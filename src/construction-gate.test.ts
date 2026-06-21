import { describe, expect, it } from 'vitest';

import { positionIsFree, regionDiscoveredOrVisible } from './construction-gate.js';
import { tileToCell, cellKey } from './discovery.js';
import { tileInscribedInEllipse } from './island.js';
import type { IslandSpec, WorldState } from './world.js';

/** Minimal WorldState carrying only the geometry `positionIsFree` reads. */
function worldWithIslands(islands: Array<Partial<IslandSpec>>): WorldState {
  return { islands, revealedCells: new Set() } as unknown as WorldState;
}

/** Minimal WorldState — regionDiscoveredOrVisible only reads revealedCells. */
function worldWith(revealed: Iterable<string>): WorldState {
  return { revealedCells: new Set(revealed) } as unknown as WorldState;
}

/** Every cell key the inscribed footprint of an ellipse at (cx,cy) occupies. */
function footprintCells(cx: number, cy: number, major: number, minor: number): string[] {
  const keys = new Set<string>();
  const xMin = -Math.ceil(major), xMax = Math.ceil(major) - 1;
  const yMin = -Math.ceil(minor), yMax = Math.ceil(minor) - 1;
  for (let dy = yMin; dy <= yMax; dy++) {
    for (let dx = xMin; dx <= xMax; dx++) {
      if (!tileInscribedInEllipse(dx, dy, major, minor)) continue;
      const { cellX, cellY } = tileToCell(cx + dx, cy + dy);
      keys.add(cellKey(cellX, cellY));
    }
  }
  return [...keys];
}

describe('regionDiscoveredOrVisible', () => {
  it('returns true when every footprint cell is revealed', () => {
    const cells = footprintCells(100, 100, 4, 4);
    expect(regionDiscoveredOrVisible(worldWith(cells), 100, 100, 4, 4)).toBe(true);
  });

  it('returns false when any footprint cell is missing from revealedCells', () => {
    const cells = footprintCells(100, 100, 4, 4);
    expect(cells.length).toBeGreaterThan(0);
    const missingOne = cells.slice(1); // drop the first cell
    expect(regionDiscoveredOrVisible(worldWith(missingOne), 100, 100, 4, 4)).toBe(false);
  });

  it('returns false against an empty revealed set', () => {
    expect(regionDiscoveredOrVisible(worldWith([]), 0, 0, 4, 4)).toBe(false);
  });
});

describe('positionIsFree (land-footprint overlap)', () => {
  it('rejects a candidate whose inscribed footprint overlaps an existing island', () => {
    const w = worldWithIslands([{ id: 'a', cx: 0, cy: 0, majorRadius: 6, minorRadius: 6 }]);
    // centres 2 tiles apart, both radius 6 → footprints heavily overlap.
    expect(positionIsFree(w, 2, 0, 6, 6)).toBe(false);
  });

  it('allows a candidate stacked off the MINOR axis of an elongated island', () => {
    // Existing island is wide in X (major 20) and thin in Y (minor 2). A candidate
    // far along Y does not overlap its land. The old circular major-radius check
    // wrongly rejected this (dist 12 < 20+5+buffer); the tile-footprint check
    // correctly allows it.
    const w = worldWithIslands([{ id: 'a', cx: 0, cy: 0, majorRadius: 20, minorRadius: 2 }]);
    expect(positionIsFree(w, 0, 12, 5, 5)).toBe(true);
  });

  it('allows a candidate far from every island', () => {
    const w = worldWithIslands([{ id: 'a', cx: 0, cy: 0, majorRadius: 6, minorRadius: 6 }]);
    expect(positionIsFree(w, 100, 100, 5, 5)).toBe(true);
  });
});
