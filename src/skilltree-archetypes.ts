// Filler archetype generator for skill-tree sub-path content.
//
// Each sub-path is a depth-graded chain of nodes. Rather than hand-writing
// ~25 nodes per sub-path, an archetype template captures the ramp pattern
// (base magnitude, growth factor, cost curve) and `generateFillerNodes`
// produces the `SkillNode[]` array.

import type { SkillEffect, SkillNode, NodeId, SubPathId } from './skilltree.js';

export interface FillerArchetype {
  readonly idPrefix: string;
  readonly effectKind: SkillEffect['kind'];
  readonly effectExtra?: Record<string, unknown>;
  readonly subPath: SubPathId;
  readonly baseMag: number;
  readonly growth: number;
  readonly baseCost: number;
  readonly costGrowth: number;
  readonly count: number;
}

/** Generate a depth-ramped filler chain from an archetype.
 *
 *  Per-node factor follows multiplicative growth:
 *    depth-d factor = (1 + baseMag) * growth^(d-1)
 *  Magnitude is stored as the +bonus (factor - 1), matching the `SkillNode`
 *  convention (0.05 means +5%).
 *
 *  Cost follows geometric growth with rounding per depth. */
export function generateFillerNodes(arch: FillerArchetype): SkillNode[] {
  const nodes: SkillNode[] = [];
  let factor = 1 + arch.baseMag;
  let cost = arch.baseCost;
  for (let d = 0; d < arch.count; d++) {
    const magnitude = factor - 1;
    nodes.push({
      id: `${arch.idPrefix}.${d + 1}` as NodeId,
      subPath: arch.subPath,
      depth: d + 1,
      cost: Math.round(cost),
      magnitude,
      effect: { kind: arch.effectKind, ...(arch.effectExtra ?? {}) } as SkillEffect,
      description: `${arch.subPath} ${arch.effectKind} depth ${d + 1}`,
    });
    factor *= arch.growth;
    cost *= arch.costGrowth;
  }
  return nodes;
}

// ---------------------------------------------------------------------------
// Extraction branch
// ---------------------------------------------------------------------------

export const MINING_FILLER_ARCHETYPES: FillerArchetype[] = [
  {
    idPrefix: 'mining.recipeRate', effectKind: 'recipeRateMul',
    effectExtra: { category: 'extraction' }, subPath: 'mining',
    baseMag: 0.04, growth: 1.10, baseCost: 1, costGrowth: 1.4, count: 8,
  },
  {
    idPrefix: 'mining.storageCap', effectKind: 'storageCategoryCapMul',
    effectExtra: { category: 'dry_goods' }, subPath: 'mining',
    baseMag: 0.05, growth: 1.08, baseCost: 1, costGrowth: 1.5, count: 7,
  },
  {
    idPrefix: 'mining.yieldBonus', effectKind: 'mineYieldBonusMul',
    subPath: 'mining', baseMag: 0.05, growth: 1.10, baseCost: 2, costGrowth: 1.6, count: 5,
  },
  {
    idPrefix: 'mining.rareTrickle', effectKind: 'mineRareTrickleMul',
    subPath: 'mining', baseMag: 0.10, growth: 1.10, baseCost: 3, costGrowth: 1.7, count: 4,
  },
];
export const MINING_FILLER_NODES = MINING_FILLER_ARCHETYPES.flatMap(generateFillerNodes);

