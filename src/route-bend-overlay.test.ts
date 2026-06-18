import { test, expect } from 'vitest';
import { handleWorldPositions } from './route-bend-overlay.js';
import type { Route } from './routes.js';
import type { IslandSpec } from './world.js';

function specAt(id: string, cx: number, cy: number): IslandSpec {
  return { id, cx, cy } as unknown as IslandSpec;
}

function idx(...specs: IslandSpec[]) {
  return new Map(specs.map((s) => [s.id, s]));
}

function route(over: Partial<Route> = {}): Route {
  return { id: 'r', from: 'a', to: 'b', type: 'cargo', ...over } as Route;
}

test('handleWorldPositions returns each waypoint scaled to world px', () => {
  const i = idx(specAt('a', 0, 0), specAt('b', 40, 0));
  const r = route({ waypoints: [{ x: 10, y: 5 }] });
  expect(handleWorldPositions(r, i, 24)).toEqual([{ x: 240, y: 120 }]);
});

test('handleWorldPositions returns [] for a straight route with no waypoints', () => {
  const i = idx(specAt('a', 0, 0), specAt('b', 40, 0));
  const r = route();
  expect(handleWorldPositions(r, i, 24)).toEqual([]);
});

test('handleWorldPositions returns multiple waypoints in order', () => {
  const i = idx(specAt('a', 0, 0), specAt('b', 40, 0));
  const r = route({ waypoints: [{ x: 10, y: 0 }, { x: 30, y: 20 }] });
  expect(handleWorldPositions(r, i, 24)).toEqual([
    { x: 240, y: 0 },
    { x: 720, y: 480 },
  ]);
});

test('handleWorldPositions returns [] when an endpoint island is unknown', () => {
  const i = idx(specAt('a', 0, 0));
  const r = route({ waypoints: [{ x: 10, y: 5 }] });
  expect(handleWorldPositions(r, i, 24)).toEqual([]);
});
