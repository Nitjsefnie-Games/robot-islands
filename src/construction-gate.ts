// Pure construction-position gate (NO pixi.js import).
//
// `positionIsFree` used to be a private helper inside `construction-ui.ts`,
// which is a DOM/Pixi panel. Extracting it here lets the authoritative server
// re-run the same overlap check the UI uses when validating an artificial
// island construction intent.

import {
  islandsOverlap, islandConstituents, BIOME_MAX_RADII,
  type IslandSpec, type WorldState,
} from './world.js';
import { tileInscribedInEllipse } from './island.js';
import { cellKey, tileToCell } from './discovery.js';

/** Does the inscribed footprint of an ellipse at (cx,cy) lie entirely within
 *  discovered-or-visible space? "Unknown" = a stratification cell not present
 *  in `world.revealedCells` (vision and discovery both write through to that
 *  set, so a single membership test covers both tiers). Re-runnable on the
 *  authoritative server — same trust-surface role as `positionIsFree`. */
export function regionDiscoveredOrVisible(
  world: WorldState,
  cx: number,
  cy: number,
  major: number,
  minor: number,
): boolean {
  const xMin = -Math.ceil(major), xMax = Math.ceil(major) - 1;
  const yMin = -Math.ceil(minor), yMax = Math.ceil(minor) - 1;
  for (let dy = yMin; dy <= yMax; dy++) {
    for (let dx = xMin; dx <= xMax; dx++) {
      if (!tileInscribedInEllipse(dx, dy, major, minor)) continue;
      const { cellX, cellY } = tileToCell(cx + dx, cy + dy);
      if (!world.revealedCells.has(cellKey(cellX, cellY))) return false;
    }
  }
  return true;
}

/** Check whether a candidate position would overlap any existing island.
 *  Returns true if safe to place, false otherwise. Mirrors the UX guardrail
 *  enforced by the Construction UI before it lets the player confirm.
 *
 *  Uses the SAME land-footprint overlap test as §3.6 island merging
 *  (`islandsOverlap`): rasterize the candidate's inscribed ellipse tiles and
 *  reject if they touch any existing island's tiles. This replaces the former
 *  circular major-radius distance check, which over-rejected near elongated
 *  islands (it ignored the minor axis). Touching counts as overlap, so islands
 *  cannot be placed flush against existing land. The candidate is a single
 *  axis-aligned ellipse (no extras/rotation at construction time); existing
 *  islands carry their full merged geometry, which `islandsOverlap` handles. */
export function positionIsFree(
  world: WorldState,
  cx: number,
  cy: number,
  majorRadius: number,
  minorRadius: number,
): boolean {
  const candidate = { cx, cy, majorRadius, minorRadius } as unknown as IslandSpec;
  for (const s of world.islands) {
    if (islandsOverlap(s, candidate)) return false;
  }
  return true;
}

/** §2.5 anti-leapfrog placement gates. Placeholder magnitudes — tunable. */
export const ARTIFICIAL_RANGE_TILES = 48;
export const ARTIFICIAL_RATIO = 2;

export type ArtificialPlacementReason = 'leapfrog-anchor' | 'out-of-range' | 'ratio-exceeded';

export interface ArtificialPlacementResult {
  readonly ok: boolean;
  readonly reason?: ArtificialPlacementReason;
}

/** A shallow variant of `spec` with every constituent grown to its own
 *  origin-biome `BIOME_MAX_RADII` caps (§3.4) — the farthest footprint the
 *  island could EVER reach via Land Reclamation, hub or no hub (a Hub can
 *  always be built later, so the gate must not condition on one). `max()`
 *  guards specs already at/over cap. Does NOT mutate `spec`. */
function maxGrowthSpec(spec: IslandSpec): IslandSpec {
  const pCaps = BIOME_MAX_RADII[spec.biome];
  return {
    ...spec,
    majorRadius: Math.max(spec.majorRadius, pCaps.major),
    minorRadius: Math.max(spec.minorRadius, pCaps.minor),
    extraEllipses: spec.extraEllipses?.map((e) => {
      const caps = BIOME_MAX_RADII[e.biome ?? spec.biome];
      return { ...e, major: Math.max(e.major, caps.major), minor: Math.max(e.minor, caps.minor) };
    }),
  };
}

