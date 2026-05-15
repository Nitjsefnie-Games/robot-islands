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

describe('§6.2/§7.2 solder + solder_alloyer (Task 2.7)', () => {
  it('solder is in ALL_RESOURCES with xp_weight 10 (T2 component)', () => {
    expect(ALL_RESOURCES).toContain('solder' as ResourceId);
    expect(XP_WEIGHT.solder).toBe(10);
  });
  it('solder_alloyer recipe: tin_ingot + lead_ingot → 2 solder', () => {
    expect(RECIPES.solder_alloyer).toBeDefined();
    expect(RECIPES.solder_alloyer!.inputs).toEqual({ tin_ingot: 1, lead_ingot: 1 });
    expect(RECIPES.solder_alloyer!.outputs).toEqual({ solder: 2 });
    expect(RECIPES.solder_alloyer!.cycleSec).toBe(200);
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
    expect(RECIPES.manganese_mine!.cycleSec).toBe(60);
  });
  it('manganese_smelter recipe: manganese_ore + coal → manganese_ingot', () => {
    expect(RECIPES.manganese_smelter).toBeDefined();
    expect(RECIPES.manganese_smelter!.inputs).toEqual({ manganese_ore: 1, coal: 1 });
    expect(RECIPES.manganese_smelter!.outputs).toEqual({ manganese_ingot: 1 });
    expect(RECIPES.manganese_smelter!.cycleSec).toBe(80);
  });
  it('carbon_steel_mill recipe: steel + manganese_ingot → carbon_steel', () => {
    expect(RECIPES.carbon_steel_mill).toBeDefined();
    expect(RECIPES.carbon_steel_mill!.inputs).toEqual({ steel: 1, manganese_ingot: 1 });
    expect(RECIPES.carbon_steel_mill!.outputs).toEqual({ carbon_steel: 1 });
    expect(RECIPES.carbon_steel_mill!.cycleSec).toBe(250);
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
    expect(RECIPES.zinc_mine!.cycleSec).toBe(60);
  });
  it('zinc_smelter recipe: zinc_ore + coal → zinc_ingot', () => {
    expect(RECIPES.zinc_smelter).toBeDefined();
    expect(RECIPES.zinc_smelter!.inputs).toEqual({ zinc_ore: 1, coal: 1 });
    expect(RECIPES.zinc_smelter!.outputs).toEqual({ zinc_ingot: 1 });
    expect(RECIPES.zinc_smelter!.cycleSec).toBe(80);
  });
  it('galvanizing_bath recipe: steel + zinc_ingot → galvanized_steel', () => {
    expect(RECIPES.galvanizing_bath).toBeDefined();
    expect(RECIPES.galvanizing_bath!.inputs).toEqual({ steel: 1, zinc_ingot: 1 });
    expect(RECIPES.galvanizing_bath!.outputs).toEqual({ galvanized_steel: 1 });
    expect(RECIPES.galvanizing_bath!.cycleSec).toBe(250);
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
    expect(RECIPES.chromium_mine!.cycleSec).toBe(60);
  });
  it('chromium_smelter recipe: chromium_ore + coal → chromium_ingot', () => {
    expect(RECIPES.chromium_smelter).toBeDefined();
    expect(RECIPES.chromium_smelter!.inputs).toEqual({ chromium_ore: 1, coal: 1 });
    expect(RECIPES.chromium_smelter!.outputs).toEqual({ chromium_ingot: 1 });
    expect(RECIPES.chromium_smelter!.cycleSec).toBe(80);
  });
  it('nickel_mine recipe: empty inputs → nickel_ore', () => {
    expect(RECIPES.nickel_mine).toBeDefined();
    expect(RECIPES.nickel_mine!.inputs).toEqual({});
    expect(RECIPES.nickel_mine!.outputs).toEqual({ nickel_ore: 1 });
    expect(RECIPES.nickel_mine!.cycleSec).toBe(60);
  });
  it('nickel_smelter recipe: nickel_ore + coal → nickel_ingot', () => {
    expect(RECIPES.nickel_smelter).toBeDefined();
    expect(RECIPES.nickel_smelter!.inputs).toEqual({ nickel_ore: 1, coal: 1 });
    expect(RECIPES.nickel_smelter!.outputs).toEqual({ nickel_ingot: 1 });
    expect(RECIPES.nickel_smelter!.cycleSec).toBe(80);
  });
  it('stainless_steel_mill recipe: steel + chromium_ingot + nickel_ingot → stainless_steel', () => {
    expect(RECIPES.stainless_steel_mill).toBeDefined();
    expect(RECIPES.stainless_steel_mill!.inputs).toEqual({ steel: 1, chromium_ingot: 1, nickel_ingot: 1 });
    expect(RECIPES.stainless_steel_mill!.outputs).toEqual({ stainless_steel: 1 });
    expect(RECIPES.stainless_steel_mill!.cycleSec).toBe(400);
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
    expect(RECIPES.tungsten_mine!.cycleSec).toBe(60);
  });
  it('tungsten_smelter recipe: tungsten_ore + coal → tungsten_ingot', () => {
    expect(RECIPES.tungsten_smelter).toBeDefined();
    expect(RECIPES.tungsten_smelter!.inputs).toEqual({ tungsten_ore: 1, coal: 1 });
    expect(RECIPES.tungsten_smelter!.outputs).toEqual({ tungsten_ingot: 1 });
    expect(RECIPES.tungsten_smelter!.cycleSec).toBe(80);
  });
  it('tool_steel_mill recipe: steel + tungsten_ingot → tool_steel', () => {
    expect(RECIPES.tool_steel_mill).toBeDefined();
    expect(RECIPES.tool_steel_mill!.inputs).toEqual({ steel: 1, tungsten_ingot: 1 });
    expect(RECIPES.tool_steel_mill!.outputs).toEqual({ tool_steel: 1 });
    expect(RECIPES.tool_steel_mill!.cycleSec).toBe(400);
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
    expect(RECIPES.crude_oil_cracker!.cycleSec).toBe(600);
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
    expect(RECIPES.plastic_polymerizer_a!.cycleSec).toBe(400);
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
    expect(RECIPES.rigid_plastic_press!.cycleSec).toBe(300);
    expect(RECIPES.rigid_plastic_press!.category).toBe('manufacturing');
  });
  it('flexible_plastic_press recipe: 1 plastic_precursor → 1 flexible_plastic', () => {
    expect(RECIPES.flexible_plastic_press).toBeDefined();
    expect(RECIPES.flexible_plastic_press!.inputs).toEqual({ plastic_precursor: 1 });
    expect(RECIPES.flexible_plastic_press!.outputs).toEqual({ flexible_plastic: 1 });
    expect(RECIPES.flexible_plastic_press!.cycleSec).toBe(300);
    expect(RECIPES.flexible_plastic_press!.category).toBe('manufacturing');
  });
  it('rubber_synthesizer recipe: 1 plastic_precursor → 1 synthetic_rubber', () => {
    expect(RECIPES.rubber_synthesizer).toBeDefined();
    expect(RECIPES.rubber_synthesizer!.inputs).toEqual({ plastic_precursor: 1 });
    expect(RECIPES.rubber_synthesizer!.outputs).toEqual({ synthetic_rubber: 1 });
    expect(RECIPES.rubber_synthesizer!.cycleSec).toBe(300);
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
    expect(RECIPES.chlor_alkali_plant!.outputs.chlorine).toBe(1);
    expect(RECIPES.chlor_alkali_plant!.outputs.sodium_hydroxide).toBe(1);
    expect(RECIPES.chlor_alkali_plant!.inputs).toEqual({ saltwater: 2 });
    expect(RECIPES.chlor_alkali_plant!.cycleSec).toBe(800);
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
    expect(RECIPES.cryo_air_separator!.cycleSec).toBe(400);
    expect(RECIPES.cryo_air_separator!.category).toBe('chemistry');
  });
  it('air_separator recipe is unchanged (still outputs nitrogen + oxygen + argon)', () => {
    expect(RECIPES.air_separator).toBeDefined();
    expect(RECIPES.air_separator!.outputs).toEqual({ nitrogen: 1, oxygen: 1, argon: 1 });
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
    expect(RECIPES.phosphor_plant!.cycleSec).toBe(600);
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
    expect(RECIPES.sulfuric_acid_plant!.cycleSec).toBe(400);
    expect(RECIPES.sulfuric_acid_plant!.category).toBe('chemistry');
  });
  it('hcl_plant recipe: salt + sulfuric_acid → hydrochloric_acid', () => {
    expect(RECIPES.hcl_plant).toBeDefined();
    expect(RECIPES.hcl_plant!.inputs).toEqual({ salt: 1, sulfuric_acid: 1 });
    expect(RECIPES.hcl_plant!.outputs).toEqual({ hydrochloric_acid: 1 });
    expect(RECIPES.hcl_plant!.cycleSec).toBe(400);
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
    expect(RECIPES.sheet_metal_mill!.cycleSec).toBe(200);
  });
  it('pipe_mill recipe: steel → pipe', () => {
    expect(RECIPES.pipe_mill).toBeDefined();
    expect(RECIPES.pipe_mill!.inputs).toEqual({ steel: 1 });
    expect(RECIPES.pipe_mill!.outputs).toEqual({ pipe: 2 });
    expect(RECIPES.pipe_mill!.cycleSec).toBe(200);
  });
  it('beam_mill recipe: steel → steel_beam', () => {
    expect(RECIPES.beam_mill).toBeDefined();
    expect(RECIPES.beam_mill!.inputs).toEqual({ steel: 1 });
    expect(RECIPES.beam_mill!.outputs).toEqual({ steel_beam: 2 });
    expect(RECIPES.beam_mill!.cycleSec).toBe(200);
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
    expect(RECIPES.bearing_press!.cycleSec).toBe(200);
  });
  it('spring_winder recipe: steel → spring', () => {
    expect(RECIPES.spring_winder).toBeDefined();
    expect(RECIPES.spring_winder!.inputs).toEqual({ steel: 1 });
    expect(RECIPES.spring_winder!.outputs).toEqual({ spring: 3 });
    expect(RECIPES.spring_winder!.cycleSec).toBe(200);
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
    expect(RECIPES.cable_drawer!.cycleSec).toBe(200);
  });
});

describe('§6.3/§7.9 battery via battery_factory (Task 6.4)', () => {
  it('battery is in ALL_RESOURCES with xp_weight 30', () => {
    expect(ALL_RESOURCES).toContain('battery');
    expect(XP_WEIGHT.battery).toBe(30);
  });
  it('battery_factory recipe: copper_ingot + rigid_plastic + wire → battery', () => {
    expect(RECIPES.battery_factory).toBeDefined();
    expect(RECIPES.battery_factory!.inputs).toEqual({
      copper_ingot: 1,
      rigid_plastic: 1,
      wire: 2,
    });
    expect(RECIPES.battery_factory!.outputs).toEqual({ battery: 1 });
    expect(RECIPES.battery_factory!.cycleSec).toBe(300);
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
