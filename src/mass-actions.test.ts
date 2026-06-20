import { describe, it, expect } from 'vitest';
import { buildingFootprintTilesWorld, buildingsInBox } from './mass-actions.js';
import type { IslandSpec } from './world.js';
import type { PlacedBuilding } from './buildings.js';

function spec(buildings: PlacedBuilding[]): IslandSpec {
  return { id: 'i1', cx: 100, cy: 200, buildings } as unknown as IslandSpec;
}
function b(id: string, defId: string, x: number, y: number): PlacedBuilding {
  return { id, defId, x, y, floorLevel: 0 } as unknown as PlacedBuilding;
}

describe('buildingFootprintTilesWorld', () => {
  it('offsets a land 1x1 footprint by the island centre', () => {
    const tiles = buildingFootprintTilesWorld(spec([]), b('a', 'mine', 3, -4));
    expect(tiles).toContainEqual({ x: 103, y: 196 });
  });
});

describe('buildingsInBox', () => {
  it('includes a building whose tile falls inside the box, excludes others', () => {
    const s = spec([b('a', 'mine', 0, 0), b('b', 'mine', 20, 20)]);
    const hit = buildingsInBox(s, { x0: 99, y0: 199, x1: 105, y1: 205 });
    expect(hit).toEqual(['a']);
  });
  it('normalizes a box dragged up-left', () => {
    const s = spec([b('a', 'mine', 0, 0)]);
    expect(buildingsInBox(s, { x0: 105, y0: 205, x1: 99, y1: 199 })).toEqual(['a']);
  });
});
