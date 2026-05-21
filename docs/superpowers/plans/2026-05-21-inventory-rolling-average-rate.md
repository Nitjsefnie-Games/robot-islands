# Inventory Rolling-Average Rate — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the inventory modal's instantaneous `Net /s` rate with a rolling 5-second average measured from realized stockpile deltas.

**Architecture:** A per-panel ring buffer of timestamped inventory snapshots is filled once per open-panel frame and pruned to a 5s window. A pure `averageRate` helper computes per-resource rate from the buffer's oldest and newest snapshots; that rate replaces the economy's `net` value for both the `Net /s` column and the `Time to EMPTY/FULL` column. The panel no longer consumes the economy's `net` at all.

**Tech Stack:** TypeScript (strict, `noUncheckedIndexedAccess`), Vitest. No PixiJS — `inventory-ui.ts` is DOM + pure helpers.

**Spec:** `docs/superpowers/specs/2026-05-21-inventory-rolling-average-rate-design.md`

---

## File Structure

- **Modify `src/inventory-ui.ts`** — add pure rate helpers (`RateSample`, `RATE_WINDOW_MS`, `RATE_MIN_SPAN_MS`, `averageRate`, `pruneRateBuffer`, `snapshotInventory`); rework `refresh`, `paintRows`, `show`, the header label, and the `InventoryUi` interface.
- **Modify `src/main.ts`** — update the single `inventoryUi.refresh(...)` call site.
- **Modify `src/inventory-ui.test.ts`** — add pure-helper tests for `averageRate` and `pruneRateBuffer`.

**Note — minor signature deviation from the spec:** the spec sketched `averageRate(buffer, nowInv, now)`. This plan uses `averageRate(buffer)` where the buffer's last entry IS the current frame — eliminating the redundant `nowInv`/`now` params. Same behaviour, simpler surface.

---

## Task 1: Pure rate helpers + tests

**Files:**
- Modify: `src/inventory-ui.ts` (insert helpers after the `// Pure helpers` comment block, before the `ResourceCategory` type)
- Test: `src/inventory-ui.test.ts`

- [ ] **Step 1: Write the failing tests**

Append to `src/inventory-ui.test.ts`. Also extend the existing import block at the top of the file to add the new symbols.

Change the existing import:

```ts
import {
  RESOURCE_CATEGORY,
  RESOURCE_FILTER_LABEL,
  RESOURCE_FILTER_ORDER,
  inventoryRowVisible,
} from './inventory-ui.js';
```

to:

```ts
import {
  RESOURCE_CATEGORY,
  RESOURCE_FILTER_LABEL,
  RESOURCE_FILTER_ORDER,
  averageRate,
  inventoryRowVisible,
  pruneRateBuffer,
  type RateSample,
} from './inventory-ui.js';
```

Then append these two describe blocks to the end of the file:

