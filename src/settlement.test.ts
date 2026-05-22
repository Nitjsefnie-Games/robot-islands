// Settlement vehicles: pure-logic tests for §12 dispatch validation +
// arrival mutation semantics.

import { beforeEach, describe, expect, it } from 'vitest';

import { advanceIsland, type IslandState } from './economy.js';
import { ALL_RESOURCES, type ResourceId } from './recipes.js';
import { makeSeededRng } from './rng.js';
import type { SettlementVehicle } from './settlement.js';
import {
  _resetRouteIdCounter,
  deliverArrivals,
} from './routes.js';
import {
  HELICOPTER_STATS,
  SHIP_STATS,
  _nearestPatronHub,
  _resetVehicleIdCounter,
  dispatchVehicle,
  hasLaunchBuildingFor,
  tickVehicles,
  tuningFor,
} from './settlement.js';
import { deserializeWorld, serializeWorld, type SaveSnapshot } from './persistence.js';
import { rasterizePath, rollVehicleDestruction, weather } from './weather.js';
import { type IslandSpec, type WorldState } from './world.js';
import { islandInscribedAny } from './island.js';

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
    lastResetAt: null,
    timeLockBankedMin: 0,
    accelerationQueue: [],
    accelerationRemainingMin: 0,
    bankingEnabled: false,
    genesisTarget: null,
    singularityStoredWs: 0,
    starterInventoryGrace: {} as Record<ResourceId, number>,
    lastTick: 0,
    ...over,
  };
}

