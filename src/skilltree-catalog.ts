import type { SkillNode, NodeId, BranchId } from './skilltree.js';
import type { KeystonePrereq, BridgeEdge, GraftSocket } from './skilltree-graph.js';
import { ALL_FILLER_NODES } from './skilltree-archetypes.js';

// ---------------------------------------------------------------------------
// Extraction branch
// ---------------------------------------------------------------------------

export const MINING_NOTABLES: SkillNode[] = [
  {
    id: 'mining.notable.deepVein' as NodeId,
    subPath: 'mining',
    depth: 4,
    cost: 4,
    magnitude: 0.20,
    effect: { kind: 'mineYieldBonusMul' },
    description: 'Deep Vein Surveying — +20% mine yield per Mine',
    aura: { radius: 1, bonus: 0.10 },
  },
  {
    id: 'mining.notable.heliumSeep' as NodeId,
    subPath: 'mining',
    depth: 5,
    cost: 5,
    magnitude: 0.15,
    effect: { kind: 'mineRareTrickleMul' },
    description: 'Helium Seep Detection — +15% helium-3 trickle from Mines',
  },
  {
    id: 'mining.notable.efficientDrills' as NodeId,
    subPath: 'mining',
    depth: 3,
    cost: 3,
    magnitude: 0.25,
    effect: { kind: 'powerConsumptionMul', reduce: true },
    description: 'Efficient Drillheads — Mines consume 25% less power',
  },
  {
    id: 'mining.notable.blastOptimization' as NodeId,
    subPath: 'mining',
    depth: 6,
    cost: 6,
    magnitude: 0.30,
    effect: { kind: 'recipeRateMul', category: 'extraction' },
    description: 'Blast Optimization — +30% extraction recipe rate',
    aura: { radius: 2, bonus: 0.12 },
  },
];

export const FORESTRY_NOTABLES: SkillNode[] = [
  {
    id: 'forestry.notable.selectiveHarvest' as NodeId,
    subPath: 'forestry',
    depth: 4,
    cost: 4,
    magnitude: 0.20,
    effect: { kind: 'loggerYieldBonusMul' },
    description: 'Selective Harvesting — +20% logger yield per Logger',
    aura: { radius: 1, bonus: 0.10 },
  },
  {
    id: 'forestry.notable.exoticInoculation' as NodeId,
    subPath: 'forestry',
    depth: 5,
    cost: 5,
    magnitude: 0.15,
    effect: { kind: 'loggerExoticTrickleMul' },
    description: 'Exotic Inoculation — +15% exotic-species trickle from Loggers',
  },
  {
    id: 'forestry.notable.clearcutCoordination' as NodeId,
    subPath: 'forestry',
    depth: 3,
    cost: 3,
    magnitude: 0.25,
    effect: { kind: 'recipeRateMul', category: 'extraction' },
    description: 'Clear-cut Coordination — +25% extraction recipe rate',
  },
  {
    id: 'forestry.notable.silvicultureHub' as NodeId,
    subPath: 'forestry',
    depth: 6,
    cost: 6,
    magnitude: 0.30,
    effect: { kind: 'storageCategoryCapMul', category: 'dry_goods' },
    description: 'Silviculture Hub — +30% dry-goods storage cap',
    aura: { radius: 2, bonus: 0.12 },
  },
];

export const DRILLING_NOTABLES: SkillNode[] = [
  {
    id: 'drilling.notable.pressurizedRecovery' as NodeId,
    subPath: 'drilling',
    depth: 4,
    cost: 4,
    magnitude: 0.20,
    effect: { kind: 'recipeRateMul', category: 'extraction' },
    description: 'Pressurized Recovery — +20% extraction recipe rate',
    aura: { radius: 1, bonus: 0.10 },
  },
  {
    id: 'drilling.notable.reservoirMapping' as NodeId,
    subPath: 'drilling',
    depth: 5,
    cost: 5,
    magnitude: 0.15,
    effect: { kind: 'mineYieldBonusMul' },
    description: 'Reservoir Mapping — +15% yield from drill-type mines',
  },
  {
    id: 'drilling.notable.subseaTanks' as NodeId,
    subPath: 'drilling',
    depth: 3,
    cost: 3,
    magnitude: 0.25,
    effect: { kind: 'storageCategoryCapMul', category: 'liquid_gas' },
    description: 'Subsea Tanks — +25% liquid-gas storage cap',
  },
  {
    id: 'drilling.notable.deepBore' as NodeId,
    subPath: 'drilling',
    depth: 6,
    cost: 6,
    magnitude: 0.30,
    effect: { kind: 'powerConsumptionMul', reduce: true },
    description: 'Deep-bore Thermals — drill-type mines consume 30% less power',
    aura: { radius: 2, bonus: 0.12 },
  },
];

export const ROBOTICS_NOTABLES: SkillNode[] = [
  {
    id: 'robotics.notable.swarmAssembly' as NodeId,
    subPath: 'robotics',
    depth: 4,
    cost: 4,
    magnitude: 0.20,
    effect: { kind: 'constructionTimeMul' },
    description: 'Swarm Assembly — +20% faster construction',
    aura: { radius: 1, bonus: 0.10 },
  },
  {
    id: 'robotics.notable.parallelFoundries' as NodeId,
    subPath: 'robotics',
    depth: 5,
    cost: 5,
    magnitude: 0.15,
    effect: { kind: 'parallelBuildCapAdd' },
    description: 'Parallel Foundries — +15% parallel build slots',
  },
  {
    id: 'robotics.notable.droneOptics' as NodeId,
    subPath: 'robotics',
    depth: 3,
    cost: 3,
    magnitude: 0.25,
    effect: { kind: 'droneScanRadiusMul' },
    description: 'Drone Optics Upgrade — +25% drone scan radius',
  },
  {
    id: 'robotics.notable.biofuelCell' as NodeId,
    subPath: 'robotics',
    depth: 6,
    cost: 6,
    magnitude: 0.30,
    effect: { kind: 'droneFuelEfficiencyMul' },
    description: 'Biofuel Cells — +30% drone fuel efficiency',
    aura: { radius: 2, bonus: 0.12 },
  },
];

// ---------------------------------------------------------------------------
// Refinement branch
// ---------------------------------------------------------------------------

export const SMELTING_NOTABLES: SkillNode[] = [
  {
    id: 'smelting.notable.inductionArc' as NodeId,
    subPath: 'smelting',
    depth: 4,
    cost: 4,
    magnitude: 0.20,
    effect: { kind: 'recipeRateMul', category: 'smelting' },
    description: 'Induction Arc — +20% smelting recipe rate',
    aura: { radius: 1, bonus: 0.10 },
  },
  {
    id: 'smelting.notable.heatRecapture' as NodeId,
    subPath: 'smelting',
    depth: 5,
    cost: 5,
    magnitude: 0.15,
    effect: { kind: 'powerConsumptionMul', reduce: true },
    description: 'Heat Recapture — smelters consume 15% less power',
  },
  {
    id: 'smelting.notable.refractoryLining' as NodeId,
    subPath: 'smelting',
    depth: 3,
    cost: 3,
    magnitude: 0.25,
    effect: { kind: 'maintenanceThresholdMul' },
    description: 'Refractory Lining — +25% maintenance threshold for smelters',
  },
  {
    id: 'smelting.notable.alloyTolerance' as NodeId,
    subPath: 'smelting',
    depth: 6,
    cost: 6,
    magnitude: 0.30,
    effect: { kind: 'recipeRateMul', category: 'smelting' },
    description: 'Alloy Tolerance — +30% smelting recipe rate',
    aura: { radius: 2, bonus: 0.12 },
  },
];

