// Pure helper tests for the route-creation UI dropdown cache keys.
// DOM-dependent behaviour is covered by manual/integration smoke tests;
// this file targets the exported pure helpers.

import { describe, expect, it } from 'vitest';

import { viaBuildingKeyForIsland } from './routes-ui.js';
import type { PlacedBuilding } from './buildings.js';
import type { IslandSpec } from './world.js';

function makeIsland(buildings: PlacedBuilding[]): IslandSpec {
  return {
    id: 'from',
    name: 'from',
    biome: 'plains',
    cx: 0,
    cy: 0,
    majorRadius: 5,
    minorRadius: 5,
    populated: true,
    discovered: true,
    modifiers: [],
    buildings,
  };
}

function b(id: string, defId: string): PlacedBuilding {
  return {
    id,
    defId,
    x: 0,
    y: 0,
    rotation: 0,
  } as PlacedBuilding;
}

describe('viaBuildingKeyForIsland (#108 route dropdown key)', () => {
  it('includes every building id and defId on the FROM island', () => {
    const island = makeIsland([b('b1', 'dock'), b('b2', 'crate')]);
    const key = viaBuildingKeyForIsland(island);
    expect(key).toContain('b1');
    expect(key).toContain('dock');
    expect(key).toContain('b2');
    expect(key).toContain('crate');
  });

  it('changes when a transport building is added', () => {
    const before = makeIsland([b('b1', 'dock')]);
    const after = makeIsland([b('b1', 'dock'), b('b2', 'dock')]);
    expect(viaBuildingKeyForIsland(after)).not.toBe(viaBuildingKeyForIsland(before));
  });

  it('changes when a building is removed', () => {
    const before = makeIsland([b('b1', 'dock'), b('b2', 'crate')]);
    const after = makeIsland([b('b1', 'dock')]);
    expect(viaBuildingKeyForIsland(after)).not.toBe(viaBuildingKeyForIsland(before));
  });

  it('returns empty string for a missing island', () => {
    expect(viaBuildingKeyForIsland(undefined)).toBe('');
  });
});
