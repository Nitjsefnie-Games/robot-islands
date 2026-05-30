// Per-cell discovery: pure-logic tests for cell key encoding, tile→cell,
// corridor enumeration, and island footprint cell coverage.

import { describe, expect, it } from 'vitest';

import {
  CELL_SIZE_TILES,
  cellCenterTile,
  cellKey,
  corridorCells,
  islandCells,
  parseCellKey,
  revealOceanCells,
  tileToCell,
} from './discovery.js';
import type { IslandSpec } from './world.js';

function makeIslandSpec(over: Partial<IslandSpec>): IslandSpec {
  return {
    id: 'spec',
    name: 'spec',
    biome: 'plains',
    cx: 0,
    cy: 0,
    majorRadius: 5,
    minorRadius: 5,
    populated: false,
    discovered: false,
    buildings: [],
    modifiers: [],
    ...over,
  };
}

describe('cellKey / parseCellKey', () => {
  it('round-trips positive coordinates', () => {
    const k = cellKey(3, 7);
    expect(k).toBe('3,7');
    expect(parseCellKey(k)).toEqual({ cellX: 3, cellY: 7 });
  });

  it('round-trips negative coordinates', () => {
    const k = cellKey(-2, -5);
    expect(k).toBe('-2,-5');
    expect(parseCellKey(k)).toEqual({ cellX: -2, cellY: -5 });
  });

  it('round-trips mixed signs and zero', () => {
    expect(parseCellKey(cellKey(0, 0))).toEqual({ cellX: 0, cellY: 0 });
    expect(parseCellKey(cellKey(-1, 4))).toEqual({ cellX: -1, cellY: 4 });
    expect(parseCellKey(cellKey(4, -1))).toEqual({ cellX: 4, cellY: -1 });
  });

  it('throws on a malformed key', () => {
    expect(() => parseCellKey('nope')).toThrow();
  });
});

describe('tileToCell', () => {
  it('maps tile (0, 0) to cell (0, 0)', () => {
    expect(tileToCell(0, 0)).toEqual({ cellX: 0, cellY: 0 });
  });

  it('maps tile (15, 15) to cell (0, 0)', () => {
    expect(tileToCell(15, 15)).toEqual({ cellX: 0, cellY: 0 });
  });

  it('maps tile (16, 0) to cell (1, 0) — the boundary tile starts a new cell', () => {
    expect(tileToCell(16, 0)).toEqual({ cellX: 1, cellY: 0 });
  });

  it('maps tile (-1, -1) to cell (-1, -1) — uses Math.floor not bitwise truncation', () => {
    expect(tileToCell(-1, -1)).toEqual({ cellX: -1, cellY: -1 });
  });

  it('maps tile (-16, -16) to cell (-1, -1) — the boundary tile sits on the previous cell', () => {
    expect(tileToCell(-16, -16)).toEqual({ cellX: -1, cellY: -1 });
  });

  it('maps tile (-17, -17) to cell (-2, -2)', () => {
    expect(tileToCell(-17, -17)).toEqual({ cellX: -2, cellY: -2 });
  });

  it('accepts fractional tile coords', () => {
    expect(tileToCell(7.9, 8.1)).toEqual({ cellX: 0, cellY: 0 });
    expect(tileToCell(15.999, 16.001)).toEqual({ cellX: 0, cellY: 1 });
  });
});

describe('cellCenterTile', () => {
  it('cell (0, 0) center is at tile (8, 8)', () => {
    expect(cellCenterTile(0, 0)).toEqual({ x: 8, y: 8 });
  });

  it('cell (1, 0) center is at tile (24, 8)', () => {
    expect(cellCenterTile(1, 0)).toEqual({ x: 24, y: 8 });
  });

  it('cell (-1, -1) center is at tile (-8, -8)', () => {
    expect(cellCenterTile(-1, -1)).toEqual({ x: -8, y: -8 });
  });
});

