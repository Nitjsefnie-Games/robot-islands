// Drone fleet: pure logic for dispatch + capsule-corridor discovery (§11).
//
// No PixiJS, no DOM. The renderer in `drones-ui.ts` reads this module's state
// and draws; the economy ticker calls `tickDrones` once per frame to advance
// returns. Tests target this module directly.
//
// Scope notes:
//   - Drone tiers T1–T6 are catalogued (§11.5); T4 omnidirectional pulse and
//     T5 path-drawn modes are wired.
//   - §2.6 weather destruction implemented.
//   - Tier-gating on Drone Pad placement runs through `buildingUnlocked` in
//     `building-defs.ts` like every other tiered building.
//   - Fuel grade matches the launching island's tier per §11.7 — resolved at
//     dispatch via `fuelForTier(tierForLevel(origin.level))` and stored on
//     the Drone record. A T1 island launches with biofuel, a T3 island with
//     aviation kerosene, etc. No fallback to lower grades.

import { computeSignalRanges, pointInSignalRange } from './antenna.js';
import { cellCenterTile, corridorCells, islandCells, parseCellKey } from './discovery.js';
import type { IslandState } from './economy.js';
import { inv } from './economy.js';
import { fuelForTier, type ResourceId } from './recipes.js';
import { effectiveSkillMultipliers, tierForLevel } from './skilltree.js';
import { rasterizePath, rollVehicleDestruction } from './weather.js';
import { CELL_SIZE_TILES } from './world.js';
import type { WorldState } from './world.js';

/** Drone tier per §11.5. Step 6 only emits tier-2 drones; the field exists so
 *  future tiers can be added without reshaping the data model. */
export type DroneTier = 1 | 2 | 3 | 4 | 5 | 6;

export interface Drone {
  readonly id: string;
  readonly fromIslandId: string;
  /** Origin position in world tiles. Stored at launch time so we don't
   *  re-look-up the island spec on every tick. */
  readonly originX: number;
  readonly originY: number;
  /** Unit direction vector (player-chosen, normalised at dispatch). */
  readonly dirX: number;
  readonly dirY: number;
  /** Outbound straight-line distance in tiles. Round-trip range is 2× this;
   *  range = fuel × tier_efficiency, with the /2 because the drone goes out
   *  AND back along the same straight line for T1-T3 (§11.2). */
  readonly outboundTiles: number;
  /** Scan corridor radius (capsule half-width) in tiles. */
  readonly scanRadius: number;
  /** Wall-clock ms timestamp of dispatch. */
  readonly launchTime: number;
  /** Wall-clock ms timestamp the drone is expected back at origin. */
  readonly expectedReturnTime: number;
  readonly tier: DroneTier;
  readonly fuelLoaded: number;
  /** §11.7 tier-matched fuel grade resolved at dispatch from the launching
   *  island's tier (`fuelForTier(tierForLevel(origin.level))`). Stored so
   *  the ticker / UI / persistence layer know which inventory key was
   *  burned without re-deriving from level (which is mutable post-launch). */
  readonly fuelResource: ResourceId;
  /** §2.6 weather-destruction fate. `active` while in flight; `lost` if the
   *  weather roll destroyed it; `returned` after a successful landing. */
  status?: 'active' | 'lost' | 'returned';
  /** For T5 path-drawn drones: sequence of waypoints. Empty for straight-line drones. */
  readonly waypoints: ReadonlyArray<{ readonly x: number; readonly y: number }>;
  /** True if this drone is currently in dark mode (out of antenna range). */
  darkMode: boolean;
  /** Accumulated discoveries while in dark mode. */
  darkModeDiscoveries: Array<{ readonly islandId: string }>;
  /** §13.3 Probability Engine bias stored at dispatch time. */
  readonly probabilityBias: number;
}

/** T2-equivalent constants for step 6. Tile units; seconds for time.
 *  10 biofuel → 40 tiles round-trip → 20 tiles outbound, ~40s flight.
 *  50 biofuel → 200 tiles round-trip → 100 tiles outbound, ~200s flight.
 *  Rebalanced for idle-game scale, step #19: speed 2 → 0.5 t/s so a
 *  50-tile drone trip takes 100s instead of 25s. */
export const DRONE_TIER_EFFICIENCY = 4;
export const DRONE_SPEED_TILES_PER_SEC = 0.5; // rebalanced for idle-game scale, step #19 (was 2)
export const DRONE_SCAN_RADIUS_TILES = 8;

