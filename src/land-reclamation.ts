// §3.4 Land Reclamation Hub — pure math + IslandSpec/IslandState mutation.
//
// The Hub is a per-island unique trigger building. Placing one enables the
// inspector's "+1 major / +1 minor" expansion action; this module provides
// the gate predicates and the mutation primitive. Multiple Hubs do not
// stack — `canExpandConstituent` only checks for "at least one Hub present".
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
import { islandInscribedAny, tileInscribedInEllipse } from './island.js';
import { LAND_TILE_COST } from './building-defs.js';
import type { ResourceId } from './recipes.js';
import { BIOME_MAX_RADII, recordGrowthClaim, type Biome, type IslandSpec } from './world.js';

/** Which ellipse semi-axis to grow on an expansion. */
export type Axis = 'major' | 'minor';

/** §3.4 cost of one +1 expansion: a resource basket keyed by ResourceId.
 *  Partial so future basket growth doesn't break partial-cost previews. */
export type LandReclamationCost = Partial<Record<ResourceId, number>>;

/** `canExpandConstituent` result. `ok: true` means `expandConstituent` will
 *  succeed. `bad-constituent` is returned when `index` selects no real
 *  constituent (out of range), so the gate never throws on stale UI input. */
export type ExpandResult =
  | { readonly ok: true }
  | {
      readonly ok: false;
      readonly reason:
        | 'no-hub'
        | 'axis-at-max'
        | 'insufficient-resources'
        | 'bad-constituent';
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

/** §3.4 cost of one +1 expansion on `axis` of constituent `index`
 *  (0 = primary, N = extraEllipses[N-1]). The delta is the number of tiles
 *  newly inscribed in the island UNION after growing that one constituent —
 *  tiles already covered by any other constituent are not re-charged. This
 *  prevents overcharging merged islands where the grown ring overlaps a
 *  sibling constituent. Charged tiles × the shared per-land-tile basket.
 *
 *  Reuses `islandInscribedAny` so the inscribe convention matches
 *  `computeIslandTileCount` / merged-island terrain exactly. Pure. */
export function landReclamationCost(
  spec: IslandSpec,
  index: number,
  axis: Axis,
): LandReclamationCost {
  const oldShape = {
    majorRadius: spec.majorRadius,
    minorRadius: spec.minorRadius,
    extraEllipses: spec.extraEllipses,
  };
  // Build newShape by growing the chosen constituent by +1 on `axis`, and
  // record that constituent's centre (cx,cy) + new radii so we can scan only
  // its bbox — only this constituent changed, so every newly-inscribed union
  // tile lives inside it.
  let newShape: typeof oldShape;
  let cx = 0;
  let cy = 0;
  let newMajor: number;
  let newMinor: number;
  if (index === 0) {
    newMajor = axis === 'major' ? spec.majorRadius + 1 : spec.majorRadius;
    newMinor = axis === 'minor' ? spec.minorRadius + 1 : spec.minorRadius;
    newShape = {
      majorRadius: newMajor,
      minorRadius: newMinor,
      extraEllipses: spec.extraEllipses,
    };
  } else {
    const extras = spec.extraEllipses ?? [];
    const e = extras[index - 1];
    if (!e) return {}; // out-of-range → no charge (the gate rejects separately)
    newMajor = axis === 'major' ? e.major + 1 : e.major;
    newMinor = axis === 'minor' ? e.minor + 1 : e.minor;
    cx = e.offsetX;
    cy = e.offsetY;
    const grown = extras.map((x, i) =>
      i === index - 1 ? { ...x, major: newMajor, minor: newMinor } : x);
    newShape = {
      majorRadius: spec.majorRadius,
      minorRadius: spec.minorRadius,
      extraEllipses: grown,
    };
  }
  // Bbox of the grown constituent (centred at cx,cy, sized to its NEW radii),
  // floored/ceiled to over-approximate so every inscribable tile is scanned.
  const xMin = Math.floor(cx - newMajor);
  const xMax = Math.ceil(cx + newMajor);
  const yMin = Math.floor(cy - newMinor);
  const yMax = Math.ceil(cy + newMinor);
  let delta = 0;
  for (let y = yMin; y <= yMax; y++) {
    for (let x = xMin; x <= xMax; x++) {
      if (!islandInscribedAny(oldShape, x, y) && islandInscribedAny(newShape, x, y)) {
        delta++;
      }
    }
  }
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
 * Resolve a constituent's current radius on `axis` and the biome whose
 * `BIOME_MAX_RADII` entry caps it. §3.4: each constituent is capped by its
 * OWN origin biome — an absorbed lobe keeps its origin cap even though its
 * terrain queries the absorber's biome (§3.6).
 *
 *   - index 0  → the primary ellipse: `spec.major/minorRadius`, `spec.biome`.
 *   - index N  → `extraEllipses[N-1]`: its `major/minor`, `biome ?? spec.biome`.
 *   - out of range → `null` (gate maps this to `bad-constituent`).
 */
function constituentAxis(
  spec: IslandSpec,
  index: number,
  axis: Axis,
): { current: number; biome: Biome } | null {
  if (index === 0) {
    return {
      current: axis === 'major' ? spec.majorRadius : spec.minorRadius,
      biome: spec.biome,
    };
  }
  const e = (spec.extraEllipses ?? [])[index - 1];
  if (!e) return null;
  return {
    current: axis === 'major' ? e.major : e.minor,
    biome: e.biome ?? spec.biome,
  };
}

/**
 * §3.4 expansion gate for a single constituent. Rejection reasons in
 * deliberate precedence:
 *
 *   1. `no-hub` — no Land Reclamation Hub on the island. Until the player
 *      places one, the inspector should not even surface the expand action.
 *   2. `bad-constituent` — `index` selects no real constituent (out of range).
 *      Checked before the cap so a stale/garbage index can never throw.
 *   3. `axis-at-max` — chosen axis already at the constituent's own origin-biome
 *      cap (`BIOME_MAX_RADII[constituent.biome]`). Checked BEFORE inventory so
 *      the player gets a structural reason ("axis is full") rather than a
 *      resource reason ("go mine more stone") when they're already capped.
 *   4. `insufficient-resources` — inventory below `landReclamationCost`.
 *
 * Pure; no mutation. `expandConstituent` defensively re-checks and no-ops on
 * rejection so misuse can't silently corrupt state.
 */
export function canExpandConstituent(
  spec: IslandSpec,
  state: IslandState,
  index: number,
  axis: Axis,
): ExpandResult {
  if (!hasLandReclamationHub(spec)) {
    return { ok: false, reason: 'no-hub' };
  }
  const c = constituentAxis(spec, index, axis);
  if (!c) {
    return { ok: false, reason: 'bad-constituent' };
  }
  const caps = BIOME_MAX_RADII[c.biome];
  const max = axis === 'major' ? caps.major : caps.minor;
  if (c.current >= max) {
    return { ok: false, reason: 'axis-at-max' };
  }
  const cost = landReclamationCost(spec, index, axis);
  for (const [r, n] of Object.entries(cost) as Array<[ResourceId, number]>) {
    if (inv(state, r as ResourceId) < n) {
      return { ok: false, reason: 'insufficient-resources' };
    }
  }
  return { ok: true };
}

/**
 * Apply one +1 Land Reclamation expansion on the chosen axis of constituent
 * `index`. Mutates `spec` (radius increment) and `state.inventory` (cost
 * deduction). The caller is responsible for rebuilding render layers
 * (`renderIsland` reads the spec's radii each rebuild, so a fresh
 * `rebuildWorldLayers()` call propagates the new tile mask) and refreshing
 * the inspector.
 *
 * Constituent dispatch:
 *   - index 0  → mutate `spec.major/minorRadius` in place.
 *   - index N  → REBUILD `extraEllipses[N-1]` (entries are `readonly`): a fresh
 *     entry with the chosen axis +1 and every other field preserved.
 *
 * Defensive no-op on rejection: if `canExpandConstituent` would return
 * `ok: false` (including `bad-constituent`), this function returns without
 * mutation. The inspector UI checks `canExpandConstituent` before offering the
 * button, so this guard exists to keep the API safe from out-of-order calls
 * (e.g. a stale click after the player just hit cap on a previous expansion).
 */
export function expandConstituent(
  spec: IslandSpec,
  state: IslandState,
  index: number,
  axis: Axis,
): void {
  const guard = canExpandConstituent(spec, state, index, axis);
  if (!guard.ok) return;
  // Pre-expansion radius drives the cost (matches the cost-preview text in the
  // inspector). The post-mutation radius is `current + 1` per §3.4 ("adds 1 to
  // either the major or the minor radius").
  const cost = landReclamationCost(spec, index, axis);
  for (const [r, n] of Object.entries(cost) as Array<[ResourceId, number]>) {
    state.inventory[r] = (state.inventory[r] ?? 0) - n;
  }
  if (index === 0) {
    if (axis === 'major') spec.majorRadius = spec.majorRadius + 1;
    else spec.minorRadius = spec.minorRadius + 1;
  } else {
    // `canExpandConstituent` already guaranteed this index resolves, so the
    // entry exists. Rebuild it (entries are readonly) with the chosen axis +1
    // and all other fields (biome, rotation, offsets, untouched axis) preserved.
    const extras = spec.extraEllipses!;
    const e = extras[index - 1]!;
    extras[index - 1] = {
      ...e,
      major: axis === 'major' ? e.major + 1 : e.major,
      minor: axis === 'minor' ? e.minor + 1 : e.minor,
    };
  }
  // §3.6 record the post-growth radii as a placement-order ownership claim so
  // the grown ring yields to any constituent that already holds those tiles.
  const grownMajor = index === 0 ? spec.majorRadius : spec.extraEllipses![index - 1]!.major;
  const grownMinor = index === 0 ? spec.minorRadius : spec.extraEllipses![index - 1]!.minor;
  recordGrowthClaim(spec, index, grownMajor, grownMinor);
}
