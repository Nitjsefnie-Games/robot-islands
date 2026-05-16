// Inter-island routes: pure logic for cargo transit + funneling credit
// accumulation (SPEC §2.4 / §10 / §15.4).
//
// No PixiJS, no DOM. The renderer (`routes-ui.ts`) reads this module's state
// and draws; the main ticker calls `tickRoutes` once per frame to deliver
// arrivals and dispatch the next batch.
//
// Step-7 scope notes (STILL-DEFERRED bits flagged inline):
//   - T1 cargo only. T2 drone cargo, T3 airship, T4 teleporter, T5 spacetime
//     anchor all share this `Route` shape but their tier-specific capacities
//     and transit times are STILL-DEFERRED.
//   - Weather modulation of capacity and in-flight loss implemented per §2.6.
//   - Multi-route contention on the same source resource IS implemented per
//     §15.4 (proportional distribution by capacity).
//   - Funneling tier-cap check uses `state.level < FUNNELING_TIER_CAP` as a
//     placeholder. The proper §9.2 tier-breakpoint mapping (T3 ≈ level 50)
//     is STILL-DEFERRED to step 9 alongside tier-gating in general; `level < 3`
//     here keeps the step-7 demo's funnel-stops-at-T3 behaviour qualitatively
//     correct.

import { cap, inv, type IslandState } from './economy.js';
import { makeSeededRng } from './rng.js';
import { XP_WEIGHT, type ResourceId } from './recipes.js';
import { effectiveSkillMultipliers } from './skilltree.js';
import { routeCapacityMultiplier } from './specialization.js';
import {
  routeCapacityMultiplierForWeather,
  rasterizeRouteCells,
  weather,
  WEATHER_ROUTE_LOSS_RATE,
} from './weather.js';
import { CELL_SIZE_TILES, type WorldState } from './world.js';

/** Transport tier per §2.4. Step 7 only emits `cargo` routes; the field
 *  exists so future tiers can be added without reshaping the data model. */
export type RouteType =
  | 'cargo'
  | 'drone'
  | 'airship'
  | 'teleporter'
  | 'cable'
  | 'spacetime';

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
  /** Stratification cells crossed by this batch, with transit fraction [0,1]
   *  for weather sampling at the time the batch was in each cell. */
  readonly crossedCells?: ReadonlyArray<{
    readonly cx: number;
    readonly cy: number;
    readonly transitFraction: number;
  }>;
}

export interface Route {
  readonly id: string;
  readonly from: string;
  readonly to: string;
  readonly type: RouteType;
  /** Capacity in units per second. For T1 cargo, placeholder 0.5 units/sec. */
  readonly capacityPerSec: number;
  /** Specific resource OR null for 'any' (with priorityList). */
  readonly filter: ResourceId | null;
  /** Ordered priority list when filter === null. Empty array if filter set. */
  readonly priorityList: ReadonlyArray<ResourceId>;
  /** Real-time-of-flight seconds. T1 cargo = distance / speed. T4 teleporter = 0. */
  readonly transitTimeSec: number;
  /** In-flight batches. Mutable (push on dispatch, splice on arrival). */
  inFlight: InFlightBatch[];
}

// ---------------------------------------------------------------------------
// Step-7 tuning constants
// ---------------------------------------------------------------------------

/** T1 cargo travel speed in tiles per second. Rebalanced for idle-game scale,
 *  step #19: 4 → 1 t/s so a 50-tile route takes 50s instead of 12s. */
export const T1_CARGO_SPEED_TILES_PER_SEC = 1; // rebalanced for idle-game scale, step #19 (was 4)

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

/** Funneling bonus per §10 / Appendix A placeholder (50%). */
export const FUNNELING_BONUS_PERCENT = 0.5;

/** Tier at which funneling bonus zeroes out per §10 ("crosses Tier 3").
 *  Placeholder: level-based. Proper §9.2 tier-breakpoint mapping STILL-DEFERRED
 *  to step 9. */
export const FUNNELING_TIER_CAP = 3;

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

/** Seed the route-id counter so the next id is `route-${value + 1}`. Called
 *  by the persistence loader after restoring `world.routes` so a freshly-
 *  loaded session doesn't allocate route ids that collide with saved ones.
 *  Idempotent: only raises the counter, never lowers it. */
export function _seedRouteIdCounter(value: number): void {
  if (value > routeIdCounter) routeIdCounter = value;
}

// ---------------------------------------------------------------------------
// Pure helpers
// ---------------------------------------------------------------------------