export const CHEMISTRY_NOTABLES: SkillNode[] = [
  {
    id: 'chemistry.notable.catalyticCracking' as NodeId,
    subPath: 'chemistry',
    depth: 4,
    cost: 4,
    magnitude: 0.20,
    effect: { kind: 'recipeRateMul', category: 'chemistry' },
    description: 'Catalytic Cracking — +20% chemistry recipe rate',
    aura: { radius: 1, bonus: 0.10 },
  },
  {
    id: 'chemistry.notable.pressurizedReactors' as NodeId,
    subPath: 'chemistry',
    depth: 5,
    cost: 5,
    magnitude: 0.15,
    effect: { kind: 'powerConsumptionMul', reduce: true },
    description: 'Pressurized Reactors — chemistry plants consume 15% less power',
  },
  {
    id: 'chemistry.notable.greenChemistry' as NodeId,
    subPath: 'chemistry',
    depth: 3,
    cost: 3,
    magnitude: 0.25,
    effect: { kind: 'storageCategoryCapMul', category: 'liquid_gas' },
    description: 'Green Chemistry — +25% liquid-gas storage cap',
  },
  {
    id: 'chemistry.notable.polymerMatrix' as NodeId,
    subPath: 'chemistry',
    depth: 6,
    cost: 6,
    magnitude: 0.30,
    effect: { kind: 'recipeRateMul', category: 'chemistry' },
    description: 'Polymer Matrix — +30% chemistry recipe rate',
    aura: { radius: 2, bonus: 0.12 },
  },
];

export const ELECTRONICS_NOTABLES: SkillNode[] = [
  {
    id: 'electronics.notable.cleanRoom' as NodeId,
    subPath: 'electronics',
    depth: 4,
    cost: 4,
    magnitude: 0.20,
    effect: { kind: 'recipeRateMul', category: 'electronics' },
    description: 'Clean Room — +20% electronics recipe rate',
    aura: { radius: 1, bonus: 0.10 },
  },
  {
    id: 'electronics.notable.lowPowerDesign' as NodeId,
    subPath: 'electronics',
    depth: 5,
    cost: 5,
    magnitude: 0.15,
    effect: { kind: 'powerConsumptionMul', reduce: true },
    description: 'Low-Power Design — electronics plants consume 15% less power',
  },
  {
    id: 'electronics.notable.satBandwidth' as NodeId,
    subPath: 'electronics',
    depth: 3,
    cost: 3,
    magnitude: 0.25,
    effect: { kind: 'satBufferCapMul' },
    description: 'Sat Bandwidth — +25% satellite buffer capacity',
  },
  {
    id: 'electronics.notable.quantumEtching' as NodeId,
    subPath: 'electronics',
    depth: 6,
    cost: 6,
    magnitude: 0.30,
    effect: { kind: 'recipeRateMul', category: 'electronics' },
    description: 'Quantum Etching — +30% electronics recipe rate',
    aura: { radius: 2, bonus: 0.12 },
  },
];

export const POWER_SYSTEMS_NOTABLES: SkillNode[] = [
  {
    id: 'power_systems.notable.turbineStaging' as NodeId,
    subPath: 'power_systems',
    depth: 4,
    cost: 4,
    magnitude: 0.20,
    effect: { kind: 'powerProductionMul' },
    description: 'Turbine Staging — +20% power production',
    aura: { radius: 1, bonus: 0.10 },
  },
  {
    id: 'power_systems.notable.smartGrid' as NodeId,
    subPath: 'power_systems',
    depth: 5,
    cost: 5,
    magnitude: 0.15,
    effect: { kind: 'powerConsumptionMul', reduce: true },
    description: 'Smart Grid — power consumers draw 15% less',
  },
  {
    id: 'power_systems.notable.xpTelemetry' as NodeId,
    subPath: 'power_systems',
    depth: 3,
    cost: 3,
    magnitude: 0.25,
    effect: { kind: 'xpGainMul', category: 'power' },
    description: 'XP Telemetry — +25% XP gain from power-category recipes',
  },
  {
    id: 'power_systems.notable.fusionPilot' as NodeId,
    subPath: 'power_systems',
    depth: 6,
    cost: 6,
    magnitude: 0.30,
    effect: { kind: 'powerProductionMul' },
    description: 'Fusion Pilot — +30% power production',
    aura: { radius: 2, bonus: 0.12 },
  },
];

// ---------------------------------------------------------------------------
// Logistics branch
// ---------------------------------------------------------------------------

export const STORAGE_NOTABLES: SkillNode[] = [
  {
    id: 'storage.notable.verticalSilo' as NodeId,
    subPath: 'storage',
    depth: 4,
    cost: 4,
    magnitude: 0.20,
    effect: { kind: 'storageCapMul' },
    description: 'Vertical Silos — +20% uniform storage cap',
    aura: { radius: 1, bonus: 0.10 },
  },
  {
    id: 'storage.notable.vaultClimate' as NodeId,
    subPath: 'storage',
    depth: 5,
    cost: 5,
    magnitude: 0.15,
    effect: { kind: 'storageCategoryCapMul', category: 'rare' },
    description: 'Vault Climate Control — +15% rare-materials storage cap',
  },
  {
    id: 'storage.notable.componentRacks' as NodeId,
    subPath: 'storage',
    depth: 3,
    cost: 3,
    magnitude: 0.25,
    effect: { kind: 'storageCategoryCapMul', category: 'components' },
    description: 'Component Racks — +25% component storage cap',
  },
  {
    id: 'storage.notable.predictiveMaintenance' as NodeId,
    subPath: 'storage',
    depth: 6,
    cost: 6,
    magnitude: 0.30,
    effect: { kind: 'maintenanceThresholdMul' },
    description: 'Predictive Maintenance — +30% maintenance threshold',
    aura: { radius: 2, bonus: 0.12 },
  },
];

export const TRANSPORT_NOTABLES: SkillNode[] = [
  {
    id: 'transport.notable.heavyHaul' as NodeId,
    subPath: 'transport',
    depth: 4,
    cost: 4,
    magnitude: 0.20,
    effect: { kind: 'routeCapacityMul' },
    description: 'Heavy Haul — +20% route capacity',
    aura: { radius: 1, bonus: 0.10 },
  },
  {
    id: 'transport.notable.jetStream' as NodeId,
    subPath: 'transport',
    depth: 5,
    cost: 5,
    magnitude: 0.15,
    effect: { kind: 'airshipRangeMul' },
    description: 'Jet Stream Routing — +15% airship range',
  },
  {
    id: 'transport.notable.droneSwarmLogistics' as NodeId,
    subPath: 'transport',
    depth: 3,
    cost: 3,
    magnitude: 0.25,
    effect: { kind: 'droneFuelEfficiencyMul' },
    description: 'Drone Swarm Logistics — +25% drone fuel efficiency',
  },
  {
    id: 'transport.notable.supplyHub' as NodeId,
    subPath: 'transport',
    depth: 6,
    cost: 6,
    magnitude: 0.30,
    effect: { kind: 'routeCapacityMul' },
    description: 'Supply Hub — +30% route capacity',
    aura: { radius: 2, bonus: 0.12 },
  },
];

