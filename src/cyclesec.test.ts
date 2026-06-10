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

describe('cycleSec matches the density formula (all categories)', () => {
  for (const id of Object.keys(RECIPES)) {
    const r = (RECIPES as any)[id];
    if (!r) continue;

    if (!shouldDeriveCycleSec(r)) continue; // power/no-output keep hand-authored cycleSec
    it(`${id} cycleSec is generator-derived`, () => {
      expect(r.cycleSec).toBe(expectedCycleSec(id));
    });
  }
});

describe('near-zero-mass recipe guards', () => {
  it('shouldDeriveCycleSec returns false when total output mass < 0.01 kg', () => {
    const recipe = { outputs: { antimatter_propellant: 1 }, category: 'manufacturing' };
    expect(shouldDeriveCycleSec(recipe)).toBe(false);
  });

  it('antimatter_refinery cycleSec is pinned to 600 s (SPEC 10-min)', () => {
    expect(RECIPES.antimatter_refinery!.cycleSec).toBe(600);
  });

  it('drilling_rig cycleSec is pinned to 800 s', () => {
    expect(RECIPES.drilling_rig!.cycleSec).toBe(800);
  });

  it('particle_accelerator cycleSec is pinned to 600 s (slow-cycle convention)', () => {
    expect(RECIPES.particle_accelerator!.cycleSec).toBe(600);
  });
});
