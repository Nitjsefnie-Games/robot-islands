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
  /** Ordered priority list when filter === null. Empty array if filter set.
   *  Mutable: the routes-UI mutates this in place when the player adds,
   *  removes, or reorders entries (see `routes-ui.ts`). */
  priorityList: ReadonlyArray<ResourceId>;
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

/** §9.5 Mass Driver capacity. Spec: "~5× airship capacity." Airship has no
 *  separate base constant today (it inherits the per-route `capacityPerSec`
 *  set by the creator); we anchor on cargo's 0.5/s and ship 5× = 2.5/s as
 *  the Mass Driver placeholder. Tune in Appendix A once airship has its own
 *  base. The constant is plumbed through standard `route.capacityPerSec`,
 *  so weather / specialization / skill multipliers compose as for any other
 *  route. */
export const MASS_DRIVER_CAPACITY_UNITS_PER_SEC = 2.5;

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
): { producedW: number; consumedW: number } {
  // Explicitly clear cableComponent so we measure pure local power.
  const localCtx: RatesContext = { ...ctx, cableComponent: undefined };
  const { power } = computeRates(state, localCtx);
  return { producedW: power.rawProduced, consumedW: power.rawConsumed };
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
        const local = computeIslandLocalPower(st, ctx);
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
      bal = {
        unified,
        producedTotal: produced,
        consumedTotal: consumed,
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
    const local = computeIslandLocalPower(st, localPowerCtxFor?.(id));
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
    if (isPowerLink(route.type)) continue; // §5.3 / §4: power-link routes transmit power, not items.
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
  // Prune draining routes whose in-flight cargo has fully landed (soft
  // delete — see `Route.draining`). Done after `deliverArrivals` so a route
  // is removed the same tick its last batch is delivered. Routes with no
  // transit buffer (instant / power-link) are pruned on their first tick.
  for (let i = world.routes.length - 1; i >= 0; i--) {
    const r = world.routes[i];
    if (r && r.draining && r.inFlight.length === 0) world.routes.splice(i, 1);
  }
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
    if (isPowerLink(route.type)) continue; // §5.3 / §4: power-link routes transmit power, not items.
    if (route.draining) continue; // soft-deleted: stop new dispatch, let in-flight finish.
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
