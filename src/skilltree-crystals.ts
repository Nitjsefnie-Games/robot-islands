import type { CrystalDef, CrystalId } from './skilltree-graph.js';
import type { SubPathId } from './skilltree.js';

function cid(id: string): CrystalId {
  return id as CrystalId;
}

function miningCrystal(tier: 1 | 2 | 3, scale: number): CrystalDef {
  const baseYield = 0.16;
  const baseTrickle = 0.10;
  const baseFiller = 0.04;

  return {
    id: cid(`mining_crystal_t${tier}`),
    displayName: `Mining Crystal T${tier}`,
    tier,
    eligibleSubPaths: ['mining' as SubPathId],
    nodes: [
      {
        idSuffix: 'core',
        cost: 3 * tier,
        magnitude: baseYield * scale,
        effect: { kind: 'mineYieldBonusMul' },
        description: `Mine yield bonus (+${Math.round(baseYield * scale * 100)}%)`,
        position: { dx: 0, dy: 40 },
      },
      {
        idSuffix: 'left1',
        cost: 1 * tier,
        magnitude: baseFiller * scale,
        effect: { kind: 'mineYieldBonusMul' },
        description: `Minor mine yield bonus (+${Math.round(baseFiller * scale * 100)}%)`,
        position: { dx: -30, dy: 20 },
      },
      {
        idSuffix: 'left2',
        cost: 1 * tier,
        magnitude: baseTrickle * scale,
        effect: { kind: 'mineRareTrickleMul' },
        description: `Mine rare trickle bonus (+${Math.round(baseTrickle * scale * 100)}%)`,
        position: { dx: -50, dy: 40 },
      },
      {
        idSuffix: 'right1',
        cost: 1 * tier,
        magnitude: baseFiller * scale,
        effect: { kind: 'mineYieldBonusMul' },
        description: `Minor mine yield bonus (+${Math.round(baseFiller * scale * 100)}%)`,
        position: { dx: 30, dy: 20 },
      },
      {
        idSuffix: 'right2',
        cost: 1 * tier,
        magnitude: baseTrickle * scale,
        effect: { kind: 'mineRareTrickleMul' },
        description: `Mine rare trickle bonus (+${Math.round(baseTrickle * scale * 100)}%)`,
        position: { dx: 50, dy: 40 },
      },
    ],
    edges: [
      { fromSuffix: 'socket', toSuffix: 'core', cost: 0 },
      { fromSuffix: 'socket', toSuffix: 'left1', cost: 1 * tier },
      { fromSuffix: 'left1', toSuffix: 'left2', cost: 1 * tier },
      { fromSuffix: 'socket', toSuffix: 'right1', cost: 1 * tier },
      { fromSuffix: 'right1', toSuffix: 'right2', cost: 1 * tier },
    ],
  };
}

function forestryCrystal(tier: 1 | 2 | 3, scale: number): CrystalDef {
  const baseYield = 0.16;
  const baseTrickle = 0.10;
  const baseFiller = 0.04;
  return {
    id: cid('forestry_crystal_t' + tier),
    displayName: 'Forestry Crystal T' + tier,
    tier,
    eligibleSubPaths: ['forestry' as SubPathId],
    nodes: [
      { idSuffix: 'core', cost: 3 * tier, magnitude: baseYield * scale, effect: {"kind":"loggerYieldBonusMul"}, description: `Logger yield bonus (+Math.round(baseYield * scale * 100)%)`, position: { dx: 0, dy: 40 } },
      { idSuffix: 'left1', cost: 1 * tier, magnitude: baseFiller * scale, effect: {"kind":"loggerYieldBonusMul"}, description: `Logger yield bonus (+Math.round(baseFiller * scale * 100)%)`, position: { dx: -30, dy: 20 } },
      { idSuffix: 'left2', cost: 1 * tier, magnitude: baseTrickle * scale, effect: {"kind":"loggerExoticTrickleMul"}, description: `Logger exotic trickle bonus (+Math.round(baseTrickle * scale * 100)%)`, position: { dx: -50, dy: 40 } },
      { idSuffix: 'right1', cost: 1 * tier, magnitude: baseFiller * scale, effect: {"kind":"loggerYieldBonusMul"}, description: `Logger yield bonus (+Math.round(baseFiller * scale * 100)%)`, position: { dx: 30, dy: 20 } },
      { idSuffix: 'right2', cost: 1 * tier, magnitude: baseTrickle * scale, effect: {"kind":"loggerExoticTrickleMul"}, description: `Logger exotic trickle bonus (+Math.round(baseTrickle * scale * 100)%)`, position: { dx: 50, dy: 40 } },
    ],
    edges: [
      { fromSuffix: 'socket', toSuffix: 'core', cost: 0 },
      { fromSuffix: 'socket', toSuffix: 'left1', cost: 1 * tier },
      { fromSuffix: 'left1', toSuffix: 'left2', cost: 1 * tier },
      { fromSuffix: 'socket', toSuffix: 'right1', cost: 1 * tier },
      { fromSuffix: 'right1', toSuffix: 'right2', cost: 1 * tier },
    ],
  };
}