describe('corridorCells', () => {
  it('a horizontal corridor along y=8 from x=0 to x=48 covers cells (0,0), (1,0), (2,0)', () => {
    const cells = corridorCells(0, 8, 48, 8, 0.5);
    expect(cells).toContain('0,0');
    expect(cells).toContain('1,0');
    expect(cells).toContain('2,0');
  });

  it('a vertical corridor along x=8 from y=0 to y=48 covers cells (0,0), (0,1), (0,2)', () => {
    const cells = corridorCells(8, 0, 8, 48, 0.5);
    expect(cells).toContain('0,0');
    expect(cells).toContain('0,1');
    expect(cells).toContain('0,2');
  });

  it('a diagonal corridor from (0,0) to (32,32) covers (0,0), (1,1), (2,2)', () => {
    const cells = corridorCells(0, 0, 32, 32, 0.5);
    expect(cells).toContain('0,0');
    expect(cells).toContain('1,1');
    expect(cells).toContain('2,2');
  });

  it('a wide corridor along y=8 with radius 16 picks up the cell row below as well', () => {
    // Cell (0,0) center at (8,8); cell (0,1) center at (8,24); distance 16.
    // With radius 16 the second row sits on the boundary — should be revealed.
    const cells = corridorCells(0, 8, 48, 8, 16);
    expect(cells).toContain('0,0');
    expect(cells).toContain('0,1');
  });

  it('a degenerate segment (a == b) covers cells around the point', () => {
    const cells = corridorCells(8, 8, 8, 8, 1);
    expect(cells).toContain('0,0');
  });

  it('a corridor crossing through negative coordinates includes cells with negative coords', () => {
    const cells = corridorCells(-20, 8, 20, 8, 0.5);
    expect(cells).toContain('-1,0');
    expect(cells).toContain('0,0');
    expect(cells).toContain('1,0');
  });

  it('returns a fresh array on each call (no shared state)', () => {
    const a = corridorCells(0, 0, 16, 0, 0.5);
    const b = corridorCells(0, 0, 16, 0, 0.5);
    expect(a).not.toBe(b);
    expect(a).toEqual(b);
  });
});

