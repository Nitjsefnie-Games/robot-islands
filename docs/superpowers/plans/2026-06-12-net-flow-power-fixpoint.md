# Net-flow ⇄ power-brownout joint fixpoint — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Co-solve the net-flow gate `g` and the brownout factor `pf` so a pinned bin nets to 0 under the *realized* (brownout-scaled) flows, killing the `+0/+0.0x` flicker the power-after-solve lag reintroduces.

**Architecture:** A new pure leaf `flow-power-fixpoint.ts` owns a damped scalar fixpoint over `pf` (gates are deterministic in `pf`, so only the scalar iterates). `computeRates` (the single `solveFlow` caller — solo, lattice §13.3, and shared-network §15.1 all route through it) bakes `pf` into power-consumers' flow coefficients and runs the fixpoint locally when not on a unified cable; the cable pre-pass in `routes.ts` runs the same fixpoint over a §5.3 component to converge its one shared scalar. A no-brownout fast path keeps the common case byte-identical to today.

**Tech Stack:** TypeScript strict (`noUncheckedIndexedAccess`), Vitest, pure-math/render separation. No new deps.

**Spec:** `docs/superpowers/specs/2026-06-12-net-flow-power-fixpoint-design.md`.

**Design refinements discovered during planning (carry into the spec if asked):**
- `solveFlow` has exactly one call site (`economy.ts:1555`); lattice/shared-network advance through `computeRates`, so they need **no separate change** — fixing `computeRates` fixes them.
- The flow solve stays **per-island** even inside a cable component (resources don't cross cables; concatenating member buildings into one `solveFlow` would wrongly couple their shared θ/φ). Only the **pf aggregation** spans the component.
- The fixpoint iterates the **scalar `pf` only** — gates are a deterministic function of `pf`, so gate-convergence need not be tracked separately.

---

## File Structure

| File | Responsibility |
|---|---|
| `src/flow-power-fixpoint.ts` *(new)* | Pure leaf: damped scalar `pf` fixpoint with no-brownout fast path, cap + fail-open. Imports nothing from `economy.ts`/Pixi/DOM. |
| `src/flow-power-fixpoint.test.ts` *(new)* | Unit tests for the leaf with synthetic `evalAtPf` callbacks. |
| `src/economy.ts` | `computeRates`: extract pass-3 power aggregation into a `gates → {producedW,consumedW}` helper; bake `pf` into power-consumer flow coeffs; run the local fixpoint (or consume a fixed component/override `pf`). New `RatesContext.fixedPowerFactor`. |
| `src/routes.ts` | `computeCableNetworkBalance`: wrap the component produced/consumed aggregation in the fixpoint, threading a fixed `pf` into `computeIslandLocalPower` → `computeRates`. |
| `src/economy.test.ts`, `src/mass-balance.test.ts` | Flicker / no-conjure / no-discard regression tests under brownout. |
| `SPEC.md` §15.3, §5.1 | Resolve the pinned-bin ↔ consumer-only-`pf` inconsistency. |

---

## Task 1: `flow-power-fixpoint.ts` — the scalar fixpoint leaf

**Files:**
- Create: `src/flow-power-fixpoint.ts`
- Test: `src/flow-power-fixpoint.test.ts`

- [ ] **Step 1: Write the failing tests**

```typescript
// src/flow-power-fixpoint.test.ts
import { describe, it, expect } from 'vitest';
import { solveBrownoutFactor } from './flow-power-fixpoint.js';

describe('solveBrownoutFactor', () => {
  it('returns pf=1 in one eval when the pool is in surplus (no brownout)', () => {
    let calls = 0;
    const r = solveBrownoutFactor((pf) => { calls++; return { producedW: 100, consumedW: 80 * pf }; });
    expect(r.powerFactor).toBe(1);
    expect(r.converged).toBe(true);
    expect(calls).toBe(1); // fast path: a single eval at pf=1
  });

  it('returns pf=1 when nothing draws power (consumedW=0)', () => {
    const r = solveBrownoutFactor(() => ({ producedW: 0, consumedW: 0 }));
    expect(r.powerFactor).toBe(1);
    expect(r.converged).toBe(true);
  });

  it('converges to the fixed point of a draw that scales with pf', () => {
    // consumedW(pf) = 200*pf, producedW = 100 → pf* solves pf = 100/(200*pf)
    // ⇒ pf*^2 = 0.5 ⇒ pf* = 0.7071...
    const r = solveBrownoutFactor((pf) => ({ producedW: 100, consumedW: 200 * pf }));
    expect(r.converged).toBe(true);
    expect(r.powerFactor).toBeCloseTo(Math.SQRT1_2, 4);
    // self-consistency: pf == min(1, P/C) at its own gates
    expect(r.powerFactor).toBeCloseTo(Math.min(1, 100 / (200 * r.powerFactor)), 4);
  });

  it('converges for a constant (pf-independent) deficit', () => {
    const r = solveBrownoutFactor(() => ({ producedW: 60, consumedW: 100 }));
    expect(r.converged).toBe(true);
    expect(r.powerFactor).toBeCloseTo(0.6, 6);
  });

  it('fails open (converged=false, clamped pf) on a pathological oscillator', () => {
    // A discontinuous map that flip-flops; damping should still bound it,
    // but assert the contract: result is finite, in [0,1], never throws.
    const r = solveBrownoutFactor(
      (pf) => ({ producedW: pf < 0.5 ? 1000 : 1, consumedW: 100 }),
      { maxIters: 8 },
    );
    expect(Number.isFinite(r.powerFactor)).toBe(true);
    expect(r.powerFactor).toBeGreaterThanOrEqual(0);
    expect(r.powerFactor).toBeLessThanOrEqual(1);
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run src/flow-power-fixpoint.test.ts`
Expected: FAIL — `Cannot find module './flow-power-fixpoint.js'`.

- [ ] **Step 3: Write the implementation**

```typescript
// src/flow-power-fixpoint.ts
// Joint net-flow ⇄ power-brownout fixpoint — §15.3 / §5.1 (see
// docs/superpowers/specs/2026-06-12-net-flow-power-fixpoint-design.md).
//
// Pure leaf: no PixiJS, no DOM, no import from economy.ts. The brownout
// factor pf scales every power-consumer's realized throughput (§5.1), and
// the net-flow gate g is solved with those pf-scaled flows. pf and g are
// therefore mutually dependent; this module finds the consistent pair.
//
// Because the gates are a DETERMINISTIC function of pf (the caller's
// `evalAtPf` solves them), the only coupling variable is the scalar pf:
// pf* = min(1, producedW / consumedW) evaluated at the gates pf* produced.

export const BROWNOUT_FIXPOINT_MAX_ITERS = 64;
export const BROWNOUT_FIXPOINT_EPSILON = 1e-6;

export interface PowerSample {
  /** Realized produced wattage at the gates solved for the probed pf. */
  readonly producedW: number;
  /** Realized consumed wattage at the gates solved for the probed pf. */
  readonly consumedW: number;
}

export interface BrownoutFixpointResult {
  readonly powerFactor: number;
  /** False only if the iteration guard tripped (pathological pool). */
  readonly converged: boolean;
  /** Number of `evalAtPf` calls made (1 on the no-brownout fast path). */
  readonly iterations: number;
}

/** pf from a power sample: the §5.1 brownout factor, clamped to [0,1]. */
function pfOf(s: PowerSample): number {
  if (!(s.consumedW > 0)) return 1; // no draw (or NaN guard) ⇒ no brownout
  return Math.min(1, s.producedW / s.consumedW);
}

/**
 * Solve pf = min(1, producedW(pf) / consumedW(pf)) for the consistent pf,
 * where `evalAtPf(pf)` solves the net-flow gates with each power-consumer's
 * flow coefficients pre-scaled by pf and returns the pool's realized power.
 *
 * Damped fixed-point iteration: the pf→pf map is a decreasing feedback
 * (more pf ⇒ more consumer draw ⇒ lower pf), so undamped iteration can
 * period-2 oscillate; the 0.5 damping converges it. Capped + fail-open,
 * mirroring flow-solver.ts's FLOW_MAX_SWEEPS discipline.
 */
export function solveBrownoutFactor(
  evalAtPf: (pf: number) => PowerSample,
  opts?: { maxIters?: number; epsilon?: number },
): BrownoutFixpointResult {
  const maxIters = opts?.maxIters ?? BROWNOUT_FIXPOINT_MAX_ITERS;
  const eps = opts?.epsilon ?? BROWNOUT_FIXPOINT_EPSILON;

  // No-brownout fast path: at full power, is the pool already in surplus?
  // Then pf=1 is the fixed point — one eval, byte-identical to the
  // pre-fixpoint behaviour for every non-brownout pool (the common case).
  const pfFull = pfOf(evalAtPf(1));
  if (pfFull >= 1 - eps) return { powerFactor: 1, converged: true, iterations: 1 };

  let pf = pfFull;
  for (let i = 1; i <= maxIters; i++) {
    const target = pfOf(evalAtPf(pf));
    const next = (pf + target) / 2; // damping for the decreasing map
    if (Math.abs(next - pf) < eps) {
      return { powerFactor: next, converged: true, iterations: i + 1 };
    }
    pf = next;
  }
  return { powerFactor: pf, converged: false, iterations: maxIters + 1 };
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run src/flow-power-fixpoint.test.ts`
Expected: PASS (5 tests).

- [ ] **Step 5: Commit**

```bash
git add src/flow-power-fixpoint.ts src/flow-power-fixpoint.test.ts
git commit -m "feat(economy): pure scalar brownout⇄flow fixpoint leaf

Co-Authored-By: <model> <noreply@anthropic.com>"
```

---

## Task 2: Extract pass-3 power aggregation into a gates-parameterized helper

The fixpoint must re-evaluate produced/consumed wattage at different `pf` (hence different gates) each iteration. Today pass 3 computes this once inline (`economy.ts:1585-1691`). Extract it so it can be called repeatedly with a `gates` argument, with **zero behavioural change** first (characterization), before any fixpoint wiring.

**Files:**
- Modify: `src/economy.ts` (pass-3 region, ~1585-1691)
- Test: `src/economy.test.ts`

- [ ] **Step 1: Write a characterization test** that pins current power output for a known island fixture, so the extraction can't drift it.

```typescript
// src/economy.test.ts — add inside the existing economy describe block
it('characterization: powerProduced/powerConsumed unchanged by pass-3 extraction', () => {
  // Build a small brownout island: one coal_gen (power producer) + two
  // power-consuming workshops, mid-stock so no bin is pinned.
  const state = makePowerFixtureIsland(); // helper below; deterministic
  const { power } = computeRates(state, undefined, state.lastTick + 200, undefined);
  // Snapshot values captured from `git stash`-clean HEAD before extraction:
  expect(power.produced).toBeCloseTo(POWER_FIXTURE_PRODUCED, 6);
  expect(power.consumed).toBeCloseTo(POWER_FIXTURE_CONSUMED, 6);
});
```

> **Implementer note:** first run this test against clean HEAD to *capture* `POWER_FIXTURE_PRODUCED`/`POWER_FIXTURE_CONSUMED` (log them, paste as consts). `makePowerFixtureIsland` builds a deterministic `IslandState` via the existing test-helpers (`src/test-helpers/`); mirror the construction used by the nearest existing power test in `economy.test.ts`.

- [ ] **Step 2: Run it on clean HEAD to capture the constants**

Run: `npx vitest run src/economy.test.ts -t "powerProduced/powerConsumed unchanged"`
Expected: read the logged produced/consumed; paste them as the asserted consts; test now PASSES on HEAD.

- [ ] **Step 3: Extract the helper.** Move the pass-3 body (`economy.ts:1585-1691`, the `for (const b of validBuildings)` power loop incl. the genesis-chamber loop) into a local closure `aggregatePower(gatesByTentIdx: readonly number[]): { producedW: number; consumedW: number }` defined just above pass 3, replacing the loop's reads of `flowGates[idx]` with `gatesByTentIdx[idx]`. Keep `powerProduced`/`powerConsumed` semantics identical; the closure returns them instead of mutating outer `let`s. Call it once with the existing `flowGates` to preserve behaviour: `const { producedW: powerProduced0, consumedW: powerConsumed0 } = aggregatePower(flowGates);` and feed those into the existing battery/cable code unchanged.

- [ ] **Step 4: Run the full economy suite**

Run: `npx vitest run src/economy.test.ts src/mass-balance.test.ts`
Expected: PASS — extraction is behaviour-preserving.

- [ ] **Step 5: Commit**

```bash
git add src/economy.ts src/economy.test.ts
git commit -m "refactor(economy): extract pass-3 power aggregation as gates→watts helper

Co-Authored-By: <model> <noreply@anthropic.com>"
```

---

## Task 3: Bake `pf` into power-consumer flow coeffs + run the local fixpoint

This is the core fix for solo islands (and, via `computeRates`, lattice §13.3 / shared-network §15.1). Make `solveFlow` see the brownout-scaled flows, and converge `pf` with `g`.

**Files:**
- Modify: `src/economy.ts` — pass 2.5 (`1487-1555`), pass 3 (`pf` computation `1719-1729`), pass 4 (`1745-1763`).
- Test: `src/economy.test.ts`

- [ ] **Step 1: Write the failing test** — the asymmetric-power pinned bin (the bug).

```typescript
// src/economy.test.ts
it('zero-pinned input under brownout does not conjure: producer (power) + consumer (no power)', () => {
  // R is zero-pinned. A produces R and CONSUMES power; B consumes R and uses
  // NO power. Pre-fix: pf scales A's R-output down but not B's draw, so B
  // "consumes" R that was never produced (net[R] < 0, clamped). Post-fix:
  // the solver balances the pf-scaled flows ⇒ net[R] == 0.
  const state = makeAsymmetricBrownoutIsland('zero-pin'); // helper below
  const { net, byBuilding } = computeRates(state, undefined, state.lastTick + 200, undefined);
  expect(net['R' as ResourceId] ?? 0).toBeCloseTo(0, 6); // no conjuring
  // B's realized draw equals A's realized supply (both > 0, balanced):
  const bRate = byBuilding.find((r) => r.building.id === 'B')!.effectiveRate;
  expect(bRate).toBeGreaterThan(0);
});

it('cap-pinned output under brownout does not over-produce: producer (no power) + consumer (power)', () => {
  const state = makeAsymmetricBrownoutIsland('cap-pin');
  const { net } = computeRates(state, undefined, state.lastTick + 200, undefined);
  expect(net['R' as ResourceId] ?? 0).toBeCloseTo(0, 6); // no discard at cap
});

it('no-brownout island: gates and rates byte-identical to pre-fixpoint', () => {
  const state = makeSurplusPowerIsland(); // produced >= consumed at full power
  const { byBuilding } = computeRates(state, undefined, state.lastTick + 200, undefined);
  // Snapshot from HEAD (captured like Task 2): the common path is unchanged.
  for (const r of byBuilding) {
    expect(r.effectiveRate).toBeCloseTo(SURPLUS_RATES[r.building.id]!, 6);
  }
});
```

> **Implementer note:** `makeAsymmetricBrownoutIsland(mode)` builds 3 buildings — A (recipe → R, `power.consumes>0`), B (R → S, no power), and a generator sized so the pool is in deficit (forces `pf<1`). For `'zero-pin'` start `R=0`; for `'cap-pin'` start `R` at its cap. Capture `SURPLUS_RATES` from clean HEAD.

- [ ] **Step 2: Run to verify failure**

Run: `npx vitest run src/economy.test.ts -t "under brownout"`
Expected: FAIL — `net['R']` is negative (zero-pin) / positive (cap-pin), not 0.

- [ ] **Step 3: Implement.** Three edits in `computeRates`:

  **(a) Parameterize coeff assembly by `pf`.** Replace the fixed `flowBuildings` (`1487-1502`) construction with a builder that scales a building's flows by `pf` when it draws power:

```typescript
// Which tentative buildings draw grid power (pf applies to their whole recipe,
// matching pass 4's effectiveRate = base × g × pf).
const consumesPowerByIdx: boolean[] = tentative.map(
  (te) => (defs[te.building.defId].power?.consumes ?? 0) > 0,
);
const buildFlowBuildings = (pf: number): FlowBuildingSpec[] =>
  tentative.map((te, i) => {
    if (te.baseRate <= 0) return { produces: {}, consumes: {} };
    const scale = (consumesPowerByIdx[i] ? pf : 1);
    const produces: Record<string, number> = {};
    const outs = resolveRotatingOutput(te.recipe, t);
    for (const [r, yld] of Object.entries(outs)) {
      const flow = (yld ?? 0) * te.baseRate * te.perBuildingMul * scale;
      if (flow > 0) produces[r] = flow;
    }
    const consumes: Record<string, number> = {};
    for (const [r, need] of Object.entries(te.recipe.inputs)) {
      if (te.recipe.exogenousFlow === 'atmosphere' && r === 'air') continue;
      const flow = ((need ?? 0) / recipeInputDiv) * te.baseRate * te.perBuildingMul * scale;
      if (flow > 0) consumes[r] = flow;
    }
    return { produces, consumes };
  });
```

  Keep the §5.2 synthetic-coal-consumer append and the §13.3 `flowSiblings` union (`1517-1554`) — factor them into a `withSynthetics(flowBuildings)` step so each `pf` iteration reuses them (siblings/coal entries are `pf`-independent: lattice siblings already arrive pre-scaled; synthetic coal burn is a fixed sink). Define `solveGatesAt(pf) → number[]` = `solveFlow(withSynthetics(buildFlowBuildings(pf)), { capConstrained, zeroConstrained }).gates`.

  **(b) Pick `pf` source and run the fixpoint.** Replace the pass-3 `powerFactor` computation (`1719-1729`) so that:

```typescript
// A unified cable component (or a pre-pass override) FIXES pf for this pool;
// otherwise pf is local and co-solved with the gates.
const fixedPf =
  ctx?.fixedPowerFactor ??
  (cableComponent?.unified
    ? (cableComponent.consumedTotal === 0
        ? 1
        : Math.min(1, cableComponent.producedTotal / cableComponent.consumedTotal))
    : undefined);

let flowGates: number[];
let powerFactor: number;
if (fixedPf !== undefined) {
  // Fixed pf: single solve against it (no local fixpoint).
  flowGates = solveGatesAt(fixedPf);
  powerFactor = fixedPf;
} else {
  // Local pool: co-solve pf with the gates. Cache gates per probed pf so the
  // no-brownout fast path (pf=1) reuses its single solve — perf parity.
  let cachePf = NaN;
  let cacheGates: number[] = [];
  let cacheProduced = 0;
  let cacheConsumed = 0;
  const evalAtPf = (pf: number) => {
    cacheGates = solveGatesAt(pf);
    cachePf = pf;
    const agg = aggregatePower(cacheGates); // Task 2 helper, BEFORE battery/cable
    cacheProduced = agg.producedW;
    cacheConsumed = agg.consumedW;
    return { producedW: cacheProduced, consumedW: cacheConsumed };
  };
  const res = solveBrownoutFactor(evalAtPf);
  powerFactor = res.powerFactor;
  flowGates = cachePf === powerFactor ? cacheGates : solveGatesAt(powerFactor);
}
```

  Note: `aggregatePower` here is the *raw* local balance (pre §13.3 battery-buffer, pre §5.3 cable unification). The battery deficit-cover and cable-unification code (`1693-1729`) stays AFTER, operating on the converged `powerFactor`/gates exactly as before — but for the local non-cabled path, `powerFactor` is now already the co-solved local value, so the existing local `min(1, produced/consumed)` line is replaced by the fixpoint result above. Wire the battery-buffer block (`1703-1710`) to use `aggregatePower(flowGates)` for its `powerProduced < powerConsumed` test.

  **(c) Pass 4 unchanged in shape** (`1745-1763`): it already multiplies `te.baseRate * g * pf`. With `g` now solved against the pf-scaled coeffs, `g` is the *residual storage* throttle and `g × pf` reproduces the realized flow the solver balanced ⇒ pinned bins net 0. Leave the line as-is. Add `import { solveBrownoutFactor } from './flow-power-fixpoint.js';` at the top.

- [ ] **Step 4: Run the targeted + full economy suites**

Run: `npx vitest run src/economy.test.ts src/mass-balance.test.ts src/flow-solver.test.ts`
Expected: PASS — new brownout tests green; no-brownout snapshot identical; existing solver tests untouched.

- [ ] **Step 5: Commit**

```bash
git add src/economy.ts src/economy.test.ts
git commit -m "fix(economy): co-solve net-flow gate with brownout (local pools)

Bakes powerFactor into power-consumers' flow coefficients and converges
pf⇄g via the scalar fixpoint, so a pinned bin nets to 0 under the realized
brownout-scaled flows — killing the +0/+0.0x flicker on solo / lattice /
shared-network islands. No-brownout pools keep a single solve (parity).

Co-Authored-By: <model> <noreply@anthropic.com>"
```

---

## Task 4: New `RatesContext.fixedPowerFactor` field (override seam for the pre-pass)

Task 3 already reads `ctx?.fixedPowerFactor`; declare it.

**Files:**
- Modify: `src/economy.ts` — `RatesContext` interface (near `129-196`).

- [ ] **Step 1: Add the field with a precise doc comment.**

```typescript
  /** §5.3 cable pre-pass seam: when set, computeRates solves the net-flow
   *  gates against THIS brownout factor (no local pf fixpoint) and reports it
   *  verbatim as `power`. Used by `computeCableNetworkBalance`'s component
   *  fixpoint to probe each member's realized draw at a candidate shared pf.
   *  Distinct from `cableComponent.unified` (which is the FINAL frozen
   *  component pf consumed during advance); `fixedPowerFactor` takes
   *  precedence when both are present. */
  readonly fixedPowerFactor?: number;
```

- [ ] **Step 2: Verify type-check.**

Run: `npm run build`
Expected: clean (no unused-field error — Task 3 references it).

- [ ] **Step 3: Commit**

```bash
git add src/economy.ts
git commit -m "feat(economy): RatesContext.fixedPowerFactor seam for the cable pre-pass

Co-Authored-By: <model> <noreply@anthropic.com>"
```

---

## Task 5: Component fixpoint in the cable pre-pass

Make `computeCableNetworkBalance`'s per-component produced/consumed aggregation a fixpoint over the one shared scalar, probing members at a candidate `pf`.

**Files:**
- Modify: `src/routes.ts` — `computeIslandLocalPower` (`259-280`), `computeCableNetworkBalance` (component summation, ~`360-430`).
- Test: `src/routes.test.ts`

- [ ] **Step 1: Write the failing test** — two-island brownout component converges to one shared `pf`.

```typescript
// src/routes.test.ts
it('cable component in brownout converges to one shared brownout factor', () => {
  // Island P: generators (surplus). Island Q: heavy power consumers (deficit).
  // Linked by a power cable with capacity passing the §5.3 gate.
  const world = makeTwoIslandCableComponent('brownout'); // helper
  const balances = computeCableNetworkBalance(world.state, world.islandStates, undefined, world.now);
  const bP = balances.get('P')!;
  const bQ = balances.get('Q')!;
  expect(bP.unified).toBe(true);
  expect(bQ.unified).toBe(true);
  const pfP = bP.producedTotal === 0 ? 1 : Math.min(1, bP.producedTotal / bP.consumedTotal);
  const pfQ = bQ.producedTotal === 0 ? 1 : Math.min(1, bQ.producedTotal / bQ.consumedTotal);
  expect(pfP).toBeCloseTo(pfQ, 6);      // ONE shared scalar
  expect(pfP).toBeLessThan(1);          // genuine brownout
});
```

- [ ] **Step 2: Run to verify failure**

Run: `npx vitest run src/routes.test.ts -t "shared brownout factor"`
Expected: FAIL — without co-solving, `producedTotal/consumedTotal` is measured at each member's pf=1 draw, so the implied pf is the wrong (un-throttled) value.

- [ ] **Step 3: Implement.** Add a `fixedPf` parameter to `computeIslandLocalPower` that threads into the `computeRates` ctx:

```typescript
export function computeIslandLocalPower(
  state: IslandState,
  ctx?: RatesContext,
  nowMs?: number,
  solarClockMs?: number,
  fixedPf?: number, // §5.3 component-fixpoint probe
): PowerBalance {
  const localCtx: RatesContext = { ...(ctx ?? {}), fixedPowerFactor: fixedPf };
  const { power } = computeRates(state, localCtx, nowMs, solarClockMs);
  return power;
}
```

  Then in `computeCableNetworkBalance`, for each connected component whose §5.3 gate passes, wrap the produced/consumed aggregation in the fixpoint:

```typescript
import { solveBrownoutFactor } from './flow-power-fixpoint.js';
// ... per unified component `members`:
const evalComponent = (pf: number) => {
  let producedW = 0, consumedW = 0;
  for (const id of members) {
    const st = islandStates.get(id)!;
    const local = computeIslandLocalPower(st, localPowerCtxFor?.(id), nowMs, solarClockMs, pf);
    producedW += local.produced;
    consumedW += local.consumed;
  }
  return { producedW, consumedW };
};
const { powerFactor } = solveBrownoutFactor(evalComponent);
// producedTotal/consumedTotal recorded at the CONVERGED pf so the stored
// balance and the advance-time pf agree:
const final = evalComponent(powerFactor);
// store final.producedW / final.consumedW into each member's CableComponentBalance
```

  Leave the un-gated (cables inert) branch on the existing single-shot local path — those islands fall back to their own local fixpoint inside `computeRates` during advance, no component scalar involved.

- [ ] **Step 4: Run routes + economy suites**

Run: `npx vitest run src/routes.test.ts src/economy.test.ts src/mass-balance.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/routes.ts src/routes.test.ts
git commit -m "fix(routes): co-solve §5.3 component brownout factor with member gates

Co-Authored-By: <model> <noreply@anthropic.com>"
```

---

## Task 6: Flicker + steady-state regression tests

Lock the behaviour the solver promises: under brownout a pinned bin holds net 0 across many segments with constant rate, and a long advance is O(1) segments.

**Files:**
- Test: `src/economy.test.ts`, `src/mass-balance.test.ts`

- [ ] **Step 1: Write the regression tests**

```typescript
// src/economy.test.ts
it('no flicker: brownout pinned bin holds constant rate across many segments', () => {
  const state = makeAsymmetricBrownoutIsland('cap-pin');
  const rates: number[] = [];
  let t = state.lastTick;
  for (let i = 0; i < 50; i++) {
    t += 200;
    const { byBuilding } = computeRates(state, undefined, t, undefined);
    const a = byBuilding.find((r) => r.building.id === 'A');
    if (a) rates.push(a.effectiveRate);
    advanceIsland(state, t);
  }
  // All sampled rates equal (no +0/+0.0x oscillation):
  const first = rates[0]!;
  for (const r of rates) expect(r).toBeCloseTo(first, 9);
});

it('event count: 1h advance at a brownout-pinned bin is O(1) segments', () => {
  const state = makeAsymmetricBrownoutIsland('cap-pin');
  const segments = countAdvanceSegments(state, state.lastTick + 3_600_000); // helper / spy
  expect(segments).toBeLessThan(10);
});
```

```typescript
// src/mass-balance.test.ts
it('brownout conserves mass at a zero-pinned input (no conjuring)', () => {
  const state = makeAsymmetricBrownoutIsland('zero-pin');
  const before = totalMass(state);
  advanceIsland(state, state.lastTick + 60_000);
  // R never went negative and B consumed only what A produced:
  expect(state.inventory['R' as ResourceId] ?? 0).toBeGreaterThanOrEqual(0);
  expect(massDelta(state, before)).toBeCloseTo(expectedNetProduction(state, 60_000), 4);
});
```

> **Implementer note:** `countAdvanceSegments` can wrap `findNextCapEvent` with a counter or reuse any existing segment-counting test util in `economy.test.ts`. Reuse `totalMass`/`massDelta` patterns already in `mass-balance.test.ts`.

- [ ] **Step 2: Run to verify they pass** (the fix from Tasks 3/5 should already satisfy them)

Run: `npx vitest run src/economy.test.ts src/mass-balance.test.ts`
Expected: PASS. If the flicker test fails, the fix is incomplete — return to Task 3.

- [ ] **Step 3: Commit**

```bash
git add src/economy.test.ts src/mass-balance.test.ts
git commit -m "test(economy): flicker + mass-conservation regressions under brownout

Co-Authored-By: <model> <noreply@anthropic.com>"
```

---

## Task 7: SPEC.md — resolve the §15.3 ↔ §5.1 inconsistency

**Files:**
- Modify: `SPEC.md` §15.3 (net-flow throttle note, ~`2032-2063`), §5.1 (~`607-611`).

- [ ] **Step 1: §15.3** — change "A pinned bin runs at net **exactly 0**" to "...at net **exactly 0 under the realized (brownout-scaled) flows**," and append: "The brownout factor `powerFactor` (§5.1) is **co-solved** with the gate `g` as a damped per-pool scalar fixpoint (`flow-power-fixpoint.ts`): power-consumers' flow coefficients are pre-scaled by `pf` before the solve, so the pinned-bin balance holds under the *realized* flows. This **supersedes** the prior 'powerFactor computed after the solve, re-throttles next segment' approximation (`docs/superpowers/specs/2026-06-10-net-flow-economy-design.md:109-111`), which reintroduced the very flicker the solver removes."

- [ ] **Step 2: §5.1** — after "`power_factor` multiplies the production rate of every consumer," add: "`power_factor` is not applied *after* the net-flow solve; it is **co-solved** with the gate `g` (§15.3) so consumer-only scaling no longer breaks the pinned-bin net-0 invariant. A pool is the set of buildings sharing one brownout scalar this tick — a unified §5.3 cable component, or a lone island. Generator wattage remains never solver-gated."

- [ ] **Step 3: Verify no stale claims remain**

Run: `grep -n "after the solve\|next segment\|same lag" SPEC.md`
Expected: no remaining assertion that brownout is applied after the solve.

- [ ] **Step 4: Commit**

```bash
git add SPEC.md
git commit -m "docs(spec): §15.3/§5.1 brownout co-solved with net-flow gate (no post-solve lag)

Co-Authored-By: <model> <noreply@anthropic.com>"
```

---

## Final verification

- [ ] `npm test` — full suite green.
- [ ] `npm run build` — clean under strict TS (`noUncheckedIndexedAccess`, `noUnusedLocals`).
- [ ] `npx vitest run src/flow-power-fixpoint.test.ts src/economy.test.ts src/routes.test.ts src/mass-balance.test.ts src/flow-solver.test.ts` — all green.
- [ ] Manual smoke: build, reload `islands.nitjsefni.eu`, observe a power-starved island — HUD rates steady (no +0/+0.0x flicker) at a pinned bin.

---

## Notes for the implementer

- **TDD is mandatory** here — every task writes the failing test first. The no-brownout snapshot tests (Tasks 2, 3) are the safety net: they must capture values from clean HEAD before the change.
- **Perf parity** is a hard requirement for non-brownout pools: the fast path must make exactly one `solveFlow` call. The gate cache in Task 3 step 3(b) enforces this.
- **Do not** concatenate cable-member buildings into one `solveFlow` — resources don't cross cables; the per-island solve + shared-scalar aggregation is deliberate (see refinements at top).
- **Fail-open** is load-bearing: a non-converging pool degrades to its last iterate for that tick, never hangs or NaNs — same posture as `flow-solver.ts`.
