// Pure logic for §2.5 artificial-island construction: data types + functions
// that compute cost / validate inputs / mint the new spec+state. No PixiJS,
// DOM, or input.ts. The UI layer (`construction-ui.ts`) collects inputs and
// surfaces validation; this module owns the math.
//
// Per §2.5: a T3+ island with a Platform Constructor constructs a new island
// instantly, paying out of its own inventory. Settlement-vehicle delivery
// (§2.3) is the separate natural-colonisation path — construction "skips the
// ship".
//
// Notes:
//   - The `artificial: true` flag lets future systems (§3.5 modifier rolls
//     excluding rare-natural-only, §9.5 biome-locked-unique placement gate)
//     identify constructed islands.
//   - Position validity (overlap, off-map) is the UI's job — the pure layer
//     accepts `position` as-given because it doesn't know the world's island
//     list. UI pre-validation + `validateConstruction`'s material/tier checks
//     together keep the pure layer cleanly testable.
//   - Radii cap on founder tier at validate time (§2.5): T3 = 8, T4 = 12,
//     T5 = 16 (see `MAX_RADIUS_BY_TIER`).

import type { Biome, IslandSpec } from './world.js';
import { BIOME_DEFS, rollModifiersArtificial } from './biomes.js';
import { tierForLevel } from './skilltree.js';
import type { IslandState } from './economy.js';
import { attachTerrainAt, makeInitialIslandState } from './world.js';
import { canPlaceOnIsland, LAND_TILE_COST, type BuildingDef } from './building-defs.js';
import { hasOperationalBuilding } from './buildings.js';
import type { ResourceId } from './recipes.js';

// Cost formula (§2.5 — "scales with size and biome"). tileCount ≈ ellipse
// area (π × major × minor); per-material cost = ceil(tileCount × multiplier ×
// surcharge). Volcanic and Arctic carry a 50% surcharge per §3.4 (smallest
// natural radius caps → "harder" biomes). Multipliers are placeholders tuned
// to drain inventory meaningfully at the 4×4 minimum without blocking the demo.



/** Biomes that carry a +50% materials surcharge per §2.5 "scales with biome". */
const HARD_BIOMES: ReadonlyArray<Biome> = ['volcanic', 'arctic'];

/** Radii cap by founder tier per §2.5. T3 = 8×8, T4 = 12×12, T5 = 16×16. */
const MAX_RADIUS_BY_TIER: Readonly<Record<3 | 4 | 5, number>> = {
  3: 8,
  4: 12,
  5: 16,
};

export interface ConstructionRequirements {
  readonly biome: Biome;
  readonly majorRadius: number;
  readonly minorRadius: number;
}

export type ConstructionCost = Partial<Record<ResourceId, number>>;

export type ValidationReason =
  | 'tier-too-low'
  | 'no-platform-constructor'
  | 'radius-too-large'
  | 'insufficient-materials'
  | 'invalid-biome';

export interface ValidationResult {
  readonly ok: boolean;
  readonly reason?: ValidationReason;
}

export interface ConstructResult {
  readonly newSpec: IslandSpec;
  readonly newState: IslandState;
}

/**
 * Compute the per-resource cost of constructing an artificial island of the
 * given biome + ellipse radii. Pure function — no state, no validation.
 *
 * tileCount approximates ellipse area: π × major × minor. The resulting cost
 * is `ceil(tileCount × per-material multiplier) × (biome surcharge)`.
 * Volcanic and Arctic get the 1.5× surcharge per §2.5 "scales with biome".
 */
export function computeConstructionCost(req: ConstructionRequirements): ConstructionCost {
  const tileCount = Math.PI * req.majorRadius * req.minorRadius;
  const surcharge = HARD_BIOMES.includes(req.biome) ? 1.5 : 1.0;
  const out: ConstructionCost = {};
  for (const [r, n] of Object.entries(LAND_TILE_COST) as Array<[ResourceId, number]>) {
    out[r] = Math.ceil(tileCount * n * surcharge);
  }
  return out;
}

