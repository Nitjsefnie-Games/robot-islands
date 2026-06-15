// Pure operational-building predicates (NO pixi.js import).
//
// These helpers answer "is this building actually running?" and "does this
// island have an operational instance of def X?". They used to live in
// `buildings.ts`, which imports PixiJS for rendering; moving them here lets
// the authoritative server (and other pure-layer modules) use them without
// dragging the render layer into Node.

import type { BuildingDefId } from './building-defs.js';
import { activeFloors } from './floor-levels.js';

/** Minimal shape needed by the operational predicates. Keep it loose so both
 *  `PlacedBuilding` (render layer) and test fixtures can pass. */
export interface OperationalBuilding {
  readonly defId: string;
  readonly invalid?: boolean;
  readonly constructionRemainingMs?: number;
  readonly floorLevel?: number;
  readonly disabledFloors?: number;
}

/** Returns true iff a single placed building is operational: not invalid,
 *  not still under construction, and not fully disabled by the player. */
export function isOperationalBuilding(
  b: { invalid?: boolean; constructionRemainingMs?: number; floorLevel?: number; disabledFloors?: number },
): boolean {
  if (b.invalid === true) return false;
  if ((b.constructionRemainingMs ?? 0) > 0) return false;
  if (activeFloors(b) <= 0) return false;
  return true;
}

/** Returns true iff `buildings` contains at least one operational instance of
 *  `defId`. Mirrors the UI gate used for Reality Forge, Drone Pad, Launch Tower,
 *  and similar building-based prereqs. */
export function hasOperationalBuilding(
  buildings: ReadonlyArray<OperationalBuilding>,
  defId: BuildingDefId,
): boolean {
  for (const b of buildings) {
    if (b.defId !== defId) continue;
    if (!isOperationalBuilding(b)) continue;
    return true;
  }
  return false;
}
