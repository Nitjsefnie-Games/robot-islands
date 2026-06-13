# Force-Run produce-at-cap toggle — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a per-building **Force Run** toggle that keeps a building producing for XP when its output bin is full, voiding the overflow at the cap while inputs, power, and maintenance wear remain real costs.

**Architecture:** One carve-out in the pure net-flow solver (`flow-solver.ts`): a building flagged `ignoreOutputCap` is excluded from the `cap:r` constraint, so a full output bin no longer drives its gate to 0. The event-driven integrator already clamps overflow to `[0, cap]` (`economy.ts` `applyRates`) and already refuses recurring events at a pinned full bin (`findNextCapEvent`), so XP and wear follow automatically once the gate stays open. A per-building `forceRun?: boolean` on `PlacedBuilding` carries the player setting (round-trips through persistence for free); an inspector toggle button sets it.

**Tech Stack:** Vite 5 + TypeScript strict + PixiJS 8 + vitest. Pure layer is unit-tested; render layer (`inspector-ui.ts`, `main.ts`) is verified by `tsc` + visual smoke test.

**Design spec:** `docs/superpowers/specs/2026-06-13-force-run-produce-at-cap-design.md` (HTML: `docs.nitjsefni.eu/d/robot-islands/2026-06-13-force-run-produce-at-cap-design`).

---

## File Structure

| File | Responsibility | Change |
|---|---|---|
| `src/flow-solver.ts` | Pure net-flow solver | Add `ignoreOutputCap?` to `FlowBuildingSpec`; exclude such buildings from `cap:r` key assignment and from the cap constraint's producer entries. |
| `src/buildings.ts` | `PlacedBuilding` type | Add `forceRun?: boolean`. |
| `src/economy.ts` | Rate computation | `buildFlowBuildings` sets `ignoreOutputCap: b.forceRun`; the `ownFlowSpecs` lattice snapshot carries the flag. |
| `src/inspector-ui.ts` | Per-building inspector panel | Add the Force Run toggle button + registry action + `onSetForceRun` dep; show only for resource-producing buildings, hide under construction. |
| `src/main.ts` | Render-layer wiring | Implement `onSetForceRun` (mutate `building.forceRun`, bump autosave). |
| `src/SPEC.md` | Spec source of truth | §4.6 cap-throttle override + §4.7 maintenance caveat. |

Tests: `src/flow-solver.test.ts`, `src/economy.test.ts`, `src/persistence.test.ts` (extend existing files).

---

### Task 1: Flow-solver — exclude force-run buildings from the cap constraint

**Files:**
- Modify: `src/flow-solver.ts` (interface `FlowBuildingSpec` ~line 15; `keysByBuilding` ~line 109; `update` cap branch ~line 145)
- Test: `src/flow-solver.test.ts`

- [ ] **Step 1: Write the failing test**

Add to `src/flow-solver.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { solveFlow } from './flow-solver.js';

describe('flow-solver — ignoreOutputCap (force run)', () => {
  it('a force-run producer keeps gate 1 at a capped output with no consumer; a normal one gates to 0', () => {
    // Two independent producers of resource "x"; "x" is at cap, nothing consumes it.
    const buildings = [
      { produces: { x: 5 }, consumes: {} },                      // normal → gates to 0
      { produces: { x: 5 }, consumes: {}, ignoreOutputCap: true }, // force-run → stays 1
    ];
    const { gates } = solveFlow(buildings, {
      capConstrained: new Set(['x']),
      zeroConstrained: new Set(),
    });
    expect(gates[0]).toBeCloseTo(0, 9);
    expect(gates[1]).toBeCloseTo(1, 9);
  });

  it('force-run producer does not absorb the consumer draw owed by normal producers', () => {
    // "x" at cap, a consumer draws 5/s of x. The normal producer must still
    // throttle to 5 (matching the consumer); the force-run producer runs full
    // and is irrelevant to that solve.
    const buildings = [
      { produces: { x: 10 }, consumes: {} },                       // normal: should gate to 0.5 (→5/s)
      { produces: { x: 10 }, consumes: {}, ignoreOutputCap: true }, // force-run: stays 1
      { produces: {}, consumes: { x: 5 } },                         // consumer draw 5/s
    ];
    const { gates } = solveFlow(buildings, {
      capConstrained: new Set(['x']),
      zeroConstrained: new Set(),
    });
    expect(gates[0]).toBeCloseTo(0.5, 6);
    expect(gates[1]).toBeCloseTo(1, 9);
    expect(gates[2]).toBeCloseTo(1, 9);
  });

  it('force-run does not exempt a building from input-empty (zero) constraints', () => {
    // Force-run building consumes "y" which is at zero and unproduced → its
    // gate must still be 0 (it cannot conjure inputs).
    const buildings = [
      { produces: { x: 5 }, consumes: { y: 1 }, ignoreOutputCap: true },
    ];
    const { gates } = solveFlow(buildings, {
      capConstrained: new Set(['x']),
      zeroConstrained: new Set(['y']),
    });
    expect(gates[0]).toBeCloseTo(0, 9);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/flow-solver.test.ts -t "ignoreOutputCap"`
