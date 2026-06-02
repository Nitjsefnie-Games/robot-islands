# Trade Offers Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a cheap T1 "Signal Exchange" building that surfaces periodic, online-only, expiring barter offers — biased to dump your fullest stock for your emptiest *ever-produced* resource — priced at per-unit XP-weight value modulated by a tier-distance spread, with no XP gain.

**Architecture:** A new pure module `src/trade.ts` holds all logic (offer generation, pricing, acceptance, lifecycle ticking) with injectable RNG/time so it is fully unit-testable with zero PixiJS. A per-island `everProduced: Set<ResourceId>` (persisted, schema v18→v19) gates the output side. The live ticker in `main.ts` drives spawn/expiry only while the tab is visible; a DOM overlay `src/trade-ui.ts` renders the offer card + a global badge. A small skill-node cluster in Logistics→Network tunes the constants.

**Tech Stack:** TypeScript (strict, `noUncheckedIndexedAccess`), Vitest, PixiJS 8 (render layer only), IndexedDB persistence via existing `persistence.ts` migration chain.

**Spec:** `docs/superpowers/specs/2026-06-02-trade-offers-design.html` (+ `.md`).

**Execution note:** Tasks 1–9 deliver the fully working feature at fixed base constants. Task 10 (skill-node tuning) is additive on top and can be executed or deferred independently. Render-layer tasks (8, 9) are verified by `npm run build` + manual browser smoke-test, not unit tests, per the repo's pure/render split.

---

### Task 1: `everProduced` seen-set on IslandState

**Files:**
- Modify: `src/economy.ts` (IslandState interface ~line 230; `applyRates` ~line 1520)
- Modify: `src/world.ts` (`makeInitialIslandState` ~line 1002)
- Test: `src/trade.test.ts` (new file)

- [ ] **Step 1: Write the failing test**

Create `src/trade.test.ts`:

```typescript
import { describe, expect, it } from 'vitest';
import { advanceIsland, type IslandState } from './economy.js';
import { BUILDING_DEFS } from './building-defs.js';
import { attachTerrainAt, makeInitialIslandState } from './world.js';

function homeState(nowMs = 0): IslandState {
  return makeInitialIslandState(
    attachTerrainAt({
      id: 'home', name: 'home', biome: 'plains', cx: 0, cy: 0,
      majorRadius: 16, minorRadius: 16, populated: true, discovered: true,
      buildings: [{ id: 'b-mine', defId: 'mine', x: 0, y: 0 }],
      modifiers: ['stable'],
    }),
    nowMs,
  );
}

describe('everProduced seen-set', () => {
  it('is empty on a fresh island except for starter inventory', () => {
    const s = homeState();
    // fresh field exists and is a Set
    expect(s.everProduced).toBeInstanceOf(Set);
  });

  it('records a resource the first time production raises its inventory', () => {
    const s = homeState(0);
    // mine produces iron_ore/stone/coal depending on terrain; advance 5 min
    advanceIsland(s, 5 * 60 * 1000, { catalog: BUILDING_DEFS }, 0);
    // at least one produced resource is now flagged
    expect(s.everProduced.size).toBeGreaterThan(0);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/trade.test.ts -t "everProduced"`
Expected: FAIL — `s.everProduced` is `undefined` (property does not exist yet).

- [ ] **Step 3: Add the field to the interface**

In `src/economy.ts`, inside `interface IslandState` (after `unlockedEdges: Set<EdgeId>;`, ~line 259), add:

```typescript
  /** Resources this island has ever produced (inventory raised above 0 at least
   *  once). Gates the "get" side of Trade Offers (§trade-offers spec). Persisted. */
  everProduced: Set<ResourceId>;
```

- [ ] **Step 4: Initialize it in the factory**

In `src/world.ts`, inside `makeInitialIslandState` (after `unlockedEdges: new Set(),` ~line 1002), add:

```typescript
    everProduced: new Set(),
```

- [ ] **Step 5: Hook production in `applyRates`**

In `src/economy.ts` `applyRates`, immediately after the line `state.inventory[r] = clamped;` (~line 1520), add:

```typescript
      if (rate > 0) state.everProduced.add(r);
```

- [ ] **Step 6: Run test to verify it passes**

Run: `npx vitest run src/trade.test.ts -t "everProduced"`
Expected: PASS (both tests).

- [ ] **Step 7: Typecheck**

Run: `npx tsc -b`
Expected: no errors. (Other call sites that construct `IslandState` literals — chiefly tests and `persistence.ts` deserialize — will error until Task 2; if `tsc` flags them now, proceed to Task 2 which adds them, then re-run. If it flags non-persistence/non-test production code, fix those literals to include `everProduced: new Set()`.)

- [ ] **Step 8: Commit**

```bash
git add src/economy.ts src/world.ts src/trade.test.ts
git commit -m "feat(trade): add everProduced seen-set to IslandState

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

### Task 2: Persistence migration v18 → v19

**Files:**
- Modify: `src/persistence.ts` (`SCHEMA_VERSION` ~line 74; `SUPPORTED_LOAD_VERSIONS` ~line 82; `SerializedIslandState` ~line 97; snapshot type aliases; `migrateV18toV19`; `serializeWorld` ~line 570; `deserializeWorld` ~line 705 & ~844)
- Test: `src/persistence.test.ts` (add cases)

- [ ] **Step 1: Write the failing test**

Add to `src/persistence.test.ts` (match its existing import style; it already imports from `./persistence.js`):

```typescript
import { describe, expect, it } from 'vitest';
import {
  SCHEMA_VERSION,
  migrateV18toV19,
  serializeWorld,
  deserializeWorld,
  type SerializedSnapshotV18,
} from './persistence.js';

