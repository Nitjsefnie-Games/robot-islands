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
} from './routes.js';
import {
  _resetVehicleIdCounter,
  dispatchVehicle,
} from './settlement.js';
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
    endgameState: { achieved: new Set(), firstAchievedMs: null },
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
});
