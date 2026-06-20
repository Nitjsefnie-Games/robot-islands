// Persistence: pure serialize/deserialize round-trip tests.
//
// idb-keyval itself is not exercised here — `saveWorld` / `loadWorld`
// touch IndexedDB, which isn't available in vitest's default node env.
// The pure transformations (`serializeWorld` / `deserializeWorld`) carry
// the load-bearing logic and ARE testable in isolation: the IDB wrappers
// just thread JSON through the store.

import { readFileSync, existsSync } from 'node:fs';
import { beforeEach, describe, expect, it } from 'vitest';

import { terrainAtForBiome } from './biomes.js';
import { floorLevel } from './buildings.js';
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
import { ALL_RESOURCES, type ResourceId } from './recipes.js';
import type { ObjectiveId } from './tutorial.js';
import type { EdgeId } from './skilltree-graph.js';
import { cumulativeSkillPointsForLevel } from './skilltree.js';

import {
  SCHEMA_VERSION,
  SUPPORTED_LOAD_VERSIONS,
  STORAGE_KEY,
  STORAGE_KEY_DISPLAY,
  deserializeWorld,
  isValidSaveSnapshot,
  migrateV7toV8,
  migrateV8toV9,
  migrateV11toV12,
  migrateV12toV13,
  migrateV13toV14,
  migrateV15toV16,
  migrateV16toV17,
  migrateV17toV18,
  migrateV18toV19,
  migrateV19toV20,
  migrateV20toV21,
  migrateV21toV22,
  migrateV22toV23,
  migrateV23toV24,
  migrateV25toV26,
  migrateV26toV27,
  migrateV27toV28,
  serializeWorld,
  type SaveSnapshot,
  type SerializedSnapshotV7,
  type SerializedSnapshotV8,
  type SerializedSnapshotV11,
  type SerializedSnapshotV12,
  type SerializedSnapshotV13,
  type SerializedSnapshotV15,
  type SerializedSnapshotV16,
  type SerializedSnapshotV17,
  type SerializedSnapshotV18,
  type SerializedSnapshotV25,
  type SerializedSnapshotV26,
  type SerializedSnapshotV27,
  type SerializedIslandStateV11,
  type SerializedWorld,
} from './persistence.js';
import {
  attachTerrainAt,
  makeInitialIslandState,
  makeInitialWorld,
  type Biome,
  type IslandSpec,
} from './world.js';
import { generateCellIslands } from './world-gen.js';
import { islandCells } from './discovery.js';
import { CELL_SIZE_TILES } from './constants.js';

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

describe('deserializeWorld — §9.9 active-bonus decay ownership', () => {
  // Regression: the closed-game decay must NOT run on the server per-intent
  // catch-up or the REMOTE live-push path — only at a genuine LOCAL cold load.
  // Otherwise every per-intent reload re-charges the inter-heartbeat window as
  // "away" (3×) while the heartbeat accrues the same window (1×) → the bonus
  // only ever drains, never ticks up. The heartbeat owns in-session accounting.
  it('does NOT erode activeBonusMs without an explicit closed-game decay opt-in', () => {
    const world = makeInitialWorld(0);
    world.activeBonusMs = 10_000;
    world.lastActiveMs = 1_000_000;
    const snap = serializeWorld(world, new Map(), /* savedAt */ 1_000_000, /* savedAtPerf */ 0);
    // 5 s later, no decay requested (server catch-up / REMOTE push path).
    const d = deserializeWorld(snap, /* nowWall */ 1_005_000, /* nowPerf */ 5_000);
    expect(d.world.activeBonusMs).toBe(10_000);
  });

  it('still applies closed-game decay at LOCAL cold load (decay opt-in)', () => {
    const world = makeInitialWorld(0);
    world.activeBonusMs = 10_000;
    world.lastActiveMs = 1_000_000;
    const snap = serializeWorld(world, new Map(), 1_000_000, 0);
    // awayMs = 5000, decay 3× → 10000 − 15000, floored at 0.
    const d = deserializeWorld(snap, 1_005_000, 5_000, { decayClosedGameActiveBonus: true });
    expect(d.world.activeBonusMs).toBe(0);
  });
});

describe('schema v25 — tradeOffers (§9.8 server-authoritative trades)', () => {
  it('migrates a v24 snapshot (no tradeOffers) to v25 with an empty offer list', () => {
    const snap = serializeWorld(makeInitialWorld(0), new Map(), 1_000_000, 500);
    const v24 = {
      ...snap,
      v: 24,
      world: { ...snap.world, tradeOffers: undefined },
    } as unknown as SaveSnapshot;
    const { world: loaded } = deserializeWorld(v24, 1_000_000, 9_999);
    expect(loaded.tradeOffers).toEqual([]);
  });

  it('round-trips tradeOffers with wall-clock times (no perfShift applied)', () => {
    const world = makeInitialWorld(0);
    world.tradeOffers = [
      {
        id: 'home-0-1000',
        islandId: 'home',
        give: { res: 'iron_ore', qty: 5 },
        get: { res: 'iron_ore', qty: 3 },
        spawnedAt: 1_000,
        expiresAt: 301_000,
      },
    ];
    const snap = serializeWorld(world, new Map(), 1_000_000, 500);
    const { world: loaded } = deserializeWorld(snap, 2_000_000, 9_999);
    expect(loaded.tradeOffers).toHaveLength(1);
    expect(loaded.tradeOffers![0]!.id).toBe('home-0-1000');
    expect(loaded.tradeOffers![0]!.expiresAt).toBe(301_000);
  });

  it('current serialize emits schema v28', () => {
    expect(serializeWorld(makeInitialWorld(0), new Map(), 0).v).toBe(28);
  });
});

describe('schema v27 → v28 — global CO₂ atmosphere + extraEllipses biome (§7.4 / §3.6)', () => {
  function v26WithPerIslandCo2(a: number, b: number): SerializedSnapshotV26 {
    const world = makeInitialWorld(0);
    world.totalCo2Kg = 0; // legacy: climate pressure lived in per-island co2Kg
    const specs = world.islands.slice(0, 2);
    const states = new Map<string, IslandState>([
      [specs[0]!.id, { ...makeInitialIslandState(specs[0]!, 0), co2Kg: a }],
      [specs[1]!.id, { ...makeInitialIslandState(specs[1]!, 0), co2Kg: b }],
    ]);
    const snap = serializeWorld(world, states, 0, 0);
    return { ...snap, v: 26 } as unknown as SerializedSnapshotV26;
  }

  it('migrateV26toV27 seeds global totalCo2Kg from the per-island sum', () => {
    const v27 = migrateV26toV27(v26WithPerIslandCo2(1200, 800));
    expect(v27.v).toBe(27);
    expect(v27.world.totalCo2Kg).toBe(2000);
  });

  it('a v26 save deserializes with totalCo2Kg seeded from the per-island sum', () => {
    const v26 = v26WithPerIslandCo2(1200, 800) as unknown as SaveSnapshot;
    const { world: loaded } = deserializeWorld(v26, 0, 0);
    expect(loaded.totalCo2Kg).toBe(2000);
  });

  it('SCHEMA_VERSION is 28 and 27/28 are in SUPPORTED_LOAD_VERSIONS', () => {
    expect(SCHEMA_VERSION).toBe(28);
    expect(SUPPORTED_LOAD_VERSIONS.has(27)).toBe(true);
    expect(SUPPORTED_LOAD_VERSIONS.has(28)).toBe(true);
  });

  it('migrateV27toV28 defaults missing extra biome to island biome', () => {
    const world = makeInitialWorld(0);
    const home = world.islands.find((s) => s.id === 'home')!;
    (home as { biome: Biome }).biome = 'plains';
    home.extraEllipses = [
      { major: 6, minor: 6, rotation: 0, offsetX: 12, offsetY: 0 }, // no biome
    ];
    const snap = serializeWorld(world, new Map(), 0, 0);
    const v27 = { ...snap, v: 27 } as unknown as SerializedSnapshotV27;
    const out = migrateV27toV28(v27);
    expect(out.v).toBe(28);
    expect(out.world.islands[0]!.extraEllipses![0]!.biome).toBe('plains');
  });

  it('migrateV27toV28 leaves an explicit extra biome untouched', () => {
    const world = makeInitialWorld(0);
    const home = world.islands.find((s) => s.id === 'home')!;
    (home as { biome: Biome }).biome = 'plains';
    home.extraEllipses = [
      { major: 6, minor: 6, rotation: 0, offsetX: 12, offsetY: 0, biome: 'forest' },
    ];
    const snap = serializeWorld(world, new Map(), 0, 0);
    const v27 = { ...snap, v: 27 } as unknown as SerializedSnapshotV27;
    const out = migrateV27toV28(v27);
    expect(out.v).toBe(28);
    expect(out.world.islands[0]!.extraEllipses![0]!.biome).toBe('forest');
  });

  it('v28 round-trips identity through serialize/loadWorld with a biome-stamped lobe', () => {
    const world = makeInitialWorld(0);
    const home = world.islands.find((s) => s.id === 'home')!;
    home.extraEllipses = [
      { major: 6, minor: 6, rotation: 0, offsetX: 12, offsetY: 0, biome: 'coast' },
    ];
    const snap = serializeWorld(world, new Map(), 0, 0);
    expect(snap.v).toBe(28);
    const json = JSON.parse(JSON.stringify(snap)) as SaveSnapshot;
    const { world: loaded } = deserializeWorld(json, 0, 0);
    const isl = loaded.islands.find((i) => i.extraEllipses?.length);
    expect(isl).toBeDefined();
    expect(isl!.extraEllipses![0]!.biome).toBe('coast');
  });
});

