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

import { computeSignalRanges, pointInSignalRange, type SignalRange } from './antenna.js';
import { hasOperationalBuilding, isOperationalBuilding } from './building-operational.js';
import { corridorCells, islandIntersectsCells, markIslandDiscovered, parseCellKey } from './discovery.js';
import { BUILDING_DEFS } from './building-defs.js';
import type { IslandState } from './economy.js';
import { inv } from './economy.js';
import { activeFloors } from './floor-levels.js';
import { shapeHeight, shapeWidth } from './shape-mask.js';
import { fuelForTier, type ResourceId } from './recipes.js';

import { effectiveSkillMultipliers, tierForLevel } from './skilltree.js';
import { visibleCellsFromVision } from './vision-source.js';
import { biomeForCell, rasterizePath, rollVehicleDestruction, sumIslandCo2 } from './weather.js';
import { CELL_SIZE_TILES, ensureCellGenerated } from './world.js';
import type { WorldState } from './world.js';

/** Drone tier per §11.5. Drone Pad (T2) is the gate to launch any drone;
 *  once built, the Drone Ops tier picker lets the player pick any tier from
 *  T1 up to the launching island's current tier (T1 = biofuel = cheap entry
 *  option for short scouts). Higher tiers cost richer fuel grades but fly
 *  farther and are more weather-rugged. */
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
   *  weather roll destroyed it; `returned` after a successful round-trip landing;
   *  `stranded` for a one-way path-drawn drone that survived to its terminus. */
  status?: 'active' | 'lost' | 'returned' | 'stranded';
  /** For T5 path-drawn drones: sequence of waypoints. Empty for straight-line drones. */
  readonly waypoints: ReadonlyArray<{ readonly x: number; readonly y: number }>;
  /** Accumulated discoveries while out of antenna range (dark mode). */
  darkModeDiscoveries: Array<{ readonly islandId: string }>;
  /** Cell-reveal buffer (mirror of darkModeDiscoveries for cells). Every
   *  corridor cell the drone scans joins this Set unconditionally on every
   *  tick; the flush step in advanceDrones drains it into world.revealedCells
   *  when the drone enters any antenna's range OR when status reaches
   *  'returned'. Drone destroyed in dark ('lost'): buffer GC'd with the drone. */
  readonly scanBuffer: Set<string>;
  /** §13.3 Probability Engine bias stored at dispatch time. */
  readonly probabilityBias: number;
  /** §Fix 6.3 §2.6 deterministic fate: the perf-clock ms of the weather-cell
   *  entry that will destroy this drone, pre-computed at dispatch time.
   *  `undefined` means the drone survives. The tick loop clamps `segEndMs` to
   *  this value so a doomed drone never live-reveals cells past its death cell.
   *  At return time the tick uses this stored fate instead of re-rolling the
   *  same RNG stream. Old saves (field absent) fall back to the return-time
   *  roll (pre-fix behaviour). */
  readonly doomedAtMs?: number;
}

/** Shared terminal-status predicate. Drone UI and tick logic both need to
 *  treat `lost`, `returned`, and `stranded` drones as finished flights. */
export function isTerminalDroneStatus(status: Drone['status']): boolean {
  return status === 'lost' || status === 'returned' || status === 'stranded';
}

/** Drone fuel efficiency — round-trip tiles per unit of fuel, per drone
 *  tier. Tiered ramp (base 3, +3 per tier): a drone's reach scales with
 *  its tier, and a light scout drone out-ranges ship/helicopter per fuel.
 *  e.g. a T1 drone: 10 biofuel → 30 tiles round-trip → 15 tiles outbound. */
export const DRONE_TIER_EFFICIENCY: Record<DroneTier, number> = {
  1: 3, 2: 6, 3: 9, 4: 12, 5: 15, 6: 18,
};
export const DRONE_SPEED_TILES_PER_SEC = 0.5; // idle-game scale
// §11.5 per-tier scan corridor half-width in tiles. T4 is the omni-pulse
// (uses T4_PULSE_RADIUS_TILES below, not a corridor) — slot is 0 / unused.
// Doubles T1 → T3 per spec ("2W" ratio); T6 = 16 (design-spec locked).
export const DRONE_TIER_SCAN_RADIUS: Record<DroneTier, number> = {
  1: 2,
  2: 4,
  3: 8,
  4: 0,
  5: 12,
  6: 16,
};

