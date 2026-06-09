# Active-Play Production Bonus Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A world-level recipe-rate buff that grows +0.1%/min while the tab is visible+focused and decays at −0.3%/min for all other wall-clock time (including game closed), floored at 0, uncapped.

**Architecture:** Pure accrual/decay module (`active-bonus.ts`) holding the math; `WorldState.activeBonusMs` balance; multiplier threaded into `computeRates` via `RatesContext.activeBonusMul` (same pattern as `ncBuff`, but world-level — every island); schema v21→v22; HUD row + inspector bonuses-line entry. Spec: `docs/superpowers/specs/2026-06-09-active-play-bonus-design.md`, SPEC.md §9.9 (added in Task 8).

**Tech Stack:** TypeScript strict, vitest. Pure layer only is tested (repo convention). Repo: `/root/robot-islands`.

**Conventions:** Run tests with `npx vitest run src/<file>.test.ts` (single file) or `npm test` (all). Every commit message ends with the trailer of the model that authored the commit, e.g. `Co-Authored-By: Kimi K2.6 <noreply@kimi.com>` for kimi subagents. Commit directly on `master` (repo policy: linear history, quick-fix track).

---

### Task 1: Pure module `active-bonus.ts`

**Files:**
- Create: `src/active-bonus.ts`
- Create: `src/active-bonus.test.ts`

- [ ] **Step 1: Write the failing tests**

Create `src/active-bonus.test.ts`:

```typescript
import { describe, expect, it } from 'vitest';
import {
  ACTIVE_BONUS_PER_MIN,
  ACTIVE_DECAY_RATIO,
  activeBonusMul,
  tickActiveBonus,
} from './active-bonus.js';
import { ONLINE_DT_CAP_MS } from './trade.js';

describe('tickActiveBonus (§9.9 accrual law)', () => {
  it('accrues focused frame dt 1:1', () => {
    const w = { activeBonusMs: 0 };
    tickActiveBonus(w, true, 1000);
    expect(w.activeBonusMs).toBe(1000);
  });

  it('clamps single-frame accrual at ONLINE_DT_CAP_MS and decays the excess (refocus after hidden gap)', () => {
    // While hidden, rAF stops; the whole gap arrives as one frameDt on the
    // refocus frame. Accrue at most the 3 s cap; the remainder decays at 3×.
    const w = { activeBonusMs: 600_000 };
    const gap = 60_000;
    tickActiveBonus(w, true, gap);
    expect(w.activeBonusMs).toBe(
      600_000 + ONLINE_DT_CAP_MS - ACTIVE_DECAY_RATIO * (gap - ONLINE_DT_CAP_MS),
    );
  });

  it('decays blurred-but-visible frames at 3×', () => {
    const w = { activeBonusMs: 10_000 };
    tickActiveBonus(w, false, 1000);
    expect(w.activeBonusMs).toBe(7000);
  });

  it('floors at 0', () => {
    const w = { activeBonusMs: 500 };
    tickActiveBonus(w, false, 60_000);
    expect(w.activeBonusMs).toBe(0);
  });

  it('treats a missing field as 0 (fixture back-compat)', () => {
    const w: { activeBonusMs?: number } = {};
    tickActiveBonus(w, true, 2000);
    expect(w.activeBonusMs).toBe(2000);
  });

  it('ignores zero and negative dt', () => {
    const w = { activeBonusMs: 123 };
    tickActiveBonus(w, true, 0);
    tickActiveBonus(w, false, -5);
    expect(w.activeBonusMs).toBe(123);
  });
});

describe('activeBonusMul', () => {
  it('is 1 at zero balance (and for a missing field)', () => {
    expect(activeBonusMul({ activeBonusMs: 0 })).toBe(1);
    expect(activeBonusMul({})).toBe(1);
  });

  it('is +0.1% per focused minute, uncapped', () => {
    expect(activeBonusMul({ activeBonusMs: 60_000 })).toBeCloseTo(1 + ACTIVE_BONUS_PER_MIN, 12);
    // 10 h of focused play → +60%
    expect(activeBonusMul({ activeBonusMs: 10 * 60 * 60_000 })).toBeCloseTo(1.6, 12);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run src/active-bonus.test.ts`