describe('schema v26 — route waypoints (§2.6 route bending)', () => {
  it('migrateV25toV26 bumps v and preserves route list', () => {
    const snap = serializeWorld(makeInitialWorld(0), new Map(), 0, 0);
    const v25 = { ...snap, v: 25 } as unknown as SerializedSnapshotV25;
    const v26 = migrateV25toV26(v25);
    expect(v26.v).toBe(26);
    expect(v26.world.routes).toEqual(snap.world.routes);
  });

  it('a bent route round-trips its waypoints', () => {
    const world = makeInitialWorld(0);
    world.routes.push({
      id: 'r1',
      from: 'home',
      to: 'forest-ne',
      type: 'cargo',
      capacityPerSec: 0.5,
      mode: 'priority',
      cargo: [],
      transitTimeSec: 10,
      inFlight: [],
      waypoints: [{ x: 10, y: 20 }, { x: 30, y: 40 }],
    });
    const snap = serializeWorld(world, new Map(), 0, 0);
    expect(snap.v).toBe(28);
    const route = snap.world.routes.find((r) => r.id === 'r1')!;
    expect(route.waypoints).toEqual([{ x: 10, y: 20 }, { x: 30, y: 40 }]);
    const json = JSON.parse(JSON.stringify(snap)) as SaveSnapshot;
    const { world: loaded } = deserializeWorld(json, 0, 0);
    expect(loaded.routes[0]!.waypoints).toEqual([{ x: 10, y: 20 }, { x: 30, y: 40 }]);
  });

  it('omits empty waypoints from the serialized blob', () => {
    const world = makeInitialWorld(0);
    world.routes.push({
      id: 'r1',
      from: 'home',
      to: 'forest-ne',
      type: 'cargo',
      capacityPerSec: 0.5,
      mode: 'priority',
      cargo: [],
      transitTimeSec: 10,
      inFlight: [],
      waypoints: [],
    });
    const snap = serializeWorld(world, new Map(), 0, 0);
    const route = snap.world.routes.find((r) => r.id === 'r1')!;
    expect((route as { waypoints?: unknown }).waypoints).toBeUndefined();
    expect(JSON.stringify(snap)).not.toContain('"waypoints"');
  });

  it('a v25 fixture migrates to v26 with straight routes (no waypoints)', () => {
    const world = makeInitialWorld(0);
    world.routes.push({
      id: 'r1',
      from: 'home',
      to: 'forest-ne',
      type: 'cargo',
      capacityPerSec: 0.5,
      mode: 'priority',
      cargo: [],
      transitTimeSec: 10,
      inFlight: [],
    });
    const snap = serializeWorld(world, new Map(), 0, 0);
    const v25 = { ...snap, v: 25 } as unknown as SaveSnapshot;
    const { world: loaded } = deserializeWorld(v25, 0, 0);
    expect(loaded.routes[0]!.waypoints).toBeUndefined();
  });

  it('26 remains a supported load version (migrates forward)', () => {
    expect(SUPPORTED_LOAD_VERSIONS.has(26)).toBe(true);
  });
});