describe('islandCells', () => {
  it('home Plains (cx=0, cy=0, r=14) covers cells (-1,-1), (-1,0), (0,-1), (0,0)', () => {
    const spec = makeIslandSpec({
      cx: 0,
      cy: 0,
      majorRadius: 14,
      minorRadius: 14,
    });
    const cells = islandCells(spec);
    const set = new Set(cells);
    expect(set.has('-1,-1')).toBe(true);
    expect(set.has('-1,0')).toBe(true);
    expect(set.has('0,-1')).toBe(true);
    expect(set.has('0,0')).toBe(true);
  });

  it('a small island at (40, -10), r=10 covers a few cells around that location', () => {
    const spec = makeIslandSpec({
      cx: 40,
      cy: -10,
      majorRadius: 10,
      minorRadius: 10,
    });
    const cells = new Set(islandCells(spec));
    // Tiles span ~[30,50] × ~[-20,0]. Cells: x in {1,2,3}, y in {-2,-1,0}.
    expect(cells.has('2,-1')).toBe(true);
  });

  it('dedupes cells covered by both primary and extra constituents', () => {
    const spec = makeIslandSpec({
      cx: 0,
      cy: 0,
      majorRadius: 5,
      minorRadius: 5,
      extraEllipses: [
        { major: 5, minor: 5, rotation: 0, offsetX: 2, offsetY: 2 },
      ],
    });
    const cells = islandCells(spec);
    const uniq = new Set(cells);
    expect(uniq.size).toBe(cells.length);
  });

  // Regression: fog overlay must NOT mask cells outside the actual island
  // footprint (open ocean cells the cell-grid snap of the tile-bbox used to
  // sneak in). For a small island at (40, -10) with r=10 the tile bbox is
  // [30, 50] × [-20, 0] which snaps to a 3×3 cell block on x∈{1,2,3}
  // y∈{-2,-1,0}. Corner cell (1, -2) covers tiles [16, 32) × [-32, -16) —
  // its nearest inscribed-test corner to the ellipse center is at distance
  // > major radius, so it contains zero inscribed tiles and is pure open
  // ocean. Including it in the fog overlay was masking the cyan vision
  // halo where it crossed those cells.
  it('excludes cells outside the inscribed ellipse footprint (regression)', () => {
    const spec = makeIslandSpec({
      cx: 40,
      cy: -10,
      majorRadius: 10,
      minorRadius: 10,
    });
    const cells = new Set(islandCells(spec));
    // Must still cover the inscribed interior.
    expect(cells.has('2,-1')).toBe(true);
    // Corner cells with no inscribed tiles must NOT slip in.
    expect(cells.has('1,-2')).toBe(false);
    expect(cells.has('3,-2')).toBe(false);
    expect(cells.has('1,0')).toBe(false);
    expect(cells.has('3,0')).toBe(false);
  });

  // Regression: every emitted cell must overlap the rendered footprint of at
  // least one inscribed tile. Tiles render at centre-origin per
  // `renderIslandTiles` — tile (X) covers world-pixel range
  // `[(X-0.5)·TILE_PX, (X+0.5)·TILE_PX)`, i.e. tile-coord range
  // `[X-0.5, X+0.5)`. The cell sprite is top-left aligned, so a rendered tile
  // sitting at X = 16k crosses the cell-k-1 / cell-k boundary — `islandCells`
  // must include BOTH cells, otherwise the cell-k-1 half of the rendered
  // tile shows against the void.
  //
  // The original check ("every emitted cell contains at least one inscribed
  // tile") was the prior over-inclusion regression. It's now slightly
  // weakened: an emitted cell may carry only the half-tile sliver of a
  // boundary-rendered tile in a neighbouring cell. Verify instead that every
  // emitted cell is *touched* by the rendered footprint of some inscribed tile
  // — the actual contract `renderOceanFogOverlay` relies on.
  it('every emitted cell is touched by a rendered inscribed tile (regression)', () => {
    const spec = makeIslandSpec({
      cx: 0,
      cy: 0,
      majorRadius: 14,
      minorRadius: 14,
    });
    const cells = islandCells(spec);
    const a2 = 14 * 14;
    function tileInscribed(x: number, y: number): boolean {
      for (const [px, py] of [[x, y], [x + 1, y], [x, y + 1], [x + 1, y + 1]]) {
        if ((px! * px!) / a2 + (py! * py!) / a2 >= 1) return false;
      }
      return true;
    }
    for (const key of cells) {
      const { cellX, cellY } = parseCellKey(key);
      const xCellLo = cellX * CELL_SIZE_TILES;
      const xCellHi = (cellX + 1) * CELL_SIZE_TILES;
      const yCellLo = cellY * CELL_SIZE_TILES;
      const yCellHi = (cellY + 1) * CELL_SIZE_TILES;
      // Any inscribed tile whose rendered tile-coord footprint
      // [x-0.5, x+0.5) × [y-0.5, y+0.5) overlaps the cell suffices. Search a
      // generous window around the cell so boundary-straddling tiles count.
      let found = false;
      for (let y = yCellLo - 1; y < yCellHi + 1 && !found; y++) {
        for (let x = xCellLo - 1; x < xCellHi + 1 && !found; x++) {
          if (!tileInscribed(x, y)) continue;
          // Rendered tile spans [x-0.5, x+0.5) × [y-0.5, y+0.5) in tile-coords.
          const tx0 = x - 0.5;
          const tx1 = x + 0.5;
          const ty0 = y - 0.5;
          const ty1 = y + 0.5;
          if (tx1 > xCellLo && tx0 < xCellHi && ty1 > yCellLo && ty0 < yCellHi) {
            found = true;
          }
        }
      }
      expect(found, `cell ${key} has no rendered inscribed tile overlapping it`).toBe(true);
    }
  });

  // Regression: when an inscribed tile sits exactly on a cell boundary
  // (X = 16k), its rendered footprint straddles cells k-1 and k. `islandCells`
  // MUST include BOTH — otherwise the half-tile sliver on the k-1 side renders
  // against the unknown-tier void (the user-reported symptom: island sticks
  // past the cyan/discovered ocean into the dark void at its widest edge).
  //
  // Construction: r=8 island at (23, 23). Inscribed x-range is [16, 29]
  // (corner (15, _) gives (15-23)²/64 = 1, not strict; corner (16, 22) gives
  // (16-23)²+(22-23)² < 64 — fits). Leftmost inscribed X = 16 sits exactly
  // on the cell-0 / cell-1 boundary. Without the fix, only cells with x ≥ 1
  // appear; with the fix, cell (0, y) for any y the boundary tile renders
  // into must also appear.
  it('includes the previous cell when the leftmost inscribed tile sits on a cell boundary (regression)', () => {
    const spec = makeIslandSpec({
      cx: 23,
      cy: 23,
      majorRadius: 8,
      minorRadius: 8,
    });
    const cells = new Set(islandCells(spec));
    // Sanity: the inscribed body is in cell (1, 1).
    expect(cells.has('1,1')).toBe(true);
    // The bug: tile (16, 23) inscribed, rendered spans tile-x [15.5, 16.5) —
    // its left half is in cell 0, not cell 1. Must be added too.
    expect(cells.has('0,1')).toBe(true);
  });

  // Symmetric Y-side regression: same r=8 island at (23, 23) — topmost
  // inscribed Y = 16 too, so the top half of the tile-(_, 16) row sits in
  // cell (_, 0). Must be added.
  it('includes the previous cell when the topmost inscribed tile sits on a cell boundary (regression)', () => {
    const spec = makeIslandSpec({
      cx: 23,
      cy: 23,
      majorRadius: 8,
      minorRadius: 8,
    });
    const cells = new Set(islandCells(spec));
    expect(cells.has('1,0')).toBe(true);
    // Diagonal cell (0,0) would only be added by a tile at (16, 16) which
    // is NOT inscribed for this geometry (((16-23)² + (16-23)² = 98 > 64)),
    // so cell (0,0) correctly stays excluded. Confirms the fix doesn't
    // over-add cells outside the rendered island's actual footprint.
    expect(cells.has('0,0')).toBe(false);
  });

  // Corner-cell regression: an island geometry where an inscribed tile DOES
  // land at (16, 16) — corner-cell case. Center (24, 24) with r=10 puts
  // tile (16, 16) inscribed: (16-24)² + (16-24)² = 128 < 100? Actually need
  // r large enough. r=12 gives 128 < 144 — inscribed. The tile straddles
  // both x=16 and y=16 boundaries, so cells (0,0), (0,1), (1,0), (1,1)
  // are ALL touched by this single rendered tile.
  it('includes the diagonal corner cell when an inscribed tile sits on a cell-grid intersection (regression)', () => {
    const spec = makeIslandSpec({
      cx: 24,
      cy: 24,
      majorRadius: 12,
      minorRadius: 12,
    });
    const cells = new Set(islandCells(spec));
    // The inscribed body is centred in cell (1, 1).
    expect(cells.has('1,1')).toBe(true);
    // Tile (16, 16) rendered footprint spans [15.5, 16.5) × [15.5, 16.5):
    // overlaps all four cells around the (16, 16) intersection.
    expect(cells.has('0,0')).toBe(true);
    expect(cells.has('0,1')).toBe(true);
    expect(cells.has('1,0')).toBe(true);
  });
});

