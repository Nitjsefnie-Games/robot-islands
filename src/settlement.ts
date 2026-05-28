// Settlement vehicles: pure logic for §12 ship/helicopter dispatch + arrival.
//
// No PixiJS, no DOM. The renderer (`settlement-ui.ts`) reads this module's
// state and draws; the main ticker calls `tickVehicles` once per frame to
// advance arrivals. Tests target this module directly.
//
// Scope notes:
//   - Per-tier variants live in SHIP_STATS / HELICOPTER_STATS — speed,
//     tilesPerFuel, maxKits, failureRate, and weatherMultiplier all scale
//     with the launching island's tier (§12.6).
//   - §2.6 weather destruction implemented. Mechanical-failure rolls are
//     implemented (§12.5). Every dispatched vehicle still arrives
//     deterministically unless a roll fails at the expected-arrival tick.
//   - Auto-routing at the 10-island NC milestone (§9.6 Auto-Patronage,
//     §12.7) is IMPLEMENTED and gated by Patron Hub presence.
//   - Coastal-tile placement check on Shipyard implemented via
//     `coastal: true` on the shipyard def (§4.3 / §8.8).
//   - Foundation Kit decomposition fires on arrival per §12.4 spec
//     ("decomposes into its raw constituent resources the moment it
//     arrives at the colony"). Held under the §12.3 grace cap until
//     normal storage takes over.
//
// Fuel grade matches the launching island's tier per §11.7 — resolved at
// dispatch via `fuelForTier(tierForLevel(originState.level))` and stored on
// the SettlementVehicle record. No fallback to lower grades.

import type { IslandState } from './economy.js';
import { inv } from './economy.js';
import { hasOperationalBuilding } from './buildings.js';
import type { BuildingDefId } from './building-defs.js';
import { fuelForTier, RECIPES, type ResourceId } from './recipes.js';
import { computeNcState } from './network-consciousness.js';
import { makeSeededRng } from './rng.js';
import { nextRouteId, T1_CARGO_CAPACITY_UNITS_PER_SEC, transitTimeForDistance } from './routes.js';
import { tierForLevel } from './skilltree.js';
import { rasterizePath, rollVehicleDestruction } from './weather.js';
import { islandInscribedAny } from './island.js';
import { CELL_SIZE_TILES, makeInitialIslandState } from './world.js';
import type { IslandSpec, WorldState } from './world.js';

/** Find a deterministic 1×1 coastal tile within `spec` — the first tile in
 *  scan order (top-left to bottom-right) that's inscribed in the island
 *  AND has at least one 4-neighbour that isn't inscribed. Used by
 *  settlement arrivals so the auto-placed Cargo Dock / Helipad lands on
 *  the island's edge rather than the geometric centre. Returns the local
 *  (x, y) relative to spec.cx/cy. Falls back to (0, 0) if no tile in the
 *  bounding box satisfies the predicate (degenerate-tiny island). */
export function findCoastalTile(
  spec: { majorRadius: number; minorRadius: number; extraEllipses?: ReadonlyArray<{ major: number; minor: number; offsetX: number; offsetY: number }> },
): { x: number; y: number } {
  const xMin = -Math.ceil(spec.majorRadius);
  const xMax = Math.ceil(spec.majorRadius);
  const yMin = -Math.ceil(spec.minorRadius);
  const yMax = Math.ceil(spec.minorRadius);
  for (let y = yMin; y <= yMax; y++) {
    for (let x = xMin; x <= xMax; x++) {
      if (!islandInscribedAny(spec, x, y)) continue;
      // 4-neighbour check: at least one neighbour outside the inscribed set.
      const open =
        !islandInscribedAny(spec, x - 1, y) ||
        !islandInscribedAny(spec, x + 1, y) ||
        !islandInscribedAny(spec, x, y - 1) ||
        !islandInscribedAny(spec, x, y + 1);
      if (open) return { x, y };
    }
  }
  return { x: 0, y: 0 };
}

/** Settlement vehicle kind per §12.6. */
export type VehicleKind = 'ship' | 'helicopter';

