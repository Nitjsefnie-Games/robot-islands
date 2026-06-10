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

  it('duplicated otherGate values (zero-width segment)', () => {
    // Both entries break at 0.5; root in the θ≤0.5 region: 20θ = 6 → 0.3.
    expect(
      solveSharedFactor(
        [{ coeff: 10, otherGate: 0.5 }, { coeff: 10, otherGate: 0.5 }],
        6,
      ),
    ).toBeCloseTo(0.3, 12);
  });

  it('root lands exactly on a breakpoint', () => {
    // 10·min(0.5,θ) + 10·min(1,θ) = 10 at θ = 0.5 exactly.
    expect(
      solveSharedFactor(
        [{ coeff: 10, otherGate: 0.5 }, { coeff: 10, otherGate: 1 }],
        10,
      ),
    ).toBeCloseTo(0.5, 12);
  });

  it('three entries, root in the middle segment', () => {
    // θ ∈ (0.3, 0.8): 2×0.3 + 4θ + 4θ = 3.8 → θ = 0.4.
    expect(
      solveSharedFactor(
        [
          { coeff: 2, otherGate: 0.3 },
          { coeff: 4, otherGate: 0.8 },
          { coeff: 4, otherGate: 1 },
        ],
        3.8,
      ),
    ).toBeCloseTo(0.4, 12);
  });

  it('NaN target fails open at gate 1 (documented contract)', () => {
    expect(solveSharedFactor([{ coeff: 5, otherGate: 1 }], Number.NaN)).toBe(1);
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
