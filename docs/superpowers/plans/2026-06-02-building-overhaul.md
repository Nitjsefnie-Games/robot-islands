# Building Overhaul Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add cancel-construction (100% refund), a FIFO build queue feeding the existing parallel slots, mirror Robotics skill nodes scaling queue capacity at a 1:2 ratio, and a persistent floor-level badge on every building.

**Architecture:** A queued build is a `PlacedBuilding` already committed to the map with a `queued: true` flag — it reserves its footprint and is paid at enqueue, but does not tick until promoted into a free running slot at the construction-completion boundary inside `advanceIsland`. Cancel is one uniform pure operation (remove + full refund) for both queued and running builds, with a distinct revert path for in-progress upgrades. Queue capacity mirrors `parallelBuildSlots` via two new Robotics nodes.

**Tech Stack:** Vite 5 + TypeScript strict + PixiJS 8 + vitest. Pure-math layer (`placement.ts`, `economy.ts`, `construction.ts`, `skilltree.ts`, `persistence.ts`) is tested without a renderer; render/UI layer (`building-alerts-overlay.ts`, the new queue window) is verified by `npm run build` + browser screenshot.

**Design spec:** `docs/superpowers/specs/2026-06-02-building-overhaul-design.md`

---

## File Structure

- `src/buildings.ts` — add `queued?: boolean`, `queueSeq?: number` to `PlacedBuilding`.
- `src/economy.ts` — add `nextQueueSeq?: number` to `IslandState`; add the promotion hook in `advanceIsland`.
- `src/construction.ts` — `tickConstruction` / `nextConstructionCompletionMs` skip queued buildings.
- `src/skilltree.ts` — `queueCapAdd` + `parallelQueue` effect kinds; `SkillMultipliers.queueCapBonus`; aggregation; hover formatter.
- `src/skilltree-derive-magnitudes.ts` — `queueCapAdd: 4.0`.
- `src/skilltree-archetypes.ts` — label for `queueCapAdd`.
- `src/skilltree-catalog.ts` — `robotics.notable.queueFoundries` + `robotics.keystone.queueConstruction` + edges/prereqs.
- `src/placement.ts` — `queuedBuildSlots`, `queuedBuildCount`, `inProgressBuildCount` (running-only), enqueue path in `placeBuilding`/`applyUpgrade`, `cancelConstruction`.
- `src/persistence.ts` — v17→v18 alias + `migrateV17toV18` + dispatch + `SUPPORTED_LOAD_VERSIONS`.
- `src/build-queue-ui.ts` (new) — draggable top-left queue window.
- `src/input.ts` — register `cancel-build` action(s) used by the window.
- `src/building-alerts-overlay.ts` — persistent bottom-right level badge.
- `SPEC.md` — §9.3 / §4 / §15.1 / §15.3 alignment.

Run all tests with `npm test`; a single file with `npx vitest run src/<file>.test.ts`; a single test with `npx vitest run -t "<name>"`. Build with `npm run build`.

---

### Task 1: Building + island-state model fields

**Files:**
- Modify: `src/buildings.ts` (the `PlacedBuilding` interface, near `constructionRemainingMs` ~line 78)
- Modify: `src/economy.ts` (the `IslandState` interface, ~line 229)
- Test: `src/buildings.test.ts` (append)

- [ ] **Step 1: Write the failing test**

Append to `src/buildings.test.ts`:

```typescript
import { describe, it, expect } from 'vitest';
import type { PlacedBuilding } from './buildings.js';

describe('queue model fields', () => {
  it('PlacedBuilding accepts queued + queueSeq', () => {
    const b: PlacedBuilding = {
      id: 'placed-1', defId: 'mine', x: 0, y: 0, rotation: 0,
      constructionRemainingMs: 30000, queued: true, queueSeq: 3,
    };
    expect(b.queued).toBe(true);
    expect(b.queueSeq).toBe(3);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/buildings.test.ts -t "PlacedBuilding accepts queued"`
Expected: FAIL — `Object literal may only specify known properties` / type error on `queued`.

(If `npm run build` is the only way the strict error surfaces, run `npm run build` — expect TS2353 on `queued`.)

- [ ] **Step 3: Add the fields**

In `src/buildings.ts`, immediately after the `constructionRemainingMs?: number;` field, add:

```typescript
  /** §queue: true while this placement/upgrade waits in the build queue. A
   *  queued build occupies its footprint and has paid its cost, but does NOT
   *  tick (`tickConstruction`/`nextConstructionCompletionMs` skip it) and is
   *  excluded from the running-slot count. Promoted to running (flag cleared)
   *  at the construction-completion boundary in `advanceIsland`. Optional;
   *  absent ≡ false (forward-compat: pre-v18 saves omit it). */
  queued?: boolean;
  /** §queue: monotonic per-island enqueue order, for deterministic FIFO
   *  promotion (lowest seq promotes first). Sourced from `IslandState.nextQueueSeq`,
   *  never wall-clock. Optional; absent ≡ 0 (placement order). */
  queueSeq?: number;
```

In `src/economy.ts`, inside the `IslandState` interface (near `lastTick`), add:

```typescript
  /** §queue: next FIFO sequence number to stamp on an enqueued build.
   *  Incremented on each enqueue. Optional; absent ≡ 0 (forward-compat). */
  nextQueueSeq?: number;
```

- [ ] **Step 4: Run test + build to verify pass**

Run: `npx vitest run src/buildings.test.ts -t "PlacedBuilding accepts queued"` → PASS
Run: `npm run build` → clean (tsc -b passes).

- [ ] **Step 5: Commit**

```bash
git add src/buildings.ts src/economy.ts src/buildings.test.ts
git commit -m "feat(queue): add queued/queueSeq building fields + nextQueueSeq island counter

Co-Authored-By: <SUBAGENT MODEL NAME> <noreply@...>"
```

---

### Task 2: Skill-tree effect kinds — `queueCapAdd` + `parallelQueue`

