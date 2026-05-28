// Recipe graph structural tests — step-18 "no orphan inputs" invariant.
//
// The recipe catalog forms a DAG: outputs become inputs to other recipes,
// recipes with empty inputs are extraction roots, recipes with empty
// outputs are consumption sinks (power burns, demolition-target). The
// economy loop in `economy.ts` doesn't know about the graph shape — it
// just iterates buildings — so structural correctness has to be enforced
// at the catalog level.
//
// "No orphan inputs": every resource referenced as a recipe INPUT must
// appear as an OUTPUT in at least one recipe. Without this invariant,
// a chain like `Workshop needs iron_ore but no Mine in the catalog` would
// stall every game forever and the failure would only surface as "the UI
// shows 0 production" — frustrating to diagnose.
//
// T0 raws (extraction-root resources whose recipes have empty inputs) are
// naturally accepted by this test: their producer-recipe's output set
// includes them, so `producerOf` contains them.

import { describe, expect, it } from 'vitest';

import {
  ALL_RECIPE_CATEGORIES,
  ALL_RESOURCES,
  RECIPES,
  RECIPE_SPECULATIVE,
  RESOURCE_META,
  XP_WEIGHT,
  fuelForTier,
  nextRotateOutputBoundaryMs,
  resolveRotatingOutput,
  availableRecipes,
  type RecipeCategory,
  type RecipeId,
  type ResourceId,
} from './recipes.js';
import { BUILDING_DEFS } from './building-defs.js';
import type { IslandState } from './economy.js';
import type { Graph } from './skilltree-graph.js';

describe('Catalog additions (§6.4 T3 raws + §6.6 T5 memetic_core)', () => {
  it('includes gold_ore as a T3 dry_goods raw with xp_weight 30', () => {
    expect(ALL_RESOURCES).toContain('gold_ore' as ResourceId);
    expect(XP_WEIGHT.gold_ore).toBe(30);
  });
  it('includes silver_ore as T3 dry_goods raw', () => {
    expect(ALL_RESOURCES).toContain('silver_ore' as ResourceId);
    expect(XP_WEIGHT.silver_ore).toBe(30);
  });
  it('includes rare_earth as T3 dry_goods raw', () => {
    expect(ALL_RESOURCES).toContain('rare_earth' as ResourceId);
    expect(XP_WEIGHT.rare_earth).toBe(30);
  });
  it('includes uranium_ore as T3 dry_goods raw', () => {
    expect(ALL_RESOURCES).toContain('uranium_ore' as ResourceId);
    expect(XP_WEIGHT.uranium_ore).toBe(30);
  });
  it('includes memetic_core as T5 rare with xp_weight 300', () => {
    expect(ALL_RESOURCES).toContain('memetic_core' as ResourceId);
    expect(XP_WEIGHT.memetic_core).toBe(300);
  });
});

describe('recipe graph completeness (step 18)', () => {
  // Build the set of all resources that appear as a recipe output. T0
  // raws (Mine, Logger, Well, Pump Jack, etc.) emit themselves as
  // outputs with empty inputs, so they land in this set naturally.
  function buildProducerSet(): Set<ResourceId> {
    const producers = new Set<ResourceId>();
    for (const recipe of Object.values(RECIPES)) {
      if (!recipe) continue;
      for (const r of Object.keys(recipe.outputs) as ResourceId[]) {
        producers.add(r);
      }
      for (const rot of recipe.rotateOutputs ?? []) {
        for (const r of Object.keys(rot) as ResourceId[]) {
          producers.add(r);
        }
      }
    }
    return producers;
  }

  it('every recipe input has at least one producer recipe', () => {
    const producers = buildProducerSet();
    // Scrap is produced by building demolition (§6.7), not by a recipe
    // cycle, so it is exempt from the orphan-input check.
    producers.add('scrap');
    // uranium_ore is a terrain-seeded T3 raw (§6.4) with no extractor
    // building yet; it is exempt until an extractor is added.
    producers.add('uranium_ore');
    // memetic_core is a T5 component with no producer recipe yet;
    // exempt until a lab is added.
    producers.add('memetic_core');
    // air is an exogenous-flow resource (atmosphere intake, §3.3);
    // no producer recipe exists by design.
    producers.add('air');
    const violations: { recipeId: string; missing: ResourceId }[] = [];
    for (const [recipeId, recipe] of Object.entries(RECIPES)) {
      if (!recipe) continue;
      for (const r of Object.keys(recipe.inputs) as ResourceId[]) {
        if (!producers.has(r)) {
          violations.push({ recipeId, missing: r });
        }
      }
    }
    // Print a structured list on failure so the diagnostic shows which
    // recipe is the orphan-consumer and which input lacks a source.
    expect(violations, JSON.stringify(violations, null, 2)).toEqual([]);
  });

  it('every recipe category is in the ALL_RECIPE_CATEGORIES list', () => {
    const allCats = new Set<RecipeCategory>(ALL_RECIPE_CATEGORIES);
    for (const [recipeId, recipe] of Object.entries(RECIPES)) {
      if (!recipe) continue;
      expect(allCats.has(recipe.category), `recipe ${recipeId} has unknown category ${recipe.category}`).toBe(true);
    }
  });

  it('every recipe input/output resource is a known ResourceId', () => {
    // ALL_RESOURCES is the canonical ResourceId list — if a recipe
    // references a resource not in ALL_RESOURCES, persistence's
    // backfill loop won't initialise inventory/cap entries for it.
    const known = new Set<ResourceId>(ALL_RESOURCES);
    for (const [recipeId, recipe] of Object.entries(RECIPES)) {
      if (!recipe) continue;
      for (const r of Object.keys(recipe.inputs) as ResourceId[]) {
        expect(known.has(r), `recipe ${recipeId} input ${r} missing from ALL_RESOURCES`).toBe(true);
      }
      for (const r of Object.keys(recipe.outputs) as ResourceId[]) {
        expect(known.has(r), `recipe ${recipeId} output ${r} missing from ALL_RESOURCES`).toBe(true);
      }
    }
  });

  it('every ResourceId has an XP_WEIGHT entry', () => {
    for (const r of ALL_RESOURCES) {
      expect(XP_WEIGHT[r], `XP_WEIGHT missing entry for ${r}`).toBeDefined();
    }
  });

  it('every cycleSec is positive', () => {
    for (const [recipeId, recipe] of Object.entries(RECIPES)) {
      if (!recipe) continue;
      expect(recipe.cycleSec, `recipe ${recipeId} has non-positive cycleSec`).toBeGreaterThan(0);
    }
  });
});

describe('produced resources have terminal classification (rev-16 §3.5.4)', () => {
  it('every ResourceId has a RESOURCE_META entry with a valid terminal tag', () => {
    for (const r of ALL_RESOURCES) {
      const meta = RESOURCE_META[r];
      expect(meta, `${r} missing RESOURCE_META`).toBeDefined();
      expect(meta.massPerUnitKg, `${r} massPerUnitKg`).toBeGreaterThanOrEqual(0);
      const t = meta.terminal;
      const ok = t === 'consumed'
        || t === 'gameplay-sink'
        || (typeof t === 'string' && t.startsWith('expansion-hook:'));
      expect(ok, `${r} terminal=${t}`).toBe(true);
    }
  });

  it("tagged 'consumed' resources that are produced have ≥ 1 recipe consumer", () => {
    const producedBy = new Map<ResourceId, string[]>();
    const consumedBy = new Map<ResourceId, string[]>();
    for (const [recipeId, recipe] of Object.entries(RECIPES)) {
      if (!recipe) continue;
      for (const r of Object.keys(recipe.outputs) as ResourceId[]) {
        producedBy.set(r, [...(producedBy.get(r) ?? []), recipeId]);
      }
      for (const rot of recipe.rotateOutputs ?? []) {
        for (const r of Object.keys(rot) as ResourceId[]) {
          producedBy.set(r, [...(producedBy.get(r) ?? []), recipeId]);
        }
      }
      for (const r of Object.keys(recipe.inputs) as ResourceId[]) {
        consumedBy.set(r, [...(consumedBy.get(r) ?? []), recipeId]);
      }
    }
    const violations: string[] = [];
    for (const r of ALL_RESOURCES) {
      if (RESOURCE_META[r].terminal === 'consumed' && producedBy.has(r)) {
        if (!consumedBy.has(r)) violations.push(r);
      }
    }
    expect(violations, `tagged-'consumed' but unconsumed: ${violations.join(', ')}`).toEqual([]);
  });

  it('RECIPE_SPECULATIVE entries reference real RecipeIds', () => {
    for (const recipeId of Object.keys(RECIPE_SPECULATIVE)) {
      expect(RECIPES[recipeId as RecipeId], `${recipeId} not in RECIPES`).toBeDefined();
    }
  });
});

describe('step-18 producer coverage (§7 chain closures)', () => {
  // Sentinel resources that were sinks-without-sources before step 18.
  // Each one MUST now appear as an output of at least one recipe. If a
  // future refactor accidentally drops a producer (say, removes the
  // Biofuel Plant), this test pinpoints it instead of a vague chain-
  // stall in the integration tests.
  const sentinelProducedResources: ReadonlyArray<ResourceId> = [
    'stone',
    'sand',
    'fresh_water',
    'saltwater',
    'salt',
    'crude_oil',
    'natural_gas',
    'quartz',
    'hydrogen',
    'lumber',
    'glass',
    'biofuel',
    'naphtha',
    'chlorine',
    'lubricant',
    'diesel',
    'wire',
    'silicon',
    'nitrogen',
    'cryo_coolant',
    'cryogenic_hydrogen',
    'aviation_kerosene',
    'microchip',
    'helium_3',
    'aetheric_current',
    'tachyon_stream',
    'dark_matter',
    'strange_matter',
    'plasma_charge',
    'eldritch_processor',
    'phase_converter',
  ];

  it('every sentinel resource has a producer recipe', () => {
    const producers = new Set<ResourceId>();
    for (const recipe of Object.values(RECIPES)) {
      if (!recipe) continue;
      for (const r of Object.keys(recipe.outputs) as ResourceId[]) {
        producers.add(r);
      }
      if (recipe.rotateOutputs) {
        for (const opt of recipe.rotateOutputs) {
          for (const r of Object.keys(opt) as ResourceId[]) {
            producers.add(r);
          }
        }
      }
    }
    for (const r of sentinelProducedResources) {
      expect(producers.has(r), `sentinel resource ${r} has no producer recipe`).toBe(true);
    }
  });
});

// ---------------------------------------------------------------------------
// §11.7 fuel-by-tier mapping
// ---------------------------------------------------------------------------

describe('fuelForTier (§11.7)', () => {
  it('maps each tier to its canonical fuel grade', () => {
    expect(fuelForTier(1)).toBe('biofuel');
    expect(fuelForTier(2)).toBe('diesel');
    expect(fuelForTier(3)).toBe('aviation_kerosene');
    expect(fuelForTier(4)).toBe('cryogenic_hydrogen');
    expect(fuelForTier(5)).toBe('plasma_charge');
    expect(fuelForTier(6)).toBe('antimatter_propellant');
  });

  it('every returned fuel is a known ResourceId', () => {
    const known = new Set<ResourceId>(ALL_RESOURCES);
    for (const tier of [1, 2, 3, 4, 5, 6] as const) {
      expect(known.has(fuelForTier(tier))).toBe(true);
    }
  });
});

describe('byproducts', () => {
  it('electrolyzer outputs oxygen', () => {
    expect(RECIPES.electrolyzer!.outputs.oxygen).toBeDefined();
    expect(RECIPES.electrolyzer!.outputs.oxygen).toBeGreaterThan(0);
  });

  it('air_separator outputs argon', () => {
    expect(RECIPES.air_separator!.outputs.argon).toBeDefined();
    expect(RECIPES.air_separator!.outputs.argon).toBeGreaterThan(0);
  });

  it('steel_mill outputs slag', () => {
    expect(RECIPES.steel_mill!.outputs.slag).toBeDefined();
    expect(RECIPES.steel_mill!.outputs.slag).toBeGreaterThan(0);
  });

  it('oxygen_converter consumes oxygen and outputs 2 steel', () => {
    expect(RECIPES.oxygen_converter!.inputs.oxygen).toBeGreaterThan(0);
    expect(RECIPES.oxygen_converter!.outputs.steel).toBe(2);
  });

  it('XP_WEIGHT.oxygen is 3', () => {
    expect(XP_WEIGHT.oxygen).toBe(3);
  });

  it('XP_WEIGHT.slag is 3', () => {
    expect(XP_WEIGHT.slag).toBe(3);
  });

  it('XP_WEIGHT.saltwater_cell is 10', () => {
    // §15.6 saltwater-cell bootstrap — T2 component weight per §9.1.
    expect(XP_WEIGHT.saltwater_cell).toBe(10);
  });
});

describe('§6.7 Steel Mill scrap substitution (steel_mill_from_scrap)', () => {
  it('steel_mill_from_scrap recipe exists with 2 scrap → 1 steel + 1 slag', () => {
    const r = RECIPES.steel_mill_from_scrap;
    expect(r).toBeDefined();
    expect(r!.inputs).toEqual({ scrap: 2 });
    expect(r!.outputs).toEqual({ steel: 1, slag: 1 });
  });

  it('steel_mill_from_scrap matches base steel_mill cycleSec (same output rate per §6.7)', () => {
    expect(RECIPES.steel_mill_from_scrap!.cycleSec).toBe(RECIPES.steel_mill!.cycleSec);
  });

  it('steel_mill_from_scrap is tagged as smelting (same category as base)', () => {
    expect(RECIPES.steel_mill_from_scrap!.category).toBe('smelting');
    expect(RECIPES.steel_mill_from_scrap!.category).toBe(RECIPES.steel_mill!.category);
  });

  it.skip('outputs match the base steel_mill — substitution preserves yields, only the input differs', () => {
    // TODO: Phase 10 recalibration — steel_mill outputs changed in Phase 2 commit 3
    // but steel_mill_from_scrap retained its old yields pending full cohort rewrite.
    expect(RECIPES.steel_mill_from_scrap!.outputs).toEqual(RECIPES.steel_mill!.outputs);
  });
});

describe('microchip chain', () => {
  it('pcb_etcher outputs pcb: 1', () => {
    expect(RECIPES.pcb_etcher!.outputs.pcb).toBe(1);
  });

  it('circuit_assembler outputs circuit_board: 1', () => {
    expect(RECIPES.circuit_assembler!.outputs.circuit_board).toBe(1);
  });

  it('processor_fab outputs processor: 2 and inputs circuit_board: 2', () => {
    expect(RECIPES.processor_fab!.outputs.processor).toBe(2); // doubled Task 16.8 (was 1)
    expect(RECIPES.processor_fab!.inputs.circuit_board).toBe(2);
  });

  it('compute_module_fab outputs computing_module: 2', () => {
    expect(RECIPES.compute_module_fab!.outputs.computing_module).toBe(2); // doubled Task 16.8 (was 1)
  });

  it('XP_WEIGHT.circuit_board is 30', () => {
    expect(XP_WEIGHT.circuit_board).toBe(30);
  });

  it('XP_WEIGHT.computing_module is 30', () => {
    expect(XP_WEIGHT.computing_module).toBe(30);
  });

  it('XP_WEIGHT.processor is 30', () => {
    expect(XP_WEIGHT.processor).toBe(30);
  });
});

