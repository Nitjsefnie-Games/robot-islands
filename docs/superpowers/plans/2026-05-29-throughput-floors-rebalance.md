# cycleSec Rebalance + Floor-Upgrade System — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: superpowers:subagent-driven-development to execute task-by-task on `master`. Steps use checkbox (`- [ ]`). Each commit ends with the implementer's `Co-Authored-By` trailer (repo CLAUDE.md).

**Goal:** Recompute all 249 recipe `cycleSec` from real area-normalized throughput, and add a universal floor-upgrade mechanic so players scale per-tile throughput/power/capacity through play.

**Architecture:** A committed density module (`src/recipe-density.ts`) is the single source of truth; an offline generator (`scripts/gen-cyclesec.ts`, run via `npx vite-node`) computes `cycleSec = output_kg / (density × footprint_m² × M)` and rewrites the literals in `recipes.ts`. The floor mechanic adds `PlacedBuilding.floorLevel` (persisted, schema v16) and scales `baseRate ×(1+L)`, power-out `×(1+L)`, power-draw `×(1+0.5L)`, storage `×(1+L)`; upgrades cost `0.8×placementCost` and `baseConstructionMs×(L+1)`, cap 10 floors.

**Tech Stack:** TypeScript strict, vitest, vite-node (ships with vite). No new runtime deps.

**Spec:** `docs/superpowers/specs/2026-05-29-throughput-floors-rebalance-design.md`
**Density data (canonical):** `docs/superpowers/specs/2026-05-29-throughput-density-table.md` → encoded in `src/recipe-density.ts`.

**Conventions:** `M = 1.4535e-3`. Footprint m²: single=1, square2=4, rect2x3/rect3x2=6, square3=9, square4=16. `output_kg = Σ(output_units × RESOURCE_META[r].massPerUnitKg)`. Multi-output ⇒ total output mass. Round `cycleSec` to 1 decimal, floor at a 1s minimum.

**Test commands:** `npx vitest run <file>` · `npm test` · `npx tsc --noEmit` · `npm run build` · generator: `npx vite-node scripts/gen-cyclesec.ts`.

---

## PHASE 1 — Density module + generator + extraction & core-chain cycleSec

### Task 1.1 — `src/recipe-density.ts` (single source of truth)

**Files:** Create `src/recipe-density.ts`; Create `src/recipe-density.test.ts`.

- [ ] **Step 1: failing test** `src/recipe-density.test.ts`:
```ts
import { describe, expect, it } from 'vitest';
import { RECIPES } from './recipes.js';
import { BUILDING_DEFS } from './building-defs.js';
import { ARCHETYPE_DENSITY, BUILDING_ARCHETYPE, M, footprintM2, densityForRecipe } from './recipe-density.js';

describe('recipe-density coverage', () => {
  it('M is the mine-anchor constant', () => expect(M).toBeCloseTo(1.4535e-3, 7));
  it('every archetype density is positive', () => {
    for (const d of Object.values(ARCHETYPE_DENSITY)) expect(d).toBeGreaterThan(0);
  });
  it('every recipe resolves to a positive density', () => {
    for (const id of Object.keys(RECIPES)) {
      const d = densityForRecipe(id);
      expect(d, `recipe ${id} has no density`).toBeGreaterThan(0);
    }
  });
  it('footprintM2 maps known shapes', () => {
    expect(footprintM2('SHAPES.single')).toBe(1);
    expect(footprintM2('SHAPES.square2')).toBe(4);
    expect(footprintM2('SHAPES.square3')).toBe(9);
    expect(footprintM2('SHAPES.square4')).toBe(16);
  });
});
```

- [ ] **Step 2: run** `npx vitest run src/recipe-density.test.ts` → FAIL (module missing).

