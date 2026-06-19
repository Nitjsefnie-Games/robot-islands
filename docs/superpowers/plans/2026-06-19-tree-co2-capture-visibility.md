# CO₂-capture Visibility Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Surface CO₂ capture in the building inspector for all three sink buildings (`plant_a_tree`, `wastewater_treatment`, `exhaust_scrubber`) so floor/cluster/active multipliers — which already scale capture — become visible, and fix the floor-upgrade copy that falsely claims "throughput" for a tree.

**Architecture:** Add one pure helper `co2CaptureKgPerMin(...)` (testable in isolation, matching the `recipeToLines`/`bonusesText` pattern) plus economy regression tests that lock the already-working scaling. Wire the helper into a new "CO₂ Capture" DOM section in `mountInspectorUi`, and branch the FLOORS preview copy. No simulation/balance change.

**Tech Stack:** TypeScript strict, vitest (`happy-dom` for inspector tests), PixiJS-free pure layer.

## Global Constraints

- TypeScript strict + `noUncheckedIndexedAccess` + `noUnusedLocals`/`noUnusedParameters` — new code compiles clean.
- No changes to `recipes.ts`, `building-defs.ts`, or simulation behavior in `economy.ts` (the only `economy.ts` edit permitted is adding `export` to the existing `hasNeighborWithAnyDefId` — a pure refactor, zero behavior change).
- No SPEC.md change (UI-only; mechanic unchanged).
- Co-author trailer on every commit: `Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>`.
- Capture formulas (exact):
  - recipe-backed (tree): `kg/min = co2CaptureKgPerCycle × effectiveRate × 60`.
  - flat (wastewater/scrubber, no recipe): `kg/min = co2CaptureKgPerCycle` (cadence is 1 cycle / 60 s).
  - scrubber when its `co2CaptureAdjacency` neighbour is absent → idle → `0 kg/min`.

---

### Task 1: Economy regression tests — lock the capture scaling

**Files:**
- Test: `src/economy.test.ts` (append to the existing CO₂-sink `describe` block near line 5225)

**Interfaces:**
- Consumes: `advanceIsland`, `makeInitialIslandState`, `DEMO_ISLANDS_TEST_FIXTURE` (from existing imports / `./world.js`).
- Produces: nothing for later tasks (pure safety net).

These assert behavior that ALREADY passes — they are a regression lock, so they go green immediately.

- [ ] **Step 1: Write the tests**

Add helper + tests inside the existing CO₂ `describe`:

```ts
function treeDrain(
  buildings: Array<{ id: string; defId: PlacedBuilding['defId']; x: number; y: number; floorLevel?: number }>,
  ctxExtra: Record<string, unknown> = {},
): number {
  const spec = DEMO_ISLANDS_TEST_FIXTURE[0]!;
  const state = makeInitialIslandState(spec, 0);
  state.buildings = buildings as unknown as IslandState['buildings'];
  state.level = 10;
  state.co2Kg = 1000;
  advanceIsland(state, 600_000, { terrainAt: () => 'tree', ...ctxExtra } as RatesContext);
  return 1000 - state.co2Kg;
}

it('floor upgrade scales tree capture by floorEffectMul', () => {
  const d0 = treeDrain([{ id: 't', defId: 'plant_a_tree', x: 5, y: 5, floorLevel: 0 }]);
  const d3 = treeDrain([{ id: 't', defId: 'plant_a_tree', x: 5, y: 5, floorLevel: 3 }]);
  expect(d3 / d0).toBeCloseTo(4, 1); // floorEffectMul(3) = 1 + 3
});

it('cluster bonus scales tree capture (4-cluster ≈ ×1.15/tree)', () => {
  const lone = treeDrain([{ id: 't', defId: 'plant_a_tree', x: 5, y: 5 }]);
  const cluster = treeDrain([
    { id: 'a', defId: 'plant_a_tree', x: 5, y: 5 },
    { id: 'b', defId: 'plant_a_tree', x: 6, y: 5 },
    { id: 'c', defId: 'plant_a_tree', x: 5, y: 6 },
    { id: 'd', defId: 'plant_a_tree', x: 6, y: 6 },
  ]);
  expect(cluster / 4 / lone).toBeCloseTo(1.15, 2); // 1 + 0.05×(K−c_i), K=4, c_i=1
});

it('active-play bonus scales tree capture', () => {
  const base = treeDrain([{ id: 't', defId: 'plant_a_tree', x: 5, y: 5 }]);
  const boosted = treeDrain([{ id: 't', defId: 'plant_a_tree', x: 5, y: 5 }], { activeBonusMul: 2 });
  expect(boosted / base).toBeCloseTo(2, 1);
});
```

