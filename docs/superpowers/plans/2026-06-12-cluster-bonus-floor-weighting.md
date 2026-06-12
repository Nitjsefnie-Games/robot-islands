# Cluster Bonus — Floor-Weighted Capacity — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Rebalance the §4.5 cluster bonus so it counts neighbours' floor-capacity (not raw head-count) at half the rate, rewarding floor-upgraded buildings and taming wide-spam.

**Architecture:** Two independent levers applied in sequence. First the rate cut (0.10 → 0.05) — at the floor-1 baseline the cluster formula already collapses to a rate-only expression, so this alone rebases every existing test with no formula change. Then the formula swap to floor-weighted neighbours-only capacity, which changes nothing at floor-1 (existing tests stay green) and only adds behaviour once floors > 1 exist. This ordering keeps `master` green after every task.

**Tech Stack:** TypeScript (strict), Vitest. Pure module `src/adjacency.ts`; constant in `src/building-defs.ts`; consumers in `src/economy.ts` need no change (the returned `Map<id,number>` is already per-building).

**Design doc:** `docs/superpowers/specs/2026-06-12-cluster-bonus-floor-weighting-design.md`

---

## File structure

| File | Responsibility | Change |
|-|-|-|
| `src/building-defs.ts` | `CATEGORY_ADJACENCY_RATE` constant | Rate 0.10 → 0.05 (Task 1) |
| `src/building-defs.test.ts` | rate constant test | Rebase to 0.05 (Task 1) |
| `src/adjacency.ts` | `clusterBonusMuls` size→multiplier step | Floor-weighted, neighbours-only (Task 2) |
| `src/adjacency.test.ts` | cluster bonus unit tests | Rebase floor-1 values (Task 1); add floor tests (Task 2) |
| `src/economy.test.ts` | §4.5 buff-adjacency integration tests | Rebase floor-1 values (Task 1); add floor-power test (Task 2) |
| `SPEC.md` | §4.5 buff-adjacency paragraph | Rewrite to floor-weighted form (Task 3) |

No persistence change — the bonus is computed live each tick and `floorLevel` is already persisted.

---

## Task 1: Rate cut 0.10 → 0.05 (formula unchanged)

At the floor-1 baseline the current head-count formula `1 + (k − 1)·rate` is purely rate-driven, so cutting the rate rebases every existing assertion without touching the formula. Update the tests first (they fail against the 0.10 code), then change the constant.

**Files:**
- Modify: `src/building-defs.ts:411-423`
- Modify (tests): `src/building-defs.test.ts:2500-2502`, `src/adjacency.test.ts` (clusterBonusMul describe), `src/economy.test.ts` (§4.5 describe + clustered-generators test)

- [ ] **Step 1: Rebase `building-defs.test.ts` rate assertion**

In `src/building-defs.test.ts`, the `CATEGORY_ADJACENCY_RATE` describe (~line 2500):

```ts
  it('defines a rate for every BuildingCategory, seeded at 0.05', () => {
    for (const cat of ALL_CATEGORIES) {
      expect(CATEGORY_ADJACENCY_RATE[cat]).toBe(0.05);
    }
  });
```

(Change the title `0.10` → `0.05` and `toBe(0.1)` → `toBe(0.05)`. Leave the second `it` at ~line 2508 — the `toBeTypeOf('number')` check — untouched.)

- [ ] **Step 2: Rebase `adjacency.test.ts` floor-1 cluster values**

In the `clusterBonusMul — §4.5 per-cluster bonus` describe, change these assertions (every building is floor-1, so each value scales from 0.10 to 0.05):

```ts
  // pair (cluster size 2) → 1 + 1 × 0.05 = 1.05
  expect(clusterBonusMul(a, [a, b])).toBeCloseTo(1.05, 9);
  expect(clusterBonusMul(b, [a, b])).toBeCloseTo(1.05, 9);

  // line of 3 → uniform 1.10
  expect(clusterBonusMul(a, all)).toBeCloseTo(1.1, 9);
  expect(clusterBonusMul(b, all)).toBeCloseTo(1.1, 9);
  expect(clusterBonusMul(c, all)).toBeCloseTo(1.1, 9);

  // cross of 5 → uniform 1.20
  for (const b of all) expect(clusterBonusMul(b, all)).toBeCloseTo(1.2, 9);

  // ring of 8 → all ×1.35
  for (const b of ids) expect(clusterBonusMul(b, ids)).toBeCloseTo(1.35, 9);

  // two disjoint clusters: pair → 1.05, triple → 1.10
  expect(clusterBonusMul(a1, all)).toBeCloseTo(1.05, 9);
  expect(clusterBonusMul(b1, all)).toBeCloseTo(1.1, 9);
  expect(clusterBonusMul(b3, all)).toBeCloseTo(1.1, 9);

  // batch agrees: line of 3 → 1.10
  expect(map.get('a')).toBeCloseTo(1.1, 9);
```

