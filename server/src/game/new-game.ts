// server/src/game/new-game.ts
import { serializeWorld, type SaveSnapshot } from '../../../src/persistence.js';
import { createNewGame } from '../../../src/new-game.js';

/** Build the initial SaveSnapshot for a brand-new account. Stamp wall == perf
 *  so offline catch-up on first load integrates from `now`. */
export function createInitialSnapshot(now: number): SaveSnapshot {
  const { world, islandStates } = createNewGame(now);
  return serializeWorld(world, islandStates, now, now);
}