Expected: FAIL — `ignoreOutputCap` is not in the type / not honored, so gate[1] is 0 (capped like a normal producer), and the second test's gate[1] is 0.

- [ ] **Step 3: Add the field to `FlowBuildingSpec`**

In `src/flow-solver.ts`, extend the interface (after the `consumes` field, ~line 19):

```ts
export interface FlowBuildingSpec {
  /** Production coefficients, units/sec at gate 1. */
  readonly produces: Readonly<Record<string, number>>;
  /** Consumption coefficients, units/sec at gate 1. */
  readonly consumes: Readonly<Record<string, number>>;
  /** Force-run (§4.6): when true, this building's PRODUCTION is exempt from
   *  output-cap throttling — a full output bin no longer drives its gate to 0.
   *  Its overflow is voided downstream by `applyRates`' clamp. It is NOT
   *  exempt from input-empty (zero) constraints or the power factor. */
  readonly ignoreOutputCap?: boolean;
}
```

- [ ] **Step 4: Skip cap-key assignment for force-run producers**

In `keysByBuilding` (~line 109), guard the producer loop with the flag:

```ts
  const keysByBuilding: MulKey[][] = buildings.map((b) => {
    const ks: MulKey[] = [];
    if (!b.ignoreOutputCap) {
      for (const r of Object.keys(b.produces)) {
        if ((b.produces[r] ?? 0) > 0 && constraints.capConstrained.has(r)) ks.push(`cap:${r}`);
      }
    }
    for (const r of Object.keys(b.consumes)) {
      if ((b.consumes[r] ?? 0) > 0 && constraints.zeroConstrained.has(r)) ks.push(`zero:${r}`);
    }
    return ks;
  });
```

(The `zero:` keys are deliberately still assigned — force-run does not exempt input starvation.)

- [ ] **Step 5: Skip force-run producers in the cap constraint's `update`**

In `update`, the `if (isCap)` branch (~line 145), skip force-run buildings from the producer side so the shared θ governs only non-force-run producers. The consumer (`else if (c > 0)`) accounting is untouched, so a force-run building that merely *consumes* a capped resource still counts as real demand:

```ts
      for (let i = 0; i < buildings.length; i++) {
        const p = buildings[i]!.produces[res] ?? 0;
        const c = buildings[i]!.consumes[res] ?? 0;
        if (p > 0) {
          if (buildings[i]!.ignoreOutputCap) continue; // force-run: outside cap throttle (overflow voided)
          const net = p - c;
          if (net > 0) {
            entries.push({ coeff: net, otherGate: gate(i, key) });
          }
        } else if (c > 0) {
          target += c * gate(i, key);
        }
      }
```

- [ ] **Step 6: Run the test to verify it passes**

Run: `npx vitest run src/flow-solver.test.ts`
Expected: PASS (new `ignoreOutputCap` tests + all pre-existing flow-solver tests).

