/* eslint-disable no-console */
// scripts/skilltree-magnitudes.ts — dev script. Computes per-effect-kind
// product of (1 + magnitude) across the live catalog and prints a table.
// Run: npx tsx scripts/skilltree-magnitudes.ts

import { FULL_CATALOG } from '../src/skilltree-catalog.js';
import type { SkillEffect } from '../src/skilltree.js';

function effectKey(e: SkillEffect): string {
  if (e.kind === 'recipeRateMul') return `recipeRateMul:${e.category}`;
  if (e.kind === 'storageCategoryCapMul') return `storageCategoryCapMul:${e.category}`;
  if (e.kind === 'xpGainMul') return `xpGainMul:${e.category ?? '(global)'}`;
  return e.kind;
}

// Per-effect-kind product targets (from spec §03). Tolerance for the test
// is ±0.5%, which catches a forgotten magnitude or an off-by-one count.
export const POOL_TARGETS: Readonly<Record<string, number>> = {
  'recipeRateMul:extraction': 3.162,
  'recipeRateMul:chemistry': 10.0,
  'recipeRateMul:smelting': 10.0,
  'recipeRateMul:electronics': 10.0,
  'recipeRateMul:manufacturing': 10.0,
  'powerConsumptionMul': 3.162,
  'commRangeMul': 10.0,
  'scannerCoverageMul': 10.0,
  'storageCategoryCapMul:dry_goods': 3.162,
  'storageCategoryCapMul:liquid_gas': 3.162,
  'storageCategoryCapMul:components': 3.162,
  'storageCategoryCapMul:rare': 3.162,
  'storageCapMul': 3.162,
  'routeCapacityMul': 10.0,
  'maintenanceThresholdMul': 10.0,
  'mineYieldBonusMul': 3.162,
  'droneScanRadiusMul': 10.0,
  'satBufferCapMul': 10.0,
  'powerProductionMul': 3.162,
  'droneFuelEfficiencyMul': 10.0,
  'airshipRangeMul': 10.0,
  'debrisProtectionMul': 10.0,
  'batteryCapacityMul': 10.0,
  'mineRareTrickleMul': 10.0,
  'constructionTimeMul': 10.0,
  'loggerYieldBonusMul': 3.162,
  'xpGainMul:(global)': 3.0,
  'scannerDwellRateMul': 10.0,
  'teleporterEfficiencyMul': 10.0,
  'repairDroneReliabilityMul': 10.0,
  'padExplosionReduceMul': 10.0,
  'satFuelReserveMul': 10.0,
  'loggerExoticTrickleMul': 10.0,
  'drillYieldBonusMul': 3.162,
  'aquacultureYieldBonusMul': 3.162,
  'patronageYieldBonusMul': 3.162,
  't5ExtractorYieldBonusMul': 3.162,
};

export function computeProducts(): Map<string, number> {
  const products = new Map<string, number>();
  for (const n of FULL_CATALOG) {
    if (!('magnitude' in n)) continue;
    const key = effectKey(n.effect);
    if (!(key in POOL_TARGETS)) continue;
    products.set(key, (products.get(key) ?? 1) * (1 + n.magnitude));
  }
  return products;
}

// CLI entry — pretty-print the table.
if (import.meta.url === `file://${process.argv[1]}`) {
  const products = computeProducts();
  const rows: Array<[string, number, number, number]> = [];
  for (const [k, target] of Object.entries(POOL_TARGETS)) {
    const actual = products.get(k) ?? 0;
    const ratio = target === 0 ? 0 : actual / target;
    rows.push([k, target, actual, ratio]);
  }
  console.log('effect-kind                                target    actual    ratio');
  console.log('-'.repeat(78));
  for (const [k, t, a, r] of rows.sort((x, y) => Math.abs(1 - y[3]) - Math.abs(1 - x[3]))) {
    console.log(k.padEnd(42), t.toFixed(3).padStart(8), a.toFixed(3).padStart(8), r.toFixed(4).padStart(8));
  }
}
