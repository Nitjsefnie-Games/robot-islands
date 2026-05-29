import { describe, expect, it } from 'vitest';
import { RECIPES } from './recipes.js';
import { ARCHETYPE_DENSITY, M, densityForRecipe } from './recipe-density.js';
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
  it('building shapes have expected tile-count footprint areas', () => {
    expect(SHAPES.single.tiles.length).toBe(1);
    expect(SHAPES.square2.tiles.length).toBe(4);
    expect(SHAPES.rect2x3.tiles.length).toBe(6);
    expect(SHAPES.rect3x2.tiles.length).toBe(6);
    expect(SHAPES.square3.tiles.length).toBe(9);
    expect(SHAPES.square4.tiles.length).toBe(16);
  });
});
