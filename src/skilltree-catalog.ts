import type { SkillNode, NodeId, BranchId } from './skilltree.js';
import type { KeystonePrereq, BridgeEdge, GraftSocket } from './skilltree-graph.js';
import { ALL_FILLER_NODES, ALL_ARCHETYPE_PREFIXES } from './skilltree-archetypes.js';
import { deriveMagnitudes, type RawSkillNode } from './skilltree-derive-magnitudes.js';

// ---------------------------------------------------------------------------
// Extraction branch
// ---------------------------------------------------------------------------

export const MINING_NOTABLES: RawSkillNode[] = [
  {
    id: 'mining.notable.deepVein' as NodeId,
    subPath: 'mining',
    depth: 4,
    cost: 4,
    effect: { kind: 'mineYieldBonusMul' },
    description: 'Deep Vein Surveying — mine yield per Mine',
    aura: { radius: 1, bonus: 0.10 }
  },
  {
    id: 'mining.notable.heliumSeep' as NodeId,
    subPath: 'mining',
    depth: 5,
    cost: 5,
    effect: { kind: 'mineRareTrickleMul' },
    description: 'Helium Seep Detection — helium-3 trickle from Mines'
  },
  {
    id: 'mining.notable.efficientDrills' as NodeId,
    subPath: 'mining',
    depth: 3,
    cost: 3,
    effect: { kind: 'powerConsumptionMul', reduce: true },
    description: 'Efficient Drillheads — reduces mine power consumption'
  },
  {
    id: 'mining.notable.blastOptimization' as NodeId,
    subPath: 'mining',
    depth: 6,
    cost: 6,
    effect: { kind: 'recipeRateMul', category: 'extraction' },
    description: 'Blast Optimization — extraction recipe rate',
    aura: { radius: 2, bonus: 0.12 }
  },
];

export const FORESTRY_NOTABLES: RawSkillNode[] = [
  {
    id: 'forestry.notable.selectiveHarvest' as NodeId,
    subPath: 'forestry',
    depth: 4,
    cost: 4,
    effect: { kind: 'loggerYieldBonusMul' },
    description: 'Selective Harvesting — logger yield per Logger',
    aura: { radius: 1, bonus: 0.10 }
  },
  {
    id: 'forestry.notable.exoticInoculation' as NodeId,
    subPath: 'forestry',
    depth: 5,
    cost: 5,
    effect: { kind: 'loggerExoticTrickleMul' },
    description: 'Exotic Inoculation — exotic-species trickle from Loggers'
  },
  {
    id: 'forestry.notable.clearcutCoordination' as NodeId,
    subPath: 'forestry',
    depth: 3,
    cost: 3,
    effect: { kind: 'recipeRateMul', category: 'extraction' },
    description: 'Clear-cut Coordination — extraction recipe rate'
  },
  {
    id: 'forestry.notable.silvicultureHub' as NodeId,
    subPath: 'forestry',
    depth: 6,
    cost: 6,
    effect: { kind: 'storageCategoryCapMul', category: 'dry_goods' },
    description: 'Silviculture Hub — dry-goods storage cap',
    aura: { radius: 2, bonus: 0.12 }
  },
];

export const DRILLING_NOTABLES: RawSkillNode[] = [
  {
    id: 'drilling.notable.pressurizedRecovery' as NodeId,
    subPath: 'drilling',
    depth: 4,
    cost: 4,
    effect: { kind: 'recipeRateMul', category: 'extraction' },
    description: 'Pressurized Recovery — extraction recipe rate',
    aura: { radius: 1, bonus: 0.10 }
  },
  {
    id: 'drilling.notable.reservoirMapping' as NodeId,
    subPath: 'drilling',
    depth: 5,
    cost: 5,
    effect: { kind: 'mineYieldBonusMul' },
    description: 'Reservoir Mapping — yield from drill-type mines'
  },
  {
    id: 'drilling.notable.subseaTanks' as NodeId,
    subPath: 'drilling',
    depth: 3,
    cost: 3,
    effect: { kind: 'storageCategoryCapMul', category: 'liquid_gas' },
    description: 'Subsea Tanks — liquid-gas storage cap'
  },
  {
    id: 'drilling.notable.deepBore' as NodeId,
    subPath: 'drilling',
    depth: 6,
    cost: 6,
    effect: { kind: 'powerConsumptionMul', reduce: true },
    description: 'Deep-bore Thermals — reduces drill-type mine power consumption',
    aura: { radius: 2, bonus: 0.12 }
  },
];

