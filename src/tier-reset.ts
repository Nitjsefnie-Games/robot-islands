// Per-island Tier Reset per SPEC §9.7. Pure logic — no PixiJS, no DOM.
//
// A player can pay a placeholder T2-T3 component cost to revert a Tier-3+
// island to Tier 1, primarily to undo a poorly-chosen §9.3 skill-tree
// commitment. Tier breakpoint
// state reverts to T1; T2+ buildings remain placed but the runtime tier
// gate in `computeRates` zeroes their effective rate until the island
// re-climbs into the relevant tier band.
//
// Preserved by reset:
//   - All placed buildings (operatingMs / maintainedAt timestamps intact).
//   - Terrain, tile types (these live on IslandSpec, not IslandState — out
//     of reach of this function by construction).
//   - Modifiers (also IslandSpec).
//   - Local inventory (minus the cost deducted at execution time) and
//     storage caps (derived from the preserved buildings via aggregate).
//   - `funnelPending` (§10) — spec is silent; preserving matches the
//     "full stockpile preserved" spirit of §9.7's "local inventory".
//   - `aiCoreCrafted` / `ascendantCoreCrafted` — these are "once-ever-crafted"
//     historical flags. Spec says "tier breakpoint state reverts to T1",
//     which we read as the level/tier band only; the historical AI-core
//     and Ascendant-core flags are NOT tier breakpoints.
//
// Cleared by reset:
//   - `level → 1`, `xp → 0`.
//   - Spent skill points refunded as `unspentSkillPoints`, then
//     `unlockedNodes` and `unlockedEdges` cleared.
//   - `declaredAt` cleared.
//
// 24-real-time-hour cooldown between resets on the same island
// (placeholder per §9.7).
//
// Merged islands (§3.6) operate as a single identity per spec; the
// absorber's IslandState IS what `executeTierReset` mutates. Because the
// merged ellipse list and absorbed-buildings live on IslandSpec /
// `state.buildings` (preserved by reset per §9.7), no merge-specific
// handling is needed here — the reset works on a merged island the same
// way it works on any other.

import { inv, type IslandState } from './economy.js';
import { nodeById } from './skilltree.js';
import { tierForLevel } from './skilltree.js';

/** Cooldown between resets on the same island. Placeholder per §9.7. */
export const TIER_RESET_COOLDOWN_MS = 24 * 60 * 60 * 1000;

/** Resource cost to reset an island at its current level. Placeholder
 *  formula per §9.7: cost proportional to level². Uses Steel (T2 component)
 *  and Gear (T2-T3 component) — both already in the catalog (see
 *  `src/recipes.ts`).
 *
 *  Cost formula: `{ steel: level², gear: floor(level² / 2) }`. At L15 (the
 *  earliest a reset can fire, since T3 = L15): 225 steel + 112 gear. At
 *  L30 (T4): 900 + 450. At L50 (T5): 2500 + 1250. Placeholder — tune once
 *  the inventory/route economy is fully balanced. */
export interface TierResetCost {
  readonly steel: number;
  readonly gear: number;
}

/** TODO(§9.7-tune): placeholder cost formula. §9.7 itself declares
 *  "Cost (placeholder): a pile of T2-T3 components scaling with the island's
 *  current level (placeholder formula: cost proportional to level²)". The
 *  code matches that literal. Balance pass once §6.5 T4-T5 production
 *  loops have throughput data — track alongside the other STILL-DEFERRED
 *  numeric placeholders in SPEC Appendix A. */
export function tierResetCost(level: number): TierResetCost {
  const l2 = level * level;
  return { steel: l2, gear: Math.floor(l2 / 2) };
}

export type TierResetReason =
  | 'tier-too-low'
  | 'cooldown-active'
  | 'insufficient-resources';

export type TierResetResult =
  | { readonly ok: true }
  | { readonly ok: false; readonly reason: TierResetReason };

/**
 * Decide whether a Tier Reset can fire on `state` at `nowMs`. Pure — does
 * not mutate state. Three rejection paths per §9.7:
 *
 *   1. Island below T3 → 'tier-too-low'. Pre-T3 islands have nothing
 *      meaningful to reset (no role declared, no sub-paths committed at
 *      depths beyond the lowest), so the spec gates this off entirely.
 *
 *   2. Last-reset within `TIER_RESET_COOLDOWN_MS` → 'cooldown-active'.
 *
 *   3. Inventory lacks the cost → 'insufficient-resources'. Checked LAST
 *      so the UI shows the most-informative gate first (a player below
 *      T3 doesn't need a "needs more steel" hint).
 */
export function canTierReset(state: IslandState, nowMs: number): TierResetResult {
  if (tierForLevel(state.level) < 3) return { ok: false, reason: 'tier-too-low' };
  if (
    state.lastResetAt !== null &&
    nowMs - state.lastResetAt < TIER_RESET_COOLDOWN_MS
  ) {
    return { ok: false, reason: 'cooldown-active' };
  }
  const cost = tierResetCost(state.level);
  if (inv(state, 'steel') < cost.steel || inv(state, 'gear') < cost.gear) {
    return { ok: false, reason: 'insufficient-resources' };
  }
  return { ok: true };
}

/**
 * Execute the reset. Mutates `state` in place. Caller MUST have verified
 * `canTierReset(state, nowMs).ok === true` first — this function trusts
 * its preconditions and doesn't re-validate them (so a malformed call
 * site can drive inventory below zero or bypass the cooldown).
 *
 * Steps per §9.7:
 *   1. Deduct cost.
 *   2. Refund spent skill points (sum `node.cost` for every
 *      `unlockedNodes` entry) into `unspentSkillPoints`.
 *   3. Clear `unlockedNodes`, `unlockedEdges`, `declaredAt`.
 *   4. Reset `level → 1`, `xp → 0`.
 *   5. Stamp `lastResetAt = nowMs` for the cooldown.
 *
 * Preserved by reset (NOT touched by this function — listed here so the
 * contract is obvious at the call site):
 *   - `buildings` (placed entries, footprints, operatingMs, maintainedAt).
 *   - `inventory` apart from the deducted cost (storage caps, funnel
 *     pending, AI-core / Ascendant-core flags).
 *   - `storageCaps` (derive from buildings — preserved automatically).
 */
export function executeTierReset(state: IslandState, nowMs: number): void {
  const cost = tierResetCost(state.level);
  state.inventory.steel = (state.inventory.steel ?? 0) - cost.steel;
  state.inventory.gear = (state.inventory.gear ?? 0) - cost.gear;

  // Refund every spent point. A missing catalog entry (e.g. a save that
  // referenced a since-removed node) refunds 0 — defensive, not an expected path.
  let refund = 0;
  for (const nodeId of state.unlockedNodes) {
    const node = nodeById(nodeId);
    if (node) refund += node.cost;
  }
  state.unspentSkillPoints += refund;
  state.unlockedNodes.clear();
  state.unlockedEdges.clear();
  state.auraAmpVersion++;
  state.declaredAt = null;
  state.level = 1;
  state.xp = 0;
  state.lastResetAt = nowMs;
}
