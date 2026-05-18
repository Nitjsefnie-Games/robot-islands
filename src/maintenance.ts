// Pure maintenance system per SPEC §4.7.
//
// Each placed building accrues wall-clock operating time from the moment it
// is placed. Once the cumulative operating time exceeds the tier-dependent
// threshold, the building enters a "needs maintenance" state and its
// effective output efficiency degrades linearly from 100% to 50% over the
// following 4 real-time hours. The factor floors at 0.5 — the building keeps
// running at half-rate indefinitely until maintenance materials arrive.
//
// Maintenance is consumed automatically: as soon as the required materials
// for the building's tier are present in the island inventory at a
// maintenance check, the materials are deducted and `operatingMs` resets to
// zero, restoring full efficiency.
//
// This module is pure: no PixiJS, no DOM, no Date.now(). The economy loop
// drives accrual via `accrueOperatingTime` inside its piecewise integration
// segment, and `tryAutoMaintain` at each segment boundary. Persistence and
// inspector UI read the same factor via `maintenanceFactor`.
//
// §13.3 Eternal Servitor exemption: a PlacedBuilding flagged with
// `eternalServitor: true` skips all maintenance accrual and degradation.
// The Servitor-Conversion-Kit cost is consumed in `convertToServitor`
// (`buildings.ts`); the player triggers it from the inspector "Convert"
// button when the active island has an operational Reality Forge.

import type { BuildingDef } from './building-defs.js';
import type { PlacedBuilding } from './buildings.js';
import type { ResourceId } from './recipes.js';
import type { Tier } from './skilltree.js';

/** Per-tier operating-time budget before maintenance is due, in ms. Placeholder
 *  values from §4.7 (T1=12h, T2=16h, T3=20h, T4=24h, T5=24h, T6=24h). T6
 *  Spaceport (§14) mechanics are wired through `orbital.ts`; the maintenance
 *  cadence here applies uniformly. */
export const MAINTENANCE_THRESHOLD_MS_BY_TIER: Readonly<Record<Tier, number>> = {
  1: 12 * 60 * 60 * 1000,
  2: 16 * 60 * 60 * 1000,
  3: 20 * 60 * 60 * 1000,
  4: 24 * 60 * 60 * 1000,
  5: 24 * 60 * 60 * 1000,
  // §4.7 doesn't specify T6 explicitly (T6 is §14 territory); placeholder
  // matches T4/T5 cadence so the forward-compat table is exhaustive.
  6: 24 * 60 * 60 * 1000,
};

/** Once over threshold, the output multiplier linearly drops from 1.0 to 0.5
 *  over this window (§4.7 placeholder = 4 hours). After this elapses, the
 *  building stays at 0.5 indefinitely until maintenance fires. */
export const MAINTENANCE_DEGRADE_DURATION_MS = 4 * 60 * 60 * 1000;

/** Per-tier maintenance recipe — exact units consumed when an auto-maintenance
 *  cycle fires. Materials must all be present in `state.inventory` for the
 *  cycle to consume; partial fulfilment is not allowed.
 *
 *  Lubricant counts match §4.7 literally for every tier. */
export const MAINTENANCE_RECIPES: Readonly<Record<Tier, Partial<Record<ResourceId, number>>>> = {
  1: { lubricant: 2, bolt: 5 },
  // T2 maintenance matches §4.7 spec literal.
  2: { lubricant: 3, bearing: 5 },
  // T3: spec literal is `5 Lubricant + 1 Electric motor + 1 Capacitor`.
  // Both motor + capacitor are now in the catalog (Tasks 10.6 / 9.2). The
  // earlier microchip + quantum_chip stand-in caused a chicken-and-egg —
  // T3 buildings hit threshold at 20h but quantum_chip required T4 access
  // (level 30+). Resolved by switching to the spec literal here.
  3: { lubricant: 5, electric_motor: 1, capacitor: 1 },
  4: { lubricant: 10, exotic_alloy: 1, microchip: 1 },
  5: { lubricant: 15, phase_converter: 1, eldritch_processor: 1 },
  // T6 maintenance matches §4.7 spec literal.
  6: { lubricant: 25, reality_anchor: 1, memetic_core: 1 },
};

