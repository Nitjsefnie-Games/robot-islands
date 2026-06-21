// Effective per-resource storage cap — the SINGLE source of truth for "how
// much of resource `r` may this island hold". Extracted from economy.ts so the
// non-economy clamp paths (island-merge inventory transfer, placement
// demolish/floor-disable/refund) can compute the SAME cap the economy uses
// WITHOUT a runtime cycle: `economy → placement` already exists, so placement
// importing `cap` from economy would cycle. This leaf imports only
// storage-categories + skilltree (both leaves; skilltree imports economy
// TYPE-ONLY) and the `IslandState` type, so every consumer can share it.
//
// Effective cap = nominal (`state.storageCaps[r]`, the base + building
// contributions accumulated by `creditStorageCaps`) × the §9.3 Storage-sub-path
// per-category multiplier, floored at the §12.4 starter grace. Reading the raw
// `state.storageCaps[r]` and clamping inventory to THAT silently drops the
// skill multiplier — e.g. a merge clamping to ⅓ of the real cap when the
// storage skill is maxed (the §3.6 inventory-loss bug). Always clamp to `cap()`.
import type { ResourceId } from './recipes.js';
import { RESOURCE_STORAGE_CATEGORY } from './storage-categories.js';
import { effectiveSkillMultipliers, type SkillMultipliers } from './skilltree.js';
import type { IslandState } from './economy.js';

/**
 * Effective storage cap for resource `r` on `state`.
 *
 * `override` (the §13.3 lattice/shared-network pooled caps) replaces the local
 * nominal when present. The §9.3 Storage sub-path multiplies the nominal by a
 * per-category factor (`storageCategoryCap`); pass `mult` to reuse an already
 * computed `SkillMultipliers` (UI/economy hot paths), else it falls back to the
 * memoized `effectiveSkillMultipliers(state)`. The §12.4 starter grace is a
 * floor on the result unless `opts.ignoreGrace` is set.
 *
 * The HUD historically read `state.storageCaps[r]` directly (predates skills)
 * and shows nominal caps; the economy and every inventory CLAMP must use this
 * effective value so clamps never discard inventory the skill multiplier holds.
 */
export function cap(
  state: IslandState,
  r: ResourceId,
  override?: Record<ResourceId, number>,
  opts?: { ignoreGrace?: boolean },
  mult?: SkillMultipliers,
): number {
  const nominal = override?.[r] ?? state.storageCaps[r] ?? 0;
  // §12.4: starter grace must apply even at zero nominal cap — the early
  // return on nominal === 0 sat BEFORE the grace read, which made the kit
  // allowance unreachable for resources with no storage built yet (fix 3.3).
  if (nominal === 0) {
    if (opts?.ignoreGrace) return 0;
    return state.starterInventoryGrace[r] ?? 0;
  }
  const resolvedMult = mult ?? effectiveSkillMultipliers(state);
  // Storage sub-path (depth ≥ 2): per-category cap multiplier. Uncategorised
  // resources (forward-compat) default to ×1.
  const cat = RESOURCE_STORAGE_CATEGORY[r];
  const catMul = cat ? resolvedMult.storageCategoryCap[cat] ?? 1 : 1;
  const computedCap = nominal * catMul;
  if (opts?.ignoreGrace) return computedCap;
  const grace = state.starterInventoryGrace[r] ?? 0;
  return Math.max(computedCap, grace);
}