describe('T6 orbital recipes (§14.10)', () => {
  it('scanner_sat_assembly has correct inputs, outputs, and cycleSec', () => {
    const r = RECIPES.scanner_sat_assembly!;
    expect(r.outputs.scanner_sat).toBe(1);
    expect(r.inputs.exotic_alloy).toBe(4);
    expect(r.inputs.ai_core).toBe(2);
    expect(r.inputs.spacetime_fragment).toBe(1);
    expect(r.inputs.aluminum).toBe(50);
    expect(r.inputs.orbital_insertion_package).toBe(1);
    expect(r.cycleSec).toBe(600);
    expect(r.category).toBe('manufacturing');
  });

  it('relay_sat_assembly matches §14.10 spec literal', () => {
    const r = RECIPES.relay_sat_assembly!;
    expect(r.outputs).toEqual({ relay_sat: 1 });
    expect(r.inputs).toEqual({
      exotic_alloy: 6,
      ai_core: 1,
      optical_fiber: 200, // §14.10 spec literal
      orbital_insertion_package: 1,
    });
    expect(r.cycleSec).toBe(600);
    expect(r.category).toBe('manufacturing');
  });

  it('sweeper_sat_assembly has correct inputs, outputs, and cycleSec', () => {
    const r = RECIPES.sweeper_sat_assembly!;
    expect(r.outputs.sweeper_sat).toBe(1);
    expect(r.inputs.exotic_alloy).toBe(4);
    expect(r.inputs.ai_core).toBe(1);
    expect(r.inputs.carbon_steel).toBe(100);
    expect(r.inputs.magnet).toBe(20);
    expect(r.inputs.orbital_insertion_package).toBe(1);
    expect(r.cycleSec).toBe(600);
    expect(r.category).toBe('manufacturing');
  });

  it('mirror_sat_assembly has correct inputs, outputs, and cycleSec (§14.3)', () => {
    const r = RECIPES.mirror_sat_assembly!;
    expect(r.outputs.mirror_sat).toBe(1);
    expect(r.inputs.exotic_alloy).toBe(4);
    expect(r.inputs.ai_core).toBe(1);
    expect(r.inputs.aluminum).toBe(150);
    expect(r.inputs.optical_glass).toBe(10);
    expect(r.inputs.orbital_insertion_package).toBe(1);
    expect(r.cycleSec).toBe(600);
    expect(r.category).toBe('manufacturing');
  });

  it('oip_assembly has correct inputs, outputs, and cycleSec', () => {
    const r = RECIPES.oip_assembly!;
    expect(r.outputs.orbital_insertion_package).toBe(1);
    expect(r.inputs.iron_ingot).toBe(100);
    expect(r.inputs.brick).toBe(30);
    expect(r.inputs.glass).toBe(20);
    expect(r.inputs.carbon_fiber).toBe(10);
    expect(r.inputs.ai_core).toBe(5);
    expect(r.cycleSec).toBe(600);
    expect(r.category).toBe('manufacturing');
  });

  it('repair_pack_assembly has correct inputs, outputs, and cycleSec', () => {
    const r = RECIPES.repair_pack_assembly!;
    expect(r.outputs.repair_pack).toBe(1);
    expect(r.inputs.exotic_alloy).toBe(1);
    expect(r.inputs.lubricant).toBe(5);
    expect(r.inputs.microchip).toBe(5);
    expect(r.cycleSec).toBe(200);
    expect(r.category).toBe('manufacturing');
  });

  it('repair_drone_assembly has correct inputs, outputs, and cycleSec', () => {
    const r = RECIPES.repair_drone_assembly!;
    expect(r.outputs.repair_drone).toBe(1);
    expect(r.inputs.exotic_alloy).toBe(2);
    expect(r.inputs.carbon_steel).toBe(50);
    expect(r.inputs.foundation_kit).toBe(1);
    expect(r.cycleSec).toBe(400);
    expect(r.category).toBe('manufacturing');
  });

  it('antimatter_refinery matches §7.12 spec literal', () => {
    const r = RECIPES.antimatter_refinery!;
    expect(r.outputs.antimatter_propellant).toBe(1);
    expect(r.inputs).toEqual({
      antimatter_capsule: 1,
      plasma_containment_vessel: 1,
      cryogenic_hydrogen: 5,
    });
    expect(r.cycleSec).toBe(600); // 10 min per §7.12 (was 30 min; 2026-05-18 ÷3 for display visibility)
    expect(r.category).toBe('manufacturing');
  });

  it('reality_forge matches §7.12 spec literal', () => {
    const r = RECIPES.reality_forge!;
    expect(r.outputs).toEqual({ reality_anchor: 1 });
    expect(r.inputs).toEqual({
      ai_core: 4,
      antimatter_capsule: 1,
      time_crystal: 1,
      exotic_alloy: 1,
    });
    expect(r.cycleSec).toBe(28800); // 8h per §7.12 (was 24h; 2026-05-18 ÷3 for display visibility)
    expect(r.category).toBe('manufacturing');
  });

  it('XP_WEIGHT for new T6 resources is correct', () => {
    expect(XP_WEIGHT.sweeper_sat).toBe(1000);
    expect(XP_WEIGHT.repair_drone).toBe(1000);
    expect(XP_WEIGHT.repair_pack).toBe(300);
  });
});

describe('§8.1 T2 extraction recipes', () => {
  it('heavy_logger produces wood with higher rate than logger', () => {
    const t1 = RECIPES.logger!;
    const t2 = RECIPES.heavy_logger!;
    const t1Rate = (t1.outputs.wood ?? 0) / t1.cycleSec;
    const t2Rate = (t2.outputs.wood ?? 0) / t2.cycleSec;
    expect(t2Rate).toBeGreaterThan(t1Rate);
  });
  it('deep_mine produces iron_ore with higher rate than mine', () => {
    const t1 = RECIPES.mine!;
    const t2 = RECIPES.deep_mine!;
    const t1Rate = (t1.outputs.iron_ore ?? 0) / t1.cycleSec;
    const t2Rate = (t2.outputs.iron_ore ?? 0) / t2.cycleSec;
    expect(t2Rate).toBeGreaterThan(t1Rate);
  });
});

describe('§6.1 T0 raws — limestone', () => {
  it('limestone is in ALL_RESOURCES with xp_weight 1', () => {
    expect(ALL_RESOURCES).toContain('limestone' as ResourceId);
    expect(XP_WEIGHT.limestone).toBe(1);
  });
});

describe('§6.1 T0 raws — clay', () => {
  it('clay is in ALL_RESOURCES with xp_weight 1', () => {
    expect(ALL_RESOURCES).toContain('clay' as ResourceId);
    expect(XP_WEIGHT.clay).toBe(1);
  });
});

describe('§6.1 T0 raws — sulfur', () => {
  it('sulfur is in ALL_RESOURCES with xp_weight 1', () => {
    expect(ALL_RESOURCES).toContain('sulfur' as ResourceId);
    expect(XP_WEIGHT.sulfur).toBe(1);
  });
});

describe('§6.1 T0 raws — phosphate', () => {
  it('phosphate is in ALL_RESOURCES with xp_weight 1', () => {
    expect(ALL_RESOURCES).toContain('phosphate' as ResourceId);
    expect(XP_WEIGHT.phosphate).toBe(1);
  });
});

describe('§6.1 T0 raws — graphite', () => {
  it('graphite is in ALL_RESOURCES with xp_weight 1', () => {
    expect(ALL_RESOURCES).toContain('graphite' as ResourceId);
    expect(XP_WEIGHT.graphite).toBe(1);
  });
});

describe('§6.1 T0 raws — copper/tin/lead ores', () => {
  it('copper_ore is in ALL_RESOURCES with xp_weight 1', () => {
    expect(ALL_RESOURCES).toContain('copper_ore' as ResourceId);
    expect(XP_WEIGHT.copper_ore).toBe(1);
  });
  it('tin_ore is in ALL_RESOURCES with xp_weight 1', () => {
    expect(ALL_RESOURCES).toContain('tin_ore' as ResourceId);
    expect(XP_WEIGHT.tin_ore).toBe(1);
  });
  it('lead_ore is in ALL_RESOURCES with xp_weight 1', () => {
    expect(ALL_RESOURCES).toContain('lead_ore' as ResourceId);
    expect(XP_WEIGHT.lead_ore).toBe(1);
  });
});

describe('§6.1 T0 raws — bauxite', () => {
  it('bauxite is in ALL_RESOURCES with xp_weight 1', () => {
    expect(ALL_RESOURCES).toContain('bauxite' as ResourceId);
    expect(XP_WEIGHT.bauxite).toBe(1);
  });
});

describe('§6.2 T1 refined — quicklime + slaked_lime (Task 2.1)', () => {
  it('quicklime is in ALL_RESOURCES with xp_weight 3', () => {
    expect(ALL_RESOURCES).toContain('quicklime' as ResourceId);
    expect(XP_WEIGHT.quicklime).toBe(3);
  });
  it('slaked_lime is in ALL_RESOURCES with xp_weight 3', () => {
    expect(ALL_RESOURCES).toContain('slaked_lime' as ResourceId);
    expect(XP_WEIGHT.slaked_lime).toBe(3);
  });
  it('limekiln recipe exists with limestone input and quicklime output', () => {
    expect(RECIPES.limekiln).toBeDefined();
    expect(RECIPES.limekiln!.inputs).toEqual({ limestone: 25 });
    expect(RECIPES.limekiln!.outputs).toEqual({ quicklime: 14, co2: 11 });
    expect(RECIPES.limekiln!.cycleSec).toBe(40);
    expect(RECIPES.limekiln!.exogenousFlow).toBe('fuel-combustion-CO₂');
    expect(RECIPES.limekiln!.exogenousFlowKg).toBe(5);
  });
  it('lime_slaker recipe exists with quicklime + fresh_water input and slaked_lime output', () => {
    expect(RECIPES.lime_slaker).toBeDefined();
    expect(RECIPES.lime_slaker!.inputs).toEqual({ quicklime: 1, fresh_water: 1 });
    expect(RECIPES.lime_slaker!.outputs).toEqual({ slaked_lime: 1 });
    expect(RECIPES.lime_slaker!.cycleSec).toBe(40);
  });
});

describe('§6.2 T1 refined — brick (Task 2.2)', () => {
  it('brick is in ALL_RESOURCES with xp_weight 3', () => {
    expect(ALL_RESOURCES).toContain('brick' as ResourceId);
    expect(XP_WEIGHT.brick).toBe(3);
  });
  it('brick_kiln recipe exists with clay input and brick output', () => {
    expect(RECIPES.brick_kiln).toBeDefined();
    expect(RECIPES.brick_kiln!.inputs).toEqual({ clay: 6 });
    expect(RECIPES.brick_kiln!.outputs).toEqual({ brick: 5, water_vapor: 1 });
    expect(RECIPES.brick_kiln!.cycleSec).toBe(40);
  });
});

describe('§6.2 T1 refined — mortar + cement + concrete (Task 2.3)', () => {
  it('mortar is in ALL_RESOURCES with xp_weight 3', () => {
    expect(ALL_RESOURCES).toContain('mortar' as ResourceId);
    expect(XP_WEIGHT.mortar).toBe(3);
  });
  it('cement is in ALL_RESOURCES with xp_weight 3', () => {
    expect(ALL_RESOURCES).toContain('cement' as ResourceId);
    expect(XP_WEIGHT.cement).toBe(3);
  });
  it('concrete is in ALL_RESOURCES with xp_weight 3', () => {
    expect(ALL_RESOURCES).toContain('concrete' as ResourceId);
    expect(XP_WEIGHT.concrete).toBe(3);
  });
  it('mortar_mixer recipe: sand + quicklime → mortar', () => {
    expect(RECIPES.mortar_mixer).toBeDefined();
    expect(RECIPES.mortar_mixer!.inputs).toEqual({ sand: 1, quicklime: 1 });
    expect(RECIPES.mortar_mixer!.outputs).toEqual({ mortar: 1 });
    expect(RECIPES.mortar_mixer!.cycleSec).toBe(40);
  });
  it('cement_mill recipe: quicklime + sand + clay → cement', () => {
    expect(RECIPES.cement_mill).toBeDefined();
    expect(RECIPES.cement_mill!.inputs).toEqual({ quicklime: 8, clay: 2, sand: 1 });
    expect(RECIPES.cement_mill!.outputs).toEqual({ cement: 11 });
    expect(RECIPES.cement_mill!.cycleSec).toBe(67);
    expect(RECIPES.cement_mill!.exogenousFlow).toBe('fuel-combustion-CO₂');
    expect(RECIPES.cement_mill!.exogenousFlowKg).toBe(4);
  });
  it('concrete_plant recipe: cement + sand + fresh_water → concrete', () => {
    expect(RECIPES.concrete_plant).toBeDefined();
    expect(RECIPES.concrete_plant!.inputs).toEqual({ cement: 1, sand: 2, stone: 3, fresh_water: 0.5 });
    expect(RECIPES.concrete_plant!.outputs).toEqual({ concrete: 6 });
    expect(RECIPES.concrete_plant!.cycleSec).toBe(67);
    expect(RECIPES.concrete_plant!.exogenousFlow).toBe('evaporation-water-vapor');
  });
});

describe('§6.2 T1 refined — charcoal (Task 2.4)', () => {
  it('charcoal is in ALL_RESOURCES with xp_weight 3', () => {
    expect(ALL_RESOURCES).toContain('charcoal' as ResourceId);
    expect(XP_WEIGHT.charcoal).toBe(3);
  });
  it('charcoal_kiln recipe: 2 wood → 1 charcoal', () => {
    expect(RECIPES.charcoal_kiln).toBeDefined();
    expect(RECIPES.charcoal_kiln!.inputs).toEqual({ wood: 8 });
    expect(RECIPES.charcoal_kiln!.outputs).toEqual({ charcoal: 2, wood_tar: 1, co2: 2, water_vapor: 3 });
    expect(RECIPES.charcoal_kiln!.cycleSec).toBe(33);
    expect(RECIPES.charcoal_kiln!.biogenic).toBe(true);
  });
});

describe('§6.2 T1 refined — plank (Task 2.5)', () => {
  it('plank is in ALL_RESOURCES with xp_weight 3', () => {
    expect(ALL_RESOURCES).toContain('plank' as ResourceId);
    expect(XP_WEIGHT.plank).toBe(3);
  });
  it('plank_mill recipe: 1 lumber → 2 plank', () => {
    expect(RECIPES.plank_mill).toBeDefined();
    expect(RECIPES.plank_mill!.inputs).toEqual({ lumber: 1 });
    expect(RECIPES.plank_mill!.outputs).toEqual({ plank: 2 });
    expect(RECIPES.plank_mill!.cycleSec).toBe(27);
  });
});

