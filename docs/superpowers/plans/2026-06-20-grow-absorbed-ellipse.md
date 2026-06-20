# Grow Absorbed Ellipses via Land Reclamation — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let the player grow any constituent ellipse of a merged island (not just the primary) via the Land Reclamation Hub, choosing the lobe through a scrollable per-constituent picker, with each lobe capped by its own origin biome.

**Architecture:** Add a cap-only `biome` field to each `extraEllipses` entry (stamped at merge time, defaulted for legacy saves by a v27→v28 migration). Generalize the three `land-reclamation.ts` functions to be **constituent-indexed** (index 0 = primary, index N = `extraEllipses[N-1]`). Thread a `constituentIndex` through the `expand-island` gateway method + server intent (server re-validates with the same pure functions). Rebuild the inspector's Reclamation section as a scrollable row-per-constituent list, and add a render-layer overlay drawing numbered badges on the map.

**Tech Stack:** TypeScript strict (client `src/` + server `server/`), PixiJS 8 (render only), vitest, Postgres (server tests). Design source: `docs/superpowers/specs/2026-06-20-grow-absorbed-ellipse-design.html`.

## Global Constraints

- **TypeScript strict** with `noUncheckedIndexedAccess`, `noUnusedLocals`, `noUnusedParameters`. New code compiles clean; use the `inv()`/`cap()` helpers and `?? 0` idioms already in the codebase for indexed reads.
- **Pure layer has NO PixiJS / DOM imports.** `world.ts`, `land-reclamation.ts`, `island-merge.ts`, `persistence.ts`, `mutation-gateway.ts` stay pure. Only `inspector-ui.ts` and the new `lobe-badge-overlay.ts` touch DOM/Pixi.
- **Spec moves with code (AGENTS.md):** every behavior change updates the relevant SPEC.md § in the same task — §15.1 (data model), §3.6 (merge), §3.4 (reclamation).
- **Persistence: bump = migrate.** Follow the `src/persistence.ts` migrate-chain checklist exactly: `SerializedSnapshotV27` alias, `migrateV27toV28`, wire into `loadWorld` dispatch, add `28` to `SUPPORTED_LOAD_VERSIONS`.
- **Terrain stays absorber-biome.** The new `extraEllipses.biome` is **cap-only** — do NOT route terrain generation through it (§3.6 note is unchanged).
- **Tests target the pure layer only.** Render layer (inspector rows, badge overlay) is verified by `npm run build` + a browser screenshot via `mcp__daedalus__screenshot`, not unit tests.
- **Run single test file:** `npx vitest run src/<file>.test.ts`. Full typecheck: `npx tsc -b --force` from repo root; server-only: `cd server && npm run typecheck`.
- **Integration track:** feature branch off `master`, reviewed via PR, rebased + fast-forwarded (linear history). Commit after every passing step.

---

### Task 1: Per-constituent `biome` field + `islandConstituents`

Adds the cap-only origin-biome field to the data model and surfaces it on the constituent view. Foundational — every later task depends on it.

**Files:**
- Modify: `src/world.ts` (the `extraEllipses` type in `IslandSpec` ~line 157; `ConstituentEllipse` ~line 177; `islandConstituents` ~line 188)
- Modify: `SPEC.md` (§15.1 data-model note for `extraEllipses`)
- Test: `src/world.test.ts`

**Interfaces:**
- Consumes: nothing (first task).
- Produces:
  - `IslandSpec.extraEllipses` entries gain `readonly biome: BiomeType`.
  - `ConstituentEllipse` gains `readonly biome: BiomeType`.
  - `islandConstituents(spec)` populates `biome`: primary = `spec.biome`; each extra = `entry.biome ?? spec.biome`.

- [ ] **Step 1: Write the failing test**

```typescript
// src/world.test.ts — add
import { islandConstituents } from './world.js';
import { makeTestSpec } from './world.js'; // if no factory exists, build a minimal spec inline

test('islandConstituents carries biome: primary from spec, extras from entry', () => {
  const spec = {
    id: 'i1', biome: 'plains' as const,
    majorRadius: 10, minorRadius: 8, cx: 0, cy: 0,
    buildings: [],
    extraEllipses: [
      { biome: 'volcanic' as const, major: 6, minor: 6, rotation: 0, offsetX: 12, offsetY: 0 },
      // legacy-shaped entry missing biome (cast to exercise the ?? fallback)
      { major: 5, minor: 5, rotation: 0, offsetX: -12, offsetY: 0 } as unknown as never,
    ],
  } as unknown as Parameters<typeof islandConstituents>[0];

  const cs = islandConstituents(spec);
  expect(cs).toHaveLength(3);
  expect(cs[0]!.biome).toBe('plains');     // primary
  expect(cs[1]!.biome).toBe('volcanic');   // explicit extra biome
  expect(cs[2]!.biome).toBe('plains');     // legacy extra falls back to spec.biome
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/world.test.ts -t "islandConstituents carries biome"`
Expected: FAIL — `cs[0].biome` is `undefined` (field not yet populated).

- [ ] **Step 3: Add the type field**

In `src/world.ts`, the `extraEllipses` array element type (inside `IslandSpec`):

```typescript
  extraEllipses?: Array<{
    /** §3.4 cap-only origin biome of this absorbed constituent. Derives the
     *  per-lobe Land Reclamation cap (BIOME_MAX_RADII[biome]). Terrain is NOT
     *  routed through this — tiles still query the absorber's biome (§3.6).
     *  Optional in input shape only: legacy saves lack it (migrated v27→v28);
     *  readers default via `?? spec.biome`. */
    readonly biome: BiomeType;
    readonly major: number;
    readonly minor: number;
    readonly rotation: number;
    readonly offsetX: number;
    readonly offsetY: number;
  }>;
```

