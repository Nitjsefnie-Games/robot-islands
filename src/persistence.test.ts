// Persistence: pure serialize/deserialize round-trip tests.
//
// idb-keyval itself is not exercised here — `saveWorld` / `loadWorld`
// touch IndexedDB, which isn't available in vitest's default node env.
// The pure transformations (`serializeWorld` / `deserializeWorld`) carry
// the load-bearing logic and ARE testable in isolation: the IDB wrappers
// just thread JSON through the store.

import { beforeEach, describe, expect, it } from 'vitest';

import { terrainAtForBiome } from './biomes.js';
import type { IslandState } from './economy.js';
import {
  _resetDroneIdCounter,
  nextDroneId,
} from './drones.js';
import {
  _resetRouteIdCounter,
  nextRouteId,
} from './routes.js';
import {
  _resetVehicleIdCounter,
  nextVehicleId,
} from './settlement.js';
import { ALL_RESOURCES, type ResourceId } from './recipes.js';
import {
  SCHEMA_VERSION,
  STORAGE_KEY,
  deserializeWorld,
  serializeWorld,
  type SaveSnapshot,
} from './persistence.js';
import {
  makeInitialIslandState,
  makeInitialWorld,
  type IslandSpec,
} from './world.js';

// ---------------------------------------------------------------------------
// Helpers (mirror the fixtures used by drones/routes tests so the shapes
// are consistent — kept local rather than importing from those test files
// to avoid cross-test-file coupling).
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

function fullCaps(): Record<ResourceId, number> {
  const c = {} as Record<ResourceId, number>;
  for (const r of ALL_RESOURCES) c[r] = 100;
  return c;
}

function makeIslandState(over: Partial<IslandState> = {}): IslandState {
  return {
    id: 'home',
    buildings: [],
    inventory: emptyInv(),
    storageCaps: fullCaps(),
    xp: 0,
    level: 1,
    unspentSkillPoints: 0,
    unlockedNodes: new Set(),
    subPathProgress: new Map(),
    funnelPending: emptyFunnel(),
    specializationRole: null,
    declaredAt: null,
    aiCoreCrafted: false,
    lastTick: 1000,
    ...over,
  };
}

beforeEach(() => {
  _resetDroneIdCounter();
  _resetRouteIdCounter();
  _resetVehicleIdCounter();
});

// ---------------------------------------------------------------------------
// Snapshot shape
// ---------------------------------------------------------------------------

describe('serializeWorld', () => {
  it('produces a snapshot with v: 3 and a savedAt timestamp', () => {
    const world = makeInitialWorld(0);
    const states = new Map<string, IslandState>();
    const snap = serializeWorld(world, states, /* savedAt */ 1_234_567);
    expect(snap.v).toBe(SCHEMA_VERSION);
    expect(snap.v).toBe(3);
    expect(snap.savedAt).toBe(1_234_567);
  });

  it('strips IslandSpec.terrainAt (functions cannot survive JSON)', () => {
    const world = makeInitialWorld(0);
    const snap = serializeWorld(world, new Map(), 0);
    for (const s of snap.world.islands) {
      expect((s as { terrainAt?: unknown }).terrainAt).toBeUndefined();
    }
  });

  it('converts unlockedNodes (Set) to an array', () => {
    const home = makeIslandState({ unlockedNodes: new Set(['mining.1', 'storage.2']) });
    const world = makeInitialWorld(0);
    const states = new Map<string, IslandState>([['home', home]]);
    const snap = serializeWorld(world, states, 0);
    expect(snap.islandStates).toHaveLength(1);
    const entry = snap.islandStates[0]!;
    expect(Array.isArray(entry.state.unlockedNodes)).toBe(true);
    expect(new Set(entry.state.unlockedNodes)).toEqual(new Set(['mining.1', 'storage.2']));
  });

  it('converts subPathProgress (Map) to a list of entries', () => {
    const home = makeIslandState({
      subPathProgress: new Map([
        ['mining', { spent: 3, complete: false }],
        ['storage', { spent: 5, complete: true }],
      ]),
    });
    const world = makeInitialWorld(0);
    const states = new Map<string, IslandState>([['home', home]]);
    const snap = serializeWorld(world, states, 0);
    const entry = snap.islandStates[0]!;
    expect(Array.isArray(entry.state.subPathProgress)).toBe(true);
    const restored = new Map(entry.state.subPathProgress);
    expect(restored.get('mining')).toEqual({ spent: 3, complete: false });
    expect(restored.get('storage')).toEqual({ spent: 5, complete: true });
  });
});

