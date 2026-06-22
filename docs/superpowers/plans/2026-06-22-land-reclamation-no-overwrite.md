# Land Reclamation No-Overwrite (Placement-Order Ownership Ledger) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make Land Reclamation growth on a merged island stop overwriting a sibling constituent's already-placed land/terrain, by resolving overlap precedence by placement *time* (an append-only ownership ledger) instead of constituent *index*.

**Architecture:** Add an optional, append-only `ownershipLedger` to `IslandSpec` recording each constituent's original-and-grown claims in placement order. A single pure resolver `constituentOwnerAt` walks the ledger (first inscriber wins; current-radii index fallback when absent or under-covering). The two terrain/biome ownership sites delegate to it; `expandConstituent` and `performMerge` maintain the ledger. No persistence schema bump — the field is additive/optional and `SerializedIslandSpec = Omit<IslandSpec,'terrainAt'>` carries it automatically.

**Tech Stack:** TypeScript (strict, `noUncheckedIndexedAccess`), Vitest, PixiJS (render layer only — untouched here). Pure-layer change.

## Global Constraints

- **Spec is source of truth; code and spec move together.** Update `SPEC.md` §3.6 (line ~466) and §3.4 (line ~420) in this change (Task 5).
- **TypeScript discipline:** compile clean under `strict`, `noUncheckedIndexedAccess`, `noUnusedLocals`, `noUnusedParameters`. Index reads need `!`/`?? 0` guards.
- **One responsibility per file.** New pure helpers live in `src/world.ts` beside `islandConstituents` / `constituentBiomeAt`. No new file needed.
- **Tile-coords convention:** geometry uses `tileInscribedInEllipse(localX, localY, major, minor)` with island-local coords; a constituent's local frame is `(x - offsetX, y - offsetY)`.
- **Constituent index convention:** `0` = primary (offset 0,0, `spec.major/minorRadius`); `N` = `spec.extraEllipses[N-1]`. The ledger's `constituent` field uses this index, matching `islandConstituents(spec)` order.
- **Verification gate:** `cd server && npx tsc --noEmit` for server typecheck; root `npx vitest run <file>` for single files; full `npm test` needs a running Postgres (client+server projects) — run it in Task 5.
- **Branch:** `feat/land-reclamation-no-overwrite` (already cut from `master`). Commit per task.

---

### Task 1: Ledger type, implicit baseline, and the `constituentOwnerAt` resolver

**Files:**
- Modify: `src/world.ts` (add `OwnershipClaim`, the `ownershipLedger` field on `IslandSpec` after `baseLayoutRadius` at ~line 191, and the helpers near `islandConstituents`/`constituentBiomeAt` ~line 214–239)
- Test: `src/world.test.ts` (create if absent, else append a `describe('ownership ledger')` block)

**Interfaces:**
- Produces:
  - `interface OwnershipClaim { readonly constituent: number; readonly major: number; readonly minor: number }`
  - `IslandSpec.ownershipLedger?: ReadonlyArray<OwnershipClaim>`
  - `islandImplicitLedger(spec: IslandSpec): OwnershipClaim[]` — baseline from current constituents in index order
  - `constituentOwnerAt(spec: IslandSpec, x: number, y: number): { ellipse: ConstituentEllipse; index: number } | undefined`
- Consumes: existing `islandConstituents(spec)`, `tileInscribedInEllipse` (already imported at `world.ts:33`), `ConstituentEllipse`.

- [ ] **Step 1: Write the failing test**

