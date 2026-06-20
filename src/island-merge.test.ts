// §3.6 Island Joining — pure unit tests.

import { beforeEach, describe, expect, it } from 'vitest';

import type { IslandState } from './economy.js';
import {
  chooseMergeAbsorber,
  findNextMerge,
  islandRefundedPoints,
  performMerge,
} from './island-merge.js';
import {
  _resetDroneIdCounter,
  type Drone,
} from './drones.js';
import {
  _resetRouteIdCounter,
  nextRouteId,
  type Route,
} from './routes.js';
import {
  _resetVehicleIdCounter,
  nextVehicleId,
  type SettlementVehicle,
} from './settlement.js';
import {
  type CommPacket,
  type RepairDrone,
  type Satellite,
} from './orbital.js';
import { ALL_RESOURCES, type ResourceId } from './recipes.js';
import {
  attachTerrainAt,
  findPopulatedIslandAt,
  islandsOverlap,
  islandTileCount,
  type IslandSpec,
  type WorldState,
} from './world.js';

// Fixtures

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

function caps(value: number): Record<ResourceId, number> {
  const c = {} as Record<ResourceId, number>;
  for (const r of ALL_RESOURCES) c[r] = value;
  return c;
}

function makeSpec(over: Partial<IslandSpec> = {}): IslandSpec {
  return {
    id: 'fixture',
    name: 'fixture',
    biome: 'plains',
    cx: 0,
    cy: 0,
    majorRadius: 14,
    minorRadius: 14,
    populated: true,
    discovered: true,
    buildings: [],
    modifiers: [],
    ...over,
  };
}