And add `biome` to `ConstituentEllipse`:

```typescript
export interface ConstituentEllipse {
  readonly biome: BiomeType;
  readonly major: number;
  readonly minor: number;
  readonly rotation: number;
  readonly offsetX: number;
  readonly offsetY: number;
}
```

(Confirm `BiomeType` is imported/defined in `world.ts`; it is the biome union used by `spec.biome`.)

- [ ] **Step 4: Populate biome in `islandConstituents`**

```typescript
export function islandConstituents(spec: IslandSpec): ConstituentEllipse[] {
  const out: ConstituentEllipse[] = [
    { biome: spec.biome, major: spec.majorRadius, minor: spec.minorRadius,
      rotation: 0, offsetX: 0, offsetY: 0 },
  ];
  if (spec.extraEllipses) {
    for (const e of spec.extraEllipses) {
      out.push({ ...e, biome: e.biome ?? spec.biome });
    }
  }
  return out;
}
```

- [ ] **Step 5: Run test to verify it passes**

Run: `npx vitest run src/world.test.ts -t "islandConstituents carries biome"`
Expected: PASS.

- [ ] **Step 6: Typecheck the whole client**

Run: `npx tsc -b --force`
Expected: errors ONLY where a spec literal constructs `extraEllipses` without `biome` (merge code + fixtures). Note them — Task 2 fixes the merge site; fixtures get `biome` added as encountered. If a fixture blocks the build, add `biome: <its spec biome>` to that literal now.

- [ ] **Step 7: Update SPEC.md §15.1**

In the `extraEllipses` / `size.ellipses` note, add: *"Each constituent records a cap-only `biome` (origin biome of the absorbed island) that derives its Land Reclamation cap; terrain still queries the absorber's biome per §3.6."*

- [ ] **Step 8: Commit**

```bash
git add src/world.ts src/world.test.ts SPEC.md
git commit -m "feat(world): cap-only biome on extraEllipses + ConstituentEllipse

Co-Authored-By: <model> <noreply@anthropic.com>"
```

---

### Task 2: Merge stamps origin biome

`performMerge` records each appended constituent's origin biome so caps survive merges (including recursive ones).

**Files:**
- Modify: `src/island-merge.ts` (`performMerge` step 1, ~lines 131–155)
- Modify: `SPEC.md` (§3.6 — appended constituents record origin biome)
- Test: `src/island-merge.test.ts`

**Interfaces:**
- Consumes: `IslandSpec.extraEllipses[].biome` (Task 1).
- Produces: after `performMerge`, every appended extra carries `biome` — absorbed primary→extra = `absorbed.biome`; propagated extras keep `e.biome ?? absorbed.biome`.

- [ ] **Step 1: Write the failing test**

```typescript
// src/island-merge.test.ts — add
test('performMerge stamps origin biome on appended + propagated extras', () => {
  // B (volcanic) already merged a C (arctic) lobe; A (plains) absorbs B.
  // Build A, B specs + states overlapping; A is the larger absorber.
  const { world, states, A, B } = makeMergeFixtureWithPriorLobe(); // helper per existing test style
  performMerge(world, states, A, B);

  const extras = A.extraEllipses!;
  // B's primary became an extra → volcanic
  expect(extras.some(e => e.biome === 'volcanic')).toBe(true);
  // B's prior arctic lobe propagated → arctic preserved
  expect(extras.some(e => e.biome === 'arctic')).toBe(true);
  // none undefined
  expect(extras.every(e => e.biome !== undefined)).toBe(true);
});
```

(If no `makeMergeFixtureWithPriorLobe` exists, construct the two specs inline mirroring the existing `island-merge.test.ts` fixtures, giving `B.extraEllipses = [{ biome: 'arctic', major, minor, rotation: 0, offsetX, offsetY }]`.)

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/island-merge.test.ts -t "stamps origin biome"`
Expected: FAIL — appended extras have `biome === undefined`.

- [ ] **Step 3: Stamp biome in `performMerge` step 1**

```typescript
  absorber.extraEllipses.push({
    biome: absorbed.biome,                 // NEW
    major: absorbed.majorRadius,
    minor: absorbed.minorRadius,
    rotation: 0,
    offsetX,
    offsetY,
  });
  if (absorbed.extraEllipses) {
    for (const e of absorbed.extraEllipses) {
      absorber.extraEllipses.push({
        biome: e.biome ?? absorbed.biome,  // NEW — preserve origin, fall back
        major: e.major,
        minor: e.minor,
        rotation: e.rotation,
        offsetX: e.offsetX + offsetX,
        offsetY: e.offsetY + offsetY,
      });
    }
  }
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/island-merge.test.ts -t "stamps origin biome"`
Expected: PASS.

- [ ] **Step 5: Run the full merge suite (no regressions)**

Run: `npx vitest run src/island-merge.test.ts`
Expected: all PASS.

- [ ] **Step 6: Update SPEC.md §3.6**

Add to the join rules: *"Each appended constituent records the origin biome of the absorbed island (recursively-propagated extras keep their own). This biome caps that lobe's Land Reclamation (§3.4) but does NOT change terrain — tiles still query the absorber's biome."*

- [ ] **Step 7: Commit**

```bash
git add src/island-merge.ts src/island-merge.test.ts SPEC.md
git commit -m "feat(merge): record origin biome on appended constituents