/** §5.3: sum the W capacity of every cable route delivering to `islandId`
 *  whose source AND destination both have at least one `power_substation`
 *  building placed. Source-side capacity is NOT deducted from the source's
 *  balance per current scope; this returns only what the destination
 *  receives. */
export function cableInflowForIsland(
  world: WorldState,
  states: Map<string, IslandState>,
  islandId: string,
): number {
  let totalW = 0;
  for (const route of world.routes) {
    if (route.type !== 'cable') continue;
    if (route.to !== islandId) continue;
    const fromState = states.get(route.from);
    const toState = states.get(islandId);
    if (!fromState || !toState) continue;
    if (!fromState.buildings.some((b) => b.defId === 'power_substation')) continue;
    if (!toState.buildings.some((b) => b.defId === 'power_substation')) continue;
    totalW += route.capacityPerSec;
  }
  return totalW;
}

/** Sum the amounts already in flight on `route` whose resourceId === `r`. */
function inFlightSumFor(route: Route, r: ResourceId): number {
  let s = 0;
  for (const b of route.inFlight) {
    if (b.resourceId === r) s += b.amount;
  }
  return s;
}

/** Sum in-flight cargo of `r` arriving at `destIslandId` across ALL routes.
 *  Used to ensure dispatch doesn't over-fill destinations that have batches
 *  already en route. */
function totalInboundInFlight(
  world: WorldState,
  destIslandId: string,
  r: ResourceId,
): number {
  let s = 0;
  for (const route of world.routes) {
    if (route.to !== destIslandId) continue;
    s += inFlightSumFor(route, r);
  }
  return s;
}

/** Headroom for receiving more `r` at the destination right now: capacity
 *  minus current inventory minus any in-flight units already addressed here.
 *  Clamped to 0 (can't be negative). */
function destinationHeadroom(
  world: WorldState,
  states: Map<string, IslandState>,
  destIslandId: string,
  r: ResourceId,
): number {
  const destState = states.get(destIslandId);
  if (!destState) return 0;
  const room = cap(destState, r, undefined, { ignoreGrace: true }) - inv(destState, r) - totalInboundInFlight(world, destIslandId, r);
  return Math.max(0, room);
}

/** Pick the resource a route should ship this tick. Filter routes ship their
 *  fixed resource if both source has >0 and dest has headroom; otherwise
 *  return null. Any-routes walk `priorityList` in order. */