function drillingCrystal(tier: 1 | 2 | 3, scale: number): CrystalDef {
  const baseYield = 0.16;
  const baseTrickle = 0.10;
  const baseFiller = 0.04;
  return {
    id: cid('drilling_crystal_t' + tier),
    displayName: 'Drilling Crystal T' + tier,
    tier,
    eligibleSubPaths: ['drilling' as SubPathId],
    nodes: [
      { idSuffix: 'core', cost: 3 * tier, magnitude: baseYield * scale, effect: {"kind":"recipeRateMul","category":"extraction"}, description: `extraction rate bonus (+Math.round(baseYield * scale * 100)%)`, position: { dx: 0, dy: 40 } },
      { idSuffix: 'left1', cost: 1 * tier, magnitude: baseFiller * scale, effect: {"kind":"recipeRateMul","category":"extraction"}, description: `extraction rate bonus (+Math.round(baseFiller * scale * 100)%)`, position: { dx: -30, dy: 20 } },
      { idSuffix: 'left2', cost: 1 * tier, magnitude: baseTrickle * scale, effect: {"kind":"powerConsumptionMul","reduce":true}, description: `Power consumption reduction (+Math.round(baseTrickle * scale * 100)%)`, position: { dx: -50, dy: 40 } },
      { idSuffix: 'right1', cost: 1 * tier, magnitude: baseFiller * scale, effect: {"kind":"recipeRateMul","category":"extraction"}, description: `extraction rate bonus (+Math.round(baseFiller * scale * 100)%)`, position: { dx: 30, dy: 20 } },
      { idSuffix: 'right2', cost: 1 * tier, magnitude: baseTrickle * scale, effect: {"kind":"powerConsumptionMul","reduce":true}, description: `Power consumption reduction (+Math.round(baseTrickle * scale * 100)%)`, position: { dx: 50, dy: 40 } },
    ],
    edges: [
      { fromSuffix: 'socket', toSuffix: 'core', cost: 0 },
      { fromSuffix: 'socket', toSuffix: 'left1', cost: 1 * tier },
      { fromSuffix: 'left1', toSuffix: 'left2', cost: 1 * tier },
      { fromSuffix: 'socket', toSuffix: 'right1', cost: 1 * tier },
      { fromSuffix: 'right1', toSuffix: 'right2', cost: 1 * tier },
    ],
  };
}

function roboticsCrystal(tier: 1 | 2 | 3, scale: number): CrystalDef {
  const baseCore = -0.22;
  const baseA = 0.10;
  const baseB = 0.10;
  const baseC = 0.08;
  return {
    id: cid('robotics_crystal_t' + tier),
    displayName: 'Robotics Crystal T' + tier,
    tier,
    eligibleSubPaths: ['robotics' as SubPathId],
    nodes: [
      { idSuffix: 'core', cost: 3 * tier, magnitude: baseCore * scale, effect: {"kind":"constructionTimeMul"}, description: `Construction time reduction (Math.round(baseCore * scale * 100)%)`, position: { dx: 0, dy: 40 } },
      { idSuffix: 'a', cost: 1 * tier, magnitude: baseA * scale, effect: {"kind":"droneScanRadiusMul"}, description: `Drone scan radius bonus (+Math.round(baseA * scale * 100)%)`, position: { dx: 0, dy: 20 } },
      { idSuffix: 'b', cost: 1 * tier, magnitude: baseB * scale, effect: {"kind":"droneFuelEfficiencyMul"}, description: `Drone fuel efficiency bonus (+Math.round(baseB * scale * 100)%)`, position: { dx: 0, dy: 0 } },
      { idSuffix: 'c', cost: 1 * tier, magnitude: baseC * scale, effect: {"kind":"recipeRateMul","category":"manufacturing"}, description: `manufacturing rate bonus (+Math.round(baseC * scale * 100)%)`, position: { dx: 0, dy: -20 } },
    ],
    edges: [
      { fromSuffix: 'socket', toSuffix: 'core', cost: 0 },
      { fromSuffix: 'core', toSuffix: 'a', cost: 1 * tier },
      { fromSuffix: 'a', toSuffix: 'b', cost: 1 * tier },
      { fromSuffix: 'b', toSuffix: 'c', cost: 1 * tier },
    ],
  };
}