Also update the human-readable `it(...)` titles that name the old numbers (`1.10`/`1.20`/`1.40`/`1.70`) to the new ones (`1.05`/`1.10`/`1.20`/`1.35`). The `1.0` cases (isolated, cross-category, diagonal, duplicate-id) are unchanged.

- [ ] **Step 3: Rebase `economy.test.ts` §4.5 assertions**

In the `§4.5 — buff adjacency in computeRates / advanceIsland` describe:

```ts
  // two adjacent mines → ×1.05. Each 0.05 × 1.05 = 0.0525; aggregate 0.105.
  expect(production.iron_ore).toBeCloseTo(0.105, 9);
  for (const r of byBuilding) {
    expect(r.effectiveRate).toBeCloseTo(0.0525, 9);
  }

  // three mines in a line → uniform 1 + (3−1)×0.05 = ×1.10 → 0.055 each
  expect(midRate).toBeCloseTo(0.055, 9);
  expect(westRate).toBeCloseTo(0.055, 9);
  expect(eastRate).toBeCloseTo(0.055, 9);

  // buff over 100s: 2 × 0.0525 × 100 = 10.5
  expect(state.inventory.iron_ore).toBeCloseTo(10.5, 6);
```

And the clustered-generators test (~line 1214):

```ts
  // two adjacent Water Wheels → ×1.05 → 21 kW each → 42 kW total
  expect(computeRates(clustered).power.produced).toBeCloseTo(42, 5);
  expect(computeRates(solo).power.produced).toBeCloseTo(20, 5);
```

Update the prose comments/titles in these tests that say `+10%` / `×1.10` / `×1.20` to `+5%` / `×1.05` / `×1.10` accordingly.

- [ ] **Step 4: Run the rebased tests — verify they FAIL against current 0.10 code**

Run: `npx vitest run src/building-defs.test.ts src/adjacency.test.ts src/economy.test.ts`
Expected: FAIL — the new assertions (0.05-based) don't match the live 0.10 constant.

- [ ] **Step 5: Cut the rate constant**

In `src/building-defs.ts`, replace the `CATEGORY_ADJACENCY_RATE` body (lines 411-423):

```ts
export const CATEGORY_ADJACENCY_RATE: Readonly<Record<BuildingCategory, number>> = {
  extraction: 0.05,
  smelting: 0.05,
  chemistry: 0.05,
  manufacturing: 0.05,
  electronics: 0.05,
  power: 0.05,
  storage: 0.05,
  logistics: 0.05,
  cooling: 0.05,
  production: 0.05,
  special: 0.05,
};
```

Also update the doc-comment just above it (lines 402-410): change "Seeded uniform at 0.10" → "Seeded uniform at 0.05".

- [ ] **Step 6: Run the tests — verify they PASS**

Run: `npx vitest run src/building-defs.test.ts src/adjacency.test.ts src/economy.test.ts`
Expected: PASS (all three files green).

- [ ] **Step 7: Commit**

```bash
git add src/building-defs.ts src/building-defs.test.ts src/adjacency.test.ts src/economy.test.ts
git commit -m "balance(adjacency): cut cluster-bonus rate 0.10 → 0.05 (§4.5)

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 2: Floor-weighted, neighbours-only formula

Swap the head-count size for floor-weighted component capacity, excluding the building's own capacity from its own bonus. At floor-1 this is identical to Task 1's output (collapse property), so the Task 1 tests stay green; new tests cover floors > 1.

**Files:**
- Modify: `src/adjacency.ts:22` (import), `src/adjacency.ts:7-8` (header comment), `src/adjacency.ts:143-156` (size→multiplier step)
- Test: `src/adjacency.test.ts` (new floor cases), `src/economy.test.ts` (new floor-power case)

- [ ] **Step 1: Write the new failing tests — `adjacency.test.ts`**

Add inside the `clusterBonusMul — §4.5 per-cluster bonus` describe (the `place` helper returns floor-1 buildings; spread to set `floorLevel`):

```ts
  it('floor-weighted: a taller neighbour raises others’ bonus; own bonus excludes own capacity', () => {
    // a = floor-1 (c=1), b = floor-3 (floorLevel 2 → c=3), adjacent. K = 4.
    // mul_a = 1 + 0.05×(4−1) = 1.15 ; mul_b = 1 + 0.05×(4−3) = 1.05
    const a = place('a', 'mine', 0, 0);
    const b = { ...place('b', 'mine', 2, 0), floorLevel: 2 };
    expect(clusterBonusMul(a, [a, b])).toBeCloseTo(1.15, 9);
    expect(clusterBonusMul(b, [a, b])).toBeCloseTo(1.05, 9);
  });

  it('floor-weighted: a lone tall building gets NO self-bonus (×1.0)', () => {
    // floorLevel 4 → c=5, K=5, 1 + 0.05×(5−5) = 1.0
    const a = { ...place('a', 'mine', 0, 0), floorLevel: 4 };
    expect(clusterBonusMul(a, [a])).toBe(1);
  });