export const ROBOTICS_NOTABLES: RawSkillNode[] = [
  {
    id: 'robotics.notable.swarmAssembly' as NodeId,
    subPath: 'robotics',
    depth: 4,
    cost: 4,
    effect: { kind: 'constructionTimeMul' },
    description: 'Swarm Assembly — faster construction',
    aura: { radius: 1, bonus: 0.10 }
  },
  {
    id: 'robotics.notable.parallelFoundries' as NodeId,
    subPath: 'robotics',
    depth: 5,
    cost: 5,
    effect: { kind: 'parallelBuildCapAdd' },
    description: 'Parallel Foundries — parallel build slots'
  },
  {
    id: 'robotics.notable.droneOptics' as NodeId,
    subPath: 'robotics',
    depth: 3,
    cost: 3,
    effect: { kind: 'droneScanRadiusMul' },
    description: 'Drone Optics Upgrade — drone scan radius'
  },
  {
    id: 'robotics.notable.biofuelCell' as NodeId,
    subPath: 'robotics',
    depth: 6,
    cost: 6,
    effect: { kind: 'droneFuelEfficiencyMul' },
    description: 'Biofuel Cells — drone fuel efficiency',
    aura: { radius: 2, bonus: 0.12 }
  },
];

// ---------------------------------------------------------------------------
// Refinement branch
// ---------------------------------------------------------------------------

export const SMELTING_NOTABLES: RawSkillNode[] = [
  {
    id: 'smelting.notable.inductionArc' as NodeId,
    subPath: 'smelting',
    depth: 4,
    cost: 4,
    effect: { kind: 'recipeRateMul', category: 'smelting' },
    description: 'Induction Arc — smelting recipe rate',
    aura: { radius: 1, bonus: 0.10 }
  },
  {
    id: 'smelting.notable.heatRecapture' as NodeId,
    subPath: 'smelting',
    depth: 5,
    cost: 5,
    effect: { kind: 'powerConsumptionMul', reduce: true },
    description: 'Heat Recapture — reduces smelter power consumption'
  },
  {
    id: 'smelting.notable.refractoryLining' as NodeId,
    subPath: 'smelting',
    depth: 3,
    cost: 3,
    effect: { kind: 'maintenanceThresholdMul' },
    description: 'Refractory Lining — maintenance threshold for smelters'
  },
  {
    id: 'smelting.notable.alloyTolerance' as NodeId,
    subPath: 'smelting',
    depth: 6,
    cost: 6,
    effect: { kind: 'recipeRateMul', category: 'smelting' },
    description: 'Alloy Tolerance — smelting recipe rate',
    aura: { radius: 2, bonus: 0.12 }
  },
];

export const CHEMISTRY_NOTABLES: RawSkillNode[] = [
  {
    id: 'chemistry.notable.catalyticCracking' as NodeId,
    subPath: 'chemistry',
    depth: 4,
    cost: 4,
    effect: { kind: 'recipeRateMul', category: 'chemistry' },
    description: 'Catalytic Cracking — chemistry recipe rate',
    aura: { radius: 1, bonus: 0.10 }
  },
  {
    id: 'chemistry.notable.pressurizedReactors' as NodeId,
    subPath: 'chemistry',
    depth: 5,
    cost: 5,
    effect: { kind: 'powerConsumptionMul', reduce: true },
    description: 'Pressurized Reactors — reduces chemistry plant power consumption'
  },
  {
    id: 'chemistry.notable.greenChemistry' as NodeId,
    subPath: 'chemistry',
    depth: 3,
    cost: 3,
    effect: { kind: 'storageCategoryCapMul', category: 'liquid_gas' },
    description: 'Green Chemistry — liquid-gas storage cap'
  },
  {
    id: 'chemistry.notable.polymerMatrix' as NodeId,
    subPath: 'chemistry',
    depth: 6,
    cost: 6,
    effect: { kind: 'recipeRateMul', category: 'chemistry' },
    description: 'Polymer Matrix — chemistry recipe rate',
    aura: { radius: 2, bonus: 0.12 }
  },
];

export const ELECTRONICS_NOTABLES: RawSkillNode[] = [
  {
    id: 'electronics.notable.cleanRoom' as NodeId,
    subPath: 'electronics',
    depth: 4,
    cost: 4,
    effect: { kind: 'recipeRateMul', category: 'electronics' },
    description: 'Clean Room — electronics recipe rate',
    aura: { radius: 1, bonus: 0.10 }
  },
  {
    id: 'electronics.notable.lowPowerDesign' as NodeId,
    subPath: 'electronics',
    depth: 5,
    cost: 5,
    effect: { kind: 'powerConsumptionMul', reduce: true },
    description: 'Low-Power Design — reduces electronics plant power consumption'
  },
  {
    id: 'electronics.notable.satBandwidth' as NodeId,
    subPath: 'electronics',
    depth: 3,
    cost: 3,
    effect: { kind: 'satBufferCapMul' },
    description: 'Sat Bandwidth — satellite buffer capacity'
  },
  {
    id: 'electronics.notable.quantumEtching' as NodeId,
    subPath: 'electronics',
    depth: 6,
    cost: 6,
    effect: { kind: 'recipeRateMul', category: 'electronics' },
    description: 'Quantum Etching — electronics recipe rate',
    aura: { radius: 2, bonus: 0.12 }
  },
];

