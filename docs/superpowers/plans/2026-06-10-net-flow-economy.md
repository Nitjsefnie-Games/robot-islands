# Net-Flow Economy Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the binary output-cap stall with an exact demand-coupled flow solver so rates stop flickering at full bins; one utilization factor per building drives effective rate, XP, power draw, and (new) maintenance wear.

**Architecture:** New pure leaf module `src/flow-solver.ts` (no PixiJS, no economy.ts import — like `vision-source.ts`) solves per-building gate factors `g[i] ∈ [0,1]` given production/consumption coefficients and per-resource cap/zero constraints, via SCC condensation + topological propagation with an exact piecewise-linear 1-D solve per constrained resource. `computeRates` (economy.ts) feeds it in a new "pass 2.5" and consumes `g` in passes 3–4. `advanceIsland` scales `operatingMs` accrual by utilization.

**Tech Stack:** TypeScript strict (`noUncheckedIndexedAccess` etc.), vitest. Pure layer only — no renderer involvement.

**Spec:** `docs/superpowers/specs/2026-06-10-net-flow-economy-design.md` (read it before starting any task). Locked rules: cap → producers throttle to consumer draw; min rule for multi-output; wear ∝ utilization; no schema bump.

**Verified code anchors (line numbers approximate — locate by the quoted code, not the number):**
- `economy.ts:532` `outputAvail` (binary; to be narrowed to pass-3 probe use)
- `economy.ts:575` `inputAvail` (continuous; to be narrowed to pass-3 probe use)
- `economy.ts:1077-1081` genesis-chamber `oa === 0` bail → REMOVE
- `economy.ts:1175-1179` normal-path `oa === 0` bail → REMOVE
- `economy.ts:1201-1202` `baseRate` composition; `effectiveMul: gateResult.effectiveMul * heatFactor`
- `economy.ts:1213-1250` pass 2 (`inputAvailByIdx`) — KEPT for pass-3 probes
- `economy.ts:1311-1330` pass-3 `nominalThroughputFrac` block
- `economy.ts:1402-1452` pass 4
- `economy.ts:513-518` `BuildingRate` interface
- `economy.ts:1583-1657` `findNextCapEvent` (maintenance boundary block at 1626-1644)
- `economy.ts:2150-2173` wear-accrual loop in `advanceIsland`
- `maintenance.ts:215` `accrueOperatingTime`

---

### Task 1: flow-solver module — types and the no-constraint trivial case

**Files:**
- Create: `src/flow-solver.ts`
- Create: `src/flow-solver.test.ts`

- [ ] **Step 1: Write the failing tests**

```ts
// src/flow-solver.test.ts
import { describe, expect, it } from 'vitest';
import { solveFlow, type FlowBuildingSpec } from './flow-solver.js';

const B = (
  produces: Record<string, number>,
  consumes: Record<string, number> = {},
): FlowBuildingSpec => ({ produces, consumes });

describe('solveFlow — trivial cases', () => {
  it('no constrained resources → every gate is 1', () => {
    const r = solveFlow(
      [B({ iron: 5 }), B({}, { iron: 3 })],
      { capConstrained: new Set(), zeroConstrained: new Set() },
    );
    expect(r.gates).toEqual([1, 1]);
    expect(r.converged).toBe(true);
  });

  it('empty problem → empty gates', () => {
    const r = solveFlow([], { capConstrained: new Set(), zeroConstrained: new Set() });
    expect(r.gates).toEqual([]);
    expect(r.converged).toBe(true);
  });

  it('coefficient-less building (baseRate 0 upstream) → gate 1, harmless', () => {
    const r = solveFlow(
      [B({}, {}), B({ iron: 5 })],
      { capConstrained: new Set(['iron']), zeroConstrained: new Set() },
    );
    expect(r.gates[0]).toBe(1);
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `npx vitest run src/flow-solver.test.ts`
Expected: FAIL — `Cannot find module './flow-solver.js'`

- [ ] **Step 3: Create the module with types and the trivial path**

```ts
// src/flow-solver.ts
// Exact net-flow solver — §15.3 net-flow rework (see
// docs/superpowers/specs/2026-06-10-net-flow-economy-design.md).
//
// Pure leaf module: no PixiJS, no DOM, no imports from economy.ts.
// Given per-building production/consumption coefficients (units/sec at
// gate 1) and the set of cap-pinned / zero-pinned resources, returns the
// greatest gate vector g ∈ [0,1]^N such that:
//   - capConstrained r:  realized production of r ≤ realized consumption
//   - zeroConstrained r: realized consumption of r ≤ realized production
//   - per-resource shared factors + min rule per building (most-constrained
//     stream governs), with complementarity (a constraint binds only while
//     it would actually be violated).

export interface FlowBuildingSpec {
  /** Production coefficients, units/sec at gate 1. */
  readonly produces: Readonly<Record<string, number>>;
  /** Consumption coefficients, units/sec at gate 1. */
  readonly consumes: Readonly<Record<string, number>>;
}

export interface FlowConstraints {
  /** Resources whose inventory sits at storage cap (inv >= cap). */
  readonly capConstrained: ReadonlySet<string>;
  /** Resources whose inventory sits at zero (inv <= 0). */
  readonly zeroConstrained: ReadonlySet<string>;
}

export interface FlowSolution {
  /** Gate per building, same order as the input array, each in [0,1]. */
  readonly gates: number[];
  /** False only if the SCC iteration guard tripped (pathological cycle). */
  readonly converged: boolean;
}

export const FLOW_EPSILON = 1e-9;
export const FLOW_MAX_SWEEPS = 1000;