- [ ] **Step 3: implement** `src/recipe-density.ts`. Encode the companion table. (Densities kg·s⁻¹·m⁻².)
```ts
// Canonical source for the cycleSec rebalance. See
// docs/superpowers/specs/2026-05-29-throughput-density-table.md for provenance.
import type { BuildingDefId } from './building-defs.js';

/** Global pace multiplier: fixes a 1-floor Mine to 20 s — 1/(8.6 × 4 × 20). */
export const M = 1.4535e-3;

/** Areal throughput density (kg·s⁻¹·m⁻²) per archetype (real 24/7 nameplate). */
export const ARCHETYPE_DENSITY = {
  hard_rock_mining: 8.6, water_pump: 42, logging: 0.49, oil_gas_well: 0.40,
  surface_quarry: 4.3, deep_drill: 0.05, blast_furnace: 0.75, bof_steel: 2.1,
  eaf_steel: 1.3, nonferrous_smelter: 0.062, aluminum: 1.4e-4, cement_kiln: 0.19,
  lime_kiln: 0.036, brick_ceramic_kiln: 0.016, coke_oven: 0.008, glass_furnace: 0.0077,
  crude_refining: 2.8, air_separation: 3.9, electrolysis: 0.03, acids: 0.22,
  polymers: 0.48, rolling_mill: 0.5, machining: 0.002, assembly: 0.6,
  battery_cells: 0.0032, wafer_fab: 6.4e-5, pcb_fab: 7e-4,
  // fantasy / endgame (no real basis — tier-anchored, see spec §3 / table §03)
  fantasy_quantum_chip: 2e-5, fantasy_ai_core: 6e-6, fantasy_exotic_alloy: 0.02,
  fantasy_carbon_fiber: 0.05, fantasy_reality: 1e-3, fantasy_casimir: 4e-3,
  fantasy_t4: 1e-4, fantasy_t5: 1e-5, fantasy_t6: 1e-6, fantasy_satellite: 4e-3,
} as const;
export type Archetype = keyof typeof ARCHETYPE_DENSITY;

/** Each recipe-bearing building → its archetype. (From the companion building→archetype map.) */
export const BUILDING_ARCHETYPE: Partial<Record<BuildingDefId, Archetype>> = {
  // extraction
  mine: 'hard_rock_mining', deep_mine: 'hard_rock_mining',
  copper_mine: 'hard_rock_mining', tin_mine: 'hard_rock_mining', lead_mine: 'hard_rock_mining',
  bauxite_mine: 'hard_rock_mining', manganese_mine: 'hard_rock_mining', zinc_mine: 'hard_rock_mining',
  chromium_mine: 'hard_rock_mining', nickel_mine: 'hard_rock_mining', tungsten_mine: 'hard_rock_mining',
  sulfur_mine: 'hard_rock_mining', phosphate_mine: 'hard_rock_mining', graphite_mine: 'hard_rock_mining',
  quarry: 'surface_quarry', quartz_mine: 'surface_quarry', limestone_quarry: 'surface_quarry',
  sand_pit: 'surface_quarry', clay_pit_extractor: 'surface_quarry', diamond_quarry: 'surface_quarry',
  uranium_mine: 'deep_drill', mercury_well: 'deep_drill', lithium_extractor: 'deep_drill', drilling_rig: 'deep_drill',
  pump_jack: 'oil_gas_well', gas_extractor: 'oil_gas_well',
  well: 'water_pump', coastal_pump: 'water_pump', seawater_intake_rig: 'water_pump',
  open_water_extractor: 'water_pump', nodule_harvester: 'water_pump', trench_drill: 'water_pump', vent_tap: 'water_pump',
  logger: 'logging', heavy_logger: 'logging',
  // smelting
  smelter: 'blast_furnace', blast_furnace: 'blast_furnace',
  steel_mill: 'bof_steel', steel_mill_scrap: 'bof_steel', oxygen_converter: 'bof_steel',
  electric_arc_furnace: 'eaf_steel',
  copper_smelter: 'nonferrous_smelter', tin_smelter: 'nonferrous_smelter', lead_smelter: 'nonferrous_smelter',
  zinc_smelter: 'nonferrous_smelter', chromium_smelter: 'nonferrous_smelter', nickel_smelter: 'nonferrous_smelter',
  tungsten_smelter: 'nonferrous_smelter', manganese_smelter: 'nonferrous_smelter',
  silicon_crusher: 'nonferrous_smelter', slag_reprocessor: 'nonferrous_smelter', alumina_refinery: 'nonferrous_smelter',
  aluminum_smelter: 'aluminum', coke_oven: 'coke_oven', charcoal_kiln: 'coke_oven',
  // kilns
  limekiln: 'lime_kiln', lime_slaker: 'cement_kiln', cement_mill: 'cement_kiln',
  concrete_plant: 'cement_kiln', mortar_mixer: 'cement_kiln',
  brick_kiln: 'brick_ceramic_kiln', ceramic_kiln: 'brick_ceramic_kiln', optical_glass_kiln: 'brick_ceramic_kiln',
  glassworks: 'glass_furnace', glass_panel_press: 'glass_furnace',
  // chemistry
  electrolyzer: 'electrolysis', chlor_alkali_plant: 'electrolysis',
  sulfuric_acid_plant: 'acids', hcl_plant: 'acids', phosphor_plant: 'acids', chemical_reactor: 'acids',
  air_separator: 'air_separation', cryo_air_separator: 'air_separation', cryo_lab: 'air_separation',
  cryo_compressor: 'air_separation', cryogenic_generator: 'air_separation', cryo_compound_lab: 'air_separation',
  naphtha_cracker: 'crude_refining', crude_oil_cracker: 'crude_refining', diesel_refinery: 'crude_refining',
  kerosene_refinery: 'crude_refining', lubricant_refinery: 'crude_refining',
  plastic_polymerizer_a: 'polymers', rubber_synthesizer: 'polymers', coolant_synthesizer: 'polymers', biofuel_plant: 'polymers',
  rigid_plastic_press: 'polymers', flexible_plastic_press: 'polymers',
  evaporator: 'lime_kiln', brine_distillation_rig: 'air_separation', nodule_concentrator: 'acids',
  vent_mineral_refinery: 'acids', heavy_water_distiller: 'air_separation',
  // manufacturing
  workshop: 'machining', assembler: 'assembly', kit_assembler: 'assembly',
  kit_assembler_enriched: 'assembly', kit_assembler_refined: 'assembly',
  bearing_assembler: 'machining', spring_press: 'machining',
  solder_alloyer: 'nonferrous_smelter', bronze_alloyer: 'nonferrous_smelter', brass_alloyer: 'nonferrous_smelter',
  mag_alloyer: 'nonferrous_smelter', mag_forge: 'nonferrous_smelter',
  motor_assembly: 'assembly', pump_assembly: 'assembly', hydraulic_assembly: 'assembly', pneumatic_assembly: 'assembly',
  generator_lab: 'assembly', fuel_cell_lab: 'assembly', fuel_rod_assembler: 'assembly',
  plasma_containment_assembler: 'assembly', cryo_containment_assembler: 'assembly', self_replication_lab: 'assembly',
  sheet_metal_mill: 'rolling_mill', pipe_mill: 'rolling_mill', beam_mill: 'rolling_mill', cable_mill: 'rolling_mill',
  metal_rolling_mill: 'rolling_mill', galvanizing_bath: 'rolling_mill', carbon_steel_mill: 'rolling_mill',
  stainless_steel_mill: 'rolling_mill', tool_steel_mill: 'rolling_mill',
  plank_mill: 'machining', lumber_mill: 'machining', battery_factory: 'battery_cells',
  glass_fiber_spinner: 'glass_furnace', optical_fiber_drawer: 'rolling_mill',
  // electronics
  pcb_etcher: 'pcb_fab', lithography_lab: 'wafer_fab', wafer_lab: 'wafer_fab',
  processor_fab: 'wafer_fab', compute_module_fab: 'wafer_fab',
  transistor_doping: 'wafer_fab', capacitor_doping: 'wafer_fab', resistor_doping: 'wafer_fab',
  memory_lab: 'wafer_fab', circuit_assembler: 'assembly', solar_cell_lab: 'wafer_fab',
  singularity_sensor_lab: 'wafer_fab', accelerator_core_lab: 'assembly',
  // fantasy / endgame
  quantum_chip_fab: 'fantasy_quantum_chip', cryogenic_compute_center: 'fantasy_ai_core',
  pyroforge: 'fantasy_exotic_alloy', carbon_forge: 'fantasy_carbon_fiber',
  reality_forge: 'fantasy_reality', casimir_tap: 'fantasy_casimir',
  particle_accelerator: 'fantasy_t4', quantum_manipulator: 'fantasy_t4',
  // (extend during impl: any remaining recipe-bearing endgame/sat/skill-forge building → fantasy_t5/t6/satellite)
};

const FOOTPRINT_M2: Record<string, number> = {
  'SHAPES.single': 1, 'SHAPES.square2': 4, 'SHAPES.rect2x3': 6, 'SHAPES.rect3x2': 6,
  'SHAPES.square3': 9, 'SHAPES.square4': 16,
};
export function footprintM2(shape: string): number {
  const m = FOOTPRINT_M2[shape];
  if (m == null) throw new Error(`unknown footprint shape: ${shape}`);
  return m;
}

/** Recipe id → building id. Most recipe ids equal a building id; tile/scrap
 *  variants resolve to their base building. */
export function buildingForRecipe(recipeId: string): BuildingDefId {
  const variant: Record<string, string> = { mine_on_ore: 'mine', mine_on_coal: 'mine' };
  return (variant[recipeId] ?? recipeId) as BuildingDefId;
}

/** Recipe id → areal density. Throws if unmapped (the coverage test forbids that). */
export function densityForRecipe(recipeId: string): number {
  const b = buildingForRecipe(recipeId);
  const arch = BUILDING_ARCHETYPE[b];
  if (!arch) throw new Error(`no archetype for building ${b} (recipe ${recipeId})`);
  return ARCHETYPE_DENSITY[arch];
}
```

