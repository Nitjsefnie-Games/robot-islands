# Construction Map-Placement UI — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the blocking construction modal with a drone-style movable/resizable/persisted HUD panel paired with a live, draggable world-space ghost ellipse, and gate placement so an island's footprint must lie entirely in discovered-or-visible space.

**Architecture:** A new pure predicate `regionDiscoveredOrVisible` lives in `construction-gate.ts` as a sibling to `positionIsFree` (reused by client UI + LOCAL gateway + server intent). A new pure `construction-placement.ts` combines `validateConstruction` + the two spatial gates into one `computePlacementValidity`. A new Pixi `construction-overlay.ts` draws the ghost in the world container. `construction-ui.ts` is reworked from `mountModal` to `mountPanel` while preserving its public interface. `main.ts` shares one candidate-state object between panel and overlay.

**Tech Stack:** Vite 5 + TypeScript (strict, `noUncheckedIndexedAccess`) + PixiJS 8 + vitest. Server: Fastify 5 + tsx. No React.

**Design refinement vs. spec:** The design doc placed the discovery predicate in `discovery.ts` and threaded it through `validateConstruction`. This plan instead adds it to `construction-gate.ts` as a **sibling gate** and checks it where `positionIsFree` is already checked — `validateConstruction`'s signature does **not** change, removing the spec's MED signature-ripple risk. The new `in-unknown-space` reason lives on a new `ConstructPlacementReason` type, not on `ValidationReason`. SPEC.md §2.5 and the design doc get this refined wording in Task 7.

## Global Constraints

