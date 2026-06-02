// IndexedDB persistence per SPEC §15.6 — save the WorldState + per-island
// IslandState map across browser sessions, restore on startup. One save
// slot per origin (the page's IndexedDB). No backend.
//
// Three concerns the serializer addresses that JSON.stringify alone can't:
//
//   1. `IslandSpec.terrainAt` is a closure (`(x, y) => terrainAtForBiome(...)`),
//      not data. Functions don't survive JSON. We strip it on save and
//      rehydrate via `terrainAtForBiome(spec.biome, spec.id, x, y)` on load —
//      the same factory `world.ts` uses to build the demo set.
//
//   2. `IslandState.unlockedNodes` is a `Set<NodeId>`. Sets stringify as `{}`
//      by default. We convert to/from array form explicitly so the round-trip
//      preserves membership and ordering.
//
//   3. Module-level id counters in `drones.ts` and `routes.ts` reset on
//      page load. After restoring, the loader seeds those counters past
//      the maximum saved id via `_seedDroneIdCounter` / `_seedRouteIdCounter`
//      so newly-allocated ids never collide with already-saved ones. The
//      in-tree FIXME this addresses lives at the counter declarations.
//
// `lastTick` timestamp strategy (per §15.5 offline catchup):
//   `lastTick` lives in the `performance.now()` domain, which is per-page-load
//   and resets to 0 on reload. Saving the raw value would make the next
//   session see `lastTick = 1_234_567` while `performance.now()` starts near
//   0 — `advanceIsland`'s `nowMs <= state.lastTick` guard would silently
//   stall the economy until time caught up minutes/hours later.
//
//   Fix: at save time we record `savedAt = Date.now()` (wall-clock ms). At
//   load time we compute `deltaMs = Date.now() - savedAt` (how long the
//   tab was closed) and remap each `lastTick = performance.now() - deltaMs`.
//   On the next frame `advanceIsland(state, performance.now())` processes
//   the full offline gap through its existing event-driven loop — the same
//   path that handles a 1-frame tick handles a 24-hour catchup. No new
//   integration code; §15.5 catchup falls out for free.

import { del, get, set } from 'idb-keyval';


import { islandCells, tileToCell } from './discovery.js';
import type { IslandState } from './economy.js';
import type { Drone } from './drones.js';
import { _seedConstructionCounter } from './construction-ui.js';
import { _seedDroneIdCounter } from './drones.js';
import type { Route } from './routes.js';
import { _seedRouteIdCounter } from './routes.js';

import type { SettlementVehicle } from './settlement.js';
import { SAT_BUFFER_CAP, type Satellite } from './orbital.js';
import type { ObjectiveId } from './tutorial.js';
import { _seedVehicleIdCounter } from './settlement.js';


import type { VictoryCondition } from './endgame.js';
import type { NodeId } from './skilltree.js';
import type { ResourceId } from './recipes.js';
import { cumulativeSkillPointsForLevel } from './skilltree.js';
import type { CrystalId, EdgeId } from './skilltree-graph.js';
import type { OceanCellSpec } from './ocean-cell.js';

import { attachTerrainAt, WORLD_SEED, type IslandSpec, type WorldState } from './world.js';

/** IndexedDB key. Bumping the trailing version (`:v2` later) is the
 *  intended break-from-stale-saves entry point — `loadWorld` keys on this
 *  string, so a new key returns "no save" without colliding with older
 *  stores. */
export const STORAGE_KEY = 'robot-islands:save:v14';

/** User-visible storage-key label. The Settings panel renders this
 *  string in the storage-key footer line. */
export const STORAGE_KEY_DISPLAY = 'robot-islands:save';

/** Current schema version. `loadWorld` rejects (returns null) any
 *  snapshot whose `v` is not strictly equal to this. */
export const SCHEMA_VERSION = 20 as const;

/** Versions that loadWorld accepts. The walker (loadWorld) chains
 *  migrateV<N>toV<N+1> functions from the lowest known version up to
 *  SCHEMA_VERSION.
 *
 *  See AGENTS.md → "Persistence migrations" for the full "bump = migrate"
 *  policy from v7 onward. */
export const SUPPORTED_LOAD_VERSIONS: ReadonlySet<number> = new Set([7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18, 19, 20]);

// ---------------------------------------------------------------------------
// Serialized shapes
// ---------------------------------------------------------------------------
//
// Each `SerializedXxx` shape mirrors the live one with the non-JSON-safe
// fields swapped out. Live → Serialized at save time, Serialized → live at
// load time.

/** IslandSpec without the `terrainAt` closure (which isn't JSON-safe). The
 *  loader rehydrates it via `terrainAtForBiome(biome, id, x, y)`. */
export type SerializedIslandSpec = Omit<IslandSpec, 'terrainAt'>;

/** IslandState with Set and Map fields converted to arrays for JSON. */
export interface SerializedIslandState
  extends Omit<IslandState, 'unlockedNodes' | 'unlockedEdges' | 'socketBindings' | 'everProduced' | 'auraAmpVersion' | 'auraAmpCache' | 'auraAmpCacheVersion'> {
  readonly unlockedNodes: ReadonlyArray<NodeId>;
  readonly unlockedEdges: ReadonlyArray<EdgeId>;
  readonly socketBindings: ReadonlyArray<[string, CrystalId]>;
  /** Resources this island has ever produced. Optional for forward-compat:
   *  a pre-v19 save lacks it and the v18→v19 migration backfills it from the
   *  resources the island holds at positive stock. Deserialize rebuilds the
   *  `Set`. */
  readonly everProduced?: ReadonlyArray<ResourceId>;
  readonly batteryStoredWs: number;
}

/** One entry of the per-island state map. We avoid serializing a `Map`
 *  directly because `JSON.stringify(map)` is `{}`; an array of pairs is
 *  the de-facto idiom and survives every transport. */
export interface SerializedIslandStateEntry {
  readonly id: string;
  readonly state: SerializedIslandState;
}

/** Drone with scanBuffer projected to a JSON-safe sorted array. */
export type SerializedDrone = Omit<Drone, 'scanBuffer'> & {
  readonly scanBuffer: ReadonlyArray<string>;
};

/** World data minus the per-island closures. Drones, Routes, and Vehicles
 *  are already JSON-friendly (only numbers, strings, and arrays — see the
 *  respective types) and round-trip without transformation.
 *
 *  §11 telemetry: `revealedCells` is serialized as a sorted array of cell
 *  keys (Sets don't survive JSON.stringify). Sorted for deterministic save
 *  blob ordering — diff-friendly + smaller-on-disk than the unsorted iteration
 *  order. */
