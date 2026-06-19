# Global CO₂ Atmosphere Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the CO₂ climate model a single global pool — emissions add to it, every sink (trees, scrubbers) drains it (floored at 0) across all islands — so a forest island's trees can offset emissions from other islands.

**Architecture:** Promote the already-serialized-but-vestigial `world.totalCo2Kg` to the authoritative global scalar. `sumIslandCo2(world)` (the stable read API used by weather/drones/routes/settlement/HUD/overlays/tutorial) returns it. `advanceWorldEconomy` seeds a shared mutable holder `co2Pool = { kg: world.totalCo2Kg }`, threads it via `ctx.co2Pool` into each per-island `advanceIsland` call, and writes it back after the loop. `applySegmentSideEffects` branches its three CO₂ mutation sites on `ctx?.co2Pool` (global when present, per-island `state.co2Kg` when standalone). A v26→v27 migration seeds the global pool from the legacy per-island sum.

**Tech Stack:** TypeScript strict, vitest. Pure layer (`src/economy.ts`, `src/weather.ts`, `src/economy-advance.ts`, `src/persistence.ts`). Server rides the same pure layer — no server code changes.

## Global Constraints

- TypeScript strict + `noUncheckedIndexedAccess` + `noUnusedLocals` + `noUnusedParameters` — new code compiles clean (`cd server && npx tsc --noEmit` for the server view; root `npm run build` = `tsc -b && vite build`).
- SPEC.md is the source of truth — §2.6 and §15.3 CO₂ notes are updated in this same change.
- Persistence discipline (AGENTS.md): bump = migrate. `SCHEMA_VERSION` is currently `26`; this change bumps to `27` with a full `migrateV26toV27` + `SUPPORTED_LOAD_VERSIONS` entry + `SerializedSnapshotV26` alias.
- Grouped lattice / shared-network advance paths are CO₂-inert today (verified) and stay that way — out of scope.
- `npm test` requires a running Postgres (server vitest project). Client-only files can be run via `npx vitest run --project client <file>`.

---

### Task 1: `sumIslandCo2` reads the global pool

**Files:**
- Modify: `src/weather.ts:156-164` (`sumIslandCo2`)
- Test: `src/weather.test.ts` (new case) or `src/co2.test.ts` (new file)

**Interfaces:**
- Produces: `sumIslandCo2(world: { totalCo2Kg?: number }): number` — returns `world.totalCo2Kg ?? 0`.

- [ ] **Step 1: Write the failing test** (new `src/co2.test.ts`)

```ts
import { describe, it, expect } from 'vitest';
import { sumIslandCo2 } from './weather.js';

describe('sumIslandCo2 — global pool', () => {
  it('returns world.totalCo2Kg directly, not a per-island sum', () => {
    const world = {
      totalCo2Kg: 4200,
      islandStates: new Map([['a', { co2Kg: 999 }], ['b', { co2Kg: 999 }]]),
    };
    expect(sumIslandCo2(world)).toBe(4200);
  });
  it('defaults to 0 when totalCo2Kg is absent', () => {
    expect(sumIslandCo2({} as { totalCo2Kg?: number })).toBe(0);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run --project client src/co2.test.ts -t "global pool"`
Expected: FAIL — current impl sums per-island `co2Kg` (returns 1998, not 4200).

- [ ] **Step 3: Rewrite `sumIslandCo2`**

```ts
/** §7.4 single global atmosphere. The world maintains one `totalCo2Kg` scalar;
 *  emissions add to it and sinks drain it (floored at 0) across all islands.
 *  This is the stable read API for every climate consumer (weather, drones,
 *  routes, settlement, HUD, overlays, tutorial). */
export function sumIslandCo2(world: { totalCo2Kg?: number }): number {
  return world.totalCo2Kg ?? 0;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run --project client src/co2.test.ts -t "global pool"`
Expected: PASS

- [ ] **Step 5: Fix fallout in existing tests**

Run: `npx vitest run --project client src/weather.test.ts` (and any client suite touching `sumIslandCo2`). Any test that built a world with per-island `co2Kg` and expected the *sum* now sets `totalCo2Kg` on the world instead. Update each to set `totalCo2Kg: <the level under test>`. Re-run until green.

