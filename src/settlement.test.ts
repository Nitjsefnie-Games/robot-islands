// Settlement vehicles: pure-logic tests for §12 dispatch validation +
// arrival mutation semantics.

import { beforeEach, describe, expect, it } from 'vitest';

import type { IslandState } from './economy.js';
import { ALL_RESOURCES, type ResourceId } from './recipes.js';
import {
  HELI_TILES_PER_FUEL,
  SHIP_SPEED_TILES_PER_SEC,
  SHIP_TILES_PER_FUEL,
  _resetVehicleIdCounter,
  dispatchVehicle,
  hasLaunchBuildingFor,
  tickVehicles,
  tuningFor,
} from './settlement.js';
import { type IslandSpec, type WorldState } from './world.js';

// ---------------------------------------------------------------------------
// Test fixtures
// ---------------------------------------------------------------------------

function emptyInv(): Record<ResourceId, number> {
  const inv = {} as Record<ResourceId, number>;
  for (const r of ALL_RESOURCES) inv[r] = 0;
  return inv;
}

function emptyFunnel(): Record<ResourceId, number> {
  const f = {} as Record<ResourceId, number>;
  for (const r of ALL_RESOURCES) f[r] = 0;
  return f;
}

function fullCaps(): Record<ResourceId, number> {
  const c = {} as Record<ResourceId, number>;
  for (const r of ALL_RESOURCES) c[r] = 1000;
  return c;
}

function makeIslandState(over: Partial<IslandState> = {}): IslandState {
  return {
    id: 'home',
    buildings: [],
    inventory: emptyInv(),
    storageCaps: fullCaps(),
    xp: 0,
    level: 1,
    unspentSkillPoints: 0,
    unlockedNodes: new Set(),
    subPathProgress: new Map(),
    funnelPending: emptyFunnel(),
    specializationRole: null,
    declaredAt: null,
    aiCoreCrafted: false,
    ascendantCoreCrafted: false,
    lastTick: 0,
    ...over,
  };
}

