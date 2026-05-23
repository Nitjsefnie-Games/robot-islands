// Antenna signal range — pure layer (§11 telemetry redesign).
//
// Drones can only transmit scan data to the player while inside an Antenna's
// signal range. Out-of-range cells the drone walked over are simply lost.
// This module owns the radius table and the point-in-range predicate that
// the drone tick consumes.
//
// Six tiers (T1-T6), 1×1 or 2×2 footprint, radii in tiles. The tier-6
// antenna doubles as a satellite dish: when present on a launching island
// it adds its signal radius to the ground-station comm range
// (`groundStationCommRange` in `orbital.ts`).

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
      if (b.invalid === true || (b.constructionRemainingMs ?? 0) > 0 || ((b as unknown) as { disabled?: boolean }).disabled === true) continue;
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
    if (dx * dx + dy * dy <= r.radius * r.radius + 1e-9) return true;
  }
  return false;
}

/** Default perimeter sample count for the redundancy check. 24 evenly
 *  spaced perimeter points + the centre = 25 union tests per call.
 *  Chord length 2·r·sin(π/24) ≈ 0.26·r — tighter than 16 at modest cost. */
export const REDUNDANT_SAMPLES = 24;

/** True iff the test antenna's coverage disc is fully covered by the
 *  union of `others`' discs. Approximated by sampling N perimeter points
 *  + the centre and checking each against the existing union helper.
 *  Pure — no PixiJS, no world mutation. A visual hint, not a removal-
 *  safety guarantee (see spec §02 for honest error accounting). */
export function isAntennaRedundant(
  test: SignalRange,
  others: ReadonlyArray<SignalRange>,
  samples: number = REDUNDANT_SAMPLES,
): boolean {
  if (others.length === 0) return false;
  if (!pointInSignalRange(others, test.cx, test.cy)) return false;
  for (let k = 0; k < samples; k++) {
    const theta = (2 * Math.PI * k) / samples;
    const x = test.cx + test.radius * Math.cos(theta);
    const y = test.cy + test.radius * Math.sin(theta);
    if (!pointInSignalRange(others, x, y)) return false;
  }
  return true;
}