```ts
describe('averageRate', () => {
  const mkInv = (
    over: Partial<Record<ResourceId, number>>,
  ): Record<ResourceId, number> => {
    const base = {} as Record<ResourceId, number>;
    for (const r of ALL_RESOURCES) base[r] = 0;
    return { ...base, ...over };
  };

  it('returns an empty record for fewer than 2 samples', () => {
    expect(averageRate([])).toEqual({});
    expect(averageRate([{ t: 1000, inv: mkInv({ iron_ore: 5 }) }])).toEqual({});
  });

  it('returns an empty record when the span is under 250ms', () => {
    const buffer: RateSample[] = [
      { t: 1000, inv: mkInv({ iron_ore: 0 }) },
      { t: 1100, inv: mkInv({ iron_ore: 10 }) },
    ];
    expect(averageRate(buffer)).toEqual({});
  });

  it('computes a partial-window average over 1s of history', () => {
    const buffer: RateSample[] = [
      { t: 1000, inv: mkInv({ iron_ore: 0 }) },
      { t: 2000, inv: mkInv({ iron_ore: 10 }) },
    ];
    expect(averageRate(buffer).iron_ore).toBeCloseTo(10, 9);
  });

  it('uses only the oldest and newest samples across the window', () => {
    const buffer: RateSample[] = [
      { t: 0, inv: mkInv({ iron_ore: 0 }) },
      { t: 2500, inv: mkInv({ iron_ore: 999 }) }, // midpoint must be ignored
      { t: 5000, inv: mkInv({ iron_ore: 50 }) },
    ];
    expect(averageRate(buffer).iron_ore).toBeCloseTo(10, 9);
  });

  it('reads 0 for a cap-pinned resource (no stock movement)', () => {
    const buffer: RateSample[] = [
      { t: 0, inv: mkInv({ iron_ore: 100 }) },
      { t: 5000, inv: mkInv({ iron_ore: 100 }) },
    ];
    expect(averageRate(buffer).iron_ore).toBe(0);
  });

  it('computes a negative rate for a draining resource', () => {
    const buffer: RateSample[] = [
      { t: 0, inv: mkInv({ coal: 50 }) },
      { t: 2000, inv: mkInv({ coal: 10 }) },
    ];
    expect(averageRate(buffer).coal).toBeCloseTo(-20, 9);
  });
});

describe('pruneRateBuffer', () => {
  const inv = {} as Record<ResourceId, number>; // values irrelevant to pruning

  it('keeps the whole buffer when it spans under 5s', () => {
    const buffer: RateSample[] = [
      { t: 1000, inv },
      { t: 3000, inv },
      { t: 5000, inv },
    ];
    pruneRateBuffer(buffer, 5000);
    expect(buffer.map((s) => s.t)).toEqual([1000, 3000, 5000]);
  });

  it('drops samples older than 5s but keeps one past the window edge', () => {
    // now = 9000 → cutoff = 4000. t=0 and t=1000 are both older than the
    // cutoff; t=1000 is retained as the single sample past the edge so the
    // window still spans a full 5s.
    const buffer: RateSample[] = [
      { t: 0, inv },
      { t: 1000, inv },
      { t: 4000, inv },
      { t: 9000, inv },
    ];
    pruneRateBuffer(buffer, 9000);
    expect(buffer.map((s) => s.t)).toEqual([1000, 4000, 9000]);
  });

  it('never prunes below 2 samples', () => {
    const buffer: RateSample[] = [
      { t: 0, inv },
      { t: 100, inv },
    ];
    pruneRateBuffer(buffer, 1_000_000);
    expect(buffer.length).toBe(2);
  });
});
```

The test file already imports `ALL_RESOURCES` from `./recipes.js`. Add `ResourceId` to that import:

```ts
import { ALL_RESOURCES, type ResourceId } from './recipes.js';
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run src/inventory-ui.test.ts`
Expected: FAIL — `averageRate` / `pruneRateBuffer` / `RateSample` are not exported (compile error or "is not a function").

- [ ] **Step 3: Implement the pure helpers**

In `src/inventory-ui.ts`, find this comment block near the top of the file:

```ts
// ---------------------------------------------------------------------------
// Pure helpers — exported for tests / docs
// ---------------------------------------------------------------------------
```

Immediately AFTER that block (before the `/** Resource filter categories ... */` comment), insert:

```ts
/** Rolling-average window for the inventory rate display, in milliseconds. */
export const RATE_WINDOW_MS = 5000;

/** Minimum sample span before a rate is reported. Below this, `averageRate`
 *  returns an empty record (rendered as `·`) — avoids a divide-by-near-zero
 *  single-frame spike during warm-up. */
export const RATE_MIN_SPAN_MS = 250;

/** One timestamped inventory snapshot. `t` is a `performance.now()` reading;
 *  `inv` is a COPY of the island's inventory at that instant (the live
 *  `IslandState.inventory` is mutated in place, so a reference is useless). */
export interface RateSample {
  readonly t: number;
  readonly inv: Record<ResourceId, number>;
}

/**
 * Average per-resource rate (units/sec) over a buffered window.
 *
 * `buffer` is oldest-first and includes the current frame as its last entry.
 * The rate is `(newest − oldest) / span` per resource. Returns an empty
 * record when there are fewer than 2 samples or the span is under
 * `RATE_MIN_SPAN_MS` — callers read missing keys as 0.
 *
 * Because it measures realized stock deltas, a cap-pinned resource reads ~0
 * even while the economy still reports a non-zero instantaneous rate.
 */
export function averageRate(
  buffer: readonly RateSample[],
): Record<ResourceId, number> {
  const out = {} as Record<ResourceId, number>;
  if (buffer.length < 2) return out;
  const oldest = buffer[0];
  const newest = buffer[buffer.length - 1];
  if (!oldest || !newest) return out;
  const spanMs = newest.t - oldest.t;
  if (spanMs < RATE_MIN_SPAN_MS) return out;
  const spanSec = spanMs / 1000;
  for (const r of ALL_RESOURCES) {
    const delta = (newest.inv[r] ?? 0) - (oldest.inv[r] ?? 0);
    out[r] = delta / spanSec;
  }
  return out;
}

/**
 * Drop samples that fall outside the `RATE_WINDOW_MS` window ending at `now`,
 * mutating `buffer` in place. One sample just past the window edge is kept so
 * the average spans a full window. Never prunes below 2 samples.
 */
export function pruneRateBuffer(buffer: RateSample[], now: number): void {
  const cutoff = now - RATE_WINDOW_MS;
  while (buffer.length >= 3) {
    const second = buffer[1];
    if (!second || second.t >= cutoff) break;
    buffer.shift();
  }
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run src/inventory-ui.test.ts`
Expected: PASS — all `averageRate` and `pruneRateBuffer` cases green, existing tests still green.