describe('serializeWorld', () => {
  it('produces a snapshot with the current schema version and a savedAt timestamp', () => {
    const world = makeInitialWorld(0);
    const states = new Map<string, IslandState>();
    const snap = serializeWorld(world, states, /* savedAt */ 1_234_567);
    expect(snap.v).toBe(SCHEMA_VERSION);
    expect(snap.v).toBe(28);
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

  it('does NOT persist the §2.6 crossed-cell path on in-flight batches (recomputed at delivery)', () => {
    const world = makeInitialWorld(0);
    // A live batch + a legacy batch that still carries a `crossedCells` array
    // from a pre-refactor save. Both must serialize WITHOUT the path data.
    world.routes.push({
      id: 'r1', from: 'home', to: 'b', type: 'cargo', capacityPerSec: 0.5,
      mode: 'priority', cargo: [{ resourceId: 'iron_ore' }], transitTimeSec: 10,
      inFlight: [
        { resourceId: 'iron_ore', amount: 3, arrivalTime: 5000, dispatchTime: 0, id: 'b0' },
        {
          resourceId: 'iron_ore', amount: 2, arrivalTime: 6000, dispatchTime: 0, id: 'b1',
          // legacy stored path — must be scrubbed by serializeWorld
          crossedCells: [{ cx: 0, cy: 0, transitFraction: 0.5 }],
        } as unknown as (typeof world.routes)[number]['inFlight'][number],
      ],
    });
    const snap = serializeWorld(world, new Map(), 0);
    const route = snap.world.routes.find((r) => r.id === 'r1');
    expect(route).toBeDefined();
    expect(route!.inFlight).toHaveLength(2);
    for (const b of route!.inFlight) {
      expect((b as { crossedCells?: unknown }).crossedCells).toBeUndefined();
    }
    // The whole serialized blob is free of the field.
    expect(JSON.stringify(snap)).not.toContain('crossedCells');
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

  it('round-trips the §4.6 forceRun flag; absent stays absent (off)', () => {
    const world = makeInitialWorld(0);
    const homeSpec = world.islands.find((s) => s.id === 'home')!;
    homeSpec.buildings.push(
      { id: 'b-forced', defId: 'mine', x: 0, y: 0, forceRun: true },
      { id: 'b-plain', defId: 'mine', x: 1, y: 0 }, // no forceRun → stays off
    );
    const snap = serializeWorld(world, new Map(), 0);
    const json = JSON.parse(JSON.stringify(snap)) as SaveSnapshot;
    const { world: restored } = deserializeWorld(json, 0, 0);
    const rHome = restored.islands.find((s) => s.id === 'home')!;
    const forced = rHome.buildings.find((b) => b.id === 'b-forced')!;
    const plain = rHome.buildings.find((b) => b.id === 'b-plain')!;
    expect(forced.forceRun).toBe(true);
    expect(plain.forceRun).toBeUndefined(); // absent ≡ off
  });

  it('preserves a grown island radius (§3.4 Land Reclamation Hub mutation)', () => {
    // Simulate a §3.4 expansion: home Plains island grown via Land
    // Reclamation Hub from initial (16,16) to (18,16) — i.e. two +1
    // major expansions. The serializer should preserve the mutated
    // values verbatim (majorRadius / minorRadius are JSON-safe number
    // fields that flow through the JSON spread).
    const world = makeInitialWorld(0);
    const homeSpec = world.islands.find((s) => s.id === 'home')!;
    homeSpec.majorRadius = 18;
    // minorRadius stays at 16 — verifies the spread doesn't accidentally
    // overwrite either field with a default.
    const snap = serializeWorld(world, new Map(), 0);
    const json = JSON.parse(JSON.stringify(snap)) as SaveSnapshot;
    const { world: restored } = deserializeWorld(json, 0, 0);
    const restoredHome = restored.islands.find((s) => s.id === 'home')!;
    expect(restoredHome.majorRadius).toBe(18);
    expect(restoredHome.minorRadius).toBe(16);
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

  it('exports STORAGE_KEY containing v14 so it does not collide with stale saves', () => {
    expect(STORAGE_KEY).toMatch(/v14$/);
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
  it('isValidSaveSnapshot accepts any supported migratable version', () => {
    // A minimal v7 top-level blob (the oldest supported version).
    const v7 = {
      v: 7,
      savedAt: 0,
      savedAtPerf: 0,
      world: {},
      islandStates: [],
    } as unknown as SaveSnapshot;
    expect(isValidSaveSnapshot(v7)).toBe(true);

    // Unsupported versions and non-numeric versions are still rejected.
    expect(isValidSaveSnapshot({ ...v7, v: 3 } as unknown as SaveSnapshot)).toBe(false);
    expect(isValidSaveSnapshot({ ...v7, v: 'seven' } as unknown as SaveSnapshot)).toBe(false);
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
      darkModeDiscoveries: [],
      scanBuffer: new Set<string>(),
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
      scanBuffer: new Set<string>(),
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
      darkModeDiscoveries: [],
      scanBuffer: new Set<string>(),
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
      scanBuffer: new Set<string>(),
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

  it('rebases server wall-epoch timestamps into the client perf.now() domain (REMOTE bug regression)', () => {
    // REMOTE sends snapshots whose savedAt/savedAtPerf are both Date.now()
    // wall-epoch values (~1.75e12). The client must deserialize them with a
    // real performance.now() value so transient timestamps compare correctly
    // against the page's render clock.
    const serverEpochMs = 1_750_000_000_000;
    const clientPerfNow = 1_500_000;

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
      launchTime: serverEpochMs,
      expectedReturnTime: serverEpochMs + 10_000,
      tier: 2,
      fuelLoaded: 10,
      fuelResource: 'biofuel',
      waypoints: [],
      darkModeDiscoveries: [],
      scanBuffer: new Set<string>(),
      probabilityBias: 0,
    });

    const snap = serializeWorld(world, new Map(), serverEpochMs, serverEpochMs);
    const { world: restored } = deserializeWorld(
      snap,
      serverEpochMs + 1_000,
      clientPerfNow,
    );
    const d = restored.drones[0]!;

    // The launchTime should land in the perf domain (near clientPerfNow),
    // not remain at the server wall epoch.
    expect(d.launchTime).toBeGreaterThan(clientPerfNow - 2_000);
    expect(d.launchTime).toBeLessThan(clientPerfNow + 2_000);
    // Interval is preserved.
    expect(d.expectedReturnTime - d.launchTime).toBe(10_000);
  });
});

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
      darkModeDiscoveries: [],
      scanBuffer: new Set<string>(),
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
      scanBuffer: new Set<string>(),
    });
    const snap = serializeWorld(world, new Map(), 0, 0);
    const json = JSON.parse(JSON.stringify(snap)) as SaveSnapshot;
    const { world: restored } = deserializeWorld(json, 0, 0);
    expect(restored.vehicles).toHaveLength(1);
    expect(restored.vehicles[0]!.fuelResource).toBe('diesel');
  });

  it('round-trips a vehicle weather-freeze: doomedAtMs perf-shifted, weatherRolled kept, scanBuffer rehydrated empty', () => {
    const world = makeInitialWorld(0);
    world.vehicles.push({
      id: 'vehicle-1', kind: 'ship', tier: 1, from: 'home', target: 'coast-unknown',
      fuelLoaded: 10, foundationKitCount: 1, speed: 1,
      launchTime: 1_000, expectedArrivalTime: 11_000,
      weatherMultiplier: 1.0, fuelResource: 'biofuel', failureRate: 0.02,
      status: 'active', weatherRolled: true, doomedAtMs: 5_000,
      // Runtime-only buffer is dropped on save by design (rehydrated empty).
      scanBuffer: new Set<string>(['3,0']),
    });
    // Save at (wall 0, perf 0); restore at (wall 0, perf 2_000) ⇒ perfShift
    // = nowPerf − savedPerf − (nowWall − savedWall) = +2_000.
    const snap = serializeWorld(world, new Map(), 0, 0);
    const json = JSON.parse(JSON.stringify(snap)) as SaveSnapshot;
    const { world: restored } = deserializeWorld(json, 0, 2_000);
    const rv = restored.vehicles[0]!;
    expect(rv.weatherRolled).toBe(true);
    expect(rv.doomedAtMs).toBe(7_000);            // 5_000 + 2_000 perfShift
    expect(rv.launchTime).toBe(3_000);            // 1_000 + 2_000
    expect(rv.scanBuffer).toBeInstanceOf(Set);
    expect(rv.scanBuffer.size).toBe(0);           // dropped on save by design
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
// §9.8.5 Trade cadence fields — v20 non-zero round-trip
// ---------------------------------------------------------------------------

describe('§9.8.5 trade cadence fields round-trip', () => {
  it('preserves non-zero tradeCooldownMs and tradeAcceptCount through serialize → JSON → deserialize', () => {
    // Exercises the ...rest / ...s spread path in serializeIslandState /
    // deserializeIslandState so a future Omit change cannot silently drop them.
    const world = makeInitialWorld(0);
    const states = new Map<string, IslandState>([
      [
        'home',
        makeIslandState({ id: 'home', tradeCooldownMs: 123_456, tradeAcceptCount: 42 }),
      ],
    ]);
    const snap = serializeWorld(world, states, 0, 0);
    const json = JSON.parse(JSON.stringify(snap)) as SaveSnapshot;
    const { islandStates: restored } = deserializeWorld(json, 0, 0);
    const r = restored.get('home')!;
    expect(r.tradeCooldownMs).toBe(123_456);
    expect(r.tradeAcceptCount).toBe(42);
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

describe('IslandState.lastResetAt perfShift (§9.7)', () => {
  it('lastResetAt is perfShift-ed (§9.7 cooldown)', () => {
    // Mirrors the repair-drone / vehicle perfShift tests above. The field
    // is minted in the saved session's `performance.now()` domain (matching
    // `lastTick`). On deserialize it must shift into the new session's
    // perf-domain so the 24-hour cooldown gate `nowMs - lastResetAt <
    // TIER_RESET_COOLDOWN_MS` reads a real elapsed value.
    const world = makeInitialWorld(0);
    const states = new Map<string, IslandState>();
    const home = world.islands[0]!;
    const homeState = makeInitialIslandState(home, 1_500_000);
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
    // lastResetAt: 1_504_000 + (-1_510_000) = -6_000
    expect(r.lastResetAt).toBe(-6_000);
  });

  it('null lastResetAt survives deserialize without perfShift NaN', () => {
    // The null-preservation branch — a fresh island has lastResetAt null.
    // The perfShift remap must NOT poison it into NaN (null + number).
    const world = makeInitialWorld(0);
    const states = new Map<string, IslandState>();
    const home = world.islands[0]!;
    const homeState = makeInitialIslandState(home, 1_500_000);
    expect(homeState.lastResetAt).toBeNull();
    states.set(homeState.id, homeState);

    const snap = serializeWorld(world, states, 100_000, 1_500_000);
    const { islandStates: restored } = deserializeWorld(snap, 115_000, 5_000);
    const r = restored.get(homeState.id)!;
    expect(r.lastResetAt).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// WorldState-level fields round-trip
// ---------------------------------------------------------------------------

describe('WorldState-level fields round-trip', () => {
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
      accelerationQueue: [{ durationMin: 5 }, { durationMin: 10 }],
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
    expect(r.accelerationQueue).toEqual([{ durationMin: 5 }, { durationMin: 10 }]);
    expect(r.accelerationRemainingMin).toBe(7.5);
    expect(r.bankingEnabled).toBe(true);
  });
});

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

  it('shifts movingTo.arrivalMs and commPackets.generatedMs across the perf-domain reset', () => {
    const world = makeInitialWorld(0);
    world.satellites.push(
      {
        id: 'sat-moving',
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
        movingTo: { x: 100, y: 200, arrivalMs: 5_000 },
      },
      {
        id: 'sat-stationary',
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
      },
    );
    world.commPackets.push({
      id: 'pkt-1',
      payload: { type: 'discovery', payload: { islandId: 'remote' } },
      currentNodeId: 'sat-moving',
      originSatId: 'sat-moving',
      generatedMs: 5_000,
    });
    const savedAtWallMs = 0;
    const savedAtPerfMs = 0;
    const shift = 123_456;
    const snap = serializeWorld(world, new Map(), savedAtWallMs, savedAtPerfMs);
    const json = JSON.parse(JSON.stringify(snap)) as SaveSnapshot;
    const { world: restored } = deserializeWorld(json, savedAtWallMs, shift);
    const moving = restored.satellites.find((s) => s.id === 'sat-moving')!;
    expect(moving.movingTo!.arrivalMs).toBe(5_000 + shift);
    const stationary = restored.satellites.find((s) => s.id === 'sat-stationary')!;
    expect(stationary.movingTo).toBeUndefined();
    const pkt = restored.commPackets[0]!;
    expect(pkt.generatedMs).toBe(5_000 + shift);
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
// §14.x satellite buffer cap on load
// ---------------------------------------------------------------------------

describe('satellite buffer cap on load', () => {
  it('preserves all buffered entries when bufferCap exceeds the global default', () => {
    const world = makeInitialWorld(0);
    const entries = Array.from({ length: 150 }, (_, i) => ({
      type: 'discovery' as const,
      payload: { index: i },
    }));
    world.satellites.push({
      id: 'sat-big',
      variant: 'relay',
      spaceportIslandId: 'home',
      x: 0,
      y: 0,
      commRange: 500,
      coverageRadius: 0,
      fuel: 100,
      lodges: { scan: 0, weather: 0, comm: 0 },
      locked: true,
      pendingRepairDroneId: null,
      buffer: entries,
      bufferCap: 150,
    });
    const snap = serializeWorld(world, new Map(), 0, 0);
    const json = JSON.parse(JSON.stringify(snap)) as SaveSnapshot;
    const { world: restored } = deserializeWorld(json, 0, 0);
    const sat = restored.satellites[0]!;
    expect(sat.buffer).toHaveLength(150);
    expect(sat.buffer[sat.buffer.length - 1]!.payload).toEqual({ index: 149 });
  });

  it('defaults a missing buffer to empty array instead of crashing', () => {
    const snap = {
      v: SCHEMA_VERSION,
      savedAt: 0,
      savedAtPerf: 0,
      world: {
        islands: [],
        drones: [],
        routes: [],
        vehicles: [],
        satellites: [
          {
            id: 'sat-nobuf',
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
          },
        ],
        repairDrones: [],
        debrisFields: [],
        commPackets: [],
        totalCo2Kg: 0,
        playerLat: null,
        playerLon: null,
      },
      islandStates: [],
    } as unknown as SaveSnapshot;
    const { world: restored } = deserializeWorld(snap, 0, 0);
    const sat = restored.satellites[0]!;
    expect(sat.buffer).toEqual([]);
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
    const world = makeInitialWorld(0);
    const homeSpec = world.islands.find((s) => s.id === 'home');
    expect(homeSpec).toBeDefined();
    (homeSpec as IslandSpec).tileOverrides = {
      '1,1': 'magma_vent',
      '-3,4': 'uranium_vein',
    };
    const states = new Map<string, IslandState>();
    states.set('home', makeInitialIslandState(homeSpec!, 0));
    const snap = serializeWorld(world, states, 1_700_000_000_000, 0);
    expect(snap.v).toBe(28);
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
    totalCo2Kg: 0,
    playerLat: null,
    playerLon: null,
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
    totalCo2Kg: 0,
    playerLat: null,
    playerLon: null,
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

describe('migrateV8toV9', () => {
  it('adds empty socketBindings to every island state', () => {
    const v8: SerializedSnapshotV8 = {
      v: 8,
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
    totalCo2Kg: 0,
    playerLat: null,
    playerLon: null,
      },
      islandStates: [
        {
          id: 'home',
          state: {
            id: 'home',
            buildings: [],
            inventory: {},
            storageCaps: {},
            funnelPending: {},
            starterInventoryGrace: {},
            xp: 0,
            level: 1,
            unspentSkillPoints: 0,
            unlockedNodes: [],
            unlockedEdges: [],
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
          } as unknown as import('./persistence.js').SerializedIslandStateV8,
        },
      ],
    };

    const v9 = migrateV8toV9(v8);
    expect(v9.v).toBe(9);
    expect(v9.islandStates[0]!.state.socketBindings).toEqual([]);
  });
});

describe('deserializeWorld v8 → v9 round-trip', () => {
  it('migrates a v8 snapshot and yields v17 in-memory state with empty socketBindings', () => {
    const world = makeInitialWorld(0);
    const homeState = makeIslandState({ id: 'home', level: 5, xp: 1200 });
    const states = new Map<string, IslandState>([['home', homeState]]);
    const v9snap = serializeWorld(world, states, 0, 0);

    // Forge a v8-shaped snapshot from the v9 one.
    const v8 = {
      ...v9snap,
      v: 8,
      islandStates: v9snap.islandStates.map((entry) => {
        const { socketBindings: _sb, ...stateRest } = entry.state;
        return {
          id: entry.id,
          state: stateRest,
        };
      }),
    } as unknown as SaveSnapshot;

    const { islandStates: restored } = deserializeWorld(v8, 0, 0);
    const home = restored.get('home')!;
    // v13 → v14 resets level + xp.
    expect(home.level).toBe(1);
    expect(home.xp).toBe(0);
    expect(home.socketBindings).toBeInstanceOf(Map);
    expect(home.socketBindings.size).toBe(0);
    // v16 → v17 refunds SP to the cumulative total for the (now level-1) island.
    expect(home.unspentSkillPoints).toBe(cumulativeSkillPointsForLevel(1));
  });

  it('round-trips v9 socketBindings through serialize → JSON → deserialize', () => {
    const world = makeInitialWorld(0);
    const homeState = makeIslandState({ id: 'home' });
    homeState.socketBindings.set('mining.socket.1', 'mining_crystal_t1' as import('./skilltree-graph.js').CrystalId);
    const states = new Map<string, IslandState>([['home', homeState]]);
    const snap = serializeWorld(world, states, 0, 0);
    const json = JSON.parse(JSON.stringify(snap)) as SaveSnapshot;
    const { islandStates: restored } = deserializeWorld(json, 0, 0);
    const home = restored.get('home')!;
    expect(home.socketBindings.size).toBe(1);
    expect(home.socketBindings.get('mining.socket.1')).toBe('mining_crystal_t1');
  });
});

describe('migrateV11toV12', () => {
  it('renames singularityStoredWs to batteryStoredWs preserving the value', () => {
    const v11: SerializedSnapshotV11 = {
      v: 11,
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
    totalCo2Kg: 0,
    playerLat: null,
    playerLon: null,
      } as unknown as SerializedWorld,
      islandStates: [{
        id: 'home',
        state: {
          id: 'home',
          level: 5,
          xp: 100,
          lastTick: 0,
          inventory: {},
          storageCaps: {},
          funnelPending: {},
          starterInventoryGrace: {},
          buildings: [],
          unlockedNodes: [],
          unlockedEdges: [],
          unspentSkillPoints: 4,
          socketBindings: [],
          lastResetAt: null,
          aiCoreCrafted: false,
          ascendantCoreCrafted: false,
          timeLockBankedMin: 0,
          accelerationQueue: [],
          accelerationRemainingMin: 0,
          bankingEnabled: false,
          genesisTarget: null,
          singularityStoredWs: 12345,
        } as unknown as SerializedIslandStateV11,
      }],
    };
    const v12 = migrateV11toV12(v11);
    expect(v12.v).toBe(12);
    expect(v12.islandStates[0]!.state.batteryStoredWs).toBe(12345);
    expect((v12.islandStates[0]!.state as any).singularityStoredWs).toBeUndefined();
    expect(v12.islandStates[0]!.state.level).toBe(5);
    expect(v12.islandStates[0]!.state.xp).toBe(100);
    expect(v12.islandStates[0]!.state.unspentSkillPoints).toBe(4);
  });
});

describe('migrateV13toV14', () => {
  it('resets per-island level + xp + skill-tree progression; preserves buildings/inventory', () => {
    const v13: SerializedSnapshotV13 = {
      v: 13,
      savedAt: 1000,
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
    totalCo2Kg: 0,
    playerLat: null,
    playerLon: null,
      },
      islandStates: [{
        id: 'home',
        state: {
          id: 'home',
          level: 128,
          xp: 99999,
          inventory: { iron_ore: 500 } as Record<string, number>,
          storageCaps: {},
          funnelPending: {},
          starterInventoryGrace: {},
          buildings: [{ id: 'mine-1', defId: 'mine', x: 2, y: 2 }],
          unlockedNodes: ['mining.recipeRate.1'],
          unlockedEdges: ['mining.0-mining.1'],
          socketBindings: [],
          unspentSkillPoints: 42,
          lastResetAt: null,
          lastTick: 0,
          aiCoreCrafted: false,
          ascendantCoreCrafted: false,
          timeLockBankedMin: 0,
          accelerationQueue: [],
          accelerationRemainingMin: 0,
          bankingEnabled: false,
          genesisTarget: null,
          batteryStoredWs: 0,
        } as unknown as import('./persistence.js').SerializedIslandState,
      }],
    };

    const v14 = migrateV13toV14(v13);
    expect(v14.v).toBe(14);
    const migrated = v14.islandStates[0]!.state;
    expect(migrated.level).toBe(1);
    expect(migrated.xp).toBe(0);
    expect(migrated.unspentSkillPoints).toBe(0);
    expect(migrated.unlockedNodes).toEqual([]);
    expect(migrated.unlockedEdges).toEqual([]);
    expect(migrated.socketBindings).toEqual([]);
    expect((migrated.inventory as Record<string, number>).iron_ore).toBe(500);
    expect(migrated.buildings.length).toBe(1);
    expect(migrated.buildings[0]!.defId).toBe('mine');
  });
});

describe('migrateV12toV13', () => {
  it('adds empty scanBuffer to every drone', () => {
    const v12: SerializedSnapshotV12 = {
      v: 12,
      savedAt: 0,
      savedAtPerf: 0,
      world: {
        islands: [],
        drones: [
          {
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
            tier: 2,
            fuelLoaded: 10,
            fuelResource: 'biofuel',
            waypoints: [],
            darkModeDiscoveries: [],
            probabilityBias: 0,
          },
        ],
        routes: [],
        vehicles: [],
        satellites: [],
        repairDrones: [],
        debrisFields: [],
        commPackets: [],
      },
      islandStates: [],
    };

    const v13 = migrateV12toV13(v12);
    expect(v13.v).toBe(13);
    expect(v13.world.drones[0]!.scanBuffer).toEqual([]);
  });

  it('v13 round-trip: scanBuffer preserves cell ids', () => {
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
      tier: 2,
      fuelLoaded: 10,
      fuelResource: 'biofuel',
      waypoints: [],
      darkModeDiscoveries: [],
      scanBuffer: new Set<string>(['2:3', '2:4', '3:3']),
      probabilityBias: 0,
    });
    const snap = serializeWorld(world, new Map(), 0, 0);
    const json = JSON.parse(JSON.stringify(snap)) as SaveSnapshot;
    const { world: restored } = deserializeWorld(json, 0, 0);
    expect([...restored.drones[0]!.scanBuffer].sort()).toEqual(['2:3', '2:4', '3:3']);
  });
});

describe('deserializeWorld v7 → v17 migration chain', () => {
  it('walks v7 through v8/v9/v10/v11/v12/v13/v14/v15/v16/v17 and refunds SP via cumulativeSkillPointsForLevel', () => {
    const world = makeInitialWorld(0);
    const homeState = makeIslandState({ id: 'home', level: 5, xp: 1200 });
    const states = new Map<string, IslandState>([['home', homeState]]);
    const currentSnap = serializeWorld(world, states, 0, 0);

    // Forge a v7-shaped snapshot from the current one.
    const v7 = {
      ...currentSnap,
      v: 7,
      islandStates: currentSnap.islandStates.map((entry) => {
        const { unlockedEdges: _ue, socketBindings: _sb, ...stateRest } = entry.state;
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
    // v13 → v14 resets level + xp + skill-tree progression to level 1.
    expect(home.level).toBe(1);
    expect(home.xp).toBe(0);
    expect(home.unlockedNodes.size).toBe(0);
    expect(home.unlockedEdges.size).toBe(0);
    expect(home.socketBindings).toBeInstanceOf(Map);
    expect(home.socketBindings.size).toBe(0);
    // v16 → v17 refunds SP to the cumulative total for the (now level-1) island.
    expect(home.unspentSkillPoints).toBe(cumulativeSkillPointsForLevel(1));
  });
});


describe('persistence v14 → v15', () => {
  it('v14 fixture loads cleanly into v16 with new fields seeded', () => {
    const v14 = JSON.parse(readFileSync('src/fixtures/v14-minimal.json', 'utf8'));
    const result = deserializeWorld(v14);
    expect(result).not.toBeNull();
    expect(result!.world.totalCo2Kg).toBe(0);
    expect(result!.world.playerLat).toBeNull();
    expect(result!.world.playerLon).toBeNull();
    for (const entry of result!.islandStates.values()) {
      expect(entry.co2Kg).toBe(0);
    }
  });

  it.skipIf(!existsSync('/tmp/robot-islands-save.json'))(
    'live /tmp/robot-islands-save.json migrates v14 → v17 with zero defaults',
    () => {
      const raw = readFileSync('/tmp/robot-islands-save.json', 'utf8');
      const result = deserializeWorld(JSON.parse(raw));
      expect(result).not.toBeNull();
      expect(typeof result!.world.totalCo2Kg).toBe('number');
      // playerLat / playerLon may be null (v14 default) or set (post-migration write);
      // both are valid post-migration states.
    },
  );
});

describe('migrateV15toV16', () => {
  it('bumps version only and preserves all fields', () => {
    const v15: SerializedSnapshotV15 = {
      v: 15,
      savedAt: 1000,
      savedAtPerf: 0,
      world: {
        islands: [],
        seed: 'demo',
        drones: [],
        routes: [],
        vehicles: [],
        satellites: [],
        repairDrones: [],
        debrisFields: [],
        commPackets: [],
        latticeActive: false,
        latticeNodeIslands: [],
        totalCo2Kg: 0,
        playerLat: null,
        playerLon: null,
      },
      islandStates: [],
    };
    const v16 = migrateV15toV16(v15);
    expect(v16.v).toBe(16);
    expect(v16.world.totalCo2Kg).toBe(0);
    expect(v16.world.playerLat).toBeNull();
    expect(v16.islandStates).toEqual([]);
  });
});

describe('migrateV16toV17', () => {
  it('clears node progression + refunds SP to cumulative total; KEEPS level/xp/buildings/inventory', () => {
    const v16: SerializedSnapshotV16 = {
      v: 16,
      savedAt: 1000,
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
        totalCo2Kg: 0,
        playerLat: null,
        playerLon: null,
      },
      islandStates: [{
        id: 'home',
        state: {
          id: 'home',
          level: 5,
          xp: 1234,
          inventory: { iron_ore: 500, biofuel: 12 } as Record<string, number>,
          storageCaps: {},
          funnelPending: {},
          starterInventoryGrace: {},
          buildings: [{ id: 'mine-1', defId: 'mine', x: 2, y: 2 }],
          unlockedNodes: ['mining.recipeRate.1', 'mining.recipeRate.2'],
          unlockedEdges: ['mining.0-mining.1'],
          socketBindings: [['mining.socket.0', 'crystal_alpha']],
          unspentSkillPoints: 0,
          lastResetAt: null,
          lastTick: 0,
          aiCoreCrafted: false,
          ascendantCoreCrafted: false,
          timeLockBankedMin: 0,
          accelerationQueue: [],
          accelerationRemainingMin: 0,
          bankingEnabled: false,
          genesisTarget: null,
          batteryStoredWs: 0,
          co2Kg: 0,
        } as unknown as import('./persistence.js').SerializedIslandState,
      }],
    } as unknown as SerializedSnapshotV16;

    const v17 = migrateV16toV17(v16);
    expect(v17.v).toBe(17);
    const migrated = v17.islandStates[0]!.state;
    // Node-progression fields all cleared (de-noding invalidated the ids).
    expect(migrated.unlockedNodes).toEqual([]);
    expect(migrated.unlockedEdges).toEqual([]);
    expect(migrated.socketBindings).toEqual([]);
    // SP refunded to the full cumulative earned total for the island's level.
    expect(migrated.unspentSkillPoints).toBe(cumulativeSkillPointsForLevel(5));
    // level / xp PRESERVED (unlike the v13 → v14 reset).
    expect(migrated.level).toBe(5);
    expect(migrated.xp).toBe(1234);
    // buildings + inventory untouched.
    expect(migrated.buildings.length).toBe(1);
    expect(migrated.buildings[0]!.defId).toBe('mine');
    expect((migrated.inventory as Record<string, number>).iron_ore).toBe(500);
    expect((migrated.inventory as Record<string, number>).biofuel).toBe(12);
  });
});

describe('persistence v15 → v16', () => {
  it('v15 fixture loads into v16 without error', () => {
    const v15 = JSON.parse(readFileSync('src/fixtures/v15-minimal.json', 'utf8'));
    const result = deserializeWorld(v15);
    expect(result).not.toBeNull();
  });

  it('v17 round-trips byte-identical through serialize → deserialize → serialize', () => {
    const world = makeInitialWorld(0);
    // §9.9 lastActiveMs is optional on fresh worlds but deserialize materializes
    // it to savedAt; seed it so the first serialize matches the second.
    world.lastActiveMs = 0;
    const islandStates = new Map<string, IslandState>();
    for (const spec of world.islands) {
      if (spec.populated) {
        islandStates.set(spec.id, makeInitialIslandState(spec, 0));
      }
    }
    // Use 0 for both timestamps so lastTick remaps to 0 and the round-trip
    // is byte-identical (deserializeWorld replaces lastTick with nowPerfMs -
    // deltaMs, so matching save and load timestamps keeps it stable).
    const s1 = serializeWorld(world, islandStates, 0, 0);
    const reloaded = deserializeWorld(s1, 0, 0);
    const s2 = serializeWorld(reloaded!.world, reloaded!.islandStates, s1.savedAt, s1.savedAtPerf);
    expect(JSON.parse(JSON.stringify(s2))).toEqual(JSON.parse(JSON.stringify(s1)));
  });
});

describe('PlacedBuilding.floorLevel persistence', () => {
  it('floorLevel survives save→load', () => {
    const world = makeInitialWorld(0);
    const home = world.islands.find((s) => s.id === 'home')!;
    home.buildings.push({ id: 'mine-1', defId: 'mine', x: 2, y: 2, floorLevel: 3 });
    const snap = serializeWorld(world, new Map(), 0, 0);
    const json = JSON.parse(JSON.stringify(snap)) as SaveSnapshot;
    const { world: restored } = deserializeWorld(json, 0, 0);
    const restoredHome = restored.islands.find((s) => s.id === 'home')!;
    const b = restoredHome.buildings.find((bld) => bld.id === 'mine-1')!;
    expect(b.floorLevel).toBe(3);
  });

  it('building without floorLevel loads with floorLevel() → 0', () => {
    const world = makeInitialWorld(0);
    const home = world.islands.find((s) => s.id === 'home')!;
    home.buildings.push({ id: 'solar-1', defId: 'solar', x: 1, y: 1 });
    const snap = serializeWorld(world, new Map(), 0, 0);
    const json = JSON.parse(JSON.stringify(snap)) as SaveSnapshot;
    const { world: restored } = deserializeWorld(json, 0, 0);
    const restoredHome = restored.islands.find((s) => s.id === 'home')!;
    const b = restoredHome.buildings.find((bld) => bld.id === 'solar-1')!;
    expect(b.floorLevel).toBeUndefined();
    expect(floorLevel(b)).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// v17 → v18 migration (build-queue fields)
// ---------------------------------------------------------------------------

describe('v17 -> v18 migration', () => {
  it('17, 18 and 19 are all supported', () => {
    expect(SUPPORTED_LOAD_VERSIONS.has(17)).toBe(true);
    expect(SUPPORTED_LOAD_VERSIONS.has(18)).toBe(true);
    expect(SUPPORTED_LOAD_VERSIONS.has(19)).toBe(true);
  });
  it('migrateV17toV18 bumps v and preserves islandStates/world', () => {
    const v17: SerializedSnapshotV17 = { v: 17, savedAt: 1, savedAtPerf: 0, world: { islands: [] }, islandStates: [] } as unknown as SerializedSnapshotV17;
    const out = migrateV17toV18(v17);
    expect(out.v).toBe(18);
    expect(out.islandStates).toEqual([]);
  });
  it('round-trip: building with queued/queueSeq and nextQueueSeq on island state survive serialize→loadWorld', () => {
    const world = makeInitialWorld(0);
    const homeSpec = world.islands.find((s) => s.id === 'home')!;
    // Push a queued building onto the spec's buildings array.
    homeSpec.buildings.push({ id: 'mine-q1', defId: 'mine', x: 5, y: 5, queued: true, queueSeq: 1 });
    const homeState = makeInitialIslandState(homeSpec, 0);
    // nextQueueSeq is a real optional field on IslandState (economy.ts).
    homeState.nextQueueSeq = 2;
    const states = new Map<string, IslandState>([['home', homeState]]);
    const snap = serializeWorld(world, states, 0, 0);
    // The snapshot must be at v28 (SCHEMA_VERSION).
    expect(snap.v).toBe(28);
    const json = JSON.parse(JSON.stringify(snap)) as SaveSnapshot;
    const { world: restored, islandStates: restoredStates } = deserializeWorld(json, 0, 0);
    const rSpec = restored.islands.find((s) => s.id === 'home')!;
    const queued = rSpec.buildings.find((b) => b.id === 'mine-q1')!;
    expect(queued.queued).toBe(true);
    expect(queued.queueSeq).toBe(1);
    const rState = restoredStates.get('home')!;
    expect(rState.nextQueueSeq).toBe(2);
  });
  it('a building with NO queue fields loads as not-queued (absent ≡ default, no backfill)', () => {
    const world = makeInitialWorld(0);
    const homeSpec = world.islands.find((s) => s.id === 'home')!;
    homeSpec.buildings.push({ id: 'mine-noq', defId: 'mine', x: 6, y: 6 });
    const snap = serializeWorld(world, new Map(), 0, 0);
    const json = JSON.parse(JSON.stringify(snap)) as SaveSnapshot;
    const { world: restored } = deserializeWorld(json, 0, 0);
    const rSpec = restored.islands.find((s) => s.id === 'home')!;
    const b = rSpec.buildings.find((bld) => bld.id === 'mine-noq')!;
    expect(b.queued).toBeFalsy();
    expect(b.queueSeq).toBeUndefined();
  });
});

describe('v18 -> v19 migration (everProduced seen-set)', () => {
  it('SCHEMA_VERSION is 28', () => {
    expect(SCHEMA_VERSION).toBe(28);
  });

  it('migrateV18toV19 backfills everProduced only from POSITIVE-stock resources', () => {
    // Build a current snapshot, then forge a v18 shape from it by stripping
    // everProduced and dropping the version to 18. The migration must seed
    // everProduced from resources held at positive stock only — a zero-stock
    // resource (the raw inventory zero-fills the whole catalog) must NOT be
    // marked ever-produced, or the trade "get" gate would be bypassed.
    const world = makeInitialWorld(0);
    const homeSpec = world.islands.find((s) => s.id === 'home')!;
    const homeState = makeInitialIslandState(homeSpec, 0);
    // Pin a known inventory: two positive-stock resources + one zero-stock.
    homeState.inventory = { iron_ore: 10, coal: 5, bolt: 0 } as typeof homeState.inventory;
    const states = new Map<string, IslandState>([['home', homeState]]);
    const current = serializeWorld(world, states, 0, 0);

    const v18: SerializedSnapshotV18 = {
      ...current,
      v: 18,
      islandStates: current.islandStates.map((entry) => {
        // Drop everProduced to emulate a genuine v18 save (field absent).
        const { everProduced: _ep, ...stateRest } = entry.state;
        return { id: entry.id, state: stateRest };
      }),
    } as unknown as SerializedSnapshotV18;

    const out = migrateV18toV19(v18);
    expect(out.v).toBe(19);
    const homeEntry = out.islandStates.find((e) => e.id === 'home')!;
    const ever = new Set(homeEntry.state.everProduced);
    expect(ever.has('iron_ore')).toBe(true);  // positive stock → seeded
    expect(ever.has('coal')).toBe(true);       // positive stock → seeded
    expect(ever.has('bolt')).toBe(false);      // zero stock → NOT seeded
    expect(ever).toEqual(new Set(['iron_ore', 'coal']));
  });

  it('round-trips everProduced identity: Set → serialize → deserialize → same contents', () => {
    const world = makeInitialWorld(0);
    const homeSpec = world.islands.find((s) => s.id === 'home')!;
    const homeState = makeInitialIslandState(homeSpec, 0);
    homeState.everProduced = new Set(['bolt', 'iron_ingot']);
    const states = new Map<string, IslandState>([['home', homeState]]);
    const snap = serializeWorld(world, states, 0, 0);
    expect(snap.v).toBe(28);
    const json = JSON.parse(JSON.stringify(snap)) as SaveSnapshot;
    const { islandStates: restored } = deserializeWorld(json, 0, 0);
    const rState = restored.get('home')!;
    expect(rState.everProduced).toBeInstanceOf(Set);
    expect(rState.everProduced).toEqual(new Set(['bolt', 'iron_ingot']));
  });
});

describe('v19 -> v20 trade-cadence migration', () => {
  it('backfills tradeCooldownMs and tradeAcceptCount to 0', () => {
    const v19 = {
      v: 19,
      savedAt: 0,
      savedAtPerf: 0,
      world: { islands: [] },
      drones: [],
      routes: [],
      vehicles: [],
      satellites: [],
      islandStates: [
        { id: 'home', state: { id: 'home', inventory: { stone: 5 } } },
      ],
    } as unknown as Parameters<typeof migrateV19toV20>[0];

    const out = migrateV19toV20(v19);
    expect(out.v).toBe(20);
    const st = out.islandStates[0]!.state as unknown as {
      tradeCooldownMs: number; tradeAcceptCount: number;
    };
    expect(st.tradeCooldownMs).toBe(0);
    expect(st.tradeAcceptCount).toBe(0);
  });
});

describe('v20 -> v21 tutorial xpBumpClaimed migration', () => {
  it('backfills xpBumpClaimed from completed', () => {
    const v20 = {
      v: 20, savedAt: 0, savedAtPerf: 0,
      world: { islands: [], tutorialState: { completed: ['a', 'b'], current: null } },
      drones: [], routes: [], vehicles: [], satellites: [], islandStates: [],
    } as unknown as Parameters<typeof migrateV20toV21>[0];
    const out = migrateV20toV21(v20);
    expect(out.v).toBe(21);
    expect(SCHEMA_VERSION).toBe(28);
    expect((out.world.tutorialState as unknown as { xpBumpClaimed: string[] }).xpBumpClaimed)
      .toEqual(['a', 'b']);
  });
  it('leaves a snapshot without tutorialState alone', () => {
    const v20 = {
      v: 20, savedAt: 0, savedAtPerf: 0,
      world: { islands: [] },
      drones: [], routes: [], vehicles: [], satellites: [], islandStates: [],
    } as unknown as Parameters<typeof migrateV20toV21>[0];
    expect(migrateV20toV21(v20).v).toBe(21);
  });
});

// ---------------------------------------------------------------------------
// v21 xpBumpClaimed round-trip
// ---------------------------------------------------------------------------

describe('v21 tutorialState.xpBumpClaimed round-trip', () => {
  it('preserves xpBumpClaimed (Set) through serialize → JSON → deserialize', () => {
    const world = makeInitialWorld(0);
    world.tutorialState = {
      completed: new Set<ObjectiveId>(['a' as ObjectiveId]),
      current: null,
      xpBumpClaimed: new Set<ObjectiveId>(['a' as ObjectiveId]),
    };
    const snap = serializeWorld(world, new Map(), 0, 0);
    const json = JSON.parse(JSON.stringify(snap)) as SaveSnapshot;
    const { world: restored } = deserializeWorld(json, 0, 0);
    expect(restored.tutorialState!.xpBumpClaimed).toBeInstanceOf(Set);
    expect(restored.tutorialState!.xpBumpClaimed!.has('a' as ObjectiveId)).toBe(true);
  });
});

describe('schema v22 — activeBonusMs (§9.9)', () => {
  it('migrateV21toV22 seeds world.activeBonusMs = 0 and bumps v', () => {
    const v21 = {
      v: 21,
      savedAt: 1_000,
      savedAtPerf: 500,
      world: { tutorialState: undefined },
    } as unknown as Parameters<typeof migrateV21toV22>[0];
    const out = migrateV21toV22(v21);
    expect(out.v).toBe(22);
    expect((out.world as { activeBonusMs?: number }).activeBonusMs).toBe(0);
  });

  it('round-trips activeBonusMs through serialize/deserialize with closed-gap decay', () => {
    const world = makeInitialWorld(0);
    world.activeBonusMs = 600_000; // 10 focused minutes banked
    const snap = serializeWorld(world, new Map(), 1_000_000, 500);
    expect(snap.v).toBe(28);
    expect(snap.world.activeBonusMs).toBe(600_000);
    // Reload 1 minute of wall-clock later: decay 3 × 60_000. Closed-game decay
    // is the LOCAL cold-load path → opt in (§9.9 heartbeat owns REMOTE).
    const { world: loaded } = deserializeWorld(snap, 1_000_000 + 60_000, 9_999, {
      decayClosedGameActiveBonus: true,
    });
    expect(loaded.activeBonusMs).toBe(420_000); // 600_000 − 3 × 60_000
  });

  it('floors load-time decay at 0 (overnight gap)', () => {
    const world = makeInitialWorld(0);
    world.activeBonusMs = 600_000;
    const snap = serializeWorld(world, new Map(), 1_000_000, 500);
    const eightHours = 8 * 3600 * 1000;
    const { world: loaded } = deserializeWorld(snap, 1_000_000 + eightHours, 9_999, {
      decayClosedGameActiveBonus: true,
    });
    expect(loaded.activeBonusMs).toBe(0);
  });

  it('a v21 snapshot (no activeBonusMs) loads with 0', () => {
    const world = makeInitialWorld(0);
    const snap = serializeWorld(world, new Map(), 1_000_000, 500);
    const v21 = {
      ...snap,
      v: 21,
      world: { ...snap.world, activeBonusMs: undefined },
    } as unknown as SaveSnapshot;
    const { world: loaded } = deserializeWorld(v21, 1_000_000, 9_999);
    expect(loaded.activeBonusMs).toBe(0);
  });

  it('decays activeBonusMs from time-since-last-active, not time-since-save', () => {
    const world = makeInitialWorld(0);
    world.activeBonusMs = 600_000;
    const savedAt = 1_000_000;
    // Player was active right up to save time.
    world.lastActiveMs = savedAt;
    const snap = serializeWorld(world, new Map(), savedAt, 500);
    // Reload one minute later; because lastActiveMs == savedAt, away time is
    // the full minute and the legacy path would also decay. The new behaviour
    // shows that lastActiveMs is carried through and the decay is computed
    // from now - lastActiveMs.
    const { world: loaded } = deserializeWorld(snap, savedAt + 60_000, 9_999, {
      decayClosedGameActiveBonus: true,
    });
    expect(loaded.activeBonusMs).toBe(420_000); // 600_000 − 3 × 60_000
    expect(loaded.lastActiveMs).toBe(savedAt);
  });

  it('does not decay when lastActiveMs is recent (connected play)', () => {
    const world = makeInitialWorld(0);
    world.activeBonusMs = 600_000;
    const savedAt = 1_000_000;
    const now = savedAt + 60_000;
    // Player sent a heartbeat 100 ms ago: only 100 ms of true away time.
    world.lastActiveMs = now - 100;
    const snap = serializeWorld(world, new Map(), savedAt, 500);
    const { world: loaded } = deserializeWorld(snap, now, 9_999, {
      decayClosedGameActiveBonus: true,
    });
    expect(loaded.activeBonusMs).toBe(599_700); // 600_000 − 3 × 100
    expect(loaded.lastActiveMs).toBe(now - 100);
  });
});

// ---------------------------------------------------------------------------
// v22 → v23 — island-density regeneration (§2.1; density lowered to 0.02)
// ---------------------------------------------------------------------------
describe('migrateV22toV23 — regenerates procedural islands at density 0.02', () => {
  const SEED = 'density-mig-seed';
  const cs = CELL_SIZE_TILES;

  function genCellList(): string[] {
    const out: string[] = [];
    // Large enough that density 0.02 reliably rolls several islands.
    for (let cy = 1; cy <= 30; cy++) for (let cx = 1; cx <= 30; cx++) out.push(`${cx},${cy}`);
    return out;
  }

  // Independent recomputation of the expected 0.02 regeneration, in the
  // (cy, cx) order the migration uses.
  function regenExpected(populated: IslandSpec[]): IslandSpec[] {
    const placed: IslandSpec[] = [...populated];
    const out: IslandSpec[] = [];
    const cells = genCellList()
      .map((k) => k.split(',').map(Number) as [number, number])
      .sort((a, b) => a[1] - b[1] || a[0] - b[0]);
    for (const [cx, cy] of cells) {
      for (const i of generateCellIslands(SEED, cx, cy, cs, 0.02, placed)) {
        placed.push(i);
        out.push(i);
      }
    }
    return out;
  }

  function homeIsland(): IslandSpec {
    return attachTerrainAt({
      id: 'home', name: 'Home', biome: 'plains', cx: 0, cy: 0,
      majorRadius: 8, minorRadius: 8, populated: true, discovered: true,
      buildings: [], modifiers: [],
    });
  }

  function makeV22(islands: IslandSpec[], revealed: string[]): SaveSnapshot {
    const base = serializeWorld(makeInitialWorld(0), new Map(), 0);
    return {
      ...base,
      v: 22,
      world: {
        ...base.world,
        seed: SEED,
        // strip terrainAt; the migration discards procedural geometry anyway
        islands: islands.map(({ terrainAt: _t, ...s }) => s),
        generatedCells: genCellList(),
        revealedCells: revealed,
      },
    } as unknown as SaveSnapshot;
  }

  it('keeps populated islands and regenerates procedural ones at 0.02', () => {
    const home = homeIsland();
    // Seed the v22 blob with bogus "dense" procedural islands — they must be
    // discarded and replaced by the deterministic 0.02 regeneration.
    const bogus: IslandSpec[] = genCellList().map((k) => {
      const [cx, cy] = k.split(',').map(Number) as [number, number];
      return attachTerrainAt({
        id: `old-${k}`, name: k, biome: 'forest', cx: cx * cs + 8, cy: cy * cs + 8,
        majorRadius: 5, minorRadius: 5, populated: false, discovered: false,
        buildings: [], modifiers: [],
      });
    });
    const out = migrateV22toV23(makeV22([home, ...bogus], []) as never);
    expect(out.v).toBe(23);
    const ids = out.world.islands.map((i) => i.id);
    expect(ids).toContain('home');
    expect(ids.some((i) => i.startsWith('old-'))).toBe(false); // bogus discarded
    const expected = regenExpected([home]);
    const proc = out.world.islands.filter((i) => !i.populated);
    expect(proc.map((i) => i.id).sort()).toEqual(expected.map((i) => i.id).sort());
    expect(proc.length).toBeGreaterThan(0);
    expect(proc.length).toBeLessThan(bogus.length); // sparser than the old per-cell set
  });

  it('preserves revealedCells and discovers regenerated islands within them', () => {
    const home = homeIsland();
    const expected = regenExpected([home]);
    expect(expected.length).toBeGreaterThan(1);
    const inside = expected[0]!;
    const insideCells = islandCells(inside);
    const out = migrateV22toV23(makeV22([home], insideCells) as never);
    expect(out.world.revealedCells).toEqual(insideCells); // untouched
    expect(out.world.islands.find((i) => i.id === inside.id)!.discovered).toBe(true);
    const outsider = expected.find((i) => islandCells(i).every((c) => !insideCells.includes(c)));
    expect(outsider).toBeDefined();
    expect(out.world.islands.find((i) => i.id === outsider!.id)!.discovered).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// v23 → v24 — buildJobs + disabled→disabledFloors (§4.8 stacked upgrade queue)
// ---------------------------------------------------------------------------
describe('schema v24 — buildJobs + disabled→disabledFloors', () => {
  it('SCHEMA_VERSION is 28', () => {
    expect(SCHEMA_VERSION).toBe(28);
  });

  function makeV23(islandStates: Array<{ id: string; state: unknown }>): SaveSnapshot {
    const base = serializeWorld(makeInitialWorld(0), new Map(), 0);
    return {
      ...base,
      v: 23,
      islandStates,
    } as unknown as SaveSnapshot;
  }

  it('migrateV23toV24 defaults each island state buildJobs to []', () => {
    const out = migrateV23toV24(makeV23([
      { id: 'home', state: { buildings: [] } },
      { id: 'b', state: { buildings: [] } },
    ]) as never);
    expect(out.v).toBe(24);
    for (const entry of out.islandStates) {
      expect((entry.state as { buildJobs?: unknown[] }).buildJobs).toEqual([]);
    }
  });

  it('migrates a disabled building (floorLevel 2) to disabledFloors 3 and drops disabled', () => {
    const out = migrateV23toV24(makeV23([
      { id: 'home', state: { buildings: [{ id: 'x', defId: 'solar', x: 0, y: 0, disabled: true, floorLevel: 2 }] } },
    ]) as never);
    const b = (out.islandStates[0]!.state as { buildings: Array<{ disabled?: boolean; disabledFloors?: number }> }).buildings[0]!;
    expect(b.disabled).toBeUndefined();
    expect(b.disabledFloors).toBe(3);
  });

  it('drops disabled (falsy) without setting disabledFloors', () => {
    const out = migrateV23toV24(makeV23([
      { id: 'home', state: { buildings: [{ id: 'y', defId: 'solar', x: 0, y: 0, disabled: false }] } },
    ]) as never);
    const b = (out.islandStates[0]!.state as { buildings: Array<{ disabled?: boolean; disabledFloors?: number }> }).buildings[0]!;
    expect('disabled' in b).toBe(false);
    expect(b.disabledFloors).toBeUndefined();
  });

  it('round-trips buildJobs and disabledFloors through serialize → JSON → deserialize', () => {
    const world = makeInitialWorld(0);
    const homeSpec = world.islands.find((s) => s.id === 'home')!;
    homeSpec.buildings.push({
      id: 'upg-1', defId: 'solar', x: 4, y: 4, floorLevel: 3, disabledFloors: 1,
    });
    const homeState = makeInitialIslandState(homeSpec, 0);
    homeState.buildJobs = [{ seq: 1, buildingId: 'upg-1', kind: 'upgrade' }];
    const states = new Map<string, IslandState>([['home', homeState]]);
    const snap = serializeWorld(world, states, 0);
    expect(snap.v).toBe(28);
    const json = JSON.parse(JSON.stringify(snap)) as SaveSnapshot;
    const { world: restored, islandStates: restoredStates } = deserializeWorld(json, 0, 0);
    expect(restoredStates.get('home')!.buildJobs).toEqual([
      { seq: 1, buildingId: 'upg-1', kind: 'upgrade' },
    ]);
    const b = restored.islands.find((s) => s.id === 'home')!.buildings.find((x) => x.id === 'upg-1')!;
    expect(b.disabledFloors).toBe(1);
    expect(b.floorLevel).toBe(3);
  });
});
