// Pure: Demolition Yard derived recipe (§6.7). A Demolition Yard automates the
// place-then-demolish loop for a selected target building: per cycle it consumes
// the un-refunded share of the target's placement cost and mints Scrap at the
// §6.7 recovery rate. The recipe is DERIVED from the target def — no recipe table
// entry, no real building instance. Mirrors the synthetic `{building}_scrapper`
// in scripts/bootstrap_planner_v3.py value-for-value.
//
// No PixiJS, no DOM. Runtime deps: building-defs (values), construction (value).
// recipes is imported type-only (stripped at runtime) → graph stays acyclic.
import {
  BUILDING_DEFS,
  SCRAP_RECOVERY_FRACTION,
  type BuildingDefId,
} from './building-defs.js';
import { BASE_CONSTRUCTION_MS_BY_TIER } from './construction.js';
import type { Recipe, ResourceId } from './recipes.js';

/** Build the Demolition Yard recipe for a target building type, or `undefined`
 *  when the target's basket is too small to mint ≥1 Scrap (or has no cost).
 *  - output: `floor(SCRAP_RECOVERY_FRACTION × Σ placementCost)` scrap
 *  - inputs: per resource `n − floor(n/2)` (place cost minus the 50% demolish
 *    refund); only positive nets are listed
 *  - cycleSec: the target tier's base construction time (ms → s) */
export function scrapRecipeForTarget(targetDefId: BuildingDefId): Recipe | undefined {
  const def = BUILDING_DEFS[targetDefId];
  const cost = def.placementCost;
  if (!cost) return undefined;
  let sum = 0;
  const inputs: Partial<Record<ResourceId, number>> = {};
  for (const [r, n] of Object.entries(cost) as Array<[ResourceId, number]>) {
    sum += n;
    const net = n - Math.floor(n / 2);
    if (net > 0) inputs[r] = net;
  }
  const scrap = Math.floor(sum * SCRAP_RECOVERY_FRACTION);
  if (scrap <= 0) return undefined;
  return {
    cycleSec: BASE_CONSTRUCTION_MS_BY_TIER[def.tier] / 1000,
    inputs,
    outputs: { scrap },
    category: 'smelting',
  };
}