/** §2.5 anchor rule: would the candidate footprint touch/overlap the
 *  MAX-GROWTH footprint of any populated island? Populated-only: growth
 *  requires a Land Reclamation Hub, which requires population; unpopulated
 *  islands cannot grow to swallow anything. Reuses the §3.6 `islandsOverlap`
 *  tile test (touching counts), so "the gap an existing island can close"
 *  and "the gap that triggers a merge" can never disagree. */
export function maxGrowthFootprintTouches(
  world: WorldState,
  cx: number,
  cy: number,
  major: number,
  minor: number,
): boolean {
  const candidate = { cx, cy, majorRadius: major, minorRadius: minor } as unknown as IslandSpec;
  for (const s of world.islands) {
    if (!s.populated) continue;
    if (islandsOverlap(maxGrowthSpec(s), candidate)) return true;
  }
  return false;
}

/** §2.5 range rule metric: the minimum Chebyshev gap between the candidate's
 *  bounding box and any founder-constituent bounding box (0 when they
 *  overlap/touch). Constituent extents, not centre distance, so a lobe that
 *  stretches toward the candidate shortens the measured gap. Cheap
 *  (O(constituents)) so the drag-ghost can evaluate it per mousemove. */
export function founderRangeGap(
  founderSpec: IslandSpec,
  cx: number,
  cy: number,
  major: number,
  minor: number,
): number {
  let best = Infinity;
  for (const c of islandConstituents(founderSpec)) {
    const ccx = founderSpec.cx + c.offsetX;
    const ccy = founderSpec.cy + c.offsetY;
    const gapX = Math.max(0, Math.abs(cx - ccx) - (major + c.major));
    const gapY = Math.max(0, Math.abs(cy - ccy) - (minor + c.minor));
    best = Math.min(best, Math.max(gapX, gapY));
  }
  return best;
}

/** §2.5 ratio rule: how many of `spec`'s constituents are NATURAL — primary
 *  or lobe whose origin island was not artificial. Uses the resolved
 *  `originId` prefix (artificial ids are `art-N` / `art-<cx>-<cy>`; generated
 *  islands are `gen-*` / `home`), which covers both the primary (originId =
 *  spec.id) and absorbed lobes uniformly. */
export function naturalConstituentCount(spec: IslandSpec): number {
  let n = 0;
  for (const c of islandConstituents(spec)) {
    if (!c.originId.startsWith('art-')) n++;
  }
  return n;
}

/** §2.5 ratio rule: the founder's LIFETIME artificial-creation count —
 *  standalone artificial islands plus absorbed artificial lobes anywhere in
 *  the world whose `founderId` matches. Never double-counts: a merge removes
 *  the standalone spec from `world.islands` in the same step it appends the
 *  lobe. Monotonic by design — merging an artificial island away does not
 *  refund the founder's budget. */
export function attributedArtificialCount(world: WorldState, founderId: string): number {
  let n = 0;
  for (const s of world.islands) {
    if (s.artificial && s.founderId === founderId) n++;
    if (s.extraEllipses) {
      for (const e of s.extraEllipses) {
        if (e.founderId === founderId) n++;
      }
    }
  }
  return n;
}

/** §2.5 anti-leapfrog placement gate: anchor, then range, then ratio
 *  (spatial reasons take precedence so the drag-ghost reds on position
 *  problems before budget problems). Pure; re-run identically by the
 *  construction UI, the LOCAL gateway, and the server `construct-island`
 *  intent — same trust-surface contract as `positionIsFree` above. */
export function validateArtificialPlacement(
  world: WorldState,
  founderSpec: IslandSpec,
  cx: number,
  cy: number,
  major: number,
  minor: number,
): ArtificialPlacementResult {
  if (maxGrowthFootprintTouches(world, cx, cy, major, minor)) {
    return { ok: false, reason: 'leapfrog-anchor' };
  }
  if (founderRangeGap(founderSpec, cx, cy, major, minor) > ARTIFICIAL_RANGE_TILES) {
    return { ok: false, reason: 'out-of-range' };
  }
  const budget = ARTIFICIAL_RATIO * naturalConstituentCount(founderSpec);
  if (attributedArtificialCount(world, founderSpec.id) + 1 > budget) {
    return { ok: false, reason: 'ratio-exceeded' };
  }
  return { ok: true };
}
