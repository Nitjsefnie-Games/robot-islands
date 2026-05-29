import { describe, expect, it } from 'vitest';
import { RECIPES } from './recipes.js';
import { BUILDING_DEFS } from './building-defs.js';
import { M, densityForRecipe, buildingForRecipe, outputKg, shouldDeriveCycleSec } from './recipe-density.js';

function expectedCycleSec(id: string): number {
  const r = (RECIPES as any)[id];
  const def = (BUILDING_DEFS as any)[buildingForRecipe(id)];
  const fp = def.footprint.tiles.length;
  return Math.max(1, Math.round((outputKg(r) / (densityForRecipe(id) * fp * M)) * 10) / 10);
}

describe('cycleSec matches the density formula (Phase 1 categories)', () => {
  for (const id of Object.keys(RECIPES)) {
    const r = (RECIPES as any)[id];
    if (!r) continue;
    if (!['extraction', 'smelting'].includes(r.category)) continue;
    if (!shouldDeriveCycleSec(r)) continue; // power/no-output keep hand-authored cycleSec
    it(`${id} cycleSec is generator-derived`, () => {
      expect(r.cycleSec).toBe(expectedCycleSec(id));
    });
  }
});
