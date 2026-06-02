# Trade — Persisted Cadence + Compounding Speedup Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Close the infinite-trade-via-refresh exploit by persisting the Signal-Exchange spawn cadence as a per-island online-time cooldown (offers stay ephemeral), and make each accepted trade compound that island's next offer 1% sooner, floored at ~1 min.

**Architecture:** Two new persisted per-island fields on `IslandState` (`tradeCooldownMs`, `tradeAcceptCount`). The pure `trade.ts` module gains an `effectiveCadenceMs` helper + constants and a reworked `tickTradeOffers` that burns down the cooldown using a caller-supplied capped online-dt instead of an ephemeral `performance.now()` gate. `main.ts` computes online-dt from `visibilityState === 'visible' && document.hasFocus()` and resets the cooldown on accept. Persistence bumps the schema v19 → v20 with a zero-backfill migration.

**Tech Stack:** TypeScript (strict, `noUncheckedIndexedAccess`), Vitest, idb-keyval persistence. Pure/render split per `AGENTS.md` — `trade.ts`/`economy.ts`/`world.ts`/`persistence.ts` logic stays free of PixiJS; only `main.ts` is render-layer.

**Branch:** `feat/trade-persist-cadence-compounding` (already cut; design docs already committed).

---

## File Structure

- `src/economy.ts` — add two `IslandState` fields (type only).
- `src/world.ts` — seed the two fields in `makeInitialIslandState`.
- `src/trade.ts` — `FLOOR_MS`, `ONLINE_DT_CAP_MS`, `effectiveCadenceMs`; rework `tickTradeOffers`; drop `TradeRuntime.nextSpawnAt`.
- `src/main.ts` — `isOnline`/`onlineDtMs` wiring; accept handler increments + resets; drop `nextSpawnAt` literal.
- `src/persistence.ts` — schema v19 → v20 migration + alias + chain wiring.
- `src/trade.test.ts` — rewrite the 3 lifecycle tests for the cooldown model; add `effectiveCadenceMs` + online-gating tests.
- `src/prefs.test.ts`-style new persistence test (in `src/persistence.test.ts`) — v19→v20 migration backfill + v20 round-trip.
- `docs/superpowers/specs/2026-06-02-trade-offers-design.{md,html}` — amend Out-of-scope #3 note.

---

### Task 1: Add persisted per-island trade fields

**Files:**
- Modify: `src/economy.ts` (IslandState, after `everProduced` ~line 266)
- Modify: `src/world.ts:993-1009` (`makeInitialIslandState` return)
- Test: `src/trade.test.ts` (new `describe` block)

- [ ] **Step 1: Write the failing test**

Add to `src/trade.test.ts` (after the imports/helpers, e.g. near the other `describe`s):

```ts
describe('persisted trade-cadence fields', () => {
  it('makeInitialIslandState seeds tradeCooldownMs and tradeAcceptCount to 0', () => {
    const s = homeState();
    expect(s.tradeCooldownMs).toBe(0);
    expect(s.tradeAcceptCount).toBe(0);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/trade.test.ts -t "seeds tradeCooldownMs"`
Expected: FAIL — `Property 'tradeCooldownMs' does not exist on type 'IslandState'` (tsc) / `undefined` at runtime.

- [ ] **Step 3: Add the fields to `IslandState`**

In `src/economy.ts`, immediately after the `everProduced: Set<ResourceId>;` field (~line 266):

```ts
  /** Trade Offers: online-ms remaining until this island's Signal Exchange
   *  may spawn its next offer. Counts down only on online frames (see
   *  `tickTradeOffers`); persisted so a page refresh can't reset the cadence
   *  (closing the infinite-trade-via-refresh exploit). Seeds to 0 — the first
   *  offer is prompt. */
  tradeCooldownMs: number;
  /** Trade Offers: count of accepted trades on this island. Drives the
   *  compounding 1%-per-accept speedup (see `effectiveCadenceMs`). Persisted. */
  tradeAcceptCount: number;
```

- [ ] **Step 4: Seed the fields in the factory**

