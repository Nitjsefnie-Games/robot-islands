// Orbital mechanics: satellite launch tests (§14.2 / §14.7).

import { describe, expect, it } from 'vitest';

import {
  launchSatellite,
  upgradeSpaceport,
  connectedSatellites,
  appendSatBuffer,
  flushSatBuffer,
  dispatchRepairDrone,
  tickRepairDrones,
  debrisDetectionRangeForIsland,
  ORBITAL_TRACKING_DETECTION_RADIUS_TILES,
  addDebrisFragments,
  debrisHitProbability,
  tickDebris,
  DEBRIS_HIT_CONSTANT,
  DEBRIS_LODGE_MAGNITUDE,
  ORBIT_EXPLOSION_FRAGMENTS,
  SAT_DESTRUCTION_FRAGMENTS,
  SAT_CROSS_SECTION,
  requestSatMove,
  tickSatMovement,
  SAT_FUEL_PER_TILE,
  SAT_MOVE_SPEED_TILES_PER_SEC,
  SAT_MOVE_MISDROP_FRAC_MIN,
  SAT_MOVE_MISDROP_FRAC_MAX,
  SCANNER_INITIAL_P_PER_TICK,
  SCANNER_ASYMPTOTE_P_PER_TICK,
  SCANNER_DWELL_TIME_CONSTANT_MS,
  scannerDiscoveryProbability,
  cellsCoveredBySat,
  tickScannerDiscovery,
  buildCommGraph,
  nextHopToNearestSpaceport,
  tickCommPackets,
  tickSweeperCleanup,
  SWEEPER_CLEAN_RATE_PER_SEC,
  REPAIR_DRONE_FUEL_PER_TILE,
  REPAIR_DRONE_MIN_FUEL,
  mirrorBoost,
  effectiveSolarBoostFor,
  type SatelliteVariant,
  type Satellite,
  type SatBufferEntry,
  type DebrisField,
  type CommPacket,
} from './orbital.js';
import { ALL_RESOURCES, type ResourceId } from './recipes.js';
import {
  makeInitialWorld,
  type WorldState,
} from './world.js';
import type { IslandState } from './economy.js';
import type { IslandSpec } from './world.js';

function emptyInv(): Record<ResourceId, number> {
  const inv = {} as Record<ResourceId, number>;
  for (const r of ALL_RESOURCES) inv[r] = 0;
  return inv;
}

function makeIslandState(over: Partial<IslandState> = {}): IslandState {
  return {
    id: 'home',
    buildings: [],
    inventory: emptyInv(),
    storageCaps: emptyInv(),
    xp: 0,
    level: 1,
    unspentSkillPoints: 0,
    unlockedNodes: new Set(),
    unlockedEdges: new Set(),
    auraAmpVersion: 0,
    auraAmpCache: null,
    auraAmpCacheVersion: -1,
    co2Kg: 0,
    funnelPending: emptyInv(),
    declaredAt: null,
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
    lastTick: 0,
    ...over,
  };
}

function makeWorld(over: Partial<WorldState> = {}): WorldState {
  const base = makeInitialWorld(0);
  return {
    ...base,
    satellites: [],
    repairDrones: [],
    debrisFields: [],
      endgameState: { achieved: new Set(), firstAchievedMs: null },
      latticeActive: false,
      latticeNodeIslands: [],
    ...over,
  };
}

function addSpaceport(
  state: IslandState,
  tier?: number,
): void {
  state.buildings.push({
    id: 'spaceport-1',
    defId: 'spaceport',
    x: 0,
    y: 0,
    ...(tier !== undefined ? { tier } : {}),
  });
}

function stockLaunchResources(
  state: IslandState,
  variant: SatelliteVariant,
): void {
  state.inventory.scanner_sat = variant === 'scanner' ? 1 : 0;
  state.inventory.sweeper_sat = variant === 'sweeper' ? 1 : 0;
  state.inventory.relay_sat = variant === 'relay' ? 1 : 0;
  state.inventory.mirror_sat = variant === 'mirror' ? 1 : 0;
  state.inventory.orbital_insertion_package = 1;
  state.inventory.antimatter_propellant = 1;
}

function stockRepairResources(state: IslandState): void {
  state.inventory.repair_pack = 1;
  state.inventory.antimatter_propellant = 1;
}

// ---------------------------------------------------------------------------
// Prerequisites
// ---------------------------------------------------------------------------

describe('satellite launch prerequisites', () => {
  it('rejects when island does not exist', () => {
    const world = makeWorld();
    const result = launchSatellite(world, 'missing', 'scanner', 50, 50, 0);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toBe('no-island');
  });

  it('rejects when island has no spaceport', () => {
    const world = makeWorld();
    const state = makeIslandState({ id: 'home', ascendantCoreCrafted: true });
    world.islandStates = new Map([['home', state]]);
    const result = launchSatellite(world, 'home', 'scanner', 50, 50, 0);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toBe('no-spaceport');
  });

  it('rejects when ascendant_core has not been crafted', () => {
    const world = makeWorld();
    const state = makeIslandState({ id: 'home', ascendantCoreCrafted: false });
    addSpaceport(state);
    world.islandStates = new Map([['home', state]]);
    const result = launchSatellite(world, 'home', 'scanner', 50, 50, 0);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toBe('no-ascendant-core');
  });

  it('rejects when resources are insufficient', () => {
    const world = makeWorld();
    const state = makeIslandState({ id: 'home', ascendantCoreCrafted: true });
    addSpaceport(state);
    world.islandStates = new Map([['home', state]]);
    const result = launchSatellite(world, 'home', 'scanner', 50, 50, 0);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toBe('insufficient-resources');
  });
});

// ---------------------------------------------------------------------------
// Success roll
// ---------------------------------------------------------------------------