Expected: FAIL — `Cannot find module './active-bonus.js'` (or equivalent resolve error).

- [ ] **Step 3: Write the implementation**

Create `src/active-bonus.ts`:

```typescript
// §9.9 Active-Play Production Bonus — pure accrual/decay math.
//
// One unified rule: focused frame-dt accrues (clamped to ONLINE_DT_CAP_MS,
// the same clamp trade.ts uses so a gap can't dump time); every OTHER
// wall-clock millisecond decays the balance at ACTIVE_DECAY_RATIO×. The
// balance `activeBonusMs` is "effective focused milliseconds"; the derived
// recipe-rate multiplier is
//   1 + (activeBonusMs / 60_000) × ACTIVE_BONUS_PER_MIN
// i.e. +0.1% per focused minute, −0.3%/min away, floor 0, no cap (§9.9).
//
// The same rule covers every loss mode: a blurred-but-visible frame decays
// its full dt; a hidden-tab gap arrives as one large frameDt on the refocus
// frame (accrual clamps, the rest decays); a closed-game gap is charged at
// load by persistence.ts from the snapshot's savedAt.
//
// Pure layer: no PixiJS, no DOM. The caller supplies the online boolean
// (document.visibilityState === 'visible' && document.hasFocus() — computed
// in main.ts's ticker, shared with the trade lifecycle).

import { ONLINE_DT_CAP_MS } from './trade.js';

/** +0.1% recipe rate per focused minute (§9.9). */
export const ACTIVE_BONUS_PER_MIN = 0.001;

/** Unfocused wall-clock burns the balance at 3× the accrual rate
 *  (−0.3%/min). Also applied to closed-game gaps at load. */
export const ACTIVE_DECAY_RATIO = 3;

/** Minimal structural slice of WorldState this module touches — keeps the
 *  module decoupled and trivially testable. Optional field for legacy-save
 *  and test-fixture back-compat (same pattern as WorldState.tutorialState). */
export interface ActiveBonusCarrier {
  activeBonusMs?: number;
}

/** Advance the balance by one wall-clock interval of `frameDtMs`. `online` =
 *  tab visible AND focused. Accrual is clamped to ONLINE_DT_CAP_MS per call;
 *  the unaccrued remainder of the interval decays at ACTIVE_DECAY_RATIO×.
 *  Mutates `world.activeBonusMs`; no-op on non-positive dt. */
export function tickActiveBonus(
  world: ActiveBonusCarrier,
  online: boolean,
  frameDtMs: number,
): void {
  if (!(frameDtMs > 0)) return;
  const accrued = online ? Math.min(frameDtMs, ONLINE_DT_CAP_MS) : 0;
  const next =
    (world.activeBonusMs ?? 0) + accrued - ACTIVE_DECAY_RATIO * (frameDtMs - accrued);
  world.activeBonusMs = next > 0 ? next : 0;
}

/** Recipe-rate multiplier derived from the balance. ≥ 1, uncapped. */
export function activeBonusMul(world: ActiveBonusCarrier): number {
  return 1 + ((world.activeBonusMs ?? 0) / 60_000) * ACTIVE_BONUS_PER_MIN;
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run src/active-bonus.test.ts`
Expected: PASS (8 tests).

- [ ] **Step 5: Commit**

