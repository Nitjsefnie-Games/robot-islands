# Building-gated tiered routes — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let the player obtain higher-tier inter-island routes (drone/airship/mass_driver/teleporter) by placing transport buildings, instead of every route being hardcoded T1 cargo.

**Architecture:** A route is owned by a transport building (`Route.sourceBuildingId`); the building's def determines the route's tier (capacity + transit speed). The route form gains a building sub-select; demolishing a building drains its route. All tier logic is pure helpers in `routes.ts` (TDD); `routes-ui.ts` and `main.ts` only wire UI to them.

**Tech Stack:** TypeScript (strict), Vite 5, PixiJS 8, vitest. Pure layer is unit-tested; render layer is verified live via the daedalus browser extension.

**Spec:** `docs/superpowers/specs/2026-05-22-route-tiers-design.md`

---

## File structure

| File | Change |
|---|---|
| `src/routes.ts` | Add per-tier constants, `RouteProfile` + `routeProfileForBuilding`, `Route.sourceBuildingId`, `createRouteFromBuilding`, `eligibleTransportBuildings`, `islandHasTeleporterPad`, `drainRoutesForBuilding`. |
| `src/routes.test.ts` | New tests for every helper above; fix one stale `mass_driver` assertion. |
| `src/routes-ui.ts` | Form gains a building sub-select; ledger gains an island filter. |
| `src/main.ts` | `onDemolish` drains the demolished building's route. |

`persistence.ts` needs **no change** — `sourceBuildingId` is optional and rides the existing `...r` spread in the snapshot/restore paths, exactly as `draining` does.

---

## Task 1: routes.ts data model — tier profiles

**Files:**
- Modify: `src/routes.ts` (constants block ~line 100-145; `Route` interface ~line 78-101)
- Modify: `src/routes.test.ts` (imports ~line 10-23; assertion at line 1009)
- Test: `src/routes.test.ts`

- [ ] **Step 1: Write the failing test**

Append to `src/routes.test.ts`:

```ts
describe('routeProfileForBuilding', () => {
  it('maps each transport building to its tier profile', () => {
    expect(routeProfileForBuilding('dock')).toEqual(
      { type: 'cargo', capacityPerSec: 0.5, speedTilesPerSec: 1 });
    expect(routeProfileForBuilding('dronepad')).toEqual(
      { type: 'drone', capacityPerSec: 1.0, speedTilesPerSec: 2 });
    expect(routeProfileForBuilding('airship_dock')).toEqual(
      { type: 'airship', capacityPerSec: 2.0, speedTilesPerSec: 4 });
    expect(routeProfileForBuilding('mass_driver')).toEqual(
      { type: 'mass_driver', capacityPerSec: 10.0, speedTilesPerSec: 8 });
    expect(routeProfileForBuilding('teleporter_pad')).toEqual(
      { type: 'teleporter', capacityPerSec: 5.0, speedTilesPerSec: 0 });
  });
  it('returns null for a non-transport building', () => {
    expect(routeProfileForBuilding('logger')).toBeNull();
    expect(routeProfileForBuilding('workshop')).toBeNull();
  });
});
```

Add `routeProfileForBuilding` to the existing `import { ... } from './routes.js';` block at the top of the file.

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/routes.test.ts -t routeProfileForBuilding`
Expected: FAIL — `routeProfileForBuilding is not a function` / TS compile error.

- [ ] **Step 3: Implement constants + helper**

In `src/routes.ts`: add a type-only import near the other imports:

```ts
import type { BuildingDefId } from './building-defs.js';
```

In the constants block, **change** the existing line
`export const MASS_DRIVER_CAPACITY_UNITS_PER_SEC = 2.5;` to:

```ts
export const MASS_DRIVER_CAPACITY_UNITS_PER_SEC = 10.0;
```

(Update its comment: the value is now 5 × airship per §9.5, no longer the cargo×5 placeholder.)

Add these new constants alongside it:

```ts
/** §2.4 T2 drone cargo — placeholder progression (Appendix A). */
export const DRONE_CARGO_CAPACITY_UNITS_PER_SEC = 1.0;
export const DRONE_CARGO_SPEED_TILES_PER_SEC = 2;
/** §2.4 T3 airship cargo — placeholder progression (Appendix A). */
export const AIRSHIP_CARGO_CAPACITY_UNITS_PER_SEC = 2.0;
export const AIRSHIP_CARGO_SPEED_TILES_PER_SEC = 4;
/** §9.5 Mass Driver transit speed (capacity constant is above). */
export const MASS_DRIVER_SPEED_TILES_PER_SEC = 8;
/** §2.4 T4 teleporter — instant transit (speed 0), high throughput. */
export const TELEPORTER_CARGO_CAPACITY_UNITS_PER_SEC = 5.0;
```

Add the profile type + map + helper (place after the constants block, before the "Route id generation" section):

```ts
/** Tier characteristics a transport building confers on the route it hosts. */
export interface RouteProfile {
  readonly type: RouteType;
  readonly capacityPerSec: number;
  /** Tiles/sec for transit-time computation. 0 = instant (teleporter). */
  readonly speedTilesPerSec: number;
}

