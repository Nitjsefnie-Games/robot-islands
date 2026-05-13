// Tests for the objectives ladder.
//
// `currentObjective` walks OBJECTIVES in order and returns the first
// uncompleted entry. We construct synthetic `GameSnapshot`s at each ladder
// milestone and assert advancement. The ladder ends with two §13.4 stubs
// (`genesis_cell`, `ascendant_core`) whose `check: () => false` are
// deliberately unsatisfiable until those resources are implemented — so
// the "all-complete → null" path is unreachable today, and the closest
// achievable terminal state is `genesis_cell`. We document and assert
// that explicitly rather than fabricate a null fixture.

import { describe, expect, it } from 'vitest';

import type { PlacedBuilding } from './buildings.js';
import type { IslandState } from './economy.js';
import type { Drone } from './drones.js';
import type { Route } from './routes.js';
import {
  completedObjectives,
  currentObjective,
  OBJECTIVES,
  type GameSnapshot,
} from './objectives.js';
import { ALL_RESOURCES, type ResourceId } from './recipes.js';
import type { IslandSpec } from './world.js';

// ---------------------------------------------------------------------------
// Snapshot construction helpers
// ---------------------------------------------------------------------------

function makeInventory(
  overrides: Partial<Record<ResourceId, number>> = {},
): Record<ResourceId, number> {
  const inventory = {} as Record<ResourceId, number>;
  for (const r of ALL_RESOURCES) {
    inventory[r] = overrides[r] ?? 0;
  }
  return inventory;
}

function makeIslandState(overrides: Partial<IslandState> & { id: string }): IslandState {
  return {
    id: overrides.id,
    buildings: overrides.buildings ?? [],
    inventory: overrides.inventory ?? makeInventory(),
    storageCaps: overrides.storageCaps ?? makeInventory(),
    xp: overrides.xp ?? 0,
    level: overrides.level ?? 1,
    unspentSkillPoints: overrides.unspentSkillPoints ?? 0,
    unlockedNodes: overrides.unlockedNodes ?? new Set(),
    subPathProgress: overrides.subPathProgress ?? new Map(),
    funnelPending: overrides.funnelPending ?? makeInventory(),
    specializationRole: overrides.specializationRole ?? null,
    declaredAt: overrides.declaredAt ?? null,
    aiCoreCrafted: overrides.aiCoreCrafted ?? false,
    ascendantCoreCrafted: overrides.ascendantCoreCrafted ?? false,
    lastResetAt: overrides.lastResetAt ?? null,
    timeLockBankedMin: overrides.timeLockBankedMin ?? 0,
    accelerationQueue: overrides.accelerationQueue ?? [],
    accelerationRemainingMin: overrides.accelerationRemainingMin ?? 0,
    bankingEnabled: overrides.bankingEnabled ?? false,
    genesisTarget: overrides.genesisTarget ?? null,
    singularityStoredWs: overrides.singularityStoredWs ?? 0,
    lastTick: overrides.lastTick ?? 0,
  };
}

function makeIslandSpec(overrides: Partial<IslandSpec> & { id: string }): IslandSpec {
  return {
    id: overrides.id,
    name: overrides.name ?? overrides.id,
    biome: overrides.biome ?? 'plains',
    cx: overrides.cx ?? 0,
    cy: overrides.cy ?? 0,
    majorRadius: overrides.majorRadius ?? 5,
    minorRadius: overrides.minorRadius ?? 5,
    populated: overrides.populated ?? true,
    discovered: overrides.discovered ?? true,
    buildings: overrides.buildings ?? [],
    modifiers: overrides.modifiers ?? [],
  };
}