export interface SerializedWorld {
  readonly islands: ReadonlyArray<SerializedIslandSpec>;
  readonly seed?: string;
  readonly drones: ReadonlyArray<SerializedDrone>;
  readonly routes: ReadonlyArray<Route>;
  readonly vehicles: ReadonlyArray<SettlementVehicle>;
  readonly revealedCells?: ReadonlyArray<string>;
  /** §14.2 satellite fleet. */
  readonly satellites: ReadonlyArray<import('./orbital.js').Satellite>;
  /** §14.12 T6 Repair Drone fleet. */
  readonly repairDrones: ReadonlyArray<import('./orbital.js').RepairDrone>;
  /** §14.8 orbital debris fields. */
  readonly debrisFields: ReadonlyArray<import('./orbital.js').DebrisField>;
  /** Tutorial onboarding state. */
  readonly tutorialState?: { completed: ObjectiveId[]; current: ObjectiveId | null };
  /** §13.4 endgame progress. */
  readonly endgameState?: {
    readonly achieved: ReadonlyArray<VictoryCondition>;
    readonly firstAchievedMs: number | null;
  };
  /** §13.3 Omniscient Lattice activation. */
  readonly latticeActive?: boolean;
  /** §13.3 Lattice Node island list. */
  readonly latticeNodeIslands?: ReadonlyArray<string>;
  /** §14.4 in-flight comm packets. */
  readonly commPackets: ReadonlyArray<import('./orbital.js').CommPacket>;
  /** §2.1 infinite map — cell keys (`"cellX,cellY"`) the procedural
   *  generator has already considered. Serialized as a sorted array so
   *  the blob diffs cleanly between saves (mirrors `revealedCells`). */
  readonly generatedCells?: ReadonlyArray<string>;
  /** Ocean-layer §2 — sparse ocean-terrain map as `[key, spec]` pairs
   *  (Maps don't survive JSON; mirrors the `unlockedNodes` idiom).
   *  Sorted by key for deterministic blob output. */
  readonly oceanCells?: ReadonlyArray<readonly [string, OceanCellSpec]>;
  /** Ocean-layer §5 — depth-revealed cell keys as a sorted array
   *  (mirrors `revealedCells`). */
  readonly depthRevealedCells?: ReadonlyArray<string>;
  /** §si-units Phase 1 — global CO₂ pool in kg. */
  readonly totalCo2Kg: number;
  /** §si-units Phase 1 — player geo-latitude in [-90, +90] or null. */
  readonly playerLat: number | null;
  /** §si-units Phase 1 — player geo-longitude in [-180, +180] or null. */
  readonly playerLon: number | null;
}

// ---------------------------------------------------------------------------
// Historical snapshot shapes (for migrations)
// ---------------------------------------------------------------------------

/** v7 island state — same as v8 but without unlockedEdges and with the old
 *  progression fields subPathProgress and specializationRole. */
export type SerializedIslandStateV7 = Omit<SerializedIslandState, 'unlockedEdges' | 'socketBindings'> & {
  readonly subPathProgress: ReadonlyArray<[string, { spent: number; complete: boolean }]>;
  readonly specializationRole: string | null;
};

/** v8 island state — same as v9 but without socketBindings. */
export type SerializedIslandStateV8 = Omit<SerializedIslandState, 'socketBindings'>;

/** v7 top-level snapshot shape. Mirrors SaveSnapshot but with v7 island
 *  states and schema version pinned to 7. */
export interface SerializedSnapshotV7 {
  readonly v: 7;
  readonly savedAt: number;
  readonly savedAtPerf: number;
  readonly world: SerializedWorld;
  readonly islandStates: ReadonlyArray<{
    readonly id: string;
    readonly state: SerializedIslandStateV7;
  }>;
}

/** v8 top-level snapshot shape. Mirrors SaveSnapshot but with v8 island
 *  states and schema version pinned to 8. */
export interface SerializedSnapshotV8 {
  readonly v: 8;
  readonly savedAt: number;
  readonly savedAtPerf: number;
  readonly world: SerializedWorld;
  readonly islandStates: ReadonlyArray<{
    readonly id: string;
    readonly state: SerializedIslandStateV8;
  }>;
}

/** Migrate a v7 snapshot to v8 (intermediate shape). Preserves identity (level,
 *  xp, inventory, buildings) and resets progression: unlockedNodes → [],
 *  unlockedEdges → [], strips subPathProgress / specializationRole,
 *  recomputes unspentSkillPoints as max(0, level - 1). */
export function migrateV7toV8(s: SerializedSnapshotV7): SerializedSnapshotV8 {
  return {
    ...s,
    v: 8 as const,
    islandStates: s.islandStates.map((entry) => {
      const { subPathProgress: _sp, specializationRole: _sr, ...stateRest } = entry.state;
      void _sp;
      void _sr;
      return {
        id: entry.id,
        state: {
          ...stateRest,
          unlockedNodes: [] as ReadonlyArray<NodeId>,
          unlockedEdges: [] as ReadonlyArray<EdgeId>,
          unspentSkillPoints: Math.max(0, entry.state.level - 1),
        },
      };
    }),
  };
}

/** Migrate a v8 snapshot to v9 (intermediate shape). Adds empty socketBindings to
 *  every island state. Lossless — existing saves get empty bindings. */
export function migrateV8toV9(s: SerializedSnapshotV8): SerializedSnapshotV9 {
  return {
    ...s,
    v: 9 as const,
    islandStates: s.islandStates.map((entry) => ({
      id: entry.id,
      state: {
        ...entry.state,
        socketBindings: [] as ReadonlyArray<[string, CrystalId]>,
      } as unknown as SerializedIslandState,
    })),
  } as SerializedSnapshotV9;
}

/** v9 top-level snapshot shape. Structurally identical to v10 (SaveSnapshot)
 *  except the v literal. The v9 → v10 migration only resets per-island skill
 *  progression. */
export type SerializedSnapshotV9 = Omit<SaveSnapshot, 'v'> & { readonly v: 9 };

/** Migrate a v9 snapshot to v10 (current). Resets skill progression on every
 *  island and refunds all spent SP — required because v9 shipped with a bug:
 *  the graph generator left notable + depth-1 filler nodes unconnected, so
 *  players could buy any notable directly for its flat cost with no chain
 *  investment. v10 fixes the graph (notables now anchor to their sub-path's
 *  filler chain) but already-saved progressions are no longer reachable under
 *  the corrected topology, so we clear them and refund SP.
 *
 *  Preserved: level, xp, inventory, buildings, socketBindings (crafted
 *  crystals stay bound; the mini-tree node ownership in unlockedNodes gets
 *  wiped along with everything else).
 *  Reset: unlockedNodes → [], unlockedEdges → [], unspentSkillPoints →
 *  cumulativeSkillPointsForLevel(level) — the §9.1-correct total a level-L
 *  island should have received under the 1.1^level grant curve. At L10 that's
 *  ~14 SP; at L70 ~5500; at L100 ~~14000 (vs. the flat (level-1) approximation
 *  which under-refunds badly past ~L15). */
export function migrateV9toV10(s: SerializedSnapshotV9): SerializedSnapshotV10 {
  return {
    ...s,
    v: 10 as const,
    islandStates: s.islandStates.map((entry) => ({
      id: entry.id,
      state: {
        ...entry.state,
        unlockedNodes: [] as ReadonlyArray<NodeId>,
        unlockedEdges: [] as ReadonlyArray<EdgeId>,
        unspentSkillPoints: cumulativeSkillPointsForLevel(entry.state.level),
      },
    })),
  } as SerializedSnapshotV10;
}

/** v10 top-level snapshot shape. Structurally identical to v11 except the v
 *  literal. The v10 → v11 migration is a per-island SP top-up. */
