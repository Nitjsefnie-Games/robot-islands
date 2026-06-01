// §3.4 Land Reclamation Hub — pure math + IslandSpec/IslandState mutation.
//
// The Hub is a per-island unique trigger building. Placing one enables the
// inspector's "+1 major / +1 minor" expansion action; this module provides
// the gate predicates and the mutation primitive. Multiple Hubs do not
// stack — `canExpandIsland` only checks for "at least one Hub present".
//
// Cost curve (§3.4): cost = inscribed-tile delta × LAND_TILE_COST where the
// delta is the number of new fully-inscribed tiles gained by a +1 expansion
// on the chosen axis. The shared per-land-tile basket lives in
// `building-defs.ts` (`LAND_TILE_COST`).
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
import { tileInscribedInEllipse } from './island.js';
import { LAND_TILE_COST } from './building-defs.js';
import type { ResourceId } from './recipes.js';
import { BIOME_MAX_RADII, type IslandSpec } from './world.js';

/** Which ellipse semi-axis to grow on an expansion. */
export type Axis = 'major' | 'minor';

/** §3.4 cost of one +1 expansion: a resource basket keyed by ResourceId.
 *  Partial so future basket growth doesn't break partial-cost previews. */
export type LandReclamationCost = Partial<Record<ResourceId, number>>;

/** `canExpandIsland` result. `ok: true` means `expandIsland` will succeed. */
export type ExpandResult =
  | { readonly ok: true }
  | {
      readonly ok: false;
      readonly reason: 'no-hub' | 'axis-at-max' | 'insufficient-resources';
    };

/** Count of fully-inscribed tiles in an axis-aligned ellipse of the given
 *  radii (same rule as computeIslandTiles). Pure. */
export function inscribedTileCount(major: number, minor: number): number {
  let n = 0;
  const xMin = -Math.ceil(major), xMax = Math.ceil(major) - 1;
  const yMin = -Math.ceil(minor), yMax = Math.ceil(minor) - 1;
  for (let y = yMin; y <= yMax; y++) {
    for (let x = xMin; x <= xMax; x++) {
      if (tileInscribedInEllipse(x, y, major, minor)) n++;
    }
  }
  return n;
}

/** §3.4 cost of one +1 expansion on `axis`: the exact inscribed-tile delta
 *  (land gained) × the shared per-land-tile basket. */
export function landReclamationCost(
  major: number,
  minor: number,
  axis: Axis,
): LandReclamationCost {
  const before = inscribedTileCount(major, minor);
  const after = axis === 'major'
    ? inscribedTileCount(major + 1, minor)
    : inscribedTileCount(major, minor + 1);
  const delta = Math.max(0, after - before);
  const out: LandReclamationCost = {};
  for (const [r, n] of Object.entries(LAND_TILE_COST) as Array<[ResourceId, number]>) {
    out[r] = delta * n;
  }
  return out;
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
  const cost = landReclamationCost(spec.majorRadius, spec.minorRadius, axis);
  for (const [r, n] of Object.entries(cost) as Array<[ResourceId, number]>) {
    if (inv(state, r as ResourceId) < n) {
      return { ok: false, reason: 'insufficient-resources' };
    }
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
  const cost = landReclamationCost(spec.majorRadius, spec.minorRadius, axis);
  for (const [r, n] of Object.entries(cost) as Array<[ResourceId, number]>) {
    state.inventory[r] = (state.inventory[r] ?? 0) - n;
  }
  if (axis === 'major') spec.majorRadius = spec.majorRadius + 1;
  else spec.minorRadius = spec.minorRadius + 1;
}