Co-Authored-By: <model> <noreply@anthropic.com>"
```

---

### Task 3: Constituent-indexed reclamation cost

Generalize `landReclamationCost` to charge the union delta of growing any constituent, keyed by index. Index 0 reproduces the current primary cost exactly.

**Files:**
- Modify: `src/land-reclamation.ts` (`landReclamationCost`, ~lines 65–101)
- Test: `src/land-reclamation.test.ts`

**Interfaces:**
- Consumes: `islandConstituents` / `islandInscribedAny` (existing), `LAND_TILE_COST`.
- Produces: `landReclamationCost(spec: IslandSpec, index: number, axis: Axis): LandReclamationCost` — replaces the old `(major, minor, axis, extraEllipses?)` signature. `index 0` grows the primary; `index N>0` grows `extraEllipses[N-1]`. Charges only tiles newly inscribed in the union.

- [ ] **Step 1: Write the failing tests**

```typescript
// src/land-reclamation.test.ts — add
import { landReclamationCost } from './land-reclamation.js';
import { LAND_TILE_COST } from './building-defs.js';

test('cost index 0 grows primary (matches legacy primary delta)', () => {
  const spec = singleEllipseSpec({ biome: 'plains', major: 10, minor: 8 });
  const cost = landReclamationCost(spec, 0, 'major');
  // delta > 0 and proportional to LAND_TILE_COST
  const stone = Object.keys(LAND_TILE_COST)[0]! as keyof typeof LAND_TILE_COST;
  expect(cost[stone]! % LAND_TILE_COST[stone]!).toBe(0);
  expect(cost[stone]!).toBeGreaterThan(0);
});

test('cost for an absorbed lobe charges only NEW union tiles', () => {
  // Primary plains r10 at (0,0); absorbed lobe r6 at offset (12,0) partly
  // overlapping the primary. Growing the lobe toward the primary adds fewer
  // new tiles than its full ring (overlap already counted).
  const spec = mergedSpec({
    primary: { biome: 'plains', major: 10, minor: 10 },
    extras: [{ biome: 'volcanic', major: 6, minor: 6, offsetX: 12, offsetY: 0 }],
  });
  const costLobe = landReclamationCost(spec, 1, 'major'); // grow the lobe
  const stone = Object.keys(LAND_TILE_COST)[0]! as keyof typeof LAND_TILE_COST;
  // Strictly less than an isolated r6→r7 ring would cost (some tiles already
  // inside the primary union).
  const isolated = landReclamationCost(
    singleEllipseSpec({ biome: 'volcanic', major: 6, minor: 6 }), 0, 'major');
  expect(costLobe[stone]!).toBeLessThan(isolated[stone]!);
  expect(costLobe[stone]!).toBeGreaterThan(0);
});
```

(`singleEllipseSpec` / `mergedSpec` are small local builders — add them at the top of the test file if absent; `mergedSpec` sets `majorRadius/minorRadius` from `primary` and `extraEllipses` from `extras`.)

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run src/land-reclamation.test.ts -t "cost"`
Expected: FAIL — signature mismatch / `landReclamationCost(spec, index, axis)` not defined.

- [ ] **Step 3: Rewrite `landReclamationCost` constituent-indexed**

```typescript
/** §3.4 cost of one +1 expansion on `axis` of constituent `index`
 *  (0 = primary, N = extraEllipses[N-1]). The delta is the number of tiles
 *  newly inscribed in the island UNION after growing that one constituent —
 *  tiles already covered by any other constituent are not re-charged. Pure. */
export function landReclamationCost(
  spec: IslandSpec,
  index: number,
  axis: Axis,
): LandReclamationCost {
  const oldShape = {
    majorRadius: spec.majorRadius,
    minorRadius: spec.minorRadius,
    extraEllipses: spec.extraEllipses,
  };
  // Build newShape by growing the chosen constituent by +1 on `axis`.
  let newShape: typeof oldShape;
  let cx = 0, cy = 0, newMajor: number, newMinor: number;
  if (index === 0) {
    newMajor = axis === 'major' ? spec.majorRadius + 1 : spec.majorRadius;
    newMinor = axis === 'minor' ? spec.minorRadius + 1 : spec.minorRadius;
    newShape = { majorRadius: newMajor, minorRadius: newMinor, extraEllipses: spec.extraEllipses };
  } else {
    const extras = spec.extraEllipses ?? [];
    const e = extras[index - 1];
    if (!e) return {}; // out-of-range → no charge (gate rejects separately)
    newMajor = axis === 'major' ? e.major + 1 : e.major;
    newMinor = axis === 'minor' ? e.minor + 1 : e.minor;
    cx = e.offsetX; cy = e.offsetY;
    const grown = extras.map((x, i) =>
      i === index - 1 ? { ...x, major: newMajor, minor: newMinor } : x);
    newShape = { majorRadius: spec.majorRadius, minorRadius: spec.minorRadius, extraEllipses: grown };
  }
  // Scan the grown constituent's new bbox (centered at cx,cy). All newly
  // inscribed tiles live here because only this constituent changed.
  const xMin = Math.floor(cx - newMajor), xMax = Math.ceil(cx + newMajor);
  const yMin = Math.floor(cy - newMinor), yMax = Math.ceil(cy + newMinor);
  let delta = 0;
  for (let y = yMin; y <= yMax; y++) {
    for (let x = xMin; x <= xMax; x++) {
      if (!islandInscribedAny(oldShape, x, y) && islandInscribedAny(newShape, x, y)) delta++;
    }
  }
  const out: LandReclamationCost = {};
  for (const [r, n] of Object.entries(LAND_TILE_COST) as Array<[ResourceId, number]>) {
    out[r] = delta * n;
  }
  return out;
}
```