**Files:**
- Modify: `src/skilltree.ts` (`StructuralEffectData` ~line 74; `SkillEffect` union ~line 117; `SkillMultipliers` ~line 833; `blankMultipliers` ~line 891; aggregation switch ~line 1027; hover formatter ~line 1279)
- Modify: `src/skilltree-derive-magnitudes.ts` (the magnitude table ~line 74)
- Modify: `src/skilltree-archetypes.ts` (the label switch ~line 63)
- Test: `src/skilltree.test.ts` (append)

- [ ] **Step 1: Write the failing test**

Append to `src/skilltree.test.ts` (mirror the existing `parallelBuildBonus` test style in that file):

```typescript
import { describe, it, expect } from 'vitest';
import { effectiveSkillMultipliers } from './skilltree.js';
import { makeTestIslandState } from './test-helpers.js'; // use the same helper other skilltree tests use

describe('queueCapBonus aggregation', () => {
  it('queueCapAdd nodes sum into queueCapBonus; default 0', () => {
    const fresh = makeTestIslandState();
    expect(effectiveSkillMultipliers(fresh).queueCapBonus).toBe(0);
  });
});
```

> NOTE: match the actual helper the existing tests in `src/skilltree.test.ts` use to build a state and to unlock nodes. If a helper that owns `robotics.notable.queueFoundries` is needed it is added in Task 3 — for now assert only the default.

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/skilltree.test.ts -t "queueCapBonus"`
Expected: FAIL — `queueCapBonus` does not exist on `SkillMultipliers`.

- [ ] **Step 3: Add the effect kinds + multiplier + aggregation**

In `src/skilltree.ts`:

(a) Extend `StructuralEffectData` (~line 74):

```typescript
export type StructuralEffectData =
  | { readonly kind: 'sharedPowerGrid' }
  | { readonly kind: 'parallelConstruction'; readonly bonus: number }
  | { readonly kind: 'parallelQueue'; readonly bonus: number };
```

(b) Add to the `SkillEffect` union, right after the `parallelBuildCapAdd` line (~line 118):

```typescript
  | { readonly kind: 'queueCapAdd' }
```

(c) In `SkillMultipliers` (~line 833), after `parallelBuildBonus`:

```typescript
  /** §queue mirror of parallelBuildBonus — extra build-QUEUE capacity on top
   *  of the base 2. Stored as the additive bonus, floored at the caller. */
  readonly queueCapBonus: number;
```

(d) In `blankMultipliers()` (~line 891), after `parallelBuildBonus: 0,`:

```typescript
    queueCapBonus: 0,
```

(e) In the aggregation switch (~line 1027, right after the `parallelBuildCapAdd` case), add a sibling case. Find where `let parallelBuildBonus = 0;` is declared (~line 940) and add `let queueCapBonus = 0;` beside it; add to the returned object (~line 1105) `queueCapBonus,`. Then the case:

```typescript
      case 'queueCapAdd':
        // Additive mirror of parallelBuildCapAdd. The placement.ts consumer
        // Math.floor()s, so the integer queue-slot count is preserved.
        queueCapBonus += node.magnitude;
        break;
```

(f) Hover formatter (~line 1279), beside the `parallelBuildCapAdd` line:

```typescript
  if (kind === 'queueCapAdd') return `+${node.magnitude.toFixed(3)}`;
```

In `src/skilltree-derive-magnitudes.ts` (~line 74, beside `parallelBuildCapAdd: 2.0,`):

```typescript
  queueCapAdd: 4.0,
```

In `src/skilltree-archetypes.ts` (~line 63, beside the `parallelBuildCapAdd` case):

```typescript
    case 'queueCapAdd':                return 'build queue slots';
```

- [ ] **Step 4: Run test + build to verify pass**

Run: `npx vitest run src/skilltree.test.ts -t "queueCapBonus"` → PASS
Run: `npm run build` → clean. Fix any non-exhaustive-switch TS errors the new union member surfaces (the magnitude-derivation map and any `switch (effect.kind)` that must stay exhaustive).

- [ ] **Step 5: Commit**

```bash
git add src/skilltree.ts src/skilltree-derive-magnitudes.ts src/skilltree-archetypes.ts src/skilltree.test.ts
git commit -m "feat(queue): queueCapAdd + parallelQueue skill effect kinds, queueCapBonus multiplier

Co-Authored-By: <SUBAGENT MODEL NAME> <noreply@...>"
```

---

### Task 3: Mirror skill nodes in the Robotics catalog

**Files:**
- Modify: `src/skilltree-catalog.ts` (add nodes near `parallelFoundries` ~line 130 and the rule-breaker keystones ~line 808; add edges/prereqs near lines 953 / 1059)
- Test: `src/skilltree.test.ts` (append); `src/skilltree-budget.test.ts` must still pass.

- [ ] **Step 1: Write the failing test**

Append to `src/skilltree.test.ts`:

```typescript
import { DEFAULT_GRAPH } from './skilltree.js';