export const POWER_SYSTEMS_NOTABLES: RawSkillNode[] = [
  {
    id: 'power_systems.notable.turbineStaging' as NodeId,
    subPath: 'power_systems',
    depth: 4,
    cost: 4,
    effect: { kind: 'powerProductionMul' },
    description: 'Turbine Staging — power production',
    aura: { radius: 1, bonus: 0.10 }
  },
  {
    id: 'power_systems.notable.smartGrid' as NodeId,
    subPath: 'power_systems',
    depth: 5,
    cost: 5,
    effect: { kind: 'powerConsumptionMul', reduce: true },
    description: 'Smart Grid — reduces power consumption'
  },
  // Structural deviation: power_systems is the first sub-path with 5 notables
  // (vs. the 4-per-sub-path convention). batteryCapacityMul is a high-impact
  // axis driving the §8.5 battery ladder, so it gets its own depth-5 lever
  // rather than displacing an existing depth-5 notable; magnitudes re-computed
  // per spec §03.
  {
    id: 'power_systems.notable.electrochemistry' as NodeId,
    subPath: 'power_systems',
    depth: 5,
    cost: 5,
    effect: { kind: 'batteryCapacityMul' },
    description: 'Electrochemistry Lab — battery capacity (all tiers)'
  },
  {
    id: 'power_systems.notable.xpTelemetry' as NodeId,
    subPath: 'power_systems',
    depth: 3,
    cost: 3,
    effect: { kind: 'xpGainMul' },
    description: 'XP Telemetry — XP gain'
  },
  {
    id: 'power_systems.notable.fusionPilot' as NodeId,
    subPath: 'power_systems',
    depth: 6,
    cost: 6,
    effect: { kind: 'powerProductionMul' },
    description: 'Fusion Pilot — power production',
    aura: { radius: 2, bonus: 0.12 }
  },
];

// ---------------------------------------------------------------------------
// Logistics branch
// ---------------------------------------------------------------------------

export const STORAGE_NOTABLES: RawSkillNode[] = [
  {
    id: 'storage.notable.verticalSilo' as NodeId,
    subPath: 'storage',
    depth: 4,
    cost: 4,
    effect: { kind: 'storageCategoryCapMul', category: 'dry_goods' },
    description: 'Vertical Silos — dry-goods storage cap',
    aura: { radius: 1, bonus: 0.10 }
  },
  {
    id: 'storage.notable.vaultClimate' as NodeId,
    subPath: 'storage',
    depth: 5,
    cost: 5,
    effect: { kind: 'storageCategoryCapMul', category: 'rare' },
    description: 'Vault Climate Control — rare-materials storage cap'
  },
  {
    id: 'storage.notable.componentRacks' as NodeId,
    subPath: 'storage',
    depth: 3,
    cost: 3,
    effect: { kind: 'storageCategoryCapMul', category: 'components' },
    description: 'Component Racks — component storage cap'
  },
  {
    id: 'storage.notable.predictiveMaintenance' as NodeId,
    subPath: 'storage',
    depth: 6,
    cost: 6,
    effect: { kind: 'maintenanceThresholdMul' },
    description: 'Predictive Maintenance — maintenance threshold',
    aura: { radius: 2, bonus: 0.12 }
  },
];

export const TRANSPORT_NOTABLES: RawSkillNode[] = [
  {
    id: 'transport.notable.heavyHaul' as NodeId,
    subPath: 'transport',
    depth: 4,
    cost: 4,
    effect: { kind: 'routeCapacityMul' },
    description: 'Heavy Haul — route capacity',
    aura: { radius: 1, bonus: 0.10 }
  },
  {
    id: 'transport.notable.jetStream' as NodeId,
    subPath: 'transport',
    depth: 5,
    cost: 5,
    effect: { kind: 'airshipRangeMul' },
    description: 'Jet Stream Routing — airship range'
  },
  {
    id: 'transport.notable.droneSwarmLogistics' as NodeId,
    subPath: 'transport',
    depth: 3,
    cost: 3,
    effect: { kind: 'droneFuelEfficiencyMul' },
    description: 'Drone Swarm Logistics — drone fuel efficiency'
  },
  {
    id: 'transport.notable.supplyHub' as NodeId,
    subPath: 'transport',
    depth: 6,
    cost: 6,
    effect: { kind: 'routeCapacityMul' },
    description: 'Supply Hub — route capacity',
    aura: { radius: 2, bonus: 0.12 }
  },
];