Ensure `DEMO_ISLANDS_TEST_FIXTURE`, `RatesContext`, `IslandState`, `PlacedBuilding` are imported at the top of the test file (add to existing import lines if missing).

- [ ] **Step 2: Run and verify they PASS (already-working behavior)**

Run: `cd /root/robot-islands && npx vitest run src/economy.test.ts -t "tree capture"`
Expected: 3 pass (floor ×4, cluster ×1.15, active ×2).

- [ ] **Step 3: Commit**

```bash
git add src/economy.test.ts
git commit -m "test(economy): lock plant_a_tree CO₂ capture scaling (floor/cluster/active)

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

### Task 2: Pure `co2CaptureKgPerMin` helper + unit tests

**Files:**
- Modify: `src/inspector-ui.ts` (add exported pure function near `recipeToLines`, ~line 263)
- Test: `src/inspector-ui.test.ts` (new `describe` block)

**Interfaces:**
- Produces (consumed by Task 3):
  ```ts
  export function co2CaptureKgPerMin(opts: {
    co2CaptureKgPerCycle: number;
    recipeBacked: boolean;   // building has a recipe → rate-driven; else flat
    effectiveRate: number;   // cycles/s; used only when recipeBacked
    adjacencyActive: boolean; // false → idle (scrubber with no adjacent emitter)
  }): number
  ```

- [ ] **Step 1: Write the failing tests**

```ts
describe('co2CaptureKgPerMin', () => {
  it('recipe-backed: kg/cycle × effectiveRate × 60', () => {
    // tree: 0.1 kg/cycle, effectiveRate 0.130 cyc/s → 0.78 kg/min
    expect(co2CaptureKgPerMin({ co2CaptureKgPerCycle: 0.1, recipeBacked: true, effectiveRate: 0.130, adjacencyActive: true }))
      .toBeCloseTo(0.78, 2);
  });
  it('flat: kg/min equals kg/cycle', () => {
    expect(co2CaptureKgPerMin({ co2CaptureKgPerCycle: 5, recipeBacked: false, effectiveRate: 0, adjacencyActive: true }))
      .toBeCloseTo(5, 6);
  });
  it('idle adjacency → 0', () => {
    expect(co2CaptureKgPerMin({ co2CaptureKgPerCycle: 20, recipeBacked: false, effectiveRate: 0, adjacencyActive: false }))
      .toBe(0);
  });
});
```

Add `co2CaptureKgPerMin` to the import on line 5.

- [ ] **Step 2: Run to verify FAIL**

Run: `cd /root/robot-islands && npx vitest run src/inspector-ui.test.ts -t "co2CaptureKgPerMin"`
Expected: FAIL — `co2CaptureKgPerMin is not a function`.

- [ ] **Step 3: Implement the helper** (in `src/inspector-ui.ts`, after `recipeToLines`)

```ts
/** kg of CO₂ removed per minute by a sink building. Recipe-backed sinks
 *  (plant_a_tree) scale with their effective cycle rate — so floor/cluster/
 *  active multipliers flow through; flat sinks (wastewater/scrubber) capture a
 *  fixed amount per 60 s cadence (`economy.ts` `dtSec/60` fallback). A scrubber
 *  with no adjacent emitter is idle and captures nothing. */
