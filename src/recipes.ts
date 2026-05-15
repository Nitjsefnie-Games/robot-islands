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
// Step-20 (T6 Orbital, §14) adds the T5→T6 transition artifact + the
// resources the spaceport / satellite-assembly defs touch in placeholder form:
//
//   T5→T6 artifact: ascendant_core      (§13.4 / §14.1 — flips the §14.1 gate)
//   T6 fuel:        antimatter_propellant (§11.7 / §14.10)
//   T6 payload:     scanner_sat, comm_sat, orbital_insertion_package (§14.3 / §14.10)
//
// `xp_weight` per SPEC §9.1: T0 raws = 1, T1 = 3, T2 = 10, T4 = 100, T5 = 300, T6 = 1000.
// Higher-tier outputs grant proportionally more XP per unit produced, so the
// progression curve rewards climbing the recipe chain rather than just
// stockpiling raws.

import type { BuildingDef, BuildingDefId } from './building-defs.js';
import type { PlacedBuilding } from './buildings.js';
import type { TerrainKind } from './island.js';
import { footprintTiles, type Rotation } from './shape-mask.js';

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
  // least one producer in the catalog. §8.1 tile-gating is live for all
  // extractors via `requiredTile` in building-defs.ts and enforced at
  // placement time (validatePlacement) and runtime (computeRates).
  | 'stone'
  | 'sand'
  | 'fresh_water'
  | 'saltwater'
  | 'salt'
  | 'crude_oil'
  | 'natural_gas'
  | 'quartz'
  | 'hydrogen'
  // §6.1 T0 mineral raw: limestone (Task 1.2)
  | 'limestone'
  | 'clay'
  | 'sulfur'
  | 'phosphate'
  | 'graphite'
  | 'copper_ore'
  | 'tin_ore'
  | 'lead_ore'
  | 'bauxite'
  // Phase 3 — T2-T3 steel alloy chains (§6.1 / §6.4 / §7.1)
  | 'manganese_ore'
  | 'manganese_ingot'
  | 'carbon_steel'
  | 'zinc_ore'
  | 'zinc_ingot'
  | 'galvanized_steel'
  | 'chromium_ore'
  | 'chromium_ingot'
  | 'nickel_ore'
  | 'nickel_ingot'
  | 'stainless_steel'
  | 'tungsten_ore'
  | 'tungsten_ingot'
  | 'tool_steel'
  // Phase 2 — T1 refined chains (§6.2 / §7.5)
  | 'quicklime'
  | 'slaked_lime'
  | 'brick'
  | 'mortar'
  | 'cement'
  | 'concrete'
  | 'charcoal'
  | 'plank'
  | 'copper_ingot'
  | 'tin_ingot'
  | 'lead_ingot'
  | 'solder'
  // Phase 7 — Bronze + Brass (§7.2)
  | 'bronze'
  | 'brass'
  // Phase 8 — Aluminum chain (§7.3)
  | 'alumina'
  | 'aluminum'
  // Byproducts (§6.7)
  | 'oxygen'
  | 'argon'
  | 'slag'
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
  // Phase 4 — T2 petrochemical byproducts (§7.4)
  | 'heavy_oil'
  | 'tar'
  | 'asphalt'
  | 'plastic_precursor'
  | 'rigid_plastic'
  | 'flexible_plastic'
  | 'synthetic_rubber'
  // Phase 6 — T2 mechanical components (§6.3 / §7.1)
  | 'sheet_metal'
  | 'pipe'
  | 'steel_beam'
  // Phase 6 — T2 mechanical fasteners (§6.3)
  | 'bearing'
  | 'spring'
  // Phase 6 — T2 mechanical components (§6.3)
  | 'heavy_cable'
  // Phase 6 — T3 battery (§6.3 / §7.9)
  | 'battery'
  // Phase 6 — T2 glass_panel (§6.3)
  | 'glass_panel'
  // Phase 6 — T2 coolant + ceramic_insulator (§6.3)
  | 'coolant'
  | 'ceramic_insulator'
  // Phase 5 — T2 chemistry chain (§7.5)
  | 'sulfuric_acid'
  | 'hydrochloric_acid'
  | 'sodium_hydroxide'
  // Phase 5 — T3 chemistry chain (§7.5)
  | 'phosphor'
  | 'liquid_nitrogen'
  // Step-18 T3 chemistry/electronics (§7.4 / §7.5).
  | 'silicon'
  | 'silicon_wafer'
  | 'transistor'
  | 'capacitor'
  | 'resistor'
  | 'memory_module'
  | 'nitrogen'
  | 'cryo_coolant'
  | 'aviation_kerosene'
  | 'microchip'
  // §6.4 T3 mineral raws (for slag reprocessing + nuclear fuel)
  | 'gold_ore'
  | 'silver_ore'
  | 'rare_earth'
  | 'uranium_ore'
  // §6.6 T5 component (memetic core)
  | 'memetic_core'
  // T4 endgame (§6.5)
  | 'helium_3'
  | 'cryogenic_hydrogen'
  | 'quantum_chip'
  | 'exotic_alloy'
  | 'ai_core'
  // §9.5 Carbon Forge output — T4 component (Forest-unique)
  | 'carbon_fiber'
  // T5 transcendent (§6.6) — partial step-13 catalog (raws/components needed
  // for the Reality Forge demo chain + T5 fuel). Full §6.6 raws deferred.
  | 'casimir_energy'
  | 'reality_anchor'
  | 'plasma_charge'
  | 'eldritch_processor'
  | 'phase_converter'
  // Step-18 T5 raws (§6.6 / §8.10). The seven raws consumed by step-18
  // T5 refining recipes and the new rotateOutputs extractor cycle.
  | 'aetheric_current'
  | 'tachyon_stream'
  | 'dark_matter'
  | 'strange_matter'
  | 'quantum_foam'
  | 'spacetime_fragment'
  | 'higgs_flux'
  // Step-20 (T6 Orbital, §14). Partial catalog: the resources the §14.2
  // Spaceport + §14.10 satellite-assembly defs touch. §14.10 placeholder
  // recipes additionally reference Aluminum, Magnet, Optical Fiber,
  // Spacetime fragment, Memetic Core, Repair Pack, Phase Converter — those
  // beyond Phase Converter (already in the T5 catalog) are DEFERRED until
  // the live launch mechanics (§14.2-14.8 / §14.12) land.
  //
  //   ascendant_core           — T5/T6 transition artifact per §13.4 /
  //                              §14.1. Crafted at `ascendant_assembly`
  //                              (T5 building); producing one flips the
  //                              §14.1 ascendantCoreCrafted gate. Auto-flip
  //                              on first production deferred — current
  //                              step seeds the flag manually on forest-ne.
  //   antimatter_propellant    — T6 launch fuel per §11.7 / §14.10. Crafted
  //                              at `antimatter_refinery` (T6).
  //   scanner_sat              — §14.3 discovery/weather satellite payload.
  //   comm_sat                 — §14.3 comm-graph extension payload.
  //   orbital_insertion_package — §14.7 "T6 Foundation-Kit equivalent" —
  //                              every launch requires one alongside fuel +
  //                              variant recipe. Crafted at
  //                              `orbital_insertion_assembly` (T6).
  | 'ascendant_core'
  | 'antimatter_propellant'
  | 'scanner_sat'
  | 'comm_sat'
  | 'orbital_insertion_package'
  | 'sweeper_sat'
  | 'repair_drone'
  | 'repair_pack'
  | 'pcb'
  | 'circuit_board'
  | 'processor'
  | 'computing_module'
  // §13.4 endgame artifact — victory condition resource. No producer yet.
  | 'genesis_cell'
  // Phase 10 — T3 minerals + alloy (Task 10.1)
  | 'mercury'
  // Phase 10 — T3 minerals + alloy (Task 10.2)
  | 'diamond_ore'
  // Phase 10 — T3 minerals + alloy (Task 10.3)
  | 'cryogenic_compound'
  // Phase 10 — T3 minerals + alloy (Task 10.4)
  | 'magnetic_alloy'
  // Phase 10b — T3 minerals + alloy (Task 10.4.5)
  | 'lithium'
