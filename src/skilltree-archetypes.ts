// Filler archetype generator for skill-tree sub-path content.
//
// Each sub-path is a depth-graded chain of nodes. Rather than hand-writing
// ~25 nodes per sub-path, an archetype template captures the ramp pattern
// (growth factor, cost curve) and `generateFillerNodes` produces the
// `RawSkillNode[]` array. baseMag is no longer authored here —
// deriveMagnitudes() solves it at module load.

import type { SkillEffect, NodeId, SubPathId } from './skilltree.js';
import type { RawSkillNode } from './skilltree-derive-magnitudes.js';

export interface FillerArchetype {
  readonly idPrefix: string;
  readonly effectKind: SkillEffect['kind'];
  readonly effectExtra?: Record<string, unknown>;
  readonly subPath: SubPathId;
  /** Per-depth growth factor for the chain. Default 1.10 = each deeper
   *  filler is 10% stronger than the previous. baseMag is no longer
   *  authored here — deriveMagnitudes() solves it at module load so the
   *  chain's product hits the filler-tier share of the pool cap. */
  readonly growth: number;
  readonly baseCost: number;
  readonly costGrowth: number;
  readonly count: number;
  /** First depth index for the chain (default 1). Used to tier-gate a chain
   *  by starting it deeper. E.g. startDepth: 3 means nodes have depth 3,4,5…
   *  and ids <prefix>.3, <prefix>.4, <prefix>.5… */
  readonly startDepth?: number;
}

/** Human-readable label for an effect kind. Pre-fixed with the catalog's
 *  `category` extra (if any) so descriptions read naturally. */
function effectLabel(kind: SkillEffect['kind'], extra?: Record<string, unknown>): string {
  const category = typeof extra?.['category'] === 'string' ? (extra['category'] as string).replace(/_/g, ' ') : '';
  const cat = category ? `${category} ` : '';
  switch (kind) {
    case 'recipeRateMul':              return `${cat}recipe rate`;
    case 'storageCategoryCapMul':      return `${cat}storage cap`;
    case 'powerProductionMul':         return 'power production';
    case 'powerConsumptionMul':        return 'power consumption';
    case 'recipeInputMul':             return 'material-input efficiency';
    case 'routeCapacityMul':           return 'route capacity';
    case 'commRangeMul':               return 'comm range';
    case 'maintenanceThresholdMul':    return 'maintenance threshold';
    case 'scannerCoverageMul':         return 'scanner coverage';
    case 'debrisProtectionMul':        return 'debris protection';
    case 'droneFuelEfficiencyMul':     return 'drone fuel efficiency';
    case 'airshipRangeMul':            return 'airship range';
    case 'padExplosionReduceMul':      return 'pad-explosion divisor';
    case 'satBufferCapMul':            return 'sat buffer cap';
    case 'scannerDwellRateMul':        return 'scanner dwell rate';
    case 'satFuelReserveMul':          return 'sat fuel reserve';
    case 'repairDroneReliabilityMul':  return 'repair-drone reliability';
    case 'constructionTimeMul':        return 'construction time';
    case 'droneScanRadiusMul':         return 'drone scan radius';
    case 'mineYieldBonusMul':          return 'mine yield';
    case 'mineRareTrickleMul':         return 'mine rare-trickle';
    case 'loggerYieldBonusMul':        return 'logger yield';
    case 'loggerExoticTrickleMul':     return 'logger exotic-trickle';
    case 'drillYieldBonusMul':         return 'drill yield';
    case 'aquacultureYieldBonusMul':   return 'aquaculture yield';
    case 'patronageYieldBonusMul':     return 'patronage yield';
    case 't5ExtractorYieldBonusMul':   return 'T5-extractor yield';
    case 'teleporterEfficiencyMul':    return 'teleporter efficiency';
    case 'parallelBuildCapAdd':        return 'parallel build slots';
    case 'launchSuccessAdditive':      return 'launch success';
    case 'xpGainMul':                  return `${cat}xp gain`;
    default:                           return String(kind);
  }
}

/** Generate a depth-ramped filler chain from an archetype.
 *
 *  Returns RawSkillNode shapes without magnitude — deriveMagnitudes()
 *  fills that in at module load so the chain's product hits the
 *  filler-tier share of the pool cap.
 *
 *  Cost follows geometric growth with rounding per depth. */
