// Pure-logic tests for the skill tree (§9.3) — tier mapping, depth gating,
// spend validation (already-owned / insufficient points / tier-locked /
// depth-prereq / branch-locked), spend mutation, and effect aggregation.

import { describe, expect, it } from 'vitest';

import type { IslandState } from './economy.js';
import { ALL_RESOURCES, type ResourceId } from './recipes.js';
import {
  canSpend,
  costForDepth,
  effectiveSkillMultipliers,
  launchSuccessBonus,
  magnitudeForDepth,
  nodeRequiredTier,
  spendPoint,
  t5Unlocked,
  t6Unlocked,
  tierForLevel,
  tierRequiredForDepth,
  type SkillNode,
} from './skilltree.js';

function blankInventory(): Record<ResourceId, number> {
  const inv = {} as Record<ResourceId, number>;
  for (const r of ALL_RESOURCES) inv[r] = 0;
  return inv;
}

function blankCaps(value: number): Record<ResourceId, number> {
  const caps = {} as Record<ResourceId, number>;
  for (const r of ALL_RESOURCES) caps[r] = value;
  return caps;
}

function blankFunnel(): Record<ResourceId, number> {
  const f = {} as Record<ResourceId, number>;
  for (const r of ALL_RESOURCES) f[r] = 0;
  return f;
}

function makeState(over: Partial<IslandState> = {}): IslandState {
  return {
    id: 'test',
    buildings: [],
    inventory: blankInventory(),
    storageCaps: blankCaps(100),
    xp: 0,
    level: 1,
    unspentSkillPoints: 0,
    unlockedNodes: new Set(),
    subPathProgress: new Map(),
    funnelPending: blankFunnel(),
    specializationRole: null,
    declaredAt: null,
    aiCoreCrafted: false,
    ascendantCoreCrafted: false,
    lastResetAt: null,
    timeLockBankedMin: 0,
    accelerationQueue: [],
    accelerationRemainingMin: 0,
    bankingEnabled: false,
    genesisTarget: null,
    singularityStoredWs: 0,
    starterInventoryGrace: {} as Record<ResourceId, number>,
    lastTick: 0,
    ...over,
  };
}

describe('tierForLevel (§9.2)', () => {
  it('returns 1 for pre-T2 levels', () => {
    expect(tierForLevel(1)).toBe(1);
    expect(tierForLevel(4)).toBe(1);
  });
  it('returns 2 at the T2 breakpoint and above', () => {
    expect(tierForLevel(5)).toBe(2);
    expect(tierForLevel(14)).toBe(2);
  });
  it('returns 3 at the T3 breakpoint and above', () => {
    expect(tierForLevel(15)).toBe(3);
    expect(tierForLevel(29)).toBe(3);
  });
  it('returns 4 at the T4 breakpoint and above', () => {
    expect(tierForLevel(30)).toBe(4);
    expect(tierForLevel(49)).toBe(4);
  });
  it('returns 5 at the T5 breakpoint and above (tier identification only; access gate via t5Unlocked)', () => {
    // tierForLevel is the band identification — level 50+ IS in the T5 band.
    // Whether T5 features (catalog rows, recipes, sub-paths) are accessible
    // is a separate composability against `aiCoreCrafted` via `t5Unlocked`.
    expect(tierForLevel(50)).toBe(5);
    expect(tierForLevel(75)).toBe(5);
  });
});

describe('t5Unlocked (§13.1 T5 access gate)', () => {
  it('locked at level 49 + aiCoreCrafted=true (level requirement)', () => {
    expect(t5Unlocked({ level: 49, aiCoreCrafted: true })).toBe(false);
  });
  it('locked at level 50 + aiCoreCrafted=false (AI-core requirement)', () => {
    expect(t5Unlocked({ level: 50, aiCoreCrafted: false })).toBe(false);
  });
  it('unlocked at level 50 + aiCoreCrafted=true', () => {
    expect(t5Unlocked({ level: 50, aiCoreCrafted: true })).toBe(true);
  });
  it('still unlocked well above level 50 with AI core', () => {
    expect(t5Unlocked({ level: 99, aiCoreCrafted: true })).toBe(true);
  });
  it('locked at level 1 without AI core (sanity)', () => {
    expect(t5Unlocked({ level: 1, aiCoreCrafted: false })).toBe(false);
  });
});