- [ ] **Step 7: Commit**

```bash
git add src/flow-solver.ts src/flow-solver.test.ts
git commit -m "feat(flow-solver): ignoreOutputCap exempts a building from cap:r throttle

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

### Task 2: Add the `forceRun` field to `PlacedBuilding`

**Files:**
- Modify: `src/buildings.ts` (the `PlacedBuilding` interface, near the `disabledFloors?` field ~line 152)

- [ ] **Step 1: Add the field**

In `src/buildings.ts`, in the `PlacedBuilding` interface, after `disabledFloors?: number;`:

```ts
  /** Force-run (§4.6): keep producing for XP even when an output bin is at
   *  cap. Absent / false = default (throttle to consumer draw at a full bin).
   *  The building still consumes inputs + power and accrues maintenance wear;
   *  the overflow output is voided at the cap. Free + instantly reversible via
   *  the inspector toggle. */
  forceRun?: boolean;
```

- [ ] **Step 2: Verify it compiles**

Run: `npx tsc -b`
Expected: clean (no errors). The field is additive and optional.

- [ ] **Step 3: Commit**

```bash
git add src/buildings.ts
git commit -m "feat(buildings): add forceRun flag to PlacedBuilding

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

### Task 3: Thread `forceRun` through `economy.buildFlowBuildings`

**Files:**
- Modify: `src/economy.ts` (`buildFlowBuildings` ~line 1533; `ownFlowSpecs` snapshot ~line 1555)
- Test: `src/economy.test.ts`

- [ ] **Step 1: Write the failing integration test**

Add to `src/economy.test.ts`. Use the existing test helpers in that file to build a minimal island; the snippet below uses the canonical pattern — adapt the import names / island-construction helper to whatever the file already uses (search the file for an existing `advanceIsland` test that places a Mine and pre-fills inventory to copy its exact setup).

```ts
import { describe, it, expect } from 'vitest';
import { advanceIsland } from './economy.js';
// reuse the file's existing island/state builders (see other tests in this file)

describe('force run — produce at cap for XP', () => {
  it('a force-run producer at a full output bin earns XP, voids overflow, and wears', () => {
    // Build an island with a single resource producer (e.g. a Mine producing
    // iron_ore) and pre-fill iron_ore to exactly its cap so the bin is full.
    // Set the building's forceRun = true.
    const { state } = makeIslandWithMine(); // <- use the file's helper
    const mine = state.buildings[0]!;
    mine.forceRun = true;
    state.inventory.iron_ore = cap(state, 'iron_ore'); // pin at cap
    const xpBefore = state.xp;
    const wearBefore = mine.operatingMs ?? 0;

    advanceIsland(state, state.lastTick + 60_000); // 60s

    expect(state.inventory.iron_ore).toBeCloseTo(cap(state, 'iron_ore'), 6); // overflow voided
    expect(state.xp).toBeGreaterThan(xpBefore);          // XP accrued
    expect(mine.operatingMs ?? 0).toBeGreaterThan(wearBefore); // wear accrued
  });

  it('with forceRun OFF, the same capped producer earns no XP and no wear', () => {
    const { state } = makeIslandWithMine();
    const mine = state.buildings[0]!;
    mine.forceRun = false;
    state.inventory.iron_ore = cap(state, 'iron_ore');
    const xpBefore = state.xp;
    const wearBefore = mine.operatingMs ?? 0;

    advanceIsland(state, state.lastTick + 60_000);

    expect(state.xp).toBeCloseTo(xpBefore, 6);           // no XP
    expect(mine.operatingMs ?? 0).toBeCloseTo(wearBefore, 6); // no wear
  });
});
```

