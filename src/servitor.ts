// Pure Eternal Servitor conversion (NO pixi.js import).
//
// Extracted from `buildings.ts` so the server can run §13.3 conversion
// authoritatively without dragging in the PixiJS render layer.

import type { BuildingDef, BuildingDefId } from './building-defs.js';
import type { IslandState } from './economy.js';
import { MAINTENANCE_RECIPES } from './maintenance.js';
import type { ResourceId } from './recipes.js';

export type ConvertToServitorResult =
  | { readonly ok: true; readonly cost: Partial<Record<ResourceId, number>> }
  | { readonly ok: false; readonly reason: 'building-not-found' | 'already-servitor' | 'insufficient-materials' };

/**
 * Convert a placed building to its Eternal Servitor variant per §13.3.
 * Consumes the §13.3 Conversion Kit recipe from `state.inventory`:
 * 1 Eldritch Processor + 1 Phase Converter + the building's tier maintenance
 * recipe (from MAINTENANCE_RECIPES). Sets `building.eternalServitor = true`.
 * Conversion is permanent — converted buildings cannot revert.
 *
 * Pure: mutates `state.inventory` and the target building in place. Does
 * NOT consult a Reality Forge presence — that gate is the UI's job (the
 * "Convert" button is only shown when the island has an operational
 * Reality Forge). This keeps the pure layer testable without UI state.
 */
export function convertToServitor(
  state: IslandState,
  buildingId: string,
  defs: Readonly<Record<BuildingDefId, BuildingDef>>,
): ConvertToServitorResult {
  const building = state.buildings.find((b) => b.id === buildingId);
  if (!building) return { ok: false, reason: 'building-not-found' };
  if (building.eternalServitor === true) return { ok: false, reason: 'already-servitor' };

  // Conversion Kit cost: maintenance recipe for the building's tier +
  // 1 Eldritch Processor + 1 Phase Converter.
  const def = defs[building.defId];
  const maintBill = MAINTENANCE_RECIPES[def.tier];
  const cost: Partial<Record<ResourceId, number>> = {};
  for (const [r, qty] of Object.entries(maintBill)) {
    cost[r as ResourceId] = (cost[r as ResourceId] ?? 0) + (qty ?? 0);
  }
  cost.eldritch_processor = (cost.eldritch_processor ?? 0) + 1;
  cost.phase_converter = (cost.phase_converter ?? 0) + 1;

  for (const [r, need] of Object.entries(cost)) {
    if ((state.inventory[r as ResourceId] ?? 0) < (need ?? 0)) {
      return { ok: false, reason: 'insufficient-materials' };
    }
  }

  // Deduct + flip flag.
  for (const [r, need] of Object.entries(cost)) {
    state.inventory[r as ResourceId] =
      (state.inventory[r as ResourceId] ?? 0) - (need ?? 0);
  }
  building.eternalServitor = true;

  return { ok: true, cost };
}