function makeIslandSpec(over: Partial<IslandSpec>): IslandSpec {
  return {
    id: 'spec',
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

function freshWorld(islands: IslandSpec[] = []): WorldState {
  return { islands, drones: [], routes: [], vehicles: [] };
}

beforeEach(() => {
  _resetVehicleIdCounter();
});

// ---------------------------------------------------------------------------
// Tuning sanity
// ---------------------------------------------------------------------------

describe('vehicle tuning', () => {
  it('ship tuning is T1, slow, fuel-efficient', () => {
    const t = tuningFor('ship');
    expect(t.tier).toBe(1);
    expect(t.speed).toBe(SHIP_SPEED_TILES_PER_SEC);
    expect(t.tilesPerFuel).toBe(SHIP_TILES_PER_FUEL);
  });

  it('helicopter tuning is T2, fast, fuel-hungry', () => {
    const t = tuningFor('helicopter');
    expect(t.tier).toBe(2);
    expect(t.tilesPerFuel).toBe(HELI_TILES_PER_FUEL);
    // Heli is faster than ship per §12.6.
    expect(t.speed).toBeGreaterThan(SHIP_SPEED_TILES_PER_SEC);
  });
});

// ---------------------------------------------------------------------------
// hasLaunchBuildingFor
// ---------------------------------------------------------------------------

describe('hasLaunchBuildingFor', () => {
  it('returns true for a ship when origin has a Shipyard', () => {
    const origin = makeIslandSpec({
      buildings: [{ id: 'sy', defId: 'shipyard', x: 0, y: 0 }],
    });
    expect(hasLaunchBuildingFor(origin, 'ship')).toBe(true);
  });

  it('returns true for a helicopter when origin has a Helipad', () => {
    const origin = makeIslandSpec({
      buildings: [{ id: 'hp', defId: 'helipad', x: 0, y: 0 }],
    });
    expect(hasLaunchBuildingFor(origin, 'helicopter')).toBe(true);
  });

  it('returns false for ship if origin only has a Helipad', () => {
    const origin = makeIslandSpec({
      buildings: [{ id: 'hp', defId: 'helipad', x: 0, y: 0 }],
    });
    expect(hasLaunchBuildingFor(origin, 'ship')).toBe(false);
  });

  it('returns false when origin has no launch buildings', () => {
    const origin = makeIslandSpec({ buildings: [] });
    expect(hasLaunchBuildingFor(origin, 'ship')).toBe(false);
    expect(hasLaunchBuildingFor(origin, 'helicopter')).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// dispatchVehicle — validation paths
// ---------------------------------------------------------------------------

describe('dispatchVehicle', () => {
  function setup(): {
    world: WorldState;
    home: IslandSpec;
    homeState: IslandState;
    target: IslandSpec;
  } {
    const home = makeIslandSpec({
      id: 'home',
      cx: 0,
      cy: 0,
      populated: true,
      discovered: true,
      buildings: [{ id: 'sy', defId: 'shipyard', x: 0, y: 0 }],
    });
    const target = makeIslandSpec({
      id: 'target',
      cx: 30,
      cy: 0,
      populated: false,
      discovered: true,
    });
    const world = freshWorld([home, target]);
    const homeState = makeIslandState({ id: 'home' });
    homeState.inventory.biofuel = 50;
    homeState.inventory.foundation_kit = 3;
    return { world, home, homeState, target };
  }

  it('happy path: deducts fuel + kit, appends vehicle, computes arrival', () => {
    const { world, home, homeState, target } = setup();
    // Distance = 30 tiles; fuel 5 × ship efficiency 12 = 60 tile range (covers
    // 30). Travel time = 30 / 0.25 t/s = 120s → arrival at 1000 + 120_000. (rebalanced step #19)
    const r = dispatchVehicle(world, home, homeState, target, 'ship', 5, 1, 1000);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(homeState.inventory.biofuel).toBe(45);
    expect(homeState.inventory.foundation_kit).toBe(2);
    expect(world.vehicles).toHaveLength(1);
    expect(r.vehicle.kind).toBe('ship');
    expect(r.vehicle.from).toBe('home');
    expect(r.vehicle.target).toBe('target');
    expect(r.vehicle.fuelLoaded).toBe(5);
    expect(r.vehicle.foundationKitCount).toBe(1);
    expect(r.vehicle.expectedArrivalTime).toBe(1000 + 120_000); // rebalanced step #19 (was 30_000)
  });

  it('rejects a non-discovered target', () => {
    const { world, home, homeState, target } = setup();
    target.discovered = false;
    const r = dispatchVehicle(world, home, homeState, target, 'ship', 5, 1, 0);
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.reason).toBe('target-not-discovered');
    expect(homeState.inventory.biofuel).toBe(50);
    expect(homeState.inventory.foundation_kit).toBe(3);
    expect(world.vehicles).toHaveLength(0);
  });

  it('rejects an already-populated target', () => {
    const { world, home, homeState, target } = setup();
    target.populated = true;
    const r = dispatchVehicle(world, home, homeState, target, 'ship', 5, 1, 0);
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.reason).toBe('target-populated');
    expect(homeState.inventory.biofuel).toBe(50);
    expect(world.vehicles).toHaveLength(0);
  });

  it('rejects when origin lacks a Shipyard for a ship dispatch', () => {
    const { world, home, homeState, target } = setup();
    home.buildings.length = 0;
    const r = dispatchVehicle(world, home, homeState, target, 'ship', 5, 1, 0);
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.reason).toBe('missing-launch-building');
    expect(homeState.inventory.foundation_kit).toBe(3);
  });

  it('rejects insufficient fuel without mutation', () => {
    const { world, home, homeState, target } = setup();
    homeState.inventory.biofuel = 2;
    const r = dispatchVehicle(world, home, homeState, target, 'ship', 5, 1, 0);
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.reason).toBe('insufficient-fuel');
    expect(homeState.inventory.biofuel).toBe(2);
    expect(homeState.inventory.foundation_kit).toBe(3);
  });

  it('rejects zero or negative fuel as insufficient-fuel', () => {
    const { world, home, homeState, target } = setup();
    const r = dispatchVehicle(world, home, homeState, target, 'ship', 0, 1, 0);
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.reason).toBe('insufficient-fuel');
  });

  it('rejects insufficient foundation kits', () => {
    const { world, home, homeState, target } = setup();
    homeState.inventory.foundation_kit = 0;
    const r = dispatchVehicle(world, home, homeState, target, 'ship', 5, 1, 0);
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.reason).toBe('insufficient-kits');
    expect(homeState.inventory.biofuel).toBe(50);
  });

  it('rejects zero kit count', () => {
    const { world, home, homeState, target } = setup();
    const r = dispatchVehicle(world, home, homeState, target, 'ship', 5, 0, 0);
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.reason).toBe('insufficient-kits');
  });

  it('rejects dispatching to self', () => {
    const { world, home, homeState } = setup();
    const r = dispatchVehicle(world, home, homeState, home, 'ship', 5, 1, 0);
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.reason).toBe('invalid-target');
  });

  it('rejects out-of-range — fuel × efficiency < distance', () => {
    const { world, home, homeState, target } = setup();
    // Distance = 30 tiles; fuel 2 × 12 = 24 tile range — insufficient.
    const r = dispatchVehicle(world, home, homeState, target, 'ship', 2, 1, 0);
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.reason).toBe('out-of-range');
    expect(homeState.inventory.biofuel).toBe(50);
    expect(homeState.inventory.foundation_kit).toBe(3);
  });

  it('rejects a second dispatch from same origin to same target', () => {
    const { world, home, homeState, target } = setup();
    expect(dispatchVehicle(world, home, homeState, target, 'ship', 5, 1, 0).ok).toBe(true);
    const r = dispatchVehicle(world, home, homeState, target, 'ship', 5, 1, 0);
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.reason).toBe('already-in-flight');
    expect(world.vehicles).toHaveLength(1);
  });

  it('allows parallel dispatch to a DIFFERENT target', () => {
    const { world, home, homeState, target } = setup();
    const target2 = makeIslandSpec({
      id: 'target2',
      cx: 0,
      cy: 30,
      populated: false,
      discovered: true,
    });
    world.islands.push(target2);
    expect(dispatchVehicle(world, home, homeState, target, 'ship', 5, 1, 0).ok).toBe(true);
    const r = dispatchVehicle(world, home, homeState, target2, 'ship', 5, 1, 0);
    expect(r.ok).toBe(true);
    expect(world.vehicles).toHaveLength(2);
  });

  it('helicopter dispatch requires a Helipad, not a Shipyard', () => {
    const { world, home, homeState, target } = setup();
    // origin has Shipyard only → helicopter dispatch fails.
    const r1 = dispatchVehicle(world, home, homeState, target, 'helicopter', 10, 1, 0);
    expect(r1.ok).toBe(false);
    if (r1.ok) return;
    expect(r1.reason).toBe('missing-launch-building');
    // Add helipad → succeeds.
    home.buildings.push({ id: 'hp', defId: 'helipad', x: 1, y: 1 });
    const r2 = dispatchVehicle(world, home, homeState, target, 'helicopter', 10, 1, 0);
    expect(r2.ok).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// tickVehicles — arrival semantics
// ---------------------------------------------------------------------------

describe('tickVehicles', () => {
  function setup(): {
    world: WorldState;
    home: IslandSpec;
    homeState: IslandState;
    target: IslandSpec;
    islandStates: Map<string, IslandState>;
  } {
    const home = makeIslandSpec({
      id: 'home',
      cx: 0,
      cy: 0,
      populated: true,
      discovered: true,
      buildings: [{ id: 'sy', defId: 'shipyard', x: 0, y: 0 }],
    });
    const target = makeIslandSpec({
      id: 'target',
      cx: 30,
      cy: 0,
      populated: false,
      discovered: true,
    });
    const world = freshWorld([home, target]);
    const homeState = makeIslandState({ id: 'home' });
    homeState.inventory.biofuel = 50;
    homeState.inventory.foundation_kit = 3;
    const islandStates = new Map<string, IslandState>([['home', homeState]]);
    return { world, home, homeState, target, islandStates };
  }

  it('returns empty when no vehicles in flight', () => {
    const { world, islandStates } = setup();
    const r = tickVehicles(world, islandStates, 5000);
    expect(r.arrivals).toHaveLength(0);
  });

  it('leaves a vehicle in flight when nowMs < expectedArrivalTime', () => {
    const { world, home, homeState, target, islandStates } = setup();
    dispatchVehicle(world, home, homeState, target, 'ship', 5, 1, 1000);
    // Travel 120s → arrives at 121_000. (rebalanced step #19: 30/0.25=120s)
    const r = tickVehicles(world, islandStates, 5_000);
    expect(r.arrivals).toHaveLength(0);
    expect(world.vehicles).toHaveLength(1);
    expect(target.populated).toBe(false);
  });

  it('populates target on arrival, places auto Cargo Dock, creates IslandState', () => {
    const { world, home, homeState, target, islandStates } = setup();
    dispatchVehicle(world, home, homeState, target, 'ship', 5, 1, 0);
    // Travel 120s → arrives at 120_000. (rebalanced step #19: 30/0.25=120s)
    const r = tickVehicles(world, islandStates, 121_000);
    expect(r.arrivals).toHaveLength(1);
    expect(r.arrivals[0]!.targetIslandId).toBe('target');
    expect(r.arrivals[0]!.fromIslandId).toBe('home');
    expect(r.arrivals[0]!.kind).toBe('ship');
    expect(world.vehicles).toHaveLength(0);
    expect(target.populated).toBe(true);
    expect(islandStates.has('target')).toBe(true);
    // Auto-placed Cargo Dock on the target spec at (0, 0).
    const dock = target.buildings.find((b) => b.defId === 'dock');
    expect(dock).toBeDefined();
    expect(dock!.x).toBe(0);
    expect(dock!.y).toBe(0);
    // State.buildings should reference the same array as spec.buildings.
    const targetState = islandStates.get('target')!;
    expect(targetState.buildings).toBe(target.buildings);
  });

  it('places an auto Helipad for a helicopter arrival', () => {
    const { world, home, homeState, target, islandStates } = setup();
    home.buildings.push({ id: 'hp', defId: 'helipad', x: 1, y: 1 });
    // Helicopter: speed 0.75 t/s, eff 4 tiles/fuel. 30 tile trip = 40s. Need
    // 30/4 = 7.5 → 8 fuel min. Use 10 fuel. (rebalanced step #19: was speed 3 → 10s)
    dispatchVehicle(world, home, homeState, target, 'helicopter', 10, 1, 0);
    tickVehicles(world, islandStates, 41_000);
    expect(target.populated).toBe(true);
    const heliBuilding = target.buildings.find((b) => b.defId === 'helipad');
    expect(heliBuilding).toBeDefined();
    expect(target.buildings.find((b) => b.defId === 'dock')).toBeUndefined();
  });

  it('does not double-populate when target was already populated mid-flight', () => {
    const { world, home, homeState, target, islandStates } = setup();
    dispatchVehicle(world, home, homeState, target, 'ship', 5, 1, 0);
    // External path populates the target before the tick fires.
    target.populated = true;
    // 30 tiles / 0.25 t/s = 120s. (rebalanced step #19)
    const r = tickVehicles(world, islandStates, 121_000);
    expect(r.arrivals).toHaveLength(1);
    // Target stays populated; vehicle consumed (lost cargo) but no new
    // IslandState was created since one might already exist.
    expect(world.vehicles).toHaveLength(0);
    expect(target.populated).toBe(true);
  });

  it('foundation_kit is consumed on dispatch (not on arrival)', () => {
    const { world, home, homeState, target, islandStates } = setup();
    expect(homeState.inventory.foundation_kit).toBe(3);
    dispatchVehicle(world, home, homeState, target, 'ship', 5, 1, 0);
    // Already consumed at dispatch.
    expect(homeState.inventory.foundation_kit).toBe(2);
    // 30 tiles / 0.25 t/s = 120s. (rebalanced step #19)
    tickVehicles(world, islandStates, 121_000);
    // Not consumed again at arrival.
    expect(homeState.inventory.foundation_kit).toBe(2);
  });

  it('vehicle removed from world.vehicles regardless of dispatch ordering', () => {
    const { world, home, homeState, target, islandStates } = setup();
    const target2 = makeIslandSpec({
      id: 'target2',
      cx: 0,
      cy: 20,
      populated: false,
      discovered: true,
    });
    world.islands.push(target2);
    dispatchVehicle(world, home, homeState, target, 'ship', 5, 1, 0);
    dispatchVehicle(world, home, homeState, target2, 'ship', 5, 1, 0);
    expect(world.vehicles).toHaveLength(2);
    // Tick at 85s — target2 (20 tile / 0.25 t/s = 80s) has arrived; target (30 tile / 0.25 t/s = 120s) hasn't. (rebalanced step #19)
    const r = tickVehicles(world, islandStates, 85_000);
    expect(r.arrivals).toHaveLength(1);
    expect(r.arrivals[0]!.targetIslandId).toBe('target2');
    expect(world.vehicles).toHaveLength(1);
    expect(world.vehicles[0]!.target).toBe('target');
  });
});

// ---------------------------------------------------------------------------
// §11.7 tier-matched fuel grades — dispatchVehicle
// ---------------------------------------------------------------------------

describe('dispatchVehicle — §11.7 tier-matched fuel', () => {
  function tieredSetup(level: number): {
    world: WorldState;
    home: IslandSpec;
    homeState: IslandState;
    target: IslandSpec;
  } {
    const home = makeIslandSpec({
      id: 'home',
      cx: 0,
      cy: 0,
      populated: true,
      discovered: true,
      buildings: [{ id: 'sy', defId: 'shipyard', x: 0, y: 0 }],
    });
    const target = makeIslandSpec({
      id: 'target',
      cx: 30,
      cy: 0,
      populated: false,
      discovered: true,
    });
    const world = freshWorld([home, target]);
    const homeState = makeIslandState({ id: 'home', level });
    homeState.inventory.foundation_kit = 3;
    return { world, home, homeState, target };
  }

  it('T1 island (level 1) consumes biofuel and records fuelResource', () => {
    const { world, home, homeState, target } = tieredSetup(1);
    homeState.inventory.biofuel = 50;
    homeState.inventory.diesel = 50; // wrong-grade present, must be untouched
    const r = dispatchVehicle(world, home, homeState, target, 'ship', 5, 1, 0);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.vehicle.fuelResource).toBe('biofuel');
    expect(homeState.inventory.biofuel).toBe(45);
    expect(homeState.inventory.diesel).toBe(50);
  });

  it('T2 island (level 5) consumes diesel (T2 helicopter dispatch)', () => {
    const { world, home, homeState, target } = tieredSetup(5);
    home.buildings.push({ id: 'hp', defId: 'helipad', x: 1, y: 1 });
    homeState.inventory.biofuel = 999;
    homeState.inventory.diesel = 50;
    // helicopter eff 4 t/fuel: 30 tile trip needs ≥ 8 fuel.
    const r = dispatchVehicle(world, home, homeState, target, 'helicopter', 10, 1, 0);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.vehicle.fuelResource).toBe('diesel');
    expect(homeState.inventory.diesel).toBe(40);
    expect(homeState.inventory.biofuel).toBe(999);
  });

  it('T3 island (level 15) consumes aviation_kerosene, NOT biofuel', () => {
    const { world, home, homeState, target } = tieredSetup(15);
    homeState.inventory.biofuel = 999;
    homeState.inventory.aviation_kerosene = 50;
    const r = dispatchVehicle(world, home, homeState, target, 'ship', 5, 1, 0);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.vehicle.fuelResource).toBe('aviation_kerosene');
    expect(homeState.inventory.aviation_kerosene).toBe(45);
    expect(homeState.inventory.biofuel).toBe(999);
  });

  it('T3 island with biofuel but no aviation_kerosene fails insufficient-fuel (no fallback)', () => {
    const { world, home, homeState, target } = tieredSetup(15);
    homeState.inventory.biofuel = 999;
    homeState.inventory.aviation_kerosene = 2;
    const r = dispatchVehicle(world, home, homeState, target, 'ship', 5, 1, 0);
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.reason).toBe('insufficient-fuel');
    expect(homeState.inventory.biofuel).toBe(999);
    expect(homeState.inventory.aviation_kerosene).toBe(2);
    expect(homeState.inventory.foundation_kit).toBe(3);
    expect(world.vehicles).toHaveLength(0);
  });

  it('T4 island (level 30) consumes cryogenic_hydrogen', () => {
    const { world, home, homeState, target } = tieredSetup(30);
    homeState.inventory.cryogenic_hydrogen = 50;
    const r = dispatchVehicle(world, home, homeState, target, 'ship', 5, 1, 0);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.vehicle.fuelResource).toBe('cryogenic_hydrogen');
    expect(homeState.inventory.cryogenic_hydrogen).toBe(45);
  });
});
