// Inter-island routes: pure logic for cargo transit + funneling credit
// accumulation (SPEC §2.4 / §10 / §15.4).
//
// No PixiJS, no DOM. The renderer (`routes-ui.ts`) reads this module's state
// and draws; the main ticker calls `tickRoutes` once per frame to deliver
// arrivals and dispatch the next batch.
//
// Scope notes:
//   - All route tiers (T1 cargo, T2 drone cargo, T3 airship, T4 mass driver,
//     T4 teleporter, T5 spacetime anchor) share this `Route` shape and have
//     per-tier capacity and transit-time constants wired.
//   - Weather modulation of capacity and in-flight loss implemented per §2.6.
//   - Multi-route contention on the same source resource is implemented per
//     §15.4 (proportional distribution by capacity).
//   - Tier-gating on route-class placement runs through `buildingUnlocked` at
//     validate-placement time like every other tiered building.

import {
  cap,
  computeRates,
  inv,
  type CableComponentBalance,
  type IslandState,
  type RatesContext,
} from './economy.js';
import { makeSeededRng } from './rng.js';
import { solveBrownoutFactor } from './flow-power-fixpoint.js';
import { XP_WEIGHT, type ResourceId } from './recipes.js';
import { effectiveSkillMultipliers, tierForLevel, type SkillMultipliers } from './skilltree.js';
import {
  biomeForCell,
  routeCapacityMultiplierForCells,
  rasterizePolylineCells,
  sumIslandCo2,
  weather,
  weatherClockMs,
  WEATHER_ROUTE_LOSS_RATE,
} from './weather.js';
import { CELL_SIZE_TILES, type IslandSpec, type WorldState } from './world.js';
import { BUILDING_DEFS, type BuildingDefId } from './building-defs.js';
import { shapeWidth, shapeHeight } from './shape-mask.js';
import { activeFloorLevel, floorEffectMul, hasOperationalBuilding, type PlacedBuilding } from './buildings.js';
import { planCargo, type ViableEntry } from './route-cargo.js';
import type { CargoMode, CargoEntry } from './route-cargo.js';
import { ALL_RESOURCES } from './recipes.js';

/** Transport tier per §2.4. Step 7 only emits `cargo` routes; the field
 *  exists so future tiers can be added without reshaping the data model.
 *  `mass_driver` is the §9.5 Plains-unique T4 long-range launcher
 *  (Route.type per §15.1) — runs through the standard cargo dispatch
 *  path with a higher capacity constant + Diesel fuel debit.
 *  `submarine_cable` (§4 ocean layer) is an inter-island power-
 *  transmission variant of `cable` that visually routes across ocean;
 *  it behaves identically to land `cable` for §5.3 unified-pool
 *  purposes (see `isPowerLink` and the dispatch skip below). */
export type RouteType =
  | 'cargo'
  | 'drone'
  | 'airship'
  | 'mass_driver'
  | 'teleporter'
  | 'cable'
  | 'spacetime'
  | 'submarine_cable';

/** A batch of cargo currently in transit on a route. Created at dispatch,
 *  removed when `arrivalTime <= nowMs`. */
export interface InFlightBatch {
  readonly resourceId: ResourceId;
  readonly amount: number;
  /** Wall-clock ms when this batch arrives at the destination. */
  readonly arrivalTime: number;
  /** Wall-clock ms when this batch was dispatched (renderer uses both
   *  timestamps for the interpolation parameter). */
  readonly dispatchTime: number;
  /** Deterministic id for weather-loss RNG seeding. */
  readonly id?: string;
  // NOTE: the stratification cells a batch crosses are NOT stored on the batch.
  // They are a pure function of the route's (from, to) geometry (both readonly),
  // so storing them per batch was megabytes of redundant, identical data across
  // every in-flight batch on a route. `deliverArrivals` recomputes the path once
  // per route via `routeCrossedCells` for the §2.6 in-flight weather-loss roll.
}

export interface Route {
  readonly id: string;
  readonly from: string;
  readonly to: string;
  readonly type: RouteType;
  /** Capacity in units per second. For T1 cargo, placeholder 0.5 units/sec. */
  readonly capacityPerSec: number;
  /** How this route divides its per-tick capacity across `cargo`. */
  mode: CargoMode;
  /** Resources this route may carry. Order matters for priority/waterfall;
   *  weight matters for split. Mutated in place by routes-ui.ts. */
  cargo: CargoEntry[];
  /** Real-time-of-flight seconds. T1 cargo = distance / speed. T4 teleporter = 0. */
  readonly transitTimeSec: number;
  /** In-flight batches. Mutable (push on dispatch, splice on arrival). */
  inFlight: InFlightBatch[];
  /** Soft-delete flag. When set, the route stops dispatching new batches
   *  (`dispatchPhase` skips it) but `deliverArrivals` keeps delivering the
   *  batches already in transit. `tickRoutes` prunes the route from
   *  `world.routes` once `inFlight` drains empty — so cargo en route at
   *  delete time is never lost. Absent/false on a live route. */
  draining?: boolean;
  /** PlacedBuilding id of the transport building that owns this route.
   *  Absent on legacy saved routes (grandfathered as plain cargo). */
  sourceBuildingId?: string;
  /** §2.6 bend points (tile coords) turning the straight corridor into a
   *  polyline of up to MAX_ROUTE_BENDS+1 segments. Absent/empty = straight
   *  (back-compat). Only bendable, non-instant cargo routes carry these. */
  waypoints?: ReadonlyArray<{ x: number; y: number }>;
  /** §2.4 merged-route group: routes created together by a `from=all` / `to=all`
   *  shortcut share one `groupId` and collapse to a single ledger row that
   *  cancels / retargets all members together (each still ticks as its own
   *  route). Absent = a standalone manual route. Not engine-significant — purely
   *  a UI grouping handle, so absent on legacy saves needs no migration. */
  groupId?: string;
}

// VISUAL-FIELD-MARKER: any new field on the Route interface above
// that affects rendered route geometry, dash style, or chevron
// count MUST be added to `perRouteKey` in RouteRenderer.diffRebuild()
// (routes-renderer.ts) AND classified in the not-visual whitelist in
// routes-renderer.test.ts.
//
// §perf-2026-05-28 RENDERING-RELEVANT FIELDS (currently in perRouteKey):
//   - route.id             (separates per-route entries in renderer cache)
//   - route.type           (selects dashed-stroke texture + colour)
//   - route.from           (island id → world-coord endpoint)
//   - route.to             (island id → world-coord endpoint)
//   - route.waypoints      (tile coords → polyline world-px path; #118)
//   - route.inFlight.length  (chevron count; items themselves NOT keyed)
//   - from.x, from.y       (world-coord endpoints; Fix 7.4)
//   - to.x,   to.y         (world-coord endpoints; Fix 7.4)

/** Build an id→spec index for the world's islands. O(islands) once per tick,
 *  replacing the old O(routes × islands) `world.islands.find(...)` scans in the
 *  route dispatch / delivery hot loops. */
function buildIslandIndex(world: WorldState): Map<string, IslandSpec> {
  const index = new Map<string, IslandSpec>();
  for (const spec of world.islands) index.set(spec.id, spec);
  return index;
}

const NO_CROSSED_CELLS: ReadonlyArray<{ cx: number; cy: number; transitFraction: number }> = [];

export const MAX_ROUTE_BENDS = 4;

/** Route classes that traverse ocean cells and can be bent. Excludes instant
 *  teleporters and power links (which transmit power, not cargo, skipping §2.6). */
export function isBendableRouteType(t: RouteType): boolean {
  return t === 'cargo' || t === 'drone' || t === 'airship' || t === 'mass_driver';
}

/** Polyline points (tile coords) for a route: [start, ...waypoints, to].
 *  The START anchors at the route's SOURCE BUILDING (`routeSourceTile`), not the
 *  island centre — a different start point crosses different §2.6 weather cells,
 *  so the building a route launches from actually changes the weather it flies
 *  through. Legacy routes with no resolvable source building fall back to the
 *  from-island centre. Null when either endpoint island is unknown. */
export function routePolylinePoints(
  route: Route, islandIndex: Map<string, IslandSpec>,
): Array<{ x: number; y: number }> | null {
  const fromSpec = islandIndex.get(route.from);
  const toSpec = islandIndex.get(route.to);
  if (!fromSpec || !toSpec) return null;
  const start = routeSourceTile(route, islandIndex) ?? { x: fromSpec.cx, y: fromSpec.cy };
  const pts: Array<{ x: number; y: number }> = [{ x: start.x, y: start.y }];
  if (route.waypoints) for (const w of route.waypoints) pts.push({ x: w.x, y: w.y });
  pts.push({ x: toSpec.cx, y: toSpec.cy });
  return pts;
}

/** Total polyline length in tiles (straight-line distance when no bends). */
export function routeBentLengthTiles(route: Route, islandIndex: Map<string, IslandSpec>): number {
  const pts = routePolylinePoints(route, islandIndex);
  if (!pts) return 0;
  let len = 0;
  for (let i = 0; i < pts.length - 1; i++) len += Math.hypot(pts[i + 1]!.x - pts[i]!.x, pts[i + 1]!.y - pts[i]!.y);
  return len;
}