/** Vehicle tier per §12.6. T1-T4 span Cargo Ship and VTOL Helicopter lines. */
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
  /** Travel speed in tiles/sec. */
  readonly speed: number;
  /** Wall-clock ms timestamp of dispatch. */
  readonly launchTime: number;
  /** Wall-clock ms timestamp the vehicle is expected to arrive. */
  readonly expectedArrivalTime: number;
  /** §2.6 weather vulnerability multiplier per vehicle tier. */
  readonly weatherMultiplier: number;
  /** §11.7 tier-matched fuel grade resolved at dispatch. */
  readonly fuelResource: ResourceId;
  /** §12.5 mechanical failure probability [0,1]. */
  readonly failureRate: number;
  /** §2.6 weather-destruction fate. `active` while in flight; `lost` if the
   *  weather roll destroyed it; `arrived` after a successful landing. */
  status?: 'active' | 'lost' | 'arrived';
}

// ---------------------------------------------------------------------------
// Per-tier stat tables (§12.6)
// ---------------------------------------------------------------------------

export interface VehicleStats {
  readonly speed: number;
  readonly tilesPerFuel: number;
  readonly maxKits: number;
  readonly failureRate: number;
  readonly weatherMultiplier: number;
}

// rev-16 §6.2: cubic-drag invariant `speed² × tilesPerFuel = 0.03125`.
// Fuel-per-second scales as v³ (cruise drag P ∝ v³). T1 anchor preserved;
// T2-T4 retabled per rev-16 §6.2 table.
export const SHIP_STATS: Record<VehicleTier, VehicleStats> = {
  1: { speed: 0.25, tilesPerFuel: 0.5000, maxKits: 1, failureRate: 0.020, weatherMultiplier: 1.0 },
  2: { speed: 0.40, tilesPerFuel: 0.1953, maxKits: 2, failureRate: 0.015, weatherMultiplier: 0.9 },
  3: { speed: 0.60, tilesPerFuel: 0.0868, maxKits: 2, failureRate: 0.010, weatherMultiplier: 0.8 },
  4: { speed: 1.00, tilesPerFuel: 0.0313, maxKits: 3, failureRate: 0.005, weatherMultiplier: 0.7 },
};

// rev-16 §6.2: cubic-drag invariant `speed² × tilesPerFuel = 0.121`.
// T1 anchor preserved. T2-T4 retabled.
export const HELICOPTER_STATS: Record<VehicleTier, VehicleStats> = {
  1: { speed: 0.55, tilesPerFuel: 0.4000, maxKits: 1, failureRate: 0.025, weatherMultiplier: 1.3 },
  2: { speed: 0.85, tilesPerFuel: 0.1675, maxKits: 1, failureRate: 0.015, weatherMultiplier: 1.1 },
  3: { speed: 1.30, tilesPerFuel: 0.0716, maxKits: 2, failureRate: 0.008, weatherMultiplier: 0.9 },
  4: { speed: 1.85, tilesPerFuel: 0.0354, maxKits: 2, failureRate: 0.005, weatherMultiplier: 0.7 },
};

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
  readonly maxKits: number;
  readonly weatherMultiplier: number;
  readonly failureRate: number; // §12.5 mechanical failure probability [0,1]
}

export function tuningFor(kind: VehicleKind, tier: VehicleTier): VehicleTuning {
  const stats = kind === 'ship' ? SHIP_STATS[tier] : HELICOPTER_STATS[tier];
  if (!stats) {
    throw new Error(`Invalid vehicle kind/tier combo: ${kind} tier ${tier}`);
  }
  return {
    tier,
    speed: stats.speed,
    tilesPerFuel: stats.tilesPerFuel,
    maxKits: stats.maxKits,
    weatherMultiplier: stats.weatherMultiplier,
    failureRate: stats.failureRate,
  };
}

/** Whether `origin` has the launch building required for `kind` (Shipyard
 *  for ship, Helipad for helicopter). Pure — reads only the placed-buildings
 *  list off the spec. */
export function hasLaunchBuildingFor(origin: IslandSpec, kind: VehicleKind): boolean {
  const required = kind === 'ship' ? 'shipyard' : 'helipad';
  return hasOperationalBuilding(origin.buildings, required);
}

/** Whether `origin` can launch a Spacetime Anchor instant-settle — i.e. it
 *  has a `spacetime_anchor` building. The `anchor`-kind sibling of
 *  `hasLaunchBuildingFor`. */
