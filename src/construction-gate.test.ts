import { describe, expect, it } from 'vitest';

import { regionDiscoveredOrVisible } from './construction-gate.js';
import { tileToCell, cellKey } from './discovery.js';
import { tileInscribedInEllipse } from './island.js';
import type { WorldState } from './world.js';

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