export const FORESTRY_FILLER_ARCHETYPES: FillerArchetype[] = [
  {
    idPrefix: 'forestry.recipeRate', effectKind: 'recipeRateMul',
    effectExtra: { category: 'extraction' }, subPath: 'forestry',
    baseMag: 0.04, growth: 1.10, baseCost: 1, costGrowth: 1.4, count: 8,
  },
  {
    idPrefix: 'forestry.storageCap', effectKind: 'storageCategoryCapMul',
    effectExtra: { category: 'dry_goods' }, subPath: 'forestry',
    baseMag: 0.05, growth: 1.08, baseCost: 1, costGrowth: 1.5, count: 7,
  },
  {
    idPrefix: 'forestry.yieldBonus', effectKind: 'loggerYieldBonusMul',
    subPath: 'forestry', baseMag: 0.05, growth: 1.10, baseCost: 2, costGrowth: 1.6, count: 5,
  },
  {
    idPrefix: 'forestry.exoticTrickle', effectKind: 'loggerExoticTrickleMul',
    subPath: 'forestry', baseMag: 0.10, growth: 1.10, baseCost: 3, costGrowth: 1.7, count: 4,
  },
];
export const FORESTRY_FILLER_NODES = FORESTRY_FILLER_ARCHETYPES.flatMap(generateFillerNodes);

export const DRILLING_FILLER_ARCHETYPES: FillerArchetype[] = [
  {
    idPrefix: 'drilling.recipeRate', effectKind: 'recipeRateMul',
    effectExtra: { category: 'extraction' }, subPath: 'drilling',
    baseMag: 0.04, growth: 1.10, baseCost: 1, costGrowth: 1.4, count: 8,
  },
  {
    idPrefix: 'drilling.storageCap', effectKind: 'storageCategoryCapMul',
    effectExtra: { category: 'liquid_gas' }, subPath: 'drilling',
    baseMag: 0.05, growth: 1.08, baseCost: 1, costGrowth: 1.5, count: 7,
  },
  {
    idPrefix: 'drilling.yieldBonus', effectKind: 'mineYieldBonusMul',
    subPath: 'drilling', baseMag: 0.05, growth: 1.10, baseCost: 2, costGrowth: 1.6, count: 5,
  },
  {
    idPrefix: 'drilling.rareTrickle', effectKind: 'mineRareTrickleMul',
    subPath: 'drilling', baseMag: 0.10, growth: 1.10, baseCost: 3, costGrowth: 1.7, count: 4,
  },
];
export const DRILLING_FILLER_NODES = DRILLING_FILLER_ARCHETYPES.flatMap(generateFillerNodes);

export const ROBOTICS_FILLER_ARCHETYPES: FillerArchetype[] = [
  {
    idPrefix: 'robotics.constructionTime', effectKind: 'constructionTimeMul',
    subPath: 'robotics', baseMag: 0.05, growth: 1.10, baseCost: 1, costGrowth: 1.4, count: 7,
  },
  {
    idPrefix: 'robotics.parallelBuild', effectKind: 'parallelBuildCapAdd',
    subPath: 'robotics', baseMag: 0.10, growth: 1.10, baseCost: 2, costGrowth: 1.5, count: 5,
  },
  {
    idPrefix: 'robotics.droneScan', effectKind: 'droneScanRadiusMul',
    subPath: 'robotics', baseMag: 0.05, growth: 1.10, baseCost: 2, costGrowth: 1.6, count: 5,
  },
  {
    idPrefix: 'robotics.droneFuel', effectKind: 'droneFuelEfficiencyMul',
    subPath: 'robotics', baseMag: 0.05, growth: 1.08, baseCost: 1, costGrowth: 1.5, count: 7,
  },
];
export const ROBOTICS_FILLER_NODES = ROBOTICS_FILLER_ARCHETYPES.flatMap(generateFillerNodes);

// ---------------------------------------------------------------------------
// Refinement branch
// ---------------------------------------------------------------------------

export const SMELTING_FILLER_ARCHETYPES: FillerArchetype[] = [
  {
    idPrefix: 'smelting.recipeRate', effectKind: 'recipeRateMul',
    effectExtra: { category: 'smelting' }, subPath: 'smelting',
    baseMag: 0.04, growth: 1.10, baseCost: 1, costGrowth: 1.4, count: 8,
  },
  {
    idPrefix: 'smelting.powerConsumption', effectKind: 'powerConsumptionMul',
    effectExtra: { reduce: true }, subPath: 'smelting',
    baseMag: 0.05, growth: 1.08, baseCost: 2, costGrowth: 1.5, count: 7,
  },
  {
    idPrefix: 'smelting.maintenance', effectKind: 'maintenanceThresholdMul',
    subPath: 'smelting', baseMag: 0.05, growth: 1.08, baseCost: 1, costGrowth: 1.5, count: 5,
  },
];
export const SMELTING_FILLER_NODES = SMELTING_FILLER_ARCHETYPES.flatMap(generateFillerNodes);