export function generateFillerNodes(arch: FillerArchetype): RawSkillNode[] {
  const nodes: RawSkillNode[] = [];
  const label = effectLabel(arch.effectKind, arch.effectExtra);
  const start = arch.startDepth ?? 1;
  let cost = arch.baseCost;
  for (let d = 0; d < arch.count; d++) {
    nodes.push({
      id: `${arch.idPrefix}.${start + d}` as NodeId,
      subPath: arch.subPath,
      depth: start + d,
      cost: Math.round(cost),
      effect: { kind: arch.effectKind, ...(arch.effectExtra ?? {}) } as SkillEffect,
      description: `${label} per node`,
    });
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
    growth: 1.10, baseCost: 1, costGrowth: 1.4, count: 8,
  },
  // storageCap (dry_goods) rehomed to storage sub-path; rareTrickle demoted to
  // notable (mining.notable.heliumSeep keeps mineRareTrickleMul alive in the pool).
  {
    idPrefix: 'mining.yieldBonus', effectKind: 'mineYieldBonusMul',
    subPath: 'mining', growth: 1.10, baseCost: 2, costGrowth: 1.6, count: 5,
  },
];
export const MINING_FILLER_NODES = MINING_FILLER_ARCHETYPES.flatMap(generateFillerNodes);

export const FORESTRY_FILLER_ARCHETYPES: FillerArchetype[] = [
  {
    idPrefix: 'forestry.recipeRate', effectKind: 'recipeRateMul',
    effectExtra: { category: 'extraction' }, subPath: 'forestry',
    growth: 1.10, baseCost: 1, costGrowth: 1.4, count: 8,
  },
  // storageCap (dry_goods) rehomed to storage sub-path; exoticTrickle demoted to
  // notable (forestry.notable.exoticInoculation keeps loggerExoticTrickleMul alive).
  {
    idPrefix: 'forestry.yieldBonus', effectKind: 'loggerYieldBonusMul',
    subPath: 'forestry', growth: 1.10, baseCost: 2, costGrowth: 1.6, count: 5,
  },
];
export const FORESTRY_FILLER_NODES = FORESTRY_FILLER_ARCHETYPES.flatMap(generateFillerNodes);

export const DRILLING_FILLER_ARCHETYPES: FillerArchetype[] = [
  {
    idPrefix: 'drilling.recipeRate', effectKind: 'recipeRateMul',
    effectExtra: { category: 'extraction' }, subPath: 'drilling',
    growth: 1.10, baseCost: 1, costGrowth: 1.4, count: 8,
  },
  // storageCap (liquid_gas) rehomed to storage sub-path; yieldBonus (mineYieldBonusMul)
  // was a duplicate of mining's — dropped per spec; rareTrickle demoted to notable
  // (drilling.notable.heliumSeep keeps mineRareTrickleMul alive via mining branch).
  {
    idPrefix: 'drilling.drillYield', effectKind: 'drillYieldBonusMul',
    subPath: 'drilling', growth: 1.10,
    baseCost: 1, costGrowth: 1.5, count: 8,
  },
];
export const DRILLING_FILLER_NODES = DRILLING_FILLER_ARCHETYPES.flatMap(generateFillerNodes);

export const ROBOTICS_FILLER_ARCHETYPES: FillerArchetype[] = [
  // §4: manufacturing-rate rehomed to robotics (replaces constructionTime/parallelBuild/droneScan fillers).
  {
    idPrefix: 'robotics.recipeRate', effectKind: 'recipeRateMul',
    effectExtra: { category: 'manufacturing' }, subPath: 'robotics',
    growth: 1.10, baseCost: 1, costGrowth: 1.5, count: 8,
  },
  {
    idPrefix: 'robotics.droneFuel', effectKind: 'droneFuelEfficiencyMul',
    subPath: 'robotics', growth: 1.10, baseCost: 1, costGrowth: 1.5, count: 7,
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
    growth: 1.10, baseCost: 1, costGrowth: 1.4, count: 8,
  },
  // Magic material-input-efficiency chain (§v2-rebalance). T3-gated via
  // startDepth 3 (the first node sits at depth 3 → tierRequiredForDepth = 3);
  // premium cost curve per spec Q4. All three refinement inputEff chains share
  // ONE recipeInputMul pool (POOL_TARGETS['recipeInputMul']) — deriveMagnitudes
  // groups by effect-key globally.
  {
    idPrefix: 'smelting.inputEff', effectKind: 'recipeInputMul',
    effectExtra: { reduce: true }, subPath: 'smelting',
    growth: 1.10, baseCost: 3, costGrowth: 1.8, count: 4, startDepth: 3,
  },
];
export const SMELTING_FILLER_NODES = SMELTING_FILLER_ARCHETYPES.flatMap(generateFillerNodes);

