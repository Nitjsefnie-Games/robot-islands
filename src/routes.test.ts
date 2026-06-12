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
import { solveBrownoutFactor } from './flow-power-fixpoint.js';
import { BUILDING_DEFS, type BuildingDef, type BuildingDefId } from './building-defs.js';
import { computeRates, type DefCatalog, type RatesContext } from './economy.js';

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
    unlockedEdges: new Set(),
    auraAmpVersion: 0,
    auraAmpCache: null,
    auraAmpCacheVersion: -1,
    co2Kg: 0,
    funnelPending: blankFunnel(),
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
    everProduced: new Set(),
    tradeCooldownMs: 0,
    tradeAcceptCount: 0,
    lastTick: 0,
    ...over,
  };
}
const NOON = new Date('2026-03-20T12:00:00Z').getTime();

function makeWorld(routes: Route[] = [], islands: IslandSpec[] = []): WorldState {
  return { islands, drones: [], routes, vehicles: [], revealedCells: new Set(), satellites: [], repairDrones: [],
    debrisFields: [], endgameState: { achieved: new Set(), firstAchievedMs: null }, latticeActive: false, latticeNodeIslands: [],
    commPackets: [], totalCo2Kg: 0, playerLat: 0, playerLon: 0, seed: 'test-seed', oceanCells: new Map(), depthRevealedCells: new Set(), recentBuildAttempts: new Set(), recentBuildAttemptTs: new Map() };
}

/** Thread `world` into every island's local-power ctx so solarMultiplier
 *  sees lat/lon = (0, 0). */