export const CHEMISTRY_FILLER_ARCHETYPES: FillerArchetype[] = [
  {
    idPrefix: 'chemistry.recipeRate', effectKind: 'recipeRateMul',
    effectExtra: { category: 'chemistry' }, subPath: 'chemistry',
    baseMag: 0.04, growth: 1.10, baseCost: 1, costGrowth: 1.4, count: 8,
  },
  {
    idPrefix: 'chemistry.storageCap', effectKind: 'storageCategoryCapMul',
    effectExtra: { category: 'liquid_gas' }, subPath: 'chemistry',
    baseMag: 0.05, growth: 1.08, baseCost: 1, costGrowth: 1.5, count: 7,
  },
  {
    idPrefix: 'chemistry.powerConsumption', effectKind: 'powerConsumptionMul',
    effectExtra: { reduce: true }, subPath: 'chemistry',
    baseMag: 0.05, growth: 1.08, baseCost: 2, costGrowth: 1.5, count: 5,
  },
];
export const CHEMISTRY_FILLER_NODES = CHEMISTRY_FILLER_ARCHETYPES.flatMap(generateFillerNodes);

export const ELECTRONICS_FILLER_ARCHETYPES: FillerArchetype[] = [
  {
    idPrefix: 'electronics.recipeRate', effectKind: 'recipeRateMul',
    effectExtra: { category: 'electronics' }, subPath: 'electronics',
    baseMag: 0.04, growth: 1.10, baseCost: 1, costGrowth: 1.4, count: 8,
  },
  {
    idPrefix: 'electronics.powerConsumption', effectKind: 'powerConsumptionMul',
    effectExtra: { reduce: true }, subPath: 'electronics',
    baseMag: 0.05, growth: 1.08, baseCost: 2, costGrowth: 1.5, count: 5,
  },
  {
    idPrefix: 'electronics.satBuffer', effectKind: 'satBufferCapMul',
    subPath: 'electronics', baseMag: 0.05, growth: 1.10, baseCost: 2, costGrowth: 1.6, count: 5,
  },
];
export const ELECTRONICS_FILLER_NODES = ELECTRONICS_FILLER_ARCHETYPES.flatMap(generateFillerNodes);

export const POWER_SYSTEMS_FILLER_ARCHETYPES: FillerArchetype[] = [
  {
    idPrefix: 'powerSystems.production', effectKind: 'powerProductionMul',
    subPath: 'power_systems', baseMag: 0.04, growth: 1.10, baseCost: 1, costGrowth: 1.4, count: 8,
  },
  {
    idPrefix: 'powerSystems.consumption', effectKind: 'powerConsumptionMul',
    effectExtra: { reduce: true }, subPath: 'power_systems',
    baseMag: 0.05, growth: 1.08, baseCost: 2, costGrowth: 1.5, count: 7,
  },
  {
    idPrefix: 'powerSystems.xpGain', effectKind: 'xpGainMul',
    effectExtra: { category: 'power' }, subPath: 'power_systems',
    baseMag: 0.05, growth: 1.10, baseCost: 2, costGrowth: 1.6, count: 5,
  },
];
export const POWER_SYSTEMS_FILLER_NODES = POWER_SYSTEMS_FILLER_ARCHETYPES.flatMap(generateFillerNodes);

// ---------------------------------------------------------------------------
// Logistics branch
// ---------------------------------------------------------------------------

