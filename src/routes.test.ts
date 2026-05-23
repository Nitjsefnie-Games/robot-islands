// Inter-island routes — pure-logic TDD coverage of dispatch, arrival,
// in-flight buffer, source contention, and funneling credit.

import { describe, expect, it, beforeEach } from 'vitest';

import {
  _resetDroneIdCounter,
} from './drones.js';
import {
  _resetRouteIdCounter,
  computeCableNetworkBalance,
  createRouteFromBuilding,
  deliverArrivals,
  dispatchAttempt,
  drainRoutesForBuilding,
  eligibleTransportBuildings,
  FUNNELING_BONUS_PERCENT,
  FUNNELING_TIER_CAP,
  islandHasTeleporterPad,
  isPowerLink,
  MASS_DRIVER_CAPACITY_UNITS_PER_SEC,
  MASS_DRIVER_DIESEL_PER_UNIT,
  nextRouteId,
  routeProfileForBuilding,
  reorderPriorityList,
  tickRoutes,
  type Route,
} from './routes.js';
import { ALL_RESOURCES, XP_WEIGHT, type ResourceId } from './recipes.js';
import type { CargoMode } from './route-cargo.js';

import type { IslandState } from './economy.js';
import { CELL_SIZE_TILES, type WorldState } from './world.js';
import type { IslandSpec } from './world.js';
import { weather, routeCapacityMultiplierForWeather, type WeatherState } from './weather.js';

