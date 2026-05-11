// Per-cell ocean discovery (§2.1 stratification cells).
//
// Pure layer — no PixiJS, no DOM. The world keeps a `Set<"cellX,cellY">` of
// revealed stratification cells; drones add to this set on a per-tick basis
// while inside an Antenna's signal range. This module owns the cell-coord
// math: encoding/decoding keys, tile→cell, and the corridor/island
// enumeration used by the drone tick and world-init.
//
// Cell coordinates are signed integers. A cell `(cx, cy)` covers tile range
// `[cx * 16, (cx + 1) * 16)` on both axes. `Math.floor` (NOT `| 0`) is used
// for the tile→cell mapping so negative coordinates land on the correct cell
// — `(-1, -1)` floors to `(-1, -1)`, not `(0, 0)`.

import { CELL_SIZE_TILES } from './world.js';
import type { IslandSpec } from './world.js';
import { islandConstituents } from './world.js';

export { CELL_SIZE_TILES };

/** Encode a stratification-cell coordinate to the key shape used in
 *  `WorldState.revealedCells`. Format: `"cellX,cellY"` — same convention as
 *  `world.ts`'s ad-hoc tile-coord string keys. */
export function cellKey(cellX: number, cellY: number): string {
  return `${cellX},${cellY}`;
}

/** Decode a cell key produced by `cellKey`. Throws on a malformed input —
 *  callers should only ever pass strings they got from `cellKey` (or saved
 *  from a prior session). */
export function parseCellKey(key: string): { cellX: number; cellY: number } {
  const i = key.indexOf(',');
  if (i < 0) throw new Error(`parseCellKey: malformed key "${key}"`);
  const cellX = Number.parseInt(key.slice(0, i), 10);
  const cellY = Number.parseInt(key.slice(i + 1), 10);
  if (!Number.isFinite(cellX) || !Number.isFinite(cellY)) {
    throw new Error(`parseCellKey: malformed key "${key}"`);
  }
  return { cellX, cellY };
}

/** World tile coordinate → its containing stratification cell. Uses
 *  `Math.floor` so negative tile coordinates land on the correct (negative)
 *  cell. Fractional tile coords accepted — the drone tick computes corridor
 *  endpoints as floats, and the cell math collapses them to integer cells. */
export function tileToCell(x: number, y: number): { cellX: number; cellY: number } {
  return {
    cellX: Math.floor(x / CELL_SIZE_TILES),
    cellY: Math.floor(y / CELL_SIZE_TILES),
  };
}

/** Cell center in world-tile coords. Used by the drone-tick reveal logic to
 *  test whether a cell sits inside an Antenna's signal range. */
export function cellCenterTile(cellX: number, cellY: number): { x: number; y: number } {
  return {
    x: cellX * CELL_SIZE_TILES + CELL_SIZE_TILES / 2,
    y: cellY * CELL_SIZE_TILES + CELL_SIZE_TILES / 2,
  };
}

/**
 * Enumerate the set of cell keys touched by a capsule corridor from `(ax, ay)`
 * to `(bx, by)` with half-width `radius`. Coarse and INCLUSIVE — we walk the
 * union bounding box (expanded by `radius` on each side) of the two
 * endpoints and add any cell whose axis-aligned bounding box intersects the
 * capsule.
 *
 * Cell-AABB vs capsule test uses the standard "distance from cell-center to
 * segment ≤ radius + half-cell-diagonal" approach via the segment-distance
 * primitive that mirrors `pointToSegmentDistSq` in `drones.ts`. We accept a
 * small over-inclusion at the corridor edges (cells whose bbox grazes the
 * capsule but whose center is just outside) — the renderer treats over-
 * inclusion as a non-issue (the cell renders revealed; the player gains a
 * tiny extra cell of ocean intel) and the alternative (a tight polygon
 * intersection) is far more complex for negligible gameplay impact.
 *
 * Pure. Returns a fresh array on every call. Degenerate segment (a == b) is
 * a circle of radius `radius` around `(ax, ay)` — the math degenerates
 * cleanly because `pointToSegmentDistSq` already handles the zero-length
 * case.
 */
