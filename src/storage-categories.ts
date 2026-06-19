// Per SPEC §4.6: storage is categorized. Each resource belongs to exactly
// one category; specialized storage buildings (Silo, Tank, Cold Storage,
// Component Warehouse, Vault) raise the cap only for resources in their
// matching category. Generic storage (Crate, Warehouse) labels a single
// resource at placement time and bumps only that resource's cap.
//
// Canonical resource→category mapping. Pure data — no PixiJS, no DOM.
// Imported by building-defs.ts, world.ts (aggregateStorageCaps), and
// placement.ts. Assignments follow §6; default to dry_goods when in doubt.

import type { ResourceId } from './recipes.js';

/**
 * Storage category per SPEC §4.6. Five specialized buckets, one per
 * §8.4 specialized-storage building. Generic storage (Crate, Warehouse)
 * is NOT a category — it carries a per-instance label instead and only
 * contributes capacity to that single resource.
 */
export type StorageCategory =
  | 'dry_goods'      // Silo: T0 raws (ore, wood, coal, stone, sand, …) + T1 refined dry
  | 'liquid_gas'     // Tank: water, oil, gas, hydrogen, fuels, acids
  | 'temp_sensitive' // Cold Storage: cryogenic compound, liquid nitrogen, certain plastics
  | 'components'     // Component Warehouse: T2-T3 manufactured parts (bolt, gear, wire, …)
  | 'rare';          // Vault: rare/valuable (helium_3, AI core, exotic alloy, T5 raws)

/** Iteration order — every StorageCategory exactly once. Used by skilltree
 *  multiplier aggregation to initialise the per-category cap multiplier map. */
export const ALL_STORAGE_CATEGORIES: ReadonlyArray<StorageCategory> = [
  'dry_goods',
  'liquid_gas',
  'temp_sensitive',
  'components',
  'rare',
];

/**
 * Canonical mapping. Every ResourceId MUST appear here exactly once;
 * `storage-categories.test.ts` enforces this. Bucketing rules per §6:
 *
 *   dry_goods  — T0 raw extractables plus T1 dry refined. Scrap (§6.7) is a
 *                T1 dry good.
 *   liquid_gas — all fluids and gases, including plasma_charge (T5 fuel).
 *   temp_sensitive — cryo_coolant (§4.6 example), cryogenic_compound,
 *                liquid_nitrogen. Cold Storage carries all three.
 *   components — T2-T3 manufactured parts; silicon lives here as a
 *                manufactured solid, not a raw.
 *   rare       — helium_3 (§4.6 names it), exotic_alloy, ai_core, and every
 *                T5 resource except plasma_charge (a T5 fuel → liquid_gas).
 */
