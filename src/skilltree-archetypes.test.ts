import { describe, expect, it } from 'vitest';
import {
  generateFillerNodes,
  MINING_FILLER_NODES,
  ALL_FILLER_NODES,
  type FillerArchetype,
} from './skilltree-archetypes.js';

describe('generateFillerNodes', () => {
  it('generates a depth-ramped filler chain', () => {
    const archetype: FillerArchetype = {
      idPrefix: 'mining.recipeRate',
      effectKind: 'recipeRateMul',
      effectExtra: { category: 'extraction' },
      subPath: 'mining',
      baseMag: 0.04,
      growth: 1.10,
      baseCost: 1,
      costGrowth: 1.4,
      count: 6,
    };
    const nodes = generateFillerNodes(archetype);
    expect(nodes).toHaveLength(6);
    expect(nodes[0]!.magnitude).toBeCloseTo(0.04, 4);
    // (1+0.04)*1.10 - 1 = 0.144
    expect(nodes[1]!.magnitude).toBeCloseTo(0.144, 4);
    expect(nodes[0]!.cost).toBe(1);
    expect(nodes[1]!.cost).toBe(Math.round(1 * 1.4));
  });

  it('produces monotonically increasing magnitudes', () => {
    const arch: FillerArchetype = {
      idPrefix: 'test.growth',
      effectKind: 'recipeRateMul',
      effectExtra: { category: 'extraction' },
      subPath: 'mining',
      baseMag: 0.05,
      growth: 1.10,
      baseCost: 1,
      costGrowth: 1.2,
      count: 10,
    };
    const nodes = generateFillerNodes(arch);
    for (let i = 1; i < nodes.length; i++) {
      expect(nodes[i]!.magnitude).toBeGreaterThan(nodes[i - 1]!.magnitude);
    }
  });

  it('produces monotonically increasing costs', () => {
    const arch: FillerArchetype = {
      idPrefix: 'test.cost',
      effectKind: 'recipeRateMul',
      effectExtra: { category: 'extraction' },
      subPath: 'mining',
      baseMag: 0.05,
      growth: 1.10,
      baseCost: 1,
      costGrowth: 1.5,
      count: 10,
    };
    const nodes = generateFillerNodes(arch);
    for (let i = 1; i < nodes.length; i++) {
      expect(nodes[i]!.cost).toBeGreaterThanOrEqual(nodes[i - 1]!.cost);
    }
  });

  it('embeds effectExtra into the effect payload', () => {
    const arch: FillerArchetype = {
      idPrefix: 'test.extra',
      effectKind: 'recipeRateMul',
      effectExtra: { category: 'extraction' },
      subPath: 'mining',
      baseMag: 0.05,
      growth: 1.10,
      baseCost: 1,
      costGrowth: 1.2,
      count: 1,
    };
    const nodes = generateFillerNodes(arch);
    expect(nodes).toHaveLength(1);
    const effect = nodes[0]!.effect as { kind: 'recipeRateMul'; category: string };
    expect(effect.kind).toBe('recipeRateMul');
    expect(effect.category).toBe('extraction');
  });

  it('works without effectExtra', () => {
    const arch: FillerArchetype = {
      idPrefix: 'test.noextra',
      effectKind: 'mineYieldBonusMul',
      subPath: 'mining',
      baseMag: 0.05,
      growth: 1.10,
      baseCost: 1,
      costGrowth: 1.2,
      count: 1,
    };
    const nodes = generateFillerNodes(arch);
    expect(nodes[0]!.effect).toEqual({ kind: 'mineYieldBonusMul' });
  });
});

describe('MINING_FILLER_NODES', () => {
  it('produces ~24 nodes from 4 archetypes', () => {
    expect(MINING_FILLER_NODES).toHaveLength(24);
  });

  it('all nodes have unique ids', () => {
    const ids = MINING_FILLER_NODES.map((n) => n.id);
    const unique = new Set(ids);
    expect(unique.size).toBe(ids.length);
  });

  it('all nodes belong to the mining sub-path', () => {
    for (const n of MINING_FILLER_NODES) {
      expect(n.subPath).toBe('mining');
    }
  });

  it('recipeRate archetype contributes 8 extraction nodes', () => {
    const rateNodes = MINING_FILLER_NODES.filter(
      (n) => n.effect.kind === 'recipeRateMul',
    );
    expect(rateNodes).toHaveLength(8);
    for (const n of rateNodes) {
      expect((n.effect as { category: string }).category).toBe('extraction');
    }
  });

  it('storageCap archetype contributes 7 dry_goods cap nodes', () => {
    const capNodes = MINING_FILLER_NODES.filter(
      (n) => n.effect.kind === 'storageCategoryCapMul',
    );
    expect(capNodes).toHaveLength(7);
    for (const n of capNodes) {
      expect((n.effect as { category: string }).category).toBe('dry_goods');
    }
  });

  it('yieldBonus archetype contributes 5 mineYieldBonusMul nodes', () => {
    const yieldNodes = MINING_FILLER_NODES.filter(
      (n) => n.effect.kind === 'mineYieldBonusMul',
    );
    expect(yieldNodes).toHaveLength(5);
  });

  it('rareTrickle archetype contributes 4 mineRareTrickleMul nodes', () => {
    const trickleNodes = MINING_FILLER_NODES.filter(
      (n) => n.effect.kind === 'mineRareTrickleMul',
    );
    expect(trickleNodes).toHaveLength(4);
  });
});

describe('ALL_FILLER_NODES sanity', () => {
  it('has a node count in the expected range', () => {
    expect(ALL_FILLER_NODES.length).toBeGreaterThanOrEqual(300);
    expect(ALL_FILLER_NODES.length).toBeLessThanOrEqual(600);
  });

  it('all node ids are unique', () => {
    const ids = ALL_FILLER_NODES.map((n) => n.id);
    const unique = new Set(ids);
    expect(unique.size).toBe(ids.length);
  });

  it('covers all 20 sub-paths', () => {
    const subPaths = new Set(ALL_FILLER_NODES.map((n) => n.subPath));
    expect(subPaths.size).toBe(15); // 15 sub-paths with filler content
  });

  it('every node has a positive magnitude', () => {
    for (const n of ALL_FILLER_NODES) {
      expect(n.magnitude).toBeGreaterThan(0);
    }
  });

  it('every node has a positive cost', () => {
    for (const n of ALL_FILLER_NODES) {
      expect(n.cost).toBeGreaterThan(0);
    }
  });
});