describe('v18 -> v19 migration (everProduced)', () => {
  it('defaults everProduced to an empty array when absent in a v18 snapshot', () => {
    const v18: SerializedSnapshotV18 = {
      v: 18,
      // minimal island state entry without everProduced; cast through unknown
      islandStates: [{ id: 'home', state: { id: 'home', inventory: { stone: 10 } } }],
    } as unknown as SerializedSnapshotV18;
    const out = migrateV18toV19(v18);
    expect(out.v).toBe(19);
    const entry = (out as unknown as { islandStates: Array<{ state: { everProduced?: unknown } }> }).islandStates[0];
    expect(entry.state.everProduced).toEqual([]);
  });

  it('round-trips everProduced through serialize/deserialize at current version', () => {
    // Build a world via the test helpers, set everProduced, serialize, deserialize.
    // (Use the same world-construction helper this test file already uses.)
    // Pseudocode shape — adapt to the file's existing makeWorld helper:
    //   const w = makeTestWorld(); w.islands[0].state.everProduced = new Set(['stone','iron_ore']);
    //   const round = deserializeWorld(JSON.parse(JSON.stringify(serializeWorld(w))));
    //   expect([...round.islands[0].state.everProduced].sort()).toEqual(['iron_ore','stone']);
    expect(SCHEMA_VERSION).toBe(19);
  });
});
```

> Note: the round-trip test's exact world construction must mirror whatever helper `persistence.test.ts` already uses to build a `WorldState`. Read the top of that file and reuse its helper rather than hand-rolling a world literal.

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/persistence.test.ts -t "v18 -> v19"`
Expected: FAIL — `migrateV18toV19` is not exported / `SCHEMA_VERSION` is 18.

- [ ] **Step 3: Add the v18 snapshot type alias**

In `src/persistence.ts`, near the other `SerializedSnapshotV*` aliases (the v17 alias is the most recent; mirror it):

```typescript
export type SerializedSnapshotV18 = Omit<SaveSnapshot, 'v'> & { readonly v: 18 };
```

- [ ] **Step 4: Add `everProduced` to `SerializedIslandState`**

In the `SerializedIslandState` interface (~line 97), add the optional array field (optional so older in-memory snapshots and the migration default both typecheck):

```typescript
  readonly everProduced?: ReadonlyArray<ResourceId>;
```

- [ ] **Step 5: Write the migration function**

After `migrateV17toV18` (~line 524), add:

```typescript
export function migrateV18toV19(s: SerializedSnapshotV18): SaveSnapshot {
  return {
    ...s,
    v: 19 as const,
    islandStates: s.islandStates.map((entry) => ({
      ...entry,
      state: {
        ...entry.state,
        everProduced: entry.state.everProduced ?? [],
      },
    })),
  } as unknown as SaveSnapshot;
}
```

- [ ] **Step 6: Bump the version constants**

`src/persistence.ts` line 74:

```typescript
export const SCHEMA_VERSION = 19 as const;
```

line 82 — add `19`:

```typescript
export const SUPPORTED_LOAD_VERSIONS: ReadonlySet<number> = new Set([7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18, 19]);
```

- [ ] **Step 7: Wire the migration into the load chain**

In `deserializeWorld`, after the v17→v18 dispatch step (~line 705), add the next link:

```typescript
  if ((snapshot as unknown as { v: number }).v === 18) {
    snapshot = migrateV18toV19(snapshot as unknown as SerializedSnapshotV18);
  }
```

- [ ] **Step 8: Serialize the Set as an array**

In `serializeWorld`, add `everProduced` to the per-island destructure (~line 570) and to the serialized object (~line 577), mirroring `unlockedNodes`:

```typescript
  const { unlockedNodes, unlockedEdges, socketBindings, everProduced,
          auraAmpVersion: _v, auraAmpCache: _c, auraAmpCacheVersion: _cv, ...rest } = state;
  const serialized: SerializedIslandState = {
    ...rest,
    unlockedNodes: [...unlockedNodes],
    unlockedEdges: [...unlockedEdges],
    socketBindings: [...socketBindings],
    everProduced: [...everProduced],
  };
```

- [ ] **Step 9: Deserialize the array back to a Set**

In `deserializeWorld`, in the per-island state reconstruction (~line 844, alongside `unlockedNodes: new Set(...)`), add:

```typescript
      everProduced: new Set(s.everProduced ?? []),
```

- [ ] **Step 10: Run tests to verify they pass**

Run: `npx vitest run src/persistence.test.ts`
Expected: PASS (including the new v18→v19 cases and all existing migration round-trips).

Run: `npx tsc -b`
Expected: no errors (the Task 1 literal-construction errors in persistence are now resolved).

- [ ] **Step 11: Commit**

```bash
git add src/persistence.ts src/persistence.test.ts
git commit -m "feat(trade): persist everProduced via schema v18->v19 migration

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

### Task 3: `trade.ts` — types, tier lookup, biased candidate selection

**Files:**
- Create: `src/trade.ts`
- Test: `src/trade.test.ts` (add `generateOffer candidate` describe block)

- [ ] **Step 1: Write the failing test**

Add to `src/trade.test.ts`:

```typescript
import {
  generateOffer,
  DEFAULT_TRADE_TUNING,
  type TradeOffer,
} from './trade.js';

function rngSeq(values: number[]): () => number {
  let i = 0;
  return () => values[i++ % values.length]!;
}

describe('generateOffer — candidate selection', () => {
  function stocked(): IslandState {
    const s = homeState();
    // give-pool candidates with varied fill%
    s.storageCaps.stone = 100; s.inventory.stone = 90;   // 0.90 fill
    s.storageCaps.wood = 100; s.inventory.wood = 10;      // 0.10 fill
    // ever-produced get-pool: things we make, varied fill
    s.everProduced.add('stone'); s.everProduced.add('wood');
    s.everProduced.add('iron_ingot');
    s.storageCaps.iron_ingot = 100; s.inventory.iron_ingot = 5; // 0.05 fill, T1
    return s;
  }

  it('never gets a resource absent from everProduced', () => {
    const s = stocked();
    for (let k = 0; k < 200; k++) {
      const o = generateOffer(s, Math.random, DEFAULT_TRADE_TUNING, 1000);
      if (o) expect(s.everProduced.has(o.get.res)).toBe(true);
    }
  });

  it('never gives a resource it holds zero of', () => {
    const s = stocked();
    for (let k = 0; k < 200; k++) {
      const o = generateOffer(s, Math.random, DEFAULT_TRADE_TUNING, 1000);
      if (o) expect(s.inventory[o.give.res] ?? 0).toBeGreaterThan(0);
    }
  });

  it('biases the give side toward higher fill% (roll-twice-take-higher)', () => {
    const s = stocked();
    let stoneGives = 0, woodGives = 0;
    for (let k = 0; k < 400; k++) {
      const o = generateOffer(s, Math.random, DEFAULT_TRADE_TUNING, 1000);
      if (!o) continue;
      if (o.give.res === 'stone') stoneGives++;
      if (o.give.res === 'wood') woodGives++;
    }
    // stone (0.90 fill) should be offered to give away far more than wood (0.10)
    expect(stoneGives).toBeGreaterThan(woodGives);
  });

  it('respects the tier-reach cap', () => {
    const s = stocked();
    for (let k = 0; k < 200; k++) {
      const o = generateOffer(s, Math.random, { ...DEFAULT_TRADE_TUNING, maxReach: 1 }, 1000);
      if (o) expect(Math.abs(tierOf(o.get.res) - tierOf(o.give.res))).toBeLessThanOrEqual(1);
    }
  });
});
```

Add `tierOf` to the import from `./trade.js`.

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/trade.test.ts -t "candidate selection"`
Expected: FAIL — `./trade.js` does not exist.