export type SerializedSnapshotV10 = Omit<SaveSnapshot, 'v'> & { readonly v: 10 };

/** v11 top-level snapshot shape. Structurally identical to v12 (SaveSnapshot)
 *  except the v literal AND the per-island state's energy-buffer field name. */
export interface SerializedIslandStateV11
  extends Omit<SerializedIslandState, 'batteryStoredWs'> {
  readonly singularityStoredWs: number;
}

export interface SerializedSnapshotV11
  extends Omit<Omit<SaveSnapshot, 'v'>, 'islandStates'> {
  readonly v: 11;
  readonly islandStates: ReadonlyArray<{
    readonly id: string;
    readonly state: SerializedIslandStateV11;
  }>;
}

/** Migrate a v10 snapshot to v11. Top-up only — does NOT reset
 *  progression. The shipped v10 migration used a wrong formula
 *  (`max(0, level - 1)`) that under-refunded high-level islands (L70 got 69
 *  SP instead of ~5500). This pass corrects: if any island's unspent SP is
 *  below cumulativeSkillPointsForLevel(level), bump it up to that value.
 *
 *  Side effect: a player who legitimately spent SP after v9→v10 migration
 *  gets refunded the difference (over-credit). That's the friendly
 *  direction and was explicitly chosen — under-refund must be fixable
 *  without making players manually re-buy everything they unlocked since. */
export function migrateV10toV11(s: SerializedSnapshotV10): SerializedSnapshotV11 {
  return {
    ...s,
    v: 11 as const,
    islandStates: s.islandStates.map((entry): { id: string; state: SerializedIslandStateV11 } => ({
      id: entry.id,
      state: {
        ...entry.state as unknown as SerializedIslandStateV11,
        unspentSkillPoints: Math.max(
          entry.state.unspentSkillPoints,
          cumulativeSkillPointsForLevel(entry.state.level),
        ),
      },
    })),
  } as SerializedSnapshotV11;
}

/** Migrate a v11 snapshot to v12 (current). Renames the per-island energy
 *  buffer field singularityStoredWs → batteryStoredWs. Lossless — every
 *  island's stored energy carries over to the generalised battery system. */
export function migrateV11toV12(s: SerializedSnapshotV11): SaveSnapshot {
  return {
    ...s,
    v: 12 as const,
    islandStates: s.islandStates.map((entry) => {
      const { singularityStoredWs, ...stateRest } = entry.state;
      return {
        id: entry.id,
        state: {
          ...stateRest,
          batteryStoredWs: singularityStoredWs,
        } as unknown as SerializedIslandState,
      };
    }),
  } as unknown as SaveSnapshot;
}

/** v12 shape — drones lack scanBuffer field. v13 adds it. */
export interface SerializedSnapshotV12 {
  readonly v: 12;
  readonly savedAt: number;
  readonly savedAtPerf: number;
  readonly world: {
    readonly islands: ReadonlyArray<SerializedIslandSpec>;
    readonly seed?: string;
    readonly drones: ReadonlyArray<SerializedDroneV12>;
    readonly routes: ReadonlyArray<Route>;
    readonly vehicles: ReadonlyArray<SettlementVehicle>;
    readonly revealedCells?: ReadonlyArray<string>;
    readonly satellites: ReadonlyArray<import('./orbital.js').Satellite>;
    readonly repairDrones: ReadonlyArray<import('./orbital.js').RepairDrone>;
    readonly debrisFields: ReadonlyArray<import('./orbital.js').DebrisField>;
    readonly tutorialState?: { completed: ObjectiveId[]; current: ObjectiveId | null };
    readonly endgameState?: {
      readonly achieved: ReadonlyArray<VictoryCondition>;
      readonly firstAchievedMs: number | null;
    };
    readonly latticeActive?: boolean;
    readonly latticeNodeIslands?: ReadonlyArray<string>;
    readonly commPackets: ReadonlyArray<import('./orbital.js').CommPacket>;
    readonly generatedCells?: ReadonlyArray<string>;
    readonly oceanCells?: ReadonlyArray<readonly [string, OceanCellSpec]>;
    readonly depthRevealedCells?: ReadonlyArray<string>;
  };
  readonly islandStates: ReadonlyArray<SerializedIslandStateEntry>;
}

/** Drone shape pre-scanBuffer. */
export type SerializedDroneV12 = Omit<Drone, 'scanBuffer'>;

/** v12 → v13: add scanBuffer to every drone (default empty array,
 *  deserialises to empty Set). Lossless — in-flight drones at v12 had no
 *  buffer concept, so empty is the correct default. */
export function migrateV12toV13(s: SerializedSnapshotV12): SaveSnapshot {
  return {
    ...s,
    v: 13 as const,
    world: {
      ...s.world,
      drones: s.world.drones.map((d) => ({
        ...d,
        scanBuffer: [],
      })),
    },
  } as unknown as SaveSnapshot;
}

/** v13 top-level snapshot shape. Structurally identical to v14 (SaveSnapshot)
 *  except the v literal. The v13 → v14 migration resets per-island
 *  progression. */
export type SerializedSnapshotV13 = Omit<SaveSnapshot, 'v'> & { readonly v: 13 };

/** v14 top-level snapshot — structurally identical to v15 SaveSnapshot
 *  except for the missing co2Kg / totalCo2Kg / playerLat / playerLon fields. */
export type SerializedSnapshotV14 = Omit<SaveSnapshot, 'v' | 'world' | 'islandStates'> & {
  readonly v: 14;
  readonly world: Omit<SerializedWorld, 'totalCo2Kg' | 'playerLat' | 'playerLon'>;
  readonly islandStates: ReadonlyArray<{
    readonly id: string;
    readonly state: Omit<SerializedIslandState, 'co2Kg'>;
  }>;
};

/** v15 top-level snapshot shape. Structurally identical to v16 (SaveSnapshot)
 *  except the v literal. The v15 → v16 migration only bumps the version:
 *  floorLevel is optional on PlacedBuilding so absence in v15 ≡ 0 at read time. */
export type SerializedSnapshotV15 = Omit<SaveSnapshot, 'v'> & { readonly v: 15 };

/** v13 → v14: reset per-island level, xp, unspentSkillPoints, and skill-tree
 *  progression (unlockedNodes, unlockedEdges, socketBindings). Preserves
 *  buildings, inventory, drones, routes, satellites — everything outside the
 *  progression ladder.
 *  Rationale: rebalance reshapes per-node magnitudes; previously-spent SP
 *  no longer matches the new cap calculus, so a fresh allocation is the
 *  cleanest fix. Player keeps the world they built. */
export function migrateV13toV14(s: SerializedSnapshotV13): SaveSnapshot {
  return {
    ...s,
    v: 14 as const,
    islandStates: s.islandStates.map((entry) => ({
      ...entry,
      state: {
        ...entry.state,
        level: 1,
        xp: 0,
        unspentSkillPoints: 0,
        unlockedNodes: [],
        unlockedEdges: [],
        socketBindings: [],
      },
    })),
  } as unknown as SaveSnapshot;
}