/** defId → tier profile. A defId absent here is not a transport building. */
const ROUTE_PROFILES: Partial<Record<BuildingDefId, RouteProfile>> = {
  dock:           { type: 'cargo',       capacityPerSec: T1_CARGO_CAPACITY_UNITS_PER_SEC,        speedTilesPerSec: T1_CARGO_SPEED_TILES_PER_SEC },
  dronepad:       { type: 'drone',       capacityPerSec: DRONE_CARGO_CAPACITY_UNITS_PER_SEC,     speedTilesPerSec: DRONE_CARGO_SPEED_TILES_PER_SEC },
  airship_dock:   { type: 'airship',     capacityPerSec: AIRSHIP_CARGO_CAPACITY_UNITS_PER_SEC,   speedTilesPerSec: AIRSHIP_CARGO_SPEED_TILES_PER_SEC },
  mass_driver:    { type: 'mass_driver', capacityPerSec: MASS_DRIVER_CAPACITY_UNITS_PER_SEC,     speedTilesPerSec: MASS_DRIVER_SPEED_TILES_PER_SEC },
  teleporter_pad: { type: 'teleporter',  capacityPerSec: TELEPORTER_CARGO_CAPACITY_UNITS_PER_SEC, speedTilesPerSec: 0 },
};

/** The route tier a transport building hosts, or null if `defId` is not a
 *  transport building. */
export function routeProfileForBuilding(defId: BuildingDefId): RouteProfile | null {
  return ROUTE_PROFILES[defId] ?? null;
}
```

Also add the optional field to the `Route` interface (after `inFlight` / `draining`):

```ts
  /** PlacedBuilding id of the transport building that owns this route.
   *  Absent on legacy saved routes (grandfathered as plain cargo). */
  sourceBuildingId?: string;
```

- [ ] **Step 4: Fix the stale mass_driver assertion**

In `src/routes.test.ts` line ~1009, change:

```ts
    expect(MASS_DRIVER_CAPACITY_UNITS_PER_SEC).toBeCloseTo(2.5, 9);
```

to:

```ts
    expect(MASS_DRIVER_CAPACITY_UNITS_PER_SEC).toBeCloseTo(10.0, 9);
```

(The other uses of `MASS_DRIVER_CAPACITY_UNITS_PER_SEC` in the file are symbolic and need no change.)

- [ ] **Step 5: Run tests to verify they pass**

Run: `npx vitest run src/routes.test.ts`
Expected: PASS — all routes tests including `routeProfileForBuilding` and the mass_driver suite.

- [ ] **Step 6: Commit**

```bash
git add src/routes.ts src/routes.test.ts
git commit -m "feat(routes): per-tier route profiles + sourceBuildingId field