function smeltingCrystal(tier: 1 | 2 | 3, scale: number): CrystalDef {
  const baseCore = 0.16;
  const baseArm = 0.08;
  return {
    id: cid('smelting_crystal_t' + tier),
    displayName: 'Smelting Crystal T' + tier,
    tier,
    eligibleSubPaths: ['smelting' as SubPathId],
    nodes: [
      { idSuffix: 'left', cost: 1 * tier, magnitude: baseArm * scale, effect: {"kind":"recipeRateMul","category":"smelting"}, description: `smelting rate bonus (+Math.round(baseArm * scale * 100)%)`, position: { dx: -30, dy: 30 } },
      { idSuffix: 'right', cost: 1 * tier, magnitude: baseArm * scale, effect: {"kind":"powerConsumptionMul","reduce":true}, description: `Power consumption reduction (+Math.round(baseArm * scale * 100)%)`, position: { dx: 30, dy: 30 } },
      { idSuffix: 'core', cost: 3 * tier, magnitude: baseCore * scale, effect: {"kind":"recipeRateMul","category":"smelting"}, description: `smelting rate bonus (+Math.round(baseCore * scale * 100)%)`, position: { dx: 0, dy: 50 } },
    ],
    edges: [
      { fromSuffix: 'socket', toSuffix: 'left', cost: 1 * tier },
      { fromSuffix: 'socket', toSuffix: 'right', cost: 1 * tier },
      { fromSuffix: 'left', toSuffix: 'core', cost: 1 * tier },
      { fromSuffix: 'right', toSuffix: 'core', cost: 1 * tier },
    ],
  };
}

function chemistryCrystal(tier: 1 | 2 | 3, scale: number): CrystalDef {
  const baseCore = 0.16;
  const baseArm = 0.08;
  return {
    id: cid('chemistry_crystal_t' + tier),
    displayName: 'Chemistry Crystal T' + tier,
    tier,
    eligibleSubPaths: ['chemistry' as SubPathId],
    nodes: [
      { idSuffix: 'left', cost: 1 * tier, magnitude: baseArm * scale, effect: {"kind":"recipeRateMul","category":"chemistry"}, description: `chemistry rate bonus (+Math.round(baseArm * scale * 100)%)`, position: { dx: -30, dy: 30 } },
      { idSuffix: 'right', cost: 1 * tier, magnitude: baseArm * scale, effect: {"kind":"powerConsumptionMul","reduce":true}, description: `Power consumption reduction (+Math.round(baseArm * scale * 100)%)`, position: { dx: 30, dy: 30 } },
      { idSuffix: 'core', cost: 3 * tier, magnitude: baseCore * scale, effect: {"kind":"recipeRateMul","category":"chemistry"}, description: `chemistry rate bonus (+Math.round(baseCore * scale * 100)%)`, position: { dx: 0, dy: 50 } },
    ],
    edges: [
      { fromSuffix: 'socket', toSuffix: 'left', cost: 1 * tier },
      { fromSuffix: 'socket', toSuffix: 'right', cost: 1 * tier },
      { fromSuffix: 'left', toSuffix: 'core', cost: 1 * tier },
      { fromSuffix: 'right', toSuffix: 'core', cost: 1 * tier },
    ],
  };
}

function electronicsCrystal(tier: 1 | 2 | 3, scale: number): CrystalDef {
  const baseCore = 0.16;
  const baseArm = 0.08;
  return {
    id: cid('electronics_crystal_t' + tier),
    displayName: 'Electronics Crystal T' + tier,
    tier,
    eligibleSubPaths: ['electronics' as SubPathId],
    nodes: [
      { idSuffix: 'left', cost: 1 * tier, magnitude: baseArm * scale, effect: {"kind":"recipeRateMul","category":"electronics"}, description: `electronics rate bonus (+Math.round(baseArm * scale * 100)%)`, position: { dx: -30, dy: 30 } },
      { idSuffix: 'right', cost: 1 * tier, magnitude: baseArm * scale, effect: {"kind":"powerConsumptionMul","reduce":true}, description: `Power consumption reduction (+Math.round(baseArm * scale * 100)%)`, position: { dx: 30, dy: 30 } },
      { idSuffix: 'core', cost: 3 * tier, magnitude: baseCore * scale, effect: {"kind":"recipeRateMul","category":"electronics"}, description: `electronics rate bonus (+Math.round(baseCore * scale * 100)%)`, position: { dx: 0, dy: 50 } },
    ],
    edges: [
      { fromSuffix: 'socket', toSuffix: 'left', cost: 1 * tier },
      { fromSuffix: 'socket', toSuffix: 'right', cost: 1 * tier },
      { fromSuffix: 'left', toSuffix: 'core', cost: 1 * tier },
      { fromSuffix: 'right', toSuffix: 'core', cost: 1 * tier },
    ],
  };
}