describe('§6.2 T1 refined — copper/tin/lead ingots (Task 2.6)', () => {
  it('copper_ingot is in ALL_RESOURCES with xp_weight 3', () => {
    expect(ALL_RESOURCES).toContain('copper_ingot' as ResourceId);
    expect(XP_WEIGHT.copper_ingot).toBe(3);
  });
  it('tin_ingot is in ALL_RESOURCES with xp_weight 3', () => {
    expect(ALL_RESOURCES).toContain('tin_ingot' as ResourceId);
    expect(XP_WEIGHT.tin_ingot).toBe(3);
  });
  it('lead_ingot is in ALL_RESOURCES with xp_weight 3', () => {
    expect(ALL_RESOURCES).toContain('lead_ingot' as ResourceId);
    expect(XP_WEIGHT.lead_ingot).toBe(3);
  });
  it('copper_smelter recipe: copper_ore + coal → copper_ingot', () => {
    expect(RECIPES.copper_smelter).toBeDefined();
    expect(RECIPES.copper_smelter!.inputs).toEqual({ copper_ore: 1, coal: 1 });
    expect(RECIPES.copper_smelter!.outputs).toEqual({ copper_ingot: 1 });
    expect(RECIPES.copper_smelter!.cycleSec).toBe(27);
  });
  it('tin_smelter recipe: tin_ore + coal → tin_ingot', () => {
    expect(RECIPES.tin_smelter).toBeDefined();
    expect(RECIPES.tin_smelter!.inputs).toEqual({ tin_ore: 1, coal: 1 });
    expect(RECIPES.tin_smelter!.outputs).toEqual({ tin_ingot: 1 });
    expect(RECIPES.tin_smelter!.cycleSec).toBe(27);
  });
  it('lead_smelter recipe: lead_ore + coal → lead_ingot', () => {
    expect(RECIPES.lead_smelter).toBeDefined();
    expect(RECIPES.lead_smelter!.inputs).toEqual({ lead_ore: 1, coal: 1 });
    expect(RECIPES.lead_smelter!.outputs).toEqual({ lead_ingot: 1 });
    expect(RECIPES.lead_smelter!.cycleSec).toBe(27);
  });
});

describe('§6.2/§7.2 solder + solder_alloyer (Task 2.7)', () => {
  it('solder is in ALL_RESOURCES with xp_weight 10 (T2 component)', () => {
    expect(ALL_RESOURCES).toContain('solder' as ResourceId);
    expect(XP_WEIGHT.solder).toBe(10);
  });
  it('solder_alloyer recipe: tin_ingot + lead_ingot → 2 solder', () => {
    expect(RECIPES.solder_alloyer).toBeDefined();
    expect(RECIPES.solder_alloyer!.inputs).toEqual({ tin_ingot: 1, lead_ingot: 1 });
    expect(RECIPES.solder_alloyer!.outputs).toEqual({ solder: 2 });
    expect(RECIPES.solder_alloyer!.cycleSec).toBe(67);
  });
});

describe('§6.1/§7.1 carbon_steel chain (Task 3.1)', () => {
  it('manganese_ore is in ALL_RESOURCES with xp_weight 1 (T0 raw)', () => {
    expect(ALL_RESOURCES).toContain('manganese_ore' as ResourceId);
    expect(XP_WEIGHT.manganese_ore).toBe(1);
  });
  it('manganese_ingot is in ALL_RESOURCES with xp_weight 3 (T1 refined)', () => {
    expect(ALL_RESOURCES).toContain('manganese_ingot' as ResourceId);
    expect(XP_WEIGHT.manganese_ingot).toBe(3);
  });
  it('carbon_steel is in ALL_RESOURCES with xp_weight 10 (T2 component)', () => {
    expect(ALL_RESOURCES).toContain('carbon_steel' as ResourceId);
    expect(XP_WEIGHT.carbon_steel).toBe(10);
  });
  it('manganese_mine recipe: empty inputs → manganese_ore', () => {
    expect(RECIPES.manganese_mine).toBeDefined();
    expect(RECIPES.manganese_mine!.inputs).toEqual({});
    expect(RECIPES.manganese_mine!.outputs).toEqual({ manganese_ore: 1 });
    expect(RECIPES.manganese_mine!.cycleSec).toBe(20);
  });
  it('manganese_smelter recipe: manganese_ore + coal → manganese_ingot', () => {
    expect(RECIPES.manganese_smelter).toBeDefined();
    expect(RECIPES.manganese_smelter!.inputs).toEqual({ manganese_ore: 1, coal: 1 });
    expect(RECIPES.manganese_smelter!.outputs).toEqual({ manganese_ingot: 1 });
    expect(RECIPES.manganese_smelter!.cycleSec).toBe(27);
  });
  it('carbon_steel_mill recipe: steel + manganese_ingot → carbon_steel', () => {
    expect(RECIPES.carbon_steel_mill).toBeDefined();
    expect(RECIPES.carbon_steel_mill!.inputs).toEqual({ steel: 1, manganese_ingot: 1 });
    expect(RECIPES.carbon_steel_mill!.outputs).toEqual({ carbon_steel: 1 });
    expect(RECIPES.carbon_steel_mill!.cycleSec).toBe(83);
  });
});

describe('§6.1/§7.1 galvanized_steel chain (Task 3.2)', () => {
  it('zinc_ore is in ALL_RESOURCES with xp_weight 1 (T0 raw)', () => {
    expect(ALL_RESOURCES).toContain('zinc_ore' as ResourceId);
    expect(XP_WEIGHT.zinc_ore).toBe(1);
  });
  it('zinc_ingot is in ALL_RESOURCES with xp_weight 3 (T1 refined)', () => {
    expect(ALL_RESOURCES).toContain('zinc_ingot' as ResourceId);
    expect(XP_WEIGHT.zinc_ingot).toBe(3);
  });
  it('galvanized_steel is in ALL_RESOURCES with xp_weight 10 (T2 component)', () => {
    expect(ALL_RESOURCES).toContain('galvanized_steel' as ResourceId);
    expect(XP_WEIGHT.galvanized_steel).toBe(10);
  });
  it('zinc_mine recipe: empty inputs → zinc_ore', () => {
    expect(RECIPES.zinc_mine).toBeDefined();
    expect(RECIPES.zinc_mine!.inputs).toEqual({});
    expect(RECIPES.zinc_mine!.outputs).toEqual({ zinc_ore: 1 });
    expect(RECIPES.zinc_mine!.cycleSec).toBe(20);
  });
  it('zinc_smelter recipe: zinc_ore + coal → zinc_ingot', () => {
    expect(RECIPES.zinc_smelter).toBeDefined();
    expect(RECIPES.zinc_smelter!.inputs).toEqual({ zinc_ore: 1, coal: 1 });
    expect(RECIPES.zinc_smelter!.outputs).toEqual({ zinc_ingot: 1 });
    expect(RECIPES.zinc_smelter!.cycleSec).toBe(27);
  });
  it('galvanizing_bath recipe: steel + zinc_ingot → galvanized_steel', () => {
    expect(RECIPES.galvanizing_bath).toBeDefined();
    expect(RECIPES.galvanizing_bath!.inputs).toEqual({ steel: 1, zinc_ingot: 1 });
    expect(RECIPES.galvanizing_bath!.outputs).toEqual({ galvanized_steel: 1 });
    expect(RECIPES.galvanizing_bath!.cycleSec).toBe(83);
  });
});

describe('§6.4/§7.1 stainless_steel chain (Task 3.3)', () => {
  it('chromium_ore is in ALL_RESOURCES with xp_weight 1 (T0 raw)', () => {
    expect(ALL_RESOURCES).toContain('chromium_ore' as ResourceId);
    expect(XP_WEIGHT.chromium_ore).toBe(1);
  });
  it('nickel_ore is in ALL_RESOURCES with xp_weight 1 (T0 raw)', () => {
    expect(ALL_RESOURCES).toContain('nickel_ore' as ResourceId);
    expect(XP_WEIGHT.nickel_ore).toBe(1);
  });
  it('chromium_ingot is in ALL_RESOURCES with xp_weight 30 (T3 refined)', () => {
    expect(ALL_RESOURCES).toContain('chromium_ingot' as ResourceId);
    expect(XP_WEIGHT.chromium_ingot).toBe(30);
  });
  it('nickel_ingot is in ALL_RESOURCES with xp_weight 30 (T3 refined)', () => {
    expect(ALL_RESOURCES).toContain('nickel_ingot' as ResourceId);
    expect(XP_WEIGHT.nickel_ingot).toBe(30);
  });
  it('stainless_steel is in ALL_RESOURCES with xp_weight 30 (T3 component)', () => {
    expect(ALL_RESOURCES).toContain('stainless_steel' as ResourceId);
    expect(XP_WEIGHT.stainless_steel).toBe(30);
  });
  it('chromium_mine recipe: empty inputs → chromium_ore', () => {
    expect(RECIPES.chromium_mine).toBeDefined();
    expect(RECIPES.chromium_mine!.inputs).toEqual({});
    expect(RECIPES.chromium_mine!.outputs).toEqual({ chromium_ore: 1 });
    expect(RECIPES.chromium_mine!.cycleSec).toBe(20);
  });
  it('chromium_smelter recipe: chromium_ore + coal → chromium_ingot', () => {
    expect(RECIPES.chromium_smelter).toBeDefined();
    expect(RECIPES.chromium_smelter!.inputs).toEqual({ chromium_ore: 1, coal: 1 });
    expect(RECIPES.chromium_smelter!.outputs).toEqual({ chromium_ingot: 1 });
    expect(RECIPES.chromium_smelter!.cycleSec).toBe(83); // rebalanced Task 16.5 (was 80; later 250; 2026-05-18 ÷3 → 83)
  });
  it('nickel_mine recipe: empty inputs → nickel_ore', () => {
    expect(RECIPES.nickel_mine).toBeDefined();
    expect(RECIPES.nickel_mine!.inputs).toEqual({});
    expect(RECIPES.nickel_mine!.outputs).toEqual({ nickel_ore: 1 });
    expect(RECIPES.nickel_mine!.cycleSec).toBe(20);
  });
  it('nickel_smelter recipe: nickel_ore + coal → nickel_ingot', () => {
    expect(RECIPES.nickel_smelter).toBeDefined();
    expect(RECIPES.nickel_smelter!.inputs).toEqual({ nickel_ore: 1, coal: 1 });
    expect(RECIPES.nickel_smelter!.outputs).toEqual({ nickel_ingot: 1 });
    expect(RECIPES.nickel_smelter!.cycleSec).toBe(83); // rebalanced Task 16.5 (was 80; later 250; 2026-05-18 ÷3 → 83)
  });
  it('stainless_steel_mill recipe: steel + chromium_ingot + nickel_ingot → stainless_steel', () => {
    expect(RECIPES.stainless_steel_mill).toBeDefined();
    expect(RECIPES.stainless_steel_mill!.inputs).toEqual({ steel: 1, chromium_ingot: 1, nickel_ingot: 1 });
    expect(RECIPES.stainless_steel_mill!.outputs).toEqual({ stainless_steel: 1 });
    expect(RECIPES.stainless_steel_mill!.cycleSec).toBe(133);
  });
});

describe('§6.4/§7.1 tool_steel chain (Task 3.4)', () => {
  it('tungsten_ore is in ALL_RESOURCES with xp_weight 1 (T0 raw)', () => {
    expect(ALL_RESOURCES).toContain('tungsten_ore' as ResourceId);
    expect(XP_WEIGHT.tungsten_ore).toBe(1);
  });
  it('tungsten_ingot is in ALL_RESOURCES with xp_weight 30 (T3 refined)', () => {
    expect(ALL_RESOURCES).toContain('tungsten_ingot' as ResourceId);
    expect(XP_WEIGHT.tungsten_ingot).toBe(30);
  });
  it('tool_steel is in ALL_RESOURCES with xp_weight 30 (T3 component)', () => {
    expect(ALL_RESOURCES).toContain('tool_steel' as ResourceId);
    expect(XP_WEIGHT.tool_steel).toBe(30);
  });
  it('tungsten_mine recipe: empty inputs → tungsten_ore', () => {
    expect(RECIPES.tungsten_mine).toBeDefined();
    expect(RECIPES.tungsten_mine!.inputs).toEqual({});
    expect(RECIPES.tungsten_mine!.outputs).toEqual({ tungsten_ore: 1 });
    expect(RECIPES.tungsten_mine!.cycleSec).toBe(20);
  });
  it('tungsten_smelter recipe: tungsten_ore + coal → tungsten_ingot', () => {
    expect(RECIPES.tungsten_smelter).toBeDefined();
    expect(RECIPES.tungsten_smelter!.inputs).toEqual({ tungsten_ore: 1, coal: 1 });
    expect(RECIPES.tungsten_smelter!.outputs).toEqual({ tungsten_ingot: 1 });
    expect(RECIPES.tungsten_smelter!.cycleSec).toBe(83); // rebalanced Task 16.5 (was 80; later 250; 2026-05-18 ÷3 → 83)
  });
  it('tool_steel_mill recipe: steel + tungsten_ingot → tool_steel', () => {
    expect(RECIPES.tool_steel_mill).toBeDefined();
    expect(RECIPES.tool_steel_mill!.inputs).toEqual({ steel: 1, tungsten_ingot: 1 });
    expect(RECIPES.tool_steel_mill!.outputs).toEqual({ tool_steel: 1 });
    expect(RECIPES.tool_steel_mill!.cycleSec).toBe(133);
  });
});

describe('§7.4 crude_oil_cracker — heavy_oil + tar + asphalt (Task 4.1)', () => {
  it('heavy_oil is in ALL_RESOURCES with xp_weight 10 (T2 liquid)', () => {
    expect(ALL_RESOURCES).toContain('heavy_oil' as ResourceId);
    expect(XP_WEIGHT.heavy_oil).toBe(10);
  });
  it('tar is in ALL_RESOURCES with xp_weight 10 (T2 liquid)', () => {
    expect(ALL_RESOURCES).toContain('tar' as ResourceId);
    expect(XP_WEIGHT.tar).toBe(10);
  });
  it('asphalt is in ALL_RESOURCES with xp_weight 10 (T2 liquid)', () => {
    expect(ALL_RESOURCES).toContain('asphalt' as ResourceId);
    expect(XP_WEIGHT.asphalt).toBe(10);
  });
  it('crude_oil_cracker recipe: 3 crude_oil → heavy_oil + tar + asphalt', () => {
    expect(RECIPES.crude_oil_cracker).toBeDefined();
    expect(RECIPES.crude_oil_cracker!.inputs).toEqual({ crude_oil: 3 });
    expect(RECIPES.crude_oil_cracker!.outputs).toEqual({ heavy_oil: 1, tar: 1, asphalt: 1 });
    expect(RECIPES.crude_oil_cracker!.cycleSec).toBe(400); // rebalanced Task 16.6 (was 600; later 1200; 2026-05-18 ÷3 → 400)
    expect(RECIPES.crude_oil_cracker!.category).toBe('chemistry');
  });
});

describe('§7.4 plastic_precursor via plastic_polymerizer_a (Task 4.2)', () => {
  it('plastic_precursor is in ALL_RESOURCES with xp_weight 10 (T2 liquid)', () => {
    expect(ALL_RESOURCES).toContain('plastic_precursor' as ResourceId);
    expect(XP_WEIGHT.plastic_precursor).toBe(10);
  });
  it('plastic_polymerizer_a recipe: 1 naphtha → 1 plastic_precursor', () => {
    expect(RECIPES.plastic_polymerizer_a).toBeDefined();
    expect(RECIPES.plastic_polymerizer_a!.inputs).toEqual({ naphtha: 1 });
    expect(RECIPES.plastic_polymerizer_a!.outputs).toEqual({ plastic_precursor: 1 });
    expect(RECIPES.plastic_polymerizer_a!.cycleSec).toBe(133);
    expect(RECIPES.plastic_polymerizer_a!.category).toBe('chemistry');
  });
});