export const NETWORK_NOTABLES: RawSkillNode[] = [
  {
    id: 'network.notable.relayAmplifier' as NodeId,
    subPath: 'network',
    depth: 4,
    cost: 4,
    effect: { kind: 'commRangeMul' },
    description: 'Relay Amplifier — communication range',
    aura: { radius: 1, bonus: 0.10 }
  },
  {
    id: 'network.notable.teleporterCoil' as NodeId,
    subPath: 'network',
    depth: 5,
    cost: 5,
    effect: { kind: 'teleporterEfficiencyMul' },
    description: 'Teleporter Coil — teleporter efficiency'
  },
  {
    id: 'network.notable.scannerUplink' as NodeId,
    subPath: 'network',
    depth: 3,
    cost: 3,
    effect: { kind: 'scannerCoverageMul' },
    description: 'Scanner Uplink — scanner coverage'
  },
  {
    id: 'network.notable.meshNetwork' as NodeId,
    subPath: 'network',
    depth: 6,
    cost: 6,
    effect: { kind: 'commRangeMul' },
    description: 'Mesh Network — communication range',
    aura: { radius: 2, bonus: 0.12 }
  },
];

export const PATRONAGE_NOTABLES: RawSkillNode[] = [
  {
    id: 'patronage.notable.sponsorContracts' as NodeId,
    subPath: 'patronage',
    depth: 4,
    cost: 4,
    effect: { kind: 'recipeRateMul', category: 'extraction' },
    description: 'Sponsor Contracts — extraction recipe rate',
    aura: { radius: 1, bonus: 0.10 }
  },
  {
    id: 'patronage.notable.curatorVaults' as NodeId,
    subPath: 'patronage',
    depth: 5,
    cost: 5,
    effect: { kind: 'storageCategoryCapMul', category: 'rare' },
    description: 'Curator Vaults — rare-materials storage cap'
  },
  {
    id: 'patronage.notable.diplomaticChannels' as NodeId,
    subPath: 'patronage',
    depth: 3,
    cost: 3,
    effect: { kind: 'commRangeMul' },
    description: 'Diplomatic Channels — communication range'
  },
  {
    id: 'patronage.notable.endowmentFund' as NodeId,
    subPath: 'patronage',
    depth: 6,
    cost: 6,
    effect: { kind: 'recipeRateMul', category: 'manufacturing' },
    description: 'Endowment Fund — manufacturing recipe rate',
    aura: { radius: 2, bonus: 0.12 }
  },
];

// ---------------------------------------------------------------------------
// Ocean branch
// ---------------------------------------------------------------------------

export const AQUACULTURE_NOTABLES: RawSkillNode[] = [
  {
    id: 'aquaculture.notable.kelpTowers' as NodeId,
    subPath: 'aquaculture',
    depth: 4,
    cost: 4,
    effect: { kind: 'recipeRateMul', category: 'extraction' },
    description: 'Kelp Towers — extraction recipe rate',
    aura: { radius: 1, bonus: 0.10 }
  },
  {
    id: 'aquaculture.notable.brineConcentration' as NodeId,
    subPath: 'aquaculture',
    depth: 5,
    cost: 5,
    effect: { kind: 'mineYieldBonusMul' },
    description: 'Brine Concentration — yield from ocean extractors'
  },
  {
    id: 'aquaculture.notable.dryStorageBarges' as NodeId,
    subPath: 'aquaculture',
    depth: 3,
    cost: 3,
    effect: { kind: 'storageCategoryCapMul', category: 'dry_goods' },
    description: 'Dry-storage Barges — dry-goods storage cap'
  },
  {
    id: 'aquaculture.notable.maricultureGrid' as NodeId,
    subPath: 'aquaculture',
    depth: 6,
    cost: 6,
    effect: { kind: 'recipeRateMul', category: 'extraction' },
    description: 'Mariculture Grid — extraction recipe rate',
    aura: { radius: 2, bonus: 0.12 }
  },
];