export function originCanAnchorSettle(origin: IslandSpec): boolean {
  return hasOperationalBuilding(origin.buildings, 'spacetime_anchor');
}

export type SpacetimeSettleReason =
  | 'invalid-target'
  | 'origin-missing'
  | 'no-spacetime-anchor'
  | 'no-refined-kit'
  | 'target-missing'
  | 'target-not-discovered'
  | 'target-populated';

export type SpacetimeSettleResult =
  | { ok: true }
  | { ok: false; reason: SpacetimeSettleReason };

/** §12.6 — instant T5 settlement via a Spacetime Anchor. Re-checks every
 *  gate, consumes one `foundation_kit_refined` from the origin island's
 *  inventory, and populates the target via `populateSettledIsland` with the
 *  richest (T4-ship-equivalent) loadout. No vehicle, no fuel, no transit.
 *  Returns `{ ok: false }` WITHOUT mutating anything on any gate failure. */
export function settleViaSpacetimeAnchor(
  world: WorldState,
  islandStates: Map<string, IslandState>,
  originId: string,
  targetId: string,
  nowMs: number,
): SpacetimeSettleResult {
  if (originId === targetId) return { ok: false, reason: 'invalid-target' };
  const originSpec = world.islands.find((s) => s.id === originId);
  const originState = islandStates.get(originId);
  if (!originSpec || !originState) return { ok: false, reason: 'origin-missing' };
  if (!originCanAnchorSettle(originSpec)) {
    return { ok: false, reason: 'no-spacetime-anchor' };
  }
  if ((originState.inventory.foundation_kit_refined ?? 0) < 1) {
    return { ok: false, reason: 'no-refined-kit' };
  }
  const targetSpec = world.islands.find((s) => s.id === targetId);
  if (!targetSpec) return { ok: false, reason: 'target-missing' };
  if (!targetSpec.discovered) return { ok: false, reason: 'target-not-discovered' };
  if (targetSpec.populated) return { ok: false, reason: 'target-populated' };

  originState.inventory.foundation_kit_refined =
    (originState.inventory.foundation_kit_refined ?? 0) - 1;
  // Richest loadout per §12.3: T4 ship-equivalent dock + starters, one kit.
  populateSettledIsland(world, islandStates, targetSpec, 'ship', 4, 1, nowMs);
  return { ok: true };
}

// ---------------------------------------------------------------------------
// Starter state helpers (§12.6 per-tier loadouts)
// ---------------------------------------------------------------------------

/** Per-tier starter loadout per §12.6. The defIds + ORDER are the contract;
 *  positions are computed dynamically by `computeStarterBuildings` so they
 *  always land inscribed regardless of island geometry. */
function starterDefIdsFor(kind: VehicleKind, tier: VehicleTier): BuildingDefId[] {
  if (tier <= 2) return [];
  const list: BuildingDefId[] = ['solar', 'workshop'];
  if (kind === 'ship' && tier >= 3) list.push('mine');
  if (tier >= 4) list.push('coal_gen', 'crate');
  return list;
}

/**
 * Compute placements for §12.6 starter buildings, guaranteeing every starter
 * lands on an inscribed tile of the target island and does not collide with
 * any already-placed building (e.g. the auto-placed dock/helipad).
 *
 * Deterministic — same (kind, tier, target geometry, occupied set) inputs
 * always produce the same output. Saves/replays depend on this. Enumeration
 * walks the bounding box in scan order (ascending y, then x), same shape as
 * `findCoastalTile`, and assigns inscribed-and-unoccupied tiles to starters
 * in the fixed defId order from `starterDefIdsFor`.
 *
 * If the island is too small to host every starter (theoretical edge case —
 * even an r=7 disk has ~140 inscribed tiles), the overflow is silently
 * dropped rather than emitting invalid placements. The dropped count is
 * logged via console.warn.
 */
