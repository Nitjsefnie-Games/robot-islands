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

/** A power balance sampled at a given brownout factor pf: the total watts
 *  produced and the total watts consumed by the pf-gated buildings. */
export interface PowerSample {
  /** Total power produced (W) at the sampled pf. */
  readonly producedW: number;
  /** Total power consumed (W) at the sampled pf. */
  readonly consumedW: number;
}

/** The result of the scalar brownout fixpoint solve. */
export interface BrownoutFixpointResult {
  /** The consistent §5.1 brownout factor pf* ∈ [0,1]. */
  readonly powerFactor: number;
  /** True if the iteration converged (or hit the no-brownout fast path);
   *  false only if the damped iteration ran out of iterations. */
  readonly converged: boolean;
  /** Number of `evalAtPf` evaluations performed. */
  readonly iterations: number;
}

/** pf from a power sample: the §5.1 brownout factor, clamped to [0,1]. */
function pfOf(s: PowerSample): number {
  if (!(s.consumedW > 0)) return 1; // no draw (or NaN guard) ⇒ no brownout
  return Math.min(1, s.producedW / s.consumedW);
}

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