/** Effective transit time: base (straight) transitTimeSec scaled by
 *  bentLength/straightLength. A straight route returns transitTimeSec unchanged. */
export function effectiveTransitTimeSec(route: Route, islandIndex: Map<string, IslandSpec>): number {
  const fromSpec = islandIndex.get(route.from);
  const toSpec = islandIndex.get(route.to);
  if (!fromSpec || !toSpec) return route.transitTimeSec;
  // Straight baseline anchors at the same source-building start as the polyline
  // (routeSourceTile ?? centre), so an UNBENT route's bentLength == straight and
  // its stored transitTimeSec is preserved — only bends add time, relative to
  // the building-anchored straight line.
  const start = routeSourceTile(route, islandIndex) ?? { x: fromSpec.cx, y: fromSpec.cy };
  const straight = Math.hypot(toSpec.cx - start.x, toSpec.cy - start.y);
  if (straight <= 0) return route.transitTimeSec;
  return route.transitTimeSec * (routeBentLengthTiles(route, islandIndex) / straight);
}

/** The stratification cells a route crosses, with per-cell transit fraction —
 *  a pure function of the route's polyline (from, waypoints, to) island
 *  geometry. Recomputed on demand (at dispatch for the §2.6 capacity throttle
 *  and at delivery for the §2.6 in-flight loss roll) rather than stored per
 *  in-flight batch, so saves never carry duplicated path data. Empty when
 *  either endpoint is unknown (matches the pre-existing "no specs ⇒ no weather"
 *  dispatch behaviour). */
export function routeCrossedCells(
  route: Route,
  islandIndex: Map<string, IslandSpec>,
): ReadonlyArray<{ cx: number; cy: number; transitFraction: number }> {
  const pts = routePolylinePoints(route, islandIndex);
  if (!pts) return NO_CROSSED_CELLS;
  return rasterizePolylineCells(pts, CELL_SIZE_TILES);
}

/** A route's effective capacity (units/sec) broken into its persistent ceiling
 *  and the live weather-throttled rate, mirroring the dispatch product
 *  `capacityPerSec × floorMul × skillCapMul × airshipMul × weatherMul`:
 *  - `base`      = tier base × floor × Transport-skill `routeCapacity` × airship
 *                  bonus — the rate the route runs at in CLEAR weather.
 *  - `throttled` = `base × weatherMul` — the ACTUAL rate right now (a storm on
 *                  the path cuts it below `base`).
 *  `floorMul` is returned too so callers can scale transit time consistently.
 *  Pure; the caller supplies the wall clock (`nowMs` + `wallOffsetMs`). */
export function routeEffectiveCapacity(
  world: WorldState,
  states: Map<string, IslandState>,
  route: Route,
  nowMs: number,
  wallOffsetMs = 0,
): { base: number; throttled: number; weatherMul: number; floorMul: number } {
  const src = states.get(route.from);
  const srcMul = src ? effectiveSkillMultipliers(src) : undefined;
  const skillCapMul = srcMul?.routeCapacity ?? 1;
  const airshipMul = route.type === 'airship' ? (srcMul?.airshipRange ?? 1) : 1;
  const floorMul = routeFloorMultiplier(route, world);
  const base = route.capacityPerSec * floorMul * skillCapMul * airshipMul;
  const weatherMul = routeWeatherCapacityMul(world, route, nowMs, wallOffsetMs);
  return { base, throttled: base * weatherMul, weatherMul, floorMul };
}

/** Live §2.6 weather capacity multiplier for a route (1 = clear, < 1 = a storm
 *  on its building-anchored path is cutting throughput). Mirrors the dispatch
 *  computation exactly so a UI readout matches the engine: instant routes
 *  (teleporter) are weather-exempt, and the storm is sampled over the SAME
 *  crossed cells (`routeCrossedCells`) the §2.6 capacity throttle uses. Pure;
 *  the caller supplies the wall clock (`nowMs` + `wallOffsetMs`). */
export function routeWeatherCapacityMul(
  world: WorldState,
  route: Route,
  nowMs: number,
  wallOffsetMs = 0,
): number {
  if (route.transitTimeSec <= 0) return 1; // instant routes are weather-exempt
  const islandIndex = new Map(world.islands.map((i) => [i.id, i]));
  const crossed = routeCrossedCells(route, islandIndex);
  if (crossed.length === 0) return 1;
  return routeCapacityMultiplierForCells(
    world.seed,
    crossed.map((c) => ({ cx: c.cx, cy: c.cy })),
    nowMs,
    wallOffsetMs,
    (cx, cy) => biomeForCell(world, cx, cy),
    sumIslandCo2(world),
  );
}

// ---------------------------------------------------------------------------
// Step-7 tuning constants
// ---------------------------------------------------------------------------

/** T1 cargo travel speed in tiles per second. Rebalanced for idle-game scale,
 *  step #19: 4 → 1 t/s so a 50-tile route takes 50s instead of 12s. */
export const T1_CARGO_SPEED_TILES_PER_SEC = 1;

/** §9.3 Network sub-path: per-tile biofuel cost of teleporter route dispatch.
 *  Added so the Network sub-path's "teleporter" theme has something concrete
 *  to scale (previously teleporters were free + instant, leaving Network with
 *  no meaningful primary axis). Placeholder — tune in Appendix A.
 *
 *  Cost per dispatch tick = distance_tiles × TELEPORTER_FUEL_PER_TILE /
 *  teleporterEfficiency (Network skill mul). If the source island lacks the
 *  fuel, the dispatch is SKIPPED for this tick — the route stays valid,
 *  it just doesn't deliver. */
export const TELEPORTER_FUEL_PER_TILE = 0.005;

/** T1 cargo throughput in units per second. Unchanged from step-7 — capacity
 *  is independent of speed; idle players accrue larger totals over time. */
export const T1_CARGO_CAPACITY_UNITS_PER_SEC = 0.5;

/** §9.5 Mass Driver capacity. Spec: "~5× airship capacity." The value is now
 *  5 × airship per §9.5, no longer the cargo×5 placeholder. */
export const MASS_DRIVER_CAPACITY_UNITS_PER_SEC = 10.0;

/** §2.4 T2 drone cargo — placeholder progression (Appendix A). */
export const DRONE_CARGO_CAPACITY_UNITS_PER_SEC = 1.0;
export const DRONE_CARGO_SPEED_TILES_PER_SEC = 2;
/** §2.4 T3 airship cargo — placeholder progression (Appendix A). */
export const AIRSHIP_CARGO_CAPACITY_UNITS_PER_SEC = 2.0;
export const AIRSHIP_CARGO_SPEED_TILES_PER_SEC = 4;
/** §9.5 Mass Driver transit speed (capacity constant is above). */
export const MASS_DRIVER_SPEED_TILES_PER_SEC = 8;
/** §2.4 T4 teleporter — instant transit (speed 0), high throughput. */
export const TELEPORTER_CARGO_CAPACITY_UNITS_PER_SEC = 5.0;

/** §9.5 Mass Driver fuel cost: units of Diesel consumed per unit of cargo
 *  dispatched. Spec literal "Consumes Diesel (T2 fuel grade) per dispatch
 *  volume." Placeholder — tune in Appendix A. Cost is computed AFTER the
 *  source-contention scaling, against the final allocated `amount`. If
 *  the source can't afford the full diesel bill, the entire dispatch is
 *  skipped wholesale (same shape as the teleporter biofuel check below in
 *  this file — same Phase-2-relative timing and refund pattern, but
 *  applied to BOTH transit branches rather than only the instant one). */
export const MASS_DRIVER_DIESEL_PER_UNIT = 0.05;

/** Funneling bonus per §10 / Appendix A placeholder (50%). */
export const FUNNELING_BONUS_PERCENT = 0.5;

/** Tier at which funneling bonus zeroes out per §10 ("crosses Tier 3").
 *  Level 15 is the T3 breakpoint per §9.2, so the bonus applies for
 *  `destState.level < 15` and zeroes out once the colony reaches T3. */
export const FUNNELING_TIER_CAP = 15;

/** Tier characteristics a transport building confers on the route it hosts. */
export interface RouteProfile {
  readonly type: RouteType;
  readonly capacityPerSec: number;
  /** Tiles/sec for transit-time computation. 0 = instant (teleporter). */
  readonly speedTilesPerSec: number;
}

/** defId → tier profile. A defId absent here is not a transport building. */
const ROUTE_PROFILES: Partial<Record<BuildingDefId, RouteProfile>> = {
  dock:           { type: 'cargo',       capacityPerSec: T1_CARGO_CAPACITY_UNITS_PER_SEC,        speedTilesPerSec: T1_CARGO_SPEED_TILES_PER_SEC },
  dronepad:       { type: 'drone',       capacityPerSec: DRONE_CARGO_CAPACITY_UNITS_PER_SEC,     speedTilesPerSec: DRONE_CARGO_SPEED_TILES_PER_SEC },
  airship_dock:   { type: 'airship',     capacityPerSec: AIRSHIP_CARGO_CAPACITY_UNITS_PER_SEC,   speedTilesPerSec: AIRSHIP_CARGO_SPEED_TILES_PER_SEC },
  mass_driver:    { type: 'mass_driver', capacityPerSec: MASS_DRIVER_CAPACITY_UNITS_PER_SEC,     speedTilesPerSec: MASS_DRIVER_SPEED_TILES_PER_SEC },
  teleporter_pad: { type: 'teleporter',  capacityPerSec: TELEPORTER_CARGO_CAPACITY_UNITS_PER_SEC, speedTilesPerSec: 0 },
};