> **If a clean Mine helper doesn't exist:** copy the island/state construction from the nearest existing `advanceIsland` test in `economy.test.ts` (e.g. "Mine fills iron_ore to exactly cap") and pre-fill inventory to cap. The assertions above are the contract; the setup must match the file's conventions.

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/economy.test.ts -t "force run"`
Expected: FAIL — `forceRun` is not yet threaded to the solver, so the capped Mine gates to 0: no XP, no wear (first test fails on `xp > xpBefore`).

- [ ] **Step 3: Thread the flag in `buildFlowBuildings`**

In `src/economy.ts`, `buildFlowBuildings` (~line 1533), add `ignoreOutputCap` to the returned spec:

```ts
  const buildFlowBuildings = (pf: number): FlowBuildingSpec[] =>
    tentative.map((te, i) => {
      if (te.baseRate <= 0) return { produces: {}, consumes: {} };
      const scale = consumesPowerByIdx[i] ? pf : 1;
      const produces: Record<string, number> = {};
      const outs = resolveRotatingOutput(te.recipe, t);
      for (const [r, yld] of Object.entries(outs)) {
        const flow = (yld ?? 0) * te.baseRate * te.perBuildingMul * scale;
        if (flow > 0) produces[r] = flow;
      }
      const consumes: Record<string, number> = {};
      for (const [r, need] of Object.entries(te.recipe.inputs)) {
        if (te.recipe.exogenousFlow === 'atmosphere' && r === 'air') continue;
        const flow = ((need ?? 0) / recipeInputDiv) * te.baseRate * te.perBuildingMul * scale;
        if (flow > 0) consumes[r] = flow;
      }
      return { produces, consumes, ignoreOutputCap: te.building.forceRun === true };
    });
```

- [ ] **Step 4: Carry the flag into the lattice `ownFlowSpecs` snapshot**

In `src/economy.ts` (~line 1555), include `ignoreOutputCap` when snapshotting own specs so a force-run building stays exempt when unioned into a lattice sibling's solve:

```ts
  const ownFlowSpecs: FlowBuildingSpec[] = buildFlowBuildings(1).map((fb) => ({
    produces: { ...fb.produces },
    consumes: { ...fb.consumes },
    ...(fb.ignoreOutputCap ? { ignoreOutputCap: true } : {}),
  }));
```

- [ ] **Step 5: Run the test to verify it passes**

Run: `npx vitest run src/economy.test.ts -t "force run"`
Expected: PASS — capped force-run Mine earns XP + wear; forceRun-off Mine earns neither.

- [ ] **Step 6: Run the full economy suite (no regressions)**

Run: `npx vitest run src/economy.test.ts`
Expected: PASS (all pre-existing economy tests still green — pf=1 path is byte-identical for non-force buildings because `ignoreOutputCap` is `false`/absent there).

- [ ] **Step 7: Commit**

```bash
git add src/economy.ts src/economy.test.ts
git commit -m "feat(economy): thread forceRun into the net-flow solver

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

### Task 4: Persistence round-trip for `forceRun`

**Files:**
- Test: `src/persistence.test.ts`

`forceRun` is a purely additive optional field on `PlacedBuilding`; serialize omits only `terrainAt` and spreads the rest, deserialize spreads `{...b}` with timestamp shifts (see `src/persistence.ts`), so no migration and no schema bump are required. This task adds a regression test proving it round-trips and that legacy saves (field absent) load with Force Run off.

- [ ] **Step 1: Write the test**

