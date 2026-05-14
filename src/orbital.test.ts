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
  type SatelliteVariant,
  type Satellite,
  type SatBufferEntry,
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
    subPathProgress: new Map(),
    funnelPending: emptyInv(),
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

function makeWorld(over: Partial<WorldState> = {}): WorldState {
  const base = makeInitialWorld(0);
  return {
    ...base,
    satellites: [],
    repairDrones: [],
      endgameState: { achieved: new Set(), firstAchievedMs: null, victoryBannerShown: false },
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
  state.inventory.comm_sat = variant === 'comm' ? 1 : 0;
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
    const result = launchSatellite(world, 'missing', 'scanner', 0);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toBe('no-island');
  });

  it('rejects when island has no spaceport', () => {
    const world = makeWorld();
    const state = makeIslandState({ id: 'home', ascendantCoreCrafted: true });
    world.islandStates = new Map([['home', state]]);
    const result = launchSatellite(world, 'home', 'scanner', 0);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toBe('no-spaceport');
  });

  it('rejects when ascendant_core has not been crafted', () => {
    const world = makeWorld();
    const state = makeIslandState({ id: 'home', ascendantCoreCrafted: false });
    addSpaceport(state);
    world.islandStates = new Map([['home', state]]);
    const result = launchSatellite(world, 'home', 'scanner', 0);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toBe('no-ascendant-core');
  });

  it('rejects when resources are insufficient', () => {
    const world = makeWorld();
    const state = makeIslandState({ id: 'home', ascendantCoreCrafted: true });
    addSpaceport(state);
    world.islandStates = new Map([['home', state]]);
    const result = launchSatellite(world, 'home', 'scanner', 0);
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
    const result = launchSatellite(world, 'home', 'scanner', 0);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(world.satellites).toHaveLength(1);
    expect(result.sat.variant).toBe('scanner');
  });

  it('succeeds at T2 spaceport with a moderate roll (nowMs=3 → rng≈0.32)', () => {
    const world = makeWorld();
    const state = makeIslandState({ id: 'home', ascendantCoreCrafted: true });
    addSpaceport(state, 2);
    stockLaunchResources(state, 'comm');
    world.islandStates = new Map([['home', state]]);
    const result = launchSatellite(world, 'home', 'comm', 3);
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
    const result = launchSatellite(world, 'home', 'sweeper', 1);
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
    const result = launchSatellite(world, 'home', 'scanner', 5);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toBe('launch-failure');
    expect(world.satellites).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// Failure modes
// ---------------------------------------------------------------------------

describe('satellite launch failure modes', () => {
  it('pad explosion destroys the spaceport (nowMs=5, T1, second roll≈0.20 < 0.30)', () => {
    const world = makeWorld();
    const state = makeIslandState({ id: 'home', ascendantCoreCrafted: true });
    addSpaceport(state, 1);
    stockLaunchResources(state, 'scanner');
    world.islandStates = new Map([['home', state]]);
    const result = launchSatellite(world, 'home', 'scanner', 5);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toBe('launch-failure');
    // Resources should NOT be consumed on failure.
    expect(state.inventory.scanner_sat).toBe(1);
    expect(state.inventory.orbital_insertion_package).toBe(1);
    expect(state.inventory.antimatter_propellant).toBe(1);
    // Spaceport should be destroyed.
    expect(state.buildings.some((b) => b.defId === 'spaceport')).toBe(false);
  });

  it('orbit explosion does not destroy the spaceport (nowMs=9, T1, second roll≈0.99 ≥ 0.30)', () => {
    const world = makeWorld();
    const state = makeIslandState({ id: 'home', ascendantCoreCrafted: true });
    addSpaceport(state, 1);
    stockLaunchResources(state, 'scanner');
    world.islandStates = new Map([['home', state]]);
    const result = launchSatellite(world, 'home', 'scanner', 9);
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
    const result = launchSatellite(world, 'home', 'scanner', 1);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.sat.coverageRadius).toBe(400);
    expect(result.sat.commRange).toBe(200);
    expect(result.sat.variant).toBe('scanner');
  });

  it('comm has commRange 500 and coverageRadius 0', () => {
    const world = makeWorld();
    const state = makeIslandState({ id: 'home', ascendantCoreCrafted: true });
    addSpaceport(state, 3);
    stockLaunchResources(state, 'comm');
    world.islandStates = new Map([['home', state]]);
    const result = launchSatellite(world, 'home', 'comm', 1);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.sat.commRange).toBe(500);
    expect(result.sat.coverageRadius).toBe(0);
    expect(result.sat.variant).toBe('comm');
  });

  it('sweeper has commRange 200 and coverageRadius 0', () => {
    const world = makeWorld();
    const state = makeIslandState({ id: 'home', ascendantCoreCrafted: true });
    addSpaceport(state, 3);
    stockLaunchResources(state, 'sweeper');
    world.islandStates = new Map([['home', state]]);
    const result = launchSatellite(world, 'home', 'sweeper', 1);
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
    const result = launchSatellite(world, 'home', 'scanner', 1);
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
  state.inventory.eldritch_processor = 2;
  state.inventory.cryogenic_hydrogen = 50;
}

function stockUpgradeResourcesTier2(state: IslandState): void {
  state.inventory.reality_anchor = 10;
  state.inventory.eldritch_processor = 5;
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
    expect(state.inventory.eldritch_processor).toBe(0);
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
    expect(state.inventory.eldritch_processor).toBe(0);
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
      endgameState: { achieved: new Set(), firstAchievedMs: null, victoryBannerShown: false },
      latticeActive: false,
      latticeNodeIslands: [],
    islandStates: opts.islandStates,
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
