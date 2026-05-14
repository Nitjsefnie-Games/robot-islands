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
  _resetConstructionCounter,
  nextArtificialId,
} from './construction-ui.js';
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
    ascendantCoreCrafted: false,
    lastResetAt: null,
    timeLockBankedMin: 0,
    accelerationQueue: [],
    accelerationRemainingMin: 0,
    bankingEnabled: false,
    genesisTarget: null,
    singularityStoredWs: 0,
    starterInventoryGrace: {} as Record<ResourceId, number>,
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
    // §3.7 cleanup: the hand-placed `coast-unknown` demo island is no
    // longer auto-seeded. Push a coast spec onto the world manually so
    // the round-trip still exercises a flipped `discovered` flag on a
    // known biome.
    const coast: IslandSpec = {
      id: 'coast-unknown',
      name: 'coast-unknown',
      biome: 'coast',
      cx: 200,
      cy: 0,
      majorRadius: 14,
      minorRadius: 7,
      populated: false,
      discovered: true,
      buildings: [],
      modifiers: [],
    };
    world.islands.push(coast);
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

  it('preserves a grown island radius (§3.4 Land Reclamation Hub mutation)', () => {
    // Simulate a §3.4 expansion: home Plains island grown via Land
    // Reclamation Hub from initial (14,14) to (16,14) — i.e. two +1
    // major expansions. The serializer should preserve the mutated
    // values verbatim (majorRadius / minorRadius are JSON-safe number
    // fields that flow through the JSON spread).
    const world = makeInitialWorld(0);
    const homeSpec = world.islands.find((s) => s.id === 'home')!;
    homeSpec.majorRadius = 16;
    // minorRadius stays at 14 — verifies the spread doesn't accidentally
    // overwrite either field with a default.
    const snap = serializeWorld(world, new Map(), 0);
    const json = JSON.parse(JSON.stringify(snap)) as SaveSnapshot;
    const { world: restored } = deserializeWorld(json, 0, 0);
    const restoredHome = restored.islands.find((s) => s.id === 'home')!;
    expect(restoredHome.majorRadius).toBe(16);
    expect(restoredHome.minorRadius).toBe(14);
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

  it('round-trips §3.6 merged-island extraEllipses geometry', () => {
    // A merged island carries one or more `extraEllipses` entries beyond
    // its primary. Serializing → JSON → deserializing should preserve every
    // entry verbatim so a reloaded session sees the same union footprint.
    const world = makeInitialWorld(0);
    const home = world.islands.find((s) => s.id === 'home')!;
    home.extraEllipses = [
      { major: 5, minor: 5, rotation: 0, offsetX: 20, offsetY: -3 },
      { major: 7, minor: 4, rotation: 0, offsetX: -15, offsetY: 12 },
    ];
    const snap = serializeWorld(world, new Map(), 0);
    const json = JSON.parse(JSON.stringify(snap)) as SaveSnapshot;
    const { world: restored } = deserializeWorld(json, 0, 0);
    const rHome = restored.islands.find((s) => s.id === 'home')!;
    expect(rHome.extraEllipses).toEqual([
      { major: 5, minor: 5, rotation: 0, offsetX: 20, offsetY: -3 },
      { major: 7, minor: 4, rotation: 0, offsetX: -15, offsetY: 12 },
    ]);
  });

  it('preserves single-ellipse islands (no extras) — extraEllipses stays undefined', () => {
    // Round-trip an unmodified demo world. Specs that never had an
    // extraEllipses field should remain field-free (no spurious []).
    const world = makeInitialWorld(0);
    const snap = serializeWorld(world, new Map(), 0);
    const json = JSON.parse(JSON.stringify(snap)) as SaveSnapshot;
    const { world: restored } = deserializeWorld(json, 0, 0);
    for (const s of restored.islands) {
      // Either undefined OR an empty array is fine — both behave identically
      // via `islandConstituents`. The contract is "no surprise data".
      const e = s.extraEllipses;
      expect(e === undefined || (Array.isArray(e) && e.length === 0)).toBe(true);
    }
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
      fuelResource: 'biofuel',
      waypoints: [],
      darkMode: false,
      darkModeDiscoveries: [],
      probabilityBias: 0,
    });
    const snap = serializeWorld(world, new Map(), 0);
    const json = JSON.parse(JSON.stringify(snap)) as SaveSnapshot;
    _resetDroneIdCounter();
    deserializeWorld(json, 0, 0);
    expect(nextDroneId()).toBe('drone-13');
  });

  it('seeds construction id counter past the maximum saved art-N suffix', () => {
    // Reload after generating two artificial islands must not reuse `art-1`.
    _resetConstructionCounter();
    const world = makeInitialWorld(0);
    world.islands.push(
      {
        id: 'art-3',
        name: 'art-3',
        biome: 'plains',
        cx: 60,
        cy: 60,
        majorRadius: 6,
        minorRadius: 6,
        populated: true,
        discovered: true,
        buildings: [],
        modifiers: [],
        artificial: true,
      },
      {
        id: 'art-7',
        name: 'art-7',
        biome: 'desert',
        cx: 80,
        cy: -40,
        majorRadius: 5,
        minorRadius: 5,
        populated: false,
        discovered: true,
        buildings: [],
        modifiers: [],
        artificial: true,
      },
    );
    const snap = serializeWorld(world, new Map(), 0);
    const json = JSON.parse(JSON.stringify(snap)) as SaveSnapshot;
    _resetConstructionCounter(); // simulate a fresh page load
    deserializeWorld(json, 0, 0);
    expect(nextArtificialId()).toBe('art-8');
  });

  it('ignores non-art-N island ids when seeding the construction counter', () => {
    // Demo fixtures like `desert-art-1` or `art-volcanic-1` carry their own
    // suffix shape and must not poison the next `art-N` allocation.
    _resetConstructionCounter();
    const world = makeInitialWorld(0);
    world.islands.push({
      id: 'desert-art-42', // matches /art-\d+/ but NOT /^art-\d+$/
      name: 'desert-art-42',
      biome: 'desert',
      cx: 100,
      cy: 0,
      majorRadius: 4,
      minorRadius: 4,
      populated: false,
      discovered: true,
      buildings: [],
      modifiers: [],
      artificial: true,
    });
    const snap = serializeWorld(world, new Map(), 0);
    const json = JSON.parse(JSON.stringify(snap)) as SaveSnapshot;
    _resetConstructionCounter();
    deserializeWorld(json, 0, 0);
    expect(nextArtificialId()).toBe('art-1');
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
      fuelResource: 'biofuel',
      failureRate: 0.02,
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
      fuelResource: 'biofuel',
      waypoints: [],
      darkMode: false,
      darkModeDiscoveries: [],
      probabilityBias: 0,
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
      fuelResource: 'biofuel',
      failureRate: 0.02,
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

// ---------------------------------------------------------------------------
// §11.7 tier-matched fuelResource — round-trip + legacy backfill
// ---------------------------------------------------------------------------

describe('§11.7 tier-matched fuelResource persistence', () => {
  it('preserves fuelResource on a drone round-trip (non-biofuel fuel)', () => {
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
      launchTime: 0,
      expectedReturnTime: 10_000,
      tier: 3,
      fuelLoaded: 10,
      fuelResource: 'aviation_kerosene',
      waypoints: [],
      darkMode: false,
      darkModeDiscoveries: [],
      probabilityBias: 0,
    });
    const snap = serializeWorld(world, new Map(), 0, 0);
    const json = JSON.parse(JSON.stringify(snap)) as SaveSnapshot;
    const { world: restored } = deserializeWorld(json, 0, 0);
    expect(restored.drones).toHaveLength(1);
    expect(restored.drones[0]!.fuelResource).toBe('aviation_kerosene');
  });

  it('preserves fuelResource on a vehicle round-trip (non-biofuel fuel)', () => {
    const world = makeInitialWorld(0);
    world.vehicles.push({
      id: 'vehicle-1',
      kind: 'helicopter',
      tier: 2,
      from: 'home',
      target: 'forest-ne',
      fuelLoaded: 10,
      foundationKitCount: 1,
      speed: 0.75,
      launchTime: 0,
      expectedArrivalTime: 10_000,
      weatherMultiplier: 0.7,
      fuelResource: 'diesel',
      failureRate: 0.01,
    });
    const snap = serializeWorld(world, new Map(), 0, 0);
    const json = JSON.parse(JSON.stringify(snap)) as SaveSnapshot;
    const { world: restored } = deserializeWorld(json, 0, 0);
    expect(restored.vehicles).toHaveLength(1);
    expect(restored.vehicles[0]!.fuelResource).toBe('diesel');
  });

  it('backfills missing fuelResource on legacy drones to biofuel', () => {
    // Synthesise a legacy v3 snapshot whose drone record predates §11.7 —
    // serialized without a `fuelResource` field. The deserializer must
    // backfill to 'biofuel' (the only fuel grade that the legacy hardcoded
    // dispatch path ever consumed).
    const baseSnap = serializeWorld(makeInitialWorld(0), new Map(), 0, 0);
    // Hand-craft a drone entry without `fuelResource` to simulate the
    // legacy save shape. Type-asserted because the new `Drone` interface
    // requires the field; the persistence loader treats it as missing.
    const legacyDrone = {
      id: 'drone-legacy',
      fromIslandId: 'home',
      originX: 0,
      originY: 0,
      dirX: 1,
      dirY: 0,
      outboundTiles: 20,
      scanRadius: 8,
      launchTime: 0,
      expectedReturnTime: 10_000,
      tier: 2,
      fuelLoaded: 10,
    };
    const legacySnap = {
      ...baseSnap,
      world: {
        ...baseSnap.world,
        drones: [legacyDrone],
      },
    } as unknown as SaveSnapshot;
    const json = JSON.parse(JSON.stringify(legacySnap)) as SaveSnapshot;
    const { world: restored } = deserializeWorld(json, 0, 0);
    expect(restored.drones).toHaveLength(1);
    expect(restored.drones[0]!.fuelResource).toBe('biofuel');
  });

  it('backfills missing fuelResource on legacy vehicles to biofuel', () => {
    const baseSnap = serializeWorld(makeInitialWorld(0), new Map(), 0, 0);
    const legacyVehicle = {
      id: 'vehicle-legacy',
      kind: 'ship',
      tier: 1,
      from: 'home',
      target: 'forest-ne',
      fuelLoaded: 10,
      foundationKitCount: 1,
      speed: 0.25,
      launchTime: 0,
      expectedArrivalTime: 10_000,
      weatherMultiplier: 1.0,
    };
    const legacySnap = {
      ...baseSnap,
      world: {
        ...baseSnap.world,
        vehicles: [legacyVehicle],
      },
    } as unknown as SaveSnapshot;
    const json = JSON.parse(JSON.stringify(legacySnap)) as SaveSnapshot;
    const { world: restored } = deserializeWorld(json, 0, 0);
    expect(restored.vehicles).toHaveLength(1);
    expect(restored.vehicles[0]!.fuelResource).toBe('biofuel');
  });
});