In `src/world.ts`, inside `makeInitialIslandState`'s returned object, immediately after `everProduced: new Set(),` (~line 1004):

```ts
    tradeCooldownMs: 0,
    tradeAcceptCount: 0,
```

- [ ] **Step 5: Run test to verify it passes**

Run: `npx vitest run src/trade.test.ts -t "seeds tradeCooldownMs"`
Expected: PASS

- [ ] **Step 6: Commit**

```bash
git add src/economy.ts src/world.ts src/trade.test.ts
git commit -m "feat(trade): persisted per-island tradeCooldownMs + tradeAcceptCount

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

### Task 2: `effectiveCadenceMs` + constants (pure)

**Files:**
- Modify: `src/trade.ts` (after `DEFAULT_TRADE_TUNING` ~line 31)
- Test: `src/trade.test.ts` (new `describe`)

- [ ] **Step 1: Write the failing test**

Add to `src/trade.test.ts`. Extend the existing import from `./trade.js` to include `effectiveCadenceMs`, `FLOOR_MS`, `ONLINE_DT_CAP_MS`, then:

```ts
describe('effectiveCadenceMs', () => {
  it('returns the base cadence at zero accepts', () => {
    expect(effectiveCadenceMs(0, 1_000_000)).toBe(1_000_000);
  });

  it('compounds 1% faster per accept', () => {
    expect(effectiveCadenceMs(1, 1_000_000)).toBeCloseTo(990_000, 5);
    expect(effectiveCadenceMs(2, 1_000_000)).toBeCloseTo(980_100, 5);
  });

  it('roughly halves by ~69 accepts', () => {
    expect(effectiveCadenceMs(69, 1_000_000)).toBeLessThan(505_000);
    expect(effectiveCadenceMs(69, 1_000_000)).toBeGreaterThan(495_000);
  });

  it('never drops below FLOOR_MS no matter the accept count', () => {
    expect(effectiveCadenceMs(100_000, DEFAULT_TRADE_TUNING.cadenceMs)).toBe(FLOOR_MS);
    expect(FLOOR_MS).toBe(60_000);
  });

  it('exposes a positive online-dt cap', () => {
    expect(ONLINE_DT_CAP_MS).toBeGreaterThan(0);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/trade.test.ts -t "effectiveCadenceMs"`
Expected: FAIL — `effectiveCadenceMs is not exported` / not defined.

- [ ] **Step 3: Add the constants + helper**

In `src/trade.ts`, immediately after the `DEFAULT_TRADE_TUNING` const (after line 31):

```ts
/** Minimum effective cadence (ms). The compounding accept-speedup can't drive
 *  offers below this, keeping the loop fast-but-bounded so it can't soft-reopen
 *  the refresh farm. ~1 minute. */
export const FLOOR_MS = 60_000;

/** Max online time (ms) credited to a cooldown in a single tick. The caller
 *  passes `min(frameElapsedMs, ONLINE_DT_CAP_MS)` so a long unfocused gap can't
 *  dump hours into the countdown on the first focused frame. */
export const ONLINE_DT_CAP_MS = 3_000;

/** Effective per-island cadence: the base cadence compounded 1% faster per
 *  accepted trade (`0.99^acceptCount`), floored at `FLOOR_MS`. Pure on numbers
 *  so both the ticker and the accept handler can reuse it. */
export function effectiveCadenceMs(acceptCount: number, baseCadenceMs: number): number {
  return Math.max(FLOOR_MS, baseCadenceMs * Math.pow(0.99, acceptCount));
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/trade.test.ts -t "effectiveCadenceMs"`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/trade.ts src/trade.test.ts
git commit -m "feat(trade): effectiveCadenceMs compounding helper + FLOOR_MS/ONLINE_DT_CAP_MS

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

### Task 3: Rework `tickTradeOffers` to the online-time cooldown

**Files:**
- Modify: `src/trade.ts:147-200` (`TradeRuntime`, `tickTradeOffers`)
- Test: `src/trade.test.ts:251-300` (rewrite the `offer lifecycle` block)

- [ ] **Step 1: Rewrite the failing lifecycle tests**

Replace the entire `describe('offer lifecycle', ...)` block (`src/trade.test.ts:251-300`) with:

```ts
describe('offer lifecycle (online-time cooldown)', () => {
  function ready(): IslandState {
    const s = homeState();
    s.storageCaps.stone = 100; s.inventory.stone = 90;
    s.everProduced.add('stone'); s.everProduced.add('wood');
    s.storageCaps.wood = 100; s.inventory.wood = 5;
    s.buildings = [...s.buildings, { id: 'b-sx', defId: 'signal_exchange', x: 1, y: 1 }];
    return s;
  }
  const TUNE = () => DEFAULT_TRADE_TUNING;

  it('detects the Signal Exchange building', () => {
    expect(islandHasSignalExchange(ready())).toBe(true);
    expect(islandHasSignalExchange(homeState())).toBe(false);
  });

  it('spawns one offer immediately when cooldown is 0, then no more while active', () => {
    const s = ready();
    const rt: TradeRuntime = { offers: [] };
    const states = new Map([[s.id, s]]);
    tickTradeOffers(rt, states, Math.random, TUNE, 0, 16);
    expect(rt.offers.filter((o) => o.islandId === s.id).length).toBe(1);
    tickTradeOffers(rt, states, Math.random, TUNE, 1000, 16);
    expect(rt.offers.filter((o) => o.islandId === s.id).length).toBe(1);
  });

  it('does NOT spawn while cooldown > 0; spawns once online time burns it down', () => {
    const s = ready();
    s.tradeCooldownMs = 5000;
    const rt: TradeRuntime = { offers: [] };
    const states = new Map([[s.id, s]]);
    tickTradeOffers(rt, states, Math.random, TUNE, 0, 1000);
    expect(rt.offers.length).toBe(0);
    expect(s.tradeCooldownMs).toBe(4000);
    // burn the remaining 4s of online time
    for (let i = 0; i < 4; i++) tickTradeOffers(rt, states, Math.random, TUNE, i + 1, 1000);
    expect(rt.offers.length).toBe(1);
  });

  it('does NOT decrement cooldown on offline frames (onlineDtMs = 0)', () => {
    const s = ready();
    s.tradeCooldownMs = 5000;
    const rt: TradeRuntime = { offers: [] };
    const states = new Map([[s.id, s]]);
    tickTradeOffers(rt, states, Math.random, TUNE, 0, 0);
    expect(s.tradeCooldownMs).toBe(5000);
    expect(rt.offers.length).toBe(0);
  });

  it('expiry prunes the offer AND resets cooldown to the effective cadence', () => {
    const s = ready();
    const rt: TradeRuntime = { offers: [] };
    const states = new Map([[s.id, s]]);
    tickTradeOffers(rt, states, Math.random, TUNE, 0, 16);
    expect(rt.offers.length).toBe(1);
    // past the 5-min expiry: pruned, cooldown reset to base cadence (0 accepts)
    tickTradeOffers(rt, states, Math.random, TUNE, 6 * 60 * 1000, 16);
    expect(rt.offers.length).toBe(0);
    expect(s.tradeCooldownMs).toBeGreaterThan(DEFAULT_TRADE_TUNING.cadenceMs - 100);
  });

  it('a higher accept count shortens the post-expiry cooldown (compounding)', () => {
    const s = ready();
    s.tradeAcceptCount = 100;
    const rt: TradeRuntime = { offers: [] };
    const states = new Map([[s.id, s]]);
    tickTradeOffers(rt, states, Math.random, TUNE, 0, 16);
    tickTradeOffers(rt, states, Math.random, TUNE, 6 * 60 * 1000, 16);
    expect(s.tradeCooldownMs).toBe(
      effectiveCadenceMs(100, DEFAULT_TRADE_TUNING.cadenceMs),
    );
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run src/trade.test.ts -t "online-time cooldown"`
Expected: FAIL — `tickTradeOffers` arity / `nextSpawnAt` type errors (signature still old).

- [ ] **Step 3: Drop `nextSpawnAt` from `TradeRuntime`**

In `src/trade.ts`, replace the `TradeRuntime` interface (lines 147-150):

```ts
export interface TradeRuntime {
  offers: TradeOffer[]; // active offers (runtime-only, never persisted)
}
```

- [ ] **Step 4: Rewrite `tickTradeOffers`**

In `src/trade.ts`, replace the whole `tickTradeOffers` function (lines 172-200) with:

```ts
/**
 * Advance offer spawning/expiry. `nowMs` (a `performance.now()` value) stamps
 * ephemeral offer `spawnedAt`/`expiresAt`; `onlineDtMs` is the capped online
 * time elapsed this frame (0 when the tab isn't visible+focused) and is what
 * burns down each island's persisted `tradeCooldownMs`. The cadence gate thus
 * lives in persisted island state, not in ephemeral runtime — refresh-proof.
 * Mutates `rt` and each island's `tradeCooldownMs`.
 */
export function tickTradeOffers(
  rt: TradeRuntime,
  islandStates: ReadonlyMap<string, IslandState>,
  rng: () => number,
  tuningFor: (state: IslandState) => TradeTuning,
  nowMs: number,
  onlineDtMs: number,
): void {
  // 1. prune expired offers; an expiry is a resolution, so it resets that
  //    island's cooldown to its (compounded) effective cadence — exactly like
  //    an accept does, starting the next wait.
  const live: TradeOffer[] = [];
  for (const o of rt.offers) {
    if (o.expiresAt > nowMs) { live.push(o); continue; }
    const st = islandStates.get(o.islandId);
    if (st) st.tradeCooldownMs = effectiveCadenceMs(st.tradeAcceptCount, tuningFor(st).cadenceMs);
  }
  rt.offers = live;

  // 2. for each eligible island with no active offer: burn the online-time
  //    cooldown, spawn when it reaches 0. Cooldown is NOT touched at spawn —
  //    it's reset only on resolution (accept/expiry), so an accept's increment
  //    lands on the very next offer.
  for (const [id, state] of islandStates) {
    if (!islandHasSignalExchange(state)) continue;
    if (rt.offers.some((o) => o.islandId === id)) continue;
    state.tradeCooldownMs = Math.max(0, state.tradeCooldownMs - onlineDtMs);
    if (state.tradeCooldownMs > 0) continue;
    const tuning = tuningFor(state);
    const offer = generateOffer(state, rng, tuning, nowMs);
    if (offer) rt.offers.push(offer);
  }
}
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `npx vitest run src/trade.test.ts`
Expected: PASS (all trade tests, including the rewritten lifecycle block).

- [ ] **Step 6: Commit**

```bash
git add src/trade.ts src/trade.test.ts
git commit -m "feat(trade): tickTradeOffers burns persisted online-time cooldown (drops nextSpawnAt)

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

### Task 4: Persistence schema v19 → v20

**Files:**
- Modify: `src/persistence.ts:75` (SCHEMA_VERSION), `:83` (SUPPORTED_LOAD_VERSIONS), `:546-559` (migrateV18toV19 return type), add `SerializedSnapshotV19` + `migrateV19toV20`, `:744` (chain)
- Test: `src/persistence.test.ts` (new `describe`)

- [ ] **Step 1: Write the failing migration test**

Add to `src/persistence.test.ts`. It builds a minimal v19 snapshot, runs the migration, and round-trips. Use the existing test imports (the file already imports from `./persistence.js`); add `migrateV19toV20`, `SCHEMA_VERSION` to that import if not present.

```ts
describe('v19 -> v20 trade-cadence migration', () => {
  it('backfills tradeCooldownMs and tradeAcceptCount to 0', () => {
    const v19 = {
      v: 19,
      savedAt: 0,
      savedAtPerf: 0,
      world: { islands: [] },
      drones: [],
      routes: [],
      vehicles: [],
      satellites: [],
      islandStates: [
        { id: 'home', state: { id: 'home', inventory: { stone: 5 } } },
      ],
    } as unknown as Parameters<typeof migrateV19toV20>[0];

    const out = migrateV19toV20(v19);
    expect(out.v).toBe(20);
    expect(SCHEMA_VERSION).toBe(20);
    const st = out.islandStates[0]!.state as unknown as {
      tradeCooldownMs: number; tradeAcceptCount: number;
    };
    expect(st.tradeCooldownMs).toBe(0);
    expect(st.tradeAcceptCount).toBe(0);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/persistence.test.ts -t "v19 -> v20"`
Expected: FAIL — `migrateV19toV20 is not exported` and `SCHEMA_VERSION` is `19`.

- [ ] **Step 3: Bump the version + supported set**

In `src/persistence.ts`:
- Line 75: `export const SCHEMA_VERSION = 20 as const;`
- Line 83: `export const SUPPORTED_LOAD_VERSIONS: ReadonlySet<number> = new Set([7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18, 19, 20]);`

- [ ] **Step 4: Retype `migrateV18toV19` to return the v19 alias**

In `src/persistence.ts`, change the `migrateV18toV19` signature + final cast (lines 546, 558). The body is unchanged except the return cast:

```ts
export function migrateV18toV19(s: SerializedSnapshotV18): SerializedSnapshotV19 {
  return {
    ...s,
    v: 19 as const,
    islandStates: s.islandStates.map((entry) => ({
      ...entry,
      state: {
        ...entry.state,
        everProduced: (Object.keys(entry.state.inventory ?? {}) as ResourceId[])
          .filter((r) => (entry.state.inventory[r] ?? 0) > 0),
      },
    })),
  } as unknown as SerializedSnapshotV19;
}
```

- [ ] **Step 5: Add the v19 alias + `migrateV19toV20`**

In `src/persistence.ts`, immediately after `migrateV18toV19` (after line 559):

```ts
/** v19 top-level snapshot shape. Structurally identical to v20 (SaveSnapshot)
 *  except the v literal and the per-island trade-cadence fields a v19 save
 *  lacks entirely (`tradeCooldownMs`, `tradeAcceptCount`). */
export type SerializedSnapshotV19 = Omit<SaveSnapshot, 'v'> & { readonly v: 19 };

/** v19 → v20: per-island persisted trade cadence shipped. A v19 save carries
 *  neither field; backfill both to 0 — first offer prompt, base cadence (the
 *  pre-persistence behavior). This is what closes the refresh-farm exploit for
 *  legacy saves going forward. Deserialize carries the numbers through. */
export function migrateV19toV20(s: SerializedSnapshotV19): SaveSnapshot {
  return {
    ...s,
    v: 20 as const,
    islandStates: s.islandStates.map((entry) => ({
      ...entry,
      state: { ...entry.state, tradeCooldownMs: 0, tradeAcceptCount: 0 },
    })),
  } as unknown as SaveSnapshot;
}
```

- [ ] **Step 6: Wire the migration into the chain**

In `src/persistence.ts` `deserializeWorld`, change the v18 step (line 744) to cast, and add the v19 step right after:

```ts
  if ((snapshot as unknown as { v: number }).v === 18) {
    snapshot = migrateV18toV19(snapshot as unknown as SerializedSnapshotV18) as unknown as SaveSnapshot;
  }
  if ((snapshot as unknown as { v: number }).v === 19) {
    snapshot = migrateV19toV20(snapshot as unknown as SerializedSnapshotV19);
  }
```

- [ ] **Step 7: Run test to verify it passes**

Run: `npx vitest run src/persistence.test.ts -t "v19 -> v20"`
Expected: PASS

- [ ] **Step 8: Run the full persistence suite (round-trip regression)**

Run: `npx vitest run src/persistence.test.ts src/persistence-load.test.ts`
Expected: PASS — serialize carries the two numbers via `...rest`; deserialize via `...s`; a v20 save round-trips identity.

- [ ] **Step 9: Commit**

```bash
git add src/persistence.ts src/persistence.test.ts
git commit -m "feat(persistence): schema v19->v20 backfills trade cadence fields to 0

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

### Task 5: `main.ts` wiring — online predicate + accept handler

**Files:**
- Modify: `src/main.ts:86` (import), `:1704` (runtime literal), `:1709-1714` (accept handler), `:1886-1898` (ticker gate)

No new unit test — this is render-layer wiring; covered by the pure tests above plus the build + manual smoke. Verified via `tsc` and full suite.

- [ ] **Step 1: Extend the trade import**

In `src/main.ts` line 86, replace:

```ts
import { tickTradeOffers, applyOffer, tuningFor, type TradeRuntime } from './trade.js';
```

with:

```ts
import {
  tickTradeOffers,
  applyOffer,
  tuningFor,
  effectiveCadenceMs,
  ONLINE_DT_CAP_MS,
  type TradeRuntime,
} from './trade.js';
```

- [ ] **Step 2: Drop `nextSpawnAt` from the runtime literal**

In `src/main.ts` line 1704, replace:

```ts
  const tradeRuntime: TradeRuntime = { offers: [], nextSpawnAt: new Map() };
```

with:

```ts
  const tradeRuntime: TradeRuntime = { offers: [] };
```

- [ ] **Step 3: Accept handler increments + resets cooldown**

In `src/main.ts` lines 1709-1714, replace the `mountTradeUi` callback body:

```ts
  const tradeUi = mountTradeUi((offer) => {
    const st = islandStates.get(offer.islandId);
    if (!st) return;
    applyOffer(st, offer);
    // Each accepted trade compounds this island's next offer 1% sooner; the
    // cooldown is reset HERE (on resolution) so the increment lands on the
    // very next offer. tuningFor folds in the Logistics-Network frequency node.
    st.tradeAcceptCount += 1;
    st.tradeCooldownMs = effectiveCadenceMs(
      st.tradeAcceptCount,
      tuningFor(effectiveSkillMultipliers(st)).cadenceMs,
    );
    tradeRuntime.offers = tradeRuntime.offers.filter((o) => o.id !== offer.id);
  });
```

- [ ] **Step 4: Online predicate + capped online-dt in the ticker**

In `src/main.ts` lines 1886-1898, replace the `if (!document.hidden) { tickTradeOffers(...) }` block:

```ts
    // Trade offer lifecycle. Online = tab visible AND focused (hasFocus covers
    // another window on top / focus loss; visibility covers minimize/other-tab;
    // "covered but focused" isn't JS-detectable — accepted limit). onlineDtMs is
    // the capped online time elapsed this frame and is 0 when not online, so the
    // persisted cooldown only burns down on focused time. Called every frame so
    // expiry pruning stays current.
    const tradeOnline = document.visibilityState === 'visible' && document.hasFocus();
    const onlineDtMs = tradeOnline ? Math.min(elapsedSec * 1000, ONLINE_DT_CAP_MS) : 0;
    tickTradeOffers(
      tradeRuntime,
      islandStates,
      Math.random,
      (state) => tuningFor(effectiveSkillMultipliers(state)),
      now,
      onlineDtMs,
    );
```

- [ ] **Step 5: Typecheck + full suite**

Run: `npm run build`
Expected: `tsc -b` clean, `vite build` succeeds (no `nextSpawnAt` references remain; `effectiveSkillMultipliers` already imported and in scope at both sites).

Run: `npm test`
Expected: PASS — full suite green.

- [ ] **Step 6: Commit**

```bash
git add src/main.ts
git commit -m "feat(trade): drive cooldown on focused online-dt; accept compounds next offer

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

### Task 6: Amend the original Trade Offers design note

**Files:**
- Modify: `docs/superpowers/specs/2026-06-02-trade-offers-design.md` (Out-of-scope "Offer persistence across reload")
- Modify: `docs/superpowers/specs/2026-06-02-trade-offers-design.html` (the matching `.defer` card, ~line 593)

- [ ] **Step 1: Update the `.md` note**

In `docs/superpowers/specs/2026-06-02-trade-offers-design.md`, find the Out-of-scope bullet for "Offer persistence across reload" and append a sentence:

```
> **Amended 2026-06-02 (trade-persist-compounding):** offers remain ephemeral,
> but the spawn *cadence* is now persisted per island as an online-time
> cooldown — see `2026-06-02-trade-persist-compounding-design`. The original
> ephemeral-cadence behavior was the source of a refresh-farm exploit.
```

- [ ] **Step 2: Update the `.html` card**

In `docs/superpowers/specs/2026-06-02-trade-offers-design.html`, in the "Offer persistence across reload" `.defer` card (~line 593-594), replace the `.dd` text:

```html
          <div class="dd">Offers themselves stay ephemeral — fresh offers regenerate on load. <strong>Amended 2026-06-02:</strong> the spawn <em>cadence</em> is now persisted per island as an online-time cooldown (the ephemeral cadence was a refresh-farm exploit) — see the trade-persist-compounding design.</div>
```

- [ ] **Step 3: Commit**

```bash
git add docs/superpowers/specs/2026-06-02-trade-offers-design.md docs/superpowers/specs/2026-06-02-trade-offers-design.html
git commit -m "docs(spec): note cadence is now persisted in original trade-offers design

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

### Task 7: Final verification + PR

- [ ] **Step 1: Full green gate**

Run: `npm test`
Expected: full suite PASS, 0 failures.

Run: `npm run build`
Expected: `tsc -b` clean + `vite build` succeeds.

- [ ] **Step 2: Grep for stragglers**

Run: `grep -rn "nextSpawnAt" src/`
Expected: no matches (all references removed).

- [ ] **Step 3: Push the branch and open the PR**

```bash
git push -u origin feat/trade-persist-cadence-compounding
gh pr create --title "Trade: persist cadence (close refresh-farm exploit) + per-island compounding speedup" --body "$(cat <<'EOF'
## Summary
- Persist the Signal-Exchange spawn cadence as a per-island online-time cooldown (`IslandState.tradeCooldownMs`), closing the infinite-trade-via-refresh exploit. Offers themselves stay ephemeral, per the original design.
- Each accepted trade compounds that island's next offer 1% sooner (`tradeAcceptCount`, `0.99^count`), floored at ~1 min (`FLOOR_MS`).
- Online = `visibilityState === 'visible' && document.hasFocus()`; per-frame online-dt capped (`ONLINE_DT_CAP_MS`).
- Schema v19 → v20 with a zero-backfill migration.

## Design
- docs/superpowers/specs/2026-06-02-trade-persist-compounding-design.md

## Test
- `npm test` green; `tsc -b && vite build` clean.

🤖 Generated with [Claude Code](https://claude.com/claude-code)
EOF
)"
```

- [ ] **Step 4: Report the PR URL back to the user.**

---

## Self-Review

- **Spec coverage:** (a) persisted online-time cooldown → Tasks 1, 3, 5; (b) per-island compounding + floor → Tasks 1, 2, 5; online predicate → Task 5; schema v19→v20 → Task 4; design-doc amendment → Task 6; verification → Task 7. All spec sections mapped.
- **Type consistency:** `effectiveCadenceMs(acceptCount, baseCadenceMs)` defined in Task 2, used identically in Tasks 3 & 5. `TradeRuntime` loses `nextSpawnAt` in Task 3; the only two literals (`trade.test.ts`, `main.ts:1704`) are updated in Tasks 3 & 5. `tickTradeOffers` gains a 6th param `onlineDtMs` in Task 3; the sole non-test caller (`main.ts`) is updated in Task 5. Fields `tradeCooldownMs`/`tradeAcceptCount` named identically across economy.ts, world.ts, persistence.ts, trade.ts, main.ts.
- **Placeholder scan:** none — every code/step shows real content.
- **Ordering note:** Tasks 1→2→3 leave the tree briefly un-typechecking between commits only at the source level if run out of order; each task's tests pass in order. Task 5 is the first point the full `npm run build` must pass (it removes the last `nextSpawnAt`), which is why the build gate lives there and in Task 7.