export const CHEMISTRY_FILLER_ARCHETYPES: FillerArchetype[] = [
  {
    idPrefix: 'chemistry.recipeRate', effectKind: 'recipeRateMul',
    effectExtra: { category: 'chemistry' }, subPath: 'chemistry',
    growth: 1.10, baseCost: 1, costGrowth: 1.4, count: 8,
  },
  // Magic material-input-efficiency chain — see SMELTING_FILLER_ARCHETYPES.
  {
    idPrefix: 'chemistry.inputEff', effectKind: 'recipeInputMul',
    effectExtra: { reduce: true }, subPath: 'chemistry',
    growth: 1.10, baseCost: 3, costGrowth: 1.8, count: 4, startDepth: 3,
  },
];
export const CHEMISTRY_FILLER_NODES = CHEMISTRY_FILLER_ARCHETYPES.flatMap(generateFillerNodes);

export const ELECTRONICS_FILLER_ARCHETYPES: FillerArchetype[] = [
  {
    idPrefix: 'electronics.recipeRate', effectKind: 'recipeRateMul',
    effectExtra: { category: 'electronics' }, subPath: 'electronics',
    growth: 1.10, baseCost: 1, costGrowth: 1.4, count: 8,
  },
  // Magic material-input-efficiency chain — see SMELTING_FILLER_ARCHETYPES.
  {
    idPrefix: 'electronics.inputEff', effectKind: 'recipeInputMul',
    effectExtra: { reduce: true }, subPath: 'electronics',
    growth: 1.10, baseCost: 3, costGrowth: 1.8, count: 4, startDepth: 3,
  },
];
export const ELECTRONICS_FILLER_NODES = ELECTRONICS_FILLER_ARCHETYPES.flatMap(generateFillerNodes);

export const POWER_SYSTEMS_FILLER_ARCHETYPES: FillerArchetype[] = [
  // C6a: xpGain (xpGainMul) demoted — power_systems.notable.xpTelemetry keeps
  // xpGainMul:(global) alive in the pool. batteryCapacity (batteryCapacityMul)
  // demoted — power_systems.notable.electrochemistry keeps it alive. 2 kept chains.
  {
    idPrefix: 'powerSystems.production', effectKind: 'powerProductionMul',
    subPath: 'power_systems', growth: 1.10, baseCost: 1, costGrowth: 1.4, count: 8,
  },
  {
    idPrefix: 'powerSystems.consumption', effectKind: 'powerConsumptionMul',
    effectExtra: { reduce: true }, subPath: 'power_systems',
    growth: 1.10, baseCost: 2, costGrowth: 1.5, count: 7,
  },
];
export const POWER_SYSTEMS_FILLER_NODES = POWER_SYSTEMS_FILLER_ARCHETYPES.flatMap(generateFillerNodes);

// ---------------------------------------------------------------------------
// Logistics branch
// ---------------------------------------------------------------------------