// ---------------------------------------------------------------------------
// §9.7 Tier Reset — lastResetAt round-trip + legacy backfill
// ---------------------------------------------------------------------------

describe('§9.7 Tier Reset lastResetAt persistence', () => {
  it('preserves a numeric lastResetAt through a round-trip', () => {
    const world = makeInitialWorld(0);
    const states = new Map<string, IslandState>([
      [
        'home',
        makeIslandState({ id: 'home', lastResetAt: 12_345_678 }),
      ],
    ]);
    const snap = serializeWorld(world, states, 0, 0);
    const json = JSON.parse(JSON.stringify(snap)) as SaveSnapshot;
    const { islandStates: restored } = deserializeWorld(json, 0, 0);
    expect(restored.get('home')!.lastResetAt).toBe(12_345_678);
  });

  it('preserves null lastResetAt through a round-trip (fresh island)', () => {
    const world = makeInitialWorld(0);
    const states = new Map<string, IslandState>([
      ['home', makeIslandState({ id: 'home', lastResetAt: null })],
    ]);
    const snap = serializeWorld(world, states, 0, 0);
    const json = JSON.parse(JSON.stringify(snap)) as SaveSnapshot;
    const { islandStates: restored } = deserializeWorld(json, 0, 0);
    expect(restored.get('home')!.lastResetAt).toBe(null);
  });

  it('backfills lastResetAt to null on a legacy save without the field', () => {
    // Hand-crafted legacy snapshot: build a normal one, then strip
    // `lastResetAt` from each island-state entry before round-tripping.
    const world = makeInitialWorld(0);
    const states = new Map<string, IslandState>([
      ['home', makeIslandState({ id: 'home', lastResetAt: 99_999 })],
    ]);
    const snap = serializeWorld(world, states, 0, 0);
    // Strip lastResetAt from every island-state to simulate the pre-§9.7
    // save shape.
    const legacy = JSON.parse(JSON.stringify(snap)) as SaveSnapshot;
    for (const entry of legacy.islandStates) {
      delete (entry.state as { lastResetAt?: unknown }).lastResetAt;
    }
    const { islandStates: restored } = deserializeWorld(legacy, 0, 0);
    expect(restored.get('home')!.lastResetAt).toBe(null);
  });
});

