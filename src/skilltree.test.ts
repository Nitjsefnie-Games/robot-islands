// Pure-logic tests for the skill tree (§9.3) — tier mapping, depth gating,
// spend validation (already-owned / insufficient points / tier-locked /
// depth-prereq / branch-locked), spend mutation, and effect aggregation.

import { describe, expect, it } from 'vitest';

import type { IslandState } from './economy.js';
import { ALL_RESOURCES, type ResourceId } from './recipes.js';
import {
  bindCrystal,
  buyKeystone,
  buyNode,
  canBuyKeystone,
  canSpend,
  costForDepth,
  costToUnlock,
  cumulativeSkillPointsForLevel,
  effectiveGraph,
  effectiveSkillMultipliers,
  hasPickableSkill,
  launchSuccessBonus,
  NODE_CATALOG,
  skillPointsForLevelUp,
  spendPoint,
  t5Unlocked,
  t6Unlocked,
  tierForLevel,
  type SkillNode,
  unbindCrystal,
} from './skilltree.js';
import { CRYSTAL_CATALOG } from './skilltree-crystals.js';
import type { EdgeId, Graph, KeystonePrereq } from './skilltree-graph.js';
import { DEFAULT_GRAPH } from './skilltree.js';

/** Minimal legacy-style nodes so multiplier-folding tests don't depend on the
 *  live catalog (which uses `.notable.` / `.keystone.` ids). */
const LEGACY_TEST_NODES: ReadonlyArray<SkillNode> = [
  { id: 'mining.1', subPath: 'mining', depth: 1, cost: 1, magnitude: 0.05, effect: { kind: 'recipeRateMul', category: 'extraction' }, description: '' },
  { id: 'mining.2', subPath: 'mining', depth: 2, cost: 2, magnitude: 0.10, effect: { kind: 'mineYieldBonusMul' }, description: '' },
  { id: 'mining.3', subPath: 'mining', depth: 3, cost: 4, magnitude: 0.20, effect: { kind: 'mineRareTrickleMul' }, description: '' },
  { id: 'mining.6', subPath: 'mining', depth: 6, cost: 32, magnitude: 0, effect: { kind: 'structural', description: 'mining unique unlock (depth 6)', data: { kind: 'sharedPowerGrid' } }, description: '' },
  { id: 'forestry.2', subPath: 'forestry', depth: 2, cost: 2, magnitude: 0.10, effect: { kind: 'loggerYieldBonusMul' }, description: '' },
  { id: 'forestry.3', subPath: 'forestry', depth: 3, cost: 4, magnitude: 0.20, effect: { kind: 'loggerExoticTrickleMul' }, description: '' },
  { id: 'power_systems.1', subPath: 'power_systems', depth: 1, cost: 1, magnitude: 0.05, effect: { kind: 'powerProductionMul' }, description: '' },
  { id: 'power_systems.2', subPath: 'power_systems', depth: 2, cost: 2, magnitude: 0.10, effect: { kind: 'powerConsumptionMul', reduce: true }, description: '' },
  { id: 'storage.1', subPath: 'storage', depth: 1, cost: 1, magnitude: 0.05, effect: { kind: 'storageCapMul' }, description: '' },
  { id: 'storage.2', subPath: 'storage', depth: 2, cost: 2, magnitude: 0.10, effect: { kind: 'storageCategoryCapMul', category: 'rare' }, description: '' },
  { id: 'robotics.1', subPath: 'robotics', depth: 1, cost: 1, magnitude: 0.05, effect: { kind: 'constructionTimeMul' }, description: '' },
  { id: 'robotics.2', subPath: 'robotics', depth: 2, cost: 2, magnitude: 0.10, effect: { kind: 'parallelBuildCapAdd' }, description: '' },
  { id: 'transport.1', subPath: 'transport', depth: 1, cost: 1, magnitude: 0.05, effect: { kind: 'routeCapacityMul' }, description: '' },
  { id: 'transport.2', subPath: 'transport', depth: 2, cost: 2, magnitude: 0.10, effect: { kind: 'droneFuelEfficiencyMul' }, description: '' },
  { id: 'network.1', subPath: 'network', depth: 1, cost: 1, magnitude: 0.05, effect: { kind: 'teleporterEfficiencyMul' }, description: '' },
  { id: 'network.2', subPath: 'network', depth: 2, cost: 2, magnitude: 0.10, effect: { kind: 'commRangeMul' }, description: '' },
  { id: 'communication.1', subPath: 'communication', depth: 1, cost: 1, magnitude: 0.05, effect: { kind: 'commRangeMul' }, description: '' },
  { id: 'communication.2', subPath: 'communication', depth: 2, cost: 2, magnitude: 0.10, effect: { kind: 'satBufferCapMul' }, description: '' },
  { id: 'discovery.1', subPath: 'discovery', depth: 1, cost: 1, magnitude: 0.05, effect: { kind: 'scannerCoverageMul' }, description: '' },
  { id: 'discovery.2', subPath: 'discovery', depth: 2, cost: 2, magnitude: 0.10, effect: { kind: 'scannerDwellRateMul' }, description: '' },
  { id: 'resilience.1', subPath: 'resilience', depth: 1, cost: 1, magnitude: 0.05, effect: { kind: 'debrisProtectionMul' }, description: '' },
  { id: 'resilience.2', subPath: 'resilience', depth: 2, cost: 2, magnitude: 0.10, effect: { kind: 'satFuelReserveMul' }, description: '' },
  { id: 'resilience.3', subPath: 'resilience', depth: 3, cost: 4, magnitude: 0.20, effect: { kind: 'repairDroneReliabilityMul' }, description: '' },
  { id: 'launch.1', subPath: 'launch', depth: 1, cost: 1, magnitude: 0.05, effect: { kind: 'launchSuccessAdditive' }, description: '' },
  { id: 'launch.2', subPath: 'launch', depth: 2, cost: 2, magnitude: 0.10, effect: { kind: 'padExplosionReduceMul' }, description: '' },
];