```bash
git add src/active-bonus.ts src/active-bonus.test.ts
git commit -m "feat(active-bonus): §9.9 pure accrual/decay module (+0.1%/min focused, −0.3%/min away)"
```
(Append the authoring model's Co-Authored-By trailer.)

---

### Task 2: `WorldState.activeBonusMs` + `makeInitialWorld` seed

**Files:**
- Modify: `src/world.ts` (interface `WorldState` ~line 683; `makeInitialWorld` return literal, function starts ~line 819)
- Modify: `src/active-bonus.test.ts` (append one describe)

- [ ] **Step 1: Write the failing test**

Append to `src/active-bonus.test.ts`:

```typescript
import { makeInitialWorld } from './world.js';

describe('makeInitialWorld §9.9 seed', () => {
  it('seeds activeBonusMs at 0', () => {
    expect(makeInitialWorld(0).activeBonusMs).toBe(0);
  });
});
```

(Place the import at the top of the file with the other imports.)

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/active-bonus.test.ts`
Expected: FAIL — `expected undefined to be 0` (TypeScript may also error on the unknown property; that's the same signal).

- [ ] **Step 3: Add the field and seed**

In `src/world.ts`, inside `interface WorldState` (after the `latticeNodeIslands: string[];` member, ~line 733):

```typescript
  /** §9.9 Active-Play Production Bonus balance — "effective focused
   *  milliseconds". Accrued/decayed by `tickActiveBonus` (active-bonus.ts);
   *  read via `activeBonusMul`. Optional so legacy saves and test fixtures
   *  compile without change; `makeInitialWorld` always seeds it. */
  activeBonusMs?: number;
```

In `makeInitialWorld`'s returned object literal (find the `latticeActive: false,` / `latticeNodeIslands: [],` seeds inside the function starting ~line 819), add alongside them:

```typescript
    activeBonusMs: 0,
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/active-bonus.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/world.ts src/active-bonus.test.ts
git commit -m "feat(world): WorldState.activeBonusMs balance, seeded 0 (§9.9)"
```
(Append the authoring model's Co-Authored-By trailer.)

---

### Task 3: `RatesContext.activeBonusMul` in economy.ts

**Files:**
- Modify: `src/economy.ts` (RatesContext ~line 122; destructure ~line 784; two `rateMul` products at ~lines 1071–1075 and ~1106–1110)
- Modify: `src/economy.test.ts` (new describe after `'NC buff integration'`, which ends ~line 1916)

- [ ] **Step 1: Write the failing test**

In `src/economy.test.ts`, after the `describe('NC buff integration', …)` block (~line 1916), add (reusing the file's existing `makeState`, `blankInventory`, `MINE`, `POWER_FREE` helpers — same ones the NC test at ~line 1897 uses):

```typescript
describe('§9.9 active-play bonus integration', () => {
  it('activeBonusMul scales recipe production multiplicatively', () => {
    // Mirror of the NC-buff test: identical islands, one advanced with
    // activeBonusMul 1.2 — production lands exactly 1.2×. Default (absent)
    // must behave identically to 1.
    const base = makeState({
      buildings: [MINE],
      inventory: blankInventory(),
      level: 10,
    });
    const boosted = makeState({
      buildings: [MINE],
      inventory: blankInventory(),
      level: 10,
    });
    advanceIsland(base, 100_000, { defs: POWER_FREE });
    advanceIsland(boosted, 100_000, { defs: POWER_FREE, activeBonusMul: 1.2 });
    expect(base.inventory.iron_ore).toBeCloseTo(5, 9);
    expect(boosted.inventory.iron_ore).toBeCloseTo(6, 9);
    // XP accrues on the boosted production (same as every rate buff).
    expect(boosted.xp).toBeGreaterThan(base.xp);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/economy.test.ts -t "active-play bonus"`
Expected: FAIL — TS error `'activeBonusMul' does not exist in type 'RatesContext'` (vitest surfaces it as a transform/type failure) or, if structurally tolerated, `expected 5 to be close to 6`.

- [ ] **Step 3: Implement**

In `src/economy.ts`:

(a) `RatesContext` — after the `readonly ncBuff?: number;` member (~line 122):

```typescript
  /** §9.9 active-play production bonus — world-level recipe-rate multiplier
   *  (`activeBonusMul(world)` in active-bonus.ts). Unlike `ncBuff`
   *  (per-island, networked T3+ only) this applies to EVERY island.
   *  Default 1 (no bonus). */
  readonly activeBonusMul?: number;
```

(b) `computeRates` destructure (~line 784) — add to the existing destructuring of `ctx`:

```typescript
    activeBonusMul = 1,
```

(c) Pass-1 rate product (~lines 1068–1075) — extend the comment and the product:

```typescript
    // Recipe-rate multipliers compose: skill-tree (per-category) × modifier
    // (per-category) × modifier (global) × NC global buff × §9.9 active-play
    // bonus. Identity bundles in any of the new factors contribute 1× so
    // existing callers see no change.
    const rateMul =
      (skillMul.recipeRate[recipe.category] ?? 1) *
      (modifierMul.recipeRateByCategory[recipe.category] ?? 1) *
      modifierMul.globalRecipeRate *
      ncBuff *
      activeBonusMul;
```

(d) Pass-2 rate product (~lines 1106–1110) — same extension (the comment there says "Same compound multiplier as Pass 1" — keep that true):

```typescript
    const rateMul =
      (skillMul.recipeRate[te.recipe.category] ?? 1) *
      (modifierMul.recipeRateByCategory[te.recipe.category] ?? 1) *
      modifierMul.globalRecipeRate *
      ncBuff *
      activeBonusMul;
```

`advanceIsland` forwards its `ctx` to `computeRates` already — no change there.

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run src/economy.test.ts`
Expected: PASS (full file — the new test plus no regressions).

- [ ] **Step 5: Commit**

```bash
git add src/economy.ts src/economy.test.ts
git commit -m "feat(economy): RatesContext.activeBonusMul recipe-rate factor (§9.9)"
```
(Append the authoring model's Co-Authored-By trailer.)

---

### Task 4: Persistence — schema v21 → v22, load-time decay

**Files:**
- Modify: `src/persistence.ts` (SCHEMA_VERSION line 75; SUPPORTED_LOAD_VERSIONS line 83; `SerializedWorld` interface ~line 132; serializeWorld world block ~line 700; migration block after `migrateV20toV21` ~line 600; dispatch chain ~line 791; deserializeWorld world assembly ~line 904)
- Modify: `src/persistence.test.ts`

- [ ] **Step 1: Write the failing tests**

Add to `src/persistence.test.ts` (mirror the existing v20→v21 migration tests at ~line 2324 for fixture style; import `migrateV21toV22` alongside `migrateV20toV21` in the import block at ~line 55, and import `ACTIVE_DECAY_RATIO` from `./active-bonus.js`):

```typescript
describe('schema v22 — activeBonusMs (§9.9)', () => {
  it('migrateV21toV22 seeds world.activeBonusMs = 0 and bumps v', () => {
    const v21 = {
      v: 21,
      savedAt: 1_000,
      savedAtPerf: 500,
      world: { tutorialState: undefined },
    } as unknown as Parameters<typeof migrateV21toV22>[0];
    const out = migrateV21toV22(v21);
    expect(out.v).toBe(22);
    expect((out.world as { activeBonusMs?: number }).activeBonusMs).toBe(0);
  });

  it('round-trips activeBonusMs through serialize/deserialize with closed-gap decay', () => {
    const world = makeInitialWorld(0);
    world.activeBonusMs = 600_000; // 10 focused minutes banked
    const snap = serializeWorld(world, new Map(), 1_000_000, 500);
    expect(snap.v).toBe(22);
    expect(snap.world.activeBonusMs).toBe(600_000);
    // Reload 1 minute of wall-clock later: decay 3 × 60_000.
    const { world: loaded } = deserializeWorld(snap, 1_000_000 + 60_000, 9_999);
    expect(loaded.activeBonusMs).toBe(600_000 - ACTIVE_DECAY_RATIO * 60_000);
  });

  it('floors load-time decay at 0 (overnight gap)', () => {
    const world = makeInitialWorld(0);
    world.activeBonusMs = 600_000;
    const snap = serializeWorld(world, new Map(), 1_000_000, 500);
    const eightHours = 8 * 3600 * 1000;
    const { world: loaded } = deserializeWorld(snap, 1_000_000 + eightHours, 9_999);
    expect(loaded.activeBonusMs).toBe(0);
  });

  it('a v21 snapshot (no activeBonusMs) loads with 0', () => {
    const world = makeInitialWorld(0);
    const snap = serializeWorld(world, new Map(), 1_000_000, 500);
    const v21 = {
      ...snap,
      v: 21,
      world: { ...snap.world, activeBonusMs: undefined },
    } as unknown as SaveSnapshot;
    const { world: loaded } = deserializeWorld(v21, 1_000_000, 9_999);
    expect(loaded.activeBonusMs).toBe(0);
  });
});
```

(If `makeInitialWorld` / `serializeWorld` / `deserializeWorld` / `SaveSnapshot` aren't already imported in this test file, add them; they almost certainly are — check the import block first.)

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run src/persistence.test.ts -t "schema v22"`
Expected: FAIL — `migrateV21toV22` is not exported.

- [ ] **Step 3: Implement the bump**

In `src/persistence.ts`, six edits:

(a) Line 75: `export const SCHEMA_VERSION = 22 as const;`

(b) Line 83: append `22` to the set: `… 19, 20, 21, 22]);`

(c) `SerializedWorld` interface (~line 132, near `readonly latticeActive?: boolean;` at line 153):

```typescript
  /** §9.9 active-play bonus balance (effective focused ms). Optional:
   *  absent on pre-v22 saves; load decays it for the closed gap. */
  readonly activeBonusMs?: number;
```

(d) serializeWorld world block — next to `latticeActive: world.latticeActive,` (~line 702):

```typescript
      activeBonusMs: world.activeBonusMs ?? 0,
```

(e) Migration — `migrateV20toV21` (~line 590) currently returns `SaveSnapshot` with `v: 21 as const`; retype it to the new alias, then add the new migration after it (mirror the `migrateV19toV20` / `SerializedSnapshotV20` precedent at lines 570–583):

```typescript
export function migrateV20toV21(s: SerializedSnapshotV20): SerializedSnapshotV21 {
  const ts = s.world.tutorialState;
  return {
    ...s,
    v: 21 as const,
    world: {
      ...s.world,
      tutorialState: ts ? { ...ts, xpBumpClaimed: ts.xpBumpClaimed ?? ts.completed } : ts,
    },
  } as unknown as SerializedSnapshotV21;
}

export type SerializedSnapshotV21 = Omit<SaveSnapshot, 'v'> & { readonly v: 21 };

/** v21 -> v22: §9.9 active-play production bonus shipped. A v21 save lacks
 *  `world.activeBonusMs`; seed 0 (no accrued bonus). */
export function migrateV21toV22(s: SerializedSnapshotV21): SaveSnapshot {
  return {
    ...s,
    v: 22 as const,
    world: { ...s.world, activeBonusMs: 0 },
  } as unknown as SaveSnapshot;
}
```

(f) Dispatch chain in `deserializeWorld` (~line 791) — the v20 step now returns the alias, so cast it like the older steps do, and add the v21 step:

```typescript
  if ((snapshot as unknown as { v: number }).v === 20) {
    snapshot = migrateV20toV21(snapshot as unknown as SerializedSnapshotV20) as unknown as SaveSnapshot;
  }
  if ((snapshot as unknown as { v: number }).v === 21) {
    snapshot = migrateV21toV22(snapshot as unknown as SerializedSnapshotV21);
  }
```

(g) deserializeWorld world assembly (~line 904, next to `latticeActive: snapshot.world.latticeActive ?? false,`) — apply the closed-gap decay using the `deltaMs` already computed at ~line 805 (`const deltaMs = Math.max(0, nowWallMs - snapshot.savedAt);`):

```typescript
    // §9.9: the closed-game gap is unfocused time — burn the balance at the
    // decay ratio before offline catch-up runs, so catch-up production uses
    // the post-decay multiplier.
    activeBonusMs: Math.max(
      0,
      (snapshot.world.activeBonusMs ?? 0) - ACTIVE_DECAY_RATIO * deltaMs,
    ),
```

Add the import at the top of persistence.ts: `import { ACTIVE_DECAY_RATIO } from './active-bonus.js';`

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run src/persistence.test.ts`
Expected: PASS (new describe + zero regressions in the rest of the file — the v-bump must not break existing round-trip tests; if any hardcode `v: 21` expectations for CURRENT version, update them to 22, but leave historical-fixture tests alone).

- [ ] **Step 5: Commit**

```bash
git add src/persistence.ts src/persistence.test.ts
git commit -m "feat(persistence): schema v21->v22 persists activeBonusMs; closed-gap decay at load (§9.9)"
```
(Append the authoring model's Co-Authored-By trailer.)

---

### Task 5: main.ts wiring (ticker + 5 RatesContext sites)

**Files:**
- Modify: `src/main.ts`

No new tests (render/wiring layer is untested by repo convention); the gate is the full suite + build.

- [ ] **Step 1: Wire the per-frame tick**

In `src/main.ts`:

(a) Add to the import block (near the `./trade.js` imports):

```typescript
import { activeBonusMul, tickActiveBonus } from './active-bonus.js';
```

(b) In the ticker, directly after the existing lines (~1908–1909):

```typescript
    const tradeOnline = document.visibilityState === 'visible' && document.hasFocus();
    const onlineDtMs = tradeOnline ? Math.min(elapsedSec * 1000, ONLINE_DT_CAP_MS) : 0;
```

add:

```typescript
    // §9.9 active-play bonus: same online condition as trades; the module
    // internally clamps accrual and decays the unfocused remainder, so the
    // RAW frame dt goes in (NOT onlineDtMs — decay needs the full interval).
    tickActiveBonus(worldState, tradeOnline, elapsedSec * 1000);
```

- [ ] **Step 2: Thread the multiplier into all five RatesContext sites**

Find every `ncBuff:` occurrence in `src/main.ts` (exactly 5 context-literal sites: the `cableLocalCtxFor` closure ~line 1829, the `advanceIsland` call ~line 1869, the post-advance `computeRates` ~line 1888, the post-tick active-island `computeRates` ~line 2031, and the lattice active-island refresh ~line 2059). Next to each `ncBuff: …,` line add:

```typescript
        activeBonusMul: activeBonusMul(worldState),
```

- [ ] **Step 3: Verify**

Run: `npm test`
Expected: all pass (2860+ tests).
Run: `npm run build`
Expected: tsc strict clean, vite build succeeds.

- [ ] **Step 4: Commit**

```bash
git add src/main.ts
git commit -m "feat(main): tick §9.9 active bonus on the trade online signal; thread activeBonusMul into all RatesContext sites"
```
(Append the authoring model's Co-Authored-By trailer.)

---

### Task 6: HUD "Active bonus" row

**Files:**
- Modify: `src/hud.ts` (`mountHud` signature ~line 483; per-island body render where the Signal Exchange countdown block lives ~line 649)

No new tests (DOM layer). Gate: full suite + build.

- [ ] **Step 1: Implement**

(a) `mountHud`'s second parameter is currently unused: `_world: WorldState` (line 485). Rename it to `world` (it's about to be used; `noUnusedParameters` requires the underscore only while unused).

(b) Add the import: `import { activeBonusMul } from './active-bonus.js';`

(c) In the body-render function, directly after the Signal Exchange next-offer block (`if (islandHasSignalExchange(state)) { … }`, ~lines 649–671) and before the `// ---- Output rates section` comment, add:

```typescript
    // ---- §9.9 active-play bonus -------------------------------------------
    // World-level: every focused minute adds +0.1% to every recipe on every
    // island; decays at 3× while away (including closed). Always rendered so
    // the mechanic is discoverable; "—" reads as "no bonus right now".
    const abKv = document.createElement('div');
    abKv.classList.add('ri-kv');
    const abK = document.createElement('span');
    abK.classList.add('ri-kv__k');
    abK.textContent = 'Active bonus';
    const abV = document.createElement('span');
    abV.classList.add('ri-kv__v');
    const abFrac = activeBonusMul(world) - 1;
    abV.textContent = abFrac > 0 ? `+${(abFrac * 100).toFixed(1)}%` : '—';
    abKv.appendChild(abK);
    abKv.appendChild(abV);
    body.appendChild(abKv);
```

(If the body-render function doesn't close over the `world` param, thread it the same way the existing render closure receives `state` — check how the Signal Exchange block gets its data and mirror it.)

- [ ] **Step 2: Verify**

Run: `npm test && npm run build`
Expected: green + clean build.

- [ ] **Step 3: Commit**

```bash
git add src/hud.ts
git commit -m "feat(hud): always-visible Active bonus row (§9.9)"
```
(Append the authoring model's Co-Authored-By trailer.)

---

### Task 7: Inspector bonuses-line entry

**Files:**
- Modify: `src/inspector-ui.ts` (bonuses readout ~lines 1343–1365)

No new tests (DOM layer). Gate: full suite + build.

- [ ] **Step 1: Implement**

(a) Add `activeBonusMul` to the imports (there is an existing `./economy.js` import at line 40; this one comes from `./active-bonus.js`):

```typescript
import { activeBonusMul } from './active-bonus.js';
```

(b) In the bonuses readout (~lines 1346–1362), the code currently reads:

```typescript
      const fledgMul = fledglingRecipeMul(state.level);
      const compositeMul = catMul * mineLogBonus * fledgMul * clusterMul;
      if (compositeMul > 1.0001) {
        const parts: string[] = [];
        if (fledgMul > 1.0001) parts.push(`fledgling ×${fledgMul.toFixed(2)}`);
        ...
```

Change it to include the active-play factor (it genuinely scales the rate via RatesContext, so the composite must include it to stay truthful):

```typescript
      const fledgMul = fledglingRecipeMul(state.level);
      // §9.9 active-play bonus — world-level, applies to every recipe.
      const activeMul = activeBonusMul(deps.world);
      const compositeMul = catMul * mineLogBonus * fledgMul * clusterMul * activeMul;
      if (compositeMul > 1.0001) {
        const parts: string[] = [];
        if (fledgMul > 1.0001) parts.push(`fledgling ×${fledgMul.toFixed(2)}`);
        if (catMul > 1.0001) parts.push(`${recipe.category} ×${catMul.toFixed(2)}`);
        if (mineLogBonus > 1.0001) parts.push(`yield ×${mineLogBonus.toFixed(2)}`);
        if (clusterMul > 1.0001) parts.push(`cluster ×${clusterMul.toFixed(2)}`);
        if (activeMul > 1.0001) parts.push(`active ×${activeMul.toFixed(2)}`);
        bonusesValue.textContent = parts.join(' · ') + ` = ×${compositeMul.toFixed(2)}`;
```

(`deps.world: WorldState` already exists on `InspectorDeps` — line ~174.)

- [ ] **Step 2: Verify**

Run: `npm test && npm run build`
Expected: green + clean build.

- [ ] **Step 3: Commit**

```bash
git add src/inspector-ui.ts
git commit -m "feat(inspector): active ×N.NN entry in recipe bonuses line (§9.9)"
```
(Append the authoring model's Co-Authored-By trailer.)

---

### Task 8: SPEC.md §9.9 + status-table row + final verification

**Files:**
- Modify: `SPEC.md`

- [ ] **Step 1: Add §9.9**

Insert immediately BEFORE the line `## 10\. Funneling (Patron-Protégé)` (line ~1306):

```markdown
### 9.9 Active-Play Production Bonus

A global recipe-rate buff that rewards focused presence, complementing §9.8's online-only trade cadence. Every focused minute adds **+0.1%** to every recipe rate on **every** island; every unfocused minute — alt-tabbed, minimized, or with the game closed — burns the accrued bonus at **−0.3%/min**, floored at 0. There is no cap: decay is the only counterweight (an overnight gap erases any realistic balance, so in practice this is a same-session mechanic despite being persisted).

* **Focus condition** — identical to §9.8.3 trading: `document.visibilityState === 'visible' && document.hasFocus()`. "Covered but focused" is not JS-detectable; accepted limit.
* **State** — `WorldState.activeBonusMs`, a balance of "effective focused milliseconds". Bonus fraction = `activeBonusMs / 60000 × 0.001`; the multiplier `1 + fraction` threads into `computeRates` as `RatesContext.activeBonusMul` alongside `ncBuff`. XP accrues on the boosted production, like every rate buff. Unlike `ncBuff` (networked T3+ only) it applies to every island.
* **Accrual law** — one rule covers every loss mode: focused frame-dt accrues (clamped to the §9.8.3 3 s online-dt cap); every other wall-clock millisecond decays at 3×. A hidden-tab gap (rAF stops) is charged on the refocus frame; a closed-game gap is charged at load from the snapshot's `savedAt`, before offline catch-up runs — catch-up production uses the post-decay multiplier.
* **Sampling** — the multiplier drifts 0.1%/min, so it is sampled per advance call as a constant; §15.3's constant-rate piecewise integration is unaffected.
* **UI** — the HUD economy panel shows an always-visible "Active bonus" row (`+X.X%`, `—` at 0); the inspector recipe bonuses line appends `active ×N.NN` when above 1.
* **Persistence** — schema v22 (`activeBonusMs`; v21 saves migrate with 0).

Source of truth: `src/active-bonus.ts`.
```

- [ ] **Step 2: Add the status-table row**

In the implementation-status table near the top of SPEC.md, find the row starting `| §9.8` and insert after it:

```markdown
| §9.9 Active-play production bonus | L | +0.1%/min focused, −0.3%/min away (incl. closed), floor 0, no cap; world-level recipe-rate multiplier, schema v22. |
```

(If no §9.8 row exists, insert after the `| §9.6 Network Consciousness` row instead.)

- [ ] **Step 3: Final verification**

Run: `npm test`
Expected: full suite green.
Run: `npm run build`
Expected: clean.

- [ ] **Step 4: Commit**

```bash
git add SPEC.md
git commit -m "docs(spec): §9.9 Active-Play Production Bonus"
```
(Append the authoring model's Co-Authored-By trailer.)

---

## Self-review notes (already applied)

- Spec coverage: state ✓ (T2), accrual law ✓ (T1), economy ✓ (T3), persistence + load decay ✓ (T4), wiring ✓ (T5), HUD ✓ (T6), inspector ✓ (T7), SPEC §9.9 ✓ (T8).
- Type consistency: `tickActiveBonus(world, online, frameDtMs)` / `activeBonusMul(world)` / `ACTIVE_BONUS_PER_MIN` / `ACTIVE_DECAY_RATIO` used identically across T1/T4/T5/T6/T7. `activeBonusMs` optional everywhere (`?? 0` reads) — matches the `tutorialState` back-compat pattern and avoids breaking WorldState fixture literals.
- Known empirical anchor: the NC-buff test's baseline (Mine, level 10, 100 s → exactly 5 iron_ore with POWER_FREE defs) is reused in T3; if that baseline ever shifts, mirror whatever the NC test asserts.
