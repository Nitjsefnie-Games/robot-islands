# Populated-Absorbs-Unpopulated Merge — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A populated island that grows until its tile footprint touches a non-populated neighbor absorbs it as a new constituent lobe.

**Architecture:** The merge engine's *trigger* (`findNextMerge` in `src/island-merge.ts`) currently filters candidates to `populated` islands only. Widen it so a pair where **≥1** island is populated is a merge candidate; the populated island is always the absorber. `performMerge` is already state-safe for a stateless absorbed island, so no change there beyond stale comments. SPEC §3.6 gains the explicit precondition. Code, tests, and SPEC move in one commit (repo rule).

**Tech Stack:** TypeScript (strict, `noUncheckedIndexedAccess`), vitest. Pure layer — no PixiJS.

## Global Constraints

- TypeScript strict; new code compiles clean under `noUnusedLocals` / `noUnusedParameters` / `noUncheckedIndexedAccess`.
- Every behavior change updates `SPEC.md` in the **same commit** (code and spec move together).
- Pure layer only — no `pixi.js` import in `island-merge.ts`.
- Co-author trailer on every commit: `Co-Authored-By: <model> <noreply@anthropic.com>`.
- Verify: `npx vitest run src/island-merge.test.ts` green and `npm run build` clean before claiming done.

---

### Task 1: Absorb non-populated neighbors on contact

**Files:**
- Modify: `src/island-merge.ts` — `findNextMerge` (~`:381`), `mergeSignature` (~`:369`), stale comments at `:344`, `:236`, `:253`.
- Test: `src/island-merge.test.ts` — invert the `:788` skip test; add four new cases.
- Modify: `SPEC.md` — §3.6 trigger paragraph (`:448`) and "larger island absorbs the smaller" bullet (`:454`).

**Interfaces:**
- Consumes (existing, unchanged signatures):
  - `findNextMerge(world: WorldState, states: Map<string, IslandState>): { absorber: IslandSpec; absorbed: IslandSpec } | null`
  - `performMerge(world, states, absorber: IslandSpec, absorbed: IslandSpec): void`
  - `chooseMergeAbsorber(a, b, sa: IslandState, sb: IslandState): AbsorberDecision` — only called when both populated.
  - `islandsOverlap(a: IslandSpec, b: IslandSpec): boolean`, `islandTileCount(s: IslandSpec): number`.
- Produces: no new exports. `findNextMerge`'s contract is extended (not changed): it now returns a pair when a populated island touches a non-populated one, with the populated island as `absorber`.

**Behavioral contract for the new `findNextMerge`:**
- Candidate pair `(a, b)` is eligible iff `islandsOverlap(a, b)` AND (`a.populated || b.populated`).
- Two non-populated overlapping islands → NOT a candidate.
- Absorber resolution: both populated → `chooseMergeAbsorber`; exactly one populated → the populated island is the absorber, the other is absorbed.
- Ordering across multiple candidate pairs in one tick is unchanged: largest combined `islandTileCount` first, then lowest `minId`.
- Memoization: signature must include every participating island (id + `cx,cy,majorRadius,minorRadius` + each `extraEllipses` entry + a populated marker). Only null results are cached.

---

- [ ] **Step 1: Write the failing test — populated absorbs a touching unpopulated island (invert the existing skip test)**

In `src/island-merge.test.ts`, replace the existing `it('skips unpopulated islands ...')` test (~`:788`) with:

```ts
it('populated island absorbs a touching unpopulated neighbour', () => {
  const a = makeSpec({ id: 'a', cx: 0, cy: 0, majorRadius: 10, minorRadius: 10 });
  const b = makeSpec({ id: 'b', cx: 15, cy: 0, majorRadius: 10, minorRadius: 10, populated: false });
  const world = makeWorld([a, b]);
  const states = new Map<string, IslandState>([['a', makeState('a')]]);
  const res = findNextMerge(world, states);
  expect(res).not.toBeNull();
  expect(res!.absorber.id).toBe('a');
  expect(res!.absorbed.id).toBe('b');
});
```

Match the existing helpers (`makeSpec`, `makeWorld`, `makeState`) already used in the file — read the top of the test file for their exact shapes before writing. Geometry: pick radii/positions whose inscribed-tile footprints **edge-touch** (use the same overlap construction the existing merge tests use, e.g. a populated-vs-populated merge case in this file). The `populated: false` island has **no** entry in `states`.

- [ ] **Step 2: Run the test, verify it fails**