/** v14 → v15: additive — seeds co2Kg, totalCo2Kg, playerLat, playerLon with safe defaults. */
export function migrateV14toV15(s: SerializedSnapshotV14): SaveSnapshot {
  return {
    ...s,
    v: 15 as const,
    world: {
      ...s.world,
      totalCo2Kg: 0,
      playerLat: null,
      playerLon: null,
    },
    islandStates: s.islandStates.map((entry) => ({
      ...entry,
      state: { ...entry.state, co2Kg: 0 },
    })),
  } as unknown as SaveSnapshot;
}

/** v15 → v16: additive version bump only. PlacedBuilding.floorLevel is optional;
 *  absent in v15 saves is handled by the floorLevel() helper at read time. */
export function migrateV15toV16(s: SerializedSnapshotV15): SaveSnapshot {
  return { ...s, v: 16 as const } as unknown as SaveSnapshot;
}

/** v16 top-level snapshot shape. Structurally identical to v17 (SaveSnapshot)
 *  except the v literal. The v16 → v17 migration is a skill-tree ladder reset:
 *  the de-noding rebalance removed/renamed node ids, so persisted progression
 *  keyed on them is invalid. */
export type SerializedSnapshotV16 = Omit<SaveSnapshot, 'v'> & { readonly v: 16 };

/** v16 → v17: skill-tree v2 ladder reset. The de-noding pass removed and
 *  renamed many node ids, so every persisted field keyed on a node/edge/socket
 *  id is now invalid: clear them and refund the player's skill points so they
 *  re-spend against the new topology from scratch.
 *
 *  Preserved (UNLIKE the v13 → v14 reset, which also nuked level/xp): level,
 *  xp, inventory, buildings — everything the player built stays. Only the
 *  progression ladder is wound back.
 *  Reset: unlockedNodes → [], unlockedEdges → [], socketBindings → []
 *  (binding keys are node/socket ids, now invalid), unspentSkillPoints →
 *  cumulativeSkillPointsForLevel(level) — the §9.1-correct full total a
 *  level-L island has earned, so no SP is lost in the reset. */
export function migrateV16toV17(s: SerializedSnapshotV16): SaveSnapshot {
  return {
    ...s,
    v: 17 as const,
    islandStates: s.islandStates.map((entry) => ({
      id: entry.id,
      state: {
        ...entry.state,
        unlockedNodes: [] as ReadonlyArray<NodeId>,
        unlockedEdges: [] as ReadonlyArray<EdgeId>,
        socketBindings: [] as ReadonlyArray<[string, CrystalId]>,
        unspentSkillPoints: cumulativeSkillPointsForLevel(entry.state.level),
      },
    })),
  } as unknown as SaveSnapshot;
}

/** v17 top-level snapshot shape. Structurally identical to v18 (SaveSnapshot)
 *  except the v literal. The v17 → v18 migration is a pure version bump:
 *  the new build-queue fields (`queued`/`queueSeq` per building,
 *  `nextQueueSeq` per island state) are all optional with absent ≡ default. */
export type SerializedSnapshotV17 = Omit<SaveSnapshot, 'v'> & { readonly v: 17 };

/** v17 → v18: build-queue fields shipped. `queued`/`queueSeq` (per building)
 *  and `nextQueueSeq` (per island state) are all optional with absent ≡ default
 *  (not queued / seq 0), so old saves need no backfill — every in-progress build
 *  loads as running, nothing queued. Pure version bump. */
export function migrateV17toV18(s: SerializedSnapshotV17): SerializedSnapshotV18 {
  return { ...s, v: 18 as const } as unknown as SerializedSnapshotV18;
}

/** v18 top-level snapshot shape. Structurally identical to v19 (SaveSnapshot)
 *  except the v literal and the per-island `everProduced` seen-set, which a
 *  v18 save lacks entirely. */
export type SerializedSnapshotV18 = Omit<SaveSnapshot, 'v'> & { readonly v: 18 };

/** v18 → v19: per-island `everProduced` seen-set shipped. A v18 save never
 *  carries a valid `everProduced` (the field didn't exist), so we backfill it
 *  from the resources the island currently holds a POSITIVE stock of. This is
 *  the best available proxy for "has ever produced" on a legacy save, since no
 *  production history exists — legacy players keep trading what they actually
 *  deal in without getting the whole catalog for free. (The raw inventory map
 *  zero-fills every resource, so an unfiltered key dump would mark all of them
 *  ever-produced and bypass the trade "get" gate entirely.) Deserialize
 *  rebuilds the array into a `Set`. */
export function migrateV18toV19(s: SerializedSnapshotV18): SerializedSnapshotV19 {
  return {
    ...s,
    v: 19 as const,
    islandStates: s.islandStates.map((entry) => ({
      ...entry,
      state: {
        ...entry.state,
        everProduced: (Object.keys(entry.state.inventory ?? {}) as ResourceId[])
          .filter((r) => (entry.state.inventory[r] ?? 0) > 0),
      },
    })),
  } as unknown as SerializedSnapshotV19;
}

/** v19 top-level snapshot shape. Structurally identical to v20 (SaveSnapshot)
 *  except the v literal and the per-island trade-cadence fields a v19 save
 *  lacks entirely (`tradeCooldownMs`, `tradeAcceptCount`). */
export type SerializedSnapshotV19 = Omit<SaveSnapshot, 'v'> & { readonly v: 19 };

/** v19 → v20: per-island persisted trade cadence shipped. A v19 save carries
 *  neither field; backfill both to 0 — first offer prompt, base cadence (the
 *  pre-persistence behavior). This is what closes the refresh-farm exploit for
 *  legacy saves going forward. Deserialize carries the numbers through. */
export function migrateV19toV20(s: SerializedSnapshotV19): SaveSnapshot {
  return {
    ...s,
    v: 20 as const,
    islandStates: s.islandStates.map((entry) => ({
      ...entry,
      state: { ...entry.state, tradeCooldownMs: 0, tradeAcceptCount: 0 },
    })),
  } as unknown as SaveSnapshot;
}

export interface SaveSnapshot {
  readonly v: typeof SCHEMA_VERSION;
  /** `Date.now()` wall-clock ms at save time. Used to compute the offline
   *  delta on restore — see the module head for the lastTick remapping. */
  readonly savedAt: number;
  /** `performance.now()` at save time. The prior session's perf-domain
   *  anchor — drone/route timestamps were minted relative to this value,
   *  so the loader needs it to translate them into the new session's
   *  perf-domain. Without this, saved in-flight craft are stuck forever. */
  readonly savedAtPerf: number;
  readonly world: SerializedWorld;
  readonly islandStates: ReadonlyArray<SerializedIslandStateEntry>;
}

// ---------------------------------------------------------------------------
// Serialize
// ---------------------------------------------------------------------------

/**
 * Project the runtime world + island-state map into a JSON-safe snapshot.
 * Pure — no IDB access, no Date.now beyond the timestamp field. Tested in
 * isolation.
 *
 * `nowWallMs` is the wall-clock save timestamp (defaults to `Date.now()`);
 * accepting it as a parameter lets tests assert exact values.
 */
