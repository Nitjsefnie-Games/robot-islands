// Settlement vehicles: pure logic for §12 ship/helicopter dispatch + arrival.
//
// No PixiJS, no DOM. The renderer (`settlement-ui.ts`) reads this module's
// state and draws; the main ticker calls `tickVehicles` once per frame to
// advance arrivals. Tests target this module directly.
//
// Step-12 scope notes (deferred bits flagged inline elsewhere):
//   - One generic ship + one generic helicopter class (T1 + T2). T3+ tiered
//     vehicles (Heavy Freighter, Industrial Carrier, VTOL Tilt-Rotor) and
//     their per-tier loadouts/speeds DEFERRED to a later step.
//   - No weather destruction (no weather system yet — §11.4 / §12.5
//     DEFERRED). Mechanical-failure rolls DEFERRED — every dispatched
//     vehicle arrives.
//   - Auto-routing at the 10-island NC milestone (§9.6 Auto-Patronage,
//     §12.7) DEFERRED.
//   - Coastal-tile placement check on Shipyard DEFERRED.
//   - Foundation Kit "starter inventory grace cap" + decomposition on
//     arrival (§12.4) DEFERRED — step 12 consumes the kit on dispatch
//     and grants no starter inventory. The colony arrives with a Cargo
//     Dock / Helipad and the standard fresh-island state.
//
// Fuel grade matches the launching island's tier per §11.7 — resolved at
// dispatch via `fuelForTier(tierForLevel(originState.level))` and stored on
// the SettlementVehicle record. No fallback to lower grades.

import type { IslandState } from './economy.js';
import { inv } from './economy.js';
import { fuelForTier, type ResourceId } from './recipes.js';
import { makeSeededRng } from './rng.js';
import { tierForLevel } from './skilltree.js';
import type { IslandSpec, WorldState } from './world.js';
import { makeInitialIslandState } from './world.js';

/** Settlement vehicle kind per §12.6. Step 12 ships one generic class per
 *  kind — `ship` (T1) and `helicopter` (T2). T3+ tiered variants are added
 *  later. */
export type VehicleKind = 'ship' | 'helicopter';

/** Vehicle tier per §12.6. Step 12 only emits T1 ships and T2 helicopters;
 *  the field exists so future tiers can be added without reshaping the
 *  data model. */
export type VehicleTier = 1 | 2 | 3 | 4;

/**
 * In-flight settlement vehicle. Mirrors §15.1 `SettlementVehicle` shape —
 * carries an origin, a target, fuel + foundation kit count consumed at
 * dispatch, and a pre-computed expected arrival time so the tick loop
 * doesn't have to recompute travel each frame.
 */
export interface SettlementVehicle {
  readonly id: string;
  readonly kind: VehicleKind;
  readonly tier: VehicleTier;
  readonly from: string;
  readonly target: string;
  readonly fuelLoaded: number;
  readonly foundationKitCount: number;
  /** Travel speed in tiles/sec. T1 ship = SHIP_SPEED; T2 heli = HELI_SPEED. */
  readonly speed: number;
  /** Wall-clock ms timestamp of dispatch. */
  readonly launchTime: number;
  /** Wall-clock ms timestamp the vehicle is expected to arrive. */
  readonly expectedArrivalTime: number;
  /** §2.6 weather vulnerability multiplier per vehicle tier. Carried for
   *  forward-compat with §11.4 destruction logic; not consulted by the
   *  step-12 deterministic-arrival tick. */
  readonly weatherMultiplier: number;
  /** §11.7 tier-matched fuel grade resolved at dispatch from the launching
   *  island's tier (`fuelForTier(tierForLevel(origin.level))`). Stored so
   *  the ticker / UI / persistence layer know which inventory key was
   *  burned without re-deriving from level (which is mutable post-launch). */
  readonly fuelResource: ResourceId;
  /** §12.5 mechanical failure probability [0,1]. Carried on the record so
   *  the tick loop can roll deterministically at arrival time. */
  readonly failureRate: number;
}

// ---------------------------------------------------------------------------
// Step-12 tuning constants
// ---------------------------------------------------------------------------

/** T1 cargo-ship speed in tiles/sec. Rebalanced for idle-game scale, step #19:
 *  1 → 0.25 t/s so a 200-tile colonization run takes ~800s (~13 min). */
export const SHIP_SPEED_TILES_PER_SEC = 0.25; // rebalanced for idle-game scale, step #19 (was 1)
/** T2 helicopter speed in tiles/sec. Faster than ships per §12.6 vehicle
 *  tier table ("Light Helicopter — high speed"). Rebalanced for idle-game
 *  scale, step #19: 3 → 0.75 t/s. */