// ---------------------------------------------------------------------------
// Player-mutable display name persistence (separate from immutable `id`).
// Mirrors the lastResetAt / ascendantCoreCrafted pattern: schema version is
// NOT bumped — `deserializeWorld` backfills `name = id` on legacy saves.
// ---------------------------------------------------------------------------

describe('IslandSpec.name persistence', () => {
  it('round-trips a custom name through serialize → JSON → deserialize', () => {
    const world = makeInitialWorld(0);
    const home = world.islands.find((s) => s.id === 'home')!;
    // Player-renamed the home island. Internal id stays 'home'; only the
    // display name changes.
    home.name = 'My Cozy Outpost';
    const snap = serializeWorld(world, new Map(), 0);
    const json = JSON.parse(JSON.stringify(snap)) as SaveSnapshot;
    const { world: restored } = deserializeWorld(json, 0, 0);
    const restoredHome = restored.islands.find((s) => s.id === 'home')!;
    expect(restoredHome.name).toBe('My Cozy Outpost');
    // Internal id must be untouched.
    expect(restoredHome.id).toBe('home');
  });

  it('backfills name = id on a legacy save without the field', () => {
    // Hand-crafted legacy snapshot: build a normal one, then strip `name`
    // from each island spec before round-tripping. The deserializer must
    // default missing `name` to the spec's `id` so every UI surface that
    // reads `spec.name` keeps producing the legacy id-as-display-name UX.
    const world = makeInitialWorld(0);
    const snap = serializeWorld(world, new Map(), 0);
    const legacy = JSON.parse(JSON.stringify(snap)) as SaveSnapshot;
    for (const isl of legacy.world.islands) {
      delete (isl as { name?: unknown }).name;
    }
    const { world: restored } = deserializeWorld(legacy, 0, 0);
    for (const spec of restored.islands) {
      expect(spec.name).toBe(spec.id);
    }
  });
});