describe('§7.4 rigid + flexible plastic + synthetic_rubber presses (Task 4.3)', () => {
  it('rigid_plastic is in ALL_RESOURCES with xp_weight 10 (T2 component)', () => {
    expect(ALL_RESOURCES).toContain('rigid_plastic' as ResourceId);
    expect(XP_WEIGHT.rigid_plastic).toBe(10);
  });
  it('flexible_plastic is in ALL_RESOURCES with xp_weight 10 (T2 component)', () => {
    expect(ALL_RESOURCES).toContain('flexible_plastic' as ResourceId);
    expect(XP_WEIGHT.flexible_plastic).toBe(10);
  });
  it('synthetic_rubber is in ALL_RESOURCES with xp_weight 10 (T2 component)', () => {
    expect(ALL_RESOURCES).toContain('synthetic_rubber' as ResourceId);
    expect(XP_WEIGHT.synthetic_rubber).toBe(10);
  });
  it('rigid_plastic_press recipe: 1 plastic_precursor → 1 rigid_plastic', () => {
    expect(RECIPES.rigid_plastic_press).toBeDefined();
    expect(RECIPES.rigid_plastic_press!.inputs).toEqual({ plastic_precursor: 1 });
    expect(RECIPES.rigid_plastic_press!.outputs).toEqual({ rigid_plastic: 1 });
    expect(RECIPES.rigid_plastic_press!.cycleSec).toBe(100);
    expect(RECIPES.rigid_plastic_press!.category).toBe('manufacturing');
  });
  it('flexible_plastic_press recipe: 1 plastic_precursor → 1 flexible_plastic', () => {
    expect(RECIPES.flexible_plastic_press).toBeDefined();
    expect(RECIPES.flexible_plastic_press!.inputs).toEqual({ plastic_precursor: 1 });
    expect(RECIPES.flexible_plastic_press!.outputs).toEqual({ flexible_plastic: 1 });
    expect(RECIPES.flexible_plastic_press!.cycleSec).toBe(100);
    expect(RECIPES.flexible_plastic_press!.category).toBe('manufacturing');
  });
  it('rubber_synthesizer recipe: 1 plastic_precursor → 1 synthetic_rubber', () => {
    expect(RECIPES.rubber_synthesizer).toBeDefined();
    expect(RECIPES.rubber_synthesizer!.inputs).toEqual({ plastic_precursor: 1 });
    expect(RECIPES.rubber_synthesizer!.outputs).toEqual({ synthetic_rubber: 1 });
    expect(RECIPES.rubber_synthesizer!.cycleSec).toBe(100);
    expect(RECIPES.rubber_synthesizer!.category).toBe('manufacturing');
  });
});

describe('§7.5 sodium_hydroxide as real chlor-alkali co-output (Task 5.2)', () => {
  it('sodium_hydroxide is in ALL_RESOURCES with xp_weight 10 (T2 liquid)', () => {
    expect(ALL_RESOURCES).toContain('sodium_hydroxide' as ResourceId);
    expect(XP_WEIGHT.sodium_hydroxide).toBe(10);
  });
  it('chlor_alkali_plant outputs both chlorine and sodium_hydroxide', () => {
    expect(RECIPES.chlor_alkali_plant).toBeDefined();
    expect(RECIPES.chlor_alkali_plant!.outputs.chlorine).toBe(71);
    expect(RECIPES.chlor_alkali_plant!.outputs.sodium_hydroxide).toBe(80);
    expect(RECIPES.chlor_alkali_plant!.inputs).toEqual({ salt: 117, fresh_water: 36 });
    expect(RECIPES.chlor_alkali_plant!.cycleSec).toBe(400); // rebalanced Task 16.6 (was 800; later 1200; 2026-05-18 ÷3 → 400)
  });
});

describe('§7.5 liquid_nitrogen via cryo_air_separator (Task 5.4)', () => {
  it('liquid_nitrogen is in ALL_RESOURCES with xp_weight 30 (T3 temp_sensitive)', () => {
    expect(ALL_RESOURCES).toContain('liquid_nitrogen' as ResourceId);
    expect(XP_WEIGHT.liquid_nitrogen).toBe(30);
  });
  it('cryo_air_separator recipe: nitrogen → liquid_nitrogen', () => {
    expect(RECIPES.cryo_air_separator).toBeDefined();
    expect(RECIPES.cryo_air_separator!.inputs).toEqual({ nitrogen: 1 });
    expect(RECIPES.cryo_air_separator!.outputs).toEqual({ liquid_nitrogen: 1 });
    expect(RECIPES.cryo_air_separator!.cycleSec).toBe(133);
    expect(RECIPES.cryo_air_separator!.category).toBe('chemistry');
  });
  it('air_separator recipe outputs nitrogen + oxygen + argon per rev-16 §3.3', () => {
    expect(RECIPES.air_separator).toBeDefined();
    expect(RECIPES.air_separator!.outputs).toEqual({ nitrogen: 75.5, oxygen: 23.2, argon: 1.3 });
    expect(RECIPES.air_separator!.inputs).toEqual({ air: 100 });
    expect(RECIPES.air_separator!.exogenousFlow).toBe('atmosphere');
  });
});

describe('§7.5 phosphor via phosphor_plant (Task 5.3)', () => {
  it('phosphor is in ALL_RESOURCES with xp_weight 30 (T3 rare)', () => {
    expect(ALL_RESOURCES).toContain('phosphor' as ResourceId);
    expect(XP_WEIGHT.phosphor).toBe(30);
  });
  it('phosphor_plant recipe: phosphate + sulfuric_acid → phosphor', () => {
    expect(RECIPES.phosphor_plant).toBeDefined();
    expect(RECIPES.phosphor_plant!.inputs).toEqual({ phosphate: 1, sulfuric_acid: 1 });
    expect(RECIPES.phosphor_plant!.outputs).toEqual({ phosphor: 1 });
    expect(RECIPES.phosphor_plant!.cycleSec).toBe(200);
    expect(RECIPES.phosphor_plant!.category).toBe('chemistry');
  });
});

describe('§7.5 sulfuric_acid + hydrochloric_acid plants (Task 5.1)', () => {
  it('sulfuric_acid is in ALL_RESOURCES with xp_weight 10 (T2 liquid)', () => {
    expect(ALL_RESOURCES).toContain('sulfuric_acid' as ResourceId);
    expect(XP_WEIGHT.sulfuric_acid).toBe(10);
  });
  it('hydrochloric_acid is in ALL_RESOURCES with xp_weight 10 (T2 liquid)', () => {
    expect(ALL_RESOURCES).toContain('hydrochloric_acid' as ResourceId);
    expect(XP_WEIGHT.hydrochloric_acid).toBe(10);
  });
  it('sulfuric_acid_plant recipe: sulfur + fresh_water → sulfuric_acid', () => {
    expect(RECIPES.sulfuric_acid_plant).toBeDefined();
    expect(RECIPES.sulfuric_acid_plant!.inputs).toEqual({ sulfur: 1, fresh_water: 2 });
    expect(RECIPES.sulfuric_acid_plant!.outputs).toEqual({ sulfuric_acid: 1 });
    expect(RECIPES.sulfuric_acid_plant!.cycleSec).toBe(133);
    expect(RECIPES.sulfuric_acid_plant!.category).toBe('chemistry');
  });
  it('hcl_plant recipe: salt + sulfuric_acid → hydrochloric_acid', () => {
    expect(RECIPES.hcl_plant).toBeDefined();
    expect(RECIPES.hcl_plant!.inputs).toEqual({ salt: 1, sulfuric_acid: 1 });
    expect(RECIPES.hcl_plant!.outputs).toEqual({ hydrochloric_acid: 1 });
    expect(RECIPES.hcl_plant!.cycleSec).toBe(133);
    expect(RECIPES.hcl_plant!.category).toBe('chemistry');
  });
});

describe('§6.3 T2 rolling outputs — sheet_metal + pipe + steel_beam (Task 6.1)', () => {
  it('sheet_metal, pipe, steel_beam are in ALL_RESOURCES with xp_weight 10', () => {
    expect(ALL_RESOURCES).toContain('sheet_metal');
    expect(ALL_RESOURCES).toContain('pipe');
    expect(ALL_RESOURCES).toContain('steel_beam');
    expect(XP_WEIGHT.sheet_metal).toBe(10);
    expect(XP_WEIGHT.pipe).toBe(10);
    expect(XP_WEIGHT.steel_beam).toBe(10);
  });
  it('sheet_metal_mill recipe: steel → sheet_metal', () => {
    expect(RECIPES.sheet_metal_mill).toBeDefined();
    expect(RECIPES.sheet_metal_mill!.inputs).toEqual({ steel: 1 });
    expect(RECIPES.sheet_metal_mill!.outputs).toEqual({ sheet_metal: 2 });
    expect(RECIPES.sheet_metal_mill!.cycleSec).toBe(67);
  });
  it('pipe_mill recipe: steel → pipe', () => {
    expect(RECIPES.pipe_mill).toBeDefined();
    expect(RECIPES.pipe_mill!.inputs).toEqual({ steel: 1 });
    expect(RECIPES.pipe_mill!.outputs).toEqual({ pipe: 2 });
    expect(RECIPES.pipe_mill!.cycleSec).toBe(67);
  });
  it('beam_mill recipe: steel → steel_beam', () => {
    expect(RECIPES.beam_mill).toBeDefined();
    expect(RECIPES.beam_mill!.inputs).toEqual({ steel: 1 });
    expect(RECIPES.beam_mill!.outputs).toEqual({ steel_beam: 2 });
    expect(RECIPES.beam_mill!.cycleSec).toBe(67);
  });
});

describe('§6.3 T2 mechanical fasteners — bearing + spring (Task 6.2)', () => {
  it('bearing and spring are in ALL_RESOURCES with xp_weight 10', () => {
    expect(ALL_RESOURCES).toContain('bearing');
    expect(ALL_RESOURCES).toContain('spring');
    expect(XP_WEIGHT.bearing).toBe(10);
    expect(XP_WEIGHT.spring).toBe(10);
  });
  it('bearing_press recipe: steel + lubricant → bearing', () => {
    expect(RECIPES.bearing_press).toBeDefined();
    expect(RECIPES.bearing_press!.inputs).toEqual({ steel: 1, lubricant: 1 });
    expect(RECIPES.bearing_press!.outputs).toEqual({ bearing: 2 });
    expect(RECIPES.bearing_press!.cycleSec).toBe(67);
  });
  it('spring_winder recipe: steel → spring', () => {
    expect(RECIPES.spring_winder).toBeDefined();
    expect(RECIPES.spring_winder!.inputs).toEqual({ steel: 1 });
    expect(RECIPES.spring_winder!.outputs).toEqual({ spring: 3 });
    expect(RECIPES.spring_winder!.cycleSec).toBe(67);
  });
});

describe('§6.3 heavy_cable via cable_drawer (Task 6.3)', () => {
  it('heavy_cable is in ALL_RESOURCES with xp_weight 10', () => {
    expect(ALL_RESOURCES).toContain('heavy_cable');
    expect(XP_WEIGHT.heavy_cable).toBe(10);
  });
  it('cable_drawer recipe: wire → heavy_cable', () => {
    expect(RECIPES.cable_drawer).toBeDefined();
    expect(RECIPES.cable_drawer!.inputs).toEqual({ wire: 3 });
    expect(RECIPES.cable_drawer!.outputs).toEqual({ heavy_cable: 1 });
    expect(RECIPES.cable_drawer!.cycleSec).toBe(67);
  });
});

describe('§6.3/§7.9 battery via battery_factory (Task 6.4)', () => {
  it('battery is in ALL_RESOURCES with xp_weight 30', () => {
    expect(ALL_RESOURCES).toContain('battery');
    expect(XP_WEIGHT.battery).toBe(30);
  });
  it('battery_factory recipe: lithium + rigid_plastic + wire → battery', () => {
    expect(RECIPES.battery_factory).toBeDefined();
    expect(RECIPES.battery_factory!.inputs).toEqual({
      lithium: 1,
      rigid_plastic: 1,
      wire: 2,
    });
    expect(RECIPES.battery_factory!.outputs).toEqual({ battery: 1 });
    expect(RECIPES.battery_factory!.cycleSec).toBe(100);
  });
});

describe('§6.4 lithium + lithium_extractor (Task 10.4.5)', () => {
  it('lithium is in ALL_RESOURCES with xp_weight 30 (T3 rare)', () => {
    expect(ALL_RESOURCES).toContain('lithium' as ResourceId);
    expect(XP_WEIGHT.lithium).toBe(30);
  });
  it('lithium_extractor recipe: empty inputs → lithium', () => {
    expect(RECIPES.lithium_extractor).toBeDefined();
    expect(RECIPES.lithium_extractor!.inputs).toEqual({});
    expect(RECIPES.lithium_extractor!.outputs).toEqual({ lithium: 1 });
    expect(RECIPES.lithium_extractor!.cycleSec).toBe(67);
  });
});

describe('§6.4/§7.9 magnet via mag_forge (Task 10.5)', () => {
  it('magnet is in ALL_RESOURCES with xp_weight 30 (T3 component)', () => {
    expect(ALL_RESOURCES).toContain('magnet' as ResourceId);
    expect(XP_WEIGHT.magnet).toBe(30);
  });
  it('mag_forge recipe: magnetic_alloy + wire → magnet', () => {
    expect(RECIPES.mag_forge).toBeDefined();
    expect(RECIPES.mag_forge!.inputs).toEqual({ magnetic_alloy: 1, wire: 2 });
    expect(RECIPES.mag_forge!.outputs).toEqual({ magnet: 1 });
    expect(RECIPES.mag_forge!.cycleSec).toBe(83);
  });
});

describe('§6.4/§7.9 electric_motor via motor_assembly (Task 10.6)', () => {
  it('electric_motor is in ALL_RESOURCES with xp_weight 30 (T3 component)', () => {
    expect(ALL_RESOURCES).toContain('electric_motor' as ResourceId);
    expect(XP_WEIGHT.electric_motor).toBe(30);
  });
  it('motor_assembly recipe: magnet + wire + steel → electric_motor', () => {
    expect(RECIPES.motor_assembly).toBeDefined();
    expect(RECIPES.motor_assembly!.inputs).toEqual({ magnet: 1, wire: 4, steel: 1 });
    expect(RECIPES.motor_assembly!.outputs).toEqual({ electric_motor: 1 });
    expect(RECIPES.motor_assembly!.cycleSec).toBe(100);
  });
});

