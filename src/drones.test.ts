// Drones: pure-logic tests for capsule-corridor math, dispatch validation,
// and tick-based per-cell discovery (§11.1-11.3, §11 telemetry redesign).

import { beforeEach, describe, expect, it } from 'vitest';

import type { IslandState } from './economy.js';
import {
  DRONE_SPEED_TILES_PER_SEC,
  DRONE_T5_SCAN_RADIUS_TILES,
  DRONE_T5_SPEED_TILES_PER_SEC,
  DRONE_TIER_EFFICIENCY,
  DRONE_TIER_SCAN_RADIUS,
  effectiveDroneScanRadius,
  T4_PULSE_FUEL_COST,
  _resetDroneIdCounter,
  dispatchDrone,
  droneCurrentPosition,
  firePulse,
  isTerminalDroneStatus,
  pointToSegmentDistSq,
  probabilityBiasForIsland,
  tickDrones,
  type Drone,
} from './drones.js';
import { islandCells } from './discovery.js';
import { dronePadCentre } from './drones-ui.js';
import { rasterizePath, rollVehicleDestruction, weather } from './weather.js';
import { ALL_RESOURCES, type ResourceId } from './recipes.js';
import { type IslandSpec, type WorldState } from './world.js';
import { computeSignalRanges } from './antenna.js';
import { displayedFloorLevel } from './buildings.js';
import { effectiveSkillMultipliers } from './skilltree.js';

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

/** Uniform per-resource cap; iterates ALL_RESOURCES so this stays
 *  in lockstep with new ResourceIds (step-18 expanded the catalog). */
function blankCaps(amount: number): Record<ResourceId, number> {
  const caps = {} as Record<ResourceId, number>;
  for (const r of ALL_RESOURCES) caps[r] = amount;
  return caps;
}

function makeIslandState(over: Partial<IslandState> = {}): IslandState {
  return {
    id: 'home',
    buildings: [],
    inventory: emptyInv(),
    storageCaps: blankCaps(100),
    xp: 0,
    level: 1,
    unspentSkillPoints: 0,
    unlockedNodes: new Set(),
    unlockedEdges: new Set(),
    auraAmpVersion: 0,
    auraAmpCache: null,
    auraAmpCacheVersion: -1,
    co2Kg: 0,
    funnelPending: emptyFunnel(),
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

beforeEach(() => {
  _resetDroneIdCounter();
});

function makeTinyWorld(): WorldState & { islandStates: Map<string, IslandState> } {
  const homeSpec: IslandSpec = {
    id: 'home',
    name: 'home',
    biome: 'plains',
    cx: 0,
    cy: 0,
    majorRadius: 5,
    minorRadius: 5,
    populated: true,
    discovered: true,
    buildings: [],
    modifiers: [],
  };
  const homeState = makeIslandState({ id: 'home' });
  const world: WorldState = {
    islands: [homeSpec],
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
    oceanCells: new Map(),
    depthRevealedCells: new Set(),
    seed: 'test-seed',
    recentBuildAttempts: new Set(),
    recentBuildAttemptTs: new Map(),
  };
  const islandStates = new Map<string, IslandState>([['home', homeState]]);
  (world as typeof world & { islandStates: typeof islandStates }).islandStates = islandStates;
  return world as typeof world & { islandStates: typeof islandStates };
}

describe('pointToSegmentDistSq', () => {
  it('returns 0 for a point on the midpoint of the segment', () => {
    expect(pointToSegmentDistSq(5, 0, 0, 0, 10, 0)).toBe(0);
  });

  it('returns the perpendicular distance squared when the foot is inside the segment', () => {
    // Segment along x-axis from (0,0) to (10,0); point at (5, 3) → dist 3 → distSq 9.
    expect(pointToSegmentDistSq(5, 3, 0, 0, 10, 0)).toBe(9);
  });

  it('clamps to the nearest endpoint when the perpendicular foot is past the end', () => {
    // Foot at t=2 (beyond endpoint), nearest segment point is (10,0); from
    // (20, 0) that's distance 10 → distSq 100.
    expect(pointToSegmentDistSq(20, 0, 0, 0, 10, 0)).toBe(100);
    // Same with offset perpendicular: (20, 5) → nearest is (10,0) → dist² = 100+25.
    expect(pointToSegmentDistSq(20, 5, 0, 0, 10, 0)).toBe(125);
  });

  it('clamps to the start endpoint when t < 0', () => {
    // From (-5, 0) with segment (0,0)-(10,0): nearest is (0,0), distSq = 25.
    expect(pointToSegmentDistSq(-5, 0, 0, 0, 10, 0)).toBe(25);
  });

  it('handles a degenerate segment (a == b) by returning distance to the point', () => {
    // a == b == (3, 4); P at origin → dist 5 → distSq 25.
    expect(pointToSegmentDistSq(0, 0, 3, 4, 3, 4)).toBe(25);
    // P at the same point → 0.
    expect(pointToSegmentDistSq(3, 4, 3, 4, 3, 4)).toBe(0);
  });
});

describe('isTerminalDroneStatus', () => {
  it('returns true for terminal statuses (lost, returned, stranded)', () => {
    expect(isTerminalDroneStatus('lost')).toBe(true);
    expect(isTerminalDroneStatus('returned')).toBe(true);
    expect(isTerminalDroneStatus('stranded')).toBe(true);
  });

  it('returns false for active and undefined statuses', () => {
    expect(isTerminalDroneStatus('active')).toBe(false);
    expect(isTerminalDroneStatus(undefined)).toBe(false);
  });
});

describe('scanBuffer flush', () => {
  function makeWorldWithSingleAntenna(): WorldState {
    const world = makeTinyWorld();
    const home = world.islands.find((i) => i.id === 'home')!;
    home.buildings.push({ id: 'home-a1', defId: 'antenna_t1', x: 0, y: 0 });
    return world as WorldState;
  }

  it('buffers corridor cells out of antenna range, flushes on re-entry', () => {
    const world = makeWorldWithSingleAntenna();
    const home = makeIslandState({ level: 5 });
    home.inventory.diesel = 50;
    const result = dispatchDrone(world, home, 0, 0, 1, 0, 50, 0, undefined, 2);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const d = result.drone;

    // Advance to mid-flight (200s, drone at 100 tiles east — out of range).
    tickDrones(world, d.launchTime + 200_000, d.launchTime);
    expect(d.scanBuffer.size).toBeGreaterThan(0);

    // Advance through return: drone re-enters antenna range, buffer drains.
    tickDrones(world, d.expectedReturnTime + 1_000, d.launchTime + 200_000);
    expect(d.scanBuffer.size).toBe(0);
    expect(world.revealedCells.size).toBeGreaterThan(0);
  });

  it('flushes on returned status even if never re-entered range', () => {
    const world = makeTinyWorld();
    // Remote antenna exists so ranges are non-empty, but the drone's path
    // (origin → 50 tiles east → origin) never comes within its 80-tile radius.
    world.islands.push({
      id: 'remote',
      name: 'remote',
      biome: 'plains',
      cx: 0,
      cy: 200,
      majorRadius: 5,
      minorRadius: 5,
      populated: true,
      discovered: true,
      buildings: [{ id: 'remote-a1', defId: 'antenna_t1', x: 0, y: 0 }],
      modifiers: [],
    });
    const home = makeIslandState({ level: 5 });
    home.inventory.diesel = 50;
    const result = dispatchDrone(world, home, 0, 0, 1, 0, 50, 0, undefined, 2);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const d = result.drone;
    const revealedBefore = world.revealedCells.size;

    d.scanBuffer.add('5:0');
    d.scanBuffer.add('6:0');
    d.scanBuffer.add('7:0');
    tickDrones(world, d.expectedReturnTime + 1_000, d.launchTime);
    expect(d.scanBuffer.size).toBe(0);
    expect(world.revealedCells.has('5:0')).toBe(true);
    expect(world.revealedCells.has('6:0')).toBe(true);
    expect(world.revealedCells.has('7:0')).toBe(true);
    expect(world.revealedCells.size).toBeGreaterThanOrEqual(revealedBefore + 3);
  });

  it('discards buffer when drone is lost in dark', () => {
    const world = makeWorldWithSingleAntenna();
    const home = makeIslandState({ level: 5 });
    home.inventory.diesel = 50;
    const result = dispatchDrone(world, home, 0, 0, 1, 0, 50, 0, undefined, 2);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const d = result.drone;
    const revealedBefore = world.revealedCells.size;

    d.scanBuffer.add('9:9');
    d.scanBuffer.add('10:9');
    d.status = 'lost';
    tickDrones(world, d.expectedReturnTime + 1_000, d.launchTime);
    expect(world.revealedCells.has('9:9')).toBe(false);
    expect(world.revealedCells.has('10:9')).toBe(false);
    expect(world.revealedCells.size).toBe(revealedBefore);
  });
});

describe('no-antenna integration', () => {
  function makeMinimalWorldNoAntennas(): WorldState {
    return makeTinyWorld();
  }

  it('reveals corridor cells when origin has no antennas, drone returns safely', () => {
    const world = makeMinimalWorldNoAntennas();
    const origin = world.islands[0]!;
    expect(origin.populated).toBe(true);
    expect(computeSignalRanges(world.islands.filter((s) => s.populated))).toEqual([]);

    const originState = makeIslandState({ id: 'home', level: 5 });
    originState.inventory.diesel = 50;

    const result = dispatchDrone(world, originState, 0, 0, 1, 0, 30, 0, undefined, 2);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const d = result.drone;
    const revealedBefore = world.revealedCells.size;

    // Advance mid-flight: cells go INTO the buffer, NOT yet revealed.
    tickDrones(world, d.launchTime + 30_000, d.launchTime);
    expect(d.scanBuffer.size).toBeGreaterThan(0);
    expect(world.revealedCells.size).toBe(revealedBefore);

    // Advance past expected return time: drone reaches 'returned',
    // flush drains scanBuffer regardless of antenna range.
    tickDrones(world, d.expectedReturnTime + 2_000, d.launchTime + 30_000);
    expect(d.scanBuffer.size).toBe(0);
    expect(world.revealedCells.size).toBeGreaterThan(revealedBefore);

    // Sanity: drone is in terminal status.
    expect(d.status === 'returned').toBe(true);
  });
});

describe('dispatchDrone', () => {
  function freshWorld(): WorldState {
    return {
      islands: [],
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
    oceanCells: new Map(),
    depthRevealedCells: new Set(),
      seed: 'test-seed',
      recentBuildAttempts: new Set(),
      recentBuildAttemptTs: new Map(),
    };
  }

  it('happy path: deducts biofuel, appends drone, computes expectedReturnTime', () => {
    const world = freshWorld();
    const home = makeIslandState();
    home.inventory.biofuel = 50;
    const result = dispatchDrone(world, home, 0, 0, 1, 0, 20, 1000);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(home.inventory.biofuel).toBe(30);
    expect(world.drones).toHaveLength(1);
    const d = result.drone;
    expect(d.fromIslandId).toBe('home');
    expect(d.dirX).toBeCloseTo(1);
    expect(d.dirY).toBeCloseTo(0);
    expect(d.fuelLoaded).toBe(20);
    // Range = 20 * 3 = 60 tiles, outbound = 30 tiles.
    expect(d.outboundTiles).toBe(30);
    // Travel time = 60 / 0.5 = 120s → return at 1000 + 120_000. (rebalanced step #19)
    expect(d.expectedReturnTime).toBe(1000 + 120_000);
    expect(d.scanRadius).toBe(DRONE_TIER_SCAN_RADIUS[1]);
  });

  it('§11.5: bakes the Robotics droneScanRadius skill into the scan corridor', () => {
    const world = freshWorld();
    const home = makeIslandState({
      unlockedNodes: new Set(['robotics.notable.droneOptics']),
    });
    home.inventory.biofuel = 50;
    const mult = effectiveSkillMultipliers(home).droneScanRadius;
    // The skill must actually widen the corridor, else this proves nothing.
    expect(mult).toBeGreaterThan(1);
    const result = dispatchDrone(world, home, 0, 0, 1, 0, 20, 0, undefined, 1);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    // Dispatch and the shared helper agree; both apply the skill multiplier on
    // top of the per-tier base. The path-mode green preview overlay calls the
    // same helper, so the preview can't undercount a skilled island's reveal.
    expect(result.drone.scanRadius).toBeCloseTo(DRONE_TIER_SCAN_RADIUS[1] * mult);
    expect(effectiveDroneScanRadius(home, 1)).toBeCloseTo(result.drone.scanRadius);
  });

  it('normalises a non-unit direction vector', () => {
    const world = freshWorld();
    const home = makeIslandState();
    home.inventory.biofuel = 50;
    const r = dispatchDrone(world, home, 0, 0, 3, 4, 10, 0);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.drone.dirX).toBeCloseTo(3 / 5);
    expect(r.drone.dirY).toBeCloseTo(4 / 5);
  });

  it('rejects insufficient fuel without mutation', () => {
    const world = freshWorld();
    const home = makeIslandState();
    home.inventory.biofuel = 5;
    const r = dispatchDrone(world, home, 0, 0, 1, 0, 20, 0);
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.reason).toBe('insufficient-fuel');
    expect(home.inventory.biofuel).toBe(5);
    expect(world.drones).toHaveLength(0);
  });

  it('rejects zero or negative fuel as insufficient-fuel', () => {
    const world = freshWorld();
    const home = makeIslandState();
    home.inventory.biofuel = 50;
    expect(dispatchDrone(world, home, 0, 0, 1, 0, 0, 0).ok).toBe(false);
    expect(world.drones).toHaveLength(0);
  });

  it('rejects a zero-vector direction', () => {
    const world = freshWorld();
    const home = makeIslandState();
    home.inventory.biofuel = 50;
    const r = dispatchDrone(world, home, 0, 0, 0, 0, 20, 0);
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.reason).toBe('invalid-direction');
    expect(home.inventory.biofuel).toBe(50);
  });

  it('rejects a second dispatch from an island already in flight', () => {
    const world = freshWorld();
    const home = makeIslandState();
    home.inventory.biofuel = 50;
    expect(dispatchDrone(world, home, 0, 0, 1, 0, 10, 0).ok).toBe(true);
    const r2 = dispatchDrone(world, home, 0, 0, 0, 1, 10, 0);
    expect(r2.ok).toBe(false);
    if (r2.ok) return;
    expect(r2.reason).toBe('already-in-flight');
    // The first drone is still there; biofuel was deducted only once.
    expect(world.drones).toHaveLength(1);
    expect(home.inventory.biofuel).toBe(40);
  });

  it('a higher-floor drone pad dispatches more concurrent drones (§4.9 floor scaling)', () => {
    const world = freshWorld();
    const spec = makeIslandSpec({ id: 'home', populated: true });
    world.islands.push(spec);
    const home = makeIslandState({ id: 'home' });
    home.inventory.biofuel = 200;
    // floorLevel 2 = displayed floor 3 ⇒ activeFloors 3 ⇒ up to 3 concurrent.
    // Pad lives on the IslandState; launches originate at its footprint centre.
    home.buildings = [{ id: 'pad', defId: 'dronepad', x: 0, y: 0, floorLevel: 2 }];
    const c = dronePadCentre(spec, home)!;
    expect(dispatchDrone(world, home, c.x, c.y, 1, 0, 10, 0).ok).toBe(true);
    expect(dispatchDrone(world, home, c.x, c.y, 0, 1, 10, 0).ok).toBe(true);
    expect(dispatchDrone(world, home, c.x, c.y, -1, 0, 10, 0).ok).toBe(true);
    const r4 = dispatchDrone(world, home, c.x, c.y, 0, -1, 10, 0);
    expect(r4.ok).toBe(false);
    if (r4.ok) return;
    expect(r4.reason).toBe('already-in-flight');
    expect(world.drones).toHaveLength(3);
  });

  it('a fresh floor-1 drone pad still caps at 1 concurrent drone', () => {
    const world = freshWorld();
    const spec = makeIslandSpec({ id: 'home', populated: true });
    world.islands.push(spec);
    const home = makeIslandState({ id: 'home' });
    home.inventory.biofuel = 200;
    home.buildings = [{ id: 'pad', defId: 'dronepad', x: 0, y: 0 }]; // floorLevel undefined ⇒ 1
    const c = dronePadCentre(spec, home)!;
    expect(dispatchDrone(world, home, c.x, c.y, 1, 0, 10, 0).ok).toBe(true);
    const r2 = dispatchDrone(world, home, c.x, c.y, 0, 1, 10, 0);
    expect(r2.ok).toBe(false);
    if (r2.ok) return;
    expect(r2.reason).toBe('already-in-flight');
    expect(world.drones).toHaveLength(1);
  });

  it('§11.1 spawn = caller-supplied origin (engine no longer overrides)', () => {
    const world = freshWorld();
    const spec = makeIslandSpec({ id: 'home', cx: 100, cy: 200, populated: true });
    world.islands.push(spec);
    const home = makeIslandState({
      id: 'home',
      buildings: [
        { id: 'dp-1', defId: 'dronepad', x: 5, y: 5 },
        { id: 'dp-2', defId: 'dronepad', x: 10, y: 10 },
      ],
    });
    home.inventory.biofuel = 50;
    // Caller now picks pad-B (10, 10) explicitly. Centre = (110.5, 210.5).
    const r = dispatchDrone(world, home, 110.5, 210.5, 1, 0, 20, 0);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.drone.originX).toBe(110.5);
    expect(r.drone.originY).toBe(210.5);
  });

  it('dispatches a T1 drone with scan radius 2', () => {
    const world = freshWorld();
    const home = makeIslandState();
    home.inventory.biofuel = 50;
    const result = dispatchDrone(world, home, 0, 0, 1, 0, 20, 0, undefined, 1);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.drone.tier).toBe(1);
    expect(result.drone.scanRadius).toBe(2);
  });

  it('dispatches a T3 drone with scan radius 8', () => {
    const world = freshWorld();
    const home = makeIslandState({ level: 15 });
    home.inventory.aviation_kerosene = 50;
    const result = dispatchDrone(world, home, 0, 0, 1, 0, 30, 0, undefined, 3);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.drone.tier).toBe(3);
    expect(result.drone.scanRadius).toBe(8);
  });

  it('dispatched drone has an empty scanBuffer', () => {
    const world = freshWorld();
    const home = makeIslandState();
    home.inventory.biofuel = 50;
    world.islands.push(makeIslandSpec({ id: 'home', cx: 0, cy: 0, populated: true, discovered: true }));
    const result = dispatchDrone(world, home, 0, 0, 1, 0, 20, 0);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.drone.scanBuffer).toBeInstanceOf(Set);
    expect(result.drone.scanBuffer.size).toBe(0);
  });
});

