import { describe, expect, it } from 'vitest';
import { hasStructuralEffect } from './structural.js';
import type { IslandState } from './economy.js';
import type { Graph } from './skilltree-graph.js';

describe('hasStructuralEffect', () => {
  it('returns false when no matching node is owned', () => {
    const state = { unlockedNodes: new Set<string>() } as IslandState;
    expect(hasStructuralEffect('sharedPowerGrid', state)).toBe(false);
  });

  it('returns true when a matching structural node is owned', () => {
    const graph: Graph = {
      nodes: [
        {
          id: 's.1',
          subPath: 'mining',
          depth: 1,
          cost: 1,
          magnitude: 0.05,
          effect: { kind: 'structural', description: 'shared grid', data: { kind: 'sharedPowerGrid' } },
          description: 'shared grid',
        },
      ],
      edges: [],
      bridges: [],
      graftSockets: [],
    };
    const state = { unlockedNodes: new Set<string>(['s.1']) } as IslandState;
    expect(hasStructuralEffect('sharedPowerGrid', state, graph)).toBe(true);
    expect(hasStructuralEffect('parallelConstruction', state, graph)).toBe(false);
  });
});