function selectResource(
  world: WorldState,
  states: Map<string, IslandState>,
  route: Route,
): ResourceId | null {
  const srcState = states.get(route.from);
  if (!srcState) return null;

  const candidates: ReadonlyArray<ResourceId> =
    route.filter !== null ? [route.filter] : route.priorityList;
  for (const r of candidates) {
    if (inv(srcState, r) <= 0) continue;
    if (destinationHeadroom(world, states, route.to, r) <= 0) continue;
    return r;
  }
  return null;
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
): Array<{ destIslandId: string; resourceId: ResourceId; amount: number }> {
  const delivered: Array<{ destIslandId: string; resourceId: ResourceId; amount: number }> = [];

  for (const route of world.routes) {
    if (route.type === 'cable') continue; // §5.3: cables transmit power, not items.
    const destState = states.get(route.to);
    if (!destState) {
      // Destination state missing (e.g., island despawned mid-flight). Drop
      // the batches; the resources are lost.
      route.inFlight = route.inFlight.filter((b) => b.arrivalTime > nowMs);
      continue;
    }
    const kept: InFlightBatch[] = [];
    for (const b of route.inFlight) {
      if (b.arrivalTime > nowMs) {
        kept.push(b);
        continue;
      }
      // §2.6 in-flight weather losses
      let remaining = b.amount;
      if (b.crossedCells && b.crossedCells.length > 0 && b.id !== undefined) {
        const transitTimeMs = b.arrivalTime - b.dispatchTime;
        for (const cell of b.crossedCells) {
          const w = weather(
            world.seed,
            cell.cx,
            cell.cy,
            b.dispatchTime + cell.transitFraction * transitTimeMs,
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
  /** Pre-computed stratification cells crossed by this route (§2.6). */
  readonly crossedCells: ReadonlyArray<{
    readonly cx: number;
    readonly cy: number;
    readonly transitFraction: number;
  }>;
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
): {
  dispatches: Array<{ routeId: string; resourceId: ResourceId; amount: number }>;
  arrivals: Array<{ destIslandId: string; resourceId: ResourceId; amount: number }>;
} {
  const arrivals = deliverArrivals(world, states, nowMs);
  const dispatches = dispatchPhase(world, states, nowMs, elapsedSec);
  return { dispatches, arrivals };
}

/** Dispatch phase isolated for testing. Caller can invoke deliverArrivals
 *  separately if a specific ordering is wanted. */
function dispatchPhase(
  world: WorldState,
  states: Map<string, IslandState>,
  nowMs: number,
  elapsedSec: number,
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
  for (const route of world.routes) {
    if (route.type === 'cable') continue; // §5.3: cables transmit power, not items.
    const srcState = states.get(route.from);
    if (!srcState) continue;
    const r = selectResource(world, states, route);
    if (r === null) continue;
    const capacityMul = routeCapacityMultiplier(srcState.specializationRole);
    // Transport sub-path skill bonus — multiplicative with the spec role
    // multiplier. Read on the SOURCE island (where dispatch decisions get
    // made and the player invests skill points). Reading per-route per-tick
    // is fine because effectiveSkillMultipliers is a cheap Map fold.
    const skillCapMul = effectiveSkillMultipliers(srcState).routeCapacity;

    // §2.6 weather capacity modulation
    const fromSpec = world.islands.find((i) => i.id === route.from);
    const toSpec = world.islands.find((i) => i.id === route.to);
    const weatherMul =
      fromSpec && toSpec
        ? routeCapacityMultiplierForWeather(
            world.seed,
            fromSpec.cx,
            fromSpec.cy,
            toSpec.cx,
            toSpec.cy,
            nowMs,
            CELL_SIZE_TILES,
          )
        : 1;

    // Airship-specific Transport bonus stacks only on airship routes.
    const airshipMul = route.type === 'airship'
      ? effectiveSkillMultipliers(srcState).airshipRange
      : 1;
    const capDemand = route.capacityPerSec * capacityMul * skillCapMul * airshipMul * weatherMul * elapsedSec;
    const headroom = destinationHeadroom(world, states, route.to, r);
    const desired = Math.min(capDemand, headroom);
    if (desired <= 0) continue;
    const crossedCells =
      fromSpec && toSpec
        ? rasterizeRouteCells(
            fromSpec.cx,
            fromSpec.cy,
            toSpec.cx,
            toSpec.cy,
            CELL_SIZE_TILES,
          )
        : [];
    demands.push({ route, resourceId: r, desired, weatherMul, crossedCells });
  }

  // Phase 2: source contention. Group demands by (fromIslandId, resourceId).
  // Source inventory is partitioned among contending routes proportionally
  // to capacity, but our `desired` is already capacity × elapsedSec for
  // each route, and the spec wording "distribute proportionally to capacity"
  // is equivalent to "scale every desired by the same factor" because each
  // route's desired share IS its capacity share of the partition.
  const allocated = new Map<Route, number>();
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
      for (const m of members) allocated.set(m.route, m.desired);
    } else {
      const scale = srcAvail / totalDesired;
      for (const m of members) allocated.set(m.route, m.desired * scale);
    }
  }

  // Phase 3: execute. Deduct source inventory and either append an in-flight
  // batch or deposit immediately for instant-transit routes.
  const dispatches: Array<{ routeId: string; resourceId: ResourceId; amount: number }> = [];
  for (const d of demands) {
    const amount = allocated.get(d.route) ?? 0;
    if (amount <= 0) continue;
    const srcState = states.get(d.route.from);
    if (!srcState) continue;
    srcState.inventory[d.resourceId] = Math.max(0, inv(srcState, d.resourceId) - amount);
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
          const efficiency = effectiveSkillMultipliers(srcState).teleporterEfficiency;
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
        const room = cap(destState, d.resourceId) - inv(destState, d.resourceId);
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
      const batchId = `${d.route.id}_${nowMs}_${d.route.inFlight.length}`;
      d.route.inFlight.push({
        resourceId: d.resourceId,
        amount,
        arrivalTime: nowMs + d.route.transitTimeSec * 1000,
        dispatchTime: nowMs,
        id: batchId,
        crossedCells: d.crossedCells,
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

/** Pure helper: reorder a priority list by moving the element at `srcIndex`
 *  to `dstIndex`. Returns a new array; the input is not modified. */
export function reorderPriorityList(list: ReadonlyArray<ResourceId>, srcIndex: number, dstIndex: number): ResourceId[] {
  if (srcIndex === dstIndex) return [...list];
  const result = [...list];
  const [moved] = result.splice(srcIndex, 1);
  if (moved === undefined) return result;
  result.splice(dstIndex, 0, moved);
  return result;
}