function power_systemsCrystal(tier: 1 | 2 | 3, scale: number): CrystalDef {
  const baseCore = 0.16;
  const baseArm = 0.08;
  return {
    id: cid('power_systems_crystal_t' + tier),
    displayName: 'Power systems Crystal T' + tier,
    tier,
    eligibleSubPaths: ['power_systems' as SubPathId],
    nodes: [
      { idSuffix: 'left', cost: 1 * tier, magnitude: baseArm * scale, effect: {"kind":"powerProductionMul"}, description: `Power production bonus (+Math.round(baseArm * scale * 100)%)`, position: { dx: -30, dy: 30 } },
      { idSuffix: 'right', cost: 1 * tier, magnitude: baseArm * scale, effect: {"kind":"recipeRateMul","category":"power"}, description: `power rate bonus (+Math.round(baseArm * scale * 100)%)`, position: { dx: 30, dy: 30 } },
      { idSuffix: 'core', cost: 3 * tier, magnitude: baseCore * scale, effect: {"kind":"powerProductionMul"}, description: `Power production bonus (+Math.round(baseCore * scale * 100)%)`, position: { dx: 0, dy: 50 } },
    ],
    edges: [
      { fromSuffix: 'socket', toSuffix: 'left', cost: 1 * tier },
      { fromSuffix: 'socket', toSuffix: 'right', cost: 1 * tier },
      { fromSuffix: 'left', toSuffix: 'core', cost: 1 * tier },
      { fromSuffix: 'right', toSuffix: 'core', cost: 1 * tier },
    ],
  };
}

function storageCrystal(tier: 1 | 2 | 3, scale: number): CrystalDef {
  const baseArm = 0.12;
  return {
    id: cid('storage_crystal_t' + tier),
    displayName: 'Storage Crystal T' + tier,
    tier,
    eligibleSubPaths: ['storage' as SubPathId],
    nodes: [
      { idSuffix: 'left', cost: 2 * tier, magnitude: baseArm * scale, effect: {"kind":"storageCapMul"}, description: `Storage capacity bonus (+Math.round(baseArm * scale * 100)%)`, position: { dx: -30, dy: 30 } },
      { idSuffix: 'right', cost: 2 * tier, magnitude: baseArm * scale, effect: {"kind":"storageCategoryCapMul","category":"dry_goods"}, description: `dry_goods storage cap bonus (+Math.round(baseArm * scale * 100)%)`, position: { dx: 30, dy: 30 } },
    ],
    edges: [
      { fromSuffix: 'socket', toSuffix: 'left', cost: 1 * tier },
      { fromSuffix: 'socket', toSuffix: 'right', cost: 1 * tier },
    ],
  };
}

function transportCrystal(tier: 1 | 2 | 3, scale: number): CrystalDef {
  const baseArm = 0.12;
  return {
    id: cid('transport_crystal_t' + tier),
    displayName: 'Transport Crystal T' + tier,
    tier,
    eligibleSubPaths: ['transport' as SubPathId],
    nodes: [
      { idSuffix: 'left', cost: 2 * tier, magnitude: baseArm * scale, effect: {"kind":"routeCapacityMul"}, description: `Route capacity bonus (+Math.round(baseArm * scale * 100)%)`, position: { dx: -30, dy: 30 } },
      { idSuffix: 'right', cost: 2 * tier, magnitude: baseArm * scale, effect: {"kind":"airshipRangeMul"}, description: `Airship range bonus (+Math.round(baseArm * scale * 100)%)`, position: { dx: 30, dy: 30 } },
    ],
    edges: [
      { fromSuffix: 'socket', toSuffix: 'left', cost: 1 * tier },
      { fromSuffix: 'socket', toSuffix: 'right', cost: 1 * tier },
    ],
  };
}

function networkCrystal(tier: 1 | 2 | 3, scale: number): CrystalDef {
  const baseArm = 0.12;
  return {
    id: cid('network_crystal_t' + tier),
    displayName: 'Network Crystal T' + tier,
    tier,
    eligibleSubPaths: ['network' as SubPathId],
    nodes: [
      { idSuffix: 'left', cost: 2 * tier, magnitude: baseArm * scale, effect: {"kind":"commRangeMul"}, description: `Comm range bonus (+Math.round(baseArm * scale * 100)%)`, position: { dx: -30, dy: 30 } },
      { idSuffix: 'right', cost: 2 * tier, magnitude: baseArm * scale, effect: {"kind":"teleporterEfficiencyMul"}, description: `Teleporter efficiency bonus (+Math.round(baseArm * scale * 100)%)`, position: { dx: 30, dy: 30 } },
    ],
    edges: [
      { fromSuffix: 'socket', toSuffix: 'left', cost: 1 * tier },
      { fromSuffix: 'socket', toSuffix: 'right', cost: 1 * tier },
    ],
  };
}