In `src/world.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import {
  constituentOwnerAt,
  islandImplicitLedger,
  type IslandSpec,
  type Biome,
} from './world.js';

function spec(over: Partial<IslandSpec> = {}): IslandSpec {
  return {
    id: 'a', name: 'a', biome: 'plains' as Biome, cx: 0, cy: 0,
    majorRadius: 5, minorRadius: 5, populated: true, discovered: true,
    buildings: [], modifiers: [], ...over,
  };
}

describe('ownership ledger', () => {
  it('islandImplicitLedger lists every constituent at current radii in index order', () => {
    const s = spec({
      extraEllipses: [{ major: 4, minor: 4, rotation: 0, offsetX: 8, offsetY: 0, biome: 'arctic' as Biome, originId: 'b' }],
    });
    expect(islandImplicitLedger(s)).toEqual([
      { constituent: 0, major: 5, minor: 5 },
      { constituent: 1, major: 4, minor: 4 },
    ]);
  });

  it('with no ledger, owner is the earliest-index inscriber (legacy behavior)', () => {
    const s = spec({
      extraEllipses: [{ major: 5, minor: 5, rotation: 0, offsetX: 3, offsetY: 0, biome: 'arctic' as Biome, originId: 'b' }],
    });
    // tile (1,0) is inscribed in BOTH primary (centre 0,0) and the extra (centre 3,0).
    const owner = constituentOwnerAt(s, 1, 0);
    expect(owner?.index).toBe(0); // primary wins by index when no ledger
  });

  it('with a ledger, an earlier claim wins even if its constituent has a higher index', () => {
    const s = spec({
      extraEllipses: [{ major: 5, minor: 5, rotation: 0, offsetX: 3, offsetY: 0, biome: 'arctic' as Biome, originId: 'b' }],
      // extra (index 1) was placed BEFORE the primary's contested ring:
      ownershipLedger: [
        { constituent: 1, major: 5, minor: 5 },
        { constituent: 0, major: 5, minor: 5 },
      ],
    });
    const owner = constituentOwnerAt(s, 1, 0);
    expect(owner?.index).toBe(1); // already-placed (the extra) wins
  });

  it('self-heals: a ledger under-covering the union still owns every union tile', () => {
    const s = spec({
      majorRadius: 6, minorRadius: 6,
      // ledger claims a SMALLER radius than current (invariant violation):
      ownershipLedger: [{ constituent: 0, major: 3, minor: 3 }],
    });
    // tile (4,0) is in the current r6 footprint but outside the r3 claim.
    expect(constituentOwnerAt(s, 4, 0)?.index).toBe(0);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/world.test.ts -t "ownership ledger"`
Expected: FAIL — `constituentOwnerAt`/`islandImplicitLedger` not exported.

- [ ] **Step 3: Implement the type, field, and helpers**

In `src/world.ts`, add the field to `IslandSpec` right after `baseLayoutRadius?: number;` (line ~191, before the closing `}`):

```ts
  /** §3.6 placement-order ownership ledger. Append-only list of ownership
   *  CLAIMS in the order constituents were placed/grown: each entry says
   *  "constituent `c` inscribed the ring up to (major,minor) at this point in
   *  time." Resolves overlap precedence by placement TIME ("already-placed
   *  wins") so a growing constituent never overwrites a sibling's existing land.
   *  `constituent` indexes `islandConstituents(spec)` (0 = primary). ABSENT ⇒
   *  the implicit baseline (`islandImplicitLedger`): constituents in index order
   *  at current radii — identical to the pre-ledger "earliest-index wins" rule,
   *  so single-ellipse and never-grown merged islands store nothing and legacy
   *  saves behave unchanged. A constituent may appear multiple times (baseline +
   *  one per later growth); only CONSECUTIVE same-constituent claims coalesce.
   *  Invariant: the last claim per constituent equals its current radii. Rides
   *  the `serializeWorld` spread (SerializedIslandSpec omits only terrainAt). */
  ownershipLedger?: ReadonlyArray<OwnershipClaim>;
```

Add the `OwnershipClaim` interface just above `IslandSpec` (near line 100):

```ts
/** §3.6 one ownership claim in `IslandSpec.ownershipLedger`. `constituent`
 *  indexes `islandConstituents(spec)` (0 = primary, N = extraEllipses[N-1]);
 *  (major,minor) are that constituent's radii AT THE TIME of this claim. */
export interface OwnershipClaim {
  readonly constituent: number;
  readonly major: number;
  readonly minor: number;
}
```

Add the helpers right after `islandConstituents` (~line 227):

