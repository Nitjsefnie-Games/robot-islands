import { describe, expect, it } from 'vitest';

import { BUILDING_DEFS } from './building-defs.js';
import { RECIPES } from './recipes.js';
import { buildRecipeGraphMermaid } from './recipe-graph.js';

describe('buildRecipeGraphMermaid', () => {
  const src = buildRecipeGraphMermaid();
  const lines = src.split('\n');

  it('starts with the flowchart LR header', () => {
    expect(lines[0]).toBe('flowchart LR');
  });

  it('emits the iron_ore → iron_smelter → iron_ingot chain', () => {
    // smelter is the T1 iron_smelter building per recipes.ts:884-885.
    expect(src).toContain('res_iron_ore --> bld_smelter');
    expect(src).toContain('bld_smelter --> res_iron_ingot');
  });

  it('declares a node for every building that owns a recipe', () => {
    const ownersWithRecipes = new Set<string>();
    for (const [recipeKey, recipe] of Object.entries(RECIPES)) {
      if (!recipe) continue;
      // mine_on_ore / mine_on_coal both owned by the mine building.
      const owner =
        recipeKey === 'mine_on_ore' || recipeKey === 'mine_on_coal'
          ? 'mine'
          : recipeKey;
      ownersWithRecipes.add(owner);
    }
    for (const owner of ownersWithRecipes) {
      // Each building node line looks like `bld_smelter(["Smelter"]):::tier1`.
      // We check for the prefix only; label + class are validated separately.
      const re = new RegExp(`^bld_${owner}\\(`, 'm');
      expect(src).toMatch(re);
    }
  });

  it('declares a node for every resource referenced by any recipe', () => {
    const resourcesSeen = new Set<string>();
    for (const recipe of Object.values(RECIPES)) {
      if (!recipe) continue;
      for (const r of Object.keys(recipe.inputs)) resourcesSeen.add(r);
      for (const r of Object.keys(recipe.outputs)) resourcesSeen.add(r);
    }
    for (const r of resourcesSeen) {
      const re = new RegExp(`^res_${r}\\(\\(`, 'm');
      expect(src).toMatch(re);
    }
  });

  it('emits at least one edge for every recipe with non-empty inputs OR outputs', () => {
    for (const [recipeKey, recipe] of Object.entries(RECIPES)) {
      if (!recipe) continue;
      const inCount = Object.keys(recipe.inputs).length;
      const outCount = Object.keys(recipe.outputs).length;
      if (inCount === 0 && outCount === 0) continue; // pure no-op recipes
      const owner =
        recipeKey === 'mine_on_ore' || recipeKey === 'mine_on_coal'
          ? 'mine'
          : recipeKey;
      // At least one edge touches the owner.
      const re = new RegExp(`(--> bld_${owner}\\b)|(\\bbld_${owner} -->)`);
      expect(src, `recipe "${recipeKey}" produced no edges`).toMatch(re);
    }
  });

  it('uses each building tier as a CSS class on the node line', () => {
    // Pick a couple of buildings with known tiers and confirm the class shows up.
    // mine = tier 1, deep_mine = tier 2.
    // BUILDING_DEFS is typed as Readonly<Record<BuildingDefId, BuildingDef>>;
    // under noUncheckedIndexedAccess these accesses are T | undefined, so
    // null-coalesce with sentinel tiers (-1) that won't match the regex.
    const mineTier = BUILDING_DEFS.mine?.tier ?? -1;
    const deepTier = BUILDING_DEFS.deep_mine?.tier ?? -1;
    expect(src).toMatch(new RegExp(`^bld_mine\\(.*\\):::tier${mineTier}`, 'm'));
    expect(src).toMatch(new RegExp(`^bld_deep_mine\\(.*\\):::tier${deepTier}`, 'm'));
  });
});