export function serializeWorld(
  world: WorldState,
  islandStates: ReadonlyMap<string, IslandState>,
  nowWallMs: number = Date.now(),
  nowPerfMs: number = performance.now(),
): SaveSnapshot {
  const islands: SerializedIslandSpec[] = world.islands.map((s) => {
    // Strip terrainAt; preserve every other field including the mutable
    // `discovered` flag and the buildings array (which is shared by
    // reference with `IslandState.buildings` at runtime but is JSON-safe
    // either way — only the contents matter at serialization time).
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    const { terrainAt: _terrainAt, ...rest } = s;
    return rest;
  });
  const stateEntries: SerializedIslandStateEntry[] = [];
  for (const [id, state] of islandStates) {
    const {
      unlockedNodes, unlockedEdges, socketBindings, everProduced,
      auraAmpVersion: _v,
      auraAmpCache: _c,
      auraAmpCacheVersion: _cv,
      ...rest
    } = state;
    const serialized: SerializedIslandState = {
      ...rest,
      unlockedNodes: [...unlockedNodes],
      unlockedEdges: [...unlockedEdges],
      socketBindings: [...socketBindings],
      everProduced: [...everProduced],
    };
    stateEntries.push({ id, state: serialized });
  }

  return {
    v: SCHEMA_VERSION,
    savedAt: nowWallMs,
    savedAtPerf: nowPerfMs,
    world: {
      islands,
      seed: world.seed,
      // Project drones to serialisable shape: scanBuffer Set → sorted Array.
      drones: world.drones.map((d) => ({
        ...d,
        scanBuffer: [...d.scanBuffer].sort(),
      })),
      routes: world.routes.map((r) => ({
        ...r,
        // Defensive copy of the mutable inFlight array so post-snapshot
        // mutations to the live route don't leak into the serialized blob.
        inFlight: [...r.inFlight],
      })),
      // Vehicles are immutable records, no nested mutable state to deep-copy.
      vehicles: [...world.vehicles],
      // §11 telemetry: snapshot the revealed-cell set as a sorted array.
      // Sorted for deterministic blob output (diff-friendly between saves).
      revealedCells: [...world.revealedCells].sort(),
      // §14.2 satellites: shallow copy of the mutable array.
      satellites: [...world.satellites],
      // §14.12 repair drones: shallow copy of the mutable array.
      repairDrones: [...world.repairDrones],
      // §14.8 debris fields: shallow copy of the mutable array.
      debrisFields: [...world.debrisFields],
      // Tutorial onboarding state.
      tutorialState: {
        completed: Array.from(world.tutorialState?.completed ?? []),
        current: world.tutorialState?.current ?? null,
      },
      // §13.4 endgame state.
      endgameState: {
        achieved: [...(world.endgameState?.achieved ?? [])],
        firstAchievedMs: world.endgameState?.firstAchievedMs ?? null,
      },
      latticeActive: world.latticeActive,
      latticeNodeIslands: [...world.latticeNodeIslands],
      commPackets: [...world.commPackets],
      totalCo2Kg: world.totalCo2Kg,
      playerLat: world.playerLat,
      playerLon: world.playerLon,
      // §2.1 infinite map — sorted for deterministic save-blob ordering
      // (mirror of `revealedCells`). Absent if the world predates the
      // field (`makeInitialWorld` always seeds it on a fresh game).
      generatedCells: world.generatedCells ? [...world.generatedCells].sort() : undefined,
      // Ocean-layer §2 — Map → sorted array of [key, spec] pairs.
      // Sorted by cell key for deterministic blob output (mirror of
      // `revealedCells` / `generatedCells`). Maps don't survive
      // `JSON.stringify`, so the array-of-pairs idiom is the
      // round-trip-safe shape (matches `SerializedIslandState.unlockedNodes`).
      oceanCells: [...world.oceanCells.entries()].sort((a, b) =>
        a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0,
      ),
      // Ocean-layer §5 — sorted array (Sets don't survive
      // `JSON.stringify`). Sort for diff-friendly save blobs.
      depthRevealedCells: [...world.depthRevealedCells].sort(),
    },
    islandStates: stateEntries,
  };
}

// ---------------------------------------------------------------------------
// Deserialize
// ---------------------------------------------------------------------------

/**
 * Inverse of `serializeWorld`. Rehydrates closures (terrainAt) and converts
 * arrays back to Set/Map. Also remaps every state's `lastTick` from the
 * saved wall-clock domain into the current `performance.now()` domain so
 * the next `advanceIsland` call processes the offline gap correctly.
 *
 * `nowWallMs` / `nowPerfMs` default to the current Date/performance values
 * but are injectable for tests.
 *
 * Throws on a snapshot with an unrecognised `v`. Callers (`loadWorld`)
 * swallow the throw and return null so the game can fall back to a fresh
 * world on a corrupt save.
 */

