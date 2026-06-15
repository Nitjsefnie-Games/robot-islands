// server/src/game/runtime.ts
import type { Queryable } from '../db.js';
import type { IslandState } from '../../../src/economy.js';
import { advanceWorldEconomy } from '../../../src/economy-advance.js';
import { advanceWorldSystems } from '../../../src/world-systems-advance.js';
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
export function catchUp(
  snapshot: SaveSnapshot | null,
  now: number,
  opts: { decayActiveBonus?: boolean } = {},
): LiveGame | null {
  if (snapshot === null) return null;
  // §9.9 accept-offline tradeoff: when the player ACCEPTS the offline catch-up,
  // the active-play bonus burns over the offline gap at ACTIVE_DECAY_RATIO (3×),
  // exactly the LOCAL cold-load semantics (deserializeWorld's
  // decayClosedGameActiveBonus). Read paths and reject pass false (bonus
  // untouched) — only the accept intent threads `decayActiveBonus: true`.
  const { world, islandStates } = deserializeWorld(snapshot, now, now, {
    decayClosedGameActiveBonus: opts.decayActiveBonus === true,
  });
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
  // Advance transport/orbital/merge systems over the offline gap as well.
  // The client runs these inline in src/main.ts; the server uses the shared
  // pure helper so REMOTE saves don't freeze drones, routes, vehicles, sats,
  // or island merges during catch-up. Result is discarded — the server doesn't
  // render. Wall timestamps are already wall-epoch here, so wallOffsetMs = 0.
  advanceWorldSystems(world, islandStates, snapshot.savedAt, now, 0);
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
export async function loadAndCatchUp(
  db: Queryable,
  userId: string,
  now: number,
  opts: { decayActiveBonus?: boolean } = {},
): Promise<LiveGame | null> {
  const snapshot = await loadSnapshot(db, userId);
  const game = catchUp(snapshot, now, opts);
  if (game === null) return null;
  const advanced: SaveSnapshot = serializeWorld(game.world, game.islandStates, now, now);
  await saveSnapshot(db, userId, advanced);
  return game;
}

/**
 * REJECT-offline path (§9.9 accept/reject): load the save and re-stamp it to
 * `now` WITHOUT integrating the offline gap — no production, no XP, no
 * world-systems advance — and WITHOUT decaying the active-play bonus. The
 * player forfeits the offline catch-up to keep the bonus.
 *
 * Mechanics: deserialize at `now` (which remaps in-flight perf timestamps into
 * the current session's domain, the same "1 frame or 24h, one code path" remap)
 * but DO NOT call advanceWorldEconomy / advanceWorldSystems, and reset each
 * island's `lastTick` to `now` so the forfeited gap is consumed (a subsequent
 * catch-up sees ~0 elapsed). `deserializeWorld` is called WITHOUT
 * `decayClosedGameActiveBonus`, so `activeBonusMs` is preserved. Persists the
 * re-stamped snapshot (savedAt = now) so the gap cannot be re-applied later.
 */
export async function loadAndSkipCatchUp(db: Queryable, userId: string, now: number): Promise<LiveGame | null> {
  const snapshot = await loadSnapshot(db, userId);
  if (snapshot === null) return null;
  const { world, islandStates } = deserializeWorld(snapshot, now, now);
  world.islandStates = islandStates;
  // Forfeit the gap: stamp every island's economy clock to `now` so no offline
  // production/XP is integrated now or on the next advance.
  for (const st of islandStates.values()) st.lastTick = now;
  const stamped: SaveSnapshot = serializeWorld(world, islandStates, now, now);
  await saveSnapshot(db, userId, stamped);
  return { world, islandStates };
}
