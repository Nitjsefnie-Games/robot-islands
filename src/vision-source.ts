// Vision-source primitive — the shared leaf module for vision queries.
//
// Pure layer: no PixiJS, no DOM, no module-level side effects. Imports only
// `./constants.js` (itself a no-dependency leaf) and nothing from
// `world.ts` / `lighthouse.ts` / `ocean.ts`, so it sits at the bottom of the
// dependency graph below the modules that consume it.
//
// `lighthouse.ts` re-exports both names so existing call sites
// (`import { pointInVision, type VisionSource } from './lighthouse.js'`)
// keep working unchanged.

import { CELL_SIZE_TILES } from './constants.js';

/** A vision-emitting source in world-tile coordinates.
 *
 *  `ellipse` is the baseline padded per-island vision halo:
 *  axis-aligned, semi-axes `(major, minor)`, centred at `(cx + offsetX,
 *  cy + offsetY)` where `(cx, cy)` is the island centre and `(offsetX,
 *  offsetY)` is the constituent offset (0,0 for a single-ellipse island).
 *
 *  `circle` is a per-Lighthouse vision disc: centred at the Lighthouse's
 *  world-tile position, with the tier-dependent radius. */
export type VisionSource =
  | {
      readonly kind: 'ellipse';
      readonly cx: number;
      readonly cy: number;
      readonly major: number;
      readonly minor: number;
      readonly offsetX: number;
      readonly offsetY: number;
    }
  | {
      readonly kind: 'circle';
      readonly cx: number;
      readonly cy: number;
      readonly radius: number;
    };

/** Is point (x, y) in world-tile coords inside any vision source? Pure.
 *  Boundary inclusive (≤, not <) so a tile sitting exactly on the rim
 *  of a padded ellipse counts as inside. */
export function pointInVision(
  sources: ReadonlyArray<VisionSource>,
  x: number,
  y: number,
): boolean {
  for (const src of sources) {
    if (src.kind === 'ellipse') {
      const dx = x - (src.cx + src.offsetX);
      const dy = y - (src.cy + src.offsetY);
      if ((dx * dx) / (src.major * src.major) + (dy * dy) / (src.minor * src.minor) <= 1) {
        return true;
      }
    } else {
      const dx = x - src.cx;
      const dy = y - src.cy;
      if (dx * dx + dy * dy <= src.radius * src.radius) return true;
    }
  }
  return false;
}

/** Does the AABB of stratification cell `(cellX, cellY)` intersect ANY of
 *  the supplied vision sources? "If any tile of the cell would be revealed,
 *  reveal the whole cell." Pure, O(|sources|) per call.
 *
 *  Implementation: per source, find the point of the cell's AABB closest
 *  (in the source's own metric) to the source centre, then run the
 *  same inside-test as `pointInVision`. For axis-aligned ellipses the
 *  L2-closest point on the AABB minimizes the ellipse equation over the
 *  AABB (the equation is separable after the (x-cx)/major substitution),
 *  so the clamp-and-test approach is EXACT, not an approximation. */
export function cellIntersectsVision(
  sources: ReadonlyArray<VisionSource>,
  cellX: number,
  cellY: number,
): boolean {
  const x0 = cellX * CELL_SIZE_TILES;
  const y0 = cellY * CELL_SIZE_TILES;
  const x1 = x0 + CELL_SIZE_TILES;
  const y1 = y0 + CELL_SIZE_TILES;
  for (const src of sources) {
    if (src.kind === 'ellipse') {
      const ecx = src.cx + src.offsetX;
      const ecy = src.cy + src.offsetY;
      const px = ecx < x0 ? x0 : ecx > x1 ? x1 : ecx;
      const py = ecy < y0 ? y0 : ecy > y1 ? y1 : ecy;
      const dx = px - ecx;
      const dy = py - ecy;
      if ((dx * dx) / (src.major * src.major) + (dy * dy) / (src.minor * src.minor) <= 1) {
        return true;
      }
    } else {
      const px = src.cx < x0 ? x0 : src.cx > x1 ? x1 : src.cx;
      const py = src.cy < y0 ? y0 : src.cy > y1 ? y1 : src.cy;
      const dx = px - src.cx;
      const dy = py - src.cy;
      if (dx * dx + dy * dy <= src.radius * src.radius) return true;
    }
  }
  return false;
}

/** Enumerate every stratification cell that intersects any vision source.
 *  Pure. Bounded by each source's own AABB so the scan cost is
 *  O(∑ sourceArea / cellArea) — typically a few hundred cells total even
 *  with many islands and lighthouses. */
export function visibleCellsFromVision(
  sources: ReadonlyArray<VisionSource>,
): Set<string> {
  const out = new Set<string>();
  for (const src of sources) {
    let minX: number;
    let maxX: number;
    let minY: number;
    let maxY: number;
    if (src.kind === 'ellipse') {
      const ecx = src.cx + src.offsetX;
      const ecy = src.cy + src.offsetY;
      minX = ecx - src.major;
      maxX = ecx + src.major;
      minY = ecy - src.minor;
      maxY = ecy + src.minor;
    } else {
      minX = src.cx - src.radius;
      maxX = src.cx + src.radius;
      minY = src.cy - src.radius;
      maxY = src.cy + src.radius;
    }
    const cMinX = Math.floor(minX / CELL_SIZE_TILES);
    const cMaxX = Math.floor(maxX / CELL_SIZE_TILES);
    const cMinY = Math.floor(minY / CELL_SIZE_TILES);
    const cMaxY = Math.floor(maxY / CELL_SIZE_TILES);
    for (let cy = cMinY; cy <= cMaxY; cy++) {
      for (let cx = cMinX; cx <= cMaxX; cx++) {
        if (cellIntersectsVision(sources, cx, cy)) {
          out.add(`${cx},${cy}`);
        }
      }
    }
  }
  return out;
}
