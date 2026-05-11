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

import { get, set } from 'idb-keyval';

import { terrainAtForBiome } from './biomes.js';
import type { IslandState } from './economy.js';
import type { Drone } from './drones.js';
import { _seedDroneIdCounter } from './drones.js';
import type { Route } from './routes.js';
import { _seedRouteIdCounter } from './routes.js';
import type { SettlementVehicle } from './settlement.js';
import { _seedVehicleIdCounter } from './settlement.js';
import { ALL_RESOURCES } from './recipes.js';
import type { NodeId, SubPathId } from './skilltree.js';
import type { IslandSpec, WorldState } from './world.js';

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
 *  to discard saves that pre-date the maintenance timer. */
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
 *  respective types) and round-trip without transformation. */
export interface SerializedWorld {
  readonly islands: ReadonlyArray<SerializedIslandSpec>;
  readonly drones: ReadonlyArray<Drone>;
  readonly routes: ReadonlyArray<Route>;
  readonly vehicles: ReadonlyArray<SettlementVehicle>;
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
  const islands: IslandSpec[] = snapshot.world.islands.map((s) => ({
    ...s,
    // Rehydrate the per-island terrainAt closure via the same factory
    // `world.ts` uses for `DEMO_ISLANDS`. Artificial islands and demo
    // islands flow through the same path because `terrainAtForBiome`
    // routes on `id === 'home'` and otherwise on `biome`.
    terrainAt: (x, y) => terrainAtForBiome(s.biome, s.id, x, y),
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
    })),
  }));

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
    drones: snapshot.world.drones.map((d) => ({
      ...d,
      launchTime: d.launchTime + perfShift,
      expectedReturnTime: d.expectedReturnTime + perfShift,
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
    })),
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
    }
    const live: IslandState = {
      ...s,
      // Defensive inventory + storageCaps + funnelPending clones so the
      // restored state has its own objects (saved snapshot stays inert).
      inventory: inventoryClone,
      storageCaps: storageCapsClone,
      funnelPending: funnelClone,
      unlockedNodes: new Set(s.unlockedNodes),
      subPathProgress: new Map(s.subPathProgress),
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

  return { world, islandStates };
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
