// IndexedDB persistence per SPEC §15.6 — save the WorldState + per-island
// IslandState map across browser sessions, restore on startup. One save
// slot per origin (the page's IndexedDB). No backend.
//
// Versioned snapshot. The v field is the schema version anchor for future
// migrations — bumping it (v: 2 later) silently invalidates v1 saves
// (`loadWorld` returns null on unknown v, the caller falls back to a fresh
// world). Migrations from prior versions are out of scope for step 14.
//
// Three concerns the serializer addresses that JSON.stringify alone can't:
//
//   1. `IslandSpec.terrainAt` is a closure (`(x, y) => terrainAtForBiome(...)`),
//      not data. Functions don't survive JSON. We strip it on save and
//      rehydrate via `terrainAtForBiome(spec.biome, spec.id, x, y)` on load —
//      the same factory `world.ts` uses to build the demo set.
//
//   2. `IslandState.unlockedNodes` is a `Set<NodeId>` and `subPathProgress`
//      is a `Map<SubPathId, …>`. Both stringify as `{}` by default. We
//      convert to/from array form explicitly so the round-trip preserves
//      membership and ordering.
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

import { islandCells } from './discovery.js';
import type { IslandState } from './economy.js';
import type { Drone } from './drones.js';
import { _seedConstructionCounter } from './construction-ui.js';
import { _seedDroneIdCounter } from './drones.js';
import type { Route } from './routes.js';
import { _seedRouteIdCounter } from './routes.js';
import type { SettlementVehicle } from './settlement.js';
import { SAT_BUFFER_CAP, type Satellite } from './orbital.js';
import type { ObjectiveId } from './tutorial.js';
import { _seedVehicleIdCounter, tuningFor } from './settlement.js';
import type { PlacedBuilding } from './buildings.js';
import { ALL_RESOURCES, type ResourceId } from './recipes.js';
import type { VictoryCondition } from './endgame.js';
import { cumulativeSkillPointsForLevel, type NodeId, type SubPathId } from './skilltree.js';
import { attachTerrainAt, WORLD_SEED, type IslandSpec, type WorldState } from './world.js';

/** IndexedDB key. Bumping the trailing version (`:v2` later) is the
 *  intended migration entry point — `loadWorld` keys on this string, so a
 *  new key returns "no save" without colliding with the v1 store.
 *
 *  Step-12 bumped this from v1 → v2: the world snapshot grew a `vehicles`
 *  field and the home spec grew a Shipyard + Kit Assembler placement.
 *  Bumping the key (rather than defaulting `vehicles ?? []`) means a stale
 *  v1 save is cleanly ignored, so a returning player gets a fresh demo
 *  seed that includes the new buildings + Foundation Kit starter inventory.
 *
 *  Step-§4.7: bumped v2 → v3 because PlacedBuilding gained `placedAt`,
 *  `operatingMs`, `maintainedAt`. The optional-field shape would let v2
 *  saves load (the maintenance code defensively treats missing fields as
 *  "not yet stamped"), but bumping invalidates them anyway to surface the
 *  schema change cleanly — saved v2 buildings have no `placedAt`, so a
 *  reload would have all buildings looking 0-second-old on the new tab,
 *  even after a 30-hour offline gap. A clean reseed is simpler than a
 *  half-correct migration.
 *
 *  See the comment on `SCHEMA_VERSION` for the reasoning. */
export const STORAGE_KEY = 'robot-islands:save:v3';

/** Current schema version. `loadWorld` rejects (returns null) any
 *  snapshot whose `v` is not strictly equal to this.
 *
 *  Step-12: bumped 1 → 2 to silently invalidate stale v1 saves that lack
 *  `world.vehicles` and the Step-12 home-island Shipyard/Kit Assembler
 *  placements. See `STORAGE_KEY` for the matching key change.
 *
 *  Step-§4.7: bumped 2 → 3 alongside the PlacedBuilding maintenance fields
 *  to discard saves that pre-date the maintenance timer.
 *
 *  Step-20 (T6 Orbital) intentionally does NOT bump 3 → 4. The new
 *  `IslandState.ascendantCoreCrafted` field is backfilled in
 *  `deserializeWorld` (defaults to false), and the new T6 ResourceIds /
 *  BuildingDefIds are additive (`ALL_RESOURCES` backfill in
 *  `deserializeWorld` zeroes new inventory keys; placed buildings list is
 *  preserved as-is). A v3 save loads cleanly without losing pre-T6
 *  progress. */