export const STORAGE_FILLER_ARCHETYPES: FillerArchetype[] = [
  // C3a: storage is now ONE capacity lever-family, category-sliced into 4
  // per-category cap chains. 4×4 = 16 filler; with 4 notables + 2 keystones
  // that is 22 ≤ 23 (a 5th node anywhere would overflow to 24).
  {
    idPrefix: 'storage.capDry', effectKind: 'storageCategoryCapMul',
    effectExtra: { category: 'dry_goods' }, subPath: 'storage',
    growth: 1.10, baseCost: 1, costGrowth: 1.5, count: 4,
  },
  {
    idPrefix: 'storage.capLiq', effectKind: 'storageCategoryCapMul',
    effectExtra: { category: 'liquid_gas' }, subPath: 'storage',
    growth: 1.10, baseCost: 1, costGrowth: 1.5, count: 4,
  },
  {
    idPrefix: 'storage.capComp', effectKind: 'storageCategoryCapMul',
    effectExtra: { category: 'components' }, subPath: 'storage',
    growth: 1.10, baseCost: 1, costGrowth: 1.5, count: 4,
  },
  {
    idPrefix: 'storage.capRare', effectKind: 'storageCategoryCapMul',
    effectExtra: { category: 'rare' }, subPath: 'storage',
    growth: 1.10, baseCost: 1, costGrowth: 1.5, count: 4,
  },
];
export const STORAGE_FILLER_NODES = STORAGE_FILLER_ARCHETYPES.flatMap(generateFillerNodes);

export const TRANSPORT_FILLER_ARCHETYPES: FillerArchetype[] = [
  // C6a: droneFuel (droneFuelEfficiencyMul) rehomed to robotics — robotics.droneFuel
  // filler already carries the pool. 2 kept chains.
  {
    idPrefix: 'transport.routeCapacity', effectKind: 'routeCapacityMul',
    subPath: 'transport', growth: 1.10, baseCost: 1, costGrowth: 1.4, count: 8,
  },
  {
    idPrefix: 'transport.airshipRange', effectKind: 'airshipRangeMul',
    subPath: 'transport', growth: 1.10, baseCost: 2, costGrowth: 1.5, count: 5,
  },
];
export const TRANSPORT_FILLER_NODES = TRANSPORT_FILLER_ARCHETYPES.flatMap(generateFillerNodes);

export const NETWORK_FILLER_ARCHETYPES: FillerArchetype[] = [
  // C6a: deliberately-sparse 1-chain sub-path (spec-approved). commRange
  // (commRangeMul) rehomed to communication — communication.commRange filler
  // carries the pool. scanner (scannerCoverageMul) rehomed to discovery —
  // discovery.scannerCoverage + oceanography.scannerCoverage fillers carry the pool.
  {
    idPrefix: 'network.teleporter', effectKind: 'teleporterEfficiencyMul',
    subPath: 'network', growth: 1.10, baseCost: 2, costGrowth: 1.5, count: 5,
  },
];
export const NETWORK_FILLER_NODES = NETWORK_FILLER_ARCHETYPES.flatMap(generateFillerNodes);

// ---------------------------------------------------------------------------
// Orbital branch
// ---------------------------------------------------------------------------

export const LAUNCH_FILLER_ARCHETYPES: FillerArchetype[] = [
  {
    idPrefix: 'launch.success', effectKind: 'launchSuccessAdditive',
    subPath: 'launch', growth: 1.10, baseCost: 1, costGrowth: 1.4, count: 7,
  },
  {
    idPrefix: 'launch.padSafety', effectKind: 'padExplosionReduceMul',
    subPath: 'launch', growth: 1.10, baseCost: 2, costGrowth: 1.5, count: 5,
  },
  {
    idPrefix: 'launch.satBuffer', effectKind: 'satBufferCapMul',
    subPath: 'launch', growth: 1.10, baseCost: 2, costGrowth: 1.6, count: 5,
  },
  {
    idPrefix: 'launch.satFuel', effectKind: 'satFuelReserveMul',
    subPath: 'launch', growth: 1.10, baseCost: 3, costGrowth: 1.7, count: 4,
  },
];
export const LAUNCH_FILLER_NODES = LAUNCH_FILLER_ARCHETYPES.flatMap(generateFillerNodes);

export const COMMUNICATION_FILLER_ARCHETYPES: FillerArchetype[] = [
  {
    idPrefix: 'communication.commRange', effectKind: 'commRangeMul',
    subPath: 'communication', growth: 1.10, baseCost: 1, costGrowth: 1.4, count: 8,
  },
  {
    idPrefix: 'communication.satBuffer', effectKind: 'satBufferCapMul',
    subPath: 'communication', growth: 1.10, baseCost: 2, costGrowth: 1.5, count: 5,
  },
  {
    idPrefix: 'communication.scanner', effectKind: 'scannerCoverageMul',
    subPath: 'communication', growth: 1.10, baseCost: 2, costGrowth: 1.6, count: 5,
  },
];
export const COMMUNICATION_FILLER_NODES = COMMUNICATION_FILLER_ARCHETYPES.flatMap(generateFillerNodes);