export const RESOURCE_STORAGE_CATEGORY: Readonly<Record<ResourceId, StorageCategory>> = {
  // T0 raws — dry_goods.
  wood: 'dry_goods',
  iron_ore: 'dry_goods',
  coal: 'dry_goods',
  scrap: 'dry_goods',          // §6.7: explicitly "T1 dry-goods storage category".
  slag: 'dry_goods',            // §6.7 byproduct — treated as dry industrial waste.
  stone: 'dry_goods',
  sand: 'dry_goods',
  salt: 'dry_goods',
  quartz: 'dry_goods',
  // §6.1 T0 mineral raw: limestone (Task 1.2)
  limestone: 'dry_goods',
  clay: 'dry_goods',
  sulfur: 'dry_goods',
  phosphate: 'dry_goods',
  graphite: 'dry_goods',
  copper_ore: 'dry_goods',
  tin_ore: 'dry_goods',
  lead_ore: 'dry_goods',
  bauxite: 'dry_goods',
  // Phase 2 — T1 refined chains (§6.2 / §7.5)
  quicklime: 'dry_goods',
  slaked_lime: 'dry_goods',
  brick: 'dry_goods',
  mortar: 'dry_goods',
  cement: 'dry_goods',
  concrete: 'dry_goods',
  charcoal: 'dry_goods',
  plank: 'dry_goods',
  copper_ingot: 'dry_goods',
  tin_ingot: 'dry_goods',
  lead_ingot: 'dry_goods',
  solder: 'components',
  // Phase 7 — Bronze + Brass (§7.2)
  bronze: 'components',
  brass: 'components',
  // Phase 8 — Aluminum chain (§7.3)
  alumina: 'components',
  aluminum: 'components',
  // Phase 3 — T2-T3 steel alloy chains
  manganese_ore: 'dry_goods',
  manganese_ingot: 'dry_goods',
  carbon_steel: 'components',
  zinc_ore: 'dry_goods',
  zinc_ingot: 'dry_goods',
  galvanized_steel: 'components',
  chromium_ore: 'dry_goods',
  chromium_ingot: 'components',
  nickel_ore: 'dry_goods',
  nickel_ingot: 'components',
  stainless_steel: 'components',
  tungsten_ore: 'dry_goods',
  tungsten_ingot: 'components',
  tool_steel: 'components',

  // T0 liquids/gases.
  fresh_water: 'liquid_gas',
  saltwater: 'liquid_gas',
  crude_oil: 'liquid_gas',
  natural_gas: 'liquid_gas',
  hydrogen: 'liquid_gas',
  oxygen: 'liquid_gas',
  argon: 'liquid_gas',

  // T1 refined dry — dry_goods.
  iron_ingot: 'dry_goods',
  coke: 'dry_goods',
  pig_iron: 'dry_goods',
  lumber: 'dry_goods',
  glass: 'dry_goods',
  foundation_kit: 'dry_goods', // composite-but-dry assembly per §12.3.
  foundation_kit_enriched: 'dry_goods',
  foundation_kit_refined: 'dry_goods',

  // T1 refined fluid.
  biofuel: 'liquid_gas',

  // T2 alloy / components.
  bolt: 'components',
  gear: 'components',
  steel: 'components',          // sheet steel: a manufactured solid, not a raw.

  // T2 petrochemical liquids.
  naphtha: 'liquid_gas',
  chlorine: 'liquid_gas',
  lubricant: 'liquid_gas',
  diesel: 'liquid_gas',
  // Phase 4 — T2 petrochemical byproducts (§7.4)
  heavy_oil: 'liquid_gas',
  tar: 'liquid_gas',
  asphalt: 'liquid_gas',
  plastic_precursor: 'liquid_gas',
  rigid_plastic: 'components',
  flexible_plastic: 'components',
  synthetic_rubber: 'components',
  // Phase 6 — T2 mechanical components (§6.3 / §7.1)
  sheet_metal: 'components',
  pipe: 'components',
  steel_beam: 'components',
  // Phase 6 — T2 mechanical fasteners (§6.3)
  bearing: 'components',
  spring: 'components',
  // Phase 6 — T2 mechanical components (§6.3)
  heavy_cable: 'components',
  // Phase 6 — T3 battery (§6.3 / §7.9)
  battery: 'components',
  // Phase 6 — T2 glass_panel (§6.3)
  glass_panel: 'components',
  // Phase 6 — T2 coolant + ceramic_insulator (§6.3)
  coolant: 'liquid_gas',
  ceramic_insulator: 'components',
  // Phase 5 — T2 chemistry chain (§7.5)
  sulfuric_acid: 'liquid_gas',
  hydrochloric_acid: 'liquid_gas',
  sodium_hydroxide: 'liquid_gas',
  // Phase 5 — T3 chemistry chain (§7.5)
  phosphor: 'rare',
  liquid_nitrogen: 'temp_sensitive',

  // T2 components.
  wire: 'components',
  // §15.6 saltwater-cell bootstrap — same bucket as wire / bolt / gear.
  saltwater_cell: 'components',

  // T3 chemistry/electronics.
  silicon: 'components',        // §6.4: semiconductor solid → component.
  silicon_wafer: 'components',  // §7.7: T3 semiconductor intermediate.
  transistor: 'components',      // §7.7: T3 electronics component.
  capacitor: 'components',       // §7.7: T3 electronics component.
  resistor: 'components',        // §7.7: T3 electronics component.
  memory_module: 'components',    // §7.7: T3 electronics component.
  nitrogen: 'liquid_gas',
  cryo_coolant: 'temp_sensitive', // §4.6 lists "cryo-coolant" under temp_sensitive.
  aviation_kerosene: 'liquid_gas',
  microchip: 'components',
  pcb: 'components',
  circuit_board: 'components',
  processor: 'components',
  computing_module: 'components',

  // T4 — components/rare/liquid.
  helium_3: 'rare',             // §6.4 T3-rare raw; §4.6 names it explicitly.
  cryogenic_hydrogen: 'liquid_gas',
  quantum_chip: 'components',   // T4 chip; brief locates it in components.
  exotic_alloy: 'rare',         // T4 alloy; brief locates it in rare.
  ai_core: 'rare',              // T4 component; brief locates it in rare.
  carbon_fiber: 'rare',         // §9.5 T4 component; Forest-unique bottleneck output.
  // §6.4 T3 mineral raws (for slag reprocessing + nuclear fuel)
  gold_ore: 'dry_goods',
  silver_ore: 'dry_goods',
  rare_earth: 'dry_goods',
  uranium_ore: 'dry_goods',
  // §6.6 T5 component (memetic core)
  memetic_core: 'rare',

  // T5 transcendent — all rare except plasma_charge (T5 propellant/fuel).
  casimir_energy: 'rare',
  reality_anchor: 'rare',
  plasma_charge: 'liquid_gas',  // §6.6 / §11.7: T5 fuel / propellant.
  eldritch_processor: 'rare',
  phase_converter: 'rare',
  aetheric_current: 'rare',
  tachyon_stream: 'rare',
  dark_matter: 'rare',
  strange_matter: 'rare',
  quantum_foam: 'rare',
  spacetime_fragment: 'rare',
  higgs_flux: 'rare',
  // Phase 12 — T5 transcendent raws (Task 12.1)
  zero_point_flux: 'rare',
  neutronium: 'rare',
  // Phase 12 — T5 components (Task 12.2)
  probability_calculator: 'rare',
  dimensional_fold: 'rare',
  causal_regulator: 'rare',
  // Phase 12 — T5 components (Task 12.3)
  tachyonic_transmitter: 'rare',
  aether_beacon: 'rare',
  reality_engine: 'rare',
  singularity_battery_unit: 'rare',
  // Step-20 (T6 Orbital) — all route to `rare`, the Vault being the T5/T6
  // catch-all. antimatter_propellant is a fuel/gas (§11.7) and an arguable
  // liquid_gas candidate, but `rare` keeps T6 launch fuel gated behind a
  // Vault not a mid-tier Tank, matching its weight (1000) and §14.10.
  ascendant_core: 'rare',
  antimatter_propellant: 'rare',
  scanner_sat: 'rare',
  relay_sat: 'rare',
  orbital_insertion_package: 'rare',
  sweeper_sat: 'rare',
  mirror_sat: 'rare',
  repair_drone: 'rare',
  repair_pack: 'rare',
  // §13.4 T5 endgame artifact — victory condition resource.
  genesis_cell: 'rare',
  // Phase 10 — T3 minerals + alloy (Task 10.1)
  mercury: 'liquid_gas',
  // Phase 10 — T3 minerals + alloy (Task 10.2)
  diamond_ore: 'rare',
  // Phase 10 — T3 minerals + alloy (Task 10.3)
  cryogenic_compound: 'temp_sensitive',
  // Phase 10 — T3 minerals + alloy (Task 10.4)
  magnetic_alloy: 'components',
  // Phase 10b — T3 minerals + alloy (Task 10.4.5)
  lithium: 'rare',
  // Phase 10b — T3 power components (Task 10.5)
  magnet: 'components',
  // Phase 10b — T3 power components (Task 10.6)
  electric_motor: 'components',
  // Phase 10b — T3 power components (Task 10.7)
  generator: 'components',
  // Phase 10c — T3 mechanical assemblies (Task 10.8)
  hydraulic_actuator: 'components',
  pneumatic_actuator: 'components',
  // Phase 10c — T3 power components (Task 10.10)
  fuel_cell: 'components',
  // Phase 10c — T3 glass/ceramics (Task 10.11)
  optical_glass: 'components',
  // Phase 10c — T3 fiber spinners (Task 10.12)
  glass_fiber: 'components',
  optical_fiber: 'components',
  // Phase 11 — T4 endgame (Task 11.1)
  time_crystal: 'rare',
  // Phase 11 — T4 endgame (Task 11.2)
  antimatter_capsule: 'rare',
  // Phase 11 — T4 endgame (Task 11.3)
  nuclear_fuel_rod: 'rare',
  // Phase 11 — T4 endgame (Task 11.4)
  plasma_containment_vessel: 'rare',
  singularity_sensor: 'rare',
  cryo_containment_unit: 'rare',
  particle_accelerator_core: 'rare',
  self_replication_module: 'rare',
  // Ocean-layer §3 — Task 8 extractor outputs. WHY these buckets:
  //   Brines are aqueous → liquid_gas; methane_hydrate is a solid clathrate
  //     but kept with the hydrocarbon stocks (crude_oil / natural_gas).
  //   Nodules are solid concretions → dry_goods; the raw nodule sits with the
  //     ore family until concentrated by §3 Task-9 processors.
  //   Vent products → dry_goods (vent_sulfide) / rare (vent_exotic, T4 feeder).
  //   he3_dilute / heavy_isotope_slurry are isotope concentrates → rare
  //     (Vault-gated, mirroring helium_3 / uranium_ore).
  dilute_brine: 'liquid_gas',
  concentrated_brine: 'liquid_gas',
  he3_dilute: 'rare',
  mn_nodule: 'dry_goods',
  re_nodule: 'dry_goods',
  co_nodule: 'dry_goods',
  methane_hydrate: 'liquid_gas',
  heavy_isotope_slurry: 'rare',
  vent_sulfide: 'dry_goods',
  vent_exotic: 'rare',
  // Ocean-layer §3 — Task 9 processor outputs. WHY these buckets:
  //   lithium_brine / bromine / heavy_water → liquid_gas (aqueous/solution
  //     intermediates; bromine stored as liquid under pressure; heavy_water
  //     is D2O).
  //   salt is reused — already dry_goods at the evaporator-output entry above.
  //   rare_earth_concentrate / refined_cobalt → dry_goods (processed powders).
  //   exotic_alloy_seed / tritium_seed are T5 exotics → rare.
  lithium_brine: 'liquid_gas',
  bromine: 'liquid_gas',
  rare_earth_concentrate: 'dry_goods',
  refined_cobalt: 'dry_goods',
  exotic_alloy_seed: 'rare',
  tritium_seed: 'rare',
  heavy_water: 'liquid_gas',
  // §04: T1 Mining Skill Crystal — rare crafted item (stored in Vault/rare).
  mining_crystal_t1: 'rare',
  // Task 6: all crystal families are rare crafted items.
  mining_crystal_t2: 'rare',
  mining_crystal_t3: 'rare',
  forestry_crystal_t1: 'rare',
  forestry_crystal_t2: 'rare',
  forestry_crystal_t3: 'rare',
  drilling_crystal_t1: 'rare',
  drilling_crystal_t2: 'rare',
  drilling_crystal_t3: 'rare',
  robotics_crystal_t1: 'rare',
  robotics_crystal_t2: 'rare',
  robotics_crystal_t3: 'rare',
  smelting_crystal_t1: 'rare',
  smelting_crystal_t2: 'rare',
  smelting_crystal_t3: 'rare',
  chemistry_crystal_t1: 'rare',
  chemistry_crystal_t2: 'rare',
  chemistry_crystal_t3: 'rare',
  electronics_crystal_t1: 'rare',
  electronics_crystal_t2: 'rare',
  electronics_crystal_t3: 'rare',
  power_systems_crystal_t1: 'rare',
  power_systems_crystal_t2: 'rare',
  power_systems_crystal_t3: 'rare',
  storage_crystal_t1: 'rare',
  storage_crystal_t2: 'rare',
  storage_crystal_t3: 'rare',
  transport_crystal_t1: 'rare',
  transport_crystal_t2: 'rare',
  transport_crystal_t3: 'rare',
  network_crystal_t1: 'rare',
  network_crystal_t2: 'rare',
  network_crystal_t3: 'rare',
  launch_crystal_t1: 'rare',
  launch_crystal_t2: 'rare',
  launch_crystal_t3: 'rare',
  communication_crystal_t1: 'rare',
  communication_crystal_t2: 'rare',
  communication_crystal_t3: 'rare',
  discovery_crystal_t1: 'rare',
  discovery_crystal_t2: 'rare',
  discovery_crystal_t3: 'rare',
  resilience_crystal_t1: 'rare',
  resilience_crystal_t2: 'rare',
  resilience_crystal_t3: 'rare',
  patronage_crystal_t1: 'rare',
  patronage_crystal_t2: 'rare',
  patronage_crystal_t3: 'rare',
  aquaculture_crystal_t1: 'rare',
  aquaculture_crystal_t2: 'rare',
  aquaculture_crystal_t3: 'rare',
  hydroprocessing_crystal_t1: 'rare',
  hydroprocessing_crystal_t2: 'rare',
  hydroprocessing_crystal_t3: 'rare',
  submarine_crystal_t1: 'rare',
  submarine_crystal_t2: 'rare',
  submarine_crystal_t3: 'rare',
  oceanography_crystal_t1: 'rare',
  oceanography_crystal_t2: 'rare',
  oceanography_crystal_t3: 'rare',
  // Phase 2 — SI-units rework new resources (§08)
  co: 'liquid_gas',
  co2: 'liquid_gas',
  refinery_gas: 'liquid_gas',
  wood_tar: 'liquid_gas',
  water_vapor: 'liquid_gas',
  aviation_kerosene_crude: 'liquid_gas',
  mill_scale: 'dry_goods',
  calcium_sulfonate: 'dry_goods',
  air: 'liquid_gas',
  cryo_coolant_vented: 'liquid_gas',
};

