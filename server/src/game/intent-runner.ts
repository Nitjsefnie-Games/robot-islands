// server/src/game/intent-runner.ts
//
// Orchestration: load authoritative state -> dispatch the intent -> persist on
// success / persist NOTHING on failure -> return a minimal ack. This is the only
// layer that touches the DB; `intents.ts` is the pure dispatch map and `ws.ts`
// is transport only.
//
// The success ack carries NO state payload: the authoritative state reaches the
// client via the `state-delta` push `ws.ts` emits right after every accepted
// intent. A heartbeat ack used to ship a full `projectGame` snapshot (~25 KiB of
// per-island inventory) that the client never read — dead weight on the wire.
//
// No-partial-persist invariant (design §10): a rejected OR throwing handler must
// not persist its would-be mutation. We achieve this by catching up IN MEMORY
// (no write) and calling `saveSnapshot` on EXACTLY ONE path — a clean {ok:true}
// or a {persist:true} failure. A rejection/throw simply returns without saving,
// so the tx commits with no write and the stored row is left byte-identical.
//
// PERF: the intent path used to call `loadAndCatchUp`, which persists the
// caught-up snapshot, and THEN `saveSnapshot` again after the mutation — so an
// accepted intent serialized + wrote the full ~1.3 MB save TWICE per request
// (~62 ms each on the real save), the gap-independent floor under every intent
// (create, cancel, place, …). Catching up in memory and writing once halves it.
// Dropping the catch-up write on rejection costs nothing semantically: catch-up
// is deterministic in `now` (see runtime.catchUp), so the offline gap is simply
// re-integrated from the same savedAt on the next read/intent — identical state,
// just not pre-persisted.

import { type Pool, withAccountTx } from '../db.js';
import { catchUp } from './runtime.js';
import { loadSnapshot, saveSnapshot } from './persistence.js';
import { serializeWorld } from '../../../src/persistence.js';
import { INTENTS, type IntentResult } from './intents.js';

/** Client -> server intent envelope (design §4). */
export interface IntentEnvelope {
  readonly type: string;
  readonly payload: unknown;
  readonly seq: number;
}

/** Server -> client acknowledgement (design §4). Carries no state payload — the
 *  post-intent `state-delta` push delivers the authoritative state. */
export type Ack =
  | { readonly seq: number; readonly ok: true }
  | { readonly seq: number; readonly ok: false; readonly error: string };

export async function applyIntent(
  pool: Pool,
  userId: string,
  envelope: IntentEnvelope,
  now: number,
): Promise<Ack> {
  const { seq, type, payload } = envelope;

  const handler = INTENTS[type];
  if (!handler) return { seq, ok: false, error: 'unknown intent' };

  // The ENTIRE load->apply->persist sequence runs inside one transaction that
  // holds the per-account advisory lock (withAccountTx), so two in-flight
  // intents for the same account (two tabs / a tick racing an intent)
  // SERIALIZE instead of both reading the old snapshot and last-writer-wins
  // clobbering each other. The lock covers loadAndCatchUp's read AND the
  // post-apply persist for the SAME intent; it releases on commit/rollback.
  return withAccountTx(pool, userId, async (client): Promise<Ack> => {
    // Catch up IN MEMORY (no write) — unlike loadAndCatchUp, which persisted
    // here and forced a second full save below for every accepted intent.
    const game = catchUp(await loadSnapshot(client, userId), now);
    if (game === null) return { seq, ok: false, error: 'no game' };

    let result: IntentResult;
    try {
      result = handler.apply(game, payload, now);
    } catch (err) {
      // Backstop: a handler should pre-check and return {ok:false}, never throw
      // for an illegal request. On an unexpected throw we RETURN a failure ack
      // (not re-throw) and persist NOTHING — the tx commits with no write, so
      // the stored save is byte-identical (no partial mutation) and the gap is
      // re-integrated deterministically on the next op.
      const error = err instanceof Error ? err.message : 'intent failed';
      return { seq, ok: false, error };
    }

    if (!result.ok && !result.persist) {
      // Reject: persist NOTHING. The in-memory `game` carries the would-be
      // mutation but we never save it; the tx commits with no write.
      return { seq, ok: false, error: result.error };
    }

    // Accepted (or §14.7 persisted-failure): the ONLY save per intent now.
    await saveSnapshot(client, userId, serializeWorld(game.world, game.islandStates, now, now));
    if (result.ok) {
      return { seq, ok: true };
    }
    // Persisted failure: the mutation was applied and saved, but the client
    // still receives a failure ack (e.g. a launch RNG failure with consumed
    // resources / debris / tier-revert per §14.7).
    return { seq, ok: false, error: result.error };
  });
}
