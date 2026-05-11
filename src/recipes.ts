// Resources, recipes, and xp_weight table.
//
// Per SPEC §6 (Resource Catalog) and §7 (Recipe Chains). Step 9 expands the
// catalog from the step-3 Mine+Workshop chain to the partial §7.1 Iron/Steel
// pipeline plus a forestry/biomass loop. Step 12 extends into the T4
// endgame chain (§6.5) — five new resources fed by the new T4 buildings:
//
//   T0/T1 raws:   wood, iron_ore, coal, biofuel
//   T1 refined:   iron_ingot, coke, pig_iron, bolt
//   T2 alloy:     steel
//   T2 component: gear
//   T4 raw/fuel:  helium_3, cryogenic_hydrogen
//   T4 component: quantum_chip, exotic_alloy, ai_core
//
// `xp_weight` per SPEC §9.1: T0 raws = 1, T1 = 3, T2 = 10, T4 = 100. Higher-tier
// outputs grant proportionally more XP per unit produced, so the progression
// curve rewards climbing the recipe chain rather than just stockpiling raws.

import type { BuildingDefId } from './building-defs.js';

export type ResourceId =
  // T0 raws
  | 'wood'
  | 'iron_ore'
  | 'coal'
  // T1 refined
  | 'biofuel'
  | 'iron_ingot'
  | 'coke'
  | 'pig_iron'
  | 'bolt'
  // T2 alloy / component
  | 'steel'
  | 'gear'
  // T4 endgame (§6.5)
  | 'helium_3'
  | 'cryogenic_hydrogen'
  | 'quantum_chip'
  | 'exotic_alloy'
  | 'ai_core';

/** All known resources, useful for iterating to initialise inventories. */
export const ALL_RESOURCES: ReadonlyArray<ResourceId> = [
  'wood',
  'iron_ore',
  'coal',
  'biofuel',
  'iron_ingot',
  'coke',
  'pig_iron',
  'bolt',
  'steel',
  'gear',
  'helium_3',
  'cryogenic_hydrogen',
  'quantum_chip',
  'exotic_alloy',
  'ai_core',
];

/**
 * XP weight per resource, per SPEC §9.1 (tier-weighted production).
 *   T0 raw       = 1   (wood, iron_ore, coal)
 *   T1 refined   = 3   (biofuel, iron_ingot, coke, pig_iron)
 *   T2 alloy /   = 10  (bolt, steel, gear)
 *      component
 *   T4 endgame   = 100 (helium_3, cryogenic_hydrogen, quantum_chip,
 *                       exotic_alloy, ai_core)
 */
export const XP_WEIGHT: Readonly<Record<ResourceId, number>> = {
  // T0 raws
  wood: 1,
  iron_ore: 1,
  coal: 1,
  // T1 refined
  biofuel: 3,
  iron_ingot: 3,
  coke: 3,
  pig_iron: 3,
  // T2 alloy / component
  bolt: 10,
  steel: 10,
  gear: 10,
  // T4 endgame (§6.5)
  helium_3: 100,
  cryogenic_hydrogen: 100,
  quantum_chip: 100,
  exotic_alloy: 100,
  ai_core: 100,
};

/**
 * Recipe categories per SPEC §7.0 / §9.4. Skill-tree effects and (later)
 * Specialization-passive buffs target recipes by category tag, not by
 * building kind — this keeps edge cases (Cracker is petrochemical, not
 * strictly smelting) consistent. The full catalog in §7 has more tags;
 * step 9 needs the seven listed below.
 */
export type RecipeCategory =
  | 'extraction'
  | 'smelting'
  | 'chemistry'
  | 'manufacturing'
  | 'electronics'
  | 'power'
  | 'logistics';

/** All recipe categories, useful for initialising per-category records to 1.0. */
export const ALL_RECIPE_CATEGORIES: ReadonlyArray<RecipeCategory> = [
  'extraction',
  'smelting',
  'chemistry',
  'manufacturing',
  'electronics',
  'power',
  'logistics',
];

/**
 * A single recipe definition. `cycleSec` is the time for one production
 * cycle at base rate (rate = 1 / cycleSec). `inputs` lists per-cycle input
 * demand; `outputs` lists per-cycle output yield. Both are partial maps:
 * resources not listed are not involved. `category` tags the recipe for
 * skill-tree and specialization effects (§9.3/§9.4).
 */
export interface Recipe {
  readonly cycleSec: number;
  readonly inputs: Partial<Record<ResourceId, number>>;
  readonly outputs: Partial<Record<ResourceId, number>>;
  readonly category: RecipeCategory;
}

/**
 * Recipe binding by building defId. Buildings without a recipe (Solar, Dock,
 * Crate, Silo, Tank, Drone Pad) are absent from the map.
 *
 * Step-9 chain (partial §7.1 Iron/Steel + auxiliaries):
 *
 *   T1 extraction:
 *     mine     -> 1 iron_ore  / 5s   (no inputs)
 *     logger   -> 1 wood      / 4s   (no inputs; tile-req `tree` deferred)
 *
 *   T1 smelting / refining:
 *     smelter  -> 1 iron_ingot / 8s  from 1 iron_ore + 1 coal
 *
 *   T1 manufacturing:
 *     workshop -> 1 bolt      / 10s  from 1 iron_ore + 1 coal
 *
 *   T1 power-burn (no resource output; W on def.power.produces):
 *     coal_gen        -> burns 1 coal / 5s
 *     biomass_plant   -> burns 1 wood / 6s
 *
 *   T2 smelting / refining:
 *     coke_oven       -> 1 coke      / 10s from 1 coal
 *     blast_furnace   -> 1 pig_iron  / 12s from 1 iron_ingot + 1 coke
 *                        (§5.2 heat-source adjacency deferred)
 *     steel_mill      -> 1 steel     / 15s from 1 pig_iron
 *                        (§7.1 scrap co-input deferred)
 *
 *   T2 manufacturing:
 *     assembler       -> 1 gear      /  8s from 1 iron_ingot + 2 bolt
 *
 *   T3 smelting:
 *     electric_arc_furnace -> 1 steel / 6s from 1 pig_iron
 *                              (higher-throughput alternative to Steel Mill)
 */