/**
 * Validate a construction request against the founder's state + spec. Pure
 * function — returns a result; does not throw, does not mutate.
 *
 * Checks (order matches the `ValidationReason` union for predictable error
 * surfacing):
 *   1. founder is T3+ (level ≥ 15 via `tierForLevel`).
 *   2. founder has at least one `platform_constructor` placed.
 *   3. requested biome is in BIOME_DEFS.
 *   4. radii are within the founder-tier cap from `MAX_RADIUS_BY_TIER`
 *      (T3 = 8, T4 = 12, T5 = 16 per §2.5).
 *   5. founder's inventory has ≥ each material cost.
 *
 * Position validity (overlap with existing islands, off-map placement) is
 * enforced at the UI layer — this function intentionally does not know
 * about the wider world's island list.
 */
export function validateConstruction(
  founderState: IslandState,
  founderSpec: IslandSpec,
  req: ConstructionRequirements,
): ValidationResult {
  // Tier gate (§2.5: T3+).
  const tier = tierForLevel(founderState.level);
  if (tier < 3) return { ok: false, reason: 'tier-too-low' };

  const hasPc = hasOperationalBuilding(founderSpec.buildings, 'platform_constructor');
  if (!hasPc) return { ok: false, reason: 'no-platform-constructor' };

  if (!(req.biome in BIOME_DEFS)) return { ok: false, reason: 'invalid-biome' };

  // Radii cap per §2.5: T3 = 8, T4 = 12, T5 = 16. Tiers below 3 fall back
  // to the T3 cap — they're already rejected above by the tier gate, but
  // the lookup needs a default to satisfy TypeScript.
  const cap = MAX_RADIUS_BY_TIER[tier as 3 | 4 | 5] ?? MAX_RADIUS_BY_TIER[3];
  if (req.majorRadius > cap || req.minorRadius > cap) {
    return { ok: false, reason: 'radius-too-large' };
  }
  // Negative or zero radii are also "too large" semantically — a 0-radius
  // island has no tiles. Reuse the same reason rather than inventing a new one.
  if (req.majorRadius <= 0 || req.minorRadius <= 0) {
    return { ok: false, reason: 'radius-too-large' };
  }

  const cost = computeConstructionCost(req);
  const inv = founderState.inventory;
  for (const [r, n] of Object.entries(cost) as Array<[ResourceId, number]>) {
    if ((inv[r] ?? 0) < n) return { ok: false, reason: 'insufficient-materials' };
}

  return { ok: true };
}

/**
 * Construct an artificial island. MUTATES `founderState` (deducts materials
 * from its inventory) and returns the new spec + state. Throws if the
 * request fails `validateConstruction` — callers MUST validate first.
 *
 * The new island is:
 *   - populated: true (artificial islands are "built ready to use")
 *   - discovered: true (implied by populated)
 *   - artificial: true (§2.5 marker for future biome-locked-unique gating)
 *   - modifiers: rolled from natural distribution excluding natural-only
 *               entries per §2.5 (aetheric_anomaly, frozen_core)
 *   - buildings: [] (player builds out manually)
 *   - terrainAt: biome-typed scatter via `terrainAtForBiome(biome, islandId, x, y)`
 *
 * The new state is built via `makeInitialIslandState`, which yields level 1,
 * empty XP, no skill points, and a fresh inventory. Position (`cx`, `cy`)
 * and `islandId` are supplied by the caller — the UI generates the id
 * (typically a short `art-<n>` slug) and resolves position from the form.
 */
