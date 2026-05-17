// Pure tests for `effectiveSpecializationMultipliers` per SPEC §9.4.
//
// Asserts each role's resolved multiplier bundle matches the catalog's
// stated buff/penalty pattern. The composition convention is:
//   effectiveRate(cat) = recipeRateByCategory[cat] × globalRecipeRate
// so for "buff category, others penalty" roles we expect:
//   buffCat   product = buffMultiplier
//   otherCat  product = penaltyMultiplier

import { describe, expect, it } from 'vitest';

import { ALL_RECIPE_CATEGORIES, type RecipeCategory } from './recipes.js';
import {
  effectiveSpecializationMultipliers,
  IDENTITY_SPECIALIZATION,
  ROLE_DEFS,
  type RoleId,
  type SpecializationMultipliers,
} from './specialization.js';

function rateFor(mul: SpecializationMultipliers, cat: RecipeCategory): number {
  return (mul.recipeRateByCategory[cat] ?? 1) * mul.globalRecipeRate;
}

describe('effectiveSpecializationMultipliers — per §9.4', () => {
  it('null role returns identity (every multiplier 1.0)', () => {
    const mul = effectiveSpecializationMultipliers(null);
    expect(mul.globalRecipeRate).toBe(1);
    expect(mul.storageCapMul).toBe(1);
    expect(mul.xpMul).toBe(1);
    for (const cat of ALL_RECIPE_CATEGORIES) {
      expect(mul.recipeRateByCategory[cat]).toBe(1);
    }
  });

  it('IDENTITY_SPECIALIZATION constant matches null-role result', () => {
    const mul = effectiveSpecializationMultipliers(null);
    expect(IDENTITY_SPECIALIZATION.globalRecipeRate).toBe(mul.globalRecipeRate);
    expect(IDENTITY_SPECIALIZATION.storageCapMul).toBe(mul.storageCapMul);
    expect(IDENTITY_SPECIALIZATION.xpMul).toBe(mul.xpMul);
    for (const cat of ALL_RECIPE_CATEGORIES) {
      expect(IDENTITY_SPECIALIZATION.recipeRateByCategory[cat]).toBe(
        mul.recipeRateByCategory[cat],
      );
    }
  });

  it('foundry: smelting × 1.5, all others × 0.75', () => {
    const mul = effectiveSpecializationMultipliers('foundry');
    expect(rateFor(mul, 'smelting')).toBeCloseTo(1.5, 12);
    for (const cat of ALL_RECIPE_CATEGORIES) {
      if (cat === 'smelting') continue;
      expect(rateFor(mul, cat)).toBeCloseTo(0.75, 12);
    }
    expect(mul.storageCapMul).toBe(1);
    expect(mul.xpMul).toBe(1);
  });

  it('refinery: chemistry × 1.5, all others × 0.75', () => {
    const mul = effectiveSpecializationMultipliers('refinery');
    expect(rateFor(mul, 'chemistry')).toBeCloseTo(1.5, 12);
    for (const cat of ALL_RECIPE_CATEGORIES) {
      if (cat === 'chemistry') continue;
      expect(rateFor(mul, cat)).toBeCloseTo(0.75, 12);
    }
    expect(mul.storageCapMul).toBe(1);
    expect(mul.xpMul).toBe(1);
  });

  it('mining: extraction × 1.75, all others × 0.50', () => {
    const mul = effectiveSpecializationMultipliers('mining');
    expect(rateFor(mul, 'extraction')).toBeCloseTo(1.75, 12);
    for (const cat of ALL_RECIPE_CATEGORIES) {
      if (cat === 'extraction') continue;
      expect(rateFor(mul, cat)).toBeCloseTo(0.50, 12);
    }
    expect(mul.storageCapMul).toBe(1);
    expect(mul.xpMul).toBe(1);
  });

  it('logistics_hub: all recipes × 0.75 (no per-category buff per §9.4), storageCapMul = 1.5', () => {
    // §9.4 Logisticist grants +100% route capacity + +50% storage cap +
    // -25% production penalty. There is NO per-category recipe-rate buff
    // (route capacity is wired via `routeCapacityMultiplier`, not the
    // recipe-rate fold). Every recipe category lands at the 0.75 penalty.
    const mul = effectiveSpecializationMultipliers('logistics_hub');
    for (const cat of ALL_RECIPE_CATEGORIES) {
      expect(rateFor(mul, cat)).toBeCloseTo(0.75, 12);
    }
    expect(mul.storageCapMul).toBeCloseTo(1.5, 12);
    expect(mul.xpMul).toBe(1);
  });

  it('research_beacon: all recipes × 0.75, xpMul = 1.5, no per-category buff', () => {
    const mul = effectiveSpecializationMultipliers('research_beacon');
    for (const cat of ALL_RECIPE_CATEGORIES) {
      expect(rateFor(mul, cat)).toBeCloseTo(0.75, 12);
    }
    expect(mul.xpMul).toBeCloseTo(1.5, 12);
    expect(mul.storageCapMul).toBe(1);
  });

  it('ROLE_DEFS metadata is consistent with the effective multipliers', () => {
    // Sanity: every catalog entry has the structural fields the UI consumes,
    // and the buff/penalty figures match the multipliers the economy applies.
    const roles: RoleId[] = ['foundry', 'refinery', 'mining', 'logistics_hub', 'research_beacon'];
    for (const id of roles) {
      const def = ROLE_DEFS[id];
      expect(def.id).toBe(id);
      expect(def.tierRequirement).toBe(3);
      expect(def.penaltyMultiplier).toBeGreaterThan(0);
      expect(def.penaltyMultiplier).toBeLessThanOrEqual(1);
      const mul = effectiveSpecializationMultipliers(id);
      // Only roles that DECLARE a per-category recipe buff (foundry /
      // refinery / mining) carry both `buffCategory` and `buffMultiplier`.
      // `logistics_hub` per §9.4 has no recipe buff at all (route capacity
      // + storage cap are its bonuses); `research_beacon` uses 'all' as a
      // sentinel with no real per-category effect.
      if (
        def.buffCategory !== undefined &&
        def.buffMultiplier !== undefined &&
        def.buffCategory !== 'all'
      ) {
        expect(rateFor(mul, def.buffCategory)).toBeCloseTo(def.buffMultiplier, 12);
      }
    }
  });

  it('logistics_hub ROLE_DEFS entry omits buffCategory/buffMultiplier per §9.4', () => {
    // Regression guard: §9.4 grants logistics_hub NO recipe-rate buff.
    // The role def must not advertise one — earlier revisions carried
    // an unspec'd `buffCategory: 'logistics'` + `buffMultiplier: 2.0`
    // that double-credited logistics-tagged recipes under the role's
    // own 0.75 penalty.
    const def = ROLE_DEFS.logistics_hub;
    expect(def.buffCategory).toBeUndefined();
    expect(def.buffMultiplier).toBeUndefined();
  });
});
