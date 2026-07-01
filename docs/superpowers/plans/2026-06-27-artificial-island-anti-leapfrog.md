# Artificial-Island Anti-Leapfrog Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Gate artificial-island construction with three placement-time rules (anchor / range / ratio) so the artificial-island leapfrog exploit — collapsing an archipelago into one merged megatile for trivial cost — is structurally impossible, while merge-as-side-effect stays untouched.

**Architecture:** Three pure predicates added to `src/construction-gate.ts` (the existing trust-surface seam), re-run identically by the construction UI (`construction-placement.ts`), the LOCAL mutation gateway, and the authoritative server `construct-island` intent — exactly like the existing `positionIsFree` / `regionDiscoveredOrVisible` pair. Attribution for the ratio rule rides a new persisted `founderId` field (schema v32 → v33 with migration).

**Tech Stack:** TypeScript strict (client `src/` pure layer + Fastify server `server/src/`), vitest, Postgres (server tests only).

**Spec:** `docs/superpowers/specs/2026-06-27-artificial-island-anti-leapfrog-design.md` (committed `6c0ac0b`, approved).

## Global Constraints

- `tsconfig` has `strict`, `noUncheckedIndexedAccess`, `noUnusedLocals`, `noUnusedParameters` — new code must compile clean.
- **Every behavior change updates `SPEC.md` in the same change** (Task 5 owns the SPEC edit; earlier tasks change only code+tests).
- Persistence: bump = migrate (AGENTS.md). v32→v33 ships `SerializedSnapshotV32` + `migrateV32toV33` + `loadWorld` wiring + `SUPPORTED_LOAD_VERSIONS` entry + tests.
- Pure layer (`src/` non-UI files) must NOT import pixi.js or DOM.
- `npm test` from repo root runs client AND server projects; server needs local Postgres (it is running on this box). `cd server && npm run typecheck` for server strict typecheck with tests.
- Work happens on feature branch `anti-leapfrog` cut from `master` (CONTRIBUTING.md full-feature track). Commits: conventional-commit style; every commit ends with the executing agent's own co-author trailer, e.g. `Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>` (a kimi implementer uses its own Kimi trailer instead).
- Constants (placeholders, tunable): `ARTIFICIAL_RANGE_TILES = 48`, `ARTIFICIAL_RATIO = 2`.
- Existing test fixtures: prefer reusing each test file's existing founder/world helpers; the code blocks below are complete fallbacks if none fit.

---

### Task 1: Founder attribution plumbing (`founderId` on spec + lobes, stamped at construction, carried through merge)

**Files:**
- Modify: `src/world.ts` (IslandSpec ~line 166 after `artificial`; extraEllipses entry ~line 187 after `originId`)
- Modify: `src/artificial-island.ts` (`constructIsland` spec literal, ~line 197–210)
- Modify: `src/island-merge.ts` (`performMerge` extraEllipses pushes, lines 142–152 and 157–168)
- Test: `src/artificial-island.test.ts`, `src/island-merge.test.ts`

**Interfaces:**
- Consumes: existing `IslandSpec`, `constructIsland`, `performMerge`.
- Produces: `IslandSpec.founderId?: string` (readonly, optional); `extraEllipses` entries gain `founderId?: string` (readonly, optional). `constructIsland` stamps `founderId: founderSpec.id` on the minted spec. `performMerge` copies `founderId` from the absorbed primary and from each propagated extra into the new lobe entries. Later tasks (2, 3) rely on these exact field names.

- [ ] **Step 1: Create the feature branch**

```bash
cd /root/robot-islands && git checkout master && git checkout -b anti-leapfrog
```

- [ ] **Step 2: Write the failing tests**

