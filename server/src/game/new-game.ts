// server/src/game/new-game.ts
import { serializeWorld, type SaveSnapshot } from '../../../src/persistence.js';
import { createNewGame } from '../../../src/new-game.js';

/** Build the initial SaveSnapshot for a brand-new account. Stamp wall == perf
 *  so offline catch-up on first load integrates from `now`. The world seed is
 *  the save's CREATION timestamp (registration, or a future save-reset), so
 *  every account gets its own procedurally-generated world instead of the
 *  shared hardcoded WORLD_SEED. (`now` is `Date.now()` from POST /api/game/new.) */
export function createInitialSnapshot(now: number): SaveSnapshot {
  const { world, islandStates } = createNewGame(now, String(now));
  return serializeWorld(world, islandStates, now, now);
}