function launchCrystal(tier: 1 | 2 | 3, scale: number): CrystalDef {
  const base = 0.10;
  return {
    id: cid('launch_crystal_t' + tier),
    displayName: 'Launch Crystal T' + tier,
    tier,
    eligibleSubPaths: ['launch' as SubPathId],
    nodes: [
      { idSuffix: 'a', cost: 1 * tier, magnitude: base * scale, effect: {"kind":"satBufferCapMul"}, description: `Satellite buffer cap bonus (+Math.round(base * scale * 100)%)`, position: { dx: 0, dy: 30 } },
      { idSuffix: 'b', cost: 1 * tier, magnitude: base * scale, effect: {"kind":"scannerCoverageMul"}, description: `Scanner coverage bonus (+Math.round(base * scale * 100)%)`, position: { dx: 30, dy: 0 } },
      { idSuffix: 'c', cost: 1 * tier, magnitude: base * scale, effect: {"kind":"commRangeMul"}, description: `Comm range bonus (+Math.round(base * scale * 100)%)`, position: { dx: 0, dy: -30 } },
      { idSuffix: 'd', cost: 1 * tier, magnitude: base * scale, effect: {"kind":"debrisProtectionMul"}, description: `Debris protection bonus (+Math.round(base * scale * 100)%)`, position: { dx: -30, dy: 0 } },
    ],
    edges: [
      { fromSuffix: 'socket', toSuffix: 'a', cost: 1 * tier },
      { fromSuffix: 'a', toSuffix: 'b', cost: 1 * tier },
      { fromSuffix: 'b', toSuffix: 'c', cost: 1 * tier },
      { fromSuffix: 'c', toSuffix: 'd', cost: 1 * tier },
      { fromSuffix: 'd', toSuffix: 'a', cost: 1 * tier },
    ],
  };
}

function communicationCrystal(tier: 1 | 2 | 3, scale: number): CrystalDef {
  const base = 0.10;
  return {
    id: cid('communication_crystal_t' + tier),
    displayName: 'Communication Crystal T' + tier,
    tier,
    eligibleSubPaths: ['communication' as SubPathId],
    nodes: [
      { idSuffix: 'a', cost: 1 * tier, magnitude: base * scale, effect: {"kind":"commRangeMul"}, description: `Comm range bonus (+Math.round(base * scale * 100)%)`, position: { dx: 0, dy: 30 } },
      { idSuffix: 'b', cost: 1 * tier, magnitude: base * scale, effect: {"kind":"satBufferCapMul"}, description: `Satellite buffer cap bonus (+Math.round(base * scale * 100)%)`, position: { dx: 30, dy: 0 } },
      { idSuffix: 'c', cost: 1 * tier, magnitude: base * scale, effect: {"kind":"teleporterEfficiencyMul"}, description: `Teleporter efficiency bonus (+Math.round(base * scale * 100)%)`, position: { dx: 0, dy: -30 } },
      { idSuffix: 'd', cost: 1 * tier, magnitude: base * scale, effect: {"kind":"routeCapacityMul"}, description: `Route capacity bonus (+Math.round(base * scale * 100)%)`, position: { dx: -30, dy: 0 } },
    ],
    edges: [
      { fromSuffix: 'socket', toSuffix: 'a', cost: 1 * tier },
      { fromSuffix: 'a', toSuffix: 'b', cost: 1 * tier },
      { fromSuffix: 'b', toSuffix: 'c', cost: 1 * tier },
      { fromSuffix: 'c', toSuffix: 'd', cost: 1 * tier },
      { fromSuffix: 'd', toSuffix: 'a', cost: 1 * tier },
    ],
  };
}