export function solveFlow(
  buildings: ReadonlyArray<FlowBuildingSpec>,
  constraints: FlowConstraints,
): FlowSolution {
  if (constraints.capConstrained.size === 0 && constraints.zeroConstrained.size === 0) {
    return { gates: buildings.map(() => 1), converged: true };
  }
  // Real solve lands in Tasks 2–3.
  return { gates: buildings.map(() => 1), converged: true };
}
```

- [ ] **Step 4: Run to verify pass**

Run: `npx vitest run src/flow-solver.test.ts`
Expected: PASS (3 tests)

- [ ] **Step 5: Commit**

```bash
git add src/flow-solver.ts src/flow-solver.test.ts
git commit -m "feat(flow-solver): module skeleton — types + unconstrained trivial solve"
```
(Implementer appends its own Co-Authored-By trailer per repo convention.)

---

### Task 2: the exact shared-factor primitive (`solveSharedFactor`)

The core math. For a capped resource the shared throttle θ must satisfy
`Σᵢ pᵢ · min(gᵢ^{¬r}, θ) = target` (realized production equals consumer
draw), NOT the naive `θ = target / Σ pᵢ gᵢ^{¬r}` — a producer already
throttled below θ by another constraint contributes only its `pᵢ·gᵢ^{¬r}`,
and the remaining producers must absorb the slack. Same equation mirrored
for zero-side φ. Solve exactly: sort breakpoints, walk piecewise-linear
segments.

**Files:**
- Modify: `src/flow-solver.ts`
- Modify: `src/flow-solver.test.ts`

- [ ] **Step 1: Write the failing tests**

```ts
// append to src/flow-solver.test.ts
import { solveSharedFactor } from './flow-solver.js';

