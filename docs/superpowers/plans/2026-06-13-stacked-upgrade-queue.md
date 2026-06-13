# Building Refactor Implementation Plan — stacked upgrade queue (#31) + temporary floor disabling

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Two bundled building mechanics on one branch (they share building fields, the #35 cluster capacity, the floor-effect multipliers, and one persistence bump):
- **Part 1 (#31):** queue multiple floor upgrades on one building — extra upgrades go to the build queue (not a second parallel slot), keep the building producing until they start, run sequentially. Also folds in: upgrades honor the Swarm Assembly construction-speed skill.
- **Part 2 (floor disabling):** replace the binary Disable button with a free, instantly-reversible **active-floor count** in `[0, built]` that scales throughput / power / storage capacity / cluster contribution; `0` active = the old "disabled".

**Architecture:** Part 1 adds `IslandState.buildJobs: BuildJob[]` (queued upgrade jobs); running construction state stays on the building so the 27 `isOperationalBuilding` call-sites etc. are unchanged. Part 2 replaces `PlacedBuilding.disabled` with `disabledFloors` (count from the top); `activeFloors === 0` reuses the existing operational/cluster gates so the disabled behavior follows automatically. ONE schema bump v23→v24 covers both.

**Tech Stack:** Vite 5 + TypeScript strict + PixiJS 8 + vitest. Pure-layer TDD; `npx vitest run <file>` for single files.

**Design doc:** `docs/superpowers/specs/2026-06-13-stacked-upgrade-queue-design.md`

**Branch:** `feat/stacked-upgrade-queue` (already cut from master; design doc already committed there).

---

## File structure

- **Modify** `src/economy.ts` — add `BuildJob` interface + `IslandState.buildJobs?: BuildJob[]` field.
- **Modify** `src/placement.ts` — `countQueuedUpgrades`/`topUpgradeLevel` helpers; rewrite `applyUpgrade` queueing branch; `queuedBuildCount` includes `buildJobs`; rewrite `promoteQueuedBuilds` (merged FIFO); `cancelConstruction` LIFO upgrade-cancel; demolish purges jobs.
- **Modify** `src/persistence.ts` — schema v23→v24: `SerializedSnapshotV23` alias, `migrateV23toV24`, wire into `loadWorld`, `SUPPORTED_LOAD_VERSIONS`, serialise `buildJobs`.
- **Modify** `src/build-queue-ui.ts` — render one row per queued upgrade job (keyed by `seq`).
- **Modify** `src/inspector-ui.ts` — Upgrade button enabled while constructing; show queued count; cost for next target floor.
- **Modify** `src/main.ts` — relax the upgrade-action no-op-while-constructing guard.
- **Modify** `SPEC.md` — §4.8 and §9.3.
- **Tests:** `src/placement.test.ts`, `src/economy.test.ts`, `src/persistence.test.ts`.

---

## Task 1: `BuildJob` type + `IslandState.buildJobs` field + `disabledFloors` field

**Files:**
- Modify: `src/economy.ts` (the `IslandState` interface, ~lines 271–390)
- Modify: `src/buildings.ts` (the `PlacedBuilding` interface, ~lines 26–160)

- [ ] **Step 1: Add the `BuildJob` interface and the field.** In `src/economy.ts`, immediately above the `IslandState` interface, add:

```ts
/**
 * §4.8 a single QUEUED floor-upgrade job that has not started running yet —
 * one pending upgrade for `buildingId`, beyond whatever upgrade (if any) is
 * currently RUNNING on that building. Ordered globally by `seq` (sourced from
 * `IslandState.nextQueueSeq`) for FIFO promotion. A queued upgrade does NOT
 * set the building's `constructionRemainingMs`, so the building keeps producing
 * at its completed floor until the job promotes to running (`promoteQueuedBuilds`).
 * Cost is paid at enqueue time. `kind` is a union for forward-compat; only
 * 'upgrade' stacks today (placements never stack).
 */
export interface BuildJob {
  readonly seq: number;
  readonly buildingId: string;
  readonly kind: 'upgrade';
}
```

Then inside `IslandState`, next to `nextQueueSeq`, add:

```ts
  /** §4.8 queued upgrade jobs (see `BuildJob`). Optional; absent ≡ [] for
   *  forward-compat with pre-v24 saves. Mutated by `applyUpgrade` (enqueue),
   *  `promoteQueuedBuilds` (dequeue→running), and `cancelConstruction` (LIFO). */
  buildJobs?: BuildJob[];
```

- [ ] **Step 2: Add the `disabledFloors` field (Part 2).** In `src/buildings.ts`, inside `PlacedBuilding`, next to the existing `disabled?: boolean` field (keep `disabled` for now — it is removed in Task 14 once all consumers are migrated), add:

```ts
  /** §NEW temporary floor-disable: how many of the building's BUILT floors are
   *  switched off, counted from the top. 0 / absent = all built floors active
   *  (full effect); equal to displayedFloorLevel = fully disabled (the old
   *  `disabled === true`). Free + instantly reversible; scales throughput /
   *  power / storage capacity / §4.5 cluster contribution by the ACTIVE floor
   *  count (`activeFloorLevel` in buildings.ts). */
  disabledFloors?: number;
```

- [ ] **Step 3: Typecheck.**

Run: `npx tsc -b`
Expected: no errors.

- [ ] **Step 4: Commit.**

```bash
git add src/economy.ts src/buildings.ts
git commit -m "feat(building): add BuildJob/buildJobs (#31) + disabledFloors field"
```

---

## Task 2: queue helpers in `placement.ts`

**Files:**
- Modify: `src/placement.ts` (near `queuedBuildCount`, ~line 533)
- Test: `src/placement.test.ts`

- [ ] **Step 1: Write failing tests.** Append to `src/placement.test.ts` (import `countQueuedUpgrades`, `topUpgradeLevel` from `./placement.js`, and `BuildJob` is in `./economy.js`). Use the file's existing island/state test helpers (search the file for how it builds an `IslandState` + `IslandSpec` — reuse that). Minimal shape:

```ts
describe('queued-upgrade helpers (#31)', () => {
  it('countQueuedUpgrades counts only this building’s jobs', () => {
    const state = { buildJobs: [
      { seq: 1, buildingId: 'a', kind: 'upgrade' as const },
      { seq: 2, buildingId: 'b', kind: 'upgrade' as const },
      { seq: 3, buildingId: 'a', kind: 'upgrade' as const },
    ] } as unknown as import('./economy.js').IslandState;
    expect(countQueuedUpgrades(state, 'a')).toBe(2);
    expect(countQueuedUpgrades(state, 'b')).toBe(1);
    expect(countQueuedUpgrades(state, 'c')).toBe(0);
  });

  it('countQueuedUpgrades handles missing buildJobs', () => {
    const state = {} as unknown as import('./economy.js').IslandState;
    expect(countQueuedUpgrades(state, 'a')).toBe(0);
  });

  it('topUpgradeLevel = rawFloorLevel + queued upgrade count', () => {
    const state = { buildJobs: [
      { seq: 1, buildingId: 'a', kind: 'upgrade' as const },
      { seq: 3, buildingId: 'a', kind: 'upgrade' as const },
    ] } as unknown as import('./economy.js').IslandState;
    // building 'a' at raw floor 1 (one running upgrade pre-bump) + 2 queued = 3
    expect(topUpgradeLevel(state, { id: 'a', floorLevel: 1 })).toBe(3);
    expect(topUpgradeLevel(state, { id: 'z', floorLevel: 0 })).toBe(0);
  });
});
```

- [ ] **Step 2: Run to verify failure.**

Run: `npx vitest run src/placement.test.ts -t "queued-upgrade helpers"`
Expected: FAIL — `countQueuedUpgrades is not a function`.

- [ ] **Step 3: Implement helpers.** In `src/placement.ts`, after `queuedBuildCount` (~line 539), add:

```ts
/** §4.8 number of QUEUED (not-yet-running) upgrade jobs for `buildingId`. */
export function countQueuedUpgrades(state: IslandState, buildingId: string): number {
  let n = 0;
  for (const j of state.buildJobs ?? []) if (j.buildingId === buildingId) n++;
  return n;
}

/** §4.8 the highest RAW floor level a building is heading toward: its current
 *  rawFloorLevel (which already includes any running upgrade's pre-bumped
 *  target) plus every queued upgrade for it. The next upgrade's target DISPLAYED
 *  floor is `topUpgradeLevel + 2` (raw→raw+1, displayed = raw+1). */
export function topUpgradeLevel(state: IslandState, b: { id: string; floorLevel?: number }): number {
  return rawFloorLevel(b) + countQueuedUpgrades(state, b.id);
}
```

- [ ] **Step 4: Run to verify pass.**

Run: `npx vitest run src/placement.test.ts -t "queued-upgrade helpers"`
Expected: PASS.

- [ ] **Step 5: Commit.**

```bash
git add src/placement.ts src/placement.test.ts
git commit -m "feat(queue): countQueuedUpgrades + topUpgradeLevel helpers (#31)"
```

---

## Task 2b: upgrade construction honors construction speed (Swarm Assembly)

> Folds in the approved fix: today `upgradeConstructionMs` ignores `skillMul.constructionTime` (the Swarm Assembly multiplier), so upgrades don't speed up while fresh placements do. Make upgrades honor it too.

**Files:**
- Modify: `src/construction.ts` — `upgradeConstructionMs` (~42)
- Test: `src/construction.test.ts`

- [ ] **Step 1: Write failing tests.** Append to `src/construction.test.ts` (it already imports `upgradeConstructionMs` + `BASE_CONSTRUCTION_MS_BY_TIER` and builds a `def`; reuse those):

```ts
describe('upgradeConstructionMs honors construction speed (#31 / Swarm Assembly)', () => {
  it('defaults to raw base × (level+1) when no multiplier given', () => {
    const def = { tier: 1 } as never; // base 30_000
    expect(upgradeConstructionMs(def, 1)).toBe(30_000 * 2);
  });
  it('divides the raw duration by the construction-time multiplier', () => {
    const def = { tier: 1 } as never;
    expect(upgradeConstructionMs(def, 1, 2)).toBe(Math.round(30_000 * 2 / 2));
    expect(upgradeConstructionMs(def, 0, 4)).toBe(Math.round(30_000 * 1 / 4));
  });
  it('treats a non-positive multiplier as no speedup', () => {
    const def = { tier: 1 } as never;
    expect(upgradeConstructionMs(def, 1, 0)).toBe(30_000 * 2);
  });
});
```

- [ ] **Step 2: Run to verify failure.**

Run: `npx vitest run src/construction.test.ts -t "honors construction speed"`
Expected: FAIL — `upgradeConstructionMs` takes 2 args / ignores the 3rd.

- [ ] **Step 3: Add the optional multiplier.** Replace `upgradeConstructionMs` in `src/construction.ts`:

```ts
/** Upgrade construction time for raising a building to `level` (the NEW level).
 *  Scales as base × (level + 1), so the L9 upgrade takes 10× base, then divides
 *  by the Robotics `constructionTimeMul` (Swarm Assembly) exactly like a fresh
 *  placement (`constructionTimeFor`) — a non-positive multiplier means no
 *  speedup. */
export function upgradeConstructionMs(
  def: BuildingDef,
  level: number,
  constructionTimeMul: number = 1,
): number {
  const base = BASE_CONSTRUCTION_MS_BY_TIER[def.tier];
  const raw = base * (level + 1);
  if (constructionTimeMul <= 0) return raw;
  return Math.round(raw / constructionTimeMul);
}
```

- [ ] **Step 4: Run to verify pass.**

Run: `npx vitest run src/construction.test.ts`
Expected: PASS (existing 2-arg call sites still compile — the 3rd param is optional).

- [ ] **Step 5: Commit.**

```bash
git add src/construction.ts src/construction.test.ts
git commit -m "feat(construction): upgrades honor Swarm Assembly construction speed (#31)"
```

---

## Task 3: `applyUpgrade` queues instead of rejecting; `queuedBuildCount` includes jobs

**Files:**
- Modify: `src/placement.ts` — `queuedBuildCount` (~533), `applyUpgrade` (~918–966), `UpgradeResult` reason union (~889–902)
- Test: `src/placement.test.ts`

- [ ] **Step 1: Write failing tests.** Append to `src/placement.test.ts`, reusing the file's island/state builder. Cover: (a) upgrading a building that is already RUNNING an upgrade enqueues a job rather than returning `'already-building'`; (b) a second stack enqueues a second job with a higher seq; (c) each enqueue charges `upgradeCost(def, topDisplayed)` for the ascending target; (d) `queue-full` when combined queue is full; (e) insufficient resources still rejected.

```ts
describe('applyUpgrade stacking (#31)', () => {
  it('queues a second upgrade instead of rejecting while one is running', () => {
    const { spec, state } = makeUpgradeScene(); // helper: 1 operational building, rich inventory
    const id = spec.buildings[0]!.id;
    expect(applyUpgrade(spec, state, id).ok).toBe(true);   // starts running (slot free)
    expect((spec.buildings[0]!.constructionRemainingMs ?? 0) > 0).toBe(true);
    const r2 = applyUpgrade(spec, state, id);              // was 'already-building'
    expect(r2.ok).toBe(true);
    expect(countQueuedUpgrades(state, id)).toBe(1);
  });

  it('stacks multiple and charges ascending target costs', () => {
    const { spec, state } = makeUpgradeScene();
    const id = spec.buildings[0]!.id;
    const def = BUILDING_DEFS[spec.buildings[0]!.defId];
    applyUpgrade(spec, state, id); // running, target displayed 2
    applyUpgrade(spec, state, id); // queued, target displayed 3
    applyUpgrade(spec, state, id); // queued, target displayed 4
    expect(countQueuedUpgrades(state, id)).toBe(2);
    // seqs strictly increasing
    const seqs = state.buildJobs!.filter((j) => j.buildingId === id).map((j) => j.seq);
    expect(seqs).toEqual([...seqs].sort((a, b) => a - b));
  });

  it('rejects queue-full when the combined queue is full', () => {
    const { spec, state } = makeUpgradeScene();
    const id = spec.buildings[0]!.id;
    // fill running + queue: 1 running upgrade + queuedBuildSlots queued
    applyUpgrade(spec, state, id);
    for (let i = 0; i < queuedBuildSlots(state); i++) expect(applyUpgrade(spec, state, id).ok).toBe(true);
    expect(applyUpgrade(spec, state, id)).toMatchObject({ ok: false, reason: 'queue-full' });
  });
});
```

> NOTE for implementer: if `makeUpgradeScene` does not already exist in the test file, add a small local helper that builds an `IslandSpec` + `IslandState` with one operational T1 building (e.g. a `mine`) at floor 0, `constructionRemainingMs` absent, and an inventory generous enough for several upgrades (copy the pattern other `placement.test.ts` upgrade tests use; search for existing `applyUpgrade(` tests).

- [ ] **Step 2: Run to verify failure.**

Run: `npx vitest run src/placement.test.ts -t "applyUpgrade stacking"`
Expected: FAIL (second `applyUpgrade` returns `already-building`).

- [ ] **Step 3: Update `queuedBuildCount`.** In `src/placement.ts`, change `queuedBuildCount` to add the job list:

```ts
export function queuedBuildCount(state: IslandState): number {
  let n = 0;
  for (const b of state.buildings) {
    if (b.queued === true) n++;
  }
  return n + (state.buildJobs?.length ?? 0);
}
```

- [ ] **Step 4: Update `UpgradeResult`.** Remove `'already-building'` from the reason union (it is no longer returned).

- [ ] **Step 5: Rewrite the `applyUpgrade` slot branch.** Replace the body from the `already-building` guard through the `mustQueue` block. New logic:

```ts
export function applyUpgrade(
  spec: IslandSpec,
  state: IslandState,
  buildingId: string,
): UpgradeResult {
  const b = spec.buildings.find((bb) => bb.id === buildingId);
  if (!b) return { ok: false, reason: 'not-found' };
  const def = BUILDING_DEFS[b.defId];

  // The building is RUNNING a construction iff its timer is live AND it is not
  // a queued placement. A running construction (place or active upgrade) means
  // the next upgrade must QUEUE; a free building with a free slot starts now.
  const buildingBusy = (b.constructionRemainingMs ?? 0) > 0;
  const slots = parallelBuildSlots(state);
  const inProgress = inProgressBuildCount(state);
  // Must queue if the building itself is busy OR all parallel slots are taken.
  const mustQueue = buildingBusy || inProgress >= slots;

  if (mustQueue && queuedBuildCount(state) >= queuedBuildSlots(state)) {
    return { ok: false, reason: 'queue-full', inProgress, slots };
  }

  // Target DISPLAYED floor for THIS upgrade = top level (raw + queued) + 2.
  const targetLevel = topUpgradeLevel(state, b) + 2;
  const cost = upgradeCost(def, targetLevel);
  const missing = affordabilityShortfall(state.inventory, cost);
  if (Object.keys(missing).length > 0) {
    return { ok: false, reason: 'insufficient-resources', missing };
  }
  for (const [r, n] of Object.entries(cost) as Array<[ResourceId, number]>) {
    if (n <= 0) continue;
    state.inventory[r] = (state.inventory[r] ?? 0) - n;
  }

  if (mustQueue) {
    // Queue an upgrade job; floorLevel is NOT bumped (only on promotion).
    const job: BuildJob = { seq: state.nextQueueSeq ?? 0, buildingId, kind: 'upgrade' };
    (state.buildJobs ??= []).push(job);
    state.nextQueueSeq = (state.nextQueueSeq ?? 0) + 1;
    return { ok: true };
  }

  // Start running now: bump floorLevel and set the timer (today's path).
  const newL = rawFloorLevel(b) + 1;
  b.floorLevel = newL;
  const upgradeMs = upgradeConstructionMs(def, newL);
  b.constructionRemainingMs = upgradeMs;
  b.constructionTotalMs = upgradeMs;
  return { ok: true };
}
```

> Import `BuildJob` from `./economy.js` at the top of `placement.ts` (it likely already imports `IslandState` from there — add `BuildJob` to that import).
> Delete the old storage-timing comment block that referenced the immediate-start path only if it no longer matches; keep the §storage-timing intent comment (storage caps still credited at completion in economy.ts).

- [ ] **Step 6: Run to verify pass.**

Run: `npx vitest run src/placement.test.ts -t "applyUpgrade stacking"`
Expected: PASS.

- [ ] **Step 7: Run the whole placement suite (catch regressions in existing upgrade tests).**

Run: `npx vitest run src/placement.test.ts`
Expected: PASS. (Existing tests that asserted `'already-building'` must be updated to the new queueing behaviour — fix any that fail to assert the new contract.)

- [ ] **Step 8: Commit.**

```bash
git add src/placement.ts src/placement.test.ts
git commit -m "feat(queue): applyUpgrade queues stacked upgrades instead of rejecting (#31)"
```

---

## Task 4: `promoteQueuedBuilds` — merged FIFO with per-building serialization

**Files:**
- Modify: `src/placement.ts` — `promoteQueuedBuilds` (~1336)
- Test: `src/placement.test.ts`

- [ ] **Step 1: Write failing tests.** Append to `src/placement.test.ts`:

```ts
describe('promoteQueuedBuilds with upgrade jobs (#31)', () => {
  it('does NOT start a queued upgrade while the building is still running one', () => {
    const { spec, state } = makeUpgradeScene(); // 1 parallel slot
    const id = spec.buildings[0]!.id;
    applyUpgrade(spec, state, id); // running
    applyUpgrade(spec, state, id); // queued
    promoteQueuedBuilds(state);
    // building still running its first upgrade; queued one not started
    expect(countQueuedUpgrades(state, id)).toBe(1);
    expect(rawFloorLevel(spec.buildings[0]!)).toBe(1);
  });

  it('promotes a queued upgrade into the freed slot once the building is idle', () => {
    const { spec, state } = makeUpgradeScene();
    const id = spec.buildings[0]!.id;
    applyUpgrade(spec, state, id);
    applyUpgrade(spec, state, id); // queued
    // simulate running upgrade completion: clear timer, floor advanced to 1
    spec.buildings[0]!.constructionRemainingMs = 0;
    promoteQueuedBuilds(state);
    expect(countQueuedUpgrades(state, id)).toBe(0);
    expect(rawFloorLevel(spec.buildings[0]!)).toBe(2);              // promoted: bumped
    expect((spec.buildings[0]!.constructionRemainingMs ?? 0) > 0).toBe(true);
  });
});
```

- [ ] **Step 2: Run to verify failure.**

Run: `npx vitest run src/placement.test.ts -t "promoteQueuedBuilds with upgrade jobs"`
Expected: FAIL (promotion ignores `buildJobs`).

- [ ] **Step 3: Rewrite `promoteQueuedBuilds`.** Replace with a merged FIFO over queued placements (`b.queued === true`) and queued upgrade jobs (`state.buildJobs`), ordered by seq, never starting an upgrade on a building that already has a running timer:

```ts
/** Promote queued builds into free running slots, FIFO by seq, until slots are
 *  full or nothing is eligible. Merges queued PLACEMENTS (building.queued) and
 *  queued UPGRADE jobs (state.buildJobs). A queued upgrade is only eligible when
 *  its building has no running construction (per-building serialisation). A
 *  promoted placement clears its `queued` flag; a promoted upgrade bumps the
 *  building's floorLevel, sets its timer, and is removed from buildJobs.
 *  Pure mutation on `state`. */
export function promoteQueuedBuilds(state: IslandState): void {
  let free = parallelBuildSlots(state) - inProgressBuildCount(state);
  if (free <= 0) return;

  // Merged candidate list, lowest seq first.
  type Cand =
    | { seq: number; kind: 'place'; b: PlacedBuilding }
    | { seq: number; kind: 'upgrade'; job: BuildJob };
  const cands: Cand[] = [];
  for (const b of state.buildings) {
    if (b.queued === true) cands.push({ seq: b.queueSeq ?? 0, kind: 'place', b });
  }
  for (const job of state.buildJobs ?? []) {
    cands.push({ seq: job.seq, kind: 'upgrade', job });
  }
  cands.sort((a, b) => a.seq - b.seq);

  for (const c of cands) {
    if (free <= 0) break;
    if (c.kind === 'place') {
      c.b.queued = false;
      free--;
      continue;
    }
    // upgrade: skip if its building is busy or missing; else start it.
    const b = state.buildings.find((bb) => bb.id === c.job.buildingId);
    if (!b) {
      // orphaned job (building gone) — drop it, no slot consumed.
      state.buildJobs = (state.buildJobs ?? []).filter((j) => j !== c.job);
      continue;
    }
    if ((b.constructionRemainingMs ?? 0) > 0) continue; // building still running — wait
    const def = BUILDING_DEFS[b.defId];
    const newL = rawFloorLevel(b) + 1;
    b.floorLevel = newL;
    const upgradeMs = upgradeConstructionMs(def, newL);
    b.constructionRemainingMs = upgradeMs;
    b.constructionTotalMs = upgradeMs;
    state.buildJobs = (state.buildJobs ?? []).filter((j) => j !== c.job);
    free--;
  }
}
```

> Imports needed in `placement.ts`: `upgradeConstructionMs` from `./construction.js`, `PlacedBuilding` from `./buildings.js`, `BuildJob` from `./economy.js` (add if missing). `BUILDING_DEFS`, `rawFloorLevel` already imported.

- [ ] **Step 4: Run to verify pass.**

Run: `npx vitest run src/placement.test.ts -t "promoteQueuedBuilds with upgrade jobs"`
Expected: PASS.

- [ ] **Step 5: Full placement suite.**

Run: `npx vitest run src/placement.test.ts`
Expected: PASS.

- [ ] **Step 6: Commit.**

```bash
git add src/placement.ts src/placement.test.ts
git commit -m "feat(queue): promoteQueuedBuilds merges placements + upgrade jobs, serialised per building (#31)"
```

---

## Task 5: end-to-end via `advanceIsland` (sequential stack + producing-while-queued)

**Files:**
- Test: `src/economy.test.ts`

- [ ] **Step 1: Write failing test.** Append to `src/economy.test.ts`, reusing its `makeState` / `advanceIsland` helpers. Scene: one `mine` (T1, base construction 30s) at floor 0, generous inventory, single parallel slot. Queue 2 stacked upgrades on top of one running upgrade (3 total). Advance long enough to finish all three; assert final `floorLevel === 3`, `buildJobs` empty, and that the mine **produced** during the windows it was merely queued (net iron_ore > 0) but the building went offline only during each running upgrade.

```ts
it('runs a 3-deep upgrade stack sequentially to completion (#31)', () => {
  const mine: PlacedBuilding = { id: 'm', defId: 'mine', x: 0, y: 0 };
  const state = makeState({ buildings: [mine], inventory: richInventory() });
  const spec = specFor(state); // however the file pairs spec/state; reuse existing pattern
  expect(applyUpgrade(spec, state, 'm').ok).toBe(true); // running -> floor 1
  expect(applyUpgrade(spec, state, 'm').ok).toBe(true); // queued
  expect(applyUpgrade(spec, state, 'm').ok).toBe(true); // queued
  // base construction 30s/floor; upgradeConstructionMs scales × (level+1).
  // Advance well past the sum of all three upgrade durations.
  advanceIsland(state, 60 * 60 * 1000, { defs: POWER_FREE });
  expect(rawFloorLevel(spec.buildings[0]!)).toBe(3);
  expect((state.buildJobs ?? []).length).toBe(0);
  expect((spec.buildings[0]!.constructionRemainingMs ?? 0)).toBe(0);
});

it('keeps producing while an upgrade is merely QUEUED, offline only while running (#31)', () => {
  const mine: PlacedBuilding = { id: 'm', defId: 'mine', x: 0, y: 0 };
  const state = makeState({ buildings: [mine], inventory: richInventory() });
  const spec = specFor(state);
  applyUpgrade(spec, state, 'm'); // running (offline)
  applyUpgrade(spec, state, 'm'); // queued (should keep producing)
  // While the FIRST is running the mine is offline; the queued one alone would
  // not block production. Assert isOperationalBuilding reflects only the timer:
  expect(isOperationalBuilding(spec.buildings[0]!)).toBe(false); // running upgrade
  spec.buildings[0]!.constructionRemainingMs = 0;                // running done, queued remains pre-promotion
  expect(isOperationalBuilding(spec.buildings[0]!)).toBe(true);  // queued upgrade does NOT freeze it
});
```

> Implementer: adapt `specFor`/`richInventory`/`POWER_FREE` to the actual helpers in `economy.test.ts` (search for existing `advanceIsland` + `applyUpgrade` tests; `POWER_FREE` already exists in the file). If `applyUpgrade` isn't imported there yet, import it from `./placement.js` and `isOperationalBuilding`/`rawFloorLevel` from `./buildings.js`.

- [ ] **Step 2: Run to verify failure.**

Run: `npx vitest run src/economy.test.ts -t "upgrade stack"`
Expected: FAIL initially if anything in the promotion/tick chain is wrong; if it passes immediately, that confirms Tasks 3–4 wired correctly — keep the test.

- [ ] **Step 3: Fix any integration gap.** If promotion isn't running each segment, confirm `promoteQueuedBuilds(state)` is still called at the end of the construction loop in `advanceIsland` (`economy.ts` ~2474) — it already is; no code change expected. The completion storage-cap branch (`floorLevel === 0 ? base : delta`, ~2434) stays correct because a completing upgrade has `floorLevel ≥ 1`.

- [ ] **Step 4: Run to verify pass.**

Run: `npx vitest run src/economy.test.ts -t "upgrade stack"` and `-t "keeps producing"`
Expected: PASS.

- [ ] **Step 5: Commit.**

```bash
git add src/economy.test.ts
git commit -m "test(queue): e2e stacked upgrades via advanceIsland (#31)"
```

---

## Task 6: cancel LIFO + demolish purge

**Files:**
- Modify: `src/placement.ts` — `cancelConstruction` (~1102); the demolish function (search `splice` / `demolish` for the building-removal path)
- Test: `src/placement.test.ts`

- [ ] **Step 1: Write failing tests.**

```ts
describe('cancel/demolish with queued upgrades (#31)', () => {
  it('cancels the NEWEST queued upgrade first (LIFO) and refunds its cost', () => {
    const { spec, state } = makeUpgradeScene();
    const id = spec.buildings[0]!.id;
    const def = BUILDING_DEFS[spec.buildings[0]!.defId];
    applyUpgrade(spec, state, id); // running
    applyUpgrade(spec, state, id); // queued -> target displayed 3
    const before = { ...state.inventory };
    const res = cancelConstruction(spec, state, id);
    expect(res.ok).toBe(true);
    expect(countQueuedUpgrades(state, id)).toBe(0);           // newest queued removed
    expect((spec.buildings[0]!.constructionRemainingMs ?? 0) > 0).toBe(true); // running untouched
    // refunded the displayed-3 upgrade cost
    const refundR = Object.keys(upgradeCost(def, 3))[0] as ResourceId;
    expect((state.inventory[refundR] ?? 0)).toBeGreaterThan(before[refundR] ?? 0);
  });

  it('cancelling the running job is blocked while queued upgrades remain', () => {
    const { spec, state } = makeUpgradeScene();
    const id = spec.buildings[0]!.id;
    applyUpgrade(spec, state, id);
    applyUpgrade(spec, state, id); // queued
    applyUpgrade(spec, state, id); // queued
    cancelConstruction(spec, state, id); // removes newest queued
    cancelConstruction(spec, state, id); // removes last queued
    expect(countQueuedUpgrades(state, id)).toBe(0);
    // now cancel hits the running job (reverts floor)
    const r = cancelConstruction(spec, state, id);
    expect(r.ok).toBe(true);
    expect((spec.buildings[0]!.constructionRemainingMs ?? 0)).toBe(0);
  });
});
```

- [ ] **Step 2: Run to verify failure.**

Run: `npx vitest run src/placement.test.ts -t "cancel/demolish with queued upgrades"`
Expected: FAIL (cancel ignores `buildJobs`).

- [ ] **Step 3: Add the LIFO branch to `cancelConstruction`.** Near the top of `cancelConstruction`, after resolving `b` and `def`, before the `constructionRemainingMs <= 0` guard, add:

```ts
  // §4.8 LIFO: if the building has QUEUED upgrade jobs, cancel the newest one
  // first (floors stay contiguous). Refund its upgrade cost; leave the running
  // job alone.
  const myJobs = (state.buildJobs ?? []).filter((j) => j.buildingId === buildingId);
  if (myJobs.length > 0) {
    const newest = myJobs.reduce((a, c) => (c.seq > a.seq ? c : a));
    // its target displayed floor = rawFloorLevel + (#queued for this building) + 1
    const targetDisplayed = rawFloorLevel(b) + myJobs.length + 1;
    state.buildJobs = (state.buildJobs ?? []).filter((j) => j !== newest);
    return { ok: true, refunded: creditRefundTopLevel(state, def, targetDisplayed) };
  }
```

Where the refund reuses the same clamp helper already defined inside `cancelConstruction` (`creditRefund`). Because `creditRefund` is a closure defined later in the function, move the LIFO branch to AFTER `creditRefund` is declared (or hoist `creditRefund` above the guard). Simplest: place the LIFO branch immediately after the `creditRefund` definition and before the `if (L === 0)` block, replacing `creditRefundTopLevel(...)` with `creditRefund(upgradeCost(def, targetDisplayed))`.

Final shape of the inserted block (place right after `creditRefund` is defined):

```ts
  const myJobs = (state.buildJobs ?? []).filter((j) => j.buildingId === buildingId);
  if (myJobs.length > 0) {
    const newest = myJobs.reduce((a, c) => (c.seq > a.seq ? c : a));
    const targetDisplayed = rawFloorLevel(b) + myJobs.length + 1;
    state.buildJobs = (state.buildJobs ?? []).filter((j) => j !== newest);
    return { ok: true, refunded: creditRefund(upgradeCost(def, targetDisplayed)) };
  }
```

Also relax the early `not-building` guard so a building that is operational but HAS queued jobs reaches the LIFO branch: move the `myJobs` block ABOVE the `if ((b.constructionRemainingMs ?? 0) <= 0) return { not-building }` guard (a queued-upgrade-only building has `constructionRemainingMs === 0`).

- [ ] **Step 4: Purge jobs on demolish.** Find the demolish path (search `placement.ts` for the function that removes a completed building, e.g. `demolishBuilding`, near the `splice`). After it removes the building from `spec.buildings`, add:

```ts
  // §4.8 drop any queued upgrade jobs that targeted the now-removed building.
  if (state.buildJobs) state.buildJobs = state.buildJobs.filter((j) => j.buildingId !== id);
```

(Use the demolished building's id variable name as it exists in that function.)

- [ ] **Step 5: Run to verify pass.**

Run: `npx vitest run src/placement.test.ts -t "cancel/demolish with queued upgrades"`
Expected: PASS.

- [ ] **Step 6: Full placement suite.**

Run: `npx vitest run src/placement.test.ts`
Expected: PASS.

- [ ] **Step 7: Commit.**

```bash
git add src/placement.ts src/placement.test.ts
git commit -m "feat(queue): LIFO cancel of queued upgrades + demolish purge (#31)"
```

---

## Task 7: persistence schema v23 → v24

**Files:**
- Modify: `src/persistence.ts`
- Test: `src/persistence.test.ts`

- [ ] **Step 1: Write failing tests.** Append to `src/persistence.test.ts` (mirror an existing `migrateV..` + round-trip test): (a) a v23 snapshot loads into v24 with each island state's `buildJobs` defaulting to `[]`; (b) a v24 snapshot with non-empty `buildJobs` round-trips through `toSnapshot`/`loadWorld` identically; (c) `SCHEMA_VERSION === 24`.

```ts
it('SCHEMA_VERSION is 24', () => {
  expect(SCHEMA_VERSION).toBe(24);
});

it('migrateV23toV24 defaults buildJobs to []', () => {
  const v23 = makeV23Fixture(); // reuse the file's fixture builder, version 23
  const v24 = migrateV23toV24(v23 as never);
  for (const isl of v24.islands) expect(isl.state.buildJobs).toEqual([]);
});

it('migrateV23toV24 converts disabled buildings to disabledFloors (all floors off)', () => {
  const v23 = makeV23Fixture();
  // mark one building disabled at floorLevel 2 (3 built floors)
  v23.islands[0].state.buildings[0] = { ...v23.islands[0].state.buildings[0], floorLevel: 2, disabled: true } as never;
  const v24 = migrateV23toV24(v23 as never);
  const b0 = v24.islands[0].state.buildings[0] as { disabled?: boolean; disabledFloors?: number };
  expect(b0.disabled).toBeUndefined();
  expect(b0.disabledFloors).toBe(3); // floorLevel 2 -> displayed 3 -> all off
});
```

- [ ] **Step 2: Run to verify failure.**

Run: `npx vitest run src/persistence.test.ts -t "24"`
Expected: FAIL (`SCHEMA_VERSION` is 23; `migrateV23toV24` undefined).

- [ ] **Step 3: Implement the migration.** In `src/persistence.ts`:
  1. Bump `export const SCHEMA_VERSION = 24 as const;`.
  2. Add `24` to `SUPPORTED_LOAD_VERSIONS`.
  3. Add a `SerializedSnapshotV23` type alias capturing the current snapshot shape (copy the structure currently serialised, i.e. the per-island `state` WITHOUT `buildJobs`). Follow the existing `SerializedSnapshotV<N>` aliases as templates.
  4. Add the migration (mirror `migrateV22toV23`'s shape):

```ts
export function migrateV23toV24(s: SerializedSnapshotV23): SaveSnapshot {
  return {
    ...s,
    v: 24,
    islands: s.islands.map((isl) => ({
      ...isl,
      state: {
        ...isl.state,
        buildJobs: [],                                   // Part 1: queued upgrades
        buildings: isl.state.buildings.map((b) => {      // Part 2: disabled -> disabledFloors
          const { disabled, ...rest } = b as { disabled?: boolean; floorLevel?: number };
          return disabled === true
            ? { ...rest, disabledFloors: (rest.floorLevel ?? 0) + 1 } // all built floors off
            : rest;
        }),
      },
    })),
  } as unknown as SaveSnapshot;
}
```

> The `SerializedSnapshotV23` building shape still carries `disabled?: boolean`
> (the old field); the migration strips it and writes `disabledFloors` for any
> building that was fully disabled. `displayedFloorLevel = floorLevel + 1` built
> floors, so a fully-disabled building gets `disabledFloors = floorLevel + 1`.

  5. Wire into `loadWorld`'s migration chain (the `if (version <= 23)` step, mirroring the existing chain at ~830–870).
  6. Ensure `toSnapshot` serialises `state.buildJobs` (if it spreads the whole state, it already does; otherwise add `buildJobs: state.buildJobs ?? []`).

- [ ] **Step 4: Run to verify pass.**

Run: `npx vitest run src/persistence.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit.**

```bash
git add src/persistence.ts src/persistence.test.ts
git commit -m "feat(persistence): schema v24 — buildJobs migration + round-trip (#31)"
```

---

## Task 8: build-queue panel rows per queued upgrade job

**Files:**
- Modify: `src/build-queue-ui.ts`

- [ ] **Step 1: Update the queued section to render jobs.** In `refresh()` (`build-queue-ui.ts`), the queued section currently lists buildings with `b.queued === true`. Extend it to also list each `state.buildJobs` entry as its own row:
  - Build a queued list = `[...queued placements] ++ [...buildJobs]` sorted by seq.
  - Key the row cache by a stable id: `place:${b.id}` for placements, `job:${job.seq}` for upgrade jobs (so multiple upgrade rows for one building are distinct).
  - Row label for an upgrade job: `${BUILDING_DEFS[b.defId].displayName} → floor ${displayedTarget}` where `displayedTarget` is computed by position among that building's jobs (lowest seq = nearest floor). Right span text: `queued`.
  - The structural signature `sig` must include the job seqs so the rows rebuild when jobs change: e.g. `q:${queuedPlacements.map(b=>b.id).join(',')};j:${(state.buildJobs??[]).map(j=>j.seq).join(',')}`.
  - The ✕ cancel button for an upgrade-job row sets `_pendingCancelBuildingId = job.buildingId` and dispatches `cancel-build` — `cancelConstruction` already cancels that building's NEWEST queued upgrade (LIFO), which matches "cancel the last row for that building." (Per-floor row order is display-only; cancel is LIFO per building by design — acceptable.)

- [ ] **Step 2: Typecheck + build.**

Run: `npx tsc -b && npm run build`
Expected: clean.

- [ ] **Step 3: Commit.**

```bash
git add src/build-queue-ui.ts
git commit -m "feat(ui): build-queue panel shows one row per queued upgrade job (#31)"
```

---

## Task 9: inspector Upgrade button — enable while constructing, show queued count

**Files:**
- Modify: `src/inspector-ui.ts` (upgrade button enable/label ~907–960, ~1531, ~1674); `src/main.ts` (~1399 guard)

- [ ] **Step 1: Relax the no-op-while-constructing guards.** In `inspector-ui.ts:939` and `main.ts:1399`, the upgrade action returns early `if ((building.constructionRemainingMs ?? 0) > 0)`. Remove those early returns so the action calls `applyUpgrade` (which now decides run-vs-queue-vs-full). Keep any guard that blocks upgrades on invalid/disabled buildings if present.

- [ ] **Step 2: Enable the button + label.** Where the upgrade button's `disabled` is set from `constructionRemainingMs > 0` (~907/1531/1674), change the disable condition to depend only on affordability + queue capacity (not on being under construction). Append a queued-count hint to the label when `countQueuedUpgrades(state, building.id) > 0`, e.g. `Upgrade (2 queued)`. Compute the cost preview for the NEXT target floor: `upgradeCost(def, topUpgradeLevel(state, building) + 2)`.

- [ ] **Step 3: Typecheck + build.**

Run: `npx tsc -b && npm run build`
Expected: clean.

- [ ] **Step 4: Commit.**

```bash
git add src/inspector-ui.ts src/main.ts
git commit -m "feat(ui): inspector Upgrade enabled while constructing, shows queued count (#31)"
```

---

## Task 10: SPEC.md §4.8 + §9.3

**Files:**
- Modify: `SPEC.md`

- [ ] **Step 1: Update §4.8** (build queue / running slots / cancel). Add: queued upgrades live in `state.buildJobs` (one entry per pending floor), occupy queue slots (shared cap with queued placements), keep the building producing until promoted, promote by global FIFO (`seq`) with per-building serialisation (never two running jobs on one building), and cancel LIFO per building (newest queued floor first; running-cancel only once no queued upgrades remain). Demolishing a building drops its queued upgrade jobs.

- [ ] **Step 2: Update §9.3** (construction): `floorLevel` advances only when an upgrade *starts running* (on promotion or immediate start); queued upgrades are pending jobs that have already paid their cost and do not bump `floorLevel`.

- [ ] **Step 3: Commit.**

```bash
git add SPEC.md
git commit -m "docs(spec): §4.8/§9.3 stacked upgrade queue (#31)"
```

---

# Part 2 — temporary floor disabling

## Task 11: floor helpers `activeFloors` / `activeFloorLevel`

**Files:**
- Modify: `src/buildings.ts` (after `displayedFloorLevel`, ~219)
- Test: `src/buildings.test.ts` (create a describe block; the file exists)

- [ ] **Step 1: Write failing tests.**

```ts
describe('active floors (floor-disable, Part 2)', () => {
  it('defaults to all built floors active', () => {
    expect(activeFloors({ floorLevel: 2 })).toBe(3);        // 3 built, none disabled
    expect(activeFloorLevel({ floorLevel: 2 })).toBe(2);
  });
  it('subtracts disabledFloors from the top', () => {
    expect(activeFloors({ floorLevel: 2, disabledFloors: 1 })).toBe(2);
    expect(activeFloorLevel({ floorLevel: 2, disabledFloors: 1 })).toBe(1);
  });
  it('fully disabled = 0 active', () => {
    expect(activeFloors({ floorLevel: 2, disabledFloors: 3 })).toBe(0);
    expect(activeFloorLevel({ floorLevel: 2, disabledFloors: 3 })).toBe(-1);
  });
  it('clamps over-disable to 0 active', () => {
    expect(activeFloors({ floorLevel: 0, disabledFloors: 9 })).toBe(0);
  });
});
```

- [ ] **Step 2: Run to verify failure.**

Run: `npx vitest run src/buildings.test.ts -t "active floors"`
Expected: FAIL — `activeFloors is not a function`.

- [ ] **Step 3: Implement.** In `src/buildings.ts` after `displayedFloorLevel`:

```ts
/** §NEW floor-disable: count of ACTIVE floors ∈ [0, displayedFloorLevel].
 *  = built floors minus `disabledFloors` (clamped at 0). */
export function activeFloors(b: { floorLevel?: number; disabledFloors?: number }): number {
  return Math.max(0, displayedFloorLevel(b) - (b.disabledFloors ?? 0));
}

/** §NEW floor-disable: 0-based effective floor level for the floor-effect
 *  multipliers (activeFloors − 1). ≥ 0 for an operational building; −1 when
 *  fully disabled (never read — the building is then non-operational). */
export function activeFloorLevel(b: { floorLevel?: number; disabledFloors?: number }): number {
  return activeFloors(b) - 1;
}
```

- [ ] **Step 4: Run to verify pass.**

Run: `npx vitest run src/buildings.test.ts -t "active floors"`
Expected: PASS.

- [ ] **Step 5: Commit.**

```bash
git add src/buildings.ts src/buildings.test.ts
git commit -m "feat(building): activeFloors/activeFloorLevel helpers (floor-disable)"
```

---

## Task 12: operational + cluster gating use active floors

**Files:**
- Modify: `src/buildings.ts` — `isOperationalBuilding` (~172), `participatesInCluster` (~196)
- Modify: `src/adjacency.ts` — `clusterFloorCapacity` (~92)
- Test: `src/buildings.test.ts`, `src/adjacency.test.ts`

- [ ] **Step 1: Write failing tests.** In `src/buildings.test.ts`:

```ts
describe('floor-disable gating', () => {
  it('a building with 0 active floors is non-operational', () => {
    expect(isOperationalBuilding({ floorLevel: 1, disabledFloors: 2 })).toBe(false);
    expect(participatesInCluster({ floorLevel: 1, disabledFloors: 2 })).toBe(false);
  });
  it('a partially-disabled building is still operational', () => {
    expect(isOperationalBuilding({ floorLevel: 2, disabledFloors: 1 })).toBe(true);
    expect(participatesInCluster({ floorLevel: 2, disabledFloors: 1 })).toBe(true);
  });
});
```

In `src/adjacency.test.ts` (cluster uses ACTIVE floors):

```ts
it('a half-disabled building contributes its ACTIVE floor count to the cluster (#floor-disable)', () => {
  const place = (id: string, defId: string, x: number, y: number) =>
    ({ id, defId: defId as never, x, y }) as unknown as PlacedBuilding;
  // a floor-1 (c=1); b built floor 3 (floorLevel 2 -> 3 floors) but 2 disabled -> active 1 (c=1). K=2.
  const a = place('a', 'mine', 0, 0);
  const b = { ...place('b', 'mine', 2, 0), floorLevel: 2, disabledFloors: 2 };
  expect(clusterBonusMul(a, [a, b])).toBeCloseTo(1.05, 9); // 1 + 0.05×(2−1)
});
```

- [ ] **Step 2: Run to verify failure.**

Run: `npx vitest run src/buildings.test.ts -t "floor-disable gating" src/adjacency.test.ts -t "ACTIVE floor count"`
Expected: FAIL.

- [ ] **Step 3: Update the two predicates.** In `src/buildings.ts`, change the param types to include `floorLevel?` + `disabledFloors?` and swap the disabled check:

```ts
export function isOperationalBuilding(
  b: { invalid?: boolean; constructionRemainingMs?: number; floorLevel?: number; disabledFloors?: number },
): boolean {
  if (b.invalid === true) return false;
  if ((b.constructionRemainingMs ?? 0) > 0) return false;
  if (activeFloors(b) <= 0) return false;   // was: b.disabled === true
  return true;
}
```

```ts
export function participatesInCluster(
  b: { invalid?: boolean; floorLevel?: number; disabledFloors?: number },
): boolean {
  return b.invalid !== true && activeFloors(b) > 0;  // was: b.disabled !== true
}
```

> Also update the param type of `hasOperationalBuilding` / `findOperationalBuilding` (they forward to `isOperationalBuilding`) to include `floorLevel?` + `disabledFloors?` so callers passing trimmed shapes still typecheck.

- [ ] **Step 4: Update `clusterFloorCapacity`** in `src/adjacency.ts` to use active floors (import `activeFloorLevel` from `./buildings.js`):

```ts
function clusterFloorCapacity(b: PlacedBuilding): number {
  const underConstruction = (b.constructionRemainingMs ?? 0) > 0;
  // §4.5/#35 + floor-disable: contribution tracks ACTIVE floors; the
  // under-construction discount removes the floor being built (running upgrade).
  return Math.max(0, activeFloorLevel(b) + (underConstruction ? 0 : 1));
}
```

- [ ] **Step 5: Run to verify pass + the existing #35 cluster suite stays green.**

Run: `npx vitest run src/buildings.test.ts src/adjacency.test.ts`
Expected: PASS (the existing #35 cases still pass — a non-disabled building has `activeFloorLevel === floorLevel`).

- [ ] **Step 6: Commit.**

```bash
git add src/buildings.ts src/adjacency.ts src/buildings.test.ts src/adjacency.test.ts
git commit -m "feat(building): operational + cluster gating use active floors (floor-disable)"
```

---

## Task 13: throughput / power / capacity scale by active floors

**Files:**
- Modify: `src/buildings.ts` — `floorScaledCapacity` (~225)
- Modify: `src/economy.ts` — rate + power sites (~1306, ~1425, ~1459, ~1719, ~1723, ~1736)
- Test: `src/economy.test.ts`

- [ ] **Step 1: Write failing test.** In `src/economy.test.ts` (reuse `makeState` / `POWER_FREE`):

```ts
it('disabling floors scales throughput by active floor count (floor-disable)', () => {
  // mine built to floor 3 (floorLevel 2 -> ×3 throughput) with 2 floors disabled
  // -> active 1 floor -> ×1 throughput (base 0.05 iron_ore/s).
  const mine: PlacedBuilding = { id: 'm', defId: 'mine', x: 0, y: 0, floorLevel: 2, disabledFloors: 2 };
  const state = makeState({ buildings: [mine], inventory: blankInventory() });
  const { byBuilding } = computeRates(state, { defs: POWER_FREE });
  expect(byBuilding.find((r) => r.building === mine)?.effectiveRate).toBeCloseTo(0.05, 9);
});

it('fully disabling all floors stops production (floor-disable)', () => {
  const mine: PlacedBuilding = { id: 'm', defId: 'mine', x: 0, y: 0, floorLevel: 2, disabledFloors: 3 };
  const state = makeState({ buildings: [mine], inventory: blankInventory() });
  const { byBuilding } = computeRates(state, { defs: POWER_FREE });
  expect(byBuilding.some((r) => r.building === mine)).toBe(false); // non-operational
});
```

- [ ] **Step 2: Run to verify failure.**

Run: `npx vitest run src/economy.test.ts -t "floor-disable"`
Expected: FAIL (throughput still uses built floors).

- [ ] **Step 3: Swap `floorLevel(b)` → `activeFloorLevel(b)` at the effect sites.** In `src/economy.ts` import `activeFloorLevel` from `./buildings.js`, then replace `floorEffectMul(floorLevel(b))` with `floorEffectMul(activeFloorLevel(b))` at the throughput sites (~1306, ~1425, ~1459 — note 1459 uses `floorLevel(te.building)` → `activeFloorLevel(te.building)`) and the power-out site (~1719); replace `floorPowerDrawMul(floorLevel(b))` with `floorPowerDrawMul(activeFloorLevel(b))` at ~1723 and ~1736. In `src/buildings.ts`, change `floorScaledCapacity`:

```ts
export function floorScaledCapacity(b: { floorLevel?: number; disabledFloors?: number }, capacity: number): number {
  return capacity * floorEffectMul(activeFloorLevel(b));
}
```

> These sites only execute for operational buildings (active ≥ 1 ⇒ `activeFloorLevel ≥ 0`). The construction-completion credit (`economy.ts` ~2440) runs when the building is full-active, so it is unchanged.

- [ ] **Step 4: Run to verify pass + full economy suite.**

Run: `npx vitest run src/economy.test.ts`
Expected: PASS (existing tests unaffected — non-disabled buildings have `activeFloorLevel === floorLevel`).

- [ ] **Step 5: Commit.**

```bash
git add src/economy.ts src/buildings.ts src/economy.test.ts
git commit -m "feat(building): throughput/power/capacity scale by active floors (floor-disable)"
```

---

## Task 14: `setBuildingActiveFloors` + rewire wear/maintenance/alerts

**Files:**
- Modify: `src/placement.ts` — new `setBuildingActiveFloors`
- Modify: `src/economy.ts` (~2450 wear skip), `src/maintenance.ts` (~269), `src/building-alerts-overlay.ts` (~164)
- Test: `src/placement.test.ts`

- [ ] **Step 1: Write failing tests.**

```ts
describe('setBuildingActiveFloors (floor-disable)', () => {
  it('lowers a storage building’s cap and clamps overflow', () => {
    const { spec, state, def } = makeStorageScene(); // crate/warehouse built to floor 1 (×2 cap), cap credited, inventory filled to cap
    const id = spec.buildings[0]!.id;
    const res = state.cargoLabel; // helper exposes the labeled resource
    const capBefore = state.storageCaps[res]!;
    setBuildingActiveFloors(spec, state, id, 2); // disable both floors -> active 0
    expect(activeFloors(spec.buildings[0]!)).toBe(0);
    expect(state.storageCaps[res]).toBeLessThan(capBefore);
    expect(state.inventory[res]!).toBeLessThanOrEqual(state.storageCaps[res]!); // overflow clamped
  });
  it('toggling back up restores the cap contribution', () => {
    const { spec, state } = makeStorageScene();
    const id = spec.buildings[0]!.id;
    const res = state.cargoLabel;
    const full = state.storageCaps[res]!;
    setBuildingActiveFloors(spec, state, id, 2); // off
    setBuildingActiveFloors(spec, state, id, 0); // back to full active
    expect(state.storageCaps[res]).toBeCloseTo(full, 6);
  });
});
```

> Implementer: build `makeStorageScene` from existing storage tests in `placement.test.ts` (search `creditStorageCaps` / `cargoLabel` usage) — a labeled crate at floor 1 with its cap credited and inventory filled to the cap.

- [ ] **Step 2: Run to verify failure.**

Run: `npx vitest run src/placement.test.ts -t "setBuildingActiveFloors"`
Expected: FAIL — `setBuildingActiveFloors is not a function`.

- [ ] **Step 3: Implement `setBuildingActiveFloors`** in `src/placement.ts` (import `displayedFloorLevel`, `floorEffectMul`, `activeFloors` from `./buildings.js`):

```ts
export interface SetActiveFloorsResult { readonly ok: boolean; readonly reason?: 'not-found'; }

/** §NEW floor-disable: set how many of a building's BUILT floors are switched
 *  off (from the top), clamped to [0, builtFloors]. Free + reversible. Adjusts
 *  the island storage cap by the active-floor delta for storage buildings and
 *  clamps any now-overflowing inventory down to the lowered cap. Pure mutation;
 *  route draining on reaching 0 active is handled by the caller (render layer).*/
export function setBuildingActiveFloors(
  spec: IslandSpec, state: IslandState, buildingId: string, newDisabledFloors: number,
): SetActiveFloorsResult {
  const b = spec.buildings.find((bb) => bb.id === buildingId);
  if (!b) return { ok: false, reason: 'not-found' };
  const def = BUILDING_DEFS[b.defId];
  const built = displayedFloorLevel(b);
  const next = Math.max(0, Math.min(built, Math.round(newDisabledFloors)));
  const prev = b.disabledFloors ?? 0;
  if (next === prev) return { ok: true };

  const storage = def.storage;
  if (storage) {
    const oldActiveLevel = Math.max(0, built - prev) - 1;  // −1 when fully off
    const newActiveLevel = Math.max(0, built - next) - 1;
    const oldMult = oldActiveLevel >= 0 ? storage.capacity * floorEffectMul(oldActiveLevel) : 0;
    const newMult = newActiveLevel >= 0 ? storage.capacity * floorEffectMul(newActiveLevel) : 0;
    const deltaMult = newMult - oldMult;
    if (deltaMult !== 0) creditStorageCaps(state, b, def, deltaMult);
    // Approved: lower cap clamps overflow — discard inventory above the new cap
    // for exactly the resources creditStorageCaps writes (mirror its selection:
    // generic storage → b.cargoLabel; otherwise def.storage's resource set).
    for (const r of storageCapResources(b, def)) {
      const cap = state.storageCaps[r] ?? 0;
      if ((state.inventory[r] ?? 0) > cap) state.inventory[r] = cap;
    }
  }

  if (next === 0) delete b.disabledFloors;
  else b.disabledFloors = next;
  return { ok: true };
}
```

> `storageCapResources(b, def)` — factor out (or inline) the resource-selection logic that already lives inside `creditStorageCaps` (placement.ts ~439) so the clamp loop hits exactly the caps that were adjusted. If `creditStorageCaps` already iterates a clear resource set, extract a small shared helper and use it in both.

- [ ] **Step 4: Rewire the remaining non-UI `disabled` reads to active floors** (keep the `disabled` FIELD for now — it is removed in Task 15 after the UI is migrated):
  - `src/economy.ts` ~2450: `if (b.disabled === true) continue;` → `if (activeFloors(b) <= 0) continue;` (import `activeFloors`).
  - `src/maintenance.ts` ~269: `if (b.disabled === true || b.invalid === true) continue;` → `if (activeFloors(b) <= 0 || b.invalid === true) continue;`.
  - `src/building-alerts-overlay.ts` ~164: replace `if (b.disabled === true) {` dim cue with `if (activeFloors(b) < displayedFloorLevel(b)) {` (partial-or-full dim; optionally stronger alpha when `activeFloors(b) === 0`).

- [ ] **Step 5: Run to verify pass.**

Run: `npx vitest run src/placement.test.ts -t "setBuildingActiveFloors"`
Expected: PASS.

- [ ] **Step 6: Commit.**

```bash
git add src/placement.ts src/economy.ts src/maintenance.ts src/building-alerts-overlay.ts src/placement.test.ts
git commit -m "feat(building): setBuildingActiveFloors cap-delta + overflow clamp; rewire wear/maintenance/alerts (floor-disable)"
```

---

## Task 15: UI — floor steppers replace the Disable button; remove `disabled` field

**Files:**
- Modify: `src/inspector-ui.ts` (~1670–1690 disable button), `src/main.ts` (~1308, ~1328–1337, ~1400–1402 toggle + route drain)
- Modify: `src/buildings.ts` — remove the now-unused `disabled?: boolean` field

- [ ] **Step 1: Replace the inspector Disable control with active-floor steppers.** In `inspector-ui.ts`, where the Disable button is built/updated (~1670–1690), render instead: a label `Active floors: <active>/<built>`, a `−` button (dispatches a `floors-down` action → `setBuildingActiveFloors(spec, state, id, (b.disabledFloors ?? 0) + 1)`), a `＋` button (`... − 1`), and quick `Off` (`= built`) / `Max` (`= 0`) buttons. Disable `−`/`Off` when already 0 active; `＋`/`Max` when already full. All via the input registry (define actions + dispatch, mirroring the existing disable action wiring and `build-queue-ui` cancel pattern). Keep it enabled while under construction? No — a building under construction has no active production; gate the steppers on `!isUnderConstruction` as the old button did.

- [ ] **Step 2: Wire the actions in `main.ts`.** Replace the disable-toggle action handlers (~1328–1337 and ~1400–1402) with handlers that call `setBuildingActiveFloors(...)` for the target building, then rebuild layers + save (same callback path the old toggle used). **Route drain on reaching 0:** after the call, if the building crossed from `activeFloors ≥ 1` (pre) to `activeFloors === 0` (post), call `drainRoutesForBuilding(worldState, id)` (mirror `main.ts:1402`). Compute pre/post active around the call. The ~1308 call site (inspector disable path) gets the same treatment.

- [ ] **Step 3: Remove the `disabled` field.** In `src/buildings.ts`, delete `disabled?: boolean` from `PlacedBuilding`. Fix any remaining compile error by routing it through `activeFloors`/`disabledFloors` (there should be none left after Tasks 12 & 14 and Steps 1–2 here).

- [ ] **Step 4: Typecheck + build.**

Run: `npx tsc -b && npm run build`
Expected: clean (no references to `building.disabled` remain).

- [ ] **Step 5: Commit.**

```bash
git add src/inspector-ui.ts src/main.ts src/buildings.ts
git commit -m "feat(ui): active-floor steppers replace Disable; route-drain at 0; drop disabled field (floor-disable)"
```

---

## Task 16: SPEC.md — floor-disable

**Files:**
- Modify: `SPEC.md`

- [ ] **Step 1: Rewrite the building-disable section** (the § NEW building-disable text per `docs/superpowers/specs/2026-05-23-building-disable-design.md`) to the active-floor model: free, instantly-reversible active-floor count in `[0, built]`; scales throughput, power (draw + output), storage capacity, and §4.5 cluster contribution by the ACTIVE floor count; `0` active = fully off (the old disable — no power/production/gates/wear/cluster, plus one-way `drainRoutesForBuilding` on reaching 0); lowering capacity clamps overflow inventory.

- [ ] **Step 2: Add to §4.5** the note that cluster capacity uses ACTIVE floors (`activeFloorLevel`).

- [ ] **Step 3: Commit.**

```bash
git add SPEC.md
git commit -m "docs(spec): floor-disable active-floor model + §4.5 active-floor cluster"
```

---

## Task 17: full verification

- [ ] **Step 1: Full suite.**

Run: `npm test`
Expected: all green (0 failed). Fix any regression before proceeding.

- [ ] **Step 2: Build.**

Run: `npm run build`
Expected: clean (the >500 kB chunk warning is pre-existing, ignore).

- [ ] **Step 3: Typecheck.**

Run: `npx tsc -b`
Expected: clean.

- [ ] **Step 4: Commit any final fixes, then the branch is ready for PR + ff-merge to master.**

---

## Self-review notes

- **Part 1 spec coverage:** applyUpgrade-queues (design §3.1 → Task 3), accounting (§3.2 → Task 3), promotion (§3.3 → Task 4), completion (§3.4 → Task 5), producing-while-queued (§3.5 → Task 5), cancel LIFO (§3.6 → Task 6), UI (§3.7 → Tasks 8–9), SPEC (§4 → Task 10), persistence (§5 → Task 7), Swarm-Assembly fix (§9 → Task 2b). Demolish-purge edge added (Task 6).
- **Part 2 spec coverage:** field + migration (design §10/§16 → Tasks 1, 7), helpers (§10 → Task 11), operational/cluster gating + active-floor cluster (§11/§12 → Task 12), effect scaling (§12 → Task 13), toggling + cap-delta + overflow clamp (§13 → Task 14), wear/maintenance/alerts (§14 → Task 14), UI steppers + route-drain-at-0 + field removal (§15 → Task 15), SPEC (§17 → Task 16).
- **Type consistency:** `BuildJob` defined once (economy.ts, Task 1); `countQueuedUpgrades`/`topUpgradeLevel` (Task 2) used by Tasks 3/6/9; `activeFloors`/`activeFloorLevel` (Task 11) used by Tasks 12/13/14/15; `disabled` field removed only in Task 15 after all consumers migrated (Tasks 12, 14, 15). `promoteQueuedBuilds`/`setBuildingActiveFloors` signatures stable across tasks.
- **Out of scope:** Part 1 — placements stay on building flags, running-upgrade downtime unchanged, no parallel same-building upgrades (design §7). Part 2 — single floor-count (no per-floor pick), no scheduling/automation, toggling always free (design §18).
- **Ordering invariant:** each task compiles + tests green before the next; the `disabled`→`disabledFloors` consumer migration spans Tasks 12 (predicates), 14 (wear/maintenance/alerts), 15 (UI + field deletion) — keep that order so no commit references a removed field.
