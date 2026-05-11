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
  tileToCell,
} from './discovery.js';
import type { IslandSpec } from './world.js';

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

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

// ---------------------------------------------------------------------------
// Cell key encoding
// ---------------------------------------------------------------------------

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

// ---------------------------------------------------------------------------
// tileToCell
// ---------------------------------------------------------------------------

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

// ---------------------------------------------------------------------------
// cellCenterTile
// ---------------------------------------------------------------------------

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

// ---------------------------------------------------------------------------
// corridorCells
// ---------------------------------------------------------------------------

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

// ---------------------------------------------------------------------------
// islandCells
// ---------------------------------------------------------------------------

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

  // Regression: every emitted cell must overlap at least one inscribed tile.
  // Exhaustive check on a moderate-size island.
  it('every emitted cell contains at least one inscribed tile (regression)', () => {
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
      let found = false;
      const xStart = cellX * CELL_SIZE_TILES;
      const yStart = cellY * CELL_SIZE_TILES;
      for (let y = yStart; y < yStart + CELL_SIZE_TILES && !found; y++) {
        for (let x = xStart; x < xStart + CELL_SIZE_TILES && !found; x++) {
          if (tileInscribed(x, y)) found = true;
        }
      }
      expect(found, `cell ${key} has no inscribed tile`).toBe(true);
    }
  });
});

// ---------------------------------------------------------------------------
// Constant sanity
// ---------------------------------------------------------------------------

describe('CELL_SIZE_TILES', () => {
  it('matches the §2.1 stratification placeholder', () => {
    expect(CELL_SIZE_TILES).toBe(16);
  });
});