function makeState(over: Partial<IslandState> = {}): IslandState {
  return {
    id: 'fixture',
    buildings: [],
    inventory: emptyInv(),
    storageCaps: caps(2000),
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

function makeWorld(islands: IslandSpec[]): WorldState {
  return { islands: [...islands], drones: [], routes: [], vehicles: [], revealedCells: new Set(), satellites: [], repairDrones: [],
    debrisFields: [], latticeActive: false, latticeNodeIslands: [],
    commPackets: [], totalCo2Kg: 0, playerLat: null, playerLon: null, seed: 'test-seed', oceanCells: new Map(), depthRevealedCells: new Set(), recentBuildAttempts: new Set(), recentBuildAttemptTs: new Map() };
}

beforeEach(() => {
  _resetDroneIdCounter();
  _resetRouteIdCounter();
  _resetVehicleIdCounter();
});

describe('islandsOverlap — tile-footprint touch (§3.6)', () => {
  // An r=2 circle inscribes exactly the 2×2 tile block at columns/rows {-1, 0}
  // (tile (x,y) needs all four corners strictly inside, so x ∈ {-1,0}). That
  // makes the touch/gap arithmetic exact and hand-verifiable below.
  it('returns false for two well-separated islands', () => {
    const a = makeSpec({ id: 'a', cx: 0, cy: 0, majorRadius: 10, minorRadius: 10 });
    const b = makeSpec({ id: 'b', cx: 100, cy: 0, majorRadius: 10, minorRadius: 10 });
    expect(islandsOverlap(a, b)).toBe(false);
  });

  it('returns FALSE when the ellipses overlap but the tile footprints have an ocean gap', () => {
    // THE BUG: two r=2 circles 3 apart. Continuous ellipses overlap (centre
    // distance 3 < sum-of-radii 4 ⇒ the old test merged them), but a's tiles
    // occupy columns {-1,0} and b's occupy {2,3} — column 1 is open ocean
    // between them, so the land masses are NOT connected.
    const a = makeSpec({ id: 'a', cx: 0, cy: 0, majorRadius: 2, minorRadius: 2 });
    const b = makeSpec({ id: 'b', cx: 3, cy: 0, majorRadius: 2, minorRadius: 2 });
    expect(islandsOverlap(a, b)).toBe(false);
  });

  it('returns true when tile footprints are edge-adjacent (no ocean between)', () => {
    // r=2 circles 2 apart: a's tiles columns {-1,0}, b's columns {1,2}. a's
    // column 0 is orthogonally adjacent to b's column 1 — touching land.
    const a = makeSpec({ id: 'a', cx: 0, cy: 0, majorRadius: 2, minorRadius: 2 });
    const b = makeSpec({ id: 'b', cx: 2, cy: 0, majorRadius: 2, minorRadius: 2 });
    expect(islandsOverlap(a, b)).toBe(true);
  });

  it('returns true when tile footprints overlap (share a tile)', () => {
    const a = makeSpec({ id: 'a', cx: 0, cy: 0, majorRadius: 2, minorRadius: 2 });
    const b = makeSpec({ id: 'b', cx: 1, cy: 0, majorRadius: 2, minorRadius: 2 });
    expect(islandsOverlap(a, b)).toBe(true);
  });

  it('returns FALSE for diagonal corner-only contact (ocean on both flanks)', () => {
    //   [a][ ]
    //   [ ][b]
    // a's tiles occupy cols/rows {-1,0}; shifting b by (+2,+2) puts b's tiles at
    // cols/rows {1,2}. a's corner tile (0,0) meets b's corner tile (1,1) only
    // diagonally — the cells (1,0) and (0,1) between them are open ocean, so the
    // land masses are not connected and must NOT merge.
    const a = makeSpec({ id: 'a', cx: 0, cy: 0, majorRadius: 2, minorRadius: 2 });
    const b = makeSpec({ id: 'b', cx: 2, cy: 2, majorRadius: 2, minorRadius: 2 });
    expect(islandsOverlap(a, b)).toBe(false);
  });

  it('returns true when only an extra constituent touches (post-merge case)', () => {
    // a: primary r=2 at (0,0) [cols {-1,0}] + extra r=2 at offset (4,0)
    // [cols {3,4}]. b: r=2 at (6,0) [cols {5,6}]. The primary is far from b,
    // but the extra's column 4 is edge-adjacent to b's column 5 ⇒ touch.
    const a = makeSpec({
      id: 'a',
      cx: 0,
      cy: 0,
      majorRadius: 2,
      minorRadius: 2,
      extraEllipses: [{ major: 2, minor: 2, rotation: 0, offsetX: 4, offsetY: 0 }],
    });
    const b = makeSpec({ id: 'b', cx: 6, cy: 0, majorRadius: 2, minorRadius: 2 });
    expect(islandsOverlap(a, b)).toBe(true);
  });

  it('returns false when an extra constituent overlaps the ellipse but not the tiles', () => {
    // Same as above but b at (7,0) [cols {6,7}]: the extra (cols {3,4}) is two
    // columns short of b (col 5 is ocean) even though the r=2 ellipses at (4,0)
    // and (7,0) still overlap (distance 3 < sum 4).
    const a = makeSpec({
      id: 'a',
      cx: 0,
      cy: 0,
      majorRadius: 2,
      minorRadius: 2,
      extraEllipses: [{ major: 2, minor: 2, rotation: 0, offsetX: 4, offsetY: 0 }],
    });
    const b = makeSpec({ id: 'b', cx: 7, cy: 0, majorRadius: 2, minorRadius: 2 });
    expect(islandsOverlap(a, b)).toBe(false);
  });
});

describe('chooseMergeAbsorber', () => {
  it('picks the larger tile-count island', () => {
    const big = makeSpec({ id: 'big', majorRadius: 14, minorRadius: 14 });
    const small = makeSpec({ id: 'small', majorRadius: 5, minorRadius: 5 });
    const sBig = makeState({ id: 'big' });
    const sSmall = makeState({ id: 'small' });
    expect(chooseMergeAbsorber(big, small, sBig, sSmall)).toEqual({
      absorber: 'a',
      reason: 'tile-count',
    });
    // Symmetric — swap inputs.
    expect(chooseMergeAbsorber(small, big, sSmall, sBig)).toEqual({
      absorber: 'b',
      reason: 'tile-count',
    });
  });

  it('breaks tile-count ties by higher level', () => {
    const a = makeSpec({ id: 'a', majorRadius: 5, minorRadius: 5 });
    const b = makeSpec({ id: 'b', majorRadius: 5, minorRadius: 5 });
    const sa = makeState({ id: 'a', level: 3 });
    const sb = makeState({ id: 'b', level: 7 });
    expect(chooseMergeAbsorber(a, b, sa, sb)).toEqual({
      absorber: 'b',
      reason: 'level-tiebreak',
    });
  });

  it('breaks tile-count + level ties by lower lexicographic id', () => {
    const a = makeSpec({ id: 'zeta', majorRadius: 5, minorRadius: 5 });
    const b = makeSpec({ id: 'alpha', majorRadius: 5, minorRadius: 5 });
    const sa = makeState({ id: 'zeta', level: 4 });
    const sb = makeState({ id: 'alpha', level: 4 });
    expect(chooseMergeAbsorber(a, b, sa, sb)).toEqual({
      absorber: 'b',
      reason: 'id-tiebreak',
    });
  });
});

describe('performMerge', () => {
  it('appends absorbed primary ellipse as extra on absorber with correct offset', () => {
    const a = makeSpec({ id: 'a', cx: 0, cy: 0, majorRadius: 14, minorRadius: 14 });
    const b = makeSpec({ id: 'b', cx: 20, cy: -5, majorRadius: 5, minorRadius: 5 });
    const sa = makeState({ id: 'a' });
    const sb = makeState({ id: 'b' });
    const world = makeWorld([a, b]);
    const states = new Map<string, IslandState>([
      ['a', sa],
      ['b', sb],
    ]);
    performMerge(world, states, a, b);
    expect(a.extraEllipses).toEqual([
      { biome: 'plains', major: 5, minor: 5, rotation: 0, offsetX: 20, offsetY: -5 },
    ]);
  });

  it('stamps origin biome on appended and propagated extras', () => {
    // A (plains) is the larger absorber; B (volcanic) already absorbed a C (arctic) lobe.
    const a = makeSpec({ id: 'a', cx: 0, cy: 0, majorRadius: 14, minorRadius: 14, biome: 'plains' });
    const b = makeSpec({
      id: 'b',
      cx: 18,
      cy: 0,
      majorRadius: 5,
      minorRadius: 5,
      biome: 'volcanic',
      extraEllipses: [{ biome: 'arctic', major: 4, minor: 4, rotation: 0, offsetX: 10, offsetY: 0 }],
    });
    const world = makeWorld([a, b]);
    const states = new Map<string, IslandState>([
      ['a', makeState({ id: 'a' })],
      ['b', makeState({ id: 'b' })],
    ]);
    performMerge(world, states, a, b);
    const extras = a.extraEllipses!;
    expect(extras.some((e) => e.biome === 'volcanic')).toBe(true);
    expect(extras.some((e) => e.biome === 'arctic')).toBe(true);
    expect(extras.every((e) => e.biome !== undefined)).toBe(true);
  });

  it('removes the absorbed island from world.islands and the state map', () => {
    const a = makeSpec({ id: 'a', cx: 0, cy: 0, majorRadius: 14, minorRadius: 14 });
    const b = makeSpec({ id: 'b', cx: 20, cy: 0, majorRadius: 5, minorRadius: 5 });
    const world = makeWorld([a, b]);
    const states = new Map<string, IslandState>([
      ['a', makeState({ id: 'a' })],
      ['b', makeState({ id: 'b' })],
    ]);
    performMerge(world, states, a, b);
    expect(world.islands.map((s) => s.id)).toEqual(['a']);
    expect(states.has('b')).toBe(false);
  });

  it('transfers absorbed inventory and clamps overflow to absorber caps', () => {
    const a = makeSpec({ id: 'a' });
    const b = makeSpec({ id: 'b', cx: 20, cy: 0 });
    const sa = makeState({ id: 'a', storageCaps: caps(100), inventory: { ...emptyInv(), iron_ore: 30 } });
    const sb = makeState({ id: 'b', inventory: { ...emptyInv(), iron_ore: 200 } });
    const world = makeWorld([a, b]);
    const states = new Map<string, IslandState>([
      ['a', sa],
      ['b', sb],
    ]);
    performMerge(world, states, a, b);
    // 30 + 200 = 230, capped at 100 → 100. The other 130 is lost.
    expect(sa.inventory.iron_ore).toBe(100);
  });

  it("refunds absorbed island's unspent + spent skill points as unspent on absorber", () => {
    const a = makeSpec({ id: 'a' });
    const b = makeSpec({ id: 'b', cx: 20, cy: 0 });
    const sa = makeState({ id: 'a', unspentSkillPoints: 2 });
    const sb = makeState({
      id: 'b',
      unspentSkillPoints: 5,
      // Simulate 3 points spent into a notable (efficientDrills=3).
      unlockedNodes: new Set(['mining.notable.efficientDrills']),
    });
    expect(islandRefundedPoints(sb)).toBe(5 + 3);
    const world = makeWorld([a, b]);
    const states = new Map<string, IslandState>([
      ['a', sa],
      ['b', sb],
    ]);
    performMerge(world, states, a, b);
    expect(sa.unspentSkillPoints).toBe(2 + 5 + 3);
  });

  it("preserves absorber's level and xp; discards absorbed's", () => {
    const a = makeSpec({ id: 'a' });
    const b = makeSpec({ id: 'b', cx: 20, cy: 0 });
    const sa = makeState({ id: 'a', level: 5, xp: 1234 });
    const sb = makeState({ id: 'b', level: 9, xp: 8888 });
    const world = makeWorld([a, b]);
    const states = new Map<string, IslandState>([
      ['a', sa],
      ['b', sb],
    ]);
    performMerge(world, states, a, b);
    expect(sa.level).toBe(5);
    expect(sa.xp).toBe(1234);
  });

  it("preserves absorber's modifiers (absorbed's are voided)", () => {
    const a = makeSpec({ id: 'a', modifiers: ['stable'] });
    const b = makeSpec({ id: 'b', cx: 20, cy: 0, modifiers: ['cursed_storms', 'fertile'] });
    const sa = makeState({ id: 'a' });
    const sb = makeState({ id: 'b' });
    const world = makeWorld([a, b]);
    const states = new Map<string, IslandState>([
      ['a', sa],
      ['b', sb],
    ]);
    performMerge(world, states, a, b);
    expect(a.modifiers).toEqual(['stable']);
  });

  it("shifts absorbed buildings into absorber's local frame by the offset", () => {
    const a = makeSpec({
      id: 'a',
      cx: 0,
      cy: 0,
      buildings: [{ id: 'a-mine', defId: 'mine', x: 1, y: 1 }],
    });
    const b = makeSpec({
      id: 'b',
      cx: 20,
      cy: 0,
      buildings: [{ id: 'b-mine', defId: 'mine', x: 3, y: 4 }],
    });
    const world = makeWorld([a, b]);
    const states = new Map<string, IslandState>([
      ['a', makeState({ id: 'a' })],
      ['b', makeState({ id: 'b' })],
    ]);
    performMerge(world, states, a, b);
    expect(a.buildings).toHaveLength(2);
    expect(a.buildings[0]).toEqual({ id: 'a-mine', defId: 'mine', x: 1, y: 1 });
    // Absorbed buildings are re-minted from shifted coords (fix 1).
    expect(a.buildings[1]).toEqual({ id: 'placed-23,4', defId: 'mine', x: 23, y: 4 });
  });

  it('redirects routes targeting absorbed; redirects routes leaving absorbed; deletes A↔B routes', () => {
    const a = makeSpec({ id: 'a' });
    const b = makeSpec({ id: 'b', cx: 20, cy: 0 });
    const c = makeSpec({ id: 'c', cx: 100, cy: 100, populated: true });
    const world = makeWorld([a, b, c]);
    const make = (from: string, to: string): Route => ({
      id: nextRouteId(),
      from,
      to,
      type: 'cargo',
      capacityPerSec: 0.5,
      mode: 'priority',
      cargo: [{ resourceId: 'iron_ore' }],
      transitTimeSec: 10,
      inFlight: [],
    });
    world.routes.push(make('b', 'c')); // B → X redirects to A → X
    world.routes.push(make('c', 'b')); // X → B redirects to X → A
    world.routes.push(make('a', 'b')); // A → B deleted
    world.routes.push(make('b', 'a')); // B → A deleted
    world.routes.push(make('a', 'c')); // unrelated — passthrough
    const states = new Map<string, IslandState>([
      ['a', makeState({ id: 'a' })],
      ['b', makeState({ id: 'b' })],
      ['c', makeState({ id: 'c' })],
    ]);
    performMerge(world, states, a, b);
    const summary = world.routes.map((r) => `${r.from}->${r.to}`).sort();
    expect(summary).toEqual(['a->c', 'a->c', 'c->a']);
  });

  it('redirects drones whose fromIslandId === absorbed.id', () => {
    const a = makeSpec({ id: 'a' });
    const b = makeSpec({ id: 'b', cx: 20, cy: 0 });
    const world = makeWorld([a, b]);
    const drone: Drone = {
      id: 'drone-1',
      fromIslandId: 'b',
      originX: 20,
      originY: 0,
      dirX: 1,
      dirY: 0,
      outboundTiles: 50,
      scanRadius: 8,
      launchTime: 0,
      expectedReturnTime: 10_000,
      tier: 2,
      fuelLoaded: 25,
      fuelResource: 'biofuel',
      waypoints: [],
      darkModeDiscoveries: [],
      scanBuffer: new Set<string>(),
      probabilityBias: 0,
    };
    world.drones.push(drone);
    const states = new Map<string, IslandState>([
      ['a', makeState({ id: 'a' })],
      ['b', makeState({ id: 'b' })],
    ]);
    performMerge(world, states, a, b);
    expect(world.drones[0]?.fromIslandId).toBe('a');
  });

  it('redirects settlement vehicles target === absorbed.id (target retargets to absorber)', () => {
    const a = makeSpec({ id: 'a' });
    const b = makeSpec({ id: 'b', cx: 20, cy: 0 });
    const world = makeWorld([a, b]);
    const v: SettlementVehicle = {
      id: nextVehicleId(),
      kind: 'ship',
      tier: 1,
      from: 'origin-x',
      target: 'b',
      fuelLoaded: 10,
      foundationKitCount: 1,
      speed: 1,
      launchTime: 0,
      expectedArrivalTime: 100_000,
      weatherMultiplier: 1,
      fuelResource: 'biofuel',
      failureRate: 0.02,
      scanBuffer: new Set<string>(),
    };
    world.vehicles.push(v);
    const states = new Map<string, IslandState>([
      ['a', makeState({ id: 'a' })],
      ['b', makeState({ id: 'b' })],
    ]);
    performMerge(world, states, a, b);
    expect(world.vehicles[0]?.target).toBe('a');
  });

  it('re-mints absorbed building ids so no duplicates exist after merge', () => {
    // Both islands own a building at local (0,0) — the ids collide if kept.
    const a = makeSpec({
      id: 'a',
      cx: 0,
      cy: 0,
      buildings: [{ id: 'placed-0,0', defId: 'mine', x: 0, y: 0 }],
    });
    const b = makeSpec({
      id: 'b',
      cx: 20,
      cy: 0,
      buildings: [{ id: 'placed-0,0', defId: 'workshop', x: 0, y: 0 }],
    });
    const world = makeWorld([a, b]);
    const states = new Map<string, IslandState>([
      ['a', makeState({ id: 'a' })],
      ['b', makeState({ id: 'b' })],
    ]);
    performMerge(world, states, a, b);
    expect(a.buildings).toHaveLength(2);
    const ids = a.buildings.map((b) => b.id);
    expect(new Set(ids).size).toBe(2);
    // Absorbed building shifted to (20,0) in A-local coords.
    expect(a.buildings[1]).toEqual({ id: 'placed-20,0', defId: 'workshop', x: 20, y: 0 });
  });

  it('updates route sourceBuildingId when the absorbed building is re-minted', () => {
    const a = makeSpec({
      id: 'a',
      cx: 0,
      cy: 0,
      buildings: [{ id: 'placed-0,0', defId: 'mine', x: 0, y: 0 }],
    });
    const b = makeSpec({
      id: 'b',
      cx: 20,
      cy: 0,
      buildings: [{ id: 'placed-0,0', defId: 'dock', x: 0, y: 0 }],
    });
    const c = makeSpec({ id: 'c', cx: 100, cy: 100, populated: true });
    const world = makeWorld([a, b, c]);
    world.routes.push({
      id: 'route-1',
      from: 'b',
      to: 'c',
      type: 'cargo',
      capacityPerSec: 0.5,
      mode: 'priority',
      cargo: [{ resourceId: 'iron_ore' }],
      transitTimeSec: 10,
      inFlight: [],
      sourceBuildingId: 'placed-0,0',
    });
    const states = new Map<string, IslandState>([
      ['a', makeState({ id: 'a' })],
      ['b', makeState({ id: 'b' })],
      ['c', makeState({ id: 'c' })],
    ]);
    performMerge(world, states, a, b);
    const route = world.routes.find((r) => r.from === 'a' && r.to === 'c');
    expect(route).toBeDefined();
    expect(route!.sourceBuildingId).toBe('placed-20,0');
  });

  it('re-anchors absorbed ocean platforms to the absorber island', () => {
    const a = makeSpec({ id: 'a', cx: 0, cy: 0 });
    const b = makeSpec({
      id: 'b',
      cx: 20,
      cy: 0,
      buildings: [
        { id: 'buoy-1', defId: 'sonar_buoy', x: 0, y: 0, anchorIslandId: 'b' },
      ],
    });
    const world = makeWorld([a, b]);
    const states = new Map<string, IslandState>([
      ['a', makeState({ id: 'a' })],
      ['b', makeState({ id: 'b' })],
    ]);
    performMerge(world, states, a, b);
    const buoy = a.buildings.find((b) => b.defId === 'sonar_buoy');
    expect(buoy).toBeDefined();
    expect(buoy!.anchorIslandId).toBe('a');
  });

  it('carries absorbed tileOverrides across the merge shifted by offset', () => {
    const a = attachTerrainAt({
      id: 'a',
      name: 'a',
      biome: 'plains',
      cx: 0,
      cy: 0,
      majorRadius: 14,
      minorRadius: 14,
      populated: true,
      discovered: true,
      buildings: [],
      modifiers: [],
    });
    const b = attachTerrainAt({
      id: 'b',
      name: 'b',
      biome: 'plains',
      cx: 20,
      cy: 0,
      majorRadius: 14,
      minorRadius: 14,
      populated: true,
      discovered: true,
      buildings: [],
      modifiers: [],
      tileOverrides: { '1,1': 'ore' },
    });
    const world = makeWorld([a, b]);
    const states = new Map<string, IslandState>([
      ['a', makeState({ id: 'a' })],
      ['b', makeState({ id: 'b' })],
    ]);
    performMerge(world, states, a, b);
    // Shifted key should exist.
    expect(a.tileOverrides?.['21,1']).toBe('ore');
    // terrainAt should resolve the override.
    expect(a.terrainAt!(21, 1)).toBe('ore');
  });

  it('credits absorbed storage caps before the inventory transfer', () => {
    const a = makeSpec({
      id: 'a',
      cx: 0,
      cy: 0,
      buildings: [],
    });
    const b = makeSpec({
      id: 'b',
      cx: 20,
      cy: 0,
      buildings: [
        { id: 'crate-1', defId: 'crate', x: 0, y: 0, cargoLabel: 'iron_ore' },
      ],
    });
    const sa = makeState({
      id: 'a',
      storageCaps: { ...caps(2000), iron_ore: 100 },
      inventory: { ...emptyInv(), iron_ore: 0 },
    });
    const sb = makeState({
      id: 'b',
      inventory: { ...emptyInv(), iron_ore: 150 },
    });
    const world = makeWorld([a, b]);
    const states = new Map<string, IslandState>([
      ['a', sa],
      ['b', sb],
    ]);
    performMerge(world, states, a, b);
    // The crate's cap contribution should now be on the absorber.
    expect(sa.storageCaps.iron_ore).toBeGreaterThan(100);
    // Inventory should have been transferred into the raised cap, not clamped.
    expect(sa.inventory.iron_ore).toBe(150);
  });

  it('rewrites satellite spaceportIslandId, comm packet currentNodeId, and lattice node membership from absorbed to absorber', () => {
    const a = makeSpec({ id: 'a' });
    const b = makeSpec({ id: 'b', cx: 20, cy: 0 });
    const world = makeWorld([a, b]);

    const sat: Satellite = {
      id: 'sat-1',
      variant: 'scanner',
      spaceportIslandId: 'b',
      x: 20,
      y: 0,
      commRange: 10,
      coverageRadius: 10,
      fuel: 100,
      lodges: { scan: 0, weather: 0, comm: 0 },
      locked: true,
      pendingRepairDroneId: null,
      buffer: [],
    };
    world.satellites.push(sat);

    const pkt: CommPacket = {
      id: 'pkt-1',
      payload: { type: 'discovery', payload: null },
      currentNodeId: 'b',
      originSatId: 'sat-1',
      generatedMs: 0,
    };
    world.commPackets.push(pkt);

    world.latticeNodeIslands = ['b'];

    const repair: RepairDrone = {
      id: 'repair-1',
      targetSatId: 'sat-1',
      launchTime: 0,
      expectedArrivalTime: 100_000,
    };
    world.repairDrones.push(repair);

    const states = new Map<string, IslandState>([
      ['a', makeState({ id: 'a' })],
      ['b', makeState({ id: 'b' })],
    ]);

    performMerge(world, states, a, b);

    expect(world.satellites[0]?.spaceportIslandId).toBe('a');
    expect(world.commPackets[0]?.currentNodeId).toBe('a');
    expect(world.latticeNodeIslands).toEqual(['a']);
    expect(world.repairDrones[0]?.targetSatId).toBe('sat-1');
  });

  it('deduplicates lattice node membership when absorber is already a node', () => {
    const a = makeSpec({ id: 'a' });
    const b = makeSpec({ id: 'b', cx: 20, cy: 0 });
    const world = makeWorld([a, b]);
    world.latticeNodeIslands = ['a', 'b'];

    const states = new Map<string, IslandState>([
      ['a', makeState({ id: 'a' })],
      ['b', makeState({ id: 'b' })],
    ]);

    performMerge(world, states, a, b);

    expect(world.latticeNodeIslands).toEqual(['a']);
  });
});

describe('findNextMerge', () => {
  it('returns null when no islands overlap', () => {
    const a = makeSpec({ id: 'a', cx: 0, cy: 0, majorRadius: 5, minorRadius: 5 });
    const b = makeSpec({ id: 'b', cx: 100, cy: 0, majorRadius: 5, minorRadius: 5 });
    const world = makeWorld([a, b]);
    const states = new Map<string, IslandState>([
      ['a', makeState({ id: 'a' })],
      ['b', makeState({ id: 'b' })],
    ]);
    expect(findNextMerge(world, states)).toBeNull();
  });

  it('selects the pair with the largest combined tile count when multiple overlaps exist', () => {
    // Pair (a,b) — both r=14 (~600+600 tiles).
    // Pair (a,c) — a r=14, c r=5 (~600+80 tiles).
    // Pair (a,b) wins on combined size.
    const a = makeSpec({ id: 'a', cx: 0, cy: 0, majorRadius: 14, minorRadius: 14 });
    const b = makeSpec({ id: 'b', cx: 25, cy: 0, majorRadius: 14, minorRadius: 14 });
    const c = makeSpec({ id: 'c', cx: 0, cy: 18, majorRadius: 5, minorRadius: 5 });
    const world = makeWorld([a, b, c]);
    const states = new Map<string, IslandState>([
      ['a', makeState({ id: 'a' })],
      ['b', makeState({ id: 'b' })],
      ['c', makeState({ id: 'c' })],
    ]);
    const pair = findNextMerge(world, states);
    expect(pair).not.toBeNull();
    const ids = [pair!.absorber.id, pair!.absorbed.id].sort();
    expect(ids).toEqual(['a', 'b']);
  });

  it('breaks combined-tile-count ties by lower-id-first per §3.6', () => {
    // Build three congruent islands so every pair has the same combined tile
    // count. (a,b) overlaps and (a,c) overlaps but (b,c) does not. Pairs
    // {a,b} and {a,c} tie; the rule says lower-min-id wins — min(a,b)=a,
    // min(a,c)=a — both have min-id 'a'. Use ids picked so the FULL pair
    // identity disambiguates: {a,b} vs {a,c} → 'a' < 'a' is false, then
    // 'b' < 'c' so {a,b} wins. We test the deterministic outcome.
    const a = makeSpec({ id: 'a', cx: 0, cy: 0, majorRadius: 5, minorRadius: 5 });
    const b = makeSpec({ id: 'b', cx: 7, cy: 0, majorRadius: 5, minorRadius: 5 });
    const c = makeSpec({ id: 'c', cx: 0, cy: 7, majorRadius: 5, minorRadius: 5 });
    const world = makeWorld([a, b, c]);
    const states = new Map<string, IslandState>([
      ['a', makeState({ id: 'a' })],
      ['b', makeState({ id: 'b' })],
      ['c', makeState({ id: 'c' })],
    ]);
    const pair = findNextMerge(world, states);
    expect(pair).not.toBeNull();
    const ids = [pair!.absorber.id, pair!.absorbed.id].sort();
    expect(ids).toEqual(['a', 'b']);
  });

  it('skips unpopulated islands (no merge between populated and unpopulated)', () => {
    const a = makeSpec({ id: 'a', cx: 0, cy: 0, majorRadius: 10, minorRadius: 10 });
    const b = makeSpec({ id: 'b', cx: 15, cy: 0, majorRadius: 10, minorRadius: 10, populated: false });
    const world = makeWorld([a, b]);
    const states = new Map<string, IslandState>([['a', makeState({ id: 'a' })]]);
    expect(findNextMerge(world, states)).toBeNull();
  });
});

describe('findPopulatedIslandAt post-merge', () => {
  it("returns the merged identity when clicking inside an absorbed constituent's footprint", () => {
    const a = makeSpec({ id: 'a', cx: 0, cy: 0, majorRadius: 5, minorRadius: 5 });
    const b = makeSpec({ id: 'b', cx: 8, cy: 0, majorRadius: 5, minorRadius: 5 });
    const world = makeWorld([a, b]);
    const states = new Map<string, IslandState>([
      ['a', makeState({ id: 'a' })],
      ['b', makeState({ id: 'b' })],
    ]);
    performMerge(world, states, a, b);
    // World point (8, 0) was inside B's original footprint. After merge,
    // findPopulatedIslandAt should return the merged identity (which is A).
    const hit = findPopulatedIslandAt(8, 0, world.islands);
    expect(hit?.id).toBe('a');
  });
});

describe('multi-merge sequence (A absorbs B, then C)', () => {
  it('after two merges, A carries two extras and overlaps the next neighbor', () => {
    // Linear chain: A at 0, B at 16, C at 22. A is r=14 (~600 tiles), B and
    // C are r=5 (~80 tiles each). A's primary tile footprint touches B but not
    // C, so A absorbs B first (largest combined pair). After that merge, A's
    // union footprint reaches further along the +x axis via the extra at offset
    // 16; that extra's tiles then touch C, enabling the second merge.
    const a = makeSpec({ id: 'a', cx: 0, cy: 0, majorRadius: 14, minorRadius: 14 });
    const b = makeSpec({ id: 'b', cx: 16, cy: 0, majorRadius: 5, minorRadius: 5 });
    const c = makeSpec({ id: 'c', cx: 22, cy: 0, majorRadius: 5, minorRadius: 5 });
    const world = makeWorld([a, b, c]);
    const states = new Map<string, IslandState>([
      ['a', makeState({ id: 'a' })],
      ['b', makeState({ id: 'b' })],
      ['c', makeState({ id: 'c' })],
    ]);
    // First merge: A and B (combined ≈ 600+80) beats B↔C — A's r=14 primary
    // footprint touches B but not C (C's tiles are an ocean gap beyond A's).
    const pair1 = findNextMerge(world, states);
    expect(pair1).not.toBeNull();
    expect([pair1!.absorber.id, pair1!.absorbed.id].sort()).toEqual(['a', 'b']);
    performMerge(world, states, pair1!.absorber, pair1!.absorbed);
    expect(a.extraEllipses?.length).toBe(1);
    // Second merge: A's primary still doesn't reach C, but A's extra at offset
    // (16, 0) now has tile footprint touching C at (22, 0).
    const pair2 = findNextMerge(world, states);
    expect(pair2).not.toBeNull();
    expect([pair2!.absorber.id, pair2!.absorbed.id].sort()).toEqual(['a', 'c']);
    performMerge(world, states, pair2!.absorber, pair2!.absorbed);
    expect(a.extraEllipses?.length).toBe(2);
  });
});

describe('performMerge with absorbed island carrying its own extras', () => {
  it("re-bases each of absorbed's extras into absorber's local frame", () => {
    // Set up: absorbed (B) already carries a single extra ellipse, as if it
    // had previously absorbed something. That extra sits at B-local offset
    // (10, 0), so its world centre is (B.cx + 10, B.cy) = (30, 0). Absorber
    // A is at (0, 0). After A absorbs B:
    //   - B's primary lands at offset (B.cx - A.cx, B.cy - A.cy) = (20, 0).
    //   - B's extra lands at offset (20 + 10, 0 + 0) = (30, 0).
    // The world centre of that extra is preserved (A.cx + 30 = 30) — the
    // round-trip from "B-local → world → A-local" is the identity.
    const a = makeSpec({ id: 'a', cx: 0, cy: 0 });
    const b = makeSpec({
      id: 'b',
      cx: 20,
      cy: 0,
      majorRadius: 5,
      minorRadius: 5,
      extraEllipses: [{ major: 7, minor: 4, rotation: 0, offsetX: 10, offsetY: 0 }],
    });
    const world = makeWorld([a, b]);
    const states = new Map<string, IslandState>([
      ['a', makeState({ id: 'a' })],
      ['b', makeState({ id: 'b' })],
    ]);
    performMerge(world, states, a, b);
    expect(a.extraEllipses).toEqual([
      // First: B's primary as a new extra.
      { biome: 'plains', major: 5, minor: 5, rotation: 0, offsetX: 20, offsetY: 0 },
      // Second: B's pre-existing extra, re-based.
      { biome: 'plains', major: 7, minor: 4, rotation: 0, offsetX: 30, offsetY: 0 },
    ]);
  });
});

describe('islandTileCount', () => {
  it('counts tiles for a single-ellipse island matching the prior behavior', () => {
    const a = makeSpec({ id: 'a', majorRadius: 5, minorRadius: 5 });
    // A r=5 disk inscribes ~50 tiles; assert it's at least 30 (lower bound to
    // tolerate slight strictly-inside variations).
    expect(islandTileCount(a)).toBeGreaterThan(30);
  });

  it('dedupes tiles shared by overlapping constituents (post-merge case)', () => {
    // Two identical constituents on top of each other (offset 0,0) — should
    // not double-count.
    const a = makeSpec({
      id: 'a',
      majorRadius: 5,
      minorRadius: 5,
      extraEllipses: [{ major: 5, minor: 5, rotation: 0, offsetX: 0, offsetY: 0 }],
    });
    const lone = makeSpec({ id: 'b', majorRadius: 5, minorRadius: 5 });
    expect(islandTileCount(a)).toBe(islandTileCount(lone));
  });
});
