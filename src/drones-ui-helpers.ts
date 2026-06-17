// Pure helpers for the drone-launch UI (no DOM, no Pixi): numeric-tier
// reachability gating and T5 path-mode range gating + fuel computation.

import { DRONE_T5_EFFICIENCY, MAX_FUEL_PER_DRONE } from './drones.js';

export interface Point {
  readonly x: number;
  readonly y: number;
}

/** Euclidean distance between two tile-coord points. */
export function tileDist(a: Point, b: Point): number {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  return Math.sqrt(dx * dx + dy * dy);
}

/** Sum of segment lengths from origin through every waypoint in order. */
export function totalPathTiles(
  origin: Point,
  waypoints: ReadonlyArray<Point>,
): number {
  if (waypoints.length === 0) return 0;
  let total = tileDist(origin, waypoints[0]!);
  for (let i = 1; i < waypoints.length; i++) {
    total += tileDist(waypoints[i - 1]!, waypoints[i]!);
  }
  return total;
}

/** True if adding `next` to the path would exceed the T5 fuel cap.
 *  Cap rule: pathLength ≤ MAX_FUEL_PER_DRONE × DRONE_T5_EFFICIENCY × efficiencyMul.
 *  #117 path-drawn T5 drones are ONE-WAY (no return leg).
 *  `efficiencyMul` defaults to 1 (no skill bonus). Pass the origin island's
 *  `droneFuelEfficiency` skill multiplier to honour the Transport skill. */
export function wouldExceedRange(
  origin: Point,
  waypoints: ReadonlyArray<Point>,
  next: Point,
  efficiencyMul = 1,
): boolean {
  const lengthWithNext = totalPathTiles(origin, [...waypoints, next]);
  const maxOneWay = MAX_FUEL_PER_DRONE * DRONE_T5_EFFICIENCY * efficiencyMul;
  return lengthWithNext > maxOneWay;
}

/** Fuel units required to fly the path one-way, rounded up.
 *  #117 path-drawn T5 drones are ONE-WAY (no return leg).
 *  `efficiencyMul` defaults to 1 (no skill bonus). Pass the origin island's
 *  `droneFuelEfficiency` skill multiplier to honour the Transport skill. */
export function fuelForPath(
  origin: Point,
  waypoints: ReadonlyArray<Point>,
  efficiencyMul = 1,
): number {
  const length = totalPathTiles(origin, waypoints);
  return Math.ceil(length / (DRONE_T5_EFFICIENCY * efficiencyMul));
}

/** If the last two waypoints share identical x/y, return a new array
 *  with the trailing duplicate removed. Otherwise return the input
 *  unchanged. Handles the browser click→dblclick double-add per the
 *  design spec §06 resolution. Pure: returns a fresh array. */
export function popTrailingDuplicate(
  waypoints: ReadonlyArray<Point>,
): ReadonlyArray<Point> {
  if (waypoints.length < 2) return waypoints;
  const n = waypoints.length;
  const last = waypoints[n - 1]!;
  const prev = waypoints[n - 2]!;
  if (last.x === prev.x && last.y === prev.y) {
    return waypoints.slice(0, n - 1);
  }
  return waypoints;
}