/** The route tier a transport building hosts, or null if `defId` is not a
 *  transport building. */
export function routeProfileForBuilding(defId: BuildingDefId): RouteProfile | null {
  return ROUTE_PROFILES[defId] ?? null;
}

// ---------------------------------------------------------------------------
// Route id generation
// ---------------------------------------------------------------------------

// The module-level counter resets on reload. After persistence (step 14)
// landed, the loader in `persistence.ts` calls `_seedRouteIdCounter` with
// the maximum numeric suffix found in the restored `world.routes`, so the
// next allocation is `max + 1` and never collides with a saved id. Same
// pattern as `_seedDroneIdCounter` in `drones.ts`.
let routeIdCounter = 0;
export function nextRouteId(): string {
  routeIdCounter += 1;
  return `route-${routeIdCounter}`;
}

/** Test-only — reset the route-id counter so each test gets stable ids. */
export function _resetRouteIdCounter(): void {
  routeIdCounter = 0;
}

// §2.4 merged-route group ids — a separate monotonic counter (group ids are a
// UI grouping handle, never persisted-deterministic-critical; LOCAL and REMOTE
// each generate their own and the snapshot carries the live value).
let groupIdCounter = 0;
export function nextGroupId(): string {
  groupIdCounter += 1;
  return `grp-${groupIdCounter}`;
}

/** Test-only — reset the group-id counter. */
export function _resetGroupIdCounter(): void {
  groupIdCounter = 0;
}

/** Seed the route-id counter so the next id is `route-${value + 1}`. Called
 *  by the persistence loader after restoring `world.routes` so a freshly-
 *  loaded session doesn't allocate route ids that collide with saved ones.
 *  Idempotent: only raises the counter, never lowers it. */
export function _seedRouteIdCounter(value: number): void {
  if (value > routeIdCounter) routeIdCounter = value;
}

// ---------------------------------------------------------------------------
// §5.3 Cable network: binary-gated unified power pool.
// ---------------------------------------------------------------------------

/** Whether a `RouteType` participates in the §5.3 inter-island power
 *  pool. The three power-link types — land `cable`, T5 `spacetime`, and
 *  the §4 ocean-layer `submarine_cable` variant — are all summed into
 *  the same component capacity. Exported so tests can pin the contract
 *  without rebuilding the network analysis path. */
export function isPowerLink(t: RouteType): boolean {
  return t === 'cable' || t === 'spacetime' || t === 'submarine_cable';
}

/** §2.4 route-floor scaling — the multiplier a cargo route inherits from its
 *  owning transport building's ACTIVE floors. The route's stored
 *  `capacityPerSec` / `transitTimeSec` are tier BASE values; floors on the
 *  source building scale capacity ×(1+L) and transit SPEED ×(1+L) (i.e. transit
 *  time ÷(1+L)), where L = the owning building's `activeFloorLevel` — the SAME
 *  curve production/power/storage use (`floorEffectMul`). Partial floor-disable
 *  throttles the route toward base; a fully floor-disabled building drains its
 *  routes elsewhere (`drainRoutesForBuilding`), so the clamp to L ≥ 0 here only
 *  guards a draining route's display against a 0 multiplier (which would make
 *  transit time Infinite). Legacy routes with no `sourceBuildingId`, or whose
 *  owner can't be found (demolished / merged away), get a neutral ×1. */
export function routeFloorMultiplier(route: Route, world: WorldState): number {
  if (route.sourceBuildingId === undefined) return 1;
  const island = world.islands.find((i) => i.id === route.from);
  if (!island) return 1;
  const b = island.buildings.find((bb) => bb.id === route.sourceBuildingId);
  if (!b) return 1;
  return floorEffectMul(Math.max(0, activeFloorLevel(b)));
}

/** Tile coords of a route's owning source building — the point the route is
 *  drawn FROM — or null when the route has no `sourceBuildingId` (legacy) or the
 *  island / building can't be resolved (demolished / merged). Render-only: the
 *  route's gameplay geometry (capacity / transit / crossed cells) stays
 *  island-centre-derived; callers fall back to the island centre on null. */
export function routeSourceTile(
  route: Route,
  islandIndex: Map<string, IslandSpec>,
): { x: number; y: number } | null {
  if (route.sourceBuildingId === undefined) return null;
  const island = islandIndex.get(route.from);
  if (!island) return null;
  const b = island.buildings.find((bb) => bb.id === route.sourceBuildingId);
  if (!b) return null;
  // Building x/y are island-LOCAL offsets to the footprint's NW tile. Tile
  // coordinates address tile CENTRES (tileToWorldPx maps an integer tile coord
  // to that tile's centre), so the NW tile's centre is (cx + b.x, cy + b.y) and
  // the footprint CENTRE is a further (W-1)/2 tiles in (0 for a 1×1, 0.5 for a
  // 2×2, 1.5 for a 4×4). Using W/2 here overshot by half a tile.
  const def = BUILDING_DEFS[b.defId as BuildingDefId];
  const offX = def ? (shapeWidth(def.footprint) - 1) / 2 : 0;
  const offY = def ? (shapeHeight(def.footprint) - 1) / 2 : 0;
  return { x: island.cx + b.x + offX, y: island.cy + b.y + offY };
}

/**
 * §5.3 local power helper — returns the per-island raw produced/consumed
 * wattage with no inter-island cable contribution. Mirrors `computeRates`
 * Pass 3 power balance: we just call `computeRates` with
 * `cableComponent: undefined` (cables inert) and read the raw values.
 *
 * Pure; safe to call from the network analysis pass before any
 * `advanceIsland` has run this tick. Pre-battery values: the Singularity
 * Battery's brownout-cover happens INSIDE `computeRates` on top of the raw
 * values, and is local to the island — it does not contribute wattage to
 * the cable network.
 */
export function computeIslandLocalPower(
  state: IslandState,
  ctx?: RatesContext,
  /** Perf-domain tick time (matches `state.lastTick`); falls back to
   *  `state.lastTick` inside computeRates when omitted (test back-compat). */
  nowMs?: number,
  /** §2.7 / §15.1 wall-clock sample time threaded into computeRates so the
   *  solar multiplier AND the during-storm conditional bonuses inside the
   *  cable gate's local-power probe read the SAME wall-anchored field the
   *  advance loop uses — not a perf-domain replay of session start. */
  solarClockMs?: number,
  /** §5.3 fixpoint probe: when set, solve this island's member gates against
   *  THIS brownout factor and return the AT-pf REALIZED draw, not the nominal.
   *  Threaded into `computeRates` as `fixedPowerFactor`. Used by the unified
   *  cable-component shared-brownout fixpoint to sample a member's draw at a
   *  candidate shared pf. When omitted (the §5.3 gate-decision call), the
   *  NOMINAL raw draw is returned — today's behaviour, on which `unified` and
   *  per-island surplus/deficit are decided. */
  fixedPf?: number,
): { producedW: number; consumedW: number } {
  // Explicitly clear cableComponent so we measure pure local power. When a
  // probe pf is supplied, also pin `fixedPowerFactor` so computeRates solves
  // the gates against it (single solve, no local fixpoint).
  const localCtx: RatesContext =
    fixedPf === undefined
      ? { ...ctx, cableComponent: undefined }
      : { ...ctx, cableComponent: undefined, fixedPowerFactor: fixedPf };
  const { power } = computeRates(state, localCtx, nowMs, solarClockMs);
  // Gate-decision call (fixedPf undefined): NOMINAL pre-brownout draw — the
  // §5.3 surplus/deficit and gate-pass test are nominal. Fixpoint probe
  // (fixedPf set): the AT-pf realized draw, so the component fixpoint converges
  // to a pf the advance loop's `min(1, producedTotal/consumedTotal)` reproduces.
  return fixedPf === undefined
    ? { producedW: power.rawProduced, consumedW: power.rawConsumed }
    : { producedW: power.produced, consumedW: power.consumed };
}

/**
 * §5.3: compute per-component cable-network balance for every island this
 * tick. Returns a map from island id → its component's `CableComponentBalance`.
 *
 * Algorithm:
 *   1. Build connected components over the graph whose nodes are island ids
 *      and whose edges are routes with `isPowerLink(type)` true.
 *   2. For every component, sum each island's local raw produced/consumed
 *      (from `computeIslandLocalPower`), sum total cable capacity (spacetime
 *      links count as Infinity, so any component containing one is auto-gated
 *      open), compute `requiredTransmission = min(surplus, deficit)`, and
 *      decide `unified = cableCapacityTotal >= requiredTransmission`.
 *   3. Islands with NO power link get a synthetic trivial component
 *      (`unified: false`, local-only).
 *
 * `localPowerCtxFor` lets the caller supply per-island `RatesContext`
 * (terrainAt, modifierMul, specMul, etc.) so the local power numbers match
 * what `advanceIsland` would compute for that island. When omitted, every
 * island uses an empty ctx — fine for tests where ctx defaults are identity.
 */
