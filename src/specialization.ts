// Per-island specialization roles per SPEC §9.4. Pure logic — no PixiJS, no DOM.
//
// Mirrors the catalog + fold pattern from `biomes.ts` (modifier multipliers)
// and `skilltree.ts` (skill multipliers): a static `ROLE_DEFS` describes each
// role for the UI, and `effectiveSpecializationMultipliers(roleId)` returns
// the resolved multiplier bundle consumed by `computeRates` and `accrueXp`
// in `economy.ts`.
//
// A null role (the default Generalist baseline per §9.4) maps to the identity
// bundle — every multiplier is 1.0. Role declaration is one-way in step 10:
// §9.7 Tier Reset is the only path back to the null state, and that system
// is STILL-DEFERRED to a later step.
//
// Multiplier values are placeholders per §9.4. The pattern matches each
// role's "buff category × buffMul, all other categories × penaltyMul",
// with research_beacon as the special case: no recipe buff at all, plus
// an `xpMul = 1.5` that the economy's `accrueXp` reads directly.

import { ALL_RECIPE_CATEGORIES, type RecipeCategory } from './recipes.js';
import type { Tier } from './skilltree.js';

export type RoleId =
  | 'foundry'
  | 'refinery'
  | 'mining'
  | 'logistics_hub'
  | 'research_beacon';

/** Optional bonus axis a role declares in addition to its recipe-rate
 *  multipliers. Step-10 wires `storage_cap_plus_50` (logistics_hub) and
 *  `skill_xp_plus_50` (research_beacon) through the economy;
 *  `route_capacity_double` is wired through `routeCapacityMultiplier` in
 *  `routes.ts`; the other flags are catalog-only. The flag also drives UI
 *  labels — declaring a role surfaces the extra in the card datasheet. */
export type RoleExtra =
  | 'route_capacity_double'
  | 'storage_cap_plus_50'
  | 'skill_xp_plus_50';

export interface RoleDef {
  readonly id: RoleId;
  readonly displayName: string;
  readonly description: string;
  /** Recipe category the buff multiplier targets, or `'all'` for the
   *  research_beacon case (no per-category buff — the penalty multiplier
   *  applies uniformly). */
  readonly buffCategory: RecipeCategory | 'all';
  readonly buffMultiplier: number;
  readonly penaltyMultiplier: number;
  readonly extra?: RoleExtra;
  /** Tier required to declare this role. §9.4 sets T3 uniformly; we keep
   *  the field per-role so future balance passes can stagger the gate. */
  readonly tierRequirement: Tier;
}

/**
 * Per §9.4 placeholder magnitudes. ROLE_DEFS is metadata for the UI; the
 * authoritative source of multipliers for the economy is
 * `effectiveSpecializationMultipliers` below, which hardcodes each case.
 * Keeping the two in lockstep is a design discipline (the UI describes the
 * same effect the economy applies); the unit tests verify both surfaces.
 */
export const ROLE_DEFS: Readonly<Record<RoleId, RoleDef>> = {
  foundry: {
    id: 'foundry',
    displayName: 'Foundry Island',
    description: '+50% smelting recipe rate; ×0.75 on all other production.',
    buffCategory: 'smelting',
    buffMultiplier: 1.5,
    penaltyMultiplier: 0.75,
    tierRequirement: 3,
  },
  refinery: {
    id: 'refinery',
    displayName: 'Refinery Island',
    description: '+50% chemistry recipe rate; ×0.75 on all other production.',
    buffCategory: 'chemistry',
    buffMultiplier: 1.5,
    penaltyMultiplier: 0.75,
    tierRequirement: 3,
  },
  mining: {
    id: 'mining',
    displayName: 'Mining Island',
    description: '+75% raw extraction; ×0.50 on all other production.',
    buffCategory: 'extraction',
    buffMultiplier: 1.75,
    penaltyMultiplier: 0.50,
    tierRequirement: 3,
  },
  logistics_hub: {
    id: 'logistics_hub',
    displayName: 'Logistics Hub',
    description:
      'Logistics recipes ×2.0, storage caps ×1.5, and route capacity ×2.0; ×0.75 on all other production.',
    buffCategory: 'logistics',
    buffMultiplier: 2.0,
    penaltyMultiplier: 0.75,
    extra: 'route_capacity_double',
    tierRequirement: 3,
  },
  research_beacon: {
    id: 'research_beacon',
    displayName: 'Research Beacon',
    description: 'Skill XP +50% on this island; base production ×0.75.',
    buffCategory: 'all',
    // Research Beacon's "buff" is XP, not a recipe-rate multiplier — the
    // `buffMultiplier` here is unused by the economy fold (recipes uniformly
    // get penaltyMultiplier). Kept at 1.0 so any consumer that misreads
    // ROLE_DEFS doesn't accidentally apply a phantom buff.
    buffMultiplier: 1.0,
    penaltyMultiplier: 0.75,
    extra: 'skill_xp_plus_50',
    tierRequirement: 3,
  },
};

/** Iteration order matches ROLE_DEFS literal order; locked in for the UI
 *  card grid. */
export const ALL_ROLES: ReadonlyArray<RoleId> = [
  'foundry',
  'refinery',
  'mining',
  'logistics_hub',
  'research_beacon',
];