Co-Authored-By: <model> <noreply@anthropic.com>"
```

---

## Task 2: `createRouteFromBuilding` — pure route constructor

**Files:**
- Modify: `src/routes.ts` (add helper near `transitTimeForDistance`, ~line 757)
- Test: `src/routes.test.ts`

- [ ] **Step 1: Write the failing test**

Append to `src/routes.test.ts`:

```ts
describe('createRouteFromBuilding', () => {
  it('builds an airship route from an Airship Dock', () => {
    const b = { id: 'ad-1', defId: 'airship_dock' as const, x: 0, y: 0 };
    const route = createRouteFromBuilding(b, 'a', 'b', 'iron_ore', 100);
    expect(route).not.toBeNull();
    expect(route!.type).toBe('airship');
    expect(route!.capacityPerSec).toBe(2.0);
    expect(route!.transitTimeSec).toBeCloseTo(25, 9); // 100 tiles / 4 t/s
    expect(route!.sourceBuildingId).toBe('ad-1');
    expect(route!.from).toBe('a');
    expect(route!.to).toBe('b');
    expect(route!.filter).toBe('iron_ore');
    expect(route!.priorityList).toEqual([]);
    expect(route!.inFlight).toEqual([]);
  });
  it('builds an instant teleporter route (transitTimeSec 0)', () => {
    const b = { id: 'tp-1', defId: 'teleporter_pad' as const, x: 0, y: 0 };
    const route = createRouteFromBuilding(b, 'a', 'b', null, 100);
    expect(route!.type).toBe('teleporter');
    expect(route!.transitTimeSec).toBe(0);
    expect(route!.filter).toBeNull();
  });
  it('returns null for a non-transport building', () => {
    const b = { id: 'lg-1', defId: 'logger' as const, x: 0, y: 0 };
    expect(createRouteFromBuilding(b, 'a', 'b', null, 100)).toBeNull();
  });
});
```

Add `createRouteFromBuilding` to the `import { ... } from './routes.js';` block.

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/routes.test.ts -t createRouteFromBuilding`
Expected: FAIL — `createRouteFromBuilding is not a function`.

- [ ] **Step 3: Implement the helper**

In `src/routes.ts`, add a type-only import:

```ts
import type { PlacedBuilding } from './buildings.js';
```

Add the helper near `transitTimeForDistance`:

```ts
/** Construct a route hosted by `building`. The building's def fixes the
 *  route tier (type, capacity, transit speed); `transitTimeSec` is derived
 *  from `distanceTiles`. Returns null if `building` is not a transport
 *  building. The route is created idle (no in-flight cargo, empty priority
 *  list). */
export function createRouteFromBuilding(
  building: PlacedBuilding,
  fromIslandId: string,
  toIslandId: string,
  filter: ResourceId | null,
  distanceTiles: number,
): Route | null {
  const profile = routeProfileForBuilding(building.defId);
  if (profile === null) return null;
  return {
    id: nextRouteId(),
    from: fromIslandId,
    to: toIslandId,
    type: profile.type,
    capacityPerSec: profile.capacityPerSec,
    filter,
    priorityList: [],
    transitTimeSec: transitTimeForDistance(distanceTiles, profile.speedTilesPerSec),
    inFlight: [],
    sourceBuildingId: building.id,
  };
}
```

(`transitTimeForDistance` already returns 0 when `speedTilesPerSec <= 0`, so the teleporter case needs no special handling.)

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run src/routes.test.ts -t createRouteFromBuilding`
Expected: PASS — all three cases.

- [ ] **Step 5: Commit**

```bash
git add src/routes.ts src/routes.test.ts
git commit -m "feat(routes): createRouteFromBuilding pure constructor

Co-Authored-By: <model> <noreply@anthropic.com>"
```

---

## Task 3: form-gating helpers — `eligibleTransportBuildings`, `islandHasTeleporterPad`

**Files:**
- Modify: `src/routes.ts` (add helpers near `createRouteFromBuilding`)
- Test: `src/routes.test.ts`

- [ ] **Step 1: Write the failing test**

Append to `src/routes.test.ts`:

```ts
describe('eligibleTransportBuildings', () => {
  it('lists free transport buildings, excluding non-transport and taken', () => {
    const island = makeIslandSpec('a', 0, 0);
    island.buildings = [
      { id: 'd1', defId: 'dock', x: 0, y: 0 },
      { id: 'd2', defId: 'dock', x: 1, y: 0 },
      { id: 'lg', defId: 'logger', x: 2, y: 0 },
    ];
    const taken = cargoRoute('a', 'b', 'iron_ore');
    taken.sourceBuildingId = 'd1';
    const eligible = eligibleTransportBuildings(island, [taken]);
    expect(eligible.map((b) => b.id)).toEqual(['d2']);
  });
  it('returns all transport buildings when no routes exist', () => {
    const island = makeIslandSpec('a', 0, 0);
    island.buildings = [{ id: 'ad', defId: 'airship_dock', x: 0, y: 0 }];
    expect(eligibleTransportBuildings(island, []).map((b) => b.id)).toEqual(['ad']);
  });
});

