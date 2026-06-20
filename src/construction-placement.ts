// Pure shared placement state + validity for §2.5 artificial-island
// construction. The DOM panel (construction-ui.ts) and the Pixi ghost
// (construction-overlay.ts) both read/write a single ConstructionCandidate;
// this module computes whether that candidate is buildable. NO pixi import.

import { validateConstruction, type ValidationReason } from './artificial-island.js';
import { positionIsFree, regionDiscoveredOrVisible } from './construction-gate.js';
import type { IslandState } from './economy.js';
import type { Biome, WorldState } from './world.js';

export interface ConstructionCandidate {
  founderId: string;
  biome: Biome;
  major: number;
  minor: number;
  cx: number;
  cy: number;
}

export type ConstructPlacementReason =
  | ValidationReason
  | 'unknown-founder'
  | 'position-occupied'
  | 'in-unknown-space';

export interface PlacementValidity {
  readonly ok: boolean;
  readonly reason?: ConstructPlacementReason;
}

/** Validity precedence: founder existence, then SPATIAL gates (overlap,
 *  discovery) so the ghost reds correctly even when also unaffordable, then
 *  the per-island validateConstruction bundle (tier / PC / radii / materials /
 *  biome). */
export function computePlacementValidity(
  world: WorldState,
  islandStates: Map<string, IslandState>,
  cand: ConstructionCandidate,
): PlacementValidity {
  const spec = world.islands.find((s) => s.id === cand.founderId);
  const state = islandStates.get(cand.founderId);
  if (!spec || !state) return { ok: false, reason: 'unknown-founder' };

  if (!positionIsFree(world, cand.cx, cand.cy, cand.major)) {
    return { ok: false, reason: 'position-occupied' };
  }
  if (!regionDiscoveredOrVisible(world, cand.cx, cand.cy, cand.major, cand.minor)) {
    return { ok: false, reason: 'in-unknown-space' };
  }

  const v = validateConstruction(state, spec, {
    biome: cand.biome,
    majorRadius: cand.major,
    minorRadius: cand.minor,
  });
  if (!v.ok) return { ok: false, reason: v.reason };

  return { ok: true };
}

/** Reasons that should render the ghost RED (placement-blocking position/size).
 *  Affordability and founder-eligibility reasons leave the ghost cyan (the
 *  Construct button is disabled separately). */
export function placementBlocksGhost(reason: ConstructPlacementReason | undefined): boolean {
  return reason === 'position-occupied'
    || reason === 'in-unknown-space'
    || reason === 'radius-too-large';
}
