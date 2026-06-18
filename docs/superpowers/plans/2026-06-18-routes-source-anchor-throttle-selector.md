# Routes: source-anchor + throttle readout + floor-scaled selector — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Draw routes starting at their source building, show each active route's actual (floor-scaled) speed plus a live throttle reason in the ledger, and show floor-scaled max throughput per building in the route-creation selector.

**Architecture:** Three additive changes. (1) A pure `routeSourceTile` resolver feeds the renderer a source-building anchor for the `from` endpoint (render-only; gameplay geometry unchanged). (2) A new pure `route-throttle.ts` diagnoses each route's bottleneck by reusing the same viability gates as `planRouteCargo`; the ledger renders a badge. (3) The building selector uses the existing `floorScaledCapacity` helper.

**Tech Stack:** Vite + TS strict + PixiJS 8 + vitest. Pure layer separated from render; tests target the pure layer.

## Global Constraints

- TS strict + `noUncheckedIndexedAccess` + `noUnusedLocals/Parameters` — new code compiles clean.
- Pure modules: no `pixi.js` import. `routes.ts`, `route-throttle.ts` stay pure. Render code reads state only.
- Every behavior change updates `SPEC.md` in the same change (§2.4/§2.6).
- TDD: failing test first, watch it fail, minimal impl, watch it pass, commit. Frequent commits.
- No persisted-save shape change (no migration).

---

### Task 1: `routeSourceTile` pure resolver

**Files:**
- Modify: `src/routes.ts` (add export near `routeFloorMultiplier`, ~line 338)
- Test: `src/routes.test.ts`

**Interfaces:**
- Produces: `routeSourceTile(route: Route, islandIndex: Map<string, IslandSpec>): { x: number; y: number } | null`

- [ ] **Step 1: Write failing test** in `src/routes.test.ts`:

```typescript
import { routeSourceTile } from './routes.js';
// ... existing imports: IslandSpec, a route factory ...

describe('routeSourceTile (#routes source anchor)', () => {
  function islandWith(buildings: Array<{ id: string; defId: string; x: number; y: number }>): IslandSpec {
    return { id: 'home', name: 'home', biome: 'plains', cx: 0, cy: 0, majorRadius: 5, minorRadius: 5,
      populated: true, discovered: true, buildings, modifiers: [] } as unknown as IslandSpec;
  }
  const idx = new Map<string, IslandSpec>([['home', islandWith([{ id: 'dock-1', defId: 'dock', x: 3, y: -2 }])]]);

  it('returns the source building tile', () => {
    const route = { from: 'home', sourceBuildingId: 'dock-1' } as unknown as import('./routes.js').Route;
    expect(routeSourceTile(route, idx)).toEqual({ x: 3, y: -2 });
  });
  it('returns null for a legacy route with no sourceBuildingId', () => {
    const route = { from: 'home' } as unknown as import('./routes.js').Route;
    expect(routeSourceTile(route, idx)).toBeNull();
  });
  it('returns null when the building was demolished', () => {
    const route = { from: 'home', sourceBuildingId: 'gone' } as unknown as import('./routes.js').Route;
    expect(routeSourceTile(route, idx)).toBeNull();
  });
});
```

- [ ] **Step 2: Run, verify it fails** — `npx vitest run src/routes.test.ts -t "routeSourceTile"` → FAIL (`routeSourceTile is not a function`).

- [ ] **Step 3: Implement** in `src/routes.ts` after `routeFloorMultiplier`:

```typescript
/** Tile coords of a route's owning source building (the route's drawn start),
 *  or null when the route has no `sourceBuildingId` (legacy) or the building /
 *  island can't be resolved (demolished / merged). Render-only — gameplay
 *  geometry stays island-centre-derived. */
export function routeSourceTile(
  route: Route,
  islandIndex: Map<string, IslandSpec>,
): { x: number; y: number } | null {
  if (route.sourceBuildingId === undefined) return null;
  const island = islandIndex.get(route.from);
  if (!island) return null;
  const b = island.buildings.find((bb) => bb.id === route.sourceBuildingId);
  if (!b) return null;
  return { x: b.x, y: b.y };
}
```