;

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
  // §6.1 T0 mineral raw: limestone (Task 1.2)
  'limestone',
  'clay',
  'sulfur',
  'phosphate',
  'graphite',
  'copper_ore',
  'tin_ore',
  'lead_ore',
  'bauxite',
  // Phase 3 — T2-T3 steel alloy chains (§6.1 / §6.4 / §7.1)
  'manganese_ore',
  'manganese_ingot',
  'carbon_steel',
  'zinc_ore',
  'zinc_ingot',
  'galvanized_steel',
  'chromium_ore',
  'chromium_ingot',
  'nickel_ore',
  'nickel_ingot',
  'stainless_steel',
  'tungsten_ore',
  'tungsten_ingot',
  'tool_steel',
  // Phase 2 — T1 refined chains (§6.2 / §7.5)
  'quicklime',
  'slaked_lime',
  'brick',
  'mortar',
  'cement',
  'concrete',
  'charcoal',
  'plank',
  'copper_ingot',
  'tin_ingot',
  'lead_ingot',
  'solder',
  // Phase 7 — Bronze + Brass (§7.2)
  'bronze',
  'brass',
  // Phase 8 — Aluminum chain (§7.3)
  'alumina',
  'aluminum',
  // Byproducts (§6.7)
  'oxygen',
  'argon',
  'slag',
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
  // Phase 4 — T2 petrochemical byproducts (§7.4)
  'heavy_oil',
  'tar',
  'asphalt',
  'plastic_precursor',
  'rigid_plastic',
  'flexible_plastic',
  'synthetic_rubber',
  // Phase 6 — T2 mechanical components (§6.3 / §7.1)
  'sheet_metal',
  'pipe',
  'steel_beam',
  // Phase 6 — T2 mechanical fasteners (§6.3)
  'bearing',
  'spring',
  // Phase 6 — T2 mechanical components (§6.3)
  'heavy_cable',
  // Phase 6 — T3 battery (§6.3 / §7.9)
  'battery',
  // Phase 6 — T2 glass_panel (§6.3)
  'glass_panel',
  // Phase 6 — T2 coolant + ceramic_insulator (§6.3)
  'coolant',
  'ceramic_insulator',
  // Phase 5 — T2 chemistry chain (§7.5)
  'sulfuric_acid',
  'hydrochloric_acid',
  'sodium_hydroxide',
  // Phase 5 — T3 chemistry chain (§7.5)
  'phosphor',
  'liquid_nitrogen',
  // Step-18 T3 chemistry / electronics.
  'silicon',
  'silicon_wafer',
  'transistor',
  'capacitor',
  'resistor',
  'memory_module',
  'nitrogen',
  'cryo_coolant',
  'aviation_kerosene',
  'microchip',
  // §6.4 T3 mineral raws (for slag reprocessing + nuclear fuel)
  'gold_ore',
  'silver_ore',
  'rare_earth',
  'uranium_ore',
  // §6.6 T5 component (memetic core)
  'memetic_core',
  'helium_3',
  'cryogenic_hydrogen',
  'quantum_chip',
  'exotic_alloy',
  'ai_core',
  // §9.5 Carbon Forge output
  'carbon_fiber',
  // T5 transcendent (§6.6) — step-13 partial catalog
  'casimir_energy',
  'reality_anchor',
  'plasma_charge',
  'eldritch_processor',
  'phase_converter',
  // Step-18 T5 raws (consumed by step-18 recipes + rotateOutputs cycle).
  'aetheric_current',
  'tachyon_stream',
  'dark_matter',
  'strange_matter',
  'quantum_foam',
  'spacetime_fragment',
  'higgs_flux',
  // Step-20 T5→T6 artifact + T6 Orbital partial catalog (§14).
  'ascendant_core',
  'antimatter_propellant',
  'scanner_sat',
  'comm_sat',
  'orbital_insertion_package',
  'sweeper_sat',
  'repair_drone',
  'repair_pack',
  'pcb',
  'circuit_board',
  'processor',
  'computing_module',
  // §13.4 endgame artifact
  'genesis_cell',
  // Phase 10 — T3 minerals + alloy (Task 10.1)
  'mercury',
  // Phase 10 — T3 minerals + alloy (Task 10.2)
  'diamond_ore',
  // Phase 10 — T3 minerals + alloy (Task 10.3)
  'cryogenic_compound',
  // Phase 10 — T3 minerals + alloy (Task 10.4)
  'magnetic_alloy',
  // Phase 10b — T3 minerals + alloy (Task 10.4.5)
  'lithium',

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
 *   T6 orbital     = 1000 (ascendant_core (T5→T6 bridge), antimatter_propellant,
 *                          scanner_sat, comm_sat, orbital_insertion_package)
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
  // §6.1 T0 mineral raw: limestone (Task 1.2)
  limestone: 1,
  clay: 1,
  sulfur: 1,
  phosphate: 1,
  graphite: 1,
  copper_ore: 1,
  tin_ore: 1,
  lead_ore: 1,
  bauxite: 1,
  // Phase 3 — T2-T3 steel alloy chains (§6.1 / §6.4 / §7.1)
  manganese_ore: 1,
  manganese_ingot: 3,
  carbon_steel: 10,
  zinc_ore: 1,
  zinc_ingot: 3,
  galvanized_steel: 10,
  chromium_ore: 1,
  chromium_ingot: 30,
  nickel_ore: 1,
  nickel_ingot: 30,
  stainless_steel: 30,
  tungsten_ore: 1,
  tungsten_ingot: 30,
  tool_steel: 30,
  // Phase 2 — T1 refined chains (§6.2 / §7.5)
  quicklime: 3,
  slaked_lime: 3,
  brick: 3,
  mortar: 3,
  cement: 3,
  concrete: 3,
  charcoal: 3,
  plank: 3,
  copper_ingot: 3,
  tin_ingot: 3,
  lead_ingot: 3,
  solder: 10,
  // Phase 7 — Bronze + Brass (§7.2)
  bronze: 10,
  brass: 10,
  // Phase 8 — Aluminum chain (§7.3)
  alumina: 10,
  aluminum: 10,
  // Byproducts (§6.7) — T1 refined weight per spec §9.1.
  oxygen: 3,
  argon: 3,
  slag: 3,
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
  // Phase 4 — T2 petrochemical byproducts (§7.4)
  heavy_oil: 10,
  tar: 10,
  asphalt: 10,
  plastic_precursor: 10,
  rigid_plastic: 10,
  flexible_plastic: 10,
  synthetic_rubber: 10,
  // Phase 6 — T2 mechanical components (§6.3 / §7.1)
  sheet_metal: 10,
  pipe: 10,
  steel_beam: 10,
  // Phase 6 — T2 mechanical fasteners (§6.3)
  bearing: 10,
  spring: 10,
  // Phase 6 — T2 mechanical components (§6.3)
  heavy_cable: 10,
  // Phase 6 — T3 battery (§6.3 / §7.9)
  battery: 30,
  // Phase 6 — T2 glass_panel (§6.3)
  glass_panel: 10,
  // Phase 6 — T2 coolant + ceramic_insulator (§6.3)
  coolant: 10,
  ceramic_insulator: 10,
  // Phase 5 — T2 chemistry chain (§7.5)
  sulfuric_acid: 10,
  hydrochloric_acid: 10,
  sodium_hydroxide: 10,
  // Phase 5 — T3 chemistry chain (§7.5)
  phosphor: 30,
  liquid_nitrogen: 30,
  // Step-18 T3 chemistry / electronics (§9.1 tier-3 weight = 30).
  silicon: 30,
  silicon_wafer: 30,
  transistor: 30,
  capacitor: 30,
  resistor: 30,
  memory_module: 30,
  nitrogen: 30,
  cryo_coolant: 30,
  aviation_kerosene: 30,
  microchip: 30,
  // §6.4 T3 mineral raws (for slag reprocessing + nuclear fuel)
  gold_ore: 30,
  silver_ore: 30,
  rare_earth: 30,
  uranium_ore: 30,
  // §6.6 T5 component (memetic core)
  memetic_core: 300,
  // T4 endgame (§6.5)
  helium_3: 100,
  cryogenic_hydrogen: 100,
  quantum_chip: 100,
  exotic_alloy: 100,
  ai_core: 100,
  // §9.5 T4 component (Carbon Forge — Forest-unique)
  carbon_fiber: 100,
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
  quantum_foam: 300,
  spacetime_fragment: 300,
  higgs_flux: 300,
  // T5→T6 transition artifact. §9.1 puts T5 weight at 300 and T6 at 1000;
  // Ascendant Core is the bridge artifact unlocking T6 access (§13.4 /
  // §14.1), so it carries the higher T6 weight (1000) — producing one
  // is the moment the player crosses into the T6 tier band.
  ascendant_core: 1000,
  // T6 Orbital — §9.1 T6 weight 1000.
  antimatter_propellant: 1000,
  scanner_sat: 1000,
  comm_sat: 1000,
  orbital_insertion_package: 1000,
  sweeper_sat: 1000,
  repair_drone: 1000,
  // repair_pack is a T5-equivalent consumable per task brief.
  repair_pack: 300,
  pcb: 10,
  circuit_board: 30,
  processor: 30,
  computing_module: 30,
  // §13.4 T5 endgame artifact
  genesis_cell: 300,
  // Phase 10 — T3 minerals + alloy (Task 10.1)
  mercury: 30,
  // Phase 10 — T3 minerals + alloy (Task 10.2)
  diamond_ore: 30,
  // Phase 10 — T3 minerals + alloy (Task 10.3)
  cryogenic_compound: 30,
  // Phase 10 — T3 minerals + alloy (Task 10.4)
  magnetic_alloy: 30,
  // Phase 10b — T3 minerals + alloy (Task 10.4.5)
  lithium: 30,
};