Add to `src/persistence.test.ts` (reuse the file's existing `saveWorld`/`loadWorld` round-trip helper and world fixture — search for an existing round-trip test to copy the setup):

```ts
import { describe, it, expect } from 'vitest';
import { saveWorld, loadWorld } from './persistence.js';

describe('persistence — forceRun round-trip', () => {
  it('forceRun: true survives a save/load cycle', () => {
    const world = makeRoundTripWorld();           // <- file's existing helper
    const b = firstBuilding(world);               // <- pick any placed building
    b.forceRun = true;
    const reloaded = loadWorld(saveWorld(world));
    expect(firstBuilding(reloaded).forceRun).toBe(true);
  });

  it('a save with no forceRun field loads with Force Run off', () => {
    const world = makeRoundTripWorld();
    const reloaded = loadWorld(saveWorld(world));
    expect(firstBuilding(reloaded).forceRun).toBeUndefined();
  });
});
```

> Match `makeRoundTripWorld` / `firstBuilding` to the helpers already in `persistence.test.ts`. The contract is: `forceRun: true` survives; absent stays absent (≡ off).

- [ ] **Step 2: Run the test to verify it passes**

Run: `npx vitest run src/persistence.test.ts -t "forceRun"`
Expected: PASS immediately (round-trips for free — this test documents/locks the behavior).

- [ ] **Step 3: Commit**

```bash
git add src/persistence.test.ts
git commit -m "test(persistence): forceRun round-trips, absent = off

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

### Task 5: Inspector — Force Run toggle button

**Files:**
- Modify: `src/inspector-ui.ts` (`InspectorDeps` ~line 196; pending-ref + action ~line 294; button factory + assembly in maintenance section ~line 985; `paint()` maintenance region ~line 1748)

Render layer — not unit-tested (tests target the pure layer; render is read-only against state per AGENTS.md). Verified by `tsc` + visual smoke test in Task 8.

- [ ] **Step 1: Add the `onSetForceRun` dep**

In `InspectorDeps` (after `onSetActiveFloors`, ~line 196):

```ts
  /** Set the building's Force Run flag (§4.6). main.ts owns the mutation
   *  (`target.building.forceRun = value || undefined`) and bumps autosave.
   *  Force Run keeps the building producing for XP at a full output bin;
   *  overflow is voided, inputs/power/wear stay real costs. */
  onSetForceRun(target: InspectorTarget, value: boolean): void;
```

- [ ] **Step 2: Add the pending ref + registry action**

After the `set-building-active-floors` action block (~line 302), add:

```ts
  // ── Force Run pending ref ───────────────────────────────────────────────
  // Mirrors the floor-disable pattern: set the desired value, dispatch the
  // payload-less registry action, which reads + nulls the ref and calls the dep.
  let pendingForceRun: boolean | null = null;
  defineAction(reg, 'set-building-force-run', () => {
    const v = pendingForceRun;
    pendingForceRun = null;
    if (v === null || !target) return;
    if ((target.building.constructionRemainingMs ?? 0) > 0) return; // guard: no-op while constructing
    deps.onSetForceRun(target, v);
    paint();
  });
```

- [ ] **Step 3: Create the toggle button and append it to the maintenance section**

After the floor-disable steppers are appended (`maintenanceSection.body.appendChild(floorDisableRow);`, ~line 985), add the button. It reuses the `convertBtn` styling idiom (accent action button):

```ts
  // §4.6 Force Run toggle — keep producing for XP at a full output bin.
  // Shown only for resource-producing buildings (the only ones a cap can
  // throttle); hidden under construction. Reuses the accent action-button look.
  const forceRunBtn = document.createElement('button');
  styled(
    forceRunBtn,
    [
      'background: transparent',
      `color: ${'var(--ri-accent)'}`,
      `border: 1px solid ${'var(--ri-accent-dim)'}`,
      'padding: 4px 8px',
      'cursor: pointer',
      'font-family: ui-monospace, monospace',
      'font-size: 10.5px',
      'letter-spacing: 0.08em',
      'text-transform: uppercase',
      'border-radius: 2px',
      'transition: background 80ms ease, border-color 80ms ease',
      'text-align: left',
      'margin-top: 4px',
    ].join(';'),
  );
  forceRunBtn.addEventListener('mouseenter', () => {
    if (forceRunBtn.disabled) return;
    forceRunBtn.style.background = 'rgba(125, 211, 232, 0.08)';
    forceRunBtn.style.borderColor = 'var(--ri-accent)';
  });
  forceRunBtn.addEventListener('mouseleave', () => {
    forceRunBtn.style.background = forceRunBtn.dataset.on === '1' ? 'rgba(125, 211, 232, 0.12)' : 'transparent';
    forceRunBtn.style.borderColor = 'var(--ri-accent-dim)';
  });
  forceRunBtn.addEventListener('click', () => {
    if (forceRunBtn.disabled || !target) return;
    if ((target.building.constructionRemainingMs ?? 0) > 0) return;
    pendingForceRun = !(target.building.forceRun === true);
    dispatchAction(reg, 'set-building-force-run');
  });
  maintenanceSection.body.appendChild(forceRunBtn);
```

- [ ] **Step 4: Paint the button in `paint()`**

In the `paint()` maintenance region, right after the floor-disable stepper paint block (after the `}` closing the `else` at ~line 1748), add. `recipe` is already in scope (`const recipe = resolveRecipe(...)` ~line 1361):

```ts
    // §4.6 Force Run toggle paint. Only meaningful for buildings that PRODUCE
    // a resource (the only ones a storage cap can throttle); hidden otherwise
    // and while under construction.
    const producesResource = Object.keys(recipe.outputs).length > 0;
    if (!producesResource || isUnderConstruction) {
      forceRunBtn.style.display = 'none';
    } else {
      forceRunBtn.style.display = '';
      const on = building.forceRun === true;
      forceRunBtn.dataset.on = on ? '1' : '0';
      forceRunBtn.textContent = on ? 'FORCE RUN: ON' : 'FORCE RUN: OFF';
      forceRunBtn.style.background = on ? 'rgba(125, 211, 232, 0.12)' : 'transparent';
      forceRunBtn.style.color = on ? 'var(--ri-accent)' : 'var(--ri-fg-2)';
      forceRunBtn.style.borderColor = 'var(--ri-accent-dim)';
    }