describe('t6Unlocked (§14.1 T6 access gate)', () => {
  const specWithSpaceport = { buildings: [{ defId: 'spaceport' }] };
  const specWithoutSpaceport = { buildings: [{ defId: 'mine' }] };
  const emptySpec = { buildings: [] };

  it('locked when ascendantCoreCrafted=false regardless of Spaceport', () => {
    expect(t6Unlocked({ ascendantCoreCrafted: false }, specWithSpaceport)).toBe(false);
    expect(t6Unlocked({ ascendantCoreCrafted: false }, specWithoutSpaceport)).toBe(false);
    expect(t6Unlocked({ ascendantCoreCrafted: false }, emptySpec)).toBe(false);
  });
  it('locked when ascendantCoreCrafted=true but no Spaceport placed', () => {
    expect(t6Unlocked({ ascendantCoreCrafted: true }, specWithoutSpaceport)).toBe(false);
    expect(t6Unlocked({ ascendantCoreCrafted: true }, emptySpec)).toBe(false);
  });
  it('unlocked when ascendantCoreCrafted=true AND Spaceport placed', () => {
    expect(t6Unlocked({ ascendantCoreCrafted: true }, specWithSpaceport)).toBe(true);
  });
  it('unlocked when Spaceport is one of several placed buildings', () => {
    const spec = { buildings: [{ defId: 'mine' }, { defId: 'spaceport' }, { defId: 'workshop' }] };
    expect(t6Unlocked({ ascendantCoreCrafted: true }, spec)).toBe(true);
  });
});

describe('nodeRequiredTier', () => {
  function mockNode(depth: number): SkillNode {
    return {
      id: `mock.${depth}`,
      subPath: 'mining',
      depth,
      cost: 1,
      magnitude: 0,
      effect: { kind: 'placeholder' },
      description: 'mock',
    };
  }
  it('maps depth 1-2 to T2', () => {
    expect(nodeRequiredTier(mockNode(1))).toBe(2);
    expect(nodeRequiredTier(mockNode(2))).toBe(2);
  });
  it('maps depth 3 to T3', () => {
    expect(nodeRequiredTier(mockNode(3))).toBe(3);
  });
  it('maps depth 4 to T4', () => {
    expect(nodeRequiredTier(mockNode(4))).toBe(4);
  });
  it('maps depth 5-7 to T5', () => {
    expect(nodeRequiredTier(mockNode(5))).toBe(5);
    expect(nodeRequiredTier(mockNode(6))).toBe(5);
    expect(nodeRequiredTier(mockNode(7))).toBe(5);
  });
  it('maps depth 8+ to T6', () => {
    expect(nodeRequiredTier(mockNode(8))).toBe(6);
    expect(nodeRequiredTier(mockNode(20))).toBe(6);
  });
});

