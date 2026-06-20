// Pure tests for `computeNcState` per SPEC §9.6.
//
// Covers the four buff thresholds (3/5/10/20), the no-milestone case, the
// T3-gate semantics, and route-graph reachability from home.

import { describe, expect, it } from 'vitest';

import type { IslandState } from './economy.js';
import { computeNcState, networkedIslandIds } from './network-consciousness.js';
import { ALL_RESOURCES, type ResourceId } from './recipes.js';
import type { WorldState } from './world.js';

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

function makeState(id: string, level: number): IslandState {
  return {
    id,
    buildings: [],
    inventory: blankInventory(),
    storageCaps: blankCaps(100),
    xp: 0,
    level,
    unspentSkillPoints: 0,
    unlockedNodes: new Set(),
    unlockedEdges: new Set(),
    auraAmpVersion: 0,
    auraAmpCache: null,
    auraAmpCacheVersion: -1,
    co2Kg: 0,
    funnelPending: blankFunnel(),
    genesisTarget: null,
    lastTick: 0,
    aiCoreCrafted: false,
    ascendantCoreCrafted: false,
    lastResetAt: null,
    timeLockBankedMin: 0,
    accelerationQueue: [],
    accelerationRemainingMin: 0,
    bankingEnabled: false,
    batteryStoredWs: 0,
    starterInventoryGrace: {} as Record<ResourceId, number>,
    socketBindings: new Map(),
    everProduced: new Set(),
    tradeCooldownMs: 0,
    tradeAcceptCount: 0,
  };
}

function makeWorld(opts: {
  islands: Array<{ id: string; populated: boolean; level: number }>;
  routes?: Array<{ from: string; to: string }>;
  omitStates?: string[];
}): WorldState {
  const islandSpecs = opts.islands.map((i) => ({
    id: i.id,
    name: i.id,
    biome: 'plains' as const,
    cx: 0,
    cy: 0,
    majorRadius: 10,
    minorRadius: 10,
    populated: i.populated,
    discovered: i.populated,
    buildings: [],
    modifiers: [] as const,
  }));

  const islandStates = new Map<string, IslandState>();
  for (const i of opts.islands) {
    if (opts.omitStates?.includes(i.id)) continue;
    islandStates.set(i.id, makeState(i.id, i.level));
  }

  const routes: import('./routes.js').Route[] = (opts.routes ?? []).map((r, idx) => ({
    id: `route-${idx}`,
    from: r.from,
    to: r.to,
    type: 'cargo',
    capacityPerSec: 1,
    mode: 'priority',
    cargo: [],
    transitTimeSec: 1,
    inFlight: [],
  }));

  return {
    islands: islandSpecs,
    seed: 'test',
    drones: [],
    routes,
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
    oceanCells: new Map(),
    depthRevealedCells: new Set(),
    recentBuildAttempts: new Set(),
    recentBuildAttemptTs: new Map(),
    islandStates,
  };
}

describe('networkedIslandIds', () => {
  it('home island is always networked', () => {
    const world = makeWorld({
      islands: [{ id: 'home', populated: true, level: 1 }],
    });
    expect(networkedIslandIds(world)).toEqual(new Set(['home']));
  });

  it('island with no route is not networked', () => {
    const world = makeWorld({
      islands: [
        { id: 'home', populated: true, level: 1 },
        { id: 'alpha', populated: true, level: 1 },
      ],
    });
    expect(networkedIslandIds(world)).toEqual(new Set(['home']));
  });

  it('chain of routes: A→B→C, all networked', () => {
    const world = makeWorld({
      islands: [
        { id: 'home', populated: true, level: 1 },
        { id: 'b', populated: true, level: 1 },
        { id: 'c', populated: true, level: 1 },
      ],
      routes: [
        { from: 'home', to: 'b' },
        { from: 'b', to: 'c' },
      ],
    });
    expect(networkedIslandIds(world)).toEqual(new Set(['home', 'b', 'c']));
  });

  it('disconnected island not counted even if T3+', () => {
    const world = makeWorld({
      islands: [
        { id: 'home', populated: true, level: 15 },
        { id: 'alone', populated: true, level: 20 },
      ],
    });
    expect(networkedIslandIds(world)).toEqual(new Set(['home']));
  });

  it('bidirectional routes and cycles do not infinite-loop or double-count', () => {
    const world = makeWorld({
      islands: [
        { id: 'home', populated: true, level: 1 },
        { id: 'b', populated: true, level: 1 },
        { id: 'c', populated: true, level: 1 },
      ],
      routes: [
        { from: 'home', to: 'b' },
        { from: 'b', to: 'home' },
        { from: 'b', to: 'c' },
        { from: 'c', to: 'b' },
      ],
    });
    expect(networkedIslandIds(world)).toEqual(new Set(['home', 'b', 'c']));
  });

  it('undirected connectivity: inbound route counts', () => {
    const world = makeWorld({
      islands: [
        { id: 'home', populated: true, level: 1 },
        { id: 'b', populated: true, level: 1 },
      ],
      routes: [{ from: 'b', to: 'home' }],
    });
    expect(networkedIslandIds(world)).toEqual(new Set(['home', 'b']));
  });
});

