// Pure helpers for the drone-launch UI. No DOM, no Pixi — testable
// in isolation. Used by drones-ui.ts for both numeric-tier reachability
// gating and T5 path-mode range gating + fuel computation.

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
 *  Cap rule: 2 × pathLength ≤ MAX_FUEL_PER_DRONE × DRONE_T5_EFFICIENCY
 *  (factor 2 = out + back; back retraces the path in reverse). */
export function wouldExceedRange(
  origin: Point,
  waypoints: ReadonlyArray<Point>,
  next: Point,
): boolean {
  const lengthWithNext = totalPathTiles(origin, [...waypoints, next]);
  const maxOneWay = MAX_FUEL_PER_DRONE * DRONE_T5_EFFICIENCY / 2;
  return lengthWithNext > maxOneWay;
}

/** Fuel units required to fly the path round-trip, rounded up. */
export function fuelForPath(
  origin: Point,
  waypoints: ReadonlyArray<Point>,
): number {
  const length = totalPathTiles(origin, waypoints);
  return Math.ceil(2 * length / DRONE_T5_EFFICIENCY);
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