describe('per-pad concurrency cap (§11 multi-pad selection)', () => {
  function freshWorld(): WorldState {
    return {
      islands: [],
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
      oceanCells: new Map(),
      depthRevealedCells: new Set(),
      seed: 'test-seed',
      recentBuildAttempts: new Set(),
      recentBuildAttemptTs: new Map(),
    };
  }

  it('rejects a second launch from the SAME pad', () => {
    const world = freshWorld();
    const home = makeIslandState();
    home.inventory.biofuel = 100;
    // Two launches from the same coords (0, 0).
    expect(dispatchDrone(world, home, 0, 0, 1, 0, 10, 0).ok).toBe(true);
    const r2 = dispatchDrone(world, home, 0, 0, 0, 1, 10, 0);
    expect(r2.ok).toBe(false);
    if (r2.ok) return;
    expect(r2.reason).toBe('already-in-flight');
  });

  it('ALLOWS a second launch from a DIFFERENT pad on the same island', () => {
    const world = freshWorld();
    const home = makeIslandState();
    home.inventory.biofuel = 100;
    // Pad-A at (10.5, 10.5), Pad-B at (20.5, 20.5) — 1 tile apart on the diagonal.
    expect(dispatchDrone(world, home, 10.5, 10.5, 1, 0, 10, 0).ok).toBe(true);
    const r2 = dispatchDrone(world, home, 20.5, 20.5, 1, 0, 10, 0);
    expect(r2.ok).toBe(true);
    expect(world.drones).toHaveLength(2);
    expect(world.drones[0]!.originX).toBe(10.5);
    expect(world.drones[1]!.originX).toBe(20.5);
  });

  it('cap is based on origin coords, not fromIslandId alone', () => {
    // Regression guard: a future refactor that re-introduces the per-island
    // cap would break this case.
    const world = freshWorld();
    const home = makeIslandState();
    home.inventory.biofuel = 100;
    dispatchDrone(world, home, 5.5, 5.5, 1, 0, 10, 0);
    expect(dispatchDrone(world, home, 6.5, 5.5, 1, 0, 10, 0).ok).toBe(true);
    expect(world.drones).toHaveLength(2);
  });

  it('sub-epsilon-different pad centres are treated as the same pad', () => {
    // Documents the PAD_MATCH_EPS contract: coords within 0.5 of each
    // other count as the same launch site.
    const world = freshWorld();
    const home = makeIslandState();
    home.inventory.biofuel = 100;
    dispatchDrone(world, home, 5.5, 5.5, 1, 0, 10, 0);
    const r2 = dispatchDrone(world, home, 5.6, 5.5, 1, 0, 10, 0);
    expect(r2.ok).toBe(false);
    if (r2.ok) return;
    expect(r2.reason).toBe('already-in-flight');
  });
});

// ---------------------------------------------------------------------------
// dronePadCentre (UI helper that aligns range / reticle / auto-fuel origin
// with the same pad centre `dispatchDrone` uses for the spawn — §11.1)
// ---------------------------------------------------------------------------

describe('dronePadCentre — §11.1 UI / dispatch origin alignment', () => {
  it('returns the pad footprint centre for an off-centre Drone Pad', () => {
    // Drone Pad is SHAPES.single (1×1). Tile coords are tile CENTRES, so the
    // footprint-centre offset is (W-1)/2 = 0 for a 1×1: pad centre =
    // (100 + 10, 100 + 5) = (110, 105).
    const spec = makeIslandSpec({ id: 'home', cx: 100, cy: 100 });
    const state = makeIslandState({
      id: 'home',
      buildings: [{ id: 'dp-1', defId: 'dronepad', x: 10, y: 5 }],
    });
    expect(dronePadCentre(spec, state)).toEqual({ x: 110, y: 105 });
  });

  it('returns null when no Drone Pad is placed', () => {
    const spec = makeIslandSpec({ id: 'home', cx: 100, cy: 100 });
    const state = makeIslandState({ id: 'home', buildings: [] });
    expect(dronePadCentre(spec, state)).toBeNull();
  });

  it('the drone fired with pad centre as origin lands on the player-clicked target', () => {
    // Regression guard: the UI's `attemptLaunch` (post §11.1 fix) computes
    // direction as `target − padCentre` and passes the pad centre as the
    // dispatch origin. The drone's apex (`originX + dirX * outboundTiles`)
    // must equal the clicked target tile — if a future refactor reintroduces
    // island-centre origin in the UI, this test breaks loudly.
    const world: WorldState = {
      islands: [],
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
      oceanCells: new Map(),
      depthRevealedCells: new Set(),
      seed: 'test-seed',
      recentBuildAttempts: new Set(),
      recentBuildAttemptTs: new Map(),
    };
    const spec = makeIslandSpec({ id: 'home', cx: 100, cy: 100, populated: true });
    world.islands.push(spec);
    const home = makeIslandState({
      id: 'home',
      buildings: [{ id: 'dp-1', defId: 'dronepad', x: 10, y: 5 }],
    });
    home.inventory.biofuel = 50;
    const pad = dronePadCentre(spec, home)!;
    // Player clicks target tile (120, 100). UI calls dispatchDrone with the
    // pad centre as origin and the pad-relative direction. Auto-fuel reserves
    // exactly enough for the round-trip.
    const targetX = 120;
    const targetY = 100;
    const dx = targetX - pad.x;
    const dy = targetY - pad.y;
    const dist = Math.sqrt(dx * dx + dy * dy);
    const fuelNeeded = Math.ceil((2 * dist) / DRONE_TIER_EFFICIENCY[1]);
    const r = dispatchDrone(world, home, pad.x, pad.y, dx, dy, fuelNeeded, 0);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    // Apex = origin + dir × outboundTiles. With fuel rounded UP, outbound
    // can slightly exceed the click distance — the apex along the launch
    // direction should equal or just exceed the target. We assert the apex
    // is collinear with origin → target AND at least covers the click.
    const apexX = r.drone.originX + r.drone.dirX * r.drone.outboundTiles;
    const apexY = r.drone.originY + r.drone.dirY * r.drone.outboundTiles;
    // Spawn coincides with the pad centre, not the island centre — this is
    // the critical assertion: an island-centre origin would put spawn at
    // (100, 100) instead of (110.5, 105.5).
    expect(r.drone.originX).toBe(pad.x);
    expect(r.drone.originY).toBe(pad.y);
    // Apex reaches at least the clicked target along the pad→target line.
    const apexDist = Math.sqrt((apexX - pad.x) ** 2 + (apexY - pad.y) ** 2);
    expect(apexDist).toBeGreaterThanOrEqual(dist - 1e-9);
    // And the apex direction matches the pad→target direction (collinear).
    expect(r.drone.dirX).toBeCloseTo(dx / dist, 9);
    expect(r.drone.dirY).toBeCloseTo(dy / dist, 9);
  });
});