// ---------------------------------------------------------------------------
// Round-trip
// ---------------------------------------------------------------------------

describe('serialize → JSON → deserialize round-trip', () => {
  it('preserves island count, biome, and discovered flag', () => {
    const world = makeInitialWorld(0);
    // Flip discovered on one of the unknown demo islands so the round-trip
    // exercises a non-default value.
    const coast = world.islands.find((s) => s.id === 'coast-unknown')!;
    coast.discovered = true;
    const snap = serializeWorld(world, new Map(), 0);
    const json = JSON.parse(JSON.stringify(snap)) as SaveSnapshot;
    const { world: restored } = deserializeWorld(json, /* nowWallMs */ 0, /* nowPerfMs */ 0);
    expect(restored.islands).toHaveLength(world.islands.length);
    const restoredCoast = restored.islands.find((s) => s.id === 'coast-unknown')!;
    expect(restoredCoast.biome).toBe('coast');
    expect(restoredCoast.discovered).toBe(true);
  });

  it('preserves inventory and aiCoreCrafted across round-trip', () => {
    const home = makeIslandState({
      inventory: { ...emptyInv(), iron_ore: 42, coal: 17, ai_core: 3 },
      aiCoreCrafted: true,
      level: 50,
      xp: 12345.6,
      unspentSkillPoints: 7,
    });
    const world = makeInitialWorld(0);
    const states = new Map<string, IslandState>([['home', home]]);
    const snap = serializeWorld(world, states, 0);
    const json = JSON.parse(JSON.stringify(snap)) as SaveSnapshot;
    const { islandStates: restored } = deserializeWorld(json, 0, 0);
    const r = restored.get('home')!;
    expect(r.inventory.iron_ore).toBe(42);
    expect(r.inventory.coal).toBe(17);
    expect(r.inventory.ai_core).toBe(3);
    expect(r.aiCoreCrafted).toBe(true);
    expect(r.level).toBe(50);
    expect(r.xp).toBeCloseTo(12345.6, 5);
    expect(r.unspentSkillPoints).toBe(7);
  });

  it('restores unlockedNodes back to a Set with identical membership', () => {
    const home = makeIslandState({
      unlockedNodes: new Set(['mining.1', 'mining.2', 'storage.1']),
    });
    const world = makeInitialWorld(0);
    const states = new Map<string, IslandState>([['home', home]]);
    const snap = serializeWorld(world, states, 0);
    const json = JSON.parse(JSON.stringify(snap)) as SaveSnapshot;
    const { islandStates: restored } = deserializeWorld(json, 0, 0);
    const r = restored.get('home')!;
    expect(r.unlockedNodes).toBeInstanceOf(Set);
    expect(r.unlockedNodes.has('mining.1')).toBe(true);
    expect(r.unlockedNodes.has('mining.2')).toBe(true);
    expect(r.unlockedNodes.has('storage.1')).toBe(true);
    expect(r.unlockedNodes.size).toBe(3);
  });

  it('restores subPathProgress back to a Map with identical entries', () => {
    const home = makeIslandState({
      subPathProgress: new Map([
        ['mining', { spent: 4, complete: false }],
        ['transport', { spent: 5, complete: true }],
      ]),
    });
    const world = makeInitialWorld(0);
    const states = new Map<string, IslandState>([['home', home]]);
    const snap = serializeWorld(world, states, 0);
    const json = JSON.parse(JSON.stringify(snap)) as SaveSnapshot;
    const { islandStates: restored } = deserializeWorld(json, 0, 0);
    const r = restored.get('home')!;
    expect(r.subPathProgress).toBeInstanceOf(Map);
    expect(r.subPathProgress.get('mining')).toEqual({ spent: 4, complete: false });
    expect(r.subPathProgress.get('transport')).toEqual({ spent: 5, complete: true });
    expect(r.subPathProgress.size).toBe(2);
  });

  it('rehydrates terrainAt to the same value terrainAtForBiome would return', () => {
    const world = makeInitialWorld(0);
    const snap = serializeWorld(world, new Map(), 0);
    const json = JSON.parse(JSON.stringify(snap)) as SaveSnapshot;
    const { world: restored } = deserializeWorld(json, 0, 0);
    for (const spec of restored.islands) {
      expect(typeof spec.terrainAt).toBe('function');
      // Sample a handful of tiles; the rehydrated closure should match
      // the factory exactly (same biome, same id, same x/y).
      for (const [x, y] of [[0, 0], [1, 2], [-3, 4], [5, -5]] as Array<[number, number]>) {
        const expected = terrainAtForBiome(spec.biome, spec.id, x, y);
        expect(spec.terrainAt!(x, y)).toBe(expected);
      }
    }
  });

  it('preserves IslandSpec.buildings (each placed building round-trips by id and position)', () => {
    const world = makeInitialWorld(0);
    const homeSpec = world.islands.find((s) => s.id === 'home')!;
    const placed = [...homeSpec.buildings];
    const snap = serializeWorld(world, new Map(), 0);
    const json = JSON.parse(JSON.stringify(snap)) as SaveSnapshot;
    const { world: restored } = deserializeWorld(json, 0, 0);
    const restoredHome = restored.islands.find((s) => s.id === 'home')!;
    expect(restoredHome.buildings).toHaveLength(placed.length);
    for (let i = 0; i < placed.length; i++) {
      expect(restoredHome.buildings[i]!.id).toBe(placed[i]!.id);
      expect(restoredHome.buildings[i]!.defId).toBe(placed[i]!.defId);
      expect(restoredHome.buildings[i]!.x).toBe(placed[i]!.x);
      expect(restoredHome.buildings[i]!.y).toBe(placed[i]!.y);
    }
  });

  it('keeps IslandState.buildings === IslandSpec.buildings after restore', () => {
    // The runtime invariant: state.buildings IS the same array reference
    // as spec.buildings so placements push into one and both consumers
    // see it. The deserializer re-establishes this link explicitly.
    const world = makeInitialWorld(0);
    const homeSpec = world.islands.find((s) => s.id === 'home')!;
    const homeState = makeInitialIslandState(homeSpec, 0);
    const states = new Map<string, IslandState>([['home', homeState]]);
    const snap = serializeWorld(world, states, 0);
    const json = JSON.parse(JSON.stringify(snap)) as SaveSnapshot;
    const { world: restored, islandStates: restoredStates } = deserializeWorld(json, 0, 0);
    const rSpec = restored.islands.find((s) => s.id === 'home')!;
    const rState = restoredStates.get('home')!;
    expect(rState.buildings).toBe(rSpec.buildings);
  });
});