export const HELI_SPEED_TILES_PER_SEC = 0.75; // rebalanced for idle-game scale, step #19 (was 3)

/** Fuel efficiency in tiles per biofuel unit (one-way; vehicles are
 *  consumed on arrival). T1 ship is fuel-efficient over long distance;
 *  T2 helicopter is fuel-hungry per §12.6 ("Light Helicopter — high
 *  speed, fuel-hungry"). */
export const SHIP_TILES_PER_FUEL = 12;
export const HELI_TILES_PER_FUEL = 4;

/** UI slider bounds for fuel selection. Min covers a short hop (12 tiles
 *  for a ship at min fuel); max covers any in-world target. */
export const MIN_FUEL_PER_VEHICLE = 5;
export const MAX_FUEL_PER_VEHICLE = 100;

/** §12.5 placeholder weather multipliers per vehicle tier. Carried on the
 *  vehicle record for forward-compat; weather destruction roll DEFERRED.
 *  Numbers mirror §2.6 / §12.6 — ships are more weather-vulnerable than
 *  helicopters at the same tier. */
const SHIP_T1_WEATHER_MUL = 1.0;
const HELI_T2_WEATHER_MUL = 0.7;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Tile-space Euclidean distance between two island centres. Pure helper. */
function distanceTiles(a: IslandSpec, b: IslandSpec): number {
  const dx = a.cx - b.cx;
  const dy = a.cy - b.cy;
  return Math.sqrt(dx * dx + dy * dy);
}

/** Per-kind tuning bundle. Centralises the (speed, efficiency, tier,
 *  weatherMul) selection so dispatch + UI agree on a single source. */
export interface VehicleTuning {
  readonly tier: VehicleTier;
  readonly speed: number;
  readonly tilesPerFuel: number;
  readonly weatherMultiplier: number;
  readonly failureRate: number; // §12.5 mechanical failure probability [0,1]
}

export function tuningFor(kind: VehicleKind): VehicleTuning {
  if (kind === 'ship') {
    return {
      tier: 1,
      speed: SHIP_SPEED_TILES_PER_SEC,
      tilesPerFuel: SHIP_TILES_PER_FUEL,
      weatherMultiplier: SHIP_T1_WEATHER_MUL,
      failureRate: 0.02, // 2% T1 ship
    };
  }
  return {
    tier: 2,
    speed: HELI_SPEED_TILES_PER_SEC,
    tilesPerFuel: HELI_TILES_PER_FUEL,
    weatherMultiplier: HELI_T2_WEATHER_MUL,
    failureRate: 0.01, // 1% T2 helicopter
  };
}

/** Whether `origin` has the launch building required for `kind` (Shipyard
 *  for ship, Helipad for helicopter). Pure — reads only the placed-buildings
 *  list off the spec. */
export function hasLaunchBuildingFor(origin: IslandSpec, kind: VehicleKind): boolean {
  const required = kind === 'ship' ? 'shipyard' : 'helipad';
  return origin.buildings.some((b) => b.defId === required);
}

// ---------------------------------------------------------------------------
// Id counter (mirrors drones.ts / routes.ts pattern)
// ---------------------------------------------------------------------------

let vehicleIdCounter = 0;
export function nextVehicleId(): string {
  vehicleIdCounter += 1;
  return `vehicle-${vehicleIdCounter}`;
}

/** Test-only — reset the vehicle-id counter so each test gets stable ids. */
export function _resetVehicleIdCounter(): void {
  vehicleIdCounter = 0;
}

/** Seed the vehicle-id counter so the next id is `vehicle-${value + 1}`.
 *  Used by the persistence loader after restoring a save so the in-session
 *  counter doesn't collide with already-saved vehicle ids. Same pattern as
 *  `_seedDroneIdCounter` / `_seedRouteIdCounter`. */
export function _seedVehicleIdCounter(value: number): void {
  if (value > vehicleIdCounter) vehicleIdCounter = value;
}

// ---------------------------------------------------------------------------
// Dispatch
// ---------------------------------------------------------------------------

export type DispatchVehicleResult =
  | { ok: true; vehicle: SettlementVehicle }
  | {
      ok: false;
      reason:
        | 'insufficient-fuel'
        | 'insufficient-kits'
        | 'invalid-target'
        | 'target-not-discovered'
        | 'target-populated'
        | 'missing-launch-building'
        | 'already-in-flight'
        | 'out-of-range';
    };