export function deserializeWorld(
  snapshot: SaveSnapshot,
  nowWallMs: number = Date.now(),
  nowPerfMs: number = performance.now(),
): { world: WorldState; islandStates: Map<string, IslandState> } {
  // Walk the v7 → … → SCHEMA_VERSION migration chain, one step per version.
  if ((snapshot as unknown as { v: number }).v === 7) {
    snapshot = migrateV7toV8(snapshot as unknown as SerializedSnapshotV7) as unknown as SaveSnapshot;
  }
  if ((snapshot as unknown as { v: number }).v === 8) {
    snapshot = migrateV8toV9(snapshot as unknown as SerializedSnapshotV8) as unknown as SaveSnapshot;
  }
  if ((snapshot as unknown as { v: number }).v === 9) {
    snapshot = migrateV9toV10(snapshot as unknown as SerializedSnapshotV9) as unknown as SaveSnapshot;
  }
  if ((snapshot as unknown as { v: number }).v === 10) {
    snapshot = migrateV10toV11(snapshot as unknown as SerializedSnapshotV10) as unknown as SaveSnapshot;
  }
  if ((snapshot as unknown as { v: number }).v === 11) {
    snapshot = migrateV11toV12(snapshot as unknown as SerializedSnapshotV11);
  }
  if ((snapshot as unknown as { v: number }).v === 12) {
    snapshot = migrateV12toV13(snapshot as unknown as SerializedSnapshotV12);
  }
  if ((snapshot as unknown as { v: number }).v === 13) {
    snapshot = migrateV13toV14(snapshot as unknown as SerializedSnapshotV13);
  }
  if ((snapshot as unknown as { v: number }).v === 14) {
    snapshot = migrateV14toV15(snapshot as unknown as SerializedSnapshotV14);
  }
  if ((snapshot as unknown as { v: number }).v === 15) {
    snapshot = migrateV15toV16(snapshot as unknown as SerializedSnapshotV15);
  }
  if ((snapshot as unknown as { v: number }).v === 16) {
    snapshot = migrateV16toV17(snapshot as unknown as SerializedSnapshotV16);
  }
  if ((snapshot as unknown as { v: number }).v === 17) {
    snapshot = migrateV17toV18(snapshot as unknown as SerializedSnapshotV17) as unknown as SaveSnapshot;
  }
  if ((snapshot as unknown as { v: number }).v === 18) {
    snapshot = migrateV18toV19(snapshot as unknown as SerializedSnapshotV18) as unknown as SaveSnapshot;
  }
  if ((snapshot as unknown as { v: number }).v === 19) {
    snapshot = migrateV19toV20(snapshot as unknown as SerializedSnapshotV19);
  }

  if (snapshot.v !== SCHEMA_VERSION) {
    throw new Error(
      `save version ${String(snapshot.v)} not supported (current: ${String(SCHEMA_VERSION)}); ` +
      `supported versions: ${[...SUPPORTED_LOAD_VERSIONS].join(', ')}.`,
    );
  }

  // Wall-clock delta between save and now. Negative would mean the system
  // clock moved backward; clamp to 0 so we don't replay a synthetic future
  // tick (advanceIsland's `nowMs <= lastTick` guard handles equality fine).
  const deltaMs = Math.max(0, nowWallMs - snapshot.savedAt);

  // Drone/route/vehicle perfShift defined just below; the buildings array
  // needs the same shift applied to its §4.7 maintenance timestamps so
  // `placedAt` / `maintainedAt` land in the NEW session's perf-domain.
  // `operatingMs` is a DURATION — never perfShift it; it preserves literally.
  const perfShift = nowPerfMs - snapshot.savedAtPerf - deltaMs;
  const islands: IslandSpec[] = snapshot.world.islands.map((s) => {
    // Rehydrate the per-island terrainAt closure via the shared
    // `attachTerrainAt` helper. The helper binds the closure to the spec
    // it returns BY REFERENCE so §3.6 extraEllipses (round-tripped via the
    // `...s` spread below) and any future in-place merge that mutates them
    // are observed live — capturing radii at closure-build time would
    // silently miss extra-ellipse tiles. `terrainAtForBiome` short-circuits
    // on `id === 'home'` so the home spec is unaffected by the predicate.
    return attachTerrainAt({
      ...s,
      // The buildings array is mutable on the live spec, so we clone it.
      // The serializer already deep-copied via JSON-equivalence in the IDB
      // layer, but explicit cloning makes the in-memory round-trip path
      // (tests) safe too. Each building gets its maintenance timestamps
      // shifted into the new perf-clock domain (drone/route timestamp
      // remap mirror).
      buildings: s.buildings.map((b) => ({
        ...b,
        ...(b.placedAt !== undefined
          ? { placedAt: b.placedAt + perfShift }
          : {}),
        ...(b.maintainedAt !== undefined
          ? { maintainedAt: b.maintainedAt + perfShift }
          : {}),
        ...(b.toxicityExpiryMs !== undefined
          ? { toxicityExpiryMs: b.toxicityExpiryMs + perfShift }
          : {}),
      })),
    });
  });

  // Drone and route timestamps were minted in the SAVED session's
  // `performance.now()` domain (which is per-page-load and resets to ~0 on
  // every refresh). They share the `perfShift` constant declared above
  // (also used for the buildings' maintenance timestamps).
  //
  // The translation: `T_new = T_saved + perfShift`, where
  //   perfShift = nowPerfMs - snapshot.savedAtPerf - deltaMs.
  //
  // Conceptually that's "shift saved-perf timestamps so a value that was
  // `savedAtPerf` lands at `nowPerfMs - deltaMs` in the new perf-domain"
  // — i.e. as far in the new session's past as the offline gap was long.
  // Anything that was a future event whose time has elapsed lands at-or-
  // below nowPerfMs and the next tick processes it as already-arrived, the
  // same "1 frame or 24h, one code path" property the lastTick remap gives
  // advanceIsland.
  const world: WorldState = {
    islands,
    seed: snapshot.world.seed ?? WORLD_SEED,
    drones: snapshot.world.drones.map((d) => ({
      ...d,
      launchTime: d.launchTime + perfShift,
      expectedReturnTime: d.expectedReturnTime + perfShift,
      scanBuffer: new Set<string>((d as unknown as { scanBuffer?: ReadonlyArray<string> }).scanBuffer ?? []),
    })),
    routes: snapshot.world.routes.map((r) => ({
      ...r,
      inFlight: r.inFlight.map((b) => ({
        ...b,
        arrivalTime: b.arrivalTime + perfShift,
        dispatchTime: b.dispatchTime + perfShift,
      })),
    })),
    vehicles: snapshot.world.vehicles.map((v) => ({
      ...v,
      launchTime: v.launchTime + perfShift,
      expectedArrivalTime: v.expectedArrivalTime + perfShift,
    })),
    revealedCells: deserializeRevealedCells(islands, snapshot.world.revealedCells),
    satellites: snapshot.world.satellites.map((s) => ({
      ...s,
      buffer: (s as { buffer: Satellite['buffer'] }).buffer.slice(-SAT_BUFFER_CAP),
    })),
    repairDrones: snapshot.world.repairDrones.map((d) => ({
      ...d,
      launchTime: d.launchTime + perfShift,
      expectedArrivalTime: d.expectedArrivalTime + perfShift,
    })),
    debrisFields: [...snapshot.world.debrisFields],
    tutorialState: snapshot.world.tutorialState
      ? {
          completed: new Set(snapshot.world.tutorialState.completed),
          current: snapshot.world.tutorialState.current,
        }
      : { completed: new Set(), current: 'place_solar' },
    endgameState: snapshot.world.endgameState
      ? {
          achieved: new Set<VictoryCondition>(snapshot.world.endgameState.achieved),
          firstAchievedMs: snapshot.world.endgameState.firstAchievedMs,
        }
      : { achieved: new Set<VictoryCondition>(), firstAchievedMs: null },
    latticeActive: snapshot.world.latticeActive ?? false,
    latticeNodeIslands: [...(snapshot.world.latticeNodeIslands ?? [])],
    commPackets: [...snapshot.world.commPackets],
    totalCo2Kg: snapshot.world.totalCo2Kg,
    playerLat: snapshot.world.playerLat,
    playerLon: snapshot.world.playerLon,
    generatedCells: deserializeGeneratedCells(islands, snapshot.world.generatedCells),
    oceanCells: new Map(snapshot.world.oceanCells ?? []),
    depthRevealedCells: new Set(snapshot.world.depthRevealedCells ?? []),
    recentBuildAttempts: new Set(),
    recentBuildAttemptTs: new Map(),
  };

  const islandStates = new Map<string, IslandState>();
  for (const entry of snapshot.islandStates) {
    const s = entry.state;
    // Compose the live IslandState by spreading the serialized form, then
    // replacing the two non-JSON fields and remapping lastTick. The order
    // matters: spread first, then the explicit Set/Map/lastTick writes
    // win over the carried-through values.
    const live: IslandState = {
      ...s,
      // Defensive inventory + storageCaps + funnelPending clones so the
      // restored state has its own objects (saved snapshot stays inert).
      inventory: { ...s.inventory },
      storageCaps: { ...s.storageCaps },
      funnelPending: { ...s.funnelPending },
      starterInventoryGrace: { ...s.starterInventoryGrace },
      unlockedNodes: new Set(s.unlockedNodes),
      unlockedEdges: new Set(s.unlockedEdges ?? []),
      everProduced: new Set(s.everProduced ?? []),
      auraAmpVersion: 0,
      auraAmpCache: null,
      auraAmpCacheVersion: -1,
      socketBindings: new Map(s.socketBindings ?? []),
      // §9.7 cooldown anchors. Both fields were minted in the saved
      // session's `performance.now()` domain (matching `lastTick`); apply
      // the same perfShift the drone/vehicle/repair-drone timestamps get,
      // so the 24-hour cooldown gate reads a real elapsed value after a
      // reload. Null-preserving: a fresh island has both null and must
      // survive deserialize as null (null + number would be NaN).
      declaredAt: s.declaredAt === null ? null : s.declaredAt + perfShift,
      lastResetAt: s.lastResetAt === null ? null : s.lastResetAt + perfShift,
      // Remap lastTick from the saved performance.now() domain into the
      // current session's performance.now() domain. The save preserved
      // lastTick literally; we shift by the offline delta so the
      // economy's next advance step processes the gap.
      lastTick: nowPerfMs - deltaMs,
    };
    // Re-link buildings from the live spec to keep the
    // `IslandSpec.buildings === IslandState.buildings` invariant that the
    // post-load placement / economy code depends on. Without this, the
    // live state would hold the JSON-cloned array and a future placement
    // would push into the spec's array but not the state's.
    const spec = islands.find((i) => i.id === entry.id);
    if (spec) live.buildings = spec.buildings;
    islandStates.set(entry.id, live);
  }

  // Seed the module-level id counters in drones.ts / routes.ts past the
  // largest saved suffix so newly-allocated ids can't collide with saved
  // ones. Ids are of the form `drone-N` and `route-N`; we parse the suffix
  // out and feed the max into the seeder. Non-numeric suffixes fall to 0.
  let droneMax = 0;
  for (const d of world.drones) {
    const n = parseSuffixCounter(d.id);
    if (n > droneMax) droneMax = n;
  }
  if (droneMax > 0) _seedDroneIdCounter(droneMax);
  let routeMax = 0;
  for (const r of world.routes) {
    const n = parseSuffixCounter(r.id);
    if (n > routeMax) routeMax = n;
  }
  if (routeMax > 0) _seedRouteIdCounter(routeMax);
  let vehicleMax = 0;
  for (const v of world.vehicles) {
    const n = parseSuffixCounter(v.id);
    if (n > vehicleMax) vehicleMax = n;
  }
  if (vehicleMax > 0) _seedVehicleIdCounter(vehicleMax);
  // `art-N` artificial-island ids per construction-ui.ts. Match strictly so
  // demo fixtures (e.g. `art-volcanic-1`, `desert-art-1`) don't poison the
  // seed — only ids of the production-allocated form count toward the next
  // construction's id.
  let constructionMax = 0;
  for (const s of world.islands) {
    const m = /^art-(\d+)$/.exec(s.id);
    if (m) {
      const n = Number.parseInt(m[1]!, 10);
      if (n > constructionMax) constructionMax = n;
    }
  }
  if (constructionMax > 0) _seedConstructionCounter(constructionMax);

  return { world, islandStates };
}