```

> `isUnderConstruction` is declared earlier in the same `paint()` scope (the floor-disable block, ~line 1728), so it is in scope here. If a linter flags use-before-read ordering, read `(building.constructionRemainingMs ?? 0) > 0` inline instead.

- [ ] **Step 5: Verify it compiles**

Run: `npx tsc -b`
Expected: FAIL with one error — `onSetForceRun` is required on `InspectorDeps` but not yet provided by `main.ts`. That is fixed in Task 6. (If you prefer a green tsc per task, do Task 6 before re-running.)

- [ ] **Step 6: Commit**

```bash
git add src/inspector-ui.ts
git commit -m "feat(ui): Force Run toggle in the building inspector

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

### Task 6: Wire `onSetForceRun` in main.ts

**Files:**
- Modify: `src/main.ts` (the inspector deps object, near `onSetActiveFloors` ~line 1323)

- [ ] **Step 1: Implement the callback**

In `src/main.ts`, in the `mountInspectorUi({ ... })` deps object, after the `onSetActiveFloors` entry (~line 1323-1327), add:

```ts
    onSetForceRun: (target: InspectorTarget, value: boolean) => {
      const b = target.building;
      // Store `undefined` when off to keep saves clean (absent ≡ off).
      b.forceRun = value ? true : undefined;
      markDirty(); // same autosave-bump path onSetActiveFloors uses
    },
```

