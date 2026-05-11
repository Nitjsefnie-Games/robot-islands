// Inter-island routes — pure-logic TDD coverage of dispatch, arrival,
// in-flight buffer, source contention, and funneling credit.

import { describe, expect, it, beforeEach } from 'vitest';

import {
  _resetDroneIdCounter,
} from './drones.js';
import {
  _resetRouteIdCounter,
  deliverArrivals,
  dispatchAttempt,
  FUNNELING_BONUS_PERCENT,
  FUNNELING_TIER_CAP,
  nextRouteId,
  tickRoutes,
  type Route,
} from './routes.js';
import { ALL_RESOURCES, XP_WEIGHT, type ResourceId } from './recipes.js';
import type { IslandState } from './economy.js';
import type { WorldState } from './world.js';
import type { IslandSpec } from './world.js';

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
    lastTick: 0,
    ...over,
  };
}
function makeWorld(routes: Route[] = []): WorldState {
  // We don't need IslandSpec data for routes logic; supply empty stubs as needed.
  const stub: IslandSpec[] = [];
  return { islands: stub, drones: [], routes, vehicles: [], revealedCells: new Set() };
}

function cargoRoute(
  from: string,
  to: string,
  filter: ResourceId | null,
  priorityList: ResourceId[] = [],
  capacityPerSec = 0.5,
  transitTimeSec = 10,
): Route {
  return {
    id: nextRouteId(),
    from,
    to,
    type: 'cargo',
    capacityPerSec,
    filter,
    priorityList,
    transitTimeSec,
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
