// Pure data layer for the §15 recipe-graph modal. Builds a flat array of
// recipe table rows from the static RECIPES + BUILDING_DEFS tables.
// No DOM. No PixiJS. No module-level cache.

import { BUILDING_DEFS, type BuildingDefId } from './building-defs.js';
import { RECIPES, type RecipeCategory, type ResourceId } from './recipes.js';

export interface RecipeTableEntry {
  readonly resource: ResourceId;
  readonly n: number;
}

export interface RecipeTableRow {
  readonly category: RecipeCategory;
  readonly recipeKey: string;
  readonly buildingId: BuildingDefId;
  readonly buildingLabel: string;
  readonly tier: number;
  readonly inputs: ReadonlyArray<RecipeTableEntry>;
  readonly outputs: ReadonlyArray<RecipeTableEntry>;
  readonly cycleSec: number;
}

function ownerOf(recipeKey: string): BuildingDefId {
  if (recipeKey === 'mine_on_ore' || recipeKey === 'mine_on_coal') {
    return 'mine';
  }
  return recipeKey as BuildingDefId;
}

export function buildRecipeTableRows(): ReadonlyArray<RecipeTableRow> {
  const rows: RecipeTableRow[] = [];

  for (const [recipeKey, recipe] of Object.entries(RECIPES)) {
    if (!recipe) continue;

    const inputs = Object.entries(recipe.inputs)
      .map(([resource, n]) => ({ resource: resource as ResourceId, n: n ?? 0 }))
      .sort((a, b) => a.resource.localeCompare(b.resource));

    const outputs = Object.entries(recipe.outputs)
      .map(([resource, n]) => ({ resource: resource as ResourceId, n: n ?? 0 }))
      .sort((a, b) => a.resource.localeCompare(b.resource));

    if (inputs.length === 0 && outputs.length === 0) continue;

    const buildingId = ownerOf(recipeKey);
    const def = BUILDING_DEFS[buildingId];
    const buildingLabel = def?.displayName ?? buildingId;
    const tier = def?.tier ?? 0;

    rows.push({
      category: recipe.category,
      recipeKey,
      buildingId,
      buildingLabel,
      tier,
      inputs,
      outputs,
      cycleSec: recipe.cycleSec,
    });
  }

  rows.sort((a, b) => {
    const byCat = a.category.localeCompare(b.category);
    if (byCat !== 0) return byCat;
    const byLabel = a.buildingLabel.localeCompare(b.buildingLabel);
    if (byLabel !== 0) return byLabel;
    return a.recipeKey.localeCompare(b.recipeKey);
  });

  return rows;
}