export function computeCableNetworkBalance(
  world: WorldState,
  islandStates: ReadonlyMap<string, IslandState>,
  localPowerCtxFor?: (islandId: string) => RatesContext | undefined,
  /** Perf-domain tick time + §2.7/§15.1 wall-clock sample time, threaded
   *  into every member's `computeIslandLocalPower` so the gate decision is
   *  taken against the same solar / conditional-bonus field the advance
   *  loop will see this frame. Omitted in tests → lastTick fallback. */
  nowMs?: number,
  solarClockMs?: number,
): Map<string, CableComponentBalance> {
  // 1) Build adjacency from power-link routes. Edges over island ids; both
  //    endpoints must have a state in islandStates (otherwise the route is
  //    dangling and we ignore it for the network).
  const adj = new Map<string, Set<string>>();
  const ensure = (id: string): Set<string> => {
    let s = adj.get(id);
    if (!s) {
      s = new Set();
      adj.set(id, s);
    }
    return s;
  };
  // Seed every known island id so isolated islands also appear in the map.
  for (const id of islandStates.keys()) ensure(id);
  // Edges from power-link routes.
  const powerRoutes: Route[] = [];
  for (const r of world.routes) {
    if (!isPowerLink(r.type)) continue;
    if (!islandStates.has(r.from) || !islandStates.has(r.to)) continue;
    powerRoutes.push(r);
    ensure(r.from).add(r.to);
    ensure(r.to).add(r.from);
  }

  // 2) BFS/DFS connected components.
  const componentOf = new Map<string, string[]>(); // member id → array of member ids in component
  const visited = new Set<string>();
  for (const start of adj.keys()) {
    if (visited.has(start)) continue;
    const stack: string[] = [start];
    const members: string[] = [];
    while (stack.length > 0) {
      const cur = stack.pop()!;
      if (visited.has(cur)) continue;
      visited.add(cur);
      members.push(cur);
      const neighbors = adj.get(cur);
      if (neighbors) for (const n of neighbors) if (!visited.has(n)) stack.push(n);
    }
    for (const m of members) componentOf.set(m, members);
  }

  // 3) Per-component aggregate, then balance object. Cache by stable key
  //    (sorted member-id join) so islands in the same component share one
  //    referent (and one cable-capacity sum).
  const balanceFor = new Map<string, CableComponentBalance>();
  const seenComponents = new Map<string, CableComponentBalance>();

  for (const [islandId, members] of componentOf) {
    const key = [...members].sort().join('|');
    let bal = seenComponents.get(key);
    if (!bal) {
      // Sum local raw power across all members. surplus/deficit accumulate
      // PER ISLAND (Σ max(0, prod_i − cons_i) and Σ max(0, cons_i − prod_i))
      // per §5.3, NOT on the component totals — this is the binding
      // constraint on how much wattage must traverse cables to balance the
      // network. A self-sufficient island contributes neither, even if
      // the component as a whole has surplus or deficit.
      let produced = 0;
      let consumed = 0;
      let totalSurplus = 0;
      let totalDeficit = 0;
      for (const m of members) {
        const st = islandStates.get(m);
        if (!st) continue;
        const ctx = localPowerCtxFor?.(m);
        const local = computeIslandLocalPower(st, ctx, nowMs, solarClockMs);
        produced += local.producedW;
        consumed += local.consumedW;
        const net = local.producedW - local.consumedW;
        if (net > 0) totalSurplus += net;
        else if (net < 0) totalDeficit += -net;
      }
      // Sum cable capacity for routes whose BOTH endpoints sit in this
      // component. Spacetime links contribute Infinity (always passes gate).
      let capacityTotal = 0;
      let hasPowerLink = false;
      const memberSet = new Set(members);
      for (const r of powerRoutes) {
        if (!memberSet.has(r.from) || !memberSet.has(r.to)) continue;
        hasPowerLink = true;
        if (r.type === 'spacetime') {
          capacityTotal = Infinity;
          break; // can't get higher than Infinity
        }
        capacityTotal += r.capacityPerSec;
      }
      // If we shortcut on spacetime, `cableCapacityTotal` stays Infinity to
      // signal "spacetime present" rather than a misleading partial sum.
      const required = Math.min(totalSurplus, totalDeficit);
      // A component with NO power-link edges is the trivial "isolated island"
      // case — explicitly unified=false per the spec contract so the local
      // brownout path runs as if no cable existed. Otherwise `unified` is
      // the gate result. Edge: a vacuous component (required=0) with a
      // power link is still legitimately unified — the link exists, no
      // transmission is needed, brownout = component balance = local balance.
      const unified = hasPowerLink && capacityTotal >= required;
      // §5.3 shared-brownout fixpoint. The gate-passing decision above stays on
      // NOMINAL per-island surplus/deficit (`produced`/`consumed`/`required`).
      // For a unified component in GENUINE deficit, the shared brownout scalar
      // must be self-consistent with the member gates solved against it (the
      // per-island fixpoint, lifted to the one shared component scalar) — not
      // the nominal ratio. So co-solve pf over the component and OVERWRITE the
      // stored totals with the AT-pf realized draw, so the advance-time
      // `min(1, producedTotal/consumedTotal)` reproduces the converged pf.
      //
      // Surplus / balanced components (produced >= consumed) keep nominal
      // totals: their fixpoint is pf=1 (no brownout), and `evalComponent(1)`'s
      // at-pf draw equals the nominal draw, so the fast path is a no-op — we
      // skip it to avoid re-solving every member's gates needlessly.
      let producedTotal = produced;
      let consumedTotal = consumed;
      if (unified && consumed > produced && produced >= 0) {
        const evalComponent = (pf: number): { producedW: number; consumedW: number } => {
          let p = 0;
          let c = 0;
          for (const m of members) {
            const mst = islandStates.get(m);
            if (!mst) continue;
            const lp = computeIslandLocalPower(mst, localPowerCtxFor?.(m), nowMs, solarClockMs, pf);
            p += lp.producedW;
            c += lp.consumedW;
          }
          return { producedW: p, consumedW: c };
        };
        const pf = solveBrownoutFactor(evalComponent).powerFactor;
        const final = evalComponent(pf); // totals AT the converged pf
        producedTotal = final.producedW;
        consumedTotal = final.consumedW;
        // Invariant: min(1, producedTotal/consumedTotal) ≈ pf (the fixpoint's
        // own definition), so advance-time `fixedPf` reproduces the converged
        // pf. Verified in src/routes.test.ts.
      }
      bal = {
        unified,
        producedTotal,
        consumedTotal,
        cableCapacityTotal: capacityTotal,
        requiredTransmission: required,
      };
      seenComponents.set(key, bal);
    }
    balanceFor.set(islandId, bal);
  }

  // 4) Synthetic trivial component for islands with NO power-link edge AND
  //    that happened to be skipped above (shouldn't normally happen since we
  //    seed every islandStates id, but be defensive). Per spec, "no cables"
  //    operates locally so gate trivially fails (unified=false) and local
  //    raw power is the only relevant balance.
  for (const [id, st] of islandStates) {
    if (balanceFor.has(id)) continue;
    const local = computeIslandLocalPower(st, localPowerCtxFor?.(id), nowMs, solarClockMs);
    balanceFor.set(id, {
      unified: false,
      producedTotal: local.producedW,
      consumedTotal: local.consumedW,
      cableCapacityTotal: 0,
      requiredTransmission: 0,
    });
  }

  return balanceFor;
}

/** Sum the amounts already in flight on `route` whose resourceId === `r`. */
function inFlightSumFor(route: Route, r: ResourceId): number {
  let s = 0;
  for (const b of route.inFlight) {
    if (b.resourceId === r) s += b.amount;
  }
  return s;
}

/** Precompute `${destIslandId}|${resourceId}` → summed in-flight amount across
 *  ALL routes, in ONE pass over every in-flight batch. `dispatchPhase` builds
 *  this once per step and threads it into every `destinationHeadroom` call, so
 *  the per-(route × cargo-resource) rescan of every route's entire `inFlight`
 *  array — O(routes × cargo × totalInFlight) per step, the dominant offline-
 *  catch-up cost once a save holds thousands of in-flight batches (profiled:
 *  `planRouteCargo` was ~33% of catch-up CPU) — collapses to an O(1) lookup.
 *  The accumulation order (routes in world order, batches in inFlight order)
 *  matches the old nested scan exactly, so the floating-point sum is byte-
 *  identical to the live scan below. Power-link / draining routes contribute
 *  the same as before (the former hold no in-flight batches; the latter still
 *  carry theirs until drained). */
export function buildInboundInflightMap(world: WorldState): Map<string, number> {
  const m = new Map<string, number>();
  for (const route of world.routes) {
    for (const b of route.inFlight) {
      const k = `${route.to}|${b.resourceId}`;
      m.set(k, (m.get(k) ?? 0) + b.amount);
    }
  }
  return m;
}

/** Sum in-flight cargo of `r` arriving at `destIslandId` across ALL routes.
 *  Used to ensure dispatch doesn't over-fill destinations that have batches
 *  already en route. When `inbound` (a per-step precompute from
 *  `buildInboundInflightMap`) is supplied this is an O(1) lookup; otherwise it
 *  falls back to the live scan (used by the route-throttle diagnosis, which
 *  makes a single call and doesn't need the precompute). */