- [ ] **Step 5: Commit**

```bash
git add src/inventory-ui.ts src/inventory-ui.test.ts
git commit -m "feat(inventory): pure rolling-average rate helpers

Co-Authored-By: <executor model> <noreply@...>"
```

(Append the executor's `Co-Authored-By` trailer per the repo's commit convention — Claude's for a Claude subagent, Kimi's for a kimi subagent.)

---

## Task 2: Wire the buffer into the panel

**Files:**
- Modify: `src/inventory-ui.ts` (`InventoryUi` interface, `mountInventoryUi` state, `refresh`, `paintRows`, `show`, header label)
- Modify: `src/main.ts` (the `inventoryUi.refresh(...)` call site)

This task has no new unit tests — `refresh`/`show` are DOM-closure-bound and JSDOM is not configured (per AGENTS.md "tests target the pure layer only"). It is verified by `tsc`, the full suite, and a browser smoke test. The island-switch and panel-reopen buffer resets are confirmed in the browser step.

- [ ] **Step 1: Add `snapshotInventory` helper**

In `src/inventory-ui.ts`, immediately AFTER the `pruneRateBuffer` function added in Task 1, insert:

```ts
/** Copy an island's inventory into a plain record — one snapshot for the
 *  rate buffer. Not exported: trivial and only used by the panel. */
function snapshotInventory(state: IslandState): Record<ResourceId, number> {
  const snap = {} as Record<ResourceId, number>;
  for (const r of ALL_RESOURCES) snap[r] = inv(state, r);
  return snap;
}
```

(`inv` and `IslandState` are already imported at the top of the file.)

- [ ] **Step 2: Update the `InventoryUi` interface**

Find:

```ts
export interface InventoryUi {
  readonly el: HTMLDivElement;
  /** Apply the current state to all visible rows. Cheap when hidden. */
  refresh(state: IslandState, net: Record<ResourceId, number>): void;
  show(): void;
```

Replace the `refresh` line so the block reads:

```ts
export interface InventoryUi {
  readonly el: HTMLDivElement;
  /** Sample the active island's inventory and repaint visible rows.
   *  Cheap when hidden (early-returns). */
  refresh(): void;
  show(): void;
```

- [ ] **Step 3: Replace the `lastNet` panel state**

Find:

```ts
  let lastNet: Record<ResourceId, number> = {} as Record<ResourceId, number>;
  let tbody: HTMLTableSectionElement | null = null;
```

Replace with:

```ts
  const rateBuffer: RateSample[] = [];
  let lastIslandId: string | null = null;
  let tbody: HTMLTableSectionElement | null = null;
```

- [ ] **Step 4: Rewrite `refresh`**

Find:

```ts
  function refresh(state: IslandState, net: Record<ResourceId, number>): void {
    if (!handle.isVisible()) return;
    void state;
    lastNet = net;
    updateSubtitle();
    paintRows();
  }
```

Replace with:

```ts
  function refresh(): void {
    if (!handle.isVisible()) return;
    const state = getState();
    if (state.id !== lastIslandId) {
      rateBuffer.length = 0;
      lastIslandId = state.id;
    }
    const now = performance.now();
    rateBuffer.push({ t: now, inv: snapshotInventory(state) });
    pruneRateBuffer(rateBuffer, now);
    updateSubtitle();
    paintRows();
  }
```

- [ ] **Step 5: Update `paintRows` to use the average**

Find:

```ts
  function paintRows(): void {
    const state = getState();
    const net = lastNet;
    if (!tbody) return;
```

Replace with:

```ts
  function paintRows(): void {
    const state = getState();
    const avgRate = averageRate(rateBuffer);
    if (!tbody) return;
```

Then find:

```ts
      const capVal = cap(state, r);
      const rate = net[r] ?? 0;
```

Replace with:

```ts
      const capVal = cap(state, r);
      const rate = avgRate[r] ?? 0;
```

- [ ] **Step 6: Clear the buffer on `show` (clean warm-up on reopen)**

Find:

```ts
  function show(): void {
    if (handle.isVisible()) return;
    handle.show();
    updateSubtitle();
```

Replace with:

```ts
  function show(): void {
    if (handle.isVisible()) return;
    rateBuffer.length = 0;
    handle.show();
    updateSubtitle();
```

- [ ] **Step 7: Relabel the column header**

Find:

```ts
      const headers = ['Resource', 'Stock', 'Cap', 'Fill', 'Net /s', 'Time to ⤓/⤒'];
```

Replace with:

```ts
      const headers = ['Resource', 'Stock', 'Cap', 'Fill', 'Net /s (5s avg)', 'Time to ⤓/⤒'];
```

- [ ] **Step 8: Update the `main.ts` call site**

In `src/main.ts`, find:

```ts
    // Inventory panel — cheap when hidden (early-returns in refresh()).
    // Reads the active state through deps + the live `net` snapshot.
    inventoryUi.refresh(activeS, net);
```

Replace with:

```ts
    // Inventory panel — cheap when hidden (early-returns in refresh()).
    // Samples the active island's inventory through deps for its rolling
    // 5s-average rate display.
    inventoryUi.refresh();
```

- [ ] **Step 9: Type-check and run the full suite**

Run: `npx tsc -b`
Expected: clean exit, no errors. (Confirms `net`/`lastNet`/`IslandState` are still consistently used — no `noUnusedLocals` / `noUnusedParameters` violations.)

Run: `npm test`
Expected: all test files pass, including the Task 1 helper tests.

- [ ] **Step 10: Commit**

```bash
git add src/inventory-ui.ts src/main.ts
git commit -m "feat(inventory): display rolling 5s-average rate

Net/s and Time-to columns now derive from realized stock deltas over a
rolling 5s window instead of the economy's instantaneous net rate.

Co-Authored-By: <executor model> <noreply@...>"
```

(Append the executor's `Co-Authored-By` trailer per the repo's commit convention.)

- [ ] **Step 11: Browser smoke test**

Per AGENTS.md, the dev server serves built `dist/` with no HMR.

Run: `npm run build`
Expected: `✓ built` with no errors.

Then reload the page in the browser tab (Daedalus Chrome extension) and verify with `mcp__daedalus__screenshot`:
1. Open the inventory panel (`I`). The column header reads `Net /s (5s avg)`.
2. For ~¼s the rate cells show `·`, then settle into smoothed numbers that no longer jump abruptly on recipe cap/stall events.
3. A resource pinned at its storage cap shows a rate near `0` (not the economy's claimed positive rate) and `—` for time-to.
4. Switch the active island, reopen the panel — the rate warms up fresh (`·` briefly) rather than showing a stale spike.

---

## Self-Review

**Spec coverage:**
- Sample buffer (`RateSample`, copy not reference) → Task 1 Step 3, Task 2 Step 1/4. ✓
- Pruning to a 5s window, one sample past the edge → Task 1 `pruneRateBuffer`. ✓
- `averageRate` pure helper feeding both columns → Task 1 Step 3, Task 2 Step 5 (`rate` feeds Net/s and Time-to). ✓
- Warm-up partial-window + 250ms / 2-sample guard → `averageRate` + `RATE_MIN_SPAN_MS`. ✓
- Island switch clears the buffer → Task 2 Step 4. ✓
- `refresh` drops the `net` param → Task 2 Steps 2/4/8. ✓ (Plan also drops the already-unused `state` param — `refresh()` takes nothing.)
- Header relabel → Task 2 Step 7. ✓
- Tests for warm-up, partial, full window, cap-pinned, island-switch → Task 1 tests cover warm-up/partial/full/cap-pinned/draining; island-switch is browser-verified (Task 2 Step 11) since it is DOM-closure state, consistent with AGENTS.md's pure-layer-only test policy.

**Placeholder scan:** none — every step has concrete code/commands. The `<executor model>` in commit trailers is intentional (filled by whoever runs the task).

**Type consistency:** `RateSample`, `averageRate`, `pruneRateBuffer`, `snapshotInventory`, `rateBuffer`, `lastIslandId` are spelled identically across all tasks. `averageRate` returns `Record<ResourceId, number>`; callers use `avgRate[r] ?? 0`, matching the old `net[r] ?? 0` shape. `refresh()` is nullary in the interface, the implementation, and the `main.ts` call site.