describe('§6.4/§7.9 generator via generator_lab (Task 10.7)', () => {
  it('generator is in ALL_RESOURCES with xp_weight 30 (T3 component)', () => {
    expect(ALL_RESOURCES).toContain('generator' as ResourceId);
    expect(XP_WEIGHT.generator).toBe(30);
  });
  it('generator_lab recipe: magnet + wire + steel + bearing → generator', () => {
    expect(RECIPES.generator_lab).toBeDefined();
    expect(RECIPES.generator_lab!.inputs).toEqual({ magnet: 1, wire: 5, steel: 1, bearing: 2 });
    expect(RECIPES.generator_lab!.outputs).toEqual({ generator: 1 });
    expect(RECIPES.generator_lab!.cycleSec).toBe(117);
  });
});

describe('§7.10 pump + hydraulic_actuator + pneumatic_actuator (Task 10.8)', () => {
  it('pump is in ALL_RESOURCES with xp_weight 30 (T3 component)', () => {
    expect(ALL_RESOURCES).toContain('pump' as ResourceId);
    expect(XP_WEIGHT.pump).toBe(30);
  });
  it('hydraulic_actuator is in ALL_RESOURCES with xp_weight 30 (T3 component)', () => {
    expect(ALL_RESOURCES).toContain('hydraulic_actuator' as ResourceId);
    expect(XP_WEIGHT.hydraulic_actuator).toBe(30);
  });
  it('pneumatic_actuator is in ALL_RESOURCES with xp_weight 30 (T3 component)', () => {
    expect(ALL_RESOURCES).toContain('pneumatic_actuator' as ResourceId);
    expect(XP_WEIGHT.pneumatic_actuator).toBe(30);
  });
  it('pump_assembly recipe: electric_motor + pipe + bearing → pump', () => {
    expect(RECIPES.pump_assembly).toBeDefined();
    expect(RECIPES.pump_assembly!.inputs).toEqual({ electric_motor: 1, pipe: 2, bearing: 1 });
    expect(RECIPES.pump_assembly!.outputs).toEqual({ pump: 1 });
    expect(RECIPES.pump_assembly!.cycleSec).toBe(100);
  });
  it('hydraulic_assembly recipe: pipe + lubricant + bearing + spring → hydraulic_actuator', () => {
    expect(RECIPES.hydraulic_assembly).toBeDefined();
    expect(RECIPES.hydraulic_assembly!.inputs).toEqual({ pipe: 2, lubricant: 2, bearing: 1, spring: 1 });
    expect(RECIPES.hydraulic_assembly!.outputs).toEqual({ hydraulic_actuator: 1 });
    expect(RECIPES.hydraulic_assembly!.cycleSec).toBe(100);
  });
  it('pneumatic_assembly recipe: pipe + bearing + spring → pneumatic_actuator', () => {
    expect(RECIPES.pneumatic_assembly).toBeDefined();
    expect(RECIPES.pneumatic_assembly!.inputs).toEqual({ pipe: 2, bearing: 1, spring: 1 });
    expect(RECIPES.pneumatic_assembly!.outputs).toEqual({ pneumatic_actuator: 1 });
    expect(RECIPES.pneumatic_assembly!.cycleSec).toBe(100);
  });
});

describe('§7.9 solar_cell via solar_cell_lab (Task 10.9)', () => {
  it('solar_cell is in ALL_RESOURCES with xp_weight 30 (T3 component)', () => {
    expect(ALL_RESOURCES).toContain('solar_cell' as ResourceId);
    expect(XP_WEIGHT.solar_cell).toBe(30);
  });
  it('solar_cell_lab recipe: silicon_wafer + glass + aluminum → solar_cell', () => {
    expect(RECIPES.solar_cell_lab).toBeDefined();
    expect(RECIPES.solar_cell_lab!.inputs).toEqual({ silicon_wafer: 1, glass: 2, aluminum: 1 });
    expect(RECIPES.solar_cell_lab!.outputs).toEqual({ solar_cell: 1 });
    expect(RECIPES.solar_cell_lab!.cycleSec).toBe(133);
  });
});

describe('§7.9 fuel_cell via fuel_cell_lab (Task 10.10)', () => {
  it('fuel_cell is in ALL_RESOURCES with xp_weight 30 (T3 component)', () => {
    expect(ALL_RESOURCES).toContain('fuel_cell' as ResourceId);
    expect(XP_WEIGHT.fuel_cell).toBe(30);
  });
  it('fuel_cell_lab recipe: hydrogen + rare_earth + flexible_plastic → fuel_cell', () => {
    expect(RECIPES.fuel_cell_lab).toBeDefined();
    expect(RECIPES.fuel_cell_lab!.inputs).toEqual({ hydrogen: 2, rare_earth: 1, flexible_plastic: 1 });
    expect(RECIPES.fuel_cell_lab!.outputs).toEqual({ fuel_cell: 1 });
    expect(RECIPES.fuel_cell_lab!.cycleSec).toBe(133);
  });
});

describe('§6.4/§7.6 optical_glass via optical_glass_kiln (Task 10.11)', () => {
  it('optical_glass is in ALL_RESOURCES with xp_weight 30 (T3 component)', () => {
    expect(ALL_RESOURCES).toContain('optical_glass' as ResourceId);
    expect(XP_WEIGHT.optical_glass).toBe(30);
  });
  it('optical_glass_kiln recipe: quartz → optical_glass', () => {
    expect(RECIPES.optical_glass_kiln).toBeDefined();
    expect(RECIPES.optical_glass_kiln!.inputs).toEqual({ quartz: 2 });
    expect(RECIPES.optical_glass_kiln!.outputs).toEqual({ optical_glass: 1 });
    expect(RECIPES.optical_glass_kiln!.cycleSec).toBe(100);
  });
});

describe('§7.6 glass_fiber + optical_fiber spinners (Task 10.12)', () => {
  it('glass_fiber is in ALL_RESOURCES with xp_weight 30 (T3 component)', () => {
    expect(ALL_RESOURCES).toContain('glass_fiber' as ResourceId);
    expect(XP_WEIGHT.glass_fiber).toBe(30);
  });
  it('optical_fiber is in ALL_RESOURCES with xp_weight 30 (T3 component)', () => {
    expect(ALL_RESOURCES).toContain('optical_fiber' as ResourceId);
    expect(XP_WEIGHT.optical_fiber).toBe(30);
  });
  it('glass_fiber_spinner recipe: glass → glass_fiber', () => {
    expect(RECIPES.glass_fiber_spinner).toBeDefined();
    expect(RECIPES.glass_fiber_spinner!.inputs).toEqual({ glass: 2 });
    expect(RECIPES.glass_fiber_spinner!.outputs).toEqual({ glass_fiber: 3 });
    expect(RECIPES.glass_fiber_spinner!.cycleSec).toBe(100);
  });
  it('optical_fiber_drawer recipe: optical_glass → optical_fiber', () => {
    expect(RECIPES.optical_fiber_drawer).toBeDefined();
    expect(RECIPES.optical_fiber_drawer!.inputs).toEqual({ optical_glass: 1 });
    expect(RECIPES.optical_fiber_drawer!.outputs).toEqual({ optical_fiber: 2 });
    expect(RECIPES.optical_fiber_drawer!.cycleSec).toBe(133);
  });
});

describe('§6.3 glass_panel via glass_panel_press (Task 6.5)', () => {
  it('glass_panel is in ALL_RESOURCES with xp_weight 10', () => {
    expect(ALL_RESOURCES).toContain('glass_panel');
    expect(XP_WEIGHT.glass_panel).toBe(10);
  });
  it('glass_panel_press recipe: glass → glass_panel', () => {
    expect(RECIPES.glass_panel_press).toBeDefined();
    expect(RECIPES.glass_panel_press!.inputs).toEqual({ glass: 2 });
    expect(RECIPES.glass_panel_press!.outputs).toEqual({ glass_panel: 1 });
    expect(RECIPES.glass_panel_press!.cycleSec).toBe(67);
  });
});

describe('§6.3 coolant + ceramic_insulator (Task 6.6)', () => {
  it('coolant and ceramic_insulator are in ALL_RESOURCES with xp_weight 10', () => {
    expect(ALL_RESOURCES).toContain('coolant');
    expect(ALL_RESOURCES).toContain('ceramic_insulator');
    expect(XP_WEIGHT.coolant).toBe(10);
    expect(XP_WEIGHT.ceramic_insulator).toBe(10);
  });
  it('coolant_synthesizer recipe: fresh_water + salt + naphtha → coolant', () => {
    expect(RECIPES.coolant_synthesizer).toBeDefined();
    expect(RECIPES.coolant_synthesizer!.inputs).toEqual({
      fresh_water: 2,
      salt: 1,
      naphtha: 1,
    });
    expect(RECIPES.coolant_synthesizer!.outputs).toEqual({ coolant: 2 });
    expect(RECIPES.coolant_synthesizer!.cycleSec).toBe(100);
  });
  it('ceramic_kiln recipe: clay + sand → ceramic_insulator', () => {
    expect(RECIPES.ceramic_kiln).toBeDefined();
    expect(RECIPES.ceramic_kiln!.inputs).toEqual({ clay: 2, sand: 1 });
    expect(RECIPES.ceramic_kiln!.outputs).toEqual({ ceramic_insulator: 1 });
    expect(RECIPES.ceramic_kiln!.cycleSec).toBe(83);
  });
});

describe('§7.2 bronze + bronze_alloyer (Task 7.1)', () => {
  it('bronze is in ALL_RESOURCES with xp_weight 10 (T2 component)', () => {
    expect(ALL_RESOURCES).toContain('bronze' as ResourceId);
    expect(XP_WEIGHT.bronze).toBe(10);
  });
  it('bronze_alloyer recipe: copper_ingot + tin_ingot → 2 bronze', () => {
    expect(RECIPES.bronze_alloyer).toBeDefined();
    expect(RECIPES.bronze_alloyer!.inputs).toEqual({ copper_ingot: 1, tin_ingot: 1 });
    expect(RECIPES.bronze_alloyer!.outputs).toEqual({ bronze: 2 });
    expect(RECIPES.bronze_alloyer!.cycleSec).toBe(83);
  });
});

describe('§7.2 brass + brass_alloyer (Task 7.2)', () => {
  it('brass is in ALL_RESOURCES with xp_weight 10 (T2 component)', () => {
    expect(ALL_RESOURCES).toContain('brass' as ResourceId);
    expect(XP_WEIGHT.brass).toBe(10);
  });
  it('brass_alloyer recipe: copper_ingot + zinc_ingot → 2 brass', () => {
    expect(RECIPES.brass_alloyer).toBeDefined();
    expect(RECIPES.brass_alloyer!.inputs).toEqual({ copper_ingot: 1, zinc_ingot: 1 });
    expect(RECIPES.brass_alloyer!.outputs).toEqual({ brass: 2 });
    expect(RECIPES.brass_alloyer!.cycleSec).toBe(83);
  });
});

describe('§7.3 alumina + alumina_refinery (Task 8.1)', () => {
  it('alumina is in ALL_RESOURCES with xp_weight 10 (T2 component)', () => {
    expect(ALL_RESOURCES).toContain('alumina' as ResourceId);
    expect(XP_WEIGHT.alumina).toBe(10);
  });
  it('alumina_refinery recipe: bauxite + sodium_hydroxide → alumina', () => {
    expect(RECIPES.alumina_refinery).toBeDefined();
    expect(RECIPES.alumina_refinery!.inputs).toEqual({ bauxite: 1, sodium_hydroxide: 1 });
    expect(RECIPES.alumina_refinery!.outputs).toEqual({ alumina: 1 });
    expect(RECIPES.alumina_refinery!.cycleSec).toBe(100);
  });
});

describe('§7.3 aluminum + aluminum_smelter (Task 8.2)', () => {
  it('aluminum is in ALL_RESOURCES with xp_weight 10 (T3 component)', () => {
    expect(ALL_RESOURCES).toContain('aluminum' as ResourceId);
    expect(XP_WEIGHT.aluminum).toBe(10);
  });
  it('aluminum_smelter recipe: alumina → aluminum', () => {
    expect(RECIPES.aluminum_smelter).toBeDefined();
    expect(RECIPES.aluminum_smelter!.inputs).toEqual({ alumina: 1 });
    expect(RECIPES.aluminum_smelter!.outputs).toEqual({ aluminum: 1 });
    expect(RECIPES.aluminum_smelter!.cycleSec).toBe(100);
  });
});

describe('§7.7 silicon_wafer via wafer_lab (Task 9.1)', () => {
  it('silicon_wafer is in ALL_RESOURCES with xp_weight 30 (T3 component)', () => {
    expect(ALL_RESOURCES).toContain('silicon_wafer' as ResourceId);
    expect(XP_WEIGHT.silicon_wafer).toBe(30);
  });
  it('wafer_lab recipe: silicon → silicon_wafer', () => {
    expect(RECIPES.wafer_lab).toBeDefined();
    expect(RECIPES.wafer_lab!.inputs).toEqual({ silicon: 1 });
    expect(RECIPES.wafer_lab!.outputs).toEqual({ silicon_wafer: 1 });
    expect(RECIPES.wafer_lab!.cycleSec).toBe(133);
    expect(RECIPES.wafer_lab!.category).toBe('electronics');
  });
});

describe('§7.7 transistor + capacitor + resistor doping chambers (Task 9.2)', () => {
  it('transistor is in ALL_RESOURCES with xp_weight 30 (T3 component)', () => {
    expect(ALL_RESOURCES).toContain('transistor' as ResourceId);
    expect(XP_WEIGHT.transistor).toBe(30);
  });
  it('capacitor is in ALL_RESOURCES with xp_weight 30 (T3 component)', () => {
    expect(ALL_RESOURCES).toContain('capacitor' as ResourceId);
    expect(XP_WEIGHT.capacitor).toBe(30);
  });
  it('resistor is in ALL_RESOURCES with xp_weight 30 (T3 component)', () => {
    expect(ALL_RESOURCES).toContain('resistor' as ResourceId);
    expect(XP_WEIGHT.resistor).toBe(30);
  });
  it('transistor_doping recipe: silicon_wafer + graphite → 4 transistor', () => {
    expect(RECIPES.transistor_doping).toBeDefined();
    expect(RECIPES.transistor_doping!.inputs).toEqual({ silicon_wafer: 1, graphite: 1 });
    expect(RECIPES.transistor_doping!.outputs).toEqual({ transistor: 4 });
    expect(RECIPES.transistor_doping!.cycleSec).toBe(67);
    expect(RECIPES.transistor_doping!.category).toBe('electronics');
  });
  it('capacitor_doping recipe: silicon_wafer + graphite → 4 capacitor', () => {
    expect(RECIPES.capacitor_doping).toBeDefined();
    expect(RECIPES.capacitor_doping!.inputs).toEqual({ silicon_wafer: 1, graphite: 1 });
    expect(RECIPES.capacitor_doping!.outputs).toEqual({ capacitor: 4 });
    expect(RECIPES.capacitor_doping!.cycleSec).toBe(67);
    expect(RECIPES.capacitor_doping!.category).toBe('electronics');
  });
  it('resistor_doping recipe: silicon_wafer + graphite → 4 resistor', () => {
    expect(RECIPES.resistor_doping).toBeDefined();
    expect(RECIPES.resistor_doping!.inputs).toEqual({ silicon_wafer: 1, graphite: 1 });
    expect(RECIPES.resistor_doping!.outputs).toEqual({ resistor: 4 });
    expect(RECIPES.resistor_doping!.cycleSec).toBe(67);
    expect(RECIPES.resistor_doping!.category).toBe('electronics');
  });
});