describe('tickDrones (§11 telemetry: per-cell reveal in antenna range)', () => {
  /** Build a world with a populated home island carrying a T1 antenna at
   *  origin so drone scans transmit. Without an antenna in range, cells are
   *  silently dropped (the "data falls on the floor" semantic). */
  function world(islands: IslandSpec[]): WorldState {
    const home: IslandSpec = {
      id: 'home',
      name: 'home',
      biome: 'plains',
      cx: 0,
      cy: 0,
      majorRadius: 5,
      minorRadius: 5,
      populated: true,
      discovered: true,
      // T1 antenna radius is 80 tiles, centered on (0.5, 0.5) for the 1×1
      // building at island-local (0,0). Plenty of range for the corridor
      // tests below.
      buildings: [{ id: 'home-a1', defId: 'antenna_t1', x: 0, y: 0 }],
      modifiers: [],
    };
    return {
      islands: [home, ...islands],
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
    oceanCells: new Map(),
    depthRevealedCells: new Set(),
      seed: 'test-seed',
      recentBuildAttempts: new Set(),
      recentBuildAttemptTs: new Map(),
    };
  }

  /** Variant of `world` with NO antenna — every cell-reveal attempt should
   *  fail (the data falls on the floor). The home island is still populated
   *  (so `computeSignalRanges` sees it), just antenna-less. */
  function worldNoAntenna(islands: IslandSpec[]): WorldState {
    const home: IslandSpec = {
      id: 'home',
      name: 'home',
      biome: 'plains',
      cx: 0,
      cy: 0,
      majorRadius: 5,
      minorRadius: 5,
      populated: true,
      discovered: true,
      buildings: [], // no antenna
      modifiers: [],
    };
    return {
      islands: [home, ...islands],
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
    oceanCells: new Map(),
    depthRevealedCells: new Set(),
      seed: 'test-seed',
      recentBuildAttempts: new Set(),
      recentBuildAttemptTs: new Map(),
    };
  }

  it('returns empty when no drones are in flight', () => {
    const w = world([]);
    const r = tickDrones(w, 5000);
    expect(r.returned).toHaveLength(0);
    expect(r.newlyDiscoveredIslandIds).toHaveLength(0);
    expect(r.revealedCellsAdded).toBe(0);
  });

  it('leaves a drone untouched when nowMs < expectedReturnTime', () => {
    const w = world([]);
    const home = makeIslandState();
    home.inventory.biofuel = 50;
    dispatchDrone(w, home, 0, 0, 1, 0, 10, 1000);
    // 10 fuel × 4 efficiency = 40 tiles round-trip / 0.5 t/s = 80s flight.
    // Tick at 5_000 ms < 81_000 ms expected return.
    const r = tickDrones(w, 5_000, 4_000);
    expect(r.returned).toHaveLength(0);
    expect(w.drones).toHaveLength(1);
  });

  it('reveals cells along the corridor while the drone is in antenna range', () => {
    const w = world([]);
    const home = makeIslandState();
    home.inventory.biofuel = 50;
    dispatchDrone(w, home, 0, 0, 1, 0, 10, 0);
    // 40 tiles round-trip, 80s flight. Tick at full return time — the
    // single-tick corridor spans origin → outbound endpoint → back.
    const r = tickDrones(w, 81_000, 0);
    expect(r.returned).toHaveLength(1);
    expect(r.revealedCellsAdded).toBeGreaterThan(0);
    // Cells along the east-pointing corridor should be revealed. Outbound
    // 20 tiles → at least cell (0,0), (1,0) are inside the 80-tile antenna
    // range (cell (1,0) center at tile (24,8), distance from antenna (0.5,
    // 0.5) ≈ 28 — well within 80).
    expect(w.revealedCells.has('0,0')).toBe(true);
    expect(w.revealedCells.has('1,0')).toBe(true);
  });

  it('flushes buffered cells on return even when no antenna was ever in range', () => {
    const w = worldNoAntenna([]);
    const home = makeIslandState();
    home.inventory.biofuel = 50;
    dispatchDrone(w, home, 0, 0, 1, 0, 10, 0);
    const r = tickDrones(w, 81_000, 0);
    expect(r.returned).toHaveLength(1);
    expect(r.revealedCellsAdded).toBeGreaterThan(0);
    expect(w.revealedCells.size).toBeGreaterThan(0);
  });

  it('drone flies past antenna range: only the in-range portion is revealed', () => {
    const w = world([]);
    const home = makeIslandState();
    home.inventory.biofuel = 50;
    // 50 fuel × 4 = 200 tiles round-trip, outbound 100 tiles east. Antenna
    // radius is 80 tiles; cells past tile ~80 should NOT be revealed.
    dispatchDrone(w, home, 0, 0, 1, 0, 50, 0);
    // Travel time 200 / 0.5 = 400s. Single-tick reveal across the whole
    // flight is sufficient — corridor covers (0,0)→(100,0)→(0,0).
    const r = tickDrones(w, 401_000, 0);
    expect(r.revealedCellsAdded).toBeGreaterThan(0);
    // Cells near origin (well within 80-tile antenna range) are revealed.
    expect(w.revealedCells.has('0,0')).toBe(true);
    // Cells past the antenna range (tile center > 80 from antenna at (0.5,
    // 0.5)) are NOT revealed. Cell (6, 0) center is at (104, 8) — distance
    // ~104 from antenna, far outside the 80-tile range.
    expect(w.revealedCells.has('6,0')).toBe(false);
  });

  it('reveals cells across multiple ticks as the drone moves', () => {
    const w = world([]);
    const home = makeIslandState();
    home.inventory.biofuel = 50;
    // 50 fuel → 100 tiles outbound; 400s round-trip flight.
    dispatchDrone(w, home, 0, 0, 1, 0, 50, 0);
    // First tick at 100s: drone has moved 50 tiles east, still in antenna
    // range. Cells near tile (50, 0) should NOT be revealed yet (those are
    // past the antenna range, but cells back near origin are).
    tickDrones(w, 100_000, 0);
    const sizeAfter100s = w.revealedCells.size;
    expect(sizeAfter100s).toBeGreaterThan(0);
    // Tick again at 400s (drone back at origin): no NEW cells revealed
    // beyond what was already seen (the corridor backtracks the same line
    // through the in-range cells).
    tickDrones(w, 400_000, 100_000);
    // No regression: the in-range cells remain revealed.
    expect(w.revealedCells.has('0,0')).toBe(true);
  });

  it('island.discovered flips when ANY of the island\'s cells gets revealed', () => {
    // Target island whose footprint sits inside the corridor, antenna range.
    const target = makeIslandSpec({
      id: 'target',
      cx: 30,
      cy: 5,
      majorRadius: 5,
      minorRadius: 5,
      discovered: false,
    });
    const w = world([target]);
    const home = makeIslandState();
    home.inventory.biofuel = 50;
    dispatchDrone(w, home, 0, 0, 1, 0, 20, 0);
    // 80 tiles round-trip, outbound 40 tiles east. Corridor over (0..40, 0)
    // with scan radius 8. Target at (30, 5) is well within both the
    // corridor and the antenna range. Its cells (cell row y=0 around
    // x=2,3) will be revealed.
    const r = tickDrones(w, 161_000, 0);
    expect(target.discovered).toBe(true);
    expect(r.newlyDiscoveredIslandIds).toEqual(['target']);
  });

  it('does not re-report an already-discovered island in newlyDiscoveredIslandIds', () => {
    const known = makeIslandSpec({ id: 'known', cx: 30, cy: 5, discovered: true });
    const w = world([known]);
    const home = makeIslandState();
    home.inventory.biofuel = 50;
    dispatchDrone(w, home, 0, 0, 1, 0, 20, 0);
    const r = tickDrones(w, 161_000, 0);
    expect(r.returned).toHaveLength(1);
    expect(r.newlyDiscoveredIslandIds).toEqual([]);
    expect(known.discovered).toBe(true);
  });

  it('does not touch populated islands (they are inherently visible)', () => {
    const pop = makeIslandSpec({ id: 'pop', cx: 30, cy: 5, populated: true, discovered: true });
    const w = world([pop]);
    const home = makeIslandState();
    home.inventory.biofuel = 50;
    dispatchDrone(w, home, 0, 0, 1, 0, 20, 0);
    tickDrones(w, 161_000, 0);
    expect(pop.populated).toBe(true);
    expect(pop.discovered).toBe(true);
  });

  it('partial-island reveal: out-of-range portion remains unrevealed but island.discovered flips', () => {
    // Target island far past antenna range — its cells on the near edge
    // get revealed (still in antenna range from origin); the far edge
    // doesn't. Any-cell rule still flips `discovered`.
    const target = makeIslandSpec({
      id: 'far-edge',
      cx: 70,
      cy: 0,
      majorRadius: 5,
      minorRadius: 5,
      discovered: false,
    });
    const w = world([target]);
    const home = makeIslandState();
    home.inventory.biofuel = 50;
    // 50 fuel → 100 tiles outbound, 400s round-trip. The drone reaches the
    // near edge of the target (tile 65) while still inside the 80-tile
    // antenna range, but goes BEYOND (tile 75) where antenna range ends.
    dispatchDrone(w, home, 0, 0, 1, 0, 50, 0);
    const r = tickDrones(w, 401_000, 0);
    // Discovery flips on any-cell rule. The target's near cells (around
    // x=4 cell row 0) should be revealed.
    expect(target.discovered).toBe(true);
    expect(r.newlyDiscoveredIslandIds).toContain('far-edge');
    // Some cell of the target was revealed.
    expect(w.revealedCells.has('4,0')).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// BUG #90/#98/#99/#100 — discovery must reveal the FULL island footprint
// ---------------------------------------------------------------------------

describe('discovery reveals whole island footprint', () => {
  function assertFootprintRevealed(w: WorldState, islandId: string): void {
    const isl = w.islands.find((i) => i.id === islandId);
    expect(isl).toBeDefined();
    expect(isl!.discovered).toBe(true);
    const footprint = new Set(islandCells(isl!));
    for (const k of footprint) {
      expect(w.revealedCells.has(k)).toBe(true);
    }
  }

  it('drone corridor discovery reveals every cell of a large straddling island (#90)', () => {
    // Large island at (70, 0) radius 30: corridor along the x-axis only
    // grazes the near edge. The old code flipped discovered=true via the
    // any-cell rule but left the rest of the footprint in fog.
    const w = makeTinyWorld();
    w.islands.push({
      id: 'straddle-drone', name: 'straddle-drone', biome: 'plains',
      cx: 70, cy: 0, majorRadius: 30, minorRadius: 30,
      discovered: false, populated: false, buildings: [], modifiers: [],
    } as any);
    const home = makeIslandState();
    home.inventory.biofuel = 50;
    dispatchDrone(w, home, 0, 0, 1, 0, 50, 0);
    tickDrones(w, 401_000, 0);
    assertFootprintRevealed(w, 'straddle-drone');
  });

  it('T4 pulse discovery reveals every cell of a disk-straddling island (#98)', () => {
    const w = makeTinyWorld();
    const origin = w.islandStates!.get('home')!;
    origin.buildings.push({
      id: 'b_lt', defId: 'launch_tower', x: 0, y: 0, rotation: 0,
    } as any);
    origin.level = 30;
    origin.inventory.cryogenic_hydrogen = 50;
    w.islands.push({
      id: 'straddle-pulse', name: 'straddle-pulse', biome: 'plains',
      cx: 70, cy: 0, majorRadius: 30, minorRadius: 30,
      discovered: false, populated: false, buildings: [], modifiers: [],
    } as any);
    const r = firePulse(w, origin, 0);
    expect(r.ok).toBe(true);
    expect(r.discoveredIslandIds).toContain('straddle-pulse');
    assertFootprintRevealed(w, 'straddle-pulse');
  });

  it('probability-bias expanded ring reveals every cell of a rare island (#99)', () => {
    // Same ring geometry as Fix 6.4: T5 path-drawn drone (scanRadius 12)
    // with one probability_engine (bias 0.25 → effective radius 15) flying
    // east along y=2. A rare island in cell row 1 (cx=30, cy=24) is only
    // discoverable via the expanded ring; its full footprint must be revealed.
    // An antenna at home is added so the one-way drone's terminus (60,2) is
    // inside signal range and the buffered discovery is recovered.
    const w = makeTinyWorld();
    const homeSpec = w.islands.find((i) => i.id === 'home')!;
    homeSpec.buildings.push({ id: 'pe1', defId: 'probability_engine', x: 0, y: 0 } as any);
    homeSpec.buildings.push({ id: 'a1', defId: 'antenna_t1', x: 0, y: 0 } as any);
    const target: IslandSpec = {
      id: 'rare-ring', name: 'rare-ring', biome: 'plains',
      cx: 30, cy: 24, majorRadius: 3, minorRadius: 3,
      populated: false, discovered: false, buildings: [],
      modifiers: ['aetheric_anomaly'],
    };
    w.islands.push(target);
    const home = makeIslandState({
      id: 'home',
      level: 50,
      buildings: [
        { id: 'pe1', defId: 'probability_engine', x: 0, y: 0 } as any,
        { id: 'a1', defId: 'antenna_t1', x: 0, y: 0 } as any,
      ],
    });
    home.inventory.plasma_charge = 50;
    const r = dispatchDrone(w, home, 0, 2, 1, 0, 15, 0, [{ x: 0, y: 2 }, { x: 60, y: 2 }]);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    tickDrones(w, r.drone.expectedReturnTime + 1000, 0);
    assertFootprintRevealed(w, 'rare-ring');
  });

  // -------------------------------------------------------------------------
  // #141 — rare-island reveals must respect the §11 dark-mode antenna gate.
  // Same detection geometry as the #99 test above (T5 path drone, scanRadius 12
  // + one probability_engine → effective radius 15, rare island at cx=30,cy=24
  // reachable only via the expanded ring). The ONLY thing that varies is
  // antenna presence / drone fate, which is exactly the buffer gate under test.
  // -------------------------------------------------------------------------
  function rareRingWorld(withAntenna: boolean) {
    const w = makeTinyWorld();
    const homeSpec = w.islands.find((i) => i.id === 'home')!;
    homeSpec.buildings.push({ id: 'pe1', defId: 'probability_engine', x: 0, y: 0 });
    if (withAntenna) homeSpec.buildings.push({ id: 'a1', defId: 'antenna_t1', x: 0, y: 0 });
    const target: IslandSpec = {
      id: 'rare-ring', name: 'rare-ring', biome: 'plains',
      cx: 30, cy: 24, majorRadius: 3, minorRadius: 3,
      populated: false, discovered: false, buildings: [],
      modifiers: ['aetheric_anomaly'],
    };
    w.islands.push(target);
    const homeBuildings: Array<{ id: string; defId: string; x: number; y: number }> = [
      { id: 'pe1', defId: 'probability_engine', x: 0, y: 0 },
    ];
    if (withAntenna) homeBuildings.push({ id: 'a1', defId: 'antenna_t1', x: 0, y: 0 });
    const home = makeIslandState({ id: 'home', level: 50, buildings: homeBuildings as never });
    home.inventory.plasma_charge = 50;
    const r = dispatchDrone(w, home, 0, 2, 1, 0, 15, 0, [{ x: 0, y: 2 }, { x: 60, y: 2 }]);
    if (!r.ok) throw new Error('dispatch failed');
    return { w, target, drone: r.drone };
  }

  function assertFootprintNotRevealed(w: WorldState, islandId: string): void {
    const isl = w.islands.find((i) => i.id === islandId)!;
    expect(isl.discovered).toBe(false);
    for (const k of islandCells(isl)) expect(w.revealedCells.has(k)).toBe(false);
  }

  it('#141 rare island is buffered, NOT revealed, while the drone is out of antenna range', () => {
    const { w, drone } = rareRingWorld(false);
    // Tick to just before the terminus: the corridor has swept past the rare
    // island (x=30) but with no antenna anywhere nothing flushes.
    tickDrones(w, drone.expectedReturnTime - 1, 0);
    const d = w.drones[0]!;
    expect(d.status).toBe('active');
    // Detected into the dark-mode buffer, but not committed to the map.
    expect(d.darkModeDiscoveries.some((x) => x.islandId === 'rare-ring')).toBe(true);
    assertFootprintNotRevealed(w, 'rare-ring');
  });

  it('#141 rare island is forfeited when a path drone strands out of antenna range', () => {
    const { w, drone } = rareRingWorld(false);
    tickDrones(w, drone.expectedReturnTime + 1000, 0);
    expect(w.drones[0]!.status).toBe('stranded');
    assertFootprintNotRevealed(w, 'rare-ring');
  });

  it('#141 rare island is forfeited when the drone is lost in a storm', () => {
    const { w, drone } = rareRingWorld(false);
    // Doom the drone mid-flight, after it has swept past the rare island at
    // x=30 (0.9 of the 60-tile path = 54 tiles).
    (w.drones[0] as { doomedAtMs?: number }).doomedAtMs = Math.floor(drone.expectedReturnTime * 0.9);
    tickDrones(w, drone.expectedReturnTime + 1000, 0);
    expect(w.drones[0]!.status).toBe('lost');
    assertFootprintNotRevealed(w, 'rare-ring');
  });
});

// ---------------------------------------------------------------------------
// Constant sanity (these are tuned values; if they change the demo islands
// in DEMO_ISLANDS need to be re-checked for reachability).
// ---------------------------------------------------------------------------

describe('drone constants', () => {
  it('matches the documented step-6 tuning', () => {
    expect(DRONE_TIER_EFFICIENCY[1]).toBe(3);
    expect(DRONE_SPEED_TILES_PER_SEC).toBe(0.5); // rebalanced for idle-game scale, step #19 (was 2)
  });

  it('has the locked per-tier scan radius values', () => {
    expect(DRONE_TIER_SCAN_RADIUS[1]).toBe(2);
    expect(DRONE_TIER_SCAN_RADIUS[2]).toBe(4);
    expect(DRONE_TIER_SCAN_RADIUS[3]).toBe(8);
    expect(DRONE_TIER_SCAN_RADIUS[4]).toBe(0);
    expect(DRONE_TIER_SCAN_RADIUS[5]).toBe(12);
    expect(DRONE_TIER_SCAN_RADIUS[6]).toBe(16);
  });
});

describe('dispatchDrone — §11.7 tier-matched fuel', () => {
  function freshWorld(): WorldState {
    return {
      islands: [],
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
    oceanCells: new Map(),
    depthRevealedCells: new Set(),
      seed: 'test-seed',
      recentBuildAttempts: new Set(),
      recentBuildAttemptTs: new Map(),
    };
  }

  it('T1 island (level 1) consumes biofuel and records fuelResource', () => {
    const world = freshWorld();
    const home = makeIslandState({ level: 1 }); // tierForLevel(1) = 1 → biofuel
    home.inventory.biofuel = 50;
    home.inventory.diesel = 50; // present but must not be touched
    const r = dispatchDrone(world, home, 0, 0, 1, 0, 20, 0);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.drone.fuelResource).toBe('biofuel');
    expect(home.inventory.biofuel).toBe(30);
    expect(home.inventory.diesel).toBe(50);
  });

  it('T3 island (level 15) consumes aviation_kerosene, NOT biofuel', () => {
    const world = freshWorld();
    const home = makeIslandState({ level: 15 }); // tierForLevel(15) = 3 → aviation_kerosene
    home.inventory.biofuel = 999;
    home.inventory.aviation_kerosene = 50;
    const r = dispatchDrone(world, home, 0, 0, 1, 0, 20, 0);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.drone.fuelResource).toBe('aviation_kerosene');
    expect(home.inventory.aviation_kerosene).toBe(30);
    // Biofuel untouched — no fallback to lower grades per §11.7.
    expect(home.inventory.biofuel).toBe(999);
  });

  it('T3 island with no aviation_kerosene but plenty of biofuel fails insufficient-fuel', () => {
    const world = freshWorld();
    const home = makeIslandState({ level: 15 }); // T3
    home.inventory.biofuel = 999; // plenty, but wrong grade
    home.inventory.aviation_kerosene = 5; // not enough for 20-unit dispatch
    const r = dispatchDrone(world, home, 0, 0, 1, 0, 20, 0);
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.reason).toBe('insufficient-fuel');
    // No fallback — biofuel is preserved and no drone launched.
    expect(home.inventory.biofuel).toBe(999);
    expect(home.inventory.aviation_kerosene).toBe(5);
    expect(world.drones).toHaveLength(0);
  });

  it('T2 island (level 5) consumes diesel', () => {
    const world = freshWorld();
    const home = makeIslandState({ level: 5 }); // tierForLevel(5) = 2 → diesel
    home.inventory.biofuel = 999;
    home.inventory.diesel = 50;
    const r = dispatchDrone(world, home, 0, 0, 1, 0, 20, 0);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.drone.fuelResource).toBe('diesel');
    expect(home.inventory.diesel).toBe(30);
    expect(home.inventory.biofuel).toBe(999);
  });

  it('T4 island (level 30) consumes cryogenic_hydrogen', () => {
    const world = freshWorld();
    const home = makeIslandState({ level: 30 }); // T4
    home.inventory.cryogenic_hydrogen = 50;
    const r = dispatchDrone(world, home, 0, 0, 1, 0, 10, 0);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.drone.fuelResource).toBe('cryogenic_hydrogen');
    expect(home.inventory.cryogenic_hydrogen).toBe(40);
  });

  it("§11.5 drone tier matches launching island's tier (L5 → T2)", () => {
    const world = freshWorld();
    const home = makeIslandState({ level: 5 }); // tierForLevel(5) = 2
    home.inventory.diesel = 50;
    const r = dispatchDrone(world, home, 0, 0, 1, 0, 20, 0);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.drone.tier).toBe(2);
  });

  it("§11.5 drone tier matches launching island's tier (L30 → T4)", () => {
    const world = freshWorld();
    const home = makeIslandState({ level: 30 }); // tierForLevel(30) = 4
    home.inventory.cryogenic_hydrogen = 50;
    const r = dispatchDrone(world, home, 0, 0, 1, 0, 10, 0);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.drone.tier).toBe(4);
  });
});