- [ ] **Step 4: Run, verify pass** — same command → PASS.
- [ ] **Step 5: Commit** — `git add src/routes.ts src/routes.test.ts && git commit -m "feat(routes): routeSourceTile pure resolver for source-anchored rendering"`

---

### Task 2: `route-throttle.ts` — reason diagnosis

**Files:**
- Create: `src/route-throttle.ts`
- Test: `src/route-throttle.test.ts`

**Interfaces:**
- Consumes: `inv`, `cap` (economy.ts), `destinationHeadroom`, `routeFloorMultiplier` (routes.ts), `effectiveSkillMultipliers` (skilltree.ts).
- Produces: `type ThrottleReason = 'draining' | 'floors-disabled' | 'idle' | 'flowing' | 'dest-full' | 'source-empty'`; `routeThrottleReason(world: WorldState, states: Map<string, IslandState>, route: Route): ThrottleReason`.

Precedence: `draining` → `floors-disabled` → `idle` (no targeted resources) → if any resource viable `flowing` → else if any has stock-but-no-headroom `dest-full` → else `source-empty`. (`low-fuel` is added in Task 2b.)

- [ ] **Step 1: Write failing tests** in `src/route-throttle.test.ts` covering: draining; floors-disabled (0 active floors); idle (empty cargo); flowing (stock+headroom); source-empty (no stock); dest-full (stock but dest at cap). Use a tiny world + two island states (mirror `routes.test.ts` factories — a `dock-1` source, explicit cargo `wood`). Each test asserts `routeThrottleReason(world, states, route)` equals the expected literal.

- [ ] **Step 2: Run, verify it fails** — `npx vitest run src/route-throttle.test.ts` → FAIL (module/function missing).

- [ ] **Step 3: Implement** `src/route-throttle.ts`:

```typescript
// Pure route-throttle diagnosis (NO pixi). Names the dominant reason an active
// route is or isn't moving cargo, reusing planRouteCargo's viability gates so the
// ledger badge can never disagree with the engine.
import { cap, inv, type IslandState } from './economy.js';
import { ALL_RESOURCES, type ResourceId } from './recipes.js';
import { effectiveSkillMultipliers } from './skilltree.js';
import { destinationHeadroom, routeFloorMultiplier, type Route } from './routes.js';
import type { WorldState } from './world.js';

export type ThrottleReason =
  | 'draining' | 'floors-disabled' | 'idle' | 'flowing' | 'dest-full' | 'source-empty';

function targetedResources(route: Route): ResourceId[] {
  const explicit = new Set<ResourceId>();
  let wildcard = false;
  for (const e of route.cargo) {
    if (e.resourceId === 'all') wildcard = true;
    else explicit.add(e.resourceId);
  }
  if (!wildcard) return [...explicit];
  return ALL_RESOURCES.filter((r) => !explicit.has(r)).concat([...explicit]);
}

export function routeThrottleReason(
  world: WorldState,
  states: Map<string, IslandState>,
  route: Route,
): ThrottleReason {
  if (route.draining === true) return 'draining';
  if (routeFloorMultiplier(route, world) === 0) return 'floors-disabled';
  const src = states.get(route.from);
  const dest = states.get(route.to);
  if (!src || !dest) return 'idle';
  const targets = targetedResources(route);
  if (targets.length === 0) return 'idle';
  const srcMul = effectiveSkillMultipliers(src);
  const destMul = effectiveSkillMultipliers(dest);
  let anyStockNoRoom = false;
  for (const r of targets) {
    const stock = inv(src, r);
    if (stock <= 0) continue;
    const headroom = destinationHeadroom(world, states, route.to, r, destMul);
    // source-floor gate (only blocks; absence of an entry = no floor gate)
    const entry = route.cargo.find((e) => e.resourceId === r);
    if (entry?.sourceFloorPct !== undefined) {
      const srcCap = cap(src, r, undefined, undefined, srcMul);
      if (srcCap <= 0 || stock / srcCap < entry.sourceFloorPct / 100) continue;
    }
    if (headroom > 0) return 'flowing';
    anyStockNoRoom = true;
  }
  return anyStockNoRoom ? 'dest-full' : 'source-empty';
}
```

- [ ] **Step 4: Run, verify pass.**
- [ ] **Step 5: Commit** — `git commit -m "feat(routes): pure routeThrottleReason diagnosis"`