function totalInboundInFlight(
  world: WorldState,
  destIslandId: string,
  r: ResourceId,
  inbound?: ReadonlyMap<string, number>,
): number {
  if (inbound) return inbound.get(`${destIslandId}|${r}`) ?? 0;
  let s = 0;
  for (const route of world.routes) {
    if (route.to !== destIslandId) continue;
    s += inFlightSumFor(route, r);
  }
  return s;
}

/** Headroom for receiving more `r` at the destination right now: capacity
 *  minus current inventory minus any in-flight units already addressed here.
 *  Clamped to 0 (can't be negative). Exported for the route-throttle diagnosis
 *  (`route-throttle.ts`) so the ledger badge reuses the exact dispatch gate. */
export function destinationHeadroom(
  world: WorldState,
  states: Map<string, IslandState>,
  destIslandId: string,
  r: ResourceId,
  /** PERF: precomputed dest-island skill multipliers. cap() folds skills when
   *  this is omitted; route dispatch calls this per resource per route per step,
   *  so a CPU profile showed the omitted-mult fold (skillMulSignature) as ~11%
   *  of offline-catch-up CPU. Passing the value cap() would itself fold is
   *  byte-identical. */
  mult?: SkillMultipliers,
  /** Per-step precomputed inbound-in-flight sums (see buildInboundInflightMap).
   *  Omitted ⇒ live scan, byte-identical result. */
  inbound?: ReadonlyMap<string, number>,
): number {
  const destState = states.get(destIslandId);
  if (!destState) return 0;
  const room = cap(destState, r, undefined, { ignoreGrace: true }, mult) - inv(destState, r) - totalInboundInFlight(world, destIslandId, r, inbound);
  return Math.max(0, room);
}

/** Build this route's per-tick demands: filter cargo to viable entries
 *  (source stock > 0, destination headroom > 0, source-floor gate passes),
 *  then run the route's mode allocator over `budget`. Pure-ish: reads
 *  world/states, mutates nothing. */
/** Internal result of planRouteCargo: CargoDemand plus the §15.4 unclamped
 *  desired used by Phase-2 proportional distribution. */
interface PlannedDemand {
  readonly resourceId: ResourceId;
  /** Spill-semantics amount (sourceAvail-clamped in waterfall mode). */
  readonly amount: number;
  /** §15.4 Phase-2 desired: capacity share BEFORE sourceAvail clamp.
   *  Equal to `amount` for non-waterfall modes (no contention bias). */
  readonly unclampedDesired: number;
}

function planRouteCargo(
  world: WorldState,
  states: Map<string, IslandState>,
  route: Route,
  budget: number,
  /** See destinationHeadroom — precomputed per-island skill mults so the per-
   *  resource cap() folds in this route's cargo planning are skipped. */
  precomputedSkillMul?: ReadonlyMap<string, SkillMultipliers>,
  /** Per-step precomputed inbound-in-flight sums (see buildInboundInflightMap),
   *  threaded into the per-resource destinationHeadroom gate below. */
  inbound?: ReadonlyMap<string, number>,
): PlannedDemand[] {
  const srcState = states.get(route.from);
  const destState = states.get(route.to);
  if (!srcState || !destState) return [];
  // Resolve source/dest skill multipliers ONCE for this route (from the
  // precomputed map during a catch-up, else a single fold) and thread them into
  // every cap() below — cap() otherwise re-folds skills per resource per push.
  const srcMul = precomputedSkillMul?.get(route.from) ?? effectiveSkillMultipliers(srcState);
  const destMul = precomputedSkillMul?.get(route.to) ?? effectiveSkillMultipliers(destState);
  const viable: ViableEntry[] = [];

  // Resources named explicitly anywhere in this cargo. Used so a wildcard
  // entry doesn't double-cover an explicit one.
  const explicit = new Set<ResourceId>();
  for (const e of route.cargo) {
    if (e.resourceId !== 'all') explicit.add(e.resourceId);
  }

  function tryPush(entry: CargoEntry, r: ResourceId): void {
    const sourceAvail = inv(srcState!, r);
    if (sourceAvail <= 0) return;
    const headroom = destinationHeadroom(world, states, route.to, r, destMul, inbound);
    if (headroom <= 0) return;
    if (entry.sourceFloorPct !== undefined) {
      const srcCap = cap(srcState!, r, undefined, undefined, srcMul);
      if (srcCap <= 0 || sourceAvail / srcCap < entry.sourceFloorPct / 100) return;
    }
    const destCap = cap(destState!, r, undefined, undefined, destMul);
    viable.push({
      resourceId: r,
      weight: entry.weight ?? 1,
      headroom,
      sourceAvail,
      destFillRatio: destCap > 0 ? inv(destState!, r) / destCap : 1,
    });
  }

  for (const entry of route.cargo) {
    if (entry.resourceId === 'all') {
      for (const r of ALL_RESOURCES) {
        if (explicit.has(r)) continue;
        tryPush(entry, r);
      }
    } else {
      tryPush(entry, entry.resourceId);
    }
  }

  const planned = planCargo(route.mode, viable, budget);

  // §15.4 fix 7.2: waterfall mode clamps each entry's `amount` to sourceAvail
  // for intra-route spill ordering.  Phase-2 must see the UNCLAMPED capacity
  // share so contending routes are scaled proportionally to capacity, not to
  // the current inventory snapshot.  Compute the unclamped desired by re-running
  // planCargo on a copy of viable with sourceAvail = Infinity.
  if (route.mode === 'waterfall') {
    const viableUnlocked = viable.map((e) => ({ ...e, sourceAvail: Infinity }));
    const unclampedPlanned = planCargo('waterfall', viableUnlocked, budget);
    // Match by resourceId, not position: the unclamped run consumes the budget
    // at least as fast per entry, so it can break early and emit FEWER entries
    // than the clamped run.  Key-based lookup stays correct under any structural
    // divergence between the two runs.  Entries absent from the unclamped run
    // fall back to their clamped amount — the unclamped budget was exhausted
    // upstream of them, so they carry no extra contention weight.
    const unclampedByResource = new Map<ResourceId, number>();
    for (const d of unclampedPlanned) unclampedByResource.set(d.resourceId, d.amount);
    return planned.map((d) => ({
      resourceId: d.resourceId,
      amount: d.amount,
      unclampedDesired: unclampedByResource.get(d.resourceId) ?? d.amount,
    }));
  }

  return planned.map((d) => ({ resourceId: d.resourceId, amount: d.amount, unclampedDesired: d.amount }));
}

// ---------------------------------------------------------------------------
// Tick: dispatch + delivery
// ---------------------------------------------------------------------------

/**
 * Deliver any in-flight batches whose `arrivalTime <= nowMs`. Returns the
 * deliveries actually realized this call (after destination-cap clamping).
 *
 * Side effects:
 *   - destination `state.inventory[r]` increases (clamped to cap).
 *   - destination `state.funnelPending[r]` accumulates bonus-XP credit per
 *     §10 IF the destination is below the funneling tier cap. Note that
 *     the credit is added based on the AMOUNT delivered (post-cap-clamp);
 *     units lost to the cap don't generate funnel credit because they were
 *     never imported.
 *   - in-flight batch removed from the route.
 *
 * Per §4.6 "if a storage building is destroyed, excess is lost": if the
 * cap has been lowered between dispatch and arrival, the excess of the
 * batch is lost. We don't model that loss as inventory or credit anywhere.
 */