/** T5 path-drawn drone constants per §11.6. */
export const DRONE_T5_EFFICIENCY = 8;
export const DRONE_T5_SPEED_TILES_PER_SEC = 0.8;
export const DRONE_T5_SCAN_RADIUS_TILES = 12;
export const DRONE_T5_WEATHER_MULTIPLIER = 0.5;

/** §2.6 weather vulnerability multiplier per drone tier. */
export const DRONE_TIER_MULTIPLIERS: Record<DroneTier, number> = {
  1: 1.5,
  2: 1.0,
  3: 0.7,
  4: 0.5,
  5: DRONE_T5_WEATHER_MULTIPLIER,
  6: 0.2,
};



/** Minimum / maximum biofuel the launch UI lets the player commit per drone.
 *  Chosen so the demo islands `hidden-w` (50 tiles) and `hidden-s` (~78 tiles)
 *  are reachable inside the slider's range. */
export const MIN_FUEL_PER_DRONE = 10;
export const MAX_FUEL_PER_DRONE = 50;

/** Squared 2D distance from point P to line segment AB. Pure math.
 *
 *  Standard derivation: project P onto the infinite line through AB, clamp
 *  the projection parameter t into [0, 1] so we measure to the segment
 *  (not the line), and return the squared distance from P to the clamped
 *  foot. Squared because every caller compares against a squared radius;
 *  no sqrt cost.
 *
 *  Degenerate segment (A == B): returns the squared distance from P to A. */
export function pointToSegmentDistSq(
  px: number,
  py: number,
  ax: number,
  ay: number,
  bx: number,
  by: number,
): number {
  const dx = bx - ax;
  const dy = by - ay;
  const lenSq = dx * dx + dy * dy;
  if (lenSq === 0) {
    const ex = px - ax;
    const ey = py - ay;
    return ex * ex + ey * ey;
  }
  const t = Math.max(0, Math.min(1, ((px - ax) * dx + (py - ay) * dy) / lenSq));
  const fx = ax + t * dx;
  const fy = ay + t * dy;
  const ex = px - fx;
  const ey = py - fy;
  return ex * ex + ey * ey;
}

/** §11.5 T4 omnidirectional pulse: reveals every undiscovered island whose
 *  centre is within `T4_PULSE_RADIUS_TILES` of `origin` in a single instant.
 *  Distinct from `dispatchDrone` — no flight path, no travel time, no
 *  return event, no corridor capsule. Pure mutation: flips `discovered`
 *  on matching islands, deducts `T4_PULSE_FUEL_COST` of tier-4 fuel
 *  (`cryogenic_hydrogen`) from the origin inventory, returns the list of
 *  newly-discovered island ids for telemetry / UI feedback. */
export const T4_PULSE_RADIUS_TILES = 3 * 16; // = 3R per §11.5 (R = CELL_SIZE_TILES = 16)
export const T4_PULSE_FUEL_COST = MIN_FUEL_PER_DRONE; // 10 units placeholder

export interface PulseResult {
  readonly ok: boolean;
  readonly reason?: string;
  readonly discoveredIslandIds: ReadonlyArray<string>;
}

export function firePulse(
  world: WorldState,
  origin: IslandState,
  nowMs: number,
): PulseResult {
  // Gate 1: origin must have a launch_tower placed.
  if (!origin.buildings.some((b) => b.defId === 'launch_tower')) {
    return { ok: false, reason: 'no-launch-tower', discoveredIslandIds: [] };
  }
  // Gate 2: origin must be tier 4 or higher (Launch Tower is T4).
  const tier = tierForLevel(origin.level);
  if (tier < 4) {
    return { ok: false, reason: 'tier-too-low', discoveredIslandIds: [] };
  }
  // Gate 3: tier-4 fuel on hand.
  const fuelResource: ResourceId = fuelForTier(4);
  if (inv(origin, fuelResource) < T4_PULSE_FUEL_COST) {
    return { ok: false, reason: 'insufficient-fuel', discoveredIslandIds: [] };
  }
  // Locate origin spec for centre coordinates.
  const originSpec = world.islands.find((i) => i.id === origin.id);
  if (!originSpec) {
    return { ok: false, reason: 'no-origin-spec', discoveredIslandIds: [] };
  }
  // Reveal every undiscovered island within the disk. `populated` islands
  // are already discovered by definition; we still flip `discovered` for
  // the unflagged ones (mirrors how dispatchDrone treats discovery).
  const discovered: string[] = [];
  for (const isl of world.islands) {
    if (isl.discovered) continue;
    const dx = isl.cx - originSpec.cx;
    const dy = isl.cy - originSpec.cy;
    if (dx * dx + dy * dy <= T4_PULSE_RADIUS_TILES * T4_PULSE_RADIUS_TILES) {
      isl.discovered = true;
      discovered.push(isl.id);
    }
  }
  // Deduct fuel — pulse fires regardless of how many islands were revealed
  // (consistent with `dispatchDrone`'s "fuel spent at launch" behavior).
  origin.inventory[fuelResource] = inv(origin, fuelResource) - T4_PULSE_FUEL_COST;
  // `nowMs` parameter currently unused — kept in the signature for future
  // tracking (e.g. cooldown gate, last-pulse timestamp) without breaking
  // call sites.
  void nowMs;
  return { ok: true, discoveredIslandIds: discovered };
}

