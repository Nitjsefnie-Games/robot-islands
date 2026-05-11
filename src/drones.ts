// Drone fleet: pure logic for dispatch + capsule-corridor discovery (§11).
//
// No PixiJS, no DOM. The renderer in `drones-ui.ts` reads this module's state
// and draws; the economy ticker calls `tickDrones` once per frame to advance
// returns. Tests target this module directly.
//
// Step-6 scope notes (deferred bits flagged inline elsewhere):
//   - One drone class only — T2-equivalent constants. T3+ tiers, T4
//     omnidirectional pulse, T5 path-drawn, all deferred to step 9+.
//   - No weather destruction (no weather system yet — §11.4 deferred).
//   - Tier-gating on Drone Pad deferred to step 9; for step 6 the Drone Pad
//     is hardcoded on the home island like Mine/Workshop are.
//   - Fuel grade matches the launching island's tier per §11.7 — resolved at
//     dispatch via `fuelForTier(tierForLevel(origin.level))` and stored on
//     the Drone record. A T1 island launches with biofuel, a T3 island with
//     aviation kerosene, etc. No fallback to lower grades.

import { computeSignalRanges, pointInSignalRange } from './antenna.js';
import { cellCenterTile, corridorCells, parseCellKey } from './discovery.js';
import type { IslandState } from './economy.js';
import { inv } from './economy.js';
import { fuelForTier, type ResourceId } from './recipes.js';
import { tierForLevel } from './skilltree.js';
import type { WorldState } from './world.js';
import { islandConstituents, CELL_SIZE_TILES } from './world.js';

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
}

/** T2-equivalent constants for step 6. Tile units; seconds for time.
 *  10 biofuel → 40 tiles round-trip → 20 tiles outbound, ~40s flight.
 *  50 biofuel → 200 tiles round-trip → 100 tiles outbound, ~200s flight.
 *  Rebalanced for idle-game scale, step #19: speed 2 → 0.5 t/s so a
 *  50-tile drone trip takes 100s instead of 25s. */
export const DRONE_TIER_EFFICIENCY = 4;
export const DRONE_SPEED_TILES_PER_SEC = 0.5; // rebalanced for idle-game scale, step #19 (was 2)
export const DRONE_SCAN_RADIUS_TILES = 8;

/** Step-6 drone tier (single class). Drone Pad nominally T2, but the engine
 *  carries the tier as data — easy to widen when more pads come online. */