export const NETWORK_NOTABLES: SkillNode[] = [
  {
    id: 'network.notable.relayAmplifier' as NodeId,
    subPath: 'network',
    depth: 4,
    cost: 4,
    magnitude: 0.20,
    effect: { kind: 'commRangeMul' },
    description: 'Relay Amplifier — +20% communication range',
    aura: { radius: 1, bonus: 0.10 },
  },
  {
    id: 'network.notable.teleporterCoil' as NodeId,
    subPath: 'network',
    depth: 5,
    cost: 5,
    magnitude: 0.15,
    effect: { kind: 'teleporterEfficiencyMul' },
    description: 'Teleporter Coil — +15% teleporter efficiency',
  },
  {
    id: 'network.notable.scannerUplink' as NodeId,
    subPath: 'network',
    depth: 3,
    cost: 3,
    magnitude: 0.25,
    effect: { kind: 'scannerCoverageMul' },
    description: 'Scanner Uplink — +25% scanner coverage',
  },
  {
    id: 'network.notable.meshNetwork' as NodeId,
    subPath: 'network',
    depth: 6,
    cost: 6,
    magnitude: 0.30,
    effect: { kind: 'commRangeMul' },
    description: 'Mesh Network — +30% communication range',
    aura: { radius: 2, bonus: 0.12 },
  },
];

export const PATRONAGE_NOTABLES: SkillNode[] = [
  {
    id: 'patronage.notable.sponsorContracts' as NodeId,
    subPath: 'patronage',
    depth: 4,
    cost: 4,
    magnitude: 0.20,
    effect: { kind: 'recipeRateMul', category: 'extraction' },
    description: 'Sponsor Contracts — +20% extraction recipe rate',
    aura: { radius: 1, bonus: 0.10 },
  },
  {
    id: 'patronage.notable.curatorVaults' as NodeId,
    subPath: 'patronage',
    depth: 5,
    cost: 5,
    magnitude: 0.15,
    effect: { kind: 'storageCategoryCapMul', category: 'rare' },
    description: 'Curator Vaults — +15% rare-materials storage cap',
  },
  {
    id: 'patronage.notable.diplomaticChannels' as NodeId,
    subPath: 'patronage',
    depth: 3,
    cost: 3,
    magnitude: 0.25,
    effect: { kind: 'commRangeMul' },
    description: 'Diplomatic Channels — +25% communication range',
  },
  {
    id: 'patronage.notable.endowmentFund' as NodeId,
    subPath: 'patronage',
    depth: 6,
    cost: 6,
    magnitude: 0.30,
    effect: { kind: 'recipeRateMul', category: 'manufacturing' },
    description: 'Endowment Fund — +30% manufacturing recipe rate',
    aura: { radius: 2, bonus: 0.12 },
  },
];

// ---------------------------------------------------------------------------
// Ocean branch
// ---------------------------------------------------------------------------

export const AQUACULTURE_NOTABLES: SkillNode[] = [
  {
    id: 'aquaculture.notable.kelpTowers' as NodeId,
    subPath: 'aquaculture',
    depth: 4,
    cost: 4,
    magnitude: 0.20,
    effect: { kind: 'recipeRateMul', category: 'extraction' },
    description: 'Kelp Towers — +20% extraction recipe rate',
    aura: { radius: 1, bonus: 0.10 },
  },
  {
    id: 'aquaculture.notable.brineConcentration' as NodeId,
    subPath: 'aquaculture',
    depth: 5,
    cost: 5,
    magnitude: 0.15,
    effect: { kind: 'mineYieldBonusMul' },
    description: 'Brine Concentration — +15% yield from ocean extractors',
  },
  {
    id: 'aquaculture.notable.dryStorageBarges' as NodeId,
    subPath: 'aquaculture',
    depth: 3,
    cost: 3,
    magnitude: 0.25,
    effect: { kind: 'storageCategoryCapMul', category: 'dry_goods' },
    description: 'Dry-storage Barges — +25% dry-goods storage cap',
  },
  {
    id: 'aquaculture.notable.maricultureGrid' as NodeId,
    subPath: 'aquaculture',
    depth: 6,
    cost: 6,
    magnitude: 0.30,
    effect: { kind: 'recipeRateMul', category: 'extraction' },
    description: 'Mariculture Grid — +30% extraction recipe rate',
    aura: { radius: 2, bonus: 0.12 },
  },
];

export const HYDROPROCESSING_NOTABLES: SkillNode[] = [
  {
    id: 'hydroprocessing.notable.desalinationCascade' as NodeId,
    subPath: 'hydroprocessing',
    depth: 4,
    cost: 4,
    magnitude: 0.20,
    effect: { kind: 'recipeRateMul', category: 'chemistry' },
    description: 'Desalination Cascade — +20% chemistry recipe rate',
    aura: { radius: 1, bonus: 0.10 },
  },
  {
    id: 'hydroprocessing.notable.osmoticPump' as NodeId,
    subPath: 'hydroprocessing',
    depth: 5,
    cost: 5,
    magnitude: 0.15,
    effect: { kind: 'powerConsumptionMul', reduce: true },
    description: 'Osmotic Pump — hydro plants consume 15% less power',
  },
  {
    id: 'hydroprocessing.notable.floatingTanks' as NodeId,
    subPath: 'hydroprocessing',
    depth: 3,
    cost: 3,
    magnitude: 0.25,
    effect: { kind: 'storageCapMul' },
    description: 'Floating Tanks — +25% uniform storage cap',
  },
  {
    id: 'hydroprocessing.notable.membraneBreakthrough' as NodeId,
    subPath: 'hydroprocessing',
    depth: 6,
    cost: 6,
    magnitude: 0.30,
    effect: { kind: 'recipeRateMul', category: 'chemistry' },
    description: 'Membrane Breakthrough — +30% chemistry recipe rate',
    aura: { radius: 2, bonus: 0.12 },
  },
];

export const SUBMARINE_NOTABLES: SkillNode[] = [
  {
    id: 'submarine.notable.pressureHull' as NodeId,
    subPath: 'submarine',
    depth: 4,
    cost: 4,
    magnitude: 0.20,
    effect: { kind: 'routeCapacityMul' },
    description: 'Pressure-hull Routing — +20% route capacity',
    aura: { radius: 1, bonus: 0.10 },
  },
  {
    id: 'submarine.notable.thermalGradient' as NodeId,
    subPath: 'submarine',
    depth: 5,
    cost: 5,
    magnitude: 0.15,
    effect: { kind: 'powerProductionMul' },
    description: 'Thermal-gradient Harvest — +15% power production',
  },
  {
    id: 'submarine.notable.sonarMapping' as NodeId,
    subPath: 'submarine',
    depth: 3,
    cost: 3,
    magnitude: 0.25,
    effect: { kind: 'airshipRangeMul' },
    description: 'Sonar Mapping — +25% airship range over ocean',
  },
  {
    id: 'submarine.notable.deepFreighter' as NodeId,
    subPath: 'submarine',
    depth: 6,
    cost: 6,
    magnitude: 0.30,
    effect: { kind: 'routeCapacityMul' },
    description: 'Deep Freighter — +30% route capacity',
    aura: { radius: 2, bonus: 0.12 },
  },
];

