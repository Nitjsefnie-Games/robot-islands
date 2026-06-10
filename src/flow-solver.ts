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
  readonly gates: readonly number[];
  /** False only if the SCC iteration guard tripped (pathological cycle). */
  readonly converged: boolean;
}

export const FLOW_EPSILON = 1e-9;
export const FLOW_MAX_SWEEPS = 1000;

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
  // A NaN target is an upstream bug (coefficients are recipe constants ×
  // [0,1] gates, so it should be impossible) — fail open at gate 1 rather
  // than throwing mid-tick, but make the contract explicit here instead of
  // letting NaN fall through every range check to the defensive return.
  if (Number.isNaN(target)) return 1;
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
  return 1; // defensive backstop for float fuzz at segment edges
}

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
      // target = realized consumer draw of res from buildings that do NOT
      // produce r (their draw is not already accounted for on the left side).
      // entries = net producers of r: (production − self-consumption) scaled
      // by the building's gate.
      let target = 0;
      const entries: SharedFactorEntry[] = [];
      for (let i = 0; i < buildings.length; i++) {
        const p = buildings[i]!.produces[res] ?? 0;
        const c = buildings[i]!.consumes[res] ?? 0;
        if (p > 0) {
          const net = p - c;
          if (net > 0) {
            entries.push({ coeff: net, otherGate: gate(i, key) });
          }
        } else if (c > 0) {
          target += c * gate(i, key);
        }
      }
      return solveSharedFactor(entries, target);
    }
    // zero side: target = realized production of res from buildings that do
    // NOT consume r. entries = net consumers: (consumption − self-production).
    let target = 0;
    const entries: SharedFactorEntry[] = [];
    for (let i = 0; i < buildings.length; i++) {
      const p = buildings[i]!.produces[res] ?? 0;
      const c = buildings[i]!.consumes[res] ?? 0;
      if (c > 0) {
        const net = c - p;
        if (net > 0) {
          entries.push({ coeff: net, otherGate: gate(i, key) });
        }
      } else if (p > 0) {
        target += p * gate(i, key);
      }
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
    // True cycle: pessimistic start (mul = 0 within the component), then
    // Gauss-Seidel sweeps upward; damp after 100 to break oscillators.
    // Starting at 1 would accept causally ungrounded fixed points — an
    // A↔B flow loop at zero stocks self-certifies at g=(1,1) even though
    // nothing seeds it (mutual bootstrap deadlock). From 0, a cycle only
    // rises on real external supply; pure bootstrap loops stay at 0.
    for (const ki of comp) mul.set(keys[ki]!, 0);
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