// ---------------------------------------------------------------------------
// §14.2 satellite buffer backfill
// ---------------------------------------------------------------------------

describe('satellite buffer persistence', () => {
  it('backfills missing buffer on a legacy satellite to []', () => {
    const baseSnap = serializeWorld(makeInitialWorld(0), new Map(), 0, 0);
    const legacySat = {
      id: 'sat-legacy',
      variant: 'scanner',
      spaceportIslandId: 'home',
      x: 0,
      y: 0,
      commRange: 10,
      coverageRadius: 20,
      fuel: 5,
      lodges: { scan: 0, weather: 0, comm: 0 },
      locked: true,
      pendingRepairDroneId: null,
      // buffer is intentionally omitted
    };
    const legacySnap = {
      ...baseSnap,
      world: {
        ...baseSnap.world,
        satellites: [legacySat],
      },
    } as unknown as SaveSnapshot;
    const json = JSON.parse(JSON.stringify(legacySnap)) as SaveSnapshot;
    const { world: restored } = deserializeWorld(json, 0, 0);
    expect(restored.satellites).toHaveLength(1);
    expect(restored.satellites[0]!.buffer).toEqual([]);
  });
});

describe('repair drone persistence', () => {
  it('round-trips repairDrones with all fields preserved', () => {
    const world = makeInitialWorld(0);
    world.repairDrones.push({
      id: 'repair-1',
      targetSatId: 'sat1',
      launchTime: 1234,
      expectedArrivalTime: 5678,
    });
    const snap = serializeWorld(world, new Map(), 0, 0);
    const json = JSON.parse(JSON.stringify(snap)) as SaveSnapshot;
    const { world: restored } = deserializeWorld(json, 0, 0);
    expect(restored.repairDrones).toHaveLength(1);
    const d = restored.repairDrones[0]!;
    expect(d.id).toBe('repair-1');
    expect(d.targetSatId).toBe('sat1');
    expect(d.launchTime).toBe(1234);
    expect(d.expectedArrivalTime).toBe(5678);
  });

  it('backfills missing repairDrones on a legacy save to []', () => {
    const baseSnap = serializeWorld(makeInitialWorld(0), new Map(), 0, 0);
    const legacy = JSON.parse(JSON.stringify(baseSnap)) as SaveSnapshot;
    delete (legacy.world as { repairDrones?: unknown }).repairDrones;
    const { world: restored } = deserializeWorld(legacy, 0, 0);
    expect(restored.repairDrones).toEqual([]);
  });

  it('repairDrones launchTime + expectedArrivalTime are perfShift-ed (§14.12)', () => {
    // Mirrors the drone/vehicle perfShift tests above. Saved session's
    // perf-time at save = 1_500_000. Repair drone in flight, 10s from
    // arrival. 15s offline gap. New session's perf-time is 5_000.
    // perfShift = 5_000 - 1_500_000 - 15_000 = -1_510_000.
    // new launchTime = 1_500_000 + perfShift = -10_000
    // new expectedArrivalTime = 1_510_000 + perfShift = 0
    // → already in the past at nowPerfMs=5_000, the repair tick resolves it.
    const world = makeInitialWorld(0);
    world.repairDrones.push({
      id: 'repair-1',
      targetSatId: 'sat1',
      launchTime: 1_500_000,
      expectedArrivalTime: 1_510_000,
    });
    const states = new Map<string, IslandState>();
    const savedAtWallMs = 100_000;
    const savedAtPerfMs = 1_500_000;
    const snap = serializeWorld(world, states, savedAtWallMs, savedAtPerfMs);
    const { world: restored } = deserializeWorld(snap, savedAtWallMs + 15_000, 5_000);
    const d = restored.repairDrones[0]!;
    // The delta between launch and expected-arrival is preserved.
    expect(d.expectedArrivalTime - d.launchTime).toBe(10_000);
    // expectedArrivalTime is now in the past relative to nowPerfMs=5_000.
    expect(d.expectedArrivalTime).toBeLessThan(5_000);
  });
});

