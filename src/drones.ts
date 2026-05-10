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
//   - Fuel = Biofuel (T1, §11.7 fuel table). The Drone Pad nominally launches
//     T2 drones burning Diesel per spec, but step 6 has no Diesel chain;
//     using Biofuel here matches the home-island tier (T1) and the spec's
//     "fuel grade matches launching island's tier" rule.

import type { IslandState } from './economy.js';
import { inv } from './economy.js';
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
}

/** T2-equivalent constants for step 6. Tile units; seconds for time.
 *  10 biofuel → 40 tiles round-trip → 20 tiles outbound, ~20s flight.
 *  50 biofuel → 200 tiles round-trip → 100 tiles outbound, ~100s flight. */
export const DRONE_TIER_EFFICIENCY = 4;
export const DRONE_SPEED_TILES_PER_SEC = 2;
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
function nextDroneId(): string {
  droneIdCounter += 1;
  return `drone-${droneIdCounter}`;
}

/** Reset the drone-id counter. Test-only — `dispatchDrone` increments a
 *  module-level counter so ids stay unique within a session. */
export function _resetDroneIdCounter(): void {
  droneIdCounter = 0;
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
 *   3. Origin must hold ≥ `fuelLoaded` biofuel.
 *
 * On success: subtract `fuelLoaded` from `inventory.biofuel`, append a fresh
 * `Drone` to `world.drones`, return `{ ok: true, drone }`.
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

  // 3. fuel
  if (inv(origin, 'biofuel') < fuelLoaded || fuelLoaded <= 0) {
    return { ok: false, reason: 'insufficient-fuel' };
  }

  // Range: total round-trip in tiles. Outbound is half (straight out, straight
  // back along the same line). Travel time uses the full round-trip distance.
  const rangeTiles = fuelLoaded * DRONE_TIER_EFFICIENCY;
  const outboundTiles = rangeTiles / 2;
  const travelSec = rangeTiles / DRONE_SPEED_TILES_PER_SEC;
  const expectedReturnTime = nowMs + travelSec * 1000;

  origin.inventory.biofuel = inv(origin, 'biofuel') - fuelLoaded;

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
  };
  world.drones.push(drone);
  return { ok: true, drone };
}

/** Result of a tick — drones that returned this frame and which (previously
 *  undiscovered) island ids they revealed. The renderer uses this to know
 *  when to rebuild the ocean / island layers. */
export interface TickDronesResult {
  returned: Drone[];
  newlyDiscoveredIslandIds: string[];
}

/**
 * Advance the drone fleet to `nowMs`. Any drone whose `expectedReturnTime`
 * has elapsed is removed from `world.drones` and runs its capsule-corridor
 * scan against the world's islands; previously-undiscovered islands inside
 * the corridor flip `discovered = true` and their ids are reported.
 *
 * The corridor is a capsule from `(originX, originY)` to the outbound
 * endpoint, with half-width `scanRadius`. The drone retraces the same
 * segment on return, so the round-trip corridor IS the outbound corridor —
 * no separate return-leg geometry needed.
 *
 * Populated islands are skipped (already on the map). Already-discovered
 * islands are not flipped or reported, so `newlyDiscoveredIslandIds`
 * contains only fresh reveals — the UI can light them up exactly once.
 */
export function tickDrones(world: WorldState, nowMs: number): TickDronesResult {
  const returned: Drone[] = [];
  const newlyDiscoveredIslandIds: string[] = [];
  const remaining: Drone[] = [];

  for (const d of world.drones) {
    if (nowMs < d.expectedReturnTime) {
      remaining.push(d);
      continue;
    }
    returned.push(d);
    const ax = d.originX;
    const ay = d.originY;
    const bx = ax + d.dirX * d.outboundTiles;
    const by = ay + d.dirY * d.outboundTiles;
    const r2 = d.scanRadius * d.scanRadius;
    for (const isl of world.islands) {
      if (isl.populated) continue;
      if (isl.discovered) continue;
      const distSq = pointToSegmentDistSq(isl.cx, isl.cy, ax, ay, bx, by);
      if (distSq <= r2) {
        isl.discovered = true;
        newlyDiscoveredIslandIds.push(isl.id);
      }
    }
  }

  // Replace world.drones contents in-place so external references stay valid.
  world.drones.length = 0;
  for (const d of remaining) world.drones.push(d);

  return { returned, newlyDiscoveredIslandIds };
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
