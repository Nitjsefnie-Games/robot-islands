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
