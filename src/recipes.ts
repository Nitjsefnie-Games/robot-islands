// Resources, recipes, and xp_weight table.
//
// Per SPEC §6 (Resource Catalog) and §7 (Recipe Chains) the full game has a
// large catalog. Step 3 needs only enough to drive two recipes through the
// `advanceIsland` tick loop:
//
//   - Mine: 1 iron_ore / 5s, no inputs (raw extraction)
//   - Workshop: 1 bolt from (1 iron_ore + 1 coal) / 10s
//
// `xp_weight` per SPEC §9.1: T0 raws = 1, T1 refined = 3, T2 component = 10.
// We mark iron_ingot at T1 weight even though step 3 has no recipe producing
// it — defining the constant now keeps the table consistent for future steps.
//
// Why bind recipes by `BuildingKind` rather than per-building instance:
// step 3 has hardcoded buildings (see buildings.ts) with no recipe field on
// the Building interface. A side-table keyed on `kind` lets us add recipes
// without touching the Building shape. When buildings become data-driven in
// a later step, the recipe can move onto the building definition itself.

import type { BuildingKind } from './buildings.js';

export type ResourceId = 'wood' | 'iron_ore' | 'coal' | 'iron_ingot' | 'bolt';

/** All known resources, useful for iterating to initialise inventories. */
export const ALL_RESOURCES: ReadonlyArray<ResourceId> = [
  'wood',
  'iron_ore',
  'coal',
  'iron_ingot',
  'bolt',
];

/**
 * XP weight per resource, per SPEC §9.1 (tier-weighted production).
 *   T0 raw       = 1   (wood, iron_ore, coal)
 *   T1 refined   = 3   (iron_ingot)
 *   T2 component = 10  (bolt)
 *
 * Higher-tier outputs grant proportionally more XP per unit produced, so the
 * progression curve rewards climbing the recipe chain rather than just
 * stockpiling raws.
 */
export const XP_WEIGHT: Readonly<Record<ResourceId, number>> = {
  wood: 1,
  iron_ore: 1,
  coal: 1,
  iron_ingot: 3,
  bolt: 10,
};

/**
 * A single recipe definition. `cycleSec` is the time for one production
 * cycle at base rate (rate = 1 / cycleSec). `inputs` lists per-cycle input
 * demand; `outputs` lists per-cycle output yield. Both are partial maps:
 * resources not listed are not involved.
 */
export interface Recipe {
  readonly cycleSec: number;
  readonly inputs: Partial<Record<ResourceId, number>>;
  readonly outputs: Partial<Record<ResourceId, number>>;
}

/**
 * Recipe binding by building kind. Buildings without a recipe (solar, dock)
 * are absent from the map.
 *
 * Step-3 chain:
 *   Mine     -> 1 iron_ore / 5s   (no inputs)
 *   Workshop -> 1 bolt / 10s from (1 iron_ore + 1 coal)
 *
 * Workshop stalls when iron_ore or coal hits zero (inputAvail = 0). Coal has
 * no producer in step 3, so the chain is guaranteed to stall eventually —
 * that's the deliberate demonstration of `inputAvail = 0` back-propagation
 * (§4.6 / §15.3).
 */
export const RECIPES: Partial<Record<BuildingKind, Recipe>> = {
  mine: {
    cycleSec: 5,
    inputs: {},
    outputs: { iron_ore: 1 },
  },
  workshop: {
    cycleSec: 10,
    inputs: { iron_ore: 1, coal: 1 },
    outputs: { bolt: 1 },
  },
  // Coal Gen burns 1 coal / 5s while active. Empty `outputs` is intentional —
  // the W contribution is on building.power.produces (§5.1), not a resource.
  coal_gen: {
    cycleSec: 5,
    inputs: { coal: 1 },
    outputs: {},
  },
};