function computeStarterBuildings(
  kind: VehicleKind,
  tier: VehicleTier,
  target: IslandSpec,
): Array<{ defId: BuildingDefId; x: number; y: number }> {
  const defs = starterDefIdsFor(kind, tier);
  if (defs.length === 0) return [];

  // Build occupied set from already-placed buildings on the target so the
  // dock/helipad (pushed onto target.buildings before this call) is excluded.
  const occupied = new Set<string>();
  for (const b of target.buildings) occupied.add(`${b.x},${b.y}`);

  // Enumerate inscribed candidate tiles in deterministic scan order.
  const xMin = -Math.ceil(target.majorRadius);
  const xMax = Math.ceil(target.majorRadius);
  const yMin = -Math.ceil(target.minorRadius);
  const yMax = Math.ceil(target.minorRadius);
  const placements: Array<{ defId: BuildingDefId; x: number; y: number }> = [];
  let i = 0;
  outer: for (let y = yMin; y <= yMax; y++) {
    for (let x = xMin; x <= xMax; x++) {
      if (i >= defs.length) break outer;
      if (!islandInscribedAny(target, x, y)) continue;
      const key = `${x},${y}`;
      if (occupied.has(key)) continue;
      placements.push({ defId: defs[i]!, x, y });
      occupied.add(key);
      i += 1;
    }
  }
  if (placements.length < defs.length) {
    // eslint-disable-next-line no-console
    console.warn(
      `[settlement] computeStarterBuildings: target ${target.id} too small for ${defs.length} starters; placed ${placements.length}, dropped ${defs.length - placements.length}`,
    );
  }
  return placements;
}

function computeFreeSkillPoints(tier: VehicleTier): number {
  if (tier === 3) return 4;
  if (tier === 4) return 6;
  return 0;
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
// Auto-Patronage helpers (§9.6 / §12.7)
// ---------------------------------------------------------------------------

export function _nearestPatronHub(world: WorldState, targetId: string): IslandSpec | null {
  const islandStates = world.islandStates;
  if (!islandStates) return null;

  const hubs = world.islands.filter(spec => {
    const state = islandStates.get(spec.id);
    return state && hasOperationalBuilding(state.buildings, 'patron_hub');
  });
  if (hubs.length === 0) return null;

  const target = world.islands.find(i => i.id === targetId);
  if (!target) return null;

  let best: IslandSpec = hubs[0]!;
  let bestDist = Infinity;
  for (const hub of hubs) {
    const d = Math.hypot(hub.cx - target.cx, hub.cy - target.cy);
    if (d < bestDist || (d === bestDist && hub.id < best.id)) {
      best = hub;
      bestDist = d;
    }
  }
  return best;
}

function spawnAutoPatronageRoutes(world: WorldState, targetId: string): void {
  const hub = _nearestPatronHub(world, targetId);
  if (!hub) return;

  const islandStates = world.islandStates;
  if (!islandStates) return;

  const targetState = islandStates.get(targetId);
  if (!targetState) return;

  const targetTier = tierForLevel(targetState.level);
  const fuel = fuelForTier(targetTier);

  const targetSpec = world.islands.find(i => i.id === targetId);
  if (!targetSpec) return;
  const distance = Math.hypot(hub.cx - targetSpec.cx, hub.cy - targetSpec.cy);
  const transitTime = transitTimeForDistance(distance);

  // Route 1: fuel
  world.routes.push({
    id: nextRouteId(),
    from: hub.id,
    to: targetId,
    type: 'cargo',
    mode: 'priority',
    cargo: [{ resourceId: fuel }],
    capacityPerSec: T1_CARGO_CAPACITY_UNITS_PER_SEC,
    transitTimeSec: transitTime,
    inFlight: [],
  });

  // Route 2: Foundation Kit components
  world.routes.push({
    id: nextRouteId(),
    from: hub.id,
    to: targetId,
    type: 'cargo',
    mode: 'priority',
    cargo: [{ resourceId: 'iron_ingot' }, { resourceId: 'brick' }, { resourceId: 'lumber' }, { resourceId: 'glass' }, { resourceId: 'gear' }],
    capacityPerSec: T1_CARGO_CAPACITY_UNITS_PER_SEC,
    transitTimeSec: transitTime,
    inFlight: [],
  });

  // Route 3: misc T1 raws
  world.routes.push({
    id: nextRouteId(),
    from: hub.id,
    to: targetId,
    type: 'cargo',
    mode: 'priority',
    cargo: [{ resourceId: 'wood' }, { resourceId: 'stone' }, { resourceId: 'coal' }, { resourceId: 'iron_ore' }, { resourceId: 'copper_ore' }],
    capacityPerSec: T1_CARGO_CAPACITY_UNITS_PER_SEC,
    transitTimeSec: transitTime,
    inFlight: [],
  });
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
        | 'out-of-range'
        | 'invalid-tier';
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
  tier: VehicleTier,
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
    if (v.from === originSpec.id && v.target === targetSpec.id && (v.status === 'active' || v.status === undefined)) {
      return { ok: false, reason: 'already-in-flight' };
    }
  }

  // Tier validation: must be within the origin island's unlocked range.
  const originTier = tierForLevel(originState.level);
  if (tier < 1 || tier > originTier) {
    return { ok: false, reason: 'invalid-tier' };
  }

  // 4. fuel — §11.7 tier-matched grade only (no fallback), positive, on-hand,
  //    and sufficient to cover the one-way distance.
  const fuelResource: ResourceId = fuelForTier(tier);
  if (fuelLoaded <= 0 || inv(originState, fuelResource) < fuelLoaded) {
    return { ok: false, reason: 'insufficient-fuel' };
  }
  const t = tuningFor(kind, tier);
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
    status: 'active',
  };
  world.vehicles.push(vehicle);
  return { ok: true, vehicle };
}

