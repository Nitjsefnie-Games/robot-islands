// Drones: pure-logic tests for capsule-corridor math, dispatch validation,
// and tick-based discovery (§11.1-11.3).

import { beforeEach, describe, expect, it } from 'vitest';

import type { IslandState } from './economy.js';
import {
  DRONE_SCAN_RADIUS_TILES,
  DRONE_SPEED_TILES_PER_SEC,
  DRONE_TIER_EFFICIENCY,
  _resetDroneIdCounter,
  dispatchDrone,
  pointToSegmentDistSq,
  tickDrones,
} from './drones.js';
import { ALL_RESOURCES, type ResourceId } from './recipes.js';
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

beforeEach(() => {
  _resetDroneIdCounter();
});

// ---------------------------------------------------------------------------
// pointToSegmentDistSq
// ---------------------------------------------------------------------------

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

// ---------------------------------------------------------------------------
// dispatchDrone
// ---------------------------------------------------------------------------

describe('dispatchDrone', () => {
  function freshWorld(): WorldState {
    return { islands: [], drones: [], routes: [], vehicles: [] };
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
    // Range = 20 * 4 = 80 tiles, outbound = 40 tiles.
    expect(d.outboundTiles).toBe(40);
    // Travel time = 80 / 0.5 = 160s → return at 1000 + 160_000. (rebalanced step #19)
    expect(d.expectedReturnTime).toBe(1000 + 160_000);
    expect(d.scanRadius).toBe(DRONE_SCAN_RADIUS_TILES);
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
});

// ---------------------------------------------------------------------------
// tickDrones
// ---------------------------------------------------------------------------

describe('tickDrones', () => {
  function world(islands: IslandSpec[]): WorldState {
    return { islands, drones: [], routes: [], vehicles: [] };
  }

  it('returns empty when no drones are in flight', () => {
    const w = world([]);
    const r = tickDrones(w, 5000);
    expect(r.returned).toHaveLength(0);
    expect(r.newlyDiscoveredIslandIds).toHaveLength(0);
  });

  it('leaves a drone untouched when nowMs < expectedReturnTime', () => {
    const w = world([]);
    const home = makeIslandState();
    home.inventory.biofuel = 50;
    dispatchDrone(w, home, 0, 0, 1, 0, 10, 1000);
    // 10 fuel × 4 efficiency = 40 tiles round-trip / 2 t/s = 20s flight.
    // Tick at 5_000 ms < 21_000 ms expected return.
    const r = tickDrones(w, 5_000);
    expect(r.returned).toHaveLength(0);
    expect(w.drones).toHaveLength(1);
  });

  it('removes a drone on return and reveals islands inside the corridor', () => {
    const target = makeIslandSpec({ id: 'target', cx: 30, cy: 5, discovered: false });
    const w = world([target]);
    const home = makeIslandState();
    home.inventory.biofuel = 50;
    dispatchDrone(w, home, 0, 0, 1, 0, 20, 0);
    // 20 fuel → 80 tiles round-trip at 0.5 t/s = 160s; outbound endpoint (40, 0).
    // Target at (30, 5) is 5 tiles off the segment, scan radius 8 → inside.
    // (rebalanced step #19: was 41_000 at 2 t/s)
    const r = tickDrones(w, 161_000);
    expect(r.returned).toHaveLength(1);
    expect(w.drones).toHaveLength(0);
    expect(target.discovered).toBe(true);
    expect(r.newlyDiscoveredIslandIds).toEqual(['target']);
  });

  it('does not reveal islands outside the corridor', () => {
    const inside = makeIslandSpec({ id: 'inside', cx: 30, cy: 5, discovered: false });
    const outside = makeIslandSpec({ id: 'outside', cx: 30, cy: 12, discovered: false });
    const w = world([inside, outside]);
    const home = makeIslandState();
    home.inventory.biofuel = 50;
    dispatchDrone(w, home, 0, 0, 1, 0, 20, 0);
    // 80 tiles / 0.5 t/s = 160s (rebalanced step #19)
    const r = tickDrones(w, 161_000);
    expect(r.newlyDiscoveredIslandIds).toEqual(['inside']);
    expect(inside.discovered).toBe(true);
    expect(outside.discovered).toBe(false);
  });

  it('does not re-report an already-discovered island in newlyDiscoveredIslandIds', () => {
    const known = makeIslandSpec({ id: 'known', cx: 30, cy: 5, discovered: true });
    const w = world([known]);
    const home = makeIslandState();
    home.inventory.biofuel = 50;
    dispatchDrone(w, home, 0, 0, 1, 0, 20, 0);
    // 80 tiles / 0.5 t/s = 160s (rebalanced step #19)
    const r = tickDrones(w, 161_000);
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
    // 80 tiles / 0.5 t/s = 160s (rebalanced step #19)
    tickDrones(w, 161_000);
    expect(pop.populated).toBe(true);
    expect(pop.discovered).toBe(true);
  });

  it('east-of-origin geometric check: reveals (40, 5), not (40, 12)', () => {
    const a = makeIslandSpec({ id: 'a', cx: 40, cy: 5 });
    const b = makeIslandSpec({ id: 'b', cx: 40, cy: 12 });
    const w = world([a, b]);
    const home = makeIslandState();
    home.inventory.biofuel = 50;
    // Outbound 50 tiles east, so segment (0,0)-(50,0) — `a` at perpendicular
    // distance 5 (inside scan radius 8); `b` at distance 12 (outside).
    dispatchDrone(w, home, 0, 0, 1, 0, 25, 0);
    // 25 fuel × 4 = 100 tiles round-trip / 0.5 t/s = 200s flight. (rebalanced step #19)
    const r = tickDrones(w, 200_500);
    expect(r.newlyDiscoveredIslandIds).toEqual(['a']);
  });
});

// ---------------------------------------------------------------------------
// Constant sanity (these are tuned values; if they change the demo islands
// in DEMO_ISLANDS need to be re-checked for reachability).
// ---------------------------------------------------------------------------

describe('drone constants', () => {
  it('matches the documented step-6 tuning', () => {
    expect(DRONE_TIER_EFFICIENCY).toBe(4);
    expect(DRONE_SPEED_TILES_PER_SEC).toBe(0.5); // rebalanced for idle-game scale, step #19 (was 2)
    expect(DRONE_SCAN_RADIUS_TILES).toBe(8);
  });
});

// ---------------------------------------------------------------------------
// §11.7 tier-matched fuel grades
// ---------------------------------------------------------------------------

describe('dispatchDrone — §11.7 tier-matched fuel', () => {
  function freshWorld(): WorldState {
    return { islands: [], drones: [], routes: [], vehicles: [] };
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
});
