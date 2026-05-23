// Persistence: pure serialize/deserialize round-trip tests.
//
// idb-keyval itself is not exercised here — `saveWorld` / `loadWorld`
// touch IndexedDB, which isn't available in vitest's default node env.
// The pure transformations (`serializeWorld` / `deserializeWorld`) carry
// the load-bearing logic and ARE testable in isolation: the IDB wrappers
// just thread JSON through the store.

import { beforeEach, describe, expect, it } from 'vitest';

import { terrainAtForBiome } from './biomes.js';
import { islandInscribedAny } from './island.js';
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
import type { VictoryCondition } from './endgame.js';
import { ALL_RESOURCES, type ResourceId } from './recipes.js';
import type { ObjectiveId } from './tutorial.js';
import type { EdgeId } from './skilltree-graph.js';

import {
  SCHEMA_VERSION,
  STORAGE_KEY,
  STORAGE_KEY_DISPLAY,
  deserializeWorld,
  isValidSaveSnapshot,
  migrateV7toV8,
  serializeWorld,
  type SaveSnapshot,
  type SerializedSnapshotV7,
} from './persistence.js';
import {
  attachTerrainAt,
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
    unlockedEdges: new Set(),
    funnelPending: emptyFunnel(),
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
  it('produces a snapshot with the current schema version and a savedAt timestamp', () => {
    const world = makeInitialWorld(0);
    const states = new Map<string, IslandState>();
    const snap = serializeWorld(world, states, /* savedAt */ 1_234_567);
    expect(snap.v).toBe(SCHEMA_VERSION);
    expect(snap.v).toBe(8);
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

  it('restores unlockedEdges back to a Set with identical membership', () => {
    const home = makeIslandState({
      unlockedEdges: new Set(['e1' as EdgeId, 'e2' as EdgeId]),
    });
    const world = makeInitialWorld(0);
    const states = new Map<string, IslandState>([['home', home]]);
    const snap = serializeWorld(world, states, 0);
    const json = JSON.parse(JSON.stringify(snap)) as SaveSnapshot;
    const { islandStates: restored } = deserializeWorld(json, 0, 0);
    const r = restored.get('home')!;
    expect(r.unlockedEdges).toBeInstanceOf(Set);
    expect(r.unlockedEdges.has('e1' as EdgeId)).toBe(true);
    expect(r.unlockedEdges.has('e2' as EdgeId)).toBe(true);
    expect(r.unlockedEdges.size).toBe(2);
  });

  it('rehydrates terrainAt to the same value terrainAtForBiome would return', () => {
    const world = makeInitialWorld(0);
    const snap = serializeWorld(world, new Map(), 0);
    const json = JSON.parse(JSON.stringify(snap)) as SaveSnapshot;
    const { world: restored } = deserializeWorld(json, 0, 0);
    for (const spec of restored.islands) {
      expect(typeof spec.terrainAt).toBe('function');
      // Sample a handful of tiles; the rehydrated closure should match
      // the factory exactly (same biome, same id, same x/y, same inscription
      // predicate — bound to the live spec so §3.6 extraEllipses are seen).
      for (const [x, y] of [[0, 0], [1, 2], [-3, 4], [5, -5]] as Array<[number, number]>) {
        const expected = terrainAtForBiome(spec.biome, spec.id, x, y, (px, py) =>
          islandInscribedAny(spec, px, py),
        );
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

  it('rehydrated terrainAt on a procedural spec with extras matches the original', () => {
    // The existing "rehydrates terrainAt …" round-trip test at :286 only
    // exercises home, where `terrainAtForBiome` short-circuits on
    // `islandId === 'home'` and never consults the inscription predicate.
    // This test covers the OTHER branch: a non-home procedural spec with a
    // §3.6 extra ellipse, where the rehydrated closure's predicate path is
    // the actual load-bearing thing.
    //
    // The probe (24, 0) mirrors the I3 by-reference test: cluster cell
    // (8, 0) sits fully outside the primary r=14 ellipse and fully inside
    // an extra at offset (22, 0) with semi-axes (8, 8). The hash for id
    // `'closure-ref-test'` on cell (8, 0) lands rare (≈0.0053 < 0.12), so
    // the cell only emits a non-default tile when the inscription predicate
    // is consulted AND sees the extra ellipse. If a future regression drops
    // `extraEllipses` before binding the rehydrated closure (or binds the
    // closure to a snapshot instead of the live spec), the rehydrated
    // terrainAt would demote to default and the assertion would fail.
    const world = makeInitialWorld(0);
    const procedural = attachTerrainAt({
      id: 'closure-ref-test',
      name: 'closure-ref-test',
      biome: 'plains',
      cx: 200,
      cy: 200,
      majorRadius: 14,
      minorRadius: 14,
      populated: false,
      discovered: true, // discovered so it survives round-trip without special handling
      buildings: [],
      modifiers: [],
      extraEllipses: [
        { major: 8, minor: 8, rotation: 0, offsetX: 22, offsetY: 0 },
      ],
    });
    world.islands.push(procedural);
    const probeX = 24;
    const probeY = 0;
    const expected = procedural.terrainAt!(probeX, probeY);
    // Discrimination guard — if the cell stops being a rare-roll cell, the
    // assertions below pass vacuously (every tile = default). Force the
    // test to fail loudly so a maintainer picks a fresh probe.
    expect(
      expected,
      'I4 probe cell must hash rare or the test is vacuous',
    ).not.toBe('grass');
    const snap = serializeWorld(world, new Map(), 0);
    const json = JSON.parse(JSON.stringify(snap)) as SaveSnapshot;
    const { world: restored } = deserializeWorld(json, 0, 0);
    const rSpec = restored.islands.find((s) => s.id === 'closure-ref-test')!;
    // The rehydrated extra MUST round-trip into the same shape that
    // attachTerrainAt's predicate consults — verify the field survives.
    expect(rSpec.extraEllipses).toEqual([
      { major: 8, minor: 8, rotation: 0, offsetX: 22, offsetY: 0 },
    ]);
    // The load-bearing assertion: the rehydrated closure agrees with the
    // pre-serialization closure at the probe AND at every sibling tile of
    // the 3×3 cluster cell. Any mismatch points at the predicate path —
    // either the closure isn't bound to the live spec, or extras dropped
    // before binding.
    for (let dy = 0; dy < 3; dy++) {
      for (let dx = 0; dx < 3; dx++) {
        const x = 24 + dx;
        const y = 0 + dy;
        expect(
          rSpec.terrainAt!(x, y),
          `(${x},${y}) drift after round-trip`,
        ).toBe(procedural.terrainAt!(x, y));
      }
    }
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
    expect(() => deserializeWorld(future, 0, 0)).toThrow(/not supported/);
  });

  it('exports STORAGE_KEY containing v7 so it does not collide with stale saves', () => {
    expect(STORAGE_KEY).toMatch(/v8$/);
  });

  it('exports a STORAGE_KEY_DISPLAY decoupled from the IDB key', () => {
    expect(STORAGE_KEY).not.toBe(STORAGE_KEY_DISPLAY);
    expect(typeof STORAGE_KEY).toBe('string');
    expect(typeof STORAGE_KEY_DISPLAY).toBe('string');
    expect(STORAGE_KEY_DISPLAY).toBe('robot-islands:save');
  });

  it('rejects a synthetic future version via the SCHEMA_VERSION gate', () => {
    const world = makeInitialWorld(0);
    const snap = serializeWorld(world, new Map(), 0);
    const futureShaped = { ...snap, v: 99 } as unknown as SaveSnapshot;
    expect(() => deserializeWorld(futureShaped, 0, 0)).toThrow(/not supported/);
    expect(isValidSaveSnapshot(futureShaped)).toBe(false);
  });

  it('rejects a v3-shaped snapshot (the §2.1 infinite-map bump is breaking)', () => {
    // A blob from the previous schema can't be migrated — the new generator
    // (density 0.08, overlap 16) would produce different procedural specs in
    // any unrevealed cell while the saved discovered-but-not-populated specs
    // would pin stale geometry. Reject so `loadWorld` falls back to a fresh
    // world via the `stored.v !== SCHEMA_VERSION` short-circuit.
    const world = makeInitialWorld(0);
    const snap = serializeWorld(world, new Map(), 0);
    const v3Shaped = { ...snap, v: 3 } as unknown as SaveSnapshot;
    expect(() => deserializeWorld(v3Shaped, 0, 0)).toThrow(/not supported/);
  });
});

// ---------------------------------------------------------------------------
// §2.1 infinite map — `generatedCells` round-trip
// ---------------------------------------------------------------------------

describe('§2.1 generatedCells persistence', () => {
  it('round-trips an explicit generatedCells set through serialize → JSON → deserialize', () => {
    const world = makeInitialWorld(0);
    // Seed an arbitrary cell beyond the boot extent so the round-trip can't
    // be conflated with the populated-cell union backfill.
    world.generatedCells = new Set(['100,-50', '0,0', '-3,4']);
    const snap = serializeWorld(world, new Map(), 0);
    expect(snap.world.generatedCells).toEqual(['-3,4', '0,0', '100,-50']);
    const json = JSON.parse(JSON.stringify(snap)) as SaveSnapshot;
    const { world: restored } = deserializeWorld(json, 0, 0);
    expect(restored.generatedCells).toBeDefined();
    // Restored set is a superset (the backfill unions in populated cells)
    // but must contain every cell we explicitly saved.
    for (const key of ['100,-50', '0,0', '-3,4']) {
      expect(restored.generatedCells!.has(key)).toBe(true);
    }
  });

  it('backfills home cell when generatedCells is missing from the saved blob', () => {
    const world = makeInitialWorld(0);
    const snap = serializeWorld(world, new Map(), 0);
    // Strip the field as a legacy-shape simulation.
    const stripped = {
      ...snap,
      world: { ...snap.world, generatedCells: undefined },
    } as SaveSnapshot;
    const { world: restored } = deserializeWorld(stripped, 0, 0);
    // Home sits at tile (0, 0); cell (0, 0) must be marked generated so the
    // lazy hook doesn't try to re-roll an island into the player's home cell.
    expect(restored.generatedCells!.has('0,0')).toBe(true);
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
      mode: 'priority',
      cargo: [],
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
      mode: 'priority',
      cargo: [{ resourceId: 'iron_ore' }],
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

});

// ---------------------------------------------------------------------------
// §9.7 Tier Reset — lastResetAt round-trip
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

});

// ---------------------------------------------------------------------------
// Player-mutable display name persistence (separate from immutable `id`).
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

// ---------------------------------------------------------------------------
// WorldState-level fields round-trip
// ---------------------------------------------------------------------------

describe('WorldState-level fields round-trip', () => {
  it('preserves endgameState (achieved Set, firstAchievedMs)', () => {
    const world = makeInitialWorld(0);
    world.endgameState = {
      achieved: new Set<VictoryCondition>(['genesis_cell_crafted', 'ascendant_core_crafted']),
      firstAchievedMs: 12_345,
    };
    const snap = serializeWorld(world, new Map(), 0, 0);
    const json = JSON.parse(JSON.stringify(snap)) as SaveSnapshot;
    const { world: restored } = deserializeWorld(json, 0, 0);
    expect(restored.endgameState.achieved).toBeInstanceOf(Set);
    expect(restored.endgameState.achieved.has('genesis_cell_crafted')).toBe(true);
    expect(restored.endgameState.achieved.has('ascendant_core_crafted')).toBe(true);
    expect(restored.endgameState.achieved.has('omniscient_lattice_active')).toBe(false);
    expect(restored.endgameState.achieved.size).toBe(2);
    expect(restored.endgameState.firstAchievedMs).toBe(12_345);
  });

  it('preserves latticeActive and latticeNodeIslands', () => {
    const world = makeInitialWorld(0);
    world.latticeActive = true;
    world.latticeNodeIslands = ['home', 'forest-ne'];
    const snap = serializeWorld(world, new Map(), 0, 0);
    const json = JSON.parse(JSON.stringify(snap)) as SaveSnapshot;
    const { world: restored } = deserializeWorld(json, 0, 0);
    expect(restored.latticeActive).toBe(true);
    expect(restored.latticeNodeIslands).toEqual(['home', 'forest-ne']);
  });

  it('preserves tutorialState (completed Set and current)', () => {
    const world = makeInitialWorld(0);
    world.tutorialState = {
      completed: new Set<ObjectiveId>(['place_solar', 'place_mine', 'reach_level_5']),
      current: 'build_dronepad',
    };
    const snap = serializeWorld(world, new Map(), 0, 0);
    const json = JSON.parse(JSON.stringify(snap)) as SaveSnapshot;
    const { world: restored } = deserializeWorld(json, 0, 0);
    expect(restored.tutorialState!.completed).toBeInstanceOf(Set);
    expect(restored.tutorialState!.completed.has('place_solar')).toBe(true);
    expect(restored.tutorialState!.completed.has('place_mine')).toBe(true);
    expect(restored.tutorialState!.completed.has('reach_level_5')).toBe(true);
    expect(restored.tutorialState!.completed.size).toBe(3);
    expect(restored.tutorialState!.current).toBe('build_dronepad');
  });

  it('preserves revealedCells as a Set of cell keys', () => {
    const world = makeInitialWorld(0);
    world.revealedCells = new Set(['0,0', '1,0', '2,0', '0,1']);
    const snap = serializeWorld(world, new Map(), 0, 0);
    const json = JSON.parse(JSON.stringify(snap)) as SaveSnapshot;
    const { world: restored } = deserializeWorld(json, 0, 0);
    expect(restored.revealedCells).toBeInstanceOf(Set);
    expect(restored.revealedCells.has('0,0')).toBe(true);
    expect(restored.revealedCells.has('1,0')).toBe(true);
    expect(restored.revealedCells.has('2,0')).toBe(true);
    expect(restored.revealedCells.has('0,1')).toBe(true);
    // deserializeRevealedCells also re-seeds cells from populated/discovered
    // islands, so the total size may be larger than the 4 explicit cells.
    expect(restored.revealedCells.size).toBeGreaterThanOrEqual(4);
  });
});

// ---------------------------------------------------------------------------
// IslandState Time Lock state round-trip
// ---------------------------------------------------------------------------

describe('IslandState Time Lock state round-trip', () => {
  it('preserves timeLockBankedMin, accelerationQueue, accelerationRemainingMin, and bankingEnabled', () => {
    const home = makeIslandState({
      timeLockBankedMin: 120,
      accelerationQueue: [{ sourceIslandId: 'home', durationMin: 5 }, { sourceIslandId: 'forest-ne', durationMin: 10 }],
      accelerationRemainingMin: 7.5,
      bankingEnabled: true,
    });
    const world = makeInitialWorld(0);
    const states = new Map<string, IslandState>([['home', home]]);
    const snap = serializeWorld(world, states, 0, 0);
    const json = JSON.parse(JSON.stringify(snap)) as SaveSnapshot;
    const { islandStates: restored } = deserializeWorld(json, 0, 0);
    const r = restored.get('home')!;
    expect(r.timeLockBankedMin).toBe(120);
    expect(r.accelerationQueue).toEqual([{ sourceIslandId: 'home', durationMin: 5 }, { sourceIslandId: 'forest-ne', durationMin: 10 }]);
    expect(r.accelerationRemainingMin).toBe(7.5);
    expect(r.bankingEnabled).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// ---------------------------------------------------------------------------
// PlacedBuilding flags round-trip
// ---------------------------------------------------------------------------

describe('PlacedBuilding flags round-trip', () => {
  it('preserves cargoLabel on a generic-storage building', () => {
    const world = makeInitialWorld(0);
    const home = world.islands.find((s) => s.id === 'home')!;
    home.buildings.push({ id: 'crate-1', defId: 'crate', x: 5, y: 5, cargoLabel: 'iron_ingot' });
    const snap = serializeWorld(world, new Map(), 0, 0);
    const json = JSON.parse(JSON.stringify(snap)) as SaveSnapshot;
    const { world: restored } = deserializeWorld(json, 0, 0);
    const restoredHome = restored.islands.find((s) => s.id === 'home')!;
    const crate = restoredHome.buildings.find((b) => b.id === 'crate-1')!;
    expect(crate.cargoLabel).toBe('iron_ingot');
  });

  it('preserves eternalServitor flag', () => {
    const world = makeInitialWorld(0);
    const home = world.islands.find((s) => s.id === 'home')!;
    home.buildings.push({ id: 'solar-99', defId: 'solar', x: 3, y: 3, eternalServitor: true });
    const snap = serializeWorld(world, new Map(), 0, 0);
    const json = JSON.parse(JSON.stringify(snap)) as SaveSnapshot;
    const { world: restored } = deserializeWorld(json, 0, 0);
    const restoredHome = restored.islands.find((s) => s.id === 'home')!;
    const solar = restoredHome.buildings.find((b) => b.id === 'solar-99')!;
    expect(solar.eternalServitor).toBe(true);
  });

  it('preserves toxicityExpiryMs on a chemical_reactor', () => {
    const world = makeInitialWorld(0);
    const home = world.islands.find((s) => s.id === 'home')!;
    home.buildings.push({ id: 'reactor-1', defId: 'chemical_reactor', x: 3, y: 3, toxicityExpiryMs: 1_234_567 });
    const snap = serializeWorld(world, new Map(), 0, 0);
    const json = JSON.parse(JSON.stringify(snap)) as SaveSnapshot;
    const { world: restored } = deserializeWorld(json, 0, 0);
    const restoredHome = restored.islands.find((s) => s.id === 'home')!;
    const r = restoredHome.buildings.find((b) => b.id === 'reactor-1')!;
    expect(r.toxicityExpiryMs).toBe(1_234_567);
  });

  it('leaves undefined toxicityExpiryMs as undefined', () => {
    const world = makeInitialWorld(0);
    const home = world.islands.find((s) => s.id === 'home')!;
    home.buildings.push({ id: 'reactor-2', defId: 'chemical_reactor', x: 4, y: 4 });
    const snap = serializeWorld(world, new Map(), 0, 0);
    const json = JSON.parse(JSON.stringify(snap)) as SaveSnapshot;
    const { world: restored } = deserializeWorld(json, 0, 0);
    const restoredHome = restored.islands.find((s) => s.id === 'home')!;
    const r = restoredHome.buildings.find((b) => b.id === 'reactor-2')!;
    expect(r.toxicityExpiryMs).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// PlacedBuilding maintenance timestamp perfShift
// ---------------------------------------------------------------------------

describe('PlacedBuilding placedAt / maintainedAt perfShift', () => {
  it('shifts placedAt and maintainedAt across the perf-domain reset', () => {
    const world = makeInitialWorld(0);
    const home = world.islands.find((s) => s.id === 'home')!;
    home.buildings.push({
      id: 'mine-1',
      defId: 'mine',
      x: 2,
      y: 2,
      placedAt: 1_500_000,
      maintainedAt: 1_505_000,
    });
    const states = new Map<string, IslandState>();
    const savedAtWallMs = 100_000;
    const savedAtPerfMs = 1_500_000;
    const snap = serializeWorld(world, states, savedAtWallMs, savedAtPerfMs);
    const { world: restored } = deserializeWorld(snap, savedAtWallMs + 15_000, 5_000);
    const restoredHome = restored.islands.find((s) => s.id === 'home')!;
    const b = restoredHome.buildings.find((bld) => bld.id === 'mine-1')!;
    // perfShift = 5_000 - 1_500_000 - 15_000 = -1_510_000
    expect(b.placedAt).toBe(-10_000);
    expect(b.maintainedAt).toBe(-5_000);
    expect(b.maintainedAt! - b.placedAt!).toBe(5_000);
  });

  it('leaves undefined placedAt / maintainedAt as undefined', () => {
    const world = makeInitialWorld(0);
    const home = world.islands.find((s) => s.id === 'home')!;
    home.buildings.push({ id: 'solar-1', defId: 'solar', x: 1, y: 1 });
    const states = new Map<string, IslandState>();
    const snap = serializeWorld(world, states, 100_000, 1_500_000);
    const { world: restored } = deserializeWorld(snap, 115_000, 5_000);
    const restoredHome = restored.islands.find((s) => s.id === 'home')!;
    const b = restoredHome.buildings.find((bld) => bld.id === 'solar-1')!;
    expect(b.placedAt).toBeUndefined();
    expect(b.maintainedAt).toBeUndefined();
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

// ---------------------------------------------------------------------------
// §14.8 debrisFields round-trip
// ---------------------------------------------------------------------------

describe('debrisFields persistence', () => {
  it('round-trips empty debrisFields', () => {
    const world = makeInitialWorld(0);
    const snap = serializeWorld(world, new Map(), 0, 0);
    const json = JSON.parse(JSON.stringify(snap)) as SaveSnapshot;
    const { world: restored } = deserializeWorld(json, 0, 0);
    expect(restored.debrisFields).toEqual([]);
  });

  it('round-trips debrisFields with 2-3 fields', () => {
    const world = makeInitialWorld(0);
    world.debrisFields.push(
      { cellX: 1, cellY: 2, fragments: 20 },
      { cellX: -3, cellY: 4, fragments: 10 },
      { cellX: 0, cellY: 0, fragments: 55 },
    );
    const snap = serializeWorld(world, new Map(), 0, 0);
    const json = JSON.parse(JSON.stringify(snap)) as SaveSnapshot;
    const { world: restored } = deserializeWorld(json, 0, 0);
    expect(restored.debrisFields).toHaveLength(3);
    expect(restored.debrisFields[0]).toEqual({ cellX: 1, cellY: 2, fragments: 20 });
    expect(restored.debrisFields[1]).toEqual({ cellX: -3, cellY: 4, fragments: 10 });
    expect(restored.debrisFields[2]).toEqual({ cellX: 0, cellY: 0, fragments: 55 });
  });

});

// ---------------------------------------------------------------------------
// §14.6 satellite movingTo round-trip
// ---------------------------------------------------------------------------

describe('satellite movingTo persistence', () => {
  it('round-trips a satellite with movingTo set', () => {
    const world = makeInitialWorld(0);
    world.satellites.push({
      id: 'sat1',
      variant: 'scanner',
      spaceportIslandId: 'home',
      x: 0,
      y: 0,
      commRange: 200,
      coverageRadius: 400,
      fuel: 80,
      lodges: { scan: 0, weather: 0, comm: 0 },
      locked: false,
      pendingRepairDroneId: null,
      buffer: [],
      movingTo: { x: 100, y: 200, arrivalMs: 12_345 },
    });
    const snap = serializeWorld(world, new Map(), 0, 0);
    const json = JSON.parse(JSON.stringify(snap)) as SaveSnapshot;
    const { world: restored } = deserializeWorld(json, 0, 0);
    expect(restored.satellites).toHaveLength(1);
    const sat = restored.satellites[0]!;
    expect(sat.movingTo).toEqual({ x: 100, y: 200, arrivalMs: 12_345 });
    expect(sat.locked).toBe(false);
  });

  it('round-trips a satellite without movingTo (stationary)', () => {
    const world = makeInitialWorld(0);
    world.satellites.push({
      id: 'sat2',
      variant: 'relay',
      spaceportIslandId: 'home',
      x: 50,
      y: 50,
      commRange: 500,
      coverageRadius: 0,
      fuel: 100,
      lodges: { scan: 0, weather: 0, comm: 0 },
      locked: true,
      pendingRepairDroneId: null,
      buffer: [],
    });
    const snap = serializeWorld(world, new Map(), 0, 0);
    const json = JSON.parse(JSON.stringify(snap)) as SaveSnapshot;
    const { world: restored } = deserializeWorld(json, 0, 0);
    expect(restored.satellites).toHaveLength(1);
    const sat = restored.satellites[0]!;
    expect(sat.movingTo).toBeUndefined();
    expect(sat.locked).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// §14.5 Scanner Sat dwellByCellKey round-trip
// ---------------------------------------------------------------------------

describe('§14.5 scanner dwellByCellKey persistence', () => {
  it('round-trips a Scanner Sat with dwellByCellKey', () => {
    const world = makeInitialWorld(0);
    world.satellites.push({
      id: 'sat1',
      variant: 'scanner',
      spaceportIslandId: 'home',
      x: 0,
      y: 0,
      commRange: 200,
      coverageRadius: 400,
      fuel: 100,
      lodges: { scan: 0, weather: 0, comm: 0 },
      locked: true,
      pendingRepairDroneId: null,
      buffer: [],
      dwellByCellKey: { '0,0': 60000, '1,0': 30000 },
    });
    const snap = serializeWorld(world, new Map(), 0, 0);
    const json = JSON.parse(JSON.stringify(snap)) as SaveSnapshot;
    const { world: restored } = deserializeWorld(json, 0, 0);
    expect(restored.satellites).toHaveLength(1);
    const sat = restored.satellites[0]!;
    expect(sat.dwellByCellKey).toEqual({ '0,0': 60000, '1,0': 30000 });
  });

  it('defaults dwellByCellKey to undefined on legacy saves without the field', () => {
    const world = makeInitialWorld(0);
    world.satellites.push({
      id: 'sat1',
      variant: 'scanner',
      spaceportIslandId: 'home',
      x: 0,
      y: 0,
      commRange: 200,
      coverageRadius: 400,
      fuel: 100,
      lodges: { scan: 0, weather: 0, comm: 0 },
      locked: true,
      pendingRepairDroneId: null,
      buffer: [],
    });
    const snap = serializeWorld(world, new Map(), 0, 0);
    const json = JSON.parse(JSON.stringify(snap)) as SaveSnapshot;
    // Strip dwellByCellKey to simulate a pre-§14.5 save.
    for (const sat of (json.world as unknown as { satellites: Array<{ dwellByCellKey?: unknown }> }).satellites) {
      delete sat.dwellByCellKey;
    }
    const { world: restored } = deserializeWorld(json, 0, 0);
    expect(restored.satellites[0]!.dwellByCellKey).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// §14.4 commPackets persistence
// ---------------------------------------------------------------------------

describe('§14.4 commPackets persistence', () => {
  it('round-trips empty commPackets', () => {
    const world = makeInitialWorld(0);
    expect(world.commPackets).toEqual([]);
    const snap = serializeWorld(world, new Map(), 0, 0);
    const json = JSON.parse(JSON.stringify(snap)) as SaveSnapshot;
    const { world: restored } = deserializeWorld(json, 0, 0);
    expect(restored.commPackets).toEqual([]);
  });

  it('round-trips commPackets with one packet', () => {
    const world = makeInitialWorld(0);
    world.commPackets.push({
      id: 'pkt-1',
      payload: { type: 'discovery', payload: { islandId: 'remote' } },
      currentNodeId: 'satA',
      originSatId: 'satA',
      generatedMs: 1234,
    });
    const snap = serializeWorld(world, new Map(), 0, 0);
    const json = JSON.parse(JSON.stringify(snap)) as SaveSnapshot;
    const { world: restored } = deserializeWorld(json, 0, 0);
    expect(restored.commPackets).toHaveLength(1);
    const pkt = restored.commPackets[0]!;
    expect(pkt.id).toBe('pkt-1');
    expect(pkt.payload).toEqual({ type: 'discovery', payload: { islandId: 'remote' } });
    expect(pkt.currentNodeId).toBe('satA');
    expect(pkt.originSatId).toBe('satA');
    expect(pkt.generatedMs).toBe(1234);
  });

});

// ---------------------------------------------------------------------------
// Ocean-layer §2 — oceanCells round-trip
// ---------------------------------------------------------------------------

describe('oceanCells round-trip', () => {
  it('v7 saves roundtrip cleanly (oceanCells + depthRevealedCells preserved)', () => {
    const world = makeInitialWorld(0);
    // Add a couple of explicit depth reveals so the round-trip exercises
    // a non-empty Set (the fresh world starts with an empty depth set).
    world.depthRevealedCells.add('5,-3');
    world.depthRevealedCells.add('0,0');
    const snap = serializeWorld(world, new Map(), 0);
    const json = JSON.parse(JSON.stringify(snap)) as SaveSnapshot;
    const { world: restored } = deserializeWorld(json, 0, 0);
    // oceanCells survive verbatim.
    expect(restored.oceanCells.size).toBe(world.oceanCells.size);
    for (const [k, v] of world.oceanCells) {
      expect(restored.oceanCells.get(k)).toEqual(v);
    }
    // depthRevealedCells survives verbatim.
    expect(restored.depthRevealedCells).toEqual(new Set(['5,-3', '0,0']));
  });

  it('serialized oceanCells is sorted by key (deterministic save blob)', () => {
    const world = makeInitialWorld(0);
    const snap = serializeWorld(world, new Map(), 0);
    const keys = (snap.world.oceanCells ?? []).map(([k]) => k);
    const sorted = [...keys].sort();
    expect(keys).toEqual(sorted);
  });
});


describe('persistence — tileOverrides round-trip (schema 7)', () => {
  it('survives serializeWorld → deserializeWorld unchanged', () => {
    const world = makeInitialWorld(0); // existing test fixture
    const homeSpec = world.islands.find((s) => s.id === 'home');
    expect(homeSpec).toBeDefined();
    (homeSpec as IslandSpec).tileOverrides = {
      '1,1': 'magma_vent',
      '-3,4': 'uranium_vein',
    };
    const states = new Map<string, IslandState>();
    states.set('home', makeInitialIslandState(homeSpec!, 0));
    const snap = serializeWorld(world, states, 1_700_000_000_000, 0);
    expect(snap.v).toBe(8);
    const { world: rehydrated } = deserializeWorld(snap, 1_700_000_000_000, 0);
    const rh = rehydrated.islands.find((s) => s.id === 'home');
    expect(rh?.tileOverrides).toEqual({
      '1,1': 'magma_vent',
      '-3,4': 'uranium_vein',
    });
    // And the closure observes them.
    expect(rh?.terrainAt?.(1, 1)).toBe('magma_vent');
    expect(rh?.terrainAt?.(-3, 4)).toBe('uranium_vein');
  });
});

describe('migrateV7toV8', () => {
  it('preserves identity fields and resets progression', () => {
    const v7: SerializedSnapshotV7 = {
      v: 7,
      savedAt: 100000,
      savedAtPerf: 95000,
      world: {
        islands: [],
        drones: [],
        routes: [],
        vehicles: [],
        satellites: [],
        repairDrones: [],
        debrisFields: [],
        commPackets: [],
      },
      islandStates: [
        {
          id: 'island-a',
          state: {
            id: 'island-a',
            buildings: [],
            inventory: { iron_ore: 50 },
            storageCaps: {},
            funnelPending: {},
            starterInventoryGrace: {},
            xp: 8500,
            level: 12,
            unspentSkillPoints: 2,
            unlockedNodes: ['mining.1', 'mining.2', 'forestry.1'],
            subPathProgress: [['mining', { spent: 3, complete: false }]],
            specializationRole: 'foundry',
            declaredAt: null,
            lastResetAt: null,
            lastTick: 95000,
            aiCoreCrafted: false,
            ascendantCoreCrafted: false,
            timeLockBankedMin: 0,
            accelerationQueue: [],
            accelerationRemainingMin: 0,
            bankingEnabled: false,
            genesisTarget: null,
            singularityStoredWs: 0,
          } as unknown as import('./persistence.js').SerializedIslandStateV7,
        },
      ],
    };

    const v8 = migrateV7toV8(v7);

    expect(v8.v).toBe(8);
    expect(v8.islandStates[0]!.state.level).toBe(12);
    expect(v8.islandStates[0]!.state.xp).toBe(8500);
    expect(v8.islandStates[0]!.state.inventory).toEqual({ iron_ore: 50 });
    expect(v8.islandStates[0]!.state.unlockedNodes).toEqual([]);
    expect(v8.islandStates[0]!.state.unlockedEdges).toEqual([]);
    expect(v8.islandStates[0]!.state.unspentSkillPoints).toBe(11);
    expect((v8.islandStates[0]!.state as any).subPathProgress).toBeUndefined();
    expect((v8.islandStates[0]!.state as any).specializationRole).toBeUndefined();
  });

  it('recomputes unspentSkillPoints as max(0, level - 1)', () => {
    const v7: SerializedSnapshotV7 = {
      v: 7,
      savedAt: 0,
      savedAtPerf: 0,
      world: {
        islands: [],
        drones: [],
        routes: [],
        vehicles: [],
        satellites: [],
        repairDrones: [],
        debrisFields: [],
        commPackets: [],
      },
      islandStates: [
        {
          id: 'a',
          state: {
            id: 'a',
            buildings: [],
            inventory: {},
            storageCaps: {},
            funnelPending: {},
            starterInventoryGrace: {},
            xp: 0,
            level: 1,
            unspentSkillPoints: 999,
            unlockedNodes: [],
            subPathProgress: [],
            specializationRole: null,
            declaredAt: null,
            lastResetAt: null,
            lastTick: 0,
            aiCoreCrafted: false,
            ascendantCoreCrafted: false,
            timeLockBankedMin: 0,
            accelerationQueue: [],
            accelerationRemainingMin: 0,
            bankingEnabled: false,
            genesisTarget: null,
            singularityStoredWs: 0,
          } as unknown as import('./persistence.js').SerializedIslandStateV7,
        },
        {
          id: 'b',
          state: {
            id: 'b',
            buildings: [],
            inventory: {},
            storageCaps: {},
            funnelPending: {},
            starterInventoryGrace: {},
            xp: 0,
            level: 50,
            unspentSkillPoints: 0,
            unlockedNodes: [],
            subPathProgress: [],
            specializationRole: null,
            declaredAt: null,
            lastResetAt: null,
            lastTick: 0,
            aiCoreCrafted: false,
            ascendantCoreCrafted: false,
            timeLockBankedMin: 0,
            accelerationQueue: [],
            accelerationRemainingMin: 0,
            bankingEnabled: false,
            genesisTarget: null,
            singularityStoredWs: 0,
          } as unknown as import('./persistence.js').SerializedIslandStateV7,
        },
      ],
    };
    const v8 = migrateV7toV8(v7);
    expect(v8.islandStates[0]!.state.unspentSkillPoints).toBe(0);
    expect(v8.islandStates[1]!.state.unspentSkillPoints).toBe(49);
  });
});

describe('deserializeWorld v7 → v8 round-trip', () => {
  it('migrates a v7 snapshot and yields v8 in-memory state', () => {
    const world = makeInitialWorld(0);
    const homeState = makeIslandState({ id: 'home', level: 5, xp: 1200 });
    const states = new Map<string, IslandState>([['home', homeState]]);
    const v8snap = serializeWorld(world, states, 0, 0);

    // Forge a v7-shaped snapshot from the v8 one.
    const v7 = {
      ...v8snap,
      v: 7,
      islandStates: v8snap.islandStates.map((entry) => {
        const { unlockedEdges: _ue, ...stateRest } = entry.state;
        return {
          id: entry.id,
          state: {
            ...stateRest,
            unlockedNodes: [...entry.state.unlockedNodes],
            subPathProgress: [['mining', { spent: 1, complete: false }]] as [string, { spent: number; complete: boolean }][],
            unspentSkillPoints: 0,
            specializationRole: 'mining' as string | null,
          },
        };
      }),
    } as unknown as SaveSnapshot;

    const { islandStates: restored } = deserializeWorld(v7, 0, 0);
    const home = restored.get('home')!;
    expect(home.level).toBe(5);
    expect(home.xp).toBe(1200);
    expect(home.unspentSkillPoints).toBe(4);
    expect(home.unlockedNodes.size).toBe(0);
    expect(home.unlockedEdges.size).toBe(0);
  });
});
