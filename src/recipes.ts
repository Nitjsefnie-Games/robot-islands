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
// Step-13 (T5 Transcendent, §6.6) adds a partial T5 catalog — just enough
// to drive the Reality Forge chain + T5 fuel:
//
//   T5 raw:       casimir_energy   (per §8.10 Casimir Tap "free vacuum energy")
//   T5 fuel:      plasma_charge    (T5 propellant per §6.6 / §11.7)
//   T5 component: reality_anchor, eldritch_processor, phase_converter
//
// Full §6.6 T5 raw catalog (Dark matter, Zero-point flux, Tachyon stream,
// Neutronium, Strange matter, Higgs flux, Quantum foam, Aetheric current,
// Spacetime fragment) is DEFERRED to step 14 — only the resources the
// Reality Forge / Casimir Tap demo recipes consume ship in step 13.
//
// `xp_weight` per SPEC §9.1: T0 raws = 1, T1 = 3, T2 = 10, T4 = 100, T5 = 300.
// Higher-tier outputs grant proportionally more XP per unit produced, so the
// progression curve rewards climbing the recipe chain rather than just
// stockpiling raws.

import type { BuildingDef, BuildingDefId } from './building-defs.js';
import type { PlacedBuilding } from './buildings.js';
import type { TerrainKind } from './island.js';

export type ResourceId =
  // T0 raws
  | 'wood'
  | 'iron_ore'
  | 'coal'
  // §6.7 demolition byproduct. T1 dry-good per spec ("Scrap is a T1 resource
  // in the dry-goods storage category"). The §6.7 Steel-recipe substitution
  // ("2 Scrap = 1 Pig iron's worth of steel input") is DEFERRED — for step
  // 2.5 the resource exists only as the credit returned on demolition.
  | 'scrap'
  // Step-18 T0 raws (§6.1 / §6.2). Added so every §7 recipe input has at
  // least one producer in the catalog. Per-tile gating on extraction
  // (Quarry → stone tile, Well → water tile, etc.) is DEFERRED — the
  // step-18 producers run anywhere. See building-defs.ts for the matching
  // §8.1 tile-requirement comment per def.
  | 'stone'
  | 'sand'
  | 'fresh_water'
  | 'saltwater'
  | 'salt'
  | 'crude_oil'
  | 'natural_gas'
  | 'quartz'
  | 'hydrogen'
  // T1 refined
  | 'biofuel'
  | 'iron_ingot'
  | 'coke'
  | 'pig_iron'
  | 'bolt'
  // Step-18 T1 refined (§6.2 / §7.3 / §7.4).
  | 'lumber'
  | 'glass'
  // T2 alloy / component
  | 'steel'
  | 'gear'
  // T1 composite (§12.3 Foundation Kit). Standard variant only — Enriched/
  // Refined per-tier variants deferred. The kit is a single inventory item;
  // its decomposition into raw constituents on arrival (§12.4) is deferred.
  | 'foundation_kit'
  // Step-18 T2 refined / petrochemical (§7.3).
  | 'naphtha'
  | 'chlorine'
  | 'lubricant'
  | 'diesel'
  | 'wire'
  // Step-18 T3 chemistry/electronics (§7.4 / §7.5).
  | 'silicon'
  | 'nitrogen'
  | 'cryo_coolant'
  | 'aviation_kerosene'
  | 'microchip'
  // T4 endgame (§6.5)
  | 'helium_3'
  | 'cryogenic_hydrogen'
  | 'quantum_chip'
  | 'exotic_alloy'
  | 'ai_core'
  // T5 transcendent (§6.6) — partial step-13 catalog (raws/components needed
  // for the Reality Forge demo chain + T5 fuel). Full §6.6 raws deferred.
  | 'casimir_energy'
  | 'reality_anchor'
  | 'plasma_charge'
  | 'eldritch_processor'
  | 'phase_converter'
  // Step-18 T5 raws (§6.6 / §8.10). Only the four raws CONSUMED by the
  // step-18 T5 refining recipes are added: aetheric_current and
  // tachyon_stream feed phase_converter; dark_matter and strange_matter
  // feed eldritch_processor. The remaining §6.6 raws (spacetime_fragment,
  // higgs_flux, quantum_foam, neutronium, zero-point_flux) are DEFERRED
  // until they have an explicit consumer.
  | 'aetheric_current'
  | 'tachyon_stream'
  | 'dark_matter'
  | 'strange_matter';