```ts
/** §3.6 the implicit ownership baseline: every constituent claimed at its
 *  CURRENT radii in index order. This is what an absent `ownershipLedger`
 *  means (legacy "earliest-index wins"). Pure. */
export function islandImplicitLedger(spec: IslandSpec): OwnershipClaim[] {
  return islandConstituents(spec).map((c, i) => ({
    constituent: i, major: c.major, minor: c.minor,
  }));
}

/** §3.6 the constituent that OWNS island-local tile (x, y) by placement order
 *  ("already-placed wins"), plus its index, or undefined when no constituent
 *  inscribes the tile. Walks `ownershipLedger` (first claim whose ellipse
 *  inscribes the tile wins); when the ledger is absent OR under-covers the
 *  current union, falls back to the current-radii index walk so a union tile is
 *  never left unowned. The owner's CURRENT radii (c.major/c.minor) — not the
 *  claim radii — drive terrain generation; only ownership is historical. Pure. */
export function constituentOwnerAt(
  spec: IslandSpec, x: number, y: number,
): { ellipse: ConstituentEllipse; index: number } | undefined {
  const constituents = islandConstituents(spec);
  const ledger = spec.ownershipLedger;
  if (ledger && ledger.length > 0) {
    for (const claim of ledger) {
      const c = constituents[claim.constituent];
      if (!c) continue; // defensive: stale index
      if (tileInscribedInEllipse(x - c.offsetX, y - c.offsetY, claim.major, claim.minor)) {
        return { ellipse: c, index: claim.constituent };
      }
    }
    // fall through: ledger under-covers the union (invariant violation) → self-heal
  }
  for (let i = 0; i < constituents.length; i++) {
    const c = constituents[i]!;
    if (tileInscribedInEllipse(x - c.offsetX, y - c.offsetY, c.major, c.minor)) {
      return { ellipse: c, index: i };
    }
  }
  return undefined;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/world.test.ts -t "ownership ledger"`
Expected: PASS (4 tests).

- [ ] **Step 5: Commit**

```bash
git add src/world.ts src/world.test.ts
git commit -m "feat(world): ownership ledger type + constituentOwnerAt resolver

Co-Authored-By: <model> <noreply@anthropic.com>"
```

---

### Task 2: Route terrain + biome ownership through the resolver

**Files:**
- Modify: `src/world.ts` — `constituentBiomeAt` (~line 234) and `attachTerrainAt`'s closure constituent loop (~line 294–313)
- Test: `src/world.test.ts` (extend the `describe('ownership ledger')` block)

**Interfaces:**
- Consumes: `constituentOwnerAt` (Task 1).
- Produces: behavior — `constituentBiomeAt` and `spec.terrainAt` now resolve contested tiles by ledger order.

- [ ] **Step 1: Write the failing test**

Append to `src/world.test.ts`:

```ts
import { attachTerrainAt, constituentBiomeAt } from './world.js';

describe('ownership ledger — terrain/biome sites', () => {
  it('constituentBiomeAt respects the ledger over index order', () => {
    const s = spec({
      extraEllipses: [{ major: 5, minor: 5, rotation: 0, offsetX: 3, offsetY: 0, biome: 'arctic' as Biome, originId: 'b' }],
      ownershipLedger: [
        { constituent: 1, major: 5, minor: 5 }, // arctic placed first
        { constituent: 0, major: 5, minor: 5 },
      ],
    });
    expect(constituentBiomeAt(s, 1, 0)).toBe('arctic'); // not the primary's 'plains'
  });

  it('attachTerrainAt uses the ledger owner biome on a contested tile', () => {
    const base = spec({
      extraEllipses: [{ major: 5, minor: 5, rotation: 0, offsetX: 3, offsetY: 0, biome: 'arctic' as Biome, originId: 'b' }],
      ownershipLedger: [
        { constituent: 1, major: 5, minor: 5 },
        { constituent: 0, major: 5, minor: 5 },
      ],
    });
    const withTerrain = attachTerrainAt(base);
    // Compare to a no-ledger control where the primary (plains) would win:
    const control = attachTerrainAt({ ...base, ownershipLedger: undefined });
    // The contested tile's terrain must differ when the arctic lobe owns it,
    // OR (if both biomes happen to yield the same kind there) at least the
    // biome resolver must report arctic:
    expect(constituentBiomeAt(base, 1, 0)).toBe('arctic');
    expect(constituentBiomeAt({ ...base, ownershipLedger: undefined }, 1, 0)).toBe('plains');
    void withTerrain; void control;
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/world.test.ts -t "terrain/biome sites"`
Expected: FAIL — `constituentBiomeAt` still returns `'plains'` (index order).

