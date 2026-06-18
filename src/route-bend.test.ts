import { describe, expect, it } from 'vitest';
import { distPointToSegment, pickWaypointAt, pickRouteAt, insertBendOnSegment } from './route-bend.js';
import { MAX_ROUTE_BENDS, type Route } from './routes.js';
import type { IslandSpec } from './world.js';

function makeIslandSpec(id: string, cx: number, cy: number): IslandSpec {
  return {
    id,
    name: id,
    biome: 'plains',
    cx,
    cy,
    majorRadius: 10,
    minorRadius: 10,
    populated: true,
    discovered: true,
    buildings: [],
    modifiers: [],
  };
}

function makeIndex(...specs: IslandSpec[]): Map<string, IslandSpec> {
  return new Map(specs.map((s) => [s.id, s]));
}

function makeRoute(type: Route['type'], over: Partial<Route> = {}): Route {
  return {
    id: 'r1',
    from: 'a',
    to: 'b',
    type,
    capacityPerSec: 1,
    mode: 'priority',
    cargo: [],
    transitTimeSec: 10,
    inFlight: [],
    ...over,
  };
}

describe('distPointToSegment', () => {
  it('returns perpendicular distance for an interior projection', () => {
    expect(distPointToSegment(5, 3, 0, 0, 10, 0)).toBeCloseTo(3, 5);
  });

  it('returns endpoint distance when projection is outside the segment', () => {
    expect(distPointToSegment(-4, 3, 0, 0, 10, 0)).toBeCloseTo(5, 5);
  });

  it('returns zero when the point lies on the segment', () => {
    expect(distPointToSegment(5, 0, 0, 0, 10, 0)).toBeCloseTo(0, 5);
  });
});

describe('pickWaypointAt', () => {
  it('returns the index of a nearby waypoint', () => {
    const r = makeRoute('cargo', { waypoints: [{ x: 20, y: 20 }] });
    expect(pickWaypointAt(r, 21, 19, 3)).toBe(0);
  });

  it('returns null when no waypoint is within tolerance', () => {
    const r = makeRoute('cargo', { waypoints: [{ x: 20, y: 20 }] });
    expect(pickWaypointAt(r, 100, 100, 3)).toBeNull();
  });

  it('returns null when the route has no waypoints', () => {
    const r = makeRoute('cargo');
    expect(pickWaypointAt(r, 0, 0, 10)).toBeNull();
  });

  it('picks the closer waypoint when both are within tolerance', () => {
    const r = makeRoute('cargo', { waypoints: [{ x: 0, y: 0 }, { x: 10, y: 0 }] });
    expect(pickWaypointAt(r, 2, 0, 5)).toBe(0);
    expect(pickWaypointAt(r, 8, 0, 5)).toBe(1);
  });
});

describe('pickRouteAt', () => {
  it('finds a bendable route the click is near', () => {
    const idx = makeIndex(makeIslandSpec('a', 0, 0), makeIslandSpec('b', 40, 0));
    const cargo = makeRoute('cargo', { id: 'cargo1' });
    expect(pickRouteAt([cargo], idx, 20, 1, 3)).toBe(cargo);
  });

  it('ignores non-bendable route types (teleporter, power links)', () => {
    const idx = makeIndex(makeIslandSpec('a', 0, 0), makeIslandSpec('b', 40, 0));
    const teleporter = makeRoute('teleporter', { id: 'tel1', transitTimeSec: 0 });
    const cable = makeRoute('cable', { id: 'cab1', transitTimeSec: 0 });
    const spacetime = makeRoute('spacetime', { id: 'st1', transitTimeSec: 0 });
    const submarine = makeRoute('submarine_cable', { id: 'sub1', transitTimeSec: 0 });
    expect(pickRouteAt([teleporter], idx, 20, 0, 3)).toBeNull();
    expect(pickRouteAt([cable], idx, 20, 0, 3)).toBeNull();
    expect(pickRouteAt([spacetime], idx, 20, 0, 3)).toBeNull();
    expect(pickRouteAt([submarine], idx, 20, 0, 3)).toBeNull();
  });

  it('ignores draining routes', () => {
    const idx = makeIndex(makeIslandSpec('a', 0, 0), makeIslandSpec('b', 40, 0));
    const cargo = makeRoute('cargo', { id: 'cargo1', draining: true });
    expect(pickRouteAt([cargo], idx, 20, 1, 3)).toBeNull();
  });

  it('returns null when click is far from any route', () => {
    const idx = makeIndex(makeIslandSpec('a', 0, 0), makeIslandSpec('b', 40, 0));
    const cargo = makeRoute('cargo', { id: 'cargo1' });
    expect(pickRouteAt([cargo], idx, 20, 20, 3)).toBeNull();
  });

  it('returns the nearest route when several are within tolerance', () => {
    const idx = makeIndex(makeIslandSpec('a', 0, 0), makeIslandSpec('b', 40, 0), makeIslandSpec('c', 0, 20));
    const r1 = makeRoute('cargo', { id: 'cargo1', from: 'a', to: 'b' });
    const r2 = makeRoute('cargo', { id: 'cargo2', from: 'a', to: 'c' });
    expect(pickRouteAt([r1, r2], idx, 2, 2, 5)).toBe(r2);
  });
});

describe('insertBendOnSegment', () => {
  it('inserts a bend at the nearest segment index on a straight route', () => {
    const idx = makeIndex(makeIslandSpec('a', 0, 0), makeIslandSpec('b', 40, 0));
    const r = makeRoute('cargo');
    const out = insertBendOnSegment(r, idx, 10, 2);
    expect(out).toHaveLength(1);
    expect(out[0]!.x).toBe(10);
    expect(out[0]!.y).toBe(2);
  });

  it('inserts a waypoint between existing waypoints', () => {
    const idx = makeIndex(makeIslandSpec('a', 0, 0), makeIslandSpec('b', 40, 0));
    const r = makeRoute('cargo', { waypoints: [{ x: 20, y: 20 }] });
    // Click near segment a→(20,20) (segment 0) inserts before the existing waypoint.
    const out = insertBendOnSegment(r, idx, 2, 2);
    expect(out).toHaveLength(2);
    expect(out[0]!.x).toBe(2);
    expect(out[0]!.y).toBe(2);
    expect(out[1]).toEqual({ x: 20, y: 20 });
  });

  it('returns existing waypoints unchanged at MAX_ROUTE_BENDS', () => {
    const idx = makeIndex(makeIslandSpec('a', 0, 0), makeIslandSpec('b', 40, 0));
    const full: Array<{ x: number; y: number }> = [
      { x: 10, y: 10 },
      { x: 20, y: 10 },
      { x: 30, y: 10 },
      { x: 35, y: 5 },
    ];
    expect(full).toHaveLength(MAX_ROUTE_BENDS);
    const r = makeRoute('cargo', { waypoints: full });
    const out = insertBendOnSegment(r, idx, 15, 2);
    expect(out).toEqual(full);
    expect(out).not.toBe(full);
  });

  it('returns an empty array when the route has no resolvable endpoints', () => {
    const idx = makeIndex(makeIslandSpec('a', 0, 0));
    const r = makeRoute('cargo', { to: 'missing' });
    expect(insertBendOnSegment(r, idx, 5, 5)).toEqual([]);
  });
});