- [ ] **Step 4: run** `npx vitest run src/recipe-density.test.ts`. The "every recipe resolves" test will list any unmapped recipe-bearing building. **For each failure, add its `BUILDING_ARCHETYPE` entry** (use the companion building→archetype map; endgame/satellite/skill-forge → `fantasy_t5`/`fantasy_t6`/`fantasy_satellite`). Repeat until green. If a recipe id is neither a building id nor a known variant, extend `buildingForRecipe`.

- [ ] **Step 5: typecheck + commit**
Run `npx tsc --noEmit` (clean).
```bash
git add src/recipe-density.ts src/recipe-density.test.ts
git commit -m "feat(rebalance): recipe-density module (archetype densities + building map + M)"
```

### Task 1.2 — `scripts/gen-cyclesec.ts` generator (compute, dry-run)

**Files:** Create `scripts/gen-cyclesec.ts`.

- [ ] **Step 1: implement the generator** (compute-and-report first; writing is Step 3):
```ts
// Recompute recipe cycleSec from real area-normalized throughput.
// Run: npx vite-node scripts/gen-cyclesec.ts [--write] [--category=extraction,smelting,...]
import { readFileSync, writeFileSync } from 'node:fs';
import { RECIPES, RESOURCE_META } from '../src/recipes.js';
import { BUILDING_DEFS } from '../src/building-defs.js';
import { M, footprintM2, densityForRecipe, buildingForRecipe } from '../src/recipe-density.js';

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

const rows: Array<[string, number, number]> = []; // id, old, new
for (const [id, recipe] of Object.entries(RECIPES) as [string, any][]) {
  if (cats && !cats.includes(recipe.category)) continue;
  const bId = buildingForRecipe(id);
  const def = BUILDING_DEFS[bId as keyof typeof BUILDING_DEFS] as any;
  if (!def) { console.error(`SKIP ${id}: no building ${bId}`); continue; }
  const fp = footprintM2(String(def.footprint?.name ?? def.footprintShape ?? def.footprint)); // see Step 2 note
  const density = densityForRecipe(id);
  const kg = outputKg(recipe);
  const throughput = density * fp * M;          // kg/s at 1 floor / no skills
  const cyc = Math.max(1, Math.round((kg / throughput) * 10) / 10);
  rows.push([id, recipe.cycleSec, cyc]);
}
rows.sort((a, b) => a[2] - b[2]);
for (const [id, oldC, newC] of rows) console.log(`${id.padEnd(28)} ${String(oldC).padStart(7)} -> ${String(newC).padStart(9)} s`);
console.error(`\n${rows.length} recipes computed${write ? ' (writing)' : ' (dry-run)'}`);

if (write) {
  let src = readFileSync('src/recipes.ts', 'utf8');
  for (const [id, , newC] of rows) {
    // replace cycleSec within this recipe's block: `<id>: {` ... `cycleSec: <num>`
    const re = new RegExp(`(\\n  ${id}: \\{[\\s\\S]*?cycleSec: )([\\d.]+)`);
    if (!re.test(src)) { console.error(`WARN: could not splice ${id}`); continue; }
    src = src.replace(re, `$1${newC}`);
  }
  writeFileSync('src/recipes.ts', src);
}
```

- [ ] **Step 2: footprint accessor.** Confirm how `BUILDING_DEFS[x].footprint` identifies its shape (it references `SHAPES.square2` etc.). If `footprint` is the SHAPES object (not a string), add a reverse lookup in `recipe-density.ts`: `shapeNameOf(footprint)` comparing identity against the `SHAPES` map, and use that in the generator instead of `String(def.footprint)`. Implement whichever the code requires; the generator must derive m² for every building.

- [ ] **Step 3: dry-run** `npx vite-node scripts/gen-cyclesec.ts` → prints old→new for all 249, sorted. Sanity-check: water/ore fast (seconds), chips slow (days), no `NaN`/`Infinity`, no SKIP/WARN. If a building's footprint or density is missing it surfaces here — fix in `recipe-density.ts` (Task 1.1) and re-run.

- [ ] **Step 4: commit the generator** (no recipes.ts change yet):
```bash
git add scripts/gen-cyclesec.ts
git commit -m "feat(rebalance): gen-cyclesec generator (density × footprint × M -> cycleSec)"
```

### Task 1.3 — Normalize extraction + apply generator to extraction/smelting/core

**Files:** Modify `src/recipes.ts` (extraction outputs + cycleSec for the Phase-1 categories); fix affected `src/*.test.ts`.

- [ ] **Step 1: normalize extraction amounts.** In `src/recipes.ts`, set each extraction recipe's output to **1 unit per cycle** of its primary resource (kills `mine_on_coal` 9, `heavy_logger` 9, `deep_mine` 3 outliers). Keep `exogenousFlow`. The generator then sets the rate via `cycleSec`. Leave multi-resource extraction (none currently) untouched.

- [ ] **Step 2: write a throughput-sanity test** `src/cyclesec.test.ts`:
```ts
import { describe, expect, it } from 'vitest';
import { RECIPES, RESOURCE_META } from './recipes.js';
import { BUILDING_DEFS } from './building-defs.js';
import { M, footprintM2, densityForRecipe, buildingForRecipe } from './recipe-density.js';

function expectedCycleSec(id: string): number {
  const r = (RECIPES as any)[id];
  let kg = 0; for (const [res, n] of Object.entries(r.outputs ?? {})) kg += (n as number) * (RESOURCE_META[res as keyof typeof RESOURCE_META]?.massPerUnitKg ?? 1);
  const def = (BUILDING_DEFS as any)[buildingForRecipe(id)];
  const fp = footprintM2(/* shape accessor from Task 1.2 */);
  return Math.max(1, Math.round((kg / (densityForRecipe(id) * fp * M)) * 10) / 10);
}
describe('cycleSec matches the density formula (Phase 1 categories)', () => {
  for (const id of Object.keys(RECIPES)) {
    const cat = (RECIPES as any)[id].category;
    if (!['extraction', 'smelting'].includes(cat)) continue;
    it(`${id} cycleSec is generator-derived`, () => {
      expect((RECIPES as any)[id].cycleSec).toBe(expectedCycleSec(id));
    });
  }
});
```
Run it → FAIL (recipes still hold old values).

- [ ] **Step 3: run the generator for the Phase-1 categories with --write:**
```bash
npx vite-node scripts/gen-cyclesec.ts --write --category=extraction,smelting
```
Re-run `npx vitest run src/cyclesec.test.ts` → PASS.

- [ ] **Step 4: full suite, fix fixtures.** Run `npm test`. Many tests assert old `cycleSec`/rates for extraction/smelting recipes (e.g. `recipes.test.ts`, `economy.test.ts`, `balance.test.ts`). Update each broken expectation to the new generated value (read it from the generator dry-run output). **Never change economy logic to pass a test.** `npx tsc --noEmit` clean.

- [ ] **Step 5: commit**
```bash
git add src/recipes.ts src/cyclesec.test.ts src/*.test.ts
git commit -m "feat(rebalance): SI cycleSec for extraction + smelting; normalize extraction to 1/cycle"
```

---

## PHASE 2 — Remaining recipe cycleSec

### Task 2.1 — Apply generator to all remaining categories

**Files:** Modify `src/recipes.ts`; fix affected tests.

- [ ] **Step 1: extend the sanity test** in `src/cyclesec.test.ts` to cover ALL categories (remove the `['extraction','smelting']` filter so every recipe is asserted generator-derived). Run → FAIL for the not-yet-regenerated recipes.

- [ ] **Step 2: regenerate all:**
```bash
npx vite-node scripts/gen-cyclesec.ts --write
```
(Re-runs all 249 incl. already-done ones — idempotent.) Re-run `npx vitest run src/cyclesec.test.ts` → PASS for all categories.

- [ ] **Step 3: full suite, fix remaining fixtures.** `npm test`; update every remaining test asserting an old `cycleSec`/throughput (chemistry/manufacturing/electronics/power/fantasy). `npx tsc --noEmit` clean; `npm run build` ok.

- [ ] **Step 4: commit**
```bash
git add src/recipes.ts src/cyclesec.test.ts src/*.test.ts
git commit -m "feat(rebalance): SI cycleSec for all remaining recipe categories (249 total)"
```

### Task 2.2 — EROI + spread sanity (guard)

- [ ] **Step 1:** add a test asserting the now-physics-derived coal loop is sane: `mine_on_coal` cycleSec and `coal_gen` burn give an EROI in a documented band; and that no recipe is `< 1s` or absurdly large beyond the intended tail (assert the max non-fantasy cycleSec is within the spec's band). Adjust only via the density source/M if a value is wrong (regenerate), not by hand-editing a literal.
- [ ] **Step 2:** commit `test(rebalance): coal EROI + cycleSec spread guards`.

---

## PHASE 3 — Floor-upgrade system (universal)

### Task 3.1 — `PlacedBuilding.floorLevel` + persistence v15→v16

**Files:** Modify `src/buildings.ts` (add field) or `src/world.ts` (PlacedBuilding type — locate it); `src/persistence.ts` (schema bump + migration); tests.

- [ ] **Step 1: add the field.** On the `PlacedBuilding` interface add `readonly floorLevel?: number; // 0..9, default 0 (1..10 floors)`. Add a helper in `buildings.ts`: `export function floorLevel(b: { floorLevel?: number }): number { return Math.max(0, Math.min(9, b.floorLevel ?? 0)); }`.

- [ ] **Step 2: persistence migration (TDD).** In `src/persistence.ts`: bump `SCHEMA_VERSION = 16`; add `16` to `SUPPORTED_LOAD_VERSIONS`; add `SerializedSnapshotV15` alias capturing the pre-floor shape and `migrateV15toV16(s: SerializedSnapshotV15): SerializedSnapshotV16` that returns the snapshot unchanged except `v: 16` (floorLevel is optional ⇒ absent = 0, no per-building rewrite needed); wire it into `loadWorld`'s dispatch. Write tests: a v15 fixture loads into v16; v16 round-trips identity; a building with `floorLevel: 3` survives save→load. Run red→green.

- [ ] **Step 3:** `npx tsc --noEmit` clean; commit `feat(floors): PlacedBuilding.floorLevel + persistence v15->v16`.

### Task 3.2 — Economy: floor scales throughput + power

**Files:** Modify `src/economy.ts`; Test `src/economy.test.ts` (or `src/floors.test.ts`).

- [ ] **Step 1: failing test** (`src/floors.test.ts`): a building at `floorLevel: 3` produces at `(1+3)=4×` the L0 base rate; consumes power `×(1+0.5·3)=2.5×`; a generator at L3 produces power `×4`. Use the existing `makeState`/catalog helpers; assert `power.produced`, `power.consumed`, and the recipe rate.

- [ ] **Step 2: implement.** In `computeRates`, where `baseRate = (1/cycleSec) × …`, multiply by `(1 + floorLevel(b))`. Where the power balance sums `def.power.produces` / `def.power.consumes` per building, multiply produces by `(1 + L)` and consumes by `(1 + 0.5·L)`. Keep brownout/heat logic unchanged. Centralize the three multipliers as small helpers (`floorEffectMul(L)=1+L`, `floorPowerDrawMul(L)=1+0.5*L`).

- [ ] **Step 3:** run the floor test → PASS; `npm test` green (existing tests use L0 ⇒ ×1, unaffected); `tsc` clean. Commit `feat(floors): economy scales rate (×1+L) + power (out ×1+L, draw ×1+0.5L)`.

### Task 3.3 — Storage capacity scales with floors

**Files:** Modify wherever per-building storage capacity is aggregated (`world.ts`/`economy.ts` `aggregateStorageCaps` per the §4.6 logic); Test.

- [ ] **Step 1: failing test** — a Crate at `floorLevel: 2` contributes `(1+2)=3×` its base `storage.capacity`.
- [ ] **Step 2: implement** — multiply each building's contributed capacity by `(1 + floorLevel(b))`.
- [ ] **Step 3:** green; commit `feat(floors): storage capacity ×(1+L)`.

### Task 3.4 — Upgrade action: cost, progressive build time, cap

**Files:** Modify `src/buildings.ts`/placement + `src/economy.ts` construction; Test.

- [ ] **Step 1: failing tests** — `upgradeCost(def, L)` returns each entry of `placementCost × 0.8` (for the L-th upgrade); `upgradeConstructionMs(def, L)` returns `BASE_CONSTRUCTION_MS_BY_TIER[def.tier] × (L+1)`; upgrading is rejected at `floorLevel === 9` (cap 10 floors).
- [ ] **Step 2: implement** pure helpers `upgradeCost`, `upgradeConstructionMs`, and `applyUpgrade(world, buildingId)` that: checks `L < 9`, checks/deducts `upgradeCost` from inventory, increments `floorLevel`, sets `constructionRemainingMs = upgradeConstructionMs(def, newL)`. The building keeps operating at its old floor level until construction completes (gate the rate multiplier on the *completed* level — store `pendingFloorLevel` or apply the new level only when `constructionRemainingMs` hits 0; pick the simplest: apply new level immediately but treat the building as under-construction until the timer elapses, so it's paused during the upgrade — match the existing new-build behavior).
- [ ] **Step 3:** green; commit `feat(floors): upgrade action — 0.8x cost, build time x(L+1), cap 10`.

### Task 3.5 — UI: per-building floor-upgrade control

**Files:** Modify `src/inspector-ui.ts` (per-building panel) — follow the existing action-button pattern.

- [ ] **Step 1:** in the building inspector panel, add a "Build floor (L→L+1)" control showing the next-floor effect (×(1+L+1)), the `upgradeCost`, and the build time; disabled at L9 or insufficient resources; on click calls `applyUpgrade`. Show current `floorLevel` / 10.
- [ ] **Step 2:** `tsc` clean; `npm run build`; commit `feat(floors): inspector floor-upgrade control`.

### Task 3.6 — Green gate + browser verify

- [ ] **Step 1:** `npm test` green, `tsc` clean, `npm run build` ok.
- [ ] **Step 2:** build + reload `https://islands.nitjsefni.eu/`; screenshot: upgrade a building, confirm floor count, throughput/power scale, cost/time applied, persists across reload.
- [ ] **Step 3:** commit any fixups `test(floors): suite green; floor system verified in-browser`.

---

## Out of scope / follow-ups
- M re-tune is a one-line change in `recipe-density.ts` + regenerate.
- Fantasy densities are abstracted — revisit endgame feel after playtest.
- Skill `recipeRateMul` already stacks multiplicatively with floors (no change needed); verify the ×10 all-skills figure holds in `skilltree.test.ts`.
- Tutorial chain (paused) cites recipe stoichiometry (unaffected) but pacing hints may shift — reconcile on tutorial resume.
- Genesis Chamber dynamic-draw + the energy-pass minor follow-ups remain separately tracked.
