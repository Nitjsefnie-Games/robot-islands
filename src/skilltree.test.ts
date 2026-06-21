// Pure-logic tests for the skill tree (§9.3) — tier mapping, depth gating,
// spend validation (already-owned / insufficient points / tier-locked /
// depth-prereq / branch-locked), spend mutation, and effect aggregation.

import { describe, expect, it } from 'vitest';

import type { IslandState } from './economy.js';
import { ALL_RESOURCES, type RecipeCategory, type ResourceId } from './recipes.js';
import {
  bindCrystal,
  buyKeystone,
  buyNode,
  canBuyKeystone,
  canSpend,
  clearSkillMultipliersMemoForTests,
  computeMiniTreeRefund,
  costForDepth,
  costToUnlock,
  cumulativeSkillPointsForLevel,
  effectiveGraph,
  effectiveSkillMultipliers,
  formatNodeMagnitude,
  hasPickableSkill,
  launchSuccessBonus,
  NODE_CATALOG,
  nodePurchaseStatus,
  skillPointsForLevelUp,
  spentInBranch,
  t5Unlocked,
  t6Unlocked,
  effectiveIslandTier,
  tierForLevel,
  type SkillNode,
  type NodeId,
  type SubPathId,
  unbindCrystal,
} from './skilltree.js';
import { KEYSTONE_PREREQS } from './skilltree-catalog.js';
import { CRYSTAL_CATALOG } from './skilltree-crystals.js';
import type { Edge, EdgeId, BridgeEdge, Graph, KeystonePrereq, NodeId as GNodeId } from './skilltree-graph.js';
import { DEFAULT_GRAPH } from './skilltree.js';
import { executeTierReset } from './tier-reset.js';

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
  { id: 'drilling.1', subPath: 'drilling', depth: 1, cost: 1, magnitude: 0.05, effect: { kind: 'drillYieldBonusMul' }, description: '' },
  { id: 'drilling.2', subPath: 'drilling', depth: 2, cost: 2, magnitude: 0.10, effect: { kind: 'drillYieldBonusMul' }, description: '' },
  { id: 'aquaculture.1', subPath: 'aquaculture', depth: 1, cost: 1, magnitude: 0.05, effect: { kind: 'aquacultureYieldBonusMul' }, description: '' },
  { id: 'patronage.1', subPath: 'patronage', depth: 1, cost: 1, magnitude: 0.05, effect: { kind: 'patronageYieldBonusMul' }, description: '' },
  { id: 'oceanography.1', subPath: 'oceanography', depth: 1, cost: 1, magnitude: 0.05, effect: { kind: 't5ExtractorYieldBonusMul' }, description: '' },
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
    auraAmpVersion: 0,
    auraAmpCache: null,
    auraAmpCacheVersion: -1,
    co2Kg: 0,
    funnelPending: blankFunnel(),
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
    everProduced: new Set(),
    tradeCooldownMs: 0,
    tradeAcceptCount: 0,
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
  const specWithoutSpaceport = { buildings: [{ defId: 'iron_mine' }] };
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
    const spec = { buildings: [{ defId: 'iron_mine' }, { defId: 'spaceport' }, { defId: 'workshop' }] };
    expect(t6Unlocked({ ascendantCoreCrafted: true }, spec)).toBe(true);
  });
});