/**
 * §11.7 fuel mapping: a craft launched from a tier-T island burns the
 * tier-T fuel grade. Pure look-up; no fallback to lower grades (the
 * spec is explicit — "cannot fall back to a lower grade").
 *
 *   T1 → biofuel               (§6.2)
 *   T2 → diesel                (§6.3)
 *   T3 → aviation_kerosene     (§6.4)
 *   T4 → cryogenic_hydrogen    (§6.5)
 *   T5 → plasma_charge         (§6.6)
 *   T6 → antimatter_propellant (§14.10)
 *
 * Callers compute the tier from the launching island's level via
 * `tierForLevel(state.level)` in `skilltree.ts`, then pass the result
 * here. Lives in `recipes.ts` because the catalog of ResourceIds is
 * authoritative here and both `drones.ts` and `settlement.ts` already
 * import from this module.
 */
export function fuelForTier(t: 1 | 2 | 3 | 4 | 5 | 6): ResourceId {
  switch (t) {
    case 1:
      return 'biofuel';
    case 2:
      return 'diesel';
    case 3:
      return 'aviation_kerosene';
    case 4:
      return 'cryogenic_hydrogen';
    case 5:
      return 'plasma_charge';
    case 6:
      return 'antimatter_propellant';
  }
}

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
  /** If set, outputs cycle through these options deterministically per §8.10. */
  readonly rotateOutputs?: ReadonlyArray<Partial<Record<ResourceId, number>>>;
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
 *     logger   -> 1 wood      / 4s   (no inputs; tile-req `tree` live)
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
  // §8.1 T2 Heavy Logger: 3× wood throughput vs T1 Logger.
  heavy_logger: {
    cycleSec: 30,
    inputs: {},
    outputs: { wood: 3 },
    category: 'extraction',
  },
  // §8.1 T2 Deep Mine: 3× ore throughput vs T1 Mine. Output is iron_ore
  // (the only ore vein the live game currently surfaces; deeper-vein
  // variants like copper / nickel land alongside their resource catalog
  // additions).
  deep_mine: {
    cycleSec: 60,
    inputs: {},
    outputs: { iron_ore: 3 },
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
  // §8.5 T2 power: Cryogenic Generator burns cryo_coolant as fuel.
  cryogenic_generator: {
    cycleSec: 60,
    inputs: { cryo_coolant: 1 },
    outputs: {},
    category: 'power',
  },
  // §8.5 T3 power: Nuclear Reactor fuel TBD per SPEC §6.5 — placeholder
  // uses `coal: 5` as a heavy proxy until `uranium_ore` (§6.4) or
  // `nuclear_fuel_rod` (§6.5) ship as ResourceIds in the catalog. Swap to
  // the real T3/T4 fuel once that lands; for now coal makes the building
  // TICKABLE without inventing a phantom ResourceId.
  nuclear_reactor: {
    cycleSec: 120,
    inputs: { coal: 5 },
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
    outputs: { steel: 1, slag: 1 },
    category: 'smelting',
  },
  // T3 smelting — Oxygen Converter (§6.7). Higher-throughput steel
  // from pig iron + scrap + oxygen. Scrap substitution: 2 Scrap = 1 Pig
  // iron's worth of steel input (per §6.7 Steel-recipe substitution).
  // §5.2 heat-source adjacency required.
  oxygen_converter: {
    cycleSec: 20,
    inputs: { pig_iron: 1, scrap: 1, oxygen: 2 },
    outputs: { steel: 2 },
    category: 'smelting',
  },
  // §6.7 Slag reprocessing — T2 smelting-byproduct refiner.
  slag_reprocessor: {
    cycleSec: 1200,        // slow — reflects "low yield" §6.7
    inputs: { slag: 10 },  // batch input keeps the yield low
    outputs: { gold_ore: 1, silver_ore: 1, rare_earth: 1 },
    category: 'smelting',
    // §6.7 "trace minerals at low yield": 10 slag in, one of each trace
    // mineral out. Tune yields in Appendix A balance pass; this matches
    // the spec's "low yield" qualifier (1/30 = 3.3% per slag unit).
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
    inputs: { steel: 3, quantum_chip: 1, argon: 1 },
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

  // §9.5 Carbon Forge: produces Carbon Fiber. Optical/Glass fiber variants
  // are separate-recipe deferrals (the 1:1 recipe-per-defId design ships a
  // single output; carbon_fiber is the primary Forest bottleneck per §9.5).
  // Optical fiber + glass fiber recipes can land later as separate def-ids
  // if needed, or via a recipe-rotation extension.
  carbon_forge: {
    cycleSec: 600,
    inputs: { wood: 5, coke: 2 },
    outputs: { carbon_fiber: 1 },
    category: 'smelting',
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
  // balanced" — a later pass will rebalance. §8.1 tile-gating is live
  // for all extractors (placement + runtime).

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
  limestone_quarry: {
    cycleSec: 60, // slightly slower than iron Mine (50s) — limestone is bulk industrial
    inputs: {},
    outputs: { limestone: 1 },
    category: 'extraction',
  },
  clay_pit_extractor: {
    cycleSec: 60,
    inputs: {},
    outputs: { clay: 1 },
    category: 'extraction',
  },
  sulfur_mine: {
    cycleSec: 60,
    inputs: {},
    outputs: { sulfur: 1 },
    category: 'extraction',
  },
  phosphate_mine: {
    cycleSec: 60,
    inputs: {},
    outputs: { phosphate: 1 },
    category: 'extraction',
  },
  graphite_mine: {
    cycleSec: 60,
    inputs: {},
    outputs: { graphite: 1 },
    category: 'extraction',
  },
  copper_mine: {
    cycleSec: 60,
    inputs: {},
    outputs: { copper_ore: 1 },
    category: 'extraction',
  },
  tin_mine: {
    cycleSec: 60,
    inputs: {},
    outputs: { tin_ore: 1 },
    category: 'extraction',
  },
  lead_mine: {
    cycleSec: 60,
    inputs: {},
    outputs: { lead_ore: 1 },
    category: 'extraction',
  },
  bauxite_mine: {
    cycleSec: 60,
    inputs: {},
    outputs: { bauxite: 1 },
    category: 'extraction',
  },

  // Phase 2 — T1 refined chains (§6.2 / §7.5)
  limekiln: {
    cycleSec: 120,
    inputs: { limestone: 1 },
    outputs: { quicklime: 1 },
    category: 'chemistry',
  },
  lime_slaker: {
    cycleSec: 120,
    inputs: { quicklime: 1, fresh_water: 1 },
    outputs: { slaked_lime: 1 },
    category: 'chemistry',
  },
  brick_kiln: {
    cycleSec: 120,
    inputs: { clay: 2 },
    outputs: { brick: 1 },
    category: 'chemistry',
  },
  mortar_mixer: {
    cycleSec: 120,
    inputs: { sand: 1, quicklime: 1 },
    outputs: { mortar: 1 },
    category: 'chemistry',
  },
  cement_mill: {
    cycleSec: 200,
    inputs: { quicklime: 1, sand: 1, clay: 1 },
    outputs: { cement: 1 },
    category: 'chemistry',
  },
  concrete_plant: {
    cycleSec: 200,
    inputs: { cement: 1, sand: 2, fresh_water: 1 },
    outputs: { concrete: 1 },
    category: 'chemistry',
  },
  charcoal_kiln: {
    cycleSec: 100,
    inputs: { wood: 2 },
    outputs: { charcoal: 1 },
    category: 'chemistry',
  },
  plank_mill: {
    cycleSec: 80,
    inputs: { lumber: 1 },
    outputs: { plank: 2 },
    category: 'manufacturing',
  },
  copper_smelter: {
    cycleSec: 80,
    inputs: { copper_ore: 1, coal: 1 },
    outputs: { copper_ingot: 1 },
    category: 'smelting',
  },
  tin_smelter: {
    cycleSec: 80,
    inputs: { tin_ore: 1, coal: 1 },
    outputs: { tin_ingot: 1 },
    category: 'smelting',
  },
  lead_smelter: {
    cycleSec: 80,
    inputs: { lead_ore: 1, coal: 1 },
    outputs: { lead_ingot: 1 },
    category: 'smelting',
  },
  solder_alloyer: {
    cycleSec: 200,
    inputs: { tin_ingot: 1, lead_ingot: 1 },
    outputs: { solder: 2 },
    category: 'manufacturing',
  },
  // Phase 7 — Bronze + Brass (§7.2)
  bronze_alloyer: {
    cycleSec: 250,
    inputs: { copper_ingot: 1, tin_ingot: 1 },
    outputs: { bronze: 2 },
    category: 'manufacturing',
  },
  brass_alloyer: {
    cycleSec: 250,
    inputs: { copper_ingot: 1, zinc_ingot: 1 },
    outputs: { brass: 2 },
    category: 'manufacturing',
  },
  // Phase 8 — Aluminum chain (§7.3)
  alumina_refinery: {
    cycleSec: 300,
    inputs: { bauxite: 1, sodium_hydroxide: 1 },
    outputs: { alumina: 1 },
    category: 'chemistry',
  },
  aluminum_smelter: {
    cycleSec: 300,
    inputs: { alumina: 1 },
    outputs: { aluminum: 1 },
    category: 'smelting',
  },

  // Phase 3 — T2-T3 steel alloy chains (§6.1 / §6.4 / §7.1)
  manganese_mine: {
    cycleSec: 60,
    inputs: {},
    outputs: { manganese_ore: 1 },
    category: 'extraction',
  },
  manganese_smelter: {
    cycleSec: 80,
    inputs: { manganese_ore: 1, coal: 1 },
    outputs: { manganese_ingot: 1 },
    category: 'smelting',
  },
  carbon_steel_mill: {
    cycleSec: 250,
    inputs: { steel: 1, manganese_ingot: 1 },
    outputs: { carbon_steel: 1 },
    category: 'manufacturing',
  },
  zinc_mine: {
    cycleSec: 60,
    inputs: {},
    outputs: { zinc_ore: 1 },
    category: 'extraction',
  },
  zinc_smelter: {
    cycleSec: 80,
    inputs: { zinc_ore: 1, coal: 1 },
    outputs: { zinc_ingot: 1 },
    category: 'smelting',
  },
  galvanizing_bath: {
    cycleSec: 250,
    inputs: { steel: 1, zinc_ingot: 1 },
    outputs: { galvanized_steel: 1 },
    category: 'manufacturing',
  },
  chromium_mine: {
    cycleSec: 60,
    inputs: {},
    outputs: { chromium_ore: 1 },
    category: 'extraction',
  },
  chromium_smelter: {
    cycleSec: 80,
    inputs: { chromium_ore: 1, coal: 1 },
    outputs: { chromium_ingot: 1 },
    category: 'smelting',
  },
  nickel_mine: {
    cycleSec: 60,
    inputs: {},
    outputs: { nickel_ore: 1 },
    category: 'extraction',
  },
  nickel_smelter: {
    cycleSec: 80,
    inputs: { nickel_ore: 1, coal: 1 },
    outputs: { nickel_ingot: 1 },
    category: 'smelting',
  },
  stainless_steel_mill: {
    cycleSec: 400,
    inputs: { steel: 1, chromium_ingot: 1, nickel_ingot: 1 },
    outputs: { stainless_steel: 1 },
    category: 'manufacturing',
  },
  tungsten_mine: {
    cycleSec: 60,
    inputs: {},
    outputs: { tungsten_ore: 1 },
    category: 'extraction',
  },
  tungsten_smelter: {
    cycleSec: 80,
    inputs: { tungsten_ore: 1, coal: 1 },
    outputs: { tungsten_ingot: 1 },
    category: 'smelting',
  },
  tool_steel_mill: {
    cycleSec: 400,
    inputs: { steel: 1, tungsten_ingot: 1 },
    outputs: { tool_steel: 1 },
    category: 'manufacturing',
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
    outputs: { hydrogen: 1, oxygen: 1 },
    category: 'chemistry',
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
    // §8.1 catalog: requires `oil_well` terrain tile. Tile gating is
    // implemented via `requiredTile` in building-defs.ts.
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
  // Phase 4 — T2 deep-fraction crude oil cracker (§7.4)
  crude_oil_cracker: {
    cycleSec: 600,
    inputs: { crude_oil: 3 },
    outputs: { heavy_oil: 1, tar: 1, asphalt: 1 },
    category: 'chemistry',
  },
  // Phase 4 — T2 plastic precursor polymerizer (§7.4)
  plastic_polymerizer_a: {
    cycleSec: 400,
    inputs: { naphtha: 1 },
    outputs: { plastic_precursor: 1 },
    category: 'chemistry',
  },
  // Phase 4 — T2 split plastic presses (§7.4)
  rigid_plastic_press: {
    cycleSec: 300,
    inputs: { plastic_precursor: 1 },
    outputs: { rigid_plastic: 1 },
    category: 'manufacturing',
  },
  flexible_plastic_press: {
    cycleSec: 300,
    inputs: { plastic_precursor: 1 },
    outputs: { flexible_plastic: 1 },
    category: 'manufacturing',
  },
  rubber_synthesizer: {
    cycleSec: 300,
    inputs: { plastic_precursor: 1 },
    outputs: { synthetic_rubber: 1 },
    category: 'manufacturing',
  },
  // Phase 5 — T2 chemistry chain (§7.5)
  sulfuric_acid_plant: {
    cycleSec: 400,
    inputs: { sulfur: 1, fresh_water: 2 },
    outputs: { sulfuric_acid: 1 },
    category: 'chemistry',
  },
  hcl_plant: {
    cycleSec: 400,
    inputs: { salt: 1, sulfuric_acid: 1 },
    outputs: { hydrochloric_acid: 1 },
    category: 'chemistry',
  },
  // Phase 5 — T3 chemistry chain (§7.5)
  phosphor_plant: {
    cycleSec: 600,
    inputs: { phosphate: 1, sulfuric_acid: 1 },
    outputs: { phosphor: 1 },
    category: 'chemistry',
  },
  cryo_air_separator: {
    cycleSec: 400,
    inputs: { nitrogen: 1 },
    outputs: { liquid_nitrogen: 1 },
    category: 'chemistry',
  },
  chlor_alkali_plant: {
    cycleSec: 800, // rebalanced for idle-game scale, step #19 (×40: was 20s)
    inputs: { saltwater: 2 },
    outputs: { chlorine: 1, sodium_hydroxide: 1 },
    category: 'chemistry',
    // Real co-output per §7.5; consumer in §7.3 alumina chain.
  },
  chemical_reactor: {
    cycleSec: 800,           // matches chlor_alkali_plant — electrolysis pace
    inputs: { salt: 1, fresh_water: 2 },
    outputs: { chlorine: 1 },
    category: 'chemistry',
    // §7.5 spec: Salt + power → Chlorine (+ Sodium hydroxide co-product
    // deferred). Acid / plastic precursor / alumina outputs from §8.2
    // are deferred — those resource ids aren't in the catalog yet.
  },
  lubricant_refinery: {
    cycleSec: 1000, // rebalanced for idle-game scale, step #19 (×40: was 25s)
    inputs: { crude_oil: 1, chlorine: 1 },
    outputs: { lubricant: 1 },
    category: 'chemistry',
    // Lubricant feeds the §4.7 per-tier maintenance recipes (see
    // `src/maintenance.ts:65-78` — every tier from T1 to T6 lists
    // lubricant in its bill of materials).
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
    outputs: { nitrogen: 1, oxygen: 1, argon: 1 },
    category: 'chemistry',
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
    // Microchip feeds the §7.7 electronics chain: pcb_etcher (PCBs) →
    // circuit_assembler → processor_fab → compute_module_fab. Those
    // recipes ship below in this same file (search for `pcb_etcher`).
  },
  // Phase 9 — Task 9.1: high-purity silicon → wafer (§7.7)
  wafer_lab: {
    cycleSec: 400,
    inputs: { silicon: 1 },
    outputs: { silicon_wafer: 1 },
    category: 'electronics',
  },
  // Phase 9 — Task 9.2: wafer + graphite → transistor / capacitor / resistor (§7.7)
  transistor_doping: {
    cycleSec: 200,
    inputs: { silicon_wafer: 1, graphite: 1 },
    outputs: { transistor: 4 },
    category: 'electronics',
  },
  capacitor_doping: {
    cycleSec: 200,
    inputs: { silicon_wafer: 1, graphite: 1 },
    outputs: { capacitor: 4 },
    category: 'electronics',
  },
  resistor_doping: {
    cycleSec: 200,
    inputs: { silicon_wafer: 1, graphite: 1 },
    outputs: { resistor: 4 },
    category: 'electronics',
  },
  // Phase 9 — Task 9.3: Memory Lab (§7.7). PCB + transistors + capacitors + resistors + solder → memory_module.
  memory_lab: {
    cycleSec: 500,
    inputs: { pcb: 1, transistor: 4, capacitor: 4, resistor: 4, solder: 1 },
    outputs: { memory_module: 1 },
    category: 'electronics',
  },
  drilling_rig: {
    cycleSec: 2400, // rebalanced for idle-game scale, step #19 (×20: was 120s)
    inputs: {},
    outputs: { helium_3: 1 },
    category: 'extraction',
    // §8.1: Drilling Rig requires `helium_vent` tile. Tile gating is
    // implemented — `validatePlacement` enforces this via `requiredTile`.
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
    rotateOutputs: [{ aetheric_current: 1 }, { quantum_foam: 1 }],
    category: 'extraction',
  },
  spacetime_resonator: {
    cycleSec: 5760, // rebalanced for idle-game scale, step #19 (×8: was 720s)
    inputs: {},
    outputs: { spacetime_fragment: 1 },
    rotateOutputs: [{ spacetime_fragment: 1 }, { tachyon_stream: 1 }],
    category: 'extraction',
  },
  eldritch_sieve: {
    cycleSec: 5760, // rebalanced for idle-game scale, step #19 (×8: was 720s)
    inputs: {},
    outputs: { dark_matter: 1 },
    rotateOutputs: [{ dark_matter: 1 }, { strange_matter: 1 }, { higgs_flux: 1 }],
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

  // ---------------------------------------------------------------------------
  // T5→T6 transition + T6 Orbital (§13.4 / §14.10 / step 20)
  // ---------------------------------------------------------------------------
  // Data-only ship. §14.2-14.8 / §14.12 launch + debris + lodge + repair
  // mechanics are DEFERRED — these recipes give the catalog rows visible
  // outputs in the inspector but the resulting payloads/fuel are inert
  // until the live launch system lands. §14.10 spec recipe inputs that
  // aren't yet in the catalog (Spacetime fragment, Aluminum, Magnet,
  // Optical Fiber, Memetic Core, Brick, Carbon Fiber) are simplified to
  // catalog-resident inputs of the same tier-weight — DEFERRED for proper
  // §14.10 fidelity until the missing intermediates ship.

  // §13.4 / §14.1: Ascendant Assembly produces the Ascendant Core (T5→T6
  // bridge artifact). Cycle is 2 hours of real time — the artifact's
  // weight-and-cost framing makes it a meaningful gate. Auto-flip of
  // `ascendantCoreCrafted` on first production DEFERRED.
  ascendant_assembly: {
    cycleSec: 7200,
    inputs: { reality_anchor: 3, eldritch_processor: 1, ai_core: 5, computing_module: 2 },
    outputs: { ascendant_core: 1 },
    category: 'manufacturing',
  },

  // §11.7 / §14.10: Antimatter Refinery produces Antimatter Propellant
  // (T6 launch fuel). 2-hour cycle.
  antimatter_refinery: {
    cycleSec: 7200,
    inputs: { exotic_alloy: 1, reality_anchor: 1, casimir_energy: 2 },
    outputs: { antimatter_propellant: 1 },
    category: 'manufacturing',
  },

  // §14.3 / §14.10: Scanner Sat Assembly. 1-hour cycle.
  scanner_sat_assembly: {
    cycleSec: 3600,
    inputs: { exotic_alloy: 4, ai_core: 2, spacetime_fragment: 1, steel: 50, orbital_insertion_package: 1 },
    outputs: { scanner_sat: 1 },
    category: 'manufacturing',
  },

  // §14.3 / §14.10: Comm Sat Assembly. 1-hour cycle.
  comm_sat_assembly: {
    cycleSec: 3600,
    inputs: { exotic_alloy: 6, ai_core: 1, wire: 200, orbital_insertion_package: 1 },
    outputs: { comm_sat: 1 },
    category: 'manufacturing',
  },

  // §14.3 / §14.10: Sweeper Sat Assembly. 1-hour cycle.
  sweeper_sat_assembly: {
    cycleSec: 3600,
    inputs: { exotic_alloy: 4, ai_core: 1, steel: 100, gear: 20, orbital_insertion_package: 1 },
    outputs: { sweeper_sat: 1 },
    category: 'manufacturing',
  },

  // §14.7 / §14.10: Orbital Insertion Assembly produces the T6 Foundation-
  // Kit-equivalent payload required by every §14.7 launch. 30-min cycle.
  orbital_insertion_assembly: {
    cycleSec: 1800,
    inputs: { iron_ingot: 100, stone: 30, glass: 20, pcb: 10, ai_core: 5 },
    outputs: { orbital_insertion_package: 1 },
    category: 'manufacturing',
  },

  // §14.12 / §14.10: Repair Pack Assembly. 30-min cycle.
  repair_pack_assembly: {
    cycleSec: 1800,
    inputs: { steel: 50, gear: 10, exotic_alloy: 2, microchip: 5 },
    outputs: { repair_pack: 1 },
    category: 'manufacturing',
  },

  // ---------------------------------------------------------------------------
  // T3 microchip intermediate chain (§7.7) — pcb, circuit_board, processor,
  // computing_module. pcb_etcher is the first step; its output feeds
  // circuit_assembler, then processor_fab, then compute_module_fab.
  // Produces the T3 electronics intermediates that feed T4+ assembly recipes.
  // ---------------------------------------------------------------------------
  pcb_etcher: {
    cycleSec: 200,
    inputs: { wire: 1, glass: 1 },
    outputs: { pcb: 1 },
    category: 'electronics',
  },
  circuit_assembler: {
    cycleSec: 30,
    inputs: { pcb: 1, microchip: 2, steel: 1 },
    outputs: { circuit_board: 1 },
    category: 'electronics',
  },
  processor_fab: {
    cycleSec: 60,
    inputs: { circuit_board: 2, microchip: 4, exotic_alloy: 1 },
    outputs: { processor: 1 },
    category: 'electronics',
  },
  compute_module_fab: {
    cycleSec: 120,
    inputs: { processor: 2, circuit_board: 4, quantum_chip: 1 },
    outputs: { computing_module: 1 },
    category: 'electronics',
  },
  // Phase 6 — T2 mechanical components (§6.3 / §7.1)
  sheet_metal_mill: {
    cycleSec: 200,
    inputs: { steel: 1 },
    outputs: { sheet_metal: 2 },
    category: 'manufacturing',
  },
  pipe_mill: {
    cycleSec: 200,
    inputs: { steel: 1 },
    outputs: { pipe: 2 },
    category: 'manufacturing',
  },
  beam_mill: {
    cycleSec: 200,
    inputs: { steel: 1 },
    outputs: { steel_beam: 2 },
    category: 'manufacturing',
  },
  // Phase 6 — T2 mechanical fasteners (§6.3)
  bearing_press: {
    cycleSec: 200,
    inputs: { steel: 1, lubricant: 1 },
    outputs: { bearing: 2 },
    category: 'manufacturing',
  },
  spring_winder: {
    cycleSec: 200,
    inputs: { steel: 1 },
    outputs: { spring: 3 },
    category: 'manufacturing',
  },
  // Phase 6 — T2 mechanical components (§6.3)
  cable_drawer: {
    cycleSec: 200,
    inputs: { wire: 3 },
    outputs: { heavy_cable: 1 },
    category: 'manufacturing',
  },
  // Phase 6 — T3 battery (§6.3 / §7.9)
  battery_factory: {
    cycleSec: 300,
    inputs: { lithium: 1, rigid_plastic: 1, wire: 2 },
    outputs: { battery: 1 },
    category: 'manufacturing',
  },
  // Phase 6 — T2 glass_panel (§6.3)
  glass_panel_press: {
    cycleSec: 200,
    inputs: { glass: 2 },
    outputs: { glass_panel: 1 },
    category: 'manufacturing',
  },
  // Phase 6 — T2 coolant + ceramic_insulator (§6.3)
  coolant_synthesizer: {
    cycleSec: 300,
    inputs: { fresh_water: 2, salt: 1, naphtha: 1 },
    outputs: { coolant: 2 },
    category: 'chemistry',
  },
  ceramic_kiln: {
    cycleSec: 250,
    inputs: { clay: 2, sand: 1 },
    outputs: { ceramic_insulator: 1 },
    category: 'manufacturing',
  },

  // Phase 10 — T3 minerals + alloy (Task 10.1)
  mercury_well: {
    cycleSec: 200,
    inputs: {},
    outputs: { mercury: 1 },
    category: 'extraction',
  },
  // Phase 10 — T3 minerals + alloy (Task 10.2)
  diamond_quarry: {
    cycleSec: 300,
    inputs: {},
    outputs: { diamond_ore: 1 },
    category: 'extraction',
  },
  // Phase 10 — T3 minerals + alloy (Task 10.3)
  cryo_compound_lab: {
    cycleSec: 400,
    inputs: { liquid_nitrogen: 1, cryo_coolant: 1 },
    outputs: { cryogenic_compound: 1 },
    category: 'chemistry',
  },
  // Phase 10 — T3 minerals + alloy (Task 10.4)
  mag_alloyer: {
    cycleSec: 300,
    inputs: { iron_ingot: 2, rare_earth: 1 },
    outputs: { magnetic_alloy: 1 },
    category: 'manufacturing',
  },
  // Phase 10b — T3 minerals + alloy (Task 10.4.5)
  lithium_extractor: {
    cycleSec: 200,
    inputs: {},
    outputs: { lithium: 1 },
    category: 'extraction',
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
 * The footprint enumeration uses `footprintTiles` from shape-mask.ts, which
 * is cycle-safe because shape-mask.ts has no imports back to recipes.ts.
 */
export function resolveRecipe(
  def: BuildingDef,
  b: PlacedBuilding,
  terrainAt?: (x: number, y: number) => TerrainKind,
): Recipe | undefined {
  if (def.id === 'mine' && terrainAt) {
    let sawCoal = false;
    let sawOre = false;
    const rotation = (b.rotation ?? 0) as Rotation;
    for (const t of footprintTiles(def.footprint, b.x, b.y, rotation)) {
      const k = terrainAt(t.x, t.y);
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
    if (sawOre) return RECIPES.mine_on_ore;
    // No ore and no coal in footprint — shouldn't happen because
    // `validatePlacement` enforces `def.requiredTile` on every footprint
    // tile. Return undefined defensively so the rate loop sees a no-op
    // building rather than picking up a stale (legacy) iron_ore recipe.
    return undefined;
  }
  return RECIPES[def.id as RecipeId];
}

/**
 * §8.10 deterministic output rotation. Given a recipe with `rotateOutputs`,
 * returns the active output set for the current cycle index. Pure — no DOM,
 * no PixiJS. The cycle index is derived from `nowMs / cycleMs` so the same
 * wall-clock time always yields the same output, making the rotation
 * deterministic and testable.
 */
export function resolveRotatingOutput(
  recipe: Recipe,
  nowMs: number,
): Partial<Record<ResourceId, number>> {
  if (!recipe.rotateOutputs || recipe.rotateOutputs.length === 0) {
    return recipe.outputs;
  }
  const cycleMs = recipe.cycleSec * 1000;
  const cycleIndex = Math.floor(nowMs / cycleMs);
  const idx = cycleIndex % recipe.rotateOutputs.length;
  return recipe.rotateOutputs[idx]!;
}

/** Next wall-clock time (in ms) at which `recipe`'s rotating output changes.
 *  Returns `null` if the recipe does not rotate or has only one option. */
export function nextRotateOutputBoundaryMs(recipe: Recipe, tMs: number): number | null {
  if (!recipe.rotateOutputs || recipe.rotateOutputs.length <= 1) return null;
  const cycleMs = recipe.cycleSec * 1000;
  const nextCycleIndex = Math.floor(tMs / cycleMs) + 1;
  return nextCycleIndex * cycleMs;
}

/** Local copy of the rotation union from placement.ts. Kept here to avoid
 *  importing placement.ts (which already imports recipes.ts); the value is
 *  PlacedBuilding.rotation, which placement.ts also constrains to 0|1|2|3. */