export function deliverArrivals(
  world: WorldState,
  states: Map<string, IslandState>,
  nowMs: number,
  /** §15.1 wall anchor: in-flight weather-loss samples are taken at
   *  `dispatchTime + transitFraction × transit + wallOffsetMs` so the
   *  storm a batch flies through is the one at the WALL-clock moment of
   *  the crossing, not a perf-domain replay of session start. */
  wallOffsetMs: number = 0,
): Array<{ destIslandId: string; resourceId: ResourceId; amount: number }> {
  const delivered: Array<{ destIslandId: string; resourceId: ResourceId; amount: number }> = [];
  const islandIndex = buildIslandIndex(world);

  for (const route of world.routes) {
    if (isPowerLink(route.type)) continue; // §5.3 / §4: power-link routes transmit power, not items.
    const destState = states.get(route.to);
    if (!destState) {
      // Destination state missing (e.g., island despawned mid-flight). Drop
      // the batches; the resources are lost.
      route.inFlight = route.inFlight.filter((b) => b.arrivalTime > nowMs);
      continue;
    }
    // §2.6 in-flight weather-loss path. The crossed cells depend only on the
    // route's (from, to) geometry, so we recompute them ONCE per route here
    // (lazily — only routes with an arriving batch pay for it) instead of
    // storing an identical copy on every in-flight batch (the old design wrote
    // megabytes of redundant path data into every save).
    let crossedCells: ReadonlyArray<{ cx: number; cy: number; transitFraction: number }> | null = null;
    const kept: InFlightBatch[] = [];
    for (const b of route.inFlight) {
      if (b.arrivalTime > nowMs) {
        kept.push(b);
        continue;
      }
      // §2.6 in-flight weather losses
      let remaining = b.amount;
      crossedCells ??= routeCrossedCells(route, islandIndex);
      if (crossedCells.length > 0 && b.id !== undefined) {
        const transitTimeMs = b.arrivalTime - b.dispatchTime;
        for (const cell of crossedCells) {
          // §7.3 coherent field: same biome + CO₂ args as the overlay /
          // tooltip / capacity / destruction consumers for this cell.
          const w = weather(
            world.seed,
            cell.cx,
            cell.cy,
            weatherClockMs(b.dispatchTime + cell.transitFraction * transitTimeMs, wallOffsetMs),
            biomeForCell(world, cell.cx, cell.cy),
            sumIslandCo2(world),
          );
          const lossRate = WEATHER_ROUTE_LOSS_RATE[w.state] ?? 0;
          if (lossRate > 0) {
            const rng = makeSeededRng(`${world.seed}_routeloss_${b.id}_${cell.cx}_${cell.cy}`);
            remaining *= 1 - lossRate * rng();
          }
        }
      }

      const headroom = cap(destState, b.resourceId, undefined, { ignoreGrace: true }) - inv(destState, b.resourceId);
      // §12.4: route arrivals respect normal caps, not the kit grace.
      // Clamp against current cap headroom only — totalInboundInFlight at
      // dispatch already accounted for siblings, so we don't subtract those
      // again here.
      const accept = Math.max(0, Math.min(remaining, headroom));
      if (accept > 0) {
        destState.inventory[b.resourceId] = inv(destState, b.resourceId) + accept;
        if (destState.level < FUNNELING_TIER_CAP) {
          const credit = accept * (XP_WEIGHT[b.resourceId] ?? 0) * FUNNELING_BONUS_PERCENT;
          destState.funnelPending[b.resourceId] =
            (destState.funnelPending[b.resourceId] ?? 0) + credit;
        }
        delivered.push({
          destIslandId: route.to,
          resourceId: b.resourceId,
          amount: accept,
        });
      }
    }
    route.inFlight = kept;
  }

  return delivered;
}

/** Internal: per-route demand entry produced in Phase 1 of dispatch. */
interface RouteDemand {
  readonly route: Route;
  readonly resourceId: ResourceId;
  /** Desired dispatch amount before cross-route source contention scaling. */
  readonly desired: number;
  /** Pre-computed weather capacity multiplier (§2.6). */
  readonly weatherMul: number;
  /** §2.4 route-floor multiplier from the source building's active floors.
   *  Scales capacity ×floorMul (Phase 1) and transit time ÷floorMul (Phase 3);
   *  always ≥ 1 so the Phase-3 division is safe. */
  readonly floorMul: number;
}

/**
 * Run one tick of dispatch + arrival across all routes.
 *
 * Order matters:
 *   1. deliverArrivals first — freshly arrived inventory is available for
 *      this tick's dispatch decisions (e.g., chained re-routes). Step 7 has
 *      no chained re-routes, but the ordering keeps the invariant clean.
 *   2. Phase 1: compute each route's desired ship per (source, resource),
 *      clamped to source inventory and destination headroom.
 *   3. Phase 2: when multiple routes share a (source, resource), scale all
 *      desires by `sourceAvail / totalDesired` if that ratio < 1. Source
 *      contention is partitioned per (source-island, resource-id) — two
 *      routes shipping different resources from the same island don't
 *      contend with each other.
 *   4. Phase 3: execute — deduct from source, append InFlightBatch (or
 *      deposit immediately if transitTimeSec === 0).
 */
export function tickRoutes(
  world: WorldState,
  states: Map<string, IslandState>,
  nowMs: number,
  elapsedSec: number,
  /** §15.1 wall anchor (see `weatherClockMs`). Threaded into both the
   *  arrival-loss samples and the dispatch capacity multiplier. */
  wallOffsetMs: number = 0,
  /** PERF: optional precomputed per-island skill multipliers (keyed by island
   *  id). A loop caller (advanceWorldSystems) whose skills are static across the
   *  bounded steps builds these once and passes them in, so dispatchPhase skips
   *  rebuilding the skill-mul memo signature + cloning per route PER step (a CPU
   *  profile showed that was ~14% of offline-catch-up CPU). Omitted ⇒ each call
   *  recomputes via effectiveSkillMultipliers, exactly as before. */
  precomputedSkillMul?: ReadonlyMap<string, SkillMultipliers>,
): {
  dispatches: Array<{ routeId: string; resourceId: ResourceId; amount: number }>;
  arrivals: Array<{ destIslandId: string; resourceId: ResourceId; amount: number }>;
} {
  const arrivals = deliverArrivals(world, states, nowMs, wallOffsetMs);
  // Prune draining routes whose in-flight cargo has fully landed (soft
  // delete — see `Route.draining`). Done after `deliverArrivals` so a route
  // is removed the same tick its last batch is delivered. Routes with no
  // transit buffer (instant / power-link) are pruned on their first tick.
  for (let i = world.routes.length - 1; i >= 0; i--) {
    const r = world.routes[i];
    if (r && r.draining && r.inFlight.length === 0) world.routes.splice(i, 1);
  }
  const dispatches = dispatchPhase(world, states, nowMs, elapsedSec, wallOffsetMs, precomputedSkillMul);
  return { dispatches, arrivals };
}

/** Dispatch phase isolated for testing. Caller can invoke deliverArrivals
 *  separately if a specific ordering is wanted. */