/** All known resources, useful for iterating to initialise inventories. */
export const ALL_RESOURCES: ReadonlyArray<ResourceId> = [
  'wood',
  'iron_ore',
  'coal',
  // §6.7 — Scrap credited on building demolition.
  'scrap',
  // Step-18 T0 raws.
  'stone',
  'sand',
  'fresh_water',
  'saltwater',
  'salt',
  'crude_oil',
  'natural_gas',
  'quartz',
  'hydrogen',
  'biofuel',
  'iron_ingot',
  'coke',
  'pig_iron',
  'bolt',
  // Step-18 T1 refined.
  'lumber',
  'glass',
  'steel',
  'gear',
  'foundation_kit',
  // Step-18 T2 petrochemical / refined.
  'naphtha',
  'chlorine',
  'lubricant',
  'diesel',
  'wire',
  // Step-18 T3 chemistry / electronics.
  'silicon',
  'nitrogen',
  'cryo_coolant',
  'aviation_kerosene',
  'microchip',
  'helium_3',
  'cryogenic_hydrogen',
  'quantum_chip',
  'exotic_alloy',
  'ai_core',
  // T5 transcendent (§6.6) — step-13 partial catalog
  'casimir_energy',
  'reality_anchor',
  'plasma_charge',
  'eldritch_processor',
  'phase_converter',
  // Step-18 T5 raws (only those consumed by step-18 recipes).
  'aetheric_current',
  'tachyon_stream',
  'dark_matter',
  'strange_matter',
];

/**
 * XP weight per resource, per SPEC §9.1 (tier-weighted production).
 *   T0 raw       = 1   (wood, iron_ore, coal)
 *   T1 refined   = 3   (biofuel, iron_ingot, coke, pig_iron)
 *   T2 alloy /   = 10  (bolt, steel, gear)
 *      component
 *   T4 endgame   = 100 (helium_3, cryogenic_hydrogen, quantum_chip,
 *                       exotic_alloy, ai_core)
 *   T5 transcendent = 300 (casimir_energy, reality_anchor, plasma_charge,
 *                          eldritch_processor, phase_converter)
 */