export const DISCOVERY_FILLER_ARCHETYPES: FillerArchetype[] = [
  {
    idPrefix: 'discovery.scannerCoverage', effectKind: 'scannerCoverageMul',
    subPath: 'discovery', growth: 1.10, baseCost: 1, costGrowth: 1.4, count: 8,
  },
  {
    idPrefix: 'discovery.scannerDwell', effectKind: 'scannerDwellRateMul',
    subPath: 'discovery', growth: 1.10, baseCost: 2, costGrowth: 1.5, count: 5,
  },
  {
    idPrefix: 'discovery.droneScan', effectKind: 'droneScanRadiusMul',
    subPath: 'discovery', growth: 1.10, baseCost: 2, costGrowth: 1.6, count: 5,
  },
];
export const DISCOVERY_FILLER_NODES = DISCOVERY_FILLER_ARCHETYPES.flatMap(generateFillerNodes);

export const RESILIENCE_FILLER_ARCHETYPES: FillerArchetype[] = [
  {
    idPrefix: 'resilience.debris', effectKind: 'debrisProtectionMul',
    subPath: 'resilience', growth: 1.10, baseCost: 1, costGrowth: 1.4, count: 7,
  },
  {
    idPrefix: 'resilience.repairDrone', effectKind: 'repairDroneReliabilityMul',
    subPath: 'resilience', growth: 1.10, baseCost: 2, costGrowth: 1.5, count: 5,
  },
  {
    idPrefix: 'resilience.maintenance', effectKind: 'maintenanceThresholdMul',
    subPath: 'resilience', growth: 1.10, baseCost: 1, costGrowth: 1.5, count: 7,
  },
];
export const RESILIENCE_FILLER_NODES = RESILIENCE_FILLER_ARCHETYPES.flatMap(generateFillerNodes);

// ---------------------------------------------------------------------------
// Ocean branch (new — spec-locked 5×4=20 sub-paths)
// ---------------------------------------------------------------------------

export const PATRONAGE_FILLER_ARCHETYPES: FillerArchetype[] = [
  // C5: deliberately-sparse 1-chain sub-path (spec-approved). patronage.recipeRate
  // (recipeRateMul:extraction — patronage is not an extractor), patronage.storageCap
  // (storageCategoryCapMul:rare → storage), and patronage.commRange (commRangeMul →
  // communication) were all removed; only the patronage-yield chain remains.
  {
    idPrefix: 'patronage.patronageYield', effectKind: 'patronageYieldBonusMul',
    subPath: 'patronage', growth: 1.10,
    baseCost: 1, costGrowth: 1.5, count: 8,
  },
];
export const PATRONAGE_FILLER_NODES = PATRONAGE_FILLER_ARCHETYPES.flatMap(generateFillerNodes);

export const AQUACULTURE_FILLER_ARCHETYPES: FillerArchetype[] = [
  // C5: aquaculture.yieldBonus (mineYieldBonusMul — duplicate, mining already
  // covers this) and aquaculture.storageCap (storageCategoryCapMul:dry_goods →
  // storage sub-path) removed; 2 kept chains.
  {
    idPrefix: 'aquaculture.recipeRate', effectKind: 'recipeRateMul',
    effectExtra: { category: 'extraction' }, subPath: 'aquaculture',
    growth: 1.10, baseCost: 1, costGrowth: 1.4, count: 7,
  },
  {
    idPrefix: 'aquaculture.aquaYield', effectKind: 'aquacultureYieldBonusMul',
    subPath: 'aquaculture', growth: 1.10,
    baseCost: 1, costGrowth: 1.5, count: 8,
  },
];
export const AQUACULTURE_FILLER_NODES = AQUACULTURE_FILLER_ARCHETYPES.flatMap(generateFillerNodes);