export const HYDROPROCESSING_NOTABLES: RawSkillNode[] = [
  {
    id: 'hydroprocessing.notable.desalinationCascade' as NodeId,
    subPath: 'hydroprocessing',
    depth: 4,
    cost: 4,
    effect: { kind: 'recipeRateMul', category: 'chemistry' },
    description: 'Desalination Cascade — chemistry recipe rate',
    aura: { radius: 1, bonus: 0.10 }
  },
  {
    id: 'hydroprocessing.notable.osmoticPump' as NodeId,
    subPath: 'hydroprocessing',
    depth: 5,
    cost: 5,
    effect: { kind: 'powerConsumptionMul', reduce: true },
    description: 'Osmotic Pump — reduces hydro plant power consumption'
  },
  {
    id: 'hydroprocessing.notable.floatingTanks' as NodeId,
    subPath: 'hydroprocessing',
    depth: 3,
    cost: 3,
    effect: { kind: 'storageCategoryCapMul', category: 'liquid_gas' },
    description: 'Floating Tanks — liquid/gas storage cap'
  },
  {
    id: 'hydroprocessing.notable.membraneBreakthrough' as NodeId,
    subPath: 'hydroprocessing',
    depth: 6,
    cost: 6,
    effect: { kind: 'recipeRateMul', category: 'chemistry' },
    description: 'Membrane Breakthrough — chemistry recipe rate',
    aura: { radius: 2, bonus: 0.12 }
  },
];

export const SUBMARINE_NOTABLES: RawSkillNode[] = [
  {
    id: 'submarine.notable.pressureHull' as NodeId,
    subPath: 'submarine',
    depth: 4,
    cost: 4,
    effect: { kind: 'routeCapacityMul' },
    description: 'Pressure-hull Routing — route capacity',
    aura: { radius: 1, bonus: 0.10 }
  },
  {
    id: 'submarine.notable.thermalGradient' as NodeId,
    subPath: 'submarine',
    depth: 5,
    cost: 5,
    effect: { kind: 'powerProductionMul' },
    description: 'Thermal-gradient Harvest — power production'
  },
  {
    id: 'submarine.notable.sonarMapping' as NodeId,
    subPath: 'submarine',
    depth: 3,
    cost: 3,
    effect: { kind: 'airshipRangeMul' },
    description: 'Sonar Mapping — airship range over ocean'
  },
  {
    id: 'submarine.notable.deepFreighter' as NodeId,
    subPath: 'submarine',
    depth: 6,
    cost: 6,
    effect: { kind: 'routeCapacityMul' },
    description: 'Deep Freighter — route capacity',
    aura: { radius: 2, bonus: 0.12 }
  },
];

export const OCEANOGRAPHY_NOTABLES: RawSkillNode[] = [
  {
    id: 'oceanography.notable.buoyArray' as NodeId,
    subPath: 'oceanography',
    depth: 4,
    cost: 4,
    effect: { kind: 'scannerCoverageMul' },
    description: 'Buoy Array — scanner coverage',
    aura: { radius: 1, bonus: 0.10 }
  },
  {
    id: 'oceanography.notable.seafloorCable' as NodeId,
    subPath: 'oceanography',
    depth: 5,
    cost: 5,
    effect: { kind: 'commRangeMul' },
    description: 'Seafloor Cable — communication range'
  },
  {
    id: 'oceanography.notable.aerialSurvey' as NodeId,
    subPath: 'oceanography',
    depth: 3,
    cost: 3,
    effect: { kind: 'droneScanRadiusMul' },
    description: 'Aerial Survey — drone scan radius'
  },
  {
    id: 'oceanography.notable.tidalPrediction' as NodeId,
    subPath: 'oceanography',
    depth: 6,
    cost: 6,
    effect: { kind: 'scannerCoverageMul' },
    description: 'Tidal Prediction — scanner coverage',
    aura: { radius: 2, bonus: 0.12 }
  },
];

// ---------------------------------------------------------------------------
// Orbital branch
// ---------------------------------------------------------------------------

export const LAUNCH_NOTABLES: RawSkillNode[] = [
  {
    id: 'launch.notable.padRedundancy' as NodeId,
    subPath: 'launch',
    depth: 4,
    cost: 4,
    effect: { kind: 'launchSuccessAdditive' },
    description: 'Pad Redundancy — launch success rate',
    aura: { radius: 1, bonus: 0.10 }
  },
  {
    id: 'launch.notable.blastDeflector' as NodeId,
    subPath: 'launch',
    depth: 5,
    cost: 5,
    effect: { kind: 'padExplosionReduceMul' },
    description: 'Blast Deflector — pad explosion reduction'
  },
  {
    id: 'launch.notable.satDatapool' as NodeId,
    subPath: 'launch',
    depth: 3,
    cost: 3,
    effect: { kind: 'satBufferCapMul' },
    description: 'Sat Datapool — satellite buffer capacity'
  },
  {
    id: 'launch.notable.reserveTanks' as NodeId,
    subPath: 'launch',
    depth: 6,
    cost: 6,
    effect: { kind: 'satFuelReserveMul' },
    description: 'Reserve Tanks — satellite fuel reserve',
    aura: { radius: 2, bonus: 0.12 }
  },
];

