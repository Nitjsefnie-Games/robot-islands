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