export const OCEANOGRAPHY_NOTABLES: SkillNode[] = [
  {
    id: 'oceanography.notable.buoyArray' as NodeId,
    subPath: 'oceanography',
    depth: 4,
    cost: 4,
    magnitude: 0.20,
    effect: { kind: 'scannerCoverageMul' },
    description: 'Buoy Array — +20% scanner coverage',
    aura: { radius: 1, bonus: 0.10 },
  },
  {
    id: 'oceanography.notable.seafloorCable' as NodeId,
    subPath: 'oceanography',
    depth: 5,
    cost: 5,
    magnitude: 0.15,
    effect: { kind: 'commRangeMul' },
    description: 'Seafloor Cable — +15% communication range',
  },
  {
    id: 'oceanography.notable.aerialSurvey' as NodeId,
    subPath: 'oceanography',
    depth: 3,
    cost: 3,
    magnitude: 0.25,
    effect: { kind: 'droneScanRadiusMul' },
    description: 'Aerial Survey — +25% drone scan radius',
  },
  {
    id: 'oceanography.notable.tidalPrediction' as NodeId,
    subPath: 'oceanography',
    depth: 6,
    cost: 6,
    magnitude: 0.30,
    effect: { kind: 'scannerCoverageMul' },
    description: 'Tidal Prediction — +30% scanner coverage',
    aura: { radius: 2, bonus: 0.12 },
  },
];

// ---------------------------------------------------------------------------
// Orbital branch
// ---------------------------------------------------------------------------

export const LAUNCH_NOTABLES: SkillNode[] = [
  {
    id: 'launch.notable.padRedundancy' as NodeId,
    subPath: 'launch',
    depth: 4,
    cost: 4,
    magnitude: 0.20,
    effect: { kind: 'launchSuccessAdditive' },
    description: 'Pad Redundancy — +20% launch success rate',
    aura: { radius: 1, bonus: 0.10 },
  },
  {
    id: 'launch.notable.blastDeflector' as NodeId,
    subPath: 'launch',
    depth: 5,
    cost: 5,
    magnitude: 0.15,
    effect: { kind: 'padExplosionReduceMul' },
    description: 'Blast Deflector — +15% pad explosion reduction',
  },
  {
    id: 'launch.notable.satDatapool' as NodeId,
    subPath: 'launch',
    depth: 3,
    cost: 3,
    magnitude: 0.25,
    effect: { kind: 'satBufferCapMul' },
    description: 'Sat Datapool — +25% satellite buffer capacity',
  },
  {
    id: 'launch.notable.reserveTanks' as NodeId,
    subPath: 'launch',
    depth: 6,
    cost: 6,
    magnitude: 0.30,
    effect: { kind: 'satFuelReserveMul' },
    description: 'Reserve Tanks — +30% satellite fuel reserve',
    aura: { radius: 2, bonus: 0.12 },
  },
];

export const COMMUNICATION_NOTABLES: SkillNode[] = [
  {
    id: 'communication.notable.groundStationHub' as NodeId,
    subPath: 'communication',
    depth: 4,
    cost: 4,
    magnitude: 0.20,
    effect: { kind: 'commRangeMul' },
    description: 'Ground-station Hub — +20% communication range',
    aura: { radius: 1, bonus: 0.10 },
  },
  {
    id: 'communication.notable.packetBurst' as NodeId,
    subPath: 'communication',
    depth: 5,
    cost: 5,
    magnitude: 0.15,
    effect: { kind: 'satBufferCapMul' },
    description: 'Packet Burst — +15% satellite buffer capacity',
  },
  {
    id: 'communication.notable.scannerOverlap' as NodeId,
    subPath: 'communication',
    depth: 3,
    cost: 3,
    magnitude: 0.25,
    effect: { kind: 'scannerCoverageMul' },
    description: 'Scanner Overlap — +25% scanner coverage',
  },
  {
    id: 'communication.notable.relayConstellation' as NodeId,
    subPath: 'communication',
    depth: 6,
    cost: 6,
    magnitude: 0.30,
    effect: { kind: 'commRangeMul' },
    description: 'Relay Constellation — +30% communication range',
    aura: { radius: 2, bonus: 0.12 },
  },
];

export const DISCOVERY_NOTABLES: SkillNode[] = [
  {
    id: 'discovery.notable.dwellOptimization' as NodeId,
    subPath: 'discovery',
    depth: 4,
    cost: 4,
    magnitude: 0.20,
    effect: { kind: 'scannerDwellRateMul' },
    description: 'Dwell Optimization — +20% scanner dwell rate',
    aura: { radius: 1, bonus: 0.10 },
  },
  {
    id: 'discovery.notable.wideAperture' as NodeId,
    subPath: 'discovery',
    depth: 5,
    cost: 5,
    magnitude: 0.15,
    effect: { kind: 'scannerCoverageMul' },
    description: 'Wide Aperture — +15% scanner coverage',
  },
  {
    id: 'discovery.notable.droneAstrogeology' as NodeId,
    subPath: 'discovery',
    depth: 3,
    cost: 3,
    magnitude: 0.25,
    effect: { kind: 'droneScanRadiusMul' },
    description: 'Drone Astrogeology — +25% drone scan radius',
  },
  {
    id: 'discovery.notable.deepField' as NodeId,
    subPath: 'discovery',
    depth: 6,
    cost: 6,
    magnitude: 0.30,
    effect: { kind: 'scannerCoverageMul' },
    description: 'Deep Field — +30% scanner coverage',
    aura: { radius: 2, bonus: 0.12 },
  },
];

export const RESILIENCE_NOTABLES: SkillNode[] = [
  {
    id: 'resilience.notable.orbitalShields' as NodeId,
    subPath: 'resilience',
    depth: 4,
    cost: 4,
    magnitude: 0.20,
    effect: { kind: 'debrisProtectionMul' },
    description: 'Orbital Shields — +20% debris protection',
    aura: { radius: 1, bonus: 0.10 },
  },
  {
    id: 'resilience.notable.redundantSystems' as NodeId,
    subPath: 'resilience',
    depth: 5,
    cost: 5,
    magnitude: 0.15,
    effect: { kind: 'repairDroneReliabilityMul' },
    description: 'Redundant Systems — +15% repair-drone reliability',
  },
  {
    id: 'resilience.notable.hardenedInfrastructure' as NodeId,
    subPath: 'resilience',
    depth: 3,
    cost: 3,
    magnitude: 0.25,
    effect: { kind: 'maintenanceThresholdMul' },
    description: 'Hardened Infrastructure — +25% maintenance threshold',
  },
  {
    id: 'resilience.notable.debrisWake' as NodeId,
    subPath: 'resilience',
    depth: 6,
    cost: 6,
    magnitude: 0.25,
    effect: { kind: 'debrisProtectionMul' },
    description: 'Debris Wake Dispersal — +25% debris protection',
    aura: { radius: 2, bonus: 0.12 },
  },
];

// ---------------------------------------------------------------------------
// Keystones — AND-prereq nodes (~30 total)
// ---------------------------------------------------------------------------

