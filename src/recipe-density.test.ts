import { describe, expect, it } from 'vitest';
import { RECIPES } from './recipes.js';
import { ARCHETYPE_DENSITY, M, footprintM2, densityForRecipe, FOOTPRINT_M2 } from './recipe-density.js';
import { SHAPES } from './shape-mask.js';

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
  it('footprintM2 string-map agrees with SHAPES tile counts', () => {
    for (const [name, mask] of Object.entries(SHAPES)) {
      const key = `SHAPES.${name}`;
      if (!(key in FOOTPRINT_M2)) continue; // only assert shapes buildings actually use
      expect(footprintM2(key), key).toBe(mask.tiles.length);
    }
  });
});
