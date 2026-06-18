# Route Bending Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let already-placed cargo routes carry up to 4 bend points (a polyline of ≤5 segments) so players steer around bad weather; weather + transit are computed along the bend; includes per-point and bulk unbend; never available during route placement.

**Architecture:** Add an optional `waypoints` array (tile coords) to `Route`. Generalize cell rasterization + the §2.6 weather throttle/loss + transit-time to a polyline. A single shared pure `setRouteWaypoints` validates (source island T5, bendable type, ≤4 points) and is called by both the LOCAL gateway and the server `set-route-waypoints` intent. The renderer draws polylines; a new overlay draws bend handles for the selected route; `main.ts` wires click-to-select / drag-to-bend / click-handle-to-remove on the map, with hit-testing in a pure `route-bend.ts`.

**Tech Stack:** Vite 5 + TypeScript strict + PixiJS 8 + vitest (client); Fastify 5 + Postgres + tsx + vitest (server).

## Global Constraints

- TypeScript strict, `noUncheckedIndexedAccess`, `noUnusedLocals`, `noUnusedParameters` — new code compiles clean.
- Pure layer imports no PixiJS/DOM. Tests target the pure layer only.
- Coords: waypoints are **tile** coords (like `IslandSpec.cx/cy` and drone `waypoints`). `TILE_PX = 24`. Cells use `CELL_SIZE_TILES` (from `world.ts`).
- Bend cap = **4** waypoints. Bendable types = `cargo`, `drone`, `airship`, `mass_driver` (NOT `teleporter`, NOT power links `cable`/`spacetime`/`submarine_cable`).
- Tier gate = `tierForLevel(sourceState.level) >= 5` (`tierForLevel` from `src/skilltree.ts`).
- Every behavior change updates `SPEC.md` (§2.4 / §2.6) in the same change.
- Persistence: bump = migrate (see AGENTS.md "Persistence migrations").
- Commit message trailer on every commit: `Co-Authored-By: <model> <noreply@…>`.
- Run client tests: `npx vitest run --project client <file>`. Server tests: from `server/`, `npm test`. Typecheck client: `npx tsc -b --noEmit` (or `npm run build`); server: `cd server && npm run typecheck`.

---

### Task 1: Polyline cell rasterization + cells-based weather throttle (`weather.ts`)

**Files:**
- Modify: `src/weather.ts` (after `rasterizeRouteCells`, ~line 770; and refactor `routeCapacityMultiplierForWeather` ~773)
- Test: `src/weather.test.ts`

**Interfaces:**
- Produces:
  - `rasterizePolylineCells(points: ReadonlyArray<{ x: number; y: number }>, cellSizeTiles: number): Array<{ cx: number; cy: number; transitFraction: number }>`
  - `routeCapacityMultiplierForCells(seed: string, cells: ReadonlyArray<{ cx: number; cy: number }>, nowMs: number, wallOffsetMs?: number, biomeFor?: (cx: number, cy: number) => Biome | undefined, totalCo2Kg?: number): number`
- Consumes: existing `lineSegmentCells` (module-private), `weather`, `weatherClockMs`, `WEATHER_ROUTE_CAPACITY_MULTIPLIER`.

- [ ] **Step 1: Write failing tests**

```ts
// in src/weather.test.ts
import { rasterizePolylineCells, rasterizeRouteCells, routeCapacityMultiplierForCells } from './weather.js';

test('rasterizePolylineCells with no bend equals straight rasterizeRouteCells (cells)', () => {
  const cell = 8;
  const poly = rasterizePolylineCells([{ x: 2, y: 2 }, { x: 40, y: 5 }], cell);
  const straight = rasterizeRouteCells(2, 2, 40, 5, cell);
  expect(poly.map(c => `${c.cx},${c.cy}`)).toEqual(straight.map(c => `${c.cx},${c.cy}`));
});

test('rasterizePolylineCells transitFraction is monotonic non-decreasing in [0,1]', () => {
  const cells = rasterizePolylineCells([{ x: 0, y: 0 }, { x: 30, y: 0 }, { x: 30, y: 30 }], 8);
  expect(cells[0]!.transitFraction).toBe(0);
  expect(cells[cells.length - 1]!.transitFraction).toBeLessThanOrEqual(1);
  for (let i = 1; i < cells.length; i++) {
    expect(cells[i]!.transitFraction).toBeGreaterThanOrEqual(cells[i - 1]!.transitFraction);
  }
});

test('rasterizePolylineCells does not duplicate the shared vertex cell', () => {
  // L-shaped path; the corner cell must appear once.
  const cells = rasterizePolylineCells([{ x: 0, y: 0 }, { x: 24, y: 0 }, { x: 24, y: 24 }], 8);
  const keys = cells.map(c => `${c.cx},${c.cy}`);
  expect(new Set(keys).size).toBe(keys.length);
});

test('routeCapacityMultiplierForCells returns min over cells (clear weather = 1)', () => {
  const cells = rasterizePolylineCells([{ x: 0, y: 0 }, { x: 40, y: 0 }], 8).map(c => ({ cx: c.cx, cy: c.cy }));
  const mul = routeCapacityMultiplierForCells('seed-clearcells', cells, 0);
  expect(mul).toBeGreaterThan(0);
  expect(mul).toBeLessThanOrEqual(1);
});
```

- [ ] **Step 2: Run, verify FAIL** — `npx vitest run --project client src/weather.test.ts` → fails (`rasterizePolylineCells is not a function`).

- [ ] **Step 3: Implement**