const LG = { nodes: LEGACY_TEST_NODES, edges: [], bridges: [], graftSockets: [] } as Graph;

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
    unlockedEdges: new Set(),
    funnelPending: blankFunnel(),
    declaredAt: null,
    aiCoreCrafted: false,
    ascendantCoreCrafted: false,
    lastResetAt: null,
    timeLockBankedMin: 0,
    accelerationQueue: [],
    accelerationRemainingMin: 0,
    bankingEnabled: false,
    genesisTarget: null,
    batteryStoredWs: 0,
    starterInventoryGrace: {} as Record<ResourceId, number>,
    socketBindings: new Map(),
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


describe('canSpend', () => {
  it('allows an island with enough points to buy a node', () => {
    const s = makeState({ level: 5, unspentSkillPoints: 5 });
    expect(canSpend(s, 'mining.notable.deepVein')).toEqual({ ok: true });
  });

  it('rejects when the player has no skill points', () => {
    const s = makeState({ level: 5, unspentSkillPoints: 0 });
    expect(canSpend(s, 'mining.notable.deepVein')).toEqual({
      ok: false,
      reason: 'insufficient-points',
    });
  });

  it('rejects re-purchasing an already-owned node', () => {
    const s = makeState({
      level: 5,
      unspentSkillPoints: 5,
      unlockedNodes: new Set(['mining.notable.deepVein']),
    });
    expect(canSpend(s, 'mining.notable.deepVein')).toEqual({
      ok: false,
      reason: 'already-unlocked',
    });
  });

  it('allows parallel work in different branches', () => {
    const s = makeState({
      level: 5,
      unspentSkillPoints: 5,
      unlockedNodes: new Set(['mining.notable.deepVein']),
    });
    expect(canSpend(s, 'smelting.notable.inductionArc')).toEqual({ ok: true });
  });
});

describe('spendPoint', () => {
  it('decrements points and adds to unlockedNodes', () => {
    const s = makeState({ level: 5, unspentSkillPoints: 3 });
    spendPoint(s, 'mining.notable.deepVein');
    expect(s.unspentSkillPoints).toBe(3 - NODE_CATALOG.find(n => n.id === 'mining.notable.deepVein')!.cost);
    expect(s.unlockedNodes.has('mining.notable.deepVein')).toBe(true);
  });

  it('allows spending on all nodes in a small catalog', () => {
    const TWO_NODE_CATALOG: ReadonlyArray<SkillNode> = [
      { id: 'mining.1', subPath: 'mining', depth: 1, cost: 1, magnitude: 0.05, effect: { kind: 'placeholder' }, description: '' },
      { id: 'mining.2', subPath: 'mining', depth: 2, cost: 2, magnitude: 0.10, effect: { kind: 'placeholder' }, description: '' },
    ];
    const s = makeState({ level: 5, unspentSkillPoints: 5 });
    spendPoint(s, 'mining.1', TWO_NODE_CATALOG);
    spendPoint(s, 'mining.2', TWO_NODE_CATALOG);
    expect(s.unlockedNodes.has('mining.1')).toBe(true);
    expect(s.unlockedNodes.has('mining.2')).toBe(true);
    expect(s.unspentSkillPoints).toBe(2);
  });
});

