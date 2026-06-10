import { describe, expect, it } from 'vitest';

import { RECIPES } from './recipes.js';
import { BUILDING_DEFS } from './building-defs.js';
import { buildRecipeTableRows } from './recipe-graph.js';
import { buildingForRecipe } from './recipe-density.js';

describe('buildRecipeTableRows', () => {
  const rows = buildRecipeTableRows();

  it('returns at least one row per non-empty recipe', () => {
    let expected = 0;
    for (const recipe of Object.values(RECIPES)) {
      if (!recipe) continue;
      const inCount = Object.keys(recipe.inputs).length;
      const outCount = Object.keys(recipe.outputs).length;
      if (inCount === 0 && outCount === 0) continue;
      expected++;
    }
    expect(rows.length).toBe(expected);
  });

  it('emits the iron_ore → smelter → iron_ingot row', () => {
    const row = rows.find((r) => r.recipeKey === 'smelter');
    expect(row).toBeDefined();
    expect(row!.buildingId).toBe('smelter');
    expect(row!.inputs.map((e) => e.resource)).toContain('iron_ore');
    expect(row!.outputs.map((e) => e.resource)).toContain('iron_ingot');
  });

  it('attributes mine_on_ore and mine_on_coal to the mine building', () => {
    const oreRow = rows.find((r) => r.recipeKey === 'mine_on_ore');
    const coalRow = rows.find((r) => r.recipeKey === 'mine_on_coal');
    expect(oreRow?.buildingId).toBe('mine');
    expect(coalRow?.buildingId).toBe('mine');
  });

  it('sorts inputs and outputs alphabetically by resource id', () => {
    for (const row of rows) {
      const inResources = row.inputs.map((e) => e.resource);
      const outResources = row.outputs.map((e) => e.resource);
      expect(inResources).toEqual([...inResources].sort());
      expect(outResources).toEqual([...outResources].sort());
    }
  });

  it('skips recipes with empty inputs AND empty outputs', () => {
    for (const row of rows) {
      expect(row.inputs.length + row.outputs.length).toBeGreaterThan(0);
    }
  });

  it('rows are sorted by (category, buildingLabel, recipeKey)', () => {
    for (let i = 1; i < rows.length; i++) {
      const a = rows[i - 1]!;
      const b = rows[i]!;
      const cmp =
        a.category.localeCompare(b.category) ||
        a.buildingLabel.localeCompare(b.buildingLabel) ||
        a.recipeKey.localeCompare(b.recipeKey);
      expect(cmp).toBeLessThanOrEqual(0);
    }
  });

  it('every recipe key resolves to a building def that exists in BUILDING_DEFS', () => {
    for (const row of rows) {
      const def = BUILDING_DEFS[row.buildingId];
      expect(def, `recipe ${row.recipeKey} -> building ${row.buildingId} missing from BUILDING_DEFS`).toBeDefined();
    }
  });
});