function discoveryCrystal(tier: 1 | 2 | 3, scale: number): CrystalDef {
  const base = 0.10;
  return {
    id: cid('discovery_crystal_t' + tier),
    displayName: 'Discovery Crystal T' + tier,
    tier,
    eligibleSubPaths: ['discovery' as SubPathId],
    nodes: [
      { idSuffix: 'a', cost: 1 * tier, magnitude: base * scale, effect: {"kind":"scannerCoverageMul"}, description: `Scanner coverage bonus (+Math.round(base * scale * 100)%)`, position: { dx: 0, dy: 30 } },
      { idSuffix: 'b', cost: 1 * tier, magnitude: base * scale, effect: {"kind":"scannerDwellRateMul"}, description: `Scanner dwell rate bonus (+Math.round(base * scale * 100)%)`, position: { dx: 30, dy: 0 } },
      { idSuffix: 'c', cost: 1 * tier, magnitude: base * scale, effect: {"kind":"satBufferCapMul"}, description: `Satellite buffer cap bonus (+Math.round(base * scale * 100)%)`, position: { dx: 0, dy: -30 } },
      { idSuffix: 'd', cost: 1 * tier, magnitude: base * scale, effect: {"kind":"commRangeMul"}, description: `Comm range bonus (+Math.round(base * scale * 100)%)`, position: { dx: -30, dy: 0 } },
    ],
    edges: [
      { fromSuffix: 'socket', toSuffix: 'a', cost: 1 * tier },
      { fromSuffix: 'a', toSuffix: 'b', cost: 1 * tier },
      { fromSuffix: 'b', toSuffix: 'c', cost: 1 * tier },
      { fromSuffix: 'c', toSuffix: 'd', cost: 1 * tier },
      { fromSuffix: 'd', toSuffix: 'a', cost: 1 * tier },
    ],
  };
}

function resilienceCrystal(tier: 1 | 2 | 3, scale: number): CrystalDef {
  const base = 0.10;
  return {
    id: cid('resilience_crystal_t' + tier),
    displayName: 'Resilience Crystal T' + tier,
    tier,
    eligibleSubPaths: ['resilience' as SubPathId],
    nodes: [
      { idSuffix: 'a', cost: 1 * tier, magnitude: base * scale, effect: {"kind":"debrisProtectionMul"}, description: `Debris protection bonus (+Math.round(base * scale * 100)%)`, position: { dx: 0, dy: 30 } },
      { idSuffix: 'b', cost: 1 * tier, magnitude: base * scale, effect: {"kind":"repairDroneReliabilityMul"}, description: `Repair drone reliability bonus (+Math.round(base * scale * 100)%)`, position: { dx: 30, dy: 0 } },
      { idSuffix: 'c', cost: 1 * tier, magnitude: base * scale, effect: {"kind":"maintenanceThresholdMul"}, description: `Maintenance threshold bonus (+Math.round(base * scale * 100)%)`, position: { dx: 0, dy: -30 } },
      { idSuffix: 'd', cost: 1 * tier, magnitude: base * scale, effect: {"kind":"padExplosionReduceMul"}, description: `Pad explosion reduction (+Math.round(base * scale * 100)%)`, position: { dx: -30, dy: 0 } },
    ],
    edges: [
      { fromSuffix: 'socket', toSuffix: 'a', cost: 1 * tier },
      { fromSuffix: 'a', toSuffix: 'b', cost: 1 * tier },
      { fromSuffix: 'b', toSuffix: 'c', cost: 1 * tier },
      { fromSuffix: 'c', toSuffix: 'd', cost: 1 * tier },
      { fromSuffix: 'd', toSuffix: 'a', cost: 1 * tier },
    ],
  };
}

function patronageCrystal(tier: 1 | 2 | 3, scale: number): CrystalDef {
  const baseCore = 0.16;
  const baseArm = 0.08;
  return {
    id: cid('patronage_crystal_t' + tier),
    displayName: 'Patronage Crystal T' + tier,
    tier,
    eligibleSubPaths: ['patronage' as SubPathId],
    nodes: [
      { idSuffix: 'left', cost: 1 * tier, magnitude: baseArm * scale, effect: {"kind":"routeCapacityMul"}, description: `Route capacity bonus (+Math.round(baseArm * scale * 100)%)`, position: { dx: -30, dy: 30 } },
      { idSuffix: 'right', cost: 1 * tier, magnitude: baseArm * scale, effect: {"kind":"airshipRangeMul"}, description: `Airship range bonus (+Math.round(baseArm * scale * 100)%)`, position: { dx: 30, dy: 30 } },
      { idSuffix: 'core', cost: 3 * tier, magnitude: baseCore * scale, effect: {"kind":"recipeRateMul","category":"manufacturing"}, description: `manufacturing rate bonus (+Math.round(baseCore * scale * 100)%)`, position: { dx: 0, dy: 50 } },
    ],
    edges: [
      { fromSuffix: 'socket', toSuffix: 'left', cost: 1 * tier },
      { fromSuffix: 'socket', toSuffix: 'right', cost: 1 * tier },
      { fromSuffix: 'left', toSuffix: 'core', cost: 1 * tier },
      { fromSuffix: 'right', toSuffix: 'core', cost: 1 * tier },
    ],
  };
}