let droneIdCounter = 0;
export function nextDroneId(): string {
  droneIdCounter += 1;
  return `drone-${droneIdCounter}`;
}

/** Reset the drone-id counter. Test-only — `dispatchDrone` increments a
 *  module-level counter so ids stay unique within a session. */
export function _resetDroneIdCounter(): void {
  droneIdCounter = 0;
}

/** Seed the drone-id counter so the next id is `drone-${value + 1}`. Used by
 *  the persistence loader (`persistence.ts`) after restoring a save so the
 *  in-session counter doesn't collide with already-saved drone ids. Walking
 *  `world.drones` for the numeric suffix max and calling this with that max
 *  is the fix the in-tree FIXME in this file foresaw. Idempotent: passing a
 *  smaller value than the current counter is a no-op (we only raise). */
export function _seedDroneIdCounter(value: number): void {
  if (value > droneIdCounter) droneIdCounter = value;
}

export type DispatchResult =
  | { ok: true; drone: Drone }
  | { ok: false; reason: 'insufficient-fuel' | 'invalid-direction' | 'already-in-flight' | 'path-too-long' };

/** §13.3 Probability Engine — compute the rare-island scan bias for an island. */
export function probabilityBiasForIsland(state: { buildings: ReadonlyArray<{ defId: string }> }): number {
  const engineCount = state.buildings.filter((b) => b.defId === 'probability_engine').length;
  if (engineCount === 0) return 0;
  if (engineCount === 1) return 0.25;
  if (engineCount === 2) return 0.40;
  if (engineCount === 3) return 0.50;
  return 0.60;
}

/** Rasterize a polyline path for weather destruction rolls.
 *  Returns the same {cx, cy, entryMs} shape as `rasterizePath` but follows
 *  the waypoint polyline outbound and its reverse inbound. */
function rasterizeWaypointPathForWeather(
  waypoints: ReadonlyArray<{ x: number; y: number }>,
  speedTilesPerSec: number,
  launchTimeMs: number,
  cellSizeTiles: number,
): Array<{ cx: number; cy: number; entryMs: number }> {
  const result: Array<{ cx: number; cy: number; entryMs: number }> = [];
  let elapsedMs = 0;
  // Outbound: follow waypoints in order.
  for (let i = 0; i < waypoints.length - 1; i++) {
    const a = waypoints[i]!;
    const b = waypoints[i + 1]!;
    const segLen = Math.sqrt((b.x - a.x) ** 2 + (b.y - a.y) ** 2);
    if (segLen === 0) continue;
    const dirX = (b.x - a.x) / segLen;
    const dirY = (b.y - a.y) / segLen;
    const segPath = rasterizePath(a.x, a.y, dirX, dirY, segLen, speedTilesPerSec, launchTimeMs + elapsedMs, cellSizeTiles);
    for (const p of segPath) {
      const last = result[result.length - 1];
      if (!last || last.cx !== p.cx || last.cy !== p.cy || Math.abs(last.entryMs - p.entryMs) > 0.001) {
        result.push(p);
      }
    }
    elapsedMs += (segLen / speedTilesPerSec) * 1000;
  }
  // Inbound: follow waypoints in reverse order.
  for (let i = waypoints.length - 1; i > 0; i--) {
    const a = waypoints[i]!;
    const b = waypoints[i - 1]!;
    const segLen = Math.sqrt((b.x - a.x) ** 2 + (b.y - a.y) ** 2);
    if (segLen === 0) continue;
    const dirX = (b.x - a.x) / segLen;
    const dirY = (b.y - a.y) / segLen;
    const segPath = rasterizePath(a.x, a.y, dirX, dirY, segLen, speedTilesPerSec, launchTimeMs + elapsedMs, cellSizeTiles);
    for (const p of segPath) {
      const last = result[result.length - 1];
      if (!last || last.cx !== p.cx || last.cy !== p.cy || Math.abs(last.entryMs - p.entryMs) > 0.001) {
        result.push(p);
      }
    }
    elapsedMs += (segLen / speedTilesPerSec) * 1000;
  }
  return result;
}

