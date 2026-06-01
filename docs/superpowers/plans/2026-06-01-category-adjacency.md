# Universal Per-Category Adjacency Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the buggy per-def `adjacencyBuffs` clustering buff with a universal per-category adjacency rule — incremental, linear, uncapped, applied to recipe rate and generator output (not consumption) — and surface it in the building inspector.

**Architecture:** A single `categoryAdjacencyMul(building, buildings, defs)` in `adjacency.ts` counts a building's distinct same-category physical 4-neighbours and returns `1 + n × CATEGORY_ADJACENCY_RATE[category]`. `computeBuffStack` becomes `categoryAdjacencyMul × Π(skill-tree exotic-pair bonuses)`, keeping its existing signature so the economy call site is unchanged. The economy applies the same multiplier to generator `powerProduced`. The inspector displays it. Gates and skill-tree exotic pairs are untouched.

**Tech Stack:** Vite 5 + TypeScript strict + PixiJS 8 + vitest. Pure simulation layer is renderer-free and unit-tested.

**Spec:** `docs/superpowers/specs/2026-06-01-category-adjacency-design.md`

---

## File Structure

- **Modify** `src/building-defs.ts` — add `CATEGORY_ADJACENCY_RATE`; remove `AdjacencyBuff` interface, the `adjacencyBuffs` def field, and the three buff entries (mine/workshop/smelter).
- **Modify** `src/adjacency.ts` — add `categoryAdjacencyMul`; rewrite `computeBuffStack`; remove `neighborMatches` and the `AdjacencyBuff` import.
- **Modify** `src/economy.ts` — import `categoryAdjacencyMul`; multiply `powerProduced` by it in the pass-3 power loop.
- **Modify** `src/inspector-ui.ts` — import `categoryAdjacencyMul`; fold it into the `BONUSES` annotation (recipe buildings) and annotate the `Power` section (generators).
- **Modify** `src/tutorial.ts` — fix the `12_adjacency` hint wording.
- **Modify** `SPEC.md` — rewrite §4.5 buff form; note generation scaling in §4.5/§5.1.
- **Rewrite** `src/adjacency.test.ts` — new category-based buff cases.
- **Modify** `src/economy.test.ts` — refresh the two-mines comment; add a generator-clustering test.

No new files. No persistence migration (`adjacencyBuffs` is static def data; `buffStack` is per-tick and never serialized).

---

### Task 1: Category-adjacency rate table

**Files:**
- Modify: `src/building-defs.ts` (add export near the `AdjacencyBuff` region, ~line 400)
- Test: `src/building-defs.test.ts`

- [ ] **Step 1: Write the failing test**

Add to `src/building-defs.test.ts` (import `CATEGORY_ADJACENCY_RATE` and the `BuildingCategory` list it must cover):

```ts
import { CATEGORY_ADJACENCY_RATE, BUILDING_DEFS } from './building-defs.js';

describe('CATEGORY_ADJACENCY_RATE', () => {
  const ALL_CATEGORIES = [
    'extraction', 'smelting', 'chemistry', 'manufacturing', 'electronics',
    'power', 'storage', 'logistics', 'cooling', 'production', 'special',
  ] as const;

  it('defines a rate for every BuildingCategory, seeded at 0.10', () => {
    for (const cat of ALL_CATEGORIES) {
      expect(CATEGORY_ADJACENCY_RATE[cat]).toBe(0.1);
    }
  });

  it('covers every category actually used by a building def', () => {
    for (const def of Object.values(BUILDING_DEFS)) {
      expect(CATEGORY_ADJACENCY_RATE[def.category]).toBeTypeOf('number');
    }
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/building-defs.test.ts -t "CATEGORY_ADJACENCY_RATE"`
Expected: FAIL — `CATEGORY_ADJACENCY_RATE` is not exported.

- [ ] **Step 3: Add the table**

In `src/building-defs.ts`, immediately after the `AdjacencyBuff` interface block (around line 427, before `export type GateMatchType`), add:

```ts
/**
 * §4.5 universal category-adjacency rate. Each building gains
 * `1 + n × CATEGORY_ADJACENCY_RATE[category]` to its recipe rate (and, for
 * generators, its power output), where `n` is the count of distinct
 * same-category physical 4-neighbours. Linear, uncapped. Seeded uniform at
 * 0.10 — tune per category here. Categories whose buildings neither run a
 * recipe nor generate power (storage / logistics / cooling) are no-ops.
 */
export const CATEGORY_ADJACENCY_RATE: Record<BuildingCategory, number> = {
  extraction: 0.1,
  smelting: 0.1,
  chemistry: 0.1,
  manufacturing: 0.1,
  electronics: 0.1,
  power: 0.1,
  storage: 0.1,
  logistics: 0.1,
  cooling: 0.1,
  production: 0.1,
  special: 0.1,
};
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/building-defs.test.ts -t "CATEGORY_ADJACENCY_RATE"`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/building-defs.ts src/building-defs.test.ts
git commit -m "feat(adjacency): add CATEGORY_ADJACENCY_RATE table

Co-Authored-By: <Your Model Name> <noreply@anthropic.com>"
```

---

### Task 2: `categoryAdjacencyMul` helper

**Files:**
- Modify: `src/adjacency.ts` (add `categoryAdjacencyMul` above `computeBuffStack`, ~line 98)
- Test: `src/adjacency.test.ts` (add a focused describe block; the full rewrite of the old suite happens in Task 3)

- [ ] **Step 1: Write the failing test**

Add to `src/adjacency.test.ts` (top of file already imports from `./building-defs.js`; add `categoryAdjacencyMul` to the `./adjacency.js` import). `mine` is `extraction`, `smelter` is `smelting`, `workshop` is `manufacturing`, all `square2` (2×2) footprints. A placed building is `{ id, defId, x, y, rotation? }`.

```ts
import { categoryAdjacencyMul } from './adjacency.js';

