// server/src/game/runtime.ts
import type { Pool } from '../db.js';
import type { IslandState } from '../../../src/economy.js';
import { advanceIsland } from '../../../src/economy.js';
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
  // If advanceIsland throws mid-loop we return before saveSnapshot, so the
  // stored save is left intact (no partial-write); the error surfaces as a 500
  // via Fastify's default handler. That fail-safe-on-load behavior is by design.
  for (const spec of world.islands) {
    if (!spec.populated) continue;
    const state = islandStates.get(spec.id);
    if (state) advanceIsland(state, now);
  }
  const advanced: SaveSnapshot = serializeWorld(world, islandStates, now, now);
  await saveSnapshot(pool, userId, advanced);
  return { world, islandStates };
}