describe('skill tree depth', () => {
  it('costForDepth grows as 1.5^(depth-1) (rounded)', () => {
    expect(costForDepth(1)).toBe(1);
    expect(costForDepth(5)).toBe(5); // 1.5^4 = 5.0625 → 5
    expect(costForDepth(10)).toBe(38); // 1.5^9 = 38.44 → 38
    expect(costForDepth(15)).toBe(292); // 1.5^14 = 291.93 → 292
  });

  it('skillPointsForLevelUp: 1.1^L floored, min 1 to keep early-game ungated', () => {
    expect(skillPointsForLevelUp(1)).toBe(1);
    expect(skillPointsForLevelUp(7)).toBe(1); // 1.94 → 1
    expect(skillPointsForLevelUp(8)).toBe(2); // 2.14 → 2
    expect(skillPointsForLevelUp(20)).toBe(6); // 6.73 → 6
    expect(skillPointsForLevelUp(50)).toBe(117);
    expect(skillPointsForLevelUp(70)).toBe(789); // 789.7 → 789
  });

  it('cumulativeSkillPointsForLevel: monotonic, matches expected sums at key levels', () => {
    expect(cumulativeSkillPointsForLevel(0)).toBe(0);
    expect(cumulativeSkillPointsForLevel(5)).toBe(5);   // five L1=1 grants
    // L8 = 1+1+1+1+1+1+1+2 = 9
    expect(cumulativeSkillPointsForLevel(8)).toBe(9);
    // Higher landmarks (worked out in the slice's commit body):
    expect(cumulativeSkillPointsForLevel(50)).toBeGreaterThan(1000);
    expect(cumulativeSkillPointsForLevel(50)).toBeLessThan(1500);
    expect(cumulativeSkillPointsForLevel(70)).toBeGreaterThan(7000);
    expect(cumulativeSkillPointsForLevel(70)).toBeLessThan(10000);
  });

  it('full sub-path cost (sum d1..d15) lands ~870 points, reachable by L50ish', () => {
    let totalCost = 0;
    for (let d = 1; d <= 15; d++) totalCost += costForDepth(d);
    // Whole sub-path is between 800 and 950 under the 1.5 ramp.
    expect(totalCost).toBeGreaterThan(800);
    expect(totalCost).toBeLessThan(950);
    // And L50's cumulative grant covers more than one sub-path's worth.
    expect(cumulativeSkillPointsForLevel(50)).toBeGreaterThan(totalCost);
  });

  it('effectiveSkillMultipliers with deep catalog composes correctly and ignores structural placeholders', () => {
    const deepCatalog: ReadonlyArray<SkillNode> = [
      { id: 'mining.1', subPath: 'mining', depth: 1, cost: 1, magnitude: 0.05, effect: { kind: 'recipeRateMul', category: 'extraction' }, description: '' },
      { id: 'mining.2', subPath: 'mining', depth: 2, cost: 2, magnitude: 0.10, effect: { kind: 'recipeRateMul', category: 'extraction' }, description: '' },
      { id: 'mining.3', subPath: 'mining', depth: 3, cost: 4, magnitude: 0.20, effect: { kind: 'recipeRateMul', category: 'extraction' }, description: '' },
      { id: 'mining.6', subPath: 'mining', depth: 6, cost: 32, magnitude: 0, effect: { kind: 'structural', description: 'mining unique unlock (depth 6)', data: { kind: 'sharedPowerGrid' } }, description: '' },
      { id: 'launch.1', subPath: 'launch', depth: 1, cost: 1, magnitude: 0, effect: { kind: 'structural', description: 'launch depth-1 unlock', data: { kind: 'sharedPowerGrid' } }, description: '' },
    ];
    const s = makeState({
      unlockedNodes: new Set(['mining.1', 'mining.2', 'mining.3', 'mining.6', 'launch.1']),
    });
    const m = effectiveSkillMultipliers(s, { nodes: deepCatalog, edges: [], bridges: [], graftSockets: [] } as Graph);
    // 1.05 * 1.10 * 1.20 = 1.386
    expect(m.recipeRate.extraction).toBeCloseTo(1.386, 9);
    expect(m.recipeRate.smelting).toBe(1);
    expect(m.storageCap).toBe(1);
    expect(m.powerProduction).toBe(1);
  });

  it('allows spending all nodes in a deep catalog (no tier/depth gates)', () => {
    const deepCatalog: ReadonlyArray<SkillNode> = [
      { id: 'mining.1', subPath: 'mining', depth: 1, cost: 1, magnitude: 0.05, effect: { kind: 'placeholder' }, description: '' },
      { id: 'mining.2', subPath: 'mining', depth: 2, cost: 2, magnitude: 0.10, effect: { kind: 'placeholder' }, description: '' },
      { id: 'mining.3', subPath: 'mining', depth: 3, cost: 4, magnitude: 0.20, effect: { kind: 'placeholder' }, description: '' },
    ];
    const s = makeState({ level: 15, unspentSkillPoints: 10 });
    spendPoint(s, 'mining.1', deepCatalog);
    spendPoint(s, 'mining.2', deepCatalog);
    expect(s.unlockedNodes.has('mining.1')).toBe(true);
    expect(s.unlockedNodes.has('mining.2')).toBe(true);
    spendPoint(s, 'mining.3', deepCatalog);
    expect(s.unlockedNodes.has('mining.3')).toBe(true);
  });

  it('parallel work in different branches is allowed', () => {
    const s = makeState({ level: 50, unspentSkillPoints: 10 });
    spendPoint(s, 'mining.notable.efficientDrills'); // 3
    spendPoint(s, 'mining.notable.deepVein');        // 4
    // 10 - 7 = 3 left; cheapest notables in other branches cost 3.
    expect(canSpend(s, 'forestry.notable.clearcutCoordination')).toEqual({ ok: true });
    expect(canSpend(s, 'smelting.notable.refractoryLining')).toEqual({ ok: true });
  });
});