```ts
// src/weather.ts — add after rasterizeRouteCells

/** Rasterize a polyline [p0, p1, …, pn] (tile coords) into stratification
 *  cells with a MONOTONIC global transitFraction in [0,1]. Each segment is
 *  rasterized via lineSegmentCells; its local fraction [0,1] is remapped to
 *  (cumLenBefore + local*segLen)/totalLen. The shared vertex cell between
 *  consecutive segments is emitted once (skip a segment's first cell if it
 *  repeats the previous segment's last cell). A single point (or zero length)
 *  yields one cell at fraction 0. */
export function rasterizePolylineCells(
  points: ReadonlyArray<{ x: number; y: number }>,
  cellSizeTiles: number,
): Array<{ cx: number; cy: number; transitFraction: number }> {
  if (points.length === 0) return [];
  if (points.length === 1) {
    const p = points[0]!;
    return [{ cx: Math.floor(p.x / cellSizeTiles), cy: Math.floor(p.y / cellSizeTiles), transitFraction: 0 }];
  }
  const segLens: number[] = [];
  let totalLen = 0;
  for (let i = 0; i < points.length - 1; i++) {
    const a = points[i]!, b = points[i + 1]!;
    const len = Math.hypot(b.x - a.x, b.y - a.y);
    segLens.push(len);
    totalLen += len;
  }
  const out: Array<{ cx: number; cy: number; transitFraction: number }> = [];
  if (totalLen === 0) {
    const p = points[0]!;
    return [{ cx: Math.floor(p.x / cellSizeTiles), cy: Math.floor(p.y / cellSizeTiles), transitFraction: 0 }];
  }
  let cumBefore = 0;
  for (let i = 0; i < points.length - 1; i++) {
    const a = points[i]!, b = points[i + 1]!;
    const segLen = segLens[i]!;
    const cells = lineSegmentCells(a.x, a.y, b.x, b.y, cellSizeTiles);
    for (let j = 0; j < cells.length; j++) {
      const c = cells[j]!;
      // Drop the leading cell of a non-first segment if it repeats the prior cell.
      if (j === 0 && i > 0) {
        const prev = out[out.length - 1];
        if (prev && prev.cx === c.cx && prev.cy === c.cy) continue;
      }
      const global = segLen > 0 ? (cumBefore + c.transitFraction * segLen) / totalLen : cumBefore / totalLen;
      out.push({ cx: c.cx, cy: c.cy, transitFraction: global });
    }
    cumBefore += segLen;
  }
  return out;
}

/** §2.6 capacity multiplier (min over already-rasterized cells). Extracted so
 *  callers that already have the (possibly bent) cell list don't re-rasterize. */
export function routeCapacityMultiplierForCells(
  seed: string,
  cells: ReadonlyArray<{ cx: number; cy: number }>,
  nowMs: number,
  wallOffsetMs = 0,
  biomeFor?: (cx: number, cy: number) => Biome | undefined,
  totalCo2Kg = 0,
): number {
  let minMul = 1;
  for (const { cx, cy } of cells) {
    const w = weather(seed, cx, cy, weatherClockMs(nowMs, wallOffsetMs), biomeFor?.(cx, cy), totalCo2Kg);
    const mul = WEATHER_ROUTE_CAPACITY_MULTIPLIER[w.state];
    if (mul !== undefined) minMul = Math.min(minMul, mul);
  }
  return minMul;
}
```

Then refactor the existing `routeCapacityMultiplierForWeather` body to delegate:

```ts
export function routeCapacityMultiplierForWeather(
  seed: string, fromX: number, fromY: number, toX: number, toY: number,
  nowMs: number, cellSizeTiles: number, wallOffsetMs = 0,
  biomeFor?: (cx: number, cy: number) => Biome | undefined, totalCo2Kg = 0,
): number {
  const cells = rasterizeLineSegment(fromX, fromY, toX, toY, cellSizeTiles);
  return routeCapacityMultiplierForCells(seed, cells, nowMs, wallOffsetMs, biomeFor, totalCo2Kg);
}
```

- [ ] **Step 4: Run, verify PASS** — `npx vitest run --project client src/weather.test.ts`.

- [ ] **Step 5: Commit** — `git add src/weather.ts src/weather.test.ts && git commit -m "feat(weather): polyline cell rasterization + cells-based route capacity throttle (#118)"` (+ co-author trailer).

---

### Task 2: `Route.waypoints` + polyline `routeCrossedCells` + bent-length/effective-transit helpers (`routes.ts`)

**Files:**
- Modify: `src/routes.ts` (`Route` interface ~84; `routeCrossedCells` ~143; add helpers; VISUAL-FIELD-MARKER comment ~111)
- Test: `src/routes.test.ts`

**Interfaces:**
- Produces (on `Route`): `waypoints?: ReadonlyArray<{ x: number; y: number }>`.
- Produces:
  - `MAX_ROUTE_BENDS = 4` (const)
  - `isBendableRouteType(t: RouteType): boolean`
  - `routePolylinePoints(route: Route, islandIndex: Map<string, IslandSpec>): Array<{ x: number; y: number }> | null` (null if endpoint unknown; `[from, ...waypoints, to]` in tile coords)
  - `routeBentLengthTiles(route: Route, islandIndex: Map<string, IslandSpec>): number`
  - `effectiveTransitTimeSec(route: Route, islandIndex: Map<string, IslandSpec>): number`
- Consumes: `rasterizePolylineCells` (Task 1).

- [ ] **Step 1: Write failing tests**

