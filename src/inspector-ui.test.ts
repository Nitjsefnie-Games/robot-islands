// @vitest-environment happy-dom

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { makeRegistry } from './input.js';
import { mountInspectorUi, recipeToLines, bonusesText, co2CaptureKgPerMin, type InspectorDeps } from './inspector-ui.js';
import { makeInitialIslandState, type IslandSpec, type WorldState } from './world.js';
import type { PlacedBuilding } from './buildings.js';
import type { Recipe } from './recipes.js';

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

describe('recipeToLines — material-input efficiency (#142)', () => {
  const recipe: Recipe = {
    cycleSec: 10,
    inputs: { iron_ore: 2 } as Recipe['inputs'],
    outputs: { iron_ingot: 1 } as Recipe['outputs'],
    category: 'smelting',
  };

  it('divides input lines by recipeInputDiv but leaves outputs unchanged', () => {
    const lines = recipeToLines(recipe, 0.5, 2);
    const input = lines.find((l) => l.direction === 'in')!;
    const output = lines.find((l) => l.direction === 'out')!;
    // input: rawQty(2) × effectiveRate(0.5) / recipeInputDiv(2) = 0.5
    expect(input.rate).toBeCloseTo(0.5, 6);
    // output: rawQty(1) × effectiveRate(0.5) = 0.5 (divisor must NOT touch it)
    expect(output.rate).toBeCloseTo(0.5, 6);
  });

  it('defaults the divisor to 1 (no division) when omitted', () => {
    const lines = recipeToLines(recipe, 0.5);
    const input = lines.find((l) => l.direction === 'in')!;
    expect(input.rate).toBeCloseTo(1.0, 6); // 2 × 0.5 / 1
  });
});

describe('bonusesText — material-input efficiency (#142)', () => {
  const base = {
    fledgMul: 1,
    catMul: 1,
    catLabel: 'refinement',
    mineLogBonus: 1,
    clusterMul: 1,
    activeMul: 1,
    recipeInput: 1,
  };

  it('names material-input efficiency as a divisor term when recipeInput > 1', () => {
    const text = bonusesText({ ...base, recipeInput: 1.25 });
    expect(text).toContain('material-input ÷1.25');
  });

  it('appends the material-input term after the rate composite', () => {
    const text = bonusesText({ ...base, catMul: 1.15, recipeInput: 1.25 });
    expect(text).toContain('refinement ×1.15');
    expect(text).toContain('= ×1.15');
    expect(text).toContain('material-input ÷1.25');
  });

  it('returns null when no bonus is active (recipeInput == 1)', () => {
    expect(bonusesText(base)).toBeNull();
  });
});

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

describe('co2CaptureKgPerMin', () => {
  it('recipe-backed: kg/cycle × effectiveRate × 60', () => {
    // tree: 0.1 kg/cycle, effectiveRate 0.130 cyc/s → 0.78 kg/min
    expect(co2CaptureKgPerMin({ co2CaptureKgPerCycle: 0.1, recipeBacked: true, effectiveRate: 0.130, adjacencyActive: true }))
      .toBeCloseTo(0.78, 2);
  });
  it('flat: kg/min equals kg/cycle', () => {
    expect(co2CaptureKgPerMin({ co2CaptureKgPerCycle: 5, recipeBacked: false, effectiveRate: 0, adjacencyActive: true }))
      .toBeCloseTo(5, 6);
  });
  it('idle adjacency → 0', () => {
    expect(co2CaptureKgPerMin({ co2CaptureKgPerCycle: 20, recipeBacked: false, effectiveRate: 0, adjacencyActive: false }))
      .toBe(0);
  });
});