// Alias preserved so existing T5 tests' import stays green.
export const DRONE_T5_SCAN_RADIUS_TILES = DRONE_TIER_SCAN_RADIUS[5];

/** §11.5 effective drone scan-corridor half-width (tiles) for a launch from
 *  `state` at `tier`: the per-tier base radius scaled by the island's Robotics
 *  `droneScanRadius` skill multiplier. Single source of truth shared by
 *  `dispatchDrone` and the path-mode preview overlay so the green corridor a
 *  player sees can't drift from the area the drone actually reveals. */
export function effectiveDroneScanRadius(state: IslandState, tier: DroneTier): number {
  return DRONE_TIER_SCAN_RADIUS[tier] * effectiveSkillMultipliers(state).droneScanRadius;
}

/** Path-mode flight speed (tier-independent). Path-drawn drones fly faster
 *  than straight-line drones because they do not reserve fuel/battery for a
 *  return leg; the speed is the same regardless of which tier is selected. */
export const DRONE_T5_SPEED_TILES_PER_SEC = 0.8;
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

/** §11.5 T4 omnidirectional pulse: reveals every undiscovered island the
 *  `T4_PULSE_RADIUS_TILES` disk centred on `origin` OVERLAPS, in a single
 *  instant (any-cell overlap, matching corridor discovery — not a centre
 *  test, so islands straddling the disk edge are found).
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
  if (!hasOperationalBuilding(origin.buildings, 'launch_tower')) {
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
  // Reveal every undiscovered island the disk OVERLAPS — not merely those
  // whose centre lies inside it. The pulse is a "disk scan" that covers a
  // 3-cell-radius disk (§11.5), so an island straddling the disk edge is
  // covered over part of its area and must be found. Reuse the same any-cell
  // predicate the normal drone scan uses (`islandIntersectsCells`), fed the
  // set of cells the disk covers — pulse and corridor discovery share one
  // overlap rule.
  const pulseCells = visibleCellsFromVision([
    { kind: 'circle', cx: originSpec.cx, cy: originSpec.cy, radius: T4_PULSE_RADIUS_TILES },
  ]);
  const discovered: string[] = [];
  for (const isl of world.islands) {
    if (isl.discovered) continue;
    if (islandIntersectsCells(isl, pulseCells)) {
      markIslandDiscovered(isl, world.revealedCells);
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

/** §13.3 Probability Engine — compute the rare-island scan bias for an island.
 *  Only OPERATIONAL buildings count — under-construction, invalid, or fully
 *  floor-disabled Probability Engines grant no bias. */
export function probabilityBiasForIsland(state: { buildings: ReadonlyArray<{ defId: string; invalid?: boolean; constructionRemainingMs?: number; floorLevel?: number; disabledFloors?: number }> }): number {
  const engineCount = state.buildings.filter(
    (b) => b.defId === 'probability_engine' && isOperationalBuilding(b),
  ).length;
  if (engineCount === 0) return 0;
  if (engineCount === 1) return 0.25;
  if (engineCount === 2) return 0.40;
  if (engineCount === 3) return 0.50;
  return 0.60;
}

/** Rasterize a polyline path for weather destruction rolls.
 *  Path-drawn flights are one-way, so this samples the OUTBOUND polyline only
 *  — the dispatch-time fate and the legacy return-time fallback must see the
 *  same cell/time sequence. */
function rasterizeWaypointPathForWeather(
  waypoints: ReadonlyArray<{ x: number; y: number }>,
  speedTilesPerSec: number,
  launchTimeMs: number,
  cellSizeTiles: number,
): Array<{ cx: number; cy: number; entryMs: number }> {
  const result: Array<{ cx: number; cy: number; entryMs: number }> = [];
  let elapsedMs = 0;
  // Outbound only: path-drawn drones do not retrace their route.
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
  return result;
}