describe('satellite launch success roll', () => {
  it('succeeds at T1 spaceport with a low roll (nowMs=0 → rng≈0.23)', () => {
    const world = makeWorld();
    const state = makeIslandState({ id: 'home', ascendantCoreCrafted: true });
    addSpaceport(state, 1);
    stockLaunchResources(state, 'scanner');
    world.islandStates = new Map([['home', state]]);
    const result = launchSatellite(world, 'home', 'scanner', 50, 50, 0);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(world.satellites).toHaveLength(1);
    expect(result.sat.variant).toBe('scanner');
  });

  it('succeeds at T2 spaceport with a moderate roll (nowMs=3 → rng≈0.32)', () => {
    const world = makeWorld();
    const state = makeIslandState({ id: 'home', ascendantCoreCrafted: true });
    addSpaceport(state, 2);
    stockLaunchResources(state, 'relay');
    world.islandStates = new Map([['home', state]]);
    const result = launchSatellite(world, 'home', 'relay', 50, 50, 3);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(world.satellites).toHaveLength(1);
  });

  it('succeeds at T3 spaceport with a higher roll (nowMs=1 → rng≈0.58)', () => {
    const world = makeWorld();
    const state = makeIslandState({ id: 'home', ascendantCoreCrafted: true });
    addSpaceport(state, 3);
    stockLaunchResources(state, 'sweeper');
    world.islandStates = new Map([['home', state]]);
    const result = launchSatellite(world, 'home', 'sweeper', 50, 50, 1);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(world.satellites).toHaveLength(1);
  });

  it('fails at T1 spaceport with a high roll (nowMs=5 → rng≈0.70)', () => {
    const world = makeWorld();
    const state = makeIslandState({ id: 'home', ascendantCoreCrafted: true });
    addSpaceport(state, 1);
    stockLaunchResources(state, 'scanner');
    world.islandStates = new Map([['home', state]]);
    const result = launchSatellite(world, 'home', 'scanner', 50, 50, 5);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toBe('launch-failure');
    expect(world.satellites).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// §14.5/14.6/14.7 target validation
// ---------------------------------------------------------------------------

describe('satellite launch target validation', () => {
  it('rejects target-at-source (target tile equals Spaceport footprint centre)', () => {
    const world = makeWorld();
    const state = makeIslandState({ id: 'home', ascendantCoreCrafted: true });
    addSpaceport(state, 3);
    stockLaunchResources(state, 'scanner');
    world.islandStates = new Map([['home', state]]);
    // Spaceport at building-local (0,0) on home (cx=0, cy=0), 4×4 footprint
    // → spawn = (0 + 0 + 2, 0 + 0 + 2) = (2, 2). Targeting (2, 2) is the
    // zero-distance launch the validator rejects.
    const result = launchSatellite(world, 'home', 'scanner', 2, 2, 1);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toBe('target-at-source');
    // Resources must NOT be deducted on a validation failure.
    expect(state.inventory.scanner_sat).toBe(1);
    expect(state.inventory.orbital_insertion_package).toBe(1);
    expect(state.inventory.antimatter_propellant).toBe(1);
    expect(world.satellites).toHaveLength(0);
  });

  it('rejects target-out-of-range when target is past sat.fuel / SAT_FUEL_PER_TILE', () => {
    const world = makeWorld();
    const state = makeIslandState({ id: 'home', ascendantCoreCrafted: true });
    addSpaceport(state, 3);
    stockLaunchResources(state, 'scanner');
    world.islandStates = new Map([['home', state]]);
    // Default satFuelReserve multiplier = 1 → launchFuel = 100,
    // maxLaunchRange = 100 / 0.05 = 2000 tiles. Target (5000, 0) is past it.
    const result = launchSatellite(world, 'home', 'scanner', 5000, 0, 1);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toBe('target-out-of-range');
    // Resources must NOT be deducted on a validation failure.
    expect(state.inventory.scanner_sat).toBe(1);
    expect(state.inventory.orbital_insertion_package).toBe(1);
    expect(state.inventory.antimatter_propellant).toBe(1);
    expect(world.satellites).toHaveLength(0);
  });

  it('on success: sat spawns at footprint centre, locked=false, movingTo set to target', () => {
    const world = makeWorld();
    const state = makeIslandState({ id: 'home', ascendantCoreCrafted: true });
    addSpaceport(state, 3);
    stockLaunchResources(state, 'scanner');
    world.islandStates = new Map([['home', state]]);
    // Spawn (2,2) → target (50, 50). dist = hypot(48, 48) = 67.882...
    const nowMs = 1;
    const result = launchSatellite(world, 'home', 'scanner', 50, 50, nowMs);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.sat.x).toBe(2);
    expect(result.sat.y).toBe(2);
    expect(result.sat.locked).toBe(false);
    expect(result.sat.movingTo).toBeDefined();
    expect(result.sat.movingTo!.x).toBe(50);
    expect(result.sat.movingTo!.y).toBe(50);
    const dist = Math.hypot(50 - 2, 50 - 2);
    const expectedArrival = nowMs + (dist / SAT_MOVE_SPEED_TILES_PER_SEC) * 1000;
    expect(result.sat.movingTo!.arrivalMs).toBeCloseTo(expectedArrival, 6);
    // Onboard fuel reduced by trip cost — same model as requestSatMove so
    // launch and subsequent moves share fuel/speed semantics.
    const expectedFuel = 100 - dist * SAT_FUEL_PER_TILE;
    expect(result.sat.fuel).toBeCloseTo(expectedFuel, 6);
  });
});

// ---------------------------------------------------------------------------
// Failure modes
// ---------------------------------------------------------------------------

describe('satellite launch failure modes', () => {
  it('pad explosion reverts the spaceport to tier I (§14.7 — was destroyed pre-fix)', () => {
    const world = makeWorld();
    const state = makeIslandState({ id: 'home', ascendantCoreCrafted: true });
    // T3 spaceport so we can prove the tier-revert path: post-pad-explosion
    // the building must persist with tier === 1.
    addSpaceport(state, 3);
    stockLaunchResources(state, 'scanner');
    world.islandStates = new Map([['home', state]]);
    const result = launchSatellite(world, 'home', 'scanner', 50, 50, 5);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toBe('launch-failure');
    // Resources should NOT be consumed on failure.
    expect(state.inventory.scanner_sat).toBe(1);
    expect(state.inventory.orbital_insertion_package).toBe(1);
    expect(state.inventory.antimatter_propellant).toBe(1);
    // §14.7: Spaceport persists; tier reverts to I.
    const sp = state.buildings.find((b) => b.defId === 'spaceport');
    expect(sp).toBeDefined();
    expect(sp?.tier ?? 1).toBe(1);
  });

  it('orbit explosion does not destroy the spaceport (nowMs=9, T1, second roll≈0.99 ≥ 0.30)', () => {
    const world = makeWorld();
    const state = makeIslandState({ id: 'home', ascendantCoreCrafted: true });
    addSpaceport(state, 1);
    stockLaunchResources(state, 'scanner');
    world.islandStates = new Map([['home', state]]);
    const result = launchSatellite(world, 'home', 'scanner', 50, 50, 9);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toBe('launch-failure');
    // Resources should NOT be consumed on failure.
    expect(state.inventory.scanner_sat).toBe(1);
    // Spaceport should survive.
    expect(state.buildings.some((b) => b.defId === 'spaceport')).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Satellite stats per variant
// ---------------------------------------------------------------------------

describe('satellite stats per variant', () => {
  it('scanner has coverageRadius 400 and commRange 200', () => {
    const world = makeWorld();
    const state = makeIslandState({ id: 'home', ascendantCoreCrafted: true });
    addSpaceport(state, 3);
    stockLaunchResources(state, 'scanner');
    world.islandStates = new Map([['home', state]]);
    const result = launchSatellite(world, 'home', 'scanner', 50, 50, 1);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.sat.coverageRadius).toBe(400);
    expect(result.sat.commRange).toBe(200);
    expect(result.sat.variant).toBe('scanner');
  });

  it('relay has commRange 500 and coverageRadius 0', () => {
    const world = makeWorld();
    const state = makeIslandState({ id: 'home', ascendantCoreCrafted: true });
    addSpaceport(state, 3);
    stockLaunchResources(state, 'relay');
    world.islandStates = new Map([['home', state]]);
    const result = launchSatellite(world, 'home', 'relay', 50, 50, 1);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.sat.commRange).toBe(500);
    expect(result.sat.coverageRadius).toBe(0);
    expect(result.sat.variant).toBe('relay');
  });

  it('sweeper has commRange 200 and coverageRadius 0', () => {
    const world = makeWorld();
    const state = makeIslandState({ id: 'home', ascendantCoreCrafted: true });
    addSpaceport(state, 3);
    stockLaunchResources(state, 'sweeper');
    world.islandStates = new Map([['home', state]]);
    const result = launchSatellite(world, 'home', 'sweeper', 50, 50, 1);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.sat.commRange).toBe(200);
    expect(result.sat.coverageRadius).toBe(0);
    expect(result.sat.variant).toBe('sweeper');
  });
});

// ---------------------------------------------------------------------------
// Resource consumption on success
// ---------------------------------------------------------------------------

describe('satellite launch resource consumption', () => {
  it('deducts payload, insertion package, and propellant on success', () => {
    const world = makeWorld();
    const state = makeIslandState({ id: 'home', ascendantCoreCrafted: true });
    addSpaceport(state, 3);
    stockLaunchResources(state, 'scanner');
    world.islandStates = new Map([['home', state]]);
    const result = launchSatellite(world, 'home', 'scanner', 50, 50, 1);
    expect(result.ok).toBe(true);
    expect(state.inventory.scanner_sat).toBe(0);
    expect(state.inventory.orbital_insertion_package).toBe(0);
    expect(state.inventory.antimatter_propellant).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// Spaceport upgrade
// ---------------------------------------------------------------------------

function stockUpgradeResourcesTier1(state: IslandState): void {
  state.inventory.phase_converter = 5;
  state.inventory.memetic_core = 2;
  state.inventory.cryogenic_hydrogen = 50;
}

function stockUpgradeResourcesTier2(state: IslandState): void {
  state.inventory.reality_anchor = 10;
  state.inventory.memetic_core = 5;
  state.inventory.antimatter_propellant = 100;
}

describe('spaceport upgrade', () => {
  it('rejects when island does not exist', () => {
    const world = makeWorld();
    const result = upgradeSpaceport(world, 'missing');
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toBe('no-island');
  });

  it('upgrades spaceport I -> II with correct cost consumption', () => {
    const world = makeWorld();
    const state = makeIslandState({ id: 'home' });
    addSpaceport(state, 1);
    stockUpgradeResourcesTier1(state);
    world.islandStates = new Map([['home', state]]);
    const result = upgradeSpaceport(world, 'home');
    expect(result.ok).toBe(true);
    const sp = state.buildings.find(b => b.defId === 'spaceport');
    expect(sp?.tier).toBe(2);
    expect(state.inventory.phase_converter).toBe(0);
    expect(state.inventory.memetic_core).toBe(0);
    expect(state.inventory.cryogenic_hydrogen).toBe(0);
  });

  it('upgrades spaceport II -> III with correct cost consumption', () => {
    const world = makeWorld();
    const state = makeIslandState({ id: 'home' });
    addSpaceport(state, 2);
    stockUpgradeResourcesTier2(state);
    world.islandStates = new Map([['home', state]]);
    const result = upgradeSpaceport(world, 'home');
    expect(result.ok).toBe(true);
    const sp = state.buildings.find(b => b.defId === 'spaceport');
    expect(sp?.tier).toBe(3);
    expect(state.inventory.reality_anchor).toBe(0);
    expect(state.inventory.memetic_core).toBe(0);
    expect(state.inventory.antimatter_propellant).toBe(0);
  });

  it('rejects upgrade beyond III', () => {
    const world = makeWorld();
    const state = makeIslandState({ id: 'home' });
    addSpaceport(state, 3);
    world.islandStates = new Map([['home', state]]);
    const result = upgradeSpaceport(world, 'home');
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toBe('max-tier');
  });

  it('rejects upgrade without spaceport', () => {
    const world = makeWorld();
    const state = makeIslandState({ id: 'home' });
    world.islandStates = new Map([['home', state]]);
    const result = upgradeSpaceport(world, 'home');
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toBe('no-spaceport');
  });

  it('rejects upgrade with insufficient resources', () => {
    const world = makeWorld();
    const state = makeIslandState({ id: 'home' });
    addSpaceport(state, 1);
    // Deliberately leave inventory empty.
    world.islandStates = new Map([['home', state]]);
    const result = upgradeSpaceport(world, 'home');
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toBe('insufficient-resources');
  });
});

// ---------------------------------------------------------------------------
// §14.2 debrisDetectionRangeForIsland
// ---------------------------------------------------------------------------

describe('§14.2 debrisDetectionRangeForIsland', () => {
  it('returns 0 for an island with no orbital_tracking_station', () => {
    const world = makeWorld();
    const state = makeIslandState({ id: 'home' });
    world.islandStates = new Map([['home', state]]);
    expect(debrisDetectionRangeForIsland(world, 'home')).toBe(0);
  });

  it('returns ORBITAL_TRACKING_DETECTION_RADIUS_TILES when one station is placed', () => {
    const world = makeWorld();
    const state = makeIslandState({ id: 'home' });
    state.buildings.push({ id: 'ots1', defId: 'orbital_tracking_station', x: 0, y: 0 });
    world.islandStates = new Map([['home', state]]);
    expect(debrisDetectionRangeForIsland(world, 'home')).toBe(ORBITAL_TRACKING_DETECTION_RADIUS_TILES);
  });

  it('returns the constant regardless of how many stations are placed (single-island radius is fixed)', () => {
    const world = makeWorld();
    const state = makeIslandState({ id: 'home' });
    state.buildings.push({ id: 'ots1', defId: 'orbital_tracking_station', x: 0, y: 0 });
    state.buildings.push({ id: 'ots2', defId: 'orbital_tracking_station', x: 3, y: 0 });
    world.islandStates = new Map([['home', state]]);
    expect(debrisDetectionRangeForIsland(world, 'home')).toBe(ORBITAL_TRACKING_DETECTION_RADIUS_TILES);
  });
});

describe('§14.2 upgradeSpaceport spec-literal costs (memetic_core, not stand-in)', () => {
  it('tier 1 → 2 charges memetic_core not eldritch_processor', () => {
    const world = makeWorld();
    const state = makeIslandState({ id: 'home' });
    addSpaceport(state, 1);
    state.inventory.phase_converter = 5;
    state.inventory.memetic_core = 2;
    state.inventory.cryogenic_hydrogen = 50;
    // Deliberately do NOT stock eldritch_processor — the fixture should still succeed.
    world.islandStates = new Map([['home', state]]);
    const result = upgradeSpaceport(world, 'home');
    expect(result.ok).toBe(true);
    expect(state.inventory.memetic_core).toBe(0);
  });

  it('tier 2 → 3 charges memetic_core not eldritch_processor', () => {
    const world = makeWorld();
    const state = makeIslandState({ id: 'home' });
    addSpaceport(state, 2);
    state.inventory.reality_anchor = 10;
    state.inventory.memetic_core = 5;
    state.inventory.antimatter_propellant = 100;
    // Deliberately do NOT stock eldritch_processor.
    world.islandStates = new Map([['home', state]]);
    const result = upgradeSpaceport(world, 'home');
    expect(result.ok).toBe(true);
    expect(state.inventory.memetic_core).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// Comm graph BFS
// ---------------------------------------------------------------------------

function makeMinimalIsland(over: Partial<IslandSpec> & { id: string; cx: number; cy: number }): IslandSpec {
  return {
    name: over.id,
    biome: 'plains',
    majorRadius: 10,
    minorRadius: 10,
    populated: false,
    discovered: false,
    buildings: [],
    modifiers: [],
    ...over,
  } as IslandSpec;
}

function makeMinimalSat(over: Partial<Satellite> & { id: string; x: number; y: number }): Satellite {
  return {
    variant: 'scanner',
    spaceportIslandId: 'home',
    commRange: 200,
    coverageRadius: 0,
    fuel: 100,
    lodges: { scan: 0, weather: 0, comm: 0 },
    locked: true,
    pendingRepairDroneId: null,
    buffer: [],
    ...over,
  } as Satellite;
}

function makeBfsWorld(opts: {
  islands: IslandSpec[];
  islandStates: Map<string, IslandState>;
  satellites: Satellite[];
}): WorldState {
  return {
    islands: opts.islands,
    drones: [],
    routes: [],
    vehicles: [],
    revealedCells: new Set(),
    seed: '0',
    satellites: opts.satellites,
    repairDrones: [],
    debrisFields: [],
      endgameState: { achieved: new Set(), firstAchievedMs: null },
      latticeActive: false,
      latticeNodeIslands: [],
    islandStates: opts.islandStates,
    commPackets: [],
    totalCo2Kg: 0,
    playerLat: null,
    playerLon: null,
    oceanCells: new Map(),
    depthRevealedCells: new Set(),
  } as WorldState;
}

describe('connectedSatellites BFS', () => {
  it('reaches satellites within comm range of a populated spaceport island', () => {
    const island = makeMinimalIsland({ id: 'home', cx: 0, cy: 0, populated: true, buildings: [{ id: 'sp1', defId: 'spaceport', x: 0, y: 0 }] });
    const state = makeIslandState({ id: 'home' });
    addSpaceport(state);
    const sat = makeMinimalSat({ id: 'sat1', x: 100, y: 0, commRange: 200 });
    const world = makeBfsWorld({
      islands: [island],
      islandStates: new Map([['home', state]]),
      satellites: [sat],
    });
    const result = connectedSatellites(world);
    expect(result).toHaveLength(1);
    expect(result[0]!.id).toBe('sat1');
  });

  it('does NOT reach satellites out of range', () => {
    const island = makeMinimalIsland({ id: 'home', cx: 0, cy: 0, populated: true, buildings: [{ id: 'sp1', defId: 'spaceport', x: 0, y: 0 }] });
    const state = makeIslandState({ id: 'home' });
    addSpaceport(state);
    const sat = makeMinimalSat({ id: 'sat1', x: 500, y: 0, commRange: 200 });
    const world = makeBfsWorld({
      islands: [island],
      islandStates: new Map([['home', state]]),
      satellites: [sat],
    });
    const result = connectedSatellites(world);
    expect(result).toHaveLength(0);
  });

  it('does NOT reach unlocked (in-transit) satellites', () => {
    const island = makeMinimalIsland({ id: 'home', cx: 0, cy: 0, populated: true, buildings: [{ id: 'sp1', defId: 'spaceport', x: 0, y: 0 }] });
    const state = makeIslandState({ id: 'home' });
    addSpaceport(state);
    const sat = makeMinimalSat({ id: 'sat1', x: 100, y: 0, commRange: 200, locked: false });
    const world = makeBfsWorld({
      islands: [island],
      islandStates: new Map([['home', state]]),
      satellites: [sat],
    });
    const result = connectedSatellites(world);
    expect(result).toHaveLength(0);
  });

  it('chains through intermediate satellites', () => {
    const island = makeMinimalIsland({ id: 'home', cx: 0, cy: 0, populated: true, buildings: [{ id: 'sp1', defId: 'spaceport', x: 0, y: 0 }] });
    const state = makeIslandState({ id: 'home' });
    addSpaceport(state);
    const satA = makeMinimalSat({ id: 'satA', x: 150, y: 0, commRange: 200 });
    const satB = makeMinimalSat({ id: 'satB', x: 350, y: 0, commRange: 200 });
    const world = makeBfsWorld({
      islands: [island],
      islandStates: new Map([['home', state]]),
      satellites: [satA, satB],
    });
    // home (range 200) reaches satA at dist 150
    // satA (range 200) reaches satB at dist 200
    const result = connectedSatellites(world);
    expect(result.map((s) => s.id)).toEqual(['satA', 'satB']);
  });

  it('only seeds from populated islands with a spaceport', () => {
    const islandA = makeMinimalIsland({ id: 'home', cx: 0, cy: 0, populated: true, buildings: [{ id: 'sp1', defId: 'spaceport', x: 0, y: 0 }] });
    const islandB = makeMinimalIsland({ id: 'away', cx: 1000, cy: 0, populated: true, buildings: [] });
    const stateA = makeIslandState({ id: 'home' });
    addSpaceport(stateA);
    const stateB = makeIslandState({ id: 'away' });
    const sat = makeMinimalSat({ id: 'sat1', x: 100, y: 0, commRange: 200 });
    const world = makeBfsWorld({
      islands: [islandA, islandB],
      islandStates: new Map([['home', stateA], ['away', stateB]]),
      satellites: [sat],
    });
    const result = connectedSatellites(world);
    expect(result).toHaveLength(1);
    expect(result[0]!.id).toBe('sat1');
  });

  it('ground station comm range is 200 at tier 1 (default)', () => {
    const island = makeMinimalIsland({ id: 'home', cx: 0, cy: 0, populated: true });
    const state = makeIslandState({ id: 'home' });
    addSpaceport(state, 1);
    const sat = makeMinimalSat({ id: 'sat1', x: 250, y: 0, commRange: 200 });
    const world = makeBfsWorld({
      islands: [island],
      islandStates: new Map([['home', state]]),
      satellites: [sat],
    });
    const result = connectedSatellites(world);
    expect(result).toHaveLength(0);
  });

  it('ground station comm range is 300 at tier 2', () => {
    const island = makeMinimalIsland({ id: 'home', cx: 0, cy: 0, populated: true });
    const state = makeIslandState({ id: 'home' });
    addSpaceport(state, 2);
    const sat = makeMinimalSat({ id: 'sat1', x: 250, y: 0, commRange: 200 });
    const world = makeBfsWorld({
      islands: [island],
      islandStates: new Map([['home', state]]),
      satellites: [sat],
    });
    const result = connectedSatellites(world);
    expect(result).toHaveLength(1);
    expect(result[0]!.id).toBe('sat1');
  });

  it('ground station comm range is 400 at tier 3', () => {
    const island = makeMinimalIsland({ id: 'home', cx: 0, cy: 0, populated: true });
    const state = makeIslandState({ id: 'home' });
    addSpaceport(state, 3);
    const sat = makeMinimalSat({ id: 'sat1', x: 350, y: 0, commRange: 200 });
    const world = makeBfsWorld({
      islands: [island],
      islandStates: new Map([['home', state]]),
      satellites: [sat],
    });
    const result = connectedSatellites(world);
    expect(result).toHaveLength(1);
    expect(result[0]!.id).toBe('sat1');
  });
});

// ---------------------------------------------------------------------------
// Store-and-forward buffering
// ---------------------------------------------------------------------------

describe('satellite buffer', () => {
  it('appends entries to the buffer', () => {
    const sat = makeMinimalSat({ id: 'sat1', x: 0, y: 0 });
    const entry: SatBufferEntry = { type: 'discovery', payload: { foo: 1 } };
    appendSatBuffer(sat, entry);
    expect(sat.buffer).toHaveLength(1);
    expect(sat.buffer[0]!.type).toBe('discovery');
  });

  it('evicts oldest entry FIFO when buffer exceeds 100 entries', () => {
    const sat = makeMinimalSat({ id: 'sat1', x: 0, y: 0 });
    for (let i = 0; i < 100; i++) {
      appendSatBuffer(sat, { type: 'weather', payload: i });
    }
    expect(sat.buffer).toHaveLength(100);
    expect(sat.buffer[0]!.payload).toBe(0);
    appendSatBuffer(sat, { type: 'weather', payload: 100 });
    expect(sat.buffer).toHaveLength(100);
    expect(sat.buffer[0]!.payload).toBe(1);
    expect(sat.buffer[99]!.payload).toBe(100);
  });

  it('flush returns all entries and empties the buffer', () => {
    const sat = makeMinimalSat({ id: 'sat1', x: 0, y: 0 });
    appendSatBuffer(sat, { type: 'debris', payload: 'a' });
    appendSatBuffer(sat, { type: 'discovery', payload: 'b' });
    const flushed = flushSatBuffer(sat);
    expect(flushed).toHaveLength(2);
    expect(flushed[0]!.type).toBe('debris');
    expect(flushed[1]!.type).toBe('discovery');
    expect(sat.buffer).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// Repair Drone dispatch
// ---------------------------------------------------------------------------

describe('repair drone dispatch', () => {
  it('rejects when target satellite does not exist', () => {
    const world = makeWorld();
    const state = makeIslandState({ id: 'home' });
    addSpaceport(state);
    stockRepairResources(state);
    world.islandStates = new Map([['home', state]]);
    const result = dispatchRepairDrone(world, 'home', 'missing-sat', 0);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toBe('no-satellite');
  });

  it('rejects when island does not exist', () => {
    const world = makeWorld();
    world.satellites.push(makeMinimalSat({ id: 'sat1', x: 0, y: 0 }));
    const result = dispatchRepairDrone(world, 'missing', 'sat1', 0);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toBe('no-island');
  });

  it('rejects when island has no spaceport', () => {
    const world = makeWorld();
    world.satellites.push(makeMinimalSat({ id: 'sat1', x: 0, y: 0 }));
    const state = makeIslandState({ id: 'home' });
    world.islandStates = new Map([['home', state]]);
    const result = dispatchRepairDrone(world, 'home', 'sat1', 0);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toBe('no-spaceport');
  });

  it('rejects when ascendant_core has not been crafted', () => {
    const world = makeWorld();
    world.satellites.push(makeMinimalSat({ id: 'sat1', x: 0, y: 0 }));
    const state = makeIslandState({ id: 'home', ascendantCoreCrafted: false });
    addSpaceport(state);
    stockRepairResources(state);
    world.islandStates = new Map([['home', state]]);
    const result = dispatchRepairDrone(world, 'home', 'sat1', 0);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toBe('no-ascendant-core');
  });

  it('rejects when repair_pack is missing', () => {
    const world = makeWorld();
    world.satellites.push(makeMinimalSat({ id: 'sat1', x: 0, y: 0 }));
    const state = makeIslandState({ id: 'home', ascendantCoreCrafted: true });
    addSpaceport(state);
    state.inventory.antimatter_propellant = 1;
    world.islandStates = new Map([['home', state]]);
    const result = dispatchRepairDrone(world, 'home', 'sat1', 0);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toBe('insufficient-repair-pack');
  });

  it('rejects when antimatter_propellant is missing', () => {
    const world = makeWorld();
    world.satellites.push(makeMinimalSat({ id: 'sat1', x: 0, y: 0 }));
    const state = makeIslandState({ id: 'home', ascendantCoreCrafted: true });
    addSpaceport(state);
    state.inventory.repair_pack = 1;
    world.islandStates = new Map([['home', state]]);
    const result = dispatchRepairDrone(world, 'home', 'sat1', 0);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toBe('insufficient-fuel');
  });

  it('dispatches a drone and sets pendingRepairDroneId', () => {
    const world = makeWorld();
    world.satellites.push(makeMinimalSat({ id: 'sat1', x: 0, y: 0 }));
    const state = makeIslandState({ id: 'home', ascendantCoreCrafted: true });
    addSpaceport(state);
    stockRepairResources(state);
    world.islandStates = new Map([['home', state]]);
    const result = dispatchRepairDrone(world, 'home', 'sat1', 0);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(world.repairDrones).toHaveLength(1);
    expect(world.repairDrones[0]!.targetSatId).toBe('sat1');
    expect(world.satellites[0]!.pendingRepairDroneId).toBe(result.drone.id);
  });

  it('blocks second dispatch while repair pending', () => {
    const world = makeWorld();
    world.satellites.push(makeMinimalSat({ id: 'sat1', x: 0, y: 0 }));
    const state = makeIslandState({ id: 'home', ascendantCoreCrafted: true });
    addSpaceport(state);
    stockRepairResources(state);
    world.islandStates = new Map([['home', state]]);
    const first = dispatchRepairDrone(world, 'home', 'sat1', 0);
    expect(first.ok).toBe(true);
    const second = dispatchRepairDrone(world, 'home', 'sat1', 1);
    expect(second.ok).toBe(false);
    if (second.ok) return;
    expect(second.reason).toBe('repair-pending');
  });

  it('deducts repair_pack and antimatter_propellant on dispatch', () => {
    const world = makeWorld();
    world.satellites.push(makeMinimalSat({ id: 'sat1', x: 0, y: 0 }));
    const state = makeIslandState({ id: 'home', ascendantCoreCrafted: true });
    addSpaceport(state);
    stockRepairResources(state);
    world.islandStates = new Map([['home', state]]);
    const result = dispatchRepairDrone(world, 'home', 'sat1', 0);
    expect(result.ok).toBe(true);
    expect(state.inventory.repair_pack).toBe(0);
    expect(state.inventory.antimatter_propellant).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// Repair Drone arrival
// ---------------------------------------------------------------------------

describe('repair drone arrival', () => {
  it('clears lodges on arrival', () => {
    const world = makeWorld({ seed: 'test-seed' });
    const sat = makeMinimalSat({ id: 'sat1', x: 0, y: 0, lodges: { scan: 0.5, weather: 0.3, comm: 0.2 }, fuel: 20 });
    world.satellites.push(sat);
    const state = makeIslandState({ id: 'home', ascendantCoreCrafted: true });
    addSpaceport(state);
    stockRepairResources(state);
    world.islandStates = new Map([['home', state]]);

    const dispatchResult = dispatchRepairDrone(world, 'home', 'sat1', 0);
    expect(dispatchResult.ok).toBe(true);
    if (!dispatchResult.ok) return;

    // Travel time is 100 seconds = 100_000 ms.
    tickRepairDrones(world, 100_001);

    expect(sat.lodges).toEqual({ scan: 0, weather: 0, comm: 0 });
    expect(sat.fuel).toBe(100);
    expect(sat.pendingRepairDroneId).toBeNull();
    expect(world.repairDrones).toHaveLength(0);
  });

  it('is lost if target sat destroyed before arrival', () => {
    const world = makeWorld({ seed: 'test-seed' });
    const sat = makeMinimalSat({ id: 'sat1', x: 0, y: 0, lodges: { scan: 0.5, weather: 0.3, comm: 0.2 } });
    world.satellites.push(sat);
    const state = makeIslandState({ id: 'home', ascendantCoreCrafted: true });
    addSpaceport(state);
    stockRepairResources(state);
    world.islandStates = new Map([['home', state]]);

    const dispatchResult = dispatchRepairDrone(world, 'home', 'sat1', 0);
    expect(dispatchResult.ok).toBe(true);
    if (!dispatchResult.ok) return;

    // Destroy the satellite before arrival.
    world.satellites = [];

    tickRepairDrones(world, 100_001);

    expect(world.repairDrones).toHaveLength(0);
  });

  it('has 5% failure rate (deterministic failure path)', () => {
    const world = makeWorld({ seed: 'test-seed' });
    const sat = makeMinimalSat({ id: 'sat1', x: 0, y: 0, lodges: { scan: 0.5, weather: 0.3, comm: 0.2 } });
    world.satellites.push(sat);
    const state = makeIslandState({ id: 'home', ascendantCoreCrafted: true });
    addSpaceport(state);
    stockRepairResources(state);
    world.islandStates = new Map([['home', state]]);

    // nowMs=14 yields rng≈0.0378 < 0.05 → deterministic failure.
    const dispatchResult = dispatchRepairDrone(world, 'home', 'sat1', 14);
    expect(dispatchResult.ok).toBe(true);
    if (!dispatchResult.ok) return;

    tickRepairDrones(world, 14 + 100_001);

    // Satellite should NOT be repaired.
    expect(sat.lodges).toEqual({ scan: 0.5, weather: 0.3, comm: 0.2 });
    expect(sat.pendingRepairDroneId).toBeNull();
    expect(world.repairDrones).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// §14.8 Debris fields
// ---------------------------------------------------------------------------

describe('addDebrisFragments', () => {
  it('creates a new field when none exists for the cell', () => {
    const world = makeBfsWorld({
      islands: [],
      islandStates: new Map(),
      satellites: [],
    });
    const field = addDebrisFragments(world, 3, 4, 20);
    expect(field.cellX).toBe(3);
    expect(field.cellY).toBe(4);
    expect(field.fragments).toBe(20);
    expect(world.debrisFields).toHaveLength(1);
  });

  it('stacks fragments into an existing field', () => {
    const world = makeBfsWorld({
      islands: [],
      islandStates: new Map(),
      satellites: [],
    });
    addDebrisFragments(world, 3, 4, 20);
    const field = addDebrisFragments(world, 3, 4, 15);
    expect(field.fragments).toBe(35);
    expect(world.debrisFields).toHaveLength(1);
  });
});

describe('debrisHitProbability', () => {
  it('scales linearly with fragments and cross-section', () => {
    const field: DebrisField = { cellX: 0, cellY: 0, fragments: 100 };
    const sat = makeMinimalSat({ id: 's1', x: 0, y: 0, variant: 'sweeper' });
    const p = debrisHitProbability(field, sat);
    expect(p).toBeCloseTo(100 * DEBRIS_HIT_CONSTANT * SAT_CROSS_SECTION.sweeper, 8);
  });

  it('clamps at 0.99 regardless of fragment count', () => {
    const field: DebrisField = { cellX: 0, cellY: 0, fragments: 1_000_000 };
    const sat = makeMinimalSat({ id: 's1', x: 0, y: 0, variant: 'scanner' });
    expect(debrisHitProbability(field, sat)).toBe(0.99);
  });
});

describe('tickDebris', () => {
  it('is a no-op when there are no debris fields', () => {
    const world = makeBfsWorld({
      islands: [],
      islandStates: new Map(),
      satellites: [makeMinimalSat({ id: 's1', x: 0, y: 0 })],
    });
    tickDebris(world, 0);
    expect(world.satellites).toHaveLength(1);
  });

  it('is a no-op when there are no satellites', () => {
    const world = makeBfsWorld({
      islands: [],
      islandStates: new Map(),
      satellites: [],
    });
    world.debrisFields.push({ cellX: 0, cellY: 0, fragments: 100 });
    tickDebris(world, 0);
    expect(world.debrisFields).toHaveLength(1);
  });

  it('skips in-transit (unlocked) satellites', () => {
    const world = makeBfsWorld({
      islands: [],
      islandStates: new Map(),
      satellites: [makeMinimalSat({ id: 's1', x: 0, y: 0, locked: false })],
    });
    world.debrisFields.push({ cellX: 0, cellY: 0, fragments: 100 });
    tickDebris(world, 0);
    expect(world.satellites).toHaveLength(1);
  });

  it('lodges a sub-stat on hit when lodge probability is forced to 1.0', () => {
    const world = makeBfsWorld({
      islands: [],
      islandStates: new Map(),
      satellites: [makeMinimalSat({ id: 's1', x: 0, y: 0, variant: 'scanner' })],
    });
    // 2000 fragments × 0.0005 × 1.2 = 1.2 → clamped to 0.99, so hit is nearly certain.
    world.debrisFields.push({ cellX: 0, cellY: 0, fragments: 2000 });
    // Deterministic lodge: seed '0_debris_0_s1' with hitP≈0.99 produces a hit,
    // and the second RNG roll lands below DEBRIS_LODGE_PROBABILITY (0.9) → lodge.
    tickDebris(world, 0);
    expect(world.satellites).toHaveLength(1);
    const sat = world.satellites[0]!;
    // At least one lodge value should have increased.
    const totalLodge = sat.lodges.scan + sat.lodges.weather + sat.lodges.comm;
    expect(totalLodge).toBeGreaterThan(0);
    expect(totalLodge).toBeCloseTo(DEBRIS_LODGE_MAGNITUDE, 5);
  });

  it('destroys satellite and seeds new fragments on destruction (Kessler)', () => {
    const world = makeBfsWorld({
      islands: [],
      islandStates: new Map(),
      satellites: [makeMinimalSat({ id: 's1', x: 0, y: 0, variant: 'sweeper' })],
    });
    world.debrisFields.push({ cellX: 0, cellY: 0, fragments: 2000 });
    // Force destruction on every hit by overriding the lodge probability.
    // We need a seed that hits (rng < 0.99) and then rolls destruction.
    // With the default DEBRIS_LODGE_PROBABILITY = 0.9, destruction requires rng >= 0.9.
    // Seed '0_debris_0_s1' first roll ≈0.003 (hit), second roll ≈0.718 (lodge).
    // We need a seed where second roll >= 0.9.  Let's brute-search in the test.
    let found = false;
    for (let t = 0; t < 2000; t++) {
      const w = makeBfsWorld({
        islands: [],
        islandStates: new Map(),
        satellites: [makeMinimalSat({ id: `s${t}`, x: 0, y: 0, variant: 'sweeper' })],
      });
      w.debrisFields.push({ cellX: 0, cellY: 0, fragments: 2000 });
      tickDebris(w, t);
      if (w.satellites.length === 0) {
        // Satellite was destroyed; check that fragments increased.
        const field = w.debrisFields.find((f) => f.cellX === 0 && f.cellY === 0);
        expect(field).toBeDefined();
        expect(field!.fragments).toBe(2000 + SAT_DESTRUCTION_FRAGMENTS);
        found = true;
        break;
      }
    }
    expect(found).toBe(true);
  });
});

describe('launchSatellite orbit-explosion debris', () => {
  it('creates a debris field along the spawn→target trajectory on orbit explosion', () => {
    const world = makeWorld();
    const state = makeIslandState({ id: 'home', ascendantCoreCrafted: true });
    addSpaceport(state, 1);
    stockLaunchResources(state, 'scanner');
    world.islandStates = new Map([['home', state]]);
    // nowMs=9 at T1: first roll fails, second roll ≈0.99 ≥ 0.30 → orbit explosion.
    // Spawn = home (0,0) + spaceport (0,0) + footprint-centre offset (2,2) = (2,2).
    // Target (50,50) → trajectory midpoint = (26, 26).
    // cell size = 16, so cellX = Math.floor(26/16) = 1, cellY = 1.
    const result = launchSatellite(world, 'home', 'scanner', 50, 50, 9);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toBe('launch-failure');
    expect(world.debrisFields).toHaveLength(1);
    const field = world.debrisFields[0]!;
    expect(field.cellX).toBe(1);
    expect(field.cellY).toBe(1);
    expect(field.fragments).toBe(ORBIT_EXPLOSION_FRAGMENTS);
  });

  it('trajectory midpoint shifts with the player-chosen target (not the old fixed (cx+100, cy+100) site)', () => {
    // Confirm that targeting a DIFFERENT tile parks the debris field in a
    // DIFFERENT cell than the legacy (cellX=6, cellY=6) hardcode would have
    // landed on. Spawn (2,2) + target (200,200) → midpoint (101,101) → cell
    // (6,6), which would coincide with the old hardcode — so pick a target
    // whose midpoint clearly lives elsewhere. (400,0) → midpoint (201,1) →
    // cell (12,0), unambiguously not (6,6).
    const world = makeWorld();
    const state = makeIslandState({ id: 'home', ascendantCoreCrafted: true });
    addSpaceport(state, 1);
    stockLaunchResources(state, 'scanner');
    world.islandStates = new Map([['home', state]]);
    const result = launchSatellite(world, 'home', 'scanner', 400, 0, 9);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toBe('launch-failure');
    expect(world.debrisFields).toHaveLength(1);
    const field = world.debrisFields[0]!;
    expect(field.cellX).toBe(12);
    expect(field.cellY).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// §14.6 Satellite movement (fuel-spend)
// ---------------------------------------------------------------------------

describe('§14.6 requestSatMove + tickSatMovement', () => {
  function makeSatMoveWorld(): WorldState {
    return makeBfsWorld({
      islands: [],
      islandStates: new Map(),
      satellites: [],
    });
  }

  it('rejects when satellite does not exist', () => {
    const world = makeSatMoveWorld();
    const result = requestSatMove(world, 'missing', 10, 10, 0);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toBe('no-satellite');
  });

  it('rejects when satellite is already moving', () => {
    const world = makeSatMoveWorld();
    const sat = makeMinimalSat({ id: 'sat1', x: 0, y: 0, fuel: 100, locked: true });
    sat.movingTo = { x: 50, y: 0, arrivalMs: 1000 };
    world.satellites.push(sat);
    const result = requestSatMove(world, 'sat1', 100, 0, 0);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toBe('already-moving');
  });

  it('rejects when a repair drone is pending', () => {
    const world = makeSatMoveWorld();
    const sat = makeMinimalSat({ id: 'sat1', x: 0, y: 0, fuel: 100, locked: true, pendingRepairDroneId: 'repair-1' });
    world.satellites.push(sat);
    const result = requestSatMove(world, 'sat1', 100, 0, 0);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toBe('pending-repair');
  });

  it('rejects when satellite is not locked', () => {
    const world = makeSatMoveWorld();
    const sat = makeMinimalSat({ id: 'sat1', x: 0, y: 0, fuel: 100, locked: false });
    world.satellites.push(sat);
    const result = requestSatMove(world, 'sat1', 100, 0, 0);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toBe('not-locked');
  });

  it('rejects when target equals current position (zero distance)', () => {
    const world = makeSatMoveWorld();
    const sat = makeMinimalSat({ id: 'sat1', x: 10, y: 20, fuel: 100, locked: true });
    world.satellites.push(sat);
    const result = requestSatMove(world, 'sat1', 10, 20, 0);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toBe('no-distance');
  });

  it('rejects when fuel is insufficient for the distance', () => {
    const world = makeSatMoveWorld();
    const sat = makeMinimalSat({ id: 'sat1', x: 0, y: 0, fuel: 1, locked: true });
    world.satellites.push(sat);
    // Distance = 100 tiles; fuel cost = 100 * 0.05 = 5 > 1.
    const result = requestSatMove(world, 'sat1', 100, 0, 0);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toBe('insufficient-fuel');
  });

  it('spends fuel proportional to distance, sets movingTo, and unlocks on success', () => {
    const world = makeSatMoveWorld();
    const sat = makeMinimalSat({ id: 'sat1', x: 0, y: 0, fuel: 100, locked: true });
    world.satellites.push(sat);
    const result = requestSatMove(world, 'sat1', 100, 0, 1000);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const expectedCost = 100 * SAT_FUEL_PER_TILE; // 5
    expect(sat.fuel).toBeCloseTo(100 - expectedCost, 5);
    expect(sat.movingTo).toBeDefined();
    expect(sat.movingTo!.x).toBe(100);
    expect(sat.movingTo!.y).toBe(0);
    expect(sat.movingTo!.arrivalMs).toBe(1000 + (100 / SAT_MOVE_SPEED_TILES_PER_SEC) * 1000);
    expect(sat.locked).toBe(false);
  });

  it('tickSatMovement keeps movingTo until arrivalMs', () => {
    const world = makeSatMoveWorld();
    const sat = makeMinimalSat({ id: 'sat1', x: 0, y: 0, fuel: 100, locked: true });
    world.satellites.push(sat);
    requestSatMove(world, 'sat1', 100, 0, 0);
    const arrivalMs = sat.movingTo!.arrivalMs;
    // One ms before arrival — still in transit.
    tickSatMovement(world, arrivalMs - 1);
    expect(world.satellites).toHaveLength(1);
    expect(sat.movingTo).toBeDefined();
    expect(sat.locked).toBe(false);
  });

  it('tickSatMovement on arrival updates position, re-locks, and clears movingTo', () => {
    const world = makeSatMoveWorld();
    const sat = makeMinimalSat({ id: 'sat1', x: 0, y: 0, fuel: 100, locked: true });
    world.satellites.push(sat);
    requestSatMove(world, 'sat1', 100, 0, 0);
    const arrivalMs = sat.movingTo!.arrivalMs;
    tickSatMovement(world, arrivalMs);
    expect(world.satellites).toHaveLength(1);
    expect(sat.x).toBe(100);
    expect(sat.y).toBe(0);
    expect(sat.locked).toBe(true);
    expect(sat.movingTo).toBeUndefined();
  });

  it('tickSatMovement failure misdrops the satellite without destroying it', () => {
    const world = makeSatMoveWorld();
    const sat = makeMinimalSat({ id: 'sat1', x: 0, y: 0, fuel: 100, locked: true });
    world.satellites.push(sat);
    const debrisFieldsBefore = world.debrisFields.length;
    // nowMs=3 yields deterministic RNG ≈0.0013 < 0.02 → failure.
    requestSatMove(world, 'sat1', 100, 0, 3);
    const arrivalMs = sat.movingTo!.arrivalMs;
    const fuelBeforeArrival = sat.fuel;
    tickSatMovement(world, arrivalMs);

    // Sat survives — empty orbital space has nothing to destroy it.
    expect(world.satellites).toHaveLength(1);
    expect(world.satellites[0]).toBe(sat);
    // Locked at the misdrop tile, no longer in transit.
    expect(sat.locked).toBe(true);
    expect(sat.movingTo).toBeUndefined();
    // Offset from intended target (100, 0) lies in
    // [MISDROP_FRAC_MIN, MISDROP_FRAC_MAX] * tripDist (= 100).
    const offsetDist = Math.hypot(sat.x - 100, sat.y - 0);
    const tripDist = 100;
    const epsilon = 1e-9;
    expect(offsetDist).toBeGreaterThanOrEqual(SAT_MOVE_MISDROP_FRAC_MIN * tripDist - epsilon);
    expect(offsetDist).toBeLessThanOrEqual(SAT_MOVE_MISDROP_FRAC_MAX * tripDist + epsilon);
    // Extra fuel burned for the misdrop, but never below zero.
    expect(sat.fuel).toBeGreaterThanOrEqual(0);
    expect(sat.fuel).toBeLessThan(fuelBeforeArrival);
    // No new debris field on move failure.
    expect(world.debrisFields).toHaveLength(debrisFieldsBefore);
  });

  it('tickSatMovement failure clamps fuel to 0 when misdrop burn exceeds reserve', () => {
    const world = makeSatMoveWorld();
    // Fuel = exactly the planned-trip cost; after requestSatMove deducts the
    // base burn, sat.fuel === 0. The misdrop's extra burn then clamps to 0.
    const tripDist = 100;
    const exactTripFuel = tripDist * SAT_FUEL_PER_TILE;
    const sat = makeMinimalSat({
      id: 'sat1',
      x: 0,
      y: 0,
      fuel: exactTripFuel,
      locked: true,
    });
    world.satellites.push(sat);
    // nowMs=3 forces the failure roll (same seeded RNG as the test above).
    requestSatMove(world, 'sat1', tripDist, 0, 3);
    expect(sat.fuel).toBe(0);
    const arrivalMs = sat.movingTo!.arrivalMs;
    tickSatMovement(world, arrivalMs);

    // Sat is stranded at the misdrop tile with zero fuel.
    expect(world.satellites).toHaveLength(1);
    expect(sat.fuel).toBe(0);
    expect(sat.locked).toBe(true);
    expect(sat.movingTo).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// §14.5 Scanner Sat dwell-ramp discovery
// ---------------------------------------------------------------------------

describe('§14.5 scanner dwell-ramp discovery', () => {
  it('scannerDiscoveryProbability(0) returns SCANNER_INITIAL_P_PER_TICK', () => {
    expect(scannerDiscoveryProbability(0)).toBe(SCANNER_INITIAL_P_PER_TICK);
  });

  it('scannerDiscoveryProbability(infinity) approaches SCANNER_ASYMPTOTE_P_PER_TICK', () => {
    expect(scannerDiscoveryProbability(Infinity)).toBeCloseTo(SCANNER_ASYMPTOTE_P_PER_TICK, 10);
  });

  it('scannerDiscoveryProbability(SCANNER_DWELL_TIME_CONSTANT_MS) returns initial + range * (1 - 1/e)', () => {
    const range = SCANNER_ASYMPTOTE_P_PER_TICK - SCANNER_INITIAL_P_PER_TICK;
    const expected = SCANNER_INITIAL_P_PER_TICK + range * (1 - 1 / Math.E);
    expect(scannerDiscoveryProbability(SCANNER_DWELL_TIME_CONSTANT_MS)).toBeCloseTo(expected, 10);
  });

  it('cellsCoveredBySat with coverageRadius=0 returns empty set', () => {
    const sat = makeMinimalSat({ id: 'sat1', x: 0, y: 0, coverageRadius: 0 });
    expect(cellsCoveredBySat(sat).size).toBe(0);
  });

  it('cellsCoveredBySat with >0 returns at least one cell at the sat position', () => {
    const sat = makeMinimalSat({ id: 'sat1', x: 0, y: 0, coverageRadius: 400 });
    const covered = cellsCoveredBySat(sat);
    expect(covered.size).toBeGreaterThan(0);
    expect(covered.has('0,0')).toBe(true);
  });

  it('cellsCoveredBySat: sat inside a cell with tiny radius admits at least its own cell (distance²=0)', () => {
    // Sat at (8, 8) is inside cell (0,0) which spans [0,16]×[0,16].
    // Even radius 1 must admit (0,0) — the closest point of the cell to the
    // sat is the sat itself (clamps return sat coords), distance² = 0.
    const sat = makeMinimalSat({ id: 'sat1', x: 8, y: 8, coverageRadius: 1 });
    const covered = cellsCoveredBySat(sat);
    expect(covered.has('0,0')).toBe(true);
  });

  it('cellsCoveredBySat: sat near a cell corner admits all 4 cells touching the corner (perimeter overlap)', () => {
    // Sat at (15, 15) sits just inside cell (0,0). With radius 2, the disk
    // overlaps the adjacent cells (1,0), (0,1), (1,1) via their shared
    // perimeter points — closest point to sat is (16, 15), (15, 16), (16, 16)
    // respectively, all at distance ≤ sqrt(2) < 2.
    // Old centre-in-radius test rejected (1,0)/(0,1)/(1,1) because their
    // centres ((24,8), (8,24), (24,24)) are ~sqrt(81+49) ≈ 11.4 from sat,
    // well outside radius 2.
    const sat = makeMinimalSat({ id: 'sat1', x: 15, y: 15, coverageRadius: 2 });
    const covered = cellsCoveredBySat(sat);
    expect(covered.has('0,0')).toBe(true);
    expect(covered.has('1,0')).toBe(true);
    expect(covered.has('0,1')).toBe(true);
    expect(covered.has('1,1')).toBe(true);
  });

  it('cellsCoveredBySat: tangent case — sat exactly coverageRadius from cell admits it (inclusive ≤)', () => {
    // Sat at (-2, 8), radius exactly 2. Cell (0,0) spans [0,16]×[0,16];
    // closest point is (0, 8); distance from sat = 2 = radius. Inclusive
    // bound (`<=`) admits.
    const sat = makeMinimalSat({ id: 'sat1', x: -2, y: 8, coverageRadius: 2 });
    const covered = cellsCoveredBySat(sat);
    expect(covered.has('0,0')).toBe(true);
  });

  it('cellsCoveredBySat: far sat with non-overlapping disk admits no cells beyond its reach', () => {
    // Sat at (8, 8), radius 4 — disk fits well inside cell (0,0), no adjacent
    // cells touched. Cells (1,0), (0,1), (-1,0), (0,-1) must NOT be admitted
    // (closest perimeter point is 8 away in one axis, > radius 4).
    const sat = makeMinimalSat({ id: 'sat1', x: 8, y: 8, coverageRadius: 4 });
    const covered = cellsCoveredBySat(sat);
    expect(covered.has('0,0')).toBe(true);
    expect(covered.has('1,0')).toBe(false);
    expect(covered.has('0,1')).toBe(false);
    expect(covered.has('-1,0')).toBe(false);
    expect(covered.has('0,-1')).toBe(false);
  });

  it('cellsCoveredBySat: large radius admits all overlapping cells within bounding box', () => {
    // Sat at cell-grid origin (0,0), radius spanning 2 cells (32 tiles).
    // Cells whose closest point is within 32 are admitted. Cell (1,1) has
    // closest point (16,16), distance sqrt(512) ≈ 22.6 ≤ 32 → admitted.
    // Cell (2,2) has closest point (32,32), distance sqrt(2048) ≈ 45.3 > 32
    // → not admitted.
    const sat = makeMinimalSat({ id: 'sat1', x: 0, y: 0, coverageRadius: 32 });
    const covered = cellsCoveredBySat(sat);
    // Sat at corner (0,0) — cells in all 4 quadrants overlap the disk.
    expect(covered.has('0,0')).toBe(true);
    expect(covered.has('-1,0')).toBe(true);
    expect(covered.has('0,-1')).toBe(true);
    expect(covered.has('-1,-1')).toBe(true);
    expect(covered.has('1,0')).toBe(true);
    expect(covered.has('0,1')).toBe(true);
    expect(covered.has('1,1')).toBe(true);
    // Cell (2,2) closest point (32,32) sits at distance sqrt(2048) ≈ 45.3 > 32.
    expect(covered.has('2,2')).toBe(false);
    expect(covered.has('-3,-3')).toBe(false);
  });

  it('cellsCoveredBySat: sanity check — sat at cell corner with r = sqrt(2)*cellSize admits all 4 adjacent cells', () => {
    // SPEC §14.5 sanity case. Sat at corner (16, 16) shared by cells
    // (0,0), (1,0), (0,1), (1,1). r = sqrt(2)*16 ≈ 22.63. Each of the 4
    // cells has the sat sitting on its corner — distance² = 0 — so all 4
    // admit unconditionally.
    const sat = makeMinimalSat({
      id: 'sat1',
      x: 16,
      y: 16,
      coverageRadius: Math.SQRT2 * 16,
    });
    const covered = cellsCoveredBySat(sat);
    expect(covered.has('0,0')).toBe(true);
    expect(covered.has('1,0')).toBe(true);
    expect(covered.has('0,1')).toBe(true);
    expect(covered.has('1,1')).toBe(true);
  });

  it('tickScannerDiscovery no-ops on non-scanner sats', () => {
    const world = makeBfsWorld({
      islands: [],
      islandStates: new Map(),
      satellites: [makeMinimalSat({ id: 'sat1', x: 0, y: 0, variant: 'relay', coverageRadius: 0 })],
    });
    const result = tickScannerDiscovery(world, 1000, 0);
    expect(result).toEqual([]);
  });

  it('tickScannerDiscovery no-ops on unlocked sats', () => {
    const world = makeBfsWorld({
      islands: [],
      islandStates: new Map(),
      satellites: [makeMinimalSat({ id: 'sat1', x: 0, y: 0, variant: 'scanner', locked: false })],
    });
    const result = tickScannerDiscovery(world, 1000, 0);
    expect(result).toEqual([]);
  });

  it('discovers an undiscovered island in coverage with a forced-success seed', () => {
    // Island at (0,0) is in the same cell as the scanner at (0,0).
    const island = makeMinimalIsland({ id: 'target', cx: 0, cy: 0, discovered: false });
    const sat = makeMinimalSat({ id: 'sat1', x: 0, y: 0, variant: 'scanner', coverageRadius: 400, locked: true });
    const world = makeBfsWorld({
      islands: [island],
      islandStates: new Map(),
      satellites: [sat],
    });
    // Pre-warm dwell so p is at asymptote (≈0.05).
    sat.dwellByCellKey = { '0,0': SCANNER_DWELL_TIME_CONSTANT_MS * 10 };
    // nowMs=20 with seed '0_scan_sat1_20' yields rng≈0.018 < 0.05 → success.
    const result = tickScannerDiscovery(world, 1000, 20);
    expect(result).toContain('target');
    expect(world.islands[0]!.discovered).toBe(true);
  });

  it('leaves out-of-coverage island undiscovered', () => {
    // Island far away at (10000, 10000) is outside coverage radius 400.
    const inRange = makeMinimalIsland({ id: 'inRange', cx: 0, cy: 0, discovered: false });
    const outOfRange = makeMinimalIsland({ id: 'outOfRange', cx: 10000, cy: 10000, discovered: false });
    const sat = makeMinimalSat({ id: 'sat1', x: 0, y: 0, variant: 'scanner', coverageRadius: 400, locked: true });
    const world = makeBfsWorld({
      islands: [inRange, outOfRange],
      islandStates: new Map(),
      satellites: [sat],
    });
    sat.dwellByCellKey = { '0,0': SCANNER_DWELL_TIME_CONSTANT_MS * 10 };
    tickScannerDiscovery(world, 1000, 20);
    expect(inRange.discovered).toBe(true);
    expect(outOfRange.discovered).toBe(false);
  });

  it('drops dwell entries for cells no longer covered after the sat moves', () => {
    const sat = makeMinimalSat({ id: 'sat1', x: 0, y: 0, variant: 'scanner', coverageRadius: 400, locked: true });
    const world = makeBfsWorld({
      islands: [],
      islandStates: new Map(),
      satellites: [sat],
    });
    // First tick: build up dwell in cells around (0,0).
    tickScannerDiscovery(world, 1000, 0);
    const dwellAfterFirst = Object.keys(sat.dwellByCellKey!);
    expect(dwellAfterFirst.length).toBeGreaterThan(0);
    expect(dwellAfterFirst).toContain('0,0');

    // Move the sat far away.
    sat.x = 10000;
    sat.y = 10000;

    // Second tick: old cells should be dropped, new cells added.
    tickScannerDiscovery(world, 1000, 1);
    const dwellAfterSecond = Object.keys(sat.dwellByCellKey!);
    expect(dwellAfterSecond).not.toContain('0,0');
    expect(dwellAfterSecond).toContain('625,625'); // cell for (10000,10000)
  });
});

describe('§14.7 launchSatellite uses launchSuccessBonus', () => {
  it('T1 Spaceport without bonus has baseSuccess 0.30', () => {
    const world = makeWorld();
    const state = makeIslandState({ id: 'home', ascendantCoreCrafted: true });
    addSpaceport(state, 1);
    stockLaunchResources(state, 'scanner');
    world.islandStates = new Map([['home', state]]);
    // nowMs=5 → rng≈0.70 > 0.30 → fails without bonus
    const result = launchSatellite(world, 'home', 'scanner', 50, 50, 5);
    expect(result.ok).toBe(false);
  });

  it('with launch.1 unlocked, effective rate becomes 0.30 + magnitudeForDepth(1)', () => {
    const world = makeWorld();
    const state = makeIslandState({
      id: 'home',
      ascendantCoreCrafted: true,
      unlockedNodes: new Set(['launch.1']),
    });
    addSpaceport(state, 1);
    stockLaunchResources(state, 'scanner');
    world.islandStates = new Map([['home', state]]);
    // nowMs=5 → rng≈0.70. With bonus 0.05, threshold is 0.35, so still fails.
    // Use nowMs=0 → rng≈0.23. Threshold 0.35 > 0.23 → success.
    const result = launchSatellite(world, 'home', 'scanner', 50, 50, 0);
    expect(result.ok).toBe(true);
  });

  it('cumulative bonuses cap at 0.99 even when sum would exceed 1.0', () => {
    const world = makeWorld();
    const launchNodes: string[] = [];
    for (let d = 1; d <= 15; d++) launchNodes.push(`launch.${d}`);
    const state = makeIslandState({
      id: 'home',
      ascendantCoreCrafted: true,
      unlockedNodes: new Set(launchNodes),
    });
    addSpaceport(state, 1);
    stockLaunchResources(state, 'scanner');
    world.islandStates = new Map([['home', state]]);
    // With all 15 launch nodes unlocked, the raw sum is well over 1.0, but
    // the effective rate must be clamped at 0.99. Find a seed that would
    // fail at base 0.30 but succeed at 0.99.
    let foundSuccess = false;
    let foundFailure = false;
    for (let t = 0; t < 200; t++) {
      const w = makeWorld();
      const s = makeIslandState({
        id: 'home',
        ascendantCoreCrafted: true,
        unlockedNodes: new Set(launchNodes),
      });
      addSpaceport(s, 1);
      stockLaunchResources(s, 'scanner');
      w.islandStates = new Map([['home', s]]);
      const result = launchSatellite(w, 'home', 'scanner', 50, 50, t);
      if (result.ok) foundSuccess = true;
      else foundFailure = true;
      if (foundSuccess && foundFailure) break;
    }
    // At 0.99 cap we should see both successes and failures across seeds.
    expect(foundSuccess).toBe(true);
    expect(foundFailure).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// §14.4 Comm packet propagation
// ---------------------------------------------------------------------------

describe('§14.4 comm packet propagation', () => {
  it('buildCommGraph connects two Spaceports within range', () => {
    const islandA = makeMinimalIsland({ id: 'home', cx: 0, cy: 0, populated: true, buildings: [{ id: 'sp1', defId: 'spaceport', x: 0, y: 0 }] });
    const islandB = makeMinimalIsland({ id: 'away', cx: 100, cy: 0, populated: true, buildings: [{ id: 'sp2', defId: 'spaceport', x: 0, y: 0 }] });
    const stateA = makeIslandState({ id: 'home' });
    addSpaceport(stateA);
    const stateB = makeIslandState({ id: 'away' });
    addSpaceport(stateB);
    const world = makeBfsWorld({
      islands: [islandA, islandB],
      islandStates: new Map([['home', stateA], ['away', stateB]]),
      satellites: [],
    });
    const graph = buildCommGraph(world);
    expect(graph.get('home')!.has('away')).toBe(true);
    expect(graph.get('away')!.has('home')).toBe(true);
  });

  it('buildCommGraph does not connect Spaceports out of range', () => {
    const islandA = makeMinimalIsland({ id: 'home', cx: 0, cy: 0, populated: true, buildings: [{ id: 'sp1', defId: 'spaceport', x: 0, y: 0 }] });
    const islandB = makeMinimalIsland({ id: 'away', cx: 500, cy: 0, populated: true, buildings: [{ id: 'sp2', defId: 'spaceport', x: 0, y: 0 }] });
    const stateA = makeIslandState({ id: 'home' });
    addSpaceport(stateA);
    const stateB = makeIslandState({ id: 'away' });
    addSpaceport(stateB);
    const world = makeBfsWorld({
      islands: [islandA, islandB],
      islandStates: new Map([['home', stateA], ['away', stateB]]),
      satellites: [],
    });
    const graph = buildCommGraph(world);
    expect(graph.get('home')!.has('away')).toBe(false);
    expect(graph.get('away')!.has('home')).toBe(false);
  });

  it('buildCommGraph excludes unlocked satellites (in-transit)', () => {
    const island = makeMinimalIsland({ id: 'home', cx: 0, cy: 0, populated: true, buildings: [{ id: 'sp1', defId: 'spaceport', x: 0, y: 0 }] });
    const state = makeIslandState({ id: 'home' });
    addSpaceport(state);
    const sat = makeMinimalSat({ id: 'sat1', x: 100, y: 0, commRange: 200, locked: false });
    const world = makeBfsWorld({
      islands: [island],
      islandStates: new Map([['home', state]]),
      satellites: [sat],
    });
    const graph = buildCommGraph(world);
    expect(graph.has('sat1')).toBe(false);
    expect(graph.get('home')!.has('sat1')).toBe(false);
  });

  it('nextHopToNearestSpaceport returns null on isolated node', () => {
    const graph = new Map<string, Set<string>>();
    graph.set('alone', new Set());
    const targets = new Set(['target']);
    expect(nextHopToNearestSpaceport(graph, 'alone', targets)).toBeNull();
  });

  it('nextHopToNearestSpaceport returns the direct-link spaceport when adjacent', () => {
    const graph = new Map<string, Set<string>>();
    graph.set('sat1', new Set(['home']));
    graph.set('home', new Set(['sat1']));
    const targets = new Set(['home']);
    expect(nextHopToNearestSpaceport(graph, 'sat1', targets)).toBe('home');
  });

  it('nextHopToNearestSpaceport picks the neighbor with shortest BFS path; ties broken by lowest id', () => {
    // Graph: start -> {a, b}. a -> target. b -> c -> target.
    // Both a and b are neighbors of start. a has distance 1 to target, b has distance 2.
    // So start should pick a.
    const graph = new Map<string, Set<string>>();
    graph.set('start', new Set(['a', 'b']));
    graph.set('a', new Set(['start', 'target']));
    graph.set('b', new Set(['start', 'c']));
    graph.set('c', new Set(['b', 'target']));
    graph.set('target', new Set(['a', 'c']));
    const targets = new Set(['target']);
    expect(nextHopToNearestSpaceport(graph, 'start', targets)).toBe('a');

    // Tie-break test: start -> {x, y}. x -> target (dist 1). y -> target (dist 1).
    // Lower id 'x' should win over 'y'.
    const graph2 = new Map<string, Set<string>>();
    graph2.set('start', new Set(['y', 'x']));
    graph2.set('x', new Set(['start', 'target']));
    graph2.set('y', new Set(['start', 'target']));
    graph2.set('target', new Set(['x', 'y']));
    expect(nextHopToNearestSpaceport(graph2, 'start', targets)).toBe('x');
  });

  it('tickCommPackets advances a packet one hop per tick along a 3-node chain (sat → sat → spaceport), delivering on the third tick', () => {
    // Chain: satA (x=100) -> satB (x=250) -> home spaceport (x=0)
    // home has T1 spaceport (range 200). satA at dist 100 from home (in range).
    // satB at dist 250 from home (out of range of home's 200).
    // satA has range 200, satB has range 200.
    // satA <-> home: dist 100 <= max(200, 200) = 200 ✓
    // satB <-> home: dist 250 <= max(200, 200) = 200 ✗
    // satA <-> satB: dist 150 <= max(200, 200) = 200 ✓
    // So the chain is satA - satB - home? Wait, satA is in range of home directly.
    // That makes it a 2-hop path, not 3. Let me adjust.
    // Make home T1 (range 200). Place satA at x=150, satB at x=300.
    // satA <-> home: 150 <= 200 ✓
    // satB <-> home: 300 <= 200 ✗
    // satA <-> satB: 150 <= 200 ✓
    // This gives satA directly connected to home, which is a 1-hop delivery.
    // I need satA NOT directly connected to home.
    // Let's use home T1 (200), satA at x=250 with commRange 100, satB at x=350 with commRange 100.
    // Wait, the connection rule is max(range_A, range_B).
    // home (200) <-> satA (100): dist=250 <= max(200,100)=200? No, 250 > 200. Not connected.
    // satA (100) <-> satB (100): dist=100 <= max(100,100)=100 ✓
    // satB (100) <-> home (200): dist=350 <= max(100,200)=200? No, 350 > 200. Not connected.
    // Hmm, then satB isn't connected to home either. We need satB in range of home.
    // Let's try: home at x=0 with T1 spaceport (range 200). satA at x=250 with commRange 200. satB at x=400 with commRange 200.
    // home <-> satA: 250 <= max(200,200)=200? No.
    // Let's use T2 for home (range 300).
    // home <-> satA: 250 <= max(300,200)=300 ✓
    // satA <-> satB: 150 <= max(200,200)=200 ✓
    // home <-> satB: 400 <= max(300,200)=300? No.
    // This works! satA is directly connected to home, but for the 3-node chain test we want satA -> satB -> home.
    // The packet starts at satA. On tick 1, nextHop should be satB (not home) because... wait.
    // nextHopToNearestSpaceport picks the neighbor with the shortest BFS path to a spaceport.
    // satA's neighbors: home (distance 0) and satB (distance 1 via home? No, satB -> home is not direct).
    // Wait, in this setup satB is connected to satA but NOT to home. So from satB, path to home is satB -> satA -> home (dist 2).
    // From satA, path to home is direct (dist 1). So nextHop from satA would be home, not satB.
    // That's not a 3-node chain.
    // I need: satA connected to satB, satB connected to home, but satA NOT connected to home.
    // home T1 (200) at x=0. satB at x=150 with commRange 100. satA at x=300 with commRange 100.
    // home <-> satB: 150 <= max(200,100)=200 ✓
    // satB <-> satA: 150 <= max(100,100)=100? No.
    // Need satB range bigger. satB commRange = 200.
    // home <-> satB: 150 <= max(200,200)=200 ✓
    // satB <-> satA: 150 <= max(200,100)=200 ✓
    // home <-> satA: 300 <= max(200,100)=200? No.
    // This works! Graph: satA -- satB -- home.
    // From satA: neighbors = {satB}. BFS from satB to home: satB -> home (dist 1). So nextHop = satB.
    // From satB: neighbors = {home, satA}. BFS from home to targets: 0 (direct). BFS from satA to home: satA -> satB -> home (dist 2). So nextHop = home.
    const island = makeMinimalIsland({ id: 'home', cx: 0, cy: 0, populated: true, buildings: [{ id: 'sp1', defId: 'spaceport', x: 0, y: 0 }] });
    const state = makeIslandState({ id: 'home' });
    addSpaceport(state, 1);
    const satA = makeMinimalSat({ id: 'satA', x: 300, y: 0, commRange: 100, locked: true });
    const satB = makeMinimalSat({ id: 'satB', x: 150, y: 0, commRange: 200, locked: true });
    const world = makeBfsWorld({
      islands: [island],
      islandStates: new Map([['home', state]]),
      satellites: [satA, satB],
    });

    const pkt: CommPacket = {
      id: 'pkt1',
      payload: { type: 'discovery', payload: {} },
      currentNodeId: 'satA',
      originSatId: 'satA',
      generatedMs: 0,
    };
    world.commPackets = [pkt];

    // Tick 1: satA -> satB
    const d1 = tickCommPackets(world);
    expect(d1).toHaveLength(0);
    expect(world.commPackets).toHaveLength(1);
    expect(world.commPackets[0]!.currentNodeId).toBe('satB');

    // Tick 2: satB -> home
    const d2 = tickCommPackets(world);
    expect(d2).toHaveLength(0);
    expect(world.commPackets).toHaveLength(1);
    expect(world.commPackets[0]!.currentNodeId).toBe('home');

    // Tick 3: delivered
    const d3 = tickCommPackets(world);
    expect(d3).toHaveLength(1);
    expect(d3[0]!.id).toBe('pkt1');
    expect(world.commPackets).toHaveLength(0);
  });

  it('tickCommPackets drops a packet whose holder no longer exists (sat removed mid-flight)', () => {
    const island = makeMinimalIsland({ id: 'home', cx: 0, cy: 0, populated: true, buildings: [{ id: 'sp1', defId: 'spaceport', x: 0, y: 0 }] });
    const state = makeIslandState({ id: 'home' });
    addSpaceport(state);
    const satA = makeMinimalSat({ id: 'satA', x: 100, y: 0, commRange: 200, locked: true });
    const world = makeBfsWorld({
      islands: [island],
      islandStates: new Map([['home', state]]),
      satellites: [satA],
    });
    const pkt: CommPacket = {
      id: 'pkt1',
      payload: { type: 'discovery', payload: {} },
      currentNodeId: 'satA',
      originSatId: 'satA',
      generatedMs: 0,
    };
    world.commPackets = [pkt];
    // Remove satA before the tick.
    world.satellites = [];
    const delivered = tickCommPackets(world);
    expect(delivered).toHaveLength(0);
    expect(world.commPackets).toHaveLength(0);
  });

  it('tickCommPackets leaves a packet in place when no next hop is available (disconnected island)', () => {
    // Island with spaceport but no sats in range.
    const island = makeMinimalIsland({ id: 'home', cx: 0, cy: 0, populated: true, buildings: [{ id: 'sp1', defId: 'spaceport', x: 0, y: 0 }] });
    const state = makeIslandState({ id: 'home' });
    addSpaceport(state);
    const satA = makeMinimalSat({ id: 'satA', x: 1000, y: 0, commRange: 100, locked: true });
    const world = makeBfsWorld({
      islands: [island],
      islandStates: new Map([['home', state]]),
      satellites: [satA],
    });
    const pkt: CommPacket = {
      id: 'pkt1',
      payload: { type: 'discovery', payload: {} },
      currentNodeId: 'satA',
      originSatId: 'satA',
      generatedMs: 0,
    };
    world.commPackets = [pkt];
    const delivered = tickCommPackets(world);
    expect(delivered).toHaveLength(0);
    expect(world.commPackets).toHaveLength(1);
    // Packet stays at satA because there are no neighbors.
    expect(world.commPackets[0]!.currentNodeId).toBe('satA');
  });
});


// ---------------------------------------------------------------------------
// §14.8 Sweeper passive cleanup
// ---------------------------------------------------------------------------

describe('§14.8 tickSweeperCleanup', () => {
  it('returns 0 when no debris fields exist', () => {
    const world = makeBfsWorld({
      islands: [],
      islandStates: new Map(),
      satellites: [makeMinimalSat({ id: 's1', x: 0, y: 0, variant: 'sweeper', locked: true })],
    });
    expect(tickSweeperCleanup(world, 1000)).toBe(0);
  });

  it('returns 0 when no satellites exist', () => {
    const world = makeBfsWorld({
      islands: [],
      islandStates: new Map(),
      satellites: [],
    });
    world.debrisFields.push({ cellX: 0, cellY: 0, fragments: 100 });
    expect(tickSweeperCleanup(world, 1000)).toBe(0);
  });

  it('clears fragments at SWEEPER_CLEAN_RATE_PER_SEC per sweeper per 1000ms', () => {
    const world = makeBfsWorld({
      islands: [],
      islandStates: new Map(),
      satellites: [makeMinimalSat({ id: 's1', x: 0, y: 0, variant: 'sweeper', locked: true })],
    });
    world.debrisFields.push({ cellX: 0, cellY: 0, fragments: 100 });
    const cleared = tickSweeperCleanup(world, 1000);
    const expectedCleared = 1 * SWEEPER_CLEAN_RATE_PER_SEC * 1;
    expect(cleared).toBeCloseTo(expectedCleared, 5);
    expect(world.debrisFields[0]!.fragments).toBeCloseTo(100 - expectedCleared, 5);
  });

  it('multiple sweepers stack (2 sweepers clear at 2× rate)', () => {
    const world = makeBfsWorld({
      islands: [],
      islandStates: new Map(),
      satellites: [
        makeMinimalSat({ id: 's1', x: 0, y: 0, variant: 'sweeper', locked: true }),
        makeMinimalSat({ id: 's2', x: 8, y: 8, variant: 'sweeper', locked: true }),
      ],
    });
    world.debrisFields.push({ cellX: 0, cellY: 0, fragments: 100 });
    const cleared = tickSweeperCleanup(world, 1000);
    const expectedCleared = 2 * SWEEPER_CLEAN_RATE_PER_SEC * 1;
    expect(cleared).toBeCloseTo(expectedCleared, 5);
  });

  it('removes field from world.debrisFields when fragments hit 0', () => {
    const world = makeBfsWorld({
      islands: [],
      islandStates: new Map(),
      satellites: [makeMinimalSat({ id: 's1', x: 0, y: 0, variant: 'sweeper', locked: true })],
    });
    world.debrisFields.push({ cellX: 0, cellY: 0, fragments: 0.01 });
    tickSweeperCleanup(world, 1000);
    expect(world.debrisFields).toHaveLength(0);
  });

  it('sweeper outside the cell does NOT count', () => {
    const world = makeBfsWorld({
      islands: [],
      islandStates: new Map(),
      satellites: [makeMinimalSat({ id: 's1', x: 1000, y: 1000, variant: 'sweeper', locked: true })],
    });
    world.debrisFields.push({ cellX: 0, cellY: 0, fragments: 100 });
    const cleared = tickSweeperCleanup(world, 1000);
    expect(cleared).toBe(0);
    expect(world.debrisFields[0]!.fragments).toBe(100);
  });

  it('unlocked sweeper does NOT count', () => {
    const world = makeBfsWorld({
      islands: [],
      islandStates: new Map(),
      satellites: [makeMinimalSat({ id: 's1', x: 0, y: 0, variant: 'sweeper', locked: false })],
    });
    world.debrisFields.push({ cellX: 0, cellY: 0, fragments: 100 });
    const cleared = tickSweeperCleanup(world, 1000);
    expect(cleared).toBe(0);
    expect(world.debrisFields[0]!.fragments).toBe(100);
  });
});

// ---------------------------------------------------------------------------
// §14.12 Repair Drone proportional fuel
// ---------------------------------------------------------------------------

describe('§14.12 dispatchRepairDrone proportional fuel', () => {
  function makeRepairWorld(opts: { satX?: number; satY?: number; propellant: number }): { world: WorldState; state: IslandState } {
    const world = makeWorld();
    const island = makeMinimalIsland({ id: 'home', cx: 0, cy: 0, populated: true, buildings: [{ id: 'sp1', defId: 'spaceport', x: 0, y: 0 }] });
    world.islands = [island];
    const sat = makeMinimalSat({ id: 'sat1', x: opts.satX ?? 0, y: opts.satY ?? 0 });
    world.satellites.push(sat);
    const state = makeIslandState({ id: 'home', ascendantCoreCrafted: true });
    addSpaceport(state);
    state.inventory.repair_pack = 1;
    state.inventory.antimatter_propellant = opts.propellant;
    world.islandStates = new Map([['home', state]]);
    return { world, state };
  }

  it('fuel load scales with rendezvous distance', () => {
    const { world, state } = makeRepairWorld({ satX: 100, satY: 0, propellant: 100 });
    const result = dispatchRepairDrone(world, 'home', 'sat1', 0);
    expect(result.ok).toBe(true);
    const expectedFuel = Math.max(REPAIR_DRONE_MIN_FUEL, 100 * REPAIR_DRONE_FUEL_PER_TILE);
    expect(state.inventory.antimatter_propellant).toBeCloseTo(100 - expectedFuel, 5);
  });

  it('distance 0 uses REPAIR_DRONE_MIN_FUEL floor', () => {
    const { world, state } = makeRepairWorld({ satX: 0, satY: 0, propellant: 100 });
    const result = dispatchRepairDrone(world, 'home', 'sat1', 0);
    expect(result.ok).toBe(true);
    expect(state.inventory.antimatter_propellant).toBe(100 - REPAIR_DRONE_MIN_FUEL);
  });

  it('returns insufficient-fuel when propellant is below the proportional load', () => {
    const { world } = makeRepairWorld({ satX: 1000, satY: 0, propellant: 1 });
    const result = dispatchRepairDrone(world, 'home', 'sat1', 0);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toBe('insufficient-fuel');
  });
});

// ---------------------------------------------------------------------------
// §14.3 Mirror Sat — Lorentzian boost falloff (additive to §2.7 solar)
// ---------------------------------------------------------------------------

describe('§14.3 Mirror Sat — mirrorBoost Lorentzian falloff', () => {
  // Per-sat fields are locked per the design brief: peakBoost = 0.7, rHalf = 200.
  // The contribution at any point is:
  //   raw = peakBoost / (1 + (d / rHalf)²)
  //   return raw < 0.05 ? 0 : raw
  function makeMirror(x: number, y: number): Satellite {
    return {
      id: 'm1',
      variant: 'mirror',
      spaceportIslandId: 'home',
      x,
      y,
      commRange: 200,
      coverageRadius: 0,
      fuel: 100,
      lodges: { scan: 0, weather: 0, comm: 0 },
      locked: true,
      pendingRepairDroneId: null,
      buffer: [],
      peakBoost: 0.7,
      rHalf: 200,
    };
  }

  it('at d=0 returns exactly peakBoost (0.7)', () => {
    const sat = makeMirror(0, 0);
    expect(mirrorBoost(sat, { x: 0, y: 0 })).toBeCloseTo(0.7, 12);
  });

  it('at d=rHalf (200) returns peakBoost/2 (0.35) — half-power point', () => {
    const sat = makeMirror(0, 0);
    expect(mirrorBoost(sat, { x: 200, y: 0 })).toBeCloseTo(0.35, 12);
  });

  it('at d=2·rHalf (400) returns peakBoost/5 (0.14)', () => {
    const sat = makeMirror(0, 0);
    // raw = 0.7 / (1 + 4) = 0.14
    expect(mirrorBoost(sat, { x: 400, y: 0 })).toBeCloseTo(0.14, 12);
  });

  it('returns 0 when raw drops below the 0.05 hard cutoff', () => {
    // raw < 0.05 ⇔ 0.7 / (1 + (d/200)²) < 0.05 ⇔ (d/200)² > 13 ⇔ d > 200√13 ≈ 721.11.
    const sat = makeMirror(0, 0);
    // d = 800: raw = 0.7 / (1 + 16) ≈ 0.0412 → below cutoff → zeroed.
    expect(mirrorBoost(sat, { x: 800, y: 0 })).toBe(0);
    // d = 720 (just under the threshold): raw ≈ 0.7 / (1 + (3.6)²) ≈ 0.7 / 13.96 ≈ 0.05014
    //   → strictly above the strict-less-than cutoff → returned as-is.
    expect(mirrorBoost(sat, { x: 720, y: 0 })).toBeGreaterThan(0.05);
    // d = 730: raw ≈ 0.7 / (1 + 13.3225) ≈ 0.04887 → below cutoff → 0.
    expect(mirrorBoost(sat, { x: 730, y: 0 })).toBe(0);
  });

  it('distance is Euclidean (mirror at (3, 4) is d=5 from origin)', () => {
    const sat = makeMirror(3, 4);
    const raw = 0.7 / (1 + (5 / 200) ** 2);
    expect(mirrorBoost(sat, { x: 0, y: 0 })).toBeCloseTo(raw, 12);
  });
});

describe('§14.3 Mirror Sat — effectiveSolarBoostFor (Σ across world.satellites)', () => {
  function makeMirrorWorld(positions: Array<{ x: number; y: number; locked?: boolean }>): WorldState {
    const w = makeWorld();
    w.satellites = positions.map((p, i) => ({
      id: `m${i}`,
      variant: 'mirror' as const,
      spaceportIslandId: 'home',
      x: p.x,
      y: p.y,
      commRange: 200,
      coverageRadius: 0,
      fuel: 100,
      lodges: { scan: 0, weather: 0, comm: 0 },
      locked: p.locked ?? true,
      pendingRepairDroneId: null,
      buffer: [],
      peakBoost: 0.7,
      rHalf: 200,
    }));
    return w;
  }

  it('returns 0 when no satellites are present', () => {
    const w = makeWorld();
    expect(effectiveSolarBoostFor(w, { x: 0, y: 0 })).toBe(0);
  });

  it('returns 0 when only non-mirror satellites are present', () => {
    const w = makeWorld();
    w.satellites = [{
      id: 's1',
      variant: 'scanner',
      spaceportIslandId: 'home',
      x: 0, y: 0,
      commRange: 200,
      coverageRadius: 400,
      fuel: 100,
      lodges: { scan: 0, weather: 0, comm: 0 },
      locked: true,
      pendingRepairDroneId: null,
      buffer: [],
    }];
    expect(effectiveSolarBoostFor(w, { x: 0, y: 0 })).toBe(0);
  });

  it('sums boost contributions from multiple mirrors', () => {
    // Two mirrors at d=0 (overlapping) should give 0.7 + 0.7 = 1.4 (UNCAPPED at this layer).
    // The cap-at-1 lives in the §2.7 composition step, not here.
    const w = makeMirrorWorld([{ x: 0, y: 0 }, { x: 0, y: 0 }]);
    expect(effectiveSolarBoostFor(w, { x: 0, y: 0 })).toBeCloseTo(1.4, 12);
  });

  it('ignores in-transit mirrors (locked === false)', () => {
    // Sat in transit shouldn't reflect sunlight — mirrors only contribute
    // while parked at their lock cell.
    const w = makeMirrorWorld([{ x: 0, y: 0, locked: false }, { x: 0, y: 0, locked: true }]);
    expect(effectiveSolarBoostFor(w, { x: 0, y: 0 })).toBeCloseTo(0.7, 12);
  });

  it('ignores out-of-range mirrors via the per-sat 0.05 cutoff', () => {
    // 10 mirrors all individually below cutoff at d=800 should sum to 0,
    // not to 10× their raw value.
    const positions = Array.from({ length: 10 }, () => ({ x: 800, y: 0 }));
    const w = makeMirrorWorld(positions);
    expect(effectiveSolarBoostFor(w, { x: 0, y: 0 })).toBe(0);
  });
});

describe('§14.3 Mirror Sat — launch + stats', () => {
  it('successful mirror launch sets peakBoost=0.7 and rHalf=200', () => {
    const world = makeWorld();
    const state = makeIslandState({ id: 'home', ascendantCoreCrafted: true });
    addSpaceport(state, 3);
    stockLaunchResources(state, 'mirror');
    world.islandStates = new Map([['home', state]]);
    const result = launchSatellite(world, 'home', 'mirror', 50, 50, 1);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.sat.variant).toBe('mirror');
    expect(result.sat.peakBoost).toBe(0.7);
    expect(result.sat.rHalf).toBe(200);
    // Coverage radius = 0 (not a scanner). Comm range nominal 200.
    expect(result.sat.coverageRadius).toBe(0);
    expect(result.sat.commRange).toBe(200);
  });

  it('mirror launch deducts mirror_sat + OIP + propellant', () => {
    const world = makeWorld();
    const state = makeIslandState({ id: 'home', ascendantCoreCrafted: true });
    addSpaceport(state, 3);
    stockLaunchResources(state, 'mirror');
    state.inventory.mirror_sat = 2; // start with extras to confirm exact deduction.
    state.inventory.orbital_insertion_package = 2;
    state.inventory.antimatter_propellant = 2;
    world.islandStates = new Map([['home', state]]);
    const result = launchSatellite(world, 'home', 'mirror', 50, 50, 1);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(state.inventory.mirror_sat).toBe(1);
    expect(state.inventory.orbital_insertion_package).toBe(1);
    expect(state.inventory.antimatter_propellant).toBe(1);
  });

  it('mirror launch rejects when mirror_sat payload is missing', () => {
    const world = makeWorld();
    const state = makeIslandState({ id: 'home', ascendantCoreCrafted: true });
    addSpaceport(state, 3);
    // OIP + propellant present, but no mirror_sat.
    state.inventory.orbital_insertion_package = 1;
    state.inventory.antimatter_propellant = 1;
    state.inventory.mirror_sat = 0;
    world.islandStates = new Map([['home', state]]);
    const result = launchSatellite(world, 'home', 'mirror', 50, 50, 1);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toBe('insufficient-resources');
  });
});

// ---------------------------------------------------------------------------
// §5 (ocean-layer design) — Scanner Sat ocean-cell discovery
// ---------------------------------------------------------------------------
//
// Task 7: extends `tickScannerDiscovery` to also write `revealedCells` and
// `depthRevealedCells` for every cell in the sat's coverage disk, mirroring
// the Sonar Buoy reveal contract (§5 design doc). The same `cellsCoveredBySat`
// area-overlap geometry that drives island discovery is reused unchanged — no
// new disk math, just an additional flip-target inside the existing tick.
//
// Geometry note: `cellsCoveredBySat` is the source of truth for "what cells
// does this sat see this tick" (tile-domain area-overlap per commit fb7bd51).
// The `revealOceanCells` helper from `discovery.ts` uses a different geometry
// (cell-domain center-disk: `dx² + dy² ≤ r²` in cell coords) — re-routing
// through it would change the covered cell set vs the island-discovery branch
// of the same tick. Per design-doc §5 ("Same coverage math, additional
// flip-target") we walk `covered` directly instead.
//
// In-transit guard: relies on the existing `if (!sat.locked) continue;` at
// the top of the per-sat loop. Power gate: scanners are not power-gated per
// §14 ("satellites operate above the weather layer"); same as today.
describe('§5 Scanner Sat ocean cell discovery', () => {
  it('Scanner Sat coverage writes revealedCells AND depthRevealedCells for cells in coverage', () => {
    // Sat at world tile (0, 0) — inside cell (0, 0). Coverage radius 400
    // tiles = 25 cells, well past the cell-(0,0) AABB. `cellsCoveredBySat`
    // admits a non-empty set; every key in it should land in both reveal
    // Sets after the tick.
    const sat = makeMinimalSat({
      id: 'sat1',
      x: 0,
      y: 0,
      variant: 'scanner',
      coverageRadius: 400,
      locked: true,
    });
    const world = makeBfsWorld({
      islands: [],
      islandStates: new Map(),
      satellites: [sat],
    });
    const expected = cellsCoveredBySat(sat);
    expect(expected.size).toBeGreaterThan(0);
    tickScannerDiscovery(world, 1000, 0);
    for (const key of expected) {
      expect(world.revealedCells.has(key)).toBe(true);
      expect(world.depthRevealedCells.has(key)).toBe(true);
    }
    // Sanity: the reveal sets have the same cardinality as the coverage set
    // (no other writers in this fixture — no islands, no drones).
    expect(world.revealedCells.size).toBe(expected.size);
    expect(world.depthRevealedCells.size).toBe(expected.size);
  });

  it('Scanner Sat over island+ocean reveals BOTH the island (existing) AND ocean cells (new)', () => {
    // Island centred at world tile (0, 0) is inside cell (0, 0). The sat
    // sits at (0, 0) with coverage 400 tiles; its coverage disk straddles
    // every cell touching the island AND surrounding ocean cells. After
    // a forced-success discovery tick: island.discovered flips, AND every
    // covered cell is in revealedCells + depthRevealedCells.
    const island = makeMinimalIsland({ id: 'target', cx: 0, cy: 0, discovered: false });
    const sat = makeMinimalSat({
      id: 'sat1',
      x: 0,
      y: 0,
      variant: 'scanner',
      coverageRadius: 400,
      locked: true,
    });
    const world = makeBfsWorld({
      islands: [island],
      islandStates: new Map(),
      satellites: [sat],
    });
    // Pre-warm dwell so discovery probability is near asymptote (~0.05).
    sat.dwellByCellKey = { '0,0': SCANNER_DWELL_TIME_CONSTANT_MS * 10 };
    const expected = cellsCoveredBySat(sat);
    // nowMs=20 with seed '0_scan_sat1_20' yields rng ≈ 0.018 < 0.05 → island
    // discovery succeeds (same forced-success seed as the §14.5 dwell test).
    const newlyDiscovered = tickScannerDiscovery(world, 1000, 20);
    expect(newlyDiscovered).toContain('target');
    expect(world.islands[0]!.discovered).toBe(true);
    // Ocean-cell reveal: every covered cell, including the cell containing
    // the island, lands in both reveal Sets. (Land cells getting written to
    // depthRevealedCells is harmless — the §5 render rule gates feature
    // glyphs on terrain being rare, so over-coverage doesn't render.)
    for (const key of expected) {
      expect(world.revealedCells.has(key)).toBe(true);
      expect(world.depthRevealedCells.has(key)).toBe(true);
    }
  });

  it('in-transit Scanner Sat (locked: false) does not reveal ocean cells', () => {
    // Same fixture as the first test but the sat is in transit. The existing
    // `if (!sat.locked) continue;` short-circuits the whole per-sat tick —
    // including the new ocean-reveal branch.
    const sat = makeMinimalSat({
      id: 'sat1',
      x: 0,
      y: 0,
      variant: 'scanner',
      coverageRadius: 400,
      locked: false,
    });
    const world = makeBfsWorld({
      islands: [],
      islandStates: new Map(),
      satellites: [sat],
    });
    tickScannerDiscovery(world, 1000, 0);
    expect(world.depthRevealedCells.size).toBe(0);
    // Surface-discovery set also stays empty — the only writer in this
    // fixture is the (skipped) sat.
    expect(world.revealedCells.size).toBe(0);
  });

  it('Non-scanner sat does not reveal ocean cells', () => {
    // A relay sat (variant !== 'scanner') is skipped by the early-continue at
    // the top of the loop — no reveal happens even if it's locked. Pins that
    // the ocean-reveal branch lives inside the same scanner-gated block.
    const sat = makeMinimalSat({
      id: 'sat1',
      x: 0,
      y: 0,
      variant: 'relay',
      coverageRadius: 400,
      locked: true,
    });
    const world = makeBfsWorld({
      islands: [],
      islandStates: new Map(),
      satellites: [sat],
    });
    tickScannerDiscovery(world, 1000, 0);
    expect(world.depthRevealedCells.size).toBe(0);
    expect(world.revealedCells.size).toBe(0);
  });
});