/**
 * Launch a drone from `origin`. Mutates `world.drones` and `origin.inventory`.
 *
 * Validation (in this order — test cases assert each rejection separately):
 *   1. Direction vector magnitude > 0 (post-normalisation length 1).
 *   2. Origin must not already have an in-flight drone (1-drone-per-pad cap
 *      per §11.7 dispatch capacity table).
 *   3. Origin must hold ≥ `fuelLoaded` of the tier-matched fuel grade. The
 *      grade is resolved from the launching island's tier per §11.7 — a T1
 *      island burns biofuel, a T3 island burns aviation_kerosene, etc.
 *      No fallback to lower grades.
 *
 * On success: subtract `fuelLoaded` from the tier-matched fuel inventory,
 * append a fresh `Drone` (carrying `fuelResource`) to `world.drones`,
 * return `{ ok: true, drone }`.
 *
 * The `originX`/`originY` are read from the home spec by the caller (UI
 * passes them in via the world map). We store them on the drone so the
 * tick loop doesn't have to re-look-up by id.
 */
export function dispatchDrone(
  world: WorldState,
  origin: IslandState,
  originX: number,
  originY: number,
  dirX: number,
  dirY: number,
  fuelLoaded: number,
  nowMs: number,
  waypoints?: ReadonlyArray<{ x: number; y: number }>,
  /** Player-selected drone tier. The Drone Ops UI now exposes a picker
   *  capped at the island's current tier; the picker passes that selection
   *  in here so a T5 island can fly a cheap T2 drone for short hops
   *  instead of always burning plasma_charge. Defaults to the island tier
   *  (legacy behavior) when undefined. The path-drawn branch forces T5
   *  regardless of the selector since path-drawn IS the T5 mechanic. */
  selectedTier?: DroneTier,
): DispatchResult {
  // 1. direction
  const mag = Math.sqrt(dirX * dirX + dirY * dirY);
  if (mag <= 0) return { ok: false, reason: 'invalid-direction' };
  const ux = dirX / mag;
  const uy = dirY / mag;

  // 2. one-pad cap — reject if any active drone shares this origin
  for (const d of world.drones) {
    if (d.fromIslandId === origin.id && (d.status === 'active' || d.status === undefined)) {
      return { ok: false, reason: 'already-in-flight' };
    }
  }

  const isPathDrawn = waypoints !== undefined && waypoints.length >= 2;
  // §11.5: drone tier resolution. Path-drawn always = T5 (it's the T5
  // mechanic). Otherwise honor the player's selectedTier when it's ≤ the
  // island's current tier; fall back to the island tier when omitted or
  // out of range.
  const islandTier = tierForLevel(origin.level);
  let resolvedTier: DroneTier;
  if (isPathDrawn) {
    resolvedTier = 5;
  } else if (selectedTier !== undefined && selectedTier >= 1 && selectedTier <= islandTier) {
    resolvedTier = selectedTier;
  } else {
    resolvedTier = islandTier;
  }

  // 3. fuel — §11.7 tier-matched grade only, NO fallback to lower grades.
  //    The player chose this drone tier explicitly via the picker, so the
  //    fuel resource follows the chosen tier (a T1 drone needs biofuel even
  //    if launched from a T5 island).
  const fuelResource: ResourceId = fuelForTier(resolvedTier);
  if (inv(origin, fuelResource) < fuelLoaded || fuelLoaded <= 0) {
    return { ok: false, reason: 'insufficient-fuel' };
  }

  // Transport skill: droneFuelEfficiency scales tiles-per-fuel-unit. A higher
  // multiplier means the same fuelLoaded covers more distance; fuel cost is
  // unchanged so the player still pays the requested amount (the range gain
  // is the bonus). Robotics skill: droneScanRadius widens the per-step scan
  // footprint so each drone reveals more of the unknown map per round-trip.
  const originSkill = effectiveSkillMultipliers(origin);
  const fuelEffMul = originSkill.droneFuelEfficiency;
  const efficiency = (isPathDrawn ? DRONE_T5_EFFICIENCY : DRONE_TIER_EFFICIENCY) * fuelEffMul;
  const speed = isPathDrawn ? DRONE_T5_SPEED_TILES_PER_SEC : DRONE_SPEED_TILES_PER_SEC;
  const scanRadius = (isPathDrawn ? DRONE_T5_SCAN_RADIUS_TILES : DRONE_SCAN_RADIUS_TILES) * originSkill.droneScanRadius;
  const tier: DroneTier = resolvedTier;

  let outboundTiles: number;
  let travelSec: number;

  if (isPathDrawn) {
    // Path-drawn: total path length is sum of segment lengths. Drone travels
    // out along the path, then back along the reverse path.
    let totalPathLength = 0;
    for (let i = 0; i < waypoints.length - 1; i++) {
      const a = waypoints[i]!;
      const b = waypoints[i + 1]!;
      totalPathLength += Math.sqrt((b.x - a.x) ** 2 + (b.y - a.y) ** 2);
    }
    // Range check: total round-trip = 2 × totalPathLength
    if (totalPathLength * 2 > fuelLoaded * efficiency) {
      return { ok: false, reason: 'path-too-long' };
    }
    outboundTiles = totalPathLength;
    travelSec = (totalPathLength * 2) / speed;
  } else {
    // Straight-line: range = fuel × efficiency, outbound = half.
    const rangeTiles = fuelLoaded * efficiency;
    outboundTiles = rangeTiles / 2;
    travelSec = rangeTiles / speed;
  }

  const expectedReturnTime = nowMs + travelSec * 1000;

  origin.inventory[fuelResource] = inv(origin, fuelResource) - fuelLoaded;

  const drone: Drone = {
    id: nextDroneId(),
    fromIslandId: origin.id,
    originX,
    originY,
    dirX: ux,
    dirY: uy,
    outboundTiles,
    scanRadius,
    launchTime: nowMs,
    expectedReturnTime,
    tier,
    fuelLoaded,
    fuelResource,
    status: 'active',
    waypoints: waypoints ?? [],
    darkMode: false,
    darkModeDiscoveries: [],
    probabilityBias: probabilityBiasForIsland(origin),
  };
  world.drones.push(drone);
  return { ok: true, drone };
}