// SI-units rev-16 §13.4 — per-resource base storage cap on a fresh island.
// Defaults via defaultCapForCategory() below; overrides for sub-calibrated
// resources (helium_3, antimatter_propellant, ai_core, foundation_kit, etc).
export const RESOURCE_BASE_CAP: Readonly<Partial<Record<ResourceId, number>>> = {
  // helium_3: 1 unit = 1 g.
  helium_3: 1,
  // antimatter_propellant: 1 unit = 1 ng.
  antimatter_propellant: 1,
  // ai_core: 1 unit = 1 kg single chip. Whole-unit-only — 0 base cap.
  ai_core: 0,
  // foundation_kit: large assembly.
  foundation_kit: 5,
};

// rev-16 §13.4 — category defaults when no per-resource override is present.
export function defaultCapForCategory(c: StorageCategory): number {
  switch (c) {
    case 'dry_goods':      return 100;
    case 'liquid_gas':     return 100;
    case 'temp_sensitive': return 50;
    case 'components':     return 20;
    case 'rare':           return 1;
  }
}

/**
 * Per-resource baseline storage cap on a fresh island (no storage buildings):
 * the `RESOURCE_BASE_CAP` override if present, else the category default. This
 * is the literal starting cap — NOT floored (ai_core legitimately starts at 0,
 * whole-unit-only).
 */
export function baselineCap(r: ResourceId): number {
  const override = RESOURCE_BASE_CAP[r];
  return override !== undefined ? override : defaultCapForCategory(RESOURCE_STORAGE_CATEGORY[r]);
}

/**
 * §4.6 percentage storage: the per-resource "base" a storage building's
 * capacity MULTIPLIER scales off. A storage building contributes
 * `multiplier × storageBaseFor(r)` to resource `r`'s cap (the `multiplier`
 * being `def.storage.capacity`, floor-scaled). Floored at 5 so resources with
 * a tiny or zero baseline (rare = 1, ai_core = 0) still receive usable storage
 * — otherwise `multiplier × 0` would leave ai_core permanently unstorable.
 */
export const MIN_STORAGE_BASE = 5;
export function storageBaseFor(r: ResourceId): number {
  return Math.max(MIN_STORAGE_BASE, baselineCap(r));
}