- **Git / branch:** All commits go on a dedicated branch `feat/construction-map-placement` **cut from `master`** — NOT on `feat/per-resource-ignore-cap`. The branch must be created (with the user's confirmation) before any commit step runs. A parallel session shares this working tree; do not switch branches or stage files you did not create. Linear history: rebase + fast-forward, never merge (CONTRIBUTING.md).
- **Co-author trailer:** every commit ends with `Co-Authored-By: <model> <email>` (the implementer's identity).
- **TypeScript:** new code compiles clean under `strict`, `noUncheckedIndexedAccess`, `noUnusedLocals`, `noUnusedParameters`. Use `.js` extensions on all local imports.
- **Purity boundary:** pure modules (`construction-gate.ts`, `construction-placement.ts`) must not import render-only state; they may import `island.ts`/`world.ts` (the codebase already loads these server-side via `land-reclamation.ts`/`construction-gate.ts`).
- **Spec parity:** SPEC.md §2.5 moves with the code (Task 7). Code and spec never diverge.
- **Tests:** pure layer is unit-tested (vitest); render layer (`*-overlay.ts`, `construction-ui.ts`, `main.ts`) is verified by `npx tsc --noEmit` + `npm run build` + manual reload of `islands.nitjsefni.eu`. Run a single test file with `npx vitest run src/<file>.test.ts`.

---

### Task 1: `regionDiscoveredOrVisible` predicate (pure)

**Files:**
- Modify: `src/construction-gate.ts` (add export + two imports)
- Test: `src/construction-gate.test.ts` (create)

**Interfaces:**
- Consumes: `tileInscribedInEllipse(x, y, major, minor)` from `./island.js` (the canonical 4-corner inscription test, same one `land-reclamation.ts` uses); `tileToCell`, `cellKey` from `./discovery.js`; `WorldState` (has `revealedCells: Set<string>`).
- Produces: `regionDiscoveredOrVisible(world: WorldState, cx: number, cy: number, major: number, minor: number): boolean` — true iff every inscribed-footprint tile's stratification cell is in `world.revealedCells`.

- [ ] **Step 1: Write the failing test**

Create `src/construction-gate.test.ts`:

```typescript
import { describe, expect, it } from 'vitest';

import { regionDiscoveredOrVisible } from './construction-gate.js';
import { tileToCell, cellKey } from './discovery.js';
import { tileInscribedInEllipse } from './island.js';
import type { WorldState } from './world.js';

/** Minimal WorldState — regionDiscoveredOrVisible only reads revealedCells. */
function worldWith(revealed: Iterable<string>): WorldState {
  return { revealedCells: new Set(revealed) } as unknown as WorldState;
}

/** Every cell key the inscribed footprint of an ellipse at (cx,cy) occupies. */
function footprintCells(cx: number, cy: number, major: number, minor: number): string[] {
  const keys = new Set<string>();
  const xMin = -Math.ceil(major), xMax = Math.ceil(major) - 1;
  const yMin = -Math.ceil(minor), yMax = Math.ceil(minor) - 1;
  for (let dy = yMin; dy <= yMax; dy++) {
    for (let dx = xMin; dx <= xMax; dx++) {
      if (!tileInscribedInEllipse(dx, dy, major, minor)) continue;
      const { cellX, cellY } = tileToCell(cx + dx, cy + dy);
      keys.add(cellKey(cellX, cellY));
    }
  }
  return [...keys];
}

describe('regionDiscoveredOrVisible', () => {
  it('returns true when every footprint cell is revealed', () => {
    const cells = footprintCells(100, 100, 4, 4);
    expect(regionDiscoveredOrVisible(worldWith(cells), 100, 100, 4, 4)).toBe(true);
  });

  it('returns false when any footprint cell is missing from revealedCells', () => {
    const cells = footprintCells(100, 100, 4, 4);
    expect(cells.length).toBeGreaterThan(0);
    const missingOne = cells.slice(1); // drop the first cell
    expect(regionDiscoveredOrVisible(worldWith(missingOne), 100, 100, 4, 4)).toBe(false);
  });

  it('returns false against an empty revealed set', () => {
    expect(regionDiscoveredOrVisible(worldWith([]), 0, 0, 4, 4)).toBe(false);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/construction-gate.test.ts`
Expected: FAIL — `regionDiscoveredOrVisible` is not exported.

- [ ] **Step 3: Add the predicate**

In `src/construction-gate.ts`, add to the imports at the top (the file currently imports only from `./world.js`):

```typescript
import { tileInscribedInEllipse } from './island.js';
import { cellKey, tileToCell } from './discovery.js';
```

Append at the end of the file:

```typescript
/** Does the inscribed footprint of an ellipse at (cx,cy) lie entirely within
 *  discovered-or-visible space? "Unknown" = a stratification cell not present
 *  in `world.revealedCells` (vision and discovery both write through to that
 *  set, so a single membership test covers both tiers). Re-runnable on the
 *  authoritative server — same trust-surface role as `positionIsFree`. */
export function regionDiscoveredOrVisible(
  world: WorldState,
  cx: number,
  cy: number,
  major: number,
  minor: number,
): boolean {
  const xMin = -Math.ceil(major), xMax = Math.ceil(major) - 1;
  const yMin = -Math.ceil(minor), yMax = Math.ceil(minor) - 1;
  for (let dy = yMin; dy <= yMax; dy++) {
    for (let dx = xMin; dx <= xMax; dx++) {
      if (!tileInscribedInEllipse(dx, dy, major, minor)) continue;
      const { cellX, cellY } = tileToCell(cx + dx, cy + dy);
      if (!world.revealedCells.has(cellKey(cellX, cellY))) return false;
    }
  }
  return true;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/construction-gate.test.ts`
Expected: PASS (3 tests).

- [ ] **Step 5: Typecheck**

Run: `npx tsc -b` (or `npm run build` if faster locally)
Expected: no errors.

- [ ] **Step 6: Commit**

```bash
git add src/construction-gate.ts src/construction-gate.test.ts
git commit -m "feat(construction): regionDiscoveredOrVisible footprint gate"
```

---

### Task 2: `construction-placement.ts` — shared candidate + `computePlacementValidity` (pure)

**Files:**
- Create: `src/construction-placement.ts`
- Test: `src/construction-placement.test.ts`

**Interfaces:**
- Consumes: `validateConstruction`, `ValidationReason` from `./artificial-island.js`; `positionIsFree`, `regionDiscoveredOrVisible` from `./construction-gate.js`; `Biome`, `IslandSpec`, `WorldState` from `./world.js`; `IslandState` from `./economy.js`.
- Produces:
  - `interface ConstructionCandidate { founderId: string; biome: Biome; major: number; minor: number; cx: number; cy: number; }`
  - `type ConstructPlacementReason = ValidationReason | 'unknown-founder' | 'position-occupied' | 'in-unknown-space'`
  - `interface PlacementValidity { readonly ok: boolean; readonly reason?: ConstructPlacementReason }`
  - `function computePlacementValidity(world, islandStates, cand): PlacementValidity`
  - `function placementBlocksGhost(reason: ConstructPlacementReason | undefined): boolean` — true for the reasons that should turn the ghost red (`position-occupied`, `in-unknown-space`, `radius-too-large`); false for affordability/founder reasons.

- [ ] **Step 1: Write the failing test**

Create `src/construction-placement.test.ts`:

```typescript
import { describe, expect, it } from 'vitest';

import {
  computePlacementValidity,
  placementBlocksGhost,
  type ConstructionCandidate,
} from './construction-placement.js';
import type { IslandState } from './economy.js';
import type { PlacedBuilding } from './buildings.js';
import { ALL_RESOURCES, type ResourceId } from './recipes.js';
import { LAND_TILE_COST } from './building-defs.js';
import { aggregateStorageCaps, cellKey, type IslandSpec, type WorldState } from './world.js';
import { tileToCell } from './discovery.js';
import { tileInscribedInEllipse } from './island.js';

const PC: PlacedBuilding = { id: 'pc-1', defId: 'platform_constructor', x: -4, y: -4 };

function inv(over: Partial<Record<ResourceId, number>>): Record<ResourceId, number> {
  const i = {} as Record<ResourceId, number>;
  for (const r of ALL_RESOURCES) i[r] = 0;
  for (const [k, v] of Object.entries(over)) i[k as ResourceId] = v ?? 0;
  return i;
}

function founderSpec(): IslandSpec {
  return {
    id: 'founder', name: 'founder', biome: 'plains', cx: 0, cy: 0,
    majorRadius: 14, minorRadius: 14, populated: true, discovered: true,
    buildings: [PC], modifiers: [],
  };
}

function founderState(level = 15, materials: Partial<Record<ResourceId, number>> = {}): IslandState {
  return {
    id: 'founder', buildings: [PC], inventory: inv(materials),
    storageCaps: aggregateStorageCaps([PC]), xp: 0, level, unspentSkillPoints: 0,
    unlockedNodes: new Set(), unlockedEdges: new Set(), auraAmpVersion: 0,
    auraAmpCache: null, auraAmpCacheVersion: -1, co2Kg: 0,
    funnelPending: inv({}), aiCoreCrafted: false, ascendantCoreCrafted: false,
    lastResetAt: null, timeLockBankedMin: 0, accelerationQueue: [],
    accelerationRemainingMin: 0, bankingEnabled: false, genesisTarget: null,
    batteryStoredWs: 0, starterInventoryGrace: {} as Record<ResourceId, number>,
    socketBindings: new Map(), everProduced: new Set(), tradeCooldownMs: 0,
    tradeAcceptCount: 0, lastTick: 0,
  };
}

/** Reveal every footprint cell of a 4x4 ellipse centered at (cx,cy). */
function revealFootprint(cx: number, cy: number): Set<string> {
  const s = new Set<string>();
  for (let dy = -4; dy <= 3; dy++) for (let dx = -4; dx <= 3; dx++) {
    if (!tileInscribedInEllipse(dx, dy, 4, 4)) continue;
    const c = tileToCell(cx + dx, cy + dy);
    s.add(cellKey(c.cellX, c.cellY));
  }
  return s;
}

function world(states: Map<string, IslandState>, revealed: Set<string>): WorldState {
  const islands: IslandSpec[] = [];
  for (const id of states.keys()) {
    if (id === 'founder') islands.push(founderSpec());
  }
  return { islands, revealedCells: revealed } as unknown as WorldState;
}

const enough = { steel_beam: 100000, concrete: 100000 } as Partial<Record<ResourceId, number>>;

function cand(over: Partial<ConstructionCandidate> = {}): ConstructionCandidate {
  return { founderId: 'founder', biome: 'plains', major: 4, minor: 4, cx: 200, cy: 200, ...over };
}

describe('computePlacementValidity', () => {
  it('returns unknown-founder when the founder id is not in state', () => {
    const states = new Map<string, IslandState>();
    const w = world(states, revealFootprint(200, 200));
    expect(computePlacementValidity(w, states, cand()).reason).toBe('unknown-founder');
  });

  it('reds out on position-occupied before checking discovery', () => {
    const states = new Map([['founder', founderState(15, enough)]]);
    // Place candidate ON TOP of the founder at (0,0) -> overlap.
    const w = world(states, revealFootprint(0, 0));
    const v = computePlacementValidity(w, states, cand({ cx: 0, cy: 0 }));
    expect(v.reason).toBe('position-occupied');
  });

  it('returns in-unknown-space when the footprint is not revealed', () => {
    const states = new Map([['founder', founderState(15, enough)]]);
    const w = world(states, new Set()); // nothing revealed
    const v = computePlacementValidity(w, states, cand());
    expect(v.reason).toBe('in-unknown-space');
  });

  it('surfaces insufficient-materials only after spatial checks pass', () => {
    const states = new Map([['founder', founderState(15, {})]]); // no materials
    const w = world(states, revealFootprint(200, 200));
    const v = computePlacementValidity(w, states, cand());
    expect(v.reason).toBe('insufficient-materials');
  });

  it('returns ok when founder valid, position free, revealed, affordable', () => {
    const states = new Map([['founder', founderState(15, enough)]]);
    const w = world(states, revealFootprint(200, 200));
    expect(computePlacementValidity(w, states, cand())).toEqual({ ok: true });
  });

  it('placementBlocksGhost reds the spatial reasons only', () => {
    expect(placementBlocksGhost('position-occupied')).toBe(true);
    expect(placementBlocksGhost('in-unknown-space')).toBe(true);
    expect(placementBlocksGhost('radius-too-large')).toBe(true);
    expect(placementBlocksGhost('insufficient-materials')).toBe(false);
    expect(placementBlocksGhost(undefined)).toBe(false);
  });
});
```

Note: `cellKey` is re-exported from `world.ts`? If `tsc` reports it is not, import `cellKey` from `./discovery.js` instead (it is defined there) — adjust the import line accordingly.

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/construction-placement.test.ts`
Expected: FAIL — module `./construction-placement.js` does not exist.

- [ ] **Step 3: Write the module**

Create `src/construction-placement.ts`:

```typescript
// Pure shared placement state + validity for §2.5 artificial-island
// construction. The DOM panel (construction-ui.ts) and the Pixi ghost
// (construction-overlay.ts) both read/write a single ConstructionCandidate;
// this module computes whether that candidate is buildable. NO pixi import.

import { validateConstruction, type ValidationReason } from './artificial-island.js';
import { positionIsFree, regionDiscoveredOrVisible } from './construction-gate.js';
import type { IslandState } from './economy.js';
import type { Biome, WorldState } from './world.js';

export interface ConstructionCandidate {
  founderId: string;
  biome: Biome;
  major: number;
  minor: number;
  cx: number;
  cy: number;
}

export type ConstructPlacementReason =
  | ValidationReason
  | 'unknown-founder'
  | 'position-occupied'
  | 'in-unknown-space';

export interface PlacementValidity {
  readonly ok: boolean;
  readonly reason?: ConstructPlacementReason;
}

/** Validity precedence: founder existence, then SPATIAL gates (overlap,
 *  discovery) so the ghost reds correctly even when also unaffordable, then
 *  the per-island validateConstruction bundle (tier / PC / radii / materials /
 *  biome). */
export function computePlacementValidity(
  world: WorldState,
  islandStates: Map<string, IslandState>,
  cand: ConstructionCandidate,
): PlacementValidity {
  const spec = world.islands.find((s) => s.id === cand.founderId);
  const state = islandStates.get(cand.founderId);
  if (!spec || !state) return { ok: false, reason: 'unknown-founder' };

  if (!positionIsFree(world, cand.cx, cand.cy, cand.major)) {
    return { ok: false, reason: 'position-occupied' };
  }
  if (!regionDiscoveredOrVisible(world, cand.cx, cand.cy, cand.major, cand.minor)) {
    return { ok: false, reason: 'in-unknown-space' };
  }

  const v = validateConstruction(state, spec, {
    biome: cand.biome,
    majorRadius: cand.major,
    minorRadius: cand.minor,
  });
  if (!v.ok) return { ok: false, reason: v.reason };

  return { ok: true };
}

/** Reasons that should render the ghost RED (placement-blocking position/size).
 *  Affordability and founder-eligibility reasons leave the ghost cyan (the
 *  Construct button is disabled separately). */
export function placementBlocksGhost(reason: ConstructPlacementReason | undefined): boolean {
  return reason === 'position-occupied'
    || reason === 'in-unknown-space'
    || reason === 'radius-too-large';
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/construction-placement.test.ts`
Expected: PASS (6 tests). If the `cellKey` import line errors, switch it to `./discovery.js` and re-run.

- [ ] **Step 5: Commit**

```bash
git add src/construction-placement.ts src/construction-placement.test.ts
git commit -m "feat(construction): computePlacementValidity shared candidate gate"
```

---

### Task 3: Authoritative enforcement — server intent + LOCAL gateway

**Files:**
- Modify: `server/src/game/intents.ts` (the `'construct-island'` handler, ~line 834-892)
- Modify: `src/mutation-gateway.ts` (LOCAL `constructIsland`, ~line 555-578)
- Test: `server/src/game/intents.test.ts` (extend the `construct-island` describe)
- Test: `src/mutation-gateway.test.ts` (extend the construct describe)

**Interfaces:**
- Consumes: `regionDiscoveredOrVisible`, `positionIsFree` from `construction-gate`.
- Produces: both call sites reject with error/reason `'in-unknown-space'` when the footprint is not fully revealed; the LOCAL gateway also gains the `'position-occupied'` check it currently lacks (parity with the server).

- [ ] **Step 1: Write the failing server test**

In `server/src/game/intents.test.ts`, inside the existing `describe('construct-island', ...)` block, mirror the adjacent "illegal: overlapping" test but vary `revealedCells`. Add:

```typescript
it('illegal: footprint extends into unknown space is rejected, save unchanged', () => {
  // Mirror the legal construct-island setup, but ensure the target cells are
  // NOT in world.revealedCells. Use a far-away cx/cy whose cells were never
  // revealed. Expect { ok: false, error: 'in-unknown-space' }.
  // (Copy the legal test's founder/level/material setup verbatim, then set
  //  the payload cx/cy to e.g. 9000/9000 and assert the result + that the
  //  island count is unchanged.)
});

it('legal: footprint fully within revealedCells succeeds', () => {
  // Copy the legal construct-island test, but additionally add every cell the
  // target footprint occupies to world.revealedCells before applying the
  // intent (use tileToCell + cellKey over the inscribed footprint, as in
  // construction-placement.test.ts's revealFootprint helper). Expect ok:true.
});
```

Implementer note: read the existing `construct-island` legal/illegal tests in this file and reuse their exact `game`/world/founder construction; only the `revealedCells` content and `cx/cy` differ. Import `tileToCell`/`cellKey`/`tileInscribedInEllipse` if building a reveal helper.

- [ ] **Step 2: Run to verify failure**

Run: `cd server && npm test -- intents` (or from root: `npx vitest run server/src/game/intents.test.ts`)
Expected: the new "illegal ... unknown space" test FAILS (the handler currently accepts it).

- [ ] **Step 3: Add the server check**

In `server/src/game/intents.ts`, add to the construction-gate import (the file already imports `positionIsFree`):

```typescript
import { positionIsFree, regionDiscoveredOrVisible } from '../../...construction-gate.js';
```

(Match the existing relative path used for `positionIsFree` in this file — do not invent a path; extend the existing import line.)

Immediately after the existing `positionIsFree` rejection block, add:

```typescript
if (!regionDiscoveredOrVisible(game.world, cx, cy, majorRadius, minorRadius)) {
  return { ok: false, error: 'in-unknown-space' };
}
```

- [ ] **Step 4: Run server tests to verify pass**

Run: `npx vitest run server/src/game/intents.test.ts`
Expected: PASS, including both new tests.

- [ ] **Step 5: Write the failing gateway test**

In `src/mutation-gateway.test.ts`, inside the construct describe, add (mirror the existing `'constructs an artificial island locally'` test's setup):

```typescript
it('rejects local construction whose footprint is not revealed', () => {
  // Same level-15 + platform_constructor + 10000/10000 setup as the existing
  // local-construct test, but DO NOT reveal the target cells. Expect the
  // gateway result ok:false with reason/error 'in-unknown-space'.
});
```

- [ ] **Step 6: Run to verify failure**

Run: `npx vitest run src/mutation-gateway.test.ts`
Expected: the new test FAILS (LOCAL gateway currently does not check discovery).

- [ ] **Step 7: Add the LOCAL gateway checks**

In `src/mutation-gateway.ts`, add to imports:

```typescript
import { positionIsFree, regionDiscoveredOrVisible } from './construction-gate.js';
```

In the LOCAL `constructIsland` method, immediately after the `validateConstruction` guard (`if (!can.ok) return err(...)`) and before `makeArtificialIdGenerator`, insert:

```typescript
if (!positionIsFree(world, cx, cy, majorRadius)) {
  return err('position-occupied', 'position-occupied');
}
if (!regionDiscoveredOrVisible(world, cx, cy, majorRadius, minorRadius)) {
  return err('in-unknown-space', 'in-unknown-space');
}
```

- [ ] **Step 8: Run gateway tests to verify pass**

Run: `npx vitest run src/mutation-gateway.test.ts`
Expected: PASS, including the new test. Confirm pre-existing construct tests still pass — if one now reveals nothing and breaks, add the footprint reveal to that test's world setup.

- [ ] **Step 9: Commit**

```bash
git add server/src/game/intents.ts server/src/game/intents.test.ts src/mutation-gateway.ts src/mutation-gateway.test.ts
git commit -m "feat(construction): enforce discovery gate on server intent + LOCAL gateway"
```

---

### Task 4: `construction-overlay.ts` — ghost ellipse + resize handles (Pixi, render)

**Files:**
- Create: `src/construction-overlay.ts`

**Interfaces:**
- Consumes: `Container`, `Graphics` from `pixi.js`; `TILE_PX` from `./island.js`; `ConstructionCandidate` from `./construction-placement.js`.
- Produces:
  ```typescript
  interface ConstructionGhostHandle {
    update(cand: ConstructionCandidate | null, red: boolean): void;
    setHandlers(h: {
      onMove(cx: number, cy: number): void;
      onResize(major: number, minor: number): void;
    }): void;
    /** Convert a Pixi global (screen) point to world-tile coords. Injected by
     *  main.ts so the overlay stays decoupled from camera internals. */
    setToTile(fn: (globalX: number, globalY: number) => { x: number; y: number }): void;
    destroy(): void;
  }
  function createConstructionGhostOverlay(parent: Container): ConstructionGhostHandle
  ```
- Notes: `parent` is the **world container** (the camera-synced Container that islands/buildings live under), so the ghost scales/pans with zoom. Drawing uses world pixels (`tile * TILE_PX`). Cyan = `0x7dd3e8` (VISION_BLUE), red = `0xe06b5a`. Radii are clamped to integers ≥ 1 by the caller; the overlay rounds on resize.

- [ ] **Step 1: Write the overlay**

Create `src/construction-overlay.ts`:

```typescript
// §2.5 construction ghost — a draggable/resizable preview ellipse for
// artificial-island placement. Parented to the WORLD container so it scales
// with the camera like islands. Render layer only; the authoritative state is
// the ConstructionCandidate owned by main.ts. Body-drag moves the centre;
// the four corner handles resize major/minor.

import { Container, Graphics, type FederatedPointerEvent } from 'pixi.js';

import { TILE_PX } from './island.js';
import type { ConstructionCandidate } from './construction-placement.js';

const GHOST_CYAN = 0x7dd3e8;
const GHOST_RED = 0xe06b5a;
const HANDLE_PX = 8;

export interface ConstructionGhostHandle {
  update(cand: ConstructionCandidate | null, red: boolean): void;
  setHandlers(h: {
    onMove(cx: number, cy: number): void;
    onResize(major: number, minor: number): void;
  }): void;
  setToTile(fn: (globalX: number, globalY: number) => { x: number; y: number }): void;
  destroy(): void;
}

export function createConstructionGhostOverlay(parent: Container): ConstructionGhostHandle {
  const layer = new Container();
  layer.label = 'construction-ghost';
  parent.addChild(layer);

  const body = new Graphics();
  body.eventMode = 'static';
  body.cursor = 'move';
  layer.addChild(body);

  // Four corner handles: TL, TR, BL, BR. Each resizes by dragging.
  const handles = [0, 1, 2, 3].map(() => {
    const g = new Graphics();
    g.eventMode = 'static';
    g.cursor = 'nwse-resize';
    layer.addChild(g);
    return g;
  });

  let current: ConstructionCandidate | null = null;
  let handlers: { onMove(cx: number, cy: number): void; onResize(major: number, minor: number): void } | null = null;
  let toTile: ((gx: number, gy: number) => { x: number; y: number }) | null = null;

  // ----- drag state -----
  let dragKind: 'body' | number | null = null; // number = handle index

  function pointerDownBody(e: FederatedPointerEvent): void {
    dragKind = 'body';
    e.stopPropagation();
  }
  function pointerDownHandle(idx: number) {
    return (e: FederatedPointerEvent): void => { dragKind = idx; e.stopPropagation(); };
  }
  function pointerMove(e: FederatedPointerEvent): void {
    if (dragKind === null || !current || !toTile || !handlers) return;
    const t = toTile(e.global.x, e.global.y);
    if (dragKind === 'body') {
      handlers.onMove(Math.round(t.x), Math.round(t.y));
    } else {
      // Handle drag: new radius = |tile - centre| on each axis, min 1.
      const major = Math.max(1, Math.round(Math.abs(t.x - current.cx)));
      const minor = Math.max(1, Math.round(Math.abs(t.y - current.cy)));
      handlers.onResize(major, minor);
    }
  }
  function pointerUp(): void { dragKind = null; }

  body.on('pointerdown', pointerDownBody);
  handles.forEach((g, i) => g.on('pointerdown', pointerDownHandle(i)));
  // Listen on the parent (world container is interactive) for move/up so the
  // drag continues even when the cursor leaves the small handle/body hit area.
  parent.eventMode = 'static';
  parent.on('globalpointermove', pointerMove);
  parent.on('pointerup', pointerUp);
  parent.on('pointerupoutside', pointerUp);

  function redraw(red: boolean): void {
    body.clear();
    handles.forEach((g) => g.clear());
    if (!current) { layer.visible = false; return; }
    layer.visible = true;
    const color = red ? GHOST_RED : GHOST_CYAN;
    const px = current.cx * TILE_PX;
    const py = current.cy * TILE_PX;
    const rx = current.major * TILE_PX;
    const ry = current.minor * TILE_PX;

    body.ellipse(px, py, rx, ry);
    body.fill({ color, alpha: 0.18 });
    body.stroke({ color, width: 2, alpha: 0.9 });

    const corners: Array<[number, number]> = [
      [px - rx, py - ry], [px + rx, py - ry], [px - rx, py + ry], [px + rx, py + ry],
    ];
    handles.forEach((g, i) => {
      const [hx, hy] = corners[i]!;
      g.rect(hx - HANDLE_PX / 2, hy - HANDLE_PX / 2, HANDLE_PX, HANDLE_PX);
      g.fill({ color, alpha: 0.95 });
    });
  }

  return {
    update(cand, red) { current = cand; redraw(red); },
    setHandlers(h) { handlers = h; },
    setToTile(fn) { toTile = fn; },
    destroy() {
      parent.off('globalpointermove', pointerMove);
      parent.off('pointerup', pointerUp);
      parent.off('pointerupoutside', pointerUp);
      layer.destroy({ children: true });
    },
  };
}
```

- [ ] **Step 2: Typecheck**

Run: `npx tsc -b`
Expected: no errors. If `globalpointermove` / `ellipse` / `stroke` APIs mismatch the installed PixiJS 8 minor, adjust to the project's existing Graphics usage (compare against `lobe-badge-overlay.ts` / `routes-renderer.ts` for the exact call shapes used elsewhere).

- [ ] **Step 3: Commit**

```bash
git add src/construction-overlay.ts
git commit -m "feat(construction): world-space ghost ellipse overlay with resize handles"
```

---

### Task 5: Rework `construction-ui.ts` — modal → movable panel

**Files:**
- Modify: `src/construction-ui.ts`

**Interfaces:**
- Consumes: `mountPanel`, `Zone` from `./ui-zones.js`; `computePlacementValidity`, `placementBlocksGhost`, `type ConstructionCandidate` from `./construction-placement.js`.
- Produces: the **same public `ConstructionUi` interface** the file already returns (`toggle()`, `isVisible()`, `refresh()`, `hide()`) so `main.ts` wiring is unchanged, PLUS two additions to `ConstructionUiOptions`:
  - `readonly candidate: ConstructionCandidate` — the shared mutable state object (created in main.ts, also handed to the overlay).
  - `onCandidateChange?(): void` — called when the panel edits the candidate (so main.ts redraws the ghost immediately, not just next frame).
- And one new method on `ConstructionUi`: `refreshFromCandidate(): void` — re-reads the shared candidate into the sliders / X-Y fields (called by main.ts after a map drag changed it).

- [ ] **Step 1: Swap the mount from modal to panel**

Replace the `import { mountModal } from './ui-modal.js';` with `import { mountPanel, Zone } from './ui-zones.js';`.

Replace the `mountModal(parentEl, { title, subtitle, onClose, buildBody, buildFooter })` block with a hand-built panel matching the drone pattern: create a `panel` div (`classList.add('ri-panel')`, set `id`), build `header` (title `CONSTRUCT` + subtitle `platform constructor` + a close button that calls the visibility setter), `body`, and `footer` elements, append them, append `panel` to `parentEl`, then:

```typescript
const panelHandle = mountPanel(panel, { id: 'construction-panel', zone: Zone.R, order: 1 });
panelHandle.setVisible(false);
let visible = false;
```

Move the existing `buildBody` contents (founder picker, biome chips, size sliders, position inputs, name input, cost grid) into direct construction against `body`, and the footer contents (status span + construct button) against `footer`. Reuse the existing element-building code verbatim; only the container wiring changes.

- [ ] **Step 2: Implement the public interface over `setVisible`**

```typescript
return {
  el: panel,
  toggle(): boolean { visible = !visible; panelHandle.setVisible(visible); if (visible) seedAndRefresh(); return visible; },
  isVisible(): boolean { return visible; },
  hide(): void { visible = false; panelHandle.setVisible(false); },
  refresh(): void { refresh(); },
  refreshFromCandidate(): void { readCandidateIntoControls(); refresh(); },
};
```

Where `seedAndRefresh()` initialises the shared `candidate` (founder = active eligible island, default biome/size, a default centre near the founder — see Task 6 for the centre seed) then calls `refresh()`.

- [ ] **Step 3: Drive all reads/writes through the shared candidate**

- Biome chips set `candidate.biome` then call `options.onCandidateChange?.()` + `refresh()`.
- Major/Minor sliders set `candidate.major` / `candidate.minor` (clamped to `maxRadiusForFounderLevel(founder.level)`), then `onCandidateChange?.()` + `refresh()`.
- The X/Y inputs (keep them, editable + synced) set `candidate.cx` / `candidate.cy` on `input`, then `onCandidateChange?.()` + `refresh()`.
- `readCandidateIntoControls()` writes `candidate.{cx,cy,major,minor,biome}` back into the slider values / number-input values / active biome chip (used by `refreshFromCandidate`).

- [ ] **Step 4: Replace validation calls with `computePlacementValidity`**

In `refresh()`, replace the two `validateConstruction(...)` calls with:

```typescript
const validity = computePlacementValidity(options.world, options.islandStates, candidate);
// status line text:
statusEl.textContent = validity.ok
  ? `READY — ${candidate.biome} ${candidate.major}x${candidate.minor} AT (${candidate.cx}, ${candidate.cy})`
  : reasonLabel(validity.reason);
// construct button enabled state:
setConstructEnabled(validity.ok);
```

Keep the existing `reasonLabel` mapping; add labels for the new reasons:
- `'position-occupied'` → `"Position overlaps an existing island"`
- `'in-unknown-space'` → `"Extends into unknown space"`
- `'unknown-founder'` → `"Select a founder island"`

In `tryConstruct()`, gate on `computePlacementValidity(...).ok` (replacing the prior `validateConstruction` guard) and pass `candidate.cx`/`candidate.cy` (already the source of truth) to the gateway/`onConstruct`.

- [ ] **Step 5: Typecheck + build**

Run: `npx tsc -b && npm run build`
Expected: no errors. (Note: `main.ts` will not yet pass the new required `candidate` option — if `candidate` is made required, update the `mountConstructionUi` call in Task 6 first or temporarily mark it optional; prefer required + do Task 6 in the same branch before building.)

- [ ] **Step 6: Commit**

```bash
git add src/construction-ui.ts
git commit -m "feat(construction): convert construction UI to a movable HUD panel"
```

---

### Task 6: `main.ts` wiring — ghost lifecycle + panel/overlay sync

**Files:**
- Modify: `src/main.ts`

**Interfaces:**
- Consumes: `createConstructionGhostOverlay` from `./construction-overlay.js`; `type ConstructionCandidate` from `./construction-placement.js`; the existing camera + world-container plumbing.
- Produces: a single shared `constructionCandidate` object passed to BOTH `mountConstructionUi` and the ghost overlay; the overlay updated each frame while the panel is visible; the candidate seeded on open and re-seeded after a construct.

- [ ] **Step 1: Create the shared candidate + ghost overlay**

Near the `lobeBadges` creation (`createLobeBadgeOverlay(app.stage)`), add the ghost — but parent it to the **world container** (the Container that islands/buildings are children of, which `main.ts` syncs from `cam` each frame), NOT `app.stage`. Grep `rebuildWorldLayers` / where island layers are `addChild`-ed to find that container's variable name; call it `worldLayer` below:

```typescript
const constructionCandidate: ConstructionCandidate = {
  founderId: '', biome: 'plains', major: 4, minor: 4, cx: 0, cy: 0,
};
const constructionGhost = createConstructionGhostOverlay(worldLayer);
```

- [ ] **Step 2: Inject the screen→tile converter**

Use the existing camera inverse of `worldToScreen` (grep `camera.ts` for `screenToWorld`; if absent, invert inline: `world = (screen - cam.t) / cam.zoom`, then `tile = world / TILE_PX`). Wire it:

```typescript
constructionGhost.setToTile((gx, gy) => {
  const wx = (gx - cam.tx) / cam.zoom;
  const wy = (gy - cam.ty) / cam.zoom;
  return { x: wx / TILE_PX, y: wy / TILE_PX };
});
```

(Use the actual camera field names from `camera.ts` — `cam.tx/cam.ty/cam.zoom` per AGENTS.md; adjust if different.)

- [ ] **Step 3: Wire drag callbacks → candidate → panel + ghost**

```typescript
constructionGhost.setHandlers({
  onMove(cx, cy) {
    constructionCandidate.cx = cx; constructionCandidate.cy = cy;
    constructionUi.refreshFromCandidate();
    redrawGhost();
  },
  onResize(major, minor) {
    const founder = islandStates.get(constructionCandidate.founderId);
    const cap = founder ? maxRadiusForFounderLevel(founder.level) : 8;
    constructionCandidate.major = Math.min(major, cap);
    constructionCandidate.minor = Math.min(minor, cap);
    constructionUi.refreshFromCandidate();
    redrawGhost();
  },
});
```

Add a `redrawGhost()` helper that recomputes validity and updates the ghost:

```typescript
function redrawGhost(): void {
  if (!constructionUi.isVisible()) { constructionGhost.update(null, false); return; }
  const v = computePlacementValidity(worldState, islandStates, constructionCandidate);
  constructionGhost.update(constructionCandidate, placementBlocksGhost(v.reason));
}
```

Import `computePlacementValidity`, `placementBlocksGhost`, `maxRadiusForFounderLevel` (already imported for `artificial-island`? if not, add).

- [ ] **Step 4: Pass the candidate + change hook into the panel**

Update the `mountConstructionUi(document.body, { ... })` call to add:

```typescript
candidate: constructionCandidate,
onCandidateChange: () => redrawGhost(),
```

- [ ] **Step 5: Seed on open, clear on close, re-seed after construct**

- In the panel's `seedAndRefresh` (Task 5) the centre defaults to a valid spot near the founder: pick the active/first eligible founder, set `candidate.founderId`, and set `cx/cy` to `founder.cx + founder.majorRadius + candidate.major + POSITION_BUFFER_TILES + 2`, `cy = founder.cy` (offset east of the founder, clear of overlap). Import `POSITION_BUFFER_TILES` from `./construction-gate.js`.
- In the existing ticker line `if (constructionUi.isVisible()) constructionUi.refresh();`, add `redrawGhost();` right after so the ghost tracks camera pans every frame; when not visible, call `constructionGhost.update(null, false)` once (guard with a `wasVisible` flag to avoid per-frame churn).
- In `onConstruct` (after the existing inserts + `rebuildWorldLayers()`), re-seed the candidate to a fresh valid spot (call the same seed helper, or nudge `cx` further east) and `redrawGhost()` so the player can place another.
- In the dismiss path that calls `constructionUi.hide()` (line ~2018), add `constructionGhost.update(null, false);`.

- [ ] **Step 6: Typecheck + build**

Run: `npx tsc -b && npm run build`
Expected: no errors.

- [ ] **Step 7: Manual verification**

```bash
npm run build
```
Then reload `https://islands.nitjsefni.eu/` (the dev service serves `dist/`; do NOT restart it). With a T3+ island that has a Platform Constructor:
- Press **C** → panel opens as a movable/resizable window; drag its header to move it, drag an edge to resize; reload the page → it returns to the moved position (persistence).
- A cyan ghost ellipse appears near the founder. Drag its body → it moves and the X/Y fields update. Drag a corner handle → it resizes and the sliders update.
- Drag the ghost over another island → it turns **red** ("Position overlaps an existing island"); drag it into the fog (unknown ocean) → red ("Extends into unknown space"); Construct is disabled in both.
- Place it on revealed open ocean with materials → cyan, Construct enabled → click → island appears, panel stays open, ghost re-seeds.

Capture a screenshot via `mcp__daedalus__screenshot` against the active tab to confirm.

- [ ] **Step 8: Commit**

```bash
git add src/main.ts
git commit -m "feat(construction): live ghost wired to panel + camera, discovery-gated placement"
```

---

### Task 7: SPEC.md §2.5 + design-doc reconciliation

**Files:**
- Modify: `SPEC.md` (§2.5 Artificial Islands)
- Modify: `docs/superpowers/specs/2026-06-20-construction-map-placement-design.md` (+ `.html`, + republish)

**Interfaces:** none (documentation).

- [ ] **Step 1: Add the placement rule to SPEC §2.5**

In SPEC.md §2.5, add a paragraph:

> **Placement constraint.** An artificial island may only be constructed where its entire inscribed footprint lies in discovered-or-visible space — every stratification cell the island would occupy must already be present in `revealedCells` (vision and discovery both write through to that set). Placement whose footprint extends into unknown ocean is rejected with reason `in-unknown-space`. The constraint is a pure predicate (`regionDiscoveredOrVisible`, `construction-gate.ts`) checked by the construction UI, the LOCAL mutation gateway, and the authoritative server `construct-island` intent. The construction UI is a movable HUD panel with a live, draggable ghost-ellipse preview (cyan valid / red invalid); position is set on the map, not by typed coordinates alone.

- [ ] **Step 2: Reconcile the design doc**

In the design `.md`, update the component table + risk table to reflect: the predicate lives in `construction-gate.ts` (not `discovery.ts`), it is a **sibling gate** (not threaded through `validateConstruction`), and the signature-ripple risk is **removed**. Rebuild the `.html` from the same content and republish:

```bash
python3 ~/.claude/scripts/docs_hub.py publish docs/superpowers/specs/2026-06-20-construction-map-placement-design.html \
  --slug robot-islands/2026-06-20-construction-map-placement-design \
  --title "Map-placement UI for artificial-island construction — design" \
  --from claude-opus-4-8 --project robot-islands --tags spec,design,ui,buildings,server
```

- [ ] **Step 3: Full test sweep**

Run (requires Postgres up): `npm test`
Expected: all client + server suites pass.

- [ ] **Step 4: Commit**

```bash
git add SPEC.md docs/superpowers/specs/2026-06-20-construction-map-placement-design.md docs/superpowers/specs/2026-06-20-construction-map-placement-design.html
git commit -m "docs(construction): SPEC §2.5 discovery placement rule + design reconciliation"
```

---

## Self-Review

**Spec coverage:**
- Movable/resizable/persisted panel → Task 5 (mountPanel) + Task 6 (wiring). ✓
- Live ghost, drag-body + resize-handles, synced both ways → Task 4 (overlay) + Task 5 (panel reads candidate) + Task 6 (callbacks). ✓
- Color + reason, free drag, handles clamp at cap → Task 4 (red flag) + Task 2 (`placementBlocksGhost`) + Task 6 (cap clamp on resize). ✓
- Discovery rule, entire footprint, pure + server → Task 1 (predicate) + Task 3 (server + gateway) + Task 2 (UI path). ✓
- X/Y editable + synced → Task 5 Step 3. ✓
- SPEC update → Task 7. ✓

**Placeholder scan:** Render Tasks 3/5/6 contain "mirror the existing test / reuse the element-building code" directions rather than full re-pastes, because the exact harnesses (intents.test.ts game fixture, the construction-ui DOM builders) are large pre-existing code the implementer edits in place — the precise new lines (imports, the two `if (!...) return` blocks, the candidate wiring) are given verbatim. No "TODO/handle errors/add validation" placeholders remain.

**Type consistency:** `ConstructionCandidate` (founderId/biome/major/minor/cx/cy) is identical across Tasks 2, 4, 5, 6. `computePlacementValidity(world, islandStates, cand)` and `placementBlocksGhost(reason)` signatures match between Task 2 (def) and Tasks 5/6 (use). `regionDiscoveredOrVisible(world, cx, cy, major, minor)` matches between Task 1 (def) and Tasks 2/3 (use). Reason strings `'position-occupied'` / `'in-unknown-space'` are spelled identically across Tasks 2, 3, 5.