---

### Task 2b: `low-fuel` reason (mass_driver / teleporter)

**Files:**
- Modify: `src/routes.ts` (extract a pure `routeFuelAffordable(world, states, route): boolean` from the dispatch fuel gate around the diesel/teleporter-biofuel logic, ~lines 239–250 + the teleporter per-tile cost), without changing dispatch behaviour.
- Modify: `src/route-throttle.ts` (insert `low-fuel` ahead of `flowing`).
- Test: `src/route-throttle.test.ts`.

- [ ] **Step 1: Write failing test** — a mass_driver route whose source has 0 Diesel (but full cargo stock + dest headroom) returns `'low-fuel'`; with Diesel it returns `'flowing'`.
- [ ] **Step 2: Run, verify fail.**
- [ ] **Step 3: Implement** — extract the existing inline fuel-affordability check into `routeFuelAffordable` (pure; reuse it from `dispatchPhase` so behaviour is identical), add `low-fuel` to `ThrottleReason`, and in `routeThrottleReason` after the `floors-disabled` check: `if ((route.type === 'mass_driver' || route.type === 'teleporter') && !routeFuelAffordable(world, states, route)) return 'low-fuel';`
- [ ] **Step 4: Run, verify pass** (and re-run `src/routes.test.ts` to confirm dispatch unchanged).
- [ ] **Step 5: Commit** — `git commit -m "feat(routes): low-fuel throttle reason via extracted routeFuelAffordable"`

---

### Task 3: `throttleBadge` presentation map

**Files:**
- Modify: `src/route-throttle.ts`
- Test: `src/route-throttle.test.ts`

**Interfaces:**
- Produces: `throttleBadge(reason: ThrottleReason): { text: string; tone: 'ok' | 'warn' | 'muted' }`.

- [ ] **Step 1: Write failing test** — `throttleBadge('flowing')` → `{ text: '▶ flowing', tone: 'ok' }`; `'source-empty'` → `{ text: '⏸ source empty', tone: 'muted' }`; `'dest-full'` → `{ text: '⛔ dest full', tone: 'warn' }`; `'floors-disabled'` → `{ text: 'floors off', tone: 'muted' }`; `'draining'` → `{ text: 'draining', tone: 'muted' }`; `'idle'` → `{ text: 'idle', tone: 'muted' }`; `'low-fuel'` → `{ text: 'low fuel', tone: 'warn' }`.
- [ ] **Step 2: Run, verify fail.**
- [ ] **Step 3: Implement** a `Record<ThrottleReason, {text,tone}>` lookup returned by `throttleBadge`.
- [ ] **Step 4: Run, verify pass.**
- [ ] **Step 5: Commit** — `git commit -m "feat(routes): throttleBadge presentation map"`

---

### Task 4: Renderer draws `from` at the source building

**Files:**
- Modify: `src/routes-renderer.ts` (constructor + `diffRebuild` `from` resolution)
- Modify: `src/main.ts:2101` (pass a `resolveRouteSourcePos` resolver)
- Test: visual (Daedalus screenshot) + the existing renderer behaviour (no unit harness for the renderer; rely on tsc + screenshot).

- [ ] **Step 1: Add optional resolver to `RouteRenderer`.** Constructor gains a second optional param `private readonly resolveRouteSourcePos?: (route: Route) => { x: number; y: number } | null`. In `diffRebuild`, change the `from` resolution to: `const from = this.resolveRouteSourcePos?.(r) ?? this.resolveIslandPos(r.from);` (`to` unchanged). The cache key already includes `from.x/from.y`, so a building move/floor change rebuilds.
- [ ] **Step 2: Wire it in `main.ts`** at the `new RouteRenderer(...)` call (2101): pass a second arg:

```typescript
}, (route) => {
  const tile = routeSourceTile(route, islandSpecsById);
  return tile ? tileToWorldPx(tile.x, tile.y) : null;
});
```
(import `routeSourceTile` from `./routes.js`.)

- [ ] **Step 3: Build + verify** — `npx tsc -b` (exit 0), `npm run build`, reload the dev tab, `mcp__daedalus__screenshot`: route lines now start at the source building, not the island centre.
- [ ] **Step 4: Commit** — `git commit -m "feat(routes): render routes starting at their source building"`