function makeSnap(args: {
  specs: IslandSpec[];
  states: IslandState[];
  drones?: Drone[];
  routes?: Route[];
  activeIslandId?: string;
}): GameSnapshot {
  const map = new Map<string, IslandState>();
  for (const s of args.states) map.set(s.id, s);
  return {
    islands: args.specs,
    islandStates: map,
    activeIslandId: args.activeIslandId ?? 'home',
    drones: args.drones ?? [],
    routes: args.routes ?? [],
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('currentObjective', () => {
  it('points at "Reach Level 5" in a fresh-world snapshot', () => {
    const home = makeIslandSpec({ id: 'home' });
    const homeState = makeIslandState({ id: 'home', level: 1 });
    const snap = makeSnap({ specs: [home], states: [homeState] });
    const obj = currentObjective(snap);
    expect(obj).not.toBeNull();
    expect(obj?.id).toBe('reach_level_5');
    expect(obj?.label).toBe('Reach Level 5');
  });

  it('advances to "Place a Smelter" once level 5 is reached', () => {
    const home = makeIslandSpec({ id: 'home' });
    const homeState = makeIslandState({ id: 'home', level: 5 });
    const snap = makeSnap({ specs: [home], states: [homeState] });
    expect(currentObjective(snap)?.id).toBe('place_smelter');
  });

  it('advances to "Produce 50 Iron Ingot" once a Smelter is placed', () => {
    const smelter: PlacedBuilding = { id: 'b1', defId: 'smelter', x: 0, y: 0 };
    const home = makeIslandSpec({ id: 'home', buildings: [smelter] });
    const homeState = makeIslandState({ id: 'home', level: 5, buildings: [smelter] });
    const snap = makeSnap({ specs: [home], states: [homeState] });
    expect(currentObjective(snap)?.id).toBe('produce_iron_ingot');
  });

  it('advances to "Place an Assembler" once 50 iron_ingot is stockpiled', () => {
    const smelter: PlacedBuilding = { id: 'b1', defId: 'smelter', x: 0, y: 0 };
    const home = makeIslandSpec({ id: 'home', buildings: [smelter] });
    const homeState = makeIslandState({
      id: 'home',
      level: 5,
      buildings: [smelter],
      inventory: makeInventory({ iron_ingot: 50 }),
    });
    const snap = makeSnap({ specs: [home], states: [homeState] });
    expect(currentObjective(snap)?.id).toBe('place_assembler');
  });

  it('advances to "Create a Cargo Route" once a drone has been dispatched', () => {
    const smelter: PlacedBuilding = { id: 'b1', defId: 'smelter', x: 0, y: 0 };
    const assembler: PlacedBuilding = { id: 'b2', defId: 'assembler', x: 4, y: 0 };
    const home = makeIslandSpec({ id: 'home', buildings: [smelter, assembler] });
    const homeState = makeIslandState({
      id: 'home',
      level: 5,
      buildings: [smelter, assembler],
      inventory: makeInventory({ iron_ingot: 50 }),
    });
    // A drone in flight satisfies dispatch_drone; subsequent ladder entries
    // (establish_route, settle_island, …) still uncompleted.
    const drone: Drone = {
      id: 'd1',
      fromIslandId: 'home',
      originX: 0,
      originY: 0,
      dirX: 1,
      dirY: 0,
      outboundTiles: 20,
      scanRadius: 8,
      launchTime: 0,
      expectedReturnTime: 1000,
      tier: 2,
      fuelLoaded: 10,
      fuelResource: 'biofuel',
      waypoints: [],
      darkMode: false,
      darkModeDiscoveries: [],
      probabilityBias: 0,
    };
    const snap = makeSnap({ specs: [home], states: [homeState], drones: [drone] });
    expect(currentObjective(snap)?.id).toBe('establish_route');
  });

  it('treats a hidden-* discovered island as monotonic proof of dispatch_drone', () => {
    // The drones list shrinks on return, so dispatch_drone also accepts the
    // monotonic side-effect: any island with id `hidden-*` flipped to
    // discovered counts as proof a drone was dispatched at some point.
    const home = makeIslandSpec({ id: 'home' });
    const hidden = makeIslandSpec({
      id: 'hidden-w',
      populated: false,
      discovered: true,
    });
    const smelter: PlacedBuilding = { id: 'b1', defId: 'smelter', x: 0, y: 0 };
    const assembler: PlacedBuilding = { id: 'b2', defId: 'assembler', x: 4, y: 0 };
    home.buildings.push(smelter, assembler);
    const homeState = makeIslandState({
      id: 'home',
      level: 5,
      buildings: home.buildings,
      inventory: makeInventory({ iron_ingot: 50 }),
    });
    const snap = makeSnap({
      specs: [home, hidden],
      states: [homeState],
      drones: [], // drone has returned
    });
    // dispatch_drone is satisfied via the discovered hidden-* island, so the
    // ladder advances past it.
    expect(currentObjective(snap)?.id).toBe('establish_route');
  });

  it('advances to "Settle a New Island" once a cargo route exists', () => {
    const smelter: PlacedBuilding = { id: 'b1', defId: 'smelter', x: 0, y: 0 };
    const assembler: PlacedBuilding = { id: 'b2', defId: 'assembler', x: 4, y: 0 };
    const home = makeIslandSpec({ id: 'home', buildings: [smelter, assembler] });
    // Discovered hidden-* island satisfies dispatch_drone monotonically so
    // the ladder advances past it without keeping a Drone in `drones`.
    const hidden = makeIslandSpec({
      id: 'hidden-w',
      populated: false,
      discovered: true,
    });
    const homeState = makeIslandState({
      id: 'home',
      level: 5,
      buildings: [smelter, assembler],
      inventory: makeInventory({ iron_ingot: 50 }),
    });
    const route: Route = {
      id: 'r1',
      from: 'home',
      to: 'forest-ne',
      type: 'cargo',
      capacityPerSec: 0.5,
      filter: null,
      priorityList: [],
      transitTimeSec: 30,
      inFlight: [],
    };
    const snap = makeSnap({
      specs: [home, hidden],
      states: [homeState],
      drones: [],
      routes: [route],
    });
    expect(currentObjective(snap)?.id).toBe('settle_island');
  });

  it('walks the full mid-to-late ladder and lands on the §13.4 endgame stub', () => {
    // Construct a snapshot that satisfies every completable check up through
    // craft_reality_anchor. The two §13.4 stubs (`genesis_cell`,
    // `ascendant_core`) have `check: () => false` by design — currentObjective
    // returns the first of them, `genesis_cell`. The literal "all complete →
    // null" path is unreachable until the §13.4 resources land.
    const smelter: PlacedBuilding = { id: 'b1', defId: 'smelter', x: 0, y: 0 };
    const assembler: PlacedBuilding = { id: 'b2', defId: 'assembler', x: 4, y: 0 };
    const homeBuildings: PlacedBuilding[] = [smelter, assembler];
    const home = makeIslandSpec({ id: 'home', buildings: homeBuildings });
    const island2 = makeIslandSpec({ id: 'forest-ne', cx: 40, cy: 0, populated: true });
    const island3 = makeIslandSpec({ id: 'col-a', cx: -40, cy: 0, populated: true });
    const homeState = makeIslandState({
      id: 'home',
      level: 50,
      aiCoreCrafted: true,
      buildings: homeBuildings,
      inventory: makeInventory({
        iron_ingot: 50,
        steel: 100,
        ai_core: 1,
        reality_anchor: 1,
      }),
    });
    const i2State = makeIslandState({ id: 'forest-ne', level: 1 });
    const i3State = makeIslandState({ id: 'col-a', level: 1 });
    const route: Route = {
      id: 'r1',
      from: 'home',
      to: 'forest-ne',
      type: 'cargo',
      capacityPerSec: 0.5,
      filter: null,
      priorityList: [],
      transitTimeSec: 30,
      inFlight: [],
    };
    const drone: Drone = {
      id: 'd1',
      fromIslandId: 'home',
      originX: 0,
      originY: 0,
      dirX: 1,
      dirY: 0,
      outboundTiles: 20,
      scanRadius: 8,
      launchTime: 0,
      expectedReturnTime: 1000,
      tier: 2,
      fuelLoaded: 10,
      fuelResource: 'biofuel',
      waypoints: [],
      darkMode: false,
      darkModeDiscoveries: [],
      probabilityBias: 0,
    };
    const snap = makeSnap({
      specs: [home, island2, island3],
      states: [homeState, i2State, i3State],
      drones: [drone],
      routes: [route],
    });
    const obj = currentObjective(snap);
    expect(obj?.id).toBe('genesis_cell');
  });

  it('returns objectives in ladder order from `completedObjectives`', () => {
    // Sanity: completedObjectives flags exactly the ids whose check passes.
    const smelter: PlacedBuilding = { id: 'b1', defId: 'smelter', x: 0, y: 0 };
    const home = makeIslandSpec({ id: 'home', buildings: [smelter] });
    const homeState = makeIslandState({
      id: 'home',
      level: 5,
      buildings: [smelter],
    });
    const snap = makeSnap({ specs: [home], states: [homeState] });
    const done = completedObjectives(snap);
    expect(done.has('reach_level_5')).toBe(true);
    expect(done.has('place_smelter')).toBe(true);
    expect(done.has('produce_iron_ingot')).toBe(false);
    expect(done.has('place_assembler')).toBe(false);
    expect(done.size).toBe(2);
  });

  it('exports OBJECTIVES with unique ids and the §13.4 endgame markers last', () => {
    const ids = OBJECTIVES.map((o) => o.id);
    expect(new Set(ids).size).toBe(ids.length);
    // Last two entries are the §13.4 endgame stubs.
    expect(ids[ids.length - 2]).toBe('genesis_cell');
    expect(ids[ids.length - 1]).toBe('ascendant_core');
  });
});
