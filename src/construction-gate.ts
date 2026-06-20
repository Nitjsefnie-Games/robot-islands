// Pure construction-position gate (NO pixi.js import).
//
// `positionIsFree` used to be a private helper inside `construction-ui.ts`,
// which is a DOM/Pixi panel. Extracting it here lets the authoritative server
// re-run the same overlap check the UI uses when validating an artificial
// island construction intent.

import { distSqTiles, type WorldState } from './world.js';
import { tileInscribedInEllipse } from './island.js';
import { cellKey, tileToCell } from './discovery.js';

/** Distance buffer (tiles) added to (major_a + major_b) for overlap check. */
export const POSITION_BUFFER_TILES = 4;

/** Does the inscribed footprint of an ellipse at (cx,cy) lie entirely within
 *  discovered-or-visible space? "Unknown" = a stratification cell not present
 *  in `world.revealedCells` (vision and discovery both write through to that
 *  set, so a single membership test covers both tiers). Re-runnable on the
 *  authoritative server — same trust-surface role as `positionIsFree`. */
export function regionDiscoveredOrVisible(
  world: WorldState,
  cx: number,
  cy: number,
  major: number,
  minor: number,
): boolean {
  const xMin = -Math.ceil(major), xMax = Math.ceil(major) - 1;
  const yMin = -Math.ceil(minor), yMax = Math.ceil(minor) - 1;
  for (let dy = yMin; dy <= yMax; dy++) {
    for (let dx = xMin; dx <= xMax; dx++) {
      if (!tileInscribedInEllipse(dx, dy, major, minor)) continue;
      const { cellX, cellY } = tileToCell(cx + dx, cy + dy);
      if (!world.revealedCells.has(cellKey(cellX, cellY))) return false;
    }
  }
  return true;
}

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
