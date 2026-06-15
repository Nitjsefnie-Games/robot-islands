// server/src/game/intent-runner.ts
//
// Orchestration: load authoritative state -> dispatch the intent -> persist on
// success / persist NOTHING on failure -> return an ack with a fresh
// projection. This is the only layer that touches the DB; `intents.ts` is the
// pure dispatch map and `ws.ts` is transport only.
//
// No-partial-persist invariant (design §10): a rejected OR throwing handler must
// leave the stored `saves` row byte-identical. We achieve this by never calling
// `saveSnapshot` on any path except a clean {ok:true}: the in-memory `game`
// (already advanced + re-persisted by `loadAndCatchUp`) is simply discarded on
// rejection.

import { type Pool, withAccountTx } from '../db.js';
import { loadAndCatchUp } from './runtime.js';
import { saveSnapshot } from './persistence.js';
import { serializeWorld } from '../../../src/persistence.js';
import { projectGame, type GameProjection } from './projection.js';
import { INTENTS, type IntentResult } from './intents.js';

/** Client -> server intent envelope (design §4). */
export interface IntentEnvelope {
  readonly type: string;
  readonly payload: unknown;
  readonly seq: number;
}

/** Server -> client acknowledgement (design §4). */
export type Ack =
  | { readonly seq: number; readonly ok: true; readonly projection: GameProjection }
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
    const game = await loadAndCatchUp(client, userId, now);
    if (game === null) return { seq, ok: false, error: 'no game' };

    let result: IntentResult;
    try {
      result = handler.apply(game, payload, now);
    } catch (err) {
      // Backstop: a handler should pre-check and return {ok:false}, never throw
      // for an illegal request. An unexpected throw must not persist a partial
      // mutation. We RETURN a failure ack (not re-throw) so the tx COMMITS the
      // catch-up write loadAndCatchUp already made (advancing the offline gap)
      // while dropping the would-be mutation — preserving the original
      // no-partial-persist semantics (the mutation never reaches saveSnapshot).
      const error = err instanceof Error ? err.message : 'intent failed';
      return { seq, ok: false, error };
    }

    if (!result.ok && !result.persist) {
      // Persist NOTHING beyond catch-up. The in-memory `game` carries the
      // would-be mutation but we never call saveSnapshot for it; the tx commits
      // only the catch-up snapshot loadAndCatchUp already wrote.
      return { seq, ok: false, error: result.error };
    }

    await saveSnapshot(client, userId, serializeWorld(game.world, game.islandStates, now, now));
    if (result.ok) {
      return { seq, ok: true, projection: projectGame(game) };
    }
    // Persisted failure: the mutation was applied and saved, but the client
    // still receives a failure ack (e.g. a launch RNG failure with consumed
    // resources / debris / tier-revert per §14.7).
    return { seq, ok: false, error: result.error };
  });
}
