// Pure tests for the shared world-system advance helper.
// Mirrors the server's reliance on this helper without touching the server.

import { beforeEach, describe, expect, it } from 'vitest';

import type { IslandState } from './economy.js';
import {
  _resetDroneIdCounter,
  dispatchDrone,
} from './drones.js';
import { ALL_RESOURCES, type ResourceId } from './recipes.js';
import {
  _resetRouteIdCounter,
  createRouteFromBuilding,
} from './routes.js';
import {
  _resetVehicleIdCounter,
  dispatchVehicle,
} from './settlement.js';
import {
  addDebrisFragments,
  type Satellite,
} from './orbital.js';
import {
  WS_SYSTEMS_MAX_STEPS,
  WS_SYSTEMS_STEP_MS,
  advanceWorldSystems,
} from './world-systems-advance.js';
import { type IslandSpec, type WorldState } from './world.js';

function emptyInv(): Record<ResourceId, number> {
  const inv = {} as Record<ResourceId, number>;
  for (const r of ALL_RESOURCES) inv[r] = 0;
  return inv;
}

function blankCaps(amount: number): Record<ResourceId, number> {
  const caps = {} as Record<ResourceId, number>;
  for (const r of ALL_RESOURCES) caps[r] = amount;
  return caps;
}

function makeIslandState(over: Partial<IslandState> = {}): IslandState {
  const f = {} as Record<ResourceId, number>;
  for (const r of ALL_RESOURCES) f[r] = 0;
  return {
    id: 'home',
    buildings: [],
    inventory: emptyInv(),
    storageCaps: blankCaps(1000),
    xp: 0,
    level: 1,
    unspentSkillPoints: 0,
    unlockedNodes: new Set(),
    unlockedEdges: new Set(),
    auraAmpVersion: 0,
    auraAmpCache: null,
    auraAmpCacheVersion: -1,
    co2Kg: 0,
    funnelPending: f,
    aiCoreCrafted: false,
    ascendantCoreCrafted: false,
    lastResetAt: null,
    timeLockBankedMin: 0,
    accelerationQueue: [],
    accelerationRemainingMin: 0,
    bankingEnabled: false,
    genesisTarget: null,
    batteryStoredWs: 0,
    starterInventoryGrace: {} as Record<ResourceId, number>,
    socketBindings: new Map(),
    everProduced: new Set(),
    tradeCooldownMs: 0,
    tradeAcceptCount: 0,
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
  return {
    islands,
    drones: [],
    routes: [],
    vehicles: [],
    revealedCells: new Set(),
    satellites: [],
    repairDrones: [],
    debrisFields: [],
    latticeActive: false,
    latticeNodeIslands: [],
    commPackets: [],
    totalCo2Kg: 0,
    playerLat: null,
    playerLon: null,
    seed: 'test-seed',
    oceanCells: new Map(),
    depthRevealedCells: new Set(),
    recentBuildAttempts: new Set(),
    recentBuildAttemptTs: new Map(),
  };
}

function makeDroneWorld() {
  const homeSpec = makeIslandSpec({
    id: 'home',
    populated: true,
    discovered: true,
    buildings: [{ id: 'dp', defId: 'dronepad', x: 0, y: 0 }],
  });
  const world = freshWorld([homeSpec]);
  const homeState = makeIslandState({ id: 'home', level: 5 });
  homeState.inventory.diesel = 50;
  const islandStates = new Map<string, IslandState>([['home', homeState]]);
  (world as typeof world & { islandStates: typeof islandStates }).islandStates = islandStates;
  return { world, homeSpec, homeState, islandStates };
}

function makeVehicleWorld() {
  const homeSpec = makeIslandSpec({
    id: 'home',
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
  homeState.inventory.foundation_kit = 3;
  const islandStates = new Map<string, IslandState>([['home', homeState]]);
  (world as typeof world & { islandStates: typeof islandStates }).islandStates = islandStates;
  return { world, homeSpec, homeState, targetSpec, islandStates };
}

function makeRouteWorld() {
  const homeSpec = makeIslandSpec({
    id: 'home',
    populated: true,
    discovered: true,
    buildings: [{ id: 'dock1', defId: 'dock', x: 0, y: 0 }],
  });
  const targetSpec = makeIslandSpec({
    id: 'target',
    cx: 30,
    cy: 0,
    populated: true,
    discovered: true,
  });
  const world = freshWorld([homeSpec, targetSpec]);
  const homeState = makeIslandState({ id: 'home' });
  homeState.inventory.iron_ore = 100;
  const targetState = makeIslandState({ id: 'target' });
  const islandStates = new Map<string, IslandState>([
    ['home', homeState],
    ['target', targetState],
  ]);
  (world as typeof world & { islandStates: typeof islandStates }).islandStates = islandStates;
  const dock = homeSpec.buildings[0]!;
  const route = createRouteFromBuilding(dock, 'home', 'target', 'iron_ore', 30);
  if (route) world.routes.push(route);
  return { world, homeSpec, homeState, targetSpec, targetState, islandStates, route };
}

beforeEach(() => {
  _resetDroneIdCounter();
  _resetVehicleIdCounter();
  _resetRouteIdCounter();
});

describe('advanceWorldSystems', () => {
  it('returns an in-flight drone by the end of the gap', () => {
    const { world, homeState, islandStates } = makeDroneWorld();
    const r = dispatchDrone(world, homeState, 0, 0, 1, 0, 10, 1000, undefined, 2);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const d = r.drone;
    // Flight: launchTime=1000, expectedReturnTime = 1000 + (60/0.5)*1000 = 121_000.
    const res = advanceWorldSystems(world, islandStates, 1000, 130_000, 0);
    expect(d.status).toBe('returned');
    expect(world.drones).toHaveLength(1);
    expect(world.drones[0]!.status).toBe('returned');
    expect(res.dronesReturned).toHaveLength(1);
    expect(res.dronesLost).toHaveLength(0);
    expect(res.steps).toBeGreaterThan(0);
  });

  it('returns an in-flight settlement vehicle by the end of the gap', () => {
    const { world, homeSpec, homeState, targetSpec, islandStates } = makeVehicleWorld();
    const r = dispatchVehicle(world, homeSpec, homeState, targetSpec, 'ship', 1, 60, 1, 0);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const v = r.vehicle;
    // 30 tiles / 0.25 t/s = 120s → expectedArrivalTime = 120_000.
    const res = advanceWorldSystems(world, islandStates, 0, 121_000, 0);
    expect(v.status).toBe('arrived');
    expect(targetSpec.populated).toBe(true);
    expect(islandStates.has('target')).toBe(true);
    expect(res.vehicleArrivals).toHaveLength(1);
    expect(res.vehicleArrivals[0]!.targetIslandId).toBe('target');
  });

  it('runs in bounded steps for a very large offline gap', () => {
    const { world, homeState, islandStates } = makeDroneWorld();
    const r = dispatchDrone(world, homeState, 0, 0, 1, 0, 10, 1000, undefined, 2);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const gapMs = 40 * 24 * 3600 * 1000;
    const res = advanceWorldSystems(world, islandStates, 1000, 1000 + gapMs, 0);
    expect(res.steps).toBeLessThanOrEqual(WS_SYSTEMS_MAX_STEPS);
    expect(res.steps).toBeGreaterThan(1);
    // stepMs scaled up: a short gap uses 1s steps; a 40-day gap must use larger steps.
    const expectedStepMs = Math.max(WS_SYSTEMS_STEP_MS, Math.ceil(gapMs / WS_SYSTEMS_MAX_STEPS));
    expect(expectedStepMs).toBeGreaterThan(WS_SYSTEMS_STEP_MS);
    expect(res.dronesReturned).toHaveLength(1);
  });

  it('discovers islands that overlap populated vision halos (#59)', () => {
    const homeSpec = makeIslandSpec({
      id: 'home',
      populated: true,
      discovered: true,
    });
    // Within home's padded halo: r5 + VISION_PADDING_TILES (10) = 15.
    const nearSpec = makeIslandSpec({
      id: 'near',
      cx: 12,
      cy: 0,
      populated: false,
      discovered: false,
    });
    const world = freshWorld([homeSpec, nearSpec]);
    const homeState = makeIslandState({ id: 'home' });
    const islandStates = new Map<string, IslandState>([['home', homeState]]);
    (world as typeof world & { islandStates: typeof islandStates }).islandStates = islandStates;

    const res = advanceWorldSystems(world, islandStates, 0, 1000, 0);

    expect(res.newlyDiscoveredIslandIds).toContain('near');
    expect(nearSpec.discovered).toBe(true);
  });

  it('advances routes (dispatches + delivers cargo) over the offline window (#84)', () => {
    const { world, islandStates } = makeRouteWorld();
    const res = advanceWorldSystems(world, islandStates, 0, 120_000, 0);
    expect(res.routeDispatches.length).toBeGreaterThan(0);
    expect(res.routeArrivals.length).toBeGreaterThan(0);
    const targetState = islandStates.get('target');
    expect(targetState?.inventory.iron_ore ?? 0).toBeGreaterThan(0);
  });

  it('orbital debris/scanner rolls are identical for different nowMs inside the same step (#53)', () => {
    function buildWorld() {
      const homeSpec = makeIslandSpec({
        id: 'home',
        populated: true,
        discovered: true,
        cx: 0,
        cy: 0,
        majorRadius: 6,
        minorRadius: 6,
      });
      const targetSpec = makeIslandSpec({
        id: 'target',
        populated: false,
        discovered: false,
        cx: 50,
        cy: 0,
        majorRadius: 4,
        minorRadius: 4,
      });
      const world = freshWorld([homeSpec, targetSpec]);
      const homeState = makeIslandState({ id: 'home' });
      const islandStates = new Map<string, IslandState>([['home', homeState]]);
      (world as typeof world & { islandStates: typeof islandStates }).islandStates = islandStates;

      const scanner: Satellite = {
        id: 'sat-scan',
        variant: 'scanner',
        spaceportIslandId: 'home',
        x: 50,
        y: 0,
        commRange: 0,
        coverageRadius: 120,
        fuel: 0,
        lodges: { scan: 0, weather: 0, comm: 0 },
        locked: true,
        pendingRepairDroneId: null,
        buffer: [],
      };
      const victim: Satellite = {
        id: 'sat-victim',
        variant: 'sweeper',
        spaceportIslandId: 'home',
        x: 0,
        y: 0,
        commRange: 0,
        coverageRadius: 0,
        fuel: 0,
        lodges: { scan: 0, weather: 0, comm: 0 },
        locked: true,
        pendingRepairDroneId: null,
        buffer: [],
      };
      world.satellites.push(scanner, victim);
      addDebrisFragments(world, 0, 0, 2000);
      return { world, islandStates, scanner, victim, targetSpec };
    }

    const a = buildWorld();
    const b = buildWorld();
    const resA = advanceWorldSystems(a.world, a.islandStates, 0, 300, 0);
    const resB = advanceWorldSystems(b.world, b.islandStates, 0, 700, 0);

    // Both trailing nowMs fall inside the same bounded step (step index 0), so
    // the recomputed partial step must resolve identically.
    expect(resA.newlyDiscoveredIslandIds).toEqual(resB.newlyDiscoveredIslandIds);
    expect(a.targetSpec.discovered).toBe(b.targetSpec.discovered);
    expect(a.scanner.lodges).toEqual(b.scanner.lodges);
    expect(a.victim.lodges).toEqual(b.victim.lodges);
    expect(a.world.satellites.map((s) => s.id)).toEqual(b.world.satellites.map((s) => s.id));
  });
});
