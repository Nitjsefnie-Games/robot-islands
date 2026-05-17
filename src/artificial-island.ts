// Pure logic for §2.5 artificial-island construction.
//
// Mirrors the catalog/pure-function style of `biomes.ts`: a small set of
// data types + functions that compute cost / validate inputs / mint the
// new spec+state. No PixiJS, no DOM, no input.ts dependency. The UI layer
// (`construction-ui.ts`) is responsible for collecting the inputs and
// surfacing the validation result; this module owns the math.
//
// Per §2.5: a T3+ island with a Platform Constructor can construct a new
// island instantly. Cost scales with biome and target ellipse size; the
// founder pays out of its own inventory. Settlement-vehicle delivery
// (§2.3) is the natural-colonisation path and is intentionally a separate
// concern — artificial construction "skips the ship".
//
// Forward-compat notes:
//   - The `artificial: true` flag on the returned `IslandSpec` is set so
//     future systems (§3.5 modifier rolls excluding rare-natural-only,
//     §9.5 biome-locked-unique placement gate) can identify constructed
//     islands. Step 11 has no current consumer; reserved for step 12.
//   - Position validity (overlap with existing islands) is the UI's job —
//     this module accepts `position` as-given because the pure layer
//     doesn't know about the world's island list. The UI's pre-validation
//     plus `validateConstruction`'s material/tier checks together keep the
//     pure layer cleanly testable.
//   - T3 caps at major=8, minor=8 (§2.5). T4 = 12×12 and T5 = 16×16 are
//     live (see `MAX_RADIUS_BY_TIER`); the cap lookup keys on the founder
//     state's tier at validate time.

import type { Biome, IslandSpec } from './world.js';
import { BIOME_DEFS, rollModifiersArtificial } from './biomes.js';
import { tierForLevel } from './skilltree.js';
import type { IslandState } from './economy.js';
import { attachTerrainAt, makeInitialIslandState } from './world.js';
import { canPlaceOnIsland, type BuildingDef } from './building-defs.js';

// ---------------------------------------------------------------------------
// Cost formula (§2.5 placeholder — "scales with size and biome")
// ---------------------------------------------------------------------------
//
// Per spec, costs scale with target tile count and biome. Step-11 placeholders:
//   tileCount   = π × majorRadius × minorRadius  (ellipse area, approximate)
//   steel       = ceil(tileCount × 5)
//   iron_ingot  = ceil(tileCount × 3)
//   wood        = ceil(tileCount × 10)
//
// Volcanic and Arctic are flagged "harder" biomes per §3.4 (volcanic max
// natural radius is 14, arctic 14 — the smallest natural caps) so we apply a
// 50% surcharge on every material. The other four biomes use the base rate.
//
// Numbers are placeholders that produce meaningful inventory drains at the
// 4×4 minimum (50 tiles × multipliers ≈ 250 steel / 150 iron / 500 wood)
// without blocking the demo entirely. The cost-curve will be retuned once
// the wider economy progresses (settlement vehicles, T3 chains, etc.).

const STEEL_PER_TILE = 5;
const IRON_INGOT_PER_TILE = 3;
const WOOD_PER_TILE = 10;

/** Biomes that carry a +50% materials surcharge per §2.5 "scales with biome". */
const HARD_BIOMES: ReadonlyArray<Biome> = ['volcanic', 'arctic'];

/** Radii cap by founder tier per §2.5. T3 = 8×8, T4 = 12×12, T5 = 16×16. */
const MAX_RADIUS_BY_TIER: Readonly<Record<3 | 4 | 5, number>> = {
  3: 8,
  4: 12,
  5: 16,
};

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export interface ConstructionRequirements {
  readonly biome: Biome;
  readonly majorRadius: number;
  readonly minorRadius: number;
}

export interface ConstructionCost {
  readonly steel: number;
  readonly iron_ingot: number;
  readonly wood: number;
}

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

// ---------------------------------------------------------------------------
// Pure functions
// ---------------------------------------------------------------------------

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
  return {
    steel: Math.ceil(tileCount * STEEL_PER_TILE * surcharge),
    iron_ingot: Math.ceil(tileCount * IRON_INGOT_PER_TILE * surcharge),
    wood: Math.ceil(tileCount * WOOD_PER_TILE * surcharge),
  };
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

  // Platform Constructor presence.
  const hasPc = founderSpec.buildings.some((b) => b.defId === 'platform_constructor');
  if (!hasPc) return { ok: false, reason: 'no-platform-constructor' };

  // Biome sanity check.
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

  // Material inventory check.
  const cost = computeConstructionCost(req);
  const inv = founderState.inventory;
  if ((inv.steel ?? 0) < cost.steel) return { ok: false, reason: 'insufficient-materials' };
  if ((inv.iron_ingot ?? 0) < cost.iron_ingot) return { ok: false, reason: 'insufficient-materials' };
  if ((inv.wood ?? 0) < cost.wood) return { ok: false, reason: 'insufficient-materials' };

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
  founderState.inventory.steel = (founderState.inventory.steel ?? 0) - cost.steel;
  founderState.inventory.iron_ingot = (founderState.inventory.iron_ingot ?? 0) - cost.iron_ingot;
  founderState.inventory.wood = (founderState.inventory.wood ?? 0) - cost.wood;

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

// ---------------------------------------------------------------------------
// Step-12: biome-locked-unique placement gate (§9.5)
// ---------------------------------------------------------------------------
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
