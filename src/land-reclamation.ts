// §3.4 Land Reclamation Hub — pure math + IslandSpec/IslandState mutation.
//
// The Hub is a per-island unique trigger building. Placing one enables the
// inspector's "+1 major / +1 minor" expansion action; this module provides
// the gate predicates and the mutation primitive. Multiple Hubs do not
// stack — `canExpandIsland` only checks for "at least one Hub present".
//
// Cost curve (§3.4 PLACEHOLDER): `cost(r).stone = 5 × r²` where r is the
// CURRENT radius along the chosen axis. Superlinear so the marginal cost
// rises faster than the marginal benefit (a +1 on a small island reveals
// more relative area than +1 on a near-cap island). Both the formula and
// the resource choice (stone-only) are placeholders pending Appendix A
// tuning — see SPEC §3.4 line 306 and §15.5 (placeholder list).
//
// Rotation cannot change post-generation per §3.4 — there is no
// `rotateIsland` here, intentionally.
//
// Pure layer: no PixiJS, no DOM. Render side rebuilds the island layer
// after a successful expansion (the caller is responsible for that — this
// module is data-only). Persistence already preserves majorRadius /
// minorRadius via the JSON-spread round-trip (`serializeWorld`).

import type { IslandState } from './economy.js';
import { inv } from './economy.js';
import { BIOME_MAX_RADII, type IslandSpec } from './world.js';

/** Which ellipse semi-axis to grow on an expansion. */
export type Axis = 'major' | 'minor';

/**
 * §3.4 placeholder cost row for a single +1 expansion. Resource basket is
 * currently stone-only; future tuning (per the §15.5 placeholder list)
 * may introduce additional inputs (concrete, machinery, etc.). New keys
 * SHOULD remain optional so a partial-cost preview at the inspector
 * doesn't break when the basket grows.
 */
export interface LandReclamationCost {
  /** §3.4 placeholder: 5 × r² stone for one +1 expansion. */
  readonly stone: number;
}

/** `canExpandIsland` result. `ok: true` means `expandIsland` will succeed. */
export type ExpandResult =
  | { readonly ok: true }
  | {
      readonly ok: false;
      readonly reason: 'no-hub' | 'axis-at-max' | 'insufficient-resources';
    };

/**
 * §3.4 placeholder cost curve: `cost(r) = 5 × r²` stone for one +1 expansion.
 * Superlinear in current radius so a near-cap expansion costs ~4× a fresh-
 * island expansion (5 × 27² = 3645 vs 5 × 14² = 980 for Plains-tuning).
 * Pure.
 */
export function landReclamationCost(currentRadius: number): LandReclamationCost {
  return { stone: 5 * currentRadius * currentRadius };
}

/**
 * Does `spec` carry at least one Land Reclamation Hub? The Hub presence
 * is the trigger gate per §3.4 (the building itself is dataless metadata —
 * see `building-defs.ts` `land_reclamation_hub`).
 */
function hasLandReclamationHub(spec: IslandSpec): boolean {
  for (const b of spec.buildings) {
    if (b.defId === 'land_reclamation_hub') return true;
  }
  return false;
}

/**
 * §3.4 expansion gate. Three rejection reasons in deliberate precedence:
 *
 *   1. `no-hub` — no Land Reclamation Hub on the island. Until the player
 *      places one, the inspector should not even surface the expand action.
 *   2. `axis-at-max` — chosen axis already at the biome cap (`BIOME_MAX_RADII`).
 *      Checked BEFORE inventory so the player gets a structural reason
 *      ("axis is full") rather than a resource reason ("go mine more stone")
 *      when they're already capped.
 *   3. `insufficient-resources` — inventory below `landReclamationCost`.
 *
 * Pure; no mutation. `expandIsland` defensively re-checks and no-ops on
 * rejection so misuse can't silently corrupt state.
 */
export function canExpandIsland(
  spec: IslandSpec,
  state: IslandState,
  axis: Axis,
): ExpandResult {
  if (!hasLandReclamationHub(spec)) {
    return { ok: false, reason: 'no-hub' };
  }
  const caps = BIOME_MAX_RADII[spec.biome];
  const current = axis === 'major' ? spec.majorRadius : spec.minorRadius;
  const max = axis === 'major' ? caps.major : caps.minor;
  if (current >= max) {
    return { ok: false, reason: 'axis-at-max' };
  }
  const cost = landReclamationCost(current);
  if (inv(state, 'stone') < cost.stone) {
    return { ok: false, reason: 'insufficient-resources' };
  }
  return { ok: true };
}

/**
 * Apply one +1 Land Reclamation expansion on the chosen axis. Mutates
 * `spec` (radius increment) and `state.inventory` (cost deduction). The
 * caller is responsible for rebuilding render layers (`renderIsland` reads
 * the spec's radii each rebuild, so a fresh `rebuildWorldLayers()` call
 * propagates the new tile mask) and refreshing the inspector.
 *
 * Defensive no-op on rejection: if `canExpandIsland` would return
 * `ok: false`, this function returns without mutation. The inspector
 * UI checks `canExpandIsland` before offering the button, so this guard
 * exists to keep the API safe from out-of-order calls (e.g. a stale
 * click after the player just hit cap on a previous expansion).
 */
export function expandIsland(
  spec: IslandSpec,
  state: IslandState,
  axis: Axis,
): void {
  const guard = canExpandIsland(spec, state, axis);
  if (!guard.ok) return;
  // Pre-expansion radius drives the cost (matches the cost-preview text
  // in the inspector). The post-mutation radius is `current + 1` per
  // §3.4 ("adds 1 to either the major or the minor radius").
  const current = axis === 'major' ? spec.majorRadius : spec.minorRadius;
  const cost = landReclamationCost(current);
  state.inventory.stone = inv(state, 'stone') - cost.stone;
  if (axis === 'major') {
    spec.majorRadius = current + 1;
  } else {
    spec.minorRadius = current + 1;
  }
}