describe('IslandState.declaredAt / lastResetAt perfShift (§9.7)', () => {
  it('IslandState.declaredAt and lastResetAt are perfShift-ed (§9.7 cooldown)', () => {
    // Mirrors the repair-drone / vehicle perfShift tests above. The two
    // fields are minted in the saved session's `performance.now()` domain
    // (matching `lastTick`). On deserialize they must shift into the new
    // session's perf-domain so the 24-hour cooldown gate `nowMs -
    // lastResetAt < TIER_RESET_COOLDOWN_MS` reads a real elapsed value.
    const world = makeInitialWorld(0);
    const states = new Map<string, IslandState>();
    const home = world.islands[0]!;
    const homeState = makeInitialIslandState(home, 1_500_000);
    homeState.declaredAt = 1_502_000; // 2s after lastTick
    homeState.lastResetAt = 1_504_000; // 4s after lastTick
    states.set(homeState.id, homeState);

    const savedAtWallMs = 100_000;
    const savedAtPerfMs = 1_500_000;
    const snap = serializeWorld(world, states, savedAtWallMs, savedAtPerfMs);
    // 15s offline; nowPerfMs in the new session = 5_000.
    // perfShift = 5_000 - 1_500_000 - 15_000 = -1_510_000.
    const { islandStates: restored } = deserializeWorld(
      snap,
      savedAtWallMs + 15_000,
      5_000,
    );
    const r = restored.get(homeState.id)!;
    // declaredAt: 1_502_000 + (-1_510_000) = -8_000
    // lastResetAt: 1_504_000 + (-1_510_000) = -6_000
    expect(r.declaredAt).toBe(-8_000);
    expect(r.lastResetAt).toBe(-6_000);
    // The 2s gap between them is preserved (perfShift is a constant offset).
    expect(r.lastResetAt! - r.declaredAt!).toBe(2_000);
  });

  it('null declaredAt and lastResetAt survive deserialize without perfShift NaN', () => {
    // The null-preservation branch — a fresh island has both fields null.
    // The perfShift remap must NOT poison them into NaN (null + number).
    const world = makeInitialWorld(0);
    const states = new Map<string, IslandState>();
    const home = world.islands[0]!;
    const homeState = makeInitialIslandState(home, 1_500_000);
    expect(homeState.declaredAt).toBeNull();
    expect(homeState.lastResetAt).toBeNull();
    states.set(homeState.id, homeState);

    const snap = serializeWorld(world, states, 100_000, 1_500_000);
    const { islandStates: restored } = deserializeWorld(snap, 115_000, 5_000);
    const r = restored.get(homeState.id)!;
    expect(r.declaredAt).toBeNull();
    expect(r.lastResetAt).toBeNull();
  });
});

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