describe('effectiveSkillMultipliers', () => {
  it('returns all-1.0 multipliers for an empty unlock set', () => {
    const s = makeState();
    const m = effectiveSkillMultipliers(s, LG);
    expect(m.recipeRate.extraction).toBe(1);
    expect(m.recipeRate.smelting).toBe(1);
    expect(m.recipeRate.power).toBe(1);
    expect(m.storageCap).toBe(1);
    expect(m.powerProduction).toBe(1);
    expect(m.powerConsumption).toBe(1);
  });

  it('applies a single mining.1 as extraction +5%', () => {
    const s = makeState({ unlockedNodes: new Set(['mining.1']) });
    const m = effectiveSkillMultipliers(s, LG);
    expect(m.recipeRate.extraction).toBeCloseTo(1.05, 9);
    expect(m.recipeRate.smelting).toBe(1);
    expect(m.storageCap).toBe(1);
  });

  it('mining.1 + mining.2 split across recipeRate.extraction and mineYieldBonus', () => {
    const s = makeState({ unlockedNodes: new Set(['mining.1', 'mining.2']) });
    const m = effectiveSkillMultipliers(s, LG);
    expect(m.recipeRate.extraction).toBeCloseTo(1.05, 9);
    expect(m.mineYieldBonus).toBeCloseTo(1.10, 9);
  });

  it('mining.1 + power_systems.1 stacks across distinct axes', () => {
    const s = makeState({
      unlockedNodes: new Set(['mining.1', 'power_systems.1']),
    });
    const m = effectiveSkillMultipliers(s, LG);
    expect(m.recipeRate.extraction).toBeCloseTo(1.05, 9);
    expect(m.powerProduction).toBeCloseTo(1.05, 9);
    expect(m.storageCap).toBe(1);
  });

  it('storage.1 applies a uniform 5% cap multiplier', () => {
    const s = makeState({ unlockedNodes: new Set(['storage.1']) });
    const m = effectiveSkillMultipliers(s, LG);
    expect(m.storageCap).toBeCloseTo(1.05, 9);
    expect(m.recipeRate.extraction).toBe(1);
  });

  it('robotics.1 boosts constructionTime; robotics.2 adds a parallel build slot', () => {
    const s = makeState({ unlockedNodes: new Set(['robotics.1', 'robotics.2']) });
    const m = effectiveSkillMultipliers(s, LG);
    expect(m.constructionTime).toBeCloseTo(1.05, 9);
    expect(m.parallelBuildBonus).toBe(1);
    expect(m.maintenanceThreshold).toBe(1);
    expect(m.recipeRate.extraction).toBe(1);
    expect(m.storageCap).toBe(1);
    expect(m.powerProduction).toBe(1);
  });

  it('transport.1 wires routeCapacity; transport.2 wires droneFuelEfficiency (spec themes split)', () => {
    const s = makeState({ unlockedNodes: new Set(['transport.1', 'transport.2']) });
    const m = effectiveSkillMultipliers(s, LG);
    expect(m.routeCapacity).toBeCloseTo(1.05, 9);
    expect(m.droneFuelEfficiency).toBeCloseTo(1.10, 9);
    expect(m.commRange).toBe(1);
  });

  it('network.1 wires teleporterEfficiency; network.2 wires commRange (spec themes split)', () => {
    const s1 = makeState({ unlockedNodes: new Set(['network.1']) });
    const m1 = effectiveSkillMultipliers(s1, LG);
    expect(m1.teleporterEfficiency).toBeCloseTo(1.05, 9);
    expect(m1.commRange).toBe(1);
    const s2 = makeState({ unlockedNodes: new Set(['network.2']) });
    const m2 = effectiveSkillMultipliers(s2, LG);
    expect(m2.teleporterEfficiency).toBe(1);
    expect(m2.commRange).toBeCloseTo(1.10, 9);
  });

  it('orbital communication / discovery / resilience wire to their axes', () => {
    const s = makeState({
      unlockedNodes: new Set([
        'communication.1',
        'discovery.1',
        'resilience.1',
      ]),
    });
    const m = effectiveSkillMultipliers(s, LG);
    expect(m.commRange).toBeCloseTo(1.05, 9);
    expect(m.scannerCoverage).toBeCloseTo(1.05, 9);
    expect(m.debrisProtection).toBeCloseTo(1.05, 9);
  });

  it('network.2 + communication.1 stack on commRange', () => {
    const s = makeState({
      unlockedNodes: new Set(['network.2', 'communication.1']),
    });
    const m = effectiveSkillMultipliers(s, LG);
    expect(m.commRange).toBeCloseTo(1.155, 9);
  });

  it('power_systems.1 boosts production and depth-2 boosts consumption-efficiency (spec themes split)', () => {
    const s = makeState({ unlockedNodes: new Set(['power_systems.1', 'power_systems.2']) });
    const m = effectiveSkillMultipliers(s, LG);
    expect(m.powerProduction).toBeCloseTo(1.05, 9);
    expect(m.powerConsumption).toBeCloseTo(1.10, 9);
  });

  it('storage.2 boosts the rare-vault category cap specifically (not all categories)', () => {
    const s = makeState({ unlockedNodes: new Set(['storage.2']) });
    const m = effectiveSkillMultipliers(s, LG);
    expect(m.storageCategoryCap.rare).toBeCloseTo(1.10, 9);
    expect(m.storageCategoryCap.dry_goods).toBe(1);
    expect(m.storageCap).toBe(1);
  });

  it('mining.2 wires mineYieldBonus; mining.3 adds rare helium_3 trickle rate', () => {
    const s2 = makeState({ unlockedNodes: new Set(['mining.2']) });
    const m2 = effectiveSkillMultipliers(s2, LG);
    expect(m2.mineYieldBonus).toBeCloseTo(1.10, 9);
    expect(m2.mineRareTrickleRate).toBe(0);
    const s3 = makeState({ unlockedNodes: new Set(['mining.3']) });
    const m3 = effectiveSkillMultipliers(s3, LG);
    expect(m3.mineRareTrickleRate).toBeCloseTo(0.0012, 9);
  });

  it('forestry.2 wires loggerYieldBonus; forestry.3 adds exotic lumber trickle rate', () => {
    const s2 = makeState({ unlockedNodes: new Set(['forestry.2']) });
    const m2 = effectiveSkillMultipliers(s2, LG);
    expect(m2.loggerYieldBonus).toBeCloseTo(1.10, 9);
    const s3 = makeState({ unlockedNodes: new Set(['forestry.3']) });
    const m3 = effectiveSkillMultipliers(s3, LG);
    expect(m3.loggerExoticTrickleRate).toBeCloseTo(0.0012, 9);
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
    const m = effectiveSkillMultipliers(s, LG);
    expect(m.padExplosionReduce).toBeCloseTo(1.10, 9);
    expect(m.satBufferCap).toBeCloseTo(1.10, 9);
    expect(m.scannerDwellRate).toBeCloseTo(1.10, 9);
    expect(m.satFuelReserve).toBeCloseTo(1.10, 9);
    expect(m.repairDroneReliability).toBeCloseTo(1.20, 9);
  });

  it('batteryCapacityMul effect contributes to batteryCapacity multiplier', () => {
    const LG_BAT: SkillNode[] = [
      { id: 'bat.1', subPath: 'power_systems', depth: 1, cost: 1, magnitude: 0.30,
        effect: { kind: 'batteryCapacityMul' }, description: '' },
    ];
    const s = makeState({ unlockedNodes: new Set(['bat.1']) });
    const m = effectiveSkillMultipliers(s, { nodes: LG_BAT, edges: [], bridges: [], graftSockets: [] } as Graph);
    expect(m.batteryCapacity).toBeCloseTo(1.30, 9);
    expect(m.powerProduction).toBe(1); // negative assertion: cross-contamination guard
    expect(m.storageCap).toBe(1); //                "
  });
});