/**
 * Compute the per-building output-efficiency multiplier given accumulated
 * operating time and the building's tier. Pure: no state mutation.
 *
 *   operatingMs < threshold           → 1.0
 *   threshold ≤ operatingMs < threshold + 4h
 *                                     → 1.0 - 0.5 × (operatingMs - threshold) / 4h
 *   operatingMs ≥ threshold + 4h      → 0.5
 *
 * Eternal Servitors and undefined-operatingMs (forward-compat for saved
 * buildings minted before this field existed) are treated as 1.0.
 */
export function maintenanceFactor(
  b: PlacedBuilding,
  def: BuildingDef,
  thresholdMul = 1,
): number {
  if (b.eternalServitor === true) return 1.0;
  const operating = b.operatingMs ?? 0;
  const threshold = MAINTENANCE_THRESHOLD_MS_BY_TIER[def.tier] * thresholdMul;
  if (operating < threshold) return 1.0;
  const overshoot = operating - threshold;
  if (overshoot >= MAINTENANCE_DEGRADE_DURATION_MS) return 0.5;
  // Linear ramp 1.0 → 0.5 over 4h.
  return 1.0 - 0.5 * (overshoot / MAINTENANCE_DEGRADE_DURATION_MS);
}

/**
 * Tier-recipe lookup with deferred-fallback safety. Returns the bill of
 * materials owed by a single maintenance cycle on this building. Eternal
 * Servitors return an empty bill (they never consume).
 */
export function maintenanceRecipeFor(
  b: PlacedBuilding,
  def: BuildingDef,
): Partial<Record<ResourceId, number>> {
  if (b.eternalServitor === true) return {};
  return MAINTENANCE_RECIPES[def.tier];
}

/**
 * Attempt an auto-maintenance cycle. Returns true if the cycle fired
 * (materials consumed, operatingMs reset, maintainedAt updated); false
 * otherwise. Pure-mutation: only `inventory` and the building's
 * `operatingMs` / `maintainedAt` are touched.
 *
 * Spec §4.7: "If maintenance materials are not present when due, the
 * building stays in its degraded state. The instant materials become
 * available, an automatic maintenance cycle runs..."
 *
 * `nowMs` is the wall-clock timestamp the maintenance check fires at — used
 * to stamp `maintainedAt`. The economy loop passes its segment-boundary
 * time so the stamp lives in the same perf-clock domain as `lastTick`.
 *
 * Eternal Servitors and below-threshold buildings short-circuit to false:
 * no cycle to run, no materials consumed.
 */
export function tryAutoMaintain(
  b: PlacedBuilding,
  def: BuildingDef,
  inventory: Record<ResourceId, number>,
  nowMs: number,
  thresholdMul = 1,
): boolean {
  if (b.eternalServitor === true) return false;
  const operating = b.operatingMs ?? 0;
  const threshold = MAINTENANCE_THRESHOLD_MS_BY_TIER[def.tier] * thresholdMul;
  if (operating < threshold) return false;
  const recipe = MAINTENANCE_RECIPES[def.tier];
  // Atomicity: check ALL inputs available before consuming any. Without this
  // a partial set would burn the lubricant and still leave the building
  // unmaintained — surprising and unrecoverable on the next tick.
  for (const [r, need] of Object.entries(recipe)) {
    const id = r as ResourceId;
    if ((inventory[id] ?? 0) < (need ?? 0)) return false;
  }
  for (const [r, need] of Object.entries(recipe)) {
    const id = r as ResourceId;
    inventory[id] = (inventory[id] ?? 0) - (need ?? 0);
  }
  // PlacedBuilding's fields are `readonly` at the type level — same
  // doc-convention pattern as `cargoLabel` mutation in inspector-ui.ts.
  // The economy already mutates `discovered` / `populated` on IslandSpec
  // through similar casts.
  (b as { operatingMs: number; maintainedAt: number }).operatingMs = 0;
  (b as { operatingMs: number; maintainedAt: number }).maintainedAt = nowMs;
  return true;
}

/**
 * Accrue `dtMs` to the building's operatingMs counter. Pure mutation. Skips
 * Eternal Servitors per §13.3 — they never accumulate maintenance debt.
 *
 * Called from the advanceIsland segment loop after `applyRates`. The
 * caller now filters out buildings without a productive recipe so this
 * function is only invoked for buildings whose `effectiveRate` actually
 * uses `maintenanceFactor` — power/storage/utility buildings never
 * accrue, because the spec's "output efficiency degrades" wording only
 * has bite when there's a recipe rate to degrade.
 */