export const COMMUNICATION_NOTABLES: RawSkillNode[] = [
  {
    id: 'communication.notable.groundStationHub' as NodeId,
    subPath: 'communication',
    depth: 4,
    cost: 4,
    effect: { kind: 'commRangeMul' },
    description: 'Ground-station Hub — communication range',
    aura: { radius: 1, bonus: 0.10 }
  },
  {
    id: 'communication.notable.packetBurst' as NodeId,
    subPath: 'communication',
    depth: 5,
    cost: 5,
    effect: { kind: 'satBufferCapMul' },
    description: 'Packet Burst — satellite buffer capacity'
  },
  {
    id: 'communication.notable.scannerOverlap' as NodeId,
    subPath: 'communication',
    depth: 3,
    cost: 3,
    effect: { kind: 'scannerCoverageMul' },
    description: 'Scanner Overlap — scanner coverage'
  },
  {
    id: 'communication.notable.relayConstellation' as NodeId,
    subPath: 'communication',
    depth: 6,
    cost: 6,
    effect: { kind: 'commRangeMul' },
    description: 'Relay Constellation — communication range',
    aura: { radius: 2, bonus: 0.12 }
  },
];

export const DISCOVERY_NOTABLES: RawSkillNode[] = [
  {
    id: 'discovery.notable.dwellOptimization' as NodeId,
    subPath: 'discovery',
    depth: 4,
    cost: 4,
    effect: { kind: 'scannerDwellRateMul' },
    description: 'Dwell Optimization — scanner dwell rate',
    aura: { radius: 1, bonus: 0.10 }
  },
  {
    id: 'discovery.notable.wideAperture' as NodeId,
    subPath: 'discovery',
    depth: 5,
    cost: 5,
    effect: { kind: 'scannerCoverageMul' },
    description: 'Wide Aperture — scanner coverage'
  },
  {
    id: 'discovery.notable.droneAstrogeology' as NodeId,
    subPath: 'discovery',
    depth: 3,
    cost: 3,
    effect: { kind: 'droneScanRadiusMul' },
    description: 'Drone Astrogeology — drone scan radius'
  },
  {
    id: 'discovery.notable.deepField' as NodeId,
    subPath: 'discovery',
    depth: 6,
    cost: 6,
    effect: { kind: 'scannerCoverageMul' },
    description: 'Deep Field — scanner coverage',
    aura: { radius: 2, bonus: 0.12 }
  },
];

export const RESILIENCE_NOTABLES: RawSkillNode[] = [
  {
    id: 'resilience.notable.orbitalShields' as NodeId,
    subPath: 'resilience',
    depth: 4,
    cost: 4,
    effect: { kind: 'debrisProtectionMul' },
    description: 'Orbital Shields — debris protection',
    aura: { radius: 1, bonus: 0.10 }
  },
  {
    id: 'resilience.notable.redundantSystems' as NodeId,
    subPath: 'resilience',
    depth: 5,
    cost: 5,
    effect: { kind: 'repairDroneReliabilityMul' },
    description: 'Redundant Systems — repair-drone reliability'
  },
  {
    id: 'resilience.notable.hardenedInfrastructure' as NodeId,
    subPath: 'resilience',
    depth: 3,
    cost: 3,
    effect: { kind: 'maintenanceThresholdMul' },
    description: 'Hardened Infrastructure — maintenance threshold'
  },
  {
    id: 'resilience.notable.debrisWake' as NodeId,
    subPath: 'resilience',
    depth: 6,
    cost: 6,
    effect: { kind: 'debrisProtectionMul' },
    description: 'Debris Wake Dispersal — debris protection',
    aura: { radius: 2, bonus: 0.12 }
  },
];

// ---------------------------------------------------------------------------
// Keystones — AND-prereq nodes (~30 total)
// ---------------------------------------------------------------------------