(Delete the now-unused `inscribedTileCount` else-branch logic only if nothing else references `inscribedTileCount`; run `findReferences` first. Keep the exported `inscribedTileCount` if other modules/tests use it.)

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run src/land-reclamation.test.ts -t "cost"`
Expected: PASS.

- [ ] **Step 5: Typecheck**

Run: `npx tsc -b --force`
Expected: errors at the old `landReclamationCost(major, minor, axis, extra)` call sites (inspector-ui, internal `canExpandIsland`/`expandIsland`). These are fixed in Tasks 4 and 7 — note them; do not fix inspector yet.

- [ ] **Step 6: Commit**

```bash
git add src/land-reclamation.ts src/land-reclamation.test.ts
git commit -m "feat(reclamation): constituent-indexed cost (union delta per lobe)

Co-Authored-By: <model> <noreply@anthropic.com>"
```

---

### Task 4: Constituent-indexed gate + mutation + §3.4

Generalize the gate and the mutation to any constituent, with per-lobe origin-biome caps.

**Files:**
- Modify: `src/land-reclamation.ts` (`ExpandResult`, `canExpandIsland`→`canExpandConstituent`, `expandIsland`→`expandConstituent`)
- Modify: `SPEC.md` (§3.4 — grow any constituent, per-lobe origin-biome cap)
- Test: `src/land-reclamation.test.ts`

**Interfaces:**
- Consumes: `landReclamationCost(spec, index, axis)` (Task 3); `BIOME_MAX_RADII`; `inv`.
- Produces:
  - `ExpandResult` reason union gains `'bad-constituent'`.
  - `canExpandConstituent(spec, state, index, axis): ExpandResult`.
  - `expandConstituent(spec, state, index, axis): void`.
  - (Optional compatibility wrappers `canExpandIsland`/`expandIsland` = constituent 0 — keep ONLY if cheaper than migrating callers; this plan migrates callers, so remove the old names.)

- [ ] **Step 1: Write the failing tests**

```typescript
// src/land-reclamation.test.ts — add
import { canExpandConstituent, expandConstituent } from './land-reclamation.js';

test('lobe capped at its OWN origin biome, not the absorber', () => {
  // Plains primary (cap 28) + Volcanic lobe (cap 14) already at minor 14.
  const spec = mergedSpec({
    primary: { biome: 'plains', major: 20, minor: 20 },
    extras: [{ biome: 'volcanic', major: 8, minor: 14, offsetX: 26, offsetY: 0 }],
  });
  const st = stateWithPlentyOfResources(spec.id);
  expect(canExpandConstituent(spec, st, 1, 'minor')).toEqual({ ok: false, reason: 'axis-at-max' });
  expect(canExpandConstituent(spec, st, 1, 'major')).toEqual({ ok: true }); // major 8 < 14
  expect(canExpandConstituent(spec, st, 0, 'major')).toEqual({ ok: true }); // primary 20 < 28
});

test('expandConstituent grows ONLY the targeted lobe', () => {
  const spec = mergedSpec({
    primary: { biome: 'plains', major: 20, minor: 20 },
    extras: [{ biome: 'volcanic', major: 8, minor: 8, offsetX: 26, offsetY: 0 }],
  });
  const st = stateWithPlentyOfResources(spec.id);
  expandConstituent(spec, st, 1, 'major');
  expect(spec.extraEllipses![0]!.major).toBe(9);     // lobe grew
  expect(spec.extraEllipses![0]!.minor).toBe(8);     // other axis untouched
  expect(spec.majorRadius).toBe(20);                 // primary untouched
});