describe('§14.7 launchSuccessBonus', () => {
  it('returns 0 for an island with no unlocked nodes', () => {
    const s = makeState();
    expect(launchSuccessBonus(s, LEGACY_TEST_NODES)).toBe(0);
  });

  it('returns 0.05 when only launch.1 is unlocked', () => {
    const s = makeState({ unlockedNodes: new Set(['launch.1']) });
    expect(launchSuccessBonus(s, LEGACY_TEST_NODES)).toBe(0.05);
  });

  it('launch.2 contributes pad-explosion mitigation, NOT launchSuccess (spec themes split)', () => {
    const s = makeState({ unlockedNodes: new Set(['launch.1', 'launch.2']) });
    expect(launchSuccessBonus(s, LEGACY_TEST_NODES)).toBe(0.05);
    const m = effectiveSkillMultipliers(s, LG);
    expect(m.padExplosionReduce).toBeCloseTo(1.10, 9);
  });

  it('returns 0 when only non-launch nodes are unlocked', () => {
    const s = makeState({ unlockedNodes: new Set(['mining.1']) });
    expect(launchSuccessBonus(s, LEGACY_TEST_NODES)).toBe(0);
  });
});

describe('hasPickableSkill', () => {
  it('returns false for a fresh island with zero points', () => {
    const state = makeState({ level: 1, unspentSkillPoints: 0 });
    expect(hasPickableSkill(state)).toBe(false);
  });

  it('returns true when the island has enough points for the cheapest node', () => {
    // Cheapest nodes in the live catalog cost 3 SP (depth-3 notables).
    const state = makeState({ level: 1, unspentSkillPoints: 5 });
    expect(NODE_CATALOG.some((n) => canSpend(state, n.id).ok)).toBe(true);
    expect(hasPickableSkill(state)).toBe(true);
  });

  it('declaration-pending alone does NOT flip the predicate true', () => {
    const state = makeState({
      level: 15,
      unspentSkillPoints: 0,
      declaredAt: null,
    });
    expect(hasPickableSkill(state)).toBe(false);
  });
});

describe('costToUnlock', () => {
  function mkNode(id: string): SkillNode {
    return {
      id: id as import('./skilltree.js').NodeId,
      subPath: 'mining',
      depth: 1,
      cost: 0,
      magnitude: 0,
      effect: { kind: 'recipeRateMul', category: 'extraction' },
      description: id,
    };
  }

  function mkGraph(): Graph {
    const nodes: SkillNode[] = [
      mkNode('R'), mkNode('A'), mkNode('X'), mkNode('Z'),
      mkNode('B'), mkNode('Y'),
    ];
    const edges = [
      { id: 'e_RA' as EdgeId, from: 'R' as import('./skilltree-graph.js').NodeId, to: 'A' as import('./skilltree-graph.js').NodeId, cost: 2 },
      { id: 'e_AX' as EdgeId, from: 'A' as import('./skilltree-graph.js').NodeId, to: 'X' as import('./skilltree-graph.js').NodeId, cost: 3 },
      { id: 'e_XZ' as EdgeId, from: 'X' as import('./skilltree-graph.js').NodeId, to: 'Z' as import('./skilltree-graph.js').NodeId, cost: 5 },
      { id: 'e_RB' as EdgeId, from: 'R' as import('./skilltree-graph.js').NodeId, to: 'B' as import('./skilltree-graph.js').NodeId, cost: 3 },
      { id: 'e_BY' as EdgeId, from: 'B' as import('./skilltree-graph.js').NodeId, to: 'Y' as import('./skilltree-graph.js').NodeId, cost: 2 },
    ];
    return { nodes, edges, bridges: [], graftSockets: [] } as Graph;
  }

  it('finds cheapest path from owned R to Z (= 2+3+5 = 10)', () => {
    const g = mkGraph();
    const owned = new Set(['R']);
    const result = costToUnlock(g, owned, new Set(), { unlockedNodes: owned } as any, 'Z');
    expect(result).not.toBeNull();
    expect(result!.totalCost).toBe(10);
    expect(result!.path.map((e) => e.id)).toEqual(['e_RA', 'e_AX', 'e_XZ']);
  });

  it('uses owned A as a starting frontier (cost = A→X→Z = 8)', () => {
    const g = mkGraph();
    const owned = new Set(['R', 'A']);
    const result = costToUnlock(g, owned, new Set(), { unlockedNodes: owned } as any, 'Z');
    expect(result).not.toBeNull();
    expect(result!.totalCost).toBe(8);
  });

  it('returns null when no path exists', () => {
    const g = mkGraph();
    const owned = new Set(['R']);
    const result = costToUnlock(g, owned, new Set(), { unlockedNodes: owned } as any, 'NOTREAL');
    expect(result).toBeNull();
  });
});

