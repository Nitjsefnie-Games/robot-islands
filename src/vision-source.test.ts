// Unit tests for the cell-snap predicates in vision-source.ts.
// `pointInVision` (the existing point test) is already covered indirectly by
// world.ts / lighthouse.ts tests via islandRenderState; these tests focus
// on the cell-grid extensions added so weather + ocean tiers agree on
// "which cells are visible".

import { describe, expect, it } from 'vitest';

import {
  cellIntersectsVision,
  visibleCellsFromVision,
  type VisionSource,
} from './vision-source.js';

const CELL = 16; // CELL_SIZE_TILES — replicated here to keep tests literal.

describe('cellIntersectsVision', () => {
  it('returns false on empty source list', () => {
    expect(cellIntersectsVision([], 0, 0)).toBe(false);
  });

  it('returns true when a circle source covers the cell centre', () => {
    const src: VisionSource = { kind: 'circle', cx: 8, cy: 8, radius: 4 };
    expect(cellIntersectsVision([src], 0, 0)).toBe(true);
  });

  it('returns true when a tiny circle source clips the cell corner', () => {
    // Cell (0,0) AABB is [0, 16] × [0, 16]. A circle of radius 1 centred at
    // (17, 17) sits just outside the corner — distance to closest AABB point
    // (16, 16) is sqrt(2) ≈ 1.414 > 1, so it does NOT intersect.
    const offCorner: VisionSource = { kind: 'circle', cx: 17, cy: 17, radius: 1 };
    expect(cellIntersectsVision([offCorner], 0, 0)).toBe(false);
    // Moving the circle so its radius reaches the corner (distance ≤ radius)
    // flips the test to true.
    const reachesCorner: VisionSource = { kind: 'circle', cx: 17, cy: 17, radius: 2 };
    expect(cellIntersectsVision([reachesCorner], 0, 0)).toBe(true);
  });

  it('returns false when a circle source is far outside the cell', () => {
    const src: VisionSource = { kind: 'circle', cx: 1000, cy: 1000, radius: 5 };
    expect(cellIntersectsVision([src], 0, 0)).toBe(false);
  });

  it('handles an ellipse source clipping the cell edge', () => {
    // Cell (0,0) AABB is [0,16]×[0,16]. Ellipse centred at (24, 8) — closest
    // cell-AABB point is (16, 8). Plug into ellipse equation:
    // ((16-24)/major)² + ((8-8)/minor)² = (8/major)². To intersect, need
    // (8/major)² ≤ 1 → major ≥ 8.
    const tooSmall: VisionSource = {
      kind: 'ellipse', cx: 24, cy: 8, major: 7, minor: 7, offsetX: 0, offsetY: 0,
    };
    expect(cellIntersectsVision([tooSmall], 0, 0)).toBe(false);
    const justReaches: VisionSource = {
      kind: 'ellipse', cx: 24, cy: 8, major: 8, minor: 8, offsetX: 0, offsetY: 0,
    };
    expect(cellIntersectsVision([justReaches], 0, 0)).toBe(true);
  });

  it('honours ellipse offsetX / offsetY (constituent merge offsets)', () => {
    // Same ellipse as above (major 8) but the constituent offset shifts it
    // 24 tiles away from cell (0,0), pushing the closest distance out of
    // reach.
    const offsetAway: VisionSource = {
      kind: 'ellipse', cx: 24, cy: 8, major: 8, minor: 8, offsetX: 24, offsetY: 0,
    };
    expect(cellIntersectsVision([offsetAway], 0, 0)).toBe(false);
  });

  it('snaps to whole-cell — any intersecting tile reveals the cell', () => {
    // A circle that pokes just one tile into the cell from outside:
    // centre (-1, 8), radius 2 → closest AABB point (0, 8), distance 1 ≤ 2.
    const sliver: VisionSource = { kind: 'circle', cx: -1, cy: 8, radius: 2 };
    expect(cellIntersectsVision([sliver], 0, 0)).toBe(true);
  });
});

describe('visibleCellsFromVision', () => {
  it('returns empty when there are no sources', () => {
    expect(visibleCellsFromVision([]).size).toBe(0);
  });

  it('enumerates every cell intersecting a single circle source', () => {
    // Circle at (24, 24) — middle of cell (1,1) — radius 4. Doesn't reach
    // any neighbouring cell (would need to cross 8 tiles to hit the cell-(0,0)
    // boundary at (16, 16); distance sqrt(8²+8²) = 11.3 > 4).
    const src: VisionSource = { kind: 'circle', cx: 24, cy: 24, radius: 4 };
    const cells = visibleCellsFromVision([src]);
    expect(cells.has('1,1')).toBe(true);
    expect(cells.has('0,0')).toBe(false);
    expect(cells.has('2,1')).toBe(false);
    expect(cells.size).toBe(1);
  });

  it('covers multiple cells when the source is wide enough', () => {
    // Circle at world (0, 0), radius 20. Bbox in tiles: [-20, 20]² → cells
    // covering [-2..1] in both axes (Math.floor(-20/16) = -2; Math.floor(20/16) = 1).
    // Most should intersect — check a few specific cells.
    const src: VisionSource = { kind: 'circle', cx: 0, cy: 0, radius: 20 };
    const cells = visibleCellsFromVision([src]);
    // Cell at origin contains tile (0,0) which is the centre → covered.
    expect(cells.has('0,0')).toBe(true);
    // Cell (-1,-1) covers tiles [-16,0)² — corner (-1,-1) is sqrt(2) from origin.
    expect(cells.has('-1,-1')).toBe(true);
    // Cell far away should NOT be in.
    expect(cells.has('100,100')).toBe(false);
  });

  it('takes the union across multiple sources', () => {
    const a: VisionSource = { kind: 'circle', cx: 8, cy: 8, radius: 3 };
    const b: VisionSource = { kind: 'circle', cx: 1000, cy: 1000, radius: 3 };
    const cells = visibleCellsFromVision([a, b]);
    expect(cells.has('0,0')).toBe(true);
    // Tile coord 1000 → cell coord Math.floor(1000/16) = 62.
    expect(cells.has(`${Math.floor(1000 / CELL)},${Math.floor(1000 / CELL)}`)).toBe(true);
    expect(cells.size).toBe(2);
  });
});