```ts
// src/routes.test.ts — add
import {
  routeCrossedCells, routePolylinePoints, routeBentLengthTiles, effectiveTransitTimeSec,
  isBendableRouteType, MAX_ROUTE_BENDS, type Route,
} from './routes.js';
import { CELL_SIZE_TILES, type IslandSpec } from './world.js';

function specAt(id: string, cx: number, cy: number): IslandSpec {
  return { id, cx, cy, buildings: [] } as unknown as IslandSpec;
}
function idx(...specs: IslandSpec[]) { return new Map(specs.map(s => [s.id, s])); }
function baseRoute(over: Partial<Route> = {}): Route {
  return { id: 'r1', from: 'a', to: 'b', type: 'cargo', capacityPerSec: 1, mode: 'priority',
    cargo: [], transitTimeSec: 40, inFlight: [], ...over } as Route;
}

test('MAX_ROUTE_BENDS is 4 and bendable types exclude teleporter/power links', () => {
  expect(MAX_ROUTE_BENDS).toBe(4);
  expect(isBendableRouteType('cargo')).toBe(true);
  expect(isBendableRouteType('mass_driver')).toBe(true);
  expect(isBendableRouteType('teleporter')).toBe(false);
  expect(isBendableRouteType('cable')).toBe(false);
  expect(isBendableRouteType('spacetime')).toBe(false);
});

test('routePolylinePoints inserts waypoints between island centres', () => {
  const i = idx(specAt('a', 0, 0), specAt('b', 40, 0));
  const r = baseRoute({ waypoints: [{ x: 20, y: 20 }] });
  expect(routePolylinePoints(r, i)).toEqual([{ x: 0, y: 0 }, { x: 20, y: 20 }, { x: 40, y: 0 }]);
});

test('routeBentLengthTiles grows when bent', () => {
  const i = idx(specAt('a', 0, 0), specAt('b', 40, 0));
  expect(routeBentLengthTiles(baseRoute(), i)).toBeCloseTo(40, 5);
  const bent = routeBentLengthTiles(baseRoute({ waypoints: [{ x: 20, y: 20 }] }), i);
  expect(bent).toBeGreaterThan(40);
});

test('effectiveTransitTimeSec scales base transit by bent/straight', () => {
  const i = idx(specAt('a', 0, 0), specAt('b', 40, 0));
  expect(effectiveTransitTimeSec(baseRoute(), i)).toBeCloseTo(40, 5);
  const bent = baseRoute({ waypoints: [{ x: 20, y: 20 }] });
  const ratio = routeBentLengthTiles(bent, i) / 40;
  expect(effectiveTransitTimeSec(bent, i)).toBeCloseTo(40 * ratio, 5);
});

test('routeCrossedCells follows the bend (visits a cell off the straight line)', () => {
  const i = idx(specAt('a', 0, 0), specAt('b', 80, 0));
  const straightKeys = new Set(routeCrossedCells(baseRoute(), i).map(c => `${c.cx},${c.cy}`));
  const bentKeys = routeCrossedCells(baseRoute({ waypoints: [{ x: 40, y: 80 }] }), i).map(c => `${c.cx},${c.cy}`);
  expect(bentKeys.some(k => !straightKeys.has(k))).toBe(true);
});
```

- [ ] **Step 2: Run, verify FAIL** — `npx vitest run --project client src/routes.test.ts`.

- [ ] **Step 3: Implement** in `src/routes.ts`:

Add to the `Route` interface (after `sourceBuildingId?`):
```ts
  /** §2.6 bend points (tile coords) turning the straight corridor into a
   *  polyline of up to MAX_ROUTE_BENDS+1 segments. Absent/empty = straight
   *  (back-compat). Only bendable, non-instant cargo routes carry these. */
  waypoints?: ReadonlyArray<{ x: number; y: number }>;
```

Extend the VISUAL-FIELD-MARKER comment block to list `route.waypoints` as rendering-relevant.

Import `rasterizePolylineCells` from `./weather.js` (alongside the existing weather imports).

Add helpers near `routeCrossedCells`:
```ts
export const MAX_ROUTE_BENDS = 4;

/** Route classes that traverse ocean cells and can be bent. Excludes instant
 *  teleporters and power links (which transmit power, not cargo, skipping §2.6). */
export function isBendableRouteType(t: RouteType): boolean {
  return t === 'cargo' || t === 'drone' || t === 'airship' || t === 'mass_driver';
}

/** Polyline points (tile coords) for a route: [from, ...waypoints, to].
 *  Null when either endpoint island is unknown. */
export function routePolylinePoints(
  route: Route, islandIndex: Map<string, IslandSpec>,
): Array<{ x: number; y: number }> | null {
  const fromSpec = islandIndex.get(route.from);
  const toSpec = islandIndex.get(route.to);
  if (!fromSpec || !toSpec) return null;
  const pts: Array<{ x: number; y: number }> = [{ x: fromSpec.cx, y: fromSpec.cy }];
  if (route.waypoints) for (const w of route.waypoints) pts.push({ x: w.x, y: w.y });
  pts.push({ x: toSpec.cx, y: toSpec.cy });
  return pts;
}

/** Total polyline length in tiles (straight-line distance when no bends). */
export function routeBentLengthTiles(route: Route, islandIndex: Map<string, IslandSpec>): number {
  const pts = routePolylinePoints(route, islandIndex);
  if (!pts) return 0;
  let len = 0;
  for (let i = 0; i < pts.length - 1; i++) len += Math.hypot(pts[i + 1]!.x - pts[i]!.x, pts[i + 1]!.y - pts[i]!.y);
  return len;
}

/** Effective transit time: base (straight) transitTimeSec scaled by
 *  bentLength/straightLength. A straight route returns transitTimeSec unchanged. */
export function effectiveTransitTimeSec(route: Route, islandIndex: Map<string, IslandSpec>): number {
  const fromSpec = islandIndex.get(route.from);
  const toSpec = islandIndex.get(route.to);
  if (!fromSpec || !toSpec) return route.transitTimeSec;
  const straight = Math.hypot(toSpec.cx - fromSpec.cx, toSpec.cy - fromSpec.cy);
  if (straight <= 0) return route.transitTimeSec;
  return route.transitTimeSec * (routeBentLengthTiles(route, islandIndex) / straight);
}
```

Rewrite `routeCrossedCells` to use the polyline:
```ts
export function routeCrossedCells(
  route: Route, islandIndex: Map<string, IslandSpec>,
): ReadonlyArray<{ cx: number; cy: number; transitFraction: number }> {
  const pts = routePolylinePoints(route, islandIndex);
  if (!pts) return NO_CROSSED_CELLS;
  return rasterizePolylineCells(pts, CELL_SIZE_TILES);
}
```

