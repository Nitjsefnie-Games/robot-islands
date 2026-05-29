// Recompute recipe cycleSec from real area-normalized throughput.
// Run: npx tsx scripts/gen-cyclesec.ts [--write] [--category=extraction,smelting,...]
import { readFileSync, writeFileSync } from 'node:fs';
import { RECIPES } from '../src/recipes.js';
import { BUILDING_DEFS } from '../src/building-defs.js';
import { M, densityForRecipe, buildingForRecipe, outputKg, shouldDeriveCycleSec } from '../src/recipe-density.js';

const args = process.argv.slice(2);
const write = args.includes('--write');
const catArg = args.find(a => a.startsWith('--category='));
const cats = catArg ? catArg.split('=')[1].split(',') : null;

const derivedRows: Array<[string, number, number]> = []; // id, old, new
const excludedRows: Array<[string, number]> = [];        // id, kept

for (const [id, recipe] of Object.entries(RECIPES) as [string, any][]) {
  if (!recipe) continue;
  if (cats && !cats.includes(recipe.category)) continue;
  const bId = buildingForRecipe(id);
  const def = BUILDING_DEFS[bId as keyof typeof BUILDING_DEFS] as any;
  if (!def) { console.error(`SKIP ${id}: no building ${bId}`); continue; }
  const derive = shouldDeriveCycleSec(recipe);
  if (!derive) {
    excludedRows.push([id, recipe.cycleSec]);
    continue;
  }
  const fp = def.footprint.tiles.length;          // m² = tile count (see brief §LOCKED #2)
  const density = densityForRecipe(id);
  const kg = outputKg(recipe);
  const throughput = density * fp * M;             // kg/s at 1 floor / no skills
  const cyc = Math.max(1, Math.round((kg / throughput) * 10) / 10);
  derivedRows.push([id, recipe.cycleSec, cyc]);
  if (!Number.isFinite(cyc)) console.error(`BAD ${id}: cycleSec=${cyc} (kg=${kg} fp=${fp} density=${density})`);
}

derivedRows.sort((a, b) => a[2] - b[2]);

for (const [id, oldC, newC] of derivedRows) {
  console.log(`${id.padEnd(30)} ${String(oldC).padStart(7)} -> ${String(newC).padStart(9)} s`);
}

if (excludedRows.length > 0) {
  console.log(`\n--- EXCLUDED (power / no material output) ---`);
  for (const [id, kept] of excludedRows) {
    console.log(`${id.padEnd(30)} kept ${String(kept).padStart(7)} s   [EXCLUDED: power/no-output — kept ${kept}s]`);
  }
}

console.error(`\n${derivedRows.length} derived, ${excludedRows.length} excluded (power/no-output): ${excludedRows.map(r => r[0]).join(', ') || '(none)'}`);

if (write) {
  let src = readFileSync('src/recipes.ts', 'utf8');
  for (const [id, , newC] of derivedRows) {
    const re = new RegExp(`(\\n  ${id}: \\{[\\s\\S]*?cycleSec: )([\\d.]+)`);
    if (!re.test(src)) { console.error(`WARN: could not splice ${id}`); continue; }
    src = src.replace(re, `$1${newC}`);
  }
  writeFileSync('src/recipes.ts', src);
}