describe('islandHasTeleporterPad', () => {
  it('is true only when a teleporter_pad is present', () => {
    const island = makeIslandSpec('a', 0, 0);
    expect(islandHasTeleporterPad(island)).toBe(false);
    island.buildings = [{ id: 't', defId: 'teleporter_pad', x: 0, y: 0 }];
    expect(islandHasTeleporterPad(island)).toBe(true);
  });
});
```

Add `eligibleTransportBuildings` and `islandHasTeleporterPad` to the `import { ... } from './routes.js';` block.

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/routes.test.ts -t eligibleTransportBuildings`
Expected: FAIL — `eligibleTransportBuildings is not a function`.

- [ ] **Step 3: Implement the helpers**

In `src/routes.ts`, add `IslandSpec` to the existing world import:

```ts
import { CELL_SIZE_TILES, type IslandSpec, type WorldState } from './world.js';
```

Add the helpers:

```ts
/** Transport buildings on `island` that can host a NEW route — they have a
 *  route profile and don't already own a route in `routes`. */
export function eligibleTransportBuildings(
  island: IslandSpec,
  routes: ReadonlyArray<Route>,
): PlacedBuilding[] {
  const taken = new Set<string>();
  for (const r of routes) {
    if (r.sourceBuildingId !== undefined) taken.add(r.sourceBuildingId);
  }
  return island.buildings.filter(
    (b) => routeProfileForBuilding(b.defId) !== null && !taken.has(b.id),
  );
}

/** Whether `island` has a Teleporter Pad — the destination-side gate for a
 *  `teleporter` route. */
export function islandHasTeleporterPad(island: IslandSpec): boolean {
  return island.buildings.some((b) => b.defId === 'teleporter_pad');
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run src/routes.test.ts -t "eligibleTransportBuildings|islandHasTeleporterPad"`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/routes.ts src/routes.test.ts
git commit -m "feat(routes): eligibleTransportBuildings + islandHasTeleporterPad gates

Co-Authored-By: <model> <noreply@anthropic.com>"
```

---

## Task 4: `drainRoutesForBuilding` — demolish coupling helper

**Files:**
- Modify: `src/routes.ts` (add helper near `drainRoutesForBuilding` siblings)
- Test: `src/routes.test.ts`

- [ ] **Step 1: Write the failing test**

Append to `src/routes.test.ts`:

```ts
describe('drainRoutesForBuilding', () => {
  it('marks routes owned by the building as draining', () => {
    const r1 = cargoRoute('a', 'b', 'iron_ore'); r1.sourceBuildingId = 'b1';
    const r2 = cargoRoute('a', 'b', 'coal');     r2.sourceBuildingId = 'b2';
    const world = makeWorld([r1, r2]);
    const n = drainRoutesForBuilding(world, 'b1');
    expect(n).toBe(1);
    expect(r1.draining).toBe(true);
    expect(r2.draining).toBeUndefined();
  });
  it('returns 0 when no route is owned by the building', () => {
    const r1 = cargoRoute('a', 'b', 'iron_ore'); r1.sourceBuildingId = 'b1';
    const world = makeWorld([r1]);
    expect(drainRoutesForBuilding(world, 'nope')).toBe(0);
    expect(r1.draining).toBeUndefined();
  });
});
```

Add `drainRoutesForBuilding` to the `import { ... } from './routes.js';` block.

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/routes.test.ts -t drainRoutesForBuilding`
Expected: FAIL — `drainRoutesForBuilding is not a function`.

- [ ] **Step 3: Implement the helper**

In `src/routes.ts`:

```ts
/** Soft-delete every route owned by `buildingId` (set on demolish). The
 *  routes finish their in-flight cargo, then `tickRoutes` prunes them.
 *  Returns the number of routes newly set to draining. */
export function drainRoutesForBuilding(world: WorldState, buildingId: string): number {
  let n = 0;
  for (const r of world.routes) {
    if (r.sourceBuildingId === buildingId && r.draining !== true) {
      r.draining = true;
      n += 1;
    }
  }
  return n;
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run src/routes.test.ts -t drainRoutesForBuilding`
Expected: PASS — both cases.

- [ ] **Step 5: Run the full suite**

Run: `npx vitest run`
Expected: PASS — all test files (no regressions).

- [ ] **Step 6: Commit**

```bash
git add src/routes.ts src/routes.test.ts
git commit -m "feat(routes): drainRoutesForBuilding for demolish coupling

Co-Authored-By: <model> <noreply@anthropic.com>"
```