function aquacultureCrystal(tier: 1 | 2 | 3, scale: number): CrystalDef {
  const baseCore = 0.16;
  const baseArm = 0.08;
  return {
    id: cid('aquaculture_crystal_t' + tier),
    displayName: 'Aquaculture Crystal T' + tier,
    tier,
    eligibleSubPaths: ['aquaculture' as SubPathId],
    nodes: [
      { idSuffix: 'left', cost: 1 * tier, magnitude: baseArm * scale, effect: {"kind":"recipeRateMul","category":"extraction"}, description: `extraction rate bonus (+Math.round(baseArm * scale * 100)%)`, position: { dx: -30, dy: 30 } },
      { idSuffix: 'right', cost: 1 * tier, magnitude: baseArm * scale, effect: {"kind":"storageCategoryCapMul","category":"liquid_gas"}, description: `liquid_gas storage cap bonus (+Math.round(baseArm * scale * 100)%)`, position: { dx: 30, dy: 30 } },
      { idSuffix: 'core', cost: 3 * tier, magnitude: baseCore * scale, effect: {"kind":"recipeRateMul","category":"extraction"}, description: `extraction rate bonus (+Math.round(baseCore * scale * 100)%)`, position: { dx: 0, dy: 50 } },
    ],
    edges: [
      { fromSuffix: 'socket', toSuffix: 'left', cost: 1 * tier },
      { fromSuffix: 'socket', toSuffix: 'right', cost: 1 * tier },
      { fromSuffix: 'left', toSuffix: 'core', cost: 1 * tier },
      { fromSuffix: 'right', toSuffix: 'core', cost: 1 * tier },
    ],
  };
}

function hydroprocessingCrystal(tier: 1 | 2 | 3, scale: number): CrystalDef {
  const baseCore = 0.16;
  const baseArm = 0.08;
  return {
    id: cid('hydroprocessing_crystal_t' + tier),
    displayName: 'Hydroprocessing Crystal T' + tier,
    tier,
    eligibleSubPaths: ['hydroprocessing' as SubPathId],
    nodes: [
      { idSuffix: 'left', cost: 1 * tier, magnitude: baseArm * scale, effect: {"kind":"recipeRateMul","category":"chemistry"}, description: `chemistry rate bonus (+Math.round(baseArm * scale * 100)%)`, position: { dx: -30, dy: 30 } },
      { idSuffix: 'right', cost: 1 * tier, magnitude: baseArm * scale, effect: {"kind":"powerConsumptionMul","reduce":true}, description: `Power consumption reduction (+Math.round(baseArm * scale * 100)%)`, position: { dx: 30, dy: 30 } },
      { idSuffix: 'core', cost: 3 * tier, magnitude: baseCore * scale, effect: {"kind":"recipeRateMul","category":"chemistry"}, description: `chemistry rate bonus (+Math.round(baseCore * scale * 100)%)`, position: { dx: 0, dy: 50 } },
    ],
    edges: [
      { fromSuffix: 'socket', toSuffix: 'left', cost: 1 * tier },
      { fromSuffix: 'socket', toSuffix: 'right', cost: 1 * tier },
      { fromSuffix: 'left', toSuffix: 'core', cost: 1 * tier },
      { fromSuffix: 'right', toSuffix: 'core', cost: 1 * tier },
    ],
  };
}

function submarineCrystal(tier: 1 | 2 | 3, scale: number): CrystalDef {
  const baseCore = 0.16;
  const baseArm = 0.08;
  return {
    id: cid('submarine_crystal_t' + tier),
    displayName: 'Submarine Crystal T' + tier,
    tier,
    eligibleSubPaths: ['submarine' as SubPathId],
    nodes: [
      { idSuffix: 'left', cost: 1 * tier, magnitude: baseArm * scale, effect: {"kind":"droneScanRadiusMul"}, description: `Drone scan radius bonus (+Math.round(baseArm * scale * 100)%)`, position: { dx: -30, dy: 30 } },
      { idSuffix: 'right', cost: 1 * tier, magnitude: baseArm * scale, effect: {"kind":"droneFuelEfficiencyMul"}, description: `Drone fuel efficiency bonus (+Math.round(baseArm * scale * 100)%)`, position: { dx: 30, dy: 30 } },
      { idSuffix: 'core', cost: 3 * tier, magnitude: baseCore * scale, effect: {"kind":"scannerCoverageMul"}, description: `Scanner coverage bonus (+Math.round(baseCore * scale * 100)%)`, position: { dx: 0, dy: 50 } },
    ],
    edges: [
      { fromSuffix: 'socket', toSuffix: 'left', cost: 1 * tier },
      { fromSuffix: 'socket', toSuffix: 'right', cost: 1 * tier },
      { fromSuffix: 'left', toSuffix: 'core', cost: 1 * tier },
      { fromSuffix: 'right', toSuffix: 'core', cost: 1 * tier },
    ],
  };
}

