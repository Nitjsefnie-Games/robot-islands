// server/src/game/runtime.ts
import type { Queryable } from '../db.js';
import type { IslandState } from '../../../src/economy.js';
import { advanceWorldEconomy } from '../../../src/economy-advance.js';
import { deserializeWorld, serializeWorld, type SaveSnapshot } from '../../../src/persistence.js';
import type { WorldState } from '../../../src/world.js';
import { loadSnapshot, saveSnapshot } from './persistence.js';

export interface LiveGame { world: WorldState; islandStates: Map<string, IslandState>; }

/**
 * READ-ONLY catch-up: load an account's save and integrate the offline gap to
 * `now` IN MEMORY, returning the advanced live game WITHOUT writing anything
 * back. Use this for projection / state pushes (GET /api/game/state, the
 * periodic WS push) — a read must reflect catch-up to `now` but must NOT commit
 * it. The next accepted intent persists authoritatively (see loadAndCatchUp),
 * so committing here would only amplify writes and widen the lost-update window.
 *
 * Deterministic: `now` is used as BOTH wall and perf clock so deserializeWorld's
 * perfShift collapses to the real elapsed time since the last save (which was
 * stamped wall == perf). Two reads at the same `now` therefore advance to the
 * same state — idempotent. Same path for a 1s and a 30d gap.
 */
export function catchUp(snapshot: SaveSnapshot | null, now: number): LiveGame | null {
  if (snapshot === null) return null;
  const { world, islandStates } = deserializeWorld(snapshot, now, now);
  // Unify the view BEFORE advancing: `advanceWorldEconomy` (via computeNcState
  // and the orbital/lattice helpers) reads `world.islandStates`, and several
  // pure entry functions (orbital.ts launch/upgrade/repair) read it afterwards.
  // The client sets this once at init before its first tick; mirror that here.
  world.islandStates = islandStates;
  // Run the SHARED pure economy advance (the same `advanceWorldEconomy` the
  // client uses) so the authoritative server integrates the offline gap with
  // the FULL RatesContext — biome modifiers, Network Consciousness buff,
  // active-play bonus (carried in from `world.activeBonusMs`, NOT accrued
  // server-side: server play is offline/lazy, so we read the stored bonus but
  // never tick it up), Mirror-Sat solar, lattice / shared-network mass-
  // conserving pooling, cable brownout, geothermal, and toxicity rolls. No
  // render hook is passed: terrain-shot resolution still mutates state
  // (resolveShot runs inside the module) but the render rebuild is skipped.
  // `now` is both perf and wall clock (matching deserializeWorld above), so
  // each island's lastTick gap collapses to the real elapsed offline time.
  advanceWorldEconomy(world, islandStates, now, now);
  return { world, islandStates };
}

/**
 * Load an account's save, integrate the offline gap to `now`, persist the
 * advanced state, and return it. This is the PERSISTING path — use it only for
 * accepted mutations (intents) and one-time seeds (new/import), NOT for reads.
 *
 * `db` may be the pool (auto-commit) or a transaction-scoped client; pass the
 * tx client when this runs inside `withAccountTx` so the load, the in-memory
 * advance, and the save all serialize under the per-account advisory lock.
 *
 * If the advance throws we return before saveSnapshot, so the stored save is
 * left intact (no partial-write); inside a tx the surrounding ROLLBACK is the
 * stronger guarantee.
 */
export async function loadAndCatchUp(db: Queryable, userId: string, now: number): Promise<LiveGame | null> {
  const snapshot = await loadSnapshot(db, userId);
  const game = catchUp(snapshot, now);
  if (game === null) return null;
  const advanced: SaveSnapshot = serializeWorld(game.world, game.islandStates, now, now);
  await saveSnapshot(db, userId, advanced);
  return game;
}