- [ ] **Step 3: Rewrite the two sites to delegate to `constituentOwnerAt`**

Replace `constituentBiomeAt` body (~line 234–239):

```ts
export function constituentBiomeAt(spec: IslandSpec, x: number, y: number): Biome | undefined {
  return constituentOwnerAt(spec, x, y)?.ellipse.biome;
}
```

In `attachTerrainAt`, replace the constituent loop (the `const constituents = islandConstituents(spec); for (let i ... ) { ... }` block, ~line 294–313) with:

```ts
    // §3.6 per-constituent terrain, resolved by placement order ("already-placed
    // wins") via the ownership ledger — a grown constituent never overwrites a
    // sibling's existing terrain. The OWNER's current radii drive the boundary
    // predicate; only ownership of a contested tile is historical.
    const owner = constituentOwnerAt(spec, x, y);
    if (owner) {
      const c = owner.ellipse;
      const lx = x - c.offsetX;
      const ly = y - c.offsetY;
      // §3.7 hand-placed base layout (home): only the PRIMARY (index 0) within
      // baseLayoutRadius uses the locked layout; absorbed lobes never do.
      if (owner.index === 0 && spec.baseLayoutRadius !== undefined &&
          tileInscribedInEllipse(lx, ly, spec.baseLayoutRadius, spec.baseLayoutRadius)) {
        return defaultTerrainAt(lx, ly);
      }
      return terrainAtForBiome(c.biome, c.originId, lx, ly, (px, py) =>
        tileInscribedInEllipse(px, py, c.major, c.minor),
      );
    }
```

(Leave the existing "not inscribed in any constituent" final fallback `return terrainAtForBiome(spec.biome, spec.id, x, y, …)` untouched.)

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run src/world.test.ts`
Expected: PASS (all ownership-ledger tests).
Run: `npx vitest run src/biomes.test.ts` (verifies the by-reference invariant + per-constituent terrain still hold).
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/world.ts src/world.test.ts
git commit -m "feat(world): resolve terrain + biome ownership via the ledger

Co-Authored-By: <model> <noreply@anthropic.com>"
```

---

### Task 3: Record growth claims in `expandConstituent` (fixes the reported bug)

**Files:**
- Modify: `src/world.ts` — add `recordGrowthClaim` helper near the other ledger helpers
- Modify: `src/land-reclamation.ts` — call it at the end of `expandConstituent` (~line 254–269)
- Test: `src/land-reclamation.test.ts` (add a `describe('no-overwrite ledger')` block)

**Interfaces:**
- Consumes: `islandImplicitLedger`, `OwnershipClaim` (Task 1); `constituentBiomeAt` (Task 2).
- Produces: `recordGrowthClaim(spec: IslandSpec, index: number, major: number, minor: number): void` — mutates `spec.ownershipLedger` (materialize baseline if absent, then append `{constituent:index,major,minor}`, coalescing only if the last entry is the same constituent).

- [ ] **Step 1: Write the failing test**

In `src/land-reclamation.test.ts`:

