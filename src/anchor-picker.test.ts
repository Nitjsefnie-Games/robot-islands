// Anchor-picker pure-logic tests — `candidateAnchors` filters and orders
// populated islands by distance (in cells) to a prospective ocean placement.
//
// Per §4: anchor selection does NOT walk a cable component; it lists every
// populated island within `ANCHOR_MAX_RANGE_CELLS` of the placement cell.

import { describe, expect, it } from 'vitest';

import {
  ANCHOR_MAX_RANGE_CELLS,
  candidateAnchors,
} from './anchor-picker.js';
import { CELL_SIZE_TILES } from './constants.js';
import type { IslandSpec, WorldState } from './world.js';

function makeSpec(over: Partial<IslandSpec>): IslandSpec {
  return {
    id: 'test',
    name: 'test',
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

/** Minimal `WorldState` stub — `candidateAnchors` only reads `world.islands`.
 *  Casting through `unknown` keeps the test fixture free of unrelated
 *  optional fields without fighting `strict` mode. */
function worldWith(islands: IslandSpec[]): WorldState {
  return { islands, recentBuildAttempts: new Set(), recentBuildAttemptTs: new Map() } as unknown as WorldState;
}

describe('candidateAnchors', () => {
  it('returns all populated islands within ANCHOR_MAX_RANGE_CELLS', () => {
    // Placement at cell (0, 0) → tile (0, 0).
    // A populated at tile (5*16, 0) → dist 5 cells.
    // B populated at tile (20*16, 0) → dist 20 cells.
    // C unpopulated at tile (10*16, 0) → dist 10 cells but filtered out.
    const islands = [
      makeSpec({ id: 'A', name: 'A', populated: true, cx: 5 * CELL_SIZE_TILES, cy: 0 }),
      makeSpec({ id: 'B', name: 'B', populated: true, cx: 20 * CELL_SIZE_TILES, cy: 0 }),
      makeSpec({ id: 'C', name: 'C', populated: false, cx: 10 * CELL_SIZE_TILES, cy: 0 }),
    ];
    const candidates = candidateAnchors(worldWith(islands), 0, 0);
    expect(candidates.map((c) => c.islandId).sort()).toEqual(['A', 'B']);
  });

  it('orders candidates by distance to the placement cell (nearest first)', () => {
    // A at dist 15 cells, B at dist 5 cells, both populated.
    const islands = [
      makeSpec({ id: 'A', name: 'A', populated: true, cx: 15 * CELL_SIZE_TILES, cy: 0 }),
      makeSpec({ id: 'B', name: 'B', populated: true, cx: 5 * CELL_SIZE_TILES, cy: 0 }),
    ];
    const candidates = candidateAnchors(worldWith(islands), 0, 0);
    expect(candidates[0]?.islandId).toBe('B');
    expect(candidates[1]?.islandId).toBe('A');
  });

  it('filters out populated islands beyond ANCHOR_MAX_RANGE_CELLS', () => {
    // Place one populated island at exactly (ANCHOR_MAX_RANGE_CELLS + 5)
    // cells from the placement cell — outside range, must drop.
    const dCells = ANCHOR_MAX_RANGE_CELLS + 5;
    const islands = [
      makeSpec({
        id: 'A',
        name: 'A',
        populated: true,
        cx: dCells * CELL_SIZE_TILES,
        cy: 0,
      }),
    ];
    const candidates = candidateAnchors(worldWith(islands), 0, 0);
    expect(candidates).toEqual([]);
  });

  it('returns empty list when no populated island exists', () => {
    const islands = [
      makeSpec({ id: 'A', name: 'A', populated: false, cx: 0, cy: 0 }),
      makeSpec({ id: 'B', name: 'B', populated: false, cx: 16, cy: 16 }),
    ];
    const candidates = candidateAnchors(worldWith(islands), 0, 0);
    expect(candidates).toEqual([]);
  });
});