describe('canSpend', () => {
  it('allows a T2 island with a point to buy mining.1', () => {
    const s = makeState({ level: 5, unspentSkillPoints: 1 });
    expect(canSpend(s, 'mining.1')).toEqual({ ok: true });
  });

  it('rejects when the player has no skill points', () => {
    const s = makeState({ level: 5, unspentSkillPoints: 0 });
    expect(canSpend(s, 'mining.1')).toEqual({
      ok: false,
      reason: 'insufficient-points',
    });
  });

  it('rejects depth-1 nodes at T1 (level 1)', () => {
    const s = makeState({ level: 1, unspentSkillPoints: 1 });
    expect(canSpend(s, 'mining.1')).toEqual({
      ok: false,
      reason: 'tier-locked',
    });
  });

  it('rejects re-purchasing an already-owned node', () => {
    const s = makeState({
      level: 5,
      unspentSkillPoints: 5,
      unlockedNodes: new Set(['mining.1']),
      subPathProgress: new Map([['mining', { spent: 1, complete: false }]]),
    });
    expect(canSpend(s, 'mining.1')).toEqual({
      ok: false,
      reason: 'already-unlocked',
    });
  });

  it('rejects depth-2 without depth-1 owned in the same sub-path', () => {
    const s = makeState({ level: 5, unspentSkillPoints: 5 });
    expect(canSpend(s, 'mining.2')).toEqual({
      ok: false,
      reason: 'depth-prereq',
    });
  });

  it('allows depth-2 once depth-1 is owned', () => {
    const s = makeState({
      level: 5,
      unspentSkillPoints: 5,
      unlockedNodes: new Set(['mining.1']),
      subPathProgress: new Map([['mining', { spent: 1, complete: false }]]),
    });
    expect(canSpend(s, 'mining.2')).toEqual({ ok: true });
  });

  it('allows parallel work in different branches (mining + smelting)', () => {
    // Even with mining COMMITTED + INCOMPLETE in the extraction branch,
    // smelting (refinement branch) is unaffected.
    const s = makeState({
      level: 5,
      unspentSkillPoints: 5,
      unlockedNodes: new Set(['mining.1']),
      // Spent over the commit threshold to simulate "committed but incomplete"
      // in mining; uses a synthetic spent count for the cross-branch test.
      subPathProgress: new Map([['mining', { spent: 3, complete: false }]]),
    });
    expect(canSpend(s, 'smelting.1')).toEqual({ ok: true });
  });
});

describe('canSpend — branch lock (synthetic catalog)', () => {
  // Step-5 catalog has only depth 1+2 per sub-path, so committing at the
  // 3-point threshold simultaneously completes the sub-path. To exercise
  // the "committed but incomplete" branch lock, we inject a 3-node sub-path
  // catalog with cost 1 each. Spending 3 points across all three nodes
  // commits the sub-path; spending only 1 leaves it committed-incomplete.

  const SYNTH_CATALOG: ReadonlyArray<SkillNode> = [
    {
      id: 'mining.1', subPath: 'mining', depth: 1, cost: 1, magnitude: 0.05,
      effect: { kind: 'placeholder' }, description: 's1',
    },
    {
      id: 'mining.2', subPath: 'mining', depth: 2, cost: 1, magnitude: 0.05,
      effect: { kind: 'placeholder' }, description: 's2',
    },
    {
      id: 'mining.3', subPath: 'mining', depth: 3, cost: 1, magnitude: 0.05,
      effect: { kind: 'placeholder' }, description: 's3',
    },
    {
      id: 'forestry.1', subPath: 'forestry', depth: 1, cost: 1, magnitude: 0.05,
      effect: { kind: 'placeholder' }, description: 'sf',
    },
    {
      id: 'smelting.1', subPath: 'smelting', depth: 1, cost: 1, magnitude: 0.05,
      effect: { kind: 'placeholder' }, description: 'ssm',
    },
  ];

  it('does not lock siblings before the commit threshold is reached', () => {
    // 2 points spent on mining (depth 1 + 2) is below the threshold of 3.
    // Forestry must still be reachable while mining is sub-threshold.
    const s = makeState({ level: 30, unspentSkillPoints: 10 });
    spendPoint(s, 'mining.1', SYNTH_CATALOG);
    spendPoint(s, 'mining.2', SYNTH_CATALOG);
    expect(canSpend(s, 'forestry.1', SYNTH_CATALOG)).toEqual({ ok: true });
  });

  it('locks sibling sub-paths when committed-incomplete (4-node mining)', () => {
    const SYNTH4: ReadonlyArray<SkillNode> = [
      {
        id: 'mining.1', subPath: 'mining', depth: 1, cost: 1, magnitude: 0.05,
        effect: { kind: 'placeholder' }, description: 's1',
      },
      {
        id: 'mining.2', subPath: 'mining', depth: 2, cost: 1, magnitude: 0.05,
        effect: { kind: 'placeholder' }, description: 's2',
      },
      {
        id: 'mining.3', subPath: 'mining', depth: 3, cost: 1, magnitude: 0.05,
        effect: { kind: 'placeholder' }, description: 's3',
      },
      {
        id: 'mining.4', subPath: 'mining', depth: 4, cost: 1, magnitude: 0.05,
        effect: { kind: 'placeholder' }, description: 's4',
      },
      {
        id: 'forestry.1', subPath: 'forestry', depth: 1, cost: 1, magnitude: 0.05,
        effect: { kind: 'placeholder' }, description: 'sf',
      },
      {
        id: 'smelting.1', subPath: 'smelting', depth: 1, cost: 1, magnitude: 0.05,
        effect: { kind: 'placeholder' }, description: 'ssm',
      },
    ];
    const s = makeState({ level: 50, unspentSkillPoints: 10 });
    spendPoint(s, 'mining.1', SYNTH4);
    spendPoint(s, 'mining.2', SYNTH4);
    spendPoint(s, 'mining.3', SYNTH4);
    // 3 points spent on mining, 4 nodes in catalog → COMMITTED + INCOMPLETE.
    // forestry.1 (same branch) must be blocked.
    expect(canSpend(s, 'forestry.1', SYNTH4)).toEqual({
      ok: false,
      reason: 'branch-locked',
    });
    // smelting.1 (refinement branch) must be unaffected.
    expect(canSpend(s, 'smelting.1', SYNTH4)).toEqual({ ok: true });
    // Buying mining.4 completes the sub-path; forestry then unlocks.
    spendPoint(s, 'mining.4', SYNTH4);
    expect(canSpend(s, 'forestry.1', SYNTH4)).toEqual({ ok: true });
  });
});