describe('buyNode', () => {
  function mkNode(id: string): SkillNode {
    return {
      id: id as import('./skilltree.js').NodeId,
      subPath: 'mining',
      depth: 1,
      cost: 0,
      magnitude: 0,
      effect: { kind: 'recipeRateMul', category: 'extraction' },
      description: id,
    };
  }

  function mkGraph(): Graph {
    const nodes: SkillNode[] = [
      mkNode('R'), mkNode('A'), mkNode('X'), mkNode('Z'),
      mkNode('B'), mkNode('Y'),
    ];
    const edges = [
      { id: 'e_RA' as EdgeId, from: 'R' as import('./skilltree-graph.js').NodeId, to: 'A' as import('./skilltree-graph.js').NodeId, cost: 2 },
      { id: 'e_AX' as EdgeId, from: 'A' as import('./skilltree-graph.js').NodeId, to: 'X' as import('./skilltree-graph.js').NodeId, cost: 3 },
      { id: 'e_XZ' as EdgeId, from: 'X' as import('./skilltree-graph.js').NodeId, to: 'Z' as import('./skilltree-graph.js').NodeId, cost: 5 },
      { id: 'e_RB' as EdgeId, from: 'R' as import('./skilltree-graph.js').NodeId, to: 'B' as import('./skilltree-graph.js').NodeId, cost: 3 },
      { id: 'e_BY' as EdgeId, from: 'B' as import('./skilltree-graph.js').NodeId, to: 'Y' as import('./skilltree-graph.js').NodeId, cost: 2 },
    ];
    return { nodes, edges, bridges: [], graftSockets: [] } as Graph;
  }

  it('buys Z from R-only state, auto-owns A and X intermediates', () => {
    const g = mkGraph();
    const state = makeState({ unspentSkillPoints: 20 });
    state.unlockedNodes.add('R');
    buyNode(g, state, 'Z');
    expect(state.unspentSkillPoints).toBe(10); // 20 - 10
    expect(state.unlockedNodes.has('A')).toBe(true);
    expect(state.unlockedNodes.has('X')).toBe(true);
    expect(state.unlockedNodes.has('Z')).toBe(true);
    expect(state.unlockedEdges.size).toBe(3);
  });

  it('throws on insufficient SP', () => {
    const g = mkGraph();
    const state = makeState({ unspentSkillPoints: 5 });
    state.unlockedNodes.add('R');
    expect(() => buyNode(g, state, 'Z')).toThrow(/insufficient/);
  });

  it('is a no-op when target is already owned', () => {
    const g = mkGraph();
    const state = makeState({ unspentSkillPoints: 10 });
    state.unlockedNodes.add('Z');
    buyNode(g, state, 'Z');
    expect(state.unspentSkillPoints).toBe(10);
  });
});

describe('effectiveSkillMultipliers — graph mode + auras', () => {
  it('folds two recipeRateMul nodes multiplicatively, not additively', () => {
    const nodes: SkillNode[] = [
      { id: 'n1' as import('./skilltree.js').NodeId, subPath: 'mining', depth: 1, cost: 1, magnitude: 0.05, effect: { kind: 'recipeRateMul', category: 'extraction' }, description: '' },
      { id: 'n2' as import('./skilltree.js').NodeId, subPath: 'mining', depth: 2, cost: 2, magnitude: 0.05, effect: { kind: 'recipeRateMul', category: 'extraction' }, description: '' },
    ];
    const g: Graph = { nodes, edges: [], bridges: [], graftSockets: [] } as Graph;
    const state = makeState();
    state.unlockedNodes.add('n1');
    state.unlockedNodes.add('n2');
    const mul = effectiveSkillMultipliers(state, g);
    expect(mul.recipeRate.extraction).toBeCloseTo(1.05 * 1.05, 4); // 1.1025, NOT 1.10
  });

  it('aura amplifies adjacent owned node’s factor', () => {
    const nodes: SkillNode[] = [
      { id: 'auraNode' as import('./skilltree.js').NodeId, subPath: 'mining', depth: 1, cost: 1, magnitude: 0, effect: { kind: 'recipeRateMul', category: 'extraction' }, description: '', aura: { radius: 1, bonus: 0.15 } },
      { id: 'neighbour' as import('./skilltree.js').NodeId, subPath: 'mining', depth: 2, cost: 2, magnitude: 0.10, effect: { kind: 'recipeRateMul', category: 'extraction' }, description: '' },
    ];
    const edges = [
      { id: 'e1' as EdgeId, from: 'auraNode' as import('./skilltree-graph.js').NodeId, to: 'neighbour' as import('./skilltree-graph.js').NodeId, cost: 1 },
    ];
    const g: Graph = { nodes, edges, bridges: [], graftSockets: [] } as Graph;
    const state = makeState();
    state.unlockedNodes.add('auraNode');
    state.unlockedNodes.add('neighbour');
    const mul = effectiveSkillMultipliers(state, g);
    // neighbour's per-node factor becomes 1 + 0.10 * 1.15 = 1.115
    expect(mul.recipeRate.extraction).toBeCloseTo(1.115, 3);
  });

  it('caps aura amplification at ×1.50', () => {
    const nodes: SkillNode[] = [
      { id: 'target' as import('./skilltree.js').NodeId, subPath: 'mining', depth: 1, cost: 1, magnitude: 0.10, effect: { kind: 'recipeRateMul', category: 'extraction' }, description: '' },
      ...Array.from({ length: 5 }, (_, i) => ({
        id: `aura${i}` as import('./skilltree.js').NodeId,
        subPath: 'mining' as import('./skilltree.js').SubPathId,
        depth: 1, cost: 1, magnitude: 0,
        effect: { kind: 'recipeRateMul' as const, category: 'extraction' as import('./recipes.js').RecipeCategory },
        description: '',
        aura: { radius: 1 as const, bonus: 0.15 },
      })),
    ];
    const edges = Array.from({ length: 5 }, (_, i) => ({
      id: `e${i}` as EdgeId,
      from: `aura${i}` as import('./skilltree-graph.js').NodeId,
      to: 'target' as import('./skilltree-graph.js').NodeId,
      cost: 1,
    }));
    const g: Graph = { nodes, edges, bridges: [], graftSockets: [] } as Graph;
    const state = makeState();
    state.unlockedNodes.add('target');
    for (let i = 0; i < 5; i++) state.unlockedNodes.add(`aura${i}`);
    const mul = effectiveSkillMultipliers(state, g);
    // target.magnitude=0.10 → factor 1 + 0.10 * 1.5 = 1.15
    expect(mul.recipeRate.extraction).toBeCloseTo(1.15, 3);
  });
});

