// @vitest-environment happy-dom

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { makeRegistry } from './input.js';
import { mountInspectorUi, type InspectorDeps } from './inspector-ui.js';
import { makeInitialIslandState, type IslandSpec, type WorldState } from './world.js';
import type { PlacedBuilding } from './buildings.js';

function makeSpec(over: Partial<IslandSpec> = {}): IslandSpec {
  return {
    id: 'island1',
    name: 'island1',
    biome: 'plains',
    cx: 0,
    cy: 0,
    majorRadius: 5,
    minorRadius: 5,
    populated: true,
    discovered: true,
    buildings: [],
    modifiers: [],
    ...over,
  };
}

function makeBuilding(over: Partial<PlacedBuilding> & { id: string; defId: PlacedBuilding['defId'] }): PlacedBuilding {
  return { x: 0, y: 0, ...over };
}

describe('mountInspectorUi', () => {
  let container: HTMLElement;

  beforeEach(() => {
    container = document.createElement('div');
    document.body.appendChild(container);
  });

  afterEach(() => {
    container.remove();
    vi.restoreAllMocks();
  });

  function makeDeps(over: Partial<InspectorDeps> = {}): InspectorDeps {
    const building = makeBuilding({ id: 'b1', defId: 'workshop' });
    const spec = makeSpec({ buildings: [building] });
    const state = makeInitialIslandState(spec, 0);
    const islandStates = new Map([[spec.id, state]]);
    const world: WorldState = {
      seed: 'test',
      islands: [spec],
      drones: [],
      routes: [],
      vehicles: [],
      revealedCells: new Set(),
      islandStates,
      satellites: [],
      repairDrones: [],
      debrisFields: [],
    } as unknown as WorldState;
    return {
      world,
      onDemolish: vi.fn(),
      onMove: vi.fn(),
      onSetActiveFloors: vi.fn(),
      onSetForceRun: vi.fn(),
      onRefreshMaintenance: vi.fn(),
      onUpgradeFloor: vi.fn(),
      onExpandIsland: vi.fn(),
      onRenameIsland: vi.fn(),
      onSetBankingEnabled: vi.fn(),
      onSpendTimeLock: vi.fn(),
      onSetGenesisTarget: vi.fn(),
      ...over,
    };
  }

  function getFloorText(root: HTMLElement): string {
    const headers = Array.from(root.querySelectorAll('span'));
    const floorHeader = headers.find((el) => el.textContent === 'Floors');
    expect(floorHeader).toBeTruthy();
    const body = floorHeader!.nextElementSibling as HTMLElement | null;
    expect(body).toBeTruthy();
    const line = body!.querySelector('span');
    expect(line).toBeTruthy();
    return line!.textContent ?? '';
  }

  it('re-resolves live objects on refresh after a snapshot swap', () => {
    const deps = makeDeps();
    const reg = makeRegistry();
    const inspector = mountInspectorUi(reg, container, deps);

    const spec = deps.world.islands[0]!;
    const state = deps.world.islandStates!.get(spec.id)!;
    const building = spec.buildings[0]!;

    inspector.open({ spec, state, building });
    expect(inspector.isVisible()).toBe(true);
    expect(getFloorText(inspector.el)).toContain('1 floors');

    // Simulate a REMOTE snapshot swap: replace the IslandState and PlacedBuilding
    // instances with fresh objects holding different values.
    const newBuilding = makeBuilding({ id: 'b1', defId: 'workshop', floorLevel: 2 });
    const newSpec = makeSpec({ buildings: [newBuilding] });
    const newState = makeInitialIslandState(newSpec, 0);
    deps.world.islands[0] = newSpec;
    deps.world.islandStates!.set(newSpec.id, newState);

    // Refresh should read the new live objects, not the stale cached ones.
    inspector.refresh();
    expect(getFloorText(inspector.el)).toContain('3 floors');
    expect(inspector.getSelectedBuildingId()).toBe('b1');
    expect(inspector.getSelectedIslandId()).toBe('island1');
  });

  it('closes the panel when the selected building no longer resolves', () => {
    const deps = makeDeps();
    const reg = makeRegistry();
    const inspector = mountInspectorUi(reg, container, deps);

    const spec = deps.world.islands[0]!;
    const state = deps.world.islandStates!.get(spec.id)!;
    const building = spec.buildings[0]!;

    inspector.open({ spec, state, building });
    expect(inspector.isVisible()).toBe(true);

    // Remove the building from the live world.
    spec.buildings = [];
    inspector.refresh();

    expect(inspector.isVisible()).toBe(false);
    expect(inspector.getSelectedBuildingId()).toBeNull();
    expect(inspector.getSelectedIslandId()).toBeNull();
  });
});
