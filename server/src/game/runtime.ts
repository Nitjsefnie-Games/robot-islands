// server/src/game/runtime.ts
import type { Pool } from '../db.js';
import type { IslandState } from '../../../src/economy.js';
import { advanceWorldEconomy } from '../../../src/economy-advance.js';
import { deserializeWorld, serializeWorld, type SaveSnapshot } from '../../../src/persistence.js';
import type { WorldState } from '../../../src/world.js';
import { loadSnapshot, saveSnapshot } from './persistence.js';

export interface LiveGame { world: WorldState; islandStates: Map<string, IslandState>; }

/**
 * Load an account's save, integrate the offline gap to `now`, persist the
 * advanced state, and return it. `now` is used as BOTH wall and perf clock so
 * deserializeWorld's perfShift collapses to the real elapsed time since the
 * last save (which was stamped wall == perf). Same path for a 1s and a 30d gap.
 */
export async function loadAndCatchUp(pool: Pool, userId: string, now: number): Promise<LiveGame | null> {
  const snapshot = await loadSnapshot(pool, userId);
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
  //
  // If the advance throws we return before saveSnapshot, so the stored save is
  // left intact (no partial-write); the error surfaces as a 500 via Fastify's
  // default handler. That fail-safe-on-load behavior is by design.
  advanceWorldEconomy(world, islandStates, now, now);
  const advanced: SaveSnapshot = serializeWorld(world, islandStates, now, now);
  await saveSnapshot(pool, userId, advanced);
  return { world, islandStates };
}