- [ ] **Step 4: Run, verify PASS** — `npx vitest run --project client src/routes.test.ts`.

- [ ] **Step 5: Typecheck** — `npx tsc -b --noEmit` clean.

- [ ] **Step 6: Commit** — `feat(routes): waypoints field + polyline crossed-cells + bent-length/effective-transit helpers (#118)`.

---

### Task 3: Dispatch + delivery use the bent path (`routes.ts`)

**Files:**
- Modify: `src/routes.ts` (`dispatchPhase` weather-mul block ~890-924; arrivalTime ~1043)
- Test: `src/routes.test.ts`

**Interfaces:**
- Consumes: `routeCrossedCells`, `routeCapacityMultiplierForCells` (Task 1), `effectiveTransitTimeSec` (Task 2).

- [ ] **Step 1: Write failing test** (a storm on the straight line is avoided by a bend, so dispatched amount rises). Use the existing test helpers in `routes.test.ts` for building a world + states; model on existing weather-throttle tests there.

```ts
// src/routes.test.ts — add. Reuse the file's existing world/state builders
// (grep for an existing "weather" capacity test to copy its setup shape).
test('bending a route around a storm restores dispatch capacity (#118)', () => {
  // Build a world+states with a cargo route a->b whose STRAIGHT corridor
  // crosses a storm cell, and a bent waypoint that detours around it.
  // Assert dispatched amount with waypoints > dispatched amount straight.
  // (Construct the storm via a seed/biome known to the existing weather tests;
  //  if no deterministic storm seed exists in this file, assert the weaker
  //  invariant: a bend that lengthens the path changes effective transit so
  //  the in-flight batch arrivalTime is later — see assertion below.)
});

test('bent route in-flight batch arrives later than the straight equivalent (#118)', () => {
  // Dispatch on a straight route, capture arrivalTime; dispatch on the same
  // route with a waypoint that doubles the length; assert arrivalTime delta
  // ~ doubles (effectiveTransitTimeSec wired into arrivalTime).
});
```

(Implementer: prefer the deterministic arrivalTime assertion — it does not depend on finding a storm seed. If the file already has a deterministic storm fixture, also add the capacity assertion.)

- [ ] **Step 2: Run, verify FAIL.**

- [ ] **Step 3: Implement** — in `dispatchPhase`, replace the straight `routeCapacityMultiplierForWeather` call with the cells path:

```ts
const instant = route.transitTimeSec <= 0;
const crossed = !instant ? routeCrossedCells(route, islandIndex) : NO_CROSSED_CELLS;
const weatherMul = !instant && crossed.length > 0
  ? routeCapacityMultiplierForCells(
      world.seed,
      crossed.map((c) => ({ cx: c.cx, cy: c.cy })),
      nowMs, wallOffsetMs,
      (cx, cy) => biomeForCell(world, cx, cy),
      sumIslandCo2(world),
    )
  : 1;
```

Update imports: add `routeCapacityMultiplierForCells` to the `./weather.js` import; you may drop `routeCapacityMultiplierForWeather` from routes.ts imports if it becomes unused (keep it exported from weather.ts).

In Phase 3 (in-flight branch), replace `route.transitTimeSec` in `arrivalTime` with the effective value:
```ts
const effTransit = effectiveTransitTimeSec(d.route, islandIndex);
// …
arrivalTime: nowMs + (effTransit / d.floorMul) * 1000,
```
(Compute `effTransit` once per dispatched route; `islandIndex` is already built at the top of `dispatchPhase`.)

- [ ] **Step 4: Run, verify PASS** (this file + full `--project client` routes suites).

- [ ] **Step 5: Typecheck + commit** — `feat(routes): sample §2.6 weather + transit along the bent polyline at dispatch (#118)`.

---

### Task 4: Pure `setRouteWaypoints` + gating (`routes.ts`)

**Files:**
- Modify: `src/routes.ts` (add near `retargetRoute` ~1142)
- Test: `src/routes.test.ts`

**Interfaces:**
- Produces:
  - `SetWaypointsResult = { ok: true; route: Route } | { ok: false; error: string }`
  - `setRouteWaypoints(world: WorldState, states: ReadonlyMap<string, IslandState>, routeId: string, waypoints: ReadonlyArray<{ x: number; y: number }>): SetWaypointsResult`
  - `canBendRoute(route: Route, world: WorldState, states: ReadonlyMap<string, IslandState>): boolean`
- Consumes: `tierForLevel` (from `./skilltree.js`), `isBendableRouteType`, `MAX_ROUTE_BENDS`.

- [ ] **Step 1: Write failing tests**

```ts
import { setRouteWaypoints, canBendRoute } from './routes.js';
// Build a minimal WorldState { routes:[route], islands:[from,to], seed }
// and states Map<id, IslandState> with from-island level at/below T5.

test('setRouteWaypoints rejects when source island below T5', () => {
  // states['a'].level = 1 (T0) → reject 'source island not T5'
});
test('setRouteWaypoints rejects non-bendable type (teleporter)', () => {});
test('setRouteWaypoints rejects > 4 waypoints', () => {});
test('setRouteWaypoints rejects non-finite coords', () => {});
test('setRouteWaypoints rejects draining route', () => {});
test('setRouteWaypoints sets waypoints on a T5 cargo route and returns ok', () => {
  // states['a'].level high enough that tierForLevel === 5; expect route.waypoints set.
});
test('setRouteWaypoints with [] clears waypoints (unbend)', () => {
  // pre-set route.waypoints, call with [], expect route.waypoints === undefined or empty.
});
test('canBendRoute true for T5 cargo, false for T4', () => {});
```

(Implementer: find the T5 level threshold by calling `tierForLevel` — pick a `level` where it returns 5; the buildings-ui test or skilltree test shows a working value.)

