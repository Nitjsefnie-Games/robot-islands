// Lighthouse-based vision (§15.x — vision redesign).
//
// Pure layer: no PixiJS, no DOM. Builds the world's vision source set from
// the populated-island catalog plus any Lighthouse buildings sitting on them.
// Two source shapes:
//
//   - 'ellipse' — the baseline per-island vision halo. Every populated
//     constituent contributes one ellipse at `(major + 10, minor + 10)`.
//     Small footprint padding ("you can see the immediate waters off your
//     own coast"); distant scouting requires Lighthouse infrastructure.
//   - 'circle' — a per-Lighthouse vision disc. The radius is a function of
//     the lighthouse's tier (`LIGHTHOUSE_VISION_RADII[defId]`) and the
//     centre is the Lighthouse's world-tile position.
//
// The `VisionSource` type and the `pointInVision` union test live in the
// leaf `vision-source.ts` module so `world.ts` can consume them without a
// circular import. We re-export both from here so existing call sites
// (`import { pointInVision, type VisionSource } from './lighthouse.js'`)
// keep working unchanged.

import { BUILDING_DEFS } from './building-defs.js';
import { isOperationalBuilding } from './buildings.js';
import { pointInVision, type VisionSource } from './vision-source.js';
import { shapeHeight, shapeWidth } from './shape-mask.js';
import {
  VISION_PADDING_TILES,
  islandConstituents,
  type IslandSpec,
} from './world.js';

export { pointInVision, type VisionSource };

/** Lighthouse defId → vision radius in tiles. Single source of truth.
 *  T1-T4 carry tuned placeholder values; T5/T6 are flagged.
 *
 *  Lighthouse placeholder — tune in Appendix A. */
export const LIGHTHOUSE_VISION_RADII: Readonly<Record<string, number>> = {
  lighthouse_t1: 50,
  lighthouse_t2: 80,
  lighthouse_t3: 120,
  lighthouse_t4: 160,
  lighthouse_t5: 220,
  lighthouse_t6: 300,
};

/**
 * Build the full set of vision sources for the current world. Walks every
 * populated island and emits:
 *   1. One baseline padded ellipse per constituent (primary + each
 *      `extraEllipses` entry, per §3.6 merge semantics).
 *   2. One circle source per Lighthouse building placed on the island,
 *      using the tier-dependent radius from `LIGHTHOUSE_VISION_RADII`.
 *
 * A Lighthouse's world position is computed as the centre of its footprint:
 * `(spec.cx + offsetX + building.x + width / 2,
 *   spec.cy + offsetY + building.y + height / 2)`.
 *
 * For merged islands every building still lives in the absorber's local
 * frame — `performMerge` shifts coordinates at absorption time — so the
 * primary constituent (offset 0,0) is the correct attribution for the
 * Lighthouse position. The walk over `extraEllipses` here only emits
 * baseline ellipses, NOT extra building loops; the spec's `buildings`
 * array is already shared across the whole merged identity.
 *
 * Pure — no PixiJS, no DOM, no mutations. Caller-owns the returned array.
 */
export function computeVisionSources(
  populated: ReadonlyArray<IslandSpec>,
): VisionSource[] {
  const out: VisionSource[] = [];
  for (const spec of populated) {
    // 1) Baseline padded ellipse per constituent. Primary at offset (0,0),
    //    each `extraEllipses` entry contributes its own ellipse.
    for (const c of islandConstituents(spec)) {
      out.push({
        kind: 'ellipse',
        cx: spec.cx,
        cy: spec.cy,
        major: c.major + VISION_PADDING_TILES,
        minor: c.minor + VISION_PADDING_TILES,
        offsetX: c.offsetX,
        offsetY: c.offsetY,
      });
    }
    // 2) Lighthouse circles. Walk the spec's `buildings` array; defId
    //    lookup via LIGHTHOUSE_VISION_RADII gates Lighthouse vs other
    //    defs. The merge-time coordinate shift means every building's
    //    (x, y) is already in the absorber's local frame.
    for (const b of spec.buildings) {
      if (!isOperationalBuilding(b)) continue;
      const radius = LIGHTHOUSE_VISION_RADII[b.defId];
      if (radius === undefined) continue;
      const def = BUILDING_DEFS[b.defId];
      out.push({
        kind: 'circle',
        cx: spec.cx + b.x + shapeWidth(def.footprint) / 2,
        cy: spec.cy + b.y + shapeHeight(def.footprint) / 2,
        radius,
      });
    }
  }
  return out;
}