- [ ] **Step 3: Create `src/trade.ts` with types and selection logic**

```typescript
import { XP_WEIGHT, type ResourceId } from './recipes.js';
import { inv, cap, type IslandState } from './economy.js';

export interface TradeOffer {
  readonly id: string;
  readonly islandId: string;
  readonly give: { readonly res: ResourceId; readonly qty: number };
  readonly get: { readonly res: ResourceId; readonly qty: number };
  readonly spawnedAt: number;
  readonly expiresAt: number;
}

export interface TradeTuning {
  readonly biasK: number;       // candidates rolled per side (take higher/lower fill)
  readonly maxReach: number;    // max |Δtier| between give and get
  readonly sizePct: number;     // fraction of give-stock an offer may move
  readonly spreadShift: number; // additive favorability on the spread center
  readonly cadenceMs: number;   // spawn interval per island (online time)
  readonly expiryMs: number;    // offer lifetime before it lapses
}

export const DEFAULT_TRADE_TUNING: TradeTuning = {
  biasK: 2,
  maxReach: 2,
  sizePct: 0.10,
  spreadShift: 0,
  cadenceMs: 2 * 60 * 60 * 1000, // 2 hours
  expiryMs: 5 * 60 * 1000,       // 5 minutes
};

/** Resource tier from the §9.1 XP-weight ladder (1,3,10,30,100,300,1000). */
export function tierOf(res: ResourceId): number {
  const w = XP_WEIGHT[res] ?? 1;
  const LADDER = [1, 3, 10, 30, 100, 300, 1000];
  let best = 0, bestDist = Infinity;
  for (let t = 0; t < LADDER.length; t++) {
    const d = Math.abs(LADDER[t]! - w);
    if (d < bestDist) { bestDist = d; best = t; }
  }
  return best;
}

/** Fill fraction for ranking. cap 0 with stock > 0 reads as fully overflowing. */
function fillPct(state: IslandState, res: ResourceId): number {
  const c = cap(state, res);
  const i = inv(state, res);
  if (c <= 0) return i > 0 ? 1 : 0;
  return Math.min(1, i / c);
}

/** Roll k candidates from pool; keep the one with the highest (dir=+1) or
 *  lowest (dir=-1) fill%. Pool must be non-empty. */
function biasPick(
  pool: ResourceId[],
  state: IslandState,
  rng: () => number,
  k: number,
  dir: 1 | -1,
): ResourceId {
  let chosen = pool[Math.floor(rng() * pool.length)]!;
  let chosenFill = fillPct(state, chosen);
  for (let r = 1; r < k; r++) {
    const cand = pool[Math.floor(rng() * pool.length)]!;
    const f = fillPct(state, cand);
    if (dir === 1 ? f > chosenFill : f < chosenFill) { chosen = cand; chosenFill = f; }
  }
  return chosen;
}

let _offerSeq = 0;

/**
 * Generate one trade offer for an island, or null if no valid pair exists.
 * Pricing/size are filled in Task 4; this returns a structurally valid offer
 * whose quantities are placeholders of 0 until then.
 */
export function generateOffer(
  state: IslandState,
  rng: () => number,
  tuning: TradeTuning,
  nowMs: number,
): TradeOffer | null {
  const givePool = (Object.keys(state.inventory) as ResourceId[]).filter((r) => inv(state, r) > 0);
  const getPool = [...state.everProduced];
  if (givePool.length === 0 || getPool.length === 0) return null;

  // Try a bounded number of times to find a give/get pair within tier reach.
  for (let attempt = 0; attempt < 12; attempt++) {
    const give = biasPick(givePool, state, rng, tuning.biasK, 1);
    const get = biasPick(getPool, state, rng, tuning.biasK, -1);
    if (give === get) continue;
    if (Math.abs(tierOf(get) - tierOf(give)) > tuning.maxReach) continue;
    return {
      id: `offer-${++_offerSeq}`,
      islandId: state.id,
      give: { res: give, qty: 0 },
      get: { res: get, qty: 0 },
      spawnedAt: nowMs,
      expiresAt: nowMs + tuning.expiryMs,
    };
  }
  return null;
}
```

> `inv` and `cap` are existing exported helpers in `economy.ts` (the `?? 0` centralizers). Confirm their exact signatures when importing; `cap(state, res)` returns the per-resource cap.

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/trade.test.ts -t "candidate selection"`
Expected: PASS (gate, give>0, bias direction, tier-reach).

- [ ] **Step 5: Typecheck + commit**

Run: `npx tsc -b` → no errors.

```bash
git add src/trade.ts src/trade.test.ts
git commit -m "feat(trade): offer candidate selection (bias + ever-produced gate + tier reach)

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

### Task 4: `trade.ts` — pricing and size/headroom clamp

**Files:**
- Modify: `src/trade.ts` (`generateOffer` quantity computation)
- Test: `src/trade.test.ts` (add `pricing & size` block)

- [ ] **Step 1: Write the failing test**