```ts
import { constituentBiomeAt, type IslandSpec, type Biome } from './world.js';

describe('no-overwrite ledger', () => {
  // Merged island: plains primary (r5 @ 0,0) + adjacent arctic lobe (r5 @ 11,0),
  // footprints just touching. A land_reclamation_hub enables growth.
  function merged(): IslandSpec {
    return makeSpec({
      biome: 'plains' as Biome, majorRadius: 5, minorRadius: 5,
      buildings: [{ id: 'h', defId: 'land_reclamation_hub', x: 0, y: 0, rotation: 0 } as PlacedBuilding],
      extraEllipses: [{ major: 5, minor: 5, rotation: 0, offsetX: 11, offsetY: 0, biome: 'arctic' as Biome, originId: 'lobe' }],
    });
  }

  it('growing the primary toward the lobe does NOT overwrite the lobe biome', () => {
    const s = merged();
    const st: IslandState = { /* see makeState helper below */ } as IslandState;
    const beforeOwner = constituentBiomeAt(s, 6, 0); // arctic lobe near tile (6,0)? choose a tile owned by the lobe
    // Grow primary major repeatedly so its ring reaches the lobe's tiles.
    for (let i = 0; i < 4; i++) expandConstituent(s, st, 0, 'major');
    // A tile that the lobe already owned must STILL report the lobe's biome.
    expect(constituentBiomeAt(s, 6, 0)).toBe(beforeOwner);
    expect(constituentBiomeAt(s, 6, 0)).toBe('arctic');
  });

  it('expandConstituent materializes a baseline then appends a coalescing claim', () => {
    const s = merged();
    const st = makeState();
    expandConstituent(s, st, 0, 'major'); // 1st growth → baseline [0,1] + claim {0,..}
    const len1 = s.ownershipLedger!.length;
    expandConstituent(s, st, 0, 'minor'); // consecutive same constituent → coalesce
    expect(s.ownershipLedger!.length).toBe(len1); // coalesced, no new entry
    // last claim equals current primary radii (invariant):
    const last = s.ownershipLedger![s.ownershipLedger!.length - 1]!;
    expect(last).toEqual({ constituent: 0, major: s.majorRadius, minor: s.minorRadius });
  });
});
```