export const HYDROPROCESSING_FILLER_ARCHETYPES: FillerArchetype[] = [
  // C3a: deliberately-sparse single-chain sub-path (spec-approved). The
  // generic storageCapMul chain and the powerConsumptionMul chain were
  // removed; only the chemistry recipe-rate chain remains.
  {
    idPrefix: 'hydroprocessing.recipeRate', effectKind: 'recipeRateMul',
    effectExtra: { category: 'chemistry' }, subPath: 'hydroprocessing',
    growth: 1.10, baseCost: 1, costGrowth: 1.4, count: 7,
  },
];
export const HYDROPROCESSING_FILLER_NODES = HYDROPROCESSING_FILLER_ARCHETYPES.flatMap(generateFillerNodes);

export const SUBMARINE_FILLER_ARCHETYPES: FillerArchetype[] = [
  // C5: submarine.powerProduction (powerProductionMul → power_systems sub-path)
  // removed; 2 kept chains.
  {
    idPrefix: 'submarine.routeCapacity', effectKind: 'routeCapacityMul',
    subPath: 'submarine', growth: 1.10, baseCost: 1, costGrowth: 1.4, count: 7,
  },
  {
    idPrefix: 'submarine.airshipRange', effectKind: 'airshipRangeMul',
    subPath: 'submarine', growth: 1.10, baseCost: 2, costGrowth: 1.6, count: 5,
  },
];
export const SUBMARINE_FILLER_NODES = SUBMARINE_FILLER_ARCHETYPES.flatMap(generateFillerNodes);

export const OCEANOGRAPHY_FILLER_ARCHETYPES: FillerArchetype[] = [
  // C5: oceanography.commRange (commRangeMul → communication sub-path) and
  // oceanography.droneScan (droneScanRadiusMul → discovery sub-path) removed;
  // 2 kept chains.
  {
    idPrefix: 'oceanography.scannerCoverage', effectKind: 'scannerCoverageMul',
    subPath: 'oceanography', growth: 1.10, baseCost: 1, costGrowth: 1.4, count: 7,
  },
  {
    idPrefix: 'oceanography.t5ExtractorYield', effectKind: 't5ExtractorYieldBonusMul',
    subPath: 'oceanography', growth: 1.10,
    baseCost: 1, costGrowth: 1.5, count: 8,
  },
];
export const OCEANOGRAPHY_FILLER_NODES = OCEANOGRAPHY_FILLER_ARCHETYPES.flatMap(generateFillerNodes);

// ---------------------------------------------------------------------------
// Aggregate
// ---------------------------------------------------------------------------

export const ALL_FILLER_NODES: RawSkillNode[] = [
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
  ...PATRONAGE_FILLER_NODES,
  ...AQUACULTURE_FILLER_NODES,
  ...HYDROPROCESSING_FILLER_NODES,
  ...SUBMARINE_FILLER_NODES,
  ...OCEANOGRAPHY_FILLER_NODES,
];

/** Flat list of every archetype's idPrefix for tier inference. */
export const ALL_ARCHETYPE_PREFIXES: ReadonlyArray<string> = [
  ...MINING_FILLER_ARCHETYPES,
  ...FORESTRY_FILLER_ARCHETYPES,
  ...DRILLING_FILLER_ARCHETYPES,
  ...ROBOTICS_FILLER_ARCHETYPES,
  ...SMELTING_FILLER_ARCHETYPES,
  ...CHEMISTRY_FILLER_ARCHETYPES,
  ...ELECTRONICS_FILLER_ARCHETYPES,
  ...POWER_SYSTEMS_FILLER_ARCHETYPES,
  ...STORAGE_FILLER_ARCHETYPES,
  ...TRANSPORT_FILLER_ARCHETYPES,
  ...NETWORK_FILLER_ARCHETYPES,
  ...LAUNCH_FILLER_ARCHETYPES,
  ...COMMUNICATION_FILLER_ARCHETYPES,
  ...DISCOVERY_FILLER_ARCHETYPES,
  ...RESILIENCE_FILLER_ARCHETYPES,
  ...PATRONAGE_FILLER_ARCHETYPES,
  ...AQUACULTURE_FILLER_ARCHETYPES,
  ...HYDROPROCESSING_FILLER_ARCHETYPES,
  ...SUBMARINE_FILLER_ARCHETYPES,
  ...OCEANOGRAPHY_FILLER_ARCHETYPES,
].map((a) => a.idPrefix);