```

- [ ] **Step 2: Write the new failing test — `economy.test.ts`**

Add inside the `§4.5 — buff adjacency in computeRates / advanceIsland` describe (uses the existing `makeState` / `blankInventory` helpers; `water_wheel` produces 20 kW, no fuel):

```ts
  it('floor-weighted generator power: own floor multiplies output; taller neighbour raises the cluster term', () => {
    // wwA floor-1 (c=1), wwB floor-2 (floorLevel 1 → c=2). K = 3.
    // wwA = 20 × floorEffectMul(0)=1 × (1 + 0.05×(3−1)=1.10) = 22 kW
    // wwB = 20 × floorEffectMul(1)=2 × (1 + 0.05×(3−2)=1.05) = 42 kW → total 64 kW
    const wwA: PlacedBuilding = { id: 'b-ww-a', defId: 'water_wheel', x: 0, y: 0 };
    const wwB: PlacedBuilding = { id: 'b-ww-b', defId: 'water_wheel', x: 1, y: 0, floorLevel: 1 };
    const state = makeState({ buildings: [wwA, wwB], inventory: blankInventory() });
    expect(computeRates(state).power.produced).toBeCloseTo(64, 5);
  });
```

- [ ] **Step 3: Run the new tests — verify they FAIL**

Run: `npx vitest run src/adjacency.test.ts src/economy.test.ts -t "floor-weighted"`
Expected: FAIL — current head-count formula ignores `floorLevel`, so it returns 1.05/1.05 (not 1.15/1.05), 1.0 holds by luck for the lone case but the mixed and power cases fail.

- [ ] **Step 4: Add the `floorLevel` import to `adjacency.ts`**

Change line 22:

```ts
import { floorLevel, type PlacedBuilding } from './buildings.js';
```

- [ ] **Step 5: Swap the size→multiplier step in `clusterBonusMuls`**

In `src/adjacency.ts`, replace the `compSize` block and the output loop (current lines 143-156):

```ts
  // §4.5 floor-weighted component capacity: a component's "size" is the sum of
  // its members' floor-capacity c = 1 + floorLevel (== floorEffectMul), NOT a
  // raw head-count — so a floor-upgraded building contributes its capacity to
  // its neighbours' bonus.
  const compCap = new Map<number, number>();
  for (let i = 0; i < n; i++) {
    const r = find(i);
    compCap.set(r, (compCap.get(r) ?? 0) + (1 + floorLevel(buildings[i]!)));
  }

  const out = new Map<string, number>();
  for (let i = 0; i < n; i++) {
    const b = buildings[i]!;
    const rate = CATEGORY_ADJACENCY_RATE[defs[b.defId].category] ?? 0;
    if (rate === 0) { out.set(b.id, 1); continue; }
    // Neighbours-only: exclude this building's own capacity from its own bonus,
    // so a lone building (any floor) gets ×1.0 and a building's own height
    // drives only its floor multiplier, not its cluster term.
    const K = compCap.get(find(i)) ?? 1;
    out.set(b.id, 1 + rate * (K - (1 + floorLevel(b))));
  }
  return out;
```

- [ ] **Step 6: Update the file-header formula comment**

In `src/adjacency.ts`, replace lines 7-8:

```ts
// SPEC §4.5 (buff form): "every building gains a multiplier from the
// floor-capacity of the REST of its same-category 4-connected cluster:
// `1 + rate × (K − c_i)`, c = 1 + floorLevel, K = Σ c over the cluster."
```

- [ ] **Step 7: Run the new + existing cluster tests — verify PASS**

Run: `npx vitest run src/adjacency.test.ts src/economy.test.ts`
Expected: PASS — new floor tests pass (1.15/1.05, 1.0, 64 kW) AND the Task 1 floor-1 tests still pass (collapse property).

- [ ] **Step 8: Commit**

```bash
git add src/adjacency.ts src/adjacency.test.ts src/economy.test.ts
git commit -m "balance(adjacency): floor-weighted neighbours-only cluster bonus (§4.5)

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 3: SPEC §4.5 rewrite