/** Build the §2.6 weather-roll path for a drone flight: the T5 waypoint
 *  polyline (outbound only — path-drawn flights are one-way) when `waypoints`
 *  has ≥ 2 points, otherwise the straight-line outbound + return legs
 *  concatenated with exact (cell, time) dedup so both legs are evaluated by
 *  `rollVehicleDestruction`.
 *
 *  Shared by the dispatch-time fate roll and the return-time legacy
 *  fallback (old saves without `doomedAtMs`): the destruction RNG stream
 *  is keyed off this exact cell/time sequence, so the two call sites MUST
 *  stay in lockstep — one helper, not two copies. */
function buildWeatherPath(
  originX: number,
  originY: number,
  dirX: number,
  dirY: number,
  outboundTiles: number,
  speed: number,
  launchTimeMs: number,
  waypoints?: ReadonlyArray<{ x: number; y: number }>,
): Array<{ cx: number; cy: number; entryMs: number }> {
  if (waypoints !== undefined && waypoints.length >= 2) {
    return rasterizeWaypointPathForWeather(waypoints, speed, launchTimeMs, CELL_SIZE_TILES);
  }
  const outPath = rasterizePath(originX, originY, dirX, dirY, outboundTiles, speed, launchTimeMs, CELL_SIZE_TILES);
  const apexTime = launchTimeMs + (outboundTiles / speed) * 1000;
  const apexX = originX + dirX * outboundTiles;
  const apexY = originY + dirY * outboundTiles;
  const retPath = rasterizePath(apexX, apexY, -dirX, -dirY, outboundTiles, speed, apexTime, CELL_SIZE_TILES);
  const seen = new Set<string>();
  const path: Array<{ cx: number; cy: number; entryMs: number }> = [];
  for (const p of [...outPath, ...retPath]) {
    const key = `${p.cx},${p.cy},${p.entryMs}`;
    if (seen.has(key)) continue;
    seen.add(key);
    path.push(p);
  }
  return path;
}