/** §9.4 role-absorption keystones */
export const ROLE_ABSORPTION_KEYSTONES: RawSkillNode[] = [
  {
    id: 'smelting.keystone.foundryMastery' as NodeId,
    subPath: 'smelting', depth: 8, cost: 10, effect: { kind: 'recipeRateMul', category: 'smelting' },
    description: 'Foundry Mastery — All smelters operate faster'
  },
  {
    id: 'chemistry.keystone.refineryMastery' as NodeId,
    subPath: 'chemistry', depth: 8, cost: 10, effect: { kind: 'recipeRateMul', category: 'chemistry' },
    description: 'Refinery Mastery — All chemistry plants operate faster'
  },
  {
    id: 'mining.keystone.veinmaster' as NodeId,
    subPath: 'mining', depth: 8, cost: 12, effect: { kind: 'recipeRateMul', category: 'extraction' },
    description: 'Veinmaster — All mines operate faster'
  },
  {
    id: 'transport.keystone.hubCapacity' as NodeId,
    subPath: 'transport', depth: 8, cost: 10, effect: { kind: 'routeCapacityMul' },
    description: 'Hub Capacity — Routes carry more per batch'
  },
  {
    id: 'storage.keystone.masterCache' as NodeId,
    subPath: 'storage', depth: 8, cost: 10, effect: { kind: 'storageCategoryCapMul', category: 'components' },
    description: 'Master Cache — components storage cap'
  },
  {
    id: 'power_systems.keystone.researchBeacon' as NodeId,
    subPath: 'power_systems', depth: 8, cost: 10, effect: { kind: 'xpGainMul' },
    description: 'Research Beacon — All XP gain boosted'
  },
];