/** Result of a tick — drones that returned this frame, ids of any islands
 *  that flipped to `discovered` (because some cell of theirs got revealed
 *  on this tick), and the count of newly-revealed cells. The renderer uses
 *  the per-tick deltas to know when to rebuild the ocean / island layers. */
export interface TickDronesResult {
  returned: Drone[];
  lost: Drone[];
  newlyDiscoveredIslandIds: string[];
  /** Number of cells added to `world.revealedCells` this tick. */
  revealedCellsAdded: number;
}

/**
 * Advance the drone fleet to `nowMs`.
 *
 * Per-tick corridor reveal (§11 telemetry redesign):
 *   1. For each in-flight drone, compute its previous-tick position and
 *      current-tick position via `droneCurrentPosition`.
 *   2. Enumerate the cells under the capsule corridor from prev → curr
 *      (`corridorCells` with the drone's `scanRadius`).
 *   3. For each such cell, if the cell center sits inside ANY current
 *      Antenna signal range, add the cell key to `world.revealedCells`.
 *      Out-of-range cells are dropped — there is no onboard buffer.
 *   4. Drones whose `expectedReturnTime` has elapsed undergo a §2.6 weather
 *      destruction roll. Destroyed drones are marked `status: 'lost'` and
 *      kept in `world.drones` for UI/history. Successful drones are marked
 *      `status: 'returned'` and also kept.
 *   5. After cell reveals, walk every island whose `discovered` is false;
 *      if any of its footprint cells is now in `revealedCells`, flip
 *      `discovered = true`. This is the new "any-cell" rule that replaces
 *      the per-return island-center-flip from the legacy implementation.
 *
 * Antenna ranges are recomputed every tick from the world's populated
 * islands' Antenna buildings — antennas can be built / demolished mid-
 * session and the range list must reflect that.
 *
 * `prevTickMs` is the wall-clock time of the previous tick (typically the
 * last frame's `now`). For brand-new drones whose launch is between
 * `prevTickMs` and `nowMs`, `droneCurrentPosition(d, prevTickMs)` clamps
 * the elapsed time to ≥ 0 and returns the launch origin — i.e. the
 * corridor of a freshly-launched drone starts at its launching island.
 */
function droneSpeed(d: Drone): number {
  return d.tier === 5 ? DRONE_T5_SPEED_TILES_PER_SEC : DRONE_SPEED_TILES_PER_SEC;
}