Add a `makeState()` fixture in the test file (mirrors the existing inventory fixtures — give plenty of resources so growth isn't resource-gated):

```ts
function makeState(): IslandState {
  return {
    id: 'fixture', inventory: emptyCaps(), funnel: emptyFunnel(),
    storageCaps: emptyCaps(), xp: 0, level: 1, lastTick: 0,
    // ...match the IslandState shape used by other tests in this file
  } as IslandState;
}
```

(Use the exact `IslandState` fields the file's other tests construct; `emptyCaps()` for inventory guarantees affordability. Pick the assertion tile `(6,0)` by computing one inscribed in the lobe but reachable by the grown primary — adjust the constant if the geometry differs, the invariant is "a pre-owned lobe tile keeps the lobe biome after the primary grows over it.")

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/land-reclamation.test.ts -t "no-overwrite ledger"`
Expected: FAIL — after growth `constituentBiomeAt(s,6,0)` returns `'plains'` (primary overwrote the lobe).

- [ ] **Step 3: Implement `recordGrowthClaim` and wire it in**

In `src/world.ts`, after `islandImplicitLedger`:

```ts
/** §3.6 record a Land Reclamation growth of constituent `index` to (major,minor)
 *  in the ownership ledger. Materializes the implicit baseline first when the
 *  ledger is absent (so the pre-growth footprint keeps its existing ownership),
 *  then appends the new claim — coalescing only when the LAST entry is the same
 *  constituent (a run of growths on one constituent is one logical claim).
 *  Mutates `spec.ownershipLedger`. Pure w.r.t. everything else. */
export function recordGrowthClaim(
  spec: IslandSpec, index: number, major: number, minor: number,
): void {
  const ledger: OwnershipClaim[] = spec.ownershipLedger
    ? [...spec.ownershipLedger]
    : islandImplicitLedger(spec);
  const last = ledger[ledger.length - 1];
  if (last && last.constituent === index) {
    ledger[ledger.length - 1] = { constituent: index, major, minor };
  } else {
    ledger.push({ constituent: index, major, minor });
  }
  spec.ownershipLedger = ledger;
}
```

In `src/land-reclamation.ts`: import `recordGrowthClaim` from `./world.js` (extend the existing `world.js` import at line 26), and at the END of `expandConstituent` (after the `if (index === 0) { … } else { … }` radius mutation, before the closing brace) add:

```ts
  // §3.6 record the post-growth radii as a placement-order ownership claim so
  // the grown ring yields to any constituent that already holds those tiles.
  const grownMajor = index === 0 ? spec.majorRadius : spec.extraEllipses![index - 1]!.major;
  const grownMinor = index === 0 ? spec.minorRadius : spec.extraEllipses![index - 1]!.minor;
  recordGrowthClaim(spec, index, grownMajor, grownMinor);
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run src/land-reclamation.test.ts`
Expected: PASS (existing tests + the new `no-overwrite ledger` block).

- [ ] **Step 5: Commit**

```bash
git add src/world.ts src/land-reclamation.ts src/land-reclamation.test.ts
git commit -m "feat(reclamation): record growth claims so growth yields, not overwrites

Co-Authored-By: <model> <noreply@anthropic.com>"
```

---

### Task 4: Carry the ledger through `performMerge`

**Files:**
- Modify: `src/world.ts` — add `appendAbsorbedLedger` helper
- Modify: `src/island-merge.ts` — call it inside `performMerge` after the extraEllipses append (~after line 163)
- Test: `src/island-merge.test.ts` (add a `describe('merge ownership ledger')` block)

**Interfaces:**
- Consumes: `islandImplicitLedger`, `OwnershipClaim` (Task 1).
- Produces: `appendAbsorbedLedger(absorber: IslandSpec, absorbed: IslandSpec, baseIndex: number): void` — when either side has a ledger, ensures the absorber has one (materialize its baseline if absent) and appends the absorbed island's claims (its own ledger, else its implicit baseline) with `constituent` remapped by `+baseIndex`; no-op when neither side has a ledger.

- [ ] **Step 1: Write the failing test**

In `src/island-merge.test.ts`:

```ts
import { islandImplicitLedger, type IslandSpec } from './world.js';

describe('merge ownership ledger', () => {
  it('merging two never-grown islands leaves the ledger absent', () => {
    const { world, states, a, b } = twoTouchingIslands(); // existing test helper / inline
    chooseMergeAbsorber(a, b, states); // absorber = larger
    performMerge(world, states, /*absorber*/ a, /*absorbed*/ b);
    expect(a.ownershipLedger).toBeUndefined();
  });

  it('merging when the absorbed island has a ledger appends remapped claims', () => {
    const { world, states, a, b } = twoTouchingIslands();
    // b was grown before being absorbed → it carries a ledger of its own.
    b.ownershipLedger = [{ constituent: 0, major: b.majorRadius, minor: b.minorRadius }];
    const preConstituents = 1 + (a.extraEllipses?.length ?? 0); // a's constituent count
    performMerge(world, states, a, b);
    // a now has a ledger; b's constituent 0 maps to a's index = preConstituents.
    expect(a.ownershipLedger).toBeDefined();
    const last = a.ownershipLedger![a.ownershipLedger!.length - 1]!;
    expect(last.constituent).toBe(preConstituents);
  });
});
```

(Reuse the file's existing island/world construction helpers — search the file for how it builds `a`, `b`, `world`, `states` and `chooseMergeAbsorber`/`performMerge` are already imported there. If no `twoTouchingIslands` helper exists, inline two `makeSpec`-style islands positioned so `islandsOverlap(a,b)` is true.)

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/island-merge.test.ts -t "merge ownership ledger"`
Expected: FAIL — `a.ownershipLedger` stays undefined in the second case.

- [ ] **Step 3: Implement `appendAbsorbedLedger` and call it**

In `src/world.ts`, after `recordGrowthClaim`:

```ts
/** §3.6 merge maintenance: fold `absorbed`'s ownership claims into `absorber`'s
 *  ledger. `baseIndex` is the absorber constituent index the absorbed PRIMARY
 *  landed at (= absorber's constituent count before the absorbed constituents
 *  were appended). No-op when neither island has a ledger (the merged spec's
 *  implicit baseline is already correct — merge introduces no overlap). When
 *  either has one, the absorber gets a materialized baseline if needed, then
 *  the absorbed claims (its ledger, else its implicit baseline) are appended
 *  with `constituent` shifted by `+baseIndex`. Mutates `absorber.ownershipLedger`. */
export function appendAbsorbedLedger(
  absorber: IslandSpec, absorbed: IslandSpec, baseIndex: number,
): void {
  if (!absorber.ownershipLedger && !absorbed.ownershipLedger) return;
  const ledger: OwnershipClaim[] = absorber.ownershipLedger
    ? [...absorber.ownershipLedger]
    : islandImplicitLedger(absorber).filter((c) => c.constituent < baseIndex);
  const absorbedClaims = absorbed.ownershipLedger
    ? absorbed.ownershipLedger
    : islandImplicitLedger(absorbed);
  for (const claim of absorbedClaims) {
    ledger.push({ constituent: claim.constituent + baseIndex, major: claim.major, minor: claim.minor });
  }
  absorber.ownershipLedger = ledger;
}
```

Note: `islandImplicitLedger(absorber)` is computed AFTER the absorbed constituents were appended to `extraEllipses`, so it must be filtered to `constituent < baseIndex` to capture only the absorber's own pre-merge constituents. (Call `appendAbsorbedLedger` AFTER the extraEllipses append; `baseIndex` is the count captured BEFORE.)

In `src/island-merge.ts`: import `appendAbsorbedLedger` from `./world.js`. Capture the base index BEFORE the extraEllipses append (top of step 1, ~line 132):

```ts
  // §3.6 ownership-ledger maintenance: the absorbed primary lands at this
  // absorber constituent index (1 primary + current extras).
  const ledgerBaseIndex = 1 + (absorber.extraEllipses?.length ?? 0);
```

Then AFTER the absorbed extras loop (after line 163, before `// 2. Shift absorbed's buildings`):

```ts
  appendAbsorbedLedger(absorber, absorbed, ledgerBaseIndex);
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run src/island-merge.test.ts`
Expected: PASS (existing merge tests + the new block).

- [ ] **Step 5: Commit**

```bash
git add src/world.ts src/island-merge.ts src/island-merge.test.ts
git commit -m "feat(merge): fold absorbed ownership claims into the absorber ledger

Co-Authored-By: <model> <noreply@anthropic.com>"
```

---

### Task 5: Grown-vs-grown end-to-end test, SPEC + comment updates, full build, oracle re-baseline

**Files:**
- Test: `src/land-reclamation.test.ts` (add the grown-vs-grown scenario)
- Modify: `SPEC.md` (§3.6 line ~466, §3.4 line ~420)
- Modify: stale comments — `src/island.ts` `computeIslandTiles` doc (~line 200–210), any remaining "earliest constituent wins" wording in `src/world.ts`
- Verify: `cd server && npx tsc --noEmit`; root `npm test` (needs Postgres); server bench oracle if it trips

**Interfaces:** none new — integration + docs.

- [ ] **Step 1: Write the grown-vs-grown end-to-end test**

In `src/land-reclamation.test.ts`, inside `describe('no-overwrite ledger')`:

```ts
it('grown-vs-grown: a later primary growth does not eat the lobe\'s earlier reclaimed ring', () => {
  const s = merged();
  // give the lobe a hub-equivalent path: both constituents are growable.
  const st = makeState();
  // 1) grow the LOBE (index 1) toward the primary first — its new ring is placed now.
  expandConstituent(s, st, 1, 'major');
  expandConstituent(s, st, 1, 'major');
  // pick a tile the lobe JUST reclaimed (in its grown ring, between the two centres):
  const reclaimedByLobe = constituentBiomeAt(s, /*x*/ 7, /*y*/ 0);
  expect(reclaimedByLobe).toBe('arctic');
  // 2) now grow the PRIMARY (index 0) over that same region.
  for (let i = 0; i < 4; i++) expandConstituent(s, st, 0, 'major');
  // The lobe's earlier-reclaimed tile must STILL be the lobe's (already-placed wins).
  expect(constituentBiomeAt(s, 7, 0)).toBe('arctic');
});
```

(Adjust the `(7,0)` constant to a tile that is in the lobe's grown ring after step 1 and inside the primary's footprint after step 2 — the assertion is the invariant, not the literal coordinate.)

- [ ] **Step 2: Run it to verify it fails on a pre-fix mental model / passes with the ledger**

Run: `npx vitest run src/land-reclamation.test.ts -t "grown-vs-grown"`
Expected: PASS (the ledger orders the lobe's growth before the primary's later growth). If it FAILS, the coalescing/ordering is wrong — debug before continuing.

- [ ] **Step 3: Update SPEC.md (code and spec move together)**

`SPEC.md` §3.6 — replace the "Overlap precedence" sentence at line ~466:

> **Overlap precedence:** a tile inscribed in more than one constituent is owned by the constituent that inscribed it **first in placement order**, recorded in `IslandSpec.ownershipLedger` (an append-only list of `{constituent, major, minor}` claims; absent ⇒ the implicit baseline of constituents in index order at current radii ≡ the legacy earliest-index rule). Land Reclamation **appends** a claim, so a growing constituent **never overwrites** a sibling's already-placed land — it gains only genuinely-new ocean tiles (matching the §3.4 union-delta cost). Terrain/biome are resolved by `constituentOwnerAt` (the ledger walk) in `attachTerrainAt` / `constituentBiomeAt`, independent of the `computeIslandTiles` dedup order (which only decides union membership). `tileOverrides` (§8) still win over all biome generation.

`SPEC.md` §3.4 — append to the line-420 paragraph:

> The union-delta cost (tiles already covered by another constituent are not charged) is exactly the no-overwrite contract: the grower is charged for, and gains, only the new ocean tiles; tiles a sibling already holds stay the sibling's (§3.6 ownership ledger).

- [ ] **Step 4: Update stale code comments**

- `src/island.ts` `computeIslandTiles` doc (~line 206–209): change "the primary's terrain wins for shared tiles (the primary is scanned first)" to note that **dedup decides union membership only; terrain for a shared tile comes from `terrainAt`/`constituentOwnerAt` by placement order (§3.6 ownership ledger), not scan order.**
- `src/world.ts`: remove/relabel any remaining "EARLIEST constituent (primary, then merge order)" wording on `constituentBiomeAt` (now delegates to `constituentOwnerAt`).

- [ ] **Step 5: Full typecheck + build + tests**

```bash
cd /root/robot-islands && npx tsc -b && cd server && npx tsc --noEmit && cd ..
npm test     # client + server projects; requires Postgres on DATABASE_URL=postgresql:///robot_islands_test
```
Expected: typecheck clean; all suites green.

- [ ] **Step 6: Re-baseline the server bench oracle IF it trips**

Only if `npm test`/the bench reports the `catchUp` SHA-256 oracle digest changed: that is expected for saves with overlapping grown constituents (terrain → economy). Re-baseline the oracle digest per `server/bench/` (catchup-bench.mts) and note the change in the commit message as an intended behavior change, not a regression. If the digest is unchanged, skip.

- [ ] **Step 7: Commit**

```bash
git add SPEC.md src/island.ts src/world.ts src/land-reclamation.test.ts
git commit -m "docs(spec): land-reclamation already-placed-wins ledger (§3.6/§3.4) + comments

Co-Authored-By: <model> <noreply@anthropic.com>"
```

---

## Self-Review

**Spec coverage:**
- Data model (`OwnershipClaim` + `ownershipLedger`) → Task 1. ✓
- Implicit baseline / absent semantics → Task 1 (`islandImplicitLedger`, resolver fallback). ✓
- Shared resolver + two ownership sites → Tasks 1–2. ✓
- `computeIslandTiles` unchanged (verified, comment updated) → Task 5. ✓
- `expandConstituent` maintenance + coalescing + invariant → Task 3. ✓
- `performMerge` maintenance + remap + recursive + never-grown-absent → Task 4. ✓
- Persistence: no schema bump, rides `Omit` → covered by NOT touching persistence.ts (called out in header). ✓
- Behavior-change/oracle caveat → Task 5 Step 6. ✓
- SPEC §3.6/§3.4 edits → Task 5. ✓
- Test plan items 1–6 from the spec → Tasks 1–5. ✓

**Placeholder scan:** Test coordinate constants (`(6,0)`, `(7,0)`) are flagged as "adjust to geometry; the invariant is the assertion" — acceptable because the geometry depends on exact radii the implementer sets; every such note states the invariant explicitly. No TBD/TODO/"handle edge cases".

**Type consistency:** `OwnershipClaim {constituent,major,minor}` used identically in `islandImplicitLedger`, `constituentOwnerAt`, `recordGrowthClaim`, `appendAbsorbedLedger`. `constituentOwnerAt` returns `{ellipse,index}` consumed by `attachTerrainAt` (uses `.ellipse`/`.index`) and `constituentBiomeAt` (uses `.ellipse.biome`). Consistent.