// revealOceanCells — pinned for Task 7 (Scanner Sat ocean extension) reuse.
describe('revealOceanCells', () => {
  function makeSets() {
    return {
      revealedCells: new Set<string>(),
      depthRevealedCells: new Set<string>(),
    };
  }

  it('closed-disk boundary — cell at exactly dx² + dy² == r² IS included', () => {
    // center (0,0), radius=2: cell (2,0) is at exactly 4 = r² and must be IN;
    // cell (3,0) at 9 > 4 must be OUT — this pins the `<=` semantics.
    const state = makeSets();
    revealOceanCells(state, 0, 0, 2, { surface: true, depth: true });
    expect(state.revealedCells.has(cellKey(2, 0))).toBe(true);
    expect(state.revealedCells.has(cellKey(-2, 0))).toBe(true);
    expect(state.revealedCells.has(cellKey(0, 2))).toBe(true);
    expect(state.revealedCells.has(cellKey(0, -2))).toBe(true);
    expect(state.revealedCells.has(cellKey(3, 0))).toBe(false);
    // depth set mirrors surface set under {surface:true, depth:true}.
    expect(state.depthRevealedCells.has(cellKey(2, 0))).toBe(true);
    expect(state.depthRevealedCells.has(cellKey(3, 0))).toBe(false);
  });

  it('{surface: true, depth: false} writes only revealedCells', () => {
    const state = makeSets();
    revealOceanCells(state, 5, 5, 2, { surface: true, depth: false });
    expect(state.revealedCells.size).toBeGreaterThan(0);
    expect(state.depthRevealedCells.size).toBe(0);
    // Spot-check the center cell ends up in revealedCells.
    expect(state.revealedCells.has(cellKey(5, 5))).toBe(true);
  });

  it('{surface: false, depth: true} writes only depthRevealedCells', () => {
    const state = makeSets();
    revealOceanCells(state, 5, 5, 2, { surface: false, depth: true });
    expect(state.depthRevealedCells.size).toBeGreaterThan(0);
    expect(state.revealedCells.size).toBe(0);
    expect(state.depthRevealedCells.has(cellKey(5, 5))).toBe(true);
  });

  it('{surface: false, depth: false} is a no-op (early return)', () => {
    const state = makeSets();
    revealOceanCells(state, 5, 5, 4, { surface: false, depth: false });
    expect(state.revealedCells.size).toBe(0);
    expect(state.depthRevealedCells.size).toBe(0);
  });

  it('is idempotent — calling twice with same args does not duplicate or corrupt the Sets', () => {
    const state = makeSets();
    revealOceanCells(state, 0, 0, 3, { surface: true, depth: true });
    const surfaceAfterFirst = new Set(state.revealedCells);
    const depthAfterFirst = new Set(state.depthRevealedCells);
    const sizeAfterFirst = state.revealedCells.size;
    expect(sizeAfterFirst).toBeGreaterThan(0);

    revealOceanCells(state, 0, 0, 3, { surface: true, depth: true });
    expect(state.revealedCells.size).toBe(sizeAfterFirst);
    expect(state.depthRevealedCells.size).toBe(sizeAfterFirst);
    expect(state.revealedCells).toEqual(surfaceAfterFirst);
    expect(state.depthRevealedCells).toEqual(depthAfterFirst);
  });
});

describe('CELL_SIZE_TILES', () => {
  it('matches the §2.1 stratification placeholder', () => {
    expect(CELL_SIZE_TILES).toBe(16);
  });
});
