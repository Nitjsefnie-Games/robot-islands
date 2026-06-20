import type { ResourceId } from './recipes.js';

/**
 * §15.3 (A) / §4.6 — the DEFAULT-ON set for per-output Ignore Cap.
 *
 * These resources are SIDE outputs of buildings whose PRIMARY output is
 * valuable; a full bin must not (by default) stall the producer and starve the
 * primary. Each is stored up to cap and drawable; overflow above cap is voided
 * by `applyRates`' clamp. This is now the DEFAULT a player can override per
 * building (see `isOutputCapExempt`), not a hard rule. `slag` joins the set
 * (side output of smelter→iron_ingot, steel_mill→steel; consumer:
 * slag_reprocessor). `co2` is NOT here — it lives in `NON_STORED_OUTPUTS`.
 */
export const OUTPUT_CAP_EXEMPT: ReadonlySet<ResourceId> = new Set<ResourceId>([
  'co', 'refinery_gas', 'wood_tar', 'water_vapor', 'cryo_coolant_vented',
  'mill_scale', 'tar', 'asphalt', 'slag',
]);

/**
 * Effective per-(building, output-resource) Ignore Cap flag. A per-building
 * override (if present for `r`) wins; otherwise the global default applies.
 * Ignore-cap ON ⇒ a full `r` bin never stalls/throttles this building (overflow
 * voided), so it keeps running for XP on its other constraints.
 */
export function isOutputCapExempt(
  b: { readonly ignoreCapOverrides?: Partial<Record<ResourceId, boolean>> },
  r: ResourceId,
): boolean {
  return b.ignoreCapOverrides?.[r] ?? OUTPUT_CAP_EXEMPT.has(r);
}