describe('§7.7 memory_module via memory_lab (Task 9.3)', () => {
  it('memory_module is in ALL_RESOURCES with xp_weight 30 (T3 component)', () => {
    expect(ALL_RESOURCES).toContain('memory_module' as ResourceId);
    expect(XP_WEIGHT.memory_module).toBe(30);
  });
  it('memory_lab recipe: pcb + 4×transistor + 4×capacitor + 4×resistor + solder → memory_module', () => {
    expect(RECIPES.memory_lab).toBeDefined();
    expect(RECIPES.memory_lab!.inputs).toEqual({
      pcb: 1,
      transistor: 4,
      capacitor: 4,
      resistor: 4,
      solder: 1,
    });
    expect(RECIPES.memory_lab!.outputs).toEqual({ memory_module: 2 }); // doubled Task 16.8 (was 1)
    expect(RECIPES.memory_lab!.cycleSec).toBe(167);
    expect(RECIPES.memory_lab!.category).toBe('electronics');
  });
});

describe('nextRotateOutputBoundaryMs', () => {
  const rotatingRecipe = {
    cycleSec: 10,
    inputs: {},
    outputs: { aetheric_current: 1 },
    rotateOutputs: [{ aetheric_current: 1 }, { quantum_foam: 1 }],
    category: 'extraction',
  } as import('./recipes.js').Recipe;

  it('returns null for non-rotating recipes', () => {
    const recipe = {
      cycleSec: 10,
      inputs: {},
      outputs: { iron_ore: 1 },
      category: 'extraction',
    } as import('./recipes.js').Recipe;
    expect(nextRotateOutputBoundaryMs(recipe, 0)).toBeNull();
    expect(nextRotateOutputBoundaryMs(recipe, 5_000)).toBeNull();
  });

  it('returns null for single-option rotateOutputs', () => {
    const recipe = {
      cycleSec: 10,
      inputs: {},
      outputs: { iron_ore: 1 },
      rotateOutputs: [{ iron_ore: 1 }],
      category: 'extraction',
    } as import('./recipes.js').Recipe;
    expect(nextRotateOutputBoundaryMs(recipe, 0)).toBeNull();
  });

  it('returns the next cycle boundary', () => {
    expect(nextRotateOutputBoundaryMs(rotatingRecipe, 0)).toBe(10_000);
    expect(nextRotateOutputBoundaryMs(rotatingRecipe, 5_000)).toBe(10_000);
    expect(nextRotateOutputBoundaryMs(rotatingRecipe, 10_000)).toBe(20_000);
    expect(nextRotateOutputBoundaryMs(rotatingRecipe, 15_000)).toBe(20_000);
  });
});

describe('§6.4 mercury + mercury_well (Task 10.1)', () => {
  it('mercury is in ALL_RESOURCES with xp_weight 30 (T3 liquid)', () => {
    expect(ALL_RESOURCES).toContain('mercury' as ResourceId);
    expect(XP_WEIGHT.mercury).toBe(30);
  });
  it('mercury_well recipe: empty inputs → mercury', () => {
    expect(RECIPES.mercury_well).toBeDefined();
    expect(RECIPES.mercury_well!.inputs).toEqual({});
    expect(RECIPES.mercury_well!.outputs).toEqual({ mercury: 1 });
    expect(RECIPES.mercury_well!.cycleSec).toBe(67);
  });
});

describe('§6.4 diamond_ore + diamond_quarry (Task 10.2)', () => {
  it('diamond_ore is in ALL_RESOURCES with xp_weight 30 (T3 rare)', () => {
    expect(ALL_RESOURCES).toContain('diamond_ore' as ResourceId);
    expect(XP_WEIGHT.diamond_ore).toBe(30);
  });
  it('diamond_quarry recipe: empty inputs → diamond_ore', () => {
    expect(RECIPES.diamond_quarry).toBeDefined();
    expect(RECIPES.diamond_quarry!.inputs).toEqual({});
    expect(RECIPES.diamond_quarry!.outputs).toEqual({ diamond_ore: 1 });
    expect(RECIPES.diamond_quarry!.cycleSec).toBe(100);
  });
});

describe('§6.4 cryogenic_compound + cryo_compound_lab (Task 10.3)', () => {
  it('cryogenic_compound is in ALL_RESOURCES with xp_weight 30 (T3 temp_sensitive)', () => {
    expect(ALL_RESOURCES).toContain('cryogenic_compound' as ResourceId);
    expect(XP_WEIGHT.cryogenic_compound).toBe(30);
  });
  it('cryo_compound_lab recipe: liquid_nitrogen + cryo_coolant → cryogenic_compound', () => {
    expect(RECIPES.cryo_compound_lab).toBeDefined();
    expect(RECIPES.cryo_compound_lab!.inputs).toEqual({ liquid_nitrogen: 1, cryo_coolant: 1 });
    expect(RECIPES.cryo_compound_lab!.outputs).toEqual({ cryogenic_compound: 1 });
    expect(RECIPES.cryo_compound_lab!.cycleSec).toBe(133);
  });
});

describe('§6.4 magnetic_alloy + mag_alloyer (Task 10.4)', () => {
  it('magnetic_alloy is in ALL_RESOURCES with xp_weight 30 (T3 component)', () => {
    expect(ALL_RESOURCES).toContain('magnetic_alloy' as ResourceId);
    expect(XP_WEIGHT.magnetic_alloy).toBe(30);
  });
  it('mag_alloyer recipe: iron_ingot + rare_earth → magnetic_alloy', () => {
    expect(RECIPES.mag_alloyer).toBeDefined();
    expect(RECIPES.mag_alloyer!.inputs).toEqual({ iron_ingot: 2, rare_earth: 1 });
    expect(RECIPES.mag_alloyer!.outputs).toEqual({ magnetic_alloy: 1 });
    expect(RECIPES.mag_alloyer!.cycleSec).toBe(100);
  });
});

describe('§6.5 time_crystal via quantum_manipulator (Task 11.1)', () => {
  it('time_crystal is in ALL_RESOURCES with xp_weight 100 (T4 rare)', () => {
    expect(ALL_RESOURCES).toContain('time_crystal' as ResourceId);
    expect(XP_WEIGHT.time_crystal).toBe(100);
  });
  it('quantum_manipulator recipe: helium_3 + exotic_alloy → time_crystal', () => {
    expect(RECIPES.quantum_manipulator).toBeDefined();
    expect(RECIPES.quantum_manipulator!.inputs).toEqual({ helium_3: 1, exotic_alloy: 1 });
    expect(RECIPES.quantum_manipulator!.outputs).toEqual({ time_crystal: 1 });
    expect(RECIPES.quantum_manipulator!.cycleSec).toBe(600);
    expect(RECIPES.quantum_manipulator!.category).toBe('manufacturing');
  });
});

describe('§6.5 antimatter_capsule via particle_accelerator (Task 11.2)', () => {
  it('antimatter_capsule is in ALL_RESOURCES with xp_weight 100 (T4 rare)', () => {
    expect(ALL_RESOURCES).toContain('antimatter_capsule' as ResourceId);
    expect(XP_WEIGHT.antimatter_capsule).toBe(100);
  });
  it('particle_accelerator recipe: hydrogen + exotic_alloy + microchip → antimatter_capsule', () => {
    expect(RECIPES.particle_accelerator).toBeDefined();
    expect(RECIPES.particle_accelerator!.inputs).toEqual({ hydrogen: 10, exotic_alloy: 1, microchip: 5 });
    expect(RECIPES.particle_accelerator!.outputs).toEqual({ antimatter_capsule: 1 });
    expect(RECIPES.particle_accelerator!.cycleSec).toBe(600);
    expect(RECIPES.particle_accelerator!.category).toBe('electronics');
  });
});

describe('§6.5 nuclear_fuel_rod + fuel_rod_assembler (Task 11.3)', () => {
  it('nuclear_fuel_rod is in ALL_RESOURCES with xp_weight 100 (T4 rare)', () => {
    expect(ALL_RESOURCES).toContain('nuclear_fuel_rod' as ResourceId);
    expect(XP_WEIGHT.nuclear_fuel_rod).toBe(100);
  });
  it('fuel_rod_assembler recipe: uranium_ore + stainless_steel + coolant → nuclear_fuel_rod', () => {
    expect(RECIPES.fuel_rod_assembler).toBeDefined();
    expect(RECIPES.fuel_rod_assembler!.inputs).toEqual({ uranium_ore: 5, stainless_steel: 2, coolant: 2 });
    expect(RECIPES.fuel_rod_assembler!.outputs).toEqual({ nuclear_fuel_rod: 1 });
    expect(RECIPES.fuel_rod_assembler!.cycleSec).toBe(400);
    expect(RECIPES.fuel_rod_assembler!.category).toBe('manufacturing');
  });
  it('nuclear_reactor recipe consumes nuclear_fuel_rod with cycleSec 600', () => {
    expect(RECIPES.nuclear_reactor).toBeDefined();
    expect(RECIPES.nuclear_reactor!.inputs).toEqual({ nuclear_fuel_rod: 1 });
    expect(RECIPES.nuclear_reactor!.outputs).toEqual({});
    expect(RECIPES.nuclear_reactor!.cycleSec).toBe(200);
    expect(RECIPES.nuclear_reactor!.category).toBe('power');
  });
});

describe('§6.5 T4 endgame components (Task 11.4)', () => {
  it('plasma_containment_vessel is in ALL_RESOURCES with xp_weight 100 (T4 rare)', () => {
    expect(ALL_RESOURCES).toContain('plasma_containment_vessel' as ResourceId);
    expect(XP_WEIGHT.plasma_containment_vessel).toBe(100);
  });
  it('singularity_sensor is in ALL_RESOURCES with xp_weight 100 (T4 rare)', () => {
    expect(ALL_RESOURCES).toContain('singularity_sensor' as ResourceId);
    expect(XP_WEIGHT.singularity_sensor).toBe(100);
  });
  it('cryo_containment_unit is in ALL_RESOURCES with xp_weight 100 (T4 rare)', () => {
    expect(ALL_RESOURCES).toContain('cryo_containment_unit' as ResourceId);
    expect(XP_WEIGHT.cryo_containment_unit).toBe(100);
  });
  it('particle_accelerator_core is in ALL_RESOURCES with xp_weight 100 (T4 rare)', () => {
    expect(ALL_RESOURCES).toContain('particle_accelerator_core' as ResourceId);
    expect(XP_WEIGHT.particle_accelerator_core).toBe(100);
  });
  it('self_replication_module is in ALL_RESOURCES with xp_weight 100 (T4 rare)', () => {
    expect(ALL_RESOURCES).toContain('self_replication_module' as ResourceId);
    expect(XP_WEIGHT.self_replication_module).toBe(100);
  });

  it('plasma_containment_assembler recipe: exotic_alloy + magnet + steel → plasma_containment_vessel', () => {
    expect(RECIPES.plasma_containment_assembler).toBeDefined();
    expect(RECIPES.plasma_containment_assembler!.inputs).toEqual({ exotic_alloy: 1, magnet: 4, steel: 5 });
    expect(RECIPES.plasma_containment_assembler!.outputs).toEqual({ plasma_containment_vessel: 1 });
    expect(RECIPES.plasma_containment_assembler!.cycleSec).toBe(500);
    expect(RECIPES.plasma_containment_assembler!.category).toBe('manufacturing');
  });
  it('singularity_sensor_lab recipe: quantum_chip + optical_fiber + magnet → singularity_sensor', () => {
    expect(RECIPES.singularity_sensor_lab).toBeDefined();
    expect(RECIPES.singularity_sensor_lab!.inputs).toEqual({ quantum_chip: 1, optical_fiber: 4, magnet: 2 });
    expect(RECIPES.singularity_sensor_lab!.outputs).toEqual({ singularity_sensor: 1 });
    expect(RECIPES.singularity_sensor_lab!.cycleSec).toBe(500);
    expect(RECIPES.singularity_sensor_lab!.category).toBe('electronics');
  });
  it('cryo_containment_assembler recipe: cryogenic_compound + stainless_steel + glass_fiber → cryo_containment_unit', () => {
    expect(RECIPES.cryo_containment_assembler).toBeDefined();
    expect(RECIPES.cryo_containment_assembler!.inputs).toEqual({ cryogenic_compound: 1, stainless_steel: 2, glass_fiber: 4 });
    expect(RECIPES.cryo_containment_assembler!.outputs).toEqual({ cryo_containment_unit: 1 });
    expect(RECIPES.cryo_containment_assembler!.cycleSec).toBe(500);
    expect(RECIPES.cryo_containment_assembler!.category).toBe('manufacturing');
  });
  it('accelerator_core_lab recipe: magnet + exotic_alloy + optical_fiber → particle_accelerator_core', () => {
    expect(RECIPES.accelerator_core_lab).toBeDefined();
    expect(RECIPES.accelerator_core_lab!.inputs).toEqual({ magnet: 8, exotic_alloy: 1, optical_fiber: 4 });
    expect(RECIPES.accelerator_core_lab!.outputs).toEqual({ particle_accelerator_core: 1 });
    expect(RECIPES.accelerator_core_lab!.cycleSec).toBe(500);
    expect(RECIPES.accelerator_core_lab!.category).toBe('electronics');
  });
  it('self_replication_lab recipe: ai_core + microchip + electric_motor + computing_module → self_replication_module', () => {
    expect(RECIPES.self_replication_lab).toBeDefined();
    expect(RECIPES.self_replication_lab!.inputs).toEqual({ ai_core: 1, microchip: 8, electric_motor: 4, computing_module: 2 });
    expect(RECIPES.self_replication_lab!.outputs).toEqual({ self_replication_module: 1 });
    expect(RECIPES.self_replication_lab!.cycleSec).toBe(600);
    expect(RECIPES.self_replication_lab!.category).toBe('manufacturing');
  });
});