/**
 * Launch a settlement vehicle from `origin` to `target`. Mutates
 * `world.vehicles` and `originState` inventory (fuel + foundation_kit).
 *
 * Validation (in this order — test cases assert each rejection separately):
 *   1. Target must be a distinct, discovered, unpopulated island.
 *   2. Origin must have the launch building for the vehicle kind
 *      (Shipyard / Helipad).
 *   3. No existing in-flight vehicle from origin to this same target
 *      (1-Shipyard/1-Helipad cap per §11.7 dispatch-capacity table —
 *      step 12 enforces "1 in-flight to any given target per origin").
 *   4. `fuelLoaded` must be positive, available in origin inventory of the
 *      tier-matched fuel grade (§11.7 — no fallback to lower grades), and
 *      sufficient for the one-way trip given the vehicle's tilesPerFuel.
 *   5. `foundationKitCount` must be ≥ 1 and available in origin inventory.
 *
 * On success: deduct the tier-matched fuel + foundation_kit from origin
 * inventory, append a fresh SettlementVehicle (carrying `fuelResource`)
 * to `world.vehicles`, return `{ ok: true, vehicle }`.
 */
export function dispatchVehicle(
  world: WorldState,
  originSpec: IslandSpec,
  originState: IslandState,
  targetSpec: IslandSpec,
  kind: VehicleKind,
  fuelLoaded: number,
  foundationKitCount: number,
  nowMs: number,
): DispatchVehicleResult {
  // 1. target validation
  if (targetSpec.id === originSpec.id) return { ok: false, reason: 'invalid-target' };
  if (!targetSpec.discovered) return { ok: false, reason: 'target-not-discovered' };
  if (targetSpec.populated) return { ok: false, reason: 'target-populated' };

  // 2. launch building
  if (!hasLaunchBuildingFor(originSpec, kind)) {
    return { ok: false, reason: 'missing-launch-building' };
  }

  // 3. one-in-flight-to-target-per-origin cap
  for (const v of world.vehicles) {
    if (v.from === originSpec.id && v.target === targetSpec.id) {
      return { ok: false, reason: 'already-in-flight' };
    }
  }

  // 4. fuel — §11.7 tier-matched grade only (no fallback), positive, on-hand,
  //    and sufficient to cover the one-way distance.
  const fuelResource: ResourceId = fuelForTier(tierForLevel(originState.level));
  if (fuelLoaded <= 0 || inv(originState, fuelResource) < fuelLoaded) {
    return { ok: false, reason: 'insufficient-fuel' };
  }
  const t = tuningFor(kind);
  const range = fuelLoaded * t.tilesPerFuel;
  const dist = distanceTiles(originSpec, targetSpec);
  if (dist > range) return { ok: false, reason: 'out-of-range' };

  // 5. foundation kit count
  if (foundationKitCount < 1) return { ok: false, reason: 'insufficient-kits' };
  if (inv(originState, 'foundation_kit') < foundationKitCount) {
    return { ok: false, reason: 'insufficient-kits' };
  }

  // All checks passed — mutate the state.
  originState.inventory[fuelResource] = inv(originState, fuelResource) - fuelLoaded;
  originState.inventory.foundation_kit =
    inv(originState, 'foundation_kit') - foundationKitCount;

  const travelSec = dist / t.speed;
  const expectedArrivalTime = nowMs + travelSec * 1000;
  const vehicle: SettlementVehicle = {
    id: nextVehicleId(),
    kind,
    tier: t.tier,
    from: originSpec.id,
    target: targetSpec.id,
    fuelLoaded,
    foundationKitCount,
    speed: t.speed,
    launchTime: nowMs,
    expectedArrivalTime,
    weatherMultiplier: t.weatherMultiplier,
    fuelResource,
    failureRate: t.failureRate,
  };
  world.vehicles.push(vehicle);
  return { ok: true, vehicle };
}

// ---------------------------------------------------------------------------
// Tick — process arrivals
// ---------------------------------------------------------------------------

/** Per-arrival record returned from `tickVehicles`. Renderer/main use these
 *  to know which targets just became populated so they can rebuild render
 *  layers + register the new IslandState's modifier-multiplier cache entry. */
export interface VehicleArrival {
  readonly targetIslandId: string;
  readonly fromIslandId: string;
  readonly kind: VehicleKind;
}

export interface TickVehiclesResult {
  readonly arrivals: VehicleArrival[];
  readonly failures: VehicleArrival[];
}