/** §9.4 role-absorption keystones */
export const ROLE_ABSORPTION_KEYSTONES: SkillNode[] = [
  {
    id: 'smelting.keystone.foundryMastery' as NodeId,
    subPath: 'smelting', depth: 8, cost: 10, magnitude: 0.50,
    effect: { kind: 'recipeRateMul', category: 'smelting' },
    description: 'Foundry Mastery — All smelters operate at +50% rate (absorbs §9.4 Foundry role)',
  },
  {
    id: 'chemistry.keystone.refineryMastery' as NodeId,
    subPath: 'chemistry', depth: 8, cost: 10, magnitude: 0.50,
    effect: { kind: 'recipeRateMul', category: 'chemistry' },
    description: 'Refinery Mastery — All chemistry plants operate at +50% rate (absorbs §9.4 Refinery role)',
  },
  {
    id: 'mining.keystone.veinmaster' as NodeId,
    subPath: 'mining', depth: 8, cost: 12, magnitude: 0.75,
    effect: { kind: 'recipeRateMul', category: 'extraction' },
    description: 'Veinmaster — All mines operate at +75% extraction rate (absorbs §9.4 Veinmaster role)',
  },
  {
    id: 'transport.keystone.hubCapacity' as NodeId,
    subPath: 'transport', depth: 8, cost: 10, magnitude: 1.0,
    effect: { kind: 'routeCapacityMul' },
    description: 'Hub Capacity — Route capacity doubled (absorbs §9.4 Logistics role)',
  },
  {
    id: 'storage.keystone.masterCache' as NodeId,
    subPath: 'storage', depth: 8, cost: 10, magnitude: 0.50,
    effect: { kind: 'storageCapMul' },
    description: 'Master Cache — All storage caps +50% (absorbs §9.4 Cache role)',
  },
  {
    id: 'power_systems.keystone.researchBeacon' as NodeId,
    subPath: 'power_systems', depth: 8, cost: 10, magnitude: 0.50,
    effect: { kind: 'xpGainMul' },
    description: 'Research Beacon — All XP gain +50% (absorbs §9.4 Beacon role)',
  },
];

/** Rule-breaker keystones using newly-wired effect kinds */
export const RULE_BREAKER_KEYSTONES: SkillNode[] = [
  {
    id: 'robotics.keystone.parallelConstruction' as NodeId,
    subPath: 'robotics', depth: 7, cost: 8, magnitude: 1.0,
    effect: { kind: 'structural', description: 'Parallel Construction +1 slot', data: { kind: 'parallelConstruction', bonus: 1 } },
    description: 'Parallel Construction — +1 concurrent build slot (structural rewrite)',
  },
  {
    id: 'forestry.keystone.charcoalUnlock' as NodeId,
    subPath: 'forestry', depth: 7, cost: 8, magnitude: 0.0,
    effect: { kind: 'unlockRecipe', targetBuilding: 'logger', recipe: { cycleSec: 20, inputs: { wood: 2 }, outputs: { coal: 1 }, category: 'extraction' } },
    description: 'Charcoal Kiln — Loggers gain a charcoal output recipe',
  },
  {
    id: 'drilling.keystone.earlyRig' as NodeId,
    subPath: 'drilling', depth: 7, cost: 8, magnitude: 0.0,
    effect: { kind: 'tierBypass', buildings: ['drilling_rig'], tierShift: 1 },
    description: 'Early Rig Permit — Drilling Rig operates one tier below requirement',
  },
  {
    id: 'smelting.keystone.pyroforgeBypass' as NodeId,
    subPath: 'smelting', depth: 7, cost: 8, magnitude: 0.0,
    effect: { kind: 'biomeBypass', buildings: ['pyroforge'] },
    description: 'Pyroforge License — Pyroforge can be placed off-volcanic biome',
  },
  {
    id: 'oceanography.keystone.sonarPair' as NodeId,
    subPath: 'oceanography', depth: 7, cost: 8, magnitude: 0.20,
    effect: { kind: 'exoticAdjacency', description: 'Dock+Tidal pair boost', effect: { kind: 'pairBoost', pair: ['dock', 'tidal_array'], recipeRateBonus: 0.2 } },
    description: 'Tidal Pairing — Adjacent Dock + Tidal Array boost each other +20%',
  },
  {
    id: 'network.keystone.sharedRoutes' as NodeId,
    subPath: 'network', depth: 7, cost: 8, magnitude: 0.0,
    effect: { kind: 'crossIslandShared', shape: { kind: 'sharedRouteCapacity' } },
    description: 'Shared Routes — Networked T3+ islands pool route-capacity bonus',
  },
  {
    id: 'communication.keystone.networkedExtract' as NodeId,
    subPath: 'communication', depth: 7, cost: 8, magnitude: 0.25,
    effect: { kind: 'conditionalBonus', multiplier: 0.25, appliesTo: 'extraction', condition: { kind: 'networked-to-N-T3-islands', n: 5 } },
    description: 'Networked Extraction — +25% extraction rate when networked to ≥5 T3 islands',
  },
  {
    id: 'mining.keystone.deepCore' as NodeId,
    subPath: 'mining', depth: 7, cost: 8, magnitude: 0.40,
    effect: { kind: 'mineYieldBonusMul' },
    description: 'Deep-core Drilling — +40% mine yield',
  },
  {
    id: 'forestry.keystone.silvicultureMastery' as NodeId,
    subPath: 'forestry', depth: 7, cost: 8, magnitude: 0.40,
    effect: { kind: 'loggerYieldBonusMul' },
    description: 'Silviculture Mastery — +40% logger yield',
  },
  {
    id: 'robotics.keystone.swarmIntelligence' as NodeId,
    subPath: 'robotics', depth: 7, cost: 8, magnitude: 0.35,
    effect: { kind: 'droneScanRadiusMul' },
    description: 'Swarm Intelligence — +35% drone scan radius',
  },
  {
    id: 'electronics.keystone.quantumYield' as NodeId,
    subPath: 'electronics', depth: 7, cost: 8, magnitude: 0.40,
    effect: { kind: 'recipeRateMul', category: 'electronics' },
    description: 'Quantum Yield — +40% electronics recipe rate',
  },
  {
    id: 'power_systems.keystone.fusionLock' as NodeId,
    subPath: 'power_systems', depth: 7, cost: 8, magnitude: 0.40,
    effect: { kind: 'powerProductionMul' },
    description: 'Fusion Lock — +40% power production',
  },
  {
    id: 'transport.keystone.supplyChain' as NodeId,
    subPath: 'transport', depth: 7, cost: 8, magnitude: 0.50,
    effect: { kind: 'routeCapacityMul' },
    description: 'Supply Chain Mastery — +50% route capacity',
  },
  {
    id: 'patronage.keystone.diplomaticImmunity' as NodeId,
    subPath: 'patronage', depth: 7, cost: 8, magnitude: 0.40,
    effect: { kind: 'commRangeMul' },
    description: 'Diplomatic Immunity — +40% communication range',
  },
  {
    id: 'aquaculture.keystone.maricultureMastery' as NodeId,
    subPath: 'aquaculture', depth: 7, cost: 8, magnitude: 0.40,
    effect: { kind: 'recipeRateMul', category: 'extraction' },
    description: 'Mariculture Mastery — +40% ocean extraction rate',
  },
  {
    id: 'hydroprocessing.keystone.desalMastery' as NodeId,
    subPath: 'hydroprocessing', depth: 7, cost: 8, magnitude: 0.40,
    effect: { kind: 'recipeRateMul', category: 'chemistry' },
    description: 'Desalination Mastery — +40% chemistry recipe rate',
  },
  {
    id: 'submarine.keystone.deepPressure' as NodeId,
    subPath: 'submarine', depth: 7, cost: 8, magnitude: 0.40,
    effect: { kind: 'routeCapacityMul' },
    description: 'Deep Pressure — +40% submarine route capacity',
  },
  {
    id: 'launch.keystone.padMastery' as NodeId,
    subPath: 'launch', depth: 7, cost: 8, magnitude: 0.40,
    effect: { kind: 'launchSuccessAdditive' },
    description: 'Pad Mastery — +40% launch success rate',
  },
  {
    id: 'discovery.keystone.deepScan' as NodeId,
    subPath: 'discovery', depth: 7, cost: 8, magnitude: 0.40,
    effect: { kind: 'scannerCoverageMul' },
    description: 'Deep Scan — +40% scanner coverage',
  },
  {
    id: 'resilience.keystone.orbitalFortress' as NodeId,
    subPath: 'resilience', depth: 7, cost: 8, magnitude: 0.40,
    effect: { kind: 'debrisProtectionMul' },
    description: 'Orbital Fortress — +40% debris protection',
  },
  {
    id: 'drilling.keystone.reservoirMastery' as NodeId,
    subPath: 'drilling', depth: 7, cost: 8, magnitude: 0.40,
    effect: { kind: 'recipeRateMul', category: 'extraction' },
    description: 'Reservoir Mastery — +40% extraction recipe rate',
  },
  {
    id: 'chemistry.keystone.catalyticMastery' as NodeId,
    subPath: 'chemistry', depth: 7, cost: 8, magnitude: 0.40,
    effect: { kind: 'recipeRateMul', category: 'chemistry' },
    description: 'Catalytic Mastery — +40% chemistry recipe rate',
  },
  {
    id: 'storage.keystone.vaultMastery' as NodeId,
    subPath: 'storage', depth: 7, cost: 8, magnitude: 0.40,
    effect: { kind: 'storageCapMul' },
    description: 'Vault Mastery — +40% uniform storage cap',
  },
  {
    id: 'network.keystone.meshMastery' as NodeId,
    subPath: 'network', depth: 7, cost: 8, magnitude: 0.40,
    effect: { kind: 'commRangeMul' },
    description: 'Mesh Mastery — +40% communication range',
  },
];