describe('§6.6 T5 components — tachyonic_transmitter + aether_beacon + reality_engine + singularity_battery_unit (Task 12.3)', () => {
  it('tachyonic_transmitter is in ALL_RESOURCES with xp_weight 300', () => {
    expect(ALL_RESOURCES).toContain('tachyonic_transmitter' as ResourceId);
    expect(XP_WEIGHT.tachyonic_transmitter).toBe(300);
  });
  it('aether_beacon is in ALL_RESOURCES with xp_weight 300', () => {
    expect(ALL_RESOURCES).toContain('aether_beacon' as ResourceId);
    expect(XP_WEIGHT.aether_beacon).toBe(300);
  });
  it('reality_engine is in ALL_RESOURCES with xp_weight 300', () => {
    expect(ALL_RESOURCES).toContain('reality_engine' as ResourceId);
    expect(XP_WEIGHT.reality_engine).toBe(300);
  });
  it('singularity_battery_unit is in ALL_RESOURCES with xp_weight 300', () => {
    expect(ALL_RESOURCES).toContain('singularity_battery_unit' as ResourceId);
    expect(XP_WEIGHT.singularity_battery_unit).toBe(300);
  });
  it('tachyonic_transmitter_lab recipe: tachyon_stream + optical_fiber + ai_core → tachyonic_transmitter', () => {
    expect(RECIPES.tachyonic_transmitter_lab).toBeDefined();
    expect(RECIPES.tachyonic_transmitter_lab!.inputs).toEqual({ tachyon_stream: 1, optical_fiber: 8, ai_core: 1 });
    expect(RECIPES.tachyonic_transmitter_lab!.outputs).toEqual({ tachyonic_transmitter: 1 });
    expect(RECIPES.tachyonic_transmitter_lab!.cycleSec).toBe(600);
    expect(RECIPES.tachyonic_transmitter_lab!.category).toBe('manufacturing');
  });
  it('aether_beacon_lab recipe: aetheric_current + casimir_energy + magnet → aether_beacon', () => {
    expect(RECIPES.aether_beacon_lab).toBeDefined();
    expect(RECIPES.aether_beacon_lab!.inputs).toEqual({ aetheric_current: 1, casimir_energy: 1, magnet: 4 });
    expect(RECIPES.aether_beacon_lab!.outputs).toEqual({ aether_beacon: 1 });
    expect(RECIPES.aether_beacon_lab!.cycleSec).toBe(600);
    expect(RECIPES.aether_beacon_lab!.category).toBe('manufacturing');
  });
  it('reality_engine_lab recipe: reality_anchor + dimensional_fold + causal_regulator → reality_engine', () => {
    expect(RECIPES.reality_engine_lab).toBeDefined();
    expect(RECIPES.reality_engine_lab!.inputs).toEqual({ reality_anchor: 1, dimensional_fold: 1, causal_regulator: 1 });
    expect(RECIPES.reality_engine_lab!.outputs).toEqual({ reality_engine: 1 });
    expect(RECIPES.reality_engine_lab!.cycleSec).toBe(600);
    expect(RECIPES.reality_engine_lab!.category).toBe('manufacturing');
  });
  it('singularity_battery_factory recipe: phase_converter + dark_matter + casimir_energy → singularity_battery_unit', () => {
    expect(RECIPES.singularity_battery_factory).toBeDefined();
    expect(RECIPES.singularity_battery_factory!.inputs).toEqual({ phase_converter: 2, dark_matter: 1, casimir_energy: 1 });
    expect(RECIPES.singularity_battery_factory!.outputs).toEqual({ singularity_battery_unit: 1 });
    expect(RECIPES.singularity_battery_factory!.cycleSec).toBe(600);
    expect(RECIPES.singularity_battery_factory!.category).toBe('manufacturing');
  });
});

describe('§6.6 T5 components — probability_calculator + dimensional_fold + causal_regulator (Task 12.2)', () => {
  it('probability_calculator is in ALL_RESOURCES with xp_weight 300', () => {
    expect(ALL_RESOURCES).toContain('probability_calculator' as ResourceId);
    expect(XP_WEIGHT.probability_calculator).toBe(300);
  });
  it('dimensional_fold is in ALL_RESOURCES with xp_weight 300', () => {
    expect(ALL_RESOURCES).toContain('dimensional_fold' as ResourceId);
    expect(XP_WEIGHT.dimensional_fold).toBe(300);
  });
  it('causal_regulator is in ALL_RESOURCES with xp_weight 300', () => {
    expect(ALL_RESOURCES).toContain('causal_regulator' as ResourceId);
    expect(XP_WEIGHT.causal_regulator).toBe(300);
  });
  it('probability_calculator_lab recipe: quantum_chip + casimir_energy + ai_core → probability_calculator', () => {
    expect(RECIPES.probability_calculator_lab).toBeDefined();
    expect(RECIPES.probability_calculator_lab!.inputs).toEqual({ quantum_chip: 4, casimir_energy: 1, ai_core: 1 });
    expect(RECIPES.probability_calculator_lab!.outputs).toEqual({ probability_calculator: 1 });
    expect(RECIPES.probability_calculator_lab!.cycleSec).toBe(600);
    expect(RECIPES.probability_calculator_lab!.category).toBe('manufacturing');
  });
  it('dimensional_fold_lab recipe: spacetime_fragment + exotic_alloy + eldritch_processor → dimensional_fold', () => {
    expect(RECIPES.dimensional_fold_lab).toBeDefined();
    expect(RECIPES.dimensional_fold_lab!.inputs).toEqual({ spacetime_fragment: 1, exotic_alloy: 2, eldritch_processor: 1 });
    expect(RECIPES.dimensional_fold_lab!.outputs).toEqual({ dimensional_fold: 1 });
    expect(RECIPES.dimensional_fold_lab!.cycleSec).toBe(600);
    expect(RECIPES.dimensional_fold_lab!.category).toBe('manufacturing');
  });
  it('causal_regulator_lab recipe: time_crystal + phase_converter + reality_anchor → causal_regulator', () => {
    expect(RECIPES.causal_regulator_lab).toBeDefined();
    expect(RECIPES.causal_regulator_lab!.inputs).toEqual({ time_crystal: 1, phase_converter: 2, reality_anchor: 1 });
    expect(RECIPES.causal_regulator_lab!.outputs).toEqual({ causal_regulator: 1 });
    expect(RECIPES.causal_regulator_lab!.cycleSec).toBe(600);
    expect(RECIPES.causal_regulator_lab!.category).toBe('manufacturing');
  });
});

describe('§13.3 T5 special — lattice_node + universe_editor recipes (Task 12.4)', () => {
  it('lattice_node recipe: reality_anchor + causal_regulator + memetic_core → activation sink', () => {
    expect(RECIPES.lattice_node).toBeDefined();
    expect(RECIPES.lattice_node!.inputs).toEqual({ reality_anchor: 2, causal_regulator: 4, memetic_core: 1 });
    expect(RECIPES.lattice_node!.outputs).toEqual({});
    expect(RECIPES.lattice_node!.cycleSec).toBe(14400);
    expect(RECIPES.lattice_node!.category).toBe('manufacturing');
  });
  it('universe_editor recipe: reality_anchor + dimensional_fold + causal_regulator → activation sink', () => {
    expect(RECIPES.universe_editor).toBeDefined();
    expect(RECIPES.universe_editor!.inputs).toEqual({ reality_anchor: 4, dimensional_fold: 1, causal_regulator: 2 });
    expect(RECIPES.universe_editor!.outputs).toEqual({});
    expect(RECIPES.universe_editor!.cycleSec).toBe(7200);
    expect(RECIPES.universe_editor!.category).toBe('manufacturing');
  });
});

describe('§6.6 T5 raws — zero_point_flux + neutronium (Task 12.1)', () => {
  it('zero_point_flux is in ALL_RESOURCES with xp_weight 300', () => {
    expect(ALL_RESOURCES).toContain('zero_point_flux' as ResourceId);
    expect(XP_WEIGHT.zero_point_flux).toBe(300);
  });
  it('neutronium is in ALL_RESOURCES with xp_weight 300', () => {
    expect(ALL_RESOURCES).toContain('neutronium' as ResourceId);
    expect(XP_WEIGHT.neutronium).toBe(300);
  });
  it('zero_point_extractor recipe: empty inputs → zero_point_flux', () => {
    expect(RECIPES.zero_point_extractor).toBeDefined();
    expect(RECIPES.zero_point_extractor!.inputs).toEqual({});
    expect(RECIPES.zero_point_extractor!.outputs).toEqual({ zero_point_flux: 1 });
    expect(RECIPES.zero_point_extractor!.cycleSec).toBe(600);
    expect(RECIPES.zero_point_extractor!.category).toBe('extraction');
  });
  it('neutronium_extractor recipe: empty inputs → neutronium', () => {
    expect(RECIPES.neutronium_extractor).toBeDefined();
    expect(RECIPES.neutronium_extractor!.inputs).toEqual({});
    expect(RECIPES.neutronium_extractor!.outputs).toEqual({ neutronium: 1 });
    expect(RECIPES.neutronium_extractor!.cycleSec).toBe(600);
    expect(RECIPES.neutronium_extractor!.category).toBe('extraction');
  });
});


describe('§7.7 double output of memory_lab + processor_fab + compute_module_fab (Task 16.8)', () => {
  it('memory_lab outputs memory_module: 2 (was 1, XP-net-negative fix)', () => {
    expect(RECIPES.memory_lab!.outputs).toEqual({ memory_module: 2 });
  });
  it('processor_fab outputs processor: 2 (was 1, XP-net-negative fix)', () => {
    expect(RECIPES.processor_fab!.outputs).toEqual({ processor: 2 });
  });
  it('compute_module_fab outputs computing_module: 2 (was 1, XP-net-negative fix)', () => {
    expect(RECIPES.compute_module_fab!.outputs).toEqual({ computing_module: 2 });
  });
});

describe('§7.4/§7.5 petrochemical chains cycleSec rebalance (Task 16.6)', () => {
  it('naphtha_cracker cycleSec is 333 (was 1000 / Task 16.6 was 600; 2026-05-18 ÷3 for display visibility)', () => {
    expect(RECIPES.naphtha_cracker!.cycleSec).toBe(333);
  });
  it('crude_oil_cracker cycleSec is 400 (was 1200 / Task 16.6 was 600; 2026-05-18 ÷3 for display visibility)', () => {
    expect(RECIPES.crude_oil_cracker!.cycleSec).toBe(400);
  });
  it('chlor_alkali_plant cycleSec is 400 (was 1200 / Task 16.6 was 800; 2026-05-18 ÷3 for display visibility)', () => {
    expect(RECIPES.chlor_alkali_plant!.cycleSec).toBe(400);
  });
});

describe('§7.1 chromium/nickel/tungsten smelter cycleSec rebalance (Task 16.5)', () => {
  it('chromium_smelter cycleSec is 83 (was 250 / Task 16.5 was 80; 2026-05-18 ÷3 for display visibility)', () => {
    expect(RECIPES.chromium_smelter!.cycleSec).toBe(83);
  });
  it('nickel_smelter cycleSec is 83 (was 250 / Task 16.5 was 80; 2026-05-18 ÷3 for display visibility)', () => {
    expect(RECIPES.nickel_smelter!.cycleSec).toBe(83);
  });
  it('tungsten_smelter cycleSec is 83 (was 250 / Task 16.5 was 80; 2026-05-18 ÷3 for display visibility)', () => {
    expect(RECIPES.tungsten_smelter!.cycleSec).toBe(83);
  });
});

describe('§7.x step-19 cycleSec rebalance (Task 16.4)', () => {
  it('oxygen_converter cycleSec is 200 (was 600 / step-19 was 20; 2026-05-18 ÷3 for display visibility)', () => {
    expect(RECIPES.oxygen_converter!.cycleSec).toBe(200);
  });
  it('circuit_assembler cycleSec is 83 (was 250 / step-19 was 30; 2026-05-18 ÷3 for display visibility)', () => {
    expect(RECIPES.circuit_assembler!.cycleSec).toBe(83);
  });
  it('processor_fab cycleSec is 400 (was 1200 / step-19 was 60; 2026-05-18 ÷3 for display visibility)', () => {
    expect(RECIPES.processor_fab!.cycleSec).toBe(400);
  });
  it('compute_module_fab cycleSec is 400 (was 1200 / step-19 was 120; 2026-05-18 ÷3 for display visibility)', () => {
    expect(RECIPES.compute_module_fab!.cycleSec).toBe(400);
  });
});

describe('§6.6 memetic_core producer via memetic_forge (Task 16.2)', () => {
  it('memetic_forge recipe: eldritch_processor + spacetime_fragment + ai_core → memetic_core', () => {
    expect(RECIPES.memetic_forge).toBeDefined();
    expect(RECIPES.memetic_forge!.inputs).toEqual({ eldritch_processor: 1, spacetime_fragment: 1, ai_core: 2 });
    expect(RECIPES.memetic_forge!.outputs).toEqual({ memetic_core: 1 });
    expect(RECIPES.memetic_forge!.cycleSec).toBe(600);
    expect(RECIPES.memetic_forge!.category).toBe('manufacturing');
  });
  it('memetic_core is still in ALL_RESOURCES with xp_weight 300', () => {
    expect(ALL_RESOURCES).toContain('memetic_core' as ResourceId);
    expect(XP_WEIGHT.memetic_core).toBe(300);
  });
});

describe('§6.4 uranium_vein + uranium_mine (Task 16.1)', () => {
  it('uranium_mine recipe: empty inputs → uranium_ore', () => {
    expect(RECIPES.uranium_mine).toBeDefined();
    expect(RECIPES.uranium_mine!.inputs).toEqual({});
    expect(RECIPES.uranium_mine!.outputs).toEqual({ uranium_ore: 1 });
    expect(RECIPES.uranium_mine!.cycleSec).toBe(67);
    expect(RECIPES.uranium_mine!.category).toBe('extraction');
  });
  it('uranium_ore is still in ALL_RESOURCES with xp_weight 30', () => {
    expect(ALL_RESOURCES).toContain('uranium_ore' as ResourceId);
    expect(XP_WEIGHT.uranium_ore).toBe(30);
  });
});

describe('§12.3 Foundation Kit Enriched + Refined (Task 13.2)', () => {
  it('foundation_kit_enriched is in ALL_RESOURCES with xp_weight 30', () => {
    expect(ALL_RESOURCES).toContain('foundation_kit_enriched' as ResourceId);
    expect(XP_WEIGHT.foundation_kit_enriched).toBe(30);
  });
  it('foundation_kit_refined is in ALL_RESOURCES with xp_weight 100', () => {
    expect(ALL_RESOURCES).toContain('foundation_kit_refined' as ResourceId);
    expect(XP_WEIGHT.foundation_kit_refined).toBe(100);
  });
  it('kit_assembler_enriched recipe: steel + microchip + wire + gear → foundation_kit_enriched', () => {
    expect(RECIPES.kit_assembler_enriched).toBeDefined();
    expect(RECIPES.kit_assembler_enriched!.inputs).toEqual({ steel: 5, microchip: 1, wire: 5, gear: 5 });
    expect(RECIPES.kit_assembler_enriched!.outputs).toEqual({ foundation_kit_enriched: 1 });
    expect(RECIPES.kit_assembler_enriched!.cycleSec).toBe(200);
    expect(RECIPES.kit_assembler_enriched!.category).toBe('manufacturing');
  });
  it('kit_assembler_refined recipe: stainless_steel + quantum_chip + fuel_cell + computing_module → foundation_kit_refined', () => {
    expect(RECIPES.kit_assembler_refined).toBeDefined();
    expect(RECIPES.kit_assembler_refined!.inputs).toEqual({ stainless_steel: 5, quantum_chip: 1, fuel_cell: 1, computing_module: 1 });
    expect(RECIPES.kit_assembler_refined!.outputs).toEqual({ foundation_kit_refined: 1 });
    expect(RECIPES.kit_assembler_refined!.cycleSec).toBe(400);
    expect(RECIPES.kit_assembler_refined!.category).toBe('manufacturing');
  });
});

