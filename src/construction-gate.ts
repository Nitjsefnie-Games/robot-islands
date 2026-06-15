// Pure construction-position gate (NO pixi.js import).
//
// `positionIsFree` used to be a private helper inside `construction-ui.ts`,
// which is a DOM/Pixi panel. Extracting it here lets the authoritative server
// re-run the same overlap check the UI uses when validating an artificial
// island construction intent.

import { distSqTiles, type WorldState } from './world.js';

/** Distance buffer (tiles) added to (major_a + major_b) for overlap check. */
export const POSITION_BUFFER_TILES = 4;

/** Check whether a candidate position would overlap any existing island.
 *  Returns true if safe to place, false otherwise. Mirrors the UX guardrail
 *  enforced by the Construction UI before it lets the player confirm. */
export function positionIsFree(
  world: WorldState,
  cx: number,
  cy: number,
  majorRadius: number,
): boolean {
  for (const s of world.islands) {
    const minDist = s.majorRadius + majorRadius + POSITION_BUFFER_TILES;
    if (distSqTiles(s.cx, s.cy, cx, cy) < minDist * minDist) return false;
  }
  return true;
}
