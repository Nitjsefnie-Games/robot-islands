# Cluster Bonus Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Rework the §4.5 buff-adjacency multiplier from a positional per-neighbour count (`1 + n × rate`) into a uniform per-cluster bonus (`1 + (k − 1) × rate`) over each building's same-category 4-connected cluster.

**Architecture:** Replace `categoryAdjacencyMul` in `adjacency.ts` with `clusterBonusMul` (single building) plus a batch `clusterBonusMuls` (whole-island, one component-labelling pass via union-find). `economy.computeRates` computes the batch map once per call and looks up each building's multiplier; `computeBuffStack` gains an optional precomputed-multiplier parameter so it reuses that map instead of recomputing. `inspector-ui` uses the single-building form and relabels the displayed bonus. The rename is atomic across the three source files + the test so the build never sits broken.

**Tech Stack:** Vite 5 + TypeScript strict (`noUncheckedIndexedAccess`, `noUnusedLocals`, `noUnusedParameters`) + vitest. Pure math layer (no PixiJS) in `adjacency.ts` / `economy.ts`; DOM layer in `inspector-ui.ts`.

---

## File Structure

- `src/adjacency.ts` — **modify.** Remove `categoryAdjacencyMul`; add `clusterBonusMul(b, buildings, defs)` and `clusterBonusMuls(buildings, defs): Map<id, number>`; add optional `clusterMul` param to `computeBuffStack`. Update the module header + doc comments from "neighbour count" to "cluster size".
- `src/adjacency.test.ts` — **modify.** Rename the `categoryAdjacencyMul` describe block and its calls to `clusterBonusMul`; flip the cross-of-5 / line assertions to uniform; add `M E M` (different-category-doesn't-bridge), disjoint-cluster, ring-with-hole, multi-tile, and batch-vs-single cases. The existing `computeBuffStack` describe block is unchanged (its base values are preserved for those layouts).
- `src/economy.ts` — **modify.** Import `clusterBonusMuls` instead of `categoryAdjacencyMul`; compute `clusterMuls` once after `validBuildings`; pass the focal building's value into `computeBuffStack` (line ~978) and use it for generator power (line ~1198).
- `src/inspector-ui.ts` — **modify.** Import `clusterBonusMul` instead of `categoryAdjacencyMul`; rename the local `adjMul → clusterMul`; relabel `adjacency ×` → `cluster ×` (two sites).
- `SPEC.md §4.5` — **modify.** Rewrite the buff-adjacency paragraph to the cluster formula and cite the new resolver names.
- `src/building-defs.ts` — **modify.** Update the `CATEGORY_ADJACENCY_RATE` doc comment from per-neighbour to per-cluster.

---

## Task 1: Cluster-bonus resolver + wiring (atomic rename)

**Files:**
- Modify: `src/adjacency.ts`
- Modify: `src/adjacency.test.ts`
- Modify: `src/economy.ts:14` (import), after `:772` (compute map), `:978`, `:1198`
- Modify: `src/inspector-ui.ts:34` (import), `:1294`, `:1356`, `:1362`, `:1384-1386`

- [ ] **Step 1: Rewrite the `categoryAdjacencyMul` test block as `clusterBonusMul` (the failing test)**

In `src/adjacency.test.ts`, change the import on line 5 from:

```ts
import { categoryAdjacencyMul, checkGates, computeBuffStack } from './adjacency.js';
```

to:

```ts
import { checkGates, clusterBonusMul, clusterBonusMuls, computeBuffStack } from './adjacency.js';
```

Then replace the entire `describe('categoryAdjacencyMul — §4.5 universal category adjacency', …)` block (lines 190–231) with:

```ts
describe('clusterBonusMul — §4.5 per-cluster bonus', () => {
  const place = (id: string, defId: string, x: number, y: number) =>
    ({ id, defId: defId as never, x, y }) as never;

  it('isolated building → 1.0', () => {
    const a = place('a', 'mine', 0, 0);
    expect(clusterBonusMul(a, [a])).toBe(1);
  });

  it('pair (cluster size 2) → 1 + 1 × 0.10 = 1.10, both members', () => {
    const a = place('a', 'mine', 0, 0);
    const b = place('b', 'mine', 2, 0);
    expect(clusterBonusMul(a, [a, b])).toBeCloseTo(1.1, 9);
    expect(clusterBonusMul(b, [a, b])).toBeCloseTo(1.1, 9);
  });

  it('line of 3 → uniform 1.20 (was: centre 1.20, ends 1.10)', () => {
    const a = place('a', 'mine', 0, 0);
    const b = place('b', 'mine', 2, 0);
    const c = place('c', 'mine', 4, 0);
    const all = [a, b, c];
    expect(clusterBonusMul(a, all)).toBeCloseTo(1.2, 9);
    expect(clusterBonusMul(b, all)).toBeCloseTo(1.2, 9);
    expect(clusterBonusMul(c, all)).toBeCloseTo(1.2, 9);
  });

  it('cross of 5 → uniform 1.40 across centre AND arms (was: arms 1.10)', () => {
    const mid = place('mid', 'mine', 0, 0);
    const n = place('n', 'mine', 0, -2);
    const s = place('s', 'mine', 0, 2);
    const e = place('e', 'mine', 2, 0);
    const w = place('w', 'mine', -2, 0);
    const all = [mid, n, s, e, w];
    for (const b of all) expect(clusterBonusMul(b, all)).toBeCloseTo(1.4, 9);
  });

  it('ring of 8 around a hole → one cluster of 8, all ×1.70 (R1: hole ignored)', () => {
    // 3×3 block of 2×2 mines at spacing 2, centre tile (2,2) empty.
    const ids = [
      place('p00', 'mine', 0, 0), place('p20', 'mine', 2, 0), place('p40', 'mine', 4, 0),
      place('p02', 'mine', 0, 2),                              place('p42', 'mine', 4, 2),
      place('p04', 'mine', 0, 4), place('p24', 'mine', 2, 4), place('p44', 'mine', 4, 4),
    ];
    for (const b of ids) expect(clusterBonusMul(b, ids)).toBeCloseTo(1.7, 9);
  });

  it('different-category building between two mines does NOT bridge them (M E M)', () => {
    // mine — workshop — mine, all spacing 2. The workshop is a different
    // category, so the two mines are not connected: two clusters of size 1.
    const m1 = place('m1', 'mine', 0, 0);
    const w = place('w', 'workshop', 2, 0);
    const m2 = place('m2', 'mine', 4, 0);
    const all = [m1, w, m2];
    expect(clusterBonusMul(m1, all)).toBe(1);
    expect(clusterBonusMul(m2, all)).toBe(1);
    expect(clusterBonusMul(w, all)).toBe(1);
  });

  it('two disjoint same-category clusters scale independently', () => {
    // Cluster A: pair at x=0,2 (size 2 → 1.10). Cluster B: triple at x=10,12,14 (size 3 → 1.20).
    const a1 = place('a1', 'mine', 0, 0);
    const a2 = place('a2', 'mine', 2, 0);
    const b1 = place('b1', 'mine', 10, 0);
    const b2 = place('b2', 'mine', 12, 0);
    const b3 = place('b3', 'mine', 14, 0);
    const all = [a1, a2, b1, b2, b3];
    expect(clusterBonusMul(a1, all)).toBeCloseTo(1.1, 9);
    expect(clusterBonusMul(b1, all)).toBeCloseTo(1.2, 9);
    expect(clusterBonusMul(b3, all)).toBeCloseTo(1.2, 9);
  });

  it('diagonal-only contact does NOT connect (4-adjacency)', () => {
    const a = place('a', 'mine', 0, 0);
    const d = place('d', 'mine', 2, 2);
    expect(clusterBonusMul(a, [a, d])).toBe(1);
    expect(clusterBonusMul(d, [a, d])).toBe(1);
  });

  it('duplicate id (degenerate) → 1.0', () => {
    const a = place('a', 'mine', 0, 0);
    expect(clusterBonusMul(a, [a, a])).toBe(1);
  });

  it('batch clusterBonusMuls agrees with single clusterBonusMul', () => {
    const a = place('a', 'mine', 0, 0);
    const b = place('b', 'mine', 2, 0);
    const c = place('c', 'mine', 4, 0);
    const all = [a, b, c];
    const map = clusterBonusMuls(all);
    for (const x of all) {
      expect(map.get(x.id)).toBeCloseTo(clusterBonusMul(x, all), 9);
    }
    expect(map.get('a')).toBeCloseTo(1.2, 9);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run src/adjacency.test.ts`
Expected: FAIL — `clusterBonusMul` / `clusterBonusMuls` are not exported from `./adjacency.js`.

- [ ] **Step 3: Implement the resolvers in `src/adjacency.ts`**

Replace the entire `categoryAdjacencyMul` function (lines 80–109) with the two functions below. Keep `footprintKeySet`, `borderTiles`, `touchesBorder` exactly as they are (they are reused).

```ts
/**
 * §4.5 per-building cluster-bonus multiplier. A building's *cluster* is the
 * maximal set of same-category buildings connected through 4-neighbour links
 * (the §4.4 border test). Every member of a cluster of size `k` receives the
 * same `1 + (k − 1) × CATEGORY_ADJACENCY_RATE[category]`. Connectivity only:
 * enclosed empty tiles do not break a cluster, and a different-category
 * building between two same-category buildings does not bridge them. Physical
 * same-island buildings only — the §13.3 cross-island lattice does NOT feed
 * this term. Returns 1.0 for an isolated building or a rate-0 category.
 *
 * Implemented via the batch labeller so single- and whole-island callers agree.
 */
export function clusterBonusMul(
  b: PlacedBuilding,
  buildings: ReadonlyArray<PlacedBuilding>,
  defs: Readonly<Record<BuildingDefId, BuildingDef>> = BUILDING_DEFS,
): number {
  return clusterBonusMuls(buildings, defs).get(b.id) ?? 1;
}

/**
 * Batch form: every building's cluster-bonus multiplier in one pass. Groups
 * by category, unions same-category 4-adjacent buildings (union-find), then
 * maps each building to `1 + (size − 1) × rate`. O(N²) over the building set —
 * the per-tick hot path (`economy.computeRates`) calls this ONCE per tick and
 * reads per-building values from the returned map, rather than re-deriving a
 * component per building.
 */
export function clusterBonusMuls(
  buildings: ReadonlyArray<PlacedBuilding>,
  defs: Readonly<Record<BuildingDefId, BuildingDef>> = BUILDING_DEFS,
): Map<string, number> {
  const n = buildings.length;
  const borders = buildings.map((b) => borderTiles(footprintKeySet(b, defs)));

  // Union-find over building indices.
  const parent = Array.from({ length: n }, (_, i) => i);
  const find = (i: number): number => {
    let r = i;
    while (parent[r]! !== r) r = parent[r]!;
    let cur = i;
    while (parent[cur]! !== r) {
      const next = parent[cur]!;
      parent[cur] = r;
      cur = next;
    }
    return r;
  };
  const union = (a: number, b: number): void => {
    const ra = find(a);
    const rb = find(b);
    if (ra !== rb) parent[ra] = rb;
  };

  for (let i = 0; i < n; i++) {
    const cat = defs[buildings[i]!.defId].category;
    for (let j = i + 1; j < n; j++) {
      if (defs[buildings[j]!.defId].category !== cat) continue;
      // Adjacency is symmetric — test j against i's border.
      if (touchesBorder(buildings[j]!, borders[i]!, defs)) union(i, j);
    }
  }

  const compSize = new Map<number, number>();
  for (let i = 0; i < n; i++) {
    const r = find(i);
    compSize.set(r, (compSize.get(r) ?? 0) + 1);
  }

  const out = new Map<string, number>();
  for (let i = 0; i < n; i++) {
    const b = buildings[i]!;
    const rate = CATEGORY_ADJACENCY_RATE[defs[b.defId].category] ?? 0;
    const k = compSize.get(find(i)) ?? 1;
    out.set(b.id, rate === 0 ? 1 : 1 + (k - 1) * rate);
  }
  return out;
}
```

Then update `computeBuffStack` (lines 124–141) to accept and prefer a precomputed multiplier. Change the signature and the first line of the body:

```ts
export function computeBuffStack(
  b: PlacedBuilding,
  buildings: ReadonlyArray<PlacedBuilding>,
  defs: Readonly<Record<BuildingDefId, BuildingDef>> = BUILDING_DEFS,
  crossIsland?: ReadonlyArray<PlacedBuilding>,
  exoticRules?: ReadonlyArray<{ readonly pair: readonly [BuildingDefId, BuildingDefId]; readonly recipeRateBonus: number }>,
  /** Precomputed cluster multiplier for `b` (from `clusterBonusMuls`). When
   *  omitted, falls back to a single `clusterBonusMul` call. */
  clusterMul?: number,
): number {
  let stack = clusterMul ?? clusterBonusMul(b, buildings, defs);
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

Finally, update the module header doc (lines 7–8) and the `computeBuffStack` doc comment (lines 111–123) to say "cluster size" rather than "per matching neighbor". Replace lines 6–8:

```ts
// SPEC §4.5 (buff form): "every building gains a uniform multiplier from the
// size of its same-category 4-connected cluster: `1 + (k − 1) × rate`."
```

and in the `computeBuffStack` doc comment replace the sentence beginning "The category term (universal, per-category, linear, uncapped …" with:

```ts
 * Returns `clusterBonusMul × Π(exotic-pair bonuses)`. The cluster term
 * (uniform per same-category 4-connected cluster — see `clusterBonusMul`) uses
 * physical same-island buildings only. The exotic-pair term carries the
```

- [ ] **Step 4: Update `src/economy.ts` to use the batch map**

Change the import on line 14 from:

```ts
import { borderTiles, categoryAdjacencyMul, checkGates, computeBuffStack, footprintKeySet, touchesBorder } from './adjacency.js';
```

to:

```ts
import { borderTiles, checkGates, clusterBonusMuls, computeBuffStack, footprintKeySet, touchesBorder } from './adjacency.js';
```

Immediately after the `validBuildings` definition (line 772), add:

```ts
  // §4.5 cluster-bonus multipliers — labelled once per tick for the whole
  // island; recipe-rate (computeBuffStack) and generator-power both read from
  // this map instead of re-deriving each building's cluster.
  const clusterMuls = clusterBonusMuls(validBuildings, defs);
```

Change line 978 from:

```ts
    const buffStack = computeBuffStack(b, validBuildings, defs, undefined, exoticRules);
```

to:

```ts
    const buffStack = computeBuffStack(b, validBuildings, defs, undefined, exoticRules, clusterMuls.get(b.id) ?? 1);
```

Change line 1198 from:

```ts
    const adjMul = categoryAdjacencyMul(b, validBuildings, defs);
```

to:

```ts
    const adjMul = clusterMuls.get(b.id) ?? 1;
```

- [ ] **Step 5: Update `src/inspector-ui.ts` to the single-building form + relabel**

Change the import on line 34 from:

```ts
import { categoryAdjacencyMul, gateSatisfied } from './adjacency.js';
```

to:

```ts
import { clusterBonusMul, gateSatisfied } from './adjacency.js';
```

Change the resolver call at lines 1294–1298 from:

```ts
    const adjMul = categoryAdjacencyMul(
      building,
      state.buildings.filter(isOperationalBuilding),
      BUILDING_DEFS,
    );
```

to:

```ts
    const clusterMul = clusterBonusMul(
      building,
      state.buildings.filter(isOperationalBuilding),
      BUILDING_DEFS,
    );
```

Then update the four downstream uses of the old `adjMul` name:

- Line 1356: `const compositeMul = catMul * mineLogBonus * fledgMul * adjMul;` → replace `adjMul` with `clusterMul`.
- Line 1362: `if (adjMul > 1.0001) parts.push(\`adjacency ×${adjMul.toFixed(2)}\`);` → `if (clusterMul > 1.0001) parts.push(\`cluster ×${clusterMul.toFixed(2)}\`);`
- Line 1384: `const prodAdj = prod * adjMul;` → `const prodAdj = prod * clusterMul;`
- Lines 1385–1387: replace with

```ts
        parts.push(clusterMul > 1.0001
          ? `+${fmtPower(prodAdj)} produced (cluster ×${clusterMul.toFixed(2)})`
          : `+${fmtPower(prodAdj)} produced`);
```

- [ ] **Step 6: Run the adjacency tests**

Run: `npx vitest run src/adjacency.test.ts`
Expected: PASS — all cluster cases green, including the flipped uniform cross-of-5 / line-of-3 assertions and the batch-vs-single check.

- [ ] **Step 7: Run the full suite**

Run: `npm test`
Expected: PASS — economy and inspector tests still green; no remaining reference to `categoryAdjacencyMul`.

- [ ] **Step 8: Typecheck / build**

Run: `npm run build`
Expected: clean `tsc -b` (no unused-import error, no missing `categoryAdjacencyMul`), then a successful vite build.

- [ ] **Step 9: Commit**

```bash
git add src/adjacency.ts src/adjacency.test.ts src/economy.ts src/inspector-ui.ts
git commit -m "feat(adjacency): per-cluster bonus replaces per-neighbour buff (§4.5)

Rework categoryAdjacencyMul → clusterBonusMul: every building in a
same-category 4-connected cluster gets a uniform 1 + (k-1) * rate. Add
batch clusterBonusMuls (union-find, one pass/tick) consumed by
computeRates for recipe rate and generator power. Inspector relabels
'adjacency' → 'cluster'. R1: holes ignored; cross-category does not bridge.

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 2: Align SPEC §4.5 and the rate doc comment

**Files:**
- Modify: `SPEC.md:476`
- Modify: `src/building-defs.ts:401-408`

- [ ] **Step 1: Rewrite the SPEC §4.5 buff-adjacency paragraph**

In `SPEC.md`, replace the paragraph on line 476 (starts `**Buff adjacency (universal per-category):**`) with:

```markdown
**Buff adjacency (universal per-category cluster):** every building gains a flat, linear, uncapped multiplier from the size of its same-category 4-connected **cluster**: `rate = 1 + (k − 1) × CATEGORY_ADJACENCY_RATE[category]`, where `k` is the number of buildings in the focal building's maximal same-category cluster — buildings joined through same-category 4-neighbour links (§4.4), a multi-tile building counting once. The bonus is **uniform** across every member of a cluster. Connectivity only: enclosed empty tiles do not break a cluster, and a different-category building between two same-category buildings does not bridge them. The multiplier applies to the building's recipe rate and, for generators, to power output (NOT power consumption). The per-category rate lives in `CATEGORY_ADJACENCY_RATE` (`building-defs.ts`), seeded uniform at 0.10. Cross-island lattice neighbours (§13.3) do not feed this term. Skill-tree `exoticAdjacency` pair-boosts (§9.1) stack multiplicatively on top. Resolution: `clusterBonusMul` / `clusterBonusMuls` / `computeBuffStack` in `adjacency.ts`.
```

- [ ] **Step 2: Update the `CATEGORY_ADJACENCY_RATE` doc comment**

In `src/building-defs.ts`, replace the comment block on lines 401–408 with:

```ts
/**
 * §4.5 universal per-category cluster-bonus rate. Each building gains
 * `1 + (k − 1) × CATEGORY_ADJACENCY_RATE[category]` to its recipe rate (and,
 * for generators, its power output), where `k` is the size of the building's
 * same-category 4-connected cluster. Uniform across the cluster, linear,
 * uncapped. Seeded uniform at 0.10 — tune per category here. Categories whose
 * buildings neither run a recipe nor generate power (storage / logistics /
 * cooling) are no-ops.
 */
```

- [ ] **Step 3: Sanity-check no stale references remain**

Run: `grep -rn "categoryAdjacencyMul\|per-neighbour\|distinct same-category 4-neighbours" src SPEC.md`
Expected: no matches (the §4.4 "4-neighbors" wording for the footprint set itself is fine and untouched; this grep targets the old buff-formula phrasing only).

- [ ] **Step 4: Commit**

```bash
git add SPEC.md src/building-defs.ts
git commit -m "docs(spec): §4.5 buff is per-cluster, not per-neighbour

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Self-Review

**Spec coverage:**
- Cluster definition (same-category, 4-connected, multi-tile-once, cross-category-no-bridge, R1 holes-ignored) → Task 1 Step 3 (`clusterBonusMuls`) + tests in Step 1; SPEC in Task 2 Step 1.
- Formula `1 + (k − 1) × rate`, uniform → Task 1 Step 3 + cross-of-5/line tests.
- Rename `categoryAdjacencyMul → clusterBonusMul` + batch → Task 1 Steps 3–5.
- Compute-once-per-tick perf → Task 1 Step 4 (`clusterMuls` after `validBuildings`).
- Inspector relabel → Task 1 Step 5.
- SPEC §4.5 + rate doc → Task 2.
- Tests (sizes, uniformity, M E M, diagonal, disjoint, ring-with-hole, multi-tile via 2×2 mines, batch-vs-single) → Task 1 Step 1. (rate-0 short-circuit is covered structurally — all live categories are 0.10, so it is exercised implicitly and asserted by the guard; no dedicated test since no rate-0 category exists to place.)

**Placeholder scan:** none — every code step shows the full replacement text and exact lines.

**Type consistency:** `clusterBonusMul(b, buildings, defs)` and `clusterBonusMuls(buildings, defs): Map<string, number>` signatures match between the implementation (Task 1 Step 3), the economy call (`clusterMuls.get(b.id) ?? 1`), the inspector call, and the tests. `computeBuffStack`'s new trailing optional `clusterMul?: number` is backward-compatible with every existing call (tests omit it; economy passes it). Building ids are `string`; the map is keyed by `b.id`.
