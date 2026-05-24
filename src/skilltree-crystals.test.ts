import { describe, expect, it } from 'vitest';
import { CRYSTAL_CATALOG } from './skilltree-crystals.js';
import { DEFAULT_GRAPH, effectiveGraph } from './skilltree.js';

describe('CRYSTAL_CATALOG', () => {
  it('has exactly 3 entries', () => {
    expect(CRYSTAL_CATALOG).toHaveLength(3);
  });

  it('each is eligible for the mining sub-path', () => {
    for (const crystal of CRYSTAL_CATALOG) {
      expect(crystal.eligibleSubPaths).toContain('mining');
    }
  });

  it('each has the expected node count', () => {
    for (const crystal of CRYSTAL_CATALOG) {
      expect(crystal.nodes).toHaveLength(5);
    }
  });
});

describe('effectiveGraph', () => {
  it('returns DEFAULT_GRAPH unchanged when socketBindings is missing', () => {
    const state = { unlockedNodes: new Set(), unlockedEdges: new Set() } as unknown as Parameters<typeof effectiveGraph>[0];
    expect(effectiveGraph(state)).toBe(DEFAULT_GRAPH);
  });

  it('returns DEFAULT_GRAPH unchanged when socketBindings is empty', () => {
    const state = { socketBindings: new Map(), unlockedNodes: new Set(), unlockedEdges: new Set() } as unknown as Parameters<typeof effectiveGraph>[0];
    expect(effectiveGraph(state)).toBe(DEFAULT_GRAPH);
  });
});