/**
 * Launch a drone from `origin`. Mutates `world.drones` and `origin.inventory`.
 *
 * Validation (in this order — test cases assert each rejection separately):
 *   1. Direction vector magnitude > 0 (post-normalisation length 1).
 *   2. The launching pad must have a free slot: its in-flight drone count must
 *      be below its active-floor cap (§4.9 — displayed floor N ⇒ N concurrent
 *      drones; a fresh floor-1 pad keeps the legacy 1-drone cap).
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
  /** Player-selected drone tier. The Drone Ops UI exposes a picker capped at
   *  the island's current tier; the picker passes that selection in here so a
   *  high-tier island can fly a cheap lower-tier drone for short hops. Defaults
   *  to the island tier when undefined. Path-drawn flights honor the selected
   *  tier for fuel grade/efficiency/scan radius; mode (one-way vs round-trip)
   *  is inferred from the presence of waypoints. */
  selectedTier?: DroneTier,
  /** §15.1 wall-clock anchor for weather sampling. The client passes
   *  `Date.now() - performance.now()` so perf-domain `nowMs` is shifted
   *  to wall time; the server already uses wall-epoch timestamps and
   *  passes 0. Defaults to 0 for tests / legacy callers. */
  wallOffsetMs: number = 0,
): DispatchResult {
  // 1. direction
  const mag = Math.sqrt(dirX * dirX + dirY * dirY);
  if (mag <= 0) return { ok: false, reason: 'invalid-direction' };
  const ux = dirX / mag;
  const uy = dirY / mag;

  // 2. per-pad cap — a drone pad may have up to its ACTIVE-FLOOR count of drones
  //    in flight at once (§4.9 floor scaling: displayed floor N ⇒ N concurrent
  //    drones; a fresh floor-1 pad keeps the legacy 1-drone cap). The launch
  //    origin is the pad's footprint CENTRE (§11.1), so resolve the pad whose
  //    centre matches `(originX, originY)` — cx/cy from the island SPEC,
  //    building list from the IslandState (the same list the launch UI reads).
  //    Default cap 1 when no pad resolves (legacy / island-centre launches).
  const PAD_MATCH_EPS = 0.5;
  const originSpec = world.islands.find((i) => i.id === origin.id);
  let padCap = 1;
  if (originSpec) {
    for (const b of origin.buildings) {
      if (b.defId !== 'dronepad') continue;
      const def = BUILDING_DEFS[b.defId];
      const padCx = originSpec.cx + b.x + (shapeWidth(def.footprint) - 1) / 2;
      const padCy = originSpec.cy + b.y + (shapeHeight(def.footprint) - 1) / 2;
      if (Math.abs(padCx - originX) < PAD_MATCH_EPS && Math.abs(padCy - originY) < PAD_MATCH_EPS) {
        padCap = Math.max(1, activeFloors(b));
        break;
      }
    }
  }
  let inFlightFromPad = 0;
  for (const d of world.drones) {
    if (d.fromIslandId !== origin.id) continue;
    if (d.status !== 'active' && d.status !== undefined) continue;
    if (Math.abs(d.originX - originX) < PAD_MATCH_EPS &&
        Math.abs(d.originY - originY) < PAD_MATCH_EPS) {
      inFlightFromPad += 1;
    }
  }
  if (inFlightFromPad >= padCap) {
    return { ok: false, reason: 'already-in-flight' };
  }

  const isPathDrawn = waypoints !== undefined && waypoints.length >= 2;
  // §11.5: drone tier resolution. Honor the player's selectedTier when it's
  // within the island's current tier; fall back to the island tier when
  // omitted or out of range. Path-drawn flights use the same resolution —
  // the mode (one-way) is inferred from waypoints, not from the tier.
  const islandTier = tierForLevel(origin.level);
  const resolvedTier: DroneTier =
    selectedTier !== undefined && selectedTier >= 1 && selectedTier <= islandTier
      ? selectedTier
      : islandTier;

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
  const efficiency = DRONE_TIER_EFFICIENCY[resolvedTier] * fuelEffMul;
  const speed = isPathDrawn ? DRONE_T5_SPEED_TILES_PER_SEC : DRONE_SPEED_TILES_PER_SEC;
  const scanRadius = effectiveDroneScanRadius(origin, resolvedTier);
  const tier: DroneTier = resolvedTier;

  let outboundTiles: number;
  let travelSec: number;

  if (isPathDrawn) {
    // Path-drawn flights are ONE-WAY: the drone flies the drawn path and
    // ends at the terminus. Range is the full drawn length, not half a
    // round-trip; travel time has no return leg.
    let totalPathLength = 0;
    for (let i = 0; i < waypoints.length - 1; i++) {
      const a = waypoints[i]!;
      const b = waypoints[i + 1]!;
      totalPathLength += Math.sqrt((b.x - a.x) ** 2 + (b.y - a.y) ** 2);
    }
    if (totalPathLength > fuelLoaded * efficiency) {
      return { ok: false, reason: 'path-too-long' };
    }
    outboundTiles = totalPathLength;
    travelSec = totalPathLength / speed;
  } else {
    // Straight-line: range = fuel × efficiency, outbound = half.
    const rangeTiles = fuelLoaded * efficiency;
    outboundTiles = rangeTiles / 2;
    travelSec = rangeTiles / speed;
  }

  const expectedReturnTime = nowMs + travelSec * 1000;

  origin.inventory[fuelResource] = inv(origin, fuelResource) - fuelLoaded;

  // §Fix 6.3 §2.6: pre-compute the deterministic weather-destruction fate at
  // dispatch time. This ensures a drone doomed to die at cell N never
  // live-reveals cells past N during per-tick scanning (the tick loop clamps
  // segEndMs to doomedAtMs). The same RNG stream is used here as was used
  // historically at return time — identical outcome. Old saves lack this field;
  // the tick loop falls back to the return-time roll when `doomedAtMs` is
  // `undefined`.
  const droneId = nextDroneId();
  const multiplier = DRONE_TIER_MULTIPLIERS[tier];
  let doomedAtMs: number | undefined;
  {
    const dispatchPath = buildWeatherPath(originX, originY, ux, uy, outboundTiles, speed, nowMs, waypoints);
    // §15.1: weather samples are wall-anchored via the module anchor; the
    // path's entryMs stay perf-domain so doomedAtMs remains comparable to
    // the tick loop's perf-domain segEndMs clamp. §7.3: biome + CO₂ make
    // the sampled field coherent with every other weather consumer.
    const roll = rollVehicleDestruction(
      world.seed, dispatchPath, multiplier, droneId, wallOffsetMs,
      (cx, cy) => biomeForCell(world, cx, cy), sumIslandCo2(world),
    );
    if (roll.destroyed && roll.atCellIndex !== null) {
      doomedAtMs = dispatchPath[roll.atCellIndex]!.entryMs;
    }
  }

  // Spawn coords: caller is source of truth. The engine trusts originX/originY
  // without further resolution — the dispatch UI already validated the pad
  // and computed the launch position before invoking dispatchDrone.
  const drone: Drone = {
    id: droneId,
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
    darkModeDiscoveries: [],
    scanBuffer: new Set<string>(),
    probabilityBias: probabilityBiasForIsland(origin),
    doomedAtMs,
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
  /** One-way path-drawn drones that survived to their terminus. */
  stranded: Drone[];
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
 *      destruction roll. Destroyed drones are marked `status: 'lost'`. Straight-
 *      line survivors are marked `status: 'returned'`. Path-drawn (one-way)
 *      survivors are marked `status: 'stranded'` at their terminus; their buffered
 *      telemetry is flushed only if the terminus is inside an Antenna signal range,
 *      otherwise it is forfeited. Terminal drones are kept in `world.drones` for
 *      UI/history.
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
  // Speed is mode-based, not tier-based: path-drawn (one-way) flights use the
  // faster path speed; straight-line round-trip flights use the simple speed.
  return d.waypoints.length >= 2 ? DRONE_T5_SPEED_TILES_PER_SEC : DRONE_SPEED_TILES_PER_SEC;
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
    if (islandIntersectsCells(isl, cells)) {
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

/** Detect (do NOT reveal) rare islands that fall inside an expanded cell set
 *  (the §13.3 probability-bias corridor). Returns dark-mode discovery records
 *  for the matching undiscovered, unpopulated rare islands. The §13.3
 *  Probability Engine only *widens the detection corridor*; per §11 the reveal
 *  is buffered and committed later by `flushDroneBuffers` (and forfeited on
 *  loss / out-of-range stranding) exactly like every other discovery. */
function rareIslandsInCells(
  islands: ReadonlyArray<import('./world.js').IslandSpec>,
  expandedCells: ReadonlySet<string>,
): Array<{ readonly islandId: string }> {
  const out: Array<{ readonly islandId: string }> = [];
  for (const isl of islands) {
    if (isl.populated) continue;
    if (isl.discovered) continue;
    if (!isRareIsland(isl)) continue;
    if (islandIntersectsCells(isl, expandedCells)) {
      out.push({ islandId: isl.id });
    }
  }
  return out;
}

/** Drain a drone's scanBuffer + darkModeDiscoveries into world state.
 *  Clears both buffers in place; safe to call repeatedly per tick. Called
 *  when the drone enters antenna range OR reaches 'returned' status. */
function flushDroneBuffers(
  d: Drone,
  world: WorldState,
  newlyDiscoveredIslandIds: string[],
): number {
  let cellsAdded = 0;
  for (const k of d.scanBuffer) {
    if (world.revealedCells.has(k)) continue;
    world.revealedCells.add(k);
    cellsAdded++;
  }
  d.scanBuffer.clear();
  for (const disc of d.darkModeDiscoveries) {
    const isl = world.islands.find((i) => i.id === disc.islandId);
    if (isl && !isl.discovered && !isl.populated) {
      markIslandDiscovered(isl, world.revealedCells);
      newlyDiscoveredIslandIds.push(isl.id);
    }
  }
  d.darkModeDiscoveries = [];
  return cellsAdded;
}

export function tickDrones(
  world: WorldState,
  nowMs: number,
  prevTickMs: number = nowMs,
  wallOffsetMs: number = 0,
  /** PERF: optional precomputed antenna signal ranges. A caller that advances
   *  many bounded steps in a loop (server/client catch-up via
   *  `advanceWorldSystems`) sees ranges that are static across steps except when
   *  island topology changes (a merge, or a vehicle settling a new island). Such
   *  a caller computes the ranges once, recomputes only at those topology
   *  changes, and passes them in here — turning a per-step O(buildings) recompute
   *  (a CPU profile showed it was ~10% of offline-catch-up CPU) into one compute
   *  per topology change. Omitted (the client per-frame path) ⇒ computed
   *  internally, exactly as before. Passing the same ranges this function would
   *  itself compute is byte-identical. */
  precomputedRanges?: ReadonlyArray<SignalRange>,
): TickDronesResult {
  const returned: Drone[] = [];
  const lost: Drone[] = [];
  const stranded: Drone[] = [];
  const newlyDiscoveredIslandIds: string[] = [];
  const remaining: Drone[] = [];

  // Antenna signal ranges — recomputed every tick (antennas can be built /
  // demolished mid-session) UNLESS a loop caller supplies precomputed ranges
  // (see the param doc). Cheap: one allocation + a walk over populated islands'
  // buildings.
  const ranges = precomputedRanges ?? computeSignalRanges(world.islands.filter((s) => s.populated));

  let cellsAddedThisTick = 0;
  for (const d of world.drones) {
    // Terminal-status drones are kept in the array for UI/history but
    // no longer participate in reveals or weather rolls.
    if (isTerminalDroneStatus(d.status)) {
      remaining.push(d);
      continue;
    }

    // 1) per-tick corridor reveal. The drone's path is piecewise-linear:
    //    straight-line drones go out to the outbound endpoint then back;
    //    path-drawn drones go one-way along their waypoints. Compute the
    //    waypoints actually visited in [prevTickMs, nowMs] and union the
    //    corridor across each linear segment between consecutive waypoints.
    //
    //    Clamping to [launchTime, expectedReturnTime] avoids the
    //    degenerate "drone has already arrived" case where both endpoints
    //    fold to the terminus/origin and the corridor collapses to a point.
    const segStartMs = Math.max(prevTickMs, d.launchTime);
    // §Fix 6.3: clamp segEndMs to doomedAtMs so a drone fated to be destroyed
    // never live-reveals cells past its destruction point. If doomedAtMs is
    // undefined (old save or surviving drone), fall through to expectedReturnTime.
    const segEndMs = Math.min(
      nowMs,
      d.doomedAtMs !== undefined ? d.doomedAtMs : d.expectedReturnTime,
    );
    if (segEndMs >= segStartMs) {
      const speed = droneSpeed(d);
      const apexMs = d.launchTime + (d.outboundTiles / speed) * 1000;
      const segWaypoints: Array<{ x: number; y: number }> = [];
      segWaypoints.push(droneCurrentPosition(d, segStartMs));

      if (d.waypoints.length >= 2) {
        // Fix 6.2: T5 path-drawn — insert every waypoint-crossing time that
        // falls strictly inside (segStartMs, segEndMs). One-way flights visit
        // waypoints in order only; there is no return leg.
        const wps = d.waypoints;
        let cumOutMs = 0;
        for (let i = 0; i < wps.length - 1; i++) {
          const a = wps[i]!;
          const b = wps[i + 1]!;
          const segLen = Math.sqrt((b.x - a.x) ** 2 + (b.y - a.y) ** 2);
          cumOutMs += (segLen / speed) * 1000;
          const crossingMs = d.launchTime + cumOutMs;
          if (crossingMs > segStartMs && crossingMs < segEndMs) {
            segWaypoints.push({ x: b.x, y: b.y });
          }
        }
      } else {
        // Straight-line behavior (T1-T4): include the apex if it falls inside.
        if (apexMs > segStartMs && apexMs < segEndMs) {
          segWaypoints.push(droneCurrentPosition(d, apexMs));
        }
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

      // §2.1 lazy generation: any cell the drone's corridor touches must
      // have its procedural islands minted before the antenna / rare-island
      // reads below — a newly-generated rare island in `expandedCorridor`
      // must be eligible for `rareIslandsInCells` on the very same tick.
      // Cells outside antenna range still need this hook: the drone is
      // physically crossing them, and a later visit (or another sensor)
      // must see the same deterministic island set.
      for (const k of expandedCorridor) {
        const { cellX, cellY } = parseCellKey(k);
        ensureCellGenerated(world, cellX, cellY);
      }

      // Buffer every corridor cell unconditionally. Flush happens below if the
      // drone is in any antenna range at tick end, or on return-status transition.
      for (const k of corridor) {
        d.scanBuffer.add(k);
      }

      // §13.3 Probability-bias rare-island DETECTION runs on the expanded
      // corridor, but the reveal is now buffered like every other discovery
      // (§11 dark-mode telemetry): it joins darkModeDiscoveries and is committed
      // only by flushDroneBuffers when the drone is in antenna range / recovers,
      // and is forfeited on loss or out-of-range stranding. The Probability
      // Engine widens the detection corridor only — it grants no exemption from
      // the antenna-range gate.
      const rareDiscoveries = rareIslandsInCells(world.islands, expandedCorridor);

      // Ordinary discoveries use the plain corridor — SPEC §13.3 grants the
      // rare-island bias (the expanded corridor) only.
      const tickIslandDiscoveries = islandsInCells(world.islands, corridor);
      const seenIslands = new Set<string>(d.darkModeDiscoveries.map((x) => x.islandId));
      for (const disc of [...rareDiscoveries, ...tickIslandDiscoveries]) {
        if (!seenIslands.has(disc.islandId)) {
          seenIslands.add(disc.islandId);
          d.darkModeDiscoveries.push(disc);
        }
      }

      // Flush trigger A: drone position in any antenna's range at tick end.
      const dronePos = droneCurrentPosition(d, segEndMs);
      const inSignalRange = pointInSignalRange(ranges, dronePos.x, dronePos.y);
      if (inSignalRange) {
        cellsAddedThisTick += flushDroneBuffers(d, world, newlyDiscoveredIslandIds);
      }
    }

    // 1.5) §11.4 dark-aware loss visibility. A doomed drone's fate is known
    //    deterministically at dispatch (`doomedAtMs`). The fleet list / map dot
    //    should reflect what the PLAYER can observe, not ground truth: a drone
    //    destroyed inside antenna coverage is witnessed and removed at once,
    //    while one lost in dark mode keeps showing as "flying" until its
    //    trajectory would re-enter coverage — at which point its absence makes
    //    the loss obvious. Flip to `lost` the first tick at/after `doomedAtMs`
    //    whose phantom position (interpolated along the would-be trajectory)
    //    lies in any antenna range. The `expectedReturnTime` branch below is
    //    the fallback cap when coverage never returns (no antenna at all), and
    //    old saves (no `doomedAtMs`) skip this and fall through to that roll.
    if (d.doomedAtMs !== undefined && nowMs >= d.doomedAtMs && nowMs < d.expectedReturnTime) {
      const phantom = droneCurrentPosition(d, nowMs);
      if (pointInSignalRange(ranges, phantom.x, phantom.y)) {
        d.status = 'lost';
        lost.push(d);
        // §11.6 data lost on failure: forfeit any buffered dark-mode telemetry.
        d.darkModeDiscoveries = [];
        d.scanBuffer.clear();
        remaining.push(d);
        continue;
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

    // §2.6 weather destruction roll — use pre-computed fate (doomedAtMs) when
    // available (Fix 6.3: deterministic fate set at dispatch time). Fall back
    // to a fresh roll for old saves (doomedAtMs === undefined).
    let willBeDestroyed: boolean;
    if (d.doomedAtMs !== undefined) {
      // Pre-computed fate: drone is doomed iff doomedAtMs is defined.
      willBeDestroyed = true;
    } else {
      // Legacy path: re-run the roll (identical RNG stream = identical result).
      const path = buildWeatherPath(
        d.originX, d.originY, d.dirX, d.dirY, d.outboundTiles, droneSpeed(d), d.launchTime, d.waypoints,
      );
      const multiplier = DRONE_TIER_MULTIPLIERS[d.tier];
      // §15.1 + §7.3: same wall anchor AND same biome/CO₂ field as
      // the dispatch-time roll — the two sites MUST stay in lockstep.
      const roll = rollVehicleDestruction(
        world.seed, path, multiplier, d.id, wallOffsetMs,
        (cx, cy) => biomeForCell(world, cx, cy), sumIslandCo2(world),
      );
      willBeDestroyed = roll.destroyed;
    }

    if (willBeDestroyed) {
      d.status = 'lost';
      lost.push(d);
      // Discard dark-mode discoveries on destruction.
      d.darkModeDiscoveries = [];
      d.scanBuffer.clear();
      remaining.push(d);
      continue;
    }

    if (d.waypoints.length >= 2) {
      // One-way path-drawn survivor: it ends at the terminus. Telemetry is
      // recovered only if the terminus lies inside an Antenna's signal range;
      // otherwise the buffered data is forfeited.
      const terminus = d.waypoints[d.waypoints.length - 1]!;
      if (pointInSignalRange(ranges, terminus.x, terminus.y)) {
        cellsAddedThisTick += flushDroneBuffers(d, world, newlyDiscoveredIslandIds);
      } else {
        d.scanBuffer.clear();
        d.darkModeDiscoveries = [];
      }
      d.status = 'stranded';
      stranded.push(d);
    } else {
      // Straight-line survivor: drains everything on return regardless of
      // current antenna range. This is the "survives the trip → reports
      // everything" guarantee per SPEC §11.6 telemetry rule.
      cellsAddedThisTick += flushDroneBuffers(d, world, newlyDiscoveredIslandIds);
      d.status = 'returned';
      returned.push(d);
    }
    remaining.push(d);
  }

  // 3) Walk undiscovered islands; any-cell rule flips `discovered`.
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

  // Replace world.drones contents in-place so external references stay valid.
  world.drones.length = 0;
  for (const d of remaining) world.drones.push(d);

  return {
    returned,
    lost,
    stranded,
    newlyDiscoveredIslandIds,
    revealedCellsAdded: cellsAddedThisTick,
  };
}


/**
 * Current world-tile position of a drone given the wall-clock time. Used by
 * the renderer to draw the moving cyan dot.
 *
 * Straight-line drones (T1-T4) fly out then back: distance travelled is
 * clamped into `[0, 2 × outboundTiles]` and folded at the apex.
 *
 * Path-drawn drones (T5, `waypoints.length >= 2`) are ONE-WAY: distance is
 * clamped into `[0, outboundTiles]` and the drone stops at the final
 * waypoint once the arrival time elapses.
 */
export function droneCurrentPosition(d: Drone, nowMs: number): { x: number; y: number } {
  const elapsedSec = Math.max(0, (nowMs - d.launchTime) / 1000);
  const speed = droneSpeed(d);
  const travelled = elapsedSec * speed;

  if (d.waypoints.length >= 2) {
    // Path-drawn: one-way along the drawn polyline.
    const clamped = Math.min(travelled, d.outboundTiles);
    return positionAlongPolyline(d.waypoints, clamped);
  }

  // Straight-line behavior: out then back.
  const total = 2 * d.outboundTiles;
  const clamped = Math.min(travelled, total);
  const along = clamped <= d.outboundTiles ? clamped : total - clamped;
  return {
    x: d.originX + d.dirX * along,
    y: d.originY + d.dirY * along,
  };
}

/** Finite-difference window for the instantaneous-heading estimate (ms). */
const HEADING_EPS_MS = 50;

/**
 * §11 — instantaneous travel heading (radians) of a drone at `nowMs`, derived
 * from the motion itself via a small backward finite difference of
 * `droneCurrentPosition`. This rotates correctly on the straight-line return
 * leg (where motion is `−dir`) and at every path-drawn waypoint bend, unlike
 * the static launch heading `(dirX, dirY)`. Falls back to the launch heading
 * when there is no motion yet (at/just after launch, or once the drone has
 * stopped at its terminus).
 */
export function droneHeadingAt(d: Drone, nowMs: number): number {
  const p1 = droneCurrentPosition(d, nowMs);
  const p0 = droneCurrentPosition(d, nowMs - HEADING_EPS_MS);
  const dx = p1.x - p0.x;
  const dy = p1.y - p0.y;
  if (dx * dx + dy * dy < 1e-12) {
    return Math.atan2(d.dirY, d.dirX);
  }
  return Math.atan2(dy, dx);
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