// ---------------------------------------------------------------------------
// lastTick remapping (offline catchup)
// ---------------------------------------------------------------------------

describe('lastTick remapping', () => {
  it('shifts lastTick backward by the offline wall-clock delta', () => {
    // Saved 10s ago in wall-clock. Current performance.now() is 5000ms
    // into the page load. We expect lastTick = 5000 - 10_000 = -5000 so
    // the next `advanceIsland(state, performance.now())` integrates a
    // 10-second offline gap.
    const home = makeIslandState({ lastTick: 1_500_000 });
    const world = makeInitialWorld(0);
    const states = new Map<string, IslandState>([['home', home]]);
    const savedAtWallMs = 100_000;
    const snap = serializeWorld(world, states, savedAtWallMs);
    const nowWallMs = savedAtWallMs + 10_000;
    const nowPerfMs = 5_000;
    const { islandStates: restored } = deserializeWorld(snap, nowWallMs, nowPerfMs);
    const r = restored.get('home')!;
    expect(r.lastTick).toBe(nowPerfMs - 10_000);
  });

  it('clamps deltaMs to 0 when wall clock has not moved or moved backward', () => {
    const home = makeIslandState({ lastTick: 1_500_000 });
    const world = makeInitialWorld(0);
    const states = new Map<string, IslandState>([['home', home]]);
    const snap = serializeWorld(world, states, 100_000);
    // Clock moved backward by 1 second — clamp to 0 so we don't manufacture
    // a fake future tick on top of the wall-clock anomaly.
    const { islandStates: restored } = deserializeWorld(snap, 99_000, 8_000);
    expect(restored.get('home')!.lastTick).toBe(8_000);
  });
});

// ---------------------------------------------------------------------------
// Schema version handling
// ---------------------------------------------------------------------------

describe('schema version', () => {
  it('throws on unknown v', () => {
    const home = makeIslandState();
    const world = makeInitialWorld(0);
    const states = new Map<string, IslandState>([['home', home]]);
    const snap = serializeWorld(world, states, 0);
    // Fake a future snapshot.
    const future = { ...snap, v: 99 } as unknown as SaveSnapshot;
    expect(() => deserializeWorld(future, 0, 0)).toThrow(/unknown schema version/);
  });

  it('exports STORAGE_KEY containing v3 so it does not collide with stale v1/v2 saves', () => {
    expect(STORAGE_KEY).toMatch(/v3$/);
  });
});

