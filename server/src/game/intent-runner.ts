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

import type { Pool } from '../db.js';
import { loadAndCatchUp } from './runtime.js';
import { saveSnapshot } from './persistence.js';
import { serializeWorld } from '../../../src/persistence.js';
import { projectGame, type GameProjection } from './projection.js';
import { INTENTS } from './intents.js';

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

  const game = await loadAndCatchUp(pool, userId, now);
  if (game === null) return { seq, ok: false, error: 'no game' };

  const handler = INTENTS[type];
  if (!handler) return { seq, ok: false, error: 'unknown intent' };

  let result: { ok: true } | { ok: false; error: string };
  try {
    result = handler.apply(game, payload, now);
  } catch (err) {
    // Backstop: a handler should pre-check and return {ok:false}, never throw
    // for an illegal request. An unexpected throw still must not persist a
    // partial mutation — discard the in-memory game and report failure.
    const error = err instanceof Error ? err.message : 'intent failed';
    return { seq, ok: false, error };
  }

  if (!result.ok) {
    // Persist NOTHING. The discarded `game` carries the would-be mutation; the
    // stored save is left exactly as `loadAndCatchUp` re-persisted it.
    return { seq, ok: false, error: result.error };
  }

  await saveSnapshot(pool, userId, serializeWorld(game.world, game.islandStates, now, now));
  return { seq, ok: true, projection: projectGame(game) };
}