/** Rebuild the `revealedCells` Set on load. Starts from the saved array
 *  and re-seeds every populated or discovered island's footprint cells.
 *  Seeding is idempotent (Set semantics) and protects against hand-edited
 *  saves where `revealedCells` was trimmed below the populated set. */
function deserializeRevealedCells(
  islands: ReadonlyArray<IslandSpec>,
  saved: ReadonlyArray<string> | undefined,
): Set<string> {
  const out = new Set<string>(saved ?? []);
  for (const spec of islands) {
    if (!spec.populated && !spec.discovered) continue;
    for (const k of islandCells(spec)) out.add(k);
  }
  return out;
}

/** Rebuild the `generatedCells` Set on load. Saved blob's array is unioned
 *  with each populated spec's home cell (`tileToCell(spec.cx, spec.cy)`) so
 *  the generator never re-rolls the cell containing a settled island.
 *
 *  Note: we deliberately key off the spec's centre cell only, not its full
 *  footprint. The generator runs once per cell and is content with "this
 *  cell already has an island"; using the centre matches how the procedural
 *  generator anchors its candidates (`generateCellIslands` places at the
 *  cell centre + jitter), so a populated spec's centre cell maps 1:1 to
 *  the cell the generator would otherwise have rolled into. */
function deserializeGeneratedCells(
  islands: ReadonlyArray<IslandSpec>,
  saved: ReadonlyArray<string> | undefined,
): Set<string> {
  const out = new Set<string>(saved ?? []);
  for (const spec of islands) {
    if (!spec.populated) continue;
    const { cellX, cellY } = tileToCell(spec.cx, spec.cy);
    out.add(`${cellX},${cellY}`);
  }
  return out;
}

/** Parse the trailing integer suffix from an id like `drone-7` → 7. Returns
 *  0 if there's no recognisable trailing integer (defensive — saved data
 *  with hand-edited or future-format ids won't crash the loader). */
function parseSuffixCounter(id: string): number {
  const m = /-(\d+)$/.exec(id);
  if (!m) return 0;
  const n = parseInt(m[1]!, 10);
  return Number.isFinite(n) ? n : 0;
}

// ---------------------------------------------------------------------------
// Side-effectful wrappers (IDB)
// ---------------------------------------------------------------------------

/**
 * Persist a snapshot to IndexedDB. Swallows errors (logs to console) so a
 * save failure can't crash the game loop. Returns void.
 */
export async function saveWorld(
  world: WorldState,
  islandStates: ReadonlyMap<string, IslandState>,
): Promise<void> {
  try {
    const snapshot = serializeWorld(world, islandStates);
    await set(STORAGE_KEY, snapshot);
  } catch (err) {
    console.warn('[robot-islands] saveWorld failed:', err);
  }
}

/**
 * Delete the saved snapshot from IndexedDB. Used by the Settings panel's
 * "Clear save (start fresh)" affordance — the caller typically follows with
 * `window.location.reload()` to boot a clean session.
 *
 * Swallows errors the same way `saveWorld` does so a delete failure can't
 * crash the dismiss handler. Returns void.
 */
export async function clearSave(): Promise<void> {
  try {
    await del(STORAGE_KEY);
  } catch (err) {
    console.warn('[robot-islands] clearSave failed:', err);
  }
}

/**
 * Validate a deserialized JSON blob as a save snapshot. Used by the
 * Settings panel's "Import save" flow before writing it back to IDB.
 * The check is intentionally shallow — `v === SCHEMA_VERSION` plus the
 * presence of the top-level fields. The full deserializer enforces the
 * deeper shape on next load; a malformed inner shape will surface there
 * as a thrown error caught by `loadWorld`, falling back to fresh world.
 */
export function isValidSaveSnapshot(value: unknown): value is SaveSnapshot {
  if (typeof value !== 'object' || value === null) return false;
  const v = value as Record<string, unknown>;
  if (typeof v['v'] !== 'number' || v['v'] !== SCHEMA_VERSION) return false;
  if (typeof v['savedAt'] !== 'number') return false;
  if (typeof v['savedAtPerf'] !== 'number') return false;
  if (typeof v['world'] !== 'object' || v['world'] === null) return false;
  if (!Array.isArray(v['islandStates'])) return false;
  return true;
}