/** Combined keystones array */
export const KEYSTONES: SkillNode[] = [
  ...ROLE_ABSORPTION_KEYSTONES,
  ...RULE_BREAKER_KEYSTONES,
];

function ksp(target: string, requires: string[], cost: number): KeystonePrereq {
  type G = import('./skilltree-graph.js').NodeId;
  return {
    targetNode: target as unknown as G,
    requires: requires.map(r => r as unknown as G),
    cost,
  };
}

/** AND-prereq specifications for each keystone.
 *  Each keystone requires 2-3 notables within its sub-path to be unlocked first. */
export const KEYSTONE_PREREQS: KeystonePrereq[] = [
  ksp('smelting.keystone.foundryMastery', ['smelting.notable.inductionArc', 'smelting.notable.alloyTolerance'], 10),
  ksp('chemistry.keystone.refineryMastery', ['chemistry.notable.catalyticCracking', 'chemistry.notable.polymerMatrix'], 10),
  ksp('mining.keystone.veinmaster', ['mining.notable.deepVein', 'mining.notable.blastOptimization'], 12),
  ksp('transport.keystone.hubCapacity', ['transport.notable.heavyHaul', 'transport.notable.supplyHub'], 10),
  ksp('storage.keystone.masterCache', ['storage.notable.verticalSilo', 'storage.notable.predictiveMaintenance'], 10),
  ksp('power_systems.keystone.researchBeacon', ['power_systems.notable.turbineStaging', 'power_systems.notable.fusionPilot'], 10),
  ksp('robotics.keystone.parallelConstruction', ['robotics.notable.swarmAssembly', 'robotics.notable.parallelFoundries'], 8),
  ksp('forestry.keystone.charcoalUnlock', ['forestry.notable.selectiveHarvest', 'forestry.notable.silvicultureHub'], 8),
  ksp('drilling.keystone.earlyRig', ['drilling.notable.pressurizedRecovery', 'drilling.notable.deepBore'], 8),
  ksp('smelting.keystone.pyroforgeBypass', ['smelting.notable.heatRecapture', 'smelting.notable.refractoryLining'], 8),
  ksp('oceanography.keystone.sonarPair', ['oceanography.notable.buoyArray', 'oceanography.notable.seafloorCable'], 8),
  ksp('network.keystone.sharedRoutes', ['network.notable.meshNetwork', 'network.notable.teleporterCoil'], 8),
  ksp('communication.keystone.networkedExtract', ['communication.notable.groundStationHub', 'communication.notable.relayConstellation'], 8),
  ksp('mining.keystone.deepCore', ['mining.notable.deepVein', 'mining.notable.efficientDrills'], 8),
  ksp('forestry.keystone.silvicultureMastery', ['forestry.notable.exoticInoculation', 'forestry.notable.clearcutCoordination'], 8),
  ksp('robotics.keystone.swarmIntelligence', ['robotics.notable.droneOptics', 'robotics.notable.biofuelCell'], 8),
  ksp('electronics.keystone.quantumYield', ['electronics.notable.cleanRoom', 'electronics.notable.quantumEtching'], 8),
  ksp('power_systems.keystone.fusionLock', ['power_systems.notable.smartGrid', 'power_systems.notable.xpTelemetry'], 8),
  ksp('transport.keystone.supplyChain', ['transport.notable.jetStream', 'transport.notable.droneSwarmLogistics'], 8),
  ksp('patronage.keystone.diplomaticImmunity', ['patronage.notable.sponsorContracts', 'patronage.notable.diplomaticChannels'], 8),
  ksp('aquaculture.keystone.maricultureMastery', ['aquaculture.notable.kelpTowers', 'aquaculture.notable.maricultureGrid'], 8),
  ksp('hydroprocessing.keystone.desalMastery', ['hydroprocessing.notable.desalinationCascade', 'hydroprocessing.notable.membraneBreakthrough'], 8),
  ksp('submarine.keystone.deepPressure', ['submarine.notable.pressureHull', 'submarine.notable.thermalGradient'], 8),
  ksp('launch.keystone.padMastery', ['launch.notable.padRedundancy', 'launch.notable.reserveTanks'], 8),
  ksp('discovery.keystone.deepScan', ['discovery.notable.dwellOptimization', 'discovery.notable.deepField'], 8),
  ksp('resilience.keystone.orbitalFortress', ['resilience.notable.orbitalShields', 'resilience.notable.hardenedInfrastructure'], 8),
  ksp('drilling.keystone.reservoirMastery', ['drilling.notable.reservoirMapping', 'drilling.notable.subseaTanks'], 8),
  ksp('chemistry.keystone.catalyticMastery', ['chemistry.notable.pressurizedReactors', 'chemistry.notable.greenChemistry'], 8),
  ksp('storage.keystone.vaultMastery', ['storage.notable.vaultClimate', 'storage.notable.componentRacks'], 8),
  ksp('network.keystone.meshMastery', ['network.notable.relayAmplifier', 'network.notable.scannerUplink'], 8),
];