---

## Task 5: route form — building sub-select (routes-ui.ts)

Render-layer task — no unit test; verified by build + live browser check.

**Files:**
- Modify: `src/routes-ui.ts` (imports ~line 26-33; form DOM ~line 289-309; `buildOptions` ~line 447; `refreshFormReadout` ~line 489; `commissionRoute` ~line 512)

- [ ] **Step 1: Update imports**

In `src/routes-ui.ts`, replace the `import { ... } from './routes.js';` block with:

```ts
import {
  reorderPriorityList,
  transitTimeForDistance,
  routeProfileForBuilding,
  createRouteFromBuilding,
  eligibleTransportBuildings,
  islandHasTeleporterPad,
  type Route,
} from './routes.js';
```

(`nextRouteId` and `T1_CARGO_CAPACITY_UNITS_PER_SEC` are dropped — they are no longer used once `commissionRoute`/`refreshFormReadout` below switch to the profile helpers. `strict` + `noUnusedLocals` will flag them if left.)

Add an import for the building catalog:

```ts
import { BUILDING_DEFS } from './building-defs.js';
```

- [ ] **Step 2: Add the building sub-select to the form**

In `src/routes-ui.ts`, immediately after the `fromRow` block (after `fromRow.appendChild(fromSel);`), add:

```ts
  const buildingRow = document.createElement('div');
  styled(buildingRow, 'display: flex; flex-direction: column; gap: 2px');
  const buildingSel = selectStyled();
  buildingRow.appendChild(labelEl('VIA BUILDING'));
  buildingRow.appendChild(buildingSel);
```

Change the `formWrap.appendChild` sequence so `buildingRow` sits between `fromRow` and `toRow`:

```ts
  formWrap.appendChild(fromRow);
  formWrap.appendChild(buildingRow);
  formWrap.appendChild(toRow);
  formWrap.appendChild(cargoRow);
```

- [ ] **Step 3: Populate the building select**

In `src/routes-ui.ts`, add this function next to `buildOptions` (after it):

```ts
  /** Rebuild the VIA BUILDING select for the currently-selected FROM
   *  island — transport buildings that don't already own a route. */
  function buildBuildingOptions(): void {
    const island = deps.islandSpecs.get(fromSel.value);
    buildingSel.replaceChildren();
    const eligible = island
      ? eligibleTransportBuildings(island, deps.world.routes)
      : [];
    if (eligible.length === 0) {
      const o = document.createElement('option');
      o.value = '';
      o.textContent = '(no transport building free)';
      buildingSel.appendChild(o);
      buildingSel.disabled = true;
      return;
    }
    buildingSel.disabled = false;
    for (const b of eligible) {
      const profile = routeProfileForBuilding(b.defId)!;
      const o = document.createElement('option');
      o.value = b.id;
      o.textContent =
        `${BUILDING_DEFS[b.defId].displayName} · ${profile.type} · ${profile.capacityPerSec} u/s`;
      buildingSel.appendChild(o);
    }
  }
```

At the end of `buildOptions()` (after the cargo options are built), add a call:

```ts
    buildBuildingOptions();
```

Change the `fromSel` change listener so it also rebuilds the building list. Replace:

```ts
  fromSel.addEventListener('change', () => refreshFormReadout());
```

with:

```ts
  fromSel.addEventListener('change', () => {
    buildBuildingOptions();
    refreshFormReadout();
  });
  buildingSel.addEventListener('change', () => refreshFormReadout());
```

- [ ] **Step 4: Replace `refreshFormReadout`**

Replace the whole `refreshFormReadout` function body with:

```ts
  function refreshFormReadout(): void {
    const fromId = fromSel.value;
    const toId = toSel.value;
    const spec1 = deps.islandSpecs.get(fromId);
    const spec2 = deps.islandSpecs.get(toId);
    const building = spec1?.buildings.find((b) => b.id === buildingSel.value) ?? null;
    const profile = building ? routeProfileForBuilding(building.defId) : null;
    const reject = (msg: string): void => {
      formReadout.textContent = msg;
      commitBtn.disabled = true;
      commitBtn.style.opacity = '0.5';
      commitBtn.style.cursor = 'not-allowed';
    };
    if (!spec1 || !spec2) return reject('');
    if (fromId === toId) return reject('pick distinct endpoints');
    if (!building || !profile) return reject('no transport building available');
    if (profile.type === 'teleporter' && !islandHasTeleporterPad(spec2)) {
      return reject('teleporter needs a pad on the destination');
    }
    const dx = spec1.cx - spec2.cx;
    const dy = spec1.cy - spec2.cy;
    const dist = Math.sqrt(dx * dx + dy * dy);
    const transit = transitTimeForDistance(dist, profile.speedTilesPerSec);
    formReadout.textContent =
      `${dist.toFixed(0)} t · ETA ${transit.toFixed(1)}s · ${profile.capacityPerSec} u/s`;
    commitBtn.disabled = false;
    commitBtn.style.opacity = '1';
    commitBtn.style.cursor = 'pointer';
  }
```

- [ ] **Step 5: Replace `commissionRoute`**

Replace the whole `commissionRoute` function body with:

```ts
  function commissionRoute(): void {
    const fromId = fromSel.value;
    const toId = toSel.value;
    const cargoChoice = cargoSel.value;
    const spec1 = deps.islandSpecs.get(fromId);
    const spec2 = deps.islandSpecs.get(toId);
    if (!spec1 || !spec2 || fromId === toId) return;
    const building = spec1.buildings.find((b) => b.id === buildingSel.value);
    if (!building) return;
    const profile = routeProfileForBuilding(building.defId);
    if (!profile) return;
    if (profile.type === 'teleporter' && !islandHasTeleporterPad(spec2)) return;
    const dx = spec1.cx - spec2.cx;
    const dy = spec1.cy - spec2.cy;
    const dist = Math.sqrt(dx * dx + dy * dy);
    const isAny = cargoChoice === '__any__';
    const route = createRouteFromBuilding(
      building, fromId, toId, isAny ? null : (cargoChoice as ResourceId), dist,
    );
    if (!route) return;
    deps.world.routes.push(route);
    refresh(performance.now());
  }
```

(`ResourceId` is already imported in `routes-ui.ts`.)

- [ ] **Step 6: Build**

Run: `npm run build`
Expected: `tsc -b` clean (no unused-import errors), `vite build` succeeds.

- [ ] **Step 7: Live verification**

Run a dev rebuild is already done by Step 6. Reload `https://islands.nitjsefni.eu/` (daedalus tab), open the routes panel (press `R`), and confirm in the NEW ROUTE form:
- A `VIA BUILDING` select appears between FROM and TO.
- Selecting a FROM island repopulates it with that island's transport buildings (or `(no transport building free)`).
- The readout shows the selected tier's capacity; committing creates a route of that tier (check the ledger row's `u/s`).
- With no transport building on the FROM island, the commit button is disabled.

Use `mcp__daedalus__screenshot` against the islands tab to confirm.

- [ ] **Step 8: Commit**

```bash
git add src/routes-ui.ts
git commit -m "feat(routes): route form gates on transport building tier

Co-Authored-By: <model> <noreply@anthropic.com>"
```

---

## Task 6: active ledger — island filter (routes-ui.ts)

Render-layer task — verified by build + live browser check.

**Files:**
- Modify: `src/routes-ui.ts` (ledger header DOM ~line 359-408; `repaintLedger` ~line 559; `buildOptions` ~line 447)

- [ ] **Step 1: Add the filter select to the ledger header**

In `src/routes-ui.ts`, immediately after the `ledgerHead` block is appended (after `ledgerWrap.appendChild(ledgerHead);`), add:

```ts
  const ledgerFilterSel = selectStyled();
  styled(ledgerFilterSel, 'font-size: 10px; padding: 2px 5px; margin: 2px 0 4px');
  ledgerWrap.appendChild(ledgerFilterSel);
```

- [ ] **Step 2: Populate the filter select**

Add this function next to `buildBuildingOptions`:

```ts
  /** Rebuild the ledger island-filter select: "All islands" + each
   *  populated island by name. Preserves the current selection. */
  function buildLedgerFilterOptions(): void {
    const prev = ledgerFilterSel.value;
    ledgerFilterSel.replaceChildren();
    const all = document.createElement('option');
    all.value = '';
    all.textContent = 'All islands';
    ledgerFilterSel.appendChild(all);
    for (const isl of populatedIslands()) {
      const o = document.createElement('option');
      o.value = isl.id;
      o.textContent = isl.name;
      ledgerFilterSel.appendChild(o);
    }
    if (prev && populatedIslands().some((s) => s.id === prev)) {
      ledgerFilterSel.value = prev;
    }
  }
```