describe('spendPoint', () => {
  it('decrements points, adds to unlockedNodes, updates sub-path progress', () => {
    const s = makeState({ level: 5, unspentSkillPoints: 3 });
    spendPoint(s, 'mining.1');
    expect(s.unspentSkillPoints).toBe(2);
    expect(s.unlockedNodes.has('mining.1')).toBe(true);
    const prog = s.subPathProgress.get('mining');
    expect(prog).toEqual({ spent: 1, complete: false });
  });

  it('marks a sub-path complete when all catalog nodes are owned', () => {
    const TWO_NODE_CATALOG: ReadonlyArray<SkillNode> = [
      { id: 'mining.1', subPath: 'mining', depth: 1, cost: 1, magnitude: 0.05, effect: { kind: 'placeholder' }, description: '' },
      { id: 'mining.2', subPath: 'mining', depth: 2, cost: 2, magnitude: 0.10, effect: { kind: 'placeholder' }, description: '' },
    ];
    const s = makeState({ level: 5, unspentSkillPoints: 5 });
    spendPoint(s, 'mining.1', TWO_NODE_CATALOG);
    spendPoint(s, 'mining.2', TWO_NODE_CATALOG);
    expect(s.subPathProgress.get('mining')).toEqual({ spent: 3, complete: true });
    expect(s.unspentSkillPoints).toBe(2);
  });
});