describe('categoryAdjacencyMul — §4.5 universal category adjacency', () => {
  const place = (id: string, defId: string, x: number, y: number) =>
    ({ id, defId: defId as never, x, y }) as never;

  it('isolated building → 1.0', () => {
    const a = place('a', 'mine', 0, 0);
    expect(categoryAdjacencyMul(a, [a])).toBe(1);
  });

  it('1 same-category neighbour → 1 + 1 × 0.10 = 1.10', () => {
    // Two 2×2 mines side by side: mine 'a' at (0,0) spans 0..1, mine 'b'
    // at (2,0) spans 2..3 — b's left column (x=2) borders a's right (x=1).
    const a = place('a', 'mine', 0, 0);
    const b = place('b', 'mine', 2, 0);
    expect(categoryAdjacencyMul(a, [a, b])).toBeCloseTo(1.1, 9);
    expect(categoryAdjacencyMul(b, [a, b])).toBeCloseTo(1.1, 9);
  });

  it('uncapped: 4 same-category neighbours → 1 + 4 × 0.10 = 1.40', () => {
    // Centre 2×2 mine at (0,0); four 2×2 mines flanking N/S/E/W.
    const mid = place('mid', 'mine', 0, 0);
    const n = place('n', 'mine', 0, -2);
    const s = place('s', 'mine', 0, 2);
    const e = place('e', 'mine', 2, 0);
    const w = place('w', 'mine', -2, 0);
    expect(categoryAdjacencyMul(mid, [mid, n, s, e, w])).toBeCloseTo(1.4, 9);
  });

  it('different category does not count (mine vs workshop)', () => {
    const mine = place('mine', 'mine', 0, 0);
    const shop = place('shop', 'workshop', 2, 0);
    expect(categoryAdjacencyMul(mine, [mine, shop])).toBe(1);
  });

  it('diagonal neighbour does NOT count (4-neighbour rule)', () => {
    const a = place('a', 'mine', 0, 0);
    const d = place('d', 'mine', 2, 2); // diagonal — no shared cardinal border
    expect(categoryAdjacencyMul(a, [a, d])).toBe(1);
  });

  it('self is never counted', () => {
    const a = place('a', 'mine', 0, 0);
    expect(categoryAdjacencyMul(a, [a, a])).toBe(1);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/adjacency.test.ts -t "categoryAdjacencyMul"`
Expected: FAIL — `categoryAdjacencyMul` is not exported.

- [ ] **Step 3: Implement the helper**

In `src/adjacency.ts`, add `CATEGORY_ADJACENCY_RATE` to the `./building-defs.js` import, then insert above `computeBuffStack` (before the big block comment at ~line 98):

```ts
/**
 * §4.5 universal category-adjacency multiplier. Counts the focal building's
 * distinct same-category physical 4-neighbours (de-duped by id; a multi-tile
 * neighbour touching several border tiles counts once) and returns
 * `1 + count × CATEGORY_ADJACENCY_RATE[category]`. Linear and uncapped.
 * Physical neighbours only — the §13.3 cross-island lattice does NOT feed
 * this term. Returns 1.0 when the focal category's rate is 0 or no
 * same-category neighbour touches the border.
 */
export function categoryAdjacencyMul(
  b: PlacedBuilding,
  buildings: ReadonlyArray<PlacedBuilding>,
  defs: Readonly<Record<BuildingDefId, BuildingDef>> = BUILDING_DEFS,
): number {
  const focalCat = defs[b.defId].category;
  const rate = CATEGORY_ADJACENCY_RATE[focalCat] ?? 0;
  if (rate === 0) return 1;
  const fp = footprintKeySet(b, defs);
  const border = borderTiles(fp);
  let count = 0;
  const seen = new Set<string>();
  for (const other of buildings) {
    if (other.id === b.id) continue;
    if (seen.has(other.id)) continue;
    if (!touchesBorder(other, border, defs)) continue;
    seen.add(other.id);
    if (defs[other.defId].category === focalCat) count++;
  }
  return 1 + count * rate;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/adjacency.test.ts -t "categoryAdjacencyMul"`
Expected: PASS (all 6 cases).

- [ ] **Step 5: Commit**

```bash
git add src/adjacency.ts src/adjacency.test.ts
git commit -m "feat(adjacency): add categoryAdjacencyMul helper

Co-Authored-By: <Your Model Name> <noreply@anthropic.com>"
```

---

### Task 3: Rewrite `computeBuffStack` (category × exotic), drop `neighborMatches`

**Files:**
- Modify: `src/adjacency.ts` (rewrite `computeBuffStack` lines ~98-178; delete `neighborMatches` lines ~80-96; remove `AdjacencyBuff` import line ~17)
- Test: `src/adjacency.test.ts` (replace the old `computeBuffStack — §4.4 / §4.5` describe block and the `withBuffs` helper)

- [ ] **Step 1: Replace the old buff tests**

In `src/adjacency.test.ts`: delete the `withBuffs` helper (~lines 16-26) and the entire `describe('computeBuffStack — §4.4 / §4.5', …)` block (the same_def / def_id / cap / multiplicative-stacking cases). Remove the now-unused `type AdjacencyBuff` import. Replace with a block that asserts category behaviour plus exotic stacking:

```ts
describe('computeBuffStack — category × exotic', () => {
  const place = (id: string, defId: string, x: number, y: number) =>
    ({ id, defId: defId as never, x, y }) as never;

  it('equals categoryAdjacencyMul when no exotic rules apply', () => {
    const a = place('a', 'mine', 0, 0);
    const b = place('b', 'mine', 2, 0);
    expect(computeBuffStack(a, [a, b])).toBeCloseTo(1.1, 9);
  });

  it('exotic pair bonus stacks multiplicatively on top of the category term', () => {
    // Two adjacent mines → category ×1.10. An exotic rule pairing
    // mine→smelter with +0.25 fires only when a smelter neighbour exists.
    const a = place('a', 'mine', 0, 0);
    const b = place('b', 'mine', 2, 0);
    const sm = place('sm', 'smelter', 0, 2); // borders a's bottom edge
    const rules = [{ pair: ['mine', 'smelter'] as const, recipeRateBonus: 0.25 }];
    expect(computeBuffStack(a, [a, b, sm], BUILDING_DEFS, undefined, rules))
      .toBeCloseTo(1.1 * 1.25, 9);
  });

  it('exotic rule with no matching neighbour leaves the stack at the category term', () => {
    const a = place('a', 'mine', 0, 0);
    const b = place('b', 'mine', 2, 0);
    const rules = [{ pair: ['mine', 'smelter'] as const, recipeRateBonus: 0.25 }];
    expect(computeBuffStack(a, [a, b], BUILDING_DEFS, undefined, rules))
      .toBeCloseTo(1.1, 9);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/adjacency.test.ts`
Expected: FAIL — old `computeBuffStack` still references `def.adjacencyBuffs` / `neighborMatches`; the exotic-only test may pass but compilation/old expectations break. (A TypeScript error on the removed `AdjacencyBuff` import is also expected.)

- [ ] **Step 3: Rewrite `computeBuffStack` and delete `neighborMatches`**

In `src/adjacency.ts`:

1. Remove `  type AdjacencyBuff,` from the `./building-defs.js` import (line ~17).
2. Delete the `neighborMatches` function entirely (the `function neighborMatches(...) { switch (entry.matchKind) … }` block, ~lines 80-96, plus its doc comment).
3. Replace the whole `computeBuffStack` body (the block comment + function, ~lines 98-178) with:

```ts
/**
 * §4.5 buff-adjacency multiplier for the focal building.
 *
 * Returns `categoryAdjacencyMul × Π(exotic-pair bonuses)`. The category term
 * (universal, per-category, linear, uncapped — see `categoryAdjacencyMul`)
 * uses physical same-island neighbours only. The exotic-pair term carries the
 * skill-tree `pairBoost` rewards (`skillUnlockedAdjacencyRules`) and keeps its
 * original neighbour semantics: physical neighbours plus any `crossIsland`
 * lattice buildings. Returns 1.0 when nothing applies.
 *
 * Signature is unchanged from the previous per-def implementation so the
 * economy call site (`computeRates`) needs no edit.
 */
export function computeBuffStack(
  b: PlacedBuilding,
  buildings: ReadonlyArray<PlacedBuilding>,
  defs: Readonly<Record<BuildingDefId, BuildingDef>> = BUILDING_DEFS,
  crossIsland?: ReadonlyArray<PlacedBuilding>,
  exoticRules?: ReadonlyArray<{ readonly pair: readonly [BuildingDefId, BuildingDefId]; readonly recipeRateBonus: number }>,
): number {
  let stack = categoryAdjacencyMul(b, buildings, defs);
  if (exoticRules && exoticRules.length > 0) {
    const neighbors = collectNeighbors(b, buildings, defs, crossIsland);
    for (const rule of exoticRules) {
      if (b.defId === rule.pair[0] && neighbors.some((n) => n.defId === rule.pair[1])) {
        stack *= 1 + rule.recipeRateBonus;
      }
    }
  }
  return stack;
}
```

(`collectNeighbors` is a function declaration later in the same file and is hoisted, so the forward reference is valid.)

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/adjacency.test.ts`
Expected: PASS — both the `categoryAdjacencyMul` block (Task 2) and the new `computeBuffStack — category × exotic` block green.

- [ ] **Step 5: Commit**

```bash
git add src/adjacency.ts src/adjacency.test.ts
git commit -m "refactor(adjacency): computeBuffStack = category x exotic, drop neighborMatches

Co-Authored-By: <Your Model Name> <noreply@anthropic.com>"
```

---

### Task 4: Strip the dead `AdjacencyBuff` type, field, and three buff entries

**Files:**
- Modify: `src/building-defs.ts` (remove `AdjacencyBuff` interface ~419-427; remove `adjacencyBuffs` field ~548-552; remove the three `adjacencyBuffs: [...]` blocks on mine/workshop/smelter)

- [ ] **Step 1: Remove the three buff entries**

In `src/building-defs.ts`, delete these three blocks (and their preceding `// §4.5 placeholder …` comments):

- mine (~634-638):
```ts
    // §4.5 placeholder — tune in Appendix A. Mild clustering bonus rewards
    // packing mines onto adjacent ore/coal veins.
    adjacencyBuffs: [
      { matchKind: 'same_def', percentPerMatch: 10, maxMatches: 2 },
    ],
```
- workshop (~672-676):
```ts
    // §4.5 placeholder — tune in Appendix A. Manufacturing co-location bonus:
    // small per-match rate boost up to three adjacent Workshops.
    adjacencyBuffs: [
      { matchKind: 'same_def', percentPerMatch: 5, maxMatches: 3 },
    ],
```
- smelter (~801-805):
```ts
    // §4.5 placeholder — tune in Appendix A. Paired smelters share heat
    // efficiencies; gentle clustering bonus rewards a two-smelter line.
    adjacencyBuffs: [
      { matchKind: 'same_def', percentPerMatch: 10, maxMatches: 2 },
    ],
```

Ensure the line before each removed block (e.g. `glyph: '⛏',`) still ends with its trailing comma and the object closes cleanly with `},`.

- [ ] **Step 2: Remove the `adjacencyBuffs` def field**

Delete (~548-552):
```ts
  /** §4.5 buff-adjacency entries. Each entry contributes additively up to
   *  its `maxMatches` cap; entries compose multiplicatively. Undefined or
   *  empty = no adjacency buff (default). Resolution: `computeBuffStack`
   *  in `adjacency.ts`, called from `computeRates`. */
  readonly adjacencyBuffs?: ReadonlyArray<AdjacencyBuff>;
```

- [ ] **Step 3: Remove the `AdjacencyBuff` interface**

Delete the interface and its doc comment (~401-427), i.e. the `/** §4.5 buff-adjacency entry … */` block through the closing `}` of `export interface AdjacencyBuff`. Leave `GateMatchType` and everything below intact.

- [ ] **Step 4: Verify nothing else references the removed symbols**

Run: `grep -rn "AdjacencyBuff\|adjacencyBuffs\|matchKind\|percentPerMatch\|maxMatches" src --include=*.ts`
Expected: only `GateRequirement`-related `minCount`/`degradeMul` are unrelated; there must be **no** remaining `AdjacencyBuff`, `adjacencyBuffs`, `matchKind`, or `percentPerMatch` hits in non-test files. If any test still references them, it belongs to the Task 3 rewrite — fix there.

- [ ] **Step 5: Build clean**

Run: `npm run build`
Expected: `tsc -b` passes with no `noUnusedLocals` / missing-symbol errors.

- [ ] **Step 6: Commit**

```bash
git add src/building-defs.ts
git commit -m "refactor(building-defs): remove dead AdjacencyBuff type, field, and buff entries

Co-Authored-By: <Your Model Name> <noreply@anthropic.com>"
```

---

### Task 5: Apply category adjacency to generator output

**Files:**
- Modify: `src/economy.ts` (import ~line 14; power loop ~line 1195)
- Test: `src/economy.test.ts`

- [ ] **Step 1: Write the failing test**

Add to `src/economy.test.ts`. Use `solar` (category `power`, `power.produces` set) or `coal_gen`; check the helper that exposes produced wattage. If the suite already has a power-balance helper, reuse it; otherwise assert via `computeRates(...).` power fields. Concretely, place two adjacent generators and assert each island's produced power exceeds a single generator's by the ×1.10-per-neighbour factor:

```ts
it('clustered generators boost each other’s output by +10% per same-category neighbour', () => {
  // Two 2×2 generators side by side → each sees 1 power-category neighbour →
  // ×1.10 production. (Pick a generator def with power.produces > 0 and no
  // recipe — e.g. 'coal_gen'. Confirm its produces value B from BUILDING_DEFS.)
  const state = makeStateWithBuildings([
    { id: 'g1', defId: 'coal_gen', x: 0, y: 0 },
    { id: 'g2', defId: 'coal_gen', x: 2, y: 0 },
  ]); // helper that builds an IslandState with these placed buildings + fuel
  const solo = makeStateWithBuildings([{ id: 'g1', defId: 'coal_gen', x: 0, y: 0 }]);
  const clusteredP = islandProducedPower(state);   // = computeRates(...).<produced>
  const soloP = islandProducedPower(solo);
  expect(clusteredP).toBeCloseTo(soloP * 2 * 1.1, 5);
});
```

Adapt `makeStateWithBuildings` / `islandProducedPower` to the existing economy-test fixtures (the suite already constructs `IslandState`s and calls `computeRates`/`advanceIsland`; mirror that). If a generator needs fuel to produce, seed the inventory so both `solo` and `clustered` are fuelled identically.

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/economy.test.ts -t "clustered generators"`
Expected: FAIL — produced power is `soloP * 2` (no adjacency factor yet).

- [ ] **Step 3: Apply the multiplier**

In `src/economy.ts`:

1. Add `categoryAdjacencyMul` to the `./adjacency.js` import (line 14):
```ts
import { borderTiles, categoryAdjacencyMul, checkGates, computeBuffStack, footprintKeySet, touchesBorder } from './adjacency.js';
```
2. In the pass-3 power loop, replace the `powerProduced +=` line (~1195):
```ts
    powerProduced += producesBase * floorEffectMul(floorLevel(b)) * solarFactor * windFactor * skillMul.powerProduction;
```
with:
```ts
    // §4.5: generator output scales by the building's category-adjacency
    // multiplier (clustered generators boost each other). Consumption below
    // is deliberately NOT scaled.
    const adjMul = categoryAdjacencyMul(b, validBuildings, defs);
    powerProduced += producesBase * floorEffectMul(floorLevel(b)) * solarFactor * windFactor * skillMul.powerProduction * adjMul;
```

(Leave the `powerConsumed +=` line unchanged — consumption stays adjacency-free.)

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/economy.test.ts -t "clustered generators"`
Expected: PASS.

- [ ] **Step 5: Refresh the existing two-mines test comment**

The test at `src/economy.test.ts:742` (`two adjacent mines each gain the same_def +10% buff`) still passes numerically (mine is `extraction`, rate 0.10, 1 neighbour → ×1.10). Update its title/comment to reflect the new mechanic:

```ts
  it('two adjacent mines each gain the +10% category-adjacency buff (1 extraction neighbour)', () => {
    // Mine is category 'extraction', rate 0.10. Two adjacent mines: each has
    // one same-category neighbour → recipe rate ×1.10.
```

- [ ] **Step 6: Run the full economy suite**

Run: `npx vitest run src/economy.test.ts`
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add src/economy.ts src/economy.test.ts
git commit -m "feat(economy): scale generator output by category adjacency

Co-Authored-By: <Your Model Name> <noreply@anthropic.com>"
```

---

### Task 6: Inspector display of the adjacency multiplier

**Files:**
- Modify: `src/inspector-ui.ts` (import; compute `adjMul` once in the per-building refresh; fold into BONUSES; annotate Power)

- [ ] **Step 1: Import and compute the multiplier**

In `src/inspector-ui.ts`:

1. Add `categoryAdjacencyMul` to the `./adjacency.js` import (currently `import { gateSatisfied } from './adjacency.js';`, line 34):
```ts
import { categoryAdjacencyMul, gateSatisfied } from './adjacency.js';
```
2. In the per-building refresh branch, right after `const skillMul: SkillMultipliers = effectiveSkillMultipliers(state);` (~line 1272), compute the multiplier once so both the recipe and power blocks can use it (`isOperationalBuilding` is already imported — it is used at ~line 1369):
```ts
    const adjMul = categoryAdjacencyMul(
      building,
      state.buildings.filter(isOperationalBuilding),
      BUILDING_DEFS,
    );
```

- [ ] **Step 2: Fold into the BONUSES line**

In the bonuses block (~1330-1340), include `adjMul` in the composite and add a labelled part:

```ts
      const compositeMul = catMul * mineLogBonus * fledgMul * adjMul;
      if (compositeMul > 1.0001) {
        const parts: string[] = [];
        if (fledgMul > 1.0001) parts.push(`fledgling ×${fledgMul.toFixed(2)}`);
        if (catMul > 1.0001) parts.push(`${recipe.category} ×${catMul.toFixed(2)}`);
        if (mineLogBonus > 1.0001) parts.push(`yield ×${mineLogBonus.toFixed(2)}`);
        if (adjMul > 1.0001) parts.push(`adjacency ×${adjMul.toFixed(2)}`);
        bonusesValue.textContent = parts.join(' · ') + ` = ×${compositeMul.toFixed(2)}`;
        bonusesRow.style.display = '';
      } else {
        bonusesRow.style.display = 'none';
      }
```

- [ ] **Step 3: Annotate the Power section for generators**

In the power block (~1350-1360), surface the adjacency-boosted production. Replace the `if (prod > 0) parts.push(...)` line:

```ts
      const parts: string[] = [];
      if (prod > 0) {
        const prodAdj = prod * adjMul;
        parts.push(adjMul > 1.0001
          ? `+${fmtPower(prodAdj)} produced (adjacency ×${adjMul.toFixed(2)})`
          : `+${fmtPower(prodAdj)} produced`);
      }
      if (cons > 0) parts.push(`-${fmtPower(cons)} consumed`);
```

(Consumption text is unchanged — no adjacency factor.)

- [ ] **Step 4: Build clean**

Run: `npm run build`
Expected: `tsc -b` passes (no unused `adjMul`, no missing import).

- [ ] **Step 5: Verify in the running app**

Run: `npm run build` (already done), then reload the browser tab at `https://islands.nitjsefni.eu/` and open the inspector on a building with a same-category neighbour. Use `mcp__daedalus__screenshot` against the active tab.
Expected: the BONUSES line shows `adjacency ×1.10` (or higher) for a clustered recipe building; a clustered generator's Power line shows `… produced (adjacency ×1.10)`.

- [ ] **Step 6: Commit**

```bash
git add src/inspector-ui.ts
git commit -m "feat(inspector): show category-adjacency multiplier in building UI

Co-Authored-By: <Your Model Name> <noreply@anthropic.com>"
```

---

### Task 7: Tutorial hint + SPEC alignment

**Files:**
- Modify: `src/tutorial.ts` (hint ~line 257)
- Modify: `SPEC.md` (§4.5 ~line 476; §4.5/§5.1 generation note)
- Test: `src/tutorial.test.ts` (no code change expected — verify it still passes)

- [ ] **Step 1: Fix the tutorial hint**

In `src/tutorial.ts`, replace line 257:
```ts
    hint: 'Cluster same-type buildings for a +10% output bonus.',
```
with:
```ts
    hint: 'Cluster same-category buildings: each adjacent same-category building adds a flat +10% to recipe rate (and generator output), uncapped.',
```

- [ ] **Step 2: Verify the tutorial trigger still fires**

Run: `npx vitest run src/tutorial.test.ts`
Expected: PASS — the `12_adjacency` trigger (`hasAdjacentSameType`, exercised by placing a second mine at `tutorial.test.ts:186`) is unaffected; two mines are still adjacent and same category.

- [ ] **Step 3: Rewrite SPEC §4.5 buff form**

In `SPEC.md`, replace line 476:
```markdown
**Buff adjacency (capped stacking):** building gains a multiplier per matching neighbor, capped at N. Format: `+X% statKey per adjacent matchType, max N matches`.
```
with:
```markdown
**Buff adjacency (universal per-category):** every building gains a flat, linear, uncapped multiplier from its distinct same-category 4-neighbours: `rate = 1 + n × CATEGORY_ADJACENCY_RATE[category]`, where `n` counts distinct same-category buildings touching the footprint border (§4.4) and a multi-tile neighbour counts once. The multiplier applies to the building's recipe rate and, for generators, to power output (NOT power consumption). The per-category rate lives in `CATEGORY_ADJACENCY_RATE` (`building-defs.ts`), seeded uniform at 0.10. Cross-island lattice neighbours (§13.3) do not feed this term. Skill-tree `exoticAdjacency` pair-boosts (§9.1) stack multiplicatively on top. Resolution: `categoryAdjacencyMul` / `computeBuffStack` in `adjacency.ts`.
```

- [ ] **Step 4: Note generation scaling near §5.1**

In `SPEC.md`, append to the `active` definition paragraph at §5.1 (~line 561), after the existing sentence about `P_produced`/`P_consumed`:
```markdown
 A generator's `P_produced` is additionally scaled by its §4.5 category-adjacency multiplier (clustered generators boost each other); `P_consumed` is not.
```

- [ ] **Step 5: Full suite + build**

Run: `npm test`
Then: `npm run build`
Expected: all tests pass; build clean.

- [ ] **Step 6: Commit**

```bash
git add src/tutorial.ts SPEC.md
git commit -m "docs(spec): align tutorial hint and SPEC §4.5/§5.1 with category adjacency

Co-Authored-By: <Your Model Name> <noreply@anthropic.com>"
```

---

## Self-Review Notes

- **Spec coverage:** rate table (T1), category rule + physical-only + uncapped + de-dup (T2), exotic-kept + signature-stable (T3), removals + no-migration (T4), generator output + consumption-unchanged (T5), inspector display (T6), tutorial + SPEC (T7). All spec sections map to a task.
- **Type/name consistency:** `categoryAdjacencyMul(b, buildings, defs)` is defined in T2 and used identically in T3 (adjacency.ts), T5 (economy.ts), T6 (inspector-ui.ts). `CATEGORY_ADJACENCY_RATE` defined T1, consumed T2. `computeBuffStack` signature unchanged, so the economy call site at `economy.ts:978` needs no edit.
- **No migration:** confirmed `adjacencyBuffs`/`buffStack` are static-def / per-tick only; T4 step 4 greps to prove no other references survive.
- **Line numbers are approximate** (they shift as edits land) — each step shows surrounding code to anchor the edit.