describe('effectiveIslandTier (#134 UI T6 surfacing)', () => {
  const withSpaceport = { buildings: [{ defId: 'spaceport' }] };
  const noSpaceport = { buildings: [{ defId: 'iron_mine' }] };

  it('promotes to T6 when t6Unlocked (Ascendant Core + Spaceport)', () => {
    expect(effectiveIslandTier({ level: 50, ascendantCoreCrafted: true }, withSpaceport)).toBe(6);
  });

  it('falls back to the level band when T6 is not unlocked', () => {
    // ascendant core but no spaceport → still the level-band tier (5 at L50).
    expect(effectiveIslandTier({ level: 50, ascendantCoreCrafted: true }, noSpaceport)).toBe(5);
    // spaceport but no ascendant core → level band.
    expect(effectiveIslandTier({ level: 50, ascendantCoreCrafted: false }, withSpaceport)).toBe(5);
    // neither → level band at lower levels too.
    expect(effectiveIslandTier({ level: 30, ascendantCoreCrafted: false }, withSpaceport)).toBe(4);
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

describe('skill tree depth', () => {
  it('costForDepth grows as 1.5^(depth-1) (rounded)', () => {
    expect(costForDepth(1)).toBe(1);
    expect(costForDepth(5)).toBe(5); // 1.5^4 = 5.0625 → 5
    expect(costForDepth(10)).toBe(38); // 1.5^9 = 38.44 → 38
    expect(costForDepth(15)).toBe(292); // 1.5^14 = 291.93 → 292
  });

  it('skillPointsForLevelUp: 1.031^L floored, min 1 to keep early-game ungated', () => {
    expect(skillPointsForLevelUp(1)).toBe(1);
    expect(skillPointsForLevelUp(22)).toBe(1); // 1.96 → 1 (last level of the flat-1 plateau)
    expect(skillPointsForLevelUp(23)).toBe(2); // 2.02 → 2 (first level that grants 2)
    expect(skillPointsForLevelUp(50)).toBe(4); // 4.60 → 4
    expect(skillPointsForLevelUp(70)).toBe(8); // 8.47 → 8
    expect(skillPointsForLevelUp(100)).toBe(21); // 21.18 → 21
  });

  it('cumulativeSkillPointsForLevel: monotonic, matches expected sums at key levels', () => {
    expect(cumulativeSkillPointsForLevel(0)).toBe(0);
    expect(cumulativeSkillPointsForLevel(5)).toBe(5);   // five L1=1 grants
    expect(cumulativeSkillPointsForLevel(22)).toBe(22); // entire flat-1 plateau
    // Higher landmarks under the 1.031^L curve:
    expect(cumulativeSkillPointsForLevel(50)).toBeGreaterThan(80);
    expect(cumulativeSkillPointsForLevel(50)).toBeLessThan(120);
    expect(cumulativeSkillPointsForLevel(100)).toBeGreaterThan(550);
    expect(cumulativeSkillPointsForLevel(100)).toBeLessThan(700);
  });

  it('full sub-path cost (sum d1..d15) lands ~870 points, reachable around L110', () => {
    let totalCost = 0;
    for (let d = 1; d <= 15; d++) totalCost += costForDepth(d);
    // Whole sub-path is between 800 and 950 under the 1.5 ramp.
    expect(totalCost).toBeGreaterThan(800);
    expect(totalCost).toBeLessThan(950);
    // L111's cumulative grant first covers one sub-path's worth.
    expect(cumulativeSkillPointsForLevel(111)).toBeGreaterThan(totalCost);
    // L100 is still short (sub-path takes ~L111 under 1.031^L).
    expect(cumulativeSkillPointsForLevel(100)).toBeLessThan(totalCost);
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
    expect(m.powerProduction).toBe(1);
  });

  it('parallel work in different branches is allowed', () => {
    // After working the mining branch (efficientDrills 3 + deepVein 4 = 7
    // spent), 3 points remain — enough for the cheapest notables in other
    // branches (cost 3). canSpend gates on points + availability, not branch.
    const s = makeState({
      level: 50,
      unspentSkillPoints: 3,
      unlockedNodes: new Set(['mining.notable.efficientDrills', 'mining.notable.deepVein']),
    });
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
    expect(m.powerProduction).toBe(1);
    expect(m.powerConsumption).toBe(1);
  });

  it('applies a single mining.1 as extraction +5%', () => {
    const s = makeState({ unlockedNodes: new Set(['mining.1']) });
    const m = effectiveSkillMultipliers(s, LG);
    expect(m.recipeRate.extraction).toBeCloseTo(1.05, 9);
    expect(m.recipeRate.smelting).toBe(1);
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
  });

  it('robotics.1 boosts constructionTime; robotics.2 adds a parallel build slot', () => {
    const s = makeState({ unlockedNodes: new Set(['robotics.1', 'robotics.2']) });
    const m = effectiveSkillMultipliers(s, LG);
    expect(m.constructionTime).toBeCloseTo(1.05, 9);
    expect(m.parallelBuildBonus).toBeCloseTo(0.10, 9);
    expect(m.maintenanceThreshold).toBe(1);
    expect(m.recipeRate.extraction).toBe(1);
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

  it('drilling nodes fold into drillYieldBonus multiplicatively', () => {
    const s1 = makeState({ unlockedNodes: new Set(['drilling.1']) });
    const m1 = effectiveSkillMultipliers(s1, LG);
    expect(m1.drillYieldBonus).toBeCloseTo(1.05, 9);
    expect(m1.aquacultureYieldBonus).toBe(1);
    const s2 = makeState({ unlockedNodes: new Set(['drilling.1', 'drilling.2']) });
    const m2 = effectiveSkillMultipliers(s2, LG);
    expect(m2.drillYieldBonus).toBeCloseTo(1.155, 9);
  });

  it('aquaculture node folds into aquacultureYieldBonus', () => {
    const s = makeState({ unlockedNodes: new Set(['aquaculture.1']) });
    const m = effectiveSkillMultipliers(s, LG);
    expect(m.aquacultureYieldBonus).toBeCloseTo(1.05, 9);
    expect(m.drillYieldBonus).toBe(1);
    expect(m.patronageYieldBonus).toBe(1);
  });

  it('patronage node folds into patronageYieldBonus', () => {
    const s = makeState({ unlockedNodes: new Set(['patronage.1']) });
    const m = effectiveSkillMultipliers(s, LG);
    expect(m.patronageYieldBonus).toBeCloseTo(1.05, 9);
    expect(m.t5ExtractorYieldBonus).toBe(1);
  });

  it('oceanography node folds into t5ExtractorYieldBonus', () => {
    const s = makeState({ unlockedNodes: new Set(['oceanography.1']) });
    const m = effectiveSkillMultipliers(s, LG);
    expect(m.t5ExtractorYieldBonus).toBeCloseTo(1.05, 9);
    expect(m.drillYieldBonus).toBe(1);
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
  });

  it('recipeInputMul nodes fold multiplicatively into recipeInputMul (1.2 × 1.1 = 1.32)', () => {
    const LG_RIM: SkillNode[] = [
      { id: 'rim.1', subPath: 'chemistry', depth: 1, cost: 1, magnitude: 0.20,
        effect: { kind: 'recipeInputMul', reduce: true }, description: '' },
      { id: 'rim.2', subPath: 'chemistry', depth: 2, cost: 2, magnitude: 0.10,
        effect: { kind: 'recipeInputMul', reduce: true }, description: '' },
    ];
    const s = makeState({ unlockedNodes: new Set(['rim.1', 'rim.2']) });
    const mul = effectiveSkillMultipliers(s, { nodes: LG_RIM, edges: [], bridges: [], graftSockets: [] } as Graph);
    expect(mul.recipeInput).toBeCloseTo(1.32, 5);
    expect(mul.powerConsumption).toBe(1); // negative assertion: cross-contamination guard
  });
});

describe('effectiveSkillMultipliers memo (§perf-2026-06-10)', () => {
  // The memo engages only for DEFAULT_GRAPH (transient/test graphs take the
  // uncached fold path — covered by every LG test above), so these tests
  // unlock REAL catalog nodes. Picks are derived from the live catalog:
  // aura-less recipeRateMul nodes. With no aura SOURCE owned, every aura
  // amp is 1, so the expected fold is the plain per-category product of
  // (1 + magnitude) over owned nodes — derived, no hardcoded catalog values.
  interface RateNodePick { id: string; category: RecipeCategory; magnitude: number }
  function pickRateNode(skip: ReadonlySet<string> = new Set()): RateNodePick {
    for (const n of NODE_CATALOG) {
      if (n.effect.kind === 'recipeRateMul' && n.aura === undefined && !skip.has(n.id)) {
        return { id: n.id, category: n.effect.category, magnitude: n.magnitude };
      }
    }
    throw new Error('catalog has no aura-less recipeRateMul node');
  }
  const nodeA = pickRateNode();
  const nodeB = pickRateNode(new Set([nodeA.id]));
  /** Expected fold for `cat` given owned aura-less rate nodes (amps all 1). */
  function expectedFor(cat: RecipeCategory, owned: ReadonlyArray<RateNodePick>): number {
    return owned.filter((n) => n.category === cat).reduce((acc, n) => acc * (1 + n.magnitude), 1);
  }

  it('repeat calls on the same state return equal values (warm hit ≡ cold fold)', () => {
    clearSkillMultipliersMemoForTests();
    const s = makeState({ unlockedNodes: new Set([nodeA.id]) });
    const cold = effectiveSkillMultipliers(s); // builds the memo entry
    const warm = effectiveSkillMultipliers(s); // serves the memo entry
    expect(warm).toEqual(cold);
    // Derived: one aura-less node, amp 1 → 1 + magnitude on its category.
    expect(warm.recipeRate[nodeA.category]).toBeCloseTo(1 + nodeA.magnitude, 9);
    // A genuinely cold re-fold (memo reset) agrees with the warm read.
    clearSkillMultipliersMemoForTests();
    expect(effectiveSkillMultipliers(s)).toEqual(warm);
  });

  it('returns a fresh clone each call — mutating result A does not affect result B', () => {
    clearSkillMultipliersMemoForTests();
    const s = makeState({ unlockedNodes: new Set([nodeA.id]) });
    const a = effectiveSkillMultipliers(s);
    const b = effectiveSkillMultipliers(s);
    expect(b).not.toBe(a);
    expect(b.recipeRate).not.toBe(a.recipeRate);
    // layerConditionalBonuses-style in-place mutation of A's nested records…
    (a.recipeRate as Record<string, number>)[nodeA.category] = 999;
    (a.storageCategoryCap as Record<string, number>)['rare'] = 999;
    (a.xpGainByCategory as Record<string, number>)[nodeA.category] = 999;
    // …must not reach B, nor poison the memo's private master for later reads.
    expect(b.recipeRate[nodeA.category]).toBeCloseTo(1 + nodeA.magnitude, 9);
    const c = effectiveSkillMultipliers(s);
    expect(c.recipeRate[nodeA.category]).toBeCloseTo(1 + nodeA.magnitude, 9);
    expect(c.storageCategoryCap.rare).toBe(1);
    expect(c.xpGainByCategory[nodeA.category]).toBe(1);
  });

  it('unlocking another node invalidates (signature catches a direct Set add, no version bump)', () => {
    clearSkillMultipliersMemoForTests();
    const s = makeState({ unlockedNodes: new Set([nodeA.id]) });
    const before = effectiveSkillMultipliers(s);
    expect(before.recipeRate[nodeA.category]).toBeCloseTo(1 + nodeA.magnitude, 9);
    // Direct Set mutation WITHOUT bumping auraAmpVersion — the content
    // signature alone must catch it (self-validating; no bump-site to miss).
    // Aura-less picks keep the stale Layer-2 aura cache harmless (`?? 1`),
    // exactly as the unmemoized fold behaved.
    s.unlockedNodes.add(nodeB.id);
    const after = effectiveSkillMultipliers(s);
    // Derived: per-category product of (1 + magnitude) over the two nodes.
    expect(after.recipeRate[nodeA.category]).toBeCloseTo(expectedFor(nodeA.category, [nodeA, nodeB]), 9);
    expect(after.recipeRate[nodeB.category]).toBeCloseTo(expectedFor(nodeB.category, [nodeA, nodeB]), 9);
  });

  it('tier-reset-style shrink of unlockedNodes invalidates (the set does not "only grow")', () => {
    clearSkillMultipliersMemoForTests();
    const s = makeState({ unlockedNodes: new Set([nodeA.id, nodeB.id]) });
    const full = effectiveSkillMultipliers(s);
    expect(full.recipeRate[nodeA.category]).toBeCloseTo(expectedFor(nodeA.category, [nodeA, nodeB]), 9);
    // §9.7 Tier Reset removes nodes and bumps auraAmpVersion (tier-reset.ts)
    // — mirror that sanctioned-mutation contract here.
    s.unlockedNodes.delete(nodeB.id);
    s.auraAmpVersion++;
    const shrunk = effectiveSkillMultipliers(s);
    expect(shrunk.recipeRate[nodeA.category]).toBeCloseTo(expectedFor(nodeA.category, [nodeA]), 9);
    expect(shrunk.recipeRate[nodeB.category]).toBeCloseTo(expectedFor(nodeB.category, [nodeA]), 9);
  });

  it('two states with the same id keep independent entries (WeakMap keyed on object identity)', () => {
    clearSkillMultipliersMemoForTests();
    const s1 = makeState({ unlockedNodes: new Set([nodeA.id]) }); // id 'test'
    const s2 = makeState(); // same id 'test', empty unlock set
    const m1 = effectiveSkillMultipliers(s1);
    expect(m1.recipeRate[nodeA.category]).toBeCloseTo(1 + nodeA.magnitude, 9);
    const m2 = effectiveSkillMultipliers(s2);
    expect(m2.recipeRate[nodeA.category]).toBe(1);
    // s2's read must not have evicted or shadowed s1's entry.
    expect(effectiveSkillMultipliers(s1).recipeRate[nodeA.category]).toBeCloseTo(1 + nodeA.magnitude, 9);
  });
});

describe('§14.7 launchSuccessBonus', () => {
  it('returns 0 for an island with no unlocked nodes', () => {
    const s = makeState();
    expect(launchSuccessBonus(s, LG)).toBe(0);
  });

  it('returns 0.05 when only launch.1 is unlocked', () => {
    const s = makeState({ unlockedNodes: new Set(['launch.1']) });
    expect(launchSuccessBonus(s, LG)).toBe(0.05);
  });

  it('launch.2 contributes pad-explosion mitigation, NOT launchSuccess (spec themes split)', () => {
    const s = makeState({ unlockedNodes: new Set(['launch.1', 'launch.2']) });
    expect(launchSuccessBonus(s, LG)).toBe(0.05);
    const m = effectiveSkillMultipliers(s, LG);
    expect(m.padExplosionReduce).toBeCloseTo(1.10, 9);
  });

  it('returns 0 when only non-launch nodes are unlocked', () => {
    const s = makeState({ unlockedNodes: new Set(['mining.1']) });
    expect(launchSuccessBonus(s, LG)).toBe(0);
  });
});

describe('hasPickableSkill', () => {
  it('returns false for a fresh island with zero points', () => {
    const state = makeState({ level: 1, unspentSkillPoints: 0 });
    expect(hasPickableSkill(state)).toBe(false);
  });

  it('returns false when affordable nodes are all tier-locked (low level)', () => {
    // The bug: at level 1 (tier 1) every node is below its required tier, so a
    // pile of SP still buys nothing — the HUD must not advertise "skills
    // available". canSpend (flat-cost only) still says ok; hasPickableSkill,
    // which the HUD reads, must apply the depth→tier gate and report false.
    const state = makeState({ level: 1, unspentSkillPoints: 999 });
    expect(NODE_CATALOG.some((n) => canSpend(state, n.id).ok)).toBe(true);
    expect(hasPickableSkill(state)).toBe(false);
  });

  it('returns true when an affordable node is also tier-eligible', () => {
    const state = makeState({ level: 50, unspentSkillPoints: 999 });
    expect(hasPickableSkill(state)).toBe(true);
  });

  it('declaration-pending alone does NOT flip the predicate true', () => {
    const state = makeState({
      level: 15,
      unspentSkillPoints: 0,
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

  // All test nodes are depth 1 (tier-2 floor → level ≥ 5). costToUnlock now
  // tier-filters by state.level, so the duck-typed state carries a tier-eligible
  // level; otherwise an absent level reads as tier 1 and filters every node out.
  it('finds cheapest path from owned R to Z (= 2+3+5 = 10)', () => {
    const g = mkGraph();
    const owned = new Set(['R']);
    const result = costToUnlock(g, owned, new Set(), { unlockedNodes: owned, level: 15 } as any, 'Z');
    expect(result).not.toBeNull();
    expect(result!.totalCost).toBe(10);
    expect(result!.path.map((e) => e.id)).toEqual(['e_RA', 'e_AX', 'e_XZ']);
  });

  it('uses owned A as a starting frontier (cost = A→X→Z = 8)', () => {
    const g = mkGraph();
    const owned = new Set(['R', 'A']);
    const result = costToUnlock(g, owned, new Set(), { unlockedNodes: owned, level: 15 } as any, 'Z');
    expect(result).not.toBeNull();
    expect(result!.totalCost).toBe(8);
  });

  it('returns null when no path exists', () => {
    const g = mkGraph();
    const owned = new Set(['R']);
    const result = costToUnlock(g, owned, new Set(), { unlockedNodes: owned, level: 15 } as any, 'NOTREAL');
    expect(result).toBeNull();
  });

  it('walks down a filler chain when a deeper node is already owned', () => {
    const state = makeState({ level: 50, unspentSkillPoints: 100 });
    const target = 'mining.recipeRate.3' as NodeId;
    state.unlockedNodes.add(target);
    state.unlockedNodes.add('mining.recipeRate.2' as NodeId);

    const shallower = 'mining.recipeRate.1' as NodeId;
    const result = costToUnlock(DEFAULT_GRAPH, state.unlockedNodes, state.unlockedEdges, state, shallower);
    expect(result).not.toBeNull();
    expect(result!.totalCost).toBe(1); // depth-1 node cost

    buyNode(DEFAULT_GRAPH, state, shallower);
    expect(state.unlockedNodes.has(shallower)).toBe(true);
    expect(state.unspentSkillPoints).toBe(99);
  });
});

describe('costToUnlock — forward-root entry nodes buy at node cost (§9.3 entry bug)', () => {
  // A filler-chain HEAD has only OUTGOING chain edges (head → .2 → .3 …), so it
  // is a forward-root: a sub-path ENTRY meant to be bought directly at its 1-SP
  // node cost. But chain edges are bidirectional and active bridges are
  // traversable, so Dijkstra can REACH the head by crossing a bridge into the
  // chain and walking back down through a notable — and used to return that
  // expensive path instead of the cheap entry cost. This is the live bug where
  // `smelting.recipeRate.1` priced as a full bridge+notable path.
  function node(id: string, depth: number, cost: number, subPath: SubPathId): SkillNode {
    return {
      id: id as NodeId, subPath, depth, cost, magnitude: 0,
      effect: { kind: 'recipeRateMul', category: 'extraction' }, description: id,
    };
  }
  function bridgedGraph(): Graph {
    const nodes: SkillNode[] = [
      node('far', 1, 1, 'mining'),    // owned frontier, a different sub-path
      node('head', 1, 1, 'smelting'), // chain HEAD — forward-root entry node
      node('head2', 1, 2, 'smelting'),
      node('note', 1, 4, 'smelting'), // notable anchored on the chain
    ];
    const edges: Edge[] = [
      { id: 'e_head_head2' as EdgeId, from: 'head' as GNodeId, to: 'head2' as GNodeId, cost: 2 },
      { id: 'e_head2_note' as EdgeId, from: 'head2' as GNodeId, to: 'note' as GNodeId, cost: 4 },
    ];
    // minSpent 0 → always active, regardless of branch SP.
    const bridges: BridgeEdge[] = [
      {
        id: 'br_far_note' as EdgeId, from: 'far' as GNodeId, to: 'note' as GNodeId,
        cost: 9, mode: 'or', threshold: [{ branch: 'extraction', minSpent: 0 }],
      },
    ];
    return { nodes, edges, bridges, graftSockets: [] } as Graph;
  }

  it('returns the entry node cost (1), not the bridge+notable path (9+2+1=12)', () => {
    const g = bridgedGraph();
    const owned = new Set(['far']);
    const result = costToUnlock(g, owned, new Set(), { unlockedNodes: owned, level: 15 } as any, 'head');
    expect(result).not.toBeNull();
    expect(result!.totalCost).toBe(1);
    expect(result!.path).toHaveLength(0); // bought directly — no path traversed
  });

  it('buyNode charges the entry cost and owns ONLY the head (no bridge intermediates)', () => {
    const g = bridgedGraph();
    const state = makeState({ level: 15, unspentSkillPoints: 10 });
    state.unlockedNodes.add('far');
    buyNode(g, state, 'head');
    expect(state.unlockedNodes.has('head')).toBe(true);
    expect(state.unspentSkillPoints).toBe(9); // 10 - 1, NOT 10 - 12
    expect(state.unlockedNodes.has('note')).toBe(false);
    expect(state.unlockedNodes.has('head2')).toBe(false);
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

  // All mkGraph nodes are depth 1 → tier-2 floor (level ≥ 5). The depth→tier
  // gate is exercised separately below; here we use a tier-2-eligible level so
  // these path/SP assertions test only the cost mechanics, not the gate.
  it('buys Z from R-only state, auto-owns A and X intermediates', () => {
    const g = mkGraph();
    const state = makeState({ level: 5, unspentSkillPoints: 20 });
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
    const state = makeState({ level: 5, unspentSkillPoints: 5 });
    state.unlockedNodes.add('R');
    expect(() => buyNode(g, state, 'Z')).toThrow(/insufficient/);
  });

  it('is a no-op when target is already owned', () => {
    const g = mkGraph();
    const state = makeState({ level: 5, unspentSkillPoints: 10 });
    state.unlockedNodes.add('Z');
    buyNode(g, state, 'Z');
    expect(state.unspentSkillPoints).toBe(10);
  });
});

describe('buyNode — depth→tier gate (§9.3, tierRequiredForDepth)', () => {
  // Depth-graded chain R(1) → M(2) → D3(3) → D4(4). Tier requirements:
  // depth 1/2 → tier 2 (level ≥ 5); depth 3 → tier 3 (level ≥ 15);
  // depth 4 → tier 4 (level ≥ 30).
  function mkNode(id: string, depth: number): SkillNode {
    return {
      id: id as import('./skilltree.js').NodeId,
      subPath: 'mining',
      depth,
      cost: 0,
      magnitude: 0,
      effect: { kind: 'recipeRateMul', category: 'extraction' },
      description: id,
    };
  }

  function mkGraph(): Graph {
    const nodes: SkillNode[] = [
      mkNode('R', 1), mkNode('M', 2), mkNode('D3', 3), mkNode('D4', 4),
    ];
    const edges = [
      { id: 'e_RM' as EdgeId, from: 'R' as import('./skilltree-graph.js').NodeId, to: 'M' as import('./skilltree-graph.js').NodeId, cost: 1 },
      { id: 'e_MD3' as EdgeId, from: 'M' as import('./skilltree-graph.js').NodeId, to: 'D3' as import('./skilltree-graph.js').NodeId, cost: 1 },
      { id: 'e_D3D4' as EdgeId, from: 'D3' as import('./skilltree-graph.js').NodeId, to: 'D4' as import('./skilltree-graph.js').NodeId, cost: 1 },
    ];
    return { nodes, edges, bridges: [], graftSockets: [] } as Graph;
  }

  it('throws when buying a depth-3 node on a tier-2 island (level 14 < 15)', () => {
    const g = mkGraph();
    const state = makeState({ level: 14, unspentSkillPoints: 50 });
    state.unlockedNodes.add('R');
    state.unlockedNodes.add('M');
    expect(() => buyNode(g, state, 'D3')).toThrow(/tier/i);
    // No partial mutation: D3 not owned, SP untouched.
    expect(state.unlockedNodes.has('D3')).toBe(false);
    expect(state.unspentSkillPoints).toBe(50);
  });

  it('succeeds buying a depth-3 node on a tier-3 island (level 15)', () => {
    const g = mkGraph();
    const state = makeState({ level: 15, unspentSkillPoints: 50 });
    state.unlockedNodes.add('R');
    state.unlockedNodes.add('M');
    buyNode(g, state, 'D3');
    expect(state.unlockedNodes.has('D3')).toBe(true);
  });

  it('blocks the whole purchase when an INTERMEDIATE node is under-tier', () => {
    // From R(1) only, buying D3(3) would auto-unlock M(2) and D3(3). At level
    // 14 (tier 2) M is fine but D3 violates → the whole purchase is rejected.
    const g = mkGraph();
    const state = makeState({ level: 14, unspentSkillPoints: 50 });
    state.unlockedNodes.add('R');
    expect(() => buyNode(g, state, 'D3')).toThrow(/tier/i);
    expect(state.unlockedNodes.has('M')).toBe(false);
    expect(state.unspentSkillPoints).toBe(50);
  });

  it('rejects a deeper depth-4 node at tier-3 (level 15 < 30), passing depth-3 first', () => {
    const g = mkGraph();
    const state = makeState({ level: 15, unspentSkillPoints: 50 });
    state.unlockedNodes.add('R');
    state.unlockedNodes.add('M');
    state.unlockedNodes.add('D3');
    expect(() => buyNode(g, state, 'D4')).toThrow(/tier/i);
  });

  it('leaves depth-1/2 nodes purchasable at tier-2 (level 5), while depth-3 throws', () => {
    const g = mkGraph();
    const state = makeState({ level: 5, unspentSkillPoints: 50 });
    state.unlockedNodes.add('R');
    // depth-2 buy is allowed at tier 2.
    buyNode(g, state, 'M');
    expect(state.unlockedNodes.has('M')).toBe(true);
    // depth-3 buy is NOT allowed at tier 2.
    expect(() => buyNode(g, state, 'D3')).toThrow(/tier/i);
  });

  it('root-fallback target is tier-gated too (depth-3 root at low tier throws)', () => {
    // D3root has zero incoming edges → root-fallback path in buyNode.
    const nodes: SkillNode[] = [mkNode('D3root', 3)];
    const g = { nodes, edges: [], bridges: [], graftSockets: [] } as Graph;
    const state = makeState({ level: 14, unspentSkillPoints: 50 });
    expect(() => buyNode(g, state, 'D3root')).toThrow(/tier/i);
    expect(state.unlockedNodes.has('D3root')).toBe(false);
  });
});

describe('depth-8 (T6) gate honours the §14.1 flags (Ascendant Core + Spaceport)', () => {
  // depth 8 → tierRequiredForDepth = 6. T6 has NO level threshold (§14.1): it
  // unlocks via ascendantCoreCrafted + an operational Spaceport. Before the
  // fix the gate compared tierForLevel (max 5) against 6 — never satisfiable.
  const T6_FILLER = 'mining.recipeRate.8';

  function spaceport(): { id: string; defId: 'spaceport'; x: number; y: number } {
    return { id: 'sp1', defId: 'spaceport', x: 0, y: 0 };
  }

  it('sanity: the depth-8 filler exists in the real catalog', () => {
    const node = DEFAULT_GRAPH.nodes.find((n) => n.id === T6_FILLER);
    expect(node).toBeDefined();
    expect(node!.depth).toBe(8);
  });

  it('high level + both T6 flags: depth-8 filler is purchasable end-to-end', () => {
    const state = makeState({
      level: 60,
      unspentSkillPoints: 10_000,
      ascendantCoreCrafted: true,
      buildings: [spaceport() as never],
    });
    buyNode(DEFAULT_GRAPH, state, 'mining.recipeRate.1');
    expect(nodePurchaseStatus(DEFAULT_GRAPH, state, T6_FILLER)).toBe('purchasable');
    buyNode(DEFAULT_GRAPH, state, T6_FILLER);
    expect(state.unlockedNodes.has(T6_FILLER)).toBe(true);
  });

  it('same level without the flags: depth-8 stays tier-locked', () => {
    const state = makeState({ level: 60, unspentSkillPoints: 10_000 });
    buyNode(DEFAULT_GRAPH, state, 'mining.recipeRate.1');
    expect(nodePurchaseStatus(DEFAULT_GRAPH, state, T6_FILLER)).toBe('tier-locked');
    expect(() => buyNode(DEFAULT_GRAPH, state, T6_FILLER)).toThrow(/tier/i);
    expect(
      costToUnlock(DEFAULT_GRAPH, state.unlockedNodes, state.unlockedEdges, state, T6_FILLER),
    ).toBeNull();
  });

  it('ascendant core alone (no Spaceport placed) is not enough', () => {
    const state = makeState({
      level: 60,
      unspentSkillPoints: 10_000,
      ascendantCoreCrafted: true,
    });
    buyNode(DEFAULT_GRAPH, state, 'mining.recipeRate.1');
    expect(nodePurchaseStatus(DEFAULT_GRAPH, state, T6_FILLER)).toBe('tier-locked');
    expect(() => buyNode(DEFAULT_GRAPH, state, T6_FILLER)).toThrow(/tier/i);
  });

  it('depths below 8 are unaffected by the T6 flags (depth 7 still wants T5 level)', () => {
    const state = makeState({
      level: 14, // tier 2
      unspentSkillPoints: 10_000,
      ascendantCoreCrafted: true,
      buildings: [spaceport() as never],
    });
    // depth-3 node still tier-locked at level 14 even with T6 flags set.
    expect(() => buyNode(DEFAULT_GRAPH, state, 'mining.recipeRate.3')).toThrow(/tier/i);
  });
});

describe('magic recipeInputMul chain — T3 gate + reachability (real DEFAULT_GRAPH)', () => {
  const MAGIC_ROOT = 'smelting.inputEff.3';

  it('the magic chain root exists in the real catalog at depth 3', () => {
    const node = DEFAULT_GRAPH.nodes.find((n) => n.id === MAGIC_ROOT);
    expect(node, `${MAGIC_ROOT} must exist in DEFAULT_GRAPH`).toBeDefined();
    expect(node!.depth).toBe(3);
    expect(node!.effect.kind).toBe('recipeInputMul');
  });

  it('is a prefix-root: no incoming edge in the real graph (buyable via root-fallback)', () => {
    // Filler-chain edges only link consecutive depths within a prefix
    // (.3→.4→.5→.6) and notable-anchoring never targets a filler node, so the
    // chain's first node has zero incoming edges → isRootNode true.
    const incoming = DEFAULT_GRAPH.edges.filter((e) => e.to === MAGIC_ROOT);
    expect(incoming, `${MAGIC_ROOT} must be orphan-buyable, not dead content`).toHaveLength(0);
  });

  it('REFUSED to buy at level 14 (tier 2 < required tier 3)', () => {
    const state = makeState({ level: 14, unspentSkillPoints: 50 });
    expect(() => buyNode(DEFAULT_GRAPH, state, MAGIC_ROOT)).toThrow(/tier/i);
    expect(state.unlockedNodes.has(MAGIC_ROOT)).toBe(false);
    expect(state.unspentSkillPoints).toBe(50);
  });

  it('SUCCEEDS to buy at level 15 (tier 3) via root-fallback with no prereqs owned', () => {
    const state = makeState({ level: 15, unspentSkillPoints: 50 });
    // Empty unlockedNodes — only a true root can be bought with no path.
    buyNode(DEFAULT_GRAPH, state, MAGIC_ROOT);
    expect(state.unlockedNodes.has(MAGIC_ROOT)).toBe(true);
  });
});

describe('depth-3 notable anchoring (§9.3) — anchored to the depth-2 chain, not a depth-6 tail', () => {
  // These three depth-3/cost-3 notables have no chain matching their effect
  // kind; the alphabetical fallback picked the <subPath>.inputEff chain, which
  // starts at depth 3 — no depth-2 node — so the deepest-node fallback hung
  // them off depth-6 T5-locked tails.
  const FIXED: ReadonlyArray<readonly [string, string]> = [
    ['smelting.notable.refractoryLining', 'smelting'],
    ['chemistry.notable.greenChemistry', 'chemistry'],
    ['electronics.notable.satBandwidth', 'electronics'],
  ];

  for (const [id, subPath] of FIXED) {
    it(`${id}: every anchor edge comes from a depth-2 node`, () => {
      const incoming = DEFAULT_GRAPH.edges.filter((e) => String(e.to) === id);
      expect(incoming.length).toBeGreaterThan(0);
      for (const e of incoming) {
        const from = DEFAULT_GRAPH.nodes.find((n) => n.id === String(e.from));
        expect(from, `anchor source ${String(e.from)} must exist`).toBeDefined();
        expect(from!.depth).toBe(2);
      }
    });

    it(`${id}: purchasable at T3 (level 15) given its depth-1/2 chain owned`, () => {
      const state = makeState({ level: 15, unspentSkillPoints: 100 });
      buyNode(DEFAULT_GRAPH, state, `${subPath}.recipeRate.1`);
      buyNode(DEFAULT_GRAPH, state, `${subPath}.recipeRate.2`);
      buyNode(DEFAULT_GRAPH, state, id);
      expect(state.unlockedNodes.has(id)).toBe(true);
    });
  }

  it('pyroforgeBypass no longer inherits the depth-3 prereq’s T5 anchor lock', () => {
    // Pre-fix, owning refractoryLining forced a walk through the T5-locked
    // inputEff tail (anchor at inputEff.6), so the keystone's depth-3 prereq
    // carried a spurious T5/depth-6 toll. Now the depth-3 prereq is satisfied
    // off the depth-2 chain with no inputEff detour; the keystone unlocks via
    // buyKeystone once the (legitimately depth-5/T5) heatRecapture prereq is
    // also owned.
    const state = makeState({ level: 50, unspentSkillPoints: 200 });
    buyNode(DEFAULT_GRAPH, state, 'smelting.recipeRate.1');
    buyNode(DEFAULT_GRAPH, state, 'smelting.notable.refractoryLining');
    // The depth-3 prereq purchase pulled in NO inputEff node.
    expect([...state.unlockedNodes].some((n) => String(n).includes('.inputEff.'))).toBe(false);
    // heatRecapture (depth 5) legitimately anchors off the inputEff chain,
    // whose first node is an orphan root — buy it, then path to the notable.
    buyNode(DEFAULT_GRAPH, state, 'smelting.inputEff.3');
    buyNode(DEFAULT_GRAPH, state, 'smelting.notable.heatRecapture');
    const ks = KEYSTONE_PREREQS.find(
      (k) => String(k.targetNode) === 'smelting.keystone.pyroforgeBypass',
    )!;
    expect(canBuyKeystone(ks, state)).toBe(true);
    buyKeystone(ks, state);
    expect(state.unlockedNodes.has('smelting.keystone.pyroforgeBypass')).toBe(true);
  });

  it('catalyticMastery no longer inherits the depth-3 prereq’s T5 anchor lock', () => {
    const state = makeState({ level: 50, unspentSkillPoints: 200 });
    buyNode(DEFAULT_GRAPH, state, 'chemistry.recipeRate.1');
    buyNode(DEFAULT_GRAPH, state, 'chemistry.notable.greenChemistry');
    expect([...state.unlockedNodes].some((n) => String(n).includes('.inputEff.'))).toBe(false);
    buyNode(DEFAULT_GRAPH, state, 'chemistry.inputEff.3');
    buyNode(DEFAULT_GRAPH, state, 'chemistry.notable.pressurizedReactors');
    const ks = KEYSTONE_PREREQS.find(
      (k) => String(k.targetNode) === 'chemistry.keystone.catalyticMastery',
    )!;
    expect(canBuyKeystone(ks, state)).toBe(true);
  });
});

describe('costToUnlock — tier-locked nodes excluded at low tier (§9.3)', () => {
  function mkNode(id: string, depth: number): SkillNode {
    return {
      id: id as import('./skilltree.js').NodeId,
      subPath: 'mining',
      depth,
      cost: 0,
      magnitude: 0,
      effect: { kind: 'recipeRateMul', category: 'extraction' },
      description: id,
    };
  }

  function mkGraph(): Graph {
    const nodes: SkillNode[] = [mkNode('R', 1), mkNode('M', 2), mkNode('D3', 3)];
    const edges = [
      { id: 'e_RM' as EdgeId, from: 'R' as import('./skilltree-graph.js').NodeId, to: 'M' as import('./skilltree-graph.js').NodeId, cost: 1 },
      { id: 'e_MD3' as EdgeId, from: 'M' as import('./skilltree-graph.js').NodeId, to: 'D3' as import('./skilltree-graph.js').NodeId, cost: 1 },
    ];
    return { nodes, edges, bridges: [], graftSockets: [] } as Graph;
  }

  it('returns null for a depth-3 target on a tier-2 island (level 14)', () => {
    const g = mkGraph();
    const owned = new Set(['R']);
    const state = makeState({ level: 14 });
    state.unlockedNodes = owned as Set<import('./skilltree.js').NodeId>;
    const result = costToUnlock(g, owned, new Set(), state, 'D3');
    expect(result).toBeNull();
  });

  it('finds the depth-3 path once the island is tier 3 (level 15)', () => {
    const g = mkGraph();
    const owned = new Set(['R']);
    const state = makeState({ level: 15 });
    state.unlockedNodes = owned as Set<import('./skilltree.js').NodeId>;
    const result = costToUnlock(g, owned, new Set(), state, 'D3');
    expect(result).not.toBeNull();
    expect(result!.path.map((e) => e.id)).toEqual(['e_RM', 'e_MD3']);
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

  it('aura amplifies ADDITIVE effect contributions too (§9.3 — no additive carve-out)', () => {
    const mk = (id: string, effect: SkillNode['effect'], magnitude: number): SkillNode => ({
      id: id as import('./skilltree.js').NodeId,
      subPath: 'robotics', depth: 1, cost: 1, magnitude, effect, description: '',
    });
    const nodes: SkillNode[] = [
      { ...mk('auraSrc', { kind: 'recipeRateMul', category: 'extraction' }, 0), aura: { radius: 1, bonus: 0.2 } },
      mk('pb', { kind: 'parallelBuildCapAdd' }, 0.5),
      mk('qc', { kind: 'queueCapAdd' }, 0.5),
      mk('tr', { kind: 'tradeReachAdd' }, 1),
      mk('ts', { kind: 'tradeSpreadShiftAdd' }, 0.05),
    ];
    const edges = ['pb', 'qc', 'tr', 'ts'].map((to, i) => ({
      id: `e${i}` as EdgeId,
      from: 'auraSrc' as import('./skilltree-graph.js').NodeId,
      to: to as import('./skilltree-graph.js').NodeId,
      cost: 1,
    }));
    const g: Graph = { nodes, edges, bridges: [], graftSockets: [] } as Graph;
    const state = makeState();
    for (const n of nodes) state.unlockedNodes.add(n.id);
    const mul = effectiveSkillMultipliers(state, g);
    expect(mul.parallelBuildBonus).toBeCloseTo(0.5 * 1.2, 9);
    expect(mul.queueCapBonus).toBeCloseTo(0.5 * 1.2, 9);
    expect(mul.tradeReachAdd).toBeCloseTo(1 * 1.2, 9);
    expect(mul.tradeSpreadShiftAdd).toBeCloseTo(0.05 * 1.2, 9);
  });
});

describe('launchSuccessBonus — aura amplification (§9.3 / §14.7)', () => {
  it('padRedundancy aura amplifies an adjacent owned launch-success node', () => {
    const padId = 'launch.notable.padRedundancy';
    const pad = DEFAULT_GRAPH.nodes.find((n) => n.id === padId)!;
    expect(pad).toBeDefined();
    expect(pad.aura).toBeDefined();
    expect(pad.effect.kind).toBe('launchSuccessAdditive');

    // The notable's anchor edge ties it into its sub-path chain — that chain
    // node is its aura-adjacent neighbour.
    const anchorEdge = DEFAULT_GRAPH.edges.find(
      (e) => String(e.to) === padId && e.mode !== 'and',
    )!;
    expect(anchorEdge).toBeDefined();
    const anchor = DEFAULT_GRAPH.nodes.find((n) => n.id === String(anchorEdge.from))!;
    expect(anchor.effect.kind).toBe('launchSuccessAdditive');

    const s = makeState({ unlockedNodes: new Set([padId, anchor.id]) });
    const bonus = launchSuccessBonus(s);
    const expected = pad.magnitude + anchor.magnitude * (1 + pad.aura!.bonus);
    expect(bonus).toBeCloseTo(expected, 9);
    // Strictly more than the raw, un-amplified sum — the aura must do something.
    expect(bonus).toBeGreaterThan(pad.magnitude + anchor.magnitude);
  });
});

// Picked these IDs from the catalog because mining.notable.blastOptimization
// has an aura (radius 2, bonus 0.12) and anchors to the mining.recipeRate
// chain, making mining.recipeRate.5 its spatial neighbour. Unlocking the
// notable therefore both adds its own recipeRateMul and amplifies the
// adjacent filler node's factor, producing a measurable change in
// recipeRate.extraction.
describe('computeAuraAmplifiers — cache', () => {
  it('reflects new aura node after unlock + version bump', () => {
    const s = makeState();
    s.unlockedNodes.add('mining.recipeRate.5' as import('./skilltree.js').NodeId);
    // Warm the cache.
    const beforeMul = effectiveSkillMultipliers(s).recipeRate.extraction;
    // Mutate directly — explicit version bump simulates what buyNode does
    // automatically in production. (The spec's risk analysis notes this
    // pattern.)
    s.unlockedNodes.add('mining.notable.blastOptimization' as import('./skilltree.js').NodeId);
    s.auraAmpVersion++;
    const afterMul = effectiveSkillMultipliers(s).recipeRate.extraction;
    expect(afterMul).toBeGreaterThan(beforeMul);
  });

  it('returns the same Map instance on repeat calls without mutation', () => {
    const s = makeState();
    s.unlockedNodes.add('mining.recipeRate.5' as import('./skilltree.js').NodeId);
    s.unlockedNodes.add('mining.notable.blastOptimization' as import('./skilltree.js').NodeId);
    // Warm.
    effectiveSkillMultipliers(s);
    const cachedMap = s.auraAmpCache;
    expect(cachedMap).not.toBeNull();
    // Second call — no mutation, no bump → cache hit.
    effectiveSkillMultipliers(s);
    expect(s.auraAmpCache).toBe(cachedMap);
  });

  it('returns deep-equal effectiveSkillMultipliers on repeat calls', () => {
    const s = makeState();
    s.unlockedNodes.add('mining.recipeRate.5' as import('./skilltree.js').NodeId);
    s.unlockedNodes.add('mining.notable.blastOptimization' as import('./skilltree.js').NodeId);
    const m1 = effectiveSkillMultipliers(s);
    const m2 = effectiveSkillMultipliers(s);
    expect(m1.recipeRate).toEqual(m2.recipeRate);
  });

  it('does not poison auraAmpCache when called with a transient graph (UI path)', () => {
    const s = makeState();
    s.unlockedNodes.add('mining.recipeRate.5' as import('./skilltree.js').NodeId);
    s.unlockedNodes.add('mining.notable.blastOptimization' as import('./skilltree.js').NodeId);

    // Warm the cache with DEFAULT_GRAPH first.
    effectiveSkillMultipliers(s);
    const warmCache = s.auraAmpCache;
    const warmVersion = s.auraAmpCacheVersion;
    expect(warmCache).not.toBeNull();

    // Now construct a transient Graph (NOT DEFAULT_GRAPH identity).
    const transient: Graph = {
      nodes: DEFAULT_GRAPH.nodes,
      edges: DEFAULT_GRAPH.edges,
      bridges: DEFAULT_GRAPH.bridges,
      graftSockets: DEFAULT_GRAPH.graftSockets,
    };
    expect(transient).not.toBe(DEFAULT_GRAPH); // sanity: different reference

    // Compute via the transient graph — must NOT touch state.auraAmpCache.
    effectiveSkillMultipliers(s, transient);

    expect(s.auraAmpCache).toBe(warmCache);              // still same instance
    expect(s.auraAmpCacheVersion).toBe(warmVersion);     // still same version stamp
  });

  it('post-deserialize state starts with cold cache (auraAmpCache=null, cacheVersion=-1)', () => {
    // Build a populated state, warm its cache.
    const s = makeState();
    s.unlockedNodes.add('mining.notable.blastOptimization' as import('./skilltree.js').NodeId);
    effectiveSkillMultipliers(s);
    expect(s.auraAmpCache).not.toBeNull();

    // Round-trip through persistence via the same destructure pattern used in serializeWorld / deserializeWorld.
    const { unlockedNodes, unlockedEdges, socketBindings,
            auraAmpVersion: _v, auraAmpCache: _c, auraAmpCacheVersion: _cv,
            ...rest } = s;
    const serialized = {
      ...rest,
      unlockedNodes: [...unlockedNodes],
      unlockedEdges: [...unlockedEdges],
      socketBindings: [...socketBindings.entries()],
    };
    const restored = {
      ...serialized,
      unlockedNodes: new Set(serialized.unlockedNodes),
      unlockedEdges: new Set(serialized.unlockedEdges),
      socketBindings: new Map(serialized.socketBindings),
      auraAmpVersion: 0,
      auraAmpCache: null,
      auraAmpCacheVersion: -1,
    co2Kg: 0,
    } as IslandState;

    // The restored state must have a cold cache.
    expect(restored.auraAmpCache).toBeNull();
    expect(restored.auraAmpCacheVersion).toBe(-1);

    // First call after load: must compute fresh (cache miss), then store.
    effectiveSkillMultipliers(restored);
    expect(restored.auraAmpCache).not.toBeNull();
    expect(restored.auraAmpCacheVersion).toBe(restored.auraAmpVersion);
  });

  it('executeTierReset bumps the cache version so post-reset reads recompute', () => {
    const s = makeState();
    s.unlockedNodes.add('mining.recipeRate.5' as import('./skilltree.js').NodeId);
    s.unlockedNodes.add('mining.notable.blastOptimization' as import('./skilltree.js').NodeId);

    // Warm: post-unlock recipeRate.extraction should be elevated.
    const beforeReset = effectiveSkillMultipliers(s).recipeRate.extraction;
    const baseline = effectiveSkillMultipliers(makeState()).recipeRate.extraction;
    expect(beforeReset).toBeGreaterThan(baseline);

    // Reset. The function clears unlockedNodes + unlockedEdges and bumps.
    executeTierReset(s, /* nowMs */ 0);

    const afterReset = effectiveSkillMultipliers(s).recipeRate.extraction;
    expect(afterReset).toBe(baseline);
  });
});

describe('keystone AND-prereqs enforced against pathing (§9.3)', () => {
  // Real catalog keystone: mining.keystone.deepCore requires deepVein (depth 4)
  // AND efficientDrills (depth 3); flat cost 8. §9.3: "even if a path exists,
  // the keystone stays locked until every prereq is satisfied" — keystones are
  // bought ONLY via buyKeystone, never via the Dijkstra path solver.
  const KS_ID = 'mining.keystone.deepCore';

  it('with 1-of-2 prereqs owned: unreachable via pathing, buyNode throws, status locked', () => {
    const state = makeState({ level: 50, unspentSkillPoints: 1000 });
    state.unlockedNodes.add('mining.notable.deepVein');
    expect(
      costToUnlock(DEFAULT_GRAPH, state.unlockedNodes, state.unlockedEdges, state, KS_ID),
    ).toBeNull();
    expect(() => buyNode(DEFAULT_GRAPH, state, KS_ID)).toThrow(/unreachable/);
    expect(state.unlockedNodes.has(KS_ID)).toBe(false);
    expect(nodePurchaseStatus(DEFAULT_GRAPH, state, KS_ID)).toBe('unreachable');
  });

  it('reachable at a keystone endpoint through an active cross-branch bridge', () => {
    const state = makeState({ level: 70, unspentSkillPoints: 100000 });
    for (const n of DEFAULT_GRAPH.nodes) {
      if (n.id !== KS_ID) state.unlockedNodes.add(n.id);
    }
    for (const e of DEFAULT_GRAPH.edges) state.unlockedEdges.add(e.id);
    // With every other node owned, the oceanography→mining cross-branch bridge
    // is active and ends at this keystone. costToUnlock may return that bridge
    // path; buyKeystone remains the canonical purchase path for keystones.
    const result = costToUnlock(DEFAULT_GRAPH, state.unlockedNodes, state.unlockedEdges, state, KS_ID);
    expect(result).not.toBeNull();
    expect(result!.totalCost).toBe(12); // br.cross.oceanography-mining cost
    expect(result!.path[result!.path.length - 1]!.to).toBe(KS_ID);
  });

  it('with all prereqs owned: purchasable at the flat keystone cost via buyKeystone', () => {
    const state = makeState({ level: 50, unspentSkillPoints: 10 });
    state.unlockedNodes.add('mining.notable.deepVein');
    state.unlockedNodes.add('mining.notable.efficientDrills');
    expect(nodePurchaseStatus(DEFAULT_GRAPH, state, KS_ID)).toBe('purchasable');
    const ks = KEYSTONE_PREREQS.find((k) => String(k.targetNode) === KS_ID)!;
    expect(canBuyKeystone(ks, state)).toBe(true);
    buyKeystone(ks, state);
    expect(state.unlockedNodes.has(KS_ID)).toBe(true);
    expect(state.unspentSkillPoints).toBe(10 - ks.cost);
  });

  it('with all prereqs owned but SP short: insufficient-sp, not unreachable', () => {
    const ks = KEYSTONE_PREREQS.find((k) => String(k.targetNode) === KS_ID)!;
    const state = makeState({ level: 50, unspentSkillPoints: ks.cost - 1 });
    state.unlockedNodes.add('mining.notable.deepVein');
    state.unlockedNodes.add('mining.notable.efficientDrills');
    expect(nodePurchaseStatus(DEFAULT_GRAPH, state, KS_ID)).toBe('insufficient-sp');
    expect(canBuyKeystone(ks, state)).toBe(false);
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

  it('bindCrystal rejects an ineligible socket/crystal pairing (§9.3)', () => {
    const inv = blankInventory();
    (inv as Record<string, number>).mining_crystal_t1 = 1;
    const state = makeState({ inventory: inv });
    expect(() =>
      bindCrystal(state, 'gs.ref.smelting-1', 'mining_crystal_t1' as import('./skilltree-graph.js').CrystalId),
    ).toThrow(/not eligible/);
    // Nothing consumed, nothing bound, socket not owned.
    expect((state.inventory as Record<string, number>).mining_crystal_t1).toBe(1);
    expect(state.socketBindings.size).toBe(0);
    expect(state.unlockedNodes.has('gs.ref.smelting-1')).toBe(false);
  });

  it('bindCrystal rejects unknown socket and unknown crystal ids', () => {
    const inv = blankInventory();
    (inv as Record<string, number>).mining_crystal_t1 = 1;
    const state = makeState({ inventory: inv });
    expect(() =>
      bindCrystal(state, 'gs.no.such-socket', 'mining_crystal_t1' as import('./skilltree-graph.js').CrystalId),
    ).toThrow(/unknown socket/);
    expect(() =>
      bindCrystal(state, 'gs.ext.mining-1', 'no_such_crystal' as import('./skilltree-graph.js').CrystalId),
    ).toThrow(/unknown crystal/);
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

  it('unbindCrystal refunds exactly what was charged (edge costs; node cost only for direct adds)', () => {
    const inv = blankInventory();
    (inv as Record<string, number>).mining_crystal_t1 = 1;
    const state = makeState({ inventory: inv, unspentSkillPoints: 0 });
    state.socketBindings.set('gs.ext.mining-1', 'mining_crystal_t1' as import('./skilltree-graph.js').CrystalId);
    state.unlockedNodes.add('gs.ext.mining-1.mining_crystal_t1.core');
    state.unlockedNodes.add('gs.ext.mining-1.mining_crystal_t1.left1');
    state.unlockedEdges.add('gs.ext.mining-1.mining_crystal_t1.edge.socket.core.0' as EdgeId);
    unbindCrystal(state, 'gs.ext.mining-1');
    // Charged-amount accounting: core was acquired through the owned
    // socket→core edge (cost 0 — what buyNode charged); left1 has no owned
    // incoming edge, so it counts as a direct add at its node cost (1).
    // The old refund (node costs + edge costs = 3+1+0) minted SP the player
    // never spent.
    expect(state.unspentSkillPoints).toBe(0 + 1);
    expect(state.unlockedNodes.has('gs.ext.mining-1.mining_crystal_t1.core')).toBe(false);
    expect(state.unlockedNodes.has('gs.ext.mining-1.mining_crystal_t1.left1')).toBe(false);
    expect(state.unlockedEdges.has('gs.ext.mining-1.mining_crystal_t1.edge.socket.core.0' as EdgeId)).toBe(false);
    expect((state.inventory as Record<string, number>).mining_crystal_t1).toBe(2);
    expect(state.socketBindings.has('gs.ext.mining-1')).toBe(false);
  });

  it('bind → buy entire mini-tree → unbind is exactly SP-neutral and returns the crystal', () => {
    const inv = blankInventory();
    (inv as Record<string, number>).mining_crystal_t1 = 1;
    const state = makeState({ inventory: inv, level: 5, unspentSkillPoints: 20 });
    bindCrystal(state, 'gs.ext.mining-1', 'mining_crystal_t1' as import('./skilltree-graph.js').CrystalId);
    const g = effectiveGraph(state);
    const prefix = 'gs.ext.mining-1.mining_crystal_t1.';
    // Buying the leaves auto-owns the arms; core's socket edge costs 0.
    buyNode(g, state, `${prefix}core`);
    buyNode(g, state, `${prefix}left2`);
    buyNode(g, state, `${prefix}right2`);
    for (const suffix of ['core', 'left1', 'left2', 'right1', 'right2']) {
      expect(state.unlockedNodes.has(`${prefix}${suffix}`)).toBe(true);
    }
    // buyNode charged Σ edge costs: 0 (socket→core) + 1+1 (left arm) + 1+1 (right arm).
    expect(state.unspentSkillPoints).toBe(20 - 4);
    // The UI confirm number must match what the unbind will actually refund.
    const preview = computeMiniTreeRefund(
      state, 'gs.ext.mining-1', 'mining_crystal_t1' as import('./skilltree-graph.js').CrystalId,
    );
    expect(preview.nodeCount).toBe(5);
    expect(preview.spRefund).toBe(4);
    unbindCrystal(state, 'gs.ext.mining-1');
    expect(state.unspentSkillPoints).toBe(20); // exactly SP-neutral — no minting
    expect((state.inventory as Record<string, number>).mining_crystal_t1).toBe(1);
    for (const id of [...state.unlockedNodes, ...state.unlockedEdges]) {
      expect(String(id).startsWith(prefix)).toBe(false);
    }
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

  it('unbindCrystal bumps auraAmpVersion so the aura cache does not serve stale data', () => {
    clearSkillMultipliersMemoForTests();
    const inv = blankInventory();
    (inv as Record<string, number>).mining_crystal_t1 = 1;
    const state = makeState({ inventory: inv });
    // Warm the cache with real catalog nodes so Layer-2 has content.
    state.unlockedNodes.add('mining.notable.blastOptimization' as NodeId);
    state.unlockedNodes.add('mining.recipeRate.5' as NodeId);

    bindCrystal(state, 'gs.ext.mining-1', 'mining_crystal_t1' as import('./skilltree-graph.js').CrystalId);
    const vAfterBind = state.auraAmpVersion;
    effectiveSkillMultipliers(state); // warm cache

    // Do not buy any mini-tree nodes, so refundAndClearMiniTree has nothing
    // to delete but still bumps once by contract. The socket deletion itself
    // must contribute a second bump.
    unbindCrystal(state, 'gs.ext.mining-1');

    // bind (+1) + refundAndClearMiniTree (+1) + socket delete (+1) = +3 total.
    expect(state.auraAmpVersion).toBe(vAfterBind + 2);
    // Recompute to prove the cache is not stale.
    effectiveSkillMultipliers(state);
    expect(state.auraAmpCacheVersion).toBe(state.auraAmpVersion);
  });
});

describe('crystal mini-tree reachability — socket ownership (§9.3 grafts)', () => {
  const SOCKET = 'gs.ext.mining-1';
  const CRYSTAL = 'mining_crystal_t1' as import('./skilltree-graph.js').CrystalId;
  const CORE = `${SOCKET}.${CRYSTAL}.core`;

  function stateWithCrystal(): IslandState {
    const inv = blankInventory();
    (inv as Record<string, number>)[CRYSTAL as string] = 1;
    return makeState({ inventory: inv, level: 5, unspentSkillPoints: 10 });
  }

  it('bindCrystal owns the synthetic socket node (cost 0) so mini-tree nodes become purchasable', () => {
    const state = stateWithCrystal();
    bindCrystal(state, SOCKET, CRYSTAL);
    expect(state.unlockedNodes.has(SOCKET)).toBe(true);
    const g = effectiveGraph(state);
    expect(nodePurchaseStatus(g, state, CORE)).toBe('purchasable');
    buyNode(g, state, CORE);
    expect(state.unlockedNodes.has(CORE)).toBe(true);
  });

  it('unbindCrystal removes the socket ownership', () => {
    const state = stateWithCrystal();
    bindCrystal(state, SOCKET, CRYSTAL);
    unbindCrystal(state, SOCKET);
    expect(state.unlockedNodes.has(SOCKET)).toBe(false);
  });

  it('rebinding a different crystal keeps the socket owned', () => {
    const state = stateWithCrystal();
    (state.inventory as Record<string, number>).mining_crystal_t2 = 1;
    bindCrystal(state, SOCKET, CRYSTAL);
    bindCrystal(state, SOCKET, 'mining_crystal_t2' as import('./skilltree-graph.js').CrystalId);
    expect(state.unlockedNodes.has(SOCKET)).toBe(true);
  });

  it('old saves (binding present, socket id absent from unlockedNodes) still reach the mini-tree', () => {
    // Pre-fix saves persisted socketBindings but never owned the socket node.
    // Belt-and-braces: costToUnlock seeds bound sockets as owned sources.
    const state = stateWithCrystal();
    state.socketBindings.set(SOCKET, CRYSTAL);
    expect(state.unlockedNodes.has(SOCKET)).toBe(false);
    const g = effectiveGraph(state);
    const r = costToUnlock(g, state.unlockedNodes, state.unlockedEdges, state, CORE);
    expect(r).not.toBeNull();
    expect(nodePurchaseStatus(g, state, CORE)).toBe('purchasable');
    buyNode(g, state, CORE);
    expect(state.unlockedNodes.has(CORE)).toBe(true);
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

describe('spentInBranch — root purchases count toward bridge thresholds (§9.3)', () => {
  function mkNode(id: string, subPath: import('./skilltree.js').SubPathId, cost: number): SkillNode {
    return {
      id: id as import('./skilltree.js').NodeId,
      subPath,
      depth: 1,
      cost,
      magnitude: 0,
      effect: { kind: 'placeholder' },
      description: id,
    };
  }

  function mkGraph(): Graph {
    const bridge = {
      id: 'br.test.root-bridge' as EdgeId,
      from: 'R' as import('./skilltree-graph.js').NodeId,
      to: 'T' as import('./skilltree-graph.js').NodeId,
      cost: 2,
      mode: 'or' as const,
      threshold: [{ branch: 'extraction' as const, minSpent: 7 }],
    };
    // T must have an incoming STANDARD edge (G→T) so it is NOT a forward-root.
    // Real bridge endpoints are always notables/keystones, which are anchored
    // (have incoming edges) — never entry roots. Without this, the forward-root
    // direct-buy rule would make T buyable at its node cost regardless of the
    // bridge, defeating the bridge-gating this test exercises. G itself is an
    // unowned root, so it provides no alternate path into T below the threshold.
    const gToT = {
      id: 'e.test.G-T' as EdgeId,
      from: 'G' as import('./skilltree-graph.js').NodeId,
      to: 'T' as import('./skilltree-graph.js').NodeId,
      cost: 1,
    };
    return {
      nodes: [mkNode('R', 'mining', 7), mkNode('G', 'smelting', 1), mkNode('T', 'smelting', 1)],
      edges: [gToT],
      bridges: [bridge],
      graftSockets: [],
    } as Graph;
  }

  it('a root buy (no edge) counts as branch spend: bridge activates and engine pathing agrees', () => {
    const g = mkGraph();
    const state = makeState({ level: 5, unspentSkillPoints: 20 });
    buyNode(g, state, 'R'); // root-fallback: charges node cost 7, owns NO edge
    expect(state.unlockedEdges.size).toBe(0);
    // The engine spend counter must see the 7 SP (the old edge-only counter
    // returned 0 here, so the bridge stayed inert for pathing while the UI's
    // node-cost counter rendered it active).
    expect(spentInBranch(state, 'extraction', g)).toBe(7);
    expect(spentInBranch(state, 'refinement', g)).toBe(0);
    const r = costToUnlock(g, state.unlockedNodes, state.unlockedEdges, state, 'T');
    expect(r).not.toBeNull();
    expect(r!.totalCost).toBe(2); // across the now-active bridge
  });

  it('below the threshold the bridge stays inactive for both the counter and pathing', () => {
    const g = mkGraph();
    const state = makeState({ level: 5, unspentSkillPoints: 20 });
    expect(spentInBranch(state, 'extraction', g)).toBe(0);
    expect(
      costToUnlock(g, state.unlockedNodes, state.unlockedEdges, state, 'T'),
    ).toBeNull();
  });
});

describe('formatNodeMagnitude', () => {
  function mk(effect: SkillNode['effect'], magnitude: number): SkillNode {
    return {
      id: 'x' as import('./skilltree.js').NodeId,
      subPath: 'mining', depth: 1, cost: 1, magnitude, effect, description: 'x',
    };
  }

  it('shows a reduction effect as the effective sub-1 multiplier (the bug: ×1.089 read as an increase)', () => {
    // powerConsumptionMul is applied as a divisor — a +0.089 node lowers draw
    // to ×(1/1.089) ≈ 0.918, NOT ×1.089.
    expect(formatNodeMagnitude(mk({ kind: 'powerConsumptionMul', reduce: true }, 0.089))).toBe('×0.9183');
  });

  it('shows recipeInputMul (also reduce) as a sub-1 multiplier', () => {
    expect(formatNodeMagnitude(mk({ kind: 'recipeInputMul', reduce: true }, 0.5))).toBe('×0.6667');
  });

  it('shows a normal increase effect as ×(1+m)', () => {
    expect(formatNodeMagnitude(mk({ kind: 'recipeRateMul', category: 'extraction' }, 0.05))).toBe('×1.0500');
  });

  it('keeps the additive formats (parallelBuildCapAdd, launchSuccessAdditive)', () => {
    expect(formatNodeMagnitude(mk({ kind: 'parallelBuildCapAdd' }, 2))).toBe('+2.000');
    expect(formatNodeMagnitude(mk({ kind: 'launchSuccessAdditive' }, 0.03))).toBe('+3.0 pp');
  });

  it('returns "" for a zero/absent magnitude', () => {
    expect(formatNodeMagnitude(mk({ kind: 'powerProductionMul' }, 0))).toBe('');
  });
});

describe('nodePurchaseStatus — UI/buy parity (§9.3 depth→tier gate)', () => {
  // R(1) is a root (no incoming edges) — the entry filler the renderer used to
  // fall back to n.cost for, ignoring the tier gate. M(2) reachable from R.
  function mkNode(id: string, depth: number): SkillNode {
    return {
      id: id as import('./skilltree.js').NodeId,
      subPath: 'mining',
      depth,
      cost: 1,
      magnitude: 0,
      effect: { kind: 'recipeRateMul', category: 'extraction' },
      description: id,
    };
  }
  function mkGraph(): Graph {
    return {
      nodes: [mkNode('R', 1), mkNode('M', 2)],
      edges: [
        { id: 'e_RM' as EdgeId, from: 'R' as import('./skilltree-graph.js').NodeId, to: 'M' as import('./skilltree-graph.js').NodeId, cost: 1 },
      ],
      bridges: [], graftSockets: [],
    } as Graph;
  }

  it('reports a depth-1 root entry node as tier-locked at level 2 (the bug: UI showed it purchasable)', () => {
    const g = mkGraph();
    const state = makeState({ level: 2, unspentSkillPoints: 50 });
    // buyNode confirms it is genuinely unbuyable here…
    expect(() => buyNode(g, state, 'R')).toThrow(/tier/i);
    // …so the UI predicate must agree, not say 'purchasable'.
    expect(nodePurchaseStatus(g, state, 'R')).toBe('tier-locked');
  });

  it('reports the same entry node purchasable once the island reaches tier 2 (level 5)', () => {
    const g = mkGraph();
    const state = makeState({ level: 5, unspentSkillPoints: 50 });
    expect(nodePurchaseStatus(g, state, 'R')).toBe('purchasable');
  });

  it('reports owned nodes as owned', () => {
    const g = mkGraph();
    const state = makeState({ level: 5, unspentSkillPoints: 50 });
    state.unlockedNodes.add('R');
    expect(nodePurchaseStatus(g, state, 'R')).toBe('owned');
  });

  it('reports insufficient-sp when tier-eligible and reachable but SP < cost', () => {
    const g = mkGraph();
    const state = makeState({ level: 5, unspentSkillPoints: 0 });
    expect(nodePurchaseStatus(g, state, 'R')).toBe('insufficient-sp');
  });
});

describe('queueCapBonus aggregation', () => {
  it('default queueCapBonus is 0 on a fresh state', () => {
    const fresh = makeState();
    expect(effectiveSkillMultipliers(fresh, LG).queueCapBonus).toBe(0);
  });
});

describe('queue mirror nodes', () => {
  it('queueFoundries + queueConstruction exist in the graph', () => {
    const ids = new Set(DEFAULT_GRAPH.nodes.map((n) => n.id));
    expect(ids.has('robotics.notable.queueFoundries')).toBe(true);
    expect(ids.has('robotics.keystone.queueConstruction')).toBe(true);
  });
});

describe('keystone bridge-OR unlock', () => {
  it('keystone is purchasable via an active bridge without its AND prereqs', () => {
    const state = makeState({ level: 70, unspentSkillPoints: 1_000_000 });
    // Own the bridge source and enough nodes to activate the threshold.
    // The bridge robotics.keystone.parallelConstruction -> electronics.keystone.quantumYield
    // requires extraction >= 18 and refinement >= 18 SP spent.
    const source = 'robotics.keystone.parallelConstruction' as NodeId;
    const target = 'electronics.keystone.quantumYield' as NodeId;

    // Give the source keystone and fake spent SP by unlocking many nodes.
    // Leave the target AND its AND-prereq notables locked so the bridge-OR path
    // is the only way the keystone can be purchasable.
    const andPrereqs = new Set<string>([
      'electronics.notable.cleanRoom',
      'electronics.notable.quantumEtching',
    ]);
    state.unlockedNodes.add(source);
    for (const n of DEFAULT_GRAPH.nodes) {
      if (n.id === target) continue;
      if (andPrereqs.has(n.id)) continue;
      if (n.subPath === 'mining' || n.subPath === 'forestry' || n.subPath === 'drilling' ||
          n.subPath === 'smelting' || n.subPath === 'chemistry' || n.subPath === 'electronics') {
        state.unlockedNodes.add(n.id as NodeId);
      }
    }

    expect(nodePurchaseStatus(DEFAULT_GRAPH, state, target)).toBe('purchasable');

    buyNode(DEFAULT_GRAPH, state, target);
    expect(state.unlockedNodes.has(target)).toBe(true);
  });

  it('keystone stays unreachable when neither AND prereqs nor bridge path exist', () => {
    const state = makeState({ level: 70, unspentSkillPoints: 1_000_000 });
    const target = 'electronics.keystone.quantumYield' as NodeId;
    expect(nodePurchaseStatus(DEFAULT_GRAPH, state, target)).toBe('unreachable');
  });
});
