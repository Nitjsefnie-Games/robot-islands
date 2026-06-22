// Settlement vehicles: pure logic for §12 ship/helicopter dispatch + arrival.
//
// No PixiJS, no DOM. The renderer (`settlement-ui.ts`) reads this module's
// state and draws; the main ticker calls `tickVehicles` once per frame to
// advance arrivals. Tests target this module directly.
//
// Per-tier stats (speed, tilesPerFuel, maxKits, failureRate, weatherMultiplier)
// live in SHIP_STATS / HELICOPTER_STATS and scale with the launching island's
// tier (§12.6). Auto-Patronage routing (§9.6 / §12.7) is gated by Patron Hub
// presence. Foundation Kit decomposition fires on arrival (§12.4), held under
// the §12.3 grace cap until normal storage takes over.
//
// Fuel grade matches the launching island's tier per §11.7 — resolved at
// dispatch via `fuelForTier(tierForLevel(originState.level))` and stored on
// the SettlementVehicle record. No fallback to lower grades.

import type { IslandState } from './economy.js';
import { inv } from './economy.js';
import { hasOperationalBuilding } from './buildings.js';
import { BUILDING_DEFS, type BuildingDefId } from './building-defs.js';
import { fuelForTier, RECIPES, type ResourceId } from './recipes.js';
import { computeNcState } from './network-consciousness.js';
import { makeSeededRng } from './rng.js';
import { nextRouteId, T1_CARGO_CAPACITY_UNITS_PER_SEC, transitTimeForDistance } from './routes.js';
import { tierForLevel } from './skilltree.js';
import { biomeForCell, rasterizePath, rollVehicleDestruction, sumIslandCo2 } from './weather.js';
import { islandInscribedAny } from './island.js';
import { footprintTiles } from './shape-mask.js';
import { CELL_SIZE_TILES, ensureCellGenerated, makeInitialIslandState } from './world.js';
import type { IslandSpec, WorldState } from './world.js';
import { computeSignalRanges, pointInSignalRange, type SignalRange } from './antenna.js';
import { islandIntersectsCells, markIslandDiscovered } from './discovery.js';

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
  /** §11 telemetry: cells scanned directly under the vehicle's path (single
   *  cell, no neighbours — see `tickVehicles`). Buffered while out of antenna
   *  range, flushed to `world.revealedCells` when the vehicle is in range OR on
   *  successful arrival; forfeited on loss. Runtime-only (rehydrated empty on
   *  load) — mirrors the drone scan buffer's role. */
  scanBuffer: Set<string>;
  /** §2.6 deterministic weather fate, frozen on the FIRST tick that processes
   *  the vehicle (mirrors the drone `doomedAtMs`, but lazily — so the §15.1
   *  wall anchor + §7.3 CO₂ field that the first tick samples decide the fate,
   *  without changing the `dispatchVehicle` signature). `doomedAtMs` is the
   *  perf-clock entry time of the cell that destroys the vehicle, or absent if
   *  it survives. `weatherRolled` guards the freeze (distinguishes "survives"
   *  from "not yet rolled"). Old saves lack both → rolled fresh on first tick. */
  doomedAtMs?: number;
  weatherRolled?: boolean;
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
  if (kind === 'ship' && tier >= 3) list.push('iron_mine');
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
  // We mark every footprint tile (not just the anchor) so multi-tile starters
  // cannot overlap each other or the dock.
  const occupied = new Set<string>();
  for (const b of target.buildings) {
    const def = BUILDING_DEFS[b.defId];
    for (const t of footprintTiles(def.footprint, b.x, b.y, (b.rotation ?? 0) as 0 | 1 | 2 | 3)) {
      occupied.add(`${t.x},${t.y}`);
    }
  }

  // Enumerate inscribed candidate tiles in deterministic scan order.
  const xMin = -Math.ceil(target.majorRadius);
  const xMax = Math.ceil(target.majorRadius);
  const yMin = -Math.ceil(target.minorRadius);
  const yMax = Math.ceil(target.minorRadius);

  // Terrain-tagged extractors (e.g. Mine) must sit on valid tiles. Place those
  // first so an unconstrained Solar/Workshop doesn't accidentally occupy part
  // of an ore cluster the Mine needs.
  const sorted = [...defs].sort((a, b) => {
    const aReq = BUILDING_DEFS[a].requiredTile?.length ? 1 : 0;
    const bReq = BUILDING_DEFS[b].requiredTile?.length ? 1 : 0;
    return bReq - aReq;
  });

  const placements: Array<{ defId: BuildingDefId; x: number; y: number }> = [];

  const tryPlace = (defId: BuildingDefId, requireTerrain: boolean): { x: number; y: number } | null => {
    const def = BUILDING_DEFS[defId];
    const required = def.requiredTile;
    const terrainAt = target.terrainAt;
    const allowed =
      requireTerrain && required && required.length > 0 && terrainAt
        ? new Set(required)
        : null;
    for (let y = yMin; y <= yMax; y++) {
      for (let x = xMin; x <= xMax; x++) {
        if (!islandInscribedAny(target, x, y)) continue;
        const tiles = footprintTiles(def.footprint, x, y, 0);
        let blocked = false;
        for (const t of tiles) {
          if (!islandInscribedAny(target, t.x, t.y)) {
            blocked = true;
            break;
          }
          if (occupied.has(`${t.x},${t.y}`)) {
            blocked = true;
            break;
          }
          if (allowed && !allowed.has(terrainAt!(t.x, t.y))) {
            blocked = true;
            break;
          }
        }
        if (blocked) continue;
        for (const t of tiles) occupied.add(`${t.x},${t.y}`);
        return { x, y };
      }
    }
    return null;
  };

  for (const defId of sorted) {
    // First pass: honour the def's terrain requirement if the island exposes
    // a terrain function.
    let p = tryPlace(defId, true);
    if (!p) {
      // Fallback: any inscribed unoccupied tile. This keeps tiny or unusual
      // islands from dropping the starter entirely, matching the old behaviour.
      p = tryPlace(defId, false);
    }
    if (p) placements.push({ defId, ...p });
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
    scanBuffer: new Set<string>(),
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
  /** §11/§12 discovery: islands that flipped `discovered` because a vehicle's
   *  single-cell scan trail revealed one of their footprint cells this tick. */
  readonly newlyDiscoveredIslandIds: string[];
  /** Number of cells added to `world.revealedCells` this tick (flushed vehicle
   *  scan buffers). The caller rebuilds render layers when this is > 0. */
  readonly revealedCellsAdded: number;
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
 * A vehicle that goes terminal (lost / arrived) THIS tick has its `status`
 * field updated and stays in `world.vehicles` for its transition tick (so the
 * arrival/loss is fully processed); the next `tickVehicles` prunes it, since
 * nothing reads a terminal vehicle afterward (the UI map + ledger both filter
 * to non-terminal). It is no longer retained indefinitely "for history".
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
/** Freeze the §2.6 weather fate for a vehicle: the perf-clock entry time of the
 *  cell that destroys it, or undefined if it survives. Uses the SAME path +
 *  coherent biome/CO₂ field + wall anchor as the legacy arrival-time roll, so
 *  the outcome is identical — only the sampling MOMENT moves to the first tick
 *  (which freezes the §15.1 anchor + §7.3 CO₂ the tick sees). */
function computeVehicleDoom(world: WorldState, v: SettlementVehicle, wallOffsetMs: number): number | undefined {
  const from = world.islands.find((s) => s.id === v.from);
  const target = world.islands.find((s) => s.id === v.target);
  if (!from || !target) return undefined;
  const dx = target.cx - from.cx;
  const dy = target.cy - from.cy;
  const distance = Math.sqrt(dx * dx + dy * dy);
  if (distance <= 0) return undefined;
  const path = rasterizePath(from.cx, from.cy, dx / distance, dy / distance, distance, v.speed, v.launchTime, CELL_SIZE_TILES);
  const roll = rollVehicleDestruction(
    world.seed, path, v.weatherMultiplier, v.id, wallOffsetMs,
    (cx, cy) => biomeForCell(world, cx, cy), sumIslandCo2(world),
  );
  return roll.destroyed && roll.atCellIndex !== null ? path[roll.atCellIndex]!.entryMs : undefined;
}

/** Cells whose interior the segment a→b passes through, by floor-division —
 *  the tiles "directly under" the vehicle with NO neighbour slack (unlike the
 *  drone corridor's half-diagonal widening). Sampled at quarter-cell resolution
 *  so no traversed cell is skipped. Returns `{cx, cy, key}` triples. */
function cellsUnderSegment(
  ax: number, ay: number, bx: number, by: number,
): Array<{ cx: number; cy: number; key: string }> {
  const dx = bx - ax;
  const dy = by - ay;
  const len = Math.sqrt(dx * dx + dy * dy);
  const steps = Math.max(1, Math.ceil(len / (CELL_SIZE_TILES / 4)));
  const seen = new Set<string>();
  const out: Array<{ cx: number; cy: number; key: string }> = [];
  for (let i = 0; i <= steps; i++) {
    const t = i / steps;
    const cx = Math.floor((ax + dx * t) / CELL_SIZE_TILES);
    const cy = Math.floor((ay + dy * t) / CELL_SIZE_TILES);
    const key = `${cx},${cy}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ cx, cy, key });
  }
  return out;
}

/** Drain a vehicle's scan buffer into `world.revealedCells`; returns the count
 *  of newly-revealed cells. Mirrors the drone buffer flush — called when the
 *  vehicle is in antenna range OR on successful arrival; cleared in place. */
function flushVehicleBuffer(v: SettlementVehicle, world: WorldState): number {
  let added = 0;
  for (const k of v.scanBuffer) {
    if (world.revealedCells.has(k)) continue;
    world.revealedCells.add(k);
    added++;
  }
  v.scanBuffer.clear();
  return added;
}

export function tickVehicles(
  world: WorldState,
  islandStates: Map<string, IslandState>,
  nowMs: number,
  /** §15.1 wall anchor: the §2.6 destruction roll samples weather at each
   *  path cell's `entryMs + wallOffsetMs` (see `weatherClockMs`). */
  wallOffsetMs: number = 0,
  /** Wall-clock ms of the previous tick — drives the per-tick single-cell scan
   *  trail (defaults to `nowMs`, i.e. a point sample, for single-shot callers). */
  prevTickMs: number = nowMs,
  /** PERF: optional precomputed antenna ranges (catch-up loop reuse), mirroring
   *  `tickDrones`. Omitted ⇒ computed from populated islands' Antennas. */
  precomputedRanges?: ReadonlyArray<SignalRange>,
): TickVehiclesResult {
  const arrivals: VehicleArrival[] = [];
  const failures: VehicleArrival[] = [];
  const lost: VehicleArrival[] = [];
  const newlyDiscoveredIslandIds: string[] = [];
  const remaining: SettlementVehicle[] = [];
  const ranges = precomputedRanges ?? computeSignalRanges(world.islands.filter((s) => s.populated));
  let cellsAddedThisTick = 0;

  for (const v of world.vehicles) {
    // PERF/cleanup: PRUNE vehicles already terminal at the start of this tick.
    // A terminal vehicle (lost / arrived) is fully processed at its transition
    // tick (settlement, scan-buffer flush, reveals) and nothing reads it
    // afterward — repaintVehicleLayer and repaintLedger (settlement-ui) both
    // skip terminal vehicles, the §12.3 one-in-flight-per-target dup-check
    // matches only `active`/undefined, and no history UI consumes them. Kept
    // "for UI/history" they only piled up unbounded in world.vehicles and got
    // walked every tick (client+server) and bloated saves. A vehicle that goes
    // terminal DURING this tick is still pushed to `remaining` below, so it
    // persists for its transition tick and is dropped on the next — its
    // processing is never skipped. Mirrors the drone prune (ca49569).
    if (v.status === 'lost' || v.status === 'arrived') {
      continue;
    }

    // Freeze the §2.6 weather fate on the first tick (see SettlementVehicle).
    if (!v.weatherRolled) {
      v.doomedAtMs = computeVehicleDoom(world, v, wallOffsetMs);
      v.weatherRolled = true;
    }

    // 1) Per-tick discovery: reveal the single cell(s) directly under the
    //    vehicle from its prev-tick position to now, antenna-gated exactly like
    //    drones. Clamp the trail end to `doomedAtMs` so a doomed vehicle never
    //    scans past its death point.
    const segStartMs = Math.max(prevTickMs, v.launchTime);
    const segEndMs = Math.min(nowMs, v.doomedAtMs !== undefined ? v.doomedAtMs : v.expectedArrivalTime);
    if (segEndMs >= segStartMs) {
      const a = vehicleCurrentPosition(v, world, segStartMs);
      const b = vehicleCurrentPosition(v, world, segEndMs);
      if (a && b) {
        for (const { cx, cy, key } of cellsUnderSegment(a.x, a.y, b.x, b.y)) {
          ensureCellGenerated(world, cx, cy);
          v.scanBuffer.add(key);
        }
        // Flush trigger A: in any antenna's range at the segment end (live).
        if (pointInSignalRange(ranges, b.x, b.y)) {
          cellsAddedThisTick += flushVehicleBuffer(v, world);
        }
      }
    }

    // 1.5) §11.4 dark-aware loss visibility (mirrors drones): a weather-doomed
    //      vehicle is removed the instant its phantom position re-enters antenna
    //      coverage at/after death. Out-of-range deaths stay shown as travelling
    //      until the `expectedArrivalTime` fallback in the arrival branch.
    if (v.doomedAtMs !== undefined && nowMs >= v.doomedAtMs && nowMs < v.expectedArrivalTime) {
      const phantom = vehicleCurrentPosition(v, world, nowMs);
      if (phantom && pointInSignalRange(ranges, phantom.x, phantom.y)) {
        v.status = 'lost';
        lost.push({ targetIslandId: v.target, fromIslandId: v.from, kind: v.kind });
        v.scanBuffer.clear(); // §11.6 telemetry forfeited on loss
        remaining.push(v);
        continue;
      }
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
      v.scanBuffer.clear();
      remaining.push(v);
      continue;
    }

    // §2.6 weather destruction — use the frozen fate (fallback: undefined ⇒
    // survived). Identical to the legacy inline roll, just decided at the freeze.
    if (v.doomedAtMs !== undefined) {
      v.status = 'lost';
      lost.push({ targetIslandId: target.id, fromIslandId: v.from, kind: v.kind });
      v.scanBuffer.clear();
      remaining.push(v);
      continue;
    }

    // §12.5 mechanical failure roll.
    const rng = makeSeededRng(`${v.id}:${v.launchTime}`);
    if (rng() < v.failureRate) {
      v.status = 'lost';
      failures.push({ targetIslandId: target.id, fromIslandId: v.from, kind: v.kind });
      v.scanBuffer.clear();
      remaining.push(v);
      continue; // vehicle lost; target stays unsettled
    }
    if (target.populated) {
      // Target became populated via a parallel path (e.g. two vehicles
      // racing to the same island). Vehicle + cargo are consumed; no
      // new state created. It still made the crossing, so flush its trail.
      v.status = 'arrived';
      cellsAddedThisTick += flushVehicleBuffer(v, world);
      arrivals.push({ targetIslandId: target.id, fromIslandId: v.from, kind: v.kind });
      remaining.push(v);
      continue;
    }
    // Populate the target (shared with the Spacetime Anchor instant path).
    populateSettledIsland(world, islandStates, target, v.kind, v.tier, v.foundationKitCount, nowMs);

    v.status = 'arrived';
    // Successful arrival recovers the full buffered scan trail (like a drone
    // flushing on return).
    cellsAddedThisTick += flushVehicleBuffer(v, world);
    arrivals.push({ targetIslandId: target.id, fromIslandId: v.from, kind: v.kind });
    remaining.push(v);
  }

  // Any-cell island discovery from the cells flushed this tick (mirrors the
  // drone post-reveal walk): flip undiscovered, unpopulated islands whose
  // footprint now intersects a revealed cell.
  if (cellsAddedThisTick > 0) {
    for (const isl of world.islands) {
      if (isl.populated) continue;
      if (isl.discovered) continue;
      if (islandIntersectsCells(isl, world.revealedCells)) {
        markIslandDiscovered(isl, world.revealedCells);
        newlyDiscoveredIslandIds.push(isl.id);
      }
    }
  }

  // Replace world.vehicles contents in-place so external references stay valid.
  world.vehicles.length = 0;
  for (const v of remaining) world.vehicles.push(v);

  return { arrivals, failures, lost, newlyDiscoveredIslandIds, revealedCellsAdded: cellsAddedThisTick };
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
