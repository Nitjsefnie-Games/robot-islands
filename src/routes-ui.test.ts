// @vitest-environment happy-dom

// Pure helper tests for the route-creation UI dropdown cache keys, plus a
// mount smoke-test guarding the boot-time temporal-dead-zone regression where
// buildOptions() (called eagerly during mount) wrote lastRoutesKey/
// lastViaBuildingsKey before their `let` declarations ran.

import { describe, expect, it } from 'vitest';

import { mountRoutesUi, viaBuildingKeyForIsland } from './routes-ui.js';
import { createNewGame } from './new-game.js';
import type { RouteRenderer } from './routes-renderer.js';
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

describe('mountRoutesUi — boot init order (TDZ regression)', () => {
  it('mounts without a temporal-dead-zone ReferenceError', () => {
    const now = Date.now();
    const { world, islandStates } = createNewGame(now);
    const islandSpecs = new Map<string, IslandSpec>(world.islands.map((s) => [s.id, s]));
    // routeRenderer is only touched in refresh()/paintLayer, never during
    // mount, so an empty mock suffices to exercise the boot path.
    const routeRenderer = {} as unknown as RouteRenderer;
    const parent = document.createElement('div');

    // Regression: buildOptions() runs at mount and assigns lastRoutesKey =
    // routesKey(), but lastRoutesKey was `let`-declared ~530 lines below the
    // call → "Cannot access 'lastRoutesKey' before initialization".
    expect(() =>
      mountRoutesUi(parent, { world, islandStates, islandSpecs, routeRenderer }),
    ).not.toThrow();
  });
});