function dispatchPhase(
  world: WorldState,
  states: Map<string, IslandState>,
  nowMs: number,
  elapsedSec: number,
  wallOffsetMs: number = 0,
  /** See tickRoutes' param doc — precomputed per-island skill multipliers so the
   *  per-route-per-step effectiveSkillMultipliers recompute is skipped during a
   *  catch-up. A miss (e.g. an island settled mid-loop) falls back to a live
   *  compute, so correctness never depends on the map being complete. */
  precomputedSkillMul?: ReadonlyMap<string, SkillMultipliers>,
): Array<{ routeId: string; resourceId: ResourceId; amount: number }> {
  if (elapsedSec <= 0) return [];

  // Phase 1: per-route demand. NOTE: we deliberately do NOT clamp to source
  // inventory here — that's Phase 2's job (proportional distribution per
  // §15.4). Two routes sharing one source and one resource must see each
  // other's demand at full capacity-ask; clamping here would let each route
  // independently claim the entire source, defeating the proportional split.
  // Destination headroom IS clamped here because two routes sharing a
  // destination but pulling from different sources don't contend on the
  // source side, so dest-cap clamping has to happen per-route.
  const demands: RouteDemand[] = [];
  const islandIndex = buildIslandIndex(world);
  // PERF: one pass over all in-flight batches → (dest|resource) inbound sums,
  // reused by every route's destinationHeadroom gate this step instead of each
  // gate rescanning every route's inFlight. Built here (Phase 1 reads inbound;
  // Phase 3 mutates inFlight only afterwards, and deliverArrivals already ran
  // this tick) so the snapshot is exact for every Phase-1 read.
  const inbound = buildInboundInflightMap(world);
  for (const route of world.routes) {
    if (isPowerLink(route.type)) continue; // §5.3 / §4: power-link routes transmit power, not items.
    if (route.draining) continue; // soft-deleted: stop new dispatch, let in-flight finish.
    const srcState = states.get(route.from);
    if (!srcState) continue;
    // Transport sub-path skill bonus — read on the SOURCE island (where
    // dispatch decisions get made and the player invests skill points). Use the
    // precomputed per-island bundle when a loop caller supplied one (skills are
    // static across a catch-up), else fold live. Computed ONCE per route here
    // and reused for both the routeCapacity and airshipRange reads below.
    const srcMul = precomputedSkillMul?.get(route.from) ?? effectiveSkillMultipliers(srcState);
    const skillCapMul = srcMul.routeCapacity;

    // §2.6 weather capacity modulation — sampled along the bent polyline.
    // Instant-transit routes (teleporter — and any future zero-latency cargo
    // type) are EXEMPT from weather: teleportation doesn't traverse the ocean
    // cells the storm sits in, so neither this capacity throttle nor the
    // in-flight loss (which can't apply — instant routes keep no in-flight
    // buffer) touches them.
    const instant = route.transitTimeSec <= 0;
    const crossed = !instant ? routeCrossedCells(route, islandIndex) : NO_CROSSED_CELLS;
    const weatherMul =
      !instant && crossed.length > 0
        ? routeCapacityMultiplierForCells(
            world.seed,
            crossed.map((c) => ({ cx: c.cx, cy: c.cy })),
            nowMs,
            wallOffsetMs,
            // §7.3 coherent field: biome + CO₂ so capacity sees the SAME
            // storm the arrival-loss / destruction consumers see.
            (cx, cy) => biomeForCell(world, cx, cy),
            sumIslandCo2(world),
          )
        : 1;

    // Airship-specific Transport bonus stacks only on airship routes.
    const airshipMul = route.type === 'airship'
      ? srcMul.airshipRange
      : 1;
    // §2.4 route-floor scaling: the source transport building's active floors
    // scale this route's effective capacity ×(1+L) (and transit speed below).
    const floorMul = routeFloorMultiplier(route, world);
    const capDemand = route.capacityPerSec * floorMul * skillCapMul * airshipMul * weatherMul * elapsedSec;
    const planned = planRouteCargo(world, states, route, capDemand, precomputedSkillMul, inbound);
    for (const d of planned) {
      // §15.4 fix 7.2: use unclampedDesired so Phase-2 proportional distribution
      // sees capacity-share, not the sourceAvail-clamped amount (waterfall fix).
      demands.push({ route, resourceId: d.resourceId, desired: d.unclampedDesired, weatherMul, floorMul });
    }
  }

  // Phase 2: source contention. Group demands by (fromIslandId, resourceId).
  // Source inventory is partitioned among contending routes proportionally
  // to capacity, but our `desired` is already capacity × elapsedSec for
  // each route, and the spec wording "distribute proportionally to capacity"
  // is equivalent to "scale every desired by the same factor" because each
  // route's desired share IS its capacity share of the partition.
  const allocated = new Map<RouteDemand, number>();
  const groups = new Map<string, RouteDemand[]>();
  for (const d of demands) {
    const key = `${d.route.from}|${d.resourceId}`;
    let arr = groups.get(key);
    if (!arr) {
      arr = [];
      groups.set(key, arr);
    }
    arr.push(d);
  }
  for (const [key, members] of groups) {
    const [fromId, resId] = key.split('|');
    if (fromId === undefined || resId === undefined) continue;
    const srcState = states.get(fromId);
    if (!srcState) continue;
    const srcAvail = inv(srcState, resId as ResourceId);
    let totalDesired = 0;
    for (const m of members) totalDesired += m.desired;
    if (totalDesired <= srcAvail || totalDesired === 0) {
      for (const m of members) allocated.set(m, m.desired);
    } else {
      const scale = srcAvail / totalDesired;
      for (const m of members) allocated.set(m, m.desired * scale);
    }
  }

  // Phase 3: execute. Deduct source inventory and either append an in-flight
  // batch or deposit immediately for instant-transit routes.
  const dispatches: Array<{ routeId: string; resourceId: ResourceId; amount: number }> = [];
  for (const d of demands) {
    const amount = allocated.get(d) ?? 0;
    if (amount <= 0) continue;
    const srcState = states.get(d.route.from);
    if (!srcState) continue;
    srcState.inventory[d.resourceId] = Math.max(0, inv(srcState, d.resourceId) - amount);
    // §9.5 Mass Driver — Diesel debit gated on dispatch volume. Computed on
    // the post-contention `amount` so two mass_driver routes sharing one
    // source pay diesel proportionally. Insufficient diesel ⇒ refund the
    // cargo and skip this dispatch (same shape as the teleporter biofuel
    // check below). The route stays valid; it just doesn't move anything
    // this tick. Applies to BOTH branches (in-flight and instant), so it
    // sits ahead of the transit-time switch.
    if (d.route.type === 'mass_driver') {
      const diesel = MASS_DRIVER_DIESEL_PER_UNIT * amount;
      if (inv(srcState, 'diesel') < diesel) {
        srcState.inventory[d.resourceId] = inv(srcState, d.resourceId) + amount;
        continue;
      }
      srcState.inventory.diesel = Math.max(0, inv(srcState, 'diesel') - diesel);
    }
    if (d.route.transitTimeSec <= 0) {
      // T4+ instant: deposit directly to destination. We still clamp at the
      // current cap so we don't overshoot.
      // §9.3 Network: teleporter routes (the canonical T4 instant-transit
      // type) burn biofuel proportional to distance. Other instant routes
      // (T5 spacetime — modelled the same way but conceptually free per
      // spec) skip the fuel debit.
      if (d.route.type === 'teleporter') {
        const fromSpec = world.islands.find((i) => i.id === d.route.from);
        const toSpec = world.islands.find((i) => i.id === d.route.to);
        if (fromSpec && toSpec) {
          const distTiles = Math.hypot(toSpec.cx - fromSpec.cx, toSpec.cy - fromSpec.cy);
          const efficiency = (precomputedSkillMul?.get(d.route.from) ?? effectiveSkillMultipliers(srcState)).teleporterEfficiency;
          const fuelCost = (distTiles * TELEPORTER_FUEL_PER_TILE) / efficiency;
          if (inv(srcState, 'biofuel') < fuelCost) {
            // Insufficient fuel — refund the cargo we already deducted above
            // and skip this dispatch.
            srcState.inventory[d.resourceId] = inv(srcState, d.resourceId) + amount;
            continue;
          }
          srcState.inventory.biofuel = Math.max(0, inv(srcState, 'biofuel') - fuelCost);
        }
      }
      const destState = states.get(d.route.to);
      if (destState) {
        // §12.4: instant-transit route arrivals respect the normal cap, not the
        // starter-grace cap, matching deliverArrivals (~589) and destinationHeadroom
        // (~467) which both pass { ignoreGrace: true } for the same reason.
        // Without this, two instant routes dispatched in the same tick to the same
        // destination could sequentially over-fill into grace space beyond storageCaps.
        const room = cap(destState, d.resourceId, undefined, { ignoreGrace: true }) - inv(destState, d.resourceId);
        const accept = Math.max(0, Math.min(amount, room));
        if (accept > 0) {
          destState.inventory[d.resourceId] = inv(destState, d.resourceId) + accept;
          if (destState.level < FUNNELING_TIER_CAP) {
            const credit = accept * (XP_WEIGHT[d.resourceId] ?? 0) * FUNNELING_BONUS_PERCENT;
            destState.funnelPending[d.resourceId] =
              (destState.funnelPending[d.resourceId] ?? 0) + credit;
          }
        }
      }
    } else {
      // §15.1: the batch id seeds the per-cell loss RNG in deliverArrivals,
      // so it must be epoch-independent — embed the WALL-clock dispatch time
      // (identical to `nowMs` when wallOffsetMs = 0) so two sessions whose
      // perf clocks started at different epochs but dispatch at the same
      // wall instant produce the same batch id ⇒ the same loss rolls.
      const batchId = `${d.route.id}_${weatherClockMs(nowMs, wallOffsetMs)}_${d.route.inFlight.length}`;
      // §2.6 effective transit along the bent polyline; computed once per
      // dispatched route (islandIndex is already built at the top of this phase).
      const effTransit = effectiveTransitTimeSec(d.route, islandIndex);
      d.route.inFlight.push({
        resourceId: d.resourceId,
        amount,
        // §2.4 route-floor scaling: speed ×floorMul ⇒ transit time ÷floorMul
        // (floorMul ≥ 1 always, so this never divides by zero).
        arrivalTime: nowMs + (effTransit / d.floorMul) * 1000,
        dispatchTime: nowMs,
        id: batchId,
      });
    }
    dispatches.push({ routeId: d.route.id, resourceId: d.resourceId, amount });
  }

  return dispatches;
}

/** Exposed for tests that want to exercise only the dispatch phase. */
export function dispatchAttempt(
  world: WorldState,
  states: Map<string, IslandState>,
  nowMs: number,
  elapsedSec: number,
): Array<{ routeId: string; resourceId: ResourceId; amount: number }> {
  return dispatchPhase(world, states, nowMs, elapsedSec);
}

// ---------------------------------------------------------------------------
// Route construction helpers
// ---------------------------------------------------------------------------

/** Compute a T1 cargo route's transit time from straight-line tile distance
 *  between the two island centres. Pure helper; UI uses this when creating
 *  a new route so player sees the ETA before committing. */
export function transitTimeForDistance(distanceTiles: number, speedTilesPerSec = T1_CARGO_SPEED_TILES_PER_SEC): number {
  if (speedTilesPerSec <= 0) return 0;
  return distanceTiles / speedTilesPerSec;
}

/** Transport buildings on `island` that can host a NEW route — they have a
 *  route profile and don't already own a route in `routes`. */
export function eligibleTransportBuildings(
  island: IslandSpec,
  routes: ReadonlyArray<Route>,
): PlacedBuilding[] {
  const taken = new Set<string>();
  for (const r of routes) {
    if (r.sourceBuildingId !== undefined) taken.add(r.sourceBuildingId);
  }
  return island.buildings.filter(
    (b) => routeProfileForBuilding(b.defId) !== null && !taken.has(b.id),
  );
}

/** Picker sentinel for a `from`/`to` value meaning "every eligible island". */
export const ROUTE_ALL = 'all';

/** §2.4 merged-route expansion. Turns a `from`/`to` selection (each an island id
 *  or the `ROUTE_ALL` sentinel) into the concrete list of routes to create as
 *  one merged group. Rules:
 *   - Sources: `from='all'` ⇒ every populated island that has a free transport
 *     building, else the single named island.
 *   - Each source contributes its **best** free transport buildings (highest
 *     route capacity first — "takes the best"), one per destination.
 *   - Destinations: `to='all'` ⇒ every other populated island (nearest first),
 *     else the single named island. A source is never its own destination.
 *   - Because a building hosts ONE route, a source emits at most
 *     `min(freeBuildings, destinations)` routes (best building → nearest dest).
 *  Pure; per-pair legality (teleporter-needs-pad etc.) is enforced later at
 *  creation, so invalid pairs are simply dropped there. Deterministic ordering
 *  (id / distance tiebreaks) so LOCAL and REMOTE expand identically. */