/** Helper: find undiscovered islands whose footprint intersects a set of cell keys. */
function islandsInCells(
  islands: ReadonlyArray<import('./world.js').IslandSpec>,
  cells: ReadonlySet<string>,
): Array<{ readonly islandId: string }> {
  const out: Array<{ readonly islandId: string }> = [];
  const seen = new Set<string>();
  for (const isl of islands) {
    if (isl.populated) continue;
    if (isl.discovered) continue;
    if (islandHasRevealedCell(isl, cells)) {
      if (!seen.has(isl.id)) {
        seen.add(isl.id);
        out.push({ islandId: isl.id });
      }
    }
  }
  return out;
}

/** §13.3 Probability Engine heuristic: an island is "rare" if it has
 *  multiple modifiers or an aetheric anomaly. */
function isRareIsland(isl: import('./world.js').IslandSpec): boolean {
  return isl.modifiers.length >= 2 || isl.modifiers.includes('aetheric_anomaly');
}

/** Discover rare islands that fall inside an expanded cell set (probability-bias
 *  corridor). Mutates `isl.discovered` and appends to `outIds`. */
function discoverRareIslands(
  islands: ReadonlyArray<import('./world.js').IslandSpec>,
  expandedCells: ReadonlySet<string>,
  outIds: string[],
): void {
  for (const isl of islands) {
    if (isl.populated) continue;
    if (isl.discovered) continue;
    if (!isRareIsland(isl)) continue;
    if (islandHasRevealedCell(isl, expandedCells)) {
      isl.discovered = true;
      outIds.push(isl.id);
    }
  }
}

