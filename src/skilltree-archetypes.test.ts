import { describe, expect, it } from 'vitest';
import {
  generateFillerNodes,
  MINING_FILLER_NODES,
  ALL_FILLER_NODES,
  type FillerArchetype,
} from './skilltree-archetypes.js';
import { FULL_CATALOG } from './skilltree-catalog.js';

describe('generateFillerNodes', () => {
  it('generates a depth-ramped filler chain', () => {
    const archetype: FillerArchetype = {
      idPrefix: 'mining.recipeRate',
      effectKind: 'recipeRateMul',
      effectExtra: { category: 'extraction' },
      subPath: 'mining',
      growth: 1.10,
      baseCost: 1,
      costGrowth: 1.4,
      count: 6,
    };
    const nodes = generateFillerNodes(archetype);
    expect(nodes).toHaveLength(6);
    expect(nodes[0]!.cost).toBe(1);
    expect(nodes[1]!.cost).toBe(Math.round(1 * 1.4));
  });

  it('produces monotonically increasing magnitudes in derived FULL_CATALOG', () => {
    const prefix = 'mining.recipeRate';
    const nodes = FULL_CATALOG.filter((n) => n.id.startsWith(prefix + '.'));
    expect(nodes.length).toBeGreaterThan(1);
    const sorted = nodes.sort((a, b) => {
      const da = Number(a.id.slice(a.id.lastIndexOf('.') + 1));
      const db = Number(b.id.slice(b.id.lastIndexOf('.') + 1));
      return da - db;
    });
    for (let i = 1; i < sorted.length; i++) {
      expect(sorted[i]!.magnitude).toBeGreaterThan(sorted[i - 1]!.magnitude);
    }
  });

  it('produces monotonically increasing costs', () => {
    const arch: FillerArchetype = {
      idPrefix: 'test.cost',
      effectKind: 'recipeRateMul',
      effectExtra: { category: 'extraction' },
      subPath: 'mining',
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
      growth: 1.10,
      baseCost: 1,
      costGrowth: 1.2,
      count: 1,
    };
    const nodes = generateFillerNodes(arch);
    expect(nodes[0]!.effect).toEqual({ kind: 'mineYieldBonusMul' });
  });

  it('respects startDepth — nodes start at the given depth and id suffix', () => {
    const arch: FillerArchetype = {
      idPrefix: 'test.magic',
      effectKind: 'mineYieldBonusMul',
      subPath: 'mining',
      growth: 1.10,
      baseCost: 5,
      costGrowth: 1.3,
      count: 4,
      startDepth: 3,
    };
    const nodes = generateFillerNodes(arch);
    expect(nodes).toHaveLength(4);
    expect(nodes.map((n) => n.depth)).toEqual([3, 4, 5, 6]);
    expect(nodes.map((n) => n.id)).toEqual([
      'test.magic.3',
      'test.magic.4',
      'test.magic.5',
      'test.magic.6',
    ]);
  });

  it('omitting startDepth yields depth 1..N and ids .1..<N> (regression guard)', () => {
    const arch: FillerArchetype = {
      idPrefix: 'test.default',
      effectKind: 'mineYieldBonusMul',
      subPath: 'mining',
      growth: 1.10,
      baseCost: 1,
      costGrowth: 1.2,
      count: 3,
    };
    const nodes = generateFillerNodes(arch);
    expect(nodes.map((n) => n.depth)).toEqual([1, 2, 3]);
    expect(nodes.map((n) => n.id)).toEqual([
      'test.default.1',
      'test.default.2',
      'test.default.3',
    ]);
  });
});

describe('MINING_FILLER_NODES', () => {
  // Mining fillers are 2 families: 8 recipeRate + 5 yieldBonus = 13.
  it('produces 13 nodes from 2 archetypes', () => {
    expect(MINING_FILLER_NODES).toHaveLength(13);
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

  it('no storageCategoryCapMul filler in mining (rehomed to storage)', () => {
    const capNodes = MINING_FILLER_NODES.filter(
      (n) => n.effect.kind === 'storageCategoryCapMul',
    );
    expect(capNodes).toHaveLength(0);
  });

  it('yieldBonus archetype contributes 5 mineYieldBonusMul nodes', () => {
    const yieldNodes = MINING_FILLER_NODES.filter(
      (n) => n.effect.kind === 'mineYieldBonusMul',
    );
    expect(yieldNodes).toHaveLength(5);
  });

  it('no mineRareTrickleMul filler in mining (demoted to notable)', () => {
    const trickleNodes = MINING_FILLER_NODES.filter(
      (n) => n.effect.kind === 'mineRareTrickleMul',
    );
    expect(trickleNodes).toHaveLength(0);
  });
});

describe('ALL_FILLER_NODES sanity', () => {
  it('has a node count in the expected range', () => {
    expect(ALL_FILLER_NODES.length).toBeGreaterThanOrEqual(240);
    expect(ALL_FILLER_NODES.length).toBeLessThanOrEqual(600);
  });

  it('all node ids are unique', () => {
    const ids = ALL_FILLER_NODES.map((n) => n.id);
    const unique = new Set(ids);
    expect(unique.size).toBe(ids.length);
  });

  it('covers all 20 sub-paths', () => {
    const subPaths = new Set(ALL_FILLER_NODES.map((n) => n.subPath));
    expect(subPaths.size).toBe(20); // 20 sub-paths with filler content
  });

  it('every multiplier-kind filler has a positive magnitude in derived FULL_CATALOG', () => {
    const multiplierKinds = new Set([
      'recipeRateMul', 'storageCategoryCapMul', 'powerProductionMul',
      'powerConsumptionMul', 'routeCapacityMul', 'commRangeMul', 'maintenanceThresholdMul',
      'scannerCoverageMul', 'debrisProtectionMul', 'droneFuelEfficiencyMul', 'airshipRangeMul',
      'padExplosionReduceMul', 'satBufferCapMul', 'scannerDwellRateMul', 'satFuelReserveMul',
      'repairDroneReliabilityMul', 'constructionTimeMul', 'droneScanRadiusMul', 'mineYieldBonusMul',
      'mineRareTrickleMul', 'loggerYieldBonusMul', 'loggerExoticTrickleMul', 'drillYieldBonusMul',
      'aquacultureYieldBonusMul', 'patronageYieldBonusMul', 't5ExtractorYieldBonusMul',
      'teleporterEfficiencyMul', 'batteryCapacityMul', 'xpGainMul',
    ]);
    const fillerIds = new Set(ALL_FILLER_NODES.map((n) => n.id));
    for (const n of FULL_CATALOG) {
      if (fillerIds.has(n.id) && multiplierKinds.has(n.effect.kind)) {
        expect(n.magnitude).toBeGreaterThan(0);
      }
    }
  });

  it('every node has a positive cost', () => {
    for (const n of ALL_FILLER_NODES) {
      expect(n.cost).toBeGreaterThan(0);
    }
  });
});