describe('solveSharedFactor', () => {
  it('single entry, no other constraint: plain ratio', () => {
    // 5/s producer, consumers draw 3/s → θ = 0.6
    expect(solveSharedFactor([{ coeff: 5, otherGate: 1 }], 3)).toBeCloseTo(0.6, 12);
  });

  it('target ≥ unthrottled supply → 1 (constraint slack / deactivated)', () => {
    expect(solveSharedFactor([{ coeff: 5, otherGate: 1 }], 7)).toBe(1);
    expect(solveSharedFactor([{ coeff: 5, otherGate: 0.4 }], 2)).toBe(1); // 5×0.4=2 ≤ 2
  });

  it('zero target → 0', () => {
    expect(solveSharedFactor([{ coeff: 5, otherGate: 1 }], 0)).toBe(0);
  });

  it('no entries or zero coeffs → 1 (nothing to throttle)', () => {
    expect(solveSharedFactor([], 3)).toBe(1);
    expect(solveSharedFactor([{ coeff: 0, otherGate: 1 }], 3)).toBe(1);
  });

  it('entry pinned below θ by its other constraint absorbs only its share', () => {
    // p=10 at otherGate 0.5 (contributes ≤5) + p=10 free.
    // target 8: 10·min(0.5,θ) + 10·min(1,θ) = 8 → θ>0.5 region:
    // 5 + 10θ = 8 → θ = 0.3? No: 0.3 < 0.5 contradiction → θ≤0.5 region:
    // 20θ = 8 → θ = 0.4 (both contribute 4). Verify: 10·0.4 + 10·0.4 = 8. ✓
    expect(
      solveSharedFactor(
        [{ coeff: 10, otherGate: 0.5 }, { coeff: 10, otherGate: 1 }],
        8,
      ),
    ).toBeCloseTo(0.4, 12);
    // target 12: θ>0.5 → 5 + 10θ = 12 → θ = 0.7.
    expect(
      solveSharedFactor(
        [{ coeff: 10, otherGate: 0.5 }, { coeff: 10, otherGate: 1 }],
        12,
      ),
    ).toBeCloseTo(0.7, 12);
  });

  it('design-spec regression: single producer otherGate 0.5, demand 3 of 10', () => {
    // Naive ratio against supplyNoR (10×0.5=5) would give 0.6 → realized 5 > 3.
    // Exact: 10·min(0.5,θ) = 3 → θ = 0.3.
    expect(solveSharedFactor([{ coeff: 10, otherGate: 0.5 }], 3)).toBeCloseTo(0.3, 12);
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `npx vitest run src/flow-solver.test.ts`
Expected: FAIL — `solveSharedFactor` is not exported

- [ ] **Step 3: Implement**

```ts
// add to src/flow-solver.ts

/** One participant in a shared-factor solve: its flow coefficient and the
 *  gate its OTHER constraints impose (the exclusion gate g^{¬r}). */
export interface SharedFactorEntry {
  readonly coeff: number;
  readonly otherGate: number;
}

/**
 * Solve Σᵢ coeffᵢ · min(otherGateᵢ, θ) = target for the largest θ ∈ [0,1].
 * Piecewise-linear and monotone in θ, so: if even θ=1 stays ≤ target the
 * constraint is slack (return 1); otherwise walk the sorted otherGate
 * breakpoints and solve the linear segment containing the root. Exact.
 */
export function solveSharedFactor(
  entries: ReadonlyArray<SharedFactorEntry>,
  target: number,
): number {
  const live = entries.filter((e) => e.coeff > 0 && e.otherGate > 0);
  if (live.length === 0) return 1;
  let full = 0;
  for (const e of live) full += e.coeff * Math.min(e.otherGate, 1);
  if (full <= target + FLOW_EPSILON) return 1; // slack — deactivated
  if (target <= 0) return 0;
  // Sort ascending by otherGate; below breakpoint k, entries 0..k-1 are
  // pinned (contribute coeff×otherGate), the rest scale with θ.
  const sorted = [...live].sort((a, b) => a.otherGate - b.otherGate);
  let pinnedSum = 0; // Σ coeff×otherGate of entries pinned below θ
  let freeCoeff = 0; // Σ coeff of entries scaling with θ
  for (const e of sorted) freeCoeff += e.coeff;
  let lo = 0;
  for (let k = 0; k <= sorted.length; k++) {
    const hi = k < sorted.length ? Math.min(sorted[k]!.otherGate, 1) : 1;
    // On [lo, hi): realized(θ) = pinnedSum + freeCoeff × θ
    const theta = (target - pinnedSum) / freeCoeff;
    if (theta >= lo - FLOW_EPSILON && theta <= hi + FLOW_EPSILON) {
      return Math.min(1, Math.max(0, theta));
    }
    if (k < sorted.length) {
      const e = sorted[k]!;
      pinnedSum += e.coeff * Math.min(e.otherGate, 1);
      freeCoeff -= e.coeff;
      lo = hi;
      if (freeCoeff <= 0) break;
    }
  }
  return 1; // unreachable given the full > target guard; defensive
}
```

- [ ] **Step 4: Run to verify pass**

Run: `npx vitest run src/flow-solver.test.ts`
Expected: PASS (all tests)

- [ ] **Step 5: Commit**

```bash
git add src/flow-solver.ts src/flow-solver.test.ts
git commit -m "feat(flow-solver): exact piecewise-linear shared-factor solve"
```

---

### Task 3: full solver — multipliers, SCC/topo ordering, sweeps, worked examples, property test

**Files:**
- Modify: `src/flow-solver.ts`
- Modify: `src/flow-solver.test.ts`

- [ ] **Step 1: Write the failing tests (the four spec worked examples + chain + cycle)**

```ts
// append to src/flow-solver.test.ts
describe('solveFlow — spec worked examples', () => {
  it('example 1 — cap throttle: mine 5/s, workshop draws 3/s, iron at cap', () => {
    const r = solveFlow(
      [B({ iron: 5 }), B({}, { iron: 3 })],
      { capConstrained: new Set(['iron']), zeroConstrained: new Set() },
    );
    expect(r.gates[0]).toBeCloseTo(0.6, 9); // mine throttled to consumer draw
    expect(r.gates[1]).toBe(1);             // consumer unconstrained
    expect(r.converged).toBe(true);
  });

  it('example 1b — cap with NO consumer: producer idles at 0', () => {
    const r = solveFlow(
      [B({ iron: 5 })],
      { capConstrained: new Set(['iron']), zeroConstrained: new Set() },
    );
    expect(r.gates[0]).toBe(0);
  });

  it('example 2 — zero flow-through: mine 3/s, workshop demands 5/s, iron at 0', () => {
    const r = solveFlow(
      [B({ iron: 3 }), B({}, { iron: 5 })],
      { capConstrained: new Set(), zeroConstrained: new Set(['iron']) },
    );
    expect(r.gates[0]).toBe(1);
    expect(r.gates[1]).toBeCloseTo(0.6, 9); // workshop ticks at 60%
  });

  it('example 3 — min rule: alloy capped (small draw), slag buffered', () => {
    const r = solveFlow(
      [B({ alloy: 4, slag: 2 }), B({}, { alloy: 1 })],
      { capConstrained: new Set(['alloy']), zeroConstrained: new Set() },
    );
    expect(r.gates[0]).toBeCloseTo(0.25, 9); // slag slows with the alloy throttle
  });

  it('example 4a — deactivating constraint: second capped output has zero demand', () => {
    // B outputs r1 (cap, demand 2/s of 10) and r2 (cap, demand 0).
    // θ_r2 = 0 ⇒ g(B) = 0; r1 then has zero supply < demand, its constraint
    // deactivates (θ_r1 = 1) — but r2 still pins the building at 0.
    const r = solveFlow(
      [B({ r1: 10, r2: 10 }), B({}, { r1: 2 })],
      { capConstrained: new Set(['r1', 'r2']), zeroConstrained: new Set() },
    );
    expect(r.gates[0]).toBe(0);
  });

  it('example 4b — partial deactivation: r2 demand 5/s', () => {
    // θ_r1 = 0.2 binds; at g=0.2 r2 supplies 2 < 5 demand → r2 deactivates.
    const r = solveFlow(
      [B({ r1: 10, r2: 10 }), B({}, { r1: 2 }), B({}, { r2: 5 })],
      { capConstrained: new Set(['r1', 'r2']), zeroConstrained: new Set() },
    );
    expect(r.gates[0]).toBeCloseTo(0.2, 9);
  });

  it('3-stage chain, middle bin capped: throttle propagates upstream', () => {
    // A → ore (capped) → S → plate (buffered) → W draws plate implicitly via
    // S consuming ore at 4/s only if S itself runs. S consumes ore 4/s,
    // produces plate 4/s; sink consumes plate 1/s; plate ALSO capped.
    // θ_plate = 1/4 → g(S)=0.25 → S draws ore at 1/s → θ_ore = 1/8 → g(A)=0.125.
    const r = solveFlow(
      [B({ ore: 8 }), B({ plate: 4 }, { ore: 4 }), B({}, { plate: 1 })],
      { capConstrained: new Set(['ore', 'plate']), zeroConstrained: new Set() },
    );
    expect(r.gates[1]).toBeCloseTo(0.25, 9);
    expect(r.gates[0]).toBeCloseTo(0.125, 9);
  });

  it('A↔B cycle at zero stocks: mutual bootstrap deadlock → both 0', () => {
    const r = solveFlow(
      [B({ x: 1 }, { y: 1 }), B({ y: 1 }, { x: 1 })],
      { capConstrained: new Set(), zeroConstrained: new Set(['x', 'y']) },
    );
    expect(r.gates[0]).toBe(0);
    expect(r.gates[1]).toBe(0);
    expect(r.converged).toBe(true);
  });

  it('self-loop: building produces and consumes the same capped resource', () => {
    // Net producer (p=5, c=2) at cap with external draw 1/s:
    // realized prod ≤ realized cons: 5g ≤ 2g + 1 → g ≤ 1/3.
    const r = solveFlow(
      [B({ iron: 5 }, { iron: 2 }), B({}, { iron: 1 })],
      { capConstrained: new Set(['iron']), zeroConstrained: new Set() },
    );
    expect(r.gates[0]!).toBeCloseTo(1 / 3, 6);
  });
});

describe('solveFlow — property test', () => {
  it('random problems satisfy constraints and maximality', () => {
    // Deterministic LCG so the test is reproducible.
    let seed = 0x2f6e2b1;
    const rnd = (): number => {
      seed = (seed * 1103515245 + 12345) & 0x7fffffff;
      return seed / 0x7fffffff;
    };
    const RESOURCES = ['a', 'b', 'c', 'd', 'e'];
    for (let trial = 0; trial < 200; trial++) {
      const n = 1 + Math.floor(rnd() * 6);
      const buildings: FlowBuildingSpec[] = [];
      for (let i = 0; i < n; i++) {
        const produces: Record<string, number> = {};
        const consumes: Record<string, number> = {};
        for (const res of RESOURCES) {
          if (rnd() < 0.3) produces[res] = 0.5 + rnd() * 9.5;
          else if (rnd() < 0.3) consumes[res] = 0.5 + rnd() * 9.5;
        }
        buildings.push({ produces, consumes });
      }
      const capConstrained = new Set<string>();
      const zeroConstrained = new Set<string>();
      for (const res of RESOURCES) {
        const roll = rnd();
        if (roll < 0.3) capConstrained.add(res);
        else if (roll < 0.6) zeroConstrained.add(res);
      }
      const { gates, converged } = solveFlow(buildings, { capConstrained, zeroConstrained });
      expect(converged).toBe(true);
      const prod: Record<string, number> = {};
      const cons: Record<string, number> = {};
      for (let i = 0; i < n; i++) {
        const g = gates[i]!;
        expect(g).toBeGreaterThanOrEqual(0);
        expect(g).toBeLessThanOrEqual(1);
        for (const [res, p] of Object.entries(buildings[i]!.produces)) {
          prod[res] = (prod[res] ?? 0) + p * g;
        }
        for (const [res, c] of Object.entries(buildings[i]!.consumes)) {
          cons[res] = (cons[res] ?? 0) + c * g;
        }
      }
      const TOL = 1e-6;
      for (const res of capConstrained) {
        expect((prod[res] ?? 0)).toBeLessThanOrEqual((cons[res] ?? 0) + TOL);
      }
      for (const res of zeroConstrained) {
        expect((cons[res] ?? 0)).toBeLessThanOrEqual((prod[res] ?? 0) + TOL);
      }
    }
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `npx vitest run src/flow-solver.test.ts`
Expected: FAIL on every new `solveFlow` test (stub returns all-1 gates)

- [ ] **Step 3: Implement the full solver**

```ts
// replace the solveFlow stub in src/flow-solver.ts with:

/** Internal multiplier key: one shared factor per constrained resource side. */
type MulKey = string; // `cap:${resource}` | `zero:${resource}`

export function solveFlow(
  buildings: ReadonlyArray<FlowBuildingSpec>,
  constraints: FlowConstraints,
): FlowSolution {
  const n = buildings.length;
  const keys: MulKey[] = [];
  for (const r of constraints.capConstrained) keys.push(`cap:${r}`);
  for (const r of constraints.zeroConstrained) keys.push(`zero:${r}`);
  if (keys.length === 0 || n === 0) {
    return { gates: buildings.map(() => 1), converged: true };
  }

  // Per building: the multiplier keys that gate it. Cap constrains PRODUCERS
  // of r; zero constrains CONSUMERS of r.
  const keysByBuilding: MulKey[][] = buildings.map((b) => {
    const ks: MulKey[] = [];
    for (const r of Object.keys(b.produces)) {
      if ((b.produces[r] ?? 0) > 0 && constraints.capConstrained.has(r)) ks.push(`cap:${r}`);
    }
    for (const r of Object.keys(b.consumes)) {
      if ((b.consumes[r] ?? 0) > 0 && constraints.zeroConstrained.has(r)) ks.push(`zero:${r}`);
    }
    return ks;
  });

  const mul = new Map<MulKey, number>();
  for (const k of keys) mul.set(k, 1);

  /** Gate of building i, optionally ignoring one multiplier key (g^{¬r}). */
  const gate = (i: number, exclude?: MulKey): number => {
    let g = 1;
    for (const k of keysByBuilding[i]!) {
      if (k === exclude) continue;
      const m = mul.get(k) ?? 1;
      if (m < g) g = m;
    }
    return g;
  };

  /** Recompute one multiplier from current state. Returns the new value. */
  const update = (key: MulKey): number => {
    const isCap = key.startsWith('cap:');
    const res = key.slice(isCap ? 4 : 5);
    if (isCap) {
      // target = realized consumer draw of res (consumers of a capped res are
      // never gated by THIS key unless they also produce it — excluded then).
      let target = 0;
      const entries: SharedFactorEntry[] = [];
      for (let i = 0; i < buildings.length; i++) {
        const c = buildings[i]!.consumes[res] ?? 0;
        if (c > 0) target += c * gate(i, key);
        const p = buildings[i]!.produces[res] ?? 0;
        if (p > 0) entries.push({ coeff: p, otherGate: gate(i, key) });
      }
      return solveSharedFactor(entries, target);
    }
    // zero side: target = realized production of res; entries = consumers.
    let target = 0;
    const entries: SharedFactorEntry[] = [];
    for (let i = 0; i < buildings.length; i++) {
      const p = buildings[i]!.produces[res] ?? 0;
      if (p > 0) target += p * gate(i, key);
      const c = buildings[i]!.consumes[res] ?? 0;
      if (c > 0) entries.push({ coeff: c, otherGate: gate(i, key) });
    }
    return solveSharedFactor(entries, target);
  };

  // ---- dependency graph between multiplier keys -------------------------
  // updating key u reads key v when some building participating in u's
  // update (either side) is gated by v. Conservative superset is fine.
  const keyIndex = new Map<MulKey, number>(keys.map((k, i) => [k, i]));
  const edges: number[][] = keys.map(() => []);
  for (let ki = 0; ki < keys.length; ki++) {
    const key = keys[ki]!;
    const isCap = key.startsWith('cap:');
    const res = key.slice(isCap ? 4 : 5);
    const deps = new Set<number>();
    for (let i = 0; i < buildings.length; i++) {
      const touches =
        (buildings[i]!.produces[res] ?? 0) > 0 || (buildings[i]!.consumes[res] ?? 0) > 0;
      if (!touches) continue;
      for (const k2 of keysByBuilding[i]!) {
        if (k2 === key) continue;
        deps.add(keyIndex.get(k2)!);
      }
    }
    edges[ki] = [...deps]; // ki depends on each of deps
  }

  // ---- Tarjan SCC over keys, then process in dependency order -----------
  const sccOf = new Array<number>(keys.length).fill(-1);
  const order: number[][] = []; // SCCs in reverse-topological completion order
  {
    let index = 0;
    const idx = new Array<number>(keys.length).fill(-1);
    const low = new Array<number>(keys.length).fill(0);
    const onStack = new Array<boolean>(keys.length).fill(false);
    const stack: number[] = [];
    const visit = (v: number): void => {
      idx[v] = low[v] = index++;
      stack.push(v);
      onStack[v] = true;
      for (const w of edges[v]!) {
        if (idx[w] === -1) {
          visit(w);
          low[v] = Math.min(low[v]!, low[w]!);
        } else if (onStack[w]) {
          low[v] = Math.min(low[v]!, idx[w]!);
        }
      }
      if (low[v] === idx[v]) {
        const comp: number[] = [];
        for (;;) {
          const w = stack.pop()!;
          onStack[w] = false;
          sccOf[w] = order.length;
          comp.push(w);
          if (w === v) break;
        }
        order.push(comp);
      }
    };
    for (let v = 0; v < keys.length; v++) if (idx[v] === -1) visit(v);
  }
  // Tarjan emits SCCs in reverse topological order of the condensation —
  // with edges meaning "depends on", dependencies complete FIRST, which is
  // exactly the processing order we need (no re-sort required).

  let converged = true;
  for (const comp of order) {
    if (comp.length === 1 && !edges[comp[0]!]!.includes(comp[0]!)) {
      // DAG node: a single exact update suffices (dependencies are final).
      const k = keys[comp[0]!]!;
      mul.set(k, update(k));
      continue;
    }
    // True cycle: Gauss-Seidel sweeps; damp after 100 to break oscillators.
    let sweeps = 0;
    for (;;) {
      let maxDelta = 0;
      for (const ki of comp) {
        const k = keys[ki]!;
        const prev = mul.get(k) ?? 1;
        let next = update(k);
        if (sweeps > 100) next = (next + prev) / 2; // damping
        mul.set(k, next);
        maxDelta = Math.max(maxDelta, Math.abs(next - prev));
      }
      sweeps++;
      if (maxDelta < FLOW_EPSILON) break;
      if (sweeps >= FLOW_MAX_SWEEPS) {
        converged = false;
        break;
      }
    }
  }

  const gates: number[] = [];
  for (let i = 0; i < n; i++) gates.push(gate(i));
  return { gates, converged };
}
```

- [ ] **Step 4: Run to verify pass**

Run: `npx vitest run src/flow-solver.test.ts`
Expected: PASS (all tests, including the 200-trial property test)

Note: if example 4a/4b or the chain test fails on ordering, the bug is
almost certainly in the DAG fast path — fall back to treating EVERY
component with the sweep loop (correct, marginally slower) and debug the
fast path from there. Do not weaken the assertions.

- [ ] **Step 5: Run the full suite (nothing else should be affected yet)**

Run: `npm test`
Expected: PASS — solver is not wired in yet.

- [ ] **Step 6: Commit**

```bash
git add src/flow-solver.ts src/flow-solver.test.ts
git commit -m "feat(flow-solver): exact net-flow solve — SCC/topo, complementarity, property-tested"
```

---

> **Task 3 shipped with two sanctioned corrections to the prescribed code**
> (commit c117a19, both spec-review-verified; design doc § flow-solver
> contract updated): (1) self-loop buildings enter a resource's equation
> with NET coefficient (p−c / c−p), self-draw not added to target;
> (2) multipliers start pessimistic (0) inside true-cycle SCCs — only DAG
> nodes start at 1. The plan's Task 3 code blocks above are otherwise
> as-shipped; read `src/flow-solver.ts` as the source of truth.

### Task 4: wire the solver into `computeRates`

**Files:**
- Modify: `src/flow-solver.ts` + `src/flow-solver.test.ts` (Step 0 cleanup only)
- Modify: `src/economy.ts` (passes 1–4, `BuildingRate`)
- Test: `src/economy.test.ts` (existing suite is the harness for this task; new behavioral tests land in Task 5)

- [ ] **Step 0: flow-solver cleanup (deferred from the Task 3 quality review)**

Three small items, in one commit (`refactor(flow-solver): drop dead sccOf, simplify singleton check, exercise damping guard`):
1. Delete the write-only `sccOf` array (declaration + the `sccOf[w] = order.length` write) — nothing reads it.
2. The edge builder skips `k2 === key`, so self-edges cannot exist; simplify the DAG-path condition to `comp.length === 1` with a one-line comment noting self-edges are impossible by construction.
3. Add one adversarial test that exercises the sweep loop beyond the trivial ≤3-sweep regime (e.g. a longer cycle chain of zero-constrained resources with partial external seeds) and asserts `converged === true` plus the constraint invariants — so the damping/guard region isn't entirely untested. Do NOT manufacture a `converged: false` case if one doesn't arise; assert what the solver actually guarantees.

- [ ] **Step 1: Read before editing**

Read `src/economy.ts` regions listed in the anchor table at the top of this
plan, plus the spec §"computeRates integration". Non-negotiable invariants:
the four-pass structure, Fix 3.7 (perBuildingMul consistency), and the
pass-3 probe behavior for `baseRate === 0` buildings.

- [ ] **Step 2: Add `utilization` to `BuildingRate`**

At the `BuildingRate` interface (`economy.ts:513`):

```ts
export interface BuildingRate {
  building: PlacedBuilding;
  recipe: Recipe;
  /** cycles/sec actually realized this segment. */
  effectiveRate: number;
  /** Duty-cycle fraction [0,1] — dynamic gates only (§4.7 net-flow):
   *  adjacency soft-gate × heat throttle × flow-solver gate × powerFactor
   *  (consumers). EXCLUDES maintenanceFactor (no degradation-slows-
   *  degradation feedback), time-acceleration, variance, and static yield
   *  multipliers. Drives operatingMs accrual. */
  utilization: number;
}
```

Then `grep -n "effectiveRate:" src/economy.ts` and add `utilization` to every
`byBuilding.push({...})` literal: `utilization: 0` for the `te.baseRate === 0`
branch; the computed value (Step 5) for the live branch. Run
`npx tsc -b --noEmit 2>&1 | head` afterward — the compiler errors are the
checklist of any literal you missed (tests constructing `BuildingRate` included).

- [ ] **Step 3: Remove the binary output-cap bails in pass 1**

Delete BOTH early-outs (the binary stall this whole plan removes):

Normal path (`economy.ts:1175-1179`):
```ts
// DELETE:
const oa = outputAvail(state, recipe, t, ctx?.caps, ctx?.baseMult);
if (oa === 0) {
  tentative.push({ building: b, recipe, baseRate: 0, buffStack, effectiveMul: gateResult.effectiveMul, perBuildingMul });
  continue;
}
```

Genesis path (`economy.ts:1077-1081`): delete the identical `oa === 0` block.

Keep every other bail (heat, tile, coastal, gates, tier) — those are not
storage-related. Keep the `outputAvail` FUNCTION — pass 3's probe path
(Step 6) still calls it.

- [ ] **Step 4: Insert pass 2.5 — the solver call (after the pass-2 loop, before pass 3, ~line 1250)**

```ts
// Pass 2.5 — exact net-flow solve (§15.3 net-flow rework, see
// docs/superpowers/specs/2026-06-10-net-flow-economy-design.md).
// Replaces the binary outputAvail stall: producers at a pinned bin rescale
// to exactly the consumers' draw (shared θ per resource, min rule per
// building); consumers at an empty bin rescale to supply (shared φ —
// supersedes per-consumer inputAvail for RUNNING buildings; inputAvailByIdx
// above remains solely the pass-3 power probe for baseRate-0 buildings).
// Coefficients mirror pass-4's realized flows at gate 1: baseRate ×
// perBuildingMul, inputs ÷ recipeInputDiv. Island-uniform factors (accel,
// variance) cancel in the ratios; powerFactor stays post-applied (pass 4)
// with the documented one-segment lag.
const flowBuildings: FlowBuildingSpec[] = tentative.map((te) => {
  if (te.baseRate <= 0) return { produces: {}, consumes: {} };
  const produces: Record<string, number> = {};
  const outs = resolveRotatingOutput(te.recipe, t);
  for (const [r, yld] of Object.entries(outs)) {
    const flow = (yld ?? 0) * te.baseRate * te.perBuildingMul;
    if (flow > 0) produces[r] = flow;
  }
  const consumes: Record<string, number> = {};
  for (const [r, need] of Object.entries(te.recipe.inputs)) {
    if (te.recipe.exogenousFlow === 'atmosphere' && r === 'air') continue;
    const flow = ((need ?? 0) / recipeInputDiv) * te.baseRate * te.perBuildingMul;
    if (flow > 0) consumes[r] = flow;
  }
  return { produces, consumes };
});
const capConstrained = new Set<string>();
const zeroConstrained = new Set<string>();
for (const fb of flowBuildings) {
  for (const r of [...Object.keys(fb.produces), ...Object.keys(fb.consumes)]) {
    const id = r as ResourceId;
    const stock = ctx?.inventory?.[id] ?? state.inventory[id] ?? 0;
    if (stock <= 0) zeroConstrained.add(r);
    if (stock >= cap(state, id, ctx?.caps, undefined, ctx?.baseMult)) capConstrained.add(r);
  }
}
// §5.2 furnace coal burn — cap-side demand (owner decision 2026-06-10, see
// design doc § flow-solver contract): each billing furnace appends a
// synthetic consumer entry so a coal producer at a pinned coal bin
// throttles to recipe-draw + burn. SKIPPED when coal is zero-constrained —
// the binary fuel-starvation recompute (Fix 4.1 below) owns that regime,
// and a synthetic entry would let the solver share fuel proportionally,
// contradicting §5.2's all-or-none heat gate. Hoist the existing
// `const COAL_CYCLE_SEC = 30;` declaration (currently just above the
// pass-4 burn fold, economy.ts:1497) up here so both sites share it —
// do NOT declare a second copy.
if (!zeroConstrained.has('coal')) {
  for (const [furnaceId, servedCount] of heat.coalConsumersByFurnace) {
    if (servedCount <= 0) continue;
    const furnace = validBuildings.find((b) => b.id === furnaceId);
    if (!furnace) continue;
    const coalPerCycle = defs[furnace.defId].heatSource?.coalPerCycle ?? 0;
    if (coalPerCycle <= 0) continue;
    flowBuildings.push({
      produces: {},
      consumes: { coal: (coalPerCycle * servedCount) / COAL_CYCLE_SEC },
    });
  }
}
const flowGates = solveFlow(flowBuildings, { capConstrained, zeroConstrained }).gates;
```

The synthetic entries sit at indices ≥ `tentative.length`; passes 3–4 index
`flowGates` only by tentative index, so they are never read back — they
exist purely to shape θ_coal. Note `capConstrained`/`zeroConstrained` are
scanned from the RECIPE entries before the synthetics are appended: if no
recipe touches coal, θ_coal has no producers to throttle and the synthetic
entries are inert, which is correct.

Import at the top of economy.ts:
```ts
import { solveFlow, type FlowBuildingSpec } from './flow-solver.js';
```

- [ ] **Step 5: Pass 4 — gate by `g`, compute utilization**

In the pass-4 loop (`economy.ts:1409-1428`), replace
```ts
const ia = inputAvailByIdx[i] ?? 0;
```
with
```ts
const g = flowGates[i] ?? 0;
```
and use `g` where `ia` was used in the `effectiveRate` formula:
```ts
const effectiveRate = te.baseRate * g * pf * accelMul * varianceFactor * te.perBuildingMul;
const utilization = Math.min(1, Math.max(0, te.effectiveMul * g * pf));
byBuilding.push({ building: te.building, recipe: te.recipe, effectiveRate, utilization });
```
(`te.effectiveMul` already carries adjacency soft-gate × heat throttle per
`economy.ts:1202`, which is exactly the spec's duty-gate set.)

- [ ] **Step 6: Pass 3 — running buildings use `g`; baseRate-0 buildings keep the probe**

Replace the block at `economy.ts:1322-1328`:
```ts
const idx = tentative.findIndex((tt) => tt.building === b);
const te = idx >= 0 ? tentative[idx] : undefined;
if (te && te.baseRate > 0) {
  const g = flowGates[idx] ?? 0;
  active = g > 0;
  nominalThroughputFrac = gateResult.effectiveMul * g;
} else {
  // Probe path — buildings stalled for non-storage reasons (tile gate,
  // tier gate, …) keep today's draw shape: inputAvail × outputAvail.
  const ia = idx >= 0 ? (inputAvailByIdx[idx] ?? 0) : 0;
  active = ia > 0;
  const oa = outputAvail(state, recipe, t, ctx?.caps, ctx?.baseMult);
  nominalThroughputFrac = gateResult.effectiveMul * ia * oa;
}
```
(`nominalThroughputFrac *= heatFactorPass3;` on the next line stays.)

- [ ] **Step 7: Compile + run the suite, triage intentional flips**

Run: `npx tsc -b --noEmit` → expected clean.
Run: `npm test`

Expected: flow-solver and most suites PASS. Some `economy.test.ts` tests
asserting the binary stall WILL fail — that is the intended behavior change.
For each failure, check it against the spec's locked rules before touching
it: a test that says "producer at cap produces 0 with no consumers" should
still pass (θ=0); a test that says "producer at cap stalls even though a
consumer is draining" flips to the throttled expectation (document the new
expected number in the assertion). `mass-balance.test.ts` and
`persistence*.test.ts` must pass UNMODIFIED — if either fails, the wiring
is wrong; stop and fix the code, not the test.

- [ ] **Step 8: Commit**

```bash
git add src/economy.ts src/economy.test.ts
git commit -m "feat(economy): net-flow solver replaces binary output stall (passes 2.5-4)"
```

---

### Task 5: behavioral tests — steady state at cap, XP, event count

**Files:**
- Modify: `src/economy.test.ts`

- [ ] **Step 1: Study the existing fixtures**

Read the top 100 lines of `src/economy.test.ts` plus the test named
`"Mine fills iron_ore to exactly cap"` and any helper in
`src/test-helpers/`. Reuse the established fixture pattern (island state
factory, building placement, clock mocking) — do NOT invent a parallel
fixture style. The code below names helpers generically; bind it to the
real helpers found in this step.

- [ ] **Step 2: Write the failing tests**

```ts
// append to src/economy.test.ts — adapt fixture calls to the real helpers.
describe('net-flow at storage cap (§15.3 rework)', () => {
  it('producer at a full bin throttles to consumer draw — no oscillation', () => {
    // Arrange: island with one Mine (iron_ore producer) and one consumer of
    // iron_ore whose recipe draws less than the Mine's full rate; set
    // state.inventory.iron_ore = cap(state, 'iron_ore') exactly.
    // Act: advance in many small segments (e.g. 60 × 1s).
    // Assert after EVERY segment:
    //   - inventory.iron_ore stays exactly pinned at cap (within 1e-9)
    //   - the Mine's BuildingRate.utilization equals consumerDraw/mineRate
    //     (constant across segments — no flicker)
    //   - the consumer's effectiveRate stays at its full rate (constant)
  });

  it('producer at a full bin with NO consumer idles at utilization 0', () => {
    // Same arrangement minus the consumer. After any advance:
    //   - utilization === 0, effectiveRate === 0, inventory pinned at cap.
  });

  it('XP accrues at the throttled rate, not the nominal rate', () => {
    // With the throttled steady state above, advance exactly N seconds and
    // assert state.xp increase equals throttledRate × xp_weight × N
    // (use XP_WEIGHT from recipes.ts; compare to a parallel island where
    // the bin is empty to confirm the ratio is consumerDraw/mineRate).
  });

  it('long advance over a pinned bin takes O(1) segments, not O(cap-hits)', () => {
    // The §15.3 loop is bounded by the `safety` counter in advanceIsland.
    // Steady state at cap must not emit per-segment cap events: a 1-hour
    // advance on the pinned-bin island must complete with safety counter
    // headroom (e.g. expose/observe via a spy on computeRates call count —
    // expect < 20 calls, vs hundreds under the old binary regime).
  });

  it('coal mine at a pinned coal bin throttles to recipe-draw + furnace burn', () => {
    // Arrange: coal at cap; one coal producer; one billing coal furnace
    // (heat.coalConsumersByFurnace non-empty — place a requiresHeat
    // consumer adjacent per the existing heat-test fixtures); optionally a
    // recipe consumer of coal. Assert across many segments: net coal flow
    // exactly 0 (bin pinned), producer utilization equals
    // (recipeDraw + coalPerCycle×servedCount/30) / fullRate, constant — no
    // oscillation. (Owner decision 2026-06-10: burn is cap-side demand.)
  });

  it('offline catchup ≡ incremental ticks (existing invariant, net-flow regime)', () => {
    // Two identical islands at a pinned bin with a consumer: advance one in
    // a single 24h call, the other in 24×3600 one-second calls. Final
    // inventories and xp agree within 1e-6 per resource.
  });
});
```

These comments are the specification of each test; write the real bodies
against the actual fixture helpers (Step 1). Every assertion listed must
appear in code — none are optional.

- [ ] **Step 3: Run to verify the new tests fail / pass for the right reason**

Run: `npx vitest run src/economy.test.ts -t "net-flow"`
Expected: with Task 4 merged these should mostly PASS already — any FAIL
here is a real wiring bug (most likely: regime detection reading the wrong
inventory override, or `findNextCapEvent` still emitting cap events because
net is not exactly 0 at the pinned bin; check `applyRates` clamping and
solver epsilon). Fix the code until green; do not loosen assertions beyond
the stated tolerances.

- [ ] **Step 4: Full suite**

Run: `npm test`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/economy.test.ts
git commit -m "test(economy): net-flow steady-state, XP throttle, segment-count, offline-equivalence"
```

---

> **Folded in from the Task 4 quality review:** while touching this region,
> build one `Map<string, PlacedBuilding>` (id → building) after pass 1 in
> `computeRates` and route through it (a) pass-3's O(V²)
> `tentative.findIndex` per building — note `tentative` is NOT
> index-aligned with `validBuildings` (recipe-less buildings skip the
> push), so map `building → tentative index` explicitly; and (b) all three
> `validBuildings.find((b) => b.id === furnaceId)` scans (pass 2.5 furnace
> entries + the two pass-4 burn folds). Behavior-neutral refactor, own
> commit, suite must stay green.

### Task 6: utilization-scaled maintenance wear

**Files:**
- Modify: `src/economy.ts` (`advanceIsland` wear loop ~2150-2173, `findNextCapEvent` ~1626-1644, its call site)
- Modify: `src/maintenance.ts` (doc comments only)
- Test: `src/economy.test.ts`, `src/maintenance.test.ts`

- [ ] **Step 1: Write the failing tests**

```ts
// append to src/economy.test.ts — adapt fixtures per Task 5 Step 1.
describe('utilization-scaled maintenance wear (§4.7 net-flow)', () => {
  it('building at utilization 0.5 accrues operatingMs at half speed', () => {
    // Arrange a steady half-throttled building (full bin + consumer at half
    // the producer rate). Advance 2h of wall time; assert
    // building.operatingMs increased by ~1h (±1s tolerance for segment
    // boundaries).
  });

  it('fully idle building (cap, no consumer) accrues zero wear', () => {
    // Advance 2h; operatingMs unchanged.
  });

  it('maintenance boundary event lands at the utilization-stretched time', () => {
    // Building with operatingMs just below threshold at utilization 0.5:
    // the degradation onset (maintenanceFactor < 1) occurs at 2× the
    // remaining wall-clock time, and offline catchup splits the segment at
    // that boundary (assert factor exactly 1.0 just before, < 1.0 just
    // after — mirrors the existing maintenance boundary tests).
  });

  it('degraded building wears at duty-cycle speed, not × maintenanceFactor', () => {
    // Building past threshold (maintenanceFactor 0.75) but unthrottled
    // (g=1, pf=1): operatingMs accrues at FULL wall speed — utilization
    // excludes the maintenance factor itself.
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `npx vitest run src/economy.test.ts -t "utilization-scaled"`
Expected: FAIL — wear still accrues wall-clock dtMs.

- [ ] **Step 3: Implement — wear loop**

In `advanceIsland`, just before the per-building wear loop (~2096), build
the lookup once per segment (`byBuilding` is already in scope from the
segment's `computeRates` destructuring):

```ts
const utilById = new Map<string, number>();
for (const br of byBuilding) utilById.set(br.building.id, br.utilization);
```

Replace `accrueOperatingTime(b, dtMs);` (`economy.ts:2172`) with:

```ts
// §4.7 net-flow: wear accrues in utilization-scaled operating time —
// duty cycle, not wall clock. A building idling against a full bin (u=0)
// no longer wears; this deliberately inverts the old "can't escape
// maintenance pressure by capping output" stance (owner decision, see
// docs/superpowers/specs/2026-06-10-net-flow-economy-design.md).
accrueOperatingTime(b, dtMs * (utilById.get(b.id) ?? 0));
```

- [ ] **Step 4: Implement — boundary event stretch**

`findNextCapEvent` (`economy.ts:1583`): add a parameter
`utilById?: ReadonlyMap<string, number>` (after `ctx`), and in the
maintenance-boundary loop (~1636-1644) replace

```ts
const eventMs = tMs + (boundary - operating);
```
with
```ts
const u = utilById?.get(b.id) ?? 1;
if (u <= 0) continue; // not wearing — no future boundary this segment
const eventMs = tMs + (boundary - operating) / u;
```

Update the call site in `advanceIsland` to pass the same `utilById` map.
`grep -n "findNextCapEvent(" src/` for any other callers (tests) — the new
parameter is optional, so they compile unchanged; default 1 preserves old
behavior for direct unit tests of the function.

- [ ] **Step 5: maintenance.ts comment updates**

Update the `accrueOperatingTime` doc comment (`maintenance.ts:205-214`):
the caller now scales `dtMs` by utilization; "operating time" means
duty-cycled operating time. Also update the stale pass-3 comment block in
economy.ts (~1270-1274) that says "Maintenance bills … intentionally NOT
scaled by throughput — a stalled building still wears down at full rate" —
it now reads the opposite; reference the design doc.

- [ ] **Step 6: Run the new tests, then the full suite**

Run: `npx vitest run src/economy.test.ts -t "utilization-scaled"` → PASS
Run: `npm test` → PASS (audit any maintenance.test.ts failures: tests
calling `accrueOperatingTime` directly are unaffected — the scaling lives
at the call site; tests advancing whole islands may need utilization-aware
expected values, each flip justified against the spec).

- [ ] **Step 7: Commit**

```bash
git add src/economy.ts src/maintenance.ts src/economy.test.ts src/maintenance.test.ts
git commit -m "feat(maintenance): wear accrues in utilization-scaled operating time"
```

---

### Task 7: SPEC.md + AGENTS.md alignment, build, visual smoke test

**Files:**
- Modify: `SPEC.md` (§15.3, §4.7, §5.1)
- Modify: `AGENTS.md` (economy section)

- [ ] **Step 1: SPEC.md §15.3** — locate the outputAvail wording (grep
`binary` near §15.3). Replace the binary clause with: outputAvail is a
continuous demand-coupled throttle — at-cap producers rescale to consumer
draw (shared θ per resource, exact active-set solve, min rule per
building); piecewise-constant rates between events are preserved; pinned
bins emit no cap events. Reference `src/flow-solver.ts` and the design doc
path as implementation notes (matching how §2.1 references `ocean-gen.ts`).

- [ ] **Step 2: SPEC.md §4.7** — wear accrues in utilization-scaled
operating time (duty cycle); thresholds, ramp, recipes unchanged; note the
inversion of the old stalled-buildings-still-wear rationale.

- [ ] **Step 3: SPEC.md §5.1** — the throughput-scaled draw factor is the
solver gate `g` (formerly `inputAvail × outputAvail`); extremes identical.

- [ ] **Step 4: AGENTS.md** — update the "Economy: event-driven piecewise
integration" section: `computeRates` is four passes plus a pass-2.5 exact
flow solve (`flow-solver.ts`); the "Don't simplify pass 2" warning becomes
"Don't replace the flow solver with binary stock checks"; mention
utilization-driven wear. Keep it as terse as the existing section.

- [ ] **Step 5: Full verification**

Run: `npm test` → PASS (full suite)
Run: `npm run build` → clean (`tsc -b` strict)

- [ ] **Step 6: Visual smoke test (per AGENTS.md dev-server rules)**

After `npm run build`: reload the browser tab (Daedalus `mcp__daedalus__reload`
against the active tab), engineer a capped chain (or load a save with one),
open the inspector on the producer, and `mcp__daedalus__screenshot` twice a
few seconds apart: the displayed rate must be steady (no +0/+0.01
alternation between the two shots).

- [ ] **Step 7: Commit**

```bash
git add SPEC.md AGENTS.md
git commit -m "docs(spec): net-flow §15.3/§4.7/§5.1 supersession + AGENTS.md economy section"
```

---

## Self-review notes (already applied)

- Spec coverage: solver contract → Tasks 1–3; computeRates integration →
  Task 4; wear/XP/events → Tasks 5–6 (XP is assertion-only — no code change
  needed, verified by the Task 5 XP test); SPEC/AGENTS updates → Task 7;
  no-schema-bump → no task (nothing to do), persistence tests guarded in
  Task 4 Step 7.
- The naive-ratio pitfall (design risk #1) is pinned by a dedicated
  regression test in Task 2 and by the property test's constraint checks.
- Type consistency: `FlowBuildingSpec`/`solveFlow`/`solveSharedFactor`/
  `FlowSolution.gates`/`BuildingRate.utilization` are used with identical
  signatures across Tasks 1–6.