export const STORAGE_FILLER_ARCHETYPES: FillerArchetype[] = [
  {
    idPrefix: 'storage.uniformCap', effectKind: 'storageCapMul',
    subPath: 'storage', baseMag: 0.04, growth: 1.10, baseCost: 1, costGrowth: 1.4, count: 7,
  },
  {
    idPrefix: 'storage.categoryCap', effectKind: 'storageCategoryCapMul',
    effectExtra: { category: 'components' }, subPath: 'storage',
    baseMag: 0.05, growth: 1.08, baseCost: 1, costGrowth: 1.5, count: 7,
  },
  {
    idPrefix: 'storage.maintenance', effectKind: 'maintenanceThresholdMul',
    subPath: 'storage', baseMag: 0.05, growth: 1.08, baseCost: 2, costGrowth: 1.5, count: 5,
  },
];
export const STORAGE_FILLER_NODES = STORAGE_FILLER_ARCHETYPES.flatMap(generateFillerNodes);

export const TRANSPORT_FILLER_ARCHETYPES: FillerArchetype[] = [
  {
    idPrefix: 'transport.routeCapacity', effectKind: 'routeCapacityMul',
    subPath: 'transport', baseMag: 0.05, growth: 1.10, baseCost: 1, costGrowth: 1.4, count: 8,
  },
  {
    idPrefix: 'transport.airshipRange', effectKind: 'airshipRangeMul',
    subPath: 'transport', baseMag: 0.05, growth: 1.10, baseCost: 2, costGrowth: 1.5, count: 5,
  },
  {
    idPrefix: 'transport.droneFuel', effectKind: 'droneFuelEfficiencyMul',
    subPath: 'transport', baseMag: 0.05, growth: 1.08, baseCost: 1, costGrowth: 1.5, count: 7,
  },
];
export const TRANSPORT_FILLER_NODES = TRANSPORT_FILLER_ARCHETYPES.flatMap(generateFillerNodes);

export const NETWORK_FILLER_ARCHETYPES: FillerArchetype[] = [
  {
    idPrefix: 'network.commRange', effectKind: 'commRangeMul',
    subPath: 'network', baseMag: 0.05, growth: 1.10, baseCost: 1, costGrowth: 1.4, count: 7,
  },
  {
    idPrefix: 'network.teleporter', effectKind: 'teleporterEfficiencyMul',
    subPath: 'network', baseMag: 0.05, growth: 1.10, baseCost: 2, costGrowth: 1.5, count: 5,
  },
  {
    idPrefix: 'network.scanner', effectKind: 'scannerCoverageMul',
    subPath: 'network', baseMag: 0.05, growth: 1.10, baseCost: 2, costGrowth: 1.6, count: 5,
  },
];
export const NETWORK_FILLER_NODES = NETWORK_FILLER_ARCHETYPES.flatMap(generateFillerNodes);

// ---------------------------------------------------------------------------
// Orbital branch
// ---------------------------------------------------------------------------

export const LAUNCH_FILLER_ARCHETYPES: FillerArchetype[] = [
  {
    idPrefix: 'launch.success', effectKind: 'launchSuccessAdditive',
    subPath: 'launch', baseMag: 0.05, growth: 1.10, baseCost: 1, costGrowth: 1.4, count: 7,
  },
  {
    idPrefix: 'launch.padSafety', effectKind: 'padExplosionReduceMul',
    subPath: 'launch', baseMag: 0.05, growth: 1.10, baseCost: 2, costGrowth: 1.5, count: 5,
  },
  {
    idPrefix: 'launch.satBuffer', effectKind: 'satBufferCapMul',
    subPath: 'launch', baseMag: 0.05, growth: 1.10, baseCost: 2, costGrowth: 1.6, count: 5,
  },
  {
    idPrefix: 'launch.satFuel', effectKind: 'satFuelReserveMul',
    subPath: 'launch', baseMag: 0.05, growth: 1.10, baseCost: 3, costGrowth: 1.7, count: 4,
  },
];
export const LAUNCH_FILLER_NODES = LAUNCH_FILLER_ARCHETYPES.flatMap(generateFillerNodes);