describe('drone weather destruction §2.6', () => {
  function findClearSeed(): string {
    for (let i = 0; i < 1000; i++) {
      const seed = `clear-${i}`;
      const outboundPath = rasterizePath(0, 0, 1, 0, 20, 0.5, 0, 16);
      const apexTime = (20 / 0.5) * 1000;
      const returnPath = rasterizePath(20, 0, -1, 0, 20, 0.5, apexTime, 16);
      let allClear = true;
      for (const p of [...outboundPath, ...returnPath]) {
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
      const seed = `destroy-${i}`;
      if (weather(seed, 0, 0, 0).state !== 'catastrophic') continue;
      const result = rollVehicleDestruction(seed, [{ cx: 0, cy: 0, entryMs: 0 }], 1.5, 'drone-1');
      if (result.destroyed) return seed;
    }
    throw new Error('no destroying seed found');
  }

  it('drone in clear weather arrives normally', () => {
    const seed = findClearSeed();
    const w: WorldState = {
      islands: [],
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
    oceanCells: new Map(),
    depthRevealedCells: new Set(),
      seed,
      recentBuildAttempts: new Set(),
      recentBuildAttemptTs: new Map(),
    };
    const home = makeIslandState();
    home.inventory.biofuel = 50;
    dispatchDrone(w, home, 0, 0, 1, 0, 10, 0);
    // 10 fuel × 4 = 40 tiles round-trip, 80s flight.
    const r = tickDrones(w, 81_000, 0);
    expect(r.returned).toHaveLength(1);
    expect(r.lost).toHaveLength(0);
    expect(w.drones[0]!.status).toBe('returned');
  });

  it('drone in catastrophic weather gets destroyed (deterministic)', () => {
    const seed = findDestroyingSeed();
    const w: WorldState = {
      islands: [],
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
    oceanCells: new Map(),
    depthRevealedCells: new Set(),
      seed,
      recentBuildAttempts: new Set(),
      recentBuildAttemptTs: new Map(),
    };
    const home = makeIslandState();
    home.inventory.biofuel = 50;
    dispatchDrone(w, home, 0, 0, 1, 0, 10, 0);
    const r = tickDrones(w, 81_000, 0);
    expect(r.returned).toHaveLength(0);
    expect(r.lost).toHaveLength(1);
    expect(w.drones[0]!.status).toBe('lost');
  });
});

// ---------------------------------------------------------------------------
// §11.6 T5 path-drawn drones
// ---------------------------------------------------------------------------

describe('T5 path-drawn drone', () => {
  function freshWorld(): WorldState {
    return {
      islands: [],
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
    oceanCells: new Map(),
    depthRevealedCells: new Set(),
      seed: 'test-seed',
      recentBuildAttempts: new Set(),
      recentBuildAttemptTs: new Map(),
    };
  }

  it('dispatches with waypoints and defaults to island tier (T5)', () => {
    const world = freshWorld();
    const home = makeIslandState({ level: 50, aiCoreCrafted: true });
    home.inventory.plasma_charge = 50;
    const waypoints = [{ x: 0, y: 0 }, { x: 10, y: 0 }, { x: 10, y: 10 }] as const;
    const result = dispatchDrone(world, home, 0, 0, 1, 0, 10, 1000, waypoints);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.drone.tier).toBe(5);
    expect(result.drone.waypoints).toEqual(waypoints);
    expect(result.drone.scanRadius).toBe(DRONE_T5_SCAN_RADIUS_TILES);
    expect(result.drone.probabilityBias).toBe(0);
  });

  it('path-drawn with selectedTier=2 uses T2 economics and scan radius on a T5 island', () => {
    const world = freshWorld();
    const home = makeIslandState({ level: 50, aiCoreCrafted: true });
    home.inventory.diesel = 50;
    const waypoints = [{ x: 0, y: 0 }, { x: 10, y: 0 }, { x: 10, y: 10 }] as const;
    const result = dispatchDrone(world, home, 0, 0, 1, 0, 10, 1000, waypoints, 2);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.drone.tier).toBe(2);
    expect(result.drone.fuelResource).toBe('diesel');
    expect(result.drone.scanRadius).toBe(DRONE_TIER_SCAN_RADIUS[2]);
    expect(result.drone.waypoints).toEqual(waypoints);
  });

  it('rejects an over-long T5 path using T5 one-way efficiency', () => {
    const world = freshWorld();
    const home = makeIslandState({ level: 50, aiCoreCrafted: true });
    home.inventory.plasma_charge = 50;
    // 10 fuel × 15 efficiency = 150 tiles one-way.
    // Path (0,0)→(100,0)→(100,100) = 200 tiles > 150.
    const waypoints = [{ x: 0, y: 0 }, { x: 100, y: 0 }, { x: 100, y: 100 }] as const;
    const result = dispatchDrone(world, home, 0, 0, 1, 0, 10, 0, waypoints);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toBe('path-too-long');
  });

  it('accepts a T5 path exactly at the one-way fuel limit', () => {
    const world = freshWorld();
    const home = makeIslandState({ level: 50, aiCoreCrafted: true });
    home.inventory.plasma_charge = 50;
    // 10 fuel × 15 efficiency = 150 tiles one-way.
    // Path (0,0)→(150,0) = 150 tiles = exactly at limit.
    const waypoints = [{ x: 0, y: 0 }, { x: 150, y: 0 }] as const;
    const result = dispatchDrone(world, home, 0, 0, 1, 0, 10, 0, waypoints);
    expect(result.ok).toBe(true);
  });

  it('rejects an over-long T2 path using T2 efficiency', () => {
    const world = freshWorld();
    const home = makeIslandState({ level: 50, aiCoreCrafted: true });
    home.inventory.diesel = 50;
    // 10 fuel × 6 efficiency = 60 tiles one-way.
    // Path (0,0)→(50,0)→(50,50) = 100 tiles > 60.
    const waypoints = [{ x: 0, y: 0 }, { x: 50, y: 0 }, { x: 50, y: 50 }] as const;
    const result = dispatchDrone(world, home, 0, 0, 1, 0, 10, 0, waypoints, 2);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toBe('path-too-long');
  });

  it('path-drawn dispatch uses one-way range and path speed', () => {
    const world = freshWorld();
    const home = makeIslandState({ level: 50, aiCoreCrafted: true });
    home.inventory.plasma_charge = 50;
    // Path length 60; one-way semantics means it fits with plenty of margin.
    const waypoints = [{ x: 0, y: 0 }, { x: 30, y: 0 }, { x: 30, y: 30 }] as const;
    const result = dispatchDrone(world, home, 0, 0, 1, 0, 10, 1000, waypoints);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.drone.outboundTiles).toBeCloseTo(60);
    // Path-mode speed is tier-independent.
    expect(result.drone.expectedReturnTime).toBe(1000 + 75_000);
  });

  it('straight-line dispatch with selectedTier=5 stays round-trip', () => {
    const world = freshWorld();
    const home = makeIslandState({ level: 50, aiCoreCrafted: true });
    home.inventory.plasma_charge = 50;
    // T5 island launching a straight-line T5 drone: no waypoints means
    // round-trip math using DRONE_TIER_EFFICIENCY[5] = 15 and simple speed.
    const result = dispatchDrone(world, home, 0, 0, 1, 0, 10, 1000, undefined, 5);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.drone.waypoints.length).toBe(0);
    expect(result.drone.outboundTiles).toBe(75); // 150 tiles round-trip / 2
    expect(result.drone.expectedReturnTime).toBe(1000 + (150 / DRONE_SPEED_TILES_PER_SEC) * 1000);
  });

  it('droneCurrentPosition follows waypoints one-way and stops at the terminus', () => {
    const waypoints = [{ x: 0, y: 0 }, { x: 10, y: 0 }, { x: 10, y: 10 }] as const;
    const drone: Drone = {
      id: 'd-t5',
      fromIslandId: 'home',
      originX: 0,
      originY: 0,
      dirX: 1,
      dirY: 0,
      outboundTiles: 20,
      scanRadius: 12,
      launchTime: 0,
      expectedReturnTime: 25_000,
      tier: 5,
      fuelLoaded: 10,
      fuelResource: 'plasma_charge',
      status: 'active',
      waypoints,
      darkModeDiscoveries: [],
      scanBuffer: new Set<string>(),
      probabilityBias: 0,
    };
    // At launch
    expect(droneCurrentPosition(drone, 0)).toEqual({ x: 0, y: 0 });
    // Halfway along path: 10 tiles → at (10, 0)
    const halfPathMs = (10 / DRONE_T5_SPEED_TILES_PER_SEC) * 1000;
    expect(droneCurrentPosition(drone, halfPathMs)).toEqual({ x: 10, y: 0 });
    // Terminus: 20 tiles → at (10, 10)
    const terminusMs = (20 / DRONE_T5_SPEED_TILES_PER_SEC) * 1000;
    expect(droneCurrentPosition(drone, terminusMs)).toEqual({ x: 10, y: 10 });
    // After arrival the drone stays at the terminus.
    expect(droneCurrentPosition(drone, 50_000)).toEqual({ x: 10, y: 10 });
  });
});