export function co2CaptureKgPerMin(opts: {
  co2CaptureKgPerCycle: number;
  recipeBacked: boolean;
  effectiveRate: number;
  adjacencyActive: boolean;
}): number {
  if (!opts.adjacencyActive) return 0;
  return opts.recipeBacked
    ? opts.co2CaptureKgPerCycle * opts.effectiveRate * 60
    : opts.co2CaptureKgPerCycle;
}
```

- [ ] **Step 4: Run to verify PASS**

Run: `cd /root/robot-islands && npx vitest run src/inspector-ui.test.ts -t "co2CaptureKgPerMin"`
Expected: 3 pass.

- [ ] **Step 5: Commit**

```bash
git add src/inspector-ui.ts src/inspector-ui.test.ts
git commit -m "feat(inspector): pure co2CaptureKgPerMin helper

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

### Task 3: Wire the "CO₂ Capture" DOM section into the inspector

**Files:**
- Modify: `src/economy.ts:50` — add `export` to `hasNeighborWithAnyDefId`.
- Modify: `src/inspector-ui.ts` — import the helper, create the section, append it, paint it.

**Interfaces:**
- Consumes: `co2CaptureKgPerMin` (Task 2); `hasNeighborWithAnyDefId(b, buildings, defIds)` (now exported from `./economy.js`); `BUILDING_DEFS`, `resolveRecipe`, `computeRates` (already imported).
- Produces: nothing downstream.

- [ ] **Step 1: Export the adjacency helper** (`src/economy.ts` line 50)

Change `function hasNeighborWithAnyDefId(` → `export function hasNeighborWithAnyDefId(`.

- [ ] **Step 2: Import it in the inspector** (`src/inspector-ui.ts`, with the existing `./economy.js` import or as a new import line)

```ts
import { computeRates, hasNeighborWithAnyDefId } from './economy.js';
```
(Merge with the existing `computeRates` import — do not duplicate.)

- [ ] **Step 3: Create the section** (after the recipe section is built, before `body.appendChild(powerSection.wrap)` — i.e. add the section object near the other `makeSection` calls, ~line 970)

```ts
// CO₂ Capture section — shown for any def with co2CaptureKgPerCycle > 0.
const co2Section = makeSection('CO₂ Capture');
const co2Line = document.createElement('span');
styled(co2Line, [`color: ${'var(--ri-fg-1)'}`, 'font-size: 11px', 'letter-spacing: 0.02em'].join(';'));
const co2DerivLine = document.createElement('span');
styled(co2DerivLine, [`color: ${'var(--ri-fg-3)'}`, 'font-size: 10px', 'letter-spacing: 0.02em'].join(';'));
co2Section.body.appendChild(co2Line);
co2Section.body.appendChild(co2DerivLine);
```

- [ ] **Step 4: Append the section** (insert immediately after `body.appendChild(recipeSection.wrap);`, currently line 1483)

```ts
body.appendChild(co2Section.wrap);
```

- [ ] **Step 5: Hoist the tree's effective rate** so the CO₂ section can read it. In the recipe `else` branch where `const effective = br?.effectiveRate ?? 0;` is computed (line ~1673), assign to an outer-scoped variable. Declare `let captureEffectiveRate = 0;` just before the `if (!recipe) {` block (~line 1657) and set `captureEffectiveRate = effective;` inside the `else` branch right after `effective` is computed.

- [ ] **Step 6: Paint the section** (add after the floor-section paint, ~line 1907, inside the same paint closure)

```ts
const co2PerCycle = def.co2CaptureKgPerCycle ?? 0;
if (co2PerCycle > 0) {
  const recipeBacked = recipe !== undefined;
  const adjacencyActive = def.co2CaptureAdjacency
    ? hasNeighborWithAnyDefId(building, state.buildings, def.co2CaptureAdjacency)
    : true;
  const kgPerMin = co2CaptureKgPerMin({
    co2CaptureKgPerCycle: co2PerCycle,
    recipeBacked,
    effectiveRate: captureEffectiveRate,
    adjacencyActive,
  });
  co2Line.textContent = `−${kgPerMin.toFixed(2)} kg/min`;
  co2Line.style.color = kgPerMin > 0 ? 'var(--ri-accent)' : 'var(--ri-fg-4)';
  if (recipeBacked) {
    co2DerivLine.textContent = `${co2PerCycle} kg/cycle × ${captureEffectiveRate.toFixed(3)} cyc/s`;
  } else if (!adjacencyActive) {
    co2DerivLine.textContent = 'IDLE — needs adjacent emitter';
  } else {
    co2DerivLine.textContent = `${co2PerCycle} kg/cycle (flat)`;
  }
  co2DerivLine.style.display = '';
  co2Section.wrap.style.display = '';
} else {
  co2Section.wrap.style.display = 'none';
}
```