// ---------------------------------------------------------------------------
// ID counter seeding (drones + routes)
// ---------------------------------------------------------------------------

describe('id counter seeding', () => {
  it('seeds route id counter past the maximum saved route suffix', () => {
    // Build a world with a route whose suffix is 7. After restore, the
    // next allocated route id must be route-8 (not route-1).
    _resetRouteIdCounter();
    const world = makeInitialWorld(0);
    world.routes.push({
      id: 'route-7',
      from: 'home',
      to: 'forest-ne',
      type: 'cargo',
      capacityPerSec: 0.5,
      filter: null,
      priorityList: [],
      transitTimeSec: 10,
      inFlight: [],
    });
    const snap = serializeWorld(world, new Map(), 0);
    const json = JSON.parse(JSON.stringify(snap)) as SaveSnapshot;
    _resetRouteIdCounter(); // simulate a fresh page load
    deserializeWorld(json, 0, 0);
    expect(nextRouteId()).toBe('route-8');
  });

  it('leaves the route id counter alone when no routes are saved', () => {
    _resetRouteIdCounter();
    const world = makeInitialWorld(0);
    const snap = serializeWorld(world, new Map(), 0);
    const json = JSON.parse(JSON.stringify(snap)) as SaveSnapshot;
    deserializeWorld(json, 0, 0);
    // No routes → counter stays at 0 → next is route-1.
    expect(nextRouteId()).toBe('route-1');
  });

  it('seeds drone id counter past the maximum saved drone suffix', () => {
    _resetDroneIdCounter();
    const world = makeInitialWorld(0);
    world.drones.push({
      id: 'drone-12',
      fromIslandId: 'home',
      originX: 0,
      originY: 0,
      dirX: 1,
      dirY: 0,
      outboundTiles: 20,
      scanRadius: 8,
      launchTime: 1000,
      expectedReturnTime: 11_000,
      tier: 2,
      fuelLoaded: 10,
    });
    const snap = serializeWorld(world, new Map(), 0);
    const json = JSON.parse(JSON.stringify(snap)) as SaveSnapshot;
    _resetDroneIdCounter();
    deserializeWorld(json, 0, 0);
    expect(nextDroneId()).toBe('drone-13');
  });

  it('seeds vehicle id counter past the maximum saved vehicle suffix', () => {
    _resetVehicleIdCounter();
    const world = makeInitialWorld(0);
    world.vehicles.push({
      id: 'vehicle-9',
      kind: 'ship',
      tier: 1,
      from: 'home',
      target: 'coast-unknown',
      fuelLoaded: 10,
      foundationKitCount: 1,
      speed: 1,
      launchTime: 1000,
      expectedArrivalTime: 11_000,
      weatherMultiplier: 1.0,
    });
    const snap = serializeWorld(world, new Map(), 0);
    const json = JSON.parse(JSON.stringify(snap)) as SaveSnapshot;
    _resetVehicleIdCounter();
    deserializeWorld(json, 0, 0);
    expect(nextVehicleId()).toBe('vehicle-10');
  });
});

// ---------------------------------------------------------------------------
// Drone + route timestamp remapping — these live in the same
// `performance.now()` domain as lastTick and need the same -deltaMs shift,
// or saved in-flight craft become permanently stuck on reload.
// ---------------------------------------------------------------------------