test('bad index rejects', () => {
  const spec = singleEllipseSpec({ biome: 'plains', major: 10, minor: 10 });
  const st = stateWithPlentyOfResources(spec.id);
  expect(canExpandConstituent(spec, st, 5, 'major')).toEqual({ ok: false, reason: 'bad-constituent' });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run src/land-reclamation.test.ts -t "lobe|expandConstituent|bad index"`
Expected: FAIL — functions not defined.

- [ ] **Step 3: Extend `ExpandResult` and implement the gate**

```typescript
export type ExpandResult =
  | { readonly ok: true }
  | { readonly ok: false;
      readonly reason: 'no-hub' | 'axis-at-max' | 'insufficient-resources' | 'bad-constituent'; };

/** Resolve a constituent's current radius on `axis` and its cap biome. */
function constituentAxis(spec: IslandSpec, index: number, axis: Axis):
  { current: number; biome: BiomeType } | null {
  if (index === 0) {
    return { current: axis === 'major' ? spec.majorRadius : spec.minorRadius, biome: spec.biome };
  }
  const e = (spec.extraEllipses ?? [])[index - 1];
  if (!e) return null;
  return { current: axis === 'major' ? e.major : e.minor, biome: e.biome ?? spec.biome };
}

export function canExpandConstituent(
  spec: IslandSpec, state: IslandState, index: number, axis: Axis,
): ExpandResult {
  if (!hasLandReclamationHub(spec)) return { ok: false, reason: 'no-hub' };
  const c = constituentAxis(spec, index, axis);
  if (!c) return { ok: false, reason: 'bad-constituent' };
  const caps = BIOME_MAX_RADII[c.biome];
  const max = axis === 'major' ? caps.major : caps.minor;
  if (c.current >= max) return { ok: false, reason: 'axis-at-max' };
  const cost = landReclamationCost(spec, index, axis);
  for (const [r, n] of Object.entries(cost) as Array<[ResourceId, number]>) {
    if (inv(state, r as ResourceId) < n) return { ok: false, reason: 'insufficient-resources' };
  }
  return { ok: true };
}
```

- [ ] **Step 4: Implement the mutation**

```typescript
export function expandConstituent(
  spec: IslandSpec, state: IslandState, index: number, axis: Axis,
): void {
  const guard = canExpandConstituent(spec, state, index, axis);
  if (!guard.ok) return;
  const cost = landReclamationCost(spec, index, axis);
  for (const [r, n] of Object.entries(cost) as Array<[ResourceId, number]>) {
    state.inventory[r] = (state.inventory[r] ?? 0) - n;
  }
  if (index === 0) {
    if (axis === 'major') spec.majorRadius += 1; else spec.minorRadius += 1;
  } else {
    const extras = spec.extraEllipses!;
    const e = extras[index - 1]!;
    extras[index - 1] = {
      ...e,
      major: axis === 'major' ? e.major + 1 : e.major,
      minor: axis === 'minor' ? e.minor + 1 : e.minor,
    };
  }
}
```

Remove the old `canExpandIsland` / `expandIsland` exports (callers migrate in Tasks 6–7).

- [ ] **Step 5: Run tests to verify they pass**

Run: `npx vitest run src/land-reclamation.test.ts`
Expected: all PASS (including pre-existing tests adapted to the new signature — update any that called the old `canExpandIsland(spec, state, axis)` to `canExpandConstituent(spec, state, 0, axis)`).

- [ ] **Step 6: Update SPEC.md §3.4**

Add: *"On a merged island, Land Reclamation can grow any constituent ellipse (primary or any absorbed lobe), chosen via the Hub inspector's per-lobe picker. Each constituent is capped independently by its own origin biome (`BIOME_MAX_RADII[constituent.biome]`). The cost is the union delta of growing that one constituent — tiles already covered by another constituent are not charged."*

- [ ] **Step 7: Commit**

```bash
git add src/land-reclamation.ts src/land-reclamation.test.ts SPEC.md
git commit -m "feat(reclamation): per-constituent gate + mutation, per-lobe biome cap

Co-Authored-By: <model> <noreply@anthropic.com>"
```

---

### Task 5: Persistence v27 → v28 migration

Default legacy `extraEllipses` entries' missing `biome` to the island's own biome (reproduces prior absorber-cap behavior).

**Files:**
- Modify: `src/persistence.ts` (`SCHEMA_VERSION`; `SUPPORTED_LOAD_VERSIONS`; new `SerializedSnapshotV27` + `migrateV27toV28`; `loadWorld` dispatch chain)
- Test: `src/persistence.test.ts`

**Interfaces:**
- Consumes: `IslandSpec.extraEllipses[].biome` (Task 1).
- Produces: `SCHEMA_VERSION = 28`; `migrateV27toV28(s: SerializedSnapshotV27): SaveSnapshot`.

- [ ] **Step 1: Write the failing tests**

```typescript
// src/persistence.test.ts — add
test('migrateV27toV28 defaults missing extra biome to island biome', () => {
  const v27 = {
    ...baseSnapshot(28 - 1),                      // a structurally-valid v27 snapshot
    v: 27 as const,
  };
  // give one island a biome-less extra
  v27.world.islands[0]!.biome = 'plains';
  (v27.world.islands[0] as { extraEllipses?: unknown }).extraEllipses = [
    { major: 6, minor: 6, rotation: 0, offsetX: 12, offsetY: 0 }, // no biome
  ];
  const out = migrateV27toV28(v27 as unknown as SerializedSnapshotV27);
  expect(out.v).toBe(28);
  expect(out.world.islands[0]!.extraEllipses![0]!.biome).toBe('plains');
});

test('v28 round-trips identity through serialize/loadWorld', () => {
  const world = makeWorldWithMergedIsland(); // primary + one biome-stamped lobe
  const snap = serializeWorld(world, /* …args per existing tests… */);
  expect(snap.v).toBe(28);
  const loaded = loadWorld(snap, /* nowMs */ 0);
  const isl = loaded.world.islands.find(i => i.extraEllipses?.length);
  expect(isl!.extraEllipses![0]!.biome).toBeDefined();
});
```

(Use the existing `persistence.test.ts` helpers — `baseSnapshot`, `serializeWorld`, `loadWorld`, `makeWorld…` — matching their current names/signatures.)

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run src/persistence.test.ts -t "migrateV27toV28|round-trips identity"`
Expected: FAIL — `migrateV27toV28` not defined; `SCHEMA_VERSION` still 27.

- [ ] **Step 3: Add the alias + migration**

```typescript
/** v27 top-level snapshot — structurally identical to v28 (SaveSnapshot) except
 *  the v literal. v27 → v28 stamps a cap-only `biome` onto every extraEllipses
 *  entry that lacks one, defaulting to the island's own biome (the absorber's,
 *  which is what implicitly capped every lobe before per-lobe caps existed). */
export type SerializedSnapshotV27 = Omit<SaveSnapshot, 'v'> & { readonly v: 27 };

export function migrateV27toV28(s: SerializedSnapshotV27): SaveSnapshot {
  return {
    ...s,
    v: 28 as const,
    world: {
      ...s.world,
      islands: s.world.islands.map((isl) =>
        isl.extraEllipses && isl.extraEllipses.length > 0
          ? { ...isl, extraEllipses: isl.extraEllipses.map((e) =>
              e.biome === undefined ? { ...e, biome: isl.biome } : e) }
          : isl),
    },
  } as unknown as SaveSnapshot;
}
```

- [ ] **Step 4: Bump version + supported set + dispatch**

```typescript
export const SCHEMA_VERSION = 28 as const;
export const SUPPORTED_LOAD_VERSIONS: ReadonlySet<number> =
  new Set([7,8,9,10,11,12,13,14,15,16,17,18,19,20,21,22,23,24,25,26,27,28]);
```

In `loadWorld`'s chain, after the v26→v27 step:

```typescript
  if ((snapshot as unknown as { v: number }).v === 27) {
    snapshot = migrateV27toV28(snapshot as unknown as SerializedSnapshotV27);
  }
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `npx vitest run src/persistence.test.ts -t "migrateV27toV28|round-trips identity"`
Expected: PASS.

- [ ] **Step 6: Run the full persistence suite**

Run: `npx vitest run src/persistence.test.ts`
Expected: all PASS (the `SCHEMA_VERSION`-equality assertions now expect 28; update any literal `27` in existing round-trip tests).

- [ ] **Step 7: Commit**

```bash
git add src/persistence.ts src/persistence.test.ts
git commit -m "feat(persistence): v27->v28 migration stamps extraEllipses biome

Co-Authored-By: <model> <noreply@anthropic.com>"
```

---

### Task 6: Gateway + server intent carry `constituentIndex`

Thread the chosen constituent through both the LOCAL and REMOTE mutation paths; the server re-validates with the same pure functions.

**Files:**
- Modify: `src/mutation-gateway.ts` (interface `:153`; LOCAL `expandIsland` `:488`; REMOTE `send` `:985`)
- Modify: `server/src/game/intents.ts` (`'expand-island'` handler `:749`)
- Modify: `src/main.ts` (`:1790` — pass index through `deps.onExpandIsland`)
- Test: `src/mutation-gateway.test.ts`; `server/src/game/intents.test.ts` (match existing server test layout)

**Interfaces:**
- Consumes: `canExpandConstituent` / `expandConstituent` (Task 4).
- Produces: `gateway.expandIsland(islandId: string, constituentIndex: number, axis: Axis): GatewayReturn`; intent payload `{ islandId, constituentIndex, axis }` (legacy `{islandId, axis}` validates as index 0).

- [ ] **Step 1: Write the failing tests**

```typescript
// src/mutation-gateway.test.ts — add
test('LOCAL gateway expandIsland grows the chosen lobe', () => {
  const gw = makeLocalGateway(worldWithMergedIsland()); // existing helper
  const r = gw.expandIsland('A', 1, 'major');
  expect(r.ok).toBe(true);
  // assert lobe 1 (extraEllipses[0]) major grew by 1 in the gateway's world
});

test('LOCAL gateway rejects out-of-range constituent', () => {
  const gw = makeLocalGateway(worldWithMergedIsland());
  expect(gw.expandIsland('A', 9, 'major').ok).toBe(false);
});
```

```typescript
// server/src/game/intents.test.ts — add (mirror existing expand-island server test if present)
test('expand-island intent honors constituentIndex; legacy defaults to 0', () => {
  const game = makeLiveGameWithMergedIsland();
  expect(applyIntent(game, 'expand-island', { islandId: 'A', constituentIndex: 1, axis: 'major' }).ok).toBe(true);
  expect(applyIntent(game, 'expand-island', { islandId: 'A', axis: 'major' }).ok).toBe(true); // legacy → index 0
  expect(applyIntent(game, 'expand-island', { islandId: 'A', constituentIndex: 9, axis: 'major' }).ok).toBe(false);
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run src/mutation-gateway.test.ts -t "expandIsland"` and `cd server && npx vitest run src/game/intents.test.ts -t "expand-island"`
Expected: FAIL — arity mismatch / `constituentIndex` ignored.

- [ ] **Step 3: Update the gateway interface + LOCAL impl**

Interface (`:153`):
```typescript
  expandIsland(islandId: string, constituentIndex: number, axis: Axis): GatewayReturn;
```
LOCAL (`:488`):
```typescript
    expandIsland(islandId, constituentIndex, axis) {
      const island = resolveIsland(islandId);
      if (!island) return err('unknown island');
      const can = canExpandConstituent(island.spec, island.state, constituentIndex, axis);
      if (!can.ok) return err(can.reason ?? 'expand failed', can.reason);
      expandConstituent(island.spec, island.state, constituentIndex, axis);
      return ok();
    },
```
(Update the import at `:17` from `canExpandIsland, expandIsland` to `canExpandConstituent, expandConstituent`.)

REMOTE (`:985`):
```typescript
    expandIsland(islandId, constituentIndex, axis) {
      return send('expand-island', { islandId, constituentIndex, axis });
    },
```

- [ ] **Step 4: Update the server intent handler**

`server/src/game/intents.ts` `'expand-island'`:
```typescript
    apply(game: LiveGame, payload: unknown): IntentResult {
      if (!isRecord(payload)) return { ok: false, error: 'malformed payload' };
      const { islandId, axis } = payload;
      const constituentIndex = (payload as { constituentIndex?: unknown }).constituentIndex ?? 0;
      if (typeof islandId !== 'string') return { ok: false, error: 'islandId must be a string' };
      if (axis !== 'major' && axis !== 'minor') return { ok: false, error: 'axis must be major or minor' };
      if (typeof constituentIndex !== 'number' || !Number.isInteger(constituentIndex) || constituentIndex < 0)
        return { ok: false, error: 'constituentIndex must be a non-negative integer' };
      const island = resolveIsland(game, islandId);
      if (!island) return { ok: false, error: 'unknown island' };
      const can = canExpandConstituent(island.spec, island.state, constituentIndex, axis as Axis);
      if (!can.ok) return { ok: false, error: can.reason ?? 'expand failed' };
      expandConstituent(island.spec, island.state, constituentIndex, axis as Axis);
      return { ok: true };
    },
```
(Update the server's import from `canExpandIsland, expandIsland` to `canExpandConstituent, expandConstituent`.)

- [ ] **Step 5: Update `main.ts` call site**

At `:1790`, change `gateway.expandIsland(target.spec.id, axis)` to thread the index from the inspector dep (Task 7 sets `onExpandIsland(target, index, axis)`). For now:
```typescript
      const gatewayResult = gateway.expandIsland(target.spec.id, index, axis);
```
and widen the `deps.onExpandIsland` signature passed to `createInspector` to `(target, index, axis)`.

- [ ] **Step 6: Run tests to verify they pass**

Run: `npx vitest run src/mutation-gateway.test.ts -t "expandIsland"` and `cd server && npx vitest run src/game/intents.test.ts -t "expand-island"`
Expected: PASS.

- [ ] **Step 7: Typecheck client + server**

Run: `npx tsc -b --force` then `cd server && npm run typecheck`
Expected: clean except the inspector dep arity (fixed in Task 7).

- [ ] **Step 8: Commit**

```bash
git add src/mutation-gateway.ts server/src/game/intents.ts src/main.ts src/mutation-gateway.test.ts server/src/game/intents.test.ts
git commit -m "feat(gateway): expand-island carries constituentIndex (server re-validates)

Co-Authored-By: <model> <noreply@anthropic.com>"
```

---

### Task 7: Inspector scrollable per-constituent picker

Replace the two static expand buttons with a scrollable list — one row per constituent, each with `+MAJ` / `+MIN` gated by `canExpandConstituent`. Render layer: verified by build + screenshot, not unit tests.

**Files:**
- Modify: `src/inspector-ui.ts` (reclamation section build `~:1363–1413`; `reclamationButtonText`/`paintReclamation` `~:1610–1654`; dep type for `onExpandIsland`)
- Modify: `src/main.ts` (wire `onExpandIsland: (target, index, axis) => …`)

**Interfaces:**
- Consumes: `islandConstituents` (Task 1), `canExpandConstituent` + `landReclamationCost` (Tasks 3–4), `BIOME_MAX_RADII`.
- Produces: a `deps.onExpandIsland(target, index, axis)` contract; a scrollable list DOM whose row `#N` corresponds to constituent index `N-1` badge-wise (display 1-based).

- [ ] **Step 1: Make the reclamation body a scroll container**

Replace the two-button append with a list container:
```typescript
  const reclamationList = document.createElement('div');
  reclamationList.setAttribute('style', [
    'display:flex', 'flex-direction:column', 'gap:6px',
    'max-height:220px', 'overflow-y:auto', // scrollable when many lobes
  ].join(';'));
  reclamationSection.body.appendChild(reclamationList);
```
Delete the single `expandMajorBtn`/`expandMinorBtn` pair and their click handlers (the per-row buttons replace them).

- [ ] **Step 2: Render one row per constituent in `paintReclamation`**

```typescript
  function paintReclamation(spec: IslandSpec, state: IslandState): void {
    const cs = islandConstituents(spec);
    reclamationList.replaceChildren();
    cs.forEach((c, index) => {
      const caps = BIOME_MAX_RADII[c.biome];
      const row = document.createElement('div'); // label + two buttons
      const label = document.createElement('span');
      label.textContent =
        `#${index + 1} · ${c.biome} · r${c.major}/${caps.major} · r${c.minor}/${caps.minor}`;
      row.appendChild(label);
      for (const axis of ['major', 'minor'] as const) {
        const gate = canExpandConstituent(spec, state, index, axis);
        const btn = makeExpandButton();
        btn.textContent = reclamationButtonText(spec, index, axis, gate);
        setExpandButtonState(btn, gate);
        btn.addEventListener('click', () => {
          const target = resolveTarget();
          if (!target) { close(); return; }
          deps.onExpandIsland(target, index, axis);
        });
        row.appendChild(btn);
      }
      reclamationList.appendChild(row);
    });
  }
```

- [ ] **Step 3: Update `reclamationButtonText` to take an index**

```typescript
  function reclamationButtonText(spec: IslandSpec, index: number, axis: Axis, gate: ExpandResult): string {
    const label = axis === 'major' ? '+1 MAJ' : '+1 MIN';
    if (gate.ok) {
      const cost = landReclamationCost(spec, index, axis);
      return `${label} · ${formatShortfall(cost)}`;
    }
    if (gate.reason === 'axis-at-max') return `${label} · CAP`;
    if (gate.reason === 'insufficient-resources') {
      return `${label} · NEED ${formatShortfall(landReclamationCost(spec, index, axis))}`;
    }
    return `${label} · —`;
  }
```
Update the `onExpandIsland` dep type to `(target: …, index: number, axis: Axis) => void`.

- [ ] **Step 4: Wire `main.ts`**

```typescript
  onExpandIsland: (target, index, axis) => {
    const gatewayResult = gateway.expandIsland(target.spec.id, index, axis);
    // …existing post-expand rebuild/refresh…
  },
```

- [ ] **Step 5: Build + typecheck**

Run: `npm run build`
Expected: clean. Fix any residual references to the deleted `expandMajorBtn`/`expandMinorBtn`.

- [ ] **Step 6: Manual visual verification**

Reload the dev tab (it serves built `dist/`), open a merged island's Land Reclamation Hub inspector, and screenshot:
Run: `mcp__daedalus__screenshot` against the active tab.
Expected: a scrollable list with one row per lobe, biome + radii labels, per-axis buttons; capped axes show `CAP`.

- [ ] **Step 7: Commit**

```bash
git add src/inspector-ui.ts src/main.ts
git commit -m "feat(inspector): scrollable per-constituent Land Reclamation picker

Co-Authored-By: <model> <noreply@anthropic.com>"
```

---

### Task 8: Numbered lobe badges overlay

A render-layer overlay drawing `#N` at each constituent center while a Land Reclamation Hub inspector is open, so picker rows map to map lobes.

**Files:**
- Create: `src/lobe-badge-overlay.ts`
- Modify: `src/main.ts` (construct + per-frame update the overlay; show only when the targeted building is a `land_reclamation_hub`)

**Interfaces:**
- Consumes: `islandConstituents` (Task 1); `tileToWorldPx` / camera→screen helpers (from `world.ts` / `camera.ts`); the active inspector target.
- Produces: `createLobeBadgeOverlay(stage): { update(spec: IslandSpec | null, cam: Camera): void; destroy(): void }`.

- [ ] **Step 1: Implement the overlay (Pixi text badges)**

```typescript
// src/lobe-badge-overlay.ts — render layer (imports pixi.js)
import { Container, Text } from 'pixi.js';
import { islandConstituents, tileToWorldPx, type IslandSpec } from './world.js';
import type { Camera } from './camera.js';

/** Draws "#1…#N" at each constituent center of the given island, or clears when
 *  spec is null. Pure-read against spec; no state mutation. */
export function createLobeBadgeOverlay(parent: Container) {
  const layer = new Container();
  parent.addChild(layer);
  const pool: Text[] = [];
  return {
    update(spec: IslandSpec | null, cam: Camera): void {
      const cs = spec ? islandConstituents(spec) : [];
      while (pool.length < cs.length) {
        const t = new Text({ text: '', style: { fill: 0x7dd3e8, fontSize: 13, fontFamily: 'monospace' } });
        t.anchor.set(0.5); layer.addChild(t); pool.push(t);
      }
      pool.forEach((t, i) => {
        if (i >= cs.length || !spec) { t.visible = false; return; }
        const c = cs[i]!;
        const w = tileToWorldPx(spec.cx + c.offsetX, spec.cy + c.offsetY);
        t.position.set(w.x * cam.zoom + cam.tx, w.y * cam.zoom + cam.ty);
        t.text = `#${i + 1}`; t.visible = true;
      });
    },
    destroy(): void { layer.destroy({ children: true }); },
  };
}
```
(Match the project's actual Pixi 8 `Text` construction and camera→screen formula — see `main.ts`'s ticker sync and any existing `*-overlay.ts` for the exact idiom.)

- [ ] **Step 2: Wire into `main.ts`**

Construct once (`const lobeBadges = createLobeBadgeOverlay(uiStage)`), and in the ticker:
```typescript
  const tgt = activeInspectorTarget();
  const showBadges = tgt && tgt.building?.defId === 'land_reclamation_hub';
  lobeBadges.update(showBadges ? tgt.spec : null, cam);
