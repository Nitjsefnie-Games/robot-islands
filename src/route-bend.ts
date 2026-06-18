import { isBendableRouteType, MAX_ROUTE_BENDS, routePolylinePoints, type Route } from './routes.js';
import type { IslandSpec } from './world.js';

export function distPointToSegment(px: number, py: number, ax: number, ay: number, bx: number, by: number): number {
  const dx = bx - ax, dy = by - ay;
  const len2 = dx * dx + dy * dy;
  let t = len2 > 0 ? ((px - ax) * dx + (py - ay) * dy) / len2 : 0;
  t = Math.max(0, Math.min(1, t));
  const cx = ax + t * dx, cy = ay + t * dy;
  return Math.hypot(px - cx, py - cy);
}

export function pickWaypointAt(route: Route, x: number, y: number, tolTiles: number): number | null {
  const wps = route.waypoints;
  if (!wps) return null;
  let best = -1, bestD = tolTiles;
  for (let i = 0; i < wps.length; i++) {
    const d = Math.hypot(wps[i]!.x - x, wps[i]!.y - y);
    if (d <= bestD) { bestD = d; best = i; }
  }
  return best >= 0 ? best : null;
}

/** Nearest segment index + distance for a click against a route's polyline. */
function nearestSegment(route: Route, islandIndex: Map<string, IslandSpec>, x: number, y: number):
  { index: number; dist: number } | null {
  const pts = routePolylinePoints(route, islandIndex);
  if (!pts || pts.length < 2) return null;
  let bestI = 0, bestD = Infinity;
  for (let i = 0; i < pts.length - 1; i++) {
    const d = distPointToSegment(x, y, pts[i]!.x, pts[i]!.y, pts[i + 1]!.x, pts[i + 1]!.y);
    if (d < bestD) { bestD = d; bestI = i; }
  }
  return { index: bestI, dist: bestD };
}

export function pickRouteAt(
  routes: ReadonlyArray<Route>, islandIndex: Map<string, IslandSpec>,
  x: number, y: number, tolTiles: number,
): Route | null {
  let best: Route | null = null, bestD = tolTiles;
  for (const r of routes) {
    if (!isBendableRouteType(r.type) || r.draining) continue;
    const ns = nearestSegment(r, islandIndex, x, y);
    if (ns && ns.dist <= bestD) { bestD = ns.dist; best = r; }
  }
  return best;
}

export function insertBendOnSegment(
  route: Route, islandIndex: Map<string, IslandSpec>, x: number, y: number,
): Array<{ x: number; y: number }> {
  const existing = route.waypoints ? route.waypoints.map((w) => ({ x: w.x, y: w.y })) : [];
  if (existing.length >= MAX_ROUTE_BENDS) return existing;
  const ns = nearestSegment(route, islandIndex, x, y);
  if (!ns) return existing;
  // polyline points = [from, ...waypoints, to]; segment i sits BEFORE waypoint i
  // (segment 0 is from→wp0 / from→to). Insert the new bend at waypoint index = ns.index.
  existing.splice(ns.index, 0, { x, y });
  return existing;
}
