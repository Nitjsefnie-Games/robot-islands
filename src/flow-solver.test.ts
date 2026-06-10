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