describe('drone and route timestamp remapping', () => {
  it('shifts drone launchTime and expectedReturnTime across the perf-domain reset', () => {
    // Saved session's perf-time at save = 1_500_000. Drone in flight,
    // 10s from arrival. 15s offline. New session's perf-time is 5_000.
    // perfShift = 5_000 - 1_500_000 - 15_000 = -1_510_000
    // new launchTime = 1_500_000 + perfShift = -10_000
    // new expectedReturnTime = 1_510_000 + perfShift = 0
    // → already in the past at nowPerfMs=5_000, tickDrones resolves it.
    const world = makeInitialWorld(0);
    world.drones.push({
      id: 'drone-1',
      fromIslandId: 'home',
      originX: 0,
      originY: 0,
      dirX: 1,
      dirY: 0,
      outboundTiles: 20,
      scanRadius: 8,
      launchTime: 1_500_000,
      expectedReturnTime: 1_510_000,
      tier: 2,
      fuelLoaded: 10,
    });
    const states = new Map<string, IslandState>();
    const savedAtWallMs = 100_000;
    const savedAtPerfMs = 1_500_000;
    const snap = serializeWorld(world, states, savedAtWallMs, savedAtPerfMs);
    const { world: restored } = deserializeWorld(snap, savedAtWallMs + 15_000, 5_000);
    const d = restored.drones[0]!;
    // The delta between launch and expected-return is preserved.
    expect(d.expectedReturnTime - d.launchTime).toBe(10_000);
    // expectedReturnTime is now in the past relative to nowPerfMs=5_000.
    expect(d.expectedReturnTime).toBeLessThan(5_000);
  });

  it('shifts settlement-vehicle launchTime + expectedArrivalTime across the perf-domain reset', () => {
    // Same setup as the drone case: in-flight vehicle, 10s remaining at
    // save, 15s offline gap, new session perf-time 5_000.
    const world = makeInitialWorld(0);
    world.vehicles.push({
      id: 'vehicle-1',
      kind: 'ship',
      tier: 1,
      from: 'home',
      target: 'coast-unknown',
      fuelLoaded: 10,
      foundationKitCount: 1,
      speed: 1,
      launchTime: 1_500_000,
      expectedArrivalTime: 1_510_000,
      weatherMultiplier: 1.0,
    });
    const states = new Map<string, IslandState>();
    const savedAtWallMs = 100_000;
    const savedAtPerfMs = 1_500_000;
    const snap = serializeWorld(world, states, savedAtWallMs, savedAtPerfMs);
    const { world: restored } = deserializeWorld(snap, savedAtWallMs + 15_000, 5_000);
    const v = restored.vehicles[0]!;
    // Delta between launch and arrival is preserved.
    expect(v.expectedArrivalTime - v.launchTime).toBe(10_000);
    // Arrival is now in the past — next tickVehicles call processes it.
    expect(v.expectedArrivalTime).toBeLessThan(5_000);
  });

  it('shifts route inFlight batch timestamps across the perf-domain reset', () => {
    const world = makeInitialWorld(0);
    world.routes.push({
      id: 'route-1',
      from: 'home',
      to: 'forest-ne',
      type: 'cargo',
      capacityPerSec: 0.5,
      filter: 'iron_ore',
      priorityList: [],
      transitTimeSec: 10,
      inFlight: [
        {
          resourceId: 'iron_ore',
          amount: 5,
          dispatchTime: 1_500_000,
          arrivalTime: 1_510_000,
        },
      ],
    });
    const savedAtWallMs = 100_000;
    const savedAtPerfMs = 1_500_000;
    const snap = serializeWorld(world, new Map(), savedAtWallMs, savedAtPerfMs);
    const { world: restored } = deserializeWorld(snap, savedAtWallMs + 15_000, 5_000);
    const b = restored.routes[0]!.inFlight[0]!;
    // Delta preserved; arrivalTime now in the past (will deliver on next tick).
    expect(b.arrivalTime - b.dispatchTime).toBe(10_000);
    expect(b.arrivalTime).toBeLessThan(5_000);
  });
});

// ---------------------------------------------------------------------------
// Type wiring sanity — make sure the test fixtures actually exercise the
// non-trivial paths (Set, Map, closure rehydration) on a real demo world.
// ---------------------------------------------------------------------------

describe('with a full demo world', () => {
  it('round-trips makeInitialWorld + per-island makeInitialIslandState', () => {
    const world = makeInitialWorld(0);
    const states = new Map<string, IslandState>();
    for (const spec of world.islands) {
      if (!spec.populated) continue;
      states.set(spec.id, makeInitialIslandState(spec, 0));
    }
    const snap = serializeWorld(world, states, 0);
    const json = JSON.parse(JSON.stringify(snap)) as SaveSnapshot;
    const { world: rWorld, islandStates: rStates } = deserializeWorld(json, 0, 0);
    expect(rWorld.islands.length).toBe(world.islands.length);
    expect(rStates.size).toBe(states.size);
    // Verify the home spec (which uses `terrainAtForBiome('plains', 'home', …)`
    // → `defaultTerrainAt`) is restored with a working terrainAt closure.
    const home: IslandSpec = rWorld.islands.find((s) => s.id === 'home')!;
    expect(typeof home.terrainAt).toBe('function');
  });
});