export const XP_WEIGHT: Readonly<Record<ResourceId, number>> = {
  // T0 raws
  wood: 1,
  iron_ore: 1,
  coal: 1,
  // §6.7 — Scrap is a T1 dry-good per spec; weight 3 to match other T1 raws.
  scrap: 3,
  // Step-18 T0 raws (§9.1 tier-1 weight).
  stone: 1,
  sand: 1,
  fresh_water: 1,
  saltwater: 1,
  salt: 1,
  crude_oil: 1,
  natural_gas: 1,
  quartz: 1,
  hydrogen: 1,
  // T1 refined
  biofuel: 3,
  iron_ingot: 3,
  coke: 3,
  pig_iron: 3,
  // Step-18 T1 refined.
  lumber: 3,
  glass: 3,
  // T2 alloy / component
  bolt: 10,
  steel: 10,
  gear: 10,
  // T1 composite (§12.3). xp_weight 10 — task brief assigns the kit the same
  // weight as T2 components since one kit represents a non-trivial assembly.
  foundation_kit: 10,
  // Step-18 T2 petrochemical / refined.
  naphtha: 10,
  chlorine: 10,
  lubricant: 10,
  diesel: 10,
  wire: 10,
  // Step-18 T3 chemistry / electronics (§9.1 tier-3 weight = 30).
  silicon: 30,
  nitrogen: 30,
  cryo_coolant: 30,
  aviation_kerosene: 30,
  microchip: 30,
  // T4 endgame (§6.5)
  helium_3: 100,
  cryogenic_hydrogen: 100,
  quantum_chip: 100,
  exotic_alloy: 100,
  ai_core: 100,
  // T5 transcendent (§6.6) — partial step-13 catalog
  casimir_energy: 300,
  reality_anchor: 300,
  plasma_charge: 300,
  eldritch_processor: 300,
  phase_converter: 300,
  // Step-18 T5 raws.
  aetheric_current: 300,
  tachyon_stream: 300,
  dark_matter: 300,
  strange_matter: 300,
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
 * A recipe id. Most ids match a `BuildingDefId` 1:1 — the recipe table is
 * keyed by the building that runs it. A few synthetic ids cover tile-variant
 * recipes for a single building kind, selected at runtime by
 * `resolveRecipe`:
 *
 *   - `mine_on_ore`  — Mine on an ore-vein footprint  → iron_ore
 *   - `mine_on_coal` — Mine on a coal-vein footprint → coal
 *
 * The legacy `mine` entry stays as a fallback recipe (= same as
 * `mine_on_ore`) so callers that don't pass a terrain closure into
 * `resolveRecipe` keep the pre-tile-aware behaviour.
 */
export type RecipeId = BuildingDefId | 'mine_on_ore' | 'mine_on_coal';

/**
 * Recipe binding by recipe id. Buildings without a recipe (Solar, Dock,
 * Crate, Silo, Tank, Drone Pad) are absent from the map.
 *
 * Step-9 chain (partial §7.1 Iron/Steel + auxiliaries):
 *
 *   T1 extraction:
 *     mine     -> 1 iron_ore  / 5s   (no inputs; fallback when no terrain
 *                                     closure is provided to resolveRecipe.
 *                                     Tile-aware callers receive
 *                                     mine_on_ore / mine_on_coal instead.)
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
 *                        (§5.2 heat-source adjacency: requires adjacent
 *                         Coal Furnace / Geothermal Vent / Plasma Heater /
 *                         Fusion Core; see heat.ts)
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
export const RECIPES: Partial<Record<RecipeId, Recipe>> = {
  // T1 extraction — rebalanced for idle-game scale, step #19 (×10)
  // `mine` is the legacy / fallback Mine recipe (= mine_on_ore). Tile-aware
  // callers go through `resolveRecipe` and receive `mine_on_ore` or
  // `mine_on_coal` depending on the building's footprint terrain. The
  // bare-defId lookup is preserved for tests + saved games that never had
  // a tile-aware path.
  mine: {
    cycleSec: 50, // rebalanced for idle-game scale, step #19 (×10: was 5s)
    inputs: {},
    outputs: { iron_ore: 1 },
    category: 'extraction',
  },
  // §8.1 Mine variants — tile-dependent recipe selection. The two entries
  // differ only in output: ore-vein footprint → iron_ore; coal-vein
  // footprint → coal. Inputs/cycleSec/category identical so a build-order
  // change in placement doesn't shift any other downstream rate.
  mine_on_ore: {
    cycleSec: 50, // rebalanced for idle-game scale, step #19 (×10: was 5s)
    inputs: {},
    outputs: { iron_ore: 1 },
    category: 'extraction',
  },
  mine_on_coal: {
    cycleSec: 50, // rebalanced for idle-game scale, step #19 (×10: was 5s)
    inputs: {},
    outputs: { coal: 1 },
    category: 'extraction',
  },
  logger: {
    cycleSec: 40, // rebalanced for idle-game scale, step #19 (×10: was 4s)
    inputs: {},
    outputs: { wood: 1 },
    category: 'extraction',
  },

  // T1 smelting — rebalanced for idle-game scale, step #19 (×10)
  smelter: {
    cycleSec: 80, // rebalanced for idle-game scale, step #19 (×10: was 8s)
    inputs: { iron_ore: 1, coal: 1 },
    outputs: { iron_ingot: 1 },
    category: 'smelting',
  },

  // T1 manufacturing — rebalanced for idle-game scale, step #19 (×10)
  workshop: {
    cycleSec: 100, // rebalanced for idle-game scale, step #19 (×10: was 10s)
    inputs: { iron_ore: 1, coal: 1 },
    outputs: { bolt: 1 },
    category: 'manufacturing',
  },

  // T1 power-burn: kept at short cycles so power keeps up with consumers
  // (per rebalance spec step #19 — power buildings stay at original scale).
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

  // T2 smelting — rebalanced for idle-game scale, step #19 (×40)
  coke_oven: {
    cycleSec: 400, // rebalanced for idle-game scale, step #19 (×40: was 10s)
    inputs: { coal: 1 },
    outputs: { coke: 1 },
    category: 'smelting',
  },
  blast_furnace: {
    cycleSec: 480, // rebalanced for idle-game scale, step #19 (×40: was 12s)
    inputs: { iron_ingot: 1, coke: 1 },
    outputs: { pig_iron: 1 },
    category: 'smelting',
  },
  steel_mill: {
    cycleSec: 600, // rebalanced for idle-game scale, step #19 (×40: was 15s)
    inputs: { pig_iron: 1 },
    outputs: { steel: 1 },
    category: 'smelting',
  },

  // T2 manufacturing — rebalanced for idle-game scale, step #19 (×40)
  assembler: {
    cycleSec: 320, // rebalanced for idle-game scale, step #19 (×40: was 8s)
    inputs: { iron_ingot: 1, bolt: 2 },
    outputs: { gear: 1 },
    category: 'manufacturing',
  },

  // T1 manufacturing — Kit Assembler (§12.3). rebalanced for idle-game scale, step #19 (×10)
  // Composite recipe producing a single Foundation Kit per cycle. Spec's full Standard
  // Foundation Kit is `50 Iron ingot + 20 Brick + 10 Lumber + 5 Glass + 5 Gear`; step-12
  // simplifies the bill to resources already in the catalog (iron_ingot,
  // wood, bolt) since Brick/Glass aren't catalogued yet.
  kit_assembler: {
    cycleSec: 600, // rebalanced for idle-game scale, step #19 (×10: was 60s)
    inputs: { iron_ingot: 5, wood: 10, bolt: 5 },
    outputs: { foundation_kit: 1 },
    category: 'manufacturing',
  },

  // T3 smelting (higher-throughput steel alternative) — rebalanced for idle-game scale, step #19 (×20)
  electric_arc_furnace: {
    cycleSec: 120, // rebalanced for idle-game scale, step #19 (×20: was 6s)
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
  // Rebalanced for idle-game scale, step #19 (×60: was 30s).
  fusion_core: {
    cycleSec: 1800, // rebalanced for idle-game scale, step #19 (×60: was 30s)
    inputs: { helium_3: 1 },
    outputs: {},
    category: 'power',
  },

  // T4 biome-locked smelting — Volcanic-only Pyroforge produces Exotic Alloy
  // from Steel + Helium-3 fuel. Per §9.5, only producer of Exotic Alloy in
  // the world. §5.2 heat-source adjacency required (see heat.ts).
  pyroforge: {
    cycleSec: 3600, // rebalanced for idle-game scale, step #19 (×60: was 60s)
    inputs: { steel: 5, helium_3: 1 },
    outputs: { exotic_alloy: 1 },
    category: 'smelting',
  },

  // T4 biome-locked electronics — Arctic-only Cryogenic Compute Center
  // produces AI Cores from Steel + Quantum Chip. Per §9.5, only producer of
  // AI Cores in the world. Arctic ambient cold halves compute-recipe power
  // draw (deferred — modelled at static 1200W in step 12).
  cryogenic_compute_center: {
    cycleSec: 5400, // rebalanced for idle-game scale, step #19 (×60: was 90s)
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
    cycleSec: 2700, // rebalanced for idle-game scale, step #19 (×60: was 45s)
    inputs: { steel: 4, pig_iron: 4 },
    outputs: { quantum_chip: 1 },
    category: 'electronics',
  },

  // ---------------------------------------------------------------------------
  // T5 Transcendent chain (§6.6 / §7.12 / §8.10 / step 13)
  // ---------------------------------------------------------------------------
  // Two recipes ship in step 13 to demonstrate the chain end-to-end:
  //   casimir_tap     → 1 casimir_energy / 1800s (no inputs; §8.10 "free vacuum energy")
  //   reality_forge   → 1 reality_anchor / 600s from 2 exotic_alloy + 1 ai_core + 1 casimir_energy
  // The §7.12 spec recipe ("4 ai_core + 1 antimatter_capsule + 1 time_crystal + 1 exotic_alloy
  // + 24h cycle → Reality Anchor") is the full T5 chain; the step-13 placeholder skips
  // antimatter_capsule + time_crystal (not yet in catalog) and condenses cycle time to 600s
  // so the demo chain is exercisable without a 24-hour wait. Full §7.12 recipe deferred
  // to step 14 alongside the missing T4 raws.

  // T5 raw extraction — placeholder for the §8.10 Casimir Tap. Spec cycle
  // 30 min to 4 h; already at 1800s (30 min lower bound) — skip rebalance
  // per step-19 spec (casimir_tap already at correct scale).
  casimir_tap: {
    cycleSec: 1800, // already at idle-game scale (30 min) — not multiplied in step #19
    inputs: {},
    outputs: { casimir_energy: 1 },
    category: 'power',
  },

  // T5 manufacturing — Reality Forge. Rebalanced for idle-game scale, step #19 (×8: was 600s).
  reality_forge: {
    cycleSec: 4800, // rebalanced for idle-game scale, step #19 (×8: was 600s)
    inputs: { exotic_alloy: 2, ai_core: 1, casimir_energy: 1 },
    outputs: { reality_anchor: 1 },
    category: 'manufacturing',
  },

  // ---------------------------------------------------------------------------
  // Step-18 recipe graph closure (§7.1-§7.12)
  // ---------------------------------------------------------------------------
  // The next block of recipes closes the resource graph: every resource
  // referenced as a recipe INPUT must have at least one producer. Cycle
  // times are placeholders chosen for "demonstrably tickable, not
  // balanced" — a later pass will rebalance. Per-tile placement gates
  // (Quarry → stone, Well → water, Pump Jack → oil_well) are DEFERRED
  // per the step-18 brief: producers run anywhere inside an island.

  // T1 extraction (§7.1 / §8.1 raws) — rebalanced for idle-game scale, step #19 (×10).
  // All have empty `inputs` and a single-resource output — same shape as the existing Mine/Logger.
  quarry: {
    cycleSec: 60, // rebalanced for idle-game scale, step #19 (×10: was 6s)
    inputs: {},
    outputs: { stone: 1 },
    category: 'extraction',
  },
  sand_pit: {
    cycleSec: 80, // rebalanced for idle-game scale, step #19 (×10: was 8s)
    inputs: {},
    outputs: { sand: 1 },
    category: 'extraction',
  },
  well: {
    cycleSec: 30, // rebalanced for idle-game scale, step #19 (×10: was 3s)
    inputs: {},
    outputs: { fresh_water: 1 },
    category: 'extraction',
  },
  coastal_pump: {
    cycleSec: 40, // rebalanced for idle-game scale, step #19 (×10: was 4s)
    inputs: {},
    outputs: { saltwater: 1 },
    category: 'extraction',
  },
  quartz_mine: {
    cycleSec: 120, // rebalanced for idle-game scale, step #19 (×10: was 12s)
    inputs: {},
    outputs: { quartz: 1 },
    category: 'extraction',
  },

  // T1 manufacturing / chemistry — T0 raws → T1 refined. Rebalanced for idle-game scale, step #19 (×10).
  lumber_mill: {
    cycleSec: 80, // rebalanced for idle-game scale, step #19 (×10: was 8s)
    inputs: { wood: 1 },
    outputs: { lumber: 1 },
    category: 'manufacturing',
  },
  glassworks: {
    cycleSec: 120, // rebalanced for idle-game scale, step #19 (×10: was 12s)
    inputs: { sand: 1 },
    outputs: { glass: 1 },
    category: 'manufacturing',
    // §5.2 mentions Glassworks as a heat-driven recipe; intentionally NOT
    // marked `requiresHeat` in this step. Step's scope is the §5.2 iron/steel
    // chain (Coke Oven / Blast Furnace / EAF / Pyroforge). Glassworks heat
    // gating ships when chemistry recipes that depend on heat also do.
  },
  evaporator: {
    cycleSec: 150, // rebalanced for idle-game scale, step #19 (×10: was 15s)
    inputs: { saltwater: 1 },
    outputs: { salt: 1 },
    category: 'manufacturing',
    // Orphan output: `salt` currently has no consumer in the catalog
    // (§7.3 chlor-alkali variants deferred). Producer ships for chain
    // completeness; consumer recipes deferred.
  },
  electrolyzer: {
    cycleSec: 100, // rebalanced for idle-game scale, step #19 (×10: was 10s)
    inputs: { fresh_water: 1 },
    outputs: { hydrogen: 1 },
    category: 'chemistry',
    // §6.2 byproduct `oxygen` deferred — Electrolyzer outputs hydrogen
    // only until an oxygen consumer lands.
  },
  biofuel_plant: {
    cycleSec: 150, // rebalanced for idle-game scale, step #19 (×10: was 15s)
    inputs: { wood: 2 },
    outputs: { biofuel: 1 },
    category: 'chemistry',
    // §11.7 drone-fuel chain closure: biofuel was previously seeded but
    // had no producer. Biofuel Plant is the canonical T1 producer.
  },

  // T2 extraction — petrochemical raws. Rebalanced for idle-game scale, step #19 (×40).
  pump_jack: {
    cycleSec: 480, // rebalanced for idle-game scale, step #19 (×40: was 12s)
    inputs: {},
    outputs: { crude_oil: 1 },
    category: 'extraction',
    // §8.1 catalog: requires `oil_well` terrain tile. Tile gating
    // DEFERRED — runs on any in-island tile.
  },
  gas_extractor: {
    cycleSec: 480, // rebalanced for idle-game scale, step #19 (×40: was 12s)
    inputs: {},
    outputs: { natural_gas: 1 },
    category: 'extraction',
    // Orphan output: no current consumer (§7.3 ammonia/syngas variants
    // deferred). Producer ships so the resource isn't a permanent
    // sink-without-source if a consumer recipe lands later.
  },

  // T2 petrochemical / refining — rebalanced for idle-game scale, step #19 (×40).
  // Each split into its own building since the engine's 1:1 recipe-per-defId
  // model doesn't support multi-recipe selection without infrastructure expansion.
  naphtha_cracker: {
    cycleSec: 600, // rebalanced for idle-game scale, step #19 (×40: was 15s)
    inputs: { crude_oil: 1 },
    outputs: { naphtha: 1 },
    category: 'chemistry',
  },
  chlor_alkali_plant: {
    cycleSec: 800, // rebalanced for idle-game scale, step #19 (×40: was 20s)
    inputs: { saltwater: 2 },
    outputs: { chlorine: 1 },
    category: 'chemistry',
    // §7.3 chlor-alkali co-output: `sodium_hydroxide`. NaOH consumer
    // recipes (soap, paper, etc.) DEFERRED → omitted from outputs to
    // keep the resource list lean.
  },
  lubricant_refinery: {
    cycleSec: 1000, // rebalanced for idle-game scale, step #19 (×40: was 25s)
    inputs: { crude_oil: 1, chlorine: 1 },
    outputs: { lubricant: 1 },
    category: 'chemistry',
    // §7.X TODO: lubricant feeds T4 maintenance per §4.7. T4
    // maintenance system is DEFERRED — lubricant is a stockpile-only
    // resource until §4.7 lands.
  },
  diesel_refinery: {
    cycleSec: 1200, // rebalanced for idle-game scale, step #19 (×40: was 30s)
    inputs: { crude_oil: 2, naphtha: 1 },
    outputs: { diesel: 1 },
    category: 'chemistry',
    // §11.7 drone tier: diesel = T2 drone fuel. The drone fuel-tier
    // selection isn't wired into drones.ts yet — diesel is a
    // stockpile-only fuel until §11.7 lands.
  },
  metal_rolling_mill: {
    cycleSec: 400, // rebalanced for idle-game scale, step #19 (×40: was 10s)
    inputs: { steel: 1 },
    outputs: { wire: 1 },
    category: 'manufacturing',
    // §7.1 spec lists multiple Steel Mill outputs (wire, sheet_metal,
    // pipe, beam). Step-18 ships wire only — wire is the input to the
    // step-18 Lithography Lab → microchip recipe. sheet_metal, pipe,
    // and beam DEFERRED until they have an explicit consumer.
  },

  // T3 chemistry / electronics — rebalanced for idle-game scale, step #19 (×20).
  silicon_crusher: {
    cycleSec: 600, // rebalanced for idle-game scale, step #19 (×20: was 30s)
    inputs: { quartz: 1 },
    outputs: { silicon: 1 },
    category: 'smelting',
    // §7.4: spec uses `silicon_wafer` as the lithography input, refined
    // from `silicon`. Step-18 simplification: silicon feeds Lithography
    // Lab directly; the wafer intermediate is DEFERRED.
  },
  air_separator: {
    cycleSec: 600, // rebalanced for idle-game scale, step #19 (×20: was 30s)
    inputs: {},
    outputs: { nitrogen: 1 },
    category: 'chemistry',
    // §7.5 byproducts (oxygen, argon) DEFERRED — Air Separator outputs
    // nitrogen only until oxygen/argon consumers land.
  },
  cryo_lab: {
    cycleSec: 1200, // rebalanced for idle-game scale, step #19 (×20: was 60s)
    inputs: { hydrogen: 1, nitrogen: 1 },
    outputs: { cryo_coolant: 1 },
    category: 'chemistry',
  },
  cryo_compressor: {
    cycleSec: 1800, // rebalanced for idle-game scale, step #19 (×20: was 90s)
    inputs: { hydrogen: 1, cryo_coolant: 1 },
    outputs: { cryogenic_hydrogen: 1 },
    category: 'chemistry',
    // T4 fuel chain closure: `cryogenic_hydrogen` was previously in the
    // catalog with no producer. Cryo Compressor closes the producer side
    // even though the T4 consumer (Fusion Core II / launch fuel)
    // remains DEFERRED.
  },
  kerosene_refinery: {
    cycleSec: 1200, // rebalanced for idle-game scale, step #19 (×20: was 60s)
    inputs: { crude_oil: 3, hydrogen: 1 },
    outputs: { aviation_kerosene: 1 },
    category: 'chemistry',
    // §11.7: aviation_kerosene = T3 drone fuel. Drone fuel-tier
    // selection DEFERRED.
  },
  lithography_lab: {
    cycleSec: 2400, // rebalanced for idle-game scale, step #19 (×20: was 120s)
    inputs: { silicon: 1, wire: 1 },
    outputs: { microchip: 1 },
    category: 'electronics',
    // §7.X TODO: microchip should feed circuit_board → processor →
    // computing_module. Those intermediates DEFERRED — microchip is a
    // stockpile-only output for step 18.
  },
  drilling_rig: {
    cycleSec: 2400, // rebalanced for idle-game scale, step #19 (×20: was 120s)
    inputs: {},
    outputs: { helium_3: 1 },
    category: 'extraction',
    // §8.1: Drilling Rig spec calls for `helium_vent` / deep terrain
    // tile. Tile gating DEFERRED — runs anywhere on T3+ islands.
    // Closes the helium_3 producer gap: previously seeded as 50 on
    // forest-ne but with no replenishment.
  },

  // ---------------------------------------------------------------------------
  // T5 raw extractors (§8.10 / step-18 closure) — rebalanced for idle-game scale, step #19 (×8)
  // ---------------------------------------------------------------------------
  // §8.10 spec describes deterministic per-cycle output rotation across
  // multiple raws ("deterministic given world seed + cycle index"). The
  // step-18 simplification: each extractor outputs a single raw per
  // cycle, with §8.10 rotation logic DEFERRED. Cycle times were at the
  // §8.10 lower bound (600-720s); multiplied ×8 for idle-game scale.
  // Power consumption per §8.10 is in the 60-100 kW range (very large).
  aetheric_conduit: {
    cycleSec: 4800, // rebalanced for idle-game scale, step #19 (×8: was 600s)
    inputs: {},
    outputs: { aetheric_current: 1 },
    category: 'extraction',
    // §8.10 rotation (aetheric_current OR quantum_foam) DEFERRED —
    // quantum_foam has no consumer in step 18 anyway.
  },
  spacetime_resonator: {
    cycleSec: 5760, // rebalanced for idle-game scale, step #19 (×8: was 720s)
    inputs: {},
    outputs: { tachyon_stream: 1 },
    category: 'extraction',
    // §8.10 rotation (tachyon_stream OR spacetime_fragment) DEFERRED —
    // spacetime_fragment has no consumer in step 18.
  },
  eldritch_sieve: {
    cycleSec: 5760, // rebalanced for idle-game scale, step #19 (×8: was 720s)
    // Multi-output recipe: dark_matter + strange_matter per cycle.
    // §8.10 rotation across {dark, strange, higgs_flux} DEFERRED;
    // producing both in one cycle keeps the downstream Eldritch
    // Refiner (1 dark + 1 strange → 1 eldritch_processor) tickable
    // without needing the rotation engine.
    inputs: {},
    outputs: { dark_matter: 1, strange_matter: 1 },
    category: 'extraction',
  },

  // T5 refining (§7.12 step-18 closure) — rebalanced for idle-game scale, step #19 (×8).
  plasma_forge: {
    cycleSec: 4800, // rebalanced for idle-game scale, step #19 (×8: was 600s)
    inputs: { exotic_alloy: 1, casimir_energy: 1 },
    outputs: { plasma_charge: 1 },
    category: 'manufacturing',
    // §11.7: plasma_charge = T5 propellant (drone fuel tier 5). Drone
    // fuel-tier selection DEFERRED.
  },
  eldritch_refiner: {
    cycleSec: 9600, // rebalanced for idle-game scale, step #19 (×8: was 1200s)
    inputs: { dark_matter: 1, strange_matter: 1 },
    outputs: { eldritch_processor: 1 },
    category: 'manufacturing',
  },
  phase_refiner: {
    cycleSec: 9600, // rebalanced for idle-game scale, step #19 (×8: was 1200s)
    inputs: { aetheric_current: 1, tachyon_stream: 1 },
    outputs: { phase_converter: 1 },
    category: 'manufacturing',
  },
};

/**
 * Tile-dependent recipe resolution per §8.1.
 *
 * Most buildings have a single recipe keyed by `def.id` — the lookup is just
 * `RECIPES[def.id]`. Mine is the §8.1 exception: it produces ore OR coal
 * depending on the tile under its footprint. To keep `PlacedBuilding` pure
 * data (no per-instance recipe state), the variant is resolved at rate-
 * computation time from the terrain function on the IslandSpec.
 *
 * Pure function — no DOM, no PixiJS, no allocation per call beyond the same
 * Recipe-object reference returned from the static RECIPES table. The hot
 * path (computeRates) calls this once per building per pass, so we avoid
 * building intermediate arrays unless we're actually scanning Mine tiles.
 *
 * The `terrainAt` closure is optional. When undefined (legacy callers,
 * tests that don't model terrain), we fall back to `RECIPES[def.id]` — for
 * Mine this is the pre-tile-aware recipe that produces iron_ore, matching
 * historical behaviour.
 *
 * The footprint enumeration mirrors `footprintTiles` in placement.ts but is
 * inlined here to keep `recipes.ts → placement.ts` from forming a runtime
 * import cycle (placement.ts imports `recipes.ts` for ResourceId/
 * ALL_RESOURCES). If we ever pull `footprintTiles` into a primitive module
 * the inlining can be removed.
 */
export function resolveRecipe(
  def: BuildingDef,
  b: PlacedBuilding,
  terrainAt?: (x: number, y: number) => TerrainKind,
): Recipe | undefined {
  if (def.id === 'mine' && terrainAt) {
    let sawCoal = false;
    let sawOre = false;
    const rotation = (b.rotation ?? 0) as Rotation01ish;
    // Inline footprint enumeration — matches the four-rotation transforms
    // in placement.ts `footprintTiles`. Short-circuits on first `coal` tile
    // to keep the typical-case cost minimal.
    for (let dy = 0; dy < def.height; dy++) {
      for (let dx = 0; dx < def.width; dx++) {
        let rx: number;
        let ry: number;
        switch (rotation) {
          case 0: rx = dx; ry = dy; break;
          case 1: rx = def.height - 1 - dy; ry = dx; break;
          case 2: rx = def.width - 1 - dx; ry = def.height - 1 - dy; break;
          case 3: rx = dy; ry = def.width - 1 - dx; break;
        }
        const k = terrainAt(b.x + rx, b.y + ry);
        if (k === 'coal') {
          sawCoal = true;
        } else if (k === 'ore') {
          sawOre = true;
        }
        // We can short-circuit only when we've seen coal: coal wins the
        // tie per the §8.1 "Ore or coal output by tile" rule encoded as
        // "any coal tile → coal recipe". Without seeing coal, an early ore
        // tile may still be followed by coal later in the scan.
        if (sawCoal) {
          return RECIPES.mine_on_coal;
        }
      }
    }
    if (sawOre) return RECIPES.mine_on_ore;
    // No ore and no coal in footprint — shouldn't happen because
    // `validatePlacement` enforces `def.requiredTile` on every footprint
    // tile. Return undefined defensively so the rate loop sees a no-op
    // building rather than picking up a stale (legacy) iron_ore recipe.
    return undefined;
  }
  return RECIPES[def.id as RecipeId];
}

/** Local copy of the rotation union from placement.ts. Kept here to avoid
 *  importing placement.ts (which already imports recipes.ts); the value is
 *  PlacedBuilding.rotation, which placement.ts also constrains to 0|1|2|3. */
type Rotation01ish = 0 | 1 | 2 | 3;