> Match the exact autosave-bump call `onSetActiveFloors` uses (search for it in `main.ts` — it may be `markDirty()`, `scheduleSave()`, or setting a dirty flag). Use the identical call so Force Run persists on the same cadence. No world-layer rebuild is needed (Force Run changes no geometry, terrain, or routes — unlike floor-disable's route drain).

- [ ] **Step 2: Verify the whole project compiles**

Run: `npx tsc -b`
Expected: clean — `InspectorDeps.onSetForceRun` is now satisfied.

- [ ] **Step 3: Commit**

```bash
git add src/main.ts
git commit -m "feat(main): wire onSetForceRun inspector callback

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

### Task 7: Update SPEC.md (§4.6 + §4.7)

**Files:**
- Modify: `SPEC.md` (§4.6 cap-throttle paragraph; §4.7 maintenance "deliberately inverts" paragraph)

- [ ] **Step 1: Add the Force Run override to §4.6**

In `SPEC.md` §4.6, immediately after the paragraph beginning "When resource `r` hits its cap, only buildings producing `r` are affected…", add:

```markdown
**Force Run (produce-at-cap for XP).** A building may be individually flagged
**Force Run** (per-building `forceRun` on `PlacedBuilding`, toggled in the
inspector). When on, that building is **exempt from the `r`-at-cap throttle**:
a full output bin no longer drives its gate to zero. It keeps running at its
input / power / heat / adjacency-gated rate, earns XP from that production, and
accrues maintenance wear like any running building. Its overflow output is
**voided at the cap** — caps stay hard, the excess is simply discarded by the
integrator's `[0, cap]` clamp. Force Run is *not* free XP: the building still
consumes its inputs and draws power, and it still stops when an input is
exhausted (input-empty constraints and the power factor are unaffected). Only
buildings with a productive resource output expose the toggle (a storage /
power / logistics building has nothing a cap can throttle). Implemented as a
single carve-out in the net-flow solver (`ignoreOutputCap` excludes the
building from the `cap:r` shared factor); a force-run building is removed from
the producer side of `cap:r` only — its *consumption* of any capped resource
still counts as real consumer demand.
```

- [ ] **Step 2: Add the maintenance caveat to §4.7**

In `SPEC.md` §4.7, in the paragraph that begins "This **deliberately inverts** the old rule…" (which notes a building can escape maintenance by sitting at a capped output with no consumer), append:

```markdown
 A building with **Force Run** on (§4.6) does **not** escape maintenance this
way: by deliberately running at a full bin it keeps a nonzero duty cycle, so it
wears normally. That ongoing wear is part of Force Run's cost.
```

- [ ] **Step 3: Verify spec/code agreement**

Re-read both edited paragraphs against the implemented behavior in `flow-solver.ts` / `economy.ts`. Confirm: (a) exempt from `cap:r` producer side only; (b) overflow voided; (c) inputs/power/zero-constraints unaffected; (d) wears normally.

- [ ] **Step 4: Commit**

```bash
git add SPEC.md
git commit -m "docs(spec): §4.6 Force Run produce-at-cap override + §4.7 wear caveat

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

### Task 8: Full verification — build, test, visual smoke

**Files:** none (verification only)

- [ ] **Step 1: Typecheck + build**

Run: `npm run build`
Expected: `tsc -b` clean + `vite build` succeeds.

- [ ] **Step 2: Full test suite**

Run: `npm test`
Expected: all tests pass (new flow-solver / economy / persistence tests + the full existing suite green).

- [ ] **Step 3: Visual smoke test (manual)**

Reload `https://islands.nitjsefni.eu/` (dev service serves built `dist/` — the build in Step 1 is already live; just reload the tab). Select a resource-producing building, confirm the **FORCE RUN: OFF/ON** toggle appears in the Maintenance section, toggles on click, persists across a reload, and is absent on a storage/power building and while a building is under construction. Use `mcp__daedalus__screenshot` against the active tab to capture.

- [ ] **Step 4: Final integration commit (if any uncommitted polish remains)**

```bash
git add -A
git commit -m "chore(force-run): final polish + verification

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Self-Review

**Spec coverage:** design spec → tasks. Flag field (Task 2). Solver carve-out (Task 1). Economy threading incl. lattice snapshot (Task 3). Persistence (Task 4). Inspector toggle, producer-only + construction-hidden (Task 5). main.ts wiring (Task 6). SPEC.md §4.6/§4.7 (Task 7). Build+test+visual (Task 8). No gaps.

**Placeholder scan:** Test setup helpers in Tasks 3–4 are intentionally adapted to existing `*.test.ts` conventions (the file already has island/world builders); the *contract* (assertions) is concrete. All code-bearing steps show real code. No TBD/TODO.

**Type consistency:** `forceRun?: boolean` (PlacedBuilding) ↔ `ignoreOutputCap?: boolean` (FlowBuildingSpec) ↔ `onSetForceRun(target, value: boolean)` (InspectorDeps) ↔ `set-building-force-run` action ↔ `pendingForceRun: boolean | null`. Consistent across tasks.