export function tickDrones(
  world: WorldState,
  nowMs: number,
  prevTickMs: number = nowMs,
): TickDronesResult {
  const returned: Drone[] = [];
  const lost: Drone[] = [];
  const newlyDiscoveredIslandIds: string[] = [];
  const remaining: Drone[] = [];

  // Antenna signal ranges — recomputed every tick (antennas can be built /
  // demolished mid-session). Cheap: one allocation + a walk over populated
  // islands' buildings.
  const populated = world.islands.filter((s) => s.populated);
  const ranges = computeSignalRanges(populated);

  let cellsAddedThisTick = 0;
  for (const d of world.drones) {
    // Terminal-status drones are kept in the array for UI/history but
    // no longer participate in reveals or weather rolls.
    if (d.status === 'lost' || d.status === 'returned') {
      remaining.push(d);
      continue;
    }

    // 1) per-tick corridor reveal. The drone's path is piecewise-linear:
    //    out from origin to the outbound endpoint, then back. Compute the
    //    waypoints actually visited in [prevTickMs, nowMs] and union the
    //    corridor across each linear segment between consecutive waypoints.
    //
    //    Clamping to [launchTime, expectedReturnTime] avoids the
    //    degenerate "drone has been back at origin forever" case where
    //    both endpoints fold to origin and the corridor collapses to a
    //    point — which would silently lose reveals for the legitimate
    //    "single tick spans the whole flight" case (the cell-test goes
    //    over a one-tick flight from launch to return).
    if (d.tier === 5 || ranges.length > 0) {
      const segStartMs = Math.max(prevTickMs, d.launchTime);
      const segEndMs = Math.min(nowMs, d.expectedReturnTime);
      if (segEndMs >= segStartMs) {
        const speed = droneSpeed(d);
        const apexMs = d.launchTime + (d.outboundTiles / speed) * 1000;
        const segWaypoints: Array<{ x: number; y: number }> = [];
        segWaypoints.push(droneCurrentPosition(d, segStartMs));
        // Include the outbound-endpoint waypoint if the apex falls strictly
        // inside (segStartMs, segEndMs). On the boundary the linear segment
        // to the next endpoint subsumes it.
        if (apexMs > segStartMs && apexMs < segEndMs) {
          segWaypoints.push(droneCurrentPosition(d, apexMs));
        }
        segWaypoints.push(droneCurrentPosition(d, segEndMs));

        // Collect all corridor cells for this tick.
        const corridor = new Set<string>();
        for (let i = 0; i + 1 < segWaypoints.length; i++) {
          const a = segWaypoints[i]!;
          const b = segWaypoints[i + 1]!;
          const cells = corridorCells(a.x, a.y, b.x, b.y, d.scanRadius);
          cells.forEach((c) => corridor.add(c));
        }

        // §13.3 Probability Engine: expanded corridor for rare-island discovery.
        const expandedCorridor = new Set<string>(corridor);
        if (d.probabilityBias > 0) {
          const effectiveRadius = d.scanRadius * (1 + d.probabilityBias);
          for (let i = 0; i + 1 < segWaypoints.length; i++) {
            const a = segWaypoints[i]!;
            const b = segWaypoints[i + 1]!;
            const cells = corridorCells(a.x, a.y, b.x, b.y, effectiveRadius);
            cells.forEach((c) => expandedCorridor.add(c));
          }
        }

        if (d.tier === 5) {
          // §11.6 dark-mode telemetry: check drone position at segEndMs.
          const dronePos = droneCurrentPosition(d, segEndMs);
          const inSignalRange = pointInSignalRange(ranges, dronePos.x, dronePos.y);

          if (inSignalRange) {
            d.darkMode = false;
            // Flush buffered discoveries.
            for (const disc of d.darkModeDiscoveries) {
              const isl = world.islands.find((i) => i.id === disc.islandId);
              if (isl && !isl.discovered && !isl.populated) {
                isl.discovered = true;
                newlyDiscoveredIslandIds.push(isl.id);
              }
            }
            d.darkModeDiscoveries = [];
          } else {
            d.darkMode = true;
            // Buffer island discoveries instead of revealing cells.
            // Use expanded corridor so Probability Engine biases toward rare islands.
            const discoveries = islandsInCells(world.islands, expandedCorridor);
            const seen = new Set<string>(d.darkModeDiscoveries.map((x) => x.islandId));
            for (const disc of discoveries) {
              if (!seen.has(disc.islandId)) {
                seen.add(disc.islandId);
                d.darkModeDiscoveries.push(disc);
              }
            }
          }
          // Per-cell antenna range check for reveals (T1–T5 all use the same rule).
          for (const k of corridor) {
            if (world.revealedCells.has(k)) continue;
            const { cellX, cellY } = parseCellKey(k);
            const center = cellCenterTile(cellX, cellY);
            if (pointInSignalRange(ranges, center.x, center.y)) {
              world.revealedCells.add(k);
              cellsAddedThisTick++;
            }
          }
          // Probability-bias discovery of rare islands in expanded corridor.
          discoverRareIslands(world.islands, expandedCorridor, newlyDiscoveredIslandIds);
        } else {
          // Legacy straight-line (T1-T4/T6) per-cell antenna range check.
          for (const k of corridor) {
            if (world.revealedCells.has(k)) continue;
            const { cellX, cellY } = parseCellKey(k);
            const center = cellCenterTile(cellX, cellY);
            if (pointInSignalRange(ranges, center.x, center.y)) {
              world.revealedCells.add(k);
              cellsAddedThisTick++;
            }
          }
          // Probability-bias discovery of rare islands in expanded corridor.
          discoverRareIslands(world.islands, expandedCorridor, newlyDiscoveredIslandIds);
        }
      }
    }

    // 2) Weather destruction on return. The return decision is decoupled
    //    from reveals — a returned drone has already had its full flight
    //    scanned above (the segStartMs..segEndMs clamp covers the entire
    //    trajectory if the tick spans the flight).
    if (nowMs < d.expectedReturnTime) {
      remaining.push(d);
      continue;
    }

    // §2.6 weather destruction roll — outbound + return legs.
    const speed = droneSpeed(d);
    let path: Array<{ cx: number; cy: number; entryMs: number }>;
    if (d.waypoints.length >= 2) {
      // T5 path-drawn: rasterize the waypoint polyline.
      path = rasterizeWaypointPathForWeather(d.waypoints, speed, d.launchTime, CELL_SIZE_TILES);
    } else {
      const outboundPath = rasterizePath(
        d.originX,
        d.originY,
        d.dirX,
        d.dirY,
        d.outboundTiles,
        speed,
        d.launchTime,
        CELL_SIZE_TILES,
      );
      const apexTime = d.launchTime + (d.outboundTiles / speed) * 1000;
      const apexX = d.originX + d.dirX * d.outboundTiles;
      const apexY = d.originY + d.dirY * d.outboundTiles;
      const returnPath = rasterizePath(
        apexX,
        apexY,
        -d.dirX,
        -d.dirY,
        d.outboundTiles,
        speed,
        apexTime,
        CELL_SIZE_TILES,
      );
      // Concatenate outbound + return legs. Dedup only exact (cell, time)
      // duplicates so both legs are evaluated by rollVehicleDestruction.
      const seen = new Set<string>();
      path = [];
      for (const p of [...outboundPath, ...returnPath]) {
        const key = `${p.cx},${p.cy},${p.entryMs}`;
        if (seen.has(key)) continue;
        seen.add(key);
        path.push(p);
      }
    }
    const multiplier = DRONE_TIER_MULTIPLIERS[d.tier];
    const roll = rollVehicleDestruction(world.seed, path, multiplier, d.id);

    if (roll.destroyed) {
      d.status = 'lost';
      lost.push(d);
      // Discard dark-mode discoveries on destruction.
      d.darkModeDiscoveries = [];
      remaining.push(d);
      continue;
    }

    d.status = 'returned';
    returned.push(d);
    // Flush dark-mode discoveries on successful return.
    for (const disc of d.darkModeDiscoveries) {
      const isl = world.islands.find((i) => i.id === disc.islandId);
      if (isl && !isl.discovered && !isl.populated) {
        isl.discovered = true;
        newlyDiscoveredIslandIds.push(isl.id);
      }
    }
    d.darkModeDiscoveries = [];
    remaining.push(d);
  }

  // 3) Walk undiscovered islands; any-cell rule flips `discovered`.
  if (cellsAddedThisTick > 0) {
    for (const isl of world.islands) {
      if (isl.populated) continue;
      if (isl.discovered) continue;
      if (islandHasRevealedCell(isl, world.revealedCells)) {
        isl.discovered = true;
        newlyDiscoveredIslandIds.push(isl.id);
      }
    }
  }

  // Replace world.drones contents in-place so external references stay valid.
  world.drones.length = 0;
  for (const d of remaining) world.drones.push(d);

  return {
    returned,
    lost,
    newlyDiscoveredIslandIds,
    revealedCellsAdded: cellsAddedThisTick,
  };
}