export const COMMUNICATION_FILLER_ARCHETYPES: FillerArchetype[] = [
  {
    idPrefix: 'communication.commRange', effectKind: 'commRangeMul',
    subPath: 'communication', baseMag: 0.05, growth: 1.10, baseCost: 1, costGrowth: 1.4, count: 8,
  },
  {
    idPrefix: 'communication.satBuffer', effectKind: 'satBufferCapMul',
    subPath: 'communication', baseMag: 0.05, growth: 1.10, baseCost: 2, costGrowth: 1.5, count: 5,
  },
  {
    idPrefix: 'communication.scanner', effectKind: 'scannerCoverageMul',
    subPath: 'communication', baseMag: 0.05, growth: 1.10, baseCost: 2, costGrowth: 1.6, count: 5,
  },
];
export const COMMUNICATION_FILLER_NODES = COMMUNICATION_FILLER_ARCHETYPES.flatMap(generateFillerNodes);

export const DISCOVERY_FILLER_ARCHETYPES: FillerArchetype[] = [
  {
    idPrefix: 'discovery.scannerCoverage', effectKind: 'scannerCoverageMul',
    subPath: 'discovery', baseMag: 0.05, growth: 1.10, baseCost: 1, costGrowth: 1.4, count: 8,
  },
  {
    idPrefix: 'discovery.scannerDwell', effectKind: 'scannerDwellRateMul',
    subPath: 'discovery', baseMag: 0.05, growth: 1.10, baseCost: 2, costGrowth: 1.5, count: 5,
  },
  {
    idPrefix: 'discovery.droneScan', effectKind: 'droneScanRadiusMul',
    subPath: 'discovery', baseMag: 0.05, growth: 1.10, baseCost: 2, costGrowth: 1.6, count: 5,
  },
];
export const DISCOVERY_FILLER_NODES = DISCOVERY_FILLER_ARCHETYPES.flatMap(generateFillerNodes);

export const RESILIENCE_FILLER_ARCHETYPES: FillerArchetype[] = [
  {
    idPrefix: 'resilience.debris', effectKind: 'debrisProtectionMul',
    subPath: 'resilience', baseMag: 0.05, growth: 1.10, baseCost: 1, costGrowth: 1.4, count: 7,
  },
  {
    idPrefix: 'resilience.repairDrone', effectKind: 'repairDroneReliabilityMul',
    subPath: 'resilience', baseMag: 0.05, growth: 1.10, baseCost: 2, costGrowth: 1.5, count: 5,
  },
  {
    idPrefix: 'resilience.maintenance', effectKind: 'maintenanceThresholdMul',
    subPath: 'resilience', baseMag: 0.05, growth: 1.08, baseCost: 1, costGrowth: 1.5, count: 7,
  },
];
export const RESILIENCE_FILLER_NODES = RESILIENCE_FILLER_ARCHETYPES.flatMap(generateFillerNodes);

// ---------------------------------------------------------------------------
// Aggregate
// ---------------------------------------------------------------------------

export const ALL_FILLER_NODES: SkillNode[] = [
  ...MINING_FILLER_NODES,
  ...FORESTRY_FILLER_NODES,
  ...DRILLING_FILLER_NODES,
  ...ROBOTICS_FILLER_NODES,
  ...SMELTING_FILLER_NODES,
  ...CHEMISTRY_FILLER_NODES,
  ...ELECTRONICS_FILLER_NODES,
  ...POWER_SYSTEMS_FILLER_NODES,
  ...STORAGE_FILLER_NODES,
  ...TRANSPORT_FILLER_NODES,
  ...NETWORK_FILLER_NODES,
  ...LAUNCH_FILLER_NODES,
  ...COMMUNICATION_FILLER_NODES,
  ...DISCOVERY_FILLER_NODES,
  ...RESILIENCE_FILLER_NODES,
];