- [ ] **Step 6: Commit**

```bash
git add src/co2.test.ts src/weather.ts src/weather.test.ts
git commit -m "feat(co2): sumIslandCo2 reads global world.totalCo2Kg

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

### Task 2: Global pool threaded through the integrator

**Files:**
- Modify: `src/economy.ts:150` (`RatesContext` — add `co2Pool`)
- Modify: `src/economy.ts:2435-2473` (`applySegmentSideEffects` — branch the 3 CO₂ mutation sites)
- Modify: `src/economy-advance.ts:83-282` (`advanceWorldEconomy` — seed holder, thread into per-island ctx, write back)
- Test: `src/co2.test.ts`

**Interfaces:**
- Consumes: `sumIslandCo2` (Task 1).
- Produces: `RatesContext.co2Pool?: { kg: number }`. When supplied, `applySegmentSideEffects` accrues/drains it instead of `state.co2Kg`. `advanceWorldEconomy` writes the holder back to `world.totalCo2Kg` after the per-island loop.

- [ ] **Step 1: Write the failing cross-island offset test**

```ts
// src/co2.test.ts — uses the real world/advance helpers
import { advanceWorldEconomy } from './economy-advance.js';
// ... build a 2-island world via the existing test helpers:
//   - island E: a co2-emitting building (e.g. coal_gen / cement chain) running
//   - island F: forest island carpeted with enough plant_a_tree to over-capture
// seed world.totalCo2Kg = 50_000, advance one tick, assert:
it('forest capture on island F draws down emissions from island E (global)', () => {
  // world.totalCo2Kg strictly decreases when total capture > total emission,
  // and is NOT partitioned per island.
  expect(world.totalCo2Kg).toBeLessThan(50_000);
});
it('global pool floors at 0 — capture beyond emissions cannot go negative', () => {
  // seed totalCo2Kg = 1, run a tick dominated by capture
  expect(world.totalCo2Kg).toBe(0);
});
```

(Build the world with the same helpers `economy.test.ts` / `drones.test.ts` use to construct populated islands + buildings; pick one emitter recipe and `plant_a_tree` on a `forest` island. The implementer reads those suites for the exact `makeInitialIslandState` + building-placement helpers.)

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run --project client src/co2.test.ts -t "global"`
Expected: FAIL — today `advanceWorldEconomy` accrues/drains per-island `state.co2Kg`; `world.totalCo2Kg` is never written, stays 50_000.

- [ ] **Step 3: Add `co2Pool` to `RatesContext`** (`src/economy.ts`, in the `RatesContext` interface ~line 150)

```ts
  /** §7.4 single global atmosphere. When the world driver supplies this shared
   *  mutable holder, `applySegmentSideEffects` accrues/drains it (global) instead
   *  of the per-island `state.co2Kg`. Absent ⇒ standalone advance falls back to
   *  `state.co2Kg` (preserves isolated-unit-test semantics). */
  co2Pool?: { kg: number };
```

- [ ] **Step 4: Branch the 3 CO₂ mutation sites in `applySegmentSideEffects`** (`src/economy.ts` ~2435-2473)

Recipe-output emission (was `state.co2Kg += co2Out * br.effectiveRate * dtSec;`):

```ts
      const emit = co2Out * br.effectiveRate * dtSec;
      if (ctx?.co2Pool) ctx.co2Pool.kg += emit; else state.co2Kg += emit;
```

Exogenous fuel-combustion emission (was `state.co2Kg += br.recipe.exogenousFlowKg * br.effectiveRate * dtSec;`):

```ts
      const emit = br.recipe.exogenousFlowKg * br.effectiveRate * dtSec;
      if (ctx?.co2Pool) ctx.co2Pool.kg += emit; else state.co2Kg += emit;
```

Sink drain (was `state.co2Kg = Math.max(0, state.co2Kg - drainKg);`):

```ts
    if (ctx?.co2Pool) ctx.co2Pool.kg = Math.max(0, ctx.co2Pool.kg - drainKg);
    else state.co2Kg = Math.max(0, state.co2Kg - drainKg);
```

