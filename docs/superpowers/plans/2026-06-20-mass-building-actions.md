# Mass Building Actions Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let the player select many buildings on one island (shift-click + shift-drag box) and act on them at once — mass destroy, upgrade, group-move, enable/disable, and ignore-cap — by batching the existing per-building gateway operations.

**Architecture:** Selection is pure client UI state owned by `main.ts` (a `Set<buildingId>` + the owning `IslandSpec`). All batch logic lives in a new pure module `mass-actions.ts` (planner, box hit-set, group-relocate validation, ignore-cap union) with full unit coverage. When ≥2 buildings are selected, the inspector delegates its body to a new `inspector-multi.ts` panel whose buttons call `main.ts` callbacks that loop the existing `gateway.*` ops. Group-move adds a sibling mode to `placement-ui.ts`. No new gateway method, no snapshot-schema bump, no migration.

**Tech Stack:** Vite 5 + TypeScript strict + PixiJS 8 + vitest. Pure-layer modules carry no PixiJS imports and are unit-tested; render/DOM wiring is read-only against state and verified by typecheck + build + browser smoke.

## Global Constraints

- TypeScript strict: `strict`, `noUncheckedIndexedAccess`, `noUnusedLocals`, `noUnusedParameters`. New code compiles clean.
- Pure layer (`mass-actions.ts`) imports NO PixiJS. Tests target the pure layer only.
- One responsibility per file; new mechanic → new file (AGENTS.md).
- Every behavior change updates `SPEC.md` in the same change (final task).
- Mutations route through `gateway.*` (REMOTE → WS intents; LOCAL → pure calls). Mass actions add NO new gateway methods — they sequence existing ones.
- Selection scope is a SINGLE island. There is NO max-floor cap (`applyUpgrade` scales cost exponentially past L10 and self-handles queue/affordability/deduction).
- Commit after every task. Branch: `feat/mass-building-actions` cut from `master`.
- Co-author trailer on every commit: `Co-Authored-By: <implementer model> <noreply@…>`.

## Verified existing APIs (consumed, do not reimplement)

```ts
// placement.ts
parallelBuildSlots(state): number
inProgressBuildCount(state): number
queuedBuildSlots(state): number
queuedBuildCount(state): number
upgradeCost(def, targetLevel?): Partial<Record<ResourceId, number>>
topUpgradeLevel(state, b): number                 // raw floor + queued upgrades
relocateFee(b, def): Partial<Record<ResourceId, number>>
affordabilityShortfall(inventory, cost): Partial<Record<ResourceId, number>>  // empty ⇒ affordable
validatePlacement(spec, state, defId, localX, localY, rotation, graph, ignoreBuildingId?, skipCostGate?): { ok: boolean; reason?: PlacementReason }
// floor-levels.ts
rawFloorLevel(b): number                          // displayed floor = raw + 1
// shape-mask.ts
footprintTiles(footprint, x, y, rotation): { x: number; y: number }[]   // island-local tiles
// recipes.ts
resolveRecipe(def, building, terrainAt): Recipe   // .outputs: Partial<Record<ResourceId, number>>
// constants
CELL_SIZE_TILES, shapeWidth(footprint), shapeHeight(footprint)   // ocean defs use cell units
// gateway (MutationGateway) — all return GatewayReturn (sync GatewayResult OR Promise)
gateway.demolishBuilding(islandId, buildingId)
gateway.applyUpgrade(islandId, buildingId, spendToken?)   // {ok:false, reason:'queue-full'} when full
gateway.relocateBuilding(islandId, buildingId, x, y, rotation)
gateway.setBuildingActiveFloors(islandId, buildingId, disabledFloors)
gateway.setIgnoreCap(islandId, buildingId, resource, value)
```

`applyUpgrade` eligibility: a building is a mass-upgrade candidate iff it is operational (`(b.constructionRemainingMs ?? 0) <= 0` and `b.queued !== true`). Disable-all uses `disabledFloors = rawFloorLevel(b) + 1`; enable uses `0`.

## File structure

| File | Responsibility |
|---|---|
| `src/mass-actions.ts` **(new, pure)** | `buildingFootprintTilesWorld`, `buildingsInBox`, `planMassUpgrade`, `validateGroupRelocate`, `groupRelocateFee`, `ignoreCapUnion`, `selectionBreakdown`. |
| `src/mass-actions.test.ts` **(new)** | Unit tests for every pure helper above. |
| `src/inspector-multi.ts` **(new)** | DOM panel for ≥2 selection: breakdown + action buttons + ignore-cap checkboxes. Calls injected callbacks. |
| `src/main.ts` **(modify)** | Selection `Set` + `selectionSpec`; shift-click toggle; shift-drag box mode + overlay; multi-outline render; mount inspector-multi; mass-action callbacks (loops over gateway). |
| `src/inspector-ui.ts` **(modify)** | Hide/yield when multi-mode active (main.ts decides which panel shows). |
| `src/placement-ui.ts` **(modify)** | `beginGroupRelocate(members)` sibling mode; group ghost + all-or-nothing commit. |
| `SPEC.md` **(modify)** | New §4 subsection documenting the model + algorithms. |