function blankInventory(): Record<ResourceId, number> {
  const inv = {} as Record<ResourceId, number>;
  for (const r of ALL_RESOURCES) inv[r] = 0;
  return inv;
}
function blankCaps(value: number): Record<ResourceId, number> {
  const caps = {} as Record<ResourceId, number>;
  for (const r of ALL_RESOURCES) caps[r] = value;
  return caps;
}
function blankFunnel(): Record<ResourceId, number> {
  const f = {} as Record<ResourceId, number>;
  for (const r of ALL_RESOURCES) f[r] = 0;
  return f;
}
function makeState(id: string, over: Partial<IslandState> = {}): IslandState {
  return {
    id,
    buildings: [],
    inventory: blankInventory(),
    storageCaps: blankCaps(100),
    xp: 0,
    level: 1,
    unspentSkillPoints: 0,
    unlockedNodes: new Set(),
    subPathProgress: new Map(),
    funnelPending: blankFunnel(),
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
function makeWorld(routes: Route[] = [], islands: IslandSpec[] = []): WorldState {
  return { islands, drones: [], routes, vehicles: [], revealedCells: new Set(), satellites: [], repairDrones: [],
    debrisFields: [], endgameState: { achieved: new Set(), firstAchievedMs: null }, latticeActive: false, latticeNodeIslands: [],
    commPackets: [], seed: 'test-seed', oceanCells: new Map(), depthRevealedCells: new Set() };
}

function makeIslandSpec(id: string, cx: number, cy: number): IslandSpec {
  return {
    id,
    name: id,
    biome: 'plains',
    cx,
    cy,
    majorRadius: 10,
    minorRadius: 10,
    populated: true,
    discovered: true,
    buildings: [],
    modifiers: [],
  };
}

function makeTwoIslandWorld(): { world: WorldState; states: Map<string, IslandState> } {
  const src = makeState('island-a');
  const dst = makeState('island-b');
  const world = makeWorld();
  const states = new Map([
    ['island-a', src],
    ['island-b', dst],
  ]);
  return { world, states };
}

function findCellWithWeather(
  seed: string,
  nowMs: number,
  targetState: WeatherState,
): { cx: number; cy: number } | null {
  for (let cx = -20; cx <= 20; cx++) {
    for (let cy = -20; cy <= 20; cy++) {
      if (weather(seed, cx, cy, nowMs).state === targetState) {
        return { cx, cy };
      }
    }
  }
  return null;
}

function cargoRoute(
  from: string,
  to: string,
  filter: ResourceId | null,
  cargoList: ResourceId[] = [],
  capacityPerSec = 0.5,
  transitTimeSec = 10,
  mode: CargoMode = 'priority',
): Route {
  const cargo = filter !== null
    ? [{ resourceId: filter }]
    : cargoList.map((resourceId) => ({ resourceId }));
  return {
    id: nextRouteId(), from, to, type: 'cargo', capacityPerSec,
    mode, cargo, transitTimeSec, inFlight: [],
  };
}

function cableRoute(
  from: string,
  to: string,
  capacityPerSec = 100,
): Route {
  return {
    id: nextRouteId(),
    from,
    to,
    type: 'cable',
    capacityPerSec,
    mode: 'priority',
    cargo: [],
    transitTimeSec: 0,
    inFlight: [],
  };
}

beforeEach(() => {
  _resetRouteIdCounter();
  _resetDroneIdCounter();
});

describe('dispatchAttempt — filter route happy path', () => {
  it('deducts source inventory immediately and pushes an in-flight batch', () => {
    const src = makeState('a', { inventory: { ...blankInventory(), iron_ore: 10 } });
    const dst = makeState('b');
    const r = cargoRoute('a', 'b', 'iron_ore');
    const world = makeWorld([r]);
    const states = new Map([['a', src], ['b', dst]]);
    const out = dispatchAttempt(world, states, 1000, 2); // 2 seconds elapsed
    // capacity 0.5/s × 2s = 1.0 unit desired, source has 10, dest has 100
    // headroom → dispatch 1.0.
    expect(out.length).toBe(1);
    expect(out[0]?.amount).toBeCloseTo(1.0, 9);
    expect(src.inventory.iron_ore).toBeCloseTo(9.0, 9);
    expect(r.inFlight.length).toBe(1);
    expect(r.inFlight[0]?.resourceId).toBe('iron_ore');
    expect(r.inFlight[0]?.arrivalTime).toBe(1000 + 10_000);
    expect(r.inFlight[0]?.dispatchTime).toBe(1000);
  });
});

describe('dispatchAttempt — clamping', () => {
  it('dispatches only what the source has when source < desired', () => {
    const src = makeState('a', { inventory: { ...blankInventory(), iron_ore: 0.3 } });
    const dst = makeState('b');
    const r = cargoRoute('a', 'b', 'iron_ore');
    const world = makeWorld([r]);
    const states = new Map([['a', src], ['b', dst]]);
    const out = dispatchAttempt(world, states, 0, 2);
    // Desired 1.0 but source has only 0.3.
    expect(out[0]?.amount).toBeCloseTo(0.3, 9);
    expect(src.inventory.iron_ore).toBeCloseTo(0, 9);
  });

  it('dispatches zero when destination cap is full and no inbound headroom', () => {
    const src = makeState('a', { inventory: { ...blankInventory(), iron_ore: 10 } });
    const dst = makeState('b', { inventory: { ...blankInventory(), iron_ore: 100 } });
    const r = cargoRoute('a', 'b', 'iron_ore');
    const world = makeWorld([r]);
    const states = new Map([['a', src], ['b', dst]]);
    const out = dispatchAttempt(world, states, 0, 2);
    expect(out.length).toBe(0);
    expect(src.inventory.iron_ore).toBe(10);
    expect(r.inFlight.length).toBe(0);
  });

  it('subtracts pre-existing in-flight from headroom when clamping', () => {
    const src = makeState('a', { inventory: { ...blankInventory(), iron_ore: 10 } });
    // Dest has 90 in inventory; cap 100 → raw headroom 10. But 8 are in-flight
    // already. Effective headroom: 100 - 90 - 8 = 2.
    const dst = makeState('b', { inventory: { ...blankInventory(), iron_ore: 90 } });
    const r = cargoRoute('a', 'b', 'iron_ore');
    r.inFlight.push({
      resourceId: 'iron_ore',
      amount: 8,
      arrivalTime: 99_999_999,
      dispatchTime: 0,
    });
    const world = makeWorld([r]);
    const states = new Map([['a', src], ['b', dst]]);
    // Capacity 0.5 × 20s = 10 desired, clamped to 2 by headroom.
    const out = dispatchAttempt(world, states, 0, 20);
    expect(out[0]?.amount).toBeCloseTo(2, 9);
    expect(src.inventory.iron_ore).toBeCloseTo(8, 9);
  });
});

describe('dispatchAttempt — any filter walks priority list', () => {
  it('picks the first resource with source > 0 AND dest headroom', () => {
    // Priority: [bolt, iron_ore, coal]. Source has no bolt but has iron_ore.
    // Should dispatch iron_ore (skip bolt because source empty), not coal.
    const src = makeState('a', {
      inventory: { ...blankInventory(), iron_ore: 10, coal: 10 },
    });
    const dst = makeState('b');
    const r = cargoRoute('a', 'b', null, ['bolt', 'iron_ore', 'coal']);
    const world = makeWorld([r]);
    const states = new Map([['a', src], ['b', dst]]);
    const out = dispatchAttempt(world, states, 0, 2);
    expect(out.length).toBe(1);
    expect(out[0]?.resourceId).toBe('iron_ore');
  });

  it('skips a priority entry when destination headroom is zero', () => {
    // Priority: [iron_ore, coal]. Dest iron_ore is at cap; should fall through to coal.
    const src = makeState('a', {
      inventory: { ...blankInventory(), iron_ore: 10, coal: 10 },
    });
    const dst = makeState('b', {
      inventory: { ...blankInventory(), iron_ore: 100 },
    });
    const r = cargoRoute('a', 'b', null, ['iron_ore', 'coal']);
    const world = makeWorld([r]);
    const states = new Map([['a', src], ['b', dst]]);
    const out = dispatchAttempt(world, states, 0, 2);
    expect(out.length).toBe(1);
    expect(out[0]?.resourceId).toBe('coal');
  });
});

describe('dispatchAttempt — multi-route source contention', () => {
  it('distributes proportionally to capacity when total desired > source available', () => {
    // Two routes share source 'a', resource iron_ore. Source has only 1 unit.
    // Route 1 capacity 0.5/s → desired 1.0 over 2s.
    // Route 2 capacity 1.5/s → desired 3.0 over 2s.
    // Total desired = 4.0, source has 1.0 → scale 1/4 = 0.25.
    // Allocations: route1 gets 0.25, route2 gets 0.75.
    const src = makeState('a', { inventory: { ...blankInventory(), iron_ore: 1 } });
    const dst1 = makeState('b');
    const dst2 = makeState('c');
    const r1 = cargoRoute('a', 'b', 'iron_ore', [], 0.5);
    const r2 = cargoRoute('a', 'c', 'iron_ore', [], 1.5);
    const world = makeWorld([r1, r2]);
    const states = new Map([['a', src], ['b', dst1], ['c', dst2]]);
    const out = dispatchAttempt(world, states, 0, 2);
    expect(out.length).toBe(2);
    const r1Out = out.find((d) => d.routeId === r1.id);
    const r2Out = out.find((d) => d.routeId === r2.id);
    expect(r1Out?.amount).toBeCloseTo(0.25, 9);
    expect(r2Out?.amount).toBeCloseTo(0.75, 9);
    expect(src.inventory.iron_ore).toBeCloseTo(0, 9);
  });

  it('does not scale when source has enough for all routes', () => {
    const src = makeState('a', { inventory: { ...blankInventory(), iron_ore: 100 } });
    const dst1 = makeState('b');
    const dst2 = makeState('c');
    const r1 = cargoRoute('a', 'b', 'iron_ore', [], 0.5);
    const r2 = cargoRoute('a', 'c', 'iron_ore', [], 1.5);
    const world = makeWorld([r1, r2]);
    const states = new Map([['a', src], ['b', dst1], ['c', dst2]]);
    const out = dispatchAttempt(world, states, 0, 2);
    // Each route gets its full ask.
    const r1Out = out.find((d) => d.routeId === r1.id);
    const r2Out = out.find((d) => d.routeId === r2.id);
    expect(r1Out?.amount).toBeCloseTo(1.0, 9);
    expect(r2Out?.amount).toBeCloseTo(3.0, 9);
  });
});

describe('deliverArrivals', () => {
  it('moves an arrived batch into destination inventory and removes it from inFlight', () => {
    const src = makeState('a');
    const dst = makeState('b');
    const r = cargoRoute('a', 'b', 'iron_ore');
    r.inFlight.push({
      resourceId: 'iron_ore',
      amount: 3,
      arrivalTime: 5000,
      dispatchTime: 0,
    });
    const world = makeWorld([r]);
    const states = new Map([['a', src], ['b', dst]]);
    const arrivals = deliverArrivals(world, states, 6000); // arrival was at 5000
    expect(arrivals.length).toBe(1);
    expect(arrivals[0]?.amount).toBeCloseTo(3, 9);
    expect(dst.inventory.iron_ore).toBeCloseTo(3, 9);
    expect(r.inFlight.length).toBe(0);
  });

  it('clamps to current cap; excess is lost (per §4.6)', () => {
    const src = makeState('a');
    const dst = makeState('b', { inventory: { ...blankInventory(), iron_ore: 98 } });
    const r = cargoRoute('a', 'b', 'iron_ore');
    r.inFlight.push({
      resourceId: 'iron_ore',
      amount: 10,
      arrivalTime: 1000,
      dispatchTime: 0,
    });
    const world = makeWorld([r]);
    const states = new Map([['a', src], ['b', dst]]);
    const arrivals = deliverArrivals(world, states, 2000);
    // Cap = 100, current 98, headroom 2. The other 8 are lost.
    expect(arrivals.length).toBe(1);
    expect(arrivals[0]?.amount).toBeCloseTo(2, 9);
    expect(dst.inventory.iron_ore).toBeCloseTo(100, 9);
    expect(r.inFlight.length).toBe(0);
  });

  it('credits funnel-pending when destination is below tier cap', () => {
    const src = makeState('a');
    const dst = makeState('b', { level: 1 });
    expect(dst.level).toBeLessThan(FUNNELING_TIER_CAP);
    const r = cargoRoute('a', 'b', 'iron_ore');
    r.inFlight.push({
      resourceId: 'iron_ore',
      amount: 4,
      arrivalTime: 0,
      dispatchTime: 0,
    });
    const world = makeWorld([r]);
    const states = new Map([['a', src], ['b', dst]]);
    deliverArrivals(world, states, 100);
    // bonus credit = 4 × xp_weight[iron_ore] × FUNNELING_BONUS_PERCENT
    //             = 4 × 1 × 0.5 = 2
    expect(dst.funnelPending.iron_ore).toBeCloseTo(2, 9);
  });

  it('does NOT credit funnel-pending when destination is at/above tier cap', () => {
    const src = makeState('a');
    const dst = makeState('b', { level: FUNNELING_TIER_CAP });
    const r = cargoRoute('a', 'b', 'iron_ore');
    r.inFlight.push({
      resourceId: 'iron_ore',
      amount: 4,
      arrivalTime: 0,
      dispatchTime: 0,
    });
    const world = makeWorld([r]);
    const states = new Map([['a', src], ['b', dst]]);
    deliverArrivals(world, states, 100);
    expect(dst.funnelPending.iron_ore).toBeCloseTo(0, 9);
  });

  it('keeps batches that have not yet arrived', () => {
    const src = makeState('a');
    const dst = makeState('b');
    const r = cargoRoute('a', 'b', 'iron_ore');
    r.inFlight.push({
      resourceId: 'iron_ore',
      amount: 1,
      arrivalTime: 1000,
      dispatchTime: 0,
    });
    r.inFlight.push({
      resourceId: 'iron_ore',
      amount: 2,
      arrivalTime: 5000,
      dispatchTime: 0,
    });
    const world = makeWorld([r]);
    const states = new Map([['a', src], ['b', dst]]);
    deliverArrivals(world, states, 2000);
    // Only the first arrived.
    expect(dst.inventory.iron_ore).toBeCloseTo(1, 9);
    expect(r.inFlight.length).toBe(1);
    expect(r.inFlight[0]?.amount).toBeCloseTo(2, 9);
  });
});

describe('tickRoutes — integration: dispatch + arrival across multiple ticks', () => {
  it('full cycle: dispatch t=0, batch arrives later, delivered to destination', () => {
    const src = makeState('a', { inventory: { ...blankInventory(), iron_ore: 100 } });
    const dst = makeState('b');
    const r = cargoRoute('a', 'b', 'iron_ore', [], 0.5, 10);
    const world = makeWorld([r]);
    const states = new Map([['a', src], ['b', dst]]);

    // Tick 1: dispatch over 2s at t=0. Capacity 1.0 unit shipped.
    tickRoutes(world, states, 0, 2);
    expect(src.inventory.iron_ore).toBeCloseTo(99, 9);
    expect(r.inFlight.length).toBe(1);
    expect(dst.inventory.iron_ore).toBe(0);

    // Tick 2: advance to t=5000 (still in transit, arrival at 10000).
    tickRoutes(world, states, 5000, 5);
    expect(dst.inventory.iron_ore).toBe(0);
    expect(r.inFlight.length).toBeGreaterThanOrEqual(1);

    // Tick 3: advance to t=10500 (past arrival).
    tickRoutes(world, states, 10_500, 5.5);
    // First batch delivered.
    expect(dst.inventory.iron_ore).toBeGreaterThan(0);
  });

  it('credits funnel-pending using the literal §10 formula on delivery', () => {
    const src = makeState('a', { inventory: { ...blankInventory(), iron_ore: 10 } });
    const dst = makeState('b', { level: 1 });
    const r = cargoRoute('a', 'b', 'iron_ore', [], 1.0, 0.001); // near-instant
    const world = makeWorld([r]);
    const states = new Map([['a', src], ['b', dst]]);
    tickRoutes(world, states, 0, 2); // dispatch 2.0 (capacity 1.0 × 2s)
    tickRoutes(world, states, 100, 0); // arrive (transit 0.001s)
    // bonus = delivered × xp_weight[iron_ore] × FUNNELING_BONUS_PERCENT
    //       = 2 × 1 × 0.5 = 1
    expect(dst.funnelPending.iron_ore).toBeCloseTo(
      2 * XP_WEIGHT.iron_ore * FUNNELING_BONUS_PERCENT,
      9,
    );
  });
});

describe('tickRoutes — instant transit (T4 teleporter equivalent)', () => {
  it('deposits directly at destination when transitTimeSec === 0', () => {
    const src = makeState('a', { inventory: { ...blankInventory(), iron_ore: 10 } });
    const dst = makeState('b');
    const r = cargoRoute('a', 'b', 'iron_ore', [], 0.5, 0);
    const world = makeWorld([r]);
    const states = new Map([['a', src], ['b', dst]]);
    tickRoutes(world, states, 0, 2);
    // 1.0 unit moved; no in-flight batch created.
    expect(src.inventory.iron_ore).toBeCloseTo(9, 9);
    expect(dst.inventory.iron_ore).toBeCloseTo(1, 9);
    expect(r.inFlight.length).toBe(0);
  });
});


describe('§9.4 logistics hub route capacity doubling', () => {
  it('doubles capacity for routes from a logistics_hub island', () => {
    const { world, states } = makeTwoIslandWorld();
    const fromState = states.get('island-a')!;
    fromState.specializationRole = 'logistics_hub';
    world.routes.push(cargoRoute('island-a', 'island-b', 'stone', [], 1, 10));
    fromState.inventory.stone = 100;
    const result = dispatchAttempt(world, states, 0, 1);
    expect(result.length).toBe(1);
    expect(result[0]!.amount).toBe(2); // 1 * 2 (doubled)
  });

  it('keeps base capacity for non-logistics-hub origin', () => {
    const { world, states } = makeTwoIslandWorld();
    const fromState = states.get('island-a')!;
    fromState.specializationRole = null; // generalist
    world.routes.push(cargoRoute('island-a', 'island-b', 'stone', [], 1, 10));
    fromState.inventory.stone = 100;
    const result = dispatchAttempt(world, states, 0, 1);
    expect(result.length).toBe(1);
    expect(result[0]!.amount).toBe(1); // base capacity
  });
});


describe('routeCapacityMultiplierForWeather', () => {
  it('returns 1 when route crosses only clear weather', () => {
    const cell = findCellWithWeather('test-seed', 0, 'clear');
    expect(cell).not.toBeNull();
    if (!cell) return;
    const mul = routeCapacityMultiplierForWeather(
      'test-seed',
      cell.cx * CELL_SIZE_TILES,
      cell.cy * CELL_SIZE_TILES,
      cell.cx * CELL_SIZE_TILES + 5,
      cell.cy * CELL_SIZE_TILES,
      0,
      CELL_SIZE_TILES,
    );
    expect(mul).toBe(1);
  });

  it('returns 0.5 when route crosses a storm cell', () => {
    const cell = findCellWithWeather('test-seed', 0, 'storm');
    expect(cell).not.toBeNull();
    if (!cell) return;
    const mul = routeCapacityMultiplierForWeather(
      'test-seed',
      cell.cx * CELL_SIZE_TILES,
      cell.cy * CELL_SIZE_TILES,
      cell.cx * CELL_SIZE_TILES + 5,
      cell.cy * CELL_SIZE_TILES,
      0,
      CELL_SIZE_TILES,
    );
    expect(mul).toBe(0.5);
  });

  it('returns 0.1 when route crosses a severe_storm cell', () => {
    const cell = findCellWithWeather('test-seed', 0, 'severe_storm');
    expect(cell).not.toBeNull();
    if (!cell) return;
    const mul = routeCapacityMultiplierForWeather(
      'test-seed',
      cell.cx * CELL_SIZE_TILES,
      cell.cy * CELL_SIZE_TILES,
      cell.cx * CELL_SIZE_TILES + 5,
      cell.cy * CELL_SIZE_TILES,
      0,
      CELL_SIZE_TILES,
    );
    expect(mul).toBe(0.1);
  });

  it('returns 0 when route crosses a catastrophic cell', () => {
    const cell = findCellWithWeather('test-seed', 0, 'catastrophic');
    expect(cell).not.toBeNull();
    if (!cell) return;
    const mul = routeCapacityMultiplierForWeather(
      'test-seed',
      cell.cx * CELL_SIZE_TILES,
      cell.cy * CELL_SIZE_TILES,
      cell.cx * CELL_SIZE_TILES + 5,
      cell.cy * CELL_SIZE_TILES,
      0,
      CELL_SIZE_TILES,
    );
    expect(mul).toBe(0);
  });
});

describe('§2.6 dispatch weather capacity reduction', () => {
  it('reduces dispatch amount when route crosses a storm cell', () => {
    const cell = findCellWithWeather('test-seed', 0, 'storm');
    expect(cell).not.toBeNull();
    if (!cell) return;

    const src = makeState('a', { inventory: { ...blankInventory(), iron_ore: 100 } });
    const dst = makeState('b');
    const world = makeWorld([], [
      makeIslandSpec('a', cell.cx * CELL_SIZE_TILES, cell.cy * CELL_SIZE_TILES),
      makeIslandSpec('b', cell.cx * CELL_SIZE_TILES + 5, cell.cy * CELL_SIZE_TILES),
    ]);
    const states = new Map([['a', src], ['b', dst]]);
    const r = cargoRoute('a', 'b', 'iron_ore', [], 10, 1);
    world.routes.push(r);

    const dispatches = dispatchAttempt(world, states, 0, 1);
    expect(dispatches.length).toBe(1);
    expect(dispatches[0]!.amount).toBeCloseTo(5, 9); // 10 * 0.5
  });

  it('reduces dispatch amount when route crosses a severe_storm cell', () => {
    const cell = findCellWithWeather('test-seed', 0, 'severe_storm');
    expect(cell).not.toBeNull();
    if (!cell) return;

    const src = makeState('a', { inventory: { ...blankInventory(), iron_ore: 100 } });
    const dst = makeState('b');
    const world = makeWorld([], [
      makeIslandSpec('a', cell.cx * CELL_SIZE_TILES, cell.cy * CELL_SIZE_TILES),
      makeIslandSpec('b', cell.cx * CELL_SIZE_TILES + 5, cell.cy * CELL_SIZE_TILES),
    ]);
    const states = new Map([['a', src], ['b', dst]]);
    const r = cargoRoute('a', 'b', 'iron_ore', [], 10, 1);
    world.routes.push(r);

    const dispatches = dispatchAttempt(world, states, 0, 1);
    expect(dispatches.length).toBe(1);
    expect(dispatches[0]!.amount).toBeCloseTo(1, 9); // 10 * 0.1
  });

  it('dispatches nothing when route crosses a catastrophic cell', () => {
    const cell = findCellWithWeather('test-seed', 0, 'catastrophic');
    expect(cell).not.toBeNull();
    if (!cell) return;

    const src = makeState('a', { inventory: { ...blankInventory(), iron_ore: 100 } });
    const dst = makeState('b');
    const world = makeWorld([], [
      makeIslandSpec('a', cell.cx * CELL_SIZE_TILES, cell.cy * CELL_SIZE_TILES),
      makeIslandSpec('b', cell.cx * CELL_SIZE_TILES + 5, cell.cy * CELL_SIZE_TILES),
    ]);
    const states = new Map([['a', src], ['b', dst]]);
    const r = cargoRoute('a', 'b', 'iron_ore', [], 10, 1);
    world.routes.push(r);

    const dispatches = dispatchAttempt(world, states, 0, 1);
    expect(dispatches.length).toBe(0);
  });
});

describe('reorderPriorityList', () => {
  it('returns a new array with the element moved from src to dst', () => {
    const list: ResourceId[] = ['iron_ore', 'coal', 'stone', 'bolt'];
    const result = reorderPriorityList(list, 0, 2);
    expect(result).toEqual(['coal', 'stone', 'iron_ore', 'bolt']);
    // Original unchanged
    expect(list).toEqual(['iron_ore', 'coal', 'stone', 'bolt']);
  });

  it('returns a shallow copy when src === dst', () => {
    const list: ResourceId[] = ['iron_ore', 'coal', 'stone'];
    const result = reorderPriorityList(list, 1, 1);
    expect(result).toEqual(['iron_ore', 'coal', 'stone']);
    expect(result).not.toBe(list);
  });

  it('handles moving the last element to the first position', () => {
    const list: ResourceId[] = ['iron_ore', 'coal', 'stone'];
    const result = reorderPriorityList(list, 2, 0);
    expect(result).toEqual(['stone', 'iron_ore', 'coal']);
  });

  it('handles moving the first element to the last position', () => {
    const list: ResourceId[] = ['iron_ore', 'coal', 'stone'];
    const result = reorderPriorityList(list, 0, 2);
    expect(result).toEqual(['coal', 'stone', 'iron_ore']);
  });

  it('returns a copy unchanged when src is out of bounds', () => {
    const list: ResourceId[] = ['iron_ore', 'coal'];
    const result = reorderPriorityList(list, 5, 0);
    expect(result).toEqual(['iron_ore', 'coal']);
  });
});

describe('computeCableNetworkBalance (§5.3 binary-gated unified pool)', () => {
  // Building fixtures: solar produces 50W per panel at full sun (default
  // lastTick=0 lands in mid-Day, multiplier 1.0). A coal_gen alternative
  // would need coal in inventory because its recipe consumes coal/cycle —
  // bare solar has no recipe, so `resolveRecipe` returns undefined and
  // Pass 3 treats it as always-active per the `if (!recipe) active = true`
  // branch. Mine consumes 25W (no recipe inputs, always active).
  const solar = (idSuffix: string, x = 0, y = 0): { id: string; defId: 'solar'; x: number; y: number } => ({
    id: `sl-${idSuffix}`,
    defId: 'solar',
    x,
    y,
  });
  const solars = (
    idSuffix: string,
    count: number,
  ): Array<{ id: string; defId: 'solar'; x: number; y: number }> =>
    Array.from({ length: count }, (_, i) => solar(`${idSuffix}-${i}`, i * 2, 0));
  const mine = (idSuffix: string, x = 0, y = 0): { id: string; defId: 'mine'; x: number; y: number } => ({
    id: `mn-${idSuffix}`,
    defId: 'mine',
    x,
    y,
  });

  const spacetimeRoute = (
    from: string,
    to: string,
    capacityPerSec = 0, // capacity is unused for spacetime — gate always passes
  ): Route => ({
    id: nextRouteId(),
    from,
    to,
    type: 'spacetime',
    capacityPerSec,
    mode: 'priority',
    cargo: [],
    transitTimeSec: 0,
    inFlight: [],
  });

  it('isolated island (no power-link routes) → trivial unified=false component', () => {
    const a = makeState('a', { buildings: [mine('a')] });
    const world = makeWorld();
    const states = new Map<string, IslandState>([['a', a]]);
    const balances = computeCableNetworkBalance(world, states);
    const bal = balances.get('a')!;
    expect(bal).toBeDefined();
    expect(bal.unified).toBe(false);
    expect(bal.consumedTotal).toBe(25);
    expect(bal.producedTotal).toBe(0);
    expect(bal.cableCapacityTotal).toBe(0);
    expect(bal.requiredTransmission).toBe(0);
  });

  it('two islands, cable capacity 50W vs required 80W → gate FAILS', () => {
    // A: 2 solars (100W produced), no consumers → surplus 100W.
    // B: 2 mines (50W consumed), no producers → deficit 50W.
    // required = min(100, 50) = 50. Capacity 40W < 50 → gate fails.
    const a = makeState('a', { buildings: solars('a', 2) });
    const b = makeState('b', { buildings: [mine('b1', 0, 0), mine('b2', 4, 0)] });
    const world = makeWorld([cableRoute('a', 'b', 40)]);
    const states = new Map<string, IslandState>([['a', a], ['b', b]]);
    const balances = computeCableNetworkBalance(world, states);
    const balA = balances.get('a')!;
    const balB = balances.get('b')!;
    // Same referent — both islands map to the same component balance.
    expect(balA).toBe(balB);
    expect(balA.producedTotal).toBe(100);
    expect(balA.consumedTotal).toBe(50);
    expect(balA.requiredTransmission).toBe(50);
    expect(balA.cableCapacityTotal).toBe(40);
    expect(balA.unified).toBe(false);
  });

  it('two islands, cable capacity 100W vs required 80W → gate PASSES, unified', () => {
    const a = makeState('a', { buildings: solars('a', 2) });
    const b = makeState('b', { buildings: [mine('b1', 0, 0), mine('b2', 4, 0)] });
    const world = makeWorld([cableRoute('a', 'b', 100)]);
    const states = new Map<string, IslandState>([['a', a], ['b', b]]);
    const balances = computeCableNetworkBalance(world, states);
    const bal = balances.get('a')!;
    expect(bal.producedTotal).toBe(100);
    expect(bal.consumedTotal).toBe(50);
    expect(bal.requiredTransmission).toBe(50);
    expect(bal.cableCapacityTotal).toBe(100);
    expect(bal.unified).toBe(true);
    // Brownout factor: 100/80 = 1.25 → clamped to 1.0 (oversupplied).
    const factor = bal.consumedTotal === 0 ? 1 : Math.min(1, bal.producedTotal / bal.consumedTotal);
    expect(factor).toBe(1);
  });

  it('A→B→C chain: per-island surplus/deficit drives requiredTransmission', () => {
    // Per §5.3 the gate uses Σ max(0, prod_i − cons_i) (per-island surplus)
    // and Σ max(0, cons_i − prod_i) (per-island deficit), NOT the component
    // net. Setup:
    //   A = 2 solars + 1 mine (100 produced, 25 consumed → local surplus 75).
    //   B = 2 solars + 2 mines (100, 50 → local surplus 50).
    //   C = 5 mines           (0, 125 → local deficit 125).
    // totalSurplus = 75 + 50 = 125. totalDeficit = 125. required = min = 125.
    // Capacity: A-B cable 80 + B-C cable 30 = 110 < 125 → gate fails.
    const a = makeState('a', { buildings: [...solars('a', 2), mine('a-x', 0, 4)] });
    const b = makeState('b', { buildings: [...solars('b', 2), mine('b1', 0, 4), mine('b2', 4, 4)] });
    const c = makeState('c', {
      buildings: [
        mine('c1', 0, 0),
        mine('c2', 4, 0),
        mine('c3', 0, 4),
        mine('c4', 4, 4),
        mine('c5', 8, 0),
      ],
    });
    const world = makeWorld([cableRoute('a', 'b', 80), cableRoute('b', 'c', 30)]);
    const states = new Map<string, IslandState>([['a', a], ['b', b], ['c', c]]);
    const balances = computeCableNetworkBalance(world, states);
    const bal = balances.get('a')!;
    expect(balances.get('b')).toBe(bal);
    expect(balances.get('c')).toBe(bal);
    expect(bal.producedTotal).toBe(200);
    expect(bal.consumedTotal).toBe(200);
    expect(bal.requiredTransmission).toBe(125);
    expect(bal.cableCapacityTotal).toBe(110);
    expect(bal.unified).toBe(false);
  });

  it('A→B→C chain with capacity below required → gate FAILS', () => {
    // Same per-island setup as above (surplus 125, deficit 125, required 125),
    // but cable capacity A-B=20 + B-C=10 = 30 < 80 → gate fails, cables inert.
    const a = makeState('a', { buildings: [...solars('a', 2), mine('a-x', 0, 4)] });
    const b = makeState('b', { buildings: [...solars('b', 2), mine('b1', 0, 4), mine('b2', 4, 4)] });
    const c = makeState('c', {
      buildings: [
        mine('c1', 0, 0),
        mine('c2', 4, 0),
        mine('c3', 0, 4),
        mine('c4', 4, 4),
        mine('c5', 8, 0),
      ],
    });
    const world = makeWorld([cableRoute('a', 'b', 20), cableRoute('b', 'c', 10)]);
    const states = new Map<string, IslandState>([['a', a], ['b', b], ['c', c]]);
    const balances = computeCableNetworkBalance(world, states);
    const bal = balances.get('a')!;
    expect(bal.requiredTransmission).toBe(125);
    expect(bal.cableCapacityTotal).toBe(30);
    expect(bal.unified).toBe(false);
  });

  it('disjoint components: {A,B} cable, {C} alone — separate components', () => {
    // {A, B} connected by A-B cable; C has no cable.
    const a = makeState('a', { buildings: [...solars('a', 2), mine('a-x', 0, 4)] });
    const b = makeState('b', { buildings: [...solars('b', 2), mine('b1', 0, 4), mine('b2', 4, 4)] });
    const c = makeState('c', {
      buildings: [
        mine('c1', 0, 0),
        mine('c2', 4, 0),
        mine('c3', 0, 4),
      ],
    });
    const world = makeWorld([cableRoute('a', 'b', 80)]);
    const states = new Map<string, IslandState>([['a', a], ['b', b], ['c', c]]);
    const balances = computeCableNetworkBalance(world, states);
    const balAB = balances.get('a')!;
    expect(balances.get('b')).toBe(balAB);
    // {A, B}: prod=200, cons=75, surplus=125, deficit=0, required=0,
    // gate trivially passes (vacuous — a cable exists but nothing needs to
    // traverse it).
    expect(balAB.producedTotal).toBe(200);
    expect(balAB.consumedTotal).toBe(75);
    expect(balAB.requiredTransmission).toBe(0);
    expect(balAB.unified).toBe(true);
    // {C}: isolated, trivial component, unified=false. prod=0, cons=75.
    const balC = balances.get('c')!;
    expect(balC).not.toBe(balAB);
    expect(balC.unified).toBe(false);
    expect(balC.producedTotal).toBe(0);
    expect(balC.consumedTotal).toBe(75);
    expect(balC.cableCapacityTotal).toBe(0);
  });

  it('Spacetime Anchor link makes gate trivially pass regardless of capacity', () => {
    // Same surplus/deficit setup as the "gate fails" test (req=50 > cap=5)
    // but with a spacetime link in addition — gate must pass.
    const a = makeState('a', { buildings: solars('a', 2) });
    const b = makeState('b', { buildings: [mine('b1', 0, 0), mine('b2', 4, 0)] });
    const world = makeWorld([
      cableRoute('a', 'b', 5), // intentionally undersized
      spacetimeRoute('a', 'b'),
    ]);
    const states = new Map<string, IslandState>([['a', a], ['b', b]]);
    const balances = computeCableNetworkBalance(world, states);
    const bal = balances.get('a')!;
    expect(bal.producedTotal).toBe(100);
    expect(bal.consumedTotal).toBe(50);
    expect(bal.requiredTransmission).toBe(50);
    expect(bal.cableCapacityTotal).toBe(Infinity);
    expect(bal.unified).toBe(true);
  });

  it('Spacetime Anchor as the SOLE link still passes gate (no cables present)', () => {
    // Edge case: a spacetime-only component with no cables. Capacity should
    // still be Infinity, gate passes, islands unify.
    const a = makeState('a', { buildings: solars('a', 2) });
    const b = makeState('b', { buildings: [mine('b1', 0, 0), mine('b2', 4, 0)] });
    const world = makeWorld([spacetimeRoute('a', 'b')]);
    const states = new Map<string, IslandState>([['a', a], ['b', b]]);
    const balances = computeCableNetworkBalance(world, states);
    const bal = balances.get('a')!;
    expect(balances.get('b')).toBe(bal);
    expect(bal.cableCapacityTotal).toBe(Infinity);
    expect(bal.unified).toBe(true);
  });

  it('ignores non-power-link routes (cargo) when building components', () => {
    // A cargo route from A→B doesn't merge them into a power component:
    // each island remains in its own trivial component.
    const a = makeState('a', { buildings: solars('a', 2) });
    const b = makeState('b', { buildings: [mine('b1', 0, 0), mine('b2', 4, 0)] });
    const world = makeWorld([cargoRoute('a', 'b', 'iron_ore', [], 1)]);
    const states = new Map<string, IslandState>([['a', a], ['b', b]]);
    const balances = computeCableNetworkBalance(world, states);
    // Two separate trivial components.
    expect(balances.get('a')).not.toBe(balances.get('b'));
    expect(balances.get('a')!.cableCapacityTotal).toBe(0);
    expect(balances.get('b')!.cableCapacityTotal).toBe(0);
  });
});

describe('§5.3 cable routes do not dispatch cargo', () => {
  it('skips cable routes in dispatch even with non-empty cargo list and capacity', () => {
    const src = makeState('a', {
      inventory: { ...blankInventory(), iron_ore: 10 },
    });
    const dst = makeState('b');
    const r: Route = {
      id: nextRouteId(),
      from: 'a',
      to: 'b',
      type: 'cable',
      capacityPerSec: 1,
      mode: 'priority',
      cargo: [{ resourceId: 'iron_ore' }],
      transitTimeSec: 1,
      inFlight: [],
    };
    const world = makeWorld([r]);
    const states = new Map<string, IslandState>([['a', src], ['b', dst]]);
    const out = dispatchAttempt(world, states, 0, 2);
    expect(out.length).toBe(0);
    expect(src.inventory.iron_ore).toBe(10);
    expect(r.inFlight.length).toBe(0);
  });
});

describe('§2.6 in-flight weather losses', () => {
  it('delivers full amount when route crosses only clear cells', () => {
    const cell = findCellWithWeather('test-seed', 0, 'clear');
    expect(cell).not.toBeNull();
    if (!cell) return;

    const fromX = cell.cx * CELL_SIZE_TILES;
    const fromY = cell.cy * CELL_SIZE_TILES + 2;
    const toX = cell.cx * CELL_SIZE_TILES;
    const toY = cell.cy * CELL_SIZE_TILES + 14;

    const src = makeState('a', { inventory: { ...blankInventory(), iron_ore: 100 } });
    const dst = makeState('b');
    const world = makeWorld([], [
      makeIslandSpec('a', fromX, fromY),
      makeIslandSpec('b', toX, toY),
    ]);
    const states = new Map([['a', src], ['b', dst]]);
    const r = cargoRoute('a', 'b', 'iron_ore', [], 10, 1);
    world.routes.push(r);

    tickRoutes(world, states, 0, 1);
    const result = tickRoutes(world, states, 2000, 0);
    expect(result.arrivals.length).toBe(1);
    expect(result.arrivals[0]!.amount).toBeCloseTo(10, 9);
  });

  it('reduces delivered amount when batch crosses a storm cell', () => {
    // Deterministic storm cell for seed 'test-seed' at t=0: (-20, -18).
    // Verified by brute-force search; weather('test-seed', -20, -18, 0) === 'storm'.
    const cell = { cx: -20, cy: -18 };

    // Place a 12-tile vertical route entirely inside that cell.
    const fromX = cell.cx * CELL_SIZE_TILES;
    const fromY = cell.cy * CELL_SIZE_TILES + 2;
    const toX = cell.cx * CELL_SIZE_TILES;
    const toY = cell.cy * CELL_SIZE_TILES + 14;

    const src = makeState('a', { inventory: { ...blankInventory(), iron_ore: 100 } });
    const dst = makeState('b');
    const world = makeWorld([], [
      makeIslandSpec('a', fromX, fromY),
      makeIslandSpec('b', toX, toY),
    ]);
    const states = new Map([['a', src], ['b', dst]]);
    const r = cargoRoute('a', 'b', 'iron_ore', [], 10, 1);
    world.routes.push(r);

    tickRoutes(world, states, 0, 1);
    const batch = r.inFlight[0];
    expect(batch).toBeDefined();

    const result = tickRoutes(world, states, 2000, 0);
    expect(result.arrivals.length).toBe(1);
    const delivered = result.arrivals[0]!.amount;
    expect(delivered).toBeLessThan(10);
    expect(delivered).toBeGreaterThan(0);

    // Golden value derived once from the exact loss math for this
    // seed / cell / route geometry / batch-id (route-1_0_0).  Capacity
    // is reduced to 5 units by the storm multiplier (0.5); the single
    // crossed cell then applies a 5% loss sampled with rng = 0.6697…
    // → 5 * (1 - 0.05 * 0.6697049676440656) = 4.832573758088984.
    expect(delivered).toBeCloseTo(4.832573758088984, 9);
  });
});

// ---------------------------------------------------------------------------
// §9.5 / §15.1 — Mass Driver route type
// ---------------------------------------------------------------------------

function massDriverRoute(
  from: string,
  to: string,
  filter: ResourceId | null,
  cargoList: ResourceId[] = [],
  capacityPerSec = MASS_DRIVER_CAPACITY_UNITS_PER_SEC,
  transitTimeSec = 10,
): Route {
  const cargo = filter !== null
    ? [{ resourceId: filter }]
    : cargoList.map((resourceId) => ({ resourceId }));
  return {
    id: nextRouteId(),
    from,
    to,
    type: 'mass_driver',
    capacityPerSec,
    mode: 'priority',
    cargo,
    transitTimeSec,
    inFlight: [],
  };
}

describe('§9.5 / §15.1 mass_driver route type', () => {
  it('is constructable with type === "mass_driver"', () => {
    const r = massDriverRoute('a', 'b', 'iron_ore');
    expect(r.type).toBe('mass_driver');
  });

  it('default capacity is 5× airship per §9.5 "~5× airship capacity"', () => {
    // Airship base is 2.0 u/s (AIRSHIP_CARGO_CAPACITY_UNITS_PER_SEC);
    // Mass Driver is 5× that = 10.0 u/s per §9.5.
    expect(MASS_DRIVER_CAPACITY_UNITS_PER_SEC).toBeCloseTo(10.0, 9);
  });

  it('dispatches like cargo on the standard happy path', () => {
    const src = makeState('a', {
      inventory: { ...blankInventory(), iron_ore: 100, diesel: 100 },
    });
    const dst = makeState('b');
    const r = massDriverRoute('a', 'b', 'iron_ore');
    const world = makeWorld([r]);
    const states = new Map([['a', src], ['b', dst]]);
    const out = dispatchAttempt(world, states, 0, 1);
    expect(out.length).toBe(1);
    expect(out[0]?.resourceId).toBe('iron_ore');
    // capacity 10.0/s × 1s = 10.0 desired, dest headroom 100 ⇒ 10.0 dispatched.
    expect(out[0]?.amount).toBeCloseTo(MASS_DRIVER_CAPACITY_UNITS_PER_SEC, 9);
    expect(src.inventory.iron_ore).toBeCloseTo(100 - MASS_DRIVER_CAPACITY_UNITS_PER_SEC, 9);
    // In-flight batch created (positive transit time).
    expect(r.inFlight.length).toBe(1);
  });

  it('consumes Diesel proportional to dispatch volume', () => {
    const src = makeState('a', {
      inventory: { ...blankInventory(), iron_ore: 100, diesel: 100 },
    });
    const dst = makeState('b');
    const r = massDriverRoute('a', 'b', 'iron_ore');
    const world = makeWorld([r]);
    const states = new Map([['a', src], ['b', dst]]);
    const out = dispatchAttempt(world, states, 0, 1);
    const dispatched = out[0]?.amount ?? 0;
    const expectedDiesel = 100 - dispatched * MASS_DRIVER_DIESEL_PER_UNIT;
    expect(src.inventory.diesel).toBeCloseTo(expectedDiesel, 9);
  });

  it('skips dispatch and refunds cargo when source has no Diesel', () => {
    const src = makeState('a', {
      inventory: { ...blankInventory(), iron_ore: 100, diesel: 0 },
    });
    const dst = makeState('b');
    const r = massDriverRoute('a', 'b', 'iron_ore');
    const world = makeWorld([r]);
    const states = new Map([['a', src], ['b', dst]]);
    const out = dispatchAttempt(world, states, 0, 1);
    // Route stays valid but nothing ships; cargo NOT deducted.
    expect(out.length).toBe(0);
    expect(src.inventory.iron_ore).toBe(100);
    expect(r.inFlight.length).toBe(0);
  });

  it('skips dispatch when source has insufficient Diesel for full ask', () => {
    // 0.001 diesel can fuel only a sliver of the 10.0-unit dispatch. Per the
    // teleporter-pattern handler, if the required fuel exceeds what's on
    // hand, the dispatch is skipped wholesale (no partial volumes shipped
    // off a budget-too-small fuel pile).
    const src = makeState('a', {
      inventory: { ...blankInventory(), iron_ore: 100, diesel: 0.001 },
    });
    const dst = makeState('b');
    const r = massDriverRoute('a', 'b', 'iron_ore');
    const world = makeWorld([r]);
    const states = new Map([['a', src], ['b', dst]]);
    const out = dispatchAttempt(world, states, 0, 1);
    expect(out.length).toBe(0);
    expect(src.inventory.iron_ore).toBe(100);
    expect(src.inventory.diesel).toBeCloseTo(0.001, 9);
  });

  it('shipping diesel itself — cargo + fuel come from the same pool', () => {
    // Pins the interaction between the cargo deduction at routes.ts:662 and
    // the fuel check at routes.ts:672. When the route ships diesel, the
    // cargo is deducted from the diesel pool BEFORE the fuel check looks at
    // remaining diesel. Two boundary cases lock the behavior so a future
    // refactor (e.g. reordering the fuel debit) cannot silently flip it.
    //
    // Capacity 10.0 u/s × 1s = 10.0 units cargo; fuel = 10.0 × 0.05 = 0.5.

    // Case A: source has exactly `amount` diesel (10.0).
    // After cargo deduct → 0; fuel check fails (0 < 0.5); cargo refunded.
    // Outcome: dispatch SKIPPED, source diesel restored to 10.0.
    {
      const src = makeState('a', {
        inventory: { ...blankInventory(), diesel: 10.0 },
      });
      const dst = makeState('b');
      const r = massDriverRoute('a', 'b', 'diesel');
      const world = makeWorld([r]);
      const states = new Map([['a', src], ['b', dst]]);
      const out = dispatchAttempt(world, states, 0, 1);
      expect(out.length).toBe(0);
      expect(src.inventory.diesel).toBeCloseTo(10.0, 9);
      expect(dst.inventory.diesel).toBe(0);
      expect(r.inFlight.length).toBe(0);
    }

    // Case B: source has exactly `amount + fuelCost` diesel (10.5).
    // After cargo deduct → 0.5; fuel check passes (0.5 ≥ 0.5);
    // fuel debited → 0. Outcome: dispatch SUCCEEDS, source diesel drained
    // to 0, in-flight batch carries the 10.0-unit cargo.
    {
      const src = makeState('a', {
        inventory: { ...blankInventory(), diesel: 10.5 },
      });
      const dst = makeState('b');
      const r = massDriverRoute('a', 'b', 'diesel');
      const world = makeWorld([r]);
      const states = new Map([['a', src], ['b', dst]]);
      const out = dispatchAttempt(world, states, 0, 1);
      expect(out.length).toBe(1);
      expect(out[0]?.resourceId).toBe('diesel');
      expect(out[0]?.amount).toBeCloseTo(10.0, 9);
      expect(src.inventory.diesel).toBeCloseTo(0, 9);
      expect(r.inFlight.length).toBe(1);
      expect(r.inFlight[0]?.amount).toBeCloseTo(10.0, 9);
    }
  });

  it('still creates in-flight batches (transit > 0)', () => {
    const src = makeState('a', {
      inventory: { ...blankInventory(), iron_ore: 100, diesel: 100 },
    });
    const dst = makeState('b');
    const r = massDriverRoute('a', 'b', 'iron_ore', [], MASS_DRIVER_CAPACITY_UNITS_PER_SEC, 5);
    const world = makeWorld([r]);
    const states = new Map([['a', src], ['b', dst]]);
    tickRoutes(world, states, 0, 1);
    expect(r.inFlight.length).toBe(1);
    expect(r.inFlight[0]?.arrivalTime).toBe(5000);
    // Advance past arrival.
    const result = tickRoutes(world, states, 6000, 0);
    expect(result.arrivals.length).toBe(1);
    expect(dst.inventory.iron_ore).toBeGreaterThan(0);
  });

  it('mass_driver routes are NOT power links (cable analysis ignores them)', () => {
    // Cable balance treats mass_driver as a non-power link — same as cargo.
    // The component graph for cable analysis must NOT pick it up.
    const a = makeState('a');
    const b = makeState('b');
    const r = massDriverRoute('a', 'b', 'iron_ore');
    const world = makeWorld([r]);
    const states = new Map([['a', a], ['b', b]]);
    const balances = computeCableNetworkBalance(world, states);
    // Both islands should be in their OWN trivial components — mass_driver
    // is not a power link, so no shared cable component.
    expect(balances.get('a')?.cableCapacityTotal).toBe(0);
    expect(balances.get('b')?.cableCapacityTotal).toBe(0);
    expect(balances.get('a')?.unified).toBe(false);
    expect(balances.get('b')?.unified).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// §4 submarine_cable RouteType — inter-island power transmission variant
// that visually routes across ocean. Behaves identically to land `cable`
// for §5.3 unified-pool purposes (`isPowerLink` returns true; does NOT
// dispatch cargo). The two route types differ only in visual rendering
// (Task 11 future work) and player intent (long-range coast-to-coast).
// ---------------------------------------------------------------------------

function submarineCableRoute(
  from: string,
  to: string,
  capacityPerSec = 100,
): Route {
  return {
    id: nextRouteId(),
    from,
    to,
    type: 'submarine_cable',
    capacityPerSec,
    mode: 'priority',
    cargo: [],
    transitTimeSec: 0,
    inFlight: [],
  };
}

describe('§4 submarine_cable RouteType', () => {
  // Reuse the same building fixtures the §5.3 cable suite uses — copying
  // here keeps this block self-contained while the tests assert equivalent
  // power-link semantics for the new RouteType.
  const solar = (idSuffix: string, x = 0, y = 0): { id: string; defId: 'solar'; x: number; y: number } => ({
    id: `sl-${idSuffix}`,
    defId: 'solar',
    x,
    y,
  });
  const solars = (
    idSuffix: string,
    count: number,
  ): Array<{ id: string; defId: 'solar'; x: number; y: number }> =>
    Array.from({ length: count }, (_, i) => solar(`${idSuffix}-${i}`, i * 2, 0));
  const mine = (idSuffix: string, x = 0, y = 0): { id: string; defId: 'mine'; x: number; y: number } => ({
    id: `mn-${idSuffix}`,
    defId: 'mine',
    x,
    y,
  });

  it("'submarine_cable' is a valid RouteType (type-system + runtime)", () => {
    // Type-level: this object must compile under the discriminated union.
    // Runtime: the literal round-trips intact, and the Route is well-formed
    // (id, capacity, transit time match the spec contract).
    const r: Route = submarineCableRoute('island-a', 'island-b', 50);
    expect(r.type).toBe('submarine_cable');
    expect(r.from).toBe('island-a');
    expect(r.to).toBe('island-b');
    expect(r.capacityPerSec).toBe(50);
    expect(r.transitTimeSec).toBe(0);
    expect(r.mode).toBe('priority');
    expect(r.cargo).toEqual([]);
    expect(r.inFlight).toEqual([]);
  });

  it('isPowerLink returns true for submarine_cable', () => {
    expect(isPowerLink('submarine_cable')).toBe(true);
    // Sanity-check the rest of the union to pin behaviour: only the three
    // power-link types should return true.
    expect(isPowerLink('cable')).toBe(true);
    expect(isPowerLink('spacetime')).toBe(true);
    expect(isPowerLink('cargo')).toBe(false);
    expect(isPowerLink('drone')).toBe(false);
    expect(isPowerLink('airship')).toBe(false);
    expect(isPowerLink('teleporter')).toBe(false);
    expect(isPowerLink('mass_driver')).toBe(false);
  });

  it('submarine_cable routes contribute to §5.3 unified pool — gate FAILS when undersized', () => {
    // Mirror of the land-cable "40W < 50W required → fails" test at routes.test.ts:705.
    // A: 2 solars (100W produced), no consumers → surplus 100W.
    // B: 2 mines (50W consumed), no producers → deficit 50W.
    // required = min(100, 50) = 50. Submarine cable capacity 40W < 50 → fails.
    const a = makeState('a', { buildings: solars('a', 2) });
    const b = makeState('b', { buildings: [mine('b1', 0, 0), mine('b2', 4, 0)] });
    const world = makeWorld([submarineCableRoute('a', 'b', 40)]);
    const states = new Map<string, IslandState>([['a', a], ['b', b]]);
    const balances = computeCableNetworkBalance(world, states);
    const balA = balances.get('a')!;
    const balB = balances.get('b')!;
    // Same referent — both islands map to the same component.
    expect(balA).toBe(balB);
    expect(balA.producedTotal).toBe(100);
    expect(balA.consumedTotal).toBe(50);
    expect(balA.requiredTransmission).toBe(50);
    expect(balA.cableCapacityTotal).toBe(40);
    expect(balA.unified).toBe(false);
  });

  it('submarine_cable routes contribute to §5.3 unified pool — gate PASSES when oversized', () => {
    // Mirror of the land-cable "100W > 80W required → passes" test at routes.test.ts:725.
    const a = makeState('a', { buildings: solars('a', 2) });
    const b = makeState('b', { buildings: [mine('b1', 0, 0), mine('b2', 4, 0)] });
    const world = makeWorld([submarineCableRoute('a', 'b', 100)]);
    const states = new Map<string, IslandState>([['a', a], ['b', b]]);
    const balances = computeCableNetworkBalance(world, states);
    const bal = balances.get('a')!;
    expect(bal.producedTotal).toBe(100);
    expect(bal.consumedTotal).toBe(50);
    expect(bal.requiredTransmission).toBe(50);
    expect(bal.cableCapacityTotal).toBe(100);
    expect(bal.unified).toBe(true);
  });

  it('submarine_cable capacity sums with land cable capacity in the same component', () => {
    // Mixed-type component: one land cable + one submarine cable both connect A↔B.
    // Their capacities add (mirrors the chain test at routes.test.ts:742) — proving
    // the new RouteType is just another bucket in the §5.3 capacity sum.
    const a = makeState('a', { buildings: solars('a', 2) });
    const b = makeState('b', { buildings: [mine('b1', 0, 0), mine('b2', 4, 0)] });
    const world = makeWorld([
      cableRoute('a', 'b', 30),
      submarineCableRoute('a', 'b', 60),
    ]);
    const states = new Map<string, IslandState>([['a', a], ['b', b]]);
    const balances = computeCableNetworkBalance(world, states);
    const bal = balances.get('a')!;
    expect(bal.requiredTransmission).toBe(50);
    expect(bal.cableCapacityTotal).toBe(90); // 30 + 60
    expect(bal.unified).toBe(true); // 90 ≥ 80
  });
});

describe('§4 submarine_cable does not dispatch cargo (mirrors §5.3 cable)', () => {
  it('skips submarine_cable routes in dispatch even with non-empty cargo list and capacity', () => {
    // Mirrors the §5.3 cable dispatch-skip test at routes.test.ts:878.
    // submarine_cable is a power-transmission route variant — it must
    // never move resources, regardless of how its cargo list is filled.
    const src = makeState('a', {
      inventory: { ...blankInventory(), iron_ore: 10 },
    });
    const dst = makeState('b');
    const r: Route = {
      id: nextRouteId(),
      from: 'a',
      to: 'b',
      type: 'submarine_cable',
      capacityPerSec: 1,
      mode: 'priority',
      cargo: [{ resourceId: 'iron_ore' }],
      transitTimeSec: 1,
      inFlight: [],
    };
    const world = makeWorld([r]);
    const states = new Map<string, IslandState>([['a', src], ['b', dst]]);
    const out = dispatchAttempt(world, states, 0, 2);
    expect(out.length).toBe(0);
    expect(src.inventory.iron_ore).toBe(10);
    expect(r.inFlight.length).toBe(0);
  });

  it('deliverArrivals skips submarine_cable routes (regression sentinel)', () => {
    // Regression sentinel — the dispatch path can't actually produce an
    // in-flight batch on a power-link route (dispatch skips them). This
    // test hand-seeds one to prove the delivery-side `continue` exists,
    // so if a future code path ever produces such a batch (data import,
    // save migration, hotfix gone wrong), this invariant prevents silent
    // delivery of cargo across a power-transmission route.
    const src = makeState('a');
    const dst = makeState('b');
    const r: Route = {
      id: nextRouteId(),
      from: 'a',
      to: 'b',
      type: 'submarine_cable',
      capacityPerSec: 1,
      mode: 'priority',
      cargo: [],
      transitTimeSec: 0,
      inFlight: [
        { resourceId: 'iron_ore', amount: 5, arrivalTime: 0, dispatchTime: 0 },
      ],
    };
    const world = makeWorld([r]);
    const states = new Map<string, IslandState>([['a', src], ['b', dst]]);
    const arrivals = deliverArrivals(world, states, 1000);
    expect(arrivals.length).toBe(0);
    expect(dst.inventory.iron_ore).toBe(0);
    // The route's inFlight is intentionally left alone — power-link routes
    // never have a deliveries pipeline that touches inFlight.
    expect(r.inFlight.length).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// §5.3 spacetime routes do not dispatch cargo — regression coverage for the
// `isPowerLink` refactor of dispatchPhase + deliverArrivals. Pre-refactor,
// both sites checked literal `'cable' || 'submarine_cable'` and silently
// excluded spacetime, even though `isPowerLink('spacetime') === true` and
// `computeCableNetworkBalance` already treats it as a power-link route.
// These tests lock in that the refactor closed that gap.
// ---------------------------------------------------------------------------

describe('§5.3 spacetime routes do not dispatch cargo (post-isPowerLink refactor)', () => {
  it('skips spacetime routes in dispatch even with non-empty cargo list and capacity', () => {
    // Mirrors the §5.3 cable dispatch-skip test. Pre-refactor, the literal
    // `'cable' || 'submarine_cable'` check would NOT skip spacetime, so
    // dispatch would have moved iron_ore from src to dst. With isPowerLink,
    // spacetime is correctly recognized as a power-link route.
    const src = makeState('a', {
      inventory: { ...blankInventory(), iron_ore: 10 },
    });
    const dst = makeState('b');
    const r: Route = {
      id: nextRouteId(),
      from: 'a',
      to: 'b',
      type: 'spacetime',
      capacityPerSec: 1,
      mode: 'priority',
      cargo: [{ resourceId: 'iron_ore' }],
      transitTimeSec: 1,
      inFlight: [],
    };
    const world = makeWorld([r]);
    const states = new Map<string, IslandState>([['a', src], ['b', dst]]);
    const out = dispatchAttempt(world, states, 0, 2);
    expect(out.length).toBe(0);
    expect(src.inventory.iron_ore).toBe(10);
    expect(r.inFlight.length).toBe(0);
  });

  it('deliverArrivals skips spacetime routes (regression sentinel — same as cable/submarine_cable)', () => {
    // Defensive sibling to the submarine_cable deliverArrivals test. A
    // spacetime route's inFlight can't actually be populated via dispatch
    // (dispatch skips power-link routes), but if a future code path ever
    // seeds one, the delivery side must also skip — same invariant.
    const src = makeState('a');
    const dst = makeState('b');
    const r: Route = {
      id: nextRouteId(),
      from: 'a',
      to: 'b',
      type: 'spacetime',
      capacityPerSec: 1,
      mode: 'priority',
      cargo: [],
      transitTimeSec: 0,
      inFlight: [
        { resourceId: 'iron_ore', amount: 5, arrivalTime: 0, dispatchTime: 0 },
      ],
    };
    const world = makeWorld([r]);
    const states = new Map<string, IslandState>([['a', src], ['b', dst]]);
    const arrivals = deliverArrivals(world, states, 1000);
    expect(arrivals.length).toBe(0);
    expect(dst.inventory.iron_ore).toBe(0);
    expect(r.inFlight.length).toBe(1);
  });
});

describe('route draining — soft delete (finish in-flight, stop dispatch)', () => {
  it('a draining route dispatches nothing', () => {
    const src = makeState('a', { inventory: { ...blankInventory(), iron_ore: 100 } });
    const dst = makeState('b');
    const r = cargoRoute('a', 'b', 'iron_ore', [], 0.5, 10);
    r.draining = true;
    const world = makeWorld([r]);
    const states = new Map<string, IslandState>([['a', src], ['b', dst]]);
    const out = dispatchAttempt(world, states, 0, 2);
    expect(out.length).toBe(0);
    expect(src.inventory.iron_ore).toBe(100);
    expect(r.inFlight.length).toBe(0);
  });

  it('a draining route still delivers cargo already in flight', () => {
    const src = makeState('a', { inventory: { ...blankInventory(), iron_ore: 100 } });
    const dst = makeState('b');
    const r = cargoRoute('a', 'b', 'iron_ore', [], 0.5, 10);
    const world = makeWorld([r]);
    const states = new Map<string, IslandState>([['a', src], ['b', dst]]);
    tickRoutes(world, states, 0, 2); // dispatch a batch while live
    expect(r.inFlight.length).toBe(1);
    r.draining = true; // player deletes the route
    tickRoutes(world, states, 11_000, 5); // batch must still arrive
    expect(dst.inventory.iron_ore).toBeGreaterThan(0);
  });

  it('prunes a draining route once its last in-flight batch is delivered', () => {
    const src = makeState('a', { inventory: { ...blankInventory(), iron_ore: 100 } });
    const dst = makeState('b');
    const r = cargoRoute('a', 'b', 'iron_ore', [], 0.5, 10);
    const world = makeWorld([r]);
    const states = new Map<string, IslandState>([['a', src], ['b', dst]]);
    tickRoutes(world, states, 0, 2);
    r.draining = true;
    tickRoutes(world, states, 5000, 5); // still in transit — route survives
    expect(world.routes.length).toBe(1);
    tickRoutes(world, states, 11_000, 1); // delivered — route pruned
    expect(world.routes.length).toBe(0);
  });

  it('prunes a draining route with no in-flight cargo on the next tick', () => {
    const src = makeState('a', { inventory: { ...blankInventory(), iron_ore: 100 } });
    const dst = makeState('b');
    const r = cargoRoute('a', 'b', 'iron_ore', [], 0.5, 10);
    r.draining = true;
    const world = makeWorld([r]);
    const states = new Map<string, IslandState>([['a', src], ['b', dst]]);
    tickRoutes(world, states, 0, 2);
    expect(world.routes.length).toBe(0);
  });

  it('leaves non-draining routes untouched', () => {
    const src = makeState('a', { inventory: { ...blankInventory(), iron_ore: 100 } });
    const dst = makeState('b');
    const r = cargoRoute('a', 'b', 'iron_ore', [], 0.5, 10);
    const world = makeWorld([r]);
    const states = new Map<string, IslandState>([['a', src], ['b', dst]]);
    tickRoutes(world, states, 0, 2);
    tickRoutes(world, states, 11_000, 5);
    expect(world.routes.length).toBe(1);
  });
});


describe('routeProfileForBuilding', () => {
  it('maps each transport building to its tier profile', () => {
    expect(routeProfileForBuilding('dock')).toEqual(
      { type: 'cargo', capacityPerSec: 0.5, speedTilesPerSec: 1 });
    expect(routeProfileForBuilding('dronepad')).toEqual(
      { type: 'drone', capacityPerSec: 1.0, speedTilesPerSec: 2 });
    expect(routeProfileForBuilding('airship_dock')).toEqual(
      { type: 'airship', capacityPerSec: 2.0, speedTilesPerSec: 4 });
    expect(routeProfileForBuilding('mass_driver')).toEqual(
      { type: 'mass_driver', capacityPerSec: 10.0, speedTilesPerSec: 8 });
    expect(routeProfileForBuilding('teleporter_pad')).toEqual(
      { type: 'teleporter', capacityPerSec: 5.0, speedTilesPerSec: 0 });
  });
  it('returns null for a non-transport building', () => {
    expect(routeProfileForBuilding('logger')).toBeNull();
    expect(routeProfileForBuilding('workshop')).toBeNull();
  });
});

describe('createRouteFromBuilding', () => {
  it('builds an airship route from an Airship Dock', () => {
    const b = { id: 'ad-1', defId: 'airship_dock' as const, x: 0, y: 0 };
    const route = createRouteFromBuilding(b, 'a', 'b', 'iron_ore', 100);
    expect(route).not.toBeNull();
    expect(route!.type).toBe('airship');
    expect(route!.capacityPerSec).toBe(2.0);
    expect(route!.transitTimeSec).toBeCloseTo(25, 9); // 100 tiles / 4 t/s
    expect(route!.sourceBuildingId).toBe('ad-1');
    expect(route!.from).toBe('a');
    expect(route!.to).toBe('b');
    expect(route!.mode).toBe('priority');
    expect(route!.cargo).toEqual([{ resourceId: 'iron_ore' }]);
    expect(route!.inFlight).toEqual([]);
  });
  it('builds an instant teleporter route (transitTimeSec 0)', () => {
    const b = { id: 'tp-1', defId: 'teleporter_pad' as const, x: 0, y: 0 };
    const route = createRouteFromBuilding(b, 'a', 'b', null, 100);
    expect(route!.type).toBe('teleporter');
    expect(route!.transitTimeSec).toBe(0);
    expect(route!.mode).toBe('priority');
    expect(route!.cargo).toEqual([]);
  });
  it('returns null for a non-transport building', () => {
    const b = { id: 'lg-1', defId: 'logger' as const, x: 0, y: 0 };
    expect(createRouteFromBuilding(b, 'a', 'b', null, 100)).toBeNull();
  });
});

describe('eligibleTransportBuildings', () => {
  it('lists free transport buildings, excluding non-transport and taken', () => {
    const island = makeIslandSpec('a', 0, 0);
    island.buildings = [
      { id: 'd1', defId: 'dock', x: 0, y: 0 },
      { id: 'd2', defId: 'dock', x: 1, y: 0 },
      { id: 'lg', defId: 'logger', x: 2, y: 0 },
    ];
    const taken = cargoRoute('a', 'b', 'iron_ore');
    taken.sourceBuildingId = 'd1';
    const eligible = eligibleTransportBuildings(island, [taken]);
    expect(eligible.map((b) => b.id)).toEqual(['d2']);
  });
  it('returns all transport buildings when no routes exist', () => {
    const island = makeIslandSpec('a', 0, 0);
    island.buildings = [{ id: 'ad', defId: 'airship_dock', x: 0, y: 0 }];
    expect(eligibleTransportBuildings(island, []).map((b) => b.id)).toEqual(['ad']);
  });
});

describe('islandHasTeleporterPad', () => {
  it('is true only when a teleporter_pad is present', () => {
    const island = makeIslandSpec('a', 0, 0);
    expect(islandHasTeleporterPad(island)).toBe(false);
    island.buildings = [{ id: 't', defId: 'teleporter_pad', x: 0, y: 0 }];
    expect(islandHasTeleporterPad(island)).toBe(true);
  });
});

describe('drainRoutesForBuilding', () => {
  it('marks routes owned by the building as draining', () => {
    const r1 = cargoRoute('a', 'b', 'iron_ore'); r1.sourceBuildingId = 'b1';
    const r2 = cargoRoute('a', 'b', 'coal');     r2.sourceBuildingId = 'b2';
    const world = makeWorld([r1, r2]);
    const n = drainRoutesForBuilding(world, 'b1');
    expect(n).toBe(1);
    expect(r1.draining).toBe(true);
    expect(r2.draining).toBeUndefined();
  });
  it('returns 0 when no route is owned by the building', () => {
    const r1 = cargoRoute('a', 'b', 'iron_ore'); r1.sourceBuildingId = 'b1';
    const world = makeWorld([r1]);
    expect(drainRoutesForBuilding(world, 'nope')).toBe(0);
    expect(r1.draining).toBeUndefined();
  });

  it('drains a route when its source building is disabled', () => {
    const r1 = cargoRoute('a', 'b', 'iron_ore');
    r1.sourceBuildingId = 'b1';
    const world = makeWorld([r1]);
    // Simulate the false→true transition that main.ts performs:
    // building.disabled = true, then drainRoutesForBuilding.
    drainRoutesForBuilding(world, 'b1');
    expect(r1.draining).toBe(true);
  });
});


describe('dispatch — cargo modes', () => {
  it('split divides one tick across two resources by weight', () => {
    const src = makeState('a', { inventory: { ...blankInventory(), wood: 100, stone: 100 } });
    const dst = makeState('b');
    const r: Route = {
      id: nextRouteId(), from: 'a', to: 'b', type: 'cargo', capacityPerSec: 1.5,
      mode: 'split',
      cargo: [{ resourceId: 'wood', weight: 2 }, { resourceId: 'stone', weight: 1 }],
      transitTimeSec: 10, inFlight: [],
    };
    const world = makeWorld([r]);
    const states = new Map([['a', src], ['b', dst]]);
    const out = dispatchAttempt(world, states, 0, 2);
    const byRes = Object.fromEntries(out.map((d) => [d.resourceId, d.amount]));
    expect(byRes.wood).toBeCloseTo(2.0, 6);
    expect(byRes.stone).toBeCloseTo(1.0, 6);
  });

  it('source-floor gate skips an entry below the floor', () => {
    const src = makeState('a', { inventory: { ...blankInventory(), wood: 30, stone: 80 } });
    const dst = makeState('b');
    const r: Route = {
      id: nextRouteId(), from: 'a', to: 'b', type: 'cargo', capacityPerSec: 0.5,
      mode: 'priority',
      cargo: [{ resourceId: 'wood', sourceFloorPct: 50 }, { resourceId: 'stone' }],
      transitTimeSec: 10, inFlight: [],
    };
    const world = makeWorld([r]);
    const states = new Map([['a', src], ['b', dst]]);
    const out = dispatchAttempt(world, states, 0, 2);
    expect(out.length).toBe(1);
    expect(out[0]?.resourceId).toBe('stone');
  });
});


describe('dispatch — all wildcard', () => {
  it('split mode with wood weight 5 + all weight 1 floor 90% — 5:1:1:1:1:1 when 5 others are above floor', () => {
    // capacity 1.5 u/s × 2s = 3.0 budget. Source has wood + 5 other resources
    // each at >= 90% of cap (cap=100, set each to 95). Expected split:
    // wood 5/10 of 3.0 = 1.5; each of 5 others 1/10 = 0.3.
    const inv = { ...blankInventory(), wood: 95, stone: 95, coal: 95, iron_ore: 95, copper_ore: 95, sand: 95 };
    const src = makeState('a', { inventory: inv });
    const dst = makeState('b');
    const r: Route = {
      id: nextRouteId(), from: 'a', to: 'b', type: 'cargo', capacityPerSec: 1.5,
      mode: 'split',
      cargo: [
        { resourceId: 'wood', weight: 5 },
        { resourceId: 'all', weight: 1, sourceFloorPct: 90 },
      ],
      transitTimeSec: 10, inFlight: [],
    };
    const world = makeWorld([r]);
    const states = new Map([['a', src], ['b', dst]]);
    const out = dispatchAttempt(world, states, 0, 2);
    const byRes = Object.fromEntries(out.map((d) => [d.resourceId, d.amount]));
    expect(byRes.wood).toBeCloseTo(1.5, 6);
    expect(byRes.stone).toBeCloseTo(0.3, 6);
    expect(byRes.coal).toBeCloseTo(0.3, 6);
    expect(byRes.iron_ore).toBeCloseTo(0.3, 6);
    expect(byRes.copper_ore).toBeCloseTo(0.3, 6);
    expect(byRes.sand).toBeCloseTo(0.3, 6);
  });

  it('wildcard skips resources already named explicitly', () => {
    // wood is explicit AND would be matched by 'all'; it must not appear twice.
    const src = makeState('a', { inventory: { ...blankInventory(), wood: 100, stone: 100 } });
    const dst = makeState('b');
    const r: Route = {
      id: nextRouteId(), from: 'a', to: 'b', type: 'cargo', capacityPerSec: 1.0,
      mode: 'split',
      cargo: [
        { resourceId: 'wood', weight: 1 },
        { resourceId: 'all', weight: 1 },
      ],
      transitTimeSec: 10, inFlight: [],
    };
    const world = makeWorld([r]);
    const states = new Map([['a', src], ['b', dst]]);
    const out = dispatchAttempt(world, states, 0, 2);
    // wood appears exactly once in the demands (not duplicated by 'all').
    const woodCount = out.filter((d) => d.resourceId === 'wood').length;
    expect(woodCount).toBe(1);
  });
});