export function accrueOperatingTime(b: PlacedBuilding, dtMs: number): void {
  if (b.eternalServitor === true) return;
  if (dtMs <= 0) return;
  const cur = b.operatingMs ?? 0;
  (b as { operatingMs: number }).operatingMs = cur + dtMs;
}

/**
 * Number of sub-segments the 4-hour linear ramp is divided into for the
 * §15.3 piecewise integration. Each sub-segment integrates at the
 * start-of-segment factor (which is constant by §15.3 invariant), so a
 * naive single-segment integration would over-produce by 33% during the
 * ramp (the linear region's true average factor is 0.75 vs the 1.0 used
 * at segment start). Sub-dividing into RAMP_SEGMENTS pieces lowers the
 * upper-bound error to `0.5 / 2 / RAMP_SEGMENTS` (≈ 6% at 4 segments).
 * Each sub-segment costs one full computeRates / findNextCapEvent /
 * applyRates pass, so the trade-off is bounded — even on a 24h offline
 * catchup with N buildings overlapping ramps, the loop tops out at
 * `(2 + RAMP_SEGMENTS) × B` event splits, well within the 10_000 safety
 * counter in advanceIsland.
 */
export const MAINTENANCE_RAMP_SEGMENTS = 8;

/**
 * Maintenance targeting policy: among all buildings whose maintenance
 * factor is below 1.0 (i.e. at-or-past their tier threshold), return the
 * single MOST-DEGRADED candidate. Returns `null` if no candidate exists.
 *
 * Eternal Servitors are excluded (maintenanceFactor returns 1.0 for them).
 * Ties are broken by `state.buildings` array order (which is placement
 * order in normal play; deterministic across save/load).
 *
 * Caller policy (economy.ts): only attempt to maintain THIS one building.
 * If insufficient materials are available, DO NOT fall through to a
 * less-degraded candidate — let the most-degraded one wait. This stops a
 * cheap T1 building from soaking up shared maintenance materials that
 * would otherwise have saved a near-plateau T3.
 */
export function pickMostDegradedTarget(
  buildings: ReadonlyArray<PlacedBuilding>,
  defs: Readonly<Record<string, BuildingDef>>,
  thresholdMul = 1,
): PlacedBuilding | null {
  let pick: PlacedBuilding | null = null;
  let lowest = 1.0;
  for (const b of buildings) {
    const def = defs[b.defId];
    if (!def) continue;
    const f = maintenanceFactor(b, def, thresholdMul);
    if (f >= 1.0) continue;
    if (f < lowest) {
      lowest = f;
      pick = b;
    }
  }
  return pick;
}

/**
 * Find the next operating-time boundary at which a building's maintenance
 * factor changes — either crossing into degraded state at `threshold`, the
 * next ramp sub-segment boundary inside the 4-hour linear-degrade window,
 * or landing on the 0.5 plateau at `threshold + 4h`. Returns null if the
 * building has no upcoming boundary (Eternal Servitor or already at
 * plateau).
 *
 * Used by `findNextCapEvent` (economy.ts) so a long offline-catchup segment
 * doesn't integrate at start-of-segment factor when the factor crosses a
 * boundary mid-segment.
 *
 * Returns the BOUNDARY operatingMs value (absolute, not a delta). The
 * caller converts to a wall-clock timestamp via `t + (boundary - operating)`.
 */
export function nextMaintenanceBoundaryMs(
  b: PlacedBuilding,
  def: BuildingDef,
  thresholdMul = 1,
): number | null {
  if (b.eternalServitor === true) return null;
  const operating = b.operatingMs ?? 0;
  const threshold = MAINTENANCE_THRESHOLD_MS_BY_TIER[def.tier] * thresholdMul;
  if (operating < threshold) return threshold;
  const plateau = threshold + MAINTENANCE_DEGRADE_DURATION_MS;
  if (operating >= plateau) return null;
  // Inside the ramp: walk forward to the next sub-segment boundary so a
  // long advanceIsland segment doesn't integrate one giant linear ramp at
  // start-of-segment factor. Each sub-segment is `4h / RAMP_SEGMENTS` wide.
  const stepMs = MAINTENANCE_DEGRADE_DURATION_MS / MAINTENANCE_RAMP_SEGMENTS;
  const stepsSoFar = Math.floor((operating - threshold) / stepMs);
  const next = threshold + (stepsSoFar + 1) * stepMs;
  // Clamp to plateau (the last sub-boundary lands exactly on plateau, by
  // integer arithmetic, but defense-in-depth against rounding fuzz).
  return Math.min(next, plateau);
}
