// Shared pure advance for time-driven world systems (drones, routes, orbital
// chores, sonar buoys, settlement vehicles, island merging). The server's
// catch-up path calls this; the client still runs the same tick block inline in
// src/main.ts (~line 2429). Keep the two in sync — ordering changes in one must
// be mirrored in the other.

import type { IslandState } from './economy.js';
import { tickDrones, type Drone, type TickDronesResult } from './drones.js';
import { computeSignalRanges } from './antenna.js';
import { findNextMerge, performMerge } from './island-merge.js';
import { discoverIslandsInVision } from './vision-discovery.js';
import {
  tickCommPackets,
  tickDebris,
  tickRepairDrones,
  tickSatMovement,
  tickScannerDiscovery,
  tickSweeperCleanup,
} from './orbital.js';
import type { ResourceId } from './recipes.js';
import { tickRoutes } from './routes.js';
import { tickSonarBuoys } from './sonar-buoy.js';
import {
  tickVehicles,
  type TickVehiclesResult,
  type VehicleArrival,
} from './settlement.js';
import type { WorldState } from './world.js';

export const WS_SYSTEMS_STEP_MS = 1000;
export const WS_SYSTEMS_MAX_STEPS = 4000;

export interface WorldSystemsResult {
  newlyDiscoveredIslandIds: string[];
  revealedCellsAdded: number;
  merges: Array<{ absorberId: string; absorbedId: string }>;
  dronesReturned: Drone[];
  dronesLost: Drone[];
  vehicleArrivals: VehicleArrival[];
  vehicleFailures: VehicleArrival[];
  vehicleLost: VehicleArrival[];
  routeArrivals: Array<{ destIslandId: string; resourceId: ResourceId; amount: number }>;
  routeDispatches: Array<{ routeId: string; resourceId: ResourceId; amount: number }>;
  packetsDelivered: number;
  debrisCleared: number;
  /** Number of bounded steps actually taken (telemetry / tests). */
  steps: number;
}

/**
 * Advance all time-driven world systems from `fromMs` to `toMs`, in BOUNDED
 * steps so a long offline gap can't blow up time-scaled accrual (debris/Kessler,
 * sweeper) or run unboundedly. Deterministic — the tick functions draw RNG from seeds keyed on a stable
 * step index, so a read-path caller may recompute it from the same stored snapshot every push
 * and get identical state.
 *
 * `wallOffsetMs` converts the tick clock to wall time for weather sampling: the
 * SERVER passes timestamps already in wall-epoch, so it passes 0. (The client,
 * if it ever calls this, would pass Date.now()-performance.now() like it does
 * for tickRoutes/tickVehicles today.)
 *
 * Ordering matches the client tick block: merge → drones → routes → orbital
 * chores (movement, sweeper, debris, scanner, comm, repair) → sonar → vehicles.
 */
export function advanceWorldSystems(
  world: WorldState,
  states: Map<string, IslandState>,
  fromMs: number,
  toMs: number,
  wallOffsetMs: number = 0,
): WorldSystemsResult {
  const result: WorldSystemsResult = {
    newlyDiscoveredIslandIds: [],
    revealedCellsAdded: 0,
    merges: [],
    dronesReturned: [],
    dronesLost: [],
    vehicleArrivals: [],
    vehicleFailures: [],
    vehicleLost: [],
    routeArrivals: [],
    routeDispatches: [],
    packetsDelivered: 0,
    debrisCleared: 0,
    steps: 0,
  };
  if (!(toMs > fromMs)) return result;

  const gap = toMs - fromMs;
  const stepMs = Math.max(WS_SYSTEMS_STEP_MS, Math.ceil(gap / WS_SYSTEMS_MAX_STEPS));

  // PERF: antenna signal ranges feed tickDrones' per-step reveal test. They are
  // a pure function of populated islands' operational antenna placements, which
  // are STATIC across the bounded steps of one advance EXCEPT when island
  // topology changes: a merge (performMerge, at the top of a step) or a
  // settlement vehicle arriving and populating an island (tickVehicles, at the
  // end of a step). tickDrones recomputed them every step (O(buildings)); a CPU
  // profile showed that recompute was ~10% of offline-catch-up time. We compute
  // them once and recompute ONLY at those topology changes, then hand them to
  // tickDrones. This reproduces the per-step result EXACTLY — a merge is applied
  // before that step's tickDrones (recompute this step), and a vehicle settle
  // happens after it (recompute before the next step's tickDrones) — so the
  // ranges tickDrones sees each step are identical to the old per-step recompute,
  // just without the 3599/3600 redundant ones. Over-recomputing on a vehicle
  // arrival that did NOT populate a new island is harmless (still identical).
  const recomputeRanges = (): ReturnType<typeof computeSignalRanges> =>
    computeSignalRanges(world.islands.filter((s) => s.populated));
  let signalRanges = recomputeRanges();

  let prev = fromMs;
  while (prev < toMs) {
    const cur = Math.min(prev + stepMs, toMs);
    const delta = cur - prev;

    // merge: one per step (matches the client's one-merge-per-tick)
    const m = findNextMerge(world, states);
    if (m) {
      performMerge(world, states, m.absorber, m.absorbed);
      result.merges.push({ absorberId: m.absorber.id, absorbedId: m.absorbed.id });
      // Islands/buildings changed → this step's tickDrones must see fresh ranges
      // (the merge ran before it, exactly as in the per-step-recompute version).
      signalRanges = recomputeRanges();
    }

    const dr: TickDronesResult = tickDrones(world, cur, prev, wallOffsetMs, signalRanges);
    result.dronesReturned.push(...dr.returned);
    result.dronesLost.push(...dr.lost);
    result.newlyDiscoveredIslandIds.push(...dr.newlyDiscoveredIslandIds);
    result.revealedCellsAdded += dr.revealedCellsAdded;

    const rr = tickRoutes(world, states, cur, delta / 1000, wallOffsetMs);
    result.routeArrivals.push(...rr.arrivals);
    result.routeDispatches.push(...rr.dispatches);

    const rngStepIndex = Math.floor(cur / WS_SYSTEMS_STEP_MS);
    tickSatMovement(world, cur);
    result.debrisCleared += tickSweeperCleanup(world, delta);
    tickDebris(world, cur, delta, rngStepIndex);
    const scannerIds = tickScannerDiscovery(world, delta, cur, rngStepIndex);
    result.newlyDiscoveredIslandIds.push(...scannerIds);

    const delivered = tickCommPackets(world);
    result.packetsDelivered += delivered.length;

    tickRepairDrones(world, cur);
    tickSonarBuoys(world);

    const vr: TickVehiclesResult = tickVehicles(world, states, cur, wallOffsetMs);
    result.vehicleArrivals.push(...vr.arrivals);
    result.vehicleFailures.push(...vr.failures);
    result.vehicleLost.push(...vr.lost);
    // A settlement arrival can populate a new island → the NEXT step's tickDrones
    // must see fresh ranges (vehicles run after tickDrones, so the effect is seen
    // next step — matching the old per-step recompute). Arrivals are rare.
    if (vr.arrivals.length > 0) signalRanges = recomputeRanges();

    result.steps++;
    prev = cur;
  }

  // §2.2 vision-overlap discovery: merge/vehicle ticks during catch-up can
  // flip islands to populated, extending the vision-source set. Run the
  // idempotent sweep once after the bounded loop (it is safe to call less
  // frequently because no system inside the loop depends on `discovered`).
  const visionIds = discoverIslandsInVision(world);
  result.newlyDiscoveredIslandIds.push(...visionIds);

  return result;
}