// ---------------------------------------------------------------------------
// Threshold-bridges — OR-style alt-entry edges between sub-paths
// ---------------------------------------------------------------------------

function be(
  id: string,
  from: string,
  to: string,
  cost: number,
  threshold: Array<{ branch: BranchId; minSpent: number }>,
): BridgeEdge {
  return {
    id: id as import('./skilltree-graph.js').EdgeId,
    from: from as import('./skilltree-graph.js').NodeId,
    to: to as import('./skilltree-graph.js').NodeId,
    cost,
    mode: 'or' as import('./skilltree-graph.js').EdgePrereqMode,
    threshold,
  } as BridgeEdge;
}

export const BRIDGE_CATALOG: BridgeEdge[] = [
  // ── Within-branch: Extraction ─────────────────────────────────────────────
  be('br.ext.mining-forestry', 'mining.notable.deepVein', 'forestry.notable.silvicultureHub', 5, [
    { branch: 'extraction', minSpent: 8 },
  ]),
  be('br.ext.forestry-robotics', 'forestry.notable.selectiveHarvest', 'robotics.notable.swarmAssembly', 5, [
    { branch: 'extraction', minSpent: 8 },
  ]),
  be('br.ext.drilling-mining', 'drilling.notable.deepBore', 'mining.notable.blastOptimization', 6, [
    { branch: 'extraction', minSpent: 10 },
  ]),

  // ── Within-branch: Refinement ─────────────────────────────────────────────
  be('br.ref.smelting-chemistry', 'smelting.notable.inductionArc', 'chemistry.notable.catalyticCracking', 5, [
    { branch: 'refinement', minSpent: 8 },
  ]),
  be('br.ref.chemistry-electronics', 'chemistry.notable.polymerMatrix', 'electronics.notable.quantumEtching', 5, [
    { branch: 'refinement', minSpent: 8 },
  ]),
  be('br.ref.electronics-power', 'electronics.notable.cleanRoom', 'power_systems.notable.turbineStaging', 5, [
    { branch: 'refinement', minSpent: 10 },
  ]),

  // ── Within-branch: Logistics ──────────────────────────────────────────────
  be('br.log.storage-transport', 'storage.notable.verticalSilo', 'transport.notable.heavyHaul', 5, [
    { branch: 'logistics', minSpent: 8 },
  ]),
  be('br.log.transport-network', 'transport.notable.supplyHub', 'network.notable.meshNetwork', 5, [
    { branch: 'logistics', minSpent: 8 },
  ]),
  be('br.log.network-storage', 'network.notable.meshNetwork', 'storage.notable.predictiveMaintenance', 6, [
    { branch: 'logistics', minSpent: 10 },
  ]),

  // ── Within-branch: Orbital ────────────────────────────────────────────────
  be('br.orb.launch-comm', 'launch.notable.padRedundancy', 'communication.notable.groundStationHub', 5, [
    { branch: 'orbital', minSpent: 8 },
  ]),
  be('br.orb.comm-discovery', 'communication.notable.relayConstellation', 'discovery.notable.dwellOptimization', 5, [
    { branch: 'orbital', minSpent: 8 },
  ]),
  be('br.orb.discovery-resilience', 'discovery.notable.deepField', 'resilience.notable.orbitalShields', 6, [
    { branch: 'orbital', minSpent: 10 },
  ]),

  // ── Within-branch: Ocean ──────────────────────────────────────────────────
  be('br.ocean.patronage-aqua', 'patronage.notable.sponsorContracts', 'aquaculture.notable.kelpTowers', 5, [
    { branch: 'ocean', minSpent: 8 },
  ]),
  be('br.ocean.aqua-hydro', 'aquaculture.notable.maricultureGrid', 'hydroprocessing.notable.desalinationCascade', 5, [
    { branch: 'ocean', minSpent: 8 },
  ]),
  be('br.ocean.submarine-oceanography', 'submarine.notable.deepFreighter', 'oceanography.notable.buoyArray', 6, [
    { branch: 'ocean', minSpent: 10 },
  ]),

  // ── Cross-branch ──────────────────────────────────────────────────────────
  be('br.cross.mining-smelting', 'mining.keystone.veinmaster', 'smelting.keystone.foundryMastery', 12, [
    { branch: 'extraction', minSpent: 20 },
    { branch: 'refinement', minSpent: 20 },
  ]),
  be('br.cross.robotics-electronics', 'robotics.keystone.parallelConstruction', 'electronics.keystone.quantumYield', 12, [
    { branch: 'extraction', minSpent: 18 },
    { branch: 'refinement', minSpent: 18 },
  ]),
  be('br.cross.transport-launch', 'transport.keystone.hubCapacity', 'launch.keystone.padMastery', 14, [
    { branch: 'logistics', minSpent: 20 },
    { branch: 'orbital', minSpent: 20 },
  ]),
  be('br.cross.network-comm', 'network.keystone.meshMastery', 'communication.keystone.networkedExtract', 12, [
    { branch: 'logistics', minSpent: 18 },
    { branch: 'orbital', minSpent: 18 },
  ]),
  be('br.cross.power-discovery', 'power_systems.keystone.researchBeacon', 'discovery.keystone.deepScan', 12, [
    { branch: 'refinement', minSpent: 18 },
    { branch: 'orbital', minSpent: 18 },
  ]),
  be('br.cross.storage-patronage', 'storage.keystone.masterCache', 'patronage.keystone.diplomaticImmunity', 12, [
    { branch: 'logistics', minSpent: 18 },
    { branch: 'ocean', minSpent: 18 },
  ]),
  be('br.cross.chemistry-hydro', 'chemistry.keystone.refineryMastery', 'hydroprocessing.keystone.desalMastery', 12, [
    { branch: 'refinement', minSpent: 20 },
    { branch: 'ocean', minSpent: 20 },
  ]),
  be('br.cross.drilling-submarine', 'drilling.keystone.earlyRig', 'submarine.keystone.deepPressure', 14, [
    { branch: 'extraction', minSpent: 18 },
    { branch: 'ocean', minSpent: 18 },
  ]),
  be('br.cross.forest-aqua', 'forestry.keystone.silvicultureMastery', 'aquaculture.keystone.maricultureMastery', 12, [
    { branch: 'extraction', minSpent: 18 },
    { branch: 'ocean', minSpent: 18 },
  ]),
  be('br.cross.resilience-power', 'resilience.keystone.orbitalFortress', 'power_systems.keystone.fusionLock', 12, [
    { branch: 'orbital', minSpent: 18 },
    { branch: 'refinement', minSpent: 18 },
  ]),
  be('br.cross.launch-network', 'launch.notable.reserveTanks', 'network.notable.teleporterCoil', 10, [
    { branch: 'orbital', minSpent: 15 },
    { branch: 'logistics', minSpent: 15 },
  ]),
  be('br.cross.oceanography-mining', 'oceanography.keystone.sonarPair', 'mining.keystone.deepCore', 12, [
    { branch: 'ocean', minSpent: 18 },
    { branch: 'extraction', minSpent: 18 },
  ]),
];

// ---------------------------------------------------------------------------
// Graft sockets — reserved attachment positions on the outer rim of each branch
// ---------------------------------------------------------------------------

