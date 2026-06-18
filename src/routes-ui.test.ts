// @vitest-environment happy-dom

// Pure helper tests for the route-creation UI dropdown cache keys, plus a
// mount smoke-test guarding the boot-time temporal-dead-zone regression where
// buildOptions() (called eagerly during mount) wrote lastRoutesKey/
// lastViaBuildingsKey before their `let` declarations ran.

import { describe, expect, it } from 'vitest';

import { mountRoutesUi, viaBuildingKeyForIsland, fmtUPerSec, routeStructKey, buildingOptionLabel } from './routes-ui.js';
import { createNewGame } from './new-game.js';
import type { RouteRenderer } from './routes-renderer.js';
import type { PlacedBuilding } from './buildings.js';
import type { IslandSpec } from './world.js';
import type { Route } from './routes.js';

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

describe('buildingOptionLabel — floor-scaled max in the route selector', () => {
  const cargoProfile = { type: 'cargo', capacityPerSec: 0.5 };

  it('shows the tier base for a fresh (floor-1) building', () => {
    // floorLevel 0 → activeFloorLevel 0 → ×(1+0) = 0.5 u/s
    expect(buildingOptionLabel({ defId: 'dock', floorLevel: 0 }, cargoProfile)).toContain('0.50 u/s');
    expect(buildingOptionLabel({ defId: 'dock', floorLevel: 0 }, cargoProfile)).toContain('cargo');
  });

  it('scales the advertised max with floor level', () => {
    // floorLevel 1 → activeFloorLevel 1 → ×(1+1) = 1.0 u/s
    expect(buildingOptionLabel({ defId: 'dock', floorLevel: 1 }, cargoProfile)).toContain('1.00 u/s');
    // floorLevel 3 → activeFloorLevel 3 → ×4 = 2.0 u/s
    expect(buildingOptionLabel({ defId: 'dock', floorLevel: 3 }, cargoProfile)).toContain('2.00 u/s');
  });
});

describe('fmtUPerSec / routeStructKey (#136 ledger display)', () => {
  it('formats a per-second capacity with the u/s unit', () => {
    expect(fmtUPerSec(1.5)).toBe('1.50 u/s');
    expect(fmtUPerSec(0)).toBe('0.00 u/s');
  });

  function makeRoute(over: Partial<Route> = {}): Route {
    return {
      id: 'r1', from: 'home', to: 'colony', mode: 'balanced',
      cargo: [{ resourceId: 'wood' }], draining: false, waypoints: [],
      ...over,
    } as unknown as Route;
  }

  it('struct key changes when the source-building floor multiplier changes (#136.3)', () => {
    const route = makeRoute();
    const label = (id: string) => (id === 'home' ? 'Home' : id);
    // Same route, different floor multiplier ⇒ different key ⇒ row rebuilds and
    // the baked-in per-row cap/transit refreshes instead of going stale.
    expect(routeStructKey(route, label, 1)).not.toBe(routeStructKey(route, label, 2));
  });

  it('struct key resolves island ids through the label fn', () => {
    const route = makeRoute();
    const label = (id: string) => (id === 'home' ? 'Home' : 'Colony');
    expect(routeStructKey(route, label, 1)).toContain('Home');
    expect(routeStructKey(route, label, 1)).toContain('Colony');
  });
});

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
