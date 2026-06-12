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
    expect(r.powerFactor).toBeCloseTo(Math.min(1, 100 / (200 * r.powerFactor)), 4);
  });

  it('converges for a constant (pf-independent) deficit', () => {
    const r = solveBrownoutFactor(() => ({ producedW: 60, consumedW: 100 }));
    expect(r.converged).toBe(true);
    expect(r.powerFactor).toBeCloseTo(0.6, 6);
    expect(r.iterations).toBe(2); // one fast-path eval at pf=1 (deficit), then one loop eval that converges immediately
  });

  it('fails open (converged=false, clamped pf) on a pathological oscillator', () => {
    const r = solveBrownoutFactor(
      (pf) => ({ producedW: pf < 0.5 ? 1000 : 1, consumedW: 100 }),
      { maxIters: 8 },
    );
    expect(Number.isFinite(r.powerFactor)).toBe(true);
    expect(r.powerFactor).toBeGreaterThanOrEqual(0);
    expect(r.powerFactor).toBeLessThanOrEqual(1);
    expect(r.converged).toBe(false);
    expect(r.iterations).toBe(9); // maxIters 8 + the initial evalAtPf(1)
  });
});