export const GRAFT_SOCKET_CATALOG: GraftSocket[] = [
  // Extraction (~8)
  { id: 'gs.ext.mining-1', branchId: 'extraction', subPathId: 'mining', attachmentDepth: 7 },
  { id: 'gs.ext.mining-2', branchId: 'extraction', subPathId: 'mining', attachmentDepth: 9 },
  { id: 'gs.ext.forestry-1', branchId: 'extraction', subPathId: 'forestry', attachmentDepth: 7 },
  { id: 'gs.ext.forestry-2', branchId: 'extraction', subPathId: 'forestry', attachmentDepth: 9 },
  { id: 'gs.ext.drilling-1', branchId: 'extraction', subPathId: 'drilling', attachmentDepth: 7 },
  { id: 'gs.ext.drilling-2', branchId: 'extraction', subPathId: 'drilling', attachmentDepth: 9 },
  { id: 'gs.ext.robotics-1', branchId: 'extraction', subPathId: 'robotics', attachmentDepth: 7 },
  { id: 'gs.ext.robotics-2', branchId: 'extraction', subPathId: 'robotics', attachmentDepth: 9 },

  // Refinement (~8)
  { id: 'gs.ref.smelting-1', branchId: 'refinement', subPathId: 'smelting', attachmentDepth: 7 },
  { id: 'gs.ref.smelting-2', branchId: 'refinement', subPathId: 'smelting', attachmentDepth: 9 },
  { id: 'gs.ref.chemistry-1', branchId: 'refinement', subPathId: 'chemistry', attachmentDepth: 7 },
  { id: 'gs.ref.chemistry-2', branchId: 'refinement', subPathId: 'chemistry', attachmentDepth: 9 },
  { id: 'gs.ref.electronics-1', branchId: 'refinement', subPathId: 'electronics', attachmentDepth: 7 },
  { id: 'gs.ref.electronics-2', branchId: 'refinement', subPathId: 'electronics', attachmentDepth: 9 },
  { id: 'gs.ref.power-1', branchId: 'refinement', subPathId: 'power_systems', attachmentDepth: 7 },
  { id: 'gs.ref.power-2', branchId: 'refinement', subPathId: 'power_systems', attachmentDepth: 9 },

  // Logistics (~6)
  { id: 'gs.log.storage-1', branchId: 'logistics', subPathId: 'storage', attachmentDepth: 7 },
  { id: 'gs.log.storage-2', branchId: 'logistics', subPathId: 'storage', attachmentDepth: 9 },
  { id: 'gs.log.transport-1', branchId: 'logistics', subPathId: 'transport', attachmentDepth: 7 },
  { id: 'gs.log.transport-2', branchId: 'logistics', subPathId: 'transport', attachmentDepth: 9 },
  { id: 'gs.log.network-1', branchId: 'logistics', subPathId: 'network', attachmentDepth: 7 },
  { id: 'gs.log.network-2', branchId: 'logistics', subPathId: 'network', attachmentDepth: 9 },

  // Orbital (~12 — largest share, SPACE-expansion landing pad)
  { id: 'gs.orb.launch-1', branchId: 'orbital', subPathId: 'launch', attachmentDepth: 7 },
  { id: 'gs.orb.launch-2', branchId: 'orbital', subPathId: 'launch', attachmentDepth: 9 },
  { id: 'gs.orb.comm-1', branchId: 'orbital', subPathId: 'communication', attachmentDepth: 7 },
  { id: 'gs.orb.comm-2', branchId: 'orbital', subPathId: 'communication', attachmentDepth: 9 },
  { id: 'gs.orb.discovery-1', branchId: 'orbital', subPathId: 'discovery', attachmentDepth: 7 },
  { id: 'gs.orb.discovery-2', branchId: 'orbital', subPathId: 'discovery', attachmentDepth: 9 },
  { id: 'gs.orb.resilience-1', branchId: 'orbital', subPathId: 'resilience', attachmentDepth: 7 },
  { id: 'gs.orb.resilience-2', branchId: 'orbital', subPathId: 'resilience', attachmentDepth: 9 },
  { id: 'gs.orb.launch-3', branchId: 'orbital', subPathId: 'launch', attachmentDepth: 11 },
  { id: 'gs.orb.comm-3', branchId: 'orbital', subPathId: 'communication', attachmentDepth: 11 },
  { id: 'gs.orb.discovery-3', branchId: 'orbital', subPathId: 'discovery', attachmentDepth: 11 },
  { id: 'gs.orb.resilience-3', branchId: 'orbital', subPathId: 'resilience', attachmentDepth: 11 },

  // Ocean (~10)
  { id: 'gs.ocean.patronage-1', branchId: 'ocean', subPathId: 'patronage', attachmentDepth: 7 },
  { id: 'gs.ocean.patronage-2', branchId: 'ocean', subPathId: 'patronage', attachmentDepth: 9 },
  { id: 'gs.ocean.aquaculture-1', branchId: 'ocean', subPathId: 'aquaculture', attachmentDepth: 7 },
  { id: 'gs.ocean.aquaculture-2', branchId: 'ocean', subPathId: 'aquaculture', attachmentDepth: 9 },
  { id: 'gs.ocean.hydro-1', branchId: 'ocean', subPathId: 'hydroprocessing', attachmentDepth: 7 },
  { id: 'gs.ocean.hydro-2', branchId: 'ocean', subPathId: 'hydroprocessing', attachmentDepth: 9 },
  { id: 'gs.ocean.submarine-1', branchId: 'ocean', subPathId: 'submarine', attachmentDepth: 7 },
  { id: 'gs.ocean.submarine-2', branchId: 'ocean', subPathId: 'submarine', attachmentDepth: 9 },
  { id: 'gs.ocean.oceanography-1', branchId: 'ocean', subPathId: 'oceanography', attachmentDepth: 7 },
  { id: 'gs.ocean.oceanography-2', branchId: 'ocean', subPathId: 'oceanography', attachmentDepth: 9 },
];

// ---------------------------------------------------------------------------
// Combined catalog
// ---------------------------------------------------------------------------

export const NOTABLES: SkillNode[] = [
  ...MINING_NOTABLES,
  ...FORESTRY_NOTABLES,
  ...DRILLING_NOTABLES,
  ...ROBOTICS_NOTABLES,
  ...SMELTING_NOTABLES,
  ...CHEMISTRY_NOTABLES,
  ...ELECTRONICS_NOTABLES,
  ...POWER_SYSTEMS_NOTABLES,
  ...STORAGE_NOTABLES,
  ...TRANSPORT_NOTABLES,
  ...NETWORK_NOTABLES,
  ...PATRONAGE_NOTABLES,
  ...AQUACULTURE_NOTABLES,
  ...HYDROPROCESSING_NOTABLES,
  ...SUBMARINE_NOTABLES,
  ...OCEANOGRAPHY_NOTABLES,
  ...LAUNCH_NOTABLES,
  ...COMMUNICATION_NOTABLES,
  ...DISCOVERY_NOTABLES,
  ...RESILIENCE_NOTABLES,
];

/** Full catalog: filler nodes + notables + keystones */
export const FULL_CATALOG: SkillNode[] = [...ALL_FILLER_NODES, ...NOTABLES, ...KEYSTONES];
