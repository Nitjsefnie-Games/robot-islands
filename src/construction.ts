// §9.3 Robotics — building construction time mechanic. Pure logic, no DOM.
//
// Every placed building has a `constructionRemainingMs` counter. While > 0
// the building is "under construction": it does NOT produce, does NOT
// contribute to power balance, and does NOT accrue maintenance operating
// time. The counter decrements each `advanceIsland` segment by dt and the
// building flips to operational the moment it reaches 0.
//
// Robotics sub-path's `constructionTimeMul` divides the base time at the
// moment of placement (NOT continuously) so a Robotics purchase mid-build
// does not retroactively speed up the in-progress building — it speeds up
// the NEXT placement.

import type { BuildingDef } from './building-defs.js';
import type { PlacedBuilding } from './buildings.js';
import type { Tier } from './skilltree.js';

/** Base construction times in ms, per tier. Placeholders — tune in Appendix A.
 *  Scale with tier so a T6 spaceport is a much bigger commitment than a T1
 *  Mine, but small enough T1 builders don't notice the wait in normal play. */
export const BASE_CONSTRUCTION_MS_BY_TIER: Readonly<Record<Tier, number>> = {
  1: 30 * 1000,
  2: 2 * 60 * 1000,
  3: 5 * 60 * 1000,
  4: 15 * 60 * 1000,
  5: 30 * 60 * 1000,
  6: 60 * 60 * 1000,
};

/** Compute the construction time for placing `def` on an island with the
 *  given Robotics multiplier. Pure: no state mutation. The multiplier > 1
 *  REDUCES time (faster builds). */
export function constructionTimeFor(def: BuildingDef, constructionTimeMul: number): number {
  const base = BASE_CONSTRUCTION_MS_BY_TIER[def.tier];
  if (constructionTimeMul <= 0) return base;
  return Math.round(base / constructionTimeMul);
}

/** Upgrade construction time for raising a building to `level` (the NEW level).
 *  Scales as base × (level + 1), so the L9 upgrade takes 10× base. Does NOT
 *  divide by Robotics constructionTimeMul — the brief pins raw base × (L+1). */
export function upgradeConstructionMs(def: BuildingDef, level: number): number {
  const base = BASE_CONSTRUCTION_MS_BY_TIER[def.tier];
  return base * (level + 1);
}

/** Completed fraction [0,1] of a building's in-progress construction job —
 *  fresh placement OR floor upgrade — for the progress arc. The job's total
 *  duration is normally `upgradeConstructionMs(def, floorLevel)`, but when
 *  `constructionTotalMs` is supplied (e.g. a Robotics-sped placement stored it
 *  on the building) the arc divides by THAT so a ×2 speed-up doesn't start at
 *  50 %. The optional parameter keeps the call-site backward-compatible and
 *  lets legacy buildings without the field fall back to the base/upgrade
 *  duration. */
export function constructionProgress(
  remainingMs: number,
  def: BuildingDef,
  floorLevel: number,
  totalMs?: number,
): number {
  const total = totalMs ?? upgradeConstructionMs(def, floorLevel);
  if (total <= 0) return 1;
  return Math.max(0, Math.min(1, 1 - remainingMs / total));
}

/** True iff the building is operational (construction complete). Pure read,
 *  undefined-safe for legacy saves. */
export function isOperational(b: PlacedBuilding): boolean {
  return (b.constructionRemainingMs ?? 0) <= 0;
}

/** Decrement `constructionRemainingMs` by `dtMs`, clamping at 0. Returns
 *  true if the building JUST FINISHED (the call crossed the threshold). */
export function tickConstruction(b: PlacedBuilding, dtMs: number): boolean {
  if (b.queued === true) return false;
  const remaining = b.constructionRemainingMs ?? 0;
  if (remaining <= 0) return false;
  const next = remaining - dtMs;
  if (next <= 0) {
    (b as { constructionRemainingMs?: number }).constructionRemainingMs = 0;
    return true;
  }
  (b as { constructionRemainingMs?: number }).constructionRemainingMs = next;
  return false;
}

/** Find the earliest construction-completion event in ms across all buildings
 *  whose remaining > 0. Returns null if no building is under construction.
 *  Used by `findNextCapEvent` so the integrator splits the segment at the
 *  exact moment a building becomes operational. */
export function nextConstructionCompletionMs(
  buildings: ReadonlyArray<PlacedBuilding>,
  tMs: number,
): number | null {
  let best: number | null = null;
  for (const b of buildings) {
    if (b.queued === true) continue;
    const r = b.constructionRemainingMs ?? 0;
    if (r <= 0) continue;
    const eventMs = tMs + r;
    if (best === null || eventMs < best) best = eventMs;
  }
  return best;
}