describe('skill tree depth', () => {
  it('tierRequiredForDepth / nodeRequiredTier for depths 3, 5, 8, 15', () => {
    expect(tierRequiredForDepth(3)).toBe(3);
    expect(tierRequiredForDepth(5)).toBe(5);
    expect(tierRequiredForDepth(8)).toBe(6);
    expect(tierRequiredForDepth(15)).toBe(6);
    expect(nodeRequiredTier({ id: 'x.3', subPath: 'mining', depth: 3, cost: 1, magnitude: 0, effect: { kind: 'placeholder' }, description: '' })).toBe(3);
    expect(nodeRequiredTier({ id: 'x.8', subPath: 'mining', depth: 8, cost: 1, magnitude: 0, effect: { kind: 'placeholder' }, description: '' })).toBe(6);
  });

  it('costForDepth doubles each depth', () => {
    expect(costForDepth(1)).toBe(1);
    expect(costForDepth(5)).toBe(16);
    expect(costForDepth(10)).toBe(512);
    expect(costForDepth(15)).toBe(16384);
  });

  it('magnitudeForDepth: doubles through depth 5, slowed geometric continuation through depth 15', () => {
    // Depth 1-5: doubling ramp 0.05 → 0.80.
    expect(magnitudeForDepth(1)).toBe(0.05);
    expect(magnitudeForDepth(2)).toBe(0.10);
    expect(magnitudeForDepth(3)).toBe(0.20);
    expect(magnitudeForDepth(4)).toBe(0.40);
    expect(magnitudeForDepth(5)).toBe(0.80);
    // Depth 6-10: +0.40 per step (slowed past doubling so depth 15 doesn't
    // blow up to +819×).
    expect(magnitudeForDepth(6)).toBeCloseTo(1.20, 9);
    expect(magnitudeForDepth(7)).toBeCloseTo(1.60, 9);
    expect(magnitudeForDepth(10)).toBeCloseTo(2.80, 9);
    // Depth 11-15: +0.20 per step. Late-game investment plateau.
    expect(magnitudeForDepth(11)).toBeCloseTo(3.00, 9);
    expect(magnitudeForDepth(15)).toBeCloseTo(3.80, 9);
    // Beyond the catalog: clamp to 0.
    expect(magnitudeForDepth(16)).toBe(0);
  });

  it('effectiveSkillMultipliers with deep catalog composes correctly and ignores structural placeholders', () => {
    const deepCatalog: ReadonlyArray<SkillNode> = [
      { id: 'mining.1', subPath: 'mining', depth: 1, cost: 1, magnitude: 0.05, effect: { kind: 'recipeRateMul', category: 'extraction' }, description: '' },
      { id: 'mining.2', subPath: 'mining', depth: 2, cost: 2, magnitude: 0.10, effect: { kind: 'recipeRateMul', category: 'extraction' }, description: '' },
      { id: 'mining.3', subPath: 'mining', depth: 3, cost: 4, magnitude: 0.20, effect: { kind: 'recipeRateMul', category: 'extraction' }, description: '' },
      { id: 'mining.6', subPath: 'mining', depth: 6, cost: 32, magnitude: 0, effect: { kind: 'structural', description: 'mining unique unlock (depth 6)' }, description: '' },
      { id: 'launch.1', subPath: 'launch', depth: 1, cost: 1, magnitude: 0, effect: { kind: 'structural', description: 'launch depth-1 unlock' }, description: '' },
    ];
    const s = makeState({
      unlockedNodes: new Set(['mining.1', 'mining.2', 'mining.3', 'mining.6', 'launch.1']),
    });
    const m = effectiveSkillMultipliers(s, deepCatalog);
    // 1.05 * 1.10 * 1.20 = 1.386
    expect(m.recipeRate.extraction).toBeCloseTo(1.386, 9);
    expect(m.recipeRate.smelting).toBe(1);
    expect(m.storageCap).toBe(1);
    expect(m.powerProduction).toBe(1);
  });

  it('canSpend rejects depth-3 node at T2 island', () => {
    const s = makeState({ level: 5, unspentSkillPoints: 10 });
    expect(canSpend(s, 'mining.3')).toEqual({ ok: false, reason: 'tier-locked' });
  });

  it('spendPoint with deep nodes updates subPathProgress.complete correctly when all nodes in a sub-path are owned', () => {
    const deepCatalog: ReadonlyArray<SkillNode> = [
      { id: 'mining.1', subPath: 'mining', depth: 1, cost: 1, magnitude: 0.05, effect: { kind: 'placeholder' }, description: '' },
      { id: 'mining.2', subPath: 'mining', depth: 2, cost: 2, magnitude: 0.10, effect: { kind: 'placeholder' }, description: '' },
      { id: 'mining.3', subPath: 'mining', depth: 3, cost: 4, magnitude: 0.20, effect: { kind: 'placeholder' }, description: '' },
    ];
    const s = makeState({ level: 15, unspentSkillPoints: 10 });
    spendPoint(s, 'mining.1', deepCatalog);
    spendPoint(s, 'mining.2', deepCatalog);
    expect(s.subPathProgress.get('mining')).toEqual({ spent: 3, complete: false });
    spendPoint(s, 'mining.3', deepCatalog);
    expect(s.subPathProgress.get('mining')).toEqual({ spent: 7, complete: true });
  });

  it('branch lock engages on default catalog after mining.1 + mining.2 (committed but incomplete)', () => {
    const s = makeState({ level: 50, unspentSkillPoints: 10 });
    spendPoint(s, 'mining.1');
    spendPoint(s, 'mining.2');
    // 3 points spent on mining → committed but incomplete (15 nodes in catalog).
    // forestry.1 (same branch) must be blocked.
    expect(canSpend(s, 'forestry.1')).toEqual({
      ok: false,
      reason: 'branch-locked',
    });
    // smelting.1 (refinement branch) must be unaffected.
    expect(canSpend(s, 'smelting.1')).toEqual({ ok: true });
  });
});