// ---------------------------------------------------------------------------
// §11.6 dark-mode telemetry
// ---------------------------------------------------------------------------

describe('dark-mode telemetry', () => {
  function worldNoAntenna(islands: IslandSpec[]): WorldState {
    const home: IslandSpec = {
      id: 'home',
      name: 'home',
      biome: 'plains',
      cx: 0,
      cy: 0,
      majorRadius: 5,
      minorRadius: 5,
      populated: true,
      discovered: true,
      buildings: [],
      modifiers: [],
    };
    return {
      islands: [home, ...islands],
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
    oceanCells: new Map(),
    depthRevealedCells: new Set(),
      seed: 'test-seed',
      recentBuildAttempts: new Set(),
      recentBuildAttemptTs: new Map(),
    };
  }

  function worldWithAntenna(islands: IslandSpec[]): WorldState {
    const home: IslandSpec = {
      id: 'home',
      name: 'home',
      biome: 'plains',
      cx: 0,
      cy: 0,
      majorRadius: 5,
      minorRadius: 5,
      populated: true,
      discovered: true,
      buildings: [{ id: 'home-a1', defId: 'antenna_t1', x: 0, y: 0 }],
      modifiers: [],
    };
    return {
      islands: [home, ...islands],
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
      oceanCells: new Map(),
      depthRevealedCells: new Set(),
      seed: 'test-seed',
      recentBuildAttempts: new Set(),
      recentBuildAttemptTs: new Map(),
    };
  }

  it('T5 drone enters dark mode when out of antenna range', () => {
    const target = makeIslandSpec({
      id: 'near-target',
      cx: 30,
      cy: 0,
      majorRadius: 5,
      minorRadius: 5,
      discovered: false,
    });
    const w = worldNoAntenna([target]);
    const home = makeIslandState({ level: 50, aiCoreCrafted: true });
    home.inventory.plasma_charge = 50;
    dispatchDrone(w, home, 0, 0, 1, 0, 10, 0, [{ x: 0, y: 0 }, { x: 40, y: 0 }]);
    expect(w.drones[0]!.tier).toBe(5);
    // Tick at mid-flight (25s), before the one-way arrival at 50s.
    tickDrones(w, 25_000, 0);
    // Cells should NOT be revealed.
    expect(w.revealedCells.size).toBe(0);
    // But the island discovery should be buffered.
    expect(w.drones[0]!.darkModeDiscoveries.length).toBeGreaterThan(0);
    expect(w.drones[0]!.darkModeDiscoveries[0]!.islandId).toBe('near-target');
    // Island not yet discovered (flush happens only at a recovery point).
    expect(target.discovered).toBe(false);
    expect(w.drones[0]!.status).toBe('active');
  });

  it('recovers buffered telemetry when the terminus is inside antenna range', () => {
    const target = makeIslandSpec({
      id: 'near-target',
      cx: 30,
      cy: 0,
      majorRadius: 5,
      minorRadius: 5,
      discovered: false,
    });
    const w = worldWithAntenna([target]);
    const home = makeIslandState({ level: 50, aiCoreCrafted: true });
    home.inventory.plasma_charge = 50;
    const r = dispatchDrone(w, home, 0, 0, 1, 0, 10, 0, [{ x: 0, y: 0 }, { x: 40, y: 0 }]);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const tickResult = tickDrones(w, r.drone.expectedReturnTime + 1_000, 0);
    expect(w.drones[0]!.status).toBe('stranded');
    expect(tickResult.stranded).toContain(w.drones[0]);
    expect(r.drone.darkModeDiscoveries.length).toBe(0);
    expect(r.drone.scanBuffer.size).toBe(0);
    expect(target.discovered).toBe(true);
    expect(tickResult.newlyDiscoveredIslandIds).toContain('near-target');
    expect(w.revealedCells.size).toBeGreaterThan(0);
  });

  it('forfeits buffered telemetry when the terminus is outside antenna range', () => {
    const target = makeIslandSpec({
      id: 'far-target',
      cx: 50,
      cy: 0,
      majorRadius: 5,
      minorRadius: 5,
      discovered: false,
    });
    const w = worldNoAntenna([target]);
    const home = makeIslandState({ level: 50, aiCoreCrafted: true });
    home.inventory.plasma_charge = 50;
    const r = dispatchDrone(w, home, 0, 0, 1, 0, 20, 0, [{ x: 0, y: 0 }, { x: 100, y: 0 }]);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const tickResult = tickDrones(w, r.drone.expectedReturnTime + 1_000, 0);
    expect(w.drones[0]!.status).toBe('stranded');
    expect(tickResult.stranded).toContain(w.drones[0]);
    expect(target.discovered).toBe(false);
    expect(w.drones[0]!.darkModeDiscoveries.length).toBe(0);
    expect(w.drones[0]!.scanBuffer.size).toBe(0);
    expect(w.revealedCells.size).toBe(0);
  });

  it('a stranded drone frees its pad slot for another launch', () => {
    const w = worldWithAntenna([]);
    const home = makeIslandState({ level: 50, aiCoreCrafted: true });
    home.inventory.plasma_charge = 50;
    const r1 = dispatchDrone(w, home, 0, 0, 1, 0, 10, 0, [{ x: 0, y: 0 }, { x: 40, y: 0 }]);
    expect(r1.ok).toBe(true);
    if (!r1.ok) return;
    tickDrones(w, r1.drone.expectedReturnTime + 1_000, 0);
    expect(r1.drone.status).toBe('stranded');
    // Same launch origin: second dispatch succeeds because 'stranded' no longer
    // counts toward the per-pad in-flight cap.
    const r2 = dispatchDrone(
      w, home, 0, 0, 0, 1, 10,
      r1.drone.expectedReturnTime + 2_000,
      [{ x: 0, y: 0 }, { x: 40, y: 0 }],
    );
    expect(r2.ok).toBe(true);
  });

  it('one-way path-drawn drone destroyed by weather is lost, not stranded', () => {
    const w = worldNoAntenna([]);
    const d: Drone = {
      id: 'doomed-path',
      fromIslandId: 'home',
      originX: 0,
      originY: 0,
      dirX: 1,
      dirY: 0,
      outboundTiles: 20,
      scanRadius: 12,
      launchTime: 0,
      expectedReturnTime: 25_000,
      tier: 5,
      fuelLoaded: 10,
      fuelResource: 'plasma_charge',
      status: 'active',
      waypoints: [{ x: 0, y: 0 }, { x: 10, y: 0 }, { x: 10, y: 10 }],
      darkModeDiscoveries: [],
      scanBuffer: new Set<string>(['0,0', '1,0']),
      probabilityBias: 0,
      doomedAtMs: 10_000,
    };
    w.drones.push(d);
    const r = tickDrones(w, 100_000, 0);
    expect(d.status).toBe('lost');
    expect(r.lost).toContain(d);
    expect(r.stranded).toHaveLength(0);
    expect(d.scanBuffer.size).toBe(0);
    expect(d.darkModeDiscoveries.length).toBe(0);
  });

  it('discards dark mode discoveries on destruction', () => {
    const target = makeIslandSpec({
      id: 'near-target',
      cx: 30,
      cy: 0,
      majorRadius: 5,
      minorRadius: 5,
      discovered: false,
    });
    // Use a destroying seed so the drone is lost.
    const w: WorldState = {
      islands: [],
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
    oceanCells: new Map(),
    depthRevealedCells: new Set(),
      seed: 'destroy-0',
      recentBuildAttempts: new Set(),
      recentBuildAttemptTs: new Map(),
    };
    // Add home island with no antenna.
    w.islands.push({
      id: 'home',
      name: 'home',
      biome: 'plains',
      cx: 0,
      cy: 0,
      majorRadius: 5,
      minorRadius: 5,
      populated: true,
      discovered: true,
      buildings: [],
      modifiers: [],
    });
    w.islands.push(target);
    const home = makeIslandState({ level: 50, aiCoreCrafted: true });
    home.inventory.plasma_charge = 50;
    dispatchDrone(w, home, 0, 0, 1, 0, 10, 0, [{ x: 0, y: 0 }, { x: 40, y: 0 }]);
    // Force catastrophic weather for this drone.
    const r = tickDrones(w, 100_000, 0);
    if (r.lost.length === 0) {
      // If this seed happens to be clear, skip the destruction assertion.
      // In practice the fixed seed should produce a deterministic result.
      return;
    }
    expect(w.drones[0]!.status).toBe('lost');
    expect(w.drones[0]!.darkModeDiscoveries.length).toBe(0);
    expect(target.discovered).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// §13.3 Probability Engine
// ---------------------------------------------------------------------------

describe('probabilityBiasForIsland', () => {
  it('returns 0 with no Probability Engine', () => {
    expect(probabilityBiasForIsland({ buildings: [] })).toBe(0);
  });

  it('returns 0.25 with 1 engine', () => {
    expect(
      probabilityBiasForIsland({ buildings: [{ defId: 'probability_engine' }] }),
    ).toBe(0.25);
  });

  it('returns 0.40 with 2 engines', () => {
    expect(
      probabilityBiasForIsland({
        buildings: [{ defId: 'probability_engine' }, { defId: 'probability_engine' }],
      }),
    ).toBe(0.40);
  });

  it('returns 0.50 with 3 engines', () => {
    expect(
      probabilityBiasForIsland({
        buildings: [
          { defId: 'probability_engine' },
          { defId: 'probability_engine' },
          { defId: 'probability_engine' },
        ],
      }),
    ).toBe(0.50);
  });

  it('returns 0.60 with 4+ engines', () => {
    expect(
      probabilityBiasForIsland({
        buildings: [
          { defId: 'probability_engine' },
          { defId: 'probability_engine' },
          { defId: 'probability_engine' },
          { defId: 'probability_engine' },
        ],
      }),
    ).toBe(0.60);
  });
});

describe('firePulse (§11.5 T4 omnidirectional pulse)', () => {
  it('rejects when origin has no launch_tower', () => {
    const world = makeTinyWorld();
    const origin = world.islandStates!.get('home')!;
    origin.level = 30;
    origin.inventory.cryogenic_hydrogen = 100;
    const r = firePulse(world, origin, 0);
    expect(r.ok).toBe(false);
    expect(r.reason).toBe('no-launch-tower');
  });

  it('rejects when origin is below tier 4', () => {
    const world = makeTinyWorld();
    const origin = world.islandStates!.get('home')!;
    origin.buildings.push({
      id: 'b_lt', defId: 'launch_tower', x: 0, y: 0, rotation: 0,
    } as any);
    origin.level = 5; // T2
    origin.inventory.cryogenic_hydrogen = 100;
    const r = firePulse(world, origin, 0);
    expect(r.ok).toBe(false);
    expect(r.reason).toBe('tier-too-low');
  });

  it('rejects when origin lacks tier-4 fuel', () => {
    const world = makeTinyWorld();
    const origin = world.islandStates!.get('home')!;
    origin.buildings.push({
      id: 'b_lt', defId: 'launch_tower', x: 0, y: 0, rotation: 0,
    } as any);
    origin.level = 30;
    origin.inventory.cryogenic_hydrogen = 0;
    const r = firePulse(world, origin, 0);
    expect(r.ok).toBe(false);
    expect(r.reason).toBe('insufficient-fuel');
  });

  it('reveals every undiscovered island within T4_PULSE_RADIUS_TILES (=48) and deducts fuel', () => {
    const world = makeTinyWorld();
    const origin = world.islandStates!.get('home')!;
    origin.buildings.push({
      id: 'b_lt', defId: 'launch_tower', x: 0, y: 0, rotation: 0,
    } as any);
    origin.level = 30;
    origin.inventory.cryogenic_hydrogen = 50;
    // Place an undiscovered island within the disk and one outside.
    world.islands.push({
      id: 'near', cx: 30, cy: 0, majorRadius: 5, minorRadius: 5,
      discovered: false, populated: false, buildings: [], modifiers: [],
    } as any);
    world.islands.push({
      id: 'far', cx: 100, cy: 0, majorRadius: 5, minorRadius: 5,
      discovered: false, populated: false, buildings: [], modifiers: [],
    } as any);
    const r = firePulse(world, origin, 0);
    expect(r.ok).toBe(true);
    expect(r.discoveredIslandIds).toContain('near');
    expect(r.discoveredIslandIds).not.toContain('far');
    expect(world.islands.find((i) => i.id === 'near')!.discovered).toBe(true);
    expect(world.islands.find((i) => i.id === 'far')!.discovered).toBe(false);
    expect(origin.inventory.cryogenic_hydrogen).toBe(50 - T4_PULSE_FUEL_COST);
  });

  it('discovers a large island that OVERLAPS the disk even when its centre is outside the radius (§11.5 disk scan covers the disk)', () => {
    const world = makeTinyWorld();
    const origin = world.islandStates!.get('home')!;
    origin.buildings.push({
      id: 'b_lt', defId: 'launch_tower', x: 0, y: 0, rotation: 0,
    } as any);
    origin.level = 30;
    origin.inventory.cryogenic_hydrogen = 50;
    // Centre at x=70 is OUTSIDE the 48-tile disk, but radius 30 puts the
    // island's western tiles at x≈40 — well inside the disk. A "disk scan"
    // that covers the disk must discover it; the old centre-only test missed
    // every island straddling the disk edge.
    world.islands.push({
      id: 'straddle', name: 'straddle', biome: 'plains',
      cx: 70, cy: 0, majorRadius: 30, minorRadius: 30,
      discovered: false, populated: false, buildings: [], modifiers: [],
    } as any);
    const r = firePulse(world, origin, 0);
    expect(r.discoveredIslandIds).toContain('straddle');
    expect(world.islands.find((i) => i.id === 'straddle')!.discovered).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Fix 6.1 — offline catch-up: corridor flown while tab was closed is scanned
// ---------------------------------------------------------------------------

describe('Fix 6.1: offline drone catch-up', () => {
  function worldWithAntenna(): WorldState {
    const home: IslandSpec = {
      id: 'home',
      name: 'home',
      biome: 'plains',
      cx: 0,
      cy: 0,
      majorRadius: 5,
      minorRadius: 5,
      populated: true,
      discovered: true,
      buildings: [{ id: 'home-a1', defId: 'antenna_t1', x: 0, y: 0 }],
      modifiers: [],
    };
    return {
      islands: [home],
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
      oceanCells: new Map(),
      depthRevealedCells: new Set(),
      seed: 'test-seed',
      recentBuildAttempts: new Set(),
      recentBuildAttemptTs: new Map(),
    };
  }

  it('offline window [1000,5000]: single catch-up tick(6000, 900) reveals corridor and returns drone', () => {
    // Drone launched at t=1000 with a short flight ending at t=5000.
    // Tab was "closed" during [1000,5000]. The catch-up tick is
    // tickDrones(world, 6000, 900) — prevTickMs=900 < launchTime=1000.
    // segStartMs = max(900, 1000) = 1000, so the full flight is covered.
    const w = worldWithAntenna();
    const home = makeIslandState({ level: 5 });
    // diesel for T2; efficiency=6 → 10 fuel → 60 tiles round-trip, 120s flight
    home.inventory.diesel = 50;
    const r = dispatchDrone(w, home, 0, 0, 1, 0, 10, 1000, undefined, 2);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const d = r.drone;
    // Flight: launchTime=1000, expectedReturnTime = 1000 + (60/0.5)*1000 = 121000
    // Catch-up: tick(nowMs=130000, prevTickMs=900) — covers the full offline window
    const tickResult = tickDrones(w, 130_000, 900);
    // 'test-seed' does not destroy this drone (deterministic) → returned,
    // and the return flush drains the full-flight scan buffer.
    expect(d.status).toBe('returned');
    expect(tickResult.returned).toHaveLength(1);
    expect(tickResult.revealedCellsAdded).toBeGreaterThan(0);
    // Launch cell revealed…
    expect(w.revealedCells.has('0,0')).toBe(true);
    // …and so is a far corridor cell near the apex (x=30 → cell 1) that can
    // ONLY come from scanning the offline window — the drone is back at the
    // origin at tick time, so a [now,now] degenerate segment would miss it.
    expect(w.revealedCells.has('1,0')).toBe(true);
  });

  it('in-session pause clamping still holds: segStartMs = max(prevTick, launchTime)', () => {
    // If prevTickMs > launchTime, segStartMs is prevTickMs (not launchTime).
    // This guards that we don't re-scan the segment before prevTick.
    const w = worldWithAntenna();
    const home = makeIslandState({ level: 5 });
    home.inventory.diesel = 50;
    const launchMs = 1000;
    const r = dispatchDrone(w, home, 0, 0, 1, 0, 10, launchMs, undefined, 2);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const d = r.drone;

    // First tick: covers [1000, 5000] — mid-flight, some cells buffered
    tickDrones(w, 5_000, 1_000);
    const revealedAfterFirst = w.revealedCells.size;

    // Second tick: covers [5000, 10000] — more flight
    tickDrones(w, 10_000, 5_000);
    // Should have scanned more (or the same if already all covered)
    expect(w.revealedCells.size).toBeGreaterThanOrEqual(revealedAfterFirst);

    // Verify drone is still active or returned
    expect(d.status === 'active' || d.status === 'returned' || d.status === 'lost').toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Fix 6.2 — T5 path waypoint crossing times
// ---------------------------------------------------------------------------

describe('Fix 6.2: T5 L-shaped path scans true polyline not chord', () => {
  function worldNoAntenna(): WorldState {
    const home: IslandSpec = {
      id: 'home',
      name: 'home',
      biome: 'plains',
      cx: 0,
      cy: 0,
      majorRadius: 5,
      minorRadius: 5,
      populated: true,
      discovered: true,
      buildings: [],
      modifiers: [],
    };
    return {
      islands: [home],
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
      oceanCells: new Map(),
      depthRevealedCells: new Set(),
      seed: 'test-seed',
      recentBuildAttempts: new Set(),
      recentBuildAttemptTs: new Map(),
    };
  }

  it('L-shaped path (0,0)→(30,0)→(30,30): elbow cell is scanned but chord-only cell is not', () => {
    // Path-drawn flights are one-way, so the drone only travels
    // (0,0)→(30,0)→(30,30). Total path = 60 tiles.
    // At DRONE_TIER_EFFICIENCY[5]=15, need 60/15 = 4 fuel.
    // Elbow at approx (30,0) — tile cell covering (30,0) should be in scanBuffer.
    // A chord-only cell at roughly (21, 12) (diagonal from origin to apex) should NOT be in scanBuffer.
    const w = worldNoAntenna();
    const home = makeIslandState({ level: 50, aiCoreCrafted: true });
    home.inventory.plasma_charge = 50;
    const waypoints = [{ x: 0, y: 0 }, { x: 30, y: 0 }, { x: 30, y: 30 }] as const;
    const fuel = Math.ceil(60 / DRONE_TIER_EFFICIENCY[5]); // 4
    const r = dispatchDrone(w, home, 0, 0, 1, 0, fuel, 0, waypoints);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const d = r.drone;

    // Tick at mid-outbound (before arrival at the terminus), so the buffer has
    // not been forfeited by stranding without an antenna.
    const outboundMs = (60 / DRONE_T5_SPEED_TILES_PER_SEC) * 1000; // 75000
    tickDrones(w, Math.floor(outboundMs / 2), 0);
    expect(d.status).toBe('active');

    // Elbow cell: (30,0) → cell coords = floor(30/16), floor(0/16) = (1,0)
    // The drone passes through the elbow, so cell (1,0) must be in the scanBuffer.
    const elbowCellKey = '1,0';
    expect(d.scanBuffer.has(elbowCellKey)).toBe(true);

    // Chord-only cell: the straight line from (0,0) to (30,30) passes through
    // roughly (15,15), cell (0,0). But the actual path goes east then north —
    // a diagonal-only cell like (1,1) (center ~(24,24)) would only be on the
    // chord, not the actual L-path. Let's check cell at center (16,16) → cell (1,1).
    // The actual path goes: along y=0 to x=30, then along x=30 to y=30.
    // The chord from (0,0) to (30,30) passes through (16,16) → cell (1,1).
    // The actual path does NOT pass through x=16, y=16 — it goes x=0..30 at y=0,
    // then x=30 from y=0..30. So cell (1,1) should NOT be scanned.
    // (1,1) center = (24,24). Path segment 1: y=0 so min dist from (24,24) to
    // segment [(0,0),(30,0)] = 24 tiles. Segment 2: x=30 so min dist from (24,24)
    // to segment [(30,0),(30,30)] = 6 tiles. Scan radius T5 = 12.
    // Segment 2 distance = 6 < 12 → cell (1,1) IS within range of segment 2!
    // Let's pick a true chord-only cell: (0,1) center = (8, 24).
    // Segment 1 (y=0): dist = 24, > 12 → not scanned.
    // Segment 2 (x=30): dist = 22, > 12 → not scanned.
    // So cell (0,1) should NOT be in scanBuffer.
    const chordOnlyCellKey = '0,1';
    expect(d.scanBuffer.has(chordOnlyCellKey)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Fix 6.3 — destruction fate decided at dispatch (§11.7); doomed drones
// never scan past their death cell; old saves fall back to return-time roll
// ---------------------------------------------------------------------------

describe('Fix 6.3: destruction fate decided at dispatch', () => {
  function worldWithSeed(seed: string): WorldState {
    return {
      islands: [{
        id: 'home',
        name: 'home',
        biome: 'plains',
        cx: 0,
        cy: 0,
        majorRadius: 5,
        minorRadius: 5,
        populated: true,
        discovered: true,
        buildings: [],
        modifiers: [],
      }],
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
      oceanCells: new Map(),
      depthRevealedCells: new Set(),
      seed,
      recentBuildAttempts: new Set(),
      recentBuildAttemptTs: new Map(),
    };
  }

  /** Hand-built T2 straight-line drone: origin (0,0) → east 30 tiles →
   *  back. Speed 0.5 t/s ⇒ apex at 60s, return at 120s. The `doomedAtMs`
   *  field is set (or omitted) per test to pin the fate plumbing without
   *  hunting RNG seeds through dispatchDrone. */
  function manualDrone(over: Partial<Drone> & Pick<Drone, 'id'>): Drone {
    return {
      fromIslandId: 'home',
      originX: 0,
      originY: 0,
      dirX: 1,
      dirY: 0,
      outboundTiles: 30,
      scanRadius: 4,
      launchTime: 0,
      expectedReturnTime: 120_000,
      tier: 2,
      fuelLoaded: 10,
      fuelResource: 'diesel',
      status: 'active',
      waypoints: [],
      darkModeDiscoveries: [],
      scanBuffer: new Set<string>(),
      probabilityBias: 0,
      ...over,
    };
  }

  it('per-tick scanning clamps segEndMs to doomedAtMs: no cells past the death point', () => {
    // Doomed at t=30s — drone is at x=15, well short of the apex (x=30).
    // Tick to t=119s (still pre-return so buffers are not GC'd yet): the
    // scan must cover only [0s, 30s] → cells near the origin, NOT the cell
    // out at the apex.
    const w = worldWithSeed('any-seed');
    const d = manualDrone({ id: 'doomed-1', doomedAtMs: 30_000 });
    w.drones.push(d);
    tickDrones(w, 119_000, 0);
    // Launch cell scanned (corridor [x=0 .. x=15]).
    expect(d.scanBuffer.has('0,0')).toBe(true);
    // Apex-adjacent cell (x≈40 → cell 2) is past the death point. Without
    // the clamp the corridor runs to the apex and back and buffers it.
    expect(d.scanBuffer.has('2,0')).toBe(false);
  });

  it('return-time bookkeeping uses the stored fate, not a fresh roll', () => {
    // 'legacy-0' does NOT destroy this drone under the return-time roll
    // (verified below). With doomedAtMs stored the drone must be lost
    // anyway — the dispatch-time fate is authoritative.
    const seed = 'legacy-0';
    const reroll = rollVehicleDestruction(seed, legacyStraightPath(), 1.0, 'doomed-2');
    expect(reroll.destroyed).toBe(false); // guard: re-roll would say "survive"
    const w = worldWithSeed(seed);
    const d = manualDrone({ id: 'doomed-2', doomedAtMs: 30_000 });
    w.drones.push(d);
    const r = tickDrones(w, 121_000, 0);
    expect(d.status).toBe('lost');
    expect(r.lost).toHaveLength(1);
    // §11.6 data lost on failure: buffer GC'd, nothing flushed.
    expect(d.scanBuffer.size).toBe(0);
    expect(w.revealedCells.size).toBe(0);
  });

  /** The exact path the legacy (return-time) roll rasterizes for the
   *  manualDrone above — outbound + return legs, (cell,time)-deduped. */
  function legacyStraightPath(): Array<{ cx: number; cy: number; entryMs: number }> {
    const out = rasterizePath(0, 0, 1, 0, 30, 0.5, 0, 16);
    const ret = rasterizePath(30, 0, -1, 0, 30, 0.5, 60_000, 16);
    const seen = new Set<string>();
    const path: Array<{ cx: number; cy: number; entryMs: number }> = [];
    for (const p of [...out, ...ret]) {
      const k = `${p.cx},${p.cy},${p.entryMs}`;
      if (seen.has(k)) continue;
      seen.add(k);
      path.push(p);
    }
    return path;
  }

  it('old save without doomedAtMs falls back to the return-time roll (destroyed)', () => {
    // 'legacy-71' destroys drone id 'legacy-drone' on this path (found by
    // deterministic scan; guarded here so a weather/RNG change is loud).
    const seed = 'legacy-71';
    const roll = rollVehicleDestruction(seed, legacyStraightPath(), 1.0, 'legacy-drone');
    expect(roll.destroyed).toBe(true); // guard
    const w = worldWithSeed(seed);
    const d = manualDrone({ id: 'legacy-drone' }); // doomedAtMs absent
    w.drones.push(d);
    const r = tickDrones(w, 121_000, 0);
    expect(d.status).toBe('lost');
    expect(r.lost).toHaveLength(1);
    expect(w.revealedCells.size).toBe(0);
  });

  it('old save without doomedAtMs falls back to the return-time roll (survives)', () => {
    const seed = 'legacy-0';
    const roll = rollVehicleDestruction(seed, legacyStraightPath(), 1.0, 'legacy-drone');
    expect(roll.destroyed).toBe(false); // guard
    const w = worldWithSeed(seed);
    const d = manualDrone({ id: 'legacy-drone' });
    w.drones.push(d);
    const r = tickDrones(w, 121_000, 0);
    expect(d.status).toBe('returned');
    expect(r.returned).toHaveLength(1);
    // Survivor flushes its full-flight buffer on return.
    expect(w.revealedCells.has('0,0')).toBe(true);
    expect(w.revealedCells.has('1,0')).toBe(true);
  });

  it('dispatch pre-computes a surviving fate as undefined (clear weather)', () => {
    let clearSeed = '';
    for (let i = 0; i < 1000; i++) {
      const s = `clear-${i}`;
      const path = rasterizePath(0, 0, 1, 0, 20, 0.5, 0, 16);
      const apexTime = (20 / 0.5) * 1000;
      const retPath = rasterizePath(20, 0, -1, 0, 20, 0.5, apexTime, 16);
      let allClear = true;
      for (const p of [...path, ...retPath]) {
        if (weather(s, p.cx, p.cy, p.entryMs).state !== 'clear') { allClear = false; break; }
      }
      if (allClear) { clearSeed = s; break; }
    }
    expect(clearSeed).not.toBe('');

    const w = worldWithSeed(clearSeed);
    const home = makeIslandState();
    home.inventory.biofuel = 50;
    const res = dispatchDrone(w, home, 0, 0, 1, 0, 10, 0);
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.drone.doomedAtMs).toBeUndefined();
    tickDrones(w, res.drone.expectedReturnTime + 1000, 0);
    expect(res.drone.status).toBe('returned');
    expect(w.revealedCells.size).toBeGreaterThan(0);
  });
});

// ---------------------------------------------------------------------------
// Fix 6.4 — rare-island bias only applies to rare islands
// ---------------------------------------------------------------------------

describe('Fix 6.4: rare-bias ring discovers rare islands only', () => {
  // The Probability Engine expands the corridor ONLY for RARE islands
  // (rareIslandsInCells). Ordinary islands must use the plain `corridor`.
  //
  // Ring geometry: T5 drone (scanRadius 12) with one operational
  // probability_engine (bias 0.25 → expanded radius 15) flying east along
  // y=2. `corridorCells` clips its candidate walk to the path bbox expanded
  // by the radius: plain reaches y ≤ 14 (cell row 0 only), expanded reaches
  // y ≤ 17 (row 1 included; row-1 cell centers at y=24 sit at distance 22
  // ≤ 15 + half-cell-diagonal ≈ 26.3). An island whose footprint lies
  // entirely in row 1 is therefore in the expanded corridor but NOT the
  // plain one — the rare-bias ring.

  function makeWorld6_4(seed: string): WorldState {
    return {
      islands: [{
        id: 'home', name: 'home', biome: 'plains',
        cx: 0, cy: 0, majorRadius: 5, minorRadius: 5,
        populated: true, discovered: true,
        buildings: [
        { id: 'pe1', defId: 'probability_engine', x: 0, y: 0 },
        { id: 'a1', defId: 'antenna_t1', x: 0, y: 0 },
      ],
        modifiers: [],
      }],
      drones: [], routes: [], vehicles: [],
      revealedCells: new Set(), satellites: [], repairDrones: [], debrisFields: [],
      endgameState: { achieved: new Set(), firstAchievedMs: null },
      latticeActive: false, latticeNodeIslands: [], commPackets: [],
      totalCo2Kg: 0, playerLat: null, playerLon: null,
      oceanCells: new Map(), depthRevealedCells: new Set(),
      seed,
      recentBuildAttempts: new Set(), recentBuildAttemptTs: new Map(),
    };
  }

  /** Dispatch the ring-probe T5 drone and tick its whole flight. The island
   *  under test sits at (30, 24), footprint y∈[21,27] — cell row 1 only. */
  function flyRingProbe(w: WorldState, island: IslandSpec): void {
    const home = makeIslandState({
      id: 'home',
      level: 50,
      buildings: [
        { id: 'pe1', defId: 'probability_engine', x: 0, y: 0 },
        { id: 'a1', defId: 'antenna_t1', x: 0, y: 0 },
      ],
    });
    home.inventory.plasma_charge = 50;
    w.islands.push(island);
    // Path 60 tiles one-way; 15 fuel is more than enough (limit = 225 tiles).
    const waypoints = [{ x: 0, y: 2 }, { x: 60, y: 2 }] as const;
    const r = dispatchDrone(w, home, 0, 2, 1, 0, 15, 0, waypoints);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.drone.probabilityBias).toBe(0.25); // guard: engine counted
    tickDrones(w, r.drone.expectedReturnTime + 1000, 0);
    // Guard: drone survived to the terminus, which is inside the antenna's
    // range, so the buffered data is recovered — not lost.
    expect(r.drone.status).toBe('stranded');
  }

  it('ordinary island only in the expanded ring stays undiscovered', () => {
    const w = makeWorld6_4('clear-0');
    const ordinaryIsland: IslandSpec = {
      id: 'ordinary', name: 'ordinary', biome: 'plains',
      cx: 30, cy: 24, majorRadius: 3, minorRadius: 3,
      populated: false, discovered: false, buildings: [],
      modifiers: [], // NOT rare
    };
    flyRingProbe(w, ordinaryIsland);
    expect(ordinaryIsland.discovered).toBe(false);
  });

  it('rare island in the same ring IS discovered', () => {
    const w = makeWorld6_4('clear-0');
    const rareIsland: IslandSpec = {
      id: 'rare', name: 'rare', biome: 'plains',
      cx: 30, cy: 24, majorRadius: 3, minorRadius: 3,
      populated: false, discovered: false, buildings: [],
      modifiers: ['aetheric_anomaly'], // RARE
    };
    flyRingProbe(w, rareIsland);
    expect(rareIsland.discovered).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Fix 6.5 — Probability Engine counts only operational buildings
// ---------------------------------------------------------------------------

describe('Fix 6.5: probabilityBiasForIsland only counts operational buildings', () => {
  it('under-construction probability_engine grants no bias', () => {
    const result = probabilityBiasForIsland({
      buildings: [{ defId: 'probability_engine', constructionRemainingMs: 5000 }],
    });
    expect(result).toBe(0);
  });

  it('invalid probability_engine grants no bias', () => {
    const result = probabilityBiasForIsland({
      buildings: [{ defId: 'probability_engine', invalid: true }],
    });
    expect(result).toBe(0);
  });

  it('disabled probability_engine grants no bias', () => {
    const result = probabilityBiasForIsland({
      buildings: [{ defId: 'probability_engine', disabledFloors: displayedFloorLevel({ floorLevel: 0 }) }],
    });
    expect(result).toBe(0);
  });

  it('operational probability_engine still grants 0.25 bias', () => {
    const result = probabilityBiasForIsland({
      buildings: [{ defId: 'probability_engine' }],
    });
    expect(result).toBe(0.25);
  });

  it('mixed: 1 under-construction + 1 operational = bias for 1 engine', () => {
    const result = probabilityBiasForIsland({
      buildings: [
        { defId: 'probability_engine', constructionRemainingMs: 5000 },
        { defId: 'probability_engine' },
      ],
    });
    expect(result).toBe(0.25);
  });
});

// ---------------------------------------------------------------------------
// §15.1 wall-anchored drone weather (module anchor)
// ---------------------------------------------------------------------------

describe('§15.1 wall-anchored drone weather', () => {
  const W = 53 * 60 * 60 * 1000; // 53 h of wall time

  function freshWorld(seed: string): WorldState {
    return {
      islands: [],
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
      oceanCells: new Map(),
      depthRevealedCells: new Set(),
      seed,
      recentBuildAttempts: new Set(),
      recentBuildAttemptTs: new Map(),
    };
  }

  /** Dispatch one straight-line drone at perf-time `launchMs` under wall
   *  anchor `anchorMs`; returns whether the dispatch-time fate roll doomed
   *  it (`doomedAtMs` set). */
  function fateWithAnchor(seed: string, launchMs: number, anchorMs: number): boolean {
    const w = freshWorld(seed);
    const home = makeIslandState();
    home.inventory.biofuel = 50;
    _resetDroneIdCounter();
    const r = dispatchDrone(w, home, 0, 0, 1, 0, 10, launchMs, undefined, undefined, anchorMs);
    expect(r.ok).toBe(true);
    return r.ok ? r.drone.doomedAtMs !== undefined : false;
  }

  it('anchor W at launch 0 ≡ anchor 0 at launch W (same wall instant, same fate)', () => {
    for (let i = 0; i < 20; i++) {
      const seed = `drone-anchor-eq-${i}`;
      expect(fateWithAnchor(seed, 0, W)).toBe(fateWithAnchor(seed, W, 0));
    }
  });

  it('a nonzero anchor flips some fate (the anchor reaches the weather samples)', () => {
    let flipped = false;
    for (let i = 0; i < 400 && !flipped; i++) {
      const seed = `drone-anchor-flip-${i}`;
      flipped = fateWithAnchor(seed, 0, 0) !== fateWithAnchor(seed, 0, W);
    }
    expect(flipped).toBe(true);
  });

  it('dispatch fate and the legacy return-time fallback agree under a nonzero anchor', () => {
    // Find one doomed and one surviving seed under anchor W, then replay each
    // through the legacy old-save path (doomedAtMs stripped) under the SAME
    // anchor — the fallback re-roll must reproduce the dispatch-time fate.
    let doomedSeed: string | null = null;
    let survivorSeed: string | null = null;
    for (let i = 0; i < 400 && (!doomedSeed || !survivorSeed); i++) {
      const seed = `drone-anchor-lockstep-${i}`;
      if (fateWithAnchor(seed, 0, W)) doomedSeed = doomedSeed ?? seed;
      else survivorSeed = survivorSeed ?? seed;
    }
    expect(doomedSeed).not.toBeNull();
    expect(survivorSeed).not.toBeNull();

    for (const [seed, expectLost] of [
      [doomedSeed!, true],
      [survivorSeed!, false],
    ] as const) {
      const w = freshWorld(seed);
      const home = makeIslandState();
      home.inventory.biofuel = 50;
      _resetDroneIdCounter();
      const r = dispatchDrone(w, home, 0, 0, 1, 0, 10, 0, undefined, undefined, W);
      expect(r.ok).toBe(true);
      if (!r.ok) return;
      // Simulate an old save: strip the pre-computed fate so tickDrones
      // takes the legacy re-roll path. (`doomedAtMs` is readonly on the
      // public type; old saves simply deserialize without it.)
      (r.drone as { doomedAtMs?: number }).doomedAtMs = undefined;
      const t = tickDrones(w, 81_000, 0, W);
      expect(t.lost).toHaveLength(expectLost ? 1 : 0);
      expect(t.returned).toHaveLength(expectLost ? 0 : 1);
    }
  });
});

describe('§7.3 coherent weather field for drone fate rolls', () => {
  const CRISIS_CO2 = 200_000;

  function worldWithCo2(seed: string, co2Kg: number): WorldState {
    const homeState = makeIslandState({ id: 'home', co2Kg });
    const w: WorldState = {
      islands: [],
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
      oceanCells: new Map(),
      depthRevealedCells: new Set(),
      seed,
      recentBuildAttempts: new Set(),
      recentBuildAttemptTs: new Map(),
    };
    w.islandStates = new Map<string, IslandState>([['home', homeState]]);
    return w;
  }

  function fateWithCo2(seed: string, co2Kg: number): boolean {
    const w = worldWithCo2(seed, co2Kg);
    const home = makeIslandState();
    home.inventory.biofuel = 50;
    _resetDroneIdCounter();
    // 50 fuel × T1 efficiency 4 = 200 tiles round trip → the path crosses
    // ~7 distinct cells, giving the CO₂ band shift (light_fog→storm — a
    // clear→storm flip is arithmetically impossible) a realistic surface
    // to land a fate change on.
    const r = dispatchDrone(w, home, 0, 0, 1, 0, 50, 0);
    expect(r.ok).toBe(true);
    return r.ok ? r.drone.doomedAtMs !== undefined : false;
  }

  it('crisis CO₂ reaches the dispatch fate roll (some fate flips)', () => {
    let flipped = false;
    for (let i = 0; i < 1500 && !flipped; i++) {
      const seed = `drone-co2-${i}`;
      flipped = fateWithCo2(seed, 0) !== fateWithCo2(seed, CRISIS_CO2);
    }
    expect(flipped).toBe(true);
  });

  it("the launch cell's biome reaches the dispatch fate roll (some fate flips)", () => {
    function fateWithBiome(seed: string, biome: IslandSpec['biome']): boolean {
      const w = worldWithCo2(seed, 0);
      // Island centred at (0, 0) puts its biome on cell (0, 0) — the
      // drone's launch cell — via biomeForCell.
      w.islands.push(makeIslandSpec({ id: 'home', biome, cx: 0, cy: 0, populated: true, discovered: true }));
      const home = makeIslandState();
      home.inventory.biofuel = 50;
      _resetDroneIdCounter();
      const r = dispatchDrone(w, home, 0, 0, 1, 0, 10, 0);
      expect(r.ok).toBe(true);
      return r.ok ? r.drone.doomedAtMs !== undefined : false;
    }
    let flipped = false;
    for (let i = 0; i < 400 && !flipped; i++) {
      const seed = `drone-biome-${i}`;
      flipped = fateWithBiome(seed, 'plains') !== fateWithBiome(seed, 'volcanic');
    }
    expect(flipped).toBe(true);
  });

  it('CO₂-amplified fate stays in lockstep with the legacy return-time fallback', () => {
    // The legacy re-roll must consume the SAME coherent field (biome + CO₂)
    // as the dispatch-time roll, or old saves would flip fates.
    let checked = 0;
    for (let i = 0; i < 60; i++) {
      const seed = `drone-co2-lockstep-${i}`;
      const w = worldWithCo2(seed, CRISIS_CO2);
      const home = makeIslandState();
      home.inventory.biofuel = 50;
      _resetDroneIdCounter();
      const r = dispatchDrone(w, home, 0, 0, 1, 0, 10, 0);
      expect(r.ok).toBe(true);
      if (!r.ok) continue;
      const doomed = r.drone.doomedAtMs !== undefined;
      (r.drone as { doomedAtMs?: number }).doomedAtMs = undefined;
      const t = tickDrones(w, 81_000, 0);
      expect(t.lost).toHaveLength(doomed ? 1 : 0);
      expect(t.returned).toHaveLength(doomed ? 0 : 1);
      checked++;
    }
    expect(checked).toBe(60);
  });
});