---

### Task 1: Pure helper — building world-tile footprint + box hit-set

**Files:**
- Create: `src/mass-actions.ts`
- Test: `src/mass-actions.test.ts`

**Interfaces:**
- Consumes: `footprintTiles`, `CELL_SIZE_TILES`, `shapeWidth`, `shapeHeight`, `BUILDING_DEFS`, `IslandSpec`, `PlacedBuilding`, `Rotation`.
- Produces:
  - `buildingFootprintTilesWorld(spec: IslandSpec, b: PlacedBuilding): { x: number; y: number }[]` — building footprint in WORLD tile coords (island-local + `spec.cx/cy`), branching ocean (cell-unit bbox) vs land (`footprintTiles`). Mirrors `paintBuildingOutline` in `main.ts`.
  - `interface TileBox { x0: number; y0: number; x1: number; y1: number }` — inclusive world-tile bounds (normalized so x0≤x1, y0≤y1).
  - `buildingsInBox(spec: IslandSpec, box: TileBox): string[]` — ids of buildings on `spec` whose footprint intersects `box` (any tile inside).

- [ ] **Step 1: Write failing tests**

```ts
import { describe, it, expect } from 'vitest';
import { buildingFootprintTilesWorld, buildingsInBox } from './mass-actions.js';
import type { IslandSpec } from './world.js';
import type { PlacedBuilding } from './buildings.js';

function spec(buildings: PlacedBuilding[]): IslandSpec {
  return { id: 'i1', cx: 100, cy: 200, buildings } as unknown as IslandSpec;
}
function b(id: string, defId: string, x: number, y: number): PlacedBuilding {
  return { id, defId, x, y, floorLevel: 0 } as unknown as PlacedBuilding;
}

describe('buildingFootprintTilesWorld', () => {
  it('offsets a land 1x1 footprint by the island centre', () => {
    const tiles = buildingFootprintTilesWorld(spec([]), b('a', 'mine', 3, -4));
    expect(tiles).toContainEqual({ x: 103, y: 196 });
  });
});

describe('buildingsInBox', () => {
  it('includes a building whose tile falls inside the box, excludes others', () => {
    const s = spec([b('a', 'mine', 0, 0), b('b', 'mine', 20, 20)]);
    const hit = buildingsInBox(s, { x0: 99, y0: 199, x1: 105, y1: 205 });
    expect(hit).toEqual(['a']);
  });
  it('normalizes a box dragged up-left', () => {
    const s = spec([b('a', 'mine', 0, 0)]);
    expect(buildingsInBox(s, { x0: 105, y0: 205, x1: 99, y1: 199 })).toEqual(['a']);
  });
});
```

- [ ] **Step 2: Run to verify fail** — `npx vitest run src/mass-actions.test.ts` → FAIL (module not found).

- [ ] **Step 3: Implement** (`src/mass-actions.ts`)

```ts
// Pure batch-action logic for multi-building selection (§4 mass actions).
// NO PixiJS imports — unit-tested leaf module.
import { BUILDING_DEFS } from './building-defs.js';
import { footprintTiles } from './shape-mask.js';
import { CELL_SIZE_TILES, shapeWidth, shapeHeight } from './shape-mask.js';
import type { Rotation } from './shape-mask.js';
import type { IslandSpec } from './world.js';
import type { PlacedBuilding } from './buildings.js';

/** World-tile footprint of a building (island-local tiles shifted by spec.cx/cy).
 *  Ocean defs use CELL-unit footprints (1 cell = CELL_SIZE_TILES tiles); land
 *  defs use the shape-mask tiles. Mirrors paintBuildingOutline in main.ts. */
export function buildingFootprintTilesWorld(
  spec: IslandSpec,
  b: PlacedBuilding,
): { x: number; y: number }[] {
  const def = BUILDING_DEFS[b.defId];
  if (def.oceanPlacement === true) {
    const w = shapeWidth(def.footprint) * CELL_SIZE_TILES;
    const h = shapeHeight(def.footprint) * CELL_SIZE_TILES;
    const out: { x: number; y: number }[] = [];
    for (let dx = 0; dx < w; dx++)
      for (let dy = 0; dy < h; dy++) out.push({ x: spec.cx + b.x + dx, y: spec.cy + b.y + dy });
    return out;
  }
  return footprintTiles(def.footprint, b.x, b.y, (b.rotation ?? 0) as Rotation).map((t) => ({
    x: spec.cx + t.x,
    y: spec.cy + t.y,
  }));
}

export interface TileBox { x0: number; y0: number; x1: number; y1: number }

function norm(box: TileBox): TileBox {
  return {
    x0: Math.min(box.x0, box.x1), x1: Math.max(box.x0, box.x1),
    y0: Math.min(box.y0, box.y1), y1: Math.max(box.y0, box.y1),
  };
}

/** Ids of buildings on `spec` with any footprint tile inside `box` (world tiles). */
export function buildingsInBox(spec: IslandSpec, box: TileBox): string[] {
  const n = norm(box);
  const out: string[] = [];
  for (const b of spec.buildings) {
    const tiles = buildingFootprintTilesWorld(spec, b);
    if (tiles.some((t) => t.x >= n.x0 && t.x <= n.x1 && t.y >= n.y0 && t.y <= n.y1)) out.push(b.id);
  }
  return out;
}
```