In `src/artificial-island.test.ts`, add (reuse the file's existing founder fixture if one exists; otherwise use this helper):

```ts
it('stamps founderId with the founding island id (§2.5 anti-leapfrog attribution)', () => {
  const spec = attachTerrainAt({
    id: 'founder-a', name: 'founder-a', biome: 'plains', cx: 0, cy: 0,
    majorRadius: 10, minorRadius: 10, populated: true, discovered: true,
    buildings: [], modifiers: [],
  });
  (spec.buildings as PlacedBuilding[]).push({
    id: 'pc-1', defId: 'platform_constructor', x: 0, y: 0, rotation: 0,
    queued: false, invalid: false, placedAt: 0, queueSeq: 1, floorLevel: 0,
    operatingMs: 0, maintainedAt: 0, constructionTotalMs: 0, constructionRemainingMs: 0,
  } as unknown as PlacedBuilding);
  const state = makeInitialIslandState(spec, 0);
  state.level = 30;
  state.inventory['steel_beam'] = 1_000_000;
  state.inventory['concrete'] = 10_000_000;
  const { newSpec } = constructIsland(
    'seed', state, spec,
    { biome: 'plains', majorRadius: 4, minorRadius: 4 },
    { cx: 100, cy: 100 }, 'art-100-100', 0,
  );
  expect(newSpec.founderId).toBe('founder-a');
  expect(newSpec.artificial).toBe(true);
});
```

In `src/island-merge.test.ts`, add (reuse the file's existing two-island merge fixture pattern):

```ts
it('carries founderId into absorbed lobes (§2.5 attribution survives merge)', () => {
  // absorber: natural populated island; absorbed: artificial island with founderId,
  // itself carrying one artificial extra with its own founderId.
  const absorber = attachTerrainAt({
    id: 'nat-1', name: 'nat-1', biome: 'plains', cx: 0, cy: 0,
    majorRadius: 10, minorRadius: 10, populated: true, discovered: true,
    buildings: [], modifiers: [],
  });
  const absorbed = attachTerrainAt({
    id: 'art-30-0', name: 'art-30-0', biome: 'plains', cx: 30, cy: 0,
    majorRadius: 6, minorRadius: 6, populated: true, discovered: true,
    buildings: [], modifiers: [], artificial: true, founderId: 'nat-1',
    extraEllipses: [{
      biome: 'plains', originId: 'art-44-0', major: 6, minor: 6,
      rotation: 0, offsetX: 14, offsetY: 0, founderId: 'nat-1',
    }],
  });
  const states = new Map<string, IslandState>([
    [absorber.id, makeInitialIslandState(absorber, 0)],
    [absorbed.id, makeInitialIslandState(absorbed, 0)],
  ]);
  const world = { islands: [absorber, absorbed] } as unknown as WorldState;
  performMerge(world, states, absorber, absorbed);
  const lobes = absorber.extraEllipses!;
  expect(lobes).toHaveLength(2);
  expect(lobes[0]!.originId).toBe('art-30-0');
  expect(lobes[0]!.founderId).toBe('nat-1');   // absorbed primary's founderId
  expect(lobes[1]!.originId).toBe('art-44-0');
  expect(lobes[1]!.founderId).toBe('nat-1');   // propagated extra's founderId
});
```

Note: `performMerge` touches `world.routes` / `world.drones` / etc. — if the minimal `world` cast fails at runtime, extend the cast with the empty arrays the existing merge tests use (`routes: [], drones: [], vehicles: [], satellites: [], commPackets: []`, …); mirror the file's existing fixtures.

- [ ] **Step 3: Run tests to verify they fail**

Run: `npx vitest run src/artificial-island.test.ts src/island-merge.test.ts -t founderId`
Expected: FAIL — `founderId` is `undefined` (field doesn't exist yet). A TS compile error about `founderId` not existing on the literal type is the equivalent failure signal.

- [ ] **Step 4: Add the fields and stamping**

`src/world.ts` — inside `IslandSpec`, immediately after the `artificial?: boolean` member (~line 166):

```ts
  /** §2.5 anti-leapfrog attribution: id of the island whose Platform
   *  Constructor built this island. Set only on artificial islands from
   *  schema v33 on (migration backfills older saves best-effort). Feeds the
   *  per-founder artificial:natural ratio gate (`attributedArtificialCount`,
   *  construction-gate.ts). Absent on natural islands. */
  readonly founderId?: string;
```

Inside the `extraEllipses` entry type, immediately after `originId` (~line 187):

```ts
    /** §2.5 anti-leapfrog attribution of an absorbed artificial constituent:
     *  the `founderId` the island carried when it was absorbed. Undefined for
     *  natural lobes. Lets a founder's lifetime artificial count survive the
     *  absorbed island's removal from `world.islands` (§3.6 merge). */
    readonly founderId?: string;
```

`src/artificial-island.ts` — in `constructIsland`'s `attachTerrainAt({ ... })` literal, after `artificial: true,`:

```ts
    // §2.5 anti-leapfrog: attribute this island to its founder for the
    // per-founder ratio gate. Survives merges via the lobe's own founderId.
    founderId: founderSpec.id,
```

`src/island-merge.ts` — in `performMerge`, the absorbed-primary push (lines 142–152) gains one line after `originId: absorbed.id,`:

```ts
    founderId: absorbed.founderId,
```

and the propagated-extras push (lines 157–168) gains one line after `originId: e.originId ?? absorbed.id,`:

```ts
        founderId: e.founderId,
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `npx vitest run src/artificial-island.test.ts src/island-merge.test.ts`
Expected: PASS (all tests in both files, new and pre-existing).

- [ ] **Step 6: Typecheck both projects**

Run: `npx tsc -b --noEmit 2>&1 | head; cd server && npx tsc --noEmit && cd ..`
Expected: no errors.

- [ ] **Step 7: Commit**

```bash
git add src/world.ts src/artificial-island.ts src/island-merge.ts src/artificial-island.test.ts src/island-merge.test.ts
git commit -m "feat(artificial-island): founderId attribution on spec + merged lobes

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 2: The three pure predicates in `construction-gate.ts`

**Files:**
- Modify: `src/construction-gate.ts`
- Test: `src/construction-gate.test.ts`

**Interfaces:**
- Consumes: `IslandSpec.founderId` / lobe `founderId` (Task 1); existing `islandsOverlap`, `islandConstituents`, `BIOME_MAX_RADII` from `./world.js`.
- Produces (exact exports later tasks import):

```ts
export const ARTIFICIAL_RANGE_TILES = 48;
export const ARTIFICIAL_RATIO = 2;
export type ArtificialPlacementReason = 'leapfrog-anchor' | 'out-of-range' | 'ratio-exceeded';
export interface ArtificialPlacementResult { readonly ok: boolean; readonly reason?: ArtificialPlacementReason; }
export function maxGrowthFootprintTouches(world: WorldState, cx: number, cy: number, major: number, minor: number): boolean;
export function founderRangeGap(founderSpec: IslandSpec, cx: number, cy: number, major: number, minor: number): number;
export function naturalConstituentCount(spec: IslandSpec): number;
export function attributedArtificialCount(world: WorldState, founderId: string): number;
export function validateArtificialPlacement(world: WorldState, founderSpec: IslandSpec, cx: number, cy: number, major: number, minor: number): ArtificialPlacementResult;
```

- [ ] **Step 1: Write the failing tests**

Append to `src/construction-gate.test.ts` (reuse the file's existing world/spec helpers where they fit):

```ts
import {
  validateArtificialPlacement, maxGrowthFootprintTouches, founderRangeGap,
  naturalConstituentCount, attributedArtificialCount,
  ARTIFICIAL_RANGE_TILES, ARTIFICIAL_RATIO,
} from './construction-gate.js';

function spec(partial: Partial<IslandSpec> & { id: string; cx: number; cy: number }): IslandSpec {
  return {
    name: partial.id, biome: 'plains', majorRadius: 10, minorRadius: 10,
    populated: true, discovered: true, buildings: [], modifiers: [],
    ...partial,
  } as IslandSpec;
}
function worldWith(...islands: IslandSpec[]): WorldState {
  return { islands } as unknown as WorldState;
}

describe('§2.5 anti-leapfrog placement gates', () => {
  // Plains max radius is 28 (BIOME_MAX_RADII). A populated plains island at
  // r10 could grow to r28: its max-growth footprint reaches |x| < 28.
  it('anchor: rejects inside a populated island\'s max-growth footprint even when clear of its current footprint', () => {
    const nat = spec({ id: 'nat-1', cx: 0, cy: 0 });          // r10 now, max 28
    const world = worldWith(nat);
    // candidate r4 centred at x=28: current footprint (r10, reach ~x=9) is 15+
    // tiles clear, but a max-grown r28 footprint reaches ~x=26-27 and the r4
    // candidate's inscribed tiles start ~x=25 — definite overlap, not a
    // borderline 1-tile gap (inscribed footprints run 1-2 tiles inside the
    // mathematical ellipse).
    expect(maxGrowthFootprintTouches(world, 28, 0, 4, 4)).toBe(true);
    const v = validateArtificialPlacement(world, nat, 28, 0, 4, 4);
    expect(v).toEqual({ ok: false, reason: 'leapfrog-anchor' });
  });

  it('anchor: accepts just beyond the max-growth footprint', () => {
    const nat = spec({ id: 'nat-1', cx: 0, cy: 0 });
    const world = worldWith(nat);
    // candidate r4 centred at x=40: max-grown reach 28 + candidate 4 → gap ≈ 8 tiles.
    expect(maxGrowthFootprintTouches(world, 40, 0, 4, 4)).toBe(false);
    expect(validateArtificialPlacement(world, nat, 40, 0, 4, 4).ok).toBe(true);
  });

  it('anchor: ignores unpopulated islands (they cannot grow)', () => {
    const ghost = spec({ id: 'nat-2', cx: 0, cy: 0, populated: false });
    const world = worldWith(ghost, spec({ id: 'founder', cx: 200, cy: 0 }));
    expect(maxGrowthFootprintTouches(world, 30, 0, 4, 4)).toBe(false);
  });

  it('range: measures the Chebyshev gap between constituent bounding boxes', () => {
    const founder = spec({ id: 'f', cx: 0, cy: 0 });          // bbox reaches x=10
    // candidate r4 at x=62: gap = 62 − 10 − 4 = 48 → exactly at the limit, allowed.
    expect(founderRangeGap(founder, 62, 0, 4, 4)).toBe(ARTIFICIAL_RANGE_TILES);
    // x=63 → gap 49 → out of range.
    expect(founderRangeGap(founder, 63, 0, 4, 4)).toBe(49);
  });

  it('range: rejects beyond ARTIFICIAL_RANGE_TILES from the founder, measured from the nearest constituent', () => {
    // founder with a lobe stretching toward the candidate: range measured from the lobe, not the primary.
    const founder = spec({
      id: 'f', cx: 0, cy: 0,
      extraEllipses: [{ biome: 'plains', originId: 'gen-1-0', major: 10, minor: 10, rotation: 0, offsetX: 40, offsetY: 0 }],
    });
    const world = worldWith(founder);
    // candidate at x=110: gap to primary = 110−10−4 = 96 > 48, but to lobe (reaches x=50) = 110−50−4 = 56 > 48 → reject.
    expect(validateArtificialPlacement(world, founder, 110, 0, 4, 4)).toEqual({ ok: false, reason: 'out-of-range' });
    // candidate at x=100: gap to lobe = 100−50−4 = 46 ≤ 48 → allowed (and clear of anchor: plains lobe max 28
    // ⇒ max-grown lobe reaches x=40+28=68; candidate r4 at 100 reaches 96).
    expect(validateArtificialPlacement(world, founder, 100, 0, 4, 4).ok).toBe(true);
  });

  it('ratio: counts natural constituents by originId prefix', () => {
    const merged = spec({
      id: 'nat-1', cx: 0, cy: 0,
      extraEllipses: [
        { biome: 'plains', originId: 'gen-2-0', major: 8, minor: 8, rotation: 0, offsetX: 20, offsetY: 0 },
        { biome: 'plains', originId: 'art-50-0', major: 8, minor: 8, rotation: 0, offsetX: 40, offsetY: 0, founderId: 'nat-1' },
      ],
    });
    expect(naturalConstituentCount(merged)).toBe(2);          // primary + gen lobe; art lobe excluded
    const artFounder = spec({ id: 'art-9-9', cx: 0, cy: 0, artificial: true });
    expect(naturalConstituentCount(artFounder)).toBe(0);      // artificial primary is not natural
  });

  it('ratio: attributedArtificialCount counts standalone islands AND absorbed lobes', () => {
    const founder = spec({ id: 'nat-1', cx: 0, cy: 0 });
    const standalone = spec({ id: 'art-80-0', cx: 80, cy: 0, artificial: true, founderId: 'nat-1' });
    const other = spec({
      id: 'nat-2', cx: 200, cy: 0,
      extraEllipses: [{ biome: 'plains', originId: 'art-90-0', major: 6, minor: 6, rotation: 0, offsetX: 30, offsetY: 0, founderId: 'nat-1' }],
    });
    const world = worldWith(founder, standalone, other);
    expect(attributedArtificialCount(world, 'nat-1')).toBe(2);
    expect(attributedArtificialCount(world, 'nat-2')).toBe(0);
  });

  it('ratio: rejects the (2N+1)-th artificial build and blocks artificial founders outright', () => {
    // founder: 1 natural constituent → budget = 2. Two attributed already → reject the 3rd.
    const founder = spec({ id: 'nat-1', cx: 0, cy: 0 });
    const a1 = spec({ id: 'art-100-0', cx: 100, cy: 0, artificial: true, founderId: 'nat-1' });
    const a2 = spec({ id: 'art-100-40', cx: 100, cy: 40, artificial: true, founderId: 'nat-1' });
    const world = worldWith(founder, a1, a2);
    // position picked clear of every anchor/range concern: within 48 of founder bbox, away from max-growth reaches.
    const v = validateArtificialPlacement(world, founder, 0, 44, 4, 4);
    expect(v).toEqual({ ok: false, reason: 'ratio-exceeded' });
    // an artificial founder (0 natural constituents) can never build:
    const artFounder = spec({ id: 'art-300-0', cx: 300, cy: 300, artificial: true, populated: true });
    const w2 = worldWith(artFounder);
    expect(validateArtificialPlacement(w2, artFounder, 300, 344, 4, 4)).toEqual({ ok: false, reason: 'ratio-exceeded' });
  });
});
```

Adjust the anchor-test positions only if the assertion comments' arithmetic disagrees with `BIOME_MAX_RADII` at read time (plains is `{major: 28, minor: 28}` per SPEC §3.4 table) — the *intent* of each case is fixed: one placement inside max-growth reach but outside current reach, one just beyond, one unpopulated-ignored. Note the ratio-reject test's candidate at `(0, 44)` must sit clear of the founder's own max-growth reach (44 − 28 − 4 = 12 tiles gap → clear); verify with the same arithmetic — anchor must NOT fire in that test (precedence would mask the ratio reason). In the second ratio-reject case, `art-300-0` is itself populated and its own max-growth footprint surrounds the candidate at `(300, 344)`? Check: artificial primary r10 grown to plains cap 28 reaches y=328; candidate r4 at 344 reaches y=340 → gap 12, clear. Keep the arithmetic comments in the test file.

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run src/construction-gate.test.ts`
Expected: FAIL — imports don't exist (`validateArtificialPlacement` not exported).

- [ ] **Step 3: Implement the predicates**

Append to `src/construction-gate.ts` (extend the existing world.js import to add `islandConstituents` and `BIOME_MAX_RADII`):

```ts
/** §2.5 anti-leapfrog placement gates. Placeholder magnitudes — tunable. */
export const ARTIFICIAL_RANGE_TILES = 48;
export const ARTIFICIAL_RATIO = 2;

export type ArtificialPlacementReason = 'leapfrog-anchor' | 'out-of-range' | 'ratio-exceeded';

export interface ArtificialPlacementResult {
  readonly ok: boolean;
  readonly reason?: ArtificialPlacementReason;
}

/** A shallow variant of `spec` with every constituent grown to its own
 *  origin-biome `BIOME_MAX_RADII` caps (§3.4) — the farthest footprint the
 *  island could EVER reach via Land Reclamation, hub or no hub (a Hub can
 *  always be built later, so the gate must not condition on one). `max()`
 *  guards specs already at/over cap. Does NOT mutate `spec`. */
function maxGrowthSpec(spec: IslandSpec): IslandSpec {
  const pCaps = BIOME_MAX_RADII[spec.biome];
  return {
    ...spec,
    majorRadius: Math.max(spec.majorRadius, pCaps.major),
    minorRadius: Math.max(spec.minorRadius, pCaps.minor),
    extraEllipses: spec.extraEllipses?.map((e) => {
      const caps = BIOME_MAX_RADII[e.biome ?? spec.biome];
      return { ...e, major: Math.max(e.major, caps.major), minor: Math.max(e.minor, caps.minor) };
    }),
  };
}

/** §2.5 anchor rule: would the candidate footprint touch/overlap the
 *  MAX-GROWTH footprint of any populated island? Populated-only: growth
 *  requires a Land Reclamation Hub, which requires population; unpopulated
 *  islands cannot grow to swallow anything. Reuses the §3.6 `islandsOverlap`
 *  tile test (touching counts), so "the gap an existing island can close"
 *  and "the gap that triggers a merge" can never disagree. */
export function maxGrowthFootprintTouches(
  world: WorldState,
  cx: number,
  cy: number,
  major: number,
  minor: number,
): boolean {
  const candidate = { cx, cy, majorRadius: major, minorRadius: minor } as unknown as IslandSpec;
  for (const s of world.islands) {
    if (!s.populated) continue;
    if (islandsOverlap(maxGrowthSpec(s), candidate)) return true;
  }
  return false;
}

/** §2.5 range rule metric: the minimum Chebyshev gap between the candidate's
 *  bounding box and any founder-constituent bounding box (0 when they
 *  overlap/touch). Constituent extents, not centre distance, so a lobe that
 *  stretches toward the candidate shortens the measured gap. Cheap
 *  (O(constituents)) so the drag-ghost can evaluate it per mousemove. */
export function founderRangeGap(
  founderSpec: IslandSpec,
  cx: number,
  cy: number,
  major: number,
  minor: number,
): number {
  let best = Infinity;
  for (const c of islandConstituents(founderSpec)) {
    const ccx = founderSpec.cx + c.offsetX;
    const ccy = founderSpec.cy + c.offsetY;
    const gapX = Math.max(0, Math.abs(cx - ccx) - (major + c.major));
    const gapY = Math.max(0, Math.abs(cy - ccy) - (minor + c.minor));
    best = Math.min(best, Math.max(gapX, gapY));
  }
  return best;
}

/** §2.5 ratio rule: how many of `spec`'s constituents are NATURAL — primary
 *  or lobe whose origin island was not artificial. Uses the resolved
 *  `originId` prefix (artificial ids are `art-N` / `art-<cx>-<cy>`; generated
 *  islands are `gen-*` / `home`), which covers both the primary (originId =
 *  spec.id) and absorbed lobes uniformly. */
export function naturalConstituentCount(spec: IslandSpec): number {
  let n = 0;
  for (const c of islandConstituents(spec)) {
    if (!c.originId.startsWith('art-')) n++;
  }
  return n;
}

/** §2.5 ratio rule: the founder's LIFETIME artificial-creation count —
 *  standalone artificial islands plus absorbed artificial lobes anywhere in
 *  the world whose `founderId` matches. Never double-counts: a merge removes
 *  the standalone spec from `world.islands` in the same step it appends the
 *  lobe. Monotonic by design — merging an artificial island away does not
 *  refund the founder's budget. */
export function attributedArtificialCount(world: WorldState, founderId: string): number {
  let n = 0;
  for (const s of world.islands) {
    if (s.artificial && s.founderId === founderId) n++;
    if (s.extraEllipses) {
      for (const e of s.extraEllipses) {
        if (e.founderId === founderId) n++;
      }
    }
  }
  return n;
}

/** §2.5 anti-leapfrog placement gate: anchor, then range, then ratio
 *  (spatial reasons take precedence so the drag-ghost reds on position
 *  problems before budget problems). Pure; re-run identically by the
 *  construction UI, the LOCAL gateway, and the server `construct-island`
 *  intent — same trust-surface contract as `positionIsFree` above. */
export function validateArtificialPlacement(
  world: WorldState,
  founderSpec: IslandSpec,
  cx: number,
  cy: number,
  major: number,
  minor: number,
): ArtificialPlacementResult {
  if (maxGrowthFootprintTouches(world, cx, cy, major, minor)) {
    return { ok: false, reason: 'leapfrog-anchor' };
  }
  if (founderRangeGap(founderSpec, cx, cy, major, minor) > ARTIFICIAL_RANGE_TILES) {
    return { ok: false, reason: 'out-of-range' };
  }
  const budget = ARTIFICIAL_RATIO * naturalConstituentCount(founderSpec);
  if (attributedArtificialCount(world, founderSpec.id) + 1 > budget) {
    return { ok: false, reason: 'ratio-exceeded' };
  }
  return { ok: true };
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run src/construction-gate.test.ts`
Expected: PASS (new describe + all pre-existing tests).

- [ ] **Step 5: Typecheck**

Run: `npx tsc -b --noEmit`
Expected: no errors.

- [ ] **Step 6: Commit**

```bash
git add src/construction-gate.ts src/construction-gate.test.ts
git commit -m "feat(construction-gate): anti-leapfrog anchor/range/ratio predicates (§2.5)

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 3: Schema v33 — persist `founderId`, migrate v32 saves

**Files:**
- Modify: `src/persistence.ts` (`SCHEMA_VERSION` line 79; `SUPPORTED_LOAD_VERSIONS` line 87; new alias + migration next to `migrateV31toV32` ~line 601–613; `loadWorld` dispatch ~line 1155–1158)
- Test: `src/persistence.test.ts`

**Interfaces:**
- Consumes: `IslandSpec.founderId` / lobe `founderId` (Task 1). `SerializedIslandSpec = Omit<IslandSpec, 'terrainAt'>` already carries both new fields through `serializeWorld`'s spread — no serializer change needed, only the version bump + backfill migration.
- Produces: `SCHEMA_VERSION = 33`; `SerializedSnapshotV32` type; `migrateV32toV33(s: SerializedSnapshotV32): SaveSnapshot`.

- [ ] **Step 1: Write the failing tests**

Add to `src/persistence.test.ts` (mirror the file's existing migration-test pattern — build a snapshot fixture, run the migration or `loadWorld`, assert):

```ts
describe('v32 → v33 migration (§2.5 founderId backfill)', () => {
  it('backfills founderId on artificial islands and artificial lobes; leaves natural untouched', () => {
    const v32 = {
      // start from the file's canonical minimal v32 snapshot fixture; islands below are the part under test
      world: {
        islands: [
          { id: 'home', name: 'home', biome: 'plains', cx: 0, cy: 0, majorRadius: 16, minorRadius: 16,
            populated: true, discovered: true, buildings: [], modifiers: [],
            extraEllipses: [
              { biome: 'desert', originId: 'gen-1-0', major: 10, minor: 10, rotation: 0, offsetX: 20, offsetY: 0 },
              { biome: 'plains', originId: 'art-2', major: 12, minor: 12, rotation: 0, offsetX: -20, offsetY: 0 },
            ] },
          { id: 'art-5', name: 'art-5', biome: 'coast', cx: 100, cy: 0, majorRadius: 6, minorRadius: 6,
            populated: true, discovered: true, buildings: [], modifiers: [], artificial: true },
        ],
      },
    } as unknown as SerializedSnapshotV32;
    const v33 = migrateV32toV33(v32);
    expect(v33.v).toBe(33);
    const [home, art5] = v33.world.islands as IslandSpec[];
    expect(home!.founderId).toBeUndefined();                       // natural island untouched
    expect(home!.extraEllipses![0]!.founderId).toBeUndefined();    // natural lobe untouched
    expect(home!.extraEllipses![1]!.founderId).toBe('home');       // artificial lobe → holder
    expect(art5!.founderId).toBe('art-5');                         // standalone artificial → own id
  });

  it('v33 round-trips founderId identically through serialize/load', () => {
    // Use the file's existing serialize→load round-trip helper (the pattern every
    // prior version bump added per the AGENTS.md migration checklist): build a
    // world containing an artificial island with founderId: 'home' and a merged
    // island whose extraEllipses carries { originId: 'art-7', founderId: 'home' },
    // run serializeWorld → loadWorld, and assert both founderId fields survive:
    //   expect(loaded.world.islands.find(i => i.id === 'art-9-9')!.founderId).toBe('home');
    //   expect(loaded.world.islands.find(i => i.id === 'merged')!.extraEllipses![0]!.founderId).toBe('home');
  });
});
```

The second test's body follows whatever serialize→load round-trip helper the file already uses for prior versions — write it concretely against that helper with the two assertions shown in the comment.

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run src/persistence.test.ts -t "v32"`
Expected: FAIL — `migrateV32toV33` / `SerializedSnapshotV32` not exported.

- [ ] **Step 3: Implement the bump + migration**

`src/persistence.ts`:

Line 79: `export const SCHEMA_VERSION = 33 as const;`

Line 87: append `33` to the `SUPPORTED_LOAD_VERSIONS` set literal.

Next to `migrateV31toV32` (~line 613), add:

```ts
export type SerializedSnapshotV32 = Omit<SaveSnapshot, 'v'> & { readonly v: 32 };

/** v32 → v33: §2.5 anti-leapfrog founder attribution. Backfill `founderId`
 *  on every artificial island (its own id — the true founder is unknowable
 *  historically; self-attribution is inert because an artificial island has
 *  0 natural constituents and can never found) and on every absorbed
 *  artificial lobe (the absorbing island's id). Natural islands and natural
 *  lobes are untouched. Never un-merges anything. */
export function migrateV32toV33(s: SerializedSnapshotV32): SaveSnapshot {
  return {
    ...s,
    v: 33 as const,
    world: {
      ...s.world,
      islands: s.world.islands.map((isl) => {
        const artificialSelf = (isl as { artificial?: boolean }).artificial === true;
        const hasFounder = (isl as { founderId?: string }).founderId !== undefined;
        return {
          ...isl,
          ...(artificialSelf && !hasFounder ? { founderId: isl.id } : {}),
          extraEllipses: isl.extraEllipses?.map((e) =>
            (e.originId ?? '').startsWith('art-') && (e as { founderId?: string }).founderId === undefined
              ? { ...e, founderId: isl.id }
              : e),
        };
      }),
    },
  } as unknown as SaveSnapshot;
}
```

In `loadWorld`'s migration walk (after the `v === 31` step at ~line 1158):

```ts
  if (snapshot.v === 32) {
    snapshot = migrateV32toV33(snapshot as unknown as SerializedSnapshotV32);
  }
```

- [ ] **Step 4: Run the full persistence suite**

Run: `npx vitest run src/persistence.test.ts`
Expected: PASS — new tests plus every pre-existing migration-chain test (v7…v31 fixtures must now land on v33; if any pre-existing test asserts a literal final version, point it at the exported `SCHEMA_VERSION` constant — never weaken the assertion).

- [ ] **Step 5: Typecheck + server suite sanity**

Run: `npx tsc -b --noEmit && cd server && npm run typecheck && cd ..`
Expected: no errors (server shares the persistence module; its save fixtures flow through the same chain).

- [ ] **Step 6: Commit**

```bash
git add src/persistence.ts src/persistence.test.ts
git commit -m "feat(persistence): schema v33 — founderId backfill migration (§2.5)

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 4: Wire the gate into all three surfaces (server intent, LOCAL gateway, construction UI)

**Files:**
- Modify: `server/src/game/intents.ts` (`construct-island` handler, after the `in-unknown-space` check at line 922–924; import block ~line 88)
- Modify: `src/mutation-gateway.ts` (LOCAL `constructIsland` at line 585–596; import at line 80)
- Modify: `src/construction-placement.ts` (`computePlacementValidity` + `ConstructPlacementReason` + `placementBlocksGhost`)
- Modify: `src/construction-ui.ts` (`REASON_LABEL` map, ~line 97–106)
- Test: `server/src/game/intents.test.ts` (`construct-island` describe at ~line 2632), `src/mutation-gateway.test.ts`, `src/construction-placement.test.ts`

**Interfaces:**
- Consumes: `validateArtificialPlacement`, `ArtificialPlacementReason` from `construction-gate.js` (Task 2 exact signatures).
- Produces: REMOTE and LOCAL reject with the same reason strings (`leapfrog-anchor` / `out-of-range` / `ratio-exceeded`); ghost reds on the two spatial reasons only.

- [ ] **Step 1: Write the failing tests**

`server/src/game/intents.test.ts`, inside the `describe('construct-island', …)` block (line ~2632) — follow the block's existing fixture pattern (it already builds a game with a founder island and asserts `position-occupied` / `in-unknown-space`; clone the nearest such test and adjust). Three cases:

```ts
it('rejects a placement inside a populated island\'s max-growth footprint (leapfrog-anchor)', async () => {
  // Founder plains island (current r ≤ 10) at (FCX, FCY), candidate r4 centred
  // 28 tiles out on the x-axis: clear of the CURRENT footprint (the existing
  // position-occupied gate passes) but overlapping the max-grown r28 reach.
  // Reveal the candidate cells the same way the block's happy-path test does.
  const r = await apply('construct-island', {
    founderIslandId: FOUNDER_ID, biome: 'plains', majorRadius: 4, minorRadius: 4,
    cx: FCX + 28, cy: FCY,
  });
  expect(r).toEqual({ ok: false, error: 'leapfrog-anchor' });
});

it('rejects a placement farther than 48 tiles from the founder (out-of-range)', async () => {
  // Candidate r4 at 120 tiles out: beyond every max-growth reach (anchor
  // passes) but bbox gap 120 − 10 − 4 = 106 > 48.
  const r = await apply('construct-island', {
    founderIslandId: FOUNDER_ID, biome: 'plains', majorRadius: 4, minorRadius: 4,
    cx: FCX + 120, cy: FCY,
  });
  expect(r).toEqual({ ok: false, error: 'out-of-range' });
});

it('rejects the build exceeding the 2×natural budget (ratio-exceeded)', async () => {
  // Push two already-attributed artificial specs into game.world.islands
  // (artificial: true, founderId: FOUNDER_ID, positioned far away and
  // unpopulated so they add no anchor footprint). Founder has 1 natural
  // constituent → budget 2 → the third build must fail on ratio at a spot
  // that is anchor- and range-legal (e.g. cx: FCX + 40 with arithmetic per
  // the construction-gate tests: 40 − 28 − 4 = 8 tiles clear of max-growth,
  // 40 − 10 − 4 = 26 ≤ 48 in range).
  const r = await apply('construct-island', {
    founderIslandId: FOUNDER_ID, biome: 'plains', majorRadius: 4, minorRadius: 4,
    cx: FCX + 40, cy: FCY,
  });
  expect(r).toEqual({ ok: false, error: 'ratio-exceeded' });
});
```

(`apply` / `FOUNDER_ID` / `FCX` / reveal-cells setup: use the names and helpers the surrounding `construct-island` tests actually use — the describe block is the template. Note the anchor-legal spot in the ratio test must ALSO have its cells revealed.)

`src/mutation-gateway.test.ts` — LOCAL/REMOTE parity, next to the file's existing `constructIsland` tests, same three scenarios through `gateway.constructIsland(...)`, asserting `{ ok: false, reason: 'leapfrog-anchor' }`, `'out-of-range'`, `'ratio-exceeded'` respectively (the LOCAL gateway surfaces the reason in `GatewayErr.reason`).

`src/construction-placement.test.ts`:

```ts
it('computePlacementValidity surfaces anti-leapfrog reasons after the spatial gates', () => {
  // Reuse the construction-gate anchor scenario through computePlacementValidity:
  // populated plains island r10 at origin (with state present in the islandStates
  // map), founder = that island, candidate r4 at (28, 0) with revealed cells →
  // expect { ok: false, reason: 'leapfrog-anchor' }.
});

it('placementBlocksGhost reds spatial anti-leapfrog reasons, not the budget one', () => {
  expect(placementBlocksGhost('leapfrog-anchor')).toBe(true);
  expect(placementBlocksGhost('out-of-range')).toBe(true);
  expect(placementBlocksGhost('ratio-exceeded')).toBe(false);
});
```

Write the first test's body concretely against the file's existing world/state fixture helpers (it already tests `position-occupied` / `in-unknown-space` — clone that shape).

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run src/mutation-gateway.test.ts src/construction-placement.test.ts && cd server && npm test -- -t "construct-island" && cd ..`
Expected: FAIL — the new reasons are never produced (gate not wired); `placementBlocksGhost('leapfrog-anchor')` is a TS error until the union widens (compile error = the failure signal there).

- [ ] **Step 3: Wire the three surfaces**

`server/src/game/intents.ts` — extend the line-88 import:

```ts
import { positionIsFree, regionDiscoveredOrVisible, validateArtificialPlacement } from '../../../src/construction-gate.js';
```

and in the `construct-island` handler, immediately after the `in-unknown-space` return (line 924):

```ts
      // §2.5 anti-leapfrog: anchor (max-growth reach), range (founder-local),
      // ratio (per-founder budget) — same pure gate the UI + LOCAL run.
      const anti = validateArtificialPlacement(game.world, founder.spec, cx, cy, majorRadius, minorRadius);
      if (!anti.ok) return { ok: false, error: anti.reason ?? 'placement invalid' };
```

`src/mutation-gateway.ts` — extend the line-80 import identically, and in LOCAL `constructIsland` immediately after the `in-unknown-space` return (line 596):

```ts
      const anti = validateArtificialPlacement(world, founder.spec, cx, cy, majorRadius, minorRadius);
      if (!anti.ok) return err(anti.reason ?? 'placement invalid', anti.reason);
```

`src/construction-placement.ts`:

```ts
import { positionIsFree, regionDiscoveredOrVisible, validateArtificialPlacement, type ArtificialPlacementReason } from './construction-gate.js';
```

```ts
export type ConstructPlacementReason =
  | ValidationReason
  | ArtificialPlacementReason
  | 'unknown-founder'
  | 'position-occupied'
  | 'in-unknown-space';
```

In `computePlacementValidity`, after the `in-unknown-space` return (line 49) and BEFORE `validateConstruction` (spatial precedence — extend the line-31 doc comment to name the anti-leapfrog gates):

```ts
  const anti = validateArtificialPlacement(world, spec, cand.cx, cand.cy, cand.major, cand.minor);
  if (!anti.ok) return { ok: false, reason: anti.reason };
```

In `placementBlocksGhost` (spatial reasons red the ghost; the ratio is a budget problem like `insufficient-materials`, ghost stays cyan):

```ts
export function placementBlocksGhost(reason: ConstructPlacementReason | undefined): boolean {
  return reason === 'position-occupied'
    || reason === 'in-unknown-space'
    || reason === 'radius-too-large'
    || reason === 'leapfrog-anchor'
    || reason === 'out-of-range';
}
```

`src/construction-ui.ts` — `REASON_LABEL` gains three entries (its `Record<ConstructPlacementReason, string>` type makes the compiler demand them):

```ts
  'leapfrog-anchor': 'Too close — an existing island could grow to reach here',
  'out-of-range': 'Too far from the founder island',
  'ratio-exceeded': 'Founder needs more natural land to support another artificial island',
```

- [ ] **Step 4: Run the wired tests**

Run: `npx vitest run src/mutation-gateway.test.ts src/construction-placement.test.ts src/construction-gate.test.ts && cd server && npm test -- -t "construct-island" && cd ..`
Expected: PASS, all files.

- [ ] **Step 5: Full typecheck**

Run: `npx tsc -b --noEmit && cd server && npm run typecheck && cd ..`
Expected: no errors.

- [ ] **Step 6: Commit**

```bash
git add server/src/game/intents.ts src/mutation-gateway.ts src/construction-placement.ts src/construction-ui.ts server/src/game/intents.test.ts src/mutation-gateway.test.ts src/construction-placement.test.ts
git commit -m "feat(construction): enforce anti-leapfrog gate on UI, LOCAL gateway, and server intent (§2.5)

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 5: SPEC.md update + full-suite verification

**Files:**
- Modify: `SPEC.md` (§2.5 after the Overlap-constraint paragraph at line 223; §3.6 merge-procedure bullets ~line 455–462; the §2.5 build-status row at line 21)
- No new tests (documentation + verification task).

**Interfaces:**
- Consumes: final behavior from Tasks 1–4 (constants, reason codes, metric definitions).
- Produces: SPEC.md as source of truth for the three constraints.

- [ ] **Step 1: Add the §2.5 constraint paragraphs**

Insert after the existing **Overlap constraint** paragraph (line 223), matching its voice:

```markdown
**Anti-leapfrog constraints (anchor + range + ratio).** Three further placement gates close the artificial-island leapfrog (pre-positioning a platform so an existing island merges it with one cheap reclamation step, then chaining outward). All three are pure predicates in `construction-gate.ts` (`validateArtificialPlacement`, reasons `leapfrog-anchor` / `out-of-range` / `ratio-exceeded`), re-run by the construction UI, the LOCAL mutation gateway, and the authoritative server `construct-island` intent, like the two gates above.

* **Anchor (`leapfrog-anchor`).** Placement is rejected when the candidate's inscribed footprint would touch or overlap the **max-growth footprint** of any populated island — every constituent rasterized at its own origin-biome `BIOME_MAX_RADII` caps rather than its current radii, hub or no hub (a Land Reclamation Hub can always be built later). The test reuses the §3.6 `islandsOverlap` tile machinery, so "the gap an existing island could ever close" and "the gap that triggers a merge" cannot disagree. Consequence: an existing island can never grow to swallow a freshly placed artificial island; the only path to that merge is growing the **new** island in — real reclamation investment. Unpopulated islands are exempt (they cannot grow).
* **Range (`out-of-range`).** The candidate must lie within `ARTIFICIAL_RANGE_TILES` (placeholder **48**, `construction-gate.ts`) of the **founder** island. Metric: the minimum Chebyshev gap between the candidate's bounding box and the nearest founder-constituent bounding box (`founderRangeGap`) — constituent extents, not centre distance, so a lobe stretching toward the candidate shortens the gap. Together with the anchor, the legal zone is a band: beyond every populated island's max-growth reach, yet within 48 tiles of the founder.
* **Founder ratio (`ratio-exceeded`).** A founder's **lifetime** artificial-creation count is capped at `ARTIFICIAL_RATIO` (**2**) × its **natural** constituent count. Natural constituents are those whose resolved `originId` does not begin `art-` (`naturalConstituentCount`); the lifetime count (`attributedArtificialCount`) tallies every artificial island anywhere whose `founderId` matches — standalone specs AND absorbed lobes, so merging a platform away never refunds budget. An artificial island has 0 natural constituents and can never found another. Absorbing more natural islands legitimately raises the ceiling.

**Implementation note — founder attribution (`founderId`, schema v33).** `constructIsland` stamps `IslandSpec.founderId` with the founder's id; a §3.6 merge copies it into the absorbed lobe's `extraEllipses` entry (alongside `originId`), so attribution survives the absorbed spec's removal from `world.islands`. The v32→v33 migration backfills `founderId` best-effort on existing saves: a standalone artificial island attributes to itself (inert — it can never found), an absorbed artificial lobe to its current holder. Known limitation, accepted: if the founder island is itself later merged away, its creations keep the original `founderId` and stop counting against the new host — the anchor and range gates still bound every individual placement, so this cannot re-open a cheap leapfrog.
```

- [ ] **Step 2: Add the §3.6 merge bullet**

In the §3.6 merge-procedure bullet list (lines ~455–462), after the constituent-storage bullet (line 455), add:

```markdown
* An absorbed artificial island's `founderId` is copied onto its lobe entry (and each propagated extra keeps its own), preserving §2.5 founder-ratio attribution across the merge.
```

- [ ] **Step 3: Update the SPEC build-status row**

Append to the §2.5 row's notes cell (SPEC.md line 21): `Anti-leapfrog placement gates: anchor (max-growth footprint), range (48 tiles of founder), founder ratio (2× natural constituents) — validateArtificialPlacement, construction-gate.ts.` Then grep SPEC.md for `v32` and update any statement claiming v32 is the *current* schema (the §4.5 conduit "persisted, schema v32" mention is historical — introduced in v32 — and stays as-is).

- [ ] **Step 4: Full verification**

```bash
npx tsc -b --noEmit && npm run build
cd server && npm run typecheck && cd ..
npm test
```

Expected: build green; both typechecks clean; full client+server suites pass (server needs the local Postgres, which is running).

- [ ] **Step 5: Commit**

```bash
git add SPEC.md
git commit -m "docs(spec): §2.5 anti-leapfrog constraints + §3.6 founderId propagation

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

## Completion

After Task 5, use superpowers:finishing-a-development-branch: rebase `anti-leapfrog` onto `master`, fast-forward merge (linear history per CONTRIBUTING.md — no merge commits), run `npm test` once more on master, push, and confirm `git rev-list --count @{u}..HEAD` is 0.
