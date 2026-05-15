// Per SPEC §4.6: storage is categorized. Each resource belongs to exactly
// one category; specialized storage buildings (Silo, Tank, Cold Storage,
// Component Warehouse, Vault) raise the cap only for resources in their
// matching category. Generic storage (Crate, Warehouse) labels a single
// resource at placement time and bumps only that resource's cap.
//
// This module is the canonical resource→category mapping. Pure data — no
// PixiJS, no DOM. Imported by `building-defs.ts` (StorageCategory union),
// `world.ts` (aggregateStorageCaps), and `placement.ts` (place/demolish).
//
// Assignments follow §6 (T0 raws → dry_goods, T1+ refined by chemistry,
// T4-T5 components → rare). When in doubt, the brief says default to
// dry_goods.

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

/**
 * Canonical mapping. Every ResourceId MUST appear here exactly once;
 * `storage-categories.test.ts` enforces this. The bucketing rules per §6:
 *
 *   dry_goods  — T0 raw extractables (ore, wood, coal, stone, sand, quartz, …)
 *                plus T1 dry refined (lumber, glass, iron_ingot, pig_iron,
 *                coke, foundation_kit). Scrap (§6.7) is a T1 dry good.
 *   liquid_gas — all fluids and gases: water (fresh + salt), crude oil,
 *                natural gas, hydrogen, biofuel, naphtha, chlorine,
 *                lubricant, diesel, aviation kerosene, nitrogen,
 *                cryogenic_hydrogen, plasma_charge (T5 fuel/propellant).
 *   temp_sensitive — cryo_coolant (per §4.6 "cryo-coolant" example).
 *                cryogenic_compound + liquid_nitrogen aren't in the catalog
 *                yet (deferred) — Cold Storage capacity will gain consumers
 *                when they ship.
 *   components — T2-T3 manufactured parts: bolt, gear, wire, sheet_metal
 *                (deferred), microchip, quantum_chip. Silicon is a T3
 *                semiconductor intermediate but lives in components since
 *                it's a manufactured solid, not a raw.
 *   rare       — helium_3 (T3 raw, per §4.6 "all T4-T6 components" and
 *                "Helium-3" example), exotic_alloy (T4), ai_core (T4 per
 *                brief), and every T5 resource (casimir_energy,
 *                reality_anchor, plasma_charge — wait: plasma_charge is a
 *                T5 fuel per §6.6, so it's liquid_gas; eldritch_processor,
 *                phase_converter, aetheric_current, tachyon_stream,
 *                dark_matter, strange_matter).
 *
 * Per the task brief: quantum_chip → components (T4 but a manufactured
 * chip), ai_core → rare. plasma_charge → liquid_gas as a T5 propellant.
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
  // Step-20 (T6 Orbital). All five route to `rare` — the Vault is the
  // canonical T5/T6 catch-all. `antimatter_propellant` is a fuel/gas in
  // nature (§11.7) and an arguable `liquid_gas` candidate, but routing it
  // to `rare` keeps T6 launch fuel gated behind a Vault rather than a
  // mid-tier Tank, matching its T6 weight (1000) and §14.10 "real
  // production commitment" narrative. Reassignable if a T6 fuel-storage
  // building lands later.
  ascendant_core: 'rare',
  antimatter_propellant: 'rare',
  scanner_sat: 'rare',
  comm_sat: 'rare',
  orbital_insertion_package: 'rare',
  sweeper_sat: 'rare',
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

};