/**
 * Advance the settlement-vehicle fleet to `nowMs`. Any vehicle whose
 * `expectedArrivalTime` has elapsed is removed from `world.vehicles` and
 * processed:
 *
 *   1. Target spec's `populated` flag flips to true.
 *   2. A Cargo Dock (for ships) or Helipad (for helicopters) is pushed onto
 *      the target spec's `buildings` array. Coordinate is (0, 0) — the
 *      auto-placed dock convention from §12.4. Coast-tile selection is
 *      DEFERRED — the dock lands at the island centre.
 *   3. A fresh IslandState is constructed via `makeInitialIslandState` and
 *      added to `islandStates`. The spec's `buildings` array IS the same
 *      reference the state will hold, so the auto-placed dock is visible
 *      to the economy on the very next tick.
 *
 * Per the load-bearing invariant in `persistence.test.ts` ("keeps
 * IslandState.buildings === IslandSpec.buildings"), we push the dock onto
 * the spec's buildings BEFORE calling `makeInitialIslandState` so the
 * storage-cap aggregation accounts for the auto-placed building.
 *
 * If the target's spec is missing (impossibly) or the target is already
 * populated (e.g. via a parallel pathway), the vehicle is still consumed —
 * the player committed the kit + fuel — but no new IslandState is added.
 *
 * Returns the list of arrivals so the caller can react (rebuild render
 * layers, update modifier-multiplier caches, etc.).
 */
export function tickVehicles(
  world: WorldState,
  islandStates: Map<string, IslandState>,
  nowMs: number,
): TickVehiclesResult {
  const arrivals: VehicleArrival[] = [];
  const failures: VehicleArrival[] = [];
  const remaining: SettlementVehicle[] = [];

  for (const v of world.vehicles) {
    if (nowMs < v.expectedArrivalTime) {
      remaining.push(v);
      continue;
    }
    // Vehicle has arrived (or its expected-arrival is in the past).
    const target = world.islands.find((s) => s.id === v.target);
    if (!target) {
      // Target despawned mid-flight — vehicle + cargo lost. (Should never
      // happen in step 12; islands aren't removed.)
      continue;
    }
    // §12.5 mechanical failure roll.
    const rng = makeSeededRng(`${v.id}:${v.launchTime}`);
    if (rng() < v.failureRate) {
      failures.push({ targetIslandId: target.id, fromIslandId: v.from, kind: v.kind });
      continue; // vehicle lost; target stays unsettled
    }
    if (target.populated) {
      // Target became populated via a parallel path (e.g. two vehicles
      // racing to the same island). Vehicle + cargo are consumed; no
      // new state created.
      arrivals.push({ targetIslandId: target.id, fromIslandId: v.from, kind: v.kind });
      continue;
    }
    // Mutate spec: populated + auto-placed building.
    target.populated = true;
    const autoBuildingDefId = v.kind === 'ship' ? 'dock' : 'helipad';
    // Push onto the SAME array `IslandState.buildings` will reference.
    // `makeInitialIslandState` sets `state.buildings = spec.buildings`,
    // so the dock is visible to the economy starting this frame.
    target.buildings.push({
      id: `${target.id}-auto-${autoBuildingDefId}-1`,
      defId: autoBuildingDefId,
      x: 0,
      y: 0,
    });
    const newState = makeInitialIslandState(target, nowMs);
    islandStates.set(target.id, newState);
    arrivals.push({ targetIslandId: target.id, fromIslandId: v.from, kind: v.kind });
  }

  // Replace world.vehicles contents in-place so external references stay valid.
  world.vehicles.length = 0;
  for (const v of remaining) world.vehicles.push(v);

  return { arrivals, failures };
}

// ---------------------------------------------------------------------------
// Current position (for in-world rendering)
// ---------------------------------------------------------------------------

/**
 * Current world-tile position of a vehicle given the wall-clock time. Used
 * by the renderer to draw the moving cyan dot along the dispatch line.
 *
 * Settlement vehicles travel one-way along a straight line from origin to
 * target. Position parameterised by elapsed-time fraction; clamped to
 * [0, 1] so a vehicle past its expected-arrival reads as "at target" until
 * the next tick removes it.
 *
 * Returns null if the vehicle's origin or target spec is missing (defensive
 * — every dispatched vehicle has valid endpoints at the time of dispatch).
 */
export function vehicleCurrentPosition(
  v: SettlementVehicle,
  world: WorldState,
  nowMs: number,
): { x: number; y: number } | null {
  const from = world.islands.find((s) => s.id === v.from);
  const to = world.islands.find((s) => s.id === v.target);
  if (!from || !to) return null;
  const totalMs = v.expectedArrivalTime - v.launchTime;
  if (totalMs <= 0) return { x: to.cx, y: to.cy };
  const elapsedMs = Math.max(0, Math.min(totalMs, nowMs - v.launchTime));
  const f = elapsedMs / totalMs;
  return {
    x: from.cx + (to.cx - from.cx) * f,
    y: from.cy + (to.cy - from.cy) * f,
  };
}
