// Lighthouse-based vision (§15.x — vision redesign).
//
// Pure layer: no PixiJS, no DOM. Builds the world's vision source set from
// the populated-island catalog plus any Lighthouse buildings on them. Two
// source shapes:
//   - 'ellipse' — baseline per-island halo. Each populated constituent
//     contributes one ellipse at `(major + 10, minor + 10)`: small padding
//     ("see the immediate waters off your own coast"); distant scouting
//     requires Lighthouse infrastructure.
//   - 'circle' — per-Lighthouse vision disc, radius keyed by tier
//     (`LIGHTHOUSE_VISION_RADII[defId]`), centred on the Lighthouse.
//
// `VisionSource`/`pointInVision` live in the leaf `vision-source.ts` so
// `world.ts` can consume them without a circular import; re-exported here so
// existing `from './lighthouse.js'` call sites keep working unchanged.

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
 *  Placeholder values — tune in Appendix A. */
export const LIGHTHOUSE_VISION_RADII: Readonly<Record<string, number>> = {
  lighthouse_t1: 50,
  lighthouse_t2: 80,
  lighthouse_t3: 120,
  lighthouse_t4: 160,
  lighthouse_t5: 220,
  lighthouse_t6: 300,
};

/**
 * Build the full set of vision sources for the world. Per populated island:
 *   1. One baseline padded ellipse per constituent (primary + each
 *      `extraEllipses` entry, per §3.6 merge semantics).
 *   2. One circle per Lighthouse building, radius from `LIGHTHOUSE_VISION_RADII`.
 *
 * For merged islands every building lives in the absorber's local frame —
 * `performMerge` shifts coordinates at absorption time — so the primary
 * constituent (offset 0,0) is the correct attribution for the Lighthouse
 * position. The `extraEllipses` walk emits baseline ellipses only, NOT extra
 * building loops; `buildings` is already shared across the merged identity.
 *
 * Pure — no PixiJS, no DOM, no mutations. Caller owns the returned array.
 */
export function computeVisionSources(
  populated: ReadonlyArray<IslandSpec>,
): VisionSource[] {
  const out: VisionSource[] = [];
  for (const spec of populated) {
    // 1) Baseline padded ellipse per constituent.
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
    // 2) Lighthouse circles. The LIGHTHOUSE_VISION_RADII lookup gates
    //    Lighthouse vs other defs.
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