- [ ] **Step 2: Run, verify FAIL.**

- [ ] **Step 3: Implement**

```ts
export function canBendRoute(
  route: Route, world: WorldState, states: ReadonlyMap<string, IslandState>,
): boolean {
  if (!isBendableRouteType(route.type)) return false;
  if (route.draining) return false;
  const srcState = states.get(route.from);
  if (!srcState) return false;
  return tierForLevel(srcState.level) >= 5;
}

export type SetWaypointsResult =
  | { readonly ok: true; readonly route: Route }
  | { readonly ok: false; readonly error: string };

/** §2.6 set (or clear, with []) a route's bend points. Validates the route is
 *  bendable (type), source island is T5, ≤ MAX_ROUTE_BENDS finite points, and
 *  not draining. Mutates route.waypoints in place. Empty array clears (unbend). */
export function setRouteWaypoints(
  world: WorldState,
  states: ReadonlyMap<string, IslandState>,
  routeId: string,
  waypoints: ReadonlyArray<{ x: number; y: number }>,
): SetWaypointsResult {
  const route = world.routes.find((r) => r.id === routeId);
  if (!route) return { ok: false, error: 'route not found' };
  if (route.draining) return { ok: false, error: 'route is draining' };
  if (!isBendableRouteType(route.type)) return { ok: false, error: 'route type cannot be bent' };
  const srcState = states.get(route.from);
  if (!srcState) return { ok: false, error: 'source island state missing' };
  if (tierForLevel(srcState.level) < 5) return { ok: false, error: 'source island not T5' };
  if (waypoints.length > MAX_ROUTE_BENDS) return { ok: false, error: `at most ${MAX_ROUTE_BENDS} bend points` };
  for (const w of waypoints) {
    if (typeof w.x !== 'number' || typeof w.y !== 'number' || !Number.isFinite(w.x) || !Number.isFinite(w.y)) {
      return { ok: false, error: 'waypoint coords must be finite numbers' };
    }
  }
  route.waypoints = waypoints.length > 0 ? waypoints.map((w) => ({ x: w.x, y: w.y })) : undefined;
  return { ok: true, route };
}
```

Add `tierForLevel` to the `./skilltree.js` import in routes.ts.

In `retargetRoute`, ensure the new route has no waypoints (it's created fresh via `createRouteFromBuilding`, which doesn't set them — confirm; no change needed but add a test asserting a retargeted route has no waypoints).

- [ ] **Step 4: Run, verify PASS + typecheck.**

- [ ] **Step 5: Commit** — `feat(routes): pure setRouteWaypoints with T5/type/≤4 gating + unbend (#118)`.

---

### Task 5: LOCAL gateway `setRouteWaypoints` (`mutation-gateway.ts`)

**Files:**
- Modify: `src/mutation-gateway.ts` (interface ~211-225; LOCAL impl near `retargetRoute` ~737; REMOTE impl near the matching REMOTE block)
- Test: `src/mutation-gateway.test.ts` (LOCAL path)

**Interfaces:**
- Produces (on the gateway interface): `setRouteWaypoints(routeId: string, waypoints: ReadonlyArray<{ x: number; y: number }>): GatewayReturn;`
- Consumes: pure `setRouteWaypoints` (Task 4).

- [ ] **Step 1: Write failing test** — model on existing `retargetRoute`/`setRouteMode` gateway LOCAL tests in `src/mutation-gateway.test.ts`: build a LOCAL gateway, a T5 cargo route, call `gateway.setRouteWaypoints(id, [{x,y}])`, assert ok + `route.waypoints` set; call with `[]`, assert cleared; assert a non-T5 route returns the error.

- [ ] **Step 2: Run, verify FAIL.**

- [ ] **Step 3: Implement** — import pure fn as `setRouteWaypoints as setRouteWaypointsPure`. Add to the interface and the LOCAL impl object:

```ts
setRouteWaypoints(routeId, waypoints) {
  const r = setRouteWaypointsPure(world, islandStates, routeId, waypoints);
  return r.ok ? ok() : err(r.error);
},
```
(Match how `retargetRoute` reads `world`/state in this file — use the same state map identifier the LOCAL block already closes over.)