/**
 * Resolved multiplier bundle. Mirrors `ModifierMultipliers` / `SkillMultipliers`
 * shape so `computeRates` composes them the same way (per-category × global).
 */
export interface SpecializationMultipliers {
  /** Multiplier on every recipe rate, regardless of category. The penalty
   *  multiplier lands here for roles whose `buffCategory !== 'all'` so the
   *  per-category buff composes on top of it. For research_beacon (the
   *  `'all'` case), all categories get the penalty uniformly so this stays
   *  at 1.0 and the per-category map carries every entry at 0.75. */
  readonly globalRecipeRate: number;
  /** Per-category multiplier. The buffed category composes its buffMultiplier
   *  on top of globalRecipeRate. Other categories stay at 1.0 (and rely on
   *  globalRecipeRate carrying the penalty). For research_beacon this map
   *  uniformly carries the penalty so foundryClass roles read consistent. */
  readonly recipeRateByCategory: Readonly<Record<RecipeCategory, number>>;
  /** Multiplier on storage caps. Default 1.0; logistics_hub bumps to 1.5. */
  readonly storageCapMul: number;
  /** Multiplier on per-tick XP gain. Default 1.0; research_beacon bumps to 1.5. */
  readonly xpMul: number;
}

/** Mutable view over the returned bundle. `readonly` on the public interface
 *  is the consumer contract; the local builder writes into the same object. */
interface MutableSpecializationMultipliers {
  globalRecipeRate: number;
  recipeRateByCategory: Record<RecipeCategory, number>;
  storageCapMul: number;
  xpMul: number;
}

function blankSpecMultipliers(): MutableSpecializationMultipliers {
  const recipeRateByCategory = {} as Record<RecipeCategory, number>;
  for (const c of ALL_RECIPE_CATEGORIES) recipeRateByCategory[c] = 1;
  return {
    globalRecipeRate: 1,
    recipeRateByCategory,
    storageCapMul: 1,
    xpMul: 1,
  };
}

/** Identity bundle — every multiplier 1.0. Exported as a named constant so
 *  the economy default doesn't have to recompute it per call. */
export const IDENTITY_SPECIALIZATION: SpecializationMultipliers = blankSpecMultipliers();

/**
 * Resolve a role id (or null) into a multiplier bundle.
 *
 * Composition convention (must match `computeRates`):
 *
 *   effectiveRate = baseRate × specRecipeCat × specGlobal × ...
 *
 * For "1 category gets the buff, all others get the penalty" roles
 * (foundry / refinery / mining / logistics_hub):
 *   - globalRecipeRate = penaltyMultiplier
 *   - recipeRateByCategory[buffCategory] = buffMultiplier / penaltyMultiplier
 *
 * That way every category lands at globalMul × catMul = penalty × 1 = penalty
 * (the "others" case), except the buffed category which lands at
 * penalty × (buff/penalty) = buff. The math composes with skill / modifier
 * multipliers without an explicit "skip the global on buff category" branch.
 *
 * For research_beacon: globalRecipeRate = penaltyMultiplier directly, every
 * category stays at 1.0 (the penalty applies uniformly), xpMul = 1.5.
 *
 * For logistics_hub: storageCapMul = 1.5 in addition to the recipe split.
 *
 * Null role → identity bundle (no buff, no penalty).
 */
export function effectiveSpecializationMultipliers(
  role: RoleId | null,
): SpecializationMultipliers {
  if (role === null) return blankSpecMultipliers();

  const out = blankSpecMultipliers();
  const recipeRateByCategory = out.recipeRateByCategory;

  switch (role) {
    case 'foundry': {
      // smelting × 1.5, others × 0.75
      const buff = 1.5;
      const pen = 0.75;
      out.globalRecipeRate = pen;
      recipeRateByCategory.smelting = buff / pen;
      return out;
    }
    case 'refinery': {
      const buff = 1.5;
      const pen = 0.75;
      out.globalRecipeRate = pen;
      recipeRateByCategory.chemistry = buff / pen;
      return out;
    }
    case 'mining': {
      // extraction × 1.75, others × 0.50
      const buff = 1.75;
      const pen = 0.50;
      out.globalRecipeRate = pen;
      recipeRateByCategory.extraction = buff / pen;
      return out;
    }
    case 'logistics_hub': {
      // logistics × 2.0, storage caps × 1.5, others × 0.75
      const buff = 2.0;
      const pen = 0.75;
      out.globalRecipeRate = pen;
      recipeRateByCategory.logistics = buff / pen;
      out.storageCapMul = 1.5;
      return out;
    }
    case 'research_beacon': {
      // XP × 1.5, all recipes × 0.75 (no per-category buff)
      out.globalRecipeRate = 0.75;
      out.xpMul = 1.5;
      return out;
    }
    default: {
      const _exhaustive: never = role;
      void _exhaustive;
      return out;
    }
  }
}

/** §9.4 route capacity multiplier for an origin island's specialization.
 *  Returns 2.0 for logistics_hub, 1.0 otherwise. */
export function routeCapacityMultiplier(role: RoleId | null): number {
  return role === 'logistics_hub' ? 2.0 : 1.0;
}