describe('effectiveSkillMultipliers', () => {
  it('returns all-1.0 multipliers for an empty unlock set', () => {
    const s = makeState();
    const m = effectiveSkillMultipliers(s);
    expect(m.recipeRate.extraction).toBe(1);
    expect(m.recipeRate.smelting).toBe(1);
    expect(m.recipeRate.power).toBe(1);
    expect(m.storageCap).toBe(1);
    expect(m.powerProduction).toBe(1);
    expect(m.powerConsumption).toBe(1);
  });

  it('applies a single mining.1 as extraction +5%', () => {
    const s = makeState({ unlockedNodes: new Set(['mining.1']) });
    const m = effectiveSkillMultipliers(s);
    expect(m.recipeRate.extraction).toBeCloseTo(1.05, 9);
    expect(m.recipeRate.smelting).toBe(1);
    expect(m.storageCap).toBe(1);
  });

  it('composes mining.1 + mining.2 multiplicatively as 1.05 × 1.10 = 1.155×', () => {
    const s = makeState({ unlockedNodes: new Set(['mining.1', 'mining.2']) });
    const m = effectiveSkillMultipliers(s);
    expect(m.recipeRate.extraction).toBeCloseTo(1.155, 9);
  });

  it('mining.1 + power_systems.1 stacks across distinct axes', () => {
    const s = makeState({
      unlockedNodes: new Set(['mining.1', 'power_systems.1']),
    });
    const m = effectiveSkillMultipliers(s);
    expect(m.recipeRate.extraction).toBeCloseTo(1.05, 9);
    expect(m.powerProduction).toBeCloseTo(1.05, 9);
    expect(m.storageCap).toBe(1);
  });

  it('storage.1 applies a uniform 5% cap multiplier', () => {
    const s = makeState({ unlockedNodes: new Set(['storage.1']) });
    const m = effectiveSkillMultipliers(s);
    expect(m.storageCap).toBeCloseTo(1.05, 9);
    expect(m.recipeRate.extraction).toBe(1);
  });

  it('robotics.1 boosts constructionTime; robotics.2 adds a parallel build slot', () => {
    const s = makeState({ unlockedNodes: new Set(['robotics.1', 'robotics.2']) });
    const m = effectiveSkillMultipliers(s);
    // depth-1 = constructionTimeMul +5% (faster builds; dividend stays ≥ 1)
    expect(m.constructionTime).toBeCloseTo(1.05, 9);
    // depth-2 = parallelBuildCapAdd grants +1 concurrent slot
    expect(m.parallelBuildBonus).toBe(1);
    // No collateral on other axes.
    expect(m.maintenanceThreshold).toBe(1);
    expect(m.recipeRate.extraction).toBe(1);
    expect(m.storageCap).toBe(1);
    expect(m.powerProduction).toBe(1);
  });

  it('transport.1 wires routeCapacity; transport.2 wires droneFuelEfficiency (spec themes split)', () => {
    const s = makeState({ unlockedNodes: new Set(['transport.1', 'transport.2']) });
    const m = effectiveSkillMultipliers(s);
    // depth-1 = routeCapacityMul (+5%)
    expect(m.routeCapacity).toBeCloseTo(1.05, 9);
    // depth-2 = droneFuelEfficiencyMul (+10%) — Transport's "drone fuel" spec theme
    expect(m.droneFuelEfficiency).toBeCloseTo(1.10, 9);
    expect(m.commRange).toBe(1);
  });

  it('network.1 boosts commRange', () => {
    const s = makeState({ unlockedNodes: new Set(['network.1']) });
    const m = effectiveSkillMultipliers(s);
    expect(m.commRange).toBeCloseTo(1.05, 9);
  });

  it('orbital communication / discovery / resilience wire to their axes', () => {
    const s = makeState({
      unlockedNodes: new Set([
        'communication.1',
        'discovery.1',
        'resilience.1',
      ]),
    });
    const m = effectiveSkillMultipliers(s);
    expect(m.commRange).toBeCloseTo(1.05, 9);
    expect(m.scannerCoverage).toBeCloseTo(1.05, 9);
    expect(m.debrisProtection).toBeCloseTo(1.05, 9);
  });

  it('network + communication stack on commRange', () => {
    const s = makeState({
      unlockedNodes: new Set(['network.1', 'communication.1']),
    });
    const m = effectiveSkillMultipliers(s);
    // 1.05 × 1.05 = 1.1025
    expect(m.commRange).toBeCloseTo(1.1025, 9);
  });

  it('power_systems.1 boosts production and depth-2 boosts consumption-efficiency (spec themes split)', () => {
    const s = makeState({ unlockedNodes: new Set(['power_systems.1', 'power_systems.2']) });
    const m = effectiveSkillMultipliers(s);
    expect(m.powerProduction).toBeCloseTo(1.05, 9);
    expect(m.powerConsumption).toBeCloseTo(1.10, 9);
  });

  it('storage.2 boosts the rare-vault category cap specifically (not all categories)', () => {
    const s = makeState({ unlockedNodes: new Set(['storage.2']) });
    const m = effectiveSkillMultipliers(s);
    expect(m.storageCategoryCap.rare).toBeCloseTo(1.10, 9);
    expect(m.storageCategoryCap.dry_goods).toBe(1);
    expect(m.storageCap).toBe(1);
  });

  it('orbital depth-2 alternates wire the secondary axes', () => {
    const s = makeState({
      unlockedNodes: new Set([
        'launch.2',
        'communication.2',
        'discovery.2',
        'resilience.2',
        'resilience.3',
      ]),
    });
    const m = effectiveSkillMultipliers(s);
    expect(m.padExplosionReduce).toBeCloseTo(1.10, 9);
    expect(m.satBufferCap).toBeCloseTo(1.10, 9);
    expect(m.scannerDwellRate).toBeCloseTo(1.10, 9);
    expect(m.satFuelReserve).toBeCloseTo(1.10, 9);
    expect(m.repairDroneReliability).toBeCloseTo(1.20, 9);
  });
});

describe('§14.7 launchSuccessBonus', () => {
  it('returns 0 for an island with no unlocked nodes', () => {
    const s = makeState();
    expect(launchSuccessBonus(s)).toBe(0);
  });

  it('returns magnitudeForDepth(1) when only launch.1 is unlocked', () => {
    const s = makeState({ unlockedNodes: new Set(['launch.1']) });
    expect(launchSuccessBonus(s)).toBe(magnitudeForDepth(1));
  });

  it('launch.2 contributes pad-explosion mitigation, NOT launchSuccess (spec themes split)', () => {
    // Post-catalog-refactor: launch depth-1+3+ stays additive launch-success;
    // depth-2 is the pad-explosion mitigation slot (separate axis).
    const s = makeState({ unlockedNodes: new Set(['launch.1', 'launch.2']) });
    expect(launchSuccessBonus(s)).toBe(magnitudeForDepth(1));
    const m = effectiveSkillMultipliers(s);
    expect(m.padExplosionReduce).toBeCloseTo(1.10, 9);
  });

  it('returns 0 when only non-launch nodes are unlocked', () => {
    const s = makeState({ unlockedNodes: new Set(['mining.1']) });
    expect(launchSuccessBonus(s)).toBe(0);
  });
});