- [ ] **Step 7: Typecheck + build**

Run: `cd /root/robot-islands && npx tsc -b && npm run build 2>&1 | tail -3`
Expected: clean typecheck, `✓ built`.

- [ ] **Step 8: Visual verification.** Reload the browser tab (preview serves stale `dist/` until reload), open the inspector on a Plant a Tree, confirm a `CO₂ Capture −X.XX kg/min` line with the `kg/cycle × cyc/s` derivation. Screenshot via `mcp__daedalus__screenshot`. Also confirm an Exhaust Scrubber shows the flat value + IDLE when not adjacent to an emitter.

- [ ] **Step 9: Commit**

```bash
git add src/economy.ts src/inspector-ui.ts
git commit -m "feat(inspector): show CO₂ capture for sink buildings

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

### Task 4: Floor-upgrade copy fix for recipe-backed capture buildings

**Files:**
- Modify: `src/inspector-ui.ts:1845-1847` (the `floorEffectDesc` branch)
- Test: covered by the existing build/visual check (copy-only, no new unit needed); optional assertion via a `floorEffectDesc`-style pure check is NOT required.

**Interfaces:** none.

- [ ] **Step 1: Branch the floor copy.** Replace the `floorEffectDesc` assignment (lines 1845-1847):

```ts
const isRecipeBackedCapture =
  (def.co2CaptureKgPerCycle ?? 0) > 0 &&
  recipe !== undefined &&
  Object.keys(recipe.outputs).length === 0;
const floorEffectDesc = def.category === 'logistics'
  ? 'route capacity & speed'
  : isRecipeBackedCapture
    ? 'CO₂ capture'
    : 'throughput / capacity / power-out';
```

This selects "CO₂ capture" only for recipe-backed, output-less sinks (the tree). Flat sinks (no recipe) keep the generic copy, since their capture does not scale with floors.

- [ ] **Step 2: Typecheck + build**

Run: `cd /root/robot-islands && npx tsc -b && npm run build 2>&1 | tail -3`
Expected: clean.

- [ ] **Step 3: Visual verification.** Reload tab, open a Plant a Tree inspector, confirm FLOORS reads `… next: ×N CO₂ capture`. Screenshot.

- [ ] **Step 4: Commit**

```bash
git add src/inspector-ui.ts
git commit -m "fix(inspector): floor preview says 'CO₂ capture' for trees, not throughput

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Final verification

- [ ] `cd /root/robot-islands && npx vitest run src/economy.test.ts src/inspector-ui.test.ts` — all green.
- [ ] `cd /root/robot-islands && cd server && npx tsc --noEmit` is NOT required (no server change); root `npx tsc -b` clean.
- [ ] Screenshots confirm: tree shows `CO₂ Capture −0.78 kg/min` + derivation + `CO₂ capture` floor copy; scrubber shows flat value + ACTIVE/IDLE.

## Self-review notes (done)

- **Spec coverage:** A (section) → Tasks 2+3; flat wastewater/scrubber + adjacency → Task 3 Step 6; B (floor copy) → Task 4; C (regression + helper tests) → Tasks 1+2. All spec sections mapped.
- **Type consistency:** `co2CaptureKgPerMin` opts shape identical in Task 2 (def + test) and Task 3 (call site). `hasNeighborWithAnyDefId(building, state.buildings, def.co2CaptureAdjacency)` matches the economy signature.
- **No placeholders:** every code step shows full code.