export function planMergedRoutes(
  islands: ReadonlyArray<IslandSpec>,
  existingRoutes: ReadonlyArray<Route>,
  fromSel: string,
  toSel: string,
): Array<{ fromId: string; toId: string; buildingId: string }> {
  const byId = (a: { id: string }, b: { id: string }): number =>
    a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
  const populated = islands.filter((i) => i.populated);
  const sources = fromSel === ROUTE_ALL
    ? [...populated].sort(byId)
    : populated.filter((i) => i.id === fromSel);
  const out: Array<{ fromId: string; toId: string; buildingId: string }> = [];
  for (const src of sources) {
    const free = eligibleTransportBuildings(src, existingRoutes).sort((a, b) => {
      const ca = routeProfileForBuilding(a.defId)?.capacityPerSec ?? 0;
      const cb = routeProfileForBuilding(b.defId)?.capacityPerSec ?? 0;
      return cb !== ca ? cb - ca : byId(a, b);
    });
    if (free.length === 0) continue;
    const dests = (toSel === ROUTE_ALL
      ? populated.filter((i) => i.id !== src.id)
      : populated.filter((i) => i.id === toSel && i.id !== src.id)
    ).sort((a, b) => {
      const da = (a.cx - src.cx) ** 2 + (a.cy - src.cy) ** 2;
      const db = (b.cx - src.cx) ** 2 + (b.cy - src.cy) ** 2;
      return da !== db ? da - db : byId(a, b);
    });
    const n = Math.min(free.length, dests.length);
    for (let i = 0; i < n; i++) {
      out.push({ fromId: src.id, toId: dests[i]!.id, buildingId: free[i]!.id });
    }
  }
  return out;
}

/** Whether `island` has a Teleporter Pad — the destination-side gate for a
 *  `teleporter` route. */
export function islandHasTeleporterPad(island: IslandSpec): boolean {
  return hasOperationalBuilding(island.buildings, 'teleporter_pad');
}

/** Construct a route hosted by `building`. The building's def fixes the
 *  route tier (type, capacity, transit speed); `transitTimeSec` is derived
 *  from `distanceTiles`. Returns null if `building` is not a transport
 *  building. The route is created idle (no in-flight cargo, empty priority
 *  list). */
export function createRouteFromBuilding(
  building: PlacedBuilding,
  fromIslandId: string,
  toIslandId: string,
  filter: ResourceId | null,
  distanceTiles: number,
): Route | null {
  const profile = routeProfileForBuilding(building.defId);
  if (profile === null) return null;
  return {
    id: nextRouteId(),
    from: fromIslandId,
    to: toIslandId,
    type: profile.type,
    capacityPerSec: profile.capacityPerSec,
    mode: 'priority',
    cargo: filter !== null ? [{ resourceId: filter }] : [],
    transitTimeSec: transitTimeForDistance(distanceTiles, profile.speedTilesPerSec),
    inFlight: [],
    sourceBuildingId: building.id,
  };
}

export type RetargetResult =
  | { readonly ok: true; readonly route: Route }
  | { readonly ok: false; readonly error: string };

/** Retarget an existing route to a different destination island.
 *
 *  In-flight batches carry no destination of their own (`deliverArrivals`
 *  reads the route's live `to`), so we CANNOT just flip `to` while cargo is
 *  airborne — it would misdeliver. Instead we drain the old route (its
 *  in-flight cargo finishes to the OLD destination, then `tickRoutes` prunes
 *  it — no cargo lost; mirrors `deleteRoute`) and spawn a fresh route from the
 *  same source building to `newToIslandId`, inheriting the old route's cargo
 *  list and split mode so the player's configuration carries over. A route
 *  with nothing in flight is removed immediately rather than left draining.
 *
 *  Pure except for the mutation of `world.routes`. Returns the new route, or a
 *  reason on rejection (mirrors the create-route eligibility checks). */
export function retargetRoute(
  world: WorldState,
  routeId: string,
  newToIslandId: string,
): RetargetResult {
  const old = world.routes.find((r) => r.id === routeId);
  if (!old) return { ok: false, error: 'route not found' };
  if (old.draining) return { ok: false, error: 'route is draining' };
  if (old.to === newToIslandId) return { ok: false, error: 'route already targets that island' };
  if (old.sourceBuildingId === undefined) {
    return { ok: false, error: 'legacy route has no source building to retarget' };
  }
  const fromSpec = world.islands.find((s) => s.id === old.from);
  if (!fromSpec) return { ok: false, error: 'unknown from island' };
  const toSpec = world.islands.find((s) => s.id === newToIslandId);
  if (!toSpec) return { ok: false, error: 'unknown to island' };
  if (!fromSpec.populated) return { ok: false, error: 'from island is not populated' };
  if (!toSpec.populated) return { ok: false, error: 'to island is not populated' };
  const building = fromSpec.buildings.find((b) => b.id === old.sourceBuildingId);
  if (!building) return { ok: false, error: 'source building not found' };
  const profile = routeProfileForBuilding(building.defId);
  if (profile === null) return { ok: false, error: 'building is not a transport building' };
  if (profile.type === 'teleporter' && !islandHasTeleporterPad(toSpec)) {
    return { ok: false, error: 'destination has no teleporter pad' };
  }
  const dx = fromSpec.cx - toSpec.cx;
  const dy = fromSpec.cy - toSpec.cy;
  const dist = Math.sqrt(dx * dx + dy * dy);
  const next = createRouteFromBuilding(building, old.from, newToIslandId, null, dist);
  if (next === null) return { ok: false, error: 'route could not be created' };
  // Carry the player's cargo config + split mode onto the retargeted route.
  next.cargo = old.cargo.map((c) => ({ ...c }));
  next.mode = old.mode;
  // Preserve §2.4 merged-group membership so retargeting a member (per-route or
  // via the group op) keeps it in the merged ledger row instead of orphaning it.
  if (old.groupId !== undefined) next.groupId = old.groupId;
  world.routes.push(next);
  // Drain the old route (or drop it outright if nothing is in flight).
  if (old.inFlight.length === 0) {
    const idx = world.routes.indexOf(old);
    if (idx >= 0) world.routes.splice(idx, 1);
  } else {
    old.draining = true;
  }
  return { ok: true, route: next };
}

export function canBendRoute(
  route: Route, _world: WorldState, states: ReadonlyMap<string, IslandState>,
): boolean {
  if (!isBendableRouteType(route.type)) return false;
  if (route.draining) return false;
  const srcState = states.get(route.from);
  if (!srcState) return false;
  return tierForLevel(srcState.level) >= 5;
}

export type SetWaypointsResult =
  | { readonly ok: true; readonly route: Route }
  | { readonly ok: false; readonly error: string };

/** §2.6 set (or clear, with []) a route's bend points. Validates the route is
 *  bendable (type), source island is T5, ≤ MAX_ROUTE_BENDS finite points, and
 *  not draining. Mutates route.waypoints in place. Empty array clears (unbend). */
export function setRouteWaypoints(
  world: WorldState,
  states: ReadonlyMap<string, IslandState>,
  routeId: string,
  waypoints: ReadonlyArray<{ x: number; y: number }>,
): SetWaypointsResult {
  const route = world.routes.find((r) => r.id === routeId);
  if (!route) return { ok: false, error: 'route not found' };
  if (route.draining) return { ok: false, error: 'route is draining' };
  if (!isBendableRouteType(route.type)) return { ok: false, error: 'route type cannot be bent' };
  const srcState = states.get(route.from);
  if (!srcState) return { ok: false, error: 'source island state missing' };
  if (tierForLevel(srcState.level) < 5) return { ok: false, error: 'source island not T5' };
  if (waypoints.length > MAX_ROUTE_BENDS) return { ok: false, error: `at most ${MAX_ROUTE_BENDS} bend points` };
  for (const w of waypoints) {
    if (typeof w.x !== 'number' || typeof w.y !== 'number' || !Number.isFinite(w.x) || !Number.isFinite(w.y)) {
      return { ok: false, error: 'waypoint coords must be finite numbers' };
    }
  }
  route.waypoints = waypoints.length > 0 ? waypoints.map((w) => ({ x: w.x, y: w.y })) : undefined;
  return { ok: true, route };
}

/** Soft-delete every route owned by `buildingId` (set on demolish). The
 *  routes finish their in-flight cargo, then `tickRoutes` prunes them.
 *  Returns the number of routes newly set to draining. */
export function drainRoutesForBuilding(world: WorldState, buildingId: string): number {
  let n = 0;
  for (const r of world.routes) {
    if (r.sourceBuildingId === buildingId && r.draining !== true) {
      r.draining = true;
      n += 1;
    }
  }
  return n;
}

/** Pure helper: reorder a list by moving the element at `srcIndex`
 *  to `dstIndex`. Returns a new array; the input is not modified. */
export function reorderPriorityList<T>(list: ReadonlyArray<T>, srcIndex: number, dstIndex: number): T[] {
  if (srcIndex === dstIndex) return [...list];
  const result = [...list];
  const [moved] = result.splice(srcIndex, 1);
  if (moved === undefined) return result;
  result.splice(dstIndex, 0, moved);
  return result;
}