> Implementer note: verify `Rotation`, `CELL_SIZE_TILES`, `shapeWidth`, `shapeHeight` exact export sites (`shape-mask.ts`); adjust imports if they live elsewhere. Keep the ocean/land branch identical in meaning to `paintBuildingOutline`.

- [ ] **Step 4: Run to verify pass** — `npx vitest run src/mass-actions.test.ts` → PASS.
- [ ] **Step 5: Typecheck** — `npx tsc -b` (or `npm run build`'s tsc step) clean.
- [ ] **Step 6: Commit** — `git add src/mass-actions.ts src/mass-actions.test.ts && git commit -m "feat(mass-actions): world footprint + box hit-set (pure)"`

---

### Task 2: Pure helper — mass-upgrade planner

**Files:**
- Modify: `src/mass-actions.ts`
- Test: `src/mass-actions.test.ts`

**Interfaces:**
- Consumes: `parallelBuildSlots`, `inProgressBuildCount`, `queuedBuildSlots`, `queuedBuildCount`, `upgradeCost`, `topUpgradeLevel`, `affordabilityShortfall` (from `placement.ts`); `BUILDING_DEFS`; `IslandState`.
- Produces: `planMassUpgrade(state: IslandState, selectedIds: Iterable<string>): string[]` — ordered ids to upgrade: lowest current `floorLevel` first, skip-unaffordable against a running inventory copy, capped at free build+queue slots. Candidates restricted to operational, selected buildings.

- [ ] **Step 1: Write failing test**

```ts
import { planMassUpgrade } from './mass-actions.js';
// minimal IslandState stub: inventory + buildings + slot-affecting fields.
// Use a real low-cost def id from BUILDING_DEFS (e.g. 'mine') so upgradeCost resolves.

it('picks lowest-floor first, skips unaffordable, caps at free slots', () => {
  // 3 mines floors [2,0,1]; inventory affords only 2 upgrades; 5 free slots.
  // Expect order by floor asc: the floor-0 then floor-1 mine (2 ids), floor-2 skipped if unaffordable after.
  const state = makeState(/* see implementer note */);
  const plan = planMassUpgrade(state, ['m0', 'm1', 'm2']);
  expect(plan[0]).toBe('m1'); // floor 0 (lowest)
  expect(plan.length).toBeLessThanOrEqual(2);
});

it('returns [] when no free slots', () => {
  const state = makeState(/* slots all consumed */);
  expect(planMassUpgrade(state, ['m0'])).toEqual([]);
});
```

> Implementer note: build `makeState` with a real def id and concrete `placementCostFor` so `upgradeCost(def, target)` returns a known basket; set `state.inventory` to afford exactly N upgrades. Slot counts derive from `state.buildings` (in-progress) and `state.buildJobs` (queue) plus skill multipliers — for a bare state with no skills, `parallelBuildSlots` = 1, `queuedBuildSlots` = 2, so free = 3 minus current usage. Assert the *order* and the *cap*, not brittle exact ids beyond the lowest.

- [ ] **Step 2: Verify fail** — `npx vitest run src/mass-actions.test.ts -t "mass-upgrade"` → FAIL.

- [ ] **Step 3: Implement** (append to `mass-actions.ts`)

```ts
import {
  parallelBuildSlots, inProgressBuildCount, queuedBuildSlots, queuedBuildCount,
  upgradeCost, topUpgradeLevel, affordabilityShortfall,
} from './placement.js';
import { BUILDING_DEFS } from './building-defs.js';
import type { IslandState } from './economy.js';
import type { ResourceId } from './resources.js';

/** Plan a mass floor-upgrade: lowest current floor first, fill free build+queue
 *  slots, skipping any whose upgrade cost can't be paid from the RUNNING (depleting)
 *  inventory. One upgrade per building. Returns ids in apply order. */
export function planMassUpgrade(state: IslandState, selectedIds: Iterable<string>): string[] {
  const free = (parallelBuildSlots(state) - inProgressBuildCount(state))
    + (queuedBuildSlots(state) - queuedBuildCount(state));
  if (free <= 0) return [];

  const ids = new Set(selectedIds);
  const candidates = state.buildings
    .filter((b) => ids.has(b.id) && (b.constructionRemainingMs ?? 0) <= 0 && b.queued !== true)
    .sort((a, b) => (a.floorLevel ?? 0) - (b.floorLevel ?? 0) || (a.id < b.id ? -1 : 1));

  const running: Partial<Record<ResourceId, number>> = { ...state.inventory };
  const plan: string[] = [];
  for (const b of candidates) {
    if (plan.length >= free) break;
    const def = BUILDING_DEFS[b.defId];
    const cost = upgradeCost(def, topUpgradeLevel(state, b) + 2);
    if (Object.keys(affordabilityShortfall(running, cost)).length > 0) continue; // skip unaffordable
    for (const [r, n] of Object.entries(cost) as Array<[ResourceId, number]>) {
      running[r] = (running[r] ?? 0) - n;
    }
    plan.push(b.id);
  }
  return plan;
}
```

- [ ] **Step 4: Verify pass** — `npx vitest run src/mass-actions.test.ts` → PASS.
- [ ] **Step 5: Typecheck** clean.
- [ ] **Step 6: Commit** — `git commit -am "feat(mass-actions): lowest-floor-first upgrade planner (pure)"`

---

### Task 3: Pure helpers — group-relocate validation, fee, ignore-cap union, breakdown

**Files:**
- Modify: `src/mass-actions.ts`
- Test: `src/mass-actions.test.ts`

**Interfaces:**
- Consumes: `validatePlacement`, `relocateFee`, `DEFAULT_GRAPH`, `BUILDING_DEFS`, `resolveRecipe`, `IslandSpec`, `IslandState`, `PlacedBuilding`, `ResourceId`.
- Produces:
  - `validateGroupRelocate(spec, state, members: PlacedBuilding[], dx: number, dy: number): { ok: boolean; reason?: string }` — translate every member by (dx,dy) island-local tiles; each must pass `validatePlacement(..., ignoreBuildingId=member.id, skipCostGate=true)` against the *post-move* world AND not overlap another moved member. `ok` only if all pass.
  - `groupRelocateFee(members, defOf): Partial<Record<ResourceId, number>>` — summed `relocateFee` across members.
  - `interface IgnoreCapRow { resource: ResourceId; allSet: boolean }`
  - `ignoreCapUnion(targets: { spec: IslandSpec; building: PlacedBuilding }[]): IgnoreCapRow[]` — union of output resources across targets (via `resolveRecipe(def, b, spec.terrainAt).outputs`), each row `allSet` = every target that outputs `resource` has `ignoreCap[resource] === true`.
  - `selectionBreakdown(buildings: PlacedBuilding[]): { defId: string; count: number }[]` — counts per `defId`, descending by count.

- [ ] **Step 1: Write failing tests** — cover: clean translation passes; a translation that pushes a member off-island (mock `validatePlacement` reason) fails; two members translated onto the same tile fail (overlap); `groupRelocateFee` sums; `ignoreCapUnion` allSet derivation; `selectionBreakdown` counts+order.

> Implementer note: `validateGroupRelocate` calls the REAL `validatePlacement`; build a small real `IslandSpec`/`IslandState` (reuse a helper from existing placement tests if present, e.g. a `makeIsland` fixture) so off-island/biome rejection is genuine rather than mocked. For the overlap check, compare post-move footprints of members against each other directly (don't rely on `validatePlacement`, which is given `ignoreBuildingId` of the moving member and sees pre-move positions of the others).

- [ ] **Step 2: Verify fail.**

- [ ] **Step 3: Implement** (append). Key shape:

```ts
import { validatePlacement, relocateFee } from './placement.js';
import { DEFAULT_GRAPH } from './skilltree.js';        // verify the graph export site
import { resolveRecipe } from './recipes.js';
import type { IslandSpec } from './world.js';
import type { IslandState } from './economy.js';
import type { PlacedBuilding } from './buildings.js';

export function validateGroupRelocate(
  spec: IslandSpec, state: IslandState, members: PlacedBuilding[], dx: number, dy: number,
): { ok: boolean; reason?: string } {
  // 1) overlap among moved members (post-move world tiles)
  const seen = new Set<string>();
  for (const m of members) {
    const def = BUILDING_DEFS[m.defId];
    for (const t of buildingFootprintTilesWorld(spec, { ...m, x: m.x + dx, y: m.y + dy } as PlacedBuilding)) {
      const key = `${t.x},${t.y}`;
      if (seen.has(key)) return { ok: false, reason: 'member-overlap' };
      seen.add(key);
    }
    void def;
  }
  // 2) each member valid against the island (ignoring its own footprint, no cost gate)
  for (const m of members) {
    const v = validatePlacement(
      spec, state, m.defId, m.x + dx, m.y + dy, (m.rotation ?? 0), DEFAULT_GRAPH, m.id, true,
    );
    if (!v.ok) return { ok: false, reason: v.reason ?? 'invalid' };
  }
  return { ok: true };
}
```

> Caveat the implementer must resolve: `validatePlacement` with `ignoreBuildingId = m.id` still sees the OTHER members at their OLD positions and may reject a member moving into a sibling's vacated tile. If tests show this, validate against a cloned spec whose moving members are first removed (or whose positions are pre-applied) — choose the approach that makes a clean rigid translation into freed tiles pass. Document the chosen approach in a code comment.

- [ ] **Step 4: Verify pass.**  **Step 5: Typecheck clean.**  **Step 6: Commit** — `git commit -am "feat(mass-actions): group-relocate validation + fee + ignore-cap union + breakdown (pure)"`

---

### Task 4: Inspector-multi panel skeleton (breakdown + button shells)

**Files:**
- Create: `src/inspector-multi.ts`
- Modify: `src/inspector-ui.ts` (export nothing new; just confirm coexistence — multi panel is a separate DOM element)

**Interfaces:**
- Consumes: `selectionBreakdown`, `ignoreCapUnion` from `mass-actions.ts`; `BUILDING_DEFS` for display names.
- Produces:
```ts
export interface MultiTarget { spec: IslandSpec; state: IslandState; buildings: PlacedBuilding[] }
export interface InspectorMultiDeps {
  onDestroy(t: MultiTarget): void;
  onUpgrade(t: MultiTarget): void;
  onEnable(t: MultiTarget): void;
  onDisable(t: MultiTarget): void;
  onMove(t: MultiTarget): void;
  onSetIgnoreCap(t: MultiTarget, resource: ResourceId, value: boolean): void;
  upgradeFitCount(t: MultiTarget): number;   // = planMassUpgrade(state, ids).length
}
export interface InspectorMultiHandle {
  el: HTMLDivElement;
  open(t: MultiTarget): void;   // show + repaint
  close(): void;
  isVisible(): boolean;
}
export function mountInspectorMulti(parent: HTMLElement, deps: InspectorMultiDeps): InspectorMultiHandle;
```

- [ ] **Step 1:** Implement `inspector-multi.ts`: a positioned panel (reuse the inspector's CSS classes / `ri-accentbtn`, `ri-warnbtn` for visual parity). Header shows `N buildings` + breakdown lines (`5× Mine, 3× Smelter`) via `selectionBreakdown`. Buttons: **Destroy** (`ri-warnbtn`), **Upgrade (n fit)** (label from `deps.upgradeFitCount`, disabled when 0), **Move**, **Enable**, **Disable**. Ignore-cap section: one checkbox per `ignoreCapUnion` row (checked = `row.allSet`), wired to `onSetIgnoreCap`. `open(t)` stores target, repaints labels/checkboxes, shows; `close()` hides.
- [ ] **Step 2:** No unit test (DOM render). Add a tiny pure test only if a non-trivial label formatter is extracted — otherwise rely on typecheck + smoke.
- [ ] **Step 3: Typecheck** — `npx tsc -b` clean (strict; no unused).
- [ ] **Step 4: Commit** — `git commit -am "feat(inspector-multi): mass-action panel skeleton"`

---

### Task 5: Selection model + shift-click + multi-outline + panel switch in main.ts

**Files:**
- Modify: `src/main.ts`

**Interfaces:**
- Consumes: `mountInspectorMulti`, `MultiTarget`, `selectionBreakdown`; existing `paintBuildingOutline`, `repaintSelection`, `inspector`, `gateway`, `buildingAtTile`, `findPopulatedIslandAt`, `findOceanBuildingAt`.
- Produces (module-local in main.ts): `selection: Set<string>`, `selectionSpec: IslandSpec | null`, `function syncSelectionUi()`, `function clearSelection()`, `function toggleSelected(spec, id)`, `function setSingleSelected(spec, id)`.

- [ ] **Step 1:** Add `const selection = new Set<string>()` and `let selectionSpec: IslandSpec | null = null`. Mount `inspectorMulti = mountInspectorMulti(document.body, {...})` with callbacks (Tasks 7–11 fill the bodies; for now wire them to no-op-but-typed stubs that call the real gateway loops added in later tasks — OR add all callback bodies here and let later tasks just add buttons; choose: implement callback bodies in their own tasks, here pass stubs that `console.warn('todo')`). **To avoid placeholders in shipped behavior, implement the Destroy/Enable/Disable/Upgrade/Move/IgnoreCap callback bodies in Tasks 7–11; in THIS task, only Destroy is needed for a usable slice** — see Step 4.
- [ ] **Step 2:** Selection mutators:
  - `setSingleSelected(spec, id)`: `selection.clear(); selection.add(id); selectionSpec = spec; syncSelectionUi()`.
  - `toggleSelected(spec, id)`: if `selectionSpec && selectionSpec.id !== spec.id` → `selection.clear()`; `selectionSpec = spec`; toggle id; `syncSelectionUi()`.
  - `clearSelection()`: `selection.clear(); selectionSpec = null; syncSelectionUi()`.
  - `syncSelectionUi()`: if `size===0` → close both inspectors; if `size===1` → open single `inspector.open({spec,state,building})`, close `inspectorMulti`; if `size>=2` → `inspector.close()`, `inspectorMulti.open({spec, state, buildings})`. Then `repaintSelection()`.
- [ ] **Step 3:** Rework `repaintSelection()` to iterate `selection` over `selectionSpec`, painting each via `paintBuildingOutline` (prune ids no longer in `selectionSpec.buildings`); keep the single-mode visual identical for size 1. Update `repaintHover` suppression to check `selection.has(id) && selectionSpec?.id === hovered.spec.id`.
- [ ] **Step 4:** In the building click handler (`main.ts:~1077`): if `e.shiftKey` → `toggleSelected(island, hitBuilding.id)` and return (no active-island switch); else `setSingleSelected(island, hitBuilding.id)` (replaces the current `inspector.open` + `selectedSpec` lines). Mirror for the ocean-building branch (`~1116`). Wire the existing demolish callback to call `clearSelection()` instead of the ad-hoc `selectedSpec=null`. Empty-ocean click and Escape → `clearSelection()`.
- [ ] **Step 5: Typecheck + build** — `npm run build` succeeds.
- [ ] **Step 6: Browser smoke** — `npm run build`, reload `islands.nitjsefni.eu`, screenshot: shift-click two buildings shows two outlines + the multi panel with a breakdown; plain click returns to single inspector. (Use `mcp__daedalus__screenshot`.)
- [ ] **Step 7: Commit** — `git commit -am "feat(main): single-island multi-select via shift-click + multi-outline + panel switch"`

---

### Task 6: Shift-drag rubber-band box select

**Files:**
- Modify: `src/main.ts`

**Interfaces:** Consumes `buildingsInBox`, `TileBox`, `screenToWorldTile`; produces a `boxDrag` mode + overlay rect (sibling to `ghostDrag`/`bendDrag`).

- [ ] **Step 1:** Add `let boxDrag: { x0: number; y0: number } | null = null` (world-tile anchor) and a `Graphics` overlay in a world-space `Container` (pattern from the ghost overlay). On mousedown with `e.shiftKey` AND not over a building AND no mode armed → start `boxDrag` at `screenToWorldTile(...)`; set `selectionSpec` from the island under the anchor if `selection` is empty.
- [ ] **Step 2:** On mousemove while `boxDrag` → redraw the overlay rect from anchor to cursor (world px); suppress camera pan (early return, like ghost/bend).
- [ ] **Step 3:** On mouseup while `boxDrag` → compute `TileBox` from anchor+cursor; `const ids = buildingsInBox(selectionSpec, box)`; add each to `selection`; clear overlay; `boxDrag = null`; `syncSelectionUi()`. A zero-area box (click, no drag) falls through to normal click handling.
- [ ] **Step 4: Typecheck + build.**
- [ ] **Step 5: Browser smoke** — shift-drag a box over several buildings selects all of them (outlines + panel count).
- [ ] **Step 6: Commit** — `git commit -am "feat(main): shift-drag rubber-band box select"`

---

### Task 7: Mass destroy

**Files:** Modify `src/main.ts` (the `onDestroy` callback passed to `mountInspectorMulti`).

- [ ] **Step 1:** Implement `onDestroy(t)`: build the aggregate confirm message by summing the existing single-building refund/scrap previews across `t.buildings` (reuse the inspector's refund/scrap helpers — if they're not exported, replicate the sum using `previewRefundForBuilding` logic or export them; prefer exporting the existing pure helper from `inspector-ui.ts`/wherever it lives). `window.confirm(msg)`; on cancel, return.
- [ ] **Step 2:** On confirm: for each `b` in `t.buildings`, `await`/handle `gateway.demolishBuilding(t.spec.id, b.id)` (handle both sync result and Promise like the existing single `onDemolish`); for each successful removal call `drainRoutesForBuilding(worldState, b.id)`. After the loop: `clearSelection()`, `rebuildWorldLayers()`, `repaintHover()`.
- [ ] **Step 2b:** Factor the sync/Promise handling into a small local `async function runGateway(result): Promise<boolean>` to keep the loop readable; reuse it in Tasks 8–11.
- [ ] **Step 3: Typecheck + build.**
- [ ] **Step 4: Browser smoke** — select 3 buildings, Destroy, confirm → all gone, panel closes, refund credited.
- [ ] **Step 5: Commit** — `git commit -am "feat(mass): mass destroy with aggregate refund confirm"`

---

### Task 8: Mass upgrade

**Files:** Modify `src/main.ts` (`onUpgrade` + `upgradeFitCount`).

- [ ] **Step 1:** `upgradeFitCount(t)` = `planMassUpgrade(t.state, [...selection]).length` (drives the "Upgrade (n fit)" label; the panel recomputes on `open`).
- [ ] **Step 2:** `onUpgrade(t)`: `const ids = planMassUpgrade(t.state, [...selection])`. For each id in order: `const r = await runGateway(gateway.applyUpgrade(t.spec.id, id))` — but ALSO inspect the failure reason: if a call fails with `reason === 'queue-full'`, break; other failures continue (skip). After the loop: `rebuildWorldLayers()`, `buildingAlertsOverlay.invalidate()`, refresh the multi panel (`inspectorMulti.open(t)` to recompute the fit count).
- [ ] **Step 2b:** Note: `runGateway` must surface the reason. Extend it to return `GatewayResult` (not just boolean) OR add a variant that returns the unwrapped result so `onUpgrade` can read `reason`.
- [ ] **Step 3: Typecheck + build.**
- [ ] **Step 4: Browser smoke** — select several mixed-floor buildings; Upgrade enqueues the lowest-floor ones up to free slots; build-queue HUD reflects the new jobs; unaffordable ones skipped.
- [ ] **Step 5: Commit** — `git commit -am "feat(mass): mass upgrade fills free slots lowest-floor-first"`

---

### Task 9: Mass enable / disable

**Files:** Modify `src/main.ts` (`onEnable`, `onDisable`).

- [ ] **Step 1:** `onDisable(t)`: for each `b` in `t.buildings` with `activeFloors(b) > 0`: `runGateway(gateway.setBuildingActiveFloors(t.spec.id, b.id, rawFloorLevel(b) + 1))`; after a building goes fully inactive call `drainRoutesForBuilding(worldState, b.id)` (mirror single `onSetActiveFloors`). After loop: `rebuildWorldLayers()`, `buildingAlertsOverlay.invalidate()`, refresh panel.
- [ ] **Step 2:** `onEnable(t)`: for each `b`: `runGateway(gateway.setBuildingActiveFloors(t.spec.id, b.id, 0))`; then `rebuildWorldLayers()`, refresh panel.
- [ ] **Step 3: Typecheck + build.**
- [ ] **Step 4: Browser smoke** — Disable greys all selected; Enable restores.
- [ ] **Step 5: Commit** — `git commit -am "feat(mass): mass enable/disable buttons"`

---

### Task 10: Mass ignore-cap checkboxes

**Files:** Modify `src/main.ts` (`onSetIgnoreCap`).

- [ ] **Step 1:** `onSetIgnoreCap(t, resource, value)`: for each `b` in `t.buildings` that outputs `resource` (check `resolveRecipe(def, b, t.spec.terrainAt).outputs[resource]` truthy): `runGateway(gateway.setIgnoreCap(t.spec.id, b.id, resource, value))`. After loop: `buildingAlertsOverlay.invalidate()`, refresh panel (so checkbox `allSet` re-derives).
- [ ] **Step 2: Typecheck + build.**
- [ ] **Step 3: Browser smoke** — checkbox for a shared output toggles ignore-cap on all selected producers; checkbox shows checked only when all are set.
- [ ] **Step 4: Commit** — `git commit -am "feat(mass): per-resource mass ignore-cap"`

---

### Task 11: Group move (rigid-cluster relocate)

**Files:** Modify `src/placement-ui.ts`, `src/main.ts`.

**Interfaces:** `placement-ui` produces `beginGroupRelocate(members: PlacedBuilding[]): void` (sibling to `beginRelocate`); on a valid drop it commits via `gateway.relocateBuilding` per member and calls `deps.onRelocated?.()`.

- [ ] **Step 1 (placement-ui):** Add group-relocate state `groupRelocating: PlacedBuilding[] | null`, with an anchor member (first). On mousemove, compute `(dx, dy)` from the anchor's original tile to the cursor tile; render a ghost for every member at `(m.x+dx, m.y+dy)` (reuse `paintOutlineAndLabel` per member, or a dedicated group painter). Tint green/red from `validateGroupRelocate(targetSpec, targetState, members, dx, dy).ok`.
- [ ] **Step 2 (placement-ui):** On commit (click) when `groupRelocating`: re-run `validateGroupRelocate`; if `!ok` → no-op (stay armed). If `ok` → for each member `gateway.relocateBuilding(targetSpec.id, m.id, m.x+dx, m.y+dy, m.rotation ?? 0)` (sync/Promise handling like single relocate); on full success, `cancel()` the mode and `deps.onRelocated?.()`. All-or-nothing: validation already guarantees every member fits, so partial failures shouldn't occur; if a gateway call still rejects, log and continue (best-effort) — the validation gate is the contract.
- [ ] **Step 3 (main.ts):** `onMove(t)`: `inspector.close()`/`inspectorMulti.close()` is NOT called (keep selection); call `placementUi.beginGroupRelocate(t.buildings)`. Escape cancels (existing dismiss path → also cancels group mode). On `onRelocated`, the existing handler rebuilds layers; then `syncSelectionUi()` to repaint outlines at new positions.
- [ ] **Step 4: Typecheck + build.**
- [ ] **Step 5: Browser smoke** — select a cluster, Move, drag: ghost stays rigid, red when overlapping a non-selected building or off-island, green on open ground; drop relocates all and charges summed fee.
- [ ] **Step 6: Commit** — `git commit -am "feat(mass): rigid-cluster group move (all-or-nothing)"`

---

### Task 12: SPEC.md alignment + final integration

**Files:** Modify `SPEC.md`.

- [ ] **Step 1:** Add a §4 subsection (place near the building-operations / build-queue text) documenting: the multi-select model (shift-click toggle + shift-drag box, single-island scope, selection owned by the client); the mass actions (destroy with aggregate refund confirm; **upgrade** = lowest-current-floor-first, skip-unaffordable against running inventory, capped at `freeSlots = (parallelBuildSlots − inProgressBuildCount) + (queuedBuildSlots − queuedBuildCount)`, no max-floor cap; two-button enable/disable; per-resource mass ignore-cap union; all-or-nothing rigid-cluster group move with per-member 50% relocate fee). Note that mass actions add no new authoritative ops — they sequence existing intents.
- [ ] **Step 2:** Full regression — `cd /root/robot-islands && npx vitest run src/mass-actions.test.ts` (pure suite) PASS; `npm run build` clean. (Root `npm test` needs Postgres; the pure suite + build is the gate for this client-only feature, plus the full client project if PG is unavailable: `npx vitest run --project client`.)
- [ ] **Step 3:** Self-review the diff for strict-mode unused-import/param violations introduced by stubs in Task 5.
- [ ] **Step 4: Commit** — `git commit -am "docs(spec): document mass building actions (§4)"`

---

## Self-Review (filled at write time)

- **Spec coverage:** selection model → T5/T6; destroy → T7; upgrade (lowest-floor/skip-unaffordable/slot cap) → T2+T8; enable/disable (two buttons) → T9; ignore-cap union → T3+T10; group move all-or-nothing + fee → T3+T11; panel/UI → T4; SPEC.md → T12. No max-floor gate (corrected from spec — `applyUpgrade` has none).
- **Placeholder scan:** Task 5 deliberately ships only Destroy-capable wiring as the usable slice; remaining callbacks land in their own tasks (not shipped as no-ops past their task). `runGateway` helper introduced in T7, reused/extended in T8–T11.
- **Type consistency:** `MultiTarget` shape `{spec,state,buildings}` consistent across T4–T11; `planMassUpgrade(state, ids)` signature consistent T2/T8; `validateGroupRelocate(spec,state,members,dx,dy)` consistent T3/T11.
- **Open implementer caveats (flagged in-task):** exact export sites for `Rotation`/`CELL_SIZE_TILES`/`DEFAULT_GRAPH`/`resolveRecipe`; the `validatePlacement` "sibling at old position" interaction in `validateGroupRelocate` (Task 3 caveat); whether refund/scrap preview helpers are exported for reuse in Task 7.