```typescript
describe('generateOffer — pricing & size', () => {
  function pair(giveRes: ResourceId, getRes: ResourceId, giveStock: number, getInv: number, getCap: number): IslandState {
    const s = homeState();
    s.storageCaps[giveRes] = giveStock * 2; s.inventory[giveRes] = giveStock;
    s.storageCaps[getRes] = getCap; s.inventory[getRes] = getInv;
    s.everProduced.add(getRes);
    // force the only valid pair by clearing other inventory
    for (const k of Object.keys(s.inventory) as ResourceId[]) {
      if (k !== giveRes && k !== getRes) s.inventory[k] = 0;
    }
    s.everProduced.add(giveRes);
    return s;
  }

  it('moves at most sizePct of the give stock', () => {
    // same-tier swap (stone T0 -> wood T0) so spread center = 0.8^0 = 1
    const s = pair('stone', 'wood', 1000, 0, 100000);
    s.everProduced.clear(); s.everProduced.add('wood'); // only wood gettable
    const o = generateOffer(s, () => 0.0, { ...DEFAULT_TRADE_TUNING, sizePct: 0.10, biasK: 1 }, 1000)!;
    expect(o).not.toBeNull();
    expect(o.give.qty).toBeLessThanOrEqual(1000 * 0.10 + 1e-6);
    expect(o.give.qty).toBeGreaterThan(0);
  });

  it('never exceeds output headroom', () => {
    // get-resource almost full: headroom 5 units
    const s = pair('stone', 'wood', 100000, 99995, 100000);
    s.everProduced.clear(); s.everProduced.add('wood');
    const o = generateOffer(s, () => 0.0, { ...DEFAULT_TRADE_TUNING, sizePct: 1.0, biasK: 1 }, 1000)!;
    expect(o.get.qty).toBeLessThanOrEqual(5 + 1e-6);
  });

  it('prices per-unit by weight ratio at Δtier 0 (spread center 1)', () => {
    // stone (w1) -> wood (w1): 1:1 at center, before spread variance
    const s = pair('stone', 'wood', 1000, 0, 100000);
    s.everProduced.clear(); s.everProduced.add('wood');
    const o = generateOffer(s, () => 0.5, { ...DEFAULT_TRADE_TUNING, sizePct: 0.10, biasK: 1, spreadShift: 0 }, 1000)!;
    // get.qty ≈ give.qty * (w_give/w_get) * spread; weights equal, spread@center≈1
    const ratio = o.get.qty / o.give.qty;
    expect(ratio).toBeGreaterThan(0.7);
    expect(ratio).toBeLessThan(1.4);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/trade.test.ts -t "pricing & size"`
Expected: FAIL — `give.qty`/`get.qty` are 0 (placeholders from Task 3).

- [ ] **Step 3: Implement pricing + size in `generateOffer`**

Replace the `return { ... qty: 0 ... }` block in `generateOffer` with a computed swap. Insert a helper above `generateOffer`:

```typescript
/** Output-per-input multiplier: fair per-unit weight ratio × a rolled spread
 *  centered on 0.8^Δtier (deal quality) plus the tuning favorability shift. */
function priceMultiplier(give: ResourceId, get: ResourceId, rng: () => number, tuning: TradeTuning): number {
  const wGive = XP_WEIGHT[give] ?? 1;
  const wGet = XP_WEIGHT[get] ?? 1;
  const dTier = Math.abs(tierOf(get) - tierOf(give));
  const center = Math.pow(0.8, dTier) + tuning.spreadShift;
  const variance = 0.25;                       // ±25% around the center
  const spread = center * (1 + (rng() - 0.5) * 2 * variance);
  return (wGive / wGet) * Math.max(0.05, spread);
}
```

Then in `generateOffer`, replace the success branch:

```typescript
    if (Math.abs(tierOf(get) - tierOf(give)) > tuning.maxReach) continue;

    const giveByStock = inv(state, give) * tuning.sizePct;
    const mult = priceMultiplier(give, get, rng, tuning);
    const headroom = Math.max(0, cap(state, get) - inv(state, get));
    // output from the stock-bounded give, then clamp by headroom and back-compute give
    let getQty = giveByStock * mult;
    let giveQty = giveByStock;
    if (getQty > headroom) { getQty = headroom; giveQty = mult > 0 ? headroom / mult : 0; }
    if (giveQty <= 0 || getQty <= 0) continue;

    return {
      id: `offer-${++_offerSeq}`,
      islandId: state.id,
      give: { res: give, qty: giveQty },
      get: { res: get, qty: getQty },
      spawnedAt: nowMs,
      expiresAt: nowMs + tuning.expiryMs,
    };
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/trade.test.ts -t "pricing & size"`
Expected: PASS (size cap, headroom cap, per-unit ratio).

- [ ] **Step 5: Typecheck + commit**

Run: `npx tsc -b` → no errors.

```bash
git add src/trade.ts src/trade.test.ts
git commit -m "feat(trade): per-unit pricing + size/headroom clamp on offers

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

### Task 5: `trade.ts` — `applyOffer` (exact swap, re-clamp, no XP)

**Files:**
- Modify: `src/trade.ts` (add `applyOffer`)
- Test: `src/trade.test.ts` (add `applyOffer` block)

- [ ] **Step 1: Write the failing test**

```typescript
import { applyOffer } from './trade.js';