function oceanographyCrystal(tier: 1 | 2 | 3, scale: number): CrystalDef {
  const baseCore = 0.16;
  const baseArm = 0.08;
  return {
    id: cid('oceanography_crystal_t' + tier),
    displayName: 'Oceanography Crystal T' + tier,
    tier,
    eligibleSubPaths: ['oceanography' as SubPathId],
    nodes: [
      { idSuffix: 'left', cost: 1 * tier, magnitude: baseArm * scale, effect: {"kind":"scannerDwellRateMul"}, description: `Scanner dwell rate bonus (+Math.round(baseArm * scale * 100)%)`, position: { dx: -30, dy: 30 } },
      { idSuffix: 'right', cost: 1 * tier, magnitude: baseArm * scale, effect: {"kind":"commRangeMul"}, description: `Comm range bonus (+Math.round(baseArm * scale * 100)%)`, position: { dx: 30, dy: 30 } },
      { idSuffix: 'core', cost: 3 * tier, magnitude: baseCore * scale, effect: {"kind":"scannerCoverageMul"}, description: `Scanner coverage bonus (+Math.round(baseCore * scale * 100)%)`, position: { dx: 0, dy: 50 } },
    ],
    edges: [
      { fromSuffix: 'socket', toSuffix: 'left', cost: 1 * tier },
      { fromSuffix: 'socket', toSuffix: 'right', cost: 1 * tier },
      { fromSuffix: 'left', toSuffix: 'core', cost: 1 * tier },
      { fromSuffix: 'right', toSuffix: 'core', cost: 1 * tier },
    ],
  };
}

export const CRYSTAL_CATALOG: ReadonlyArray<CrystalDef> = [
  miningCrystal(1, 1),
  miningCrystal(2, 1.5),
  miningCrystal(3, 2.25),
  forestryCrystal(1, 1),
  forestryCrystal(2, 1.5),
  forestryCrystal(3, 2.25),
  drillingCrystal(1, 1),
  drillingCrystal(2, 1.5),
  drillingCrystal(3, 2.25),
  roboticsCrystal(1, 1),
  roboticsCrystal(2, 1.5),
  roboticsCrystal(3, 2.25),
  smeltingCrystal(1, 1),
  smeltingCrystal(2, 1.5),
  smeltingCrystal(3, 2.25),
  chemistryCrystal(1, 1),
  chemistryCrystal(2, 1.5),
  chemistryCrystal(3, 2.25),
  electronicsCrystal(1, 1),
  electronicsCrystal(2, 1.5),
  electronicsCrystal(3, 2.25),
  power_systemsCrystal(1, 1),
  power_systemsCrystal(2, 1.5),
  power_systemsCrystal(3, 2.25),
  storageCrystal(1, 1),
  storageCrystal(2, 1.5),
  storageCrystal(3, 2.25),
  transportCrystal(1, 1),
  transportCrystal(2, 1.5),
  transportCrystal(3, 2.25),
  networkCrystal(1, 1),
  networkCrystal(2, 1.5),
  networkCrystal(3, 2.25),
  launchCrystal(1, 1),
  launchCrystal(2, 1.5),
  launchCrystal(3, 2.25),
  communicationCrystal(1, 1),
  communicationCrystal(2, 1.5),
  communicationCrystal(3, 2.25),
  discoveryCrystal(1, 1),
  discoveryCrystal(2, 1.5),
  discoveryCrystal(3, 2.25),
  resilienceCrystal(1, 1),
  resilienceCrystal(2, 1.5),
  resilienceCrystal(3, 2.25),
  patronageCrystal(1, 1),
  patronageCrystal(2, 1.5),
  patronageCrystal(3, 2.25),
  aquacultureCrystal(1, 1),
  aquacultureCrystal(2, 1.5),
  aquacultureCrystal(3, 2.25),
  hydroprocessingCrystal(1, 1),
  hydroprocessingCrystal(2, 1.5),
  hydroprocessingCrystal(3, 2.25),
  submarineCrystal(1, 1),
  submarineCrystal(2, 1.5),
  submarineCrystal(3, 2.25),
  oceanographyCrystal(1, 1),
  oceanographyCrystal(2, 1.5),
  oceanographyCrystal(3, 2.25),
];