describe('canBuyKeystone / buyKeystone', () => {
  it('requires all AND-prereqs to be owned', () => {
    const ks: KeystonePrereq = {
      targetNode: 'K1' as import('./skilltree-graph.js').NodeId,
      requires: ['A' as import('./skilltree-graph.js').NodeId, 'B' as import('./skilltree-graph.js').NodeId],
      cost: 10,
    };
    const state = makeState({ unspentSkillPoints: 15 });
    state.unlockedNodes.add('A');
    expect(canBuyKeystone(ks, state)).toBe(false);
    state.unlockedNodes.add('B');
    expect(canBuyKeystone(ks, state)).toBe(true);
  });

  it('buyKeystone charges flat cost + owns target', () => {
    const ks: KeystonePrereq = {
      targetNode: 'K1' as import('./skilltree-graph.js').NodeId,
      requires: ['A' as import('./skilltree-graph.js').NodeId],
      cost: 8,
    };
    const state = makeState({ unspentSkillPoints: 10 });
    state.unlockedNodes.add('A');
    buyKeystone(ks, state);
    expect(state.unspentSkillPoints).toBe(2);
    expect(state.unlockedNodes.has('K1')).toBe(true);
  });
});

describe('bindCrystal / unbindCrystal', () => {
  it('bindCrystal consumes crystal from inventory and sets binding', () => {
    const inv = blankInventory();
    (inv as Record<string, number>).mining_crystal_t1 = 2;
    const state = makeState({ inventory: inv });
    bindCrystal(state, 'gs.ext.mining-1', 'mining_crystal_t1' as import('./skilltree-graph.js').CrystalId);
    expect((state.inventory as Record<string, number>).mining_crystal_t1).toBe(1);
    expect(state.socketBindings.get('gs.ext.mining-1')).toBe('mining_crystal_t1');
  });

  it('bindCrystal throws when crystal is absent', () => {
    const state = makeState();
    expect(() =>
      bindCrystal(state, 'gs.ext.mining-1', 'mining_crystal_t1' as import('./skilltree-graph.js').CrystalId),
    ).toThrow(/no mining_crystal_t1 in inventory/);
  });

  it('bindCrystal returns previous crystal to inventory', () => {
    const inv = blankInventory();
    (inv as Record<string, number>).mining_crystal_t1 = 1;
    (inv as Record<string, number>).mining_crystal_t2 = 1;
    const state = makeState({ inventory: inv });
    state.socketBindings.set('gs.ext.mining-1', 'mining_crystal_t1' as import('./skilltree-graph.js').CrystalId);
    bindCrystal(state, 'gs.ext.mining-1', 'mining_crystal_t2' as import('./skilltree-graph.js').CrystalId);
    expect((state.inventory as Record<string, number>).mining_crystal_t1).toBe(2);
    expect((state.inventory as Record<string, number>).mining_crystal_t2).toBe(0);
    expect(state.socketBindings.get('gs.ext.mining-1')).toBe('mining_crystal_t2');
  });

  it('unbindCrystal returns crystal to inventory and clears binding', () => {
    const inv = blankInventory();
    (inv as Record<string, number>).mining_crystal_t1 = 0;
    const state = makeState({ inventory: inv });
    state.socketBindings.set('gs.ext.mining-1', 'mining_crystal_t1' as import('./skilltree-graph.js').CrystalId);
    unbindCrystal(state, 'gs.ext.mining-1');
    expect((state.inventory as Record<string, number>).mining_crystal_t1).toBe(1);
    expect(state.socketBindings.has('gs.ext.mining-1')).toBe(false);
  });

  it('unbindCrystal is a no-op on an empty socket', () => {
    const state = makeState();
    unbindCrystal(state, 'gs.ext.mining-1');
    expect(state.socketBindings.has('gs.ext.mining-1')).toBe(false);
  });

  it('unbindCrystal refunds SP for owned mini-tree nodes and edges', () => {
    const inv = blankInventory();
    (inv as Record<string, number>).mining_crystal_t1 = 1;
    const state = makeState({ inventory: inv, unspentSkillPoints: 0 });
    state.socketBindings.set('gs.ext.mining-1', 'mining_crystal_t1' as import('./skilltree-graph.js').CrystalId);
    // Simulate owning two mini-tree nodes and one edge
    state.unlockedNodes.add('gs.ext.mining-1.mining_crystal_t1.core');
    state.unlockedNodes.add('gs.ext.mining-1.mining_crystal_t1.left1');
    state.unlockedEdges.add('gs.ext.mining-1.mining_crystal_t1.edge.socket.core.0' as EdgeId);
    unbindCrystal(state, 'gs.ext.mining-1');
    expect(state.unspentSkillPoints).toBe(3 + 1 + 0); // core=3, left1=1, edge=0
    expect(state.unlockedNodes.has('gs.ext.mining-1.mining_crystal_t1.core')).toBe(false);
    expect(state.unlockedNodes.has('gs.ext.mining-1.mining_crystal_t1.left1')).toBe(false);
    expect(state.unlockedEdges.has('gs.ext.mining-1.mining_crystal_t1.edge.socket.core.0' as EdgeId)).toBe(false);
    expect((state.inventory as Record<string, number>).mining_crystal_t1).toBe(2);
    expect(state.socketBindings.has('gs.ext.mining-1')).toBe(false);
  });

  it('unbindCrystal leaves unrelated nodes and edges untouched', () => {
    const inv = blankInventory();
    (inv as Record<string, number>).mining_crystal_t1 = 1;
    const state = makeState({ inventory: inv, unspentSkillPoints: 5 });
    state.socketBindings.set('gs.ext.mining-1', 'mining_crystal_t1' as import('./skilltree-graph.js').CrystalId);
    state.unlockedNodes.add('mining.1');
    state.unlockedNodes.add('gs.ext.mining-1.mining_crystal_t1.core');
    state.unlockedEdges.add('some.edge' as EdgeId);
    unbindCrystal(state, 'gs.ext.mining-1');
    expect(state.unlockedNodes.has('mining.1')).toBe(true);
    expect(state.unlockedEdges.has('some.edge' as EdgeId)).toBe(true);
    expect(state.unspentSkillPoints).toBe(5 + 3);
  });

  it('bindCrystal refunds SP and clears nodes when replacing a previous crystal', () => {
    const inv = blankInventory();
    (inv as Record<string, number>).mining_crystal_t1 = 1;
    (inv as Record<string, number>).mining_crystal_t2 = 1;
    const state = makeState({ inventory: inv, unspentSkillPoints: 0 });
    bindCrystal(state, 'gs.ext.mining-1', 'mining_crystal_t1' as import('./skilltree-graph.js').CrystalId);
    state.unlockedNodes.add('gs.ext.mining-1.mining_crystal_t1.core');
    state.unlockedNodes.add('gs.ext.mining-1.mining_crystal_t1.left1');

    bindCrystal(state, 'gs.ext.mining-1', 'mining_crystal_t2' as import('./skilltree-graph.js').CrystalId);
    expect(state.unspentSkillPoints).toBe(3 + 1); // refunded from t1
    expect(state.unlockedNodes.has('gs.ext.mining-1.mining_crystal_t1.core')).toBe(false);
    expect(state.unlockedNodes.has('gs.ext.mining-1.mining_crystal_t1.left1')).toBe(false);
    expect((state.inventory as Record<string, number>).mining_crystal_t1).toBe(1);
    expect((state.inventory as Record<string, number>).mining_crystal_t2).toBe(0);
    expect(state.socketBindings.get('gs.ext.mining-1')).toBe('mining_crystal_t2');
  });

  it('re-binding the same crystal after unbind restores cleanly without state corruption', () => {
    const inv = blankInventory();
    (inv as Record<string, number>).mining_crystal_t1 = 1;
    const state = makeState({ inventory: inv, unspentSkillPoints: 0 });
    bindCrystal(state, 'gs.ext.mining-1', 'mining_crystal_t1' as import('./skilltree-graph.js').CrystalId);
    state.unlockedNodes.add('gs.ext.mining-1.mining_crystal_t1.core');
    state.unlockedNodes.add('gs.ext.mining-1.mining_crystal_t1.left1');
    expect((state.inventory as Record<string, number>).mining_crystal_t1).toBe(0);

    unbindCrystal(state, 'gs.ext.mining-1');
    expect((state.inventory as Record<string, number>).mining_crystal_t1).toBe(1);
    expect(state.unlockedNodes.has('gs.ext.mining-1.mining_crystal_t1.core')).toBe(false);
    expect(state.unlockedNodes.has('gs.ext.mining-1.mining_crystal_t1.left1')).toBe(false);

    bindCrystal(state, 'gs.ext.mining-1', 'mining_crystal_t1' as import('./skilltree-graph.js').CrystalId);
    expect((state.inventory as Record<string, number>).mining_crystal_t1).toBe(0);
    expect(state.socketBindings.get('gs.ext.mining-1')).toBe('mining_crystal_t1');
    // Ensure no phantom nodes from the previous binding remain
    expect(state.unlockedNodes.has('gs.ext.mining-1.mining_crystal_t1.core')).toBe(false);
    expect(state.unlockedNodes.has('gs.ext.mining-1.mining_crystal_t1.left1')).toBe(false);
  });
});

