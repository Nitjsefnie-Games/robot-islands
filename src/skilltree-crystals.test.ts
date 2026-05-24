import { describe, expect, it } from 'vitest';
import { CRYSTAL_CATALOG } from './skilltree-crystals.js';
import { DEFAULT_GRAPH, effectiveGraph } from './skilltree.js';

describe('CRYSTAL_CATALOG', () => {
  it('has exactly 60 entries', () => {
    expect(CRYSTAL_CATALOG).toHaveLength(60);
  });

  it('each crystal is eligible only for its own sub-path', () => {
    for (const crystal of CRYSTAL_CATALOG) {
      const family = crystal.id.replace(/_crystal_t[123]$/, '');
      expect(crystal.eligibleSubPaths).toEqual([family]);
    }
  });

  it('spot-check mining T1 magnitudes', () => {
    const c = CRYSTAL_CATALOG.find((x) => x.id === 'mining_crystal_t1')!;
    const core = c.nodes.find((n) => n.idSuffix === 'core')!;
    expect(core.magnitude).toBeCloseTo(0.16, 3);
  });

  it('spot-check mining T3 magnitudes', () => {
    const c = CRYSTAL_CATALOG.find((x) => x.id === 'mining_crystal_t3')!;
    const core = c.nodes.find((n) => n.idSuffix === 'core')!;
    expect(core.magnitude).toBeCloseTo(0.16 * 2.25, 3);
  });

  it('spot-check forestry T2 magnitudes', () => {
    const c = CRYSTAL_CATALOG.find((x) => x.id === 'forestry_crystal_t2')!;
    const core = c.nodes.find((n) => n.idSuffix === 'core')!;
    expect(core.magnitude).toBeCloseTo(0.16 * 1.5, 3);
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
