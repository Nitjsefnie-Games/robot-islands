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
  XP_WEIGHT,
  fuelForTier,
  nextRotateOutputBoundaryMs,
  type RecipeCategory,
  type ResourceId,
} from './recipes.js';

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
      expect(XP_WEIGHT[r], `XP_WEIGHT missing entry for ${r}`).toBeGreaterThan(0);
    }
  });

  it('every cycleSec is positive', () => {
    for (const [recipeId, recipe] of Object.entries(RECIPES)) {
      if (!recipe) continue;
      expect(recipe.cycleSec, `recipe ${recipeId} has non-positive cycleSec`).toBeGreaterThan(0);
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
});

describe('microchip chain', () => {
  it('pcb_etcher outputs pcb: 1', () => {
    expect(RECIPES.pcb_etcher!.outputs.pcb).toBe(1);
  });

  it('circuit_assembler outputs circuit_board: 1', () => {
    expect(RECIPES.circuit_assembler!.outputs.circuit_board).toBe(1);
  });

  it('processor_fab outputs processor: 1 and inputs circuit_board: 2', () => {
    expect(RECIPES.processor_fab!.outputs.processor).toBe(1);
    expect(RECIPES.processor_fab!.inputs.circuit_board).toBe(2);
  });

  it('compute_module_fab outputs computing_module: 1', () => {
    expect(RECIPES.compute_module_fab!.outputs.computing_module).toBe(1);
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
    expect(r.inputs.steel).toBe(50);
    expect(r.inputs.orbital_insertion_package).toBe(1);
    expect(r.cycleSec).toBe(3600);
    expect(r.category).toBe('manufacturing');
  });

  it('comm_sat_assembly has correct inputs, outputs, and cycleSec', () => {
    const r = RECIPES.comm_sat_assembly!;
    expect(r.outputs.comm_sat).toBe(1);
    expect(r.inputs.exotic_alloy).toBe(6);
    expect(r.inputs.ai_core).toBe(1);
    expect(r.inputs.wire).toBe(200);
    expect(r.inputs.orbital_insertion_package).toBe(1);
    expect(r.cycleSec).toBe(3600);
    expect(r.category).toBe('manufacturing');
  });

  it('sweeper_sat_assembly has correct inputs, outputs, and cycleSec', () => {
    const r = RECIPES.sweeper_sat_assembly!;
    expect(r.outputs.sweeper_sat).toBe(1);
    expect(r.inputs.exotic_alloy).toBe(4);
    expect(r.inputs.ai_core).toBe(1);
    expect(r.inputs.steel).toBe(100);
    expect(r.inputs.gear).toBe(20);
    expect(r.inputs.orbital_insertion_package).toBe(1);
    expect(r.cycleSec).toBe(3600);
    expect(r.category).toBe('manufacturing');
  });

  it('orbital_insertion_assembly has correct inputs, outputs, and cycleSec', () => {
    const r = RECIPES.orbital_insertion_assembly!;
    expect(r.outputs.orbital_insertion_package).toBe(1);
    expect(r.inputs.iron_ingot).toBe(100);
    expect(r.inputs.stone).toBe(30);
    expect(r.inputs.glass).toBe(20);
    expect(r.inputs.pcb).toBe(10);
    expect(r.inputs.ai_core).toBe(5);
    expect(r.cycleSec).toBe(1800);
    expect(r.category).toBe('manufacturing');
  });

  it('repair_pack_assembly has correct inputs, outputs, and cycleSec', () => {
    const r = RECIPES.repair_pack_assembly!;
    expect(r.outputs.repair_pack).toBe(1);
    expect(r.inputs.steel).toBe(50);
    expect(r.inputs.gear).toBe(10);
    expect(r.inputs.exotic_alloy).toBe(2);
    expect(r.inputs.microchip).toBe(5);
    expect(r.cycleSec).toBe(1800);
    expect(r.category).toBe('manufacturing');
  });

  it('antimatter_refinery recipe is unchanged', () => {
    const r = RECIPES.antimatter_refinery!;
    expect(r.outputs.antimatter_propellant).toBe(1);
    expect(r.inputs.exotic_alloy).toBe(1);
    expect(r.inputs.reality_anchor).toBe(1);
    expect(r.inputs.casimir_energy).toBe(2);
    expect(r.cycleSec).toBe(7200);
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
    expect(RECIPES.limekiln!.inputs).toEqual({ limestone: 1 });
    expect(RECIPES.limekiln!.outputs).toEqual({ quicklime: 1 });
    expect(RECIPES.limekiln!.cycleSec).toBe(120);
  });
  it('lime_slaker recipe exists with quicklime + fresh_water input and slaked_lime output', () => {
    expect(RECIPES.lime_slaker).toBeDefined();
    expect(RECIPES.lime_slaker!.inputs).toEqual({ quicklime: 1, fresh_water: 1 });
    expect(RECIPES.lime_slaker!.outputs).toEqual({ slaked_lime: 1 });
    expect(RECIPES.lime_slaker!.cycleSec).toBe(120);
  });
});

describe('§6.2 T1 refined — brick (Task 2.2)', () => {
  it('brick is in ALL_RESOURCES with xp_weight 3', () => {
    expect(ALL_RESOURCES).toContain('brick' as ResourceId);
    expect(XP_WEIGHT.brick).toBe(3);
  });
  it('brick_kiln recipe exists with clay input and brick output', () => {
    expect(RECIPES.brick_kiln).toBeDefined();
    expect(RECIPES.brick_kiln!.inputs).toEqual({ clay: 2 });
    expect(RECIPES.brick_kiln!.outputs).toEqual({ brick: 1 });
    expect(RECIPES.brick_kiln!.cycleSec).toBe(120);
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
    expect(RECIPES.mortar_mixer!.cycleSec).toBe(120);
  });
  it('cement_mill recipe: quicklime + sand + clay → cement', () => {
    expect(RECIPES.cement_mill).toBeDefined();
    expect(RECIPES.cement_mill!.inputs).toEqual({ quicklime: 1, sand: 1, clay: 1 });
    expect(RECIPES.cement_mill!.outputs).toEqual({ cement: 1 });
    expect(RECIPES.cement_mill!.cycleSec).toBe(200);
  });
  it('concrete_plant recipe: cement + sand + fresh_water → concrete', () => {
    expect(RECIPES.concrete_plant).toBeDefined();
    expect(RECIPES.concrete_plant!.inputs).toEqual({ cement: 1, sand: 2, fresh_water: 1 });
    expect(RECIPES.concrete_plant!.outputs).toEqual({ concrete: 1 });
    expect(RECIPES.concrete_plant!.cycleSec).toBe(200);
  });
});

describe('§6.2 T1 refined — charcoal (Task 2.4)', () => {
  it('charcoal is in ALL_RESOURCES with xp_weight 3', () => {
    expect(ALL_RESOURCES).toContain('charcoal' as ResourceId);
    expect(XP_WEIGHT.charcoal).toBe(3);
  });
  it('charcoal_kiln recipe: 2 wood → 1 charcoal', () => {
    expect(RECIPES.charcoal_kiln).toBeDefined();
    expect(RECIPES.charcoal_kiln!.inputs).toEqual({ wood: 2 });
    expect(RECIPES.charcoal_kiln!.outputs).toEqual({ charcoal: 1 });
    expect(RECIPES.charcoal_kiln!.cycleSec).toBe(100);
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
    expect(RECIPES.plank_mill!.cycleSec).toBe(80);
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
    expect(RECIPES.copper_smelter!.cycleSec).toBe(80);
  });
  it('tin_smelter recipe: tin_ore + coal → tin_ingot', () => {
    expect(RECIPES.tin_smelter).toBeDefined();
    expect(RECIPES.tin_smelter!.inputs).toEqual({ tin_ore: 1, coal: 1 });
    expect(RECIPES.tin_smelter!.outputs).toEqual({ tin_ingot: 1 });
    expect(RECIPES.tin_smelter!.cycleSec).toBe(80);
  });
  it('lead_smelter recipe: lead_ore + coal → lead_ingot', () => {
    expect(RECIPES.lead_smelter).toBeDefined();
    expect(RECIPES.lead_smelter!.inputs).toEqual({ lead_ore: 1, coal: 1 });
    expect(RECIPES.lead_smelter!.outputs).toEqual({ lead_ingot: 1 });
    expect(RECIPES.lead_smelter!.cycleSec).toBe(80);
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