**Files:**
- Modify: `SPEC.md` (the buff-adjacency paragraph, ~line 494)

- [ ] **Step 1: Replace the buff-adjacency paragraph**

Find the paragraph beginning `**Buff adjacency (universal per-category cluster):**` and replace it in full with:

```markdown
**Buff adjacency (per-category cluster, floor-weighted):** every building gains a flat, linear, uncapped multiplier from the **floor-capacity of the rest of its same-category 4-connected cluster**: `mul_i = 1 + CATEGORY_ADJACENCY_RATE[category] × (K − c_i)`, where `c_i = 1 + floorLevel_i` is the building's own capacity (the same `1 + L` factor as the floor-upgrade throughput multiplier) and `K = Σ_j c_j` over the focal building's maximal same-category cluster — buildings joined through same-category 4-neighbour links (§4.4), a multi-tile building counting once. The `(K − c_i)` term is **neighbours-only**: a building's own height drives its own floor multiplier, not its cluster bonus, so a lone building (any floor) gets ×1.0. Because the bonus is floor-weighted, a floor-upgraded building both contributes more to its neighbours' bonus and is itself rewarded for clustering. When every member is floor-1 (`c_j = 1`), `K − c_i = k − 1` and the formula collapses to the legacy head-count form `1 + (k − 1) × rate`. Connectivity only: enclosed empty tiles do not break a cluster, and a different-category building between two same-category buildings does not bridge them. The multiplier applies to the building's recipe rate and, for generators, to power output (NOT power consumption). The per-category rate lives in `CATEGORY_ADJACENCY_RATE` (`building-defs.ts`), seeded uniform at 0.05. Cross-island lattice neighbours (§13.3) do not feed this term. Skill-tree `exoticAdjacency` pair-boosts (§9.1) stack multiplicatively on top. Resolution: `clusterBonusMul` / `clusterBonusMuls` / `computeBuffStack` in `adjacency.ts`.
```

- [ ] **Step 2: Check for stray references to the old form**

Run: `grep -nE "uniform across every member|\(k − 1\)|0\.10" SPEC.md`
Expected: no remaining cluster-bonus references to "uniform across every member", the bare `(k − 1)` form outside the collapse note, or the `0.10` rate. (The collapse note in the rewritten paragraph legitimately contains `(k − 1)` and is fine. Other §s mentioning generator cluster scaling without a formula, e.g. §4.6/§4 power definition, need no change.)

- [ ] **Step 3: Commit**

```bash
git add SPEC.md
git commit -m "docs(spec): §4.5 cluster bonus is floor-weighted, neighbours-only, rate 0.05

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 4: Full verification

**Files:** none (verification only)

- [ ] **Step 1: Typecheck + build**

Run: `npm run build`
Expected: clean (no `error TS…`), `✓ built`.

- [ ] **Step 2: Full test suite**

Run: `npx vitest run`
Expected: all files pass (the pre-change baseline was 3133 passed; this adds 3 new tests → expect ~3136 passed, plus the skipped/todo counts unchanged).

- [ ] **Step 3: Confirm no economy.ts code change was needed**

Run: `git diff --name-only origin/master`
Expected: `src/adjacency.ts`, `src/building-defs.ts`, `SPEC.md`, and the three test files only. `src/economy.ts` must NOT appear — it already reads per-building values from the `clusterMuls` map via `clusterMuls.get(b.id)` (recipe rate through `computeBuffStack`, power through the generator path), so the floor-weighted values flow through unchanged.

---

## Self-review notes

- **Spec coverage:** rate cut (Task 1) ✓; floor-weighted neighbours-only formula (Task 2) ✓; SPEC §4.5 rewrite (Task 3) ✓; no-migration claim verified by Task 4 Step 3 ✓; generator-power path covered by the new economy test ✓.
- **Type consistency:** `floorLevel(b)` is the existing clamped `[0,9]` helper from `buildings.ts` (undefined-safe); `clusterBonusMuls` keeps its `Map<string, number>` return type and `clusterBonusMul` keeps its signature; `PlacedBuilding.floorLevel?: number` is an existing optional field, so the test literals `{ ..., floorLevel: 1 }` typecheck.
- **Ordering:** rate-first / formula-second is deliberate — the floor-1 collapse means Task 1 fully rebases existing tests with no formula churn, and Task 2's formula swap leaves those rebased tests green.
