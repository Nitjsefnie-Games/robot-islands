// Antenna signal range — pure layer (§11 telemetry redesign).
//
// Drones can only transmit scan data to the player while inside an Antenna's
// signal range. Out-of-range cells the drone walked over are simply lost.
// This module owns the radius table and the point-in-range predicate that
// the drone tick consumes.
//
// Six tiers (T1-T6), 1×1 or 2×2 footprint, radii in tiles. The tier-6
// antenna doubles as a satellite dish for the §14 orbital launch chain —
// flagged on the building def but the dish-side dual role is STILL-DEFERRED.

import { BUILDING_DEFS } from './building-defs.js';
import type { BuildingDefId } from './building-defs.js';
import { shapeHeight, shapeWidth } from './shape-mask.js';
import type { IslandSpec } from './world.js';

/** Antenna defId → signal radius in tiles. Single source of truth.
 *
 *  Antenna placeholder — tune in Appendix A. */
export const ANTENNA_SIGNAL_RADII: Readonly<Record<string, number>> = {
  antenna_t1: 80,
  antenna_t2: 140,
  antenna_t3: 220,
  antenna_t4: 320,
  antenna_t5: 480,
  antenna_t6: 700,
};

/** A signal-emitting antenna in world-tile coordinates. Centered on the
 *  Antenna building's footprint center; radius from `ANTENNA_SIGNAL_RADII`. */
export interface SignalRange {
  readonly cx: number;
  readonly cy: number;
  readonly radius: number;
}

/** Walk every populated island's `buildings` array; emit one `SignalRange`
 *  per Antenna building (any defId in `ANTENNA_SIGNAL_RADII`). Building
 *  position is its footprint center: `(spec.cx + b.x + width / 2,
 *  spec.cy + b.y + height / 2)`. Same pattern Lighthouse vision sources use.
 *
 *  Walks ALL `populated` islands — antennas on uninhabited (but
 *  player-built) islands wouldn't make sense, and the input filter to
 *  `populated` matches the lighthouse convention. */
export function computeSignalRanges(
  populated: ReadonlyArray<IslandSpec>,
): SignalRange[] {
  const out: SignalRange[] = [];
  for (const spec of populated) {
    for (const b of spec.buildings) {
      const radius = ANTENNA_SIGNAL_RADII[b.defId];
      if (radius === undefined) continue;
      const def = BUILDING_DEFS[b.defId as BuildingDefId];
      out.push({
        cx: spec.cx + b.x + shapeWidth(def.footprint) / 2,
        cy: spec.cy + b.y + shapeHeight(def.footprint) / 2,
        radius,
      });
    }
  }
  return out;
}

/** Is point (x, y) in world-tile coords inside any signal range? Pure. */
export function pointInSignalRange(
  ranges: ReadonlyArray<SignalRange>,
  x: number,
  y: number,
): boolean {
  for (const r of ranges) {
    const dx = x - r.cx;
    const dy = y - r.cy;
    if (dx * dx + dy * dy <= r.radius * r.radius) return true;
  }
  return false;
}