function balance(world: WorldState, states: Map<string, IslandState>) {
  return computeCableNetworkBalance(world, states, () => ({ world }));
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

  it('fix 7.2 — multi-entry waterfall attaches each unclamped desired to the RIGHT resource', () => {
    // Structural divergence between the clamped and unclamped planCargo runs:
    //   R1 (waterfall [wood, stone], capacity 10/s, 1s → budget 10), source wood=3, stone=4.
    //   Clamped run:   wood = min(10,hr,3) = 3, rem 7; stone = min(7,hr,4) = 4 → TWO entries.
    //   Unclamped run: wood = min(10,hr) = 10, rem 0 → break → ONE entry.
    // So the unclamped run is shorter than the clamped run.  Correct attribution:
    //   wood.unclampedDesired = 10 (from the unclamped run, keyed by resource)
    //   stone.unclampedDesired = 4 (fallback to clamped amount — absent from unclamped run)
    // We observe attribution through Phase-2 contention on WOOD:
    //   R2 (priority [wood], capacity 2/s → desired 2) contends with R1's wood desire.
    //   srcAvail wood = 3, total desired = 10 + 2 = 12 → scale 3/12:
    //     R1 wood = 10 × 3/12 = 2.5,  R2 wood = 2 × 3/12 = 0.5.
    //   Stone group: only R1, desired 4 ≤ srcAvail 4 → ships 4.
    // If wood/stone desireds were swapped (misattribution), the wood group would
    // be 3 + 2 = 5 → scale 3/5 → R1 wood = 1.8, R2 wood = 1.2 — different output.
    const src = makeState('a', { inventory: { ...blankInventory(), wood: 3, stone: 4 } });
    const dst1 = makeState('b');
    const dst2 = makeState('c');
    const r1 = cargoRoute('a', 'b', null, ['wood', 'stone'], 10, 10, 'waterfall');
    const r2 = cargoRoute('a', 'c', 'wood', [], 2);
    const world = makeWorld([r1, r2]);
    const states = new Map([['a', src], ['b', dst1], ['c', dst2]]);
    const out = dispatchAttempt(world, states, 0, 1);
    const r1Wood = out.find((d) => d.routeId === r1.id && d.resourceId === 'wood');
    const r1Stone = out.find((d) => d.routeId === r1.id && d.resourceId === 'stone');
    const r2Wood = out.find((d) => d.routeId === r2.id && d.resourceId === 'wood');
    expect(r1Wood?.amount).toBeCloseTo(2.5, 9);
    expect(r2Wood?.amount).toBeCloseTo(0.5, 9);
    expect(r1Stone?.amount).toBeCloseTo(4, 9);
  });

  it('fix 7.2 — waterfall routes split proportionally to capacity (§15.4)', () => {
    // Source has 5 iron_ore.  Route A capacity 1/s, route B capacity 10/s, both waterfall.
    // Before fix: desired clamped to sourceAvail=5, giving A=0.83, B=4.17.
    // After fix:  desired unclamped (1 and 10), Phase-2 scale=5/11 → A≈0.45, B≈4.55.
    const src = makeState('a', { inventory: { ...blankInventory(), iron_ore: 5 } });
    const dst1 = makeState('b');
    const dst2 = makeState('c');
    const r1 = cargoRoute('a', 'b', 'iron_ore', [], 1,  10, 'waterfall');
    const r2 = cargoRoute('a', 'c', 'iron_ore', [], 10, 10, 'waterfall');
    const world = makeWorld([r1, r2]);
    const states = new Map([['a', src], ['b', dst1], ['c', dst2]]);
    const out = dispatchAttempt(world, states, 0, 1); // 1 second elapsed
    expect(out.length).toBe(2);
    const r1Out = out.find((d) => d.routeId === r1.id);
    const r2Out = out.find((d) => d.routeId === r2.id);
    // Capacity-proportional split: A gets 1/11 × 5 ≈ 0.4545, B gets 10/11 × 5 ≈ 4.5454
    expect(r1Out?.amount).toBeCloseTo(5 / 11, 4);
    expect(r2Out?.amount).toBeCloseTo(50 / 11, 4);
    expect(src.inventory.iron_ore).toBeCloseTo(0, 9);
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

  it('fix 7.3 — two instant routes do not overflow into grace headroom beyond normal cap (§12.4)', () => {
    // Phase-1 headroom for both routes is cap(ignoreGrace)-inv-inFlight = 5-0-0 = 5.
    // Each route gets 5 approved by Phase-2 (different sources, no source contention).
    // Phase-3 sequential execution:
    //   Before fix: route-A deposits 5, inv=5.  Route-B instant branch: cap(WITH_grace)=100,
    //               room=100-5=95, deposits 5, inv=10.  OVERFLOW beyond storageCaps=5.
    //   After fix:  route-A deposits 5, inv=5.  Route-B instant branch: cap(ignoreGrace)=5,
    //               room=5-5=0, deposits 0, inv=5.  Correct.
    const srcA = makeState('a', { inventory: { ...blankInventory(), iron_ore: 10 } });
    const srcB = makeState('b', { inventory: { ...blankInventory(), iron_ore: 10 } });
    const dst = makeState('c', {
      storageCaps: { ...blankCaps(100), iron_ore: 5 },
      starterInventoryGrace: { ...blankInventory(), iron_ore: 100 } as Record<ResourceId, number>,
    });
    const r1 = cargoRoute('a', 'c', 'iron_ore', [], 10, 0); // instant from a
    const r2 = cargoRoute('b', 'c', 'iron_ore', [], 10, 0); // instant from b
    const world = makeWorld([r1, r2]);
    const states = new Map([['a', srcA], ['b', srcB], ['c', dst]]);
    dispatchAttempt(world, states, 0, 1);
    // Must not exceed storageCaps=5 regardless of grace=100.
    expect(dst.inventory.iron_ore).toBeLessThanOrEqual(5);
  });

  it('fix 7.3 — instant delivery delivers 0 when destination has only grace headroom (§12.4)', () => {
    // Destination storageCaps[iron_ore]=0, grace=10.
    // destinationHeadroom (Phase-1) already uses ignoreGrace:true → blocks dispatch.
    // This test is a regression guard confirming the combined behaviour.
    const src = makeState('a', { inventory: { ...blankInventory(), iron_ore: 10 } });
    const dst = makeState('b', {
      storageCaps: { ...blankCaps(100), iron_ore: 0 },
      starterInventoryGrace: { ...blankInventory(), iron_ore: 10 } as Record<ResourceId, number>,
    });
    const r = cargoRoute('a', 'b', 'iron_ore', [], 0.5, 0); // transitTimeSec=0
    const world = makeWorld([r]);
    const states = new Map([['a', src], ['b', dst]]);
    dispatchAttempt(world, states, 0, 2);
    expect(dst.inventory.iron_ore).toBe(0);
    expect(src.inventory.iron_ore).toBe(10);
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
    const balances = balance(world, states);
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
    const a = makeState('a', { buildings: solars('a', 2), lastTick: NOON });
    const b = makeState('b', { buildings: [mine('b1', 0, 0), mine('b2', 4, 0)] });
    const world = makeWorld([cableRoute('a', 'b', 40)]);
    const states = new Map<string, IslandState>([['a', a], ['b', b]]);
    const balances = balance(world, states);
    const balA = balances.get('a')!;
    const balB = balances.get('b')!;
    // Same referent — both islands map to the same component balance.
    expect(balA).toBe(balB);
    expect(balA.producedTotal).toBeCloseTo(100, 0);
    expect(balA.consumedTotal).toBe(50);
    expect(balA.requiredTransmission).toBeCloseTo(50, 0);
    expect(balA.cableCapacityTotal).toBe(40);
    expect(balA.unified).toBe(false);
  });

  it('two islands, cable capacity 100W vs required 80W → gate PASSES, unified', () => {
    const a = makeState('a', { buildings: solars('a', 2), lastTick: NOON });
    const b = makeState('b', { buildings: [mine('b1', 0, 0), mine('b2', 4, 0)] });
    const world = makeWorld([cableRoute('a', 'b', 100)]);
    const states = new Map<string, IslandState>([['a', a], ['b', b]]);
    const balances = balance(world, states);
    const bal = balances.get('a')!;
    expect(bal.producedTotal).toBeCloseTo(100, 0);
    expect(bal.consumedTotal).toBe(50);
    expect(bal.requiredTransmission).toBeCloseTo(50, 0);
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
    const a = makeState('a', { buildings: [...solars('a', 2), mine('a-x', 0, 4)], lastTick: NOON });
    const b = makeState('b', { buildings: [...solars('b', 2), mine('b1', 0, 4), mine('b2', 4, 4)], lastTick: NOON });
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
    const balances = balance(world, states);
    const bal = balances.get('a')!;
    expect(balances.get('b')).toBe(bal);
    expect(balances.get('c')).toBe(bal);
    expect(bal.producedTotal).toBeCloseTo(200, 0);
    expect(bal.consumedTotal).toBe(200);
    expect(bal.requiredTransmission).toBeCloseTo(125, 0);
    expect(bal.cableCapacityTotal).toBe(110);
    expect(bal.unified).toBe(false);
  });

  it('A→B→C chain with capacity below required → gate FAILS', () => {
    // Same per-island setup as above (surplus 125, deficit 125, required 125),
    // but cable capacity A-B=20 + B-C=10 = 30 < 80 → gate fails, cables inert.
    const a = makeState('a', { buildings: [...solars('a', 2), mine('a-x', 0, 4)], lastTick: NOON });
    const b = makeState('b', { buildings: [...solars('b', 2), mine('b1', 0, 4), mine('b2', 4, 4)], lastTick: NOON });
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
    const balances = balance(world, states);
    const bal = balances.get('a')!;
    expect(bal.requiredTransmission).toBeCloseTo(125, 0);
    expect(bal.cableCapacityTotal).toBe(30);
    expect(bal.unified).toBe(false);
  });

  it('disjoint components: {A,B} cable, {C} alone — separate components', () => {
    // {A, B} connected by A-B cable; C has no cable.
    const a = makeState('a', { buildings: [...solars('a', 2), mine('a-x', 0, 4)], lastTick: NOON });
    const b = makeState('b', { buildings: [...solars('b', 2), mine('b1', 0, 4), mine('b2', 4, 4)], lastTick: NOON });
    const c = makeState('c', {
      buildings: [
        mine('c1', 0, 0),
        mine('c2', 4, 0),
        mine('c3', 0, 4),
      ],
    });
    const world = makeWorld([cableRoute('a', 'b', 80)]);
    const states = new Map<string, IslandState>([['a', a], ['b', b], ['c', c]]);
    const balances = balance(world, states);
    const balAB = balances.get('a')!;
    expect(balances.get('b')).toBe(balAB);
    // {A, B}: prod=200, cons=75, surplus=125, deficit=0, required=0,
    // gate trivially passes (vacuous — a cable exists but nothing needs to
    // traverse it).
    expect(balAB.producedTotal).toBeCloseTo(200, 0);
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
    const a = makeState('a', { buildings: solars('a', 2), lastTick: NOON });
    const b = makeState('b', { buildings: [mine('b1', 0, 0), mine('b2', 4, 0)] });
    const world = makeWorld([
      cableRoute('a', 'b', 5), // intentionally undersized
      spacetimeRoute('a', 'b'),
    ]);
    const states = new Map<string, IslandState>([['a', a], ['b', b]]);
    const balances = balance(world, states);
    const bal = balances.get('a')!;
    expect(bal.producedTotal).toBeCloseTo(100, 0);
    expect(bal.consumedTotal).toBe(50);
    expect(bal.requiredTransmission).toBeCloseTo(50, 0);
    expect(bal.cableCapacityTotal).toBe(Infinity);
    expect(bal.unified).toBe(true);
  });

  it('Spacetime Anchor as the SOLE link still passes gate (no cables present)', () => {
    // Edge case: a spacetime-only component with no cables. Capacity should
    // still be Infinity, gate passes, islands unify.
    const a = makeState('a', { buildings: solars('a', 2), lastTick: NOON });
    const b = makeState('b', { buildings: [mine('b1', 0, 0), mine('b2', 4, 0)] });
    const world = makeWorld([spacetimeRoute('a', 'b')]);
    const states = new Map<string, IslandState>([['a', a], ['b', b]]);
    const balances = balance(world, states);
    const bal = balances.get('a')!;
    expect(balances.get('b')).toBe(bal);
    expect(bal.cableCapacityTotal).toBe(Infinity);
    expect(bal.unified).toBe(true);
  });

  it('ignores non-power-link routes (cargo) when building components', () => {
    // A cargo route from A→B doesn't merge them into a power component:
    // each island remains in its own trivial component.
    const a = makeState('a', { buildings: solars('a', 2), lastTick: NOON });
    const b = makeState('b', { buildings: [mine('b1', 0, 0), mine('b2', 4, 0)] });
    const world = makeWorld([cargoRoute('a', 'b', 'iron_ore', [], 1)]);
    const states = new Map<string, IslandState>([['a', a], ['b', b]]);
    const balances = balance(world, states);
    // Two separate trivial components.
    expect(balances.get('a')).not.toBe(balances.get('b'));
    expect(balances.get('a')!.cableCapacityTotal).toBe(0);
    expect(balances.get('b')!.cableCapacityTotal).toBe(0);
  });
});

describe('§5.3 unified cable component — shared brownout co-solved with member gates', () => {
  // The gate-passing decision stays on NOMINAL per-island surplus/deficit, but
  // a unified component IN DEFICIT now reports stored totals whose implied
  // factor min(1, producedTotal/consumedTotal) is the per-tick FIXPOINT over
  // the one shared scalar (member gates solved against it), not the nominal
  // ratio. This matters whenever a member's realized draw scales with pf — here
  // Q's power-drawing Mines feed a cap-pinned iron_ore bin that a non-power
  // Workshop drains, so as pf falls the Mines' iron output coefficient shrinks
  // and their gate (hence power draw) rises. The fixpoint pf therefore sits far
  // below the nominal ratio.
  const NOON_LOCAL = NOON;

  // Tiny generator (water_wheel with shrunk power.produces) sizes P's surplus
  // below Q's nominal deficit so the component is in genuine deficit (pf < 1).
  // Workshop stripped of its power draw so it's the pf-independent drain on the
  // cap-pinned bin (mirrors the §15.3 cap-pinned-output fixture in economy.ts).
  const defsFor = (genW: number): DefCatalog => {
    const base = { ...BUILDING_DEFS } as Record<BuildingDefId, BuildingDef>;
    const { power: _wp, ...workshopNoPower } = base.workshop;
    base.workshop = workshopNoPower as BuildingDef;
    base.water_wheel = { ...base.water_wheel, power: { produces: genW } } as BuildingDef;
    return base;
  };

  it('unified deficit component: stored totals reproduce the self-consistent fixpoint, equal for both members, < 1', () => {
    const defs = defsFor(0.3);
    // P: one tiny generator (0.3 W produced) → surplus 0.3 W (no consumers).
    const p = makeState('p', { buildings: [{ id: 'gen', defId: 'water_wheel', x: 0, y: 0 }], lastTick: NOON_LOCAL });
    // Q: 4 power-drawing Mines producing iron_ore into a cap-pinned bin
    // (iron_ore at cap=100) that 4 non-power Workshops drain. Nominal draw is
    // small (Mines throttled to the Workshop drain) but rises sharply as pf
    // falls. Coal stocked so Workshops aren't fuel-starved.
    const qMines = Array.from({ length: 4 }, (_, i) => ({ id: `qmn${i}`, defId: 'mine' as const, x: i * 2, y: 0 }));
    const qWorkshops = Array.from({ length: 4 }, (_, i) => ({ id: `qws${i}`, defId: 'workshop' as const, x: i * 2, y: 4 }));
    const q = makeState('q', {
      buildings: [...qMines, ...qWorkshops],
      inventory: { ...blankInventory(), iron_ore: 100, coal: 100000 },
      lastTick: NOON_LOCAL,
    });
    // Cable capacity well above the nominal required transmission so the §5.3
    // gate PASSES (unified). Nominal: P surplus 0.3, Q deficit ≈ 0.465 ⇒
    // required = min ≈ 0.3 ≪ 100.
    const world = makeWorld([cableRoute('p', 'q', 100)]);
    const states = new Map<string, IslandState>([['p', p], ['q', q]]);

    const ctxFor = (_id: string): RatesContext => ({ world, defs });
    const balances = computeCableNetworkBalance(world, states, ctxFor);
    const balP = balances.get('p')!;
    const balQ = balances.get('q')!;

    // Both members share one component balance and the gate passed.
    expect(balP).toBe(balQ);
    expect(balP.unified).toBe(true);

    // Implied shared brownout scalar from the stored totals.
    const impliedFactor = balP.consumedTotal === 0
      ? 1
      : Math.min(1, balP.producedTotal / balP.consumedTotal);
    // Real brownout (deficit component) — strictly below 1.
    expect(impliedFactor).toBeLessThan(1);
    expect(impliedFactor).toBeGreaterThan(0);

    // The stored factor must be the SELF-CONSISTENT fixpoint: re-deriving each
    // member's draw at that pf reproduces the stored ratio. Recompute the
    // component fixpoint independently from the same member states.
    const evalAtPf = (pf: number) => {
      let producedW = 0;
      let consumedW = 0;
      for (const st of [p, q]) {
        // At-pf realized draw (the same sample computeIslandLocalPower returns
        // from its fixedPf probe).
        const { power } = computeRates(st, { world, defs, fixedPowerFactor: pf });
        producedW += power.produced;
        consumedW += power.consumed;
      }
      return { producedW, consumedW };
    };
    const fixpointPf = solveBrownoutFactor(evalAtPf).powerFactor;
    // Stored implied factor equals the converged fixpoint pf, within the
    // solver's own convergence epsilon (BROWNOUT_FIXPOINT_EPSILON = 1e-6): the
    // stored ratio is `pfOf(evalComponent(pf*))`, which the damped iteration
    // brings to within ~epsilon of pf* itself. Self-consistency is at the
    // documented solver precision, not sub-epsilon.
    expect(impliedFactor).toBeCloseTo(fixpointPf, 5);

    // ADVANCE-TIME REPRODUCTION (the load-bearing invariant): the advance loop
    // reads fixedPf = min(1, producedTotal/consumedTotal) = impliedFactor and
    // re-solves the member gates at it. Re-evaluating the component at exactly
    // that stored pf must reproduce the stored ratio — i.e. impliedFactor is a
    // stable fixpoint of pf ↦ pfOf(evalComponent(pf)), so advance does not
    // drift away from the stored brownout.
    const reEval = evalAtPf(impliedFactor);
    const reImplied = Math.min(1, reEval.producedW / reEval.consumedW);
    expect(reImplied).toBeCloseTo(impliedFactor, 5);

    // And the fixpoint genuinely DIVERGES from the nominal ratio (proving the
    // co-solve is doing work — the old nominal-ratio store would be wrong).
    const nom = evalAtPf(1);
    const nominalRatio = Math.min(1, nom.producedW / nom.consumedW);
    expect(Math.abs(fixpointPf - nominalRatio)).toBeGreaterThan(0.1);
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
    const balances = balance(world, states);
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
    const a = makeState('a', { buildings: solars('a', 2), lastTick: NOON });
    const b = makeState('b', { buildings: [mine('b1', 0, 0), mine('b2', 4, 0)] });
    const world = makeWorld([submarineCableRoute('a', 'b', 40)]);
    const states = new Map<string, IslandState>([['a', a], ['b', b]]);
    const balances = balance(world, states);
    const balA = balances.get('a')!;
    const balB = balances.get('b')!;
    // Same referent — both islands map to the same component.
    expect(balA).toBe(balB);
    expect(balA.producedTotal).toBeCloseTo(100, 0);
    expect(balA.consumedTotal).toBe(50);
    expect(balA.requiredTransmission).toBeCloseTo(50, 0);
    expect(balA.cableCapacityTotal).toBe(40);
    expect(balA.unified).toBe(false);
  });

  it('submarine_cable routes contribute to §5.3 unified pool — gate PASSES when oversized', () => {
    // Mirror of the land-cable "100W > 80W required → passes" test at routes.test.ts:725.
    const a = makeState('a', { buildings: solars('a', 2), lastTick: NOON });
    const b = makeState('b', { buildings: [mine('b1', 0, 0), mine('b2', 4, 0)] });
    const world = makeWorld([submarineCableRoute('a', 'b', 100)]);
    const states = new Map<string, IslandState>([['a', a], ['b', b]]);
    const balances = balance(world, states);
    const bal = balances.get('a')!;
    expect(bal.producedTotal).toBeCloseTo(100, 0);
    expect(bal.consumedTotal).toBe(50);
    expect(bal.requiredTransmission).toBeCloseTo(50, 0);
    expect(bal.cableCapacityTotal).toBe(100);
    expect(bal.unified).toBe(true);
  });

  it('submarine_cable capacity sums with land cable capacity in the same component', () => {
    // Mixed-type component: one land cable + one submarine cable both connect A↔B.
    // Their capacities add (mirrors the chain test at routes.test.ts:742) — proving
    // the new RouteType is just another bucket in the §5.3 capacity sum.
    const a = makeState('a', { buildings: solars('a', 2), lastTick: NOON });
    const b = makeState('b', { buildings: [mine('b1', 0, 0), mine('b2', 4, 0)] });
    const world = makeWorld([
      cableRoute('a', 'b', 30),
      submarineCableRoute('a', 'b', 60),
    ]);
    const states = new Map<string, IslandState>([['a', a], ['b', b]]);
    const balances = balance(world, states);
    const bal = balances.get('a')!;
    expect(bal.requiredTransmission).toBeCloseTo(50, 0);
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

describe('§15.1 wall-anchored route weather (wallOffsetMs threading)', () => {
  const W = 3 * 24 * 60 * 60 * 1000; // 3 days of wall time

  /** Cells whose weather is `clear` at perf-domain sample times [0, 2000]
   *  but a loss-inducing storm class at wall time W. Proves the offset is
   *  what moves the sample, not the perf timestamp. */
  function findOffsetFlipCell(seed: string): { cx: number; cy: number } | null {
    for (let cx = -25; cx <= 25; cx++) {
      for (let cy = -25; cy <= 25; cy++) {
        const base = weather(seed, cx, cy, 0).state;
        if (base !== 'clear') continue;
        const wall = weather(seed, cx, cy, W).state;
        if (wall === 'storm' || wall === 'severe_storm') return { cx, cy };
      }
    }
    return null;
  }

  function runSession(
    cell: { cx: number; cy: number },
    perfDispatchMs: number,
    wallOffsetMs: number,
  ): { dispatched: number; delivered: number } {
    _resetRouteIdCounter();
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
    const out = tickRoutes(world, states, perfDispatchMs, 1, wallOffsetMs);
    const dispatched = out.dispatches.reduce((s, d) => s + d.amount, 0);
    const arr = tickRoutes(world, states, perfDispatchMs + 2000, 0, wallOffsetMs);
    const delivered = arr.arrivals.reduce((s, a) => s + a.amount, 0);
    return { dispatched, delivered };
  }

  it('arrival losses + dispatch capacity sample weather at perfTs + wallOffset', () => {
    const cell = findOffsetFlipCell('test-seed');
    expect(cell).not.toBeNull();
    if (!cell) return;

    // Offset 0: perf-domain samples are clear ⇒ full capacity, no loss.
    const base = runSession(cell, 0, 0);
    expect(base.dispatched).toBeCloseTo(10, 9);
    expect(base.delivered).toBeCloseTo(10, 9);

    // Offset W: same perf timestamps now sample the storm at wall time W ⇒
    // dispatch capacity is cut AND the in-flight batch takes a loss.
    const anchored = runSession(cell, 0, W);
    expect(anchored.dispatched).toBeLessThan(10);
    expect(anchored.delivered).toBeLessThan(anchored.dispatched);
  });

  it('same wall times ⇒ same outcomes regardless of the perf-clock epoch', () => {
    const cell = findOffsetFlipCell('test-seed');
    expect(cell).not.toBeNull();
    if (!cell) return;

    // Two "sessions" whose perf clocks started at different epochs but whose
    // wall anchors line the dispatch up at the same wall instant W.
    const sessionA = runSession(cell, 1_000, W - 1_000);
    const sessionB = runSession(cell, 777_000, W - 777_000);
    expect(sessionA.dispatched).toBeCloseTo(sessionB.dispatched, 9);
    expect(sessionA.delivered).toBeCloseTo(sessionB.delivered, 9);
    // And the shared outcome is the weather-affected one, not the clear-sky one.
    expect(sessionA.dispatched).toBeLessThan(10);
  });
});

describe('§7.3 coherent weather field across route consumers', () => {
  const CRISIS_CO2 = 200_000; // ≥ 100 t ⇒ ×1.6 storm-weight amplification

  /** Lossy storm states that still dispatch a nonzero batch (catastrophic
   *  has capacity ×0 — nothing would fly, so nothing could take losses). */
  function isStormClass(s: WeatherState): boolean {
    return s === 'storm' || s === 'severe_storm';
  }

  /** Cell that is benign (clear / light_fog — full capacity, no loss) at
   *  t=0 baseline but storm-class under crisis CO₂. A clear→storm flip is
   *  arithmetically impossible (amplification shifts the clear band into
   *  light_fog only), so benign-but-foggy baselines are the flip surface. */
  function findCo2FlipCell(seed: string): { cx: number; cy: number } {
    for (let cx = -25; cx <= 25; cx++) {
      for (let cy = -25; cy <= 25; cy++) {
        const base = weather(seed, cx, cy, 0).state;
        if (base !== 'clear' && base !== 'light_fog') continue;
        if (isStormClass(weather(seed, cx, cy, 0, undefined, CRISIS_CO2).state)) {
          return { cx, cy };
        }
      }
    }
    throw new Error('no CO₂ flip cell found');
  }

  function runWithCo2(co2Kg: number): { dispatched: number; delivered: number } {
    _resetRouteIdCounter();
    const cell = findCo2FlipCell('test-seed');
    const fromX = cell.cx * CELL_SIZE_TILES;
    const fromY = cell.cy * CELL_SIZE_TILES + 2;
    const toX = cell.cx * CELL_SIZE_TILES;
    const toY = cell.cy * CELL_SIZE_TILES + 14;
    const src = makeState('a', { inventory: { ...blankInventory(), iron_ore: 100 }, co2Kg });
    const dst = makeState('b');
    const world = makeWorld([], [
      makeIslandSpec('a', fromX, fromY),
      makeIslandSpec('b', toX, toY),
    ]);
    const states = new Map([['a', src], ['b', dst]]);
    world.islandStates = states; // sumIslandCo2 reads world.islandStates
    const r = cargoRoute('a', 'b', 'iron_ore', [], 10, 1);
    world.routes.push(r);
    const out = tickRoutes(world, states, 0, 1);
    const dispatched = out.dispatches.reduce((s, d) => s + d.amount, 0);
    const arr = tickRoutes(world, states, 2000, 0);
    const delivered = arr.arrivals.reduce((s, a) => s + a.amount, 0);
    return { dispatched, delivered };
  }

  it('crisis CO₂: dispatch capacity AND arrival losses both see the storm', () => {
    const amped = runWithCo2(CRISIS_CO2);
    expect(amped.dispatched).toBeLessThan(10);
    expect(amped.delivered).toBeLessThan(amped.dispatched);
  });

  it('zero CO₂: every consumer sees the same clear baseline', () => {
    const base = runWithCo2(0);
    expect(base.dispatched).toBeCloseTo(10, 9);
    expect(base.delivered).toBeCloseTo(10, 9);
  });

  it('biome threads into dispatch capacity and arrival losses', () => {
    // Cell clear at t=0 for the default field but storm-class under the
    // volcanic biome weighting; an island centred in that cell makes
    // biomeForCell return 'volcanic' for every consumer.
    let flip: { cx: number; cy: number } | null = null;
    for (let cx = -25; cx <= 25 && !flip; cx++) {
      for (let cy = -25; cy <= 25 && !flip; cy++) {
        const base = weather('test-seed', cx, cy, 0).state;
        if (base !== 'clear' && base !== 'light_fog') continue;
        if (isStormClass(weather('test-seed', cx, cy, 0, 'volcanic').state)) flip = { cx, cy };
      }
    }
    expect(flip).not.toBeNull();
    if (!flip) return;

    const run = (biome: IslandSpec['biome']): { dispatched: number; delivered: number } => {
      _resetRouteIdCounter();
      const fromX = flip!.cx * CELL_SIZE_TILES;
      const fromY = flip!.cy * CELL_SIZE_TILES + 2;
      const toX = flip!.cx * CELL_SIZE_TILES;
      const toY = flip!.cy * CELL_SIZE_TILES + 14;
      const src = makeState('a', { inventory: { ...blankInventory(), iron_ore: 100 } });
      const dst = makeState('b');
      const world = makeWorld([], [
        { ...makeIslandSpec('a', fromX, fromY), biome },
        makeIslandSpec('b', toX, toY),
      ]);
      const states = new Map([['a', src], ['b', dst]]);
      const r = cargoRoute('a', 'b', 'iron_ore', [], 10, 1);
      world.routes.push(r);
      const out = tickRoutes(world, states, 0, 1);
      const dispatched = out.dispatches.reduce((s, d) => s + d.amount, 0);
      const arr = tickRoutes(world, states, 2000, 0);
      const delivered = arr.arrivals.reduce((s, a) => s + a.amount, 0);
      return { dispatched, delivered };
    };

    const plains = run('plains');
    expect(plains.dispatched).toBeCloseTo(10, 9);
    expect(plains.delivered).toBeCloseTo(10, 9);

    const volcanic = run('volcanic');
    expect(volcanic.dispatched).toBeLessThan(10);
    expect(volcanic.delivered).toBeLessThan(volcanic.dispatched);
  });
});

describe('§2.7 / §15.1 cable-balance local power threads the wall clock', () => {
  const solarB = (i: number): { id: string; defId: 'solar'; x: number; y: number } =>
    ({ id: `sol-${i}`, defId: 'solar', x: i * 2, y: 0 });

  it('solarClockMs overrides the lastTick fallback inside computeIslandLocalPower', () => {
    const a = makeState('a', { buildings: [solarB(0), solarB(1)], lastTick: NOON });
    const world = makeWorld([]);
    const states = new Map<string, IslandState>([['a', a]]);
    // Default (no clocks): falls back to lastTick = NOON → full solar output.
    const noon = computeCableNetworkBalance(world, states, () => ({ world })).get('a')!;
    expect(noon.producedTotal).toBeCloseTo(100, 0);
    // Threaded midnight wall clock: solar gated down — proves the clock
    // params reach computeRates inside computeIslandLocalPower, so the
    // cable gate sees the same §2.7 solar (and §9.x during-storm
    // conditional) field the advance loop sees.
    const MIDNIGHT = NOON + 12 * 60 * 60 * 1000;
    const night = computeCableNetworkBalance(world, states, () => ({ world }), NOON, MIDNIGHT).get('a')!;
    expect(night.producedTotal).toBeLessThan(10);
  });
});