export function constructIsland(
  worldSeed: string,
  founderState: IslandState,
  founderSpec: IslandSpec,
  req: ConstructionRequirements,
  position: { cx: number; cy: number },
  islandId: string,
  nowMs: number,
  /** Optional player-supplied display name. Defaults to `islandId`. The
   *  caller validates trim/length/control-char; this function trusts its
   *  input (mirrors how `position` is trusted — overlap is a UI concern). */
  displayName?: string,
): ConstructResult {
  const valid = validateConstruction(founderState, founderSpec, req);
  if (!valid.ok) {
    throw new Error(`constructIsland: invalid request (${valid.reason ?? 'unknown'})`);
  }

  // Deduct materials. Validation has already confirmed sufficient balance,
  // so subtraction is safe without re-checking.
  const cost = computeConstructionCost(req);
  for (const [r, n] of Object.entries(cost) as Array<[ResourceId, number]>) {
    founderState.inventory[r] = (founderState.inventory[r] ?? 0) - n;
  }

  // Mint the new spec via the shared `attachTerrainAt` helper — its closure
  // captures the spec by reference so any future §3.6 merge that mutates
  // `extraEllipses` is observed live (no closure-capture of radii). The
  // helper centralises the readonly-widening cast that was previously
  // inlined here.
  const biome = req.biome;
  const newSpec: IslandSpec = attachTerrainAt({
    id: islandId,
    name: displayName ?? islandId,
    biome,
    cx: position.cx,
    cy: position.cy,
    majorRadius: req.majorRadius,
    minorRadius: req.minorRadius,
    populated: true,
    discovered: true,
    buildings: [],
    modifiers: rollModifiersArtificial(worldSeed, biome, islandId, nowMs),
    artificial: true,
  });
  const newState = makeInitialIslandState(newSpec, nowMs);
  return { newSpec, newState };
}

/** Exported for the UI's "next radius cap" indicator. Returns the maximum
 *  major OR minor radius the founder's tier allows. T3 caps at 8; T4 at 12;
 *  T5 at 16. Returns 0 for founders below T3 (artificial construction is
 *  closed at T1/T2 entirely — the validate function blocks that path before
 *  this is consulted, but the UI uses this for slider bounds). */
export function maxRadiusForFounderLevel(level: number): number {
  const tier = tierForLevel(level);
  if (tier < 3) return 0;
  return MAX_RADIUS_BY_TIER[tier as 3 | 4 | 5] ?? MAX_RADIUS_BY_TIER[3];
}

// Step-12: biome-locked-unique placement gate (§9.5).
//
// `canPlaceOnIsland` is the canonical pure check (in `building-defs.ts`).
// `validateBuildingPlacement` adds a reason-code layer for UI surfacing —
// step 12 hooks the catalog tooltip, step 2.5 will hook the placement
// validator. The two reasons mirror the two gates inside `canPlaceOnIsland`:
//   - `biome-mismatch` — the def has `requiredBiomes` and the island's
//     biome is not in the set (e.g. Pyroforge on a Forest island).
//   - `artificial-island-biome-locked` — the def has `requiredBiomes` and
//     the island is artificial. Per §9.5 "Artificial islands cannot host
//     biome-locked uniques."

export type PlacementReason = 'biome-mismatch' | 'artificial-island-biome-locked';

export interface PlacementResult {
  readonly ok: boolean;
  readonly reason?: PlacementReason;
}

/**
 * Validate placement of a single biome-locked building on a target island.
 * Pure — returns a reasoned result; does not throw, does not mutate.
 *
 * Unrestricted defs (no `requiredBiomes`) always return `{ ok: true }`.
 * Restricted defs check biome match first, then the artificial flag — the
 * biome reason is preferred when both fail (a Volcanic-locked def on an
 * artificial Forest island fails on biome match, which is the more
 * actionable error for the player).
 */
export function validateBuildingPlacement(
  def: BuildingDef,
  spec: IslandSpec,
): PlacementResult {
  if (canPlaceOnIsland(def, spec)) return { ok: true };
  if (def.requiredBiomes && !def.requiredBiomes.includes(spec.biome)) {
    return { ok: false, reason: 'biome-mismatch' };
  }
  // Reaching here means the biome IS in requiredBiomes but the island is
  // artificial — the §9.5 gate.
  return { ok: false, reason: 'artificial-island-biome-locked' };
}