/**
 * Write an externally-provided snapshot (e.g. from clipboard / file import)
 * directly to IndexedDB. Caller is responsible for validation via
 * `isValidSaveSnapshot` first; this function trusts its input. The
 * standard follow-up is `window.location.reload()` to rehydrate world
 * state from the imported snapshot.
 */
export async function importSave(snapshot: SaveSnapshot): Promise<void> {
  await set(STORAGE_KEY, snapshot);
}

/**
 * Load and deserialize the latest snapshot, or return null if none exists,
 * the schema version is unrecognised, or the stored value is corrupt. Any
 * error path is logged and resolved with null so the caller can fall back
 * to a fresh world without crashing.
 */
export async function loadWorld(): Promise<
  { world: WorldState; islandStates: Map<string, IslandState> } | null
> {
  try {
    // Try current key first.
    let stored = (await get(STORAGE_KEY)) as SaveSnapshot | undefined;
    let foundKey: string | null = stored ? STORAGE_KEY : null;

    // Fallback: walk supported older versions, highest first.
    if (stored === undefined) {
      for (const v of [...SUPPORTED_LOAD_VERSIONS].sort((a, b) => b - a)) {
        if (v === SCHEMA_VERSION) continue;
        const oldKey = `robot-islands:save:v${v}`;
        const old = await get(oldKey);
        if (old !== undefined) {
          stored = old as SaveSnapshot;
          foundKey = oldKey;
          break;
        }
      }
    }

    if (stored === undefined) return null;
    const result = deserializeWorld(stored);

    // Migrate-write-back: if loaded from an older key, persist to current key
    // and delete the old. Future loads hit the current key directly.
    if (foundKey !== null && foundKey !== STORAGE_KEY && result !== null) {
      const snapshot = serializeWorld(result.world, result.islandStates);
      await set(STORAGE_KEY, snapshot);
      await del(foundKey);
    }

    return result;
  } catch (err) {
    console.warn('[robot-islands] loadWorld failed:', err);
    return null;
  }
}

// ---------------------------------------------------------------------------
// UI Prefs (camera transform) — separate IDB key
// ---------------------------------------------------------------------------
//
// Camera position is restored across page reloads. Kept in a separate
// `robot-islands:prefs:v<n>` key from the main save snapshot so cam-jiggle
// during pan/zoom doesn't churn the world-state blob (or vice-versa: a
// malformed prefs blob can't corrupt the save).
//
// The shape is intentionally flat and permissive: every field is optional
// at parse time, and the loader returns `null` on anything it can't trust.
// Callers then fall back to defaults (camera centred on home).
//
// Historical note: an earlier revision of this blob also persisted the
// active-island id and the open-panel id. Both were removed because
// restoring transient UI state across reload was undesirable — e.g. the
// Construct window would silently re-open on every refresh. Old v1 blobs
// that still carry those extra fields parse fine: the loader just doesn't
// read them, so no schema bump was needed.

// The IDB key keeps its `:v1` suffix even though the in-blob `v` field is now
// 2 — the suffix is just the storage namespace, and reusing it lets a v1 blob
// (camera only) be read and migrated in place rather than orphaned. Versioning
// is done by the internal `v` field; loadPrefs accepts v1 and v2.
export const PREFS_KEY = 'robot-islands:prefs:v1';
export const PREFS_VERSION = 2 as const;

/** Autosave-interval bounds (seconds). User-configurable in Settings → SAVE. */
export const DEFAULT_SAVE_INTERVAL_SEC = 30;
export const MIN_SAVE_INTERVAL_SEC = 1;
export const MAX_SAVE_INTERVAL_SEC = 600;

export interface UiPrefs {
  readonly v: typeof PREFS_VERSION;
  readonly cam: { readonly tx: number; readonly ty: number; readonly zoom: number };
  /** Autosave cadence in seconds, clamped to [1, 600]. */
  readonly saveIntervalSec: number;
}

function isFiniteNumber(x: unknown): x is number {
  return typeof x === 'number' && Number.isFinite(x);
}

/**
 * Coerce an arbitrary value to a valid autosave interval in seconds:
 * floor to a whole second and clamp to [MIN, MAX]. Anything non-finite or
 * non-numeric (NaN, Infinity, undefined, a string) falls back to the default.
 * Pure — exported for tests and reused by the Settings input.
 */
export function clampSaveIntervalSec(x: unknown): number {
  if (!isFiniteNumber(x)) return DEFAULT_SAVE_INTERVAL_SEC;
  const floored = Math.floor(x);
  if (floored < MIN_SAVE_INTERVAL_SEC) return MIN_SAVE_INTERVAL_SEC;
  if (floored > MAX_SAVE_INTERVAL_SEC) return MAX_SAVE_INTERVAL_SEC;
  return floored;
}

/**
 * Persist UI prefs (camera transform).
 * Swallows errors — pref-save failure must not interrupt the game loop.
 */
export async function savePrefs(prefs: Omit<UiPrefs, 'v'>): Promise<void> {
  try {
    const blob: UiPrefs = {
      v: PREFS_VERSION,
      cam: prefs.cam,
      saveIntervalSec: clampSaveIntervalSec(prefs.saveIntervalSec),
    };
    await set(PREFS_KEY, blob);
  } catch (err) {
    console.warn('[robot-islands] savePrefs failed:', err);
  }
}

/**
 * Load UI prefs, returning null if absent / malformed / wrong version.
 * Caller falls back to defaults (centre-on-home camera). Legacy v1 blobs
 * with extra `activeIslandId` / `openPanel` fields parse cleanly — the
 * validator just ignores them.
 */
export async function loadPrefs(): Promise<UiPrefs | null> {
  try {
    const raw = (await get(PREFS_KEY)) as unknown;
    if (typeof raw !== 'object' || raw === null) return null;
    const o = raw as Record<string, unknown>;
    // Accept v1 (camera-only) and v2 (camera + saveIntervalSec). v1 blobs
    // migrate forward in place: camera is preserved, the interval defaults.
    // Returning null here (as a strict version check would) silently wipes
    // the saved camera on every schema bump — the migration avoids that.
    if (o['v'] !== 1 && o['v'] !== PREFS_VERSION) return null;
    const cam = o['cam'];
    if (typeof cam !== 'object' || cam === null) return null;
    const c = cam as Record<string, unknown>;
    if (!isFiniteNumber(c['tx']) || !isFiniteNumber(c['ty']) || !isFiniteNumber(c['zoom'])) {
      return null;
    }
    // v1 lacks saveIntervalSec; clampSaveIntervalSec maps the missing value to
    // the default. v2 stores it; clamp defensively in case bounds change.
    return {
      v: PREFS_VERSION,
      cam: { tx: c['tx'], ty: c['ty'], zoom: c['zoom'] },
      saveIntervalSec: clampSaveIntervalSec(o['saveIntervalSec']),
    };
  } catch (err) {
    console.warn('[robot-islands] loadPrefs failed:', err);
    return null;
  }
}

/**
 * Delete the prefs blob. Used by Settings → "Clear save" so a clean reboot
 * doesn't restore a stale camera position over the fresh world.
 */
export async function clearPrefs(): Promise<void> {
  try {
    await del(PREFS_KEY);
  } catch (err) {
    console.warn('[robot-islands] clearPrefs failed:', err);
  }
}