describe('queue mirror nodes', () => {
  it('queueFoundries (+4) and queueConstruction (+2) exist; full robotics gives 1:2', () => {
    const ids = new Set(DEFAULT_GRAPH.nodes.map((n) => n.id));
    expect(ids.has('robotics.notable.queueFoundries')).toBe(true);
    expect(ids.has('robotics.keystone.queueConstruction')).toBe(true);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/skilltree.test.ts -t "queue mirror nodes"`
Expected: FAIL — ids not present.

- [ ] **Step 3: Add the nodes**

In `src/skilltree-catalog.ts`, beside `robotics.notable.parallelFoundries` (~line 130), add:

```typescript
  {
    id: 'robotics.notable.queueFoundries' as NodeId,
    subPath: 'robotics',
    depth: 5,
    cost: 5,
    effect: { kind: 'queueCapAdd' },
    description: 'Queue Foundries — build queue slots'
  },
```

Beside `robotics.keystone.parallelConstruction` in `RULE_BREAKER_KEYSTONES` (~line 808), add:

```typescript
  {
    id: 'robotics.keystone.queueConstruction' as NodeId,
    subPath: 'robotics', depth: 7, cost: 8,
    effect: { kind: 'structural', description: 'Queue Construction +2 queue', data: { kind: 'parallelQueue', bonus: 2 } },
    description: 'Queue Construction — +2 build queue slots'
  },
```

Wire edges/prereqs mirroring `parallelConstruction`. Near line 953 add a `ksp(...)` keystone-prereq entry for `robotics.keystone.queueConstruction` using the SAME prereq nodes pattern as `parallelConstruction` (read the `ksp` signature in this file and the existing line 953 call; reuse `robotics.notable.swarmAssembly` + `robotics.notable.queueFoundries`). Add `be(...)` edges so the new notable/keystone are reachable in the robotics chain exactly as `parallelFoundries`/`parallelConstruction` are (read the surrounding `be(...)` edge calls ~line 1059 and mirror them, pointing into the new node ids).

- [ ] **Step 4: Run tests + build to verify pass**

Run: `npx vitest run src/skilltree.test.ts -t "queue mirror nodes"` → PASS
Run: `npx vitest run src/skilltree-budget.test.ts` → PASS (confirm `robotics: ≤ 23 total nodes` still green — it gains exactly 2 non-filler nodes; if it now exceeds 23, STOP and report — the design assumed headroom).
Run: `npm run build` → clean.

- [ ] **Step 5: Commit**

```bash
git add src/skilltree-catalog.ts src/skilltree.test.ts
git commit -m "feat(queue): mirror Robotics nodes queueFoundries (+4) + queueConstruction (+2)

Co-Authored-By: <SUBAGENT MODEL NAME> <noreply@...>"
```

---

### Task 4: Capacities — `queuedBuildSlots`, `queuedBuildCount`, running-only `inProgressBuildCount`

**Files:**
- Modify: `src/placement.ts` (`parallelBuildSlots`/`inProgressBuildCount` ~line 415-430)
- Test: `src/placement.test.ts` (append)

- [ ] **Step 1: Write the failing test**

```typescript
import { describe, it, expect } from 'vitest';
import { queuedBuildSlots, queuedBuildCount, inProgressBuildCount } from './placement.js';
import { makeTestIslandState } from './test-helpers.js'; // match existing placement.test.ts helpers

describe('queue capacities', () => {
  it('base queuedBuildSlots is 2', () => {
    expect(queuedBuildSlots(makeTestIslandState())).toBe(2);
  });
  it('inProgressBuildCount counts running only; queuedBuildCount counts queued', () => {
    const s = makeTestIslandState();
    s.buildings.push(
      { id: 'a', defId: 'mine', x: 0, y: 0, rotation: 0, constructionRemainingMs: 1000 },
      { id: 'b', defId: 'mine', x: 1, y: 0, rotation: 0, constructionRemainingMs: 1000, queued: true },
    );
    expect(inProgressBuildCount(s)).toBe(1);
    expect(queuedBuildCount(s)).toBe(1);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/placement.test.ts -t "queue capacities"`
Expected: FAIL — `queuedBuildSlots`/`queuedBuildCount` not exported; `inProgressBuildCount` returns 2 (counts the queued one).

- [ ] **Step 3: Implement**

In `src/placement.ts`, change `inProgressBuildCount` to exclude queued, and add the two new functions beside it:

```typescript
/** Count of currently-RUNNING (ticking) construction jobs — excludes queued. */
export function inProgressBuildCount(state: IslandState): number {
  let n = 0;
  for (const b of state.buildings) {
    if ((b.constructionRemainingMs ?? 0) > 0 && b.queued !== true) n++;
  }
  return n;
}

/** Count of builds currently waiting in the queue. */
export function queuedBuildCount(state: IslandState): number {
  let n = 0;
  for (const b of state.buildings) {
    if (b.queued === true) n++;
  }
  return n;
}

/** §queue mirror of `parallelBuildSlots`: base 2 + floor(queueCapBonus)
 *  + structural `parallelQueue` (+2 when owned). Holds a 1:2 ratio with
 *  running slots at empty and full skill tree. */
export function queuedBuildSlots(state: IslandState): number {
  const skillBonus = Math.floor(effectiveSkillMultipliers(state).queueCapBonus);
  const structural = hasStructuralEffect('parallelQueue', state, DEFAULT_GRAPH) ? 2 : 0;
  return 2 + skillBonus + structural;
}
```

> `hasStructuralEffect` is imported in `placement.ts` already (line 40). Confirm `src/structural.ts` `hasStructuralEffect` matches on the `data.kind` string `'parallelQueue'` the same way it does `'parallelConstruction'` — if `structural.ts` has an explicit allow-list of kinds, add `'parallelQueue'` to it.

- [ ] **Step 4: Run test + build to verify pass**

Run: `npx vitest run src/placement.test.ts -t "queue capacities"` → PASS
Run: `npm run build` → clean.

- [ ] **Step 5: Audit existing `inProgressBuildCount` callers**

The semantics narrowed (running-only). Find every caller and confirm each still wants "running" (they do — all current callers gate against `parallelBuildSlots`):

Run: `grep -rn "inProgressBuildCount" src/*.ts | grep -v test`
Expected callers: `placement.ts` (placeBuilding, applyUpgrade), `inspector-ui.ts` (upgrade gate). All gate running slots → correct unchanged.

- [ ] **Step 6: Commit**

```bash
git add src/placement.ts src/placement.test.ts
git commit -m "feat(queue): queuedBuildSlots + queuedBuildCount; inProgressBuildCount is running-only

Co-Authored-By: <SUBAGENT MODEL NAME> <noreply@...>"
```

---

### Task 5: `construction.ts` skips queued builds

**Files:**
- Modify: `src/construction.ts` (`tickConstruction`, `nextConstructionCompletionMs`)
- Test: `src/construction.test.ts` (append)

- [ ] **Step 1: Write the failing test**

```typescript
import { describe, it, expect } from 'vitest';
import { tickConstruction, nextConstructionCompletionMs } from './construction.js';
import type { PlacedBuilding } from './buildings.js';

describe('queued builds do not tick', () => {
  it('tickConstruction leaves a queued build untouched and returns false', () => {
    const b: PlacedBuilding = { id: 'q', defId: 'mine', x: 0, y: 0, rotation: 0, constructionRemainingMs: 5000, queued: true };
    expect(tickConstruction(b, 9999)).toBe(false);
    expect(b.constructionRemainingMs).toBe(5000);
  });
  it('nextConstructionCompletionMs ignores queued builds', () => {
    const running: PlacedBuilding = { id: 'r', defId: 'mine', x: 0, y: 0, rotation: 0, constructionRemainingMs: 3000 };
    const queued: PlacedBuilding = { id: 'q', defId: 'mine', x: 1, y: 0, rotation: 0, constructionRemainingMs: 1000, queued: true };
    expect(nextConstructionCompletionMs([queued, running], 0)).toBe(3000);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/construction.test.ts -t "queued builds do not tick"`
Expected: FAIL — queued build ticks to 0 / completion returns 1000.

- [ ] **Step 3: Implement**

In `tickConstruction`, add a guard at the top after reading `remaining`:

```typescript
export function tickConstruction(b: PlacedBuilding, dtMs: number): boolean {
  if (b.queued === true) return false;
  const remaining = b.constructionRemainingMs ?? 0;
  // ... unchanged ...
```

In `nextConstructionCompletionMs`, skip queued in the loop:

```typescript
  for (const b of buildings) {
    if (b.queued === true) continue;
    const r = b.constructionRemainingMs ?? 0;
    // ... unchanged ...
```

- [ ] **Step 4: Run test + build to verify pass**

Run: `npx vitest run src/construction.test.ts -t "queued builds do not tick"` → PASS
Run: `npm run build` → clean.

- [ ] **Step 5: Commit**

```bash
git add src/construction.ts src/construction.test.ts
git commit -m "feat(queue): tickConstruction + nextConstructionCompletionMs skip queued builds

Co-Authored-By: <SUBAGENT MODEL NAME> <noreply@...>"
```

---

### Task 6: Enqueue path in `placeBuilding` + `applyUpgrade`

**Files:**
- Modify: `src/placement.ts` (`placeBuilding` slot gate ~line 520; `applyUpgrade` slot gate ~line 816)
- Test: `src/placement.test.ts` (append)

When running slots are full but the queue has room, commit the build/upgrade as `queued` instead of rejecting. Materials still deduct (deduct-at-enqueue). The new building's `constructionRemainingMs` is its full timer (it will start counting once promoted). Stamp `queued: true` + `queueSeq` and bump `state.nextQueueSeq`.

- [ ] **Step 1: Write the failing test**

```typescript
import { placeBuilding, parallelBuildSlots } from './placement.js';

describe('enqueue when slots full', () => {
  it('a placement past the running cap is committed as queued, paid, FIFO-stamped', () => {
    const s = makeTestIslandState();            // base: 1 running slot, 2 queue
    // fill the single running slot
    s.buildings.push({ id: 'run', defId: 'mine', x: 5, y: 5, rotation: 0, constructionRemainingMs: 30000 });
    const before = s.inventory.stone ?? 0;
    let seq = 0;
    const res = placeBuilding(s.spec, s.state ?? s, 'mine', 0, 0, 0, () => `placed-${seq++}`);
    expect(res.ok).toBe(true);
    if (res.ok) {
      expect(res.placed.queued).toBe(true);
      expect(typeof res.placed.queueSeq).toBe('number');
    }
    expect((s.inventory.stone ?? 0)).toBeLessThan(before); // cost was deducted
  });
});
```

> NOTE: adapt `s.spec` / `s.state` to the actual shape returned by `makeTestIslandState` in `placement.test.ts` (the existing placement tests already call `placeBuilding` — copy their fixture setup exactly, including how they obtain `spec` and `state` and a buildable tile for `mine`).

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/placement.test.ts -t "enqueue when slots full"`
Expected: FAIL — `placeBuilding` returns `{ ok: false, reason: 'queue-full' }`.

- [ ] **Step 3: Implement enqueue in `placeBuilding`**

Replace the queue-full rejection (~line 523-527) so it enqueues when the queue has room. After computing `slots` and `inProgress`, compute whether this build must be queued, and only hard-reject if the queue is also full:

```typescript
  const slots = parallelBuildSlots(state);
  const inProgress = inProgressBuildCount(state);
  const mustQueue = inProgress >= slots;
  if (mustQueue && queuedBuildCount(state) >= queuedBuildSlots(state)) {
    return { ok: false, reason: 'queue-full', inProgress, slots };
  }
```

Then, where the building object is constructed (the `const placed: PlacedBuilding = { ... }` near the end of `placeBuilding`), set the queue fields when `mustQueue`:

```typescript
    ...(mustQueue ? { queued: true, queueSeq: state.nextQueueSeq ?? 0 } : {}),
```

and immediately after committing, bump the counter when queued:

```typescript
  if (mustQueue) state.nextQueueSeq = (state.nextQueueSeq ?? 0) + 1;
```

> The cost deduction and storage-cap credit already happen unconditionally in `placeBuilding` — leave them; deduct-at-enqueue is exactly this. Do NOT move them below the queue decision.

- [ ] **Step 4: Implement enqueue in `applyUpgrade`**

In `applyUpgrade` (~line 816), replace the hard `queue-full` return with the same mustQueue logic, and set `queued`/`queueSeq` on the building when queued:

```typescript
  const slots = parallelBuildSlots(state);
  const inProgress = inProgressBuildCount(state);
  const mustQueue = inProgress >= slots;
  if (mustQueue && queuedBuildCount(state) >= queuedBuildSlots(state)) {
    return { ok: false, reason: 'queue-full', inProgress, slots };
  }
```

After the existing `b.floorLevel = newL;` and `constructionRemainingMs` assignment, add:

```typescript
  if (mustQueue) {
    b.queued = true;
    b.queueSeq = state.nextQueueSeq ?? 0;
    state.nextQueueSeq = (state.nextQueueSeq ?? 0) + 1;
  }
```

> The existing immediate storage-cap credit + `floorLevel` set stay as-is (a queued upgrade reserves its level + storage immediately, identical to a running upgrade; production scaling is still gated by `constructionRemainingMs` via `computeRates`). Cancel-upgrade (Task 8) reverses both.

- [ ] **Step 5: Run test + build to verify pass**

Run: `npx vitest run src/placement.test.ts -t "enqueue when slots full"` → PASS
Run: `npm run build` → clean.

- [ ] **Step 6: Commit**

```bash
git add src/placement.ts src/placement.test.ts
git commit -m "feat(queue): placeBuilding + applyUpgrade enqueue when running slots full

Co-Authored-By: <SUBAGENT MODEL NAME> <noreply@...>"
```

---

### Task 7: Promotion hook in `advanceIsland`

**Files:**
- Modify: `src/economy.ts` (the segment loop in `advanceIsland`, at the construction-completion handling)
- Test: `src/economy.test.ts` (append)

When a running build finishes during a segment and a running slot frees, promote the lowest-`queueSeq` queued build by clearing its `queued` flag (it then ticks from the next segment). Promote repeatedly while slots are free and the queue is non-empty.

- [ ] **Step 1: Write the failing test**

```typescript
import { describe, it, expect } from 'vitest';
import { advanceIsland, makeInitialIslandState } from './economy.js';
// build a spec/state with 1 running slot, one running build about to finish,
// and one queued build; advance past the running build's completion.

describe('queue promotion on completion', () => {
  it('promotes FIFO head into the freed slot when a running build completes', () => {
    // Construct via the same fixtures economy.test.ts already uses.
    // running build: constructionRemainingMs = 1000 (finishes at t0+1s)
    // queued build:  queued = true, constructionRemainingMs = 5000, queueSeq 0
    // advanceIsland to t0 + 2000ms
    // ASSERT: running build operational (constructionRemainingMs 0);
    //         queued build now has queued !== true and constructionRemainingMs < 5000
    //         (it began ticking after promotion).
  });
});
```

> Fill the fixture body using `economy.test.ts`'s existing construction tests as the template (there are already tests that advance a building's `constructionRemainingMs` — copy their world/state setup). The assertions above are the contract.

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/economy.test.ts -t "queue promotion on completion"`
Expected: FAIL — queued build stays `queued`, never ticks.

- [ ] **Step 3: Implement**

In `advanceIsland`, locate where a segment ends on a construction-completion boundary (the code that calls `tickConstruction` / detects a build crossing 0 — found via `nextConstructionCompletionMs` in `findNextCapEvent`). Immediately AFTER the per-segment tick where buildings may have completed, add a promotion pass:

```typescript
  // §queue promotion: after this segment's completions, fill any free running
  // slot with the FIFO head of the queue (lowest queueSeq). Repeat until slots
  // are full or the queue is empty.
  promoteQueuedBuilds(state);
```

Add the pure helper (export it for testing) in `economy.ts` or `construction.ts` (prefer `construction.ts` to keep economy lean — then import it):

```typescript
/** Promote queued builds into free running slots, FIFO by queueSeq, until
 *  slots are full or the queue is empty. A promoted build clears its `queued`
 *  flag and begins ticking on the next segment. Pure mutation on `state`. */
export function promoteQueuedBuilds(state: IslandState): void {
  let free = parallelBuildSlots(state) - inProgressBuildCount(state);
  if (free <= 0) return;
  const queued = state.buildings
    .filter((b) => b.queued === true)
    .sort((a, b) => (a.queueSeq ?? 0) - (b.queueSeq ?? 0));
  for (const b of queued) {
    if (free <= 0) break;
    b.queued = false;
    free--;
  }
}
```

> `promoteQueuedBuilds` lives wherever it can import `parallelBuildSlots`/`inProgressBuildCount` without a cycle. If `placement.ts` ↔ `economy.ts` would cycle, put `promoteQueuedBuilds` in `placement.ts` (it already owns those two functions) and import it into `economy.ts`. Verify with `npm run build` (TS will flag a cycle as a type error only if it breaks resolution; otherwise confirm no runtime `undefined` import).

- [ ] **Step 4: Run test + build to verify pass**

Run: `npx vitest run src/economy.test.ts -t "queue promotion on completion"` → PASS
Run: `npm run build` → clean. Run full economy suite: `npx vitest run src/economy.test.ts` → all PASS.

- [ ] **Step 5: Commit**

```bash
git add src/economy.ts src/placement.ts src/economy.test.ts
git commit -m "feat(queue): promote FIFO queue head into freed running slots in advanceIsland

Co-Authored-By: <SUBAGENT MODEL NAME> <noreply@...>"
```

---

### Task 8: `cancelConstruction` — full refund (placement + upgrade shapes)

**Files:**
- Modify: `src/placement.ts` (new `CancelResult` interface + `cancelConstruction`, near `demolishBuilding` ~line 892)
- Test: `src/placement.test.ts` (append)

Cancel is valid only while `constructionRemainingMs > 0` (queued or running). Discriminator: `floorLevel(b) === 0` → fresh placement (remove building, refund 100% of placement cost, strip storage contribution, free slot). `floorLevel(b) >= 1` → in-progress upgrade (keep building, revert `floorLevel` to L-1, clear `constructionRemainingMs`, refund `upgradeCost(def)`, strip the storage delta `applyUpgrade` granted).

- [ ] **Step 1: Write the failing test**

```typescript
import { placeBuilding, applyUpgrade, cancelConstruction, placementCostFor, upgradeCost } from './placement.js';
import { BUILDING_DEFS } from './building-defs.js';

describe('cancelConstruction full refund', () => {
  it('cancelling a fresh in-progress placement removes the building and refunds 100%', () => {
    const f = /* fixture: state with a buildable tile, ample inventory */;
    const before = f.state.inventory.stone ?? 0;
    const res = placeBuilding(f.spec, f.state, 'mine', 0, 0, 0, () => 'placed-x');
    expect(res.ok).toBe(true);
    const afterPlace = f.state.inventory.stone ?? 0;
    const c = cancelConstruction(f.spec, f.state, 'placed-x');
    expect(c.ok).toBe(true);
    expect(f.spec.buildings.find((b) => b.id === 'placed-x')).toBeUndefined();
    expect(f.state.inventory.stone ?? 0).toBe(before); // full refund: back to pre-place
  });

  it('cancelling an in-progress upgrade reverts the level and refunds the upgrade cost', () => {
    const f = /* fixture with an operational mine at floorLevel 0, 1 free slot */;
    const beforeUp = f.state.inventory.stone ?? 0;
    const up = applyUpgrade(f.spec, f.state, 'mine-1');
    expect(up.ok).toBe(true);
    const b = f.spec.buildings.find((x) => x.id === 'mine-1')!;
    expect(b.floorLevel).toBe(1);
    const c = cancelConstruction(f.spec, f.state, 'mine-1');
    expect(c.ok).toBe(true);
    expect(b.floorLevel ?? 0).toBe(0);                  // reverted
    expect(b.constructionRemainingMs ?? 0).toBe(0);      // cleared
    expect(f.state.inventory.stone ?? 0).toBe(beforeUp); // upgrade cost refunded
  });
});
```

> Fill the `/* fixture */` blocks from the existing `placement.test.ts` setup helpers (same ones Task 4/6 used). Use a building def with a known `placementCost` containing `stone` (e.g. `mine`).

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/placement.test.ts -t "cancelConstruction full refund"`
Expected: FAIL — `cancelConstruction` not exported.

- [ ] **Step 3: Implement**

Add near `demolishBuilding`:

```typescript
export interface CancelResult {
  readonly ok: boolean;
  /** Resources credited back (full refund; pre-cap-clamp amounts that fit). */
  readonly refunded: Partial<Record<ResourceId, number>>;
  readonly reason?: 'not-found' | 'not-building';
}

/** Cancel an in-progress (running OR queued) construction job for a 100%
 *  material refund. Distinct from §6.7 demolish (30% scrap) and relocate
 *  (half-fee). Two shapes by `floorLevel`:
 *    - floorLevel 0 → fresh placement: remove building, refund placement cost,
 *      strip storage contribution, free the slot.
 *    - floorLevel >= 1 → in-progress upgrade: keep building, revert to
 *      floorLevel-1, clear the timer, refund the upgrade cost, strip the
 *      storage delta the upgrade granted.
 *  Only valid while constructionRemainingMs > 0. Pure mutation. */
export function cancelConstruction(
  spec: IslandSpec,
  state: IslandState,
  buildingId: string,
): CancelResult {
  const idx = spec.buildings.findIndex((b) => b.id === buildingId);
  if (idx < 0) return { ok: false, refunded: {}, reason: 'not-found' };
  const b = spec.buildings[idx]!;
  if ((b.constructionRemainingMs ?? 0) <= 0) return { ok: false, refunded: {}, reason: 'not-building' };
  const def = BUILDING_DEFS[b.defId];
  const L = floorLevel(b);

  const creditRefund = (cost: Partial<Record<ResourceId, number>>): Partial<Record<ResourceId, number>> => {
    const refunded: Partial<Record<ResourceId, number>> = {};
    for (const [r, n] of Object.entries(cost) as Array<[ResourceId, number]>) {
      if (n <= 0) continue;
      const have = state.inventory[r] ?? 0;
      const cap = state.storageCaps[r] ?? 0;
      const next = Math.min(cap, have + n);
      const credited = next - have;
      if (credited > 0) { state.inventory[r] = next; refunded[r] = credited; }
    }
    return refunded;
  };

  if (L === 0) {
    // Fresh placement: refund placement cost (incl. terrain-modifier upfront),
    // strip storage contribution, remove the building, free the slot.
    const fullCost: Partial<Record<ResourceId, number>> = { ...placementCostFor(def) };
    if (def.terrainModifier === true && b.terrainTarget !== undefined) {
      for (const [r, n] of Object.entries(conversionCostForTarget(b.terrainTarget)) as Array<[ResourceId, number]>) {
        fullCost[r] = (fullCost[r] ?? 0) + n;
      }
    }
    spec.buildings.splice(idx, 1);
    const storage = def.storage;
    if (storage) {
      const strip = (r: ResourceId): void => {
        const next = (state.storageCaps[r] ?? 0) - floorScaledCapacity(b, storage.capacity);
        state.storageCaps[r] = next < 0 ? 0 : next;
        const have = state.inventory[r] ?? 0;
        const newCap = state.storageCaps[r] ?? 0;
        if (have > newCap) state.inventory[r] = newCap;
      };
      if (storage.category === 'generic') { if (b.cargoLabel !== undefined) strip(b.cargoLabel); }
      else { for (const r of ALL_RESOURCES as ReadonlyArray<ResourceId>) if (RESOURCE_STORAGE_CATEGORY[r] === storage.category) strip(r); }
    }
    return { ok: true, refunded: creditRefund(fullCost) };
  }

  // In-progress upgrade: revert level, clear timer, refund upgrade cost,
  // strip the storage delta the upgrade granted (+storage.capacity).
  b.floorLevel = L - 1;
  (b as { constructionRemainingMs?: number }).constructionRemainingMs = 0;
  b.queued = false;
  const storage = def.storage;
  if (storage) {
    const delta = storage.capacity;
    const stripDelta = (r: ResourceId): void => {
      const next = (state.storageCaps[r] ?? 0) - delta;
      state.storageCaps[r] = next < 0 ? 0 : next;
      const have = state.inventory[r] ?? 0;
      const newCap = state.storageCaps[r] ?? 0;
      if (have > newCap) state.inventory[r] = newCap;
    };
    if (storage.category === 'generic') { if (b.cargoLabel !== undefined) stripDelta(b.cargoLabel); }
    else { for (const r of ALL_RESOURCES as ReadonlyArray<ResourceId>) if (RESOURCE_STORAGE_CATEGORY[r] === storage.category) stripDelta(r); }
  }
  return { ok: true, refunded: creditRefund(upgradeCost(def)) };
}
```

> Confirm `conversionCostForTarget`, `floorScaledCapacity`, `placementCostFor`, `upgradeCost`, `ALL_RESOURCES`, `RESOURCE_STORAGE_CATEGORY` are already imported in `placement.ts` (they are used by `placeBuilding`/`demolishBuilding`). For a fresh placement `floorScaledCapacity(b, …)` at floorLevel 0 equals the base capacity — matching what `placeBuilding` credited.

- [ ] **Step 4: Run tests + build to verify pass**

Run: `npx vitest run src/placement.test.ts -t "cancelConstruction full refund"` → PASS
Run: `npm run build` → clean.

- [ ] **Step 5: Add a queued-cancel + promotion test**

```typescript
it('cancelling a queued placement removes it and frees queue room (no slot change)', () => {
  // fixture: 1 running slot occupied; enqueue a placement; cancel it; queuedBuildCount back to 0
});
```
Run it → PASS.

- [ ] **Step 6: Commit**

```bash
git add src/placement.ts src/placement.test.ts
git commit -m "feat(cancel): cancelConstruction — 100% refund for placements + upgrade revert

Co-Authored-By: <SUBAGENT MODEL NAME> <noreply@...>"
```

---

### Task 9: Persistence migration v17 → v18

**Files:**
- Modify: `src/persistence.ts` (`SCHEMA_VERSION` ~line 74; `SUPPORTED_LOAD_VERSIONS` ~line 82; add `SerializedSnapshotV17` alias + `migrateV17toV18`; wire into `loadWorld` dispatch ~line 688)
- Test: `src/persistence.test.ts` (append)

The new fields (`queued`, `queueSeq`, `nextQueueSeq`) are all optional with absent ≡ default, so the migration is a pure version bump (no data backfill needed) — but per AGENTS.md it must still be an explicit `migrateV17toV18` step with the alias + supported-version entry + tests.

- [ ] **Step 1: Write the failing test**

```typescript
import { describe, it, expect } from 'vitest';
import { migrateV17toV18, SCHEMA_VERSION, SUPPORTED_LOAD_VERSIONS } from './persistence.js';

describe('v17 -> v18 migration', () => {
  it('SCHEMA_VERSION is 18 and 18 is supported', () => {
    expect(SCHEMA_VERSION).toBe(18);
    expect(SUPPORTED_LOAD_VERSIONS.has(17)).toBe(true);
    expect(SUPPORTED_LOAD_VERSIONS.has(18)).toBe(true);
  });
  it('migrateV17toV18 bumps v and preserves islandStates/world', () => {
    const v17: any = { v: 17, savedAt: 1, perfAtSave: 0, world: { islands: [] }, islandStates: [] };
    const out = migrateV17toV18(v17);
    expect(out.v).toBe(18);
    expect(out.islandStates).toEqual([]);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/persistence.test.ts -t "v17 -> v18 migration"`
Expected: FAIL — `SCHEMA_VERSION` is 17 / `migrateV17toV18` not exported.

- [ ] **Step 3: Implement**

In `src/persistence.ts`:

```typescript
export const SCHEMA_VERSION = 18 as const;
export const SUPPORTED_LOAD_VERSIONS: ReadonlySet<number> = new Set([7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18]);
```

Add the alias (mirror `SerializedSnapshotV16`) and the migration:

```typescript
export type SerializedSnapshotV17 = Omit<SaveSnapshot, 'v'> & { readonly v: 17 };

/** v17 → v18: build-queue fields shipped. `queued`/`queueSeq` (per building)
 *  and `nextQueueSeq` (per island state) are all optional with absent ≡
 *  default (not queued / seq 0), so old saves need no backfill — every
 *  in-progress build loads as running, nothing queued. Pure version bump. */
export function migrateV17toV18(s: SerializedSnapshotV17): SaveSnapshot {
  return { ...s, v: 18 as const } as unknown as SaveSnapshot;
}
```

Wire into `loadWorld` after the v16→v17 step (~line 688):

```typescript
  if ((snapshot as unknown as { v: number }).v === 17) {
    snapshot = migrateV17toV18(snapshot as unknown as SerializedSnapshotV17);
  }
```

- [ ] **Step 4: Run tests + build to verify pass**

Run: `npx vitest run src/persistence.test.ts` → all PASS
Run: `npm run build` → clean.

- [ ] **Step 5: Add a round-trip + queued-field test**

```typescript
it('a queued building round-trips through save/load at v18', () => {
  // build a world with one queued building, serialize, loadWorld, assert queued + queueSeq survive
});
```
Use the existing serialize/loadWorld helpers in `persistence.test.ts`. Run → PASS.

- [ ] **Step 6: Commit**

```bash
git add src/persistence.ts src/persistence.test.ts
git commit -m "feat(persistence): bump schema v17 -> v18 for build-queue fields

Co-Authored-By: <SUBAGENT MODEL NAME> <noreply@...>"
```

---

### Task 10: Build-queue window (draggable, top-left)

**Files:**
- Create: `src/build-queue-ui.ts`
- Modify: `src/input.ts` (register a `cancel-build` action), `src/main.ts` (mount the window)
- Verify: `npm run build` + browser screenshot (no unit test — render/DOM layer)

Reuse the bottom-right HUD pattern: read `src/hud.ts` (or whichever module mounts in `Zone.BR`) end-to-end as the template for `mountPanel` usage, then mount this one in `Zone.TL` and call `makePanelDraggable` on it. Read `src/ui-zones.ts` `mountPanel` signature (line 185) + `PanelMountOptions`, and `src/window-manager.ts` `makePanelDraggable` (line 206) before writing.

- [ ] **Step 1: Read the templates**

Run: open `src/hud.ts`, `src/ui-zones.ts` (lines 41-200), `src/window-manager.ts` (lines 206-end). Note exact `mountPanel({ zone, order, ... })` options and `makePanelDraggable(el, ...)` args.

- [ ] **Step 2: Build the panel module**

Create `src/build-queue-ui.ts` exporting `mountBuildQueuePanel(getActiveIslandState, dispatch)` that:
- mounts a panel in `Zone.TL` via `mountPanel`, makes it draggable via `makePanelDraggable`;
- renders, for the active island: a header `BUILD QUEUE`, a `running N/slots` + `queued M/queueSlots` line (from `inProgressBuildCount`/`parallelBuildSlots`/`queuedBuildCount`/`queuedBuildSlots`), then a row per running build (def name + progress %) and per queued build (def name + "queued"), FIFO order by `queueSeq`;
- each row has a `CANCEL` button whose click calls `dispatch('cancel-build', { islandId, buildingId })`;
- refreshes on the same cadence the HUD uses (read how `hud.ts` schedules refresh).

> Follow `src/economy.ts`/`placement.ts` for reads only — the panel is read-only against state except via the dispatched cancel action. No `e.code` checks; no direct state mutation in the UI module.

- [ ] **Step 3: Register the action + wire cancel**

In `src/input.ts`, register a `cancel-build` action (follow the existing action-registry pattern — `actions` table). Its handler calls `cancelConstruction(spec, state, buildingId)` for the target island and triggers a HUD/queue refresh + persistence save (match how `demolish`/`relocate` actions in the inspector flow do it — read `inspector-ui.ts` demolish handler for the exact post-mutation refresh + save call).

In `src/main.ts`, call `mountBuildQueuePanel(...)` during UI bootstrap (beside the other `mount*` calls).

- [ ] **Step 4: Build + smoke-test**

Run: `npm run build` → clean.
Reload the browser tab (the dev service serves built `dist/`, no HMR). Then:
- Verify the panel appears top-left and drags.
- Place buildings past the running-slot cap → they appear under "queued"; cancel one → it disappears and inventory is refunded; let a running build finish → a queued one promotes (its row flips from "queued" to a progress %).

Run a screenshot via `mcp__daedalus__screenshot` against the active tab to confirm layout.

- [ ] **Step 5: Commit**

```bash
git add src/build-queue-ui.ts src/input.ts src/main.ts
git commit -m "feat(queue-ui): draggable top-left build-queue window with per-item cancel

Co-Authored-By: <SUBAGENT MODEL NAME> <noreply@...>"
```

---

### Task 11: Persistent floor-level badge (bottom-right)

**Files:**
- Modify: `src/building-alerts-overlay.ts`
- Verify: `npm run build` + screenshot

Add a persistent level number in the bottom-right corner of each building's footprint, always shown (including L1). The module already imports `floorLevel` and computes footprint extents per building (the construction-tint code does this).

- [ ] **Step 1: Read the overlay rebuild loop**

Read `src/building-alerts-overlay.ts` `rebuild()` in full — note how it gets each building's footprint extents (`rx/ry/rw/rh`) and how the top-left construction arc + top-right maintenance dot are drawn. The badge reuses the same per-building loop.

- [ ] **Step 2: Draw the badge**

Inside the per-building loop, after the maintenance/construction badges, draw the level badge at the bottom-right corner: a small filled rounded rect + the level number text (`floorLevel(b) + 1` to display 1..10, matching the inspector's `${fl + 1}/10` convention — confirm against `inspector-ui.ts`). Use PixiJS `Text` or a `BitmapText` consistent with the overlay's existing text usage (if the overlay is Graphics-only, add a `Text` child or a small dot+pip rendering — match whatever text mechanism the codebase already uses for on-canvas labels; check `hover-tooltip.ts`/`grid.ts` for the established pattern).

Position: bottom-right = `(rx + rw - PAD, ry + rh - PAD)`, anchored bottom-right. Always drawn (no `>= 2` gate).

- [ ] **Step 3: Build + smoke-test**

Run: `npm run build` → clean. Reload tab. Confirm every building shows its level bottom-right (a fresh L1 mine shows "1"); upgrade one and confirm the number bumps. Screenshot via `mcp__daedalus__screenshot`.

- [ ] **Step 4: Commit**

```bash
git add src/building-alerts-overlay.ts
git commit -m "feat(ui): persistent bottom-right floor-level badge on every building

Co-Authored-By: <SUBAGENT MODEL NAME> <noreply@...>"
```

---

### Task 12: SPEC.md alignment + full verification

**Files:**
- Modify: `SPEC.md` (§9.3 Robotics; §4 / §15.1 data structures; §15.3 integration; a cancel note)

- [ ] **Step 1: Update the spec prose**

- §9.3 Robotics: document build-queue capacity (base 2) and the two mirror nodes (`queueFoundries` +4, `queueConstruction` +2), holding 1:2 with parallel slots.
- §4 / §15.1: add `queued` / `queueSeq` to the building model description and `nextQueueSeq` to island state; describe cancel (100% refund) as distinct from §6.7 demolish (30% scrap) and relocate (half-fee).
- §15.3: note FIFO promotion at the construction-completion boundary.

- [ ] **Step 2: Full suite + build**

Run: `npm test` → ALL PASS (report the count).
Run: `npm run build` → clean.
Run: `npx vitest run src/skilltree-budget.test.ts` → PASS (Robotics ≤ 23).

- [ ] **Step 3: Commit**

```bash
git add SPEC.md
git commit -m "docs(spec): align §9.3/§4/§15.1/§15.3 with build-queue + cancel mechanics

Co-Authored-By: <SUBAGENT MODEL NAME> <noreply@...>"
```

---

## Self-Review notes (lead, pre-execution)

- **Spec coverage:** cancel (T8), queue + capacities (T4/T6/T7), mirror nodes (T2/T3), level badge (T11), materials-at-enqueue (T6), persistence (T9), UI (T10), spec align (T12) — all design sections mapped.
- **Type consistency:** `queued`/`queueSeq`/`nextQueueSeq`/`queueCapBonus`/`queuedBuildSlots`/`queuedBuildCount`/`cancelConstruction`/`promoteQueuedBuilds`/`migrateV17toV18` used consistently across tasks.
- **Open implementer judgment calls flagged inline:** fixture shapes in tests (copy from existing suites), `promoteQueuedBuilds` file placement (cycle-avoidance), on-canvas text mechanism for the badge, `hasStructuralEffect` allow-list for `parallelQueue`.