---

### Task 5: Draft preview anchors at the selected via-building + ledger throttle badge

**Files:**
- Modify: `src/routes-ui.ts` (ledger row: render badge from `routeThrottleReason`/`throttleBadge`; add reason to `routeRowStructKey`; draft preview start)
- Modify: `src/routes-renderer.ts` `paintOverlay` draft branch if the draft start is computed there
- Test: `src/routes-ui.test.ts` (badge text via the existing mount harness OR a focused pure check on `routeStructKey` including reason)

- [ ] **Step 1:** In the ledger row builder, compute `const reason = routeThrottleReason(deps.world, deps.islandStates, route);` and append a `<span>` with `throttleBadge(reason).text` coloured by `tone` (map tone→`--ri-accent`/`--ri-warn`/`--ri-fg-4`). Only show for non-power-link cargo routes.
- [ ] **Step 2:** Include the reason in `routeRowStructKey` (pass through to the exported `routeStructKey` as an extra keyed field, OR concatenate in the delegator) so the row rebuilds when the throttle state flips. Add a `routes-ui.test.ts` assertion that the struct key differs between two throttle reasons.
- [ ] **Step 3:** Draft preview: where the new-route preview start point is computed (from-island centre today), use the selected via-building tile (`routeSourceTile`-style lookup on the chosen building) so the preview matches the real route.
- [ ] **Step 4: Build + verify** — `npx vitest run src/routes-ui.test.ts`, `npx tsc -b`, `npm run build`, screenshot: active route rows show a throttle badge; creating a route previews from the building.
- [ ] **Step 5: Commit** — `git commit -m "feat(routes-ui): active-route throttle badge + building-anchored draft preview"`

---

### Task 6: Floor-scaled max in the building selector

**Files:**
- Modify: `src/routes-ui.ts` `buildBuildingOptions()` (the source-building option label, ~line 521 region)
- Test: `src/routes-ui.test.ts`

- [ ] **Step 1: Write failing test** — mount/route the selector (or extract a pure `buildingOptionLabel(b, profile)` helper and test it): a floor-2 dock (`floorLevel: 1`, base 0.5 u/s) shows `1.00 u/s` (0.5 × (1+1)), not `0.5`.
- [ ] **Step 2: Run, verify fail.**
- [ ] **Step 3: Implement** — change the option label to use `floorScaledCapacity(b, profile.capacityPerSec)` (import from `./buildings.js`) formatted with `fmtUPerSec`. If cleaner, extract `export function buildingOptionLabel(b, profile): string` and unit-test that.
- [ ] **Step 4: Run, verify pass.**
- [ ] **Step 5: Commit** — `git commit -m "feat(routes-ui): building selector shows floor-scaled max throughput"`

---

### Task 7: SPEC update

**Files:**
- Modify: `SPEC.md` §2.4 (and §2.6 if the ledger is described there)

- [ ] **Step 1:** Add to §2.4: routes are drawn starting at their source building (render-only; gameplay geometry unchanged), and the ledger surfaces each active route's effective speed plus a live throttle reason (flowing / source-empty / dest-full / floors-off / low-fuel / draining). Note the new-route selector shows floor-scaled max throughput (already implied by the §2.4 floor-scaling paragraph).
- [ ] **Step 2: Commit** — `git commit -m "docs(spec): §2.4 source-anchored route rendering + throttle readout"`

---

## Self-Review

- **Spec coverage:** ask 1 → Tasks 1+4; ask 2 (actual speed) → existing effective line kept + Task 5 badge; ask 2 (throttle) → Tasks 2/2b/3/5; ask 3 → Task 6. SPEC → Task 7. ✓
- **Type consistency:** `routeSourceTile` (Task 1) reused in Task 4 + Task 5 preview; `ThrottleReason`/`routeThrottleReason`/`throttleBadge` (Tasks 2/2b/3) consumed in Task 5; `floorScaledCapacity`/`fmtUPerSec` are existing exports. ✓
- **Placeholders:** Task 2 test bodies and Task 5/6 exact label code are described concretely; the pure-helper code blocks are complete. Renderer/UI steps are render-layer (screenshot-verified), consistent with the codebase's no-unit-harness-for-render convention.
