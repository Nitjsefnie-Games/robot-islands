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
  type RecipeCategory,
  type ResourceId,
} from './recipes.js';

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
    }
    return producers;
  }

  it('every recipe input has at least one producer recipe', () => {
    const producers = buildProducerSet();
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