// ---------------------------------------------------------------------------
// Tick — process arrivals
// ---------------------------------------------------------------------------

/**
 * Populate a freshly-settled island: flip `populated`, auto-place the dock,
 * push the tier's starter buildings, build + register the IslandState, run
 * §9.6 Auto-Patronage, decompose the Foundation Kit(s) into colony
 * inventory, and grant §12.6 free skill points. Shared by vehicle arrival
 * (`tickVehicles`) and Spacetime Anchor instant-settle.
 *
 * `kind` / `tier` drive the dock def + starter loadout exactly as a vehicle
 * arrival would; `foundationKitCount` drives the §12.4 kit decomposition.
 * The caller must have already confirmed `target` is unpopulated. */
function populateSettledIsland(
  world: WorldState,
  islandStates: Map<string, IslandState>,
  target: IslandSpec,
  kind: VehicleKind,
  tier: VehicleTier,
  foundationKitCount: number,
  nowMs: number,
): void {
  target.populated = true;
  const autoBuildingDefId = kind === 'ship' ? 'dock' : 'helipad';
  const dropTile = kind === 'ship' ? findCoastalTile(target) : { x: 0, y: 0 };
  target.buildings.push({
    id: `${target.id}-auto-${autoBuildingDefId}-1`,
    defId: autoBuildingDefId,
    x: dropTile.x,
    y: dropTile.y,
  });

  const starters = computeStarterBuildings(kind, tier, target);
  for (const b of starters) {
    target.buildings.push({ id: `${target.id}-starter-${b.defId}`, defId: b.defId, x: b.x, y: b.y });
  }

  const newState = makeInitialIslandState(target, nowMs);
  islandStates.set(target.id, newState);

  // §9.6 / §12.7 Auto-Patronage.
  world.islandStates = islandStates;
  const ncState = computeNcState(world);
  if (ncState.milestone >= 3) {
    spawnAutoPatronageRoutes(world, target.id);
  }

  // §12.4 Foundation Kit decomposition: credit recipe inputs to the colony.
  const kitRecipe = RECIPES['kit_assembler'];
  if (kitRecipe) {
    for (const [r, amount] of Object.entries(kitRecipe.inputs)) {
      const id = r as ResourceId;
      const total = (amount ?? 0) * foundationKitCount;
      if (total > 0) {
        newState.inventory[id] = (newState.inventory[id] ?? 0) + total;
        newState.starterInventoryGrace[id] =
          (newState.starterInventoryGrace[id] ?? 0) + total;
      }
    }
  }

  // §12.6 free skill points for T3+ arrivals.
  const freePoints = computeFreeSkillPoints(tier);
  if (freePoints > 0) {
    newState.unspentSkillPoints += freePoints;
  }
}

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
  readonly lost: VehicleArrival[];
}