/** Whether any cell touched by `spec`'s footprint sits in `revealedCells`.
 *  Delegates to `islandCells` (discovery.ts) for footprint enumeration —
 *  walks every constituent (primary + extraEllipses) so merged islands
 *  flip discovered the moment any one of their absorbed lobes is touched.
 *  Pure. */
function islandHasRevealedCell(
  spec: import('./world.js').IslandSpec,
  revealedCells: ReadonlySet<string>,
): boolean {
  for (const k of islandCells(spec)) {
    if (revealedCells.has(k)) return true;
  }
  return false;
}

/**
 * Current world-tile position of a drone given the wall-clock time. Used by
 * the renderer to draw the moving cyan dot.
 *
 * The flight is a straight line out then back. Distance travelled along
 * the path (one-way) at time `t` past launch is `speed × elapsedSec`
 * clamped into `[0, 2 × outboundTiles]`. Position = origin + dir × (path
 * distance, folded so the second half retreats back toward origin).
 *
 * If the drone is already past its return time, position folds back to
 * origin (caller should remove the drone before this point — used as a
 * safety value).
 */
export function droneCurrentPosition(d: Drone, nowMs: number): { x: number; y: number } {
  const elapsedSec = Math.max(0, (nowMs - d.launchTime) / 1000);
  const speed = droneSpeed(d);
  const travelled = elapsedSec * speed;
  const total = 2 * d.outboundTiles;
  const clamped = Math.min(travelled, total);

  if (d.waypoints.length >= 2) {
    // T5 path-drawn: travel along waypoints outbound, then reverse inbound.
    if (clamped <= d.outboundTiles) {
      return positionAlongPolyline(d.waypoints, clamped);
    } else {
      const returnDist = clamped - d.outboundTiles;
      return positionAlongPolyline([...d.waypoints].reverse(), returnDist);
    }
  }

  // Straight-line behavior (T1-T4).
  const along = clamped <= d.outboundTiles ? clamped : total - clamped;
  return {
    x: d.originX + d.dirX * along,
    y: d.originY + d.dirY * along,
  };
}

function positionAlongPolyline(
  waypoints: ReadonlyArray<{ x: number; y: number }>,
  distance: number,
): { x: number; y: number } {
  let remaining = distance;
  for (let i = 0; i < waypoints.length - 1; i++) {
    const a = waypoints[i]!;
    const b = waypoints[i + 1]!;
    const segLen = Math.sqrt((b.x - a.x) ** 2 + (b.y - a.y) ** 2);
    if (remaining <= segLen + 1e-9) {
      const t = segLen === 0 ? 0 : remaining / segLen;
      return { x: a.x + t * (b.x - a.x), y: a.y + t * (b.y - a.y) };
    }
    remaining -= segLen;
  }
  const last = waypoints[waypoints.length - 1]!;
  return { x: last.x, y: last.y };
}
