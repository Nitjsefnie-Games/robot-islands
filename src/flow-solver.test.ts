// src/flow-solver.test.ts
import { describe, expect, it } from 'vitest';
import { solveFlow, solveSharedFactor, type FlowBuildingSpec } from './flow-solver.js';

const B = (
  produces: Record<string, number>,
  consumes: Record<string, number> = {},
): FlowBuildingSpec => ({ produces, consumes });

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
    // target 8: in the θ≤0.5 region 20θ = 8 → θ = 0.4 (both contribute 4).
    expect(
      solveSharedFactor(
        [{ coeff: 10, otherGate: 0.5 }, { coeff: 10, otherGate: 1 }],
        8,
      ),
    ).toBeCloseTo(0.4, 12);
    // target 12: θ>0.5 region → 5 + 10θ = 12 → θ = 0.7.
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