(`ctx` is `applySegmentSideEffects`'s first parameter, `RatesContext | undefined` — confirm the param name in the signature ~2397-2405 and use it.)

- [ ] **Step 5: Seed + thread + write back the holder in `advanceWorldEconomy`** (`src/economy-advance.ts`)

Near the top of the function (after `islandSpecsById` is built, before the advance calls):

```ts
  // §7.4 single global atmosphere — one shared holder seeded from the world
  // total, threaded into every per-island advance, written back after the loop.
  const co2Pool = { kg: world.totalCo2Kg };
```

In the per-island `advanceIsland` ctx object (the `advanceIsland(s, now, { ...buildIslandRatesContext(), worldSeed, onTerrainShotFire }, nowWall)` call ~267), add `co2Pool` to that object:

```ts
      advanceIsland(s, now, {
        ...buildIslandRatesContext(),
        worldSeed: world.seed,
        co2Pool,
        onTerrainShotFire: (buildingId) => { /* unchanged */ },
      }, nowWall);
```

After the `for (const s of islandStates.values())` loop closes, before `return { ncState, islandCtx }`:

```ts
  world.totalCo2Kg = co2Pool.kg;
```

(Grouped lattice / shared-network members are NOT given `co2Pool` — they are CO₂-inert today and stay so. Only the per-island `advanceIsland` path carries the pool.)

- [ ] **Step 6: Run the new + neighboring tests**

Run: `npx vitest run --project client src/co2.test.ts src/economy.test.ts src/drones.test.ts src/network.test.ts`
Expected: new CO₂ tests PASS. Fix any standalone-`advanceIsland` suite that asserted `state.co2Kg` after a *world* advance — switch it to assert `world.totalCo2Kg` / `sumIslandCo2(world)`. (Standalone `advanceIsland(state, now)` with no ctx keeps mutating `state.co2Kg` via the fallback branch and needs no change.)

- [ ] **Step 7: Commit**

```bash
git add src/economy.ts src/economy-advance.ts src/co2.test.ts
git add -u  # any test files updated in step 6
git commit -m "feat(co2): global pool threaded through advanceWorldEconomy

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

### Task 3: Persistence v26 → v27 migration

**Files:**
- Modify: `src/persistence.ts` — `SCHEMA_VERSION` (line 78), `SUPPORTED_LOAD_VERSIONS` (line 86), add `SerializedSnapshotV26` + `migrateV26toV27` (after `migrateV25toV26` ~498), wire dispatch (after line 987)
- Test: `src/persistence.test.ts`

**Interfaces:**
- Consumes: existing `SaveSnapshot`, `SerializedWorld.totalCo2Kg`, `SerializedIslandState.co2Kg`.
- Produces: `migrateV26toV27(s: SerializedSnapshotV26): SaveSnapshot` seeding `world.totalCo2Kg = (existing) + Σ state.co2Kg`.

- [ ] **Step 1: Write the failing migration test**

```ts
import { migrateV26toV27 } from './persistence.js';
it('v26→v27 seeds global totalCo2Kg from the per-island sum', () => {
  const v26 = {
    v: 26 as const,
    world: { /* ...minimal valid world... */ totalCo2Kg: 0 },
    islandStates: [
      { id: 'a', state: { /* ... */ co2Kg: 1200 } },
      { id: 'b', state: { /* ... */ co2Kg: 800 } },
    ],
    savedAt: 0,
  };
  const v27 = migrateV26toV27(v26 as unknown as SerializedSnapshotV26);
  expect(v27.v).toBe(27);
  expect(v27.world.totalCo2Kg).toBe(2000);
});
```

(Model the fixture on the existing `migrateV25toV26` / `migrateV14toV15` tests in `persistence.test.ts` — reuse the same minimal-snapshot factory those use.)

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run --project client src/persistence.test.ts -t "v26"`
Expected: FAIL — `migrateV26toV27` is not defined.

- [ ] **Step 3: Add the alias + migration** (`src/persistence.ts`, after `migrateV25toV26`)

```ts
/** v26 top-level snapshot shape — structurally identical to v27 (SaveSnapshot)
 *  except the v literal. The v26 → v27 migration reconciles the global CO₂
 *  pool: pre-v27 saves keep climate pressure in per-island `co2Kg` with
 *  `world.totalCo2Kg == 0`; this seeds the now-authoritative global scalar. */
export type SerializedSnapshotV26 = Omit<SaveSnapshot, 'v'> & { readonly v: 26 };

/** v26 → v27: seed the single global atmosphere from the legacy per-island sum. */
export function migrateV26toV27(s: SerializedSnapshotV26): SaveSnapshot {
  const sumCo2 = s.islandStates.reduce((acc, e) => acc + (e.state.co2Kg ?? 0), 0);
  return {
    ...s,
    v: 27 as const,
    world: { ...s.world, totalCo2Kg: (s.world.totalCo2Kg ?? 0) + sumCo2 },
  } as unknown as SaveSnapshot;
}
```

- [ ] **Step 4: Bump version + supported set + wire dispatch**

`SCHEMA_VERSION` (line 78): `export const SCHEMA_VERSION = 27 as const;`

`SUPPORTED_LOAD_VERSIONS` (line 86): append `27` to the set.

Dispatch (after the `v === 25 → migrateV25toV26` block ~987, before the `snapshot.v !== SCHEMA_VERSION` guard):

```ts
  if ((snapshot as unknown as { v: number }).v === 26) {
    snapshot = migrateV26toV27(snapshot as unknown as SerializedSnapshotV26);
  }
```

- [ ] **Step 5: Run migration + round-trip tests**

Run: `npx vitest run --project client src/persistence.test.ts`
Expected: PASS — new v26→v27 test green; existing round-trip/identity tests green (add a v27 identity round-trip case mirroring the existing latest-version round-trip test if the suite has one).

- [ ] **Step 6: Commit**

```bash
git add src/persistence.ts src/persistence.test.ts
git commit -m "feat(co2): v26→v27 migration — seed global totalCo2Kg from per-island sum

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

### Task 4: SPEC.md — align §2.6 and §15.3 with the global model

**Files:**
- Modify: `SPEC.md:329` (§2.6 implementation note — CO₂-driven storm amplification)
- Modify: `SPEC.md:2160-2164` (§15.3 NON_STORED_OUTPUTS — the `(2) co2` paragraph)

- [ ] **Step 1: Rewrite the §2.6 implementation note**

Replace "Each island accumulates `co2Kg` as fossil-fuel buildings run; `sumIslandCo2` totals it across the world." with: "The world maintains a single global atmosphere scalar `totalCo2Kg`: fossil-fuel buildings add emissions to it and sinks (trees, scrubbers) drain it, floored at 0, **across all islands** — capture on one island offsets emissions on any other. `sumIslandCo2(world)` returns this global total. The per-island integration accrues/drains it through a shared `ctx.co2Pool` holder seeded from and written back to `world.totalCo2Kg` once per `advanceWorldEconomy` tick." Keep the band-multiplier and `rollHeatwave` sentences unchanged.

- [ ] **Step 2: Rewrite the §15.3 `(2) co2` paragraph**

Replace "Its climate contribution accrues only to the per-island `co2Kg` scalar … The world total is `Σ co2Kg` (`sumIslandCo2`)" with the single-global-pool wording: emissions add to / sinks drain the one `world.totalCo2Kg` (floored at 0), surfaced in the HUD as `☁ ATMOSPHERE CO₂` via `sumIslandCo2`. Note the per-island `co2Kg` field is retained for the standalone `advanceIsland` fallback but is inert in production, and that grouped lattice/shared-network advance paths remain CO₂-inert (pre-existing).

- [ ] **Step 3: Verify build + commit**

Run: `npm run build`
Expected: clean (`tsc -b && vite build` pass).

```bash
git add SPEC.md
git commit -m "docs(spec): §2.6/§15.3 — CO₂ is one global atmosphere, sinks drain it world-wide

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Final verification (after all tasks)

- [ ] `npm run build` — clean (root `tsc -b && vite build`).
- [ ] `cd server && npx tsc --noEmit` — server cross-workspace typecheck clean.
- [ ] Full `npm test` (requires Postgres up) — both client + server vitest projects green.
- [ ] Restart the two services per the session goal.