export const SCHEMA_VERSION = 3 as const;

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
  extends Omit<IslandState, 'unlockedNodes' | 'subPathProgress'> {
  readonly unlockedNodes: ReadonlyArray<NodeId>;
  readonly subPathProgress: ReadonlyArray<
    readonly [SubPathId, { readonly spent: number; readonly complete: boolean }]
  >;
}

/** One entry of the per-island state map. We avoid serializing a `Map`
 *  directly because `JSON.stringify(map)` is `{}`; an array of pairs is
 *  the de-facto idiom and survives every transport. */
export interface SerializedIslandStateEntry {
  readonly id: string;
  readonly state: SerializedIslandState;
}

/** World data minus the per-island closures. Drones, Routes, and Vehicles
 *  are already JSON-friendly (only numbers, strings, and arrays — see the
 *  respective types) and round-trip without transformation.
 *
 *  §11 telemetry: `revealedCells` is serialized as a sorted array of cell
 *  keys (Sets don't survive JSON.stringify). Sorted for deterministic save
 *  blob ordering — diff-friendly + smaller-on-disk than the unsorted iteration
 *  order. Legacy saves (pre-§11) lack this field; the deserializer backfills
 *  with cells under each populated island's footprint. */
export interface SerializedWorld {
  readonly islands: ReadonlyArray<SerializedIslandSpec>;
  readonly seed?: string;
  readonly drones: ReadonlyArray<Drone>;
  readonly routes: ReadonlyArray<Route>;
  readonly vehicles: ReadonlyArray<SettlementVehicle>;
  readonly revealedCells?: ReadonlyArray<string>;
  /** §14.2 satellite fleet. Backfilled to `[]` on legacy saves. */
  readonly satellites?: ReadonlyArray<import('./orbital.js').Satellite>;
  /** §14.12 T6 Repair Drone fleet. Backfilled to `[]` on legacy saves. */
  readonly repairDrones?: ReadonlyArray<import('./orbital.js').RepairDrone>;
  /** §14.8 orbital debris fields. Backfilled to `[]` on legacy saves. */
  readonly debrisFields?: ReadonlyArray<import('./orbital.js').DebrisField>;
  /** Tutorial onboarding state. Backfilled on legacy saves. */
  readonly tutorialState?: { completed: ObjectiveId[]; current: ObjectiveId | null };
  /** §13.4 endgame progress. Backfilled on legacy saves. */
  readonly endgameState?: {
    readonly achieved: ReadonlyArray<VictoryCondition>;
    readonly firstAchievedMs: number | null;
    readonly victoryBannerShown: boolean;
  };
  /** §13.3 Omniscient Lattice activation. Backfilled on legacy saves. */
  readonly latticeActive?: boolean;
  /** §13.3 Lattice Node island list. Backfilled on legacy saves. */
  readonly latticeNodeIslands?: ReadonlyArray<string>;
  /** §14.4 in-flight comm packets. Backfilled to `[]` on legacy saves. */
  readonly commPackets?: ReadonlyArray<import('./orbital.js').CommPacket>;
}

/** Top-level snapshot. The `v` field is the schema-version anchor: this
 *  step ships v1, future revisions bump it and the loader returns null
 *  on a v mismatch (caller falls back to a fresh world). */
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
    const serialized: SerializedIslandState = {
      ...state,
      unlockedNodes: [...state.unlockedNodes],
      subPathProgress: [...state.subPathProgress.entries()],
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
      // Spread to drop any read-only-array exotic-ness from the live arrays.
      drones: [...world.drones],
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
        victoryBannerShown: world.endgameState?.victoryBannerShown ?? false,
      },
      latticeActive: world.latticeActive,
      latticeNodeIslands: [...world.latticeNodeIslands],
      commPackets: [...world.commPackets],
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

/** Defensive migration: pre-fix saves minted ids via a session-local
 *  counter (`placed-1`, `placed-2`, …) that reset to 0 on every reload,
 *  with no persistence-side counter seeding. Saved buildings could end up
 *  sharing an id with new placements minted post-reload. The fix in
 *  `placement-ui.ts` derives new ids from anchor coords (`placed-x,y`),
 *  but legacy saves still carry colliding `placed-N` ids. This helper
 *  detects any duplicate id within an island's buildings array and
 *  re-keys the duplicates to the new coord-based shape, so the live game
 *  state is collision-free regardless of save vintage.
 *
 *  Pure: returns a new array with possibly-renamed `id` fields. Original
 *  input is not mutated. Building order is preserved. */