export const RECIPES: Partial<Record<BuildingDefId, Recipe>> = {
  // T1 extraction
  mine: {
    cycleSec: 5,
    inputs: {},
    outputs: { iron_ore: 1 },
    category: 'extraction',
  },
  logger: {
    cycleSec: 4,
    inputs: {},
    outputs: { wood: 1 },
    category: 'extraction',
  },

  // T1 smelting
  smelter: {
    cycleSec: 8,
    inputs: { iron_ore: 1, coal: 1 },
    outputs: { iron_ingot: 1 },
    category: 'smelting',
  },

  // T1 manufacturing
  workshop: {
    cycleSec: 10,
    inputs: { iron_ore: 1, coal: 1 },
    outputs: { bolt: 1 },
    category: 'manufacturing',
  },

  // T1 power-burn (Coal Gen burns 1 coal/5s; W contribution lives on
  // def.power.produces, not in `outputs`). Empty `outputs` is intentional.
  coal_gen: {
    cycleSec: 5,
    inputs: { coal: 1 },
    outputs: {},
    category: 'power',
  },
  biomass_plant: {
    cycleSec: 6,
    inputs: { wood: 1 },
    outputs: {},
    category: 'power',
  },

  // T2 smelting
  coke_oven: {
    cycleSec: 10,
    inputs: { coal: 1 },
    outputs: { coke: 1 },
    category: 'smelting',
  },
  blast_furnace: {
    cycleSec: 12,
    inputs: { iron_ingot: 1, coke: 1 },
    outputs: { pig_iron: 1 },
    category: 'smelting',
  },
  steel_mill: {
    cycleSec: 15,
    inputs: { pig_iron: 1 },
    outputs: { steel: 1 },
    category: 'smelting',
  },

  // T2 manufacturing
  assembler: {
    cycleSec: 8,
    inputs: { iron_ingot: 1, bolt: 2 },
    outputs: { gear: 1 },
    category: 'manufacturing',
  },

  // T3 smelting (higher-throughput steel alternative)
  electric_arc_furnace: {
    cycleSec: 6,
    inputs: { pig_iron: 1 },
    outputs: { steel: 1 },
    category: 'smelting',
  },

  // ---------------------------------------------------------------------------
  // T4 endgame chain (§6.5 / §7.11 / §8.2 / §9.5)
  // ---------------------------------------------------------------------------
  // Dependency arrow: particle_accelerator → quantum_chip
  //                   → cryogenic_compute_center (ARCTIC) → ai_core
  //                   pyroforge (VOLCANIC) → exotic_alloy (uses helium_3 fuel)
  //                   fusion_core → power-burn (uses helium_3 fuel)
  // helium_3 is a §6.4 T3 raw mined naturally (Vault terrain) — not produced
  // by any building in step 12. It is seeded on forest-ne for demo only.
  // The chain is NOT fully exercisable on forest-ne (no Arctic/Volcanic) —
  // that's intended demo behaviour per §9.5 biome-locked uniques.

  // T4 power — Fusion Core burns helium_3 as fuel; W contribution lives on
  // def.power.produces (5000W), not in `outputs`. Empty outputs intentional.
  fusion_core: {
    cycleSec: 30,
    inputs: { helium_3: 1 },
    outputs: {},
    category: 'power',
  },

  // T4 biome-locked smelting — Volcanic-only Pyroforge produces Exotic Alloy
  // from Steel + Helium-3 fuel. Per §9.5, only producer of Exotic Alloy in
  // the world. §5.2 heat-source adjacency deferred.
  pyroforge: {
    cycleSec: 60,
    inputs: { steel: 5, helium_3: 1 },
    outputs: { exotic_alloy: 1 },
    category: 'smelting',
  },

  // T4 biome-locked electronics — Arctic-only Cryogenic Compute Center
  // produces AI Cores from Steel + Quantum Chip. Per §9.5, only producer of
  // AI Cores in the world. Arctic ambient cold halves compute-recipe power
  // draw (deferred — modelled at static 1200W in step 12).
  cryogenic_compute_center: {
    cycleSec: 90,
    inputs: { steel: 3, quantum_chip: 1 },
    outputs: { ai_core: 1 },
    category: 'electronics',
  },

  // T4 electronics — Particle Accelerator produces Quantum Chips from
  // Steel + Pig Iron. Not biome-locked (only Carbon Forge / Pyroforge /
  // Cryogenic Compute Center / Mass Driver / Tidal Array / Sunspire are).
  // Tagged `electronics` because Quantum Chip is the T4 electronics
  // intermediate; the building's name is metallurgy-coded but its output
  // is an electronics component.
  particle_accelerator: {
    cycleSec: 45,
    inputs: { steel: 4, pig_iron: 4 },
    outputs: { quantum_chip: 1 },
    category: 'electronics',
  },
};
