import { describe, expect, it } from 'vitest';
import { RECIPES } from './recipes.js';
import { ARCHETYPE_DENSITY, M, footprintM2, densityForRecipe } from './recipe-density.js';

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