export function corridorCells(
  ax: number,
  ay: number,
  bx: number,
  by: number,
  radius: number,
): string[] {
  const xMin = Math.min(ax, bx) - radius;
  const xMax = Math.max(ax, bx) + radius;
  const yMin = Math.min(ay, by) - radius;
  const yMax = Math.max(ay, by) + radius;
  const cMinX = Math.floor(xMin / CELL_SIZE_TILES);
  const cMaxX = Math.floor(xMax / CELL_SIZE_TILES);
  const cMinY = Math.floor(yMin / CELL_SIZE_TILES);
  const cMaxY = Math.floor(yMax / CELL_SIZE_TILES);
  // Slack term: half the cell's diagonal in tiles. Adding this to `radius`
  // when testing "cell center inside capsule" makes the test cover any cell
  // whose AABB intersects the capsule (the worst case being a corner touching
  // the capsule, which means the center is at most `half-diagonal` outside).
  const halfDiag = (CELL_SIZE_TILES * Math.SQRT2) / 2;
  const effectiveRadius = radius + halfDiag;
  const r2 = effectiveRadius * effectiveRadius;
  const out: string[] = [];
  for (let cy = cMinY; cy <= cMaxY; cy++) {
    for (let cx = cMinX; cx <= cMaxX; cx++) {
      const center = cellCenterTile(cx, cy);
      if (pointToSegmentDistSq2(center.x, center.y, ax, ay, bx, by) <= r2) {
        out.push(cellKey(cx, cy));
      }
    }
  }
  return out;
}

/** Inline copy of `pointToSegmentDistSq` (drones.ts) to avoid a runtime
 *  cycle (`discovery.ts ← drones.ts`). The two implementations are
 *  intentionally identical and trivially small. */
function pointToSegmentDistSq2(
  px: number,
  py: number,
  ax: number,
  ay: number,
  bx: number,
  by: number,
): number {
  const dx = bx - ax;
  const dy = by - ay;
  const lenSq = dx * dx + dy * dy;
  if (lenSq === 0) {
    const ex = px - ax;
    const ey = py - ay;
    return ex * ex + ey * ey;
  }
  const t = Math.max(0, Math.min(1, ((px - ax) * dx + (py - ay) * dy) / lenSq));
  const fx = ax + t * dx;
  const fy = ay + t * dy;
  const ex = px - fx;
  const ey = py - fy;
  return ex * ex + ey * ey;
}

/**
 * Enumerate the set of cell keys covered by an island's footprint. Used at
 * world-init time so populated islands' immediate cells start revealed (the
 * home island shouldn't read as pitch-dark — its own footprint cells are
 * trivially revealed at game start).
 *
 * Walks every constituent's tile bounding box and adds each tile's cell.
 * Coarse vs precise: we add a cell as soon as any one of its tiles falls
 * inside the constituent's bbox — that's a slight over-inclusion at the
 * ellipse edges (cell can be "covered" by a single corner tile that isn't
 * actually inscribed), but cells are the unit and a partial-coverage cell
 * still reads as "the player has been here".
 */
export function islandCells(spec: IslandSpec): string[] {
  const seen = new Set<string>();
  for (const c of islandConstituents(spec)) {
    const xMin = Math.floor(spec.cx + c.offsetX - c.major);
    const xMax = Math.ceil(spec.cx + c.offsetX + c.major);
    const yMin = Math.floor(spec.cy + c.offsetY - c.minor);
    const yMax = Math.ceil(spec.cy + c.offsetY + c.minor);
    const cMinX = Math.floor(xMin / CELL_SIZE_TILES);
    const cMaxX = Math.floor(xMax / CELL_SIZE_TILES);
    const cMinY = Math.floor(yMin / CELL_SIZE_TILES);
    const cMaxY = Math.floor(yMax / CELL_SIZE_TILES);
    for (let cy = cMinY; cy <= cMaxY; cy++) {
      for (let cx = cMinX; cx <= cMaxX; cx++) {
        seen.add(cellKey(cx, cy));
      }
    }
  }
  return [...seen];
}
