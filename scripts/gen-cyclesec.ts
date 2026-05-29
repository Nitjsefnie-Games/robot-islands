// Recompute recipe cycleSec from real area-normalized throughput.
// Run: npx tsx scripts/gen-cyclesec.ts [--write] [--category=extraction,smelting,...]
import { readFileSync, writeFileSync } from 'node:fs';
import { RECIPES, RESOURCE_META } from '../src/recipes.js';
import { BUILDING_DEFS } from '../src/building-defs.js';
import { M, densityForRecipe, buildingForRecipe } from '../src/recipe-density.js';

const args = process.argv.slice(2);
const write = args.includes('--write');
const catArg = args.find(a => a.startsWith('--category='));
const cats = catArg ? catArg.split('=')[1].split(',') : null;

function outputKg(recipe: { outputs?: Record<string, number> }): number {
  let kg = 0;
  for (const [r, n] of Object.entries(recipe.outputs ?? {})) {
    kg += n * (RESOURCE_META[r as keyof typeof RESOURCE_META]?.massPerUnitKg ?? 1);
  }
  return kg;
}

const rows: Array<[string, number, number, boolean]> = []; // id, old, new, emptyOutputs
for (const [id, recipe] of Object.entries(RECIPES) as [string, any][]) {
  if (!recipe) continue;
  if (cats && !cats.includes(recipe.category)) continue;
  const bId = buildingForRecipe(id);
  const def = BUILDING_DEFS[bId as keyof typeof BUILDING_DEFS] as any;
  if (!def) { console.error(`SKIP ${id}: no building ${bId}`); continue; }
  const fp = def.footprint.tiles.length;          // m² = tile count (see brief §LOCKED #2)
  const density = densityForRecipe(id);
  const kg = outputKg(recipe);
  const throughput = density * fp * M;             // kg/s at 1 floor / no skills
  const cyc = Math.max(1, Math.round((kg / throughput) * 10) / 10);
  rows.push([id, recipe.cycleSec, cyc, kg === 0]);
  if (!Number.isFinite(cyc)) console.error(`BAD ${id}: cycleSec=${cyc} (kg=${kg} fp=${fp} density=${density})`);
}
rows.sort((a, b) => a[2] - b[2]);
for (const [id, oldC, newC, empty] of rows) {
  console.log(`${id.padEnd(30)} ${String(oldC).padStart(7)} -> ${String(newC).padStart(9)} s${empty ? '   [EMPTY-OUTPUTS -> floored 1s]' : ''}`);
}
const emptyRows = rows.filter(r => r[3]);
console.error(`\n${rows.length} recipes computed${write ? ' (WRITING)' : ' (dry-run)'}; ${emptyRows.length} have empty outputs (floored to 1s): ${emptyRows.map(r => r[0]).join(', ') || '(none)'}`);

if (write) {
  let src = readFileSync('src/recipes.ts', 'utf8');
  for (const [id, , newC] of rows) {
    const re = new RegExp(`(\\n  ${id}: \\{[\\s\\S]*?cycleSec: )([\\d.]+)`);
    if (!re.test(src)) { console.error(`WARN: could not splice ${id}`); continue; }
    src = src.replace(re, `$1${newC}`);
  }
  writeFileSync('src/recipes.ts', src);
}