Run: `npx vitest run src/island-merge.test.ts -t "absorbs a touching unpopulated"`
Expected: FAIL — `findNextMerge` currently filters to populated and returns `null`.

- [ ] **Step 3: Widen the candidate scan and absorber resolution in `findNextMerge`**

In `src/island-merge.ts` `findNextMerge`:

1. Build the candidate set from pairs where ≥1 island is populated, iterating populated outer × all-islands inner to stay O(P·N):

```ts
const populated = world.islands.filter((s) => s.populated);
const sig = mergeSignature(world.islands);   // signature now spans ALL islands
if (sig === _mergeSig) return _mergeResult;
// ... cache() helper unchanged ...

const tileCounts = new Map<string, number>();
for (const s of world.islands) tileCounts.set(s.id, islandTileCount(s));

const seen = new Set<string>();   // dedupe unordered pairs
const cands: Candidate[] = [];
for (const p of populated) {
  for (const other of world.islands) {
    if (other.id === p.id) continue;
    const key = p.id < other.id ? `${p.id}|${other.id}` : `${other.id}|${p.id}`;
    if (seen.has(key)) continue;
    seen.add(key);
    if (!islandsOverlap(p, other)) continue;
    const a = p.id < other.id ? p : other;
    const b = p.id < other.id ? other : p;
    const ta = tileCounts.get(a.id) ?? 0;
    const tb = tileCounts.get(b.id) ?? 0;
    cands.push({ a, b, combined: ta + tb, minId: a.id });
  }
}
```

2. After the existing sort (largest combined first, then lower `minId`), resolve the absorber so a populated island always wins over a non-populated one:

```ts
const top = cands[0]!;
const sa = states.get(top.a.id);
const sb = states.get(top.b.id);
let absorber: IslandSpec;
let absorbed: IslandSpec;
if (top.a.populated && top.b.populated) {
  if (!sa || !sb) return cache(null);   // populated invariant: both must have state
  const decision = chooseMergeAbsorber(top.a, top.b, sa, sb);
  absorber = decision.absorber === 'a' ? top.a : top.b;
  absorbed = decision.absorber === 'a' ? top.b : top.a;
} else {
  // Exactly one populated (≥1 guaranteed by the scan). The populated island
  // owns the surviving identity/state and is always the absorber.
  absorber = top.a.populated ? top.a : top.b;
  absorbed = top.a.populated ? top.b : top.a;
  if (!states.get(absorber.id)) return cache(null);   // absorber must have state
}
return cache({ absorber, absorbed });
```

Keep the `minId` tiebreak field consistent: since `a` is always the lower-id member, `minId: a.id` is correct.

- [ ] **Step 4: Update `mergeSignature` to span all islands plus a populated marker**

Change `mergeSignature` to accept all islands and encode the populated bit:

```ts
function mergeSignature(islands: ReadonlyArray<IslandSpec>): string {
  let sig = '';
  for (const s of islands) {
    sig += `${s.id}:${s.populated ? 1 : 0}:${s.cx},${s.cy},${s.majorRadius},${s.minorRadius}`;
    if (s.extraEllipses) {
      for (const e of s.extraEllipses) sig += `;${e.major},${e.minor},${e.offsetX},${e.offsetY}`;
    }
    sig += '|';
  }
  return sig;
}
```

(The call site in Step 3 already passes `world.islands`.)

- [ ] **Step 5: Run the inverted test, verify it passes**

Run: `npx vitest run src/island-merge.test.ts -t "absorbs a touching unpopulated"`
Expected: PASS.

- [ ] **Step 6: Add the remaining behavior tests**

Add to `src/island-merge.test.ts`:

```ts
it('absorbed unpopulated lobe keeps its biome and terrain seed', () => {
  const a = makeSpec({ id: 'a', cx: 0, cy: 0, majorRadius: 10, minorRadius: 10, biome: 'plains' });
  const b = makeSpec({ id: 'b', cx: 15, cy: 0, majorRadius: 10, minorRadius: 10, populated: false, biome: 'volcanic' });
  const world = makeWorld([a, b]);
  const states = new Map<string, IslandState>([['a', makeState('a')]]);
  performMerge(world, states, a, b);
  const lobe = a.extraEllipses!.at(-1)!;
  expect(lobe.biome).toBe('volcanic');
  expect(lobe.originId).toBe('b');
  expect(world.islands.find((s) => s.id === 'b')).toBeUndefined();
});

it('absorbs an undiscovered neighbour on contact (no discovered gate)', () => {
  const a = makeSpec({ id: 'a', cx: 0, cy: 0, majorRadius: 10, minorRadius: 10 });
  const b = makeSpec({ id: 'b', cx: 15, cy: 0, majorRadius: 10, minorRadius: 10, populated: false, discovered: false });
  const world = makeWorld([a, b]);
  const states = new Map<string, IslandState>([['a', makeState('a')]]);
  const res = findNextMerge(world, states);
  expect(res).not.toBeNull();
  expect(res!.absorber.id).toBe('a');
  expect(res!.absorbed.id).toBe('b');
});

it('does NOT merge two non-populated islands', () => {
  const a = makeSpec({ id: 'a', cx: 0, cy: 0, majorRadius: 10, minorRadius: 10, populated: false });
  const b = makeSpec({ id: 'b', cx: 15, cy: 0, majorRadius: 10, minorRadius: 10, populated: false });
  const world = makeWorld([a, b]);
  const states = new Map<string, IslandState>();
  expect(findNextMerge(world, states)).toBeNull();
});

it('retargets a settler in transit to an absorbed island and consumes it cleanly', () => {
  const a = makeSpec({ id: 'a', cx: 0, cy: 0, majorRadius: 10, minorRadius: 10 });
  const b = makeSpec({ id: 'b', cx: 15, cy: 0, majorRadius: 10, minorRadius: 10, populated: false });
  const world = makeWorld([a, b]);
  const states = new Map<string, IslandState>([['a', makeState('a')]]);
  // a settlement vehicle in transit toward the soon-to-be-absorbed island b
  world.vehicles.push(makeVehicle({ target: 'b', from: 'a' }));
  performMerge(world, states, a, b);
  expect(world.vehicles[0]!.target).toBe('a');   // retargeted to the absorber
});
```

Use the file's existing vehicle/state helpers; if no `makeVehicle` helper exists, construct a minimal `SettlementVehicle` literal matching the type (read the type and any existing vehicle test in the file). The point of the last test is only that `performMerge` retargets `target` to the absorber — the full arrival/consume path is covered by `settlement.test.ts`.

- [ ] **Step 7: Run all the new tests, verify they pass**

Run: `npx vitest run src/island-merge.test.ts`
Expected: PASS (all, including unchanged populated-vs-populated cases).

- [ ] **Step 8: Fix stale comments in `island-merge.ts`**

Update the comment block at `findNextMerge` (~`:344`) — remove "Only populated islands participate; an unpopulated island has no `state`…" and replace with a note that a pair needs ≥1 populated island and the populated island is always the absorber. Update the inline comments at the inventory transfer (`:236-237`) and skill-refund (`:253`) steps in `performMerge` so they no longer assert "both islands are populated"; instead note the absorbed island may be stateless (guards already handle it).

- [ ] **Step 9: Update SPEC.md §3.6**

In `SPEC.md` §3.6:
- Amend the trigger paragraph (`:448`) to add: a merge requires at least one populated island; two unpopulated islands never merge.
- Amend the "The larger island absorbs the smaller" bullet (`:454`) to: when both islands are populated, the larger absorbs the smaller (level tiebreak); **when exactly one is populated, the populated island is always the absorber regardless of size**, and the absorbed non-populated neighbour contributes only its land area, biome, terrain seed, and ownership-ledger lobe (it has no inventory, skill points, level, buildings, or routes). Eligibility is geometric contact, independent of the `discovered` flag.

- [ ] **Step 10: Full build + targeted suite, then commit**

Run: `npm run build`
Expected: clean (tsc -b + vite build), no strict errors.

Run: `npx vitest run src/island-merge.test.ts`
Expected: PASS.

```bash
git add src/island-merge.ts src/island-merge.test.ts SPEC.md
git commit -m "feat(merge): populated islands absorb non-populated neighbours on contact (§3.6)

Co-Authored-By: <model> <noreply@anthropic.com>"
```

---

## Self-Review

- **Spec coverage:** trigger widening (Steps 3-4) ✓; populated-always-absorber (Step 3) ✓; ≥1-populated precondition / no two-unpopulated merge (Steps 3, 6) ✓; biome/terrain-seed preserved (Step 6) ✓; no `discovered` gate (Step 6) ✓; settler interplay (Step 6) ✓; SPEC §3.6 (Step 9) ✓; stale comments (Step 8) ✓.
- **Placeholder scan:** none — all steps carry concrete code/commands.
- **Type consistency:** `findNextMerge`/`performMerge`/`chooseMergeAbsorber`/`mergeSignature` signatures match the existing module; `mergeSignature` arg changes from `populated` to `world.islands` and its sole caller is updated in Step 3.