function rekeyCollidingBuildingIds(
  buildings: ReadonlyArray<PlacedBuilding>,
): PlacedBuilding[] {
  const seen = new Set<string>();
  return buildings.map((b) => {
    if (!seen.has(b.id)) {
      seen.add(b.id);
      return b;
    }
    // Collision — rename via the new coord-based shape. Two buildings
    // can't share an (x, y) anchor (`validatePlacement` rejects overlap),
    // so the new id is unique by construction.
    const newId = `placed-${b.x},${b.y}`;
    seen.add(newId);
    return { ...b, id: newId };
  });
}

export function deserializeWorld(
  snapshot: SaveSnapshot,
  nowWallMs: number = Date.now(),
  nowPerfMs: number = performance.now(),
): { world: WorldState; islandStates: Map<string, IslandState> } {
  if (snapshot.v !== SCHEMA_VERSION) {
    throw new Error(`persistence: unknown schema version ${String(snapshot.v)}`);
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
      // Forward-compat backfill: a save written before the player-mutable
      // display-name field existed has no `name`. Default to `id` so the
      // legacy UX (id-as-display-name) is preserved verbatim. Same
      // SCHEMA_VERSION — mirror the `ascendantCoreCrafted` / `lastResetAt`
      // backfill pattern.
      name:
        typeof (s as { name?: unknown }).name === 'string'
          ? (s as { name: string }).name
          : s.id,
      // The buildings array is mutable on the live spec, so we clone it.
      // The serializer already deep-copied via JSON-equivalence in the IDB
      // layer, but explicit cloning makes the in-memory round-trip path
      // (tests) safe too. Each building gets its maintenance timestamps
      // shifted into the new perf-clock domain (drone/route timestamp
      // remap mirror).
      buildings: rekeyCollidingBuildingIds(
        s.buildings.map((b) => ({
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
      ),
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
    seed:
      'seed' in snapshot.world && typeof (snapshot.world as { seed?: unknown }).seed === 'string'
        ? (snapshot.world as { seed: string }).seed
        : WORLD_SEED,
    drones: snapshot.world.drones.map((d) => ({
      ...d,
      launchTime: d.launchTime + perfShift,
      expectedReturnTime: d.expectedReturnTime + perfShift,
      // §11.7 tier-matched fuel backfill. Legacy saves predate the
      // `fuelResource` field — every in-flight drone written before the
      // §11.7 patch was dispatched with biofuel (the previous hardcode),
      // so default missing values to 'biofuel'. New saves carry the
      // explicit value and round-trip unchanged. Mirrors the
      // `ascendantCoreCrafted` backfill pattern below.
      fuelResource:
        'fuelResource' in d && typeof (d as { fuelResource?: unknown }).fuelResource === 'string'
          ? (d as { fuelResource: Drone['fuelResource'] }).fuelResource
          : 'biofuel',
      // T5 path-drawn drone backfill. Legacy saves predate waypoint,
      // dark-mode telemetry, and probability-bias fields.
      waypoints:
        'waypoints' in d && Array.isArray((d as { waypoints?: unknown }).waypoints)
          ? (d as { waypoints: Drone['waypoints'] }).waypoints
          : [],
      darkMode:
        'darkMode' in d && typeof (d as { darkMode?: unknown }).darkMode === 'boolean'
          ? (d as { darkMode: boolean }).darkMode
          : false,
      darkModeDiscoveries:
        'darkModeDiscoveries' in d && Array.isArray((d as { darkModeDiscoveries?: unknown }).darkModeDiscoveries)
          ? (d as { darkModeDiscoveries: Drone['darkModeDiscoveries'] }).darkModeDiscoveries
          : [],
      probabilityBias:
        'probabilityBias' in d && typeof (d as { probabilityBias?: unknown }).probabilityBias === 'number'
          ? (d as { probabilityBias: number }).probabilityBias
          : 0,
    })),
    routes: snapshot.world.routes.map((r) => ({
      ...r,
      inFlight: r.inFlight.map((b) => ({
        ...b,
        arrivalTime: b.arrivalTime + perfShift,
        dispatchTime: b.dispatchTime + perfShift,
      })),
    })),
    // Settlement vehicles share the same `performance.now()` domain as
    // drones/routes; apply the same shift so an in-flight vehicle's
    // arrival lands correctly in the new session's perf-domain.
    // Default to [] when restoring a snapshot that pre-dates the field
    // (defensive — v2 always carries `vehicles`, but a hand-crafted or
    // partially-migrated snapshot might omit it).
    vehicles: (snapshot.world.vehicles ?? []).map((v) => ({
      ...v,
      launchTime: v.launchTime + perfShift,
      expectedArrivalTime: v.expectedArrivalTime + perfShift,
      // §11.7 tier-matched fuel backfill — see drones above for rationale.
      fuelResource:
        'fuelResource' in v && typeof (v as { fuelResource?: unknown }).fuelResource === 'string'
          ? (v as { fuelResource: SettlementVehicle['fuelResource'] }).fuelResource
          : 'biofuel',
      // §12.5 mechanical-failure rate backfill. Legacy saves predate the
      // `failureRate` field — derive from vehicle kind via tuning table.
      failureRate:
        'failureRate' in v && typeof (v as { failureRate?: unknown }).failureRate === 'number'
          ? (v as { failureRate: SettlementVehicle['failureRate'] }).failureRate
          : tuningFor(
              v.kind,
              'tier' in v && typeof (v as { tier?: unknown }).tier === 'number'
                ? (v as { tier: SettlementVehicle['tier'] }).tier
                : (v.kind === 'ship' ? 1 : 2),
            ).failureRate,
    })),
    // §11 telemetry forward-compat backfill: legacy v3 saves predate the
    // `revealedCells` field. Restore from the snapshot's array (Set form
    // doesn't survive JSON); on a missing/empty array, seed every cell
    // touched by a populated island's footprint so the player doesn't
    // load into a pitch-dark world. The fresh-game seed in
    // `makeInitialWorld` does the same thing; this just covers the
    // "loaded a save written before §11 landed" case.
    revealedCells: deserializeRevealedCells(islands, snapshot.world.revealedCells),
    // §14.2 satellite fleet backfill: legacy v3 saves predate `satellites`.
    // Default to an empty array so the world loads cleanly.
    satellites: (snapshot.world.satellites ?? []).map((s) => ({
      ...s,
      buffer: Array.isArray((s as { buffer?: unknown }).buffer)
        ? (s as { buffer: Satellite['buffer'] }).buffer.slice(-SAT_BUFFER_CAP)
        : [],
    })),
    // §14.12 repair drone fleet backfill. perfShift the in-flight timestamps
    // so the prior session's `performance.now()` domain doesn't strand the
    // drone forever. Mirrors the drone (lines 354-355) / vehicle (401-402)
    // backfill pattern.
    repairDrones: (snapshot.world.repairDrones ?? []).map((d) => ({
      ...d,
      launchTime: d.launchTime + perfShift,
      expectedArrivalTime: d.expectedArrivalTime + perfShift,
    })),
    // §14.8 debris fields backfill: legacy saves predate the field.
    // No timestamp shifting needed — fields are static cell-anchored data.
    debrisFields: [...(snapshot.world.debrisFields ?? [])],
    // Tutorial onboarding state backfill: legacy saves predate the field.
    // Default to the fresh-game starting objective.
    tutorialState: snapshot.world.tutorialState
      ? {
          completed: new Set(snapshot.world.tutorialState.completed),
          current: snapshot.world.tutorialState.current,
        }
      : { completed: new Set(), current: 'place_solar' },
    // §13.4 endgame state backfill: legacy saves predate the field.
    endgameState: snapshot.world.endgameState
      ? {
          achieved: new Set<VictoryCondition>(snapshot.world.endgameState.achieved),
          firstAchievedMs: snapshot.world.endgameState.firstAchievedMs,
          victoryBannerShown: snapshot.world.endgameState.victoryBannerShown,
        }
      : { achieved: new Set<VictoryCondition>(), firstAchievedMs: null, victoryBannerShown: false },
    // §13.3 Omniscient Lattice backfill: legacy saves predate these fields.
    latticeActive: snapshot.world.latticeActive ?? false,
    latticeNodeIslands: [...(snapshot.world.latticeNodeIslands ?? [])],
    commPackets: [...(snapshot.world.commPackets ?? [])],
  };

  const islandStates = new Map<string, IslandState>();
  for (const entry of snapshot.islandStates) {
    const s = entry.state;
    // Compose the live IslandState by spreading the serialized form, then
    // replacing the two non-JSON fields and remapping lastTick. The order
    // matters: spread first, then the explicit Set/Map/lastTick writes
    // win over the carried-through values.
    const inventoryClone = { ...s.inventory };
    const storageCapsClone = { ...s.storageCaps };
    const funnelClone = { ...s.funnelPending };
    const graceClone = { ...(s as { starterInventoryGrace?: Record<ResourceId, number> }).starterInventoryGrace } as Record<ResourceId, number>;
    // Forward-compat backfill: a save written by an older build is missing
    // any ResourceId added since. The strict `Record<ResourceId, number>`
    // type would catch reads of missing keys via `noUncheckedIndexedAccess`
    // (returning undefined), but the per-cap-derived clamp in
    // `demolishBuilding` and the `applyRates` path expect a real cap
    // number — `cap=0` would silently zero the demolition credit. Seed
    // the baseline cap for missing keys; inventory stays at 0 by default.
    // Matches `world.ts` BASELINE_STORAGE_CAP — kept in sync so reload
    // produces the same per-resource baseline as a fresh state.
    const BASELINE_STORAGE_CAP = 2000;
    for (const r of ALL_RESOURCES) {
      if (!(r in inventoryClone)) inventoryClone[r] = 0;
      if (!(r in storageCapsClone)) storageCapsClone[r] = BASELINE_STORAGE_CAP;
      if (!(r in funnelClone)) funnelClone[r] = 0;
      if (!(r in graceClone)) graceClone[r] = 0;
    }
    // Forward-compat backfill: step-20 added `ascendantCoreCrafted` to
    // IslandState (§14.1 T6 access gate). A v3 save written before the
    // step-20 schema landed lacks the field; reading it through the
    // strict `boolean` type would surface as `undefined` at runtime and
    // poison every downstream gate evaluation. Default to `false` so old
    // saves keep their pre-T6 progress (the SCHEMA_VERSION 3 → 4 bump
    // alternative would invalidate every save unnecessarily).
    const ascendantCoreCrafted =
      'ascendantCoreCrafted' in s && typeof (s as { ascendantCoreCrafted?: unknown }).ascendantCoreCrafted === 'boolean'
        ? (s as { ascendantCoreCrafted: boolean }).ascendantCoreCrafted
        : false;
    // Forward-compat backfill: §9.7 Tier Reset added `lastResetAt` to
    // IslandState. Defaults to `null` (never reset) on legacy saves —
    // the cooldown gate trivially passes, matching the player's pre-§9.7
    // experience. Same SCHEMA_VERSION as ascendantCoreCrafted's backfill,
    // for the same "no need to invalidate every save" reasoning.
    const lastResetAt =
      'lastResetAt' in s &&
      (typeof (s as { lastResetAt?: unknown }).lastResetAt === 'number' ||
        (s as { lastResetAt?: unknown }).lastResetAt === null)
        ? (s as { lastResetAt: number | null }).lastResetAt
        : null;
    // Forward-compat backfill: Time Lock fields added after v3. Legacy saves
    // lack them; default to safe baseline values so banking / spending math
    // doesn't see `undefined` and produce NaN.
    const timeLockBankedMin =
      typeof (s as { timeLockBankedMin?: unknown }).timeLockBankedMin === 'number'
        ? (s as { timeLockBankedMin: number }).timeLockBankedMin
        : 0;
    const accelerationQueue = Array.isArray(
      (s as { accelerationQueue?: unknown }).accelerationQueue,
    )
      ? (s as { accelerationQueue: IslandState['accelerationQueue'] }).accelerationQueue
      : [];
    const accelerationRemainingMin =
      typeof (s as { accelerationRemainingMin?: unknown }).accelerationRemainingMin ===
      'number'
        ? (s as { accelerationRemainingMin: number }).accelerationRemainingMin
        : 0;
    const bankingEnabled =
      typeof (s as { bankingEnabled?: unknown }).bankingEnabled === 'boolean'
        ? (s as { bankingEnabled: boolean }).bankingEnabled
        : false;
    // Forward-compat backfill: Genesis Chamber target added after v3.
    const genesisTarget =
      (s as { genesisTarget?: unknown }).genesisTarget === null ||
      typeof (s as { genesisTarget?: unknown }).genesisTarget === 'string'
        ? (s as { genesisTarget: ResourceId | null }).genesisTarget
        : null;
    // Forward-compat backfill: Singularity Battery stored energy added after v3.
    const singularityStoredWs =
      typeof (s as { singularityStoredWs?: unknown }).singularityStoredWs === 'number'
        ? (s as { singularityStoredWs: number }).singularityStoredWs
        : 0;
    // Forward-compat backfill: `declaredAt` added after v3. A snapshot
    // missing the field must backfill to `null`, not `undefined`, so the
    // `null + perfShift` guard below doesn't produce NaN.
    const declaredAt =
      'declaredAt' in s &&
      (typeof (s as { declaredAt?: unknown }).declaredAt === 'number' ||
        (s as { declaredAt?: unknown }).declaredAt === null)
        ? (s as { declaredAt: number | null }).declaredAt
        : null;
    const live: IslandState = {
      ...s,
      // Defensive inventory + storageCaps + funnelPending clones so the
      // restored state has its own objects (saved snapshot stays inert).
      inventory: inventoryClone,
      storageCaps: storageCapsClone,
      funnelPending: funnelClone,
      starterInventoryGrace: graceClone,
      unlockedNodes: new Set(s.unlockedNodes),
      subPathProgress: new Map(s.subPathProgress),
      ascendantCoreCrafted,
      // §9.7 cooldown anchors. Both fields were minted in the saved
      // session's `performance.now()` domain (matching `lastTick`); apply
      // the same perfShift the drone/vehicle/repair-drone timestamps get,
      // so the 24-hour cooldown gate reads a real elapsed value after a
      // reload. Null-preserving: a fresh island has both null and must
      // survive deserialize as null (null + number would be NaN).
      declaredAt: declaredAt === null ? null : declaredAt + perfShift,
      lastResetAt: lastResetAt === null ? null : lastResetAt + perfShift,
      timeLockBankedMin,
      accelerationQueue,
      accelerationRemainingMin,
      bankingEnabled,
      genesisTarget,
      singularityStoredWs,
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
    // §9.3 grant-curve migration. Pre-migration saves got 1 skill point per
    // level-up; the new schedule is `floor(1.1^L)`. Top up by the difference
    // so a long-lived L50 save lands the 1,256 cumulative points it would
    // have under the new schedule (vs the 50 it received under the old one).
    // The flag prevents double-application across multiple loads.
    if (live.skillPointGrantMigrationApplied !== true) {
      const oldGrantTotal = live.level;
      const newGrantTotal = cumulativeSkillPointsForLevel(live.level);
      const topUp = Math.max(0, newGrantTotal - oldGrantTotal);
      live.unspentSkillPoints += topUp;
      live.skillPointGrantMigrationApplied = true;
    }
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

/** Backfill the `revealedCells` Set on load. If the saved blob carries an
 *  explicit array, use it verbatim (recent saves). If the field is missing
 *  (legacy v3 save written before §11 landed) OR the array is empty,
 *  reconstruct from each populated island's footprint cells so the player
 *  doesn't load into a pitch-dark world.
 *
 *  We deliberately also re-seed populated-island cells when the saved array
 *  is non-empty — a player's save retains whatever they explored, and the
 *  populated-island cells are part of that set, but seeding them again is
 *  idempotent (Set semantics) and protects against a future scenario where
 *  someone manually trimmed `revealedCells` from a save blob. */
function deserializeRevealedCells(
  islands: ReadonlyArray<IslandSpec>,
  saved: ReadonlyArray<string> | undefined,
): Set<string> {
  const out = new Set<string>(saved ?? []);
  for (const spec of islands) {
    // Seed cells for populated AND already-discovered islands. A legacy v3
    // save that pre-dates §11 may carry `discovered: true` on islands that
    // the player revealed via the old center-flip mechanic; without seeding
    // their cells here the fog overlay would paint over them on load.
    // `islandCells` walks every constituent (primary + extraEllipses) so
    // merged islands get their absorbed-lobe cells seeded too.
    if (!spec.populated && !spec.discovered) continue;
    for (const k of islandCells(spec)) out.add(k);
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
  if (v['v'] !== SCHEMA_VERSION) return false;
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
    const stored = (await get(STORAGE_KEY)) as SaveSnapshot | undefined;
    if (stored === undefined) return null;
    if (stored.v !== SCHEMA_VERSION) {
      console.warn(
        `[robot-islands] loadWorld: ignoring snapshot with unknown v=${String(stored.v)}`,
      );
      return null;
    }
    return deserializeWorld(stored);
  } catch (err) {
    console.warn('[robot-islands] loadWorld failed:', err);
    return null;
  }
}