describe('computeNcState — Network Consciousness thresholds per §9.6', () => {
  it('empty world → milestone 0 / buff 1.0 / count 0', () => {
    const world = makeWorld({ islands: [] });
    const nc = computeNcState(world);
    expect(nc.tier3PlusCount).toBe(0);
    expect(nc.milestone).toBe(0);
    expect(nc.globalProductionBuff).toBe(1);
  });

  it('1 island at T3+ → milestone 0 (below threshold)', () => {
    const world = makeWorld({
      islands: [{ id: 'home', populated: true, level: 15 }],
    });
    const nc = computeNcState(world);
    expect(nc.tier3PlusCount).toBe(1);
    expect(nc.milestone).toBe(0);
    expect(nc.globalProductionBuff).toBe(1);
  });

  it('2 islands at T3+ → milestone 0 (still below threshold)', () => {
    const world = makeWorld({
      islands: [
        { id: 'home', populated: true, level: 20 },
        { id: 'a', populated: true, level: 16 },
      ],
      routes: [{ from: 'home', to: 'a' }],
    });
    const nc = computeNcState(world);
    expect(nc.tier3PlusCount).toBe(2);
    expect(nc.milestone).toBe(0);
    expect(nc.globalProductionBuff).toBe(1);
  });

  it('3 islands at T3+ → milestone 1 / buff 1.05', () => {
    const world = makeWorld({
      islands: [
        { id: 'home', populated: true, level: 15 },
        { id: 'b', populated: true, level: 17 },
        { id: 'c', populated: true, level: 22 },
      ],
      routes: [
        { from: 'home', to: 'b' },
        { from: 'home', to: 'c' },
      ],
    });
    const nc = computeNcState(world);
    expect(nc.tier3PlusCount).toBe(3);
    expect(nc.milestone).toBe(1);
    expect(nc.globalProductionBuff).toBeCloseTo(1.05, 12);
  });

  it('5 islands at T3+ → milestone 2 / buff 1.10', () => {
    const islands = Array.from({ length: 5 }, (_, i) => ({
      id: i === 0 ? 'home' : `a${i}`,
      populated: true as const,
      level: 15,
    }));
    const routes = islands.slice(1).map((i) => ({ from: 'home', to: i.id }));
    const world = makeWorld({ islands, routes });
    const nc = computeNcState(world);
    expect(nc.tier3PlusCount).toBe(5);
    expect(nc.milestone).toBe(2);
    expect(nc.globalProductionBuff).toBeCloseTo(1.10, 12);
  });

  it('10 islands at T3+ → milestone 3 / buff 1.25', () => {
    const islands = Array.from({ length: 10 }, (_, i) => ({
      id: i === 0 ? 'home' : `a${i}`,
      populated: true as const,
      level: 15,
    }));
    const routes = islands.slice(1).map((i) => ({ from: 'home', to: i.id }));
    const world = makeWorld({ islands, routes });
    const nc = computeNcState(world);
    expect(nc.tier3PlusCount).toBe(10);
    expect(nc.milestone).toBe(3);
    expect(nc.globalProductionBuff).toBeCloseTo(1.25, 12);
  });

  it('20 islands at T3+ → milestone 4 / buff 1.25', () => {
    const islands = Array.from({ length: 20 }, (_, i) => ({
      id: i === 0 ? 'home' : `a${i}`,
      populated: true as const,
      level: 15,
    }));
    const routes = islands.slice(1).map((i) => ({ from: 'home', to: i.id }));
    const world = makeWorld({ islands, routes });
    const nc = computeNcState(world);
    expect(nc.tier3PlusCount).toBe(20);
    expect(nc.milestone).toBe(4);
    expect(nc.globalProductionBuff).toBeCloseTo(1.25, 12);
  });

  it('non-T3 islands are not counted (level 14 just below)', () => {
    const islands = Array.from({ length: 5 }, (_, i) => ({
      id: `a${i}`,
      populated: true as const,
      level: 14,
    }));
    const routes = islands.slice(1).map((i) => ({ from: 'a0', to: i.id }));
    const world = makeWorld({ islands, routes });
    const nc = computeNcState(world);
    expect(nc.tier3PlusCount).toBe(0);
    expect(nc.milestone).toBe(0);
    expect(nc.globalProductionBuff).toBe(1);
  });

  it('mixed-tier population: only T3+ count toward the milestone', () => {
    const world = makeWorld({
      islands: [
        { id: 'home', populated: true, level: 30 }, // T4 → counts
        { id: 'a', populated: true, level: 15 },    // T3 boundary → counts
        { id: 'b', populated: true, level: 14 },    // T2 → does NOT count
        { id: 'c', populated: true, level: 1 },     // T1 → does NOT count
        { id: 'd', populated: true, level: 17 },    // T3 → counts
      ],
      routes: [
        { from: 'home', to: 'a' },
        { from: 'home', to: 'b' },
        { from: 'home', to: 'c' },
        { from: 'home', to: 'd' },
      ],
    });
    const nc = computeNcState(world);
    expect(nc.tier3PlusCount).toBe(3);
    expect(nc.milestone).toBe(1);
    expect(nc.globalProductionBuff).toBeCloseTo(1.05, 12);
  });

  it('level 15 is the T3 boundary (inclusive)', () => {
    const world = makeWorld({
      islands: [
        { id: 'home', populated: true, level: 15 },
        { id: 'a', populated: true, level: 15 },
        { id: 'b', populated: true, level: 15 },
      ],
      routes: [
        { from: 'home', to: 'a' },
        { from: 'home', to: 'b' },
      ],
    });
    const nc = computeNcState(world);
    expect(nc.tier3PlusCount).toBe(3);
    expect(nc.milestone).toBe(1);
  });

  it('throws when world.islandStates is missing', () => {
    const world = makeWorld({
      islands: [{ id: 'home', populated: true, level: 15 }],
    });
    world.islandStates = undefined;
    expect(() => computeNcState(world)).toThrow(
      'computeNcState: world.islandStates is missing',
    );
  });

  it('ignores islands that have no entry in islandStates', () => {
    const world = makeWorld({
      islands: [
        { id: 'home', populated: true, level: 15 },
        { id: 'missing', populated: true, level: 20 },
      ],
      routes: [{ from: 'home', to: 'missing' }],
      omitStates: ['missing'],
    });
    const nc = computeNcState(world);
    expect(nc.tier3PlusCount).toBe(1); // only home counts
    expect(nc.milestone).toBe(0);
  });

  it('unpopulated islands never count, even if T3+ and routed', () => {
    const world = makeWorld({
      islands: [
        { id: 'home', populated: true, level: 15 },
        { id: 'ghost', populated: false, level: 20 },
      ],
      routes: [{ from: 'home', to: 'ghost' }],
    });
    const nc = computeNcState(world);
    expect(nc.tier3PlusCount).toBe(1);
    expect(nc.milestone).toBe(0);
  });

  it('disconnected T3+ island is excluded from count', () => {
    const world = makeWorld({
      islands: [
        { id: 'home', populated: true, level: 15 },
        { id: 'remote', populated: true, level: 20 },
        { id: 'linked', populated: true, level: 20 },
      ],
      routes: [{ from: 'home', to: 'linked' }],
    });
    const nc = computeNcState(world);
    expect(nc.tier3PlusCount).toBe(2); // home + linked
    expect(nc.milestone).toBe(0);
  });
});