describe('applyOffer', () => {
  function offerOn(s: IslandState, give: ResourceId, giveQty: number, get: ResourceId, getQty: number): TradeOffer {
    return { id: 'o1', islandId: s.id, give: { res: give, qty: giveQty }, get: { res: get, qty: getQty }, spawnedAt: 0, expiresAt: 1 };
  }

  it('subtracts give and adds get exactly', () => {
    const s = homeState();
    s.storageCaps.stone = 1000; s.inventory.stone = 500;
    s.storageCaps.wood = 1000; s.inventory.wood = 100;
    applyOffer(s, offerOn(s, 'stone', 50, 'wood', 40));
    expect(s.inventory.stone).toBe(450);
    expect(s.inventory.wood).toBe(140);
  });

  it('grants no XP', () => {
    const s = homeState();
    s.storageCaps.stone = 1000; s.inventory.stone = 500;
    s.storageCaps.wood = 1000; s.inventory.wood = 0;
    const xpBefore = s.xp;
    applyOffer(s, offerOn(s, 'stone', 50, 'wood', 40));
    expect(s.xp).toBe(xpBefore);
  });

  it('re-clamps when stock fell below the offer since spawn', () => {
    const s = homeState();
    s.storageCaps.stone = 1000; s.inventory.stone = 30; // less than offered 50
    s.storageCaps.wood = 1000; s.inventory.wood = 0;
    const moved = applyOffer(s, offerOn(s, 'stone', 50, 'wood', 40));
    expect(s.inventory.stone).toBe(0);
    // get scaled by the same ratio it could actually fund (30/50)
    expect(s.inventory.wood).toBeCloseTo(40 * (30 / 50), 6);
    expect(moved.give).toBeCloseTo(30, 6);
  });

  it('re-clamps to output headroom', () => {
    const s = homeState();
    s.storageCaps.stone = 1000; s.inventory.stone = 500;
    s.storageCaps.wood = 100; s.inventory.wood = 90; // headroom 10
    applyOffer(s, offerOn(s, 'stone', 50, 'wood', 40));
    expect(s.inventory.wood).toBe(100); // capped
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/trade.test.ts -t "applyOffer"`
Expected: FAIL — `applyOffer` not exported.

- [ ] **Step 3: Implement `applyOffer`**

Append to `src/trade.ts`:

```typescript
/**
 * Apply an accepted offer to the island, mutating inventory in place.
 * Re-clamps against current give-stock and output headroom (production may have
 * moved stock since the offer spawned). Grants no XP. Returns the amounts moved.
 */
export function applyOffer(state: IslandState, offer: TradeOffer): { give: number; get: number } {
  const haveGive = inv(state, offer.give.res);
  const headroom = Math.max(0, cap(state, offer.get.res) - inv(state, offer.get.res));

  // scale to whichever side is now the binding constraint, preserving the rate
  const rate = offer.give.qty > 0 ? offer.get.qty / offer.give.qty : 0;
  let giveQty = Math.min(offer.give.qty, haveGive);
  let getQty = giveQty * rate;
  if (getQty > headroom) { getQty = headroom; giveQty = rate > 0 ? headroom / rate : 0; }

  state.inventory[offer.give.res] = haveGive - giveQty;
  state.inventory[offer.get.res] = inv(state, offer.get.res) + getQty;
  return { give: giveQty, get: getQty };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/trade.test.ts -t "applyOffer"`
Expected: PASS (exact swap, no XP, both re-clamp cases).

- [ ] **Step 5: Typecheck + commit**

Run: `npx tsc -b` → no errors.

```bash
git add src/trade.ts src/trade.test.ts
git commit -m "feat(trade): applyOffer with re-clamp and zero XP

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

### Task 6: Signal Exchange building

**Files:**
- Modify: `src/building-defs.ts` (add `signal_exchange` row near `crate` ~line 793)
- Test: `src/trade.test.ts` (add `signal exchange building` block)

- [ ] **Step 1: Write the failing test**

```typescript
import { BUILDING_DEFS } from './building-defs.js';

describe('signal exchange building', () => {
  it('exists as a cheap T1 logistics 1x1 building with no recipe or power', () => {
    const def = (BUILDING_DEFS as Record<string, any>)['signal_exchange'];
    expect(def).toBeDefined();
    expect(def.category).toBe('logistics');
    expect(def.tier).toBe(1);
    expect(def.recipe).toBeUndefined();
    expect(def.power).toBeUndefined();
    expect(def.storage).toBeUndefined();
    // cheap: total placement basket <= the crate's
    const total = Object.values(def.placementCost as Record<string, number>).reduce((a, b) => a + b, 0);
    expect(total).toBeLessThanOrEqual(110); // crate is 80+30
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/trade.test.ts -t "signal exchange"`
Expected: FAIL — `signal_exchange` undefined.

- [ ] **Step 3: Add the building definition**

In `src/building-defs.ts`, after the `crate` entry (~line 809), add (mirroring the crate's field set; pick distinct colours/glyph):

```typescript
  signal_exchange: {
    id: 'signal_exchange',
    displayName: 'Signal Exchange',
    category: 'logistics',
    tier: 1,
    footprint: SHAPES.single,
    fill: 0x2f6f7a,
    stroke: 0x123942,
    placementCost: { wood: 40, stone: 20 },
    glyph: '⇄',
  },
```

> Confirm `'logistics'` is the exact `BuildingCategory` union value (building-defs.ts category union ~line 38-49). If the enum uses a different spelling, match it and update the Task-6 test accordingly.

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/trade.test.ts -t "signal exchange"`
Expected: PASS.

- [ ] **Step 5: Typecheck + commit**

Run: `npx tsc -b` → no errors.

```bash
git add src/building-defs.ts src/trade.test.ts
git commit -m "feat(trade): add cheap T1 Signal Exchange building

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

### Task 7: Offer lifecycle controller (pure)

**Files:**
- Modify: `src/trade.ts` (add `TradeRuntime`, `tickTradeOffers`, `islandHasSignalExchange`)
- Test: `src/trade.test.ts` (add `lifecycle` block)

- [ ] **Step 1: Write the failing test**

```typescript
import { tickTradeOffers, islandHasSignalExchange, type TradeRuntime } from './trade.js';

describe('offer lifecycle', () => {
  function ready(): IslandState {
    const s = homeState();
    s.storageCaps.stone = 100; s.inventory.stone = 90;
    s.everProduced.add('stone'); s.everProduced.add('wood');
    s.storageCaps.wood = 100; s.inventory.wood = 5;
    s.buildings = [...s.buildings, { id: 'b-sx', defId: 'signal_exchange', x: 1, y: 1 }];
    return s;
  }

  it('detects the Signal Exchange building', () => {
    expect(islandHasSignalExchange(ready())).toBe(true);
    expect(islandHasSignalExchange(homeState())).toBe(false);
  });

  it('spawns at most one active offer per island and not before cadence', () => {
    const s = ready();
    const rt: TradeRuntime = { offers: [], nextSpawnAt: new Map() };
    const states = new Map([[s.id, s]]);
    tickTradeOffers(rt, states, Math.random, DEFAULT_TRADE_TUNING, 0);
    expect(rt.offers.filter((o) => o.islandId === s.id).length).toBe(1);
    // tick again immediately: still one (active offer present, cadence not elapsed)
    tickTradeOffers(rt, states, Math.random, DEFAULT_TRADE_TUNING, 1000);
    expect(rt.offers.filter((o) => o.islandId === s.id).length).toBe(1);
  });

  it('expires offers past expiresAt', () => {
    const s = ready();
    const rt: TradeRuntime = { offers: [], nextSpawnAt: new Map() };
    const states = new Map([[s.id, s]]);
    tickTradeOffers(rt, states, Math.random, DEFAULT_TRADE_TUNING, 0);
    expect(rt.offers.length).toBe(1);
    // advance past expiry (5 min) — old offer pruned; cadence (2h) not elapsed so no new one
    tickTradeOffers(rt, states, Math.random, DEFAULT_TRADE_TUNING, 6 * 60 * 1000);
    expect(rt.offers.length).toBe(0);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/trade.test.ts -t "lifecycle"`
Expected: FAIL — `tickTradeOffers`/`islandHasSignalExchange`/`TradeRuntime` not exported.

- [ ] **Step 3: Implement the lifecycle**

Append to `src/trade.ts`:

```typescript
import type { PlacedBuilding } from './buildings.js';

export interface TradeRuntime {
  offers: TradeOffer[];                 // active offers (runtime-only, never persisted)
  nextSpawnAt: Map<string, number>;     // islandId -> earliest next spawn (ms)
}

export function islandHasSignalExchange(state: IslandState): boolean {
  return state.buildings.some((b: PlacedBuilding) => b.defId === 'signal_exchange');
}

/**
 * Advance offer spawning/expiry. Pure given (rng, nowMs); call ONLY while the tab
 * is visible so spawns accrue on online time only. Mutates `rt` in place.
 */
export function tickTradeOffers(
  rt: TradeRuntime,
  islandStates: ReadonlyMap<string, IslandState>,
  rng: () => number,
  tuning: TradeTuning,
  nowMs: number,
): void {
  // 1. prune expired
  rt.offers = rt.offers.filter((o) => o.expiresAt > nowMs);

  // 2. spawn for eligible islands with no active offer and cadence elapsed
  for (const [id, state] of islandStates) {
    if (!islandHasSignalExchange(state)) continue;
    if (rt.offers.some((o) => o.islandId === id)) continue;
    const due = rt.nextSpawnAt.get(id) ?? 0;
    if (nowMs < due) continue;
    const offer = generateOffer(state, rng, tuning, nowMs);
    if (offer) rt.offers.push(offer);
    rt.nextSpawnAt.set(id, nowMs + tuning.cadenceMs);
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/trade.test.ts -t "lifecycle"`
Expected: PASS (detect building, one-per-island + cadence gate, expiry prune).

- [ ] **Step 5: Full trade suite + typecheck + commit**

Run: `npx vitest run src/trade.test.ts` → all PASS.
Run: `npx tsc -b` → no errors.

```bash
git add src/trade.ts src/trade.test.ts
git commit -m "feat(trade): online-only offer lifecycle controller (spawn cadence + expiry)

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

### Task 8: Ticker wiring (online-only) in `main.ts`

**Files:**
- Modify: `src/main.ts` (ticker body ~line 1809–2016; module-scope runtime store)

> Render/driver task — verified by `npm run build` + manual smoke-test, no unit test.

- [ ] **Step 1: Add a module-scope runtime store and visibility flag**

Near the top of the ticker setup in `main.ts` (module scope, before `app.ticker.add`), add:

```typescript
import { tickTradeOffers, DEFAULT_TRADE_TUNING, type TradeRuntime } from './trade.js';

const tradeRuntime: TradeRuntime = { offers: [], nextSpawnAt: new Map() };
```

- [ ] **Step 2: Call the lifecycle tick, gated on tab visibility**

Inside `app.ticker.add(...)`, after the per-island economy loop completes (after ~line 1841, where `islandNets`/`islandPower` are populated; `now` is `performance.now()` from ~line 1700), add:

```typescript
    if (!document.hidden) {
      tickTradeOffers(tradeRuntime, islandStates, Math.random, DEFAULT_TRADE_TUNING, now);
    }
```

> `islandStates` is the existing `Map<string, IslandState>` iterated at ~line 1809. `document.hidden` is `true` when the tab is backgrounded, so spawns accrue on visible time only (per spec). A long hidden gap yields a single catch-up offer on return, not accrual — acceptable.

- [ ] **Step 3: Build and smoke-test**

Run: `npm run build`
Expected: `tsc -b && vite build` succeed, no type errors.

Manual (reload the browser tab on `islands.nitjsefni.eu` after build):
- Place a Signal Exchange on the home island. (For a fast check, temporarily lower `cadenceMs` to e.g. `10_000` in `DEFAULT_TRADE_TUNING`, build, verify an offer appears in `tradeRuntime` via a `console.log(tradeRuntime.offers)` in the ticker, then revert the constant.)

- [ ] **Step 4: Commit**

```bash
git add src/main.ts
git commit -m "feat(trade): drive online-only offer lifecycle from the main ticker

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

### Task 9: `trade-ui.ts` — offer card + global badge

**Files:**
- Create: `src/trade-ui.ts`
- Modify: `src/main.ts` (mount + per-frame update)

> Render task — manual smoke-test. Mirror the DOM-overlay idiom of `hud.ts`/`ui.ts` (a `.ri-*` fixed-position panel exposing `update()`), and reuse the keyboard/mouse dispatch via the input registry rather than hardcoding handlers.

- [ ] **Step 1: Create the overlay module**

```typescript
import type { TradeRuntime, TradeOffer } from './trade.js';
import { applyOffer, type IslandState } from './trade.js';

export interface TradeUiHandle {
  readonly el: HTMLDivElement;
  update(rt: TradeRuntime, activeIslandId: string, islandStates: ReadonlyMap<string, IslandState>, nowMs: number): void;
}

export function mountTradeUi(onAccept: (offer: TradeOffer) => void): TradeUiHandle {
  const el = document.createElement('div');
  el.className = 'ri-trade-ui';
  el.style.cssText = 'position:fixed;left:12px;top:12px;z-index:40;font:13px system-ui;color:#e8e6df;';
  document.body.appendChild(el);

  function update(rt: TradeRuntime, activeIslandId: string, _states: ReadonlyMap<string, IslandState>, nowMs: number): void {
    const here = rt.offers.find((o) => o.islandId === activeIslandId);
    const elsewhere = rt.offers.filter((o) => o.islandId !== activeIslandId).length;
    if (!here && elsewhere === 0) { el.style.display = 'none'; return; }
    el.style.display = 'block';

    const parts: string[] = [];
    if (here) {
      const secs = Math.max(0, Math.ceil((here.expiresAt - nowMs) / 1000));
      parts.push(
        `<div class="ri-trade-card" style="background:#252420;border:1.5px solid #3a3833;border-radius:10px;padding:12px 14px;margin-bottom:8px;">
           <div style="color:#8f8d82;font:11px ui-monospace;text-transform:uppercase;letter-spacing:.06em;">Trade offer · ${secs}s</div>
           <div style="margin:6px 0;">Give <b>${here.give.qty.toFixed(0)} ${here.give.res}</b> → Get <b style="color:#8FA56E;">${here.get.qty.toFixed(0)} ${here.get.res}</b></div>
           <button data-accept="${here.id}" style="font:11px ui-monospace;background:#D97757;color:#1B1A17;border:none;border-radius:7px;padding:7px 14px;cursor:pointer;font-weight:700;">ACCEPT</button>
         </div>`,
      );
    }
    if (elsewhere > 0) {
      parts.push(`<div style="color:#8f8d82;font-size:12px;">${elsewhere} offer${elsewhere === 1 ? '' : 's'} waiting elsewhere</div>`);
    }
    el.innerHTML = parts.join('');

    const btn = el.querySelector<HTMLButtonElement>('button[data-accept]');
    if (btn && here) btn.onclick = () => onAccept(here);
  }

  return { el, update };
}
```

- [ ] **Step 2: Mount and wire acceptance in `main.ts`**

After the HUD is mounted (near `mountHud(...)`), add:

```typescript
import { mountTradeUi } from './trade-ui.js';

const tradeUi = mountTradeUi((offer) => {
  const st = islandStates.get(offer.islandId);
  if (!st) return;
  applyOffer(st, offer);
  tradeRuntime.offers = tradeRuntime.offers.filter((o) => o.id !== offer.id);
});
```

(import `applyOffer` from `./trade.js` in `main.ts`.)

- [ ] **Step 3: Update the overlay each frame**

In the ticker, after `hud.update(...)` (~line 2005) and `islandBar.update(...)` (~line 2016), add:

```typescript
    tradeUi.update(tradeRuntime, activeIslandId, islandStates, now);
```

- [ ] **Step 4: Build + manual smoke-test**

Run: `npm run build` → succeeds.

Manual (lower `cadenceMs` temporarily as in Task 8): reload tab, place a Signal Exchange, confirm the offer card appears with a live countdown, click ACCEPT, confirm inventory shifts (watch the HUD economy panel) and the card disappears. Confirm the "waiting elsewhere" badge appears when a second Signal-Exchange island has an offer and you view a different island. Revert `cadenceMs`.

- [ ] **Step 5: Commit**

```bash
git add src/trade-ui.ts src/main.ts
git commit -m "feat(trade): offer card + global badge overlay, wire acceptance

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

### Task 10: Skill-node tuning cluster (Logistics → Network)

**Files:**
- Modify: `src/skilltree.ts` (SkillEffect union ~line 96; `SkillMultipliers` struct + `effectiveSkillMultipliers`)
- Modify: `src/skilltree-catalog.ts` (`NETWORK_NOTABLES` ~line 405)
- Modify: `src/skilltree-derive-magnitudes.ts` (`POOL_TARGETS` ~line 23)
- Modify: `src/trade.ts` (resolve per-island tuning from multipliers)
- Test: `src/trade.test.ts` + ensure `src/skilltree-budget.test.ts` still passes

> This task extends an intricate auto-magnitude subsystem. First READ `skilltree.ts` (`SkillEffect` union, the `SkillMultipliers` interface, and `effectiveSkillMultipliers`) and `skilltree-derive-magnitudes.ts` end to end, then mirror the existing `commRangeMul` path (declared at `skilltree.ts:96`, catalog node at `skilltree-catalog.ts:405`, target at `skilltree-derive-magnitudes.ts`). The steps below give the exact additions; match the surrounding style.

- [ ] **Step 1: Add the effect kinds to the union**

In `src/skilltree.ts` SkillEffect union (~line 96), add:

```typescript
  | { readonly kind: 'tradeFrequencyMul' }
  | { readonly kind: 'tradeSizeMul' }
  | { readonly kind: 'tradeReachAdd' }
  | { readonly kind: 'tradeSpreadShiftAdd' }
```

- [ ] **Step 2: Add fields to `SkillMultipliers` and fold them**

In the `SkillMultipliers` interface, add four fields mirroring an existing `...Mul` field (multipliers default 1, additives default 0):

```typescript
  tradeFrequencyMul: number;  // >1 = shorter cadence
  tradeSizeMul: number;
  tradeReachAdd: number;
  tradeSpreadShiftAdd: number;
```

In `effectiveSkillMultipliers` (where each effect kind is folded into the struct), add cases mirroring the `commRangeMul` fold: multiply `tradeFrequencyMul`/`tradeSizeMul`, sum `tradeReachAdd`/`tradeSpreadShiftAdd`. Initialize the four fields in the struct's base/identity value.

- [ ] **Step 3: Add POOL_TARGETS for the multiplier kinds**

In `src/skilltree-derive-magnitudes.ts` `POOL_TARGETS` (~line 23), add targets for the two `*Mul` kinds (the additive kinds use hand-set magnitudes on their nodes, not the solver). Mirror an existing modest target:

```typescript
  'tradeFrequencyMul': 4,
  'tradeSizeMul': 3,
```

- [ ] **Step 4: Add the notable nodes (≤ budget)**

In `src/skilltree-catalog.ts` `NETWORK_NOTABLES` (~line 405), add up to four notables. The Network sub-path must stay ≤ 23 total nodes and ≤ 2 distinct filler lever-families — adding notables does not add filler families, but verify the count. Example entries:

```typescript
  { id: 'network.notable.exchangeUplink' as NodeId, subPath: 'network', depth: 3, cost: 4,
    effect: { kind: 'tradeFrequencyMul' }, description: 'Exchange Uplink — more frequent trade offers' },
  { id: 'network.notable.barterReach' as NodeId, subPath: 'network', depth: 4, cost: 4,
    effect: { kind: 'tradeReachAdd' }, description: 'Barter Reach — offers span one more tier' },
  { id: 'network.notable.bulkBroker' as NodeId, subPath: 'network', depth: 5, cost: 5,
    effect: { kind: 'tradeSizeMul' }, description: 'Bulk Broker — larger trade volumes' },
  { id: 'network.notable.shrewdHaggler' as NodeId, subPath: 'network', depth: 6, cost: 6,
    effect: { kind: 'tradeSpreadShiftAdd' }, description: 'Shrewd Haggler — offers skew in your favour' },
```

For the additive nodes (`tradeReachAdd`, `tradeSpreadShiftAdd`), if the magnitude system requires an explicit magnitude rather than a solver target, set it where hand-set magnitudes live (mirror how a non-pooled additive effect like `launchSuccessAdditive` declares its magnitude). `tradeReachAdd` should total +1 to +2 across owned nodes; `tradeSpreadShiftAdd` a small positive (e.g. +0.05–0.10).

- [ ] **Step 5: Resolve tuning from multipliers in `trade.ts`**

Add a helper that builds a per-island `TradeTuning` from `DEFAULT_TRADE_TUNING` and the island's resolved `SkillMultipliers`:

```typescript
import type { SkillMultipliers } from './skilltree.js';

export function tuningFor(mult: SkillMultipliers): TradeTuning {
  return {
    ...DEFAULT_TRADE_TUNING,
    cadenceMs: DEFAULT_TRADE_TUNING.cadenceMs / Math.max(1, mult.tradeFrequencyMul),
    sizePct: DEFAULT_TRADE_TUNING.sizePct * Math.max(1, mult.tradeSizeMul),
    maxReach: DEFAULT_TRADE_TUNING.maxReach + Math.round(mult.tradeReachAdd),
    spreadShift: DEFAULT_TRADE_TUNING.spreadShift + mult.tradeSpreadShiftAdd,
  };
}
```

Then in `main.ts`, replace the `DEFAULT_TRADE_TUNING` argument to `tickTradeOffers` with a per-island lookup — pass a `tuningFor(effectiveSkillMultipliers(state, ...))` resolver. (Simplest: change `tickTradeOffers` to take a `tuningFor: (state) => TradeTuning` callback instead of a single tuning; update Task 7's signature and its tests accordingly, defaulting to `() => DEFAULT_TRADE_TUNING` where skills are absent.)

- [ ] **Step 6: Test — tuning derivation + budget guard**

Add to `src/trade.test.ts`:

```typescript
import { tuningFor } from './trade.js';

describe('skill tuning', () => {
  it('frequency multiplier shortens cadence', () => {
    const base = tuningFor({ tradeFrequencyMul: 1, tradeSizeMul: 1, tradeReachAdd: 0, tradeSpreadShiftAdd: 0 } as any);
    const fast = tuningFor({ tradeFrequencyMul: 4, tradeSizeMul: 1, tradeReachAdd: 0, tradeSpreadShiftAdd: 0 } as any);
    expect(fast.cadenceMs).toBeLessThan(base.cadenceMs);
  });
  it('reach add widens maxReach', () => {
    const t = tuningFor({ tradeFrequencyMul: 1, tradeSizeMul: 1, tradeReachAdd: 2, tradeSpreadShiftAdd: 0 } as any);
    expect(t.maxReach).toBe(DEFAULT_TRADE_TUNING.maxReach + 2);
  });
});
```

Run: `npx vitest run src/trade.test.ts` → PASS.
Run: `npx vitest run src/skilltree-budget.test.ts` → PASS (Network ≤ 23 nodes, ≤ 2 filler families).
Run: `npx vitest run` → full suite green.
Run: `npx tsc -b` → no errors.

- [ ] **Step 7: Commit**

```bash
git add src/skilltree.ts src/skilltree-catalog.ts src/skilltree-derive-magnitudes.ts src/trade.ts src/trade-ui.ts src/main.ts src/trade.test.ts
git commit -m "feat(trade): Logistics-Network skill cluster tuning offer frequency/size/reach/spread

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Final verification (after all tasks)

- [ ] `npx vitest run` — entire suite green (trade, persistence, skilltree-budget, economy).
- [ ] `npm run build` — `tsc -b && vite build` clean.
- [ ] Manual: place a Signal Exchange; with a temporarily-shortened cadence, confirm an offer appears, the countdown ticks, ACCEPT shifts inventory with no XP change (watch HUD), the card clears, and the "waiting elsewhere" badge behaves across two Signal-Exchange islands. Revert the cadence constant.
- [ ] Manual: reload after building — a save written pre-Signal-Exchange loads cleanly (migration v18→v19), and `everProduced` is populated from prior inventory.

## Spec coverage check

| Spec section | Task(s) |
|---|---|
| everProduced seen-set | 1 (field+hook), 2 (persist) |
| trade.ts generate/apply | 3, 4, 5 |
| Signal Exchange building | 6 |
| Online-only expiring lifecycle | 7 (logic), 8 (visibility gate) |
| Offer card + global badge | 9 |
| Skill cluster (freq/size/reach/spread) | 10 |
| Per-unit pricing + 0.8^Δtier spread | 4 |
| Size = min(%stock, headroom) | 4 (generate), 5 (re-clamp on accept) |
| No XP | 5 |
| Persistence v18→v19 | 2 |