const STEP6_DRONE_TIER: DroneTier = 2;

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
  | { ok: false; reason: 'insufficient-fuel' | 'invalid-direction' | 'already-in-flight' };

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
): DispatchResult {
  // 1. direction
  const mag = Math.sqrt(dirX * dirX + dirY * dirY);
  if (mag <= 0) return { ok: false, reason: 'invalid-direction' };
  const ux = dirX / mag;
  const uy = dirY / mag;

  // 2. one-pad cap — reject if any existing drone shares this origin
  for (const d of world.drones) {
    if (d.fromIslandId === origin.id) return { ok: false, reason: 'already-in-flight' };
  }

  // 3. fuel — §11.7 tier-matched grade only, no fallback to lower grades
  const fuelResource: ResourceId = fuelForTier(tierForLevel(origin.level));
  if (inv(origin, fuelResource) < fuelLoaded || fuelLoaded <= 0) {
    return { ok: false, reason: 'insufficient-fuel' };
  }

  // Range: total round-trip in tiles. Outbound is half (straight out, straight
  // back along the same line). Travel time uses the full round-trip distance.
  const rangeTiles = fuelLoaded * DRONE_TIER_EFFICIENCY;
  const outboundTiles = rangeTiles / 2;
  const travelSec = rangeTiles / DRONE_SPEED_TILES_PER_SEC;
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
    scanRadius: DRONE_SCAN_RADIUS_TILES,
    launchTime: nowMs,
    expectedReturnTime,
    tier: STEP6_DRONE_TIER,
    fuelLoaded,
    fuelResource,
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
 *   4. Drones whose `expectedReturnTime` has elapsed are removed from
 *      `world.drones`.
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
export function tickDrones(
  world: WorldState,
  nowMs: number,
  prevTickMs: number = nowMs,
): TickDronesResult {
  const returned: Drone[] = [];
  const newlyDiscoveredIslandIds: string[] = [];
  const remaining: Drone[] = [];

  // Antenna signal ranges — recomputed every tick (antennas can be built /
  // demolished mid-session). Cheap: one allocation + a walk over populated
  // islands' buildings.
  const populated = world.islands.filter((s) => s.populated);
  const ranges = computeSignalRanges(populated);

  let cellsAddedThisTick = 0;
  for (const d of world.drones) {
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
    if (ranges.length > 0) {
      const segStartMs = Math.max(prevTickMs, d.launchTime);
      const segEndMs = Math.min(nowMs, d.expectedReturnTime);
      if (segEndMs >= segStartMs) {
        const apexMs =
          d.launchTime + (d.outboundTiles / DRONE_SPEED_TILES_PER_SEC) * 1000;
        const waypoints: Array<{ x: number; y: number }> = [];
        waypoints.push(droneCurrentPosition(d, segStartMs));
        // Include the outbound-endpoint waypoint if the apex falls strictly
        // inside (segStartMs, segEndMs). On the boundary the linear segment
        // to the next endpoint subsumes it.
        if (apexMs > segStartMs && apexMs < segEndMs) {
          waypoints.push(droneCurrentPosition(d, apexMs));
        }
        waypoints.push(droneCurrentPosition(d, segEndMs));
        for (let i = 0; i + 1 < waypoints.length; i++) {
          const a = waypoints[i]!;
          const b = waypoints[i + 1]!;
          const cells = corridorCells(a.x, a.y, b.x, b.y, d.scanRadius);
          for (const k of cells) {
            if (world.revealedCells.has(k)) continue;
            const { cellX, cellY } = parseCellKey(k);
            const center = cellCenterTile(cellX, cellY);
            if (pointInSignalRange(ranges, center.x, center.y)) {
              world.revealedCells.add(k);
              cellsAddedThisTick++;
            }
          }
        }
      }
    }

    // 2) Removal on return. The return decision is decoupled from reveals —
    //    a returned drone has already had its full flight scanned above
    //    (the segStartMs..segEndMs clamp covers the entire trajectory if
    //    the tick spans the flight).
    if (nowMs < d.expectedReturnTime) {
      remaining.push(d);
      continue;
    }
    returned.push(d);
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
    newlyDiscoveredIslandIds,
    revealedCellsAdded: cellsAddedThisTick,
  };
}

/** Whether any cell touched by `spec`'s footprint sits in `revealedCells`.
 *  Walks the same tile-bbox-per-constituent shape `islandCells` (discovery.ts)
 *  uses; short-circuits on the first hit. Pure. */
function islandHasRevealedCell(
  spec: import('./world.js').IslandSpec,
  revealedCells: ReadonlySet<string>,
): boolean {
  for (const c of islandConstituents(spec)) {
    const xMin = Math.floor(spec.cx + c.offsetX - c.major);
    const xMax = Math.ceil(spec.cx + c.offsetX + c.major);
    const yMin = Math.floor(spec.cy + c.offsetY - c.minor);
    const yMax = Math.ceil(spec.cy + c.offsetY + c.minor);
    const cMinX = Math.floor(xMin / CELL_SIZE_TILES);
    const cMaxX = Math.floor(xMax / CELL_SIZE_TILES);
    const cMinY = Math.floor(yMin / CELL_SIZE_TILES);
    const cMaxY = Math.floor(yMax / CELL_SIZE_TILES);
    for (let cy = cMinY; cy <= cMaxY; cy++) {
      for (let cx = cMinX; cx <= cMaxX; cx++) {
        if (revealedCells.has(`${cx},${cy}`)) return true;
      }
    }
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
  const travelled = elapsedSec * DRONE_SPEED_TILES_PER_SEC;
  const total = 2 * d.outboundTiles;
  const clamped = Math.min(travelled, total);
  // Fold: 0..outbound is forward, outbound..2*outbound is backward.
  const along = clamped <= d.outboundTiles ? clamped : total - clamped;
  return {
    x: d.originX + d.dirX * along,
    y: d.originY + d.dirY * along,
  };
}