function makeIslandSpec(over: Partial<IslandSpec>): IslandSpec {
  return {
    id: 'spec',
    name: 'spec',
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
  return { islands, drones: [], routes: [], vehicles: [], revealedCells: new Set(), satellites: [], repairDrones: [],
    debrisFields: [], endgameState: { achieved: new Set(), firstAchievedMs: null }, latticeActive: false, latticeNodeIslands: [],
    commPackets: [], seed: 'test-seed', oceanCells: new Map(), depthRevealedCells: new Set() };
}

function makeTestWorld(): {
  world: WorldState;
  homeSpec: IslandSpec;
  homeState: IslandState;
  targetSpec: IslandSpec;
  islandStates: Map<string, IslandState>;
} {
  const homeSpec = makeIslandSpec({
    id: 'home',
    cx: 0,
    cy: 0,
    populated: true,
    discovered: true,
    buildings: [{ id: 'sy', defId: 'shipyard', x: 0, y: 0 }],
  });
  const targetSpec = makeIslandSpec({
    id: 'target',
    cx: 30,
    cy: 0,
    populated: false,
    discovered: true,
  });
  const world = freshWorld([homeSpec, targetSpec]);
  const homeState = makeIslandState({ id: 'home', level: 30 });
  homeState.inventory.biofuel = 200;
  homeState.inventory.diesel = 200;
  homeState.inventory.aviation_kerosene = 50;
  homeState.inventory.cryogenic_hydrogen = 50;
  const islandStates = new Map<string, IslandState>([['home', homeState]]);
  return { world, homeSpec, homeState, targetSpec, islandStates };
}

beforeEach(() => {
  _resetVehicleIdCounter();
  _resetRouteIdCounter();
});

// ---------------------------------------------------------------------------
// Tuning sanity
// ---------------------------------------------------------------------------

describe('vehicle tuning', () => {
  it('ship tuning is T1, slow, fuel-efficient', () => {
    const t = tuningFor('ship', 1);
    expect(t.tier).toBe(1);
    expect(t.speed).toBe(SHIP_STATS[1].speed);
    expect(t.tilesPerFuel).toBe(SHIP_STATS[1].tilesPerFuel);
  });

  it('helicopter tuning is T2, fast, fuel-hungry', () => {
    const t = tuningFor('helicopter', 2);
    expect(t.tier).toBe(2);
    expect(t.tilesPerFuel).toBe(HELICOPTER_STATS[2].tilesPerFuel);
    // Heli is faster than ship per §12.6.
    expect(t.speed).toBeGreaterThan(SHIP_STATS[1].speed);
  });
});

// ---------------------------------------------------------------------------
// Per-tier vehicle stats
// ---------------------------------------------------------------------------

describe('per-tier vehicle stats', () => {
  it('T3 ship is faster than T1 ship', () => {
    expect(SHIP_STATS[3].speed).toBeGreaterThan(SHIP_STATS[1].speed);
  });
  it('T4 VTOL carries 2 kits', () => {
    expect(HELICOPTER_STATS[4].maxKits).toBe(2);
  });
  it('T1 ship has 2% failure rate', () => {
    expect(SHIP_STATS[1].failureRate).toBe(0.02);
  });
  it('T3 ship drops starter buildings on arrival', () => {
    const { world, homeSpec, homeState, targetSpec, islandStates } = makeTestWorld();
    homeState.inventory.foundation_kit = 1;
    homeState.inventory.biofuel = 10;
    const r = dispatchVehicle(world, homeSpec, homeState, targetSpec, 'ship', 3, 9, 1, 0);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    tickVehicles(world, islandStates, r.vehicle.expectedArrivalTime + 1);
    expect(targetSpec.buildings.some((b) => b.defId === 'solar')).toBe(true);
    expect(targetSpec.buildings.some((b) => b.defId === 'workshop')).toBe(true);
    expect(targetSpec.buildings.some((b) => b.defId === 'mine')).toBe(true);
  });
  it('T4 ship arrival grants 6 free skill points', () => {
    const { world, homeSpec, homeState, targetSpec, islandStates } = makeTestWorld();
    homeState.inventory.foundation_kit = 1;
    homeState.inventory.biofuel = 10;
    const r = dispatchVehicle(world, homeSpec, homeState, targetSpec, 'ship', 4, 6, 1, 0);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    tickVehicles(world, islandStates, r.vehicle.expectedArrivalTime + 1);
    const newState = islandStates.get(targetSpec.id);
    expect(newState).toBeDefined();
    expect(newState!.unspentSkillPoints).toBe(6);
  });
  it('T2 arrival grants no free skill points', () => {
    const { world, homeSpec, homeState, targetSpec, islandStates } = makeTestWorld();
    homeState.inventory.foundation_kit = 1;
    homeState.inventory.biofuel = 10;
    const r = dispatchVehicle(world, homeSpec, homeState, targetSpec, 'ship', 2, 15, 1, 0);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    tickVehicles(world, islandStates, r.vehicle.expectedArrivalTime + 1);
    const newState = islandStates.get(targetSpec.id);
    expect(newState).toBeDefined();
    expect(newState!.unspentSkillPoints).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// §12.4 starter building inscription — small biomes
// ---------------------------------------------------------------------------

describe('§12.4 starter building inscription', () => {
  function makeArrivalSetup(targetRadius: number): {
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
      majorRadius: 14,
      minorRadius: 14,
      buildings: [{ id: 'sy', defId: 'shipyard', x: 0, y: 0 }],
    });
    // Target is the colony being settled — distinct location, small radius.
    const target = makeIslandSpec({
      id: 'target',
      cx: 30,
      cy: 0,
      populated: false,
      discovered: true,
      majorRadius: targetRadius,
      minorRadius: targetRadius,
    });
    const world = freshWorld([home, target]);
    const homeState = makeIslandState({ id: 'home', level: 30 });
    homeState.inventory.biofuel = 50;
    homeState.inventory.diesel = 50;
    homeState.inventory.aviation_kerosene = 50;
    homeState.inventory.cryogenic_hydrogen = 50;
    homeState.inventory.foundation_kit = 3;
    const islandStates = new Map<string, IslandState>([['home', homeState]]);
    return { world, home, homeState, target, islandStates };
  }

  it('T4 ship into a Volcanic r=7 colony: every starter is inscribed and unique', () => {
    const { world, home, homeState, target, islandStates } = makeArrivalSetup(7);
    const r = dispatchVehicle(world, home, homeState, target, 'ship', 4, 6, 1, 0);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    tickVehicles(world, islandStates, r.vehicle.expectedArrivalTime + 1);
    // T4 ship places: solar, workshop, mine, coal_gen, crate.
    const starters = target.buildings.filter((b) => b.id.startsWith('target-starter-'));
    expect(starters.length).toBe(5);
    const seen = new Set<string>();
    for (const b of starters) {
      expect(islandInscribedAny(target, b.x, b.y)).toBe(true);
      const key = `${b.x},${b.y}`;
      expect(seen.has(key)).toBe(false);
      seen.add(key);
    }
    // Starter tiles must not collide with the auto-placed dock either.
    const dock = target.buildings.find((b) => b.defId === 'dock');
    expect(dock).toBeDefined();
    expect(seen.has(`${dock!.x},${dock!.y}`)).toBe(false);
  });

  it('T4 ship into an Arctic r=7 colony: every starter is inscribed', () => {
    const { world, home, homeState, target, islandStates } = makeArrivalSetup(7);
    const r = dispatchVehicle(world, home, homeState, target, 'ship', 4, 6, 1, 0);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    tickVehicles(world, islandStates, r.vehicle.expectedArrivalTime + 1);
    const starters = target.buildings.filter((b) => b.id.startsWith('target-starter-'));
    expect(starters.length).toBe(5);
    for (const b of starters) {
      expect(islandInscribedAny(target, b.x, b.y)).toBe(true);
    }
  });

  it('T4 ship into a Plains r=14 colony: 5 unique inscribed starters', () => {
    const { world, home, homeState, target, islandStates } = makeArrivalSetup(14);
    const r = dispatchVehicle(world, home, homeState, target, 'ship', 4, 6, 1, 0);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    tickVehicles(world, islandStates, r.vehicle.expectedArrivalTime + 1);
    const starters = target.buildings.filter((b) => b.id.startsWith('target-starter-'));
    expect(starters.length).toBe(5);
    const seen = new Set<string>();
    for (const b of starters) {
      expect(islandInscribedAny(target, b.x, b.y)).toBe(true);
      seen.add(`${b.x},${b.y}`);
    }
    expect(seen.size).toBe(5);
  });

  it('starter placement is deterministic for identical inputs', () => {
    // Two parallel settlements with the same target geometry — assertions on
    // starter coords must match exactly.
    const a = makeArrivalSetup(7);
    const ra = dispatchVehicle(a.world, a.home, a.homeState, a.target, 'ship', 4, 6, 1, 0);
    expect(ra.ok).toBe(true);
    if (!ra.ok) return;
    tickVehicles(a.world, a.islandStates, ra.vehicle.expectedArrivalTime + 1);
    const startersA = a.target.buildings
      .filter((b) => b.id.startsWith('target-starter-'))
      .map((b) => `${b.defId}@${b.x},${b.y}`);

    _resetVehicleIdCounter();
    _resetRouteIdCounter();
    const b = makeArrivalSetup(7);
    const rb = dispatchVehicle(b.world, b.home, b.homeState, b.target, 'ship', 4, 6, 1, 0);
    expect(rb.ok).toBe(true);
    if (!rb.ok) return;
    tickVehicles(b.world, b.islandStates, rb.vehicle.expectedArrivalTime + 1);
    const startersB = b.target.buildings
      .filter((b) => b.id.startsWith('target-starter-'))
      .map((b) => `${b.defId}@${b.x},${b.y}`);
    expect(startersA).toEqual(startersB);
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
    homeState.inventory.biofuel = 200;
    homeState.inventory.foundation_kit = 3;
    return { world, home, homeState, target };
  }

  it('happy path: deducts fuel + kit, appends vehicle, computes arrival', () => {
    const { world, home, homeState, target } = setup();
    // Distance = 30 tiles; fuel 60 × ship efficiency 0.5 = 30 tile range (covers
    // 30). Travel time = 30 / 0.25 t/s = 120s → arrival at 1000 + 120_000.
    const r = dispatchVehicle(world, home, homeState, target, 'ship', 1, 60, 1, 1000);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(homeState.inventory.biofuel).toBe(140);
    expect(homeState.inventory.foundation_kit).toBe(2);
    expect(world.vehicles).toHaveLength(1);
    expect(r.vehicle.kind).toBe('ship');
    expect(r.vehicle.from).toBe('home');
    expect(r.vehicle.target).toBe('target');
    expect(r.vehicle.fuelLoaded).toBe(60);
    expect(r.vehicle.foundationKitCount).toBe(1);
    expect(r.vehicle.expectedArrivalTime).toBe(1000 + 120_000);
  });

  it('rejects a non-discovered target', () => {
    const { world, home, homeState, target } = setup();
    target.discovered = false;
    const r = dispatchVehicle(world, home, homeState, target, 'ship', 1, 60, 1, 0);
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.reason).toBe('target-not-discovered');
    expect(homeState.inventory.biofuel).toBe(200);
    expect(homeState.inventory.foundation_kit).toBe(3);
    expect(world.vehicles).toHaveLength(0);
  });

  it('rejects an already-populated target', () => {
    const { world, home, homeState, target } = setup();
    target.populated = true;
    const r = dispatchVehicle(world, home, homeState, target, 'ship', 1, 60, 1, 0);
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.reason).toBe('target-populated');
    expect(homeState.inventory.biofuel).toBe(200);
    expect(world.vehicles).toHaveLength(0);
  });

  it('rejects when origin lacks a Shipyard for a ship dispatch', () => {
    const { world, home, homeState, target } = setup();
    home.buildings.length = 0;
    const r = dispatchVehicle(world, home, homeState, target, 'ship', 1, 60, 1, 0);
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.reason).toBe('missing-launch-building');
    expect(homeState.inventory.foundation_kit).toBe(3);
  });

  it('rejects insufficient fuel without mutation', () => {
    const { world, home, homeState, target } = setup();
    homeState.inventory.biofuel = 2;
    const r = dispatchVehicle(world, home, homeState, target, 'ship', 1, 60, 1, 0);
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.reason).toBe('insufficient-fuel');
    expect(homeState.inventory.biofuel).toBe(2);
    expect(homeState.inventory.foundation_kit).toBe(3);
  });

  it('rejects zero or negative fuel as insufficient-fuel', () => {
    const { world, home, homeState, target } = setup();
    const r = dispatchVehicle(world, home, homeState, target, 'ship', 1, 0, 1, 0);
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.reason).toBe('insufficient-fuel');
  });

  it('rejects insufficient foundation kits', () => {
    const { world, home, homeState, target } = setup();
    homeState.inventory.foundation_kit = 0;
    const r = dispatchVehicle(world, home, homeState, target, 'ship', 1, 60, 1, 0);
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.reason).toBe('insufficient-kits');
    expect(homeState.inventory.biofuel).toBe(200);
  });

  it('rejects zero kit count', () => {
    const { world, home, homeState, target } = setup();
    const r = dispatchVehicle(world, home, homeState, target, 'ship', 1, 60, 0, 0);
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.reason).toBe('insufficient-kits');
  });

  it('rejects dispatching to self', () => {
    const { world, home, homeState } = setup();
    const r = dispatchVehicle(world, home, homeState, home, 'ship', 1, 60, 1, 0);
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.reason).toBe('invalid-target');
  });

  it('rejects out-of-range — fuel × efficiency < distance', () => {
    const { world, home, homeState, target } = setup();
    // Distance = 30 tiles; fuel 2 × 0.5 = 1 tile range — insufficient.
    const r = dispatchVehicle(world, home, homeState, target, 'ship', 1, 2, 1, 0);
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.reason).toBe('out-of-range');
    expect(homeState.inventory.biofuel).toBe(200);
    expect(homeState.inventory.foundation_kit).toBe(3);
  });

  it('rejects a second dispatch from same origin to same target', () => {
    const { world, home, homeState, target } = setup();
    expect(dispatchVehicle(world, home, homeState, target, 'ship', 1, 60, 1, 0).ok).toBe(true);
    const r = dispatchVehicle(world, home, homeState, target, 'ship', 1, 60, 1, 0);
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
    expect(dispatchVehicle(world, home, homeState, target, 'ship', 1, 60, 1, 0).ok).toBe(true);
    const r = dispatchVehicle(world, home, homeState, target2, 'ship', 1, 60, 1, 0);
    expect(r.ok).toBe(true);
    expect(world.vehicles).toHaveLength(2);
  });

  it('helicopter dispatch requires a Helipad, not a Shipyard', () => {
    const { world, home, homeState, target } = setup();
    // origin has Shipyard only → helicopter dispatch fails.
    const r1 = dispatchVehicle(world, home, homeState, target, 'helicopter', 2, 60, 1, 0);
    expect(r1.ok).toBe(false);
    if (r1.ok) return;
    expect(r1.reason).toBe('missing-launch-building');
    // Add helipad + T2 fuel → succeeds.
    home.buildings.push({ id: 'hp', defId: 'helipad', x: 1, y: 1 });
    homeState.level = 5;
    homeState.inventory.diesel = 100;
    const r2 = dispatchVehicle(world, home, homeState, target, 'helicopter', 2, 60, 1, 0);
    expect(r2.ok).toBe(true);
  });

  it('rejects tier > origin tier', () => {
    const { world, home, homeState, target } = setup();
    // Origin is T1 (level 1); tier 2 ship is invalid.
    const r = dispatchVehicle(world, home, homeState, target, 'ship', 2, 5, 1, 0);
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.reason).toBe('invalid-tier');
  });

  it('rejects helicopter tier 1 (T1 heli does not exist)', () => {
    const { world, home, homeState, target } = setup();
    home.buildings.push({ id: 'hp', defId: 'helipad', x: 1, y: 1 });
    const r = dispatchVehicle(world, home, homeState, target, 'helicopter', 1, 10, 1, 0);
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.reason).toBe('invalid-tier');
  });

  it('rejects tier 0 as invalid-tier', () => {
    const { world, home, homeState, target } = setup();
    const r = dispatchVehicle(world, home, homeState, target, 'ship', 0 as any, 5, 1, 0);
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.reason).toBe('invalid-tier');
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
    homeState.inventory.biofuel = 200;
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
    dispatchVehicle(world, home, homeState, target, 'ship', 1, 60, 1, 1000);
    // Travel 120s → arrives at 121_000.
    const r = tickVehicles(world, islandStates, 5_000);
    expect(r.arrivals).toHaveLength(0);
    expect(world.vehicles).toHaveLength(1);
    expect(target.populated).toBe(false);
  });

  it('populates target on arrival, places auto Cargo Dock, creates IslandState', () => {
    const { world, home, homeState, target, islandStates } = setup();
    dispatchVehicle(world, home, homeState, target, 'ship', 1, 60, 1, 0);
    // Travel 120s → arrives at 120_000.
    const r = tickVehicles(world, islandStates, 121_000);
    expect(r.arrivals).toHaveLength(1);
    expect(r.arrivals[0]!.targetIslandId).toBe('target');
    expect(r.arrivals[0]!.fromIslandId).toBe('home');
    expect(r.arrivals[0]!.kind).toBe('ship');
    expect(world.vehicles).toHaveLength(1);
    expect(world.vehicles[0]!.status).toBe('arrived');
    expect(target.populated).toBe(true);
    expect(islandStates.has('target')).toBe(true);
    // Auto-placed Cargo Dock on a coastal tile within the target's
    // ellipse — `findCoastalTile` walks the bounding box in scan order
    // and picks the first inscribed tile bordering an outside neighbour.
    // For a 4-radius round island the first such tile is on the top edge.
    const dock = target.buildings.find((b) => b.defId === 'dock');
    expect(dock).toBeDefined();
    expect(target.buildings.some((b) => b.defId === 'dock')).toBe(true);
    // State.buildings should reference the same array as spec.buildings.
    const targetState = islandStates.get('target')!;
    expect(targetState.buildings).toBe(target.buildings);
  });

  it('places an auto Helipad for a helicopter arrival', () => {
    const { world, home, homeState, target, islandStates } = setup();
    home.buildings.push({ id: 'hp', defId: 'helipad', x: 1, y: 1 });
    homeState.level = 5;
    homeState.inventory.diesel = 100;
    // Helicopter T2: speed 0.75 t/s, eff 0.5 tiles/fuel. 30 tile trip = 40s. Need
    // 30/0.5 = 60 fuel min. Use 60 fuel.
    dispatchVehicle(world, home, homeState, target, 'helicopter', 2, 60, 1, 0);
    tickVehicles(world, islandStates, 41_000);
    expect(target.populated).toBe(true);
    const heliBuilding = target.buildings.find((b) => b.defId === 'helipad');
    expect(heliBuilding).toBeDefined();
    expect(target.buildings.find((b) => b.defId === 'dock')).toBeUndefined();
  });

  it('does not double-populate when target was already populated mid-flight', () => {
    const { world, home, homeState, target, islandStates } = setup();
    dispatchVehicle(world, home, homeState, target, 'ship', 1, 60, 1, 0);
    // External path populates the target before the tick fires.
    target.populated = true;
    // 30 tiles / 0.25 t/s = 120s.
    const r = tickVehicles(world, islandStates, 121_000);
    expect(r.arrivals).toHaveLength(1);
    // Target stays populated; vehicle consumed (lost cargo) but no new
    // IslandState was created since one might already exist.
    expect(world.vehicles).toHaveLength(1);
    expect(world.vehicles[0]!.status).toBe('arrived');
    expect(target.populated).toBe(true);
  });

  it('foundation_kit is consumed on dispatch (not on arrival)', () => {
    const { world, home, homeState, target, islandStates } = setup();
    expect(homeState.inventory.foundation_kit).toBe(3);
    dispatchVehicle(world, home, homeState, target, 'ship', 1, 60, 1, 0);
    // Already consumed at dispatch.
    expect(homeState.inventory.foundation_kit).toBe(2);
    // 30 tiles / 0.25 t/s = 120s.
    tickVehicles(world, islandStates, 121_000);
    // Not consumed again at arrival.
    expect(homeState.inventory.foundation_kit).toBe(2);
  });

  it('keeps arrived vehicle in world.vehicles with status arrived', () => {
    const { world, home, homeState, target, islandStates } = setup();
    const target2 = makeIslandSpec({
      id: 'target2',
      cx: 0,
      cy: 20,
      populated: false,
      discovered: true,
    });
    world.islands.push(target2);
    dispatchVehicle(world, home, homeState, target, 'ship', 1, 60, 1, 0);
    dispatchVehicle(world, home, homeState, target2, 'ship', 1, 60, 1, 0);
    expect(world.vehicles).toHaveLength(2);
    // Tick at 85s — target2 (20 tile / 0.25 t/s = 80s) has arrived; target (30 tile / 0.25 t/s = 120s) hasn't.
    const r = tickVehicles(world, islandStates, 85_000);
    expect(r.arrivals).toHaveLength(1);
    expect(r.arrivals[0]!.targetIslandId).toBe('target2');
    expect(world.vehicles).toHaveLength(2);
    const active = world.vehicles.filter((v) => v.status === 'active' || v.status === undefined);
    expect(active).toHaveLength(1);
    expect(active[0]!.target).toBe('target');
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
    homeState.inventory.biofuel = 100;
    homeState.inventory.diesel = 50; // wrong-grade present, must be untouched
    const r = dispatchVehicle(world, home, homeState, target, 'ship', 1, 60, 1, 0);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.vehicle.fuelResource).toBe('biofuel');
    expect(homeState.inventory.biofuel).toBe(40);
    expect(homeState.inventory.diesel).toBe(50);
  });

  it('T2 island (level 5) consumes diesel (T2 helicopter dispatch)', () => {
    const { world, home, homeState, target } = tieredSetup(5);
    home.buildings.push({ id: 'hp', defId: 'helipad', x: 1, y: 1 });
    homeState.inventory.biofuel = 999;
    homeState.inventory.diesel = 100;
    // helicopter T2 eff 0.5 t/fuel: 30 tile trip needs ≥ 60 fuel.
    const r = dispatchVehicle(world, home, homeState, target, 'helicopter', 2, 60, 1, 0);
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
    const r = dispatchVehicle(world, home, homeState, target, 'ship', 3, 9, 1, 0);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.vehicle.fuelResource).toBe('aviation_kerosene');
    expect(homeState.inventory.aviation_kerosene).toBe(41);
    expect(homeState.inventory.biofuel).toBe(999);
  });

  it('T3 island with biofuel but no aviation_kerosene fails insufficient-fuel (no fallback)', () => {
    const { world, home, homeState, target } = tieredSetup(15);
    homeState.inventory.biofuel = 999;
    homeState.inventory.aviation_kerosene = 2;
    const r = dispatchVehicle(world, home, homeState, target, 'ship', 3, 9, 1, 0);
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
    const r = dispatchVehicle(world, home, homeState, target, 'ship', 4, 6, 1, 0);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.vehicle.fuelResource).toBe('cryogenic_hydrogen');
    expect(homeState.inventory.cryogenic_hydrogen).toBe(44);
  });
});