describe('effectiveGraph with crystal bindings', () => {
  it('returns DEFAULT_GRAPH reference when there are no bindings', () => {
    const state = makeState();
    expect(effectiveGraph(state)).toBe(DEFAULT_GRAPH);
  });

  it('appends mini-tree nodes and edges with the crystal-id prefix', () => {
    const state = makeState({
      socketBindings: new Map([['gs.ext.mining-1', 'mining_crystal_t1' as import('./skilltree-graph.js').CrystalId]]),
    });
    const g = effectiveGraph(state);
    expect(g.nodes.length).toBeGreaterThan(DEFAULT_GRAPH.nodes.length);
    expect(g.edges.length).toBeGreaterThan(DEFAULT_GRAPH.edges.length);

    const crystal = CRYSTAL_CATALOG.find((c) => c.id === 'mining_crystal_t1')!;
    for (const nodeDef of crystal.nodes) {
      const id = `gs.ext.mining-1.mining_crystal_t1.${nodeDef.idSuffix}`;
      expect(g.nodes.some((n) => n.id === id)).toBe(true);
    }
    for (const edgeDef of crystal.edges) {
      const from = edgeDef.fromSuffix === 'socket' ? 'gs.ext.mining-1' : `gs.ext.mining-1.mining_crystal_t1.${edgeDef.fromSuffix}`;
      const to = edgeDef.toSuffix === 'socket' ? 'gs.ext.mining-1' : `gs.ext.mining-1.mining_crystal_t1.${edgeDef.toSuffix}`;
      expect(g.edges.some((e) => e.from === from && e.to === to)).toBe(true);
    }
  });

  it('includes the synthetic socket node only once per socket', () => {
    const state = makeState({
      socketBindings: new Map([
        ['gs.ext.mining-1', 'mining_crystal_t1' as import('./skilltree-graph.js').CrystalId],
      ]),
    });
    const g = effectiveGraph(state);
    const socketNodes = g.nodes.filter((n) => n.id === 'gs.ext.mining-1');
    expect(socketNodes.length).toBe(1);
  });
});