/** Rule-breaker keystones using newly-wired effect kinds */
export const RULE_BREAKER_KEYSTONES: RawSkillNode[] = [
  {
    id: 'robotics.keystone.parallelConstruction' as NodeId,
    subPath: 'robotics', depth: 7, cost: 8, effect: { kind: 'structural', description: 'Parallel Construction +1 slot', data: { kind: 'parallelConstruction', bonus: 1 } },
    description: 'Parallel Construction — +1 concurrent build slot'
  },
  {
    id: 'forestry.keystone.charcoalUnlock' as NodeId,
    subPath: 'forestry', depth: 7, cost: 8, effect: { kind: 'unlockRecipe', targetBuilding: 'logger', recipe: { cycleSec: 20, inputs: { wood: 2 }, outputs: { coal: 1 }, category: 'extraction' } },
    description: 'Charcoal Kiln — Loggers gain a charcoal output recipe'
  },
  {
    id: 'drilling.keystone.earlyRig' as NodeId,
    subPath: 'drilling', depth: 7, cost: 8, effect: { kind: 'tierBypass', buildings: ['drilling_rig'], tierShift: 1 },
    description: 'Early Rig Permit — Drilling Rig operates one tier below requirement'
  },
  {
    id: 'smelting.keystone.pyroforgeBypass' as NodeId,
    subPath: 'smelting', depth: 7, cost: 8, effect: { kind: 'biomeBypass', buildings: ['pyroforge'] },
    description: 'Pyroforge License — Pyroforge can be placed off-volcanic biome'
  },
  {
    id: 'oceanography.keystone.sonarPair' as NodeId,
    subPath: 'oceanography', depth: 7, cost: 8, effect: { kind: 'exoticAdjacency', description: 'Dock+Tidal pair boost', effect: { kind: 'pairBoost', pair: ['dock', 'tidal_array'], recipeRateBonus: 0.2 } },
    description: 'Tidal Pairing — Adjacent Dock + Tidal Array boost each other'
  },
  {
    id: 'network.keystone.sharedRoutes' as NodeId,
    subPath: 'network', depth: 7, cost: 8, effect: { kind: 'crossIslandShared', shape: { kind: 'sharedRouteCapacity' } },
    description: 'Shared Routes — Networked T3+ islands pool route-capacity bonus'
  },
  {
    id: 'communication.keystone.networkedExtract' as NodeId,
    subPath: 'communication', depth: 7, cost: 8, effect: { kind: 'conditionalBonus', multiplier: 0.25, appliesTo: 'extraction', condition: { kind: 'networked-to-N-T3-islands', n: 5 } },
    description: 'Networked Extraction — extraction rate when networked to ≥5 T3 islands'
  },
  {
    id: 'mining.keystone.deepCore' as NodeId,
    subPath: 'mining', depth: 7, cost: 8, effect: { kind: 'mineYieldBonusMul' },
    description: 'Deep-core Drilling — mine yield'
  },
  {
    id: 'forestry.keystone.silvicultureMastery' as NodeId,
    subPath: 'forestry', depth: 7, cost: 8, effect: { kind: 'loggerYieldBonusMul' },
    description: 'Silviculture Mastery — logger yield'
  },
  {
    id: 'robotics.keystone.swarmIntelligence' as NodeId,
    subPath: 'robotics', depth: 7, cost: 8, effect: { kind: 'droneScanRadiusMul' },
    description: 'Swarm Intelligence — drone scan radius'
  },
  {
    id: 'electronics.keystone.quantumYield' as NodeId,
    subPath: 'electronics', depth: 7, cost: 8, effect: { kind: 'recipeRateMul', category: 'electronics' },
    description: 'Quantum Yield — electronics recipe rate'
  },
  {
    id: 'power_systems.keystone.fusionLock' as NodeId,
    subPath: 'power_systems', depth: 7, cost: 8, effect: { kind: 'powerProductionMul' },
    description: 'Fusion Lock — power production'
  },
  {
    id: 'transport.keystone.supplyChain' as NodeId,
    subPath: 'transport', depth: 7, cost: 8, effect: { kind: 'routeCapacityMul' },
    description: 'Supply Chain Mastery — route capacity'
  },
  {
    id: 'patronage.keystone.diplomaticImmunity' as NodeId,
    subPath: 'patronage', depth: 7, cost: 8, effect: { kind: 'commRangeMul' },
    description: 'Diplomatic Immunity — communication range'
  },
  {
    id: 'aquaculture.keystone.maricultureMastery' as NodeId,
    subPath: 'aquaculture', depth: 7, cost: 8, effect: { kind: 'recipeRateMul', category: 'extraction' },
    description: 'Mariculture Mastery — ocean extraction rate'
  },
  {
    id: 'hydroprocessing.keystone.desalMastery' as NodeId,
    subPath: 'hydroprocessing', depth: 7, cost: 8, effect: { kind: 'recipeRateMul', category: 'chemistry' },
    description: 'Desalination Mastery — chemistry recipe rate'
  },
  {
    id: 'submarine.keystone.deepPressure' as NodeId,
    subPath: 'submarine', depth: 7, cost: 8, effect: { kind: 'routeCapacityMul' },
    description: 'Deep Pressure — submarine route capacity'
  },
  {
    id: 'launch.keystone.padMastery' as NodeId,
    subPath: 'launch', depth: 7, cost: 8, effect: { kind: 'launchSuccessAdditive' },
    description: 'Pad Mastery — launch success rate'
  },
  {
    id: 'discovery.keystone.deepScan' as NodeId,
    subPath: 'discovery', depth: 7, cost: 8, effect: { kind: 'scannerCoverageMul' },
    description: 'Deep Scan — scanner coverage'
  },
  {
    id: 'resilience.keystone.orbitalFortress' as NodeId,
    subPath: 'resilience', depth: 7, cost: 8, effect: { kind: 'debrisProtectionMul' },
    description: 'Orbital Fortress — debris protection'
  },
  {
    id: 'drilling.keystone.reservoirMastery' as NodeId,
    subPath: 'drilling', depth: 7, cost: 8, effect: { kind: 'recipeRateMul', category: 'extraction' },
    description: 'Reservoir Mastery — extraction recipe rate'
  },
  {
    id: 'chemistry.keystone.catalyticMastery' as NodeId,
    subPath: 'chemistry', depth: 7, cost: 8, effect: { kind: 'recipeRateMul', category: 'chemistry' },
    description: 'Catalytic Mastery — chemistry recipe rate'
  },
  {
    id: 'storage.keystone.vaultMastery' as NodeId,
    subPath: 'storage', depth: 7, cost: 8, effect: { kind: 'storageCategoryCapMul', category: 'rare' },
    description: 'Vault Mastery — rare storage cap'
  },
  {
    id: 'network.keystone.meshMastery' as NodeId,
    subPath: 'network', depth: 7, cost: 8, effect: { kind: 'commRangeMul' },
    description: 'Mesh Mastery — communication range'
  },
];

/** Combined keystones array */
export const KEYSTONES: RawSkillNode[] = [
  ...ROLE_ABSORPTION_KEYSTONES,
  ...RULE_BREAKER_KEYSTONES,
];

function ksp(target: string, requires: string[], cost: number): KeystonePrereq {
  type G = import('./skilltree-graph.js').NodeId;
  return {
    targetNode: target as unknown as G,
    requires: requires.map(r => r as unknown as G),
    cost
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
    threshold
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

export const NOTABLES: RawSkillNode[] = [
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
const RAW_FULL_CATALOG: ReadonlyArray<RawSkillNode> = [...ALL_FILLER_NODES, ...NOTABLES, ...KEYSTONES];
export const FULL_CATALOG: ReadonlyArray<SkillNode> = deriveMagnitudes(RAW_FULL_CATALOG, ALL_ARCHETYPE_PREFIXES);