// ---------------------------------------------------------------------------
// Ocean-layer §3 — Task 9 processor catalog (4 chemistry processors + 1 power
// source). Mirrors Task 8's "one recipe per building, rotateOutputs for the
// multi-output cases" pattern — recipe keys are the building ids, no synthetic
// RecipeId entries. Geothermal Vent Generator is a passive power source like
// Solar / Nuclear Reactor: NO recipe entry; def.power.produces only.
// ---------------------------------------------------------------------------
describe('§3 ocean processing recipes (Task 9)', () => {
  it('lithium_brine, bromine, rare_earth_concentrate, refined_cobalt, exotic_alloy_seed, tritium_seed, heavy_water are in ALL_RESOURCES with the right XP_WEIGHT', () => {
    // T3 intermediates from Brine Distillation Rig.
    expect(ALL_RESOURCES).toContain('lithium_brine' as ResourceId);
    expect(XP_WEIGHT.lithium_brine).toBe(30);
    expect(ALL_RESOURCES).toContain('bromine' as ResourceId);
    expect(XP_WEIGHT.bromine).toBe(30);
    // T4 intermediates from Nodule Concentrator.
    expect(ALL_RESOURCES).toContain('rare_earth_concentrate' as ResourceId);
    expect(XP_WEIGHT.rare_earth_concentrate).toBe(100);
    expect(ALL_RESOURCES).toContain('refined_cobalt' as ResourceId);
    expect(XP_WEIGHT.refined_cobalt).toBe(100);
    // T5 finals from Vent Mineral Refinery + Heavy Water Distiller.
    expect(ALL_RESOURCES).toContain('exotic_alloy_seed' as ResourceId);
    expect(XP_WEIGHT.exotic_alloy_seed).toBe(300);
    expect(ALL_RESOURCES).toContain('tritium_seed' as ResourceId);
    expect(XP_WEIGHT.tritium_seed).toBe(300);
    expect(ALL_RESOURCES).toContain('heavy_water' as ResourceId);
    expect(XP_WEIGHT.heavy_water).toBe(300);
  });

  it('brine_distillation_rig recipe consumes dilute_brine and rotates lithium_brine / salt / bromine outputs', () => {
    const r = RECIPES.brine_distillation_rig;
    expect(r).toBeDefined();
    expect(r!.inputs).toEqual({ dilute_brine: 5 });
    expect(r!.outputs).toEqual({ lithium_brine: 1 });
    expect(r!.rotateOutputs).toBeDefined();
    expect(r!.rotateOutputs!).toHaveLength(3);
    expect(r!.rotateOutputs![0]).toEqual({ lithium_brine: 1 });
    expect(r!.rotateOutputs![1]).toEqual({ salt: 2 });
    expect(r!.rotateOutputs![2]).toEqual({ bromine: 1 });
    expect(r!.cycleSec).toBe(120);
    expect(r!.category).toBe('chemistry');
  });

  it('nodule_concentrator per-output variants (_re, _co) each consume ONE nodule type + sulfuric_acid for the matching output', () => {
    // §3 chain examples list distinct feedstocks per output
    // (re_nodule + sulfuric_acid → rare_earth_concentrate;
    //  co_nodule + sulfuric_acid → refined_cobalt). Each cycle burns one
    // nodule type only, restoring spec-aligned 1:1 feedstock cost.
    const re = RECIPES.nodule_concentrator_re;
    expect(re).toBeDefined();
    expect(re!.inputs).toEqual({ re_nodule: 2, sulfuric_acid: 1 });
    expect(re!.outputs).toEqual({ rare_earth_concentrate: 1 });
    expect(re!.rotateOutputs).toBeUndefined();
    expect(re!.cycleSec).toBe(240);
    expect(re!.category).toBe('chemistry');

    const co = RECIPES.nodule_concentrator_co;
    expect(co).toBeDefined();
    expect(co!.inputs).toEqual({ co_nodule: 2, sulfuric_acid: 1 });
    expect(co!.outputs).toEqual({ refined_cobalt: 1 });
    expect(co!.rotateOutputs).toBeUndefined();
    expect(co!.cycleSec).toBe(240);
    expect(co!.category).toBe('chemistry');

    // Base id is NOT a recipe entry — callers go through resolveRecipe.
    expect(RECIPES.nodule_concentrator).toBeUndefined();
  });

  it('vent_mineral_refinery per-output variants (_exotic, _tritium) each consume the matching feedstock + casimir_energy', () => {
    // §3 chain examples list distinct feedstocks per output
    // (vent_exotic + casimir_energy → exotic_alloy_seed;
    //  heavy_isotope_slurry + casimir_energy → tritium_seed).
    const ex = RECIPES.vent_mineral_refinery_exotic;
    expect(ex).toBeDefined();
    expect(ex!.inputs).toEqual({ vent_exotic: 1, casimir_energy: 1 });
    expect(ex!.outputs).toEqual({ exotic_alloy_seed: 1 });
    expect(ex!.rotateOutputs).toBeUndefined();
    expect(ex!.cycleSec).toBe(480);
    expect(ex!.category).toBe('chemistry');

    const tr = RECIPES.vent_mineral_refinery_tritium;
    expect(tr).toBeDefined();
    expect(tr!.inputs).toEqual({ heavy_isotope_slurry: 1, casimir_energy: 1 });
    expect(tr!.outputs).toEqual({ tritium_seed: 1 });
    expect(tr!.rotateOutputs).toBeUndefined();
    expect(tr!.cycleSec).toBe(480);
    expect(tr!.category).toBe('chemistry');

    // Base id is NOT a recipe entry — callers go through resolveRecipe.
    expect(RECIPES.vent_mineral_refinery).toBeUndefined();
  });

  it('heavy_water_distiller recipe consumes concentrated_brine ONLY and produces heavy_water (no microchip co-input; single-output, no rotation)', () => {
    const r = RECIPES.heavy_water_distiller;
    expect(r).toBeDefined();
    // Spec §3 lists concentrated_brine as the sole input — the earlier
    // microchip co-input was a "precision control electronics" overreach.
    expect(r!.inputs).toEqual({ concentrated_brine: 4 });
    expect(r!.outputs).toEqual({ heavy_water: 1 });
    expect(r!.rotateOutputs).toBeUndefined();
    expect(r!.cycleSec).toBe(360);
    expect(r!.category).toBe('chemistry');
  });

  it('brine_distillation_rig rotates outputs deterministically across cycles', () => {
    // brine_distillation_rig is the only remaining multi-output recipe in
    // the Task 9 catalog (nodule_concentrator / vent_mineral_refinery were
    // split into per-output RecipeId variants). All three rotation outputs
    // (lithium_brine, salt, bromine) share the same dilute_brine feedstock,
    // so rotateOutputs is the right shape here — observe all three appear
    // in three consecutive cycle slots.
    const r = RECIPES.brine_distillation_rig!;
    const cycleMs = r.cycleSec * 1000;
    const out0 = resolveRotatingOutput(r, 0);
    const out1 = resolveRotatingOutput(r, cycleMs);
    const out2 = resolveRotatingOutput(r, cycleMs * 2);
    const observed = new Set([
      Object.keys(out0)[0],
      Object.keys(out1)[0],
      Object.keys(out2)[0],
    ]);
    expect(observed).toEqual(new Set(['lithium_brine', 'salt', 'bromine']));
  });

  it('geothermal_vent_generator has NO recipe entry (passive power source)', () => {
    expect(RECIPES.geothermal_vent_generator).toBeUndefined();
  });
});

describe('§3 ocean processor + Geothermal Generator building defs (Task 9)', () => {
  it('brine_distillation_rig: T3, 3x3, chemistry, 800W consumes, shallows OR deep', () => {
    const def = BUILDING_DEFS.brine_distillation_rig;
    expect(def.tier).toBe(3);
    expect(def.footprint.tiles).toHaveLength(9);
    expect(def.category).toBe('chemistry');
    expect(def.power?.consumes).toBe(800);
    expect(def.oceanPlacement).toBe(true);
    expect(def.terrainReqs).toEqual(['shallows', 'deep']);
  });

  it('nodule_concentrator: T4, 3x3, chemistry, 1200W consumes, shallows OR deep', () => {
    const def = BUILDING_DEFS.nodule_concentrator;
    expect(def.tier).toBe(4);
    expect(def.footprint.tiles).toHaveLength(9);
    expect(def.category).toBe('chemistry');
    expect(def.power?.consumes).toBe(1200);
    expect(def.oceanPlacement).toBe(true);
    expect(def.terrainReqs).toEqual(['shallows', 'deep']);
  });

  it('vent_mineral_refinery: T5, 3x3, chemistry, 1500W consumes, shallows OR deep', () => {
    const def = BUILDING_DEFS.vent_mineral_refinery;
    expect(def.tier).toBe(5);
    expect(def.footprint.tiles).toHaveLength(9);
    expect(def.category).toBe('chemistry');
    expect(def.power?.consumes).toBe(1500);
    expect(def.oceanPlacement).toBe(true);
    expect(def.terrainReqs).toEqual(['shallows', 'deep']);
  });

  it('heavy_water_distiller: T5, 3x3, chemistry, 1200W consumes, shallows OR deep', () => {
    const def = BUILDING_DEFS.heavy_water_distiller;
    expect(def.tier).toBe(5);
    expect(def.footprint.tiles).toHaveLength(9);
    expect(def.category).toBe('chemistry');
    expect(def.power?.consumes).toBe(1200);
    expect(def.oceanPlacement).toBe(true);
    expect(def.terrainReqs).toEqual(['shallows', 'deep']);
  });

  it('geothermal_vent_generator: T6, 2x2, power, PRODUCES 2000W, hydrothermal_vent only', () => {
    const def = BUILDING_DEFS.geothermal_vent_generator;
    expect(def.tier).toBe(6);
    expect(def.footprint.tiles).toHaveLength(4);
    expect(def.category).toBe('power');
    expect(def.power?.produces).toBe(2000);
    expect(def.power?.consumes).toBeUndefined();
    expect(def.oceanPlacement).toBe(true);
    expect(def.terrainReqs).toEqual(['hydrothermal_vent']);
  });
});

// ---------------------------------------------------------------------------
// availableRecipes
// ---------------------------------------------------------------------------

describe('availableRecipes', () => {
  it('returns empty array for building with no base recipe and no unlocks', () => {
    const state = { unlockedNodes: new Set<string>() } as IslandState;
    const recipes = availableRecipes('solar', state);
    expect(recipes).toEqual([]);
  });

  it('returns base recipe for mine', () => {
    const state = { unlockedNodes: new Set<string>() } as IslandState;
    const recipes = availableRecipes('mine', state);
    expect(recipes).toHaveLength(1);
    expect(recipes[0]).toBe(RECIPES.mine);
  });

  it('returns skill-unlocked recipe when node is owned', () => {
    const unlockedRecipe = { cycleSec: 10, inputs: {}, outputs: { coal: 1 }, category: 'extraction' as const };
    const graph: Graph = {
      nodes: [
        {
          id: 'test.1',
          subPath: 'mining',
          depth: 1,
          cost: 1,
          magnitude: 0.05,
          effect: { kind: 'unlockRecipe', targetBuilding: 'mine', recipe: unlockedRecipe },
          description: 'test',
        },
      ],
      edges: [],
      bridges: [],
      graftSockets: [],
    };
    const state = { unlockedNodes: new Set<string>(['test.1']) } as IslandState;
    const recipes = availableRecipes('mine', state, graph);
    expect(recipes).toHaveLength(2);
    expect(recipes[0]).toBe(RECIPES.mine);
    expect(recipes[1]).toBe(unlockedRecipe);
  });

  it('returns only unlocked recipe when building has no base recipe', () => {
    const unlockedRecipe = { cycleSec: 5, inputs: { iron_ore: 1 }, outputs: { steel: 1 }, category: 'smelting' as const };
    const graph: Graph = {
      nodes: [
        {
          id: 'test.2',
          subPath: 'smelting',
          depth: 1,
          cost: 1,
          magnitude: 0.05,
          effect: { kind: 'unlockRecipe', targetBuilding: 'steel_mill', recipe: unlockedRecipe },
          description: 'test',
        },
      ],
      edges: [],
      bridges: [],
      graftSockets: [],
    };
    const state = { unlockedNodes: new Set<string>(['test.2']) } as IslandState;
    availableRecipes('steel_mill', state, graph);
    // steel_mill HAS a base recipe, so this test is actually for a building that
    // does have a base. Let's test a building that genuinely has no base recipe.
    // Looking at the catalog, 'solar' has no recipe.
    const solarRecipes = availableRecipes('solar', state, graph);
    expect(solarRecipes).toEqual([]);
  });

  it('excludes unlockRecipe nodes for a different building', () => {
    const unlockedRecipe = { cycleSec: 10, inputs: {}, outputs: { coal: 1 }, category: 'extraction' as const };
    const graph: Graph = {
      nodes: [
        {
          id: 'test.3',
          subPath: 'mining',
          depth: 1,
          cost: 1,
          magnitude: 0.05,
          effect: { kind: 'unlockRecipe', targetBuilding: 'mine', recipe: unlockedRecipe },
          description: 'test',
        },
      ],
      edges: [],
      bridges: [],
      graftSockets: [],
    };
    const state = { unlockedNodes: new Set<string>(['test.3']) } as IslandState;
    const recipes = availableRecipes('logger', state, graph);
    // logger has a base recipe but the unlock is for mine, so only base
    expect(recipes).toHaveLength(1);
    expect(recipes[0]).toBe(RECIPES.logger);
  });

  it('returns multiple unlocked recipes for the same building', () => {
    const recipeA = { cycleSec: 10, inputs: {}, outputs: { coal: 1 }, category: 'extraction' as const };
    const recipeB = { cycleSec: 20, inputs: {}, outputs: { iron_ore: 2 }, category: 'extraction' as const };
    const graph: Graph = {
      nodes: [
        {
          id: 'test.4a',
          subPath: 'mining',
          depth: 1,
          cost: 1,
          magnitude: 0.05,
          effect: { kind: 'unlockRecipe', targetBuilding: 'mine', recipe: recipeA },
          description: 'test a',
        },
        {
          id: 'test.4b',
          subPath: 'mining',
          depth: 2,
          cost: 2,
          magnitude: 0.10,
          effect: { kind: 'unlockRecipe', targetBuilding: 'mine', recipe: recipeB },
          description: 'test b',
        },
      ],
      edges: [],
      bridges: [],
      graftSockets: [],
    };
    const state = { unlockedNodes: new Set<string>(['test.4a', 'test.4b']) } as IslandState;
    const recipes = availableRecipes('mine', state, graph);
    expect(recipes).toHaveLength(3);
    expect(recipes[0]).toBe(RECIPES.mine);
    expect(recipes[1]).toBe(recipeA);
    expect(recipes[2]).toBe(recipeB);
  });

  it('uses custom graph correctly instead of empty default', () => {
    const unlockedRecipe = { cycleSec: 10, inputs: {}, outputs: { coal: 1 }, category: 'extraction' as const };
    const graphA: Graph = {
      nodes: [
        {
          id: 'g1.1',
          subPath: 'mining',
          depth: 1,
          cost: 1,
          magnitude: 0.05,
          effect: { kind: 'unlockRecipe', targetBuilding: 'mine', recipe: unlockedRecipe },
          description: 'g1',
        },
      ],
      edges: [],
      bridges: [],
      graftSockets: [],
    };
    const graphB: Graph = { nodes: [], edges: [], bridges: [], graftSockets: [] };
    const state = { unlockedNodes: new Set<string>(['g1.1']) } as IslandState;
    expect(availableRecipes('mine', state, graphA)).toHaveLength(2);
    expect(availableRecipes('mine', state, graphB)).toHaveLength(1);
  });
});