describe('mechanical failure §12.5', () => {
  it('deterministically fails a T1 ship with a known seed', () => {
    const origin = makeIslandSpec({
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
    const world = freshWorld([origin, target]);
    const originState = makeIslandState({ id: 'home' });
    originState.inventory.biofuel = 100;
    originState.inventory.foundation_kit = 1;

    // Brute-force a launchTime that causes failure for id 'vehicle-1'.
    let launchTime = 0;
    while (true) {
      const rng = makeSeededRng(`vehicle-1:${launchTime}`);
      if (rng() < 0.02) break;
      launchTime += 1;
    }

    const result = dispatchVehicle(world, origin, originState, target, 'ship', 1, 60, 1, launchTime);
    expect(result.ok).toBe(true);
    const v = (result as any).vehicle as SettlementVehicle;

    const tickResult = tickVehicles(world, new Map(), v.expectedArrivalTime + 1);
    expect(tickResult.failures.length).toBe(1);
    expect(tickResult.arrivals.length).toBe(0);
    expect(target.populated).toBe(false);
  });

  it('deterministically succeeds a T2 helicopter with a known seed', () => {
    const origin = makeIslandSpec({
      id: 'home',
      cx: 0,
      cy: 0,
      populated: true,
      discovered: true,
      buildings: [
        { id: 'sy', defId: 'shipyard', x: 0, y: 0 },
        { id: 'hp', defId: 'helipad', x: 1, y: 1 },
      ],
    });
    const target = makeIslandSpec({
      id: 'target',
      cx: 30,
      cy: 0,
      populated: false,
      discovered: true,
    });
    const world = freshWorld([origin, target]);
    const originState = makeIslandState({ id: 'home', level: 5 });
    originState.inventory.diesel = 100;
    originState.inventory.foundation_kit = 1;

    let launchTime = 0;
    while (true) {
      const rng = makeSeededRng(`vehicle-1:${launchTime}`);
      if (rng() >= 0.01) break;
      launchTime += 1;
    }

    const result = dispatchVehicle(world, origin, originState, target, 'helicopter', 2, 60, 1, launchTime);
    expect(result.ok).toBe(true);
    const v = (result as any).vehicle as SettlementVehicle;

    const tickResult = tickVehicles(world, new Map(), v.expectedArrivalTime + 1);
    expect(tickResult.failures.length).toBe(0);
    expect(tickResult.arrivals.length).toBe(1);
    expect(target.populated).toBe(true);
  });
});

describe('§12.4 foundation kit decomposition', () => {
  it('credits kit recipe inputs to the new colony on arrival', () => {
    const { world, homeSpec, homeState, targetSpec, islandStates } = makeTestWorld();
    homeState.inventory.foundation_kit = 1;
    homeState.inventory.biofuel = 100;
    const r = dispatchVehicle(world, homeSpec, homeState, targetSpec, 'ship', 1, 60, 1, 0);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    tickVehicles(world, islandStates, r.vehicle.expectedArrivalTime + 1);
    const newState = islandStates.get(targetSpec.id);
    expect(newState).toBeDefined();
    // kit_assembler inputs: { iron_ingot: 5, wood: 10, bolt: 5 }
    // startingInventory seeds wood=40, foundation_kit=1.
    expect(newState!.inventory.iron_ingot).toBe(5);
    expect(newState!.inventory.wood).toBe(50);
    expect(newState!.inventory.bolt).toBe(5);
  });

  it('multiplies decomposition by foundationKitCount', () => {
    const { world, homeSpec, homeState, targetSpec, islandStates } = makeTestWorld();
    homeState.inventory.foundation_kit = 2;
    homeState.inventory.biofuel = 100;
    const r = dispatchVehicle(world, homeSpec, homeState, targetSpec, 'ship', 1, 60, 2, 0);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    tickVehicles(world, islandStates, r.vehicle.expectedArrivalTime + 1);
    const newState = islandStates.get(targetSpec.id);
    expect(newState!.inventory.iron_ingot).toBe(10);
    expect(newState!.inventory.wood).toBe(60); // 40 starter + 20 from 2 kits
    expect(newState!.inventory.bolt).toBe(10);
  });
});

// ---------------------------------------------------------------------------
// §12.4 Foundation Kit starter-inventory grace cap
// ---------------------------------------------------------------------------

describe('§12.4 Foundation Kit starter-inventory grace cap', () => {
  it('arriving colony holds kit raw contents above zero normal cap', () => {
    const { world, homeSpec, homeState, targetSpec, islandStates } = makeTestWorld();
    homeState.inventory.foundation_kit = 1;
    homeState.inventory.biofuel = 100;
    const r = dispatchVehicle(world, homeSpec, homeState, targetSpec, 'ship', 1, 60, 1, 0);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    tickVehicles(world, islandStates, r.vehicle.expectedArrivalTime + 1);
    const newState = islandStates.get(targetSpec.id)!;
    // kit_assembler inputs: { iron_ingot: 5, wood: 10, bolt: 5 }
    // startingInventory seeds wood=40, so wood = 50 after kit.
    expect(newState.inventory.iron_ingot).toBe(5);
    expect(newState.inventory.wood).toBe(50);
    expect(newState.inventory.bolt).toBe(5);
    expect(newState.starterInventoryGrace.iron_ingot).toBe(5);
    expect(newState.starterInventoryGrace.wood).toBe(10);
    expect(newState.starterInventoryGrace.bolt).toBe(5);
  });

  it('grace shrinks when normal cap catches up', () => {
    const { world, homeSpec, homeState, targetSpec, islandStates } = makeTestWorld();
    homeState.inventory.foundation_kit = 1;
    homeState.inventory.biofuel = 100;
    const r = dispatchVehicle(world, homeSpec, homeState, targetSpec, 'ship', 1, 60, 1, 0);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    tickVehicles(world, islandStates, r.vehicle.expectedArrivalTime + 1);
    const newState = islandStates.get(targetSpec.id)!;
    // Simulate zero normal cap for kit resources so grace is active.
    newState.storageCaps.iron_ingot = 0;
    newState.storageCaps.bolt = 0;
    // Place a generic Crate labeled for iron_ingot (capacity 100).
    newState.buildings.push({ id: 'crate-1', defId: 'crate', x: 1, y: 1, cargoLabel: 'iron_ingot' });
    newState.storageCaps.iron_ingot += 100;
    // Tick — clearGraceIfRedundant should clear iron_ingot but not bolt.
    advanceIsland(newState, newState.lastTick + 1000);
    expect(newState.starterInventoryGrace.iron_ingot).toBe(0);
    expect(newState.starterInventoryGrace.bolt).toBe(5);
  });

  it('route arrivals respect normal cap, not grace', () => {
    // Colony with 5 iron_ingot under grace but zero normal cap.
    const destState = makeIslandState({ id: 'dest' });
    destState.inventory.iron_ingot = 5;
    destState.starterInventoryGrace.iron_ingot = 5;
    destState.storageCaps.iron_ingot = 0;
    // Source with 10 iron_ingot to ship.
    const srcState = makeIslandState({ id: 'src' });
    srcState.inventory.iron_ingot = 10;
    const route = {
      id: 'r-1',
      from: 'src',
      to: 'dest',
      type: 'cargo' as const,
      capacityPerSec: 1,
      filter: 'iron_ingot' as const,
      priorityList: [],
      transitTimeSec: 0,
      inFlight: [
        {
          resourceId: 'iron_ingot' as const,
          amount: 10,
          arrivalTime: 1000,
          dispatchTime: 0,
        },
      ],
    };
    const world = freshWorld([]);
    world.routes.push(route);
    const states = new Map([
      ['src', srcState],
      ['dest', destState],
    ]);
    const delivered = deliverArrivals(world, states, 2000);
    // Normal cap is 0, so no headroom — route arrival rejected.
    expect(destState.inventory.iron_ingot).toBe(5);
    expect(delivered.length).toBe(0);
  });

  it('grace persists across save/load', () => {
    const world = freshWorld([]);
    const state = makeIslandState({ id: 'home' });
    state.starterInventoryGrace.iron_ingot = 5;
    state.starterInventoryGrace.bolt = 3;
    const states = new Map([['home', state]]);
    const snap = serializeWorld(world, states, 0, 0);
    const json = JSON.parse(JSON.stringify(snap)) as SaveSnapshot;
    const { islandStates: restored } = deserializeWorld(json, 0, 0);
    const r = restored.get('home')!;
    expect(r.starterInventoryGrace.iron_ingot).toBe(5);
    expect(r.starterInventoryGrace.bolt).toBe(3);

    // Legacy saves missing the field default to all-zero grace.
    for (const entry of json.islandStates) {
      delete (entry.state as { starterInventoryGrace?: unknown }).starterInventoryGrace;
    }
    const { islandStates: legacyRestored } = deserializeWorld(json, 0, 0);
    const lr = legacyRestored.get('home')!;
    expect(lr.starterInventoryGrace.iron_ingot).toBe(0);
    expect(lr.starterInventoryGrace.bolt).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// §2.6 vehicle weather destruction
// ---------------------------------------------------------------------------

describe('vehicle weather destruction §2.6', () => {
  function findClearSeed(): string {
    for (let i = 0; i < 1000; i++) {
      const seed = `v-clear-${i}`;
      // Path from (0,0) to (30,0) with cell size 16
      const path = rasterizePath(0, 0, 1, 0, 30, 0.25, 0, 16);
      let allClear = true;
      for (const p of path) {
        if (weather(seed, p.cx, p.cy, p.entryMs).state !== 'clear') {
          allClear = false;
          break;
        }
      }
      if (allClear) return seed;
    }
    throw new Error('no clear seed found');
  }

  function findDestroyingSeed(): string {
    for (let i = 0; i < 10000; i++) {
      const seed = `v-destroy-${i}`;
      if (weather(seed, 0, 0, 0).state !== 'catastrophic') continue;
      const result = rollVehicleDestruction(seed, [{ cx: 0, cy: 0, entryMs: 0 }], 1.0, 'vehicle-1');
      if (result.destroyed) return seed;
    }
    throw new Error('no destroying seed found');
  }

  it('ship in clear weather arrives and populates target', () => {
    const seed = findClearSeed();
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
    const world: WorldState = { ...freshWorld([home, target]), seed };
    const homeState = makeIslandState({ id: 'home' });
    homeState.inventory.biofuel = 100;
    homeState.inventory.foundation_kit = 1;
    const islandStates = new Map<string, IslandState>([['home', homeState]]);

    const r = dispatchVehicle(world, home, homeState, target, 'ship', 1, 60, 1, 0);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const result = tickVehicles(world, islandStates, r.vehicle.expectedArrivalTime + 1);
    expect(result.arrivals).toHaveLength(1);
    expect(result.failures).toHaveLength(0);
    expect(target.populated).toBe(true);
    expect(world.vehicles[0]!.status).toBe('arrived');
  });

  it('ship in catastrophic weather gets destroyed (deterministic)', () => {
    const seed = findDestroyingSeed();
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
    const world: WorldState = { ...freshWorld([home, target]), seed };
    const homeState = makeIslandState({ id: 'home' });
    homeState.inventory.biofuel = 100;
    homeState.inventory.foundation_kit = 1;
    const islandStates = new Map<string, IslandState>([['home', homeState]]);

    const r = dispatchVehicle(world, home, homeState, target, 'ship', 1, 60, 1, 0);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const result = tickVehicles(world, islandStates, r.vehicle.expectedArrivalTime + 1);
    expect(result.arrivals).toHaveLength(0);
    expect(result.lost).toHaveLength(1);
    expect(result.failures).toHaveLength(0);
    expect(target.populated).toBe(false);
    expect(world.vehicles[0]!.status).toBe('lost');
  });
});

// ---------------------------------------------------------------------------
// §9.6 / §12.7 Auto-Patronage
// ---------------------------------------------------------------------------

function makeT3Island(id: string, cx: number, cy: number, opts: { hasPatronHub?: boolean } = {}): IslandSpec {
  return makeIslandSpec({
    id,
    name: id,
    cx,
    cy,
    populated: true,
    discovered: true,
    buildings: opts.hasPatronHub ? [{ id: `${id}-ph`, defId: 'patron_hub', x: 0, y: 0 }] : [],
  });
}

function makeT3State(id: string): IslandState {
  return makeIslandState({ id, level: 15 });
}

function makeNetworkedWorldWithMilestone(
  t3Count: number,
  opts: { hasPatronHub?: boolean; extraHubs?: Array<{ id: string; cx: number; cy: number }> } = {},
): {
  world: WorldState;
  homeSpec: IslandSpec;
  homeState: IslandState;
  targetSpec: IslandSpec;
  islandStates: Map<string, IslandState>;
} {
  const homeSpec = makeIslandSpec({
    id: 'home',
    cx: 0,
    cy: 0,
    populated: true,
    discovered: true,
    buildings: [{ id: 'sy', defId: 'shipyard', x: 0, y: 0 }],
  });
  const islands: IslandSpec[] = [homeSpec];
  const islandStates = new Map<string, IslandState>();
  islandStates.set('home', makeIslandState({ id: 'home', level: 1 }));

  const routes: import('./routes.js').Route[] = [];

  for (let i = 0; i < t3Count; i++) {
    const id = `t3-${i}`;
    const hasHub = opts.hasPatronHub && (opts.extraHubs ? false : i === 0);
    const cx = (i + 1) * 10;
    const cy = 0;
    const island = makeT3Island(id, cx, cy, { hasPatronHub: hasHub });
    islands.push(island);
    const state = makeT3State(id);
    state.buildings = island.buildings;
    islandStates.set(id, state);
    routes.push({
      id: `net-route-${i}`,
      from: 'home',
      to: id,
      type: 'cargo',
      capacityPerSec: 1,
      filter: null,
      priorityList: [],
      transitTimeSec: 1,
      inFlight: [],
    });
  }

  if (opts.extraHubs) {
    for (const h of opts.extraHubs) {
      const hub = makeT3Island(h.id, h.cx, h.cy, { hasPatronHub: true });
      islands.push(hub);
      const state = makeT3State(h.id);
      state.buildings = hub.buildings;
      islandStates.set(h.id, state);
      routes.push({
        id: `net-route-hub-${h.id}`,
        from: 'home',
        to: h.id,
        type: 'cargo',
        capacityPerSec: 1,
        filter: null,
        priorityList: [],
        transitTimeSec: 1,
        inFlight: [],
      });
    }
  }

  const targetSpec = makeIslandSpec({
    id: 'target',
    cx: 5,
    cy: 5,
    populated: false,
    discovered: true,
  });
  islands.push(targetSpec);

  const homeState = islandStates.get('home')!;
  homeState.buildings = homeSpec.buildings;
  homeState.inventory.biofuel = 100;
  homeState.inventory.foundation_kit = 1;

  const world: WorldState = {
    islands,
    drones: [],
    routes,
    vehicles: [],
    revealedCells: new Set(),
    satellites: [],
    repairDrones: [],
    debrisFields: [],
      endgameState: { achieved: new Set(), firstAchievedMs: null },
      latticeActive: false,
      latticeNodeIslands: [],
    commPackets: [],
    oceanCells: new Map(),
    depthRevealedCells: new Set(),
    seed: 'test-seed',
    islandStates,
  };

  return { world, homeSpec, homeState, targetSpec, islandStates };
}

describe('Auto-Patronage §9.6 / §12.7', () => {
  it('spawns 3 routes on settlement when milestone active', () => {
    const { world, homeSpec, homeState, targetSpec, islandStates } = makeNetworkedWorldWithMilestone(
      10,
      { hasPatronHub: true },
    );
    const routeCountBefore = world.routes.length;
    const r = dispatchVehicle(world, homeSpec, homeState, targetSpec, 'ship', 1, 15, 1, 0);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    tickVehicles(world, islandStates, r.vehicle.expectedArrivalTime + 1);
    expect(world.routes.length).toBe(routeCountBefore + 3);

    const newRoutes = world.routes.slice(routeCountBefore);
    expect(newRoutes.every(rt => rt.from === 't3-0')).toBe(true);
    expect(newRoutes.every(rt => rt.to === 'target')).toBe(true);

    const fuelRoute = newRoutes.find(rt => rt.filter !== null);
    expect(fuelRoute).toBeDefined();
    expect(fuelRoute!.filter).toBe('biofuel');

    const kitRoute = newRoutes.find(
      rt => rt.filter === null && rt.priorityList.includes('iron_ingot'),
    );
    expect(kitRoute).toBeDefined();
    expect(kitRoute!.priorityList).toEqual(['iron_ingot', 'brick', 'lumber', 'glass', 'gear']);

    const rawRoute = newRoutes.find(
      rt => rt.filter === null && rt.priorityList.includes('wood'),
    );
    expect(rawRoute).toBeDefined();
    expect(rawRoute!.priorityList).toEqual(['wood', 'stone', 'coal', 'iron_ore', 'copper_ore']);
  });

  it('no-ops when no Patron Hub exists', () => {
    const { world, homeSpec, homeState, targetSpec, islandStates } = makeNetworkedWorldWithMilestone(
      10,
      { hasPatronHub: false },
    );
    const routeCountBefore = world.routes.length;
    const r = dispatchVehicle(world, homeSpec, homeState, targetSpec, 'ship', 1, 15, 1, 0);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    tickVehicles(world, islandStates, r.vehicle.expectedArrivalTime + 1);
    expect(world.routes.length).toBe(routeCountBefore);
  });

  it('no-ops when milestone below 10', () => {
    const { world, homeSpec, homeState, targetSpec, islandStates } = makeNetworkedWorldWithMilestone(
      5,
      { hasPatronHub: true },
    );
    const routeCountBefore = world.routes.length;
    const r = dispatchVehicle(world, homeSpec, homeState, targetSpec, 'ship', 1, 15, 1, 0);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    tickVehicles(world, islandStates, r.vehicle.expectedArrivalTime + 1);
    expect(world.routes.length).toBe(routeCountBefore);
  });

  it('uses nearest Patron Hub by euclidean distance', () => {
    const { world, homeSpec, homeState, targetSpec, islandStates } = makeNetworkedWorldWithMilestone(
      10,
      { hasPatronHub: false, extraHubs: [
        { id: 'near-hub', cx: 0, cy: 0 },
        { id: 'far-hub', cx: 200, cy: 0 },
      ] },
    );
    const routeCountBefore = world.routes.length;
    const r = dispatchVehicle(world, homeSpec, homeState, targetSpec, 'ship', 1, 15, 1, 0);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    tickVehicles(world, islandStates, r.vehicle.expectedArrivalTime + 1);
    expect(world.routes.length).toBe(routeCountBefore + 3);

    const newRoutes = world.routes.slice(routeCountBefore);
    expect(newRoutes.every(rt => rt.from === 'near-hub')).toBe(true);
    expect(newRoutes.every(rt => rt.to === 'target')).toBe(true);
  });

  it('breaks distance ties by lower island ID', () => {
    const hubA = makeT3Island('hub-b', 0, 0, { hasPatronHub: true });
    const hubB = makeT3Island('hub-a', 0, 0, { hasPatronHub: true });
    const target = makeIslandSpec({ id: 'target', cx: 0, cy: 0 });
    const stateA = makeT3State('hub-b');
    stateA.buildings = hubA.buildings;
    const stateB = makeT3State('hub-a');
    stateB.buildings = hubB.buildings;
    const world: WorldState = {
      islands: [hubA, hubB, target],
      drones: [],
      routes: [],
      vehicles: [],
      revealedCells: new Set(),
      satellites: [],
      repairDrones: [],
    debrisFields: [],
      endgameState: { achieved: new Set(), firstAchievedMs: null },
      latticeActive: false,
      latticeNodeIslands: [],
    commPackets: [],
    oceanCells: new Map(),
    depthRevealedCells: new Set(),
      seed: 'test-seed',
      islandStates: new Map([
        ['hub-b', stateA],
        ['hub-a', stateB],
      ]),
    };
    const result = _nearestPatronHub(world, 'target');
    expect(result).not.toBeNull();
    expect(result!.id).toBe('hub-a');
  });
});