At the end of `buildOptions()` (right after the `buildBuildingOptions();` call added in Task 5), add:

```ts
    buildLedgerFilterOptions();
```

Add a change listener after the select is created:

```ts
  ledgerFilterSel.addEventListener('change', () => repaintLedger(performance.now()));
```

- [ ] **Step 3: Filter rows in `repaintLedger`**

In `repaintLedger`, replace the line:

```ts
    const routes = deps.world.routes;
```

with:

```ts
    const filterId = ledgerFilterSel.value;
    const routes = filterId === ''
      ? deps.world.routes
      : deps.world.routes.filter((r) => r.from === filterId);
```

In the same function, change the structural signature line so the filter is part of it (so switching the filter rebuilds the rows):

```ts
    const sig = filterId + '\u001e' + routes.map(routeStructKey).join('\u001e');
```

- [ ] **Step 4: Build**

Run: `npm run build`
Expected: clean.

- [ ] **Step 5: Live verification**

Reload `https://islands.nitjsefni.eu/`, open the routes panel. Confirm a dropdown sits above the ACTIVE list, defaulting to "All islands"; selecting an island narrows the ledger to routes whose source is that island; switching back to "All islands" restores the full list. Screenshot via daedalus.

- [ ] **Step 6: Commit**

```bash
git add src/routes-ui.ts
git commit -m "feat(routes): island filter on the active route ledger

Co-Authored-By: <model> <noreply@anthropic.com>"
```

---

## Task 7: demolish drains the building's route (main.ts)

Integration task — verified by build + live browser check.

**Files:**
- Modify: `src/main.ts` (routes import ~line 100; `onDemolish` handler ~line 1217)

- [ ] **Step 1: Update the routes import**

In `src/main.ts`, change:

```ts
import { computeCableNetworkBalance, tickRoutes } from './routes.js';
```

to:

```ts
import { computeCableNetworkBalance, drainRoutesForBuilding, tickRoutes } from './routes.js';
```

- [ ] **Step 2: Drain the route on demolish**

In the `onDemolish` handler, add the drain call right after the success guard. Change:

```ts
    onDemolish: (target: InspectorTarget) => {
      const result = demolishBuilding(target.spec, target.state, target.building.id);
      if (!result.ok) return;
```

to:

```ts
    onDemolish: (target: InspectorTarget) => {
      const result = demolishBuilding(target.spec, target.state, target.building.id);
      if (!result.ok) return;
      // A transport building's route drains when the building is removed —
      // in-flight cargo finishes, then tickRoutes prunes it.
      drainRoutesForBuilding(worldState, target.building.id);
```

(The rest of the handler — inspector close, selection clear, layer rebuild — is unchanged.)

- [ ] **Step 3: Build**

Run: `npm run build`
Expected: clean.

- [ ] **Step 4: Live verification**

Reload `https://islands.nitjsefni.eu/`. Create a route from a transport building, then demolish that building via the inspector's DEMOLISH button. Confirm the route's ledger row shows `DRAINING` and is removed once its in-flight cargo lands (instantly if it had none). Screenshot via daedalus.

- [ ] **Step 5: Run the full suite**

Run: `npx vitest run`
Expected: PASS — all test files.

- [ ] **Step 6: Commit**

```bash
git add src/main.ts
git commit -m "feat(routes): demolishing a transport building drains its route

Co-Authored-By: <model> <noreply@anthropic.com>"
```

---

## Notes for the implementer

- The `Co-Authored-By` trailer on every commit must name the model that actually authored it (e.g. `Kimi K2.6 <noreply@kimi.com>` for a kimi subagent). One primary-author trailer per commit.
- The dev service serves built `dist/` with no HMR — every live verification needs `npm run build` first, then a manual browser reload. Do **not** restart `robot-islands-dev.service`.
- Tasks 1-4 are pure and fully unit-tested. Tasks 5-7 are render/integration layer: their correctness is confirmed by `npm run build` + a daedalus screenshot, per the repo's pure-layer-only test discipline.
- `settlement.ts`'s three `cargo` route constructors are intentionally left alone — settled-colony routes stay legacy (no `sourceBuildingId`), grandfathered. That is out of scope per the spec.