/**
 * Advance the settlement-vehicle fleet to `nowMs`. Any vehicle whose
 * `expectedArrivalTime` has elapsed is processed:
 *
 *   1. §2.6 weather destruction roll — if destroyed, mark `status: 'lost'`
 *      and do not populate target.
 *   2. §12.5 mechanical failure roll — if failed, mark `status: 'lost'`
 *      and do not populate target.
 *   3. Target spec's `populated` flag flips to true.
 *   4. A Cargo Dock (for ships) or Helipad (for helicopters) is pushed onto
 *      the target spec's `buildings` array. Ship docks land on the first
 *      coastal tile (`findCoastalTile`) so they sit on the island's edge
 *      rather than the centre; helipads stay at (0, 0) since they don't
 *      need shoreline contact.
 *   5. Starter buildings for T3+ vehicles are pushed onto the spec before
 *      `makeInitialIslandState` so they count for storage + economy.
 *   6. A fresh IslandState is constructed via `makeInitialIslandState` and
 *      added to `islandStates`. The spec's `buildings` array IS the same
 *      reference the state will hold, so the auto-placed dock + starters
 *      are visible to the economy on the very next tick.
 *
 * All vehicles (including lost and arrived) are kept in `world.vehicles`
 * with their `status` field updated so the UI/history can display them.
 *
 * Per the load-bearing invariant in `persistence.test.ts` ("keeps
 * IslandState.buildings === IslandSpec.buildings"), we push all buildings
 * onto the spec BEFORE calling `makeInitialIslandState` so the storage-cap
 * aggregation accounts for every starter building.
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
  const lost: VehicleArrival[] = [];
  const remaining: SettlementVehicle[] = [];

  for (const v of world.vehicles) {
    // Terminal-status vehicles are kept for UI/history but no longer
    // participate in arrival processing.
    if (v.status === 'lost' || v.status === 'arrived') {
      remaining.push(v);
      continue;
    }

    if (nowMs < v.expectedArrivalTime) {
      remaining.push(v);
      continue;
    }
    // Vehicle has arrived (or its expected-arrival is in the past).
    const target = world.islands.find((s) => s.id === v.target);
    if (!target) {
      // Target despawned mid-flight — vehicle + cargo lost. (Should never
      // happen in step 12; islands aren't removed.)
      v.status = 'lost';
      remaining.push(v);
      continue;
    }

    // §2.6 weather destruction roll.
    const from = world.islands.find((s) => s.id === v.from);
    if (from) {
      const dx = target.cx - from.cx;
      const dy = target.cy - from.cy;
      const distance = Math.sqrt(dx * dx + dy * dy);
      if (distance > 0) {
        const dirX = dx / distance;
        const dirY = dy / distance;
        const path = rasterizePath(
          from.cx,
          from.cy,
          dirX,
          dirY,
          distance,
          v.speed,
          v.launchTime,
          CELL_SIZE_TILES,
        );
        const roll = rollVehicleDestruction(world.seed, path, v.weatherMultiplier, v.id);
        if (roll.destroyed) {
          v.status = 'lost';
          lost.push({ targetIslandId: target.id, fromIslandId: v.from, kind: v.kind });
          remaining.push(v);
          continue;
        }
      }
    }

    // §12.5 mechanical failure roll.
    const rng = makeSeededRng(`${v.id}:${v.launchTime}`);
    if (rng() < v.failureRate) {
      v.status = 'lost';
      failures.push({ targetIslandId: target.id, fromIslandId: v.from, kind: v.kind });
      remaining.push(v);
      continue; // vehicle lost; target stays unsettled
    }
    if (target.populated) {
      // Target became populated via a parallel path (e.g. two vehicles
      // racing to the same island). Vehicle + cargo are consumed; no
      // new state created.
      v.status = 'arrived';
      arrivals.push({ targetIslandId: target.id, fromIslandId: v.from, kind: v.kind });
      remaining.push(v);
      continue;
    }
    // Populate the target (shared with the Spacetime Anchor instant path).
    populateSettledIsland(world, islandStates, target, v.kind, v.tier, v.foundationKitCount, nowMs);

    v.status = 'arrived';
    arrivals.push({ targetIslandId: target.id, fromIslandId: v.from, kind: v.kind });
    remaining.push(v);
  }

  // Replace world.vehicles contents in-place so external references stay valid.
  world.vehicles.length = 0;
  for (const v of remaining) world.vehicles.push(v);

  return { arrivals, failures, lost };
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
