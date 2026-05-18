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

import { CELL_SIZE_TILES } from './constants.js';
import { tileInscribedInOffsetEllipse } from './island.js';
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
 * Ocean-layer §5 — disk reveal helper shared by Sonar Buoy (Task 6) and the
 * Scanner Sat ocean extension (Task 7). Given a center cell `(cx, cy)` and a
 * radius `r` in cells, walks every cell `(cx+dx, cy+dy)` inside the closed
 * disk `dx² + dy² ≤ r²` and writes it into `revealedCells` and/or
 * `depthRevealedCells` per the `surface` / `depth` flags.
 *
 * Centralised here (rather than inlined in `sonar-buoy.ts`) so the disk
 * geometry stays consistent across every consumer that ever needs "cells
 * inside a radius around a point." Same convention as `corridorCells` (this
 * module's other geometry helper): radius is in **cells**, not tiles — the
 * caller has already converted whatever tile-domain radius is in play.
 *
 * Pure-mutating: only touches the two Sets on `state`. No allocation outside
 * the loop. Caller chooses which sets to write — passing both `false` is a
 * no-op (defensive — the caller would normally just skip the call).
 */
export function revealOceanCells(
  state: {
    revealedCells: Set<string>;
    depthRevealedCells: Set<string>;
  },
  centerCellX: number,
  centerCellY: number,
  radiusCells: number,
  options: { surface: boolean; depth: boolean },
): void {
  if (!options.surface && !options.depth) return;
  const r2 = radiusCells * radiusCells;
  for (let dy = -radiusCells; dy <= radiusCells; dy++) {
    for (let dx = -radiusCells; dx <= radiusCells; dx++) {
      if (dx * dx + dy * dy > r2) continue;
      const key = cellKey(centerCellX + dx, centerCellY + dy);
      if (options.surface) state.revealedCells.add(key);
      if (options.depth) state.depthRevealedCells.add(key);
    }
  }
}

/**
 * Enumerate the set of cell keys covered by an island's footprint. Used at
 * world-init time so populated islands' immediate cells start revealed (the
 * home island shouldn't read as pitch-dark — its own footprint cells are
 * trivially revealed at game start) and by `renderOceanFogOverlay` to mask
 * the unrevealed portion of each partially-revealed island.
 *
 * A cell is included iff the rendered footprint of at least one inscribed
 * tile (from any of the island's constituent ellipses) overlaps that cell.
 * Walking the tile-bbox and snapping to the cell grid (the original
 * implementation) double-rounded outward — the tile bbox already overshoots
 * the ellipse, then floor/ceil to cell coords added another up-to-16-tile
 * margin per axis. Corner cells with zero inscribed tiles slipped in, which
 * the fog overlay then painted UNKNOWN_BLUE squares over — masking the
 * vision halo where it crossed those cells in open ocean.
 *
 * Renderer-convention detail: `renderIslandTiles` paints tile (X, Y) at
 * centre-origin — the rendered square spans world-pixel range
 * `[(X-0.5)·TILE_PX, (X+0.5)·TILE_PX)` (and same for Y), i.e. tile-coord
 * range `[X-0.5, X+0.5)`. Cell sprites are top-left aligned — cell (cx, cy)
 * spans tile-coord range `[cx·16, (cx+1)·16)`. When an inscribed tile sits
 * at X = 16·k for any integer k, its rendered footprint straddles cells
 * k-1 and k. A naive `Math.floor(X / 16)` only adds cell k, leaving a
 * half-tile sliver of the rendered tile in cell k-1 — which then renders
 * against the UNKNOWN_BLUE void (the user-visible "island sticks past the
 * cyan ocean" bug at island edges that fall on cell multiples of 16).
 *
 * Fix: enumerate cells from the rendered tile's footprint corners. For an
 * inscribed tile (x, y), both `floor((x-0.5)/16)` and `floor((x+0.5-ε)/16)`
 * are candidate cell-X values; they differ only when x = 16k. The
 * y-axis is symmetric. So normally 1 cell is added per tile, 2 when a
 * single axis sits on a cell boundary, 4 when both do.
 *
 * The inscribed-tile walk is bounded by the same per-constituent tile bbox
 * `computeIslandTiles` uses (`xMin = -ceil(major)`..`xMax = ceil(major)-1`,
 * same for y) shifted to world coords; `tileInscribedInOffsetEllipse`
 * (island.ts) runs the strict-inside corner test that defines buildable
 * terrain (§3.4). Rotation on extras is ignored — `computeIslandTiles`
 * ignores it too, so cell coverage stays consistent with what gets rendered.
 */
export function islandCells(spec: IslandSpec): string[] {
  const seen = new Set<string>();
  for (const c of islandConstituents(spec)) {
    const cxAbs = spec.cx + c.offsetX;
    const cyAbs = spec.cy + c.offsetY;
    const xMin = Math.floor(cxAbs - c.major);
    const xMax = Math.ceil(cxAbs + c.major) - 1;
    const yMin = Math.floor(cyAbs - c.minor);
    const yMax = Math.ceil(cyAbs + c.minor) - 1;
    for (let y = yMin; y <= yMax; y++) {
      for (let x = xMin; x <= xMax; x++) {
        if (!tileInscribedInOffsetEllipse(x, y, c.major, c.minor, cxAbs, cyAbs)) {
          continue;
        }
        // Rendered tile spans tile-coord range [x-0.5, x+0.5) × [y-0.5, y+0.5).
        // Take the cell of each rendered-footprint corner so a tile sitting on
        // a cell boundary (x = 16k or y = 16k) contributes to BOTH adjacent
        // cells, not just the one `Math.floor(x/16)` picks.
        const cxLow = Math.floor((x - 0.5) / CELL_SIZE_TILES);
        const cxHigh = Math.floor((x + 0.5) / CELL_SIZE_TILES);
        const cyLow = Math.floor((y - 0.5) / CELL_SIZE_TILES);
        const cyHigh = Math.floor((y + 0.5) / CELL_SIZE_TILES);
        for (let cy = cyLow; cy <= cyHigh; cy++) {
          for (let cx = cxLow; cx <= cxHigh; cx++) {
            seen.add(cellKey(cx, cy));
          }
        }
      }
    }
  }
  return [...seen];
}