```

- [ ] **Step 3: Build + typecheck**

Run: `npm run build`
Expected: clean.

- [ ] **Step 4: Manual visual verification**

Reload the tab, open a merged island's Hub inspector, screenshot:
Run: `mcp__daedalus__screenshot`
Expected: `#1…#N` badges at each lobe center matching the picker rows; badges disappear when the inspector closes or a non-Hub building is selected.

- [ ] **Step 5: Commit**

```bash
git add src/lobe-badge-overlay.ts src/main.ts
git commit -m "feat(overlay): numbered lobe badges while Reclamation Hub is open

Co-Authored-By: <model> <noreply@anthropic.com>"
```

---

### Final verification (whole feature)

- [ ] **Full typecheck:** `npx tsc -b --force` (client) and `cd server && npm run typecheck` — both clean.
- [ ] **Full suite (Postgres up):** `npm test` — all client + server projects green.
- [ ] **Manual end-to-end:** on a merged island, grow an absorbed lobe to its origin-biome cap; confirm cost matches deduction, a capped axis shows `CAP`, and growing a lobe into a third island triggers a §3.6 merge.
- [ ] **Spec parity:** SPEC.md §3.4 / §3.6 / §15.1 reflect the shipped behavior.
- [ ] **Integrate:** rebase the feature branch on `master`, fast-forward (linear history), open the PR per CONTRIBUTING.md.

## Notes for the implementer

- **The cost-preview fix is already on master** (`f2e0dea`): the inspector now passes the full constituent set to `landReclamationCost`. Task 3 changes that function's signature, so the inspector call site is rewritten in Task 7 anyway — no conflict.
- **`findReferences` before removing `canExpandIsland`/`expandIsland`** — there may be test or fixture callers beyond the gateway/server/inspector; update them all to the constituent-indexed names (index 0).
- **Render layer stays read-only against state** — the overlay and picker never mutate `spec`/`state`; all mutation flows through the gateway.