For the REMOTE impl, emit the intent (match the REMOTE pattern used by `retargetRoute`/`setRouteMode` in this file):
```ts
setRouteWaypoints(routeId, waypoints) {
  return sendIntent('set-route-waypoints', { routeId, waypoints });
},
```
(Use the file's actual REMOTE intent-send helper name — grep the REMOTE block for how `set-route-mode` is emitted and mirror it exactly, including return type.)

- [ ] **Step 4: Run, verify PASS + `npx tsc -b --noEmit`.**

- [ ] **Step 5: Commit** — `feat(gateway): setRouteWaypoints (LOCAL pure + REMOTE intent) (#118)`.

---

### Task 6: Server `set-route-waypoints` intent (`server/src/game/intents.ts`)

**Files:**
- Modify: `server/src/game/intents.ts` (add an intent next to `set-route-mode` ~885; import the pure fn)
- Test: `server/src/game/intents.test.ts`

**Interfaces:**
- Consumes: pure `setRouteWaypoints` from the client `routes` module (the server imports shared pure logic — confirm the existing import path for `retargetRoute`/`createRouteFromBuilding` at the top of `intents.ts` and add `setRouteWaypoints` there).

- [ ] **Step 1: Write failing test** — in `server/src/game/intents.test.ts`, model on the existing `retarget-route` / `set-route-mode` intent tests: apply `set-route-waypoints` with a valid `{ routeId, waypoints:[{x,y}] }` on a T5 route → ok + waypoints set; apply with 5 waypoints → error; apply with malformed point → error; apply with `[]` → unbend.

- [ ] **Step 2: Run, verify FAIL** — `cd server && npm test -- intents` (or the file path).

- [ ] **Step 3: Implement**

```ts
// next to 'set-route-mode'
'set-route-waypoints': {
  apply(game: LiveGame, payload: unknown): IntentResult {
    if (!isRecord(payload)) return { ok: false, error: 'malformed payload' };
    const { routeId, waypoints } = payload;
    if (typeof routeId !== 'string') return { ok: false, error: 'routeId must be a string' };
    if (!Array.isArray(waypoints)) return { ok: false, error: 'waypoints must be an array' };
    const pts: Array<{ x: number; y: number }> = [];
    for (const w of waypoints) {
      if (!isRecord(w) || typeof w.x !== 'number' || typeof w.y !== 'number'
        || !Number.isFinite(w.x) || !Number.isFinite(w.y)) {
        return { ok: false, error: 'each waypoint must be { x:number, y:number }' };
      }
      pts.push({ x: w.x, y: w.y });
    }
    const r = setRouteWaypoints(game.world, game.islandStates, routeId, pts);
    return r.ok ? { ok: true } : { ok: false, error: r.error };
  },
},
```
(Use the same `game.islandStates` accessor the surrounding intents use for per-island state — grep an intent that reads island state, e.g. one using `tierForLevel`/`resolveRoute`, and match it. If states live under a different field, use that field.)

Add `setRouteWaypoints` to the existing `from '…/routes.js'` import.

- [ ] **Step 4: Run, verify PASS + `cd server && npm run typecheck`.**

- [ ] **Step 5: Commit** — `feat(server): set-route-waypoints intent mirroring the pure gate (#118)`.

---

### Task 7: Persistence v26 — serialize waypoints + migration (`persistence.ts`)

**Files:**
- Modify: `src/persistence.ts` (`SCHEMA_VERSION` ~78; `SUPPORTED_LOAD_VERSIONS` ~86; route serialize/deserialize; add `SerializedSnapshotV25` alias + `migrateV25toV26`; wire into `loadWorld` chain)
- Test: `src/persistence.test.ts`

**Interfaces:**
- Consumes: `Route.waypoints` (Task 2).

- [ ] **Step 1: Write failing tests**

```ts
test('v26: a bent route round-trips its waypoints', () => {
  // serialize a world whose route has waypoints:[{x:10,y:20}], parse back,
  // expect the loaded route.waypoints to equal it.
});
test('v25 fixture migrates to v26 with straight routes (no waypoints)', () => {
  // craft a v25 snapshot (v:25) with one route lacking waypoints; loadWorld
  // succeeds and the route has no waypoints.
});
test('SCHEMA_VERSION is 26 and 26 is in SUPPORTED_LOAD_VERSIONS', () => {
  expect(SCHEMA_VERSION).toBe(26);
  expect(SUPPORTED_LOAD_VERSIONS.has(26)).toBe(true);
});
```

- [ ] **Step 2: Run, verify FAIL.**

- [ ] **Step 3: Implement** — follow AGENTS.md "Persistence migrations" exactly:
  1. `export const SCHEMA_VERSION = 26 as const;`
  2. Add `26` to `SUPPORTED_LOAD_VERSIONS`.
  3. In the route serializer, include `waypoints` only when present/non-empty: `...(r.waypoints && r.waypoints.length ? { waypoints: r.waypoints.map(w => ({ x: w.x, y: w.y })) } : {})`.
  4. In the route deserializer, read `waypoints` back onto the route (optional).
  5. Add `type SerializedSnapshotV25 = …` capturing the pre-waypoints route shape (copy the current route serialized type, omit `waypoints`).
  6. `function migrateV25toV26(s: SerializedSnapshotV25): SerializedSnapshotV26 { return { ...s, v: 26 }; }` (routes default to no waypoints; if routes are nested, map them through unchanged — no waypoints added).
  7. Wire `migrateV25toV26` into `loadWorld`'s version-dispatch chain (mirror the existing `migrateV24toV25` wiring).

- [ ] **Step 4: Run, verify PASS + typecheck.**

- [ ] **Step 5: Commit** — `feat(persistence): v26 serialize route waypoints + v25→v26 migration (#118)`.

---

### Task 8: Renderer draws polylines + waypoints in cacheKey (`routes-renderer.ts`)

**Files:**
- Modify: `src/routes-renderer.ts` (`perRouteKey` ~88; `buildRouteGeometry` ~140; `updateAnimationOnly` ~209; `paintOverlay` chevrons ~277)
- Test: `src/routes-renderer.test.ts`

**Interfaces:**
- Consumes: `Route.waypoints`, `routePolylinePoints` is NOT used here (renderer resolves island positions in WORLD-PIXEL coords; waypoints are tile coords → multiply by `TILE_PX`). Add a small private helper `routeWorldPoints(r)` returning `[{x,y}...]` in world px: `from`, each `waypoint*TILE_PX`, `to`.

- [ ] **Step 1: Write failing test** — in `routes-renderer.test.ts`, assert the per-route cacheKey changes when `waypoints` changes (mirror the existing cacheKey test). Add `waypoints` to the test's not-visual whitelist classification per the VISUAL-FIELD-MARKER contract (the test enforces every Route field is classified visual/not-visual — add `waypoints` to the VISUAL set).

```ts
test('changing waypoints invalidates the per-route cacheKey (rebuild) (#118)', () => {
  // build renderer with one straight route; update(); capture cacheKey;
  // set route.waypoints=[{x,y}]; update(); expect cacheKey changed.
});
```

- [ ] **Step 2: Run, verify FAIL.**

- [ ] **Step 3: Implement**
  - Add `route.waypoints` (length + serialized coords) to `perRouteKey`: append `|${r.waypoints?.map(w=>`${w.x},${w.y}`).join(';') ?? ''}`.
  - Store the resolved world-px polyline on `RouteRenderState` (add `points: Array<{x:number;y:number}>`), built in diffRebuild from `from`, `waypoints.map(w => ({x:w.x*TILE_PX, y:w.y*TILE_PX}))`, `to`. Import `TILE_PX` from `./island.js` (confirm export site).
  - `buildRouteGeometry` + `updateAnimationOnly`: stroke segment-by-segment over `entry.points` (moveTo first, lineTo the rest) instead of a single from→to line. For the animated texture matrix, use each segment's own angle (rotate per segment) — loop segments, restroking each. Keep it simple: one `stroke()` call after building the full polyline path is fine for the static/animated line; the dash scroll matrix can use the first→last angle as an approximation, OR stroke per segment with per-segment matrix. Prefer per-segment for correctness.
  - `paintOverlay` chevrons: interpolate along cumulative polyline length. Compute segment lengths over `entry.points`; for a batch fraction `t∈[0,1]`, find the segment containing `t*totalLen` and place the chevron there with that segment's direction.

- [ ] **Step 4: Run, verify PASS + typecheck.** Also run the full `routes-renderer.test.ts`.

- [ ] **Step 5: Commit** — `feat(routes-ui): render routes as bent polylines + waypoints in render cacheKey (#118)`.

---

### Task 9: Pure bend hit-testing (`route-bend.ts`)

**Files:**
- Create: `src/route-bend.ts`
- Test: `src/route-bend.test.ts`

**Interfaces:**
- Produces (all coords in **tile** space):
  - `distPointToSegment(px, py, ax, ay, bx, by): number`
  - `pickWaypointAt(route: Route, x: number, y: number, tolTiles: number): number | null` (index into `route.waypoints`)
  - `pickRouteAt(routes: ReadonlyArray<Route>, islandIndex: Map<string, IslandSpec>, x: number, y: number, tolTiles: number): Route | null` (nearest bendable route within tol; ties → smallest distance)
  - `insertBendOnSegment(route: Route, islandIndex: Map<string, IslandSpec>, x: number, y: number): Array<{ x: number; y: number }>` (new waypoints array with a point inserted at the nearest segment's index; if already at MAX_ROUTE_BENDS, returns the existing waypoints unchanged)
- Consumes: `routePolylinePoints`, `isBendableRouteType`, `MAX_ROUTE_BENDS` (Task 2).

- [ ] **Step 1: Write failing tests**

```ts
import { distPointToSegment, pickWaypointAt, pickRouteAt, insertBendOnSegment } from './route-bend.js';

test('distPointToSegment: perpendicular distance', () => {
  expect(distPointToSegment(5, 3, 0, 0, 10, 0)).toBeCloseTo(3, 5);
});
test('pickWaypointAt returns the index of a nearby waypoint', () => {
  const r = { /* cargo route with waypoints:[{x:20,y:20}] */ } as Route;
  expect(pickWaypointAt(r, 21, 19, 3)).toBe(0);
  expect(pickWaypointAt(r, 100, 100, 3)).toBeNull();
});
test('pickRouteAt finds a bendable route the click is near, ignores teleporter', () => {});
test('insertBendOnSegment inserts at the correct segment index', () => {
  // straight a(0,0)->b(40,0); click near (10,2) inserts wp at index 0 → [{~10,~2}]
});
test('insertBendOnSegment is a no-op at MAX_ROUTE_BENDS', () => {});
```

- [ ] **Step 2: Run, verify FAIL.**

- [ ] **Step 3: Implement** `src/route-bend.ts` (pure, no Pixi/DOM):

```ts
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
```

- [ ] **Step 4: Run, verify PASS + typecheck.**

- [ ] **Step 5: Commit** — `feat(routes): pure bend hit-testing (pick route/waypoint, insert bend) (#118)`.

---

### Task 10: Bend overlay (`route-bend-overlay.ts`)

**Files:**
- Create: `src/route-bend-overlay.ts`
- Test: `src/route-bend-overlay.test.ts` (pure handle-geometry only)

**Interfaces:**
- Produces:
  - pure `handleWorldPositions(route: Route, islandIndex: Map<string, IslandSpec>, tilePx: number): Array<{ x: number; y: number }>` (world-px positions of each waypoint handle)
  - `class RouteBendOverlay { readonly layer: Container; setSelected(route: Route | null, islandIndex: Map<string, IslandSpec>): void; update(): void; dispose(): void }`
- Consumes: `Route`, `routePolylinePoints`.

- [ ] **Step 1: Write failing test** (pure geometry only — render code is read-only and not unit-tested per AGENTS.md):

```ts
import { handleWorldPositions } from './route-bend-overlay.js';
test('handleWorldPositions returns each waypoint scaled to world px', () => {
  const i = new Map([['a', { id:'a', cx:0, cy:0 } as any], ['b', { id:'b', cx:40, cy:0 } as any]]);
  const r = { id:'r', from:'a', to:'b', type:'cargo', waypoints:[{x:10,y:5}] } as any;
  expect(handleWorldPositions(r, i, 24)).toEqual([{ x: 240, y: 120 }]);
});
```

- [ ] **Step 2: Run, verify FAIL.**

- [ ] **Step 3: Implement** — pure `handleWorldPositions` plus a thin Pixi `RouteBendOverlay` that, given the selected route, draws: a highlighted polyline (faint) + a filled circle handle at each waypoint position and a smaller "add" affordance dot at each segment midpoint. Model the container/layer + dispose pattern on `RouteRenderer` (constructor builds a `Graphics`, `update()` clears+redraws, `dispose()` destroys). `setSelected(null, …)` hides everything.

- [ ] **Step 4: Run, verify PASS + typecheck.**

- [ ] **Step 5: Commit** — `feat(routes-ui): bend-handle overlay for the selected route (#118)`.

---

### Task 11: Wire map gestures + weather overlay + Unbend-all button (`main.ts`, `routes-ui.ts`)

**Files:**
- Modify: `src/main.ts` (pointer handlers ~746-870, ticker overlay wiring, mode mutual-exclusion)
- Modify: `src/routes-ui.ts` (selected-route row → "Unbend all" button)
- Modify: `src/world.ts` or wherever the weather-overlay toggle lives (auto-show while a route is selected)

**Interfaces:**
- Consumes: `pickRouteAt`, `pickWaypointAt`, `insertBendOnSegment` (Task 9), `RouteBendOverlay` (Task 10), `gateway.setRouteWaypoints` (Task 5), `MAX_ROUTE_BENDS`.

This task is integration glue; verify by build + manual smoke-test (no new unit test — render/DOM/input wiring is not unit-tested per AGENTS.md, but keep logic delegated to the pure Task 9/10 functions so it stays trivial).

- [ ] **Step 1: Add bend-edit state to `main.ts`**: `let selectedBendRouteId: string | null = null;` plus a `RouteBendOverlay` instance parented under `world` (next to the `RouteRenderer` wiring). A small drag-state object `{ kind: 'waypoint'|'segment'|null, index: number, preview: {x,y}[] }`.

- [ ] **Step 2: mousedown handler** (button 0, NOT in placement/launch modes): convert to world tile via `screenToWorldTile`. If a route is already selected: `pickWaypointAt` on it → begin waypoint drag (record index); else if click is on the selected route's polyline (`pickRouteAt` returns it) → begin segment-insert drag (compute insert index via `insertBendOnSegment`, seed preview). Otherwise `pickRouteAt` over all routes → if hit, set `selectedBendRouteId`, show weather overlay; if miss, clear selection + hide overlay. Use the existing `accumDrag`/`CLICK_DRAG_PX_MAX` machinery to distinguish click vs drag.

- [ ] **Step 3: mousemove** while dragging a bend: update the preview waypoint position (overlay reads preview). Do NOT commit yet.

- [ ] **Step 4: mouseup**: if a bend drag was in progress, build the final waypoints array (apply the preview into the route's waypoints copy) and commit via `gateway.setRouteWaypoints(selectedBendRouteId, finalWaypoints)`. If the gesture was a click (`accumDrag < CLICK_DRAG_PX_MAX`) on an existing handle → remove that waypoint (`waypoints.filter((_,i)=>i!==idx)`) and commit.

- [ ] **Step 5: Mutual exclusion** — entering placement/drone-launch/settlement/orbital modes clears `selectedBendRouteId` + hides the overlay (add to their existing `onLaunchModeChanged`/activation callbacks); entering bend selection is implicit (no mode button) so just guard the mousedown branch to no-op when any of those modes is active.

- [ ] **Step 6: Weather overlay auto-show** — when `selectedBendRouteId` is set, force the weather overlay visible (grep how the weather overlay visibility is toggled — likely a `*-overlay.ts` `setVisible`/a UI action; call it). Restore prior visibility on deselect.

- [ ] **Step 7: "Unbend all" button** in `routes-ui.ts` — in `renderLedgerRow`, for a bendable route with `waypoints?.length`, add a button that calls `deps.gateway.setRouteWaypoints(route.id, [])`. (Confirm the routes-ui `deps` exposes the gateway; if not, thread it like the existing delete/retarget calls do.)

- [ ] **Step 8: Pass `selectedBendRouteId` + preview into `RouteBendOverlay.setSelected`/`update`** each ticker frame; pass `world.routes` + island index.

- [ ] **Step 9: Build** — `npm run build` clean. **Smoke-test**: `npm run build` then reload the browser tab; screenshot via `mcp__daedalus__screenshot` to confirm a route can be selected, bent, and unbent, with the weather overlay showing. (Per AGENTS.md: do NOT restart `robot-islands-dev.service`; just rebuild + reload.)

- [ ] **Step 10: Commit** — `feat(routes-ui): map gestures for bend/unbend on placed routes + Unbend-all + weather overlay (#118)`.

---

### Task 12: SPEC.md update

**Files:**
- Modify: `SPEC.md` (§2.4 route tiers, §2.6 weather modulation)

- [ ] **Step 1**: In §2.6, document that a route may carry up to 4 bend points (polyline ≤5 segments), that weather capacity throttle + in-flight loss are sampled along the bent polyline, and transit time scales with total bent length. Gate: source island T5; bendable types = cargo/drone/airship/mass_driver (not teleporter/power links). Bends are edited on placed routes only (click-select, drag-bend, click-handle-remove, Unbend-all), never during creation. Enforced server-side (≤4, T5, type) via the `set-route-waypoints` intent.

- [ ] **Step 2**: In §2.4, note the optional `waypoints` on the route model and the persistence v26 bump.

- [ ] **Step 3: Commit** — `docs(spec): §2.4/§2.6 route bending (#118)`.

---

## Self-Review

- **Spec coverage:** waypoints model (T2), polyline weather throttle + loss (T1/T2/T3), transit scaling (T2/T3), T5/type/≤4 gate (T4), gateway (T5), server intent (T6), persistence migration (T7), polyline render (T8), hit-testing (T9), overlay (T10), map gestures + unbend + weather overlay (T11), SPEC (T12). All design sections covered.
- **Placeholder scan:** Tasks 3 and 11 intentionally describe integration steps where exact surrounding identifiers must be confirmed by grep in the target file (the plan says which symbol to mirror) — these are not placeholders for *behavior*, which is fully specified; they acknowledge the implementer must match existing local names. All code-producing pure tasks (1,2,4,9,10) carry complete code.
- **Type consistency:** `setRouteWaypoints(world, states, routeId, waypoints)` signature identical across pure (T4), gateway (T5), server (T6). `routePolylinePoints`/`routeBentLengthTiles`/`effectiveTransitTimeSec` consumed by T3/T8/T9 match T2 definitions. `MAX_ROUTE_BENDS`/`isBendableRouteType` consistent across T2/T4/T9.
- **Coords:** pure layer + hit-testing in tile coords; renderer/overlay convert to world px via `TILE_PX`. Consistent.
