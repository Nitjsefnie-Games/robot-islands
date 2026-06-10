// Resources, recipes, and xp_weight table. Per SPEC §6 (Resource Catalog)
// and §7 (Recipe Chains). Catalog spans T0 raws through the T6 Orbital tier:
//
//   T0/T1 raws:   wood, iron_ore, coal, biofuel
//   T1 refined:   iron_ingot, coke, pig_iron, bolt
//   T2 alloy:     steel
//   T2 component: gear
//   T4 raw/fuel:  helium_3, cryogenic_hydrogen
//   T4 component: quantum_chip, exotic_alloy, ai_core
//   T5 raw:       casimir_energy   (per §8.10 Casimir Tap "free vacuum energy")
//   T5 fuel:      plasma_charge    (T5 propellant per §6.6 / §11.7)
//   T5 component: reality_anchor, eldritch_processor, phase_converter
//   T5→T6 artifact: ascendant_core      (§13.4 / §14.1 — flips the §14.1 gate)
//   T6 fuel:        antimatter_propellant (§11.7 / §14.10)
//   T6 payload:     scanner_sat, relay_sat, orbital_insertion_package (§14.3 / §14.10)
//
// `xp_weight` per SPEC §9.1: T0 raws = 1, T1 = 3, T2 = 10, T4 = 100, T5 = 300, T6 = 1000.
// Higher-tier outputs grant proportionally more XP per unit produced, so the
// progression curve rewards climbing the recipe chain rather than just
// stockpiling raws.

import type { BuildingDef, BuildingDefId } from './building-defs.js';
import type { PlacedBuilding } from './buildings.js';
import type { TerrainKind } from './island.js';
import { footprintTiles, type Rotation } from './shape-mask.js';
import type { IslandState } from './economy.js';
import type { Graph } from './skilltree-graph.js';

export type ResourceId =
  // T0 raws
  | 'wood'
  | 'iron_ore'
  | 'coal'
  // §6.7 demolition byproduct. T1 dry-good per spec ("Scrap is a T1 resource
  // in the dry-goods storage category"). The §6.7 Steel-recipe substitution
  // ("2 Scrap = 1 Pig iron's worth of steel input") is wired via the
  // `steel_mill_from_scrap` synthetic recipe selected at runtime by
  // `resolveRecipe` when a Steel Mill has no pig_iron stockpile but has
  // scrap on hand. The substitution preserves the base Steel Mill's
  // output rate (1 steel + 1 slag per 600s cycle).
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
  // Refined per-tier variants shipped in Task 13.2. The kit is a single
  // inventory item; its decomposition into raw constituents on arrival (§12.4)
  // is implemented in settlement.ts tickVehicles.
  | 'foundation_kit'
  // Task 13.2 — Foundation Kit Enriched (T3) + Refined (T4) variants.
  | 'foundation_kit_enriched'
  | 'foundation_kit_refined'
  // Step-18 T2 refined / petrochemical (§7.3).
  | 'naphtha'
  | 'chlorine'
  | 'lubricant'
  | 'diesel'
  | 'wire'
  // §15.6 saltwater-cell bootstrap — T2 home-buildable battery component.
  | 'saltwater_cell'
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
  // for the Reality Forge demo chain + T5 fuel). Full §6.6 raws partially
  // shipped in step 18 (Aetheric Conduit, Spacetime Resonator, Eldritch Sieve
  // plus Phase 12 Zero-Point / Neutronium).
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
  // Phase 12 — T5 transcendent raws (Task 12.1)
  | 'zero_point_flux'
  | 'neutronium'
  // Phase 12 — T5 components (Task 12.2)
  | 'probability_calculator'
  | 'dimensional_fold'
  | 'causal_regulator'
  // Phase 12 — T5 components (Task 12.3)
  | 'tachyonic_transmitter'
  | 'aether_beacon'
  | 'reality_engine'
  | 'singularity_battery_unit'
  // T6 Orbital (§14). Resources the §14.2 Spaceport + §14.10
  // satellite-assembly defs touch.
  //
  //   ascendant_core           — T5/T6 transition artifact per §13.4 /
  //                              §14.1. Crafted at `ascendant_assembly`
  //                              (T5 building); first local production
  //                              auto-flips `state.ascendantCoreCrafted`
  //                              (see economy.ts:advanceIsland — the §13
  //                              auto-flip block fires alongside the AI-Core
  //                              flip). The T6 launch UI gates on the flag.
  //   antimatter_propellant    — T6 launch fuel per §11.7 / §14.10. Crafted
  //                              at `antimatter_refinery` (T6).
  //   scanner_sat              — §14.3 discovery/weather satellite payload.
  //   relay_sat                — §14.3 comm-graph extension payload.
  //   mirror_sat               — §14.3 Mirror Sat payload: orbital reflector
  //                              that boosts ground-station effective solar
  //                              multiplier via a Lorentzian distance falloff.
  //   orbital_insertion_package — §14.7 "T6 Foundation-Kit equivalent" —
  //                              every launch requires one alongside fuel +
  //                              variant recipe. Crafted at
  //                              `oip_assembly` (T6).
  | 'ascendant_core'
  | 'antimatter_propellant'
  | 'scanner_sat'
  | 'relay_sat'
  | 'orbital_insertion_package'
  | 'sweeper_sat'
  | 'mirror_sat'
  | 'repair_drone'
  | 'repair_pack'
  | 'pcb'
  | 'circuit_board'
  | 'processor'
  | 'computing_module'
  // §13.4 T5 transcendent artifact — produced by `genesis_forge` (24h cycle;
  // 2026-05-18 ÷3 for display visibility → now 8h cycle).
  // Per spec the game has NO finish state; crafting this is a milestone,
  // not a win condition.
  | 'genesis_cell'
  // Phase 11 — T4 endgame (Task 11.1)
  | 'time_crystal'
  // Phase 11 — T4 endgame (Task 11.2)
  | 'antimatter_capsule'
  // Phase 11 — T4 endgame (Task 11.3)
  | 'nuclear_fuel_rod'
  // Phase 11 — T4 endgame (Task 11.4)
  | 'plasma_containment_vessel'
  | 'singularity_sensor'
  | 'cryo_containment_unit'
  | 'particle_accelerator_core'
  | 'self_replication_module'
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
  // Phase 10b — T3 power components (Task 10.5)
  | 'magnet'
  // Phase 10b — T3 power components (Task 10.6)
  | 'electric_motor'
  // Phase 10b — T3 power components (Task 10.7)
  | 'generator'
  // Phase 10c — T3 mechanical assemblies (Task 10.8)
  | 'pump'
  | 'hydraulic_actuator'
  | 'pneumatic_actuator'
  // Phase 10c — T3 power components (Task 10.9)
  | 'solar_cell'
  // Phase 10c — T3 power components (Task 10.10)
  | 'fuel_cell'
  // Phase 10c — T3 glass/ceramics (Task 10.11)
  | 'optical_glass'
  // Phase 10c — T3 fiber spinners (Task 10.12)
  | 'glass_fiber'
  | 'optical_fiber'
  // Ocean-layer §3 — Task 8 raw extractor outputs (10 new raws).
  // Common (dry_goods / liquid_gas): dilute_brine, concentrated_brine,
  // mn_nodule, methane_hydrate, vent_sulfide.
  // Rare (Vault category): he3_dilute, re_nodule, co_nodule,
  // heavy_isotope_slurry, vent_exotic.
  // Task 9 will add the processor outputs that consume these.
  | 'dilute_brine'
  | 'concentrated_brine'
  | 'he3_dilute'
  | 'mn_nodule'
  | 're_nodule'
  | 'co_nodule'
  | 'methane_hydrate'
  | 'heavy_isotope_slurry'
  | 'vent_sulfide'
  | 'vent_exotic'
  // Ocean-layer §3 — Task 9 processor outputs (7 new).
  //   T3 intermediates (Brine Distillation Rig rotateOutputs): lithium_brine,
  //     bromine. (`salt` is reused from the existing chemistry chain — same
  //     Evaporator-output salt the chlor-alkali pathway consumes.)
  //   T4 intermediates (Nodule Concentrator rotateOutputs):
  //     rare_earth_concentrate, refined_cobalt.
  //   T5 finals (Vent Mineral Refinery + Heavy Water Distiller):
  //     exotic_alloy_seed, tritium_seed, heavy_water.
  | 'lithium_brine'
  | 'bromine'
  | 'rare_earth_concentrate'
  | 'refined_cobalt'
  | 'exotic_alloy_seed'
  | 'tritium_seed'
  | 'heavy_water'
  // §04: Skill Crystal — T1 Mining Crystal (crafted at Skill Forge).
  | 'mining_crystal_t1'
  // Task 6: content fill — 19 remaining families × 3 tiers = 57 new crystals.
  | 'mining_crystal_t2'
  | 'mining_crystal_t3'
  | 'forestry_crystal_t1'
  | 'forestry_crystal_t2'
  | 'forestry_crystal_t3'
  | 'drilling_crystal_t1'
  | 'drilling_crystal_t2'
  | 'drilling_crystal_t3'
  | 'robotics_crystal_t1'
  | 'robotics_crystal_t2'
  | 'robotics_crystal_t3'
  | 'smelting_crystal_t1'
  | 'smelting_crystal_t2'
  | 'smelting_crystal_t3'
  | 'chemistry_crystal_t1'
  | 'chemistry_crystal_t2'
  | 'chemistry_crystal_t3'
  | 'electronics_crystal_t1'
  | 'electronics_crystal_t2'
  | 'electronics_crystal_t3'
  | 'power_systems_crystal_t1'
  | 'power_systems_crystal_t2'
  | 'power_systems_crystal_t3'
  | 'storage_crystal_t1'
  | 'storage_crystal_t2'
  | 'storage_crystal_t3'
  | 'transport_crystal_t1'
  | 'transport_crystal_t2'
  | 'transport_crystal_t3'
  | 'network_crystal_t1'
  | 'network_crystal_t2'
  | 'network_crystal_t3'
  | 'launch_crystal_t1'
  | 'launch_crystal_t2'
  | 'launch_crystal_t3'
  | 'communication_crystal_t1'
  | 'communication_crystal_t2'
  | 'communication_crystal_t3'
  | 'discovery_crystal_t1'
  | 'discovery_crystal_t2'
  | 'discovery_crystal_t3'
  | 'resilience_crystal_t1'
  | 'resilience_crystal_t2'
  | 'resilience_crystal_t3'
  | 'patronage_crystal_t1'
  | 'patronage_crystal_t2'
  | 'patronage_crystal_t3'
  | 'aquaculture_crystal_t1'
  | 'aquaculture_crystal_t2'
  | 'aquaculture_crystal_t3'
  | 'hydroprocessing_crystal_t1'
  | 'hydroprocessing_crystal_t2'
  | 'hydroprocessing_crystal_t3'
  | 'submarine_crystal_t1'
  | 'submarine_crystal_t2'
  | 'submarine_crystal_t3'
  | 'oceanography_crystal_t1'
  | 'oceanography_crystal_t2'
  | 'oceanography_crystal_t3'
// Phase 2 — SI-units rework new resources (§08)
| 'co'
| 'co2'
| 'refinery_gas'
| 'wood_tar'
| 'water_vapor'
| 'aviation_kerosene_crude'
| 'mill_scale'
| 'calcium_sulfonate'
| 'air'
| 'cryo_coolant_vented';

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
  // Task 13.2 — Foundation Kit Enriched (T3) + Refined (T4) variants.
  'foundation_kit_enriched',
  'foundation_kit_refined',
  // Step-18 T2 petrochemical / refined.
  'naphtha',
  'chlorine',
  'lubricant',
  'diesel',
  'wire',
  // §15.6 saltwater-cell bootstrap.
  'saltwater_cell',
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
  // Phase 12 — T5 transcendent raws (Task 12.1)
  'zero_point_flux',
  'neutronium',
  // Phase 12 — T5 components (Task 12.2)
  'probability_calculator',
  'dimensional_fold',
  'causal_regulator',
  // Phase 12 — T5 components (Task 12.3)
  'tachyonic_transmitter',
  'aether_beacon',
  'reality_engine',
  'singularity_battery_unit',
  // Step-20 T5→T6 artifact + T6 Orbital partial catalog (§14).
  'ascendant_core',
  'antimatter_propellant',
  'scanner_sat',
  'relay_sat',
  'orbital_insertion_package',
  'sweeper_sat',
  'mirror_sat',
  'repair_drone',
  'repair_pack',
  'pcb',
  'circuit_board',
  'processor',
  'computing_module',
  // §13.4 endgame artifact
  'genesis_cell',
  // Phase 11 — T4 endgame (Task 11.1)
  'time_crystal',
  // Phase 11 — T4 endgame (Task 11.2)
  'antimatter_capsule',
  // Phase 11 — T4 endgame (Task 11.3)
  'nuclear_fuel_rod',
  // Phase 11 — T4 endgame (Task 11.4)
  'plasma_containment_vessel',
  'singularity_sensor',
  'cryo_containment_unit',
  'particle_accelerator_core',
  'self_replication_module',
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
  // Phase 10b — T3 power components (Task 10.5)
  'magnet',
  // Phase 10b — T3 power components (Task 10.6)
  'electric_motor',
  // Phase 10b — T3 power components (Task 10.7)
  'generator',
  // Phase 10c — T3 mechanical assemblies (Task 10.8)
  'pump',
  'hydraulic_actuator',
  'pneumatic_actuator',
  // Phase 10c — T3 power components (Task 10.9)
  'solar_cell',
  // Phase 10c — T3 power components (Task 10.10)
  'fuel_cell',
  // Phase 10c — T3 glass/ceramics (Task 10.11)
  'optical_glass',
  // Phase 10c — T3 fiber spinners (Task 10.12)
  'glass_fiber',
  'optical_fiber',
  // Ocean-layer §3 — Task 8 raw extractor outputs.
  'dilute_brine',
  'concentrated_brine',
  'he3_dilute',
  'mn_nodule',
  're_nodule',
  'co_nodule',
  'methane_hydrate',
  'heavy_isotope_slurry',
  'vent_sulfide',
  'vent_exotic',
  // Ocean-layer §3 — Task 9 processor outputs.
  'lithium_brine',
  'bromine',
  'rare_earth_concentrate',
  'refined_cobalt',
  'exotic_alloy_seed',
  'tritium_seed',
  'heavy_water',
  // §04: Skill Crystal — T1 Mining Crystal.
  'mining_crystal_t1',
  // Task 6: content fill — 19 remaining families × 3 tiers.
  'mining_crystal_t2',
  'mining_crystal_t3',
  'forestry_crystal_t1',
  'forestry_crystal_t2',
  'forestry_crystal_t3',
  'drilling_crystal_t1',
  'drilling_crystal_t2',
  'drilling_crystal_t3',
  'robotics_crystal_t1',
  'robotics_crystal_t2',
  'robotics_crystal_t3',
  'smelting_crystal_t1',
  'smelting_crystal_t2',
  'smelting_crystal_t3',
  'chemistry_crystal_t1',
  'chemistry_crystal_t2',
  'chemistry_crystal_t3',
  'electronics_crystal_t1',
  'electronics_crystal_t2',
  'electronics_crystal_t3',
  'power_systems_crystal_t1',
  'power_systems_crystal_t2',
  'power_systems_crystal_t3',
  'storage_crystal_t1',
  'storage_crystal_t2',
  'storage_crystal_t3',
  'transport_crystal_t1',
  'transport_crystal_t2',
  'transport_crystal_t3',
  'network_crystal_t1',
  'network_crystal_t2',
  'network_crystal_t3',
  'launch_crystal_t1',
  'launch_crystal_t2',
  'launch_crystal_t3',
  'communication_crystal_t1',
  'communication_crystal_t2',
  'communication_crystal_t3',
  'discovery_crystal_t1',
  'discovery_crystal_t2',
  'discovery_crystal_t3',
  'resilience_crystal_t1',
  'resilience_crystal_t2',
  'resilience_crystal_t3',
  'patronage_crystal_t1',
  'patronage_crystal_t2',
  'patronage_crystal_t3',
  'aquaculture_crystal_t1',
  'aquaculture_crystal_t2',
  'aquaculture_crystal_t3',
  'hydroprocessing_crystal_t1',
  'hydroprocessing_crystal_t2',
  'hydroprocessing_crystal_t3',
  'submarine_crystal_t1',
  'submarine_crystal_t2',
  'submarine_crystal_t3',
  'oceanography_crystal_t1',
  'oceanography_crystal_t2',
  'oceanography_crystal_t3',
  // Phase 2 — SI-units rework new resources (§08)
  'co',
  'co2',
  'refinery_gas',
  'wood_tar',
  'water_vapor',
  'aviation_kerosene_crude',
  'mill_scale',
  'calcium_sulfonate',
  'air',
  'cryo_coolant_vented',
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
 *                          scanner_sat, relay_sat, orbital_insertion_package)
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
  // Task 13.2 — Foundation Kit Enriched (T3) + Refined (T4) variants.
  foundation_kit_enriched: 30,
  foundation_kit_refined: 100,
  // Step-18 T2 petrochemical / refined.
  naphtha: 10,
  chlorine: 10,
  lubricant: 10,
  diesel: 10,
  wire: 10,
  // §15.6 saltwater-cell bootstrap — T2 component weight = 10 per §9.1.
  saltwater_cell: 10,
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
  // Phase 12 — T5 transcendent raws (Task 12.1)
  zero_point_flux: 300,
  neutronium: 300,
  // Phase 12 — T5 components (Task 12.2)
  probability_calculator: 300,
  dimensional_fold: 300,
  causal_regulator: 300,
  // Phase 12 — T5 components (Task 12.3)
  tachyonic_transmitter: 300,
  aether_beacon: 300,
  reality_engine: 300,
  singularity_battery_unit: 300,
  // T5→T6 transition artifact. §9.1 puts T5 weight at 300 and T6 at 1000;
  // Ascendant Core is the bridge artifact unlocking T6 access (§13.4 /
  // §14.1), so it carries the higher T6 weight (1000) — producing one
  // is the moment the player crosses into the T6 tier band.
  ascendant_core: 1000,
  // T6 Orbital — §9.1 T6 weight 1000.
  antimatter_propellant: 1000,
  scanner_sat: 1000,
  relay_sat: 1000,
  orbital_insertion_package: 1000,
  sweeper_sat: 1000,
  mirror_sat: 1000,
  repair_drone: 1000,
  // repair_pack is a T5-equivalent consumable per task brief.
  repair_pack: 300,
  pcb: 10,
  circuit_board: 30,
  processor: 30,
  computing_module: 30,
  // §13.4 T5 endgame artifact
  genesis_cell: 300,
  // Phase 11 — T4 endgame (Task 11.1)
  time_crystal: 100,
  // Phase 11 — T4 endgame (Task 11.2)
  antimatter_capsule: 100,
  // Phase 11 — T4 endgame (Task 11.3)
  nuclear_fuel_rod: 100,
  // Phase 11 — T4 endgame (Task 11.4)
  plasma_containment_vessel: 100,
  singularity_sensor: 100,
  cryo_containment_unit: 100,
  particle_accelerator_core: 100,
  self_replication_module: 100,
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
  // Phase 10b — T3 power components (Task 10.5)
  magnet: 30,
  // Phase 10b — T3 power components (Task 10.6)
  electric_motor: 30,
  // Phase 10b — T3 power components (Task 10.7)
  generator: 30,
  // Phase 10c — T3 mechanical assemblies (Task 10.8)
  pump: 30,
  hydraulic_actuator: 30,
  pneumatic_actuator: 30,
  // Phase 10c — T3 power components (Task 10.9)
  solar_cell: 30,
  // Phase 10c — T3 power components (Task 10.10)
  fuel_cell: 30,
  // Phase 10c — T3 glass/ceramics (Task 10.11)
  optical_glass: 30,
  // Phase 10c — T3 fiber spinners (Task 10.12)
  glass_fiber: 30,
  optical_fiber: 30,
  // Ocean-layer §3 — Task 8 raw extractor outputs (xp weight = source tier).
  //   Seawater Intake T2 → dilute_brine (T2 weight 10).
  //   Open-Water (T3) → concentrated_brine, he3_dilute (T3 weight 30).
  //   Nodule Harvester (T3) → mn_nodule, re_nodule, co_nodule (T3 weight 30).
  //   Trench Drill (T4) → methane_hydrate, heavy_isotope_slurry, vent_sulfide
  //     (T4 weight 100; vent_sulfide is also produced by T4 Vent Tap so 100
  //     holds either side).
  //   Vent Tap (T4) → vent_sulfide, vent_exotic (T4 weight 100).
  dilute_brine: 10,
  concentrated_brine: 30,
  he3_dilute: 30,
  mn_nodule: 30,
  re_nodule: 30,
  co_nodule: 30,
  methane_hydrate: 100,
  heavy_isotope_slurry: 100,
  vent_sulfide: 100,
  vent_exotic: 100,
  // Ocean-layer §3 — Task 9 processor outputs.
  //   T3 intermediates (Brine Distillation Rig): weight 30.
  //   T4 intermediates (Nodule Concentrator): weight 100.
  //   T5 finals (Vent Mineral Refinery + Heavy Water Distiller): weight 300
  //     (same tier as casimir_energy / reality_anchor / plasma_charge).
  lithium_brine: 30,
  bromine: 30,
  rare_earth_concentrate: 100,
  refined_cobalt: 100,
  exotic_alloy_seed: 300,
  tritium_seed: 300,
  heavy_water: 300,
  // §04: T1 Skill Crystal. Crafted at T4 Skill Forge using T5 inputs
  // (reality_anchor), so it carries T4 endgame weight (100).
  mining_crystal_t1: 100,
  // Task 6: T2 = 300 (T5-ish), T3 = 1000 (T6-ish).
  mining_crystal_t2: 300,
  mining_crystal_t3: 1000,
  forestry_crystal_t1: 100,
  forestry_crystal_t2: 300,
  forestry_crystal_t3: 1000,
  drilling_crystal_t1: 100,
  drilling_crystal_t2: 300,
  drilling_crystal_t3: 1000,
  robotics_crystal_t1: 100,
  robotics_crystal_t2: 300,
  robotics_crystal_t3: 1000,
  smelting_crystal_t1: 100,
  smelting_crystal_t2: 300,
  smelting_crystal_t3: 1000,
  chemistry_crystal_t1: 100,
  chemistry_crystal_t2: 300,
  chemistry_crystal_t3: 1000,
  electronics_crystal_t1: 100,
  electronics_crystal_t2: 300,
  electronics_crystal_t3: 1000,
  power_systems_crystal_t1: 100,
  power_systems_crystal_t2: 300,
  power_systems_crystal_t3: 1000,
  storage_crystal_t1: 100,
  storage_crystal_t2: 300,
  storage_crystal_t3: 1000,
  transport_crystal_t1: 100,
  transport_crystal_t2: 300,
  transport_crystal_t3: 1000,
  network_crystal_t1: 100,
  network_crystal_t2: 300,
  network_crystal_t3: 1000,
  launch_crystal_t1: 100,
  launch_crystal_t2: 300,
  launch_crystal_t3: 1000,
  communication_crystal_t1: 100,
  communication_crystal_t2: 300,
  communication_crystal_t3: 1000,
  discovery_crystal_t1: 100,
  discovery_crystal_t2: 300,
  discovery_crystal_t3: 1000,
  resilience_crystal_t1: 100,
  resilience_crystal_t2: 300,
  resilience_crystal_t3: 1000,
  patronage_crystal_t1: 100,
  patronage_crystal_t2: 300,
  patronage_crystal_t3: 1000,
  aquaculture_crystal_t1: 100,
  aquaculture_crystal_t2: 300,
  aquaculture_crystal_t3: 1000,
  hydroprocessing_crystal_t1: 100,
  hydroprocessing_crystal_t2: 300,
  hydroprocessing_crystal_t3: 1000,
  submarine_crystal_t1: 100,
  submarine_crystal_t2: 300,
  submarine_crystal_t3: 1000,
  oceanography_crystal_t1: 100,
  oceanography_crystal_t2: 300,
  oceanography_crystal_t3: 1000,
  // Phase 2 — SI-units rework new resources (§08)
  co: 3,
  co2: 3,
  refinery_gas: 3,
  wood_tar: 3,
  water_vapor: 3,
  aviation_kerosene_crude: 3,
  mill_scale: 3,
  calcium_sulfonate: 3,
  air: 0,
  cryo_coolant_vented: 3,
};

export interface ResourceMeta {
  readonly massPerUnitKg: number;
  readonly volumePerUnitL?: number;
  readonly energyPerUnitKWh?: number;
  readonly terminal: 'consumed' | `expansion-hook:${string}` | 'gameplay-sink';
}

export const RESOURCE_META: Readonly<Record<ResourceId, ResourceMeta>> = {
  wood: { massPerUnitKg: 1, terminal: 'consumed' },
  iron_ore: { massPerUnitKg: 1, terminal: 'consumed' },
  coal: { massPerUnitKg: 1, terminal: 'consumed' },
  scrap: { massPerUnitKg: 1, terminal: 'consumed' },
  stone: { massPerUnitKg: 1, terminal: 'consumed' },
  sand: { massPerUnitKg: 1, terminal: 'consumed' },
  fresh_water: { massPerUnitKg: 1, volumePerUnitL: 1, terminal: 'consumed' },
  saltwater: { massPerUnitKg: 1, volumePerUnitL: 1, terminal: 'consumed' },
  salt: { massPerUnitKg: 1, terminal: 'consumed' },
  crude_oil: { massPerUnitKg: 1, volumePerUnitL: 1, terminal: 'consumed' },
  natural_gas: { massPerUnitKg: 1, terminal: 'expansion-hook:ammonia / syngas / gas-turbine power' },
  quartz: { massPerUnitKg: 1, terminal: 'consumed' },
  hydrogen: { massPerUnitKg: 1, terminal: 'consumed' },
  limestone: { massPerUnitKg: 1, terminal: 'consumed' },
  clay: { massPerUnitKg: 1, terminal: 'consumed' },
  sulfur: { massPerUnitKg: 1, terminal: 'consumed' },
  phosphate: { massPerUnitKg: 1, terminal: 'consumed' },
  graphite: { massPerUnitKg: 1, terminal: 'consumed' },
  copper_ore: { massPerUnitKg: 1, terminal: 'consumed' },
  tin_ore: { massPerUnitKg: 1, terminal: 'consumed' },
  lead_ore: { massPerUnitKg: 1, terminal: 'consumed' },
  bauxite: { massPerUnitKg: 1, terminal: 'consumed' },
  manganese_ore: { massPerUnitKg: 1, terminal: 'consumed' },
  manganese_ingot: { massPerUnitKg: 1, terminal: 'consumed' },
  carbon_steel: { massPerUnitKg: 1, terminal: 'consumed' },
  zinc_ore: { massPerUnitKg: 1, terminal: 'consumed' },
  zinc_ingot: { massPerUnitKg: 1, terminal: 'consumed' },
  galvanized_steel: { massPerUnitKg: 1, terminal: 'expansion-hook:Phase 2 supplies consumer' },
  chromium_ore: { massPerUnitKg: 1, terminal: 'consumed' },
  chromium_ingot: { massPerUnitKg: 1, terminal: 'consumed' },
  nickel_ore: { massPerUnitKg: 1, terminal: 'consumed' },
  nickel_ingot: { massPerUnitKg: 1, terminal: 'consumed' },
  stainless_steel: { massPerUnitKg: 1, terminal: 'consumed' },
  tungsten_ore: { massPerUnitKg: 1, terminal: 'consumed' },
  tungsten_ingot: { massPerUnitKg: 1, terminal: 'consumed' },
  tool_steel: { massPerUnitKg: 1, terminal: 'expansion-hook:Phase 2 supplies consumer' },
  quicklime: { massPerUnitKg: 1, terminal: 'consumed' },
  slaked_lime: { massPerUnitKg: 1, terminal: 'expansion-hook:Phase 2 supplies consumer' },
  brick: { massPerUnitKg: 1, terminal: 'consumed' },
  mortar: { massPerUnitKg: 1, terminal: 'expansion-hook:Phase 2 supplies consumer' },
  cement: { massPerUnitKg: 1, terminal: 'consumed' },
  concrete: { massPerUnitKg: 1, terminal: 'consumed' },
  charcoal: { massPerUnitKg: 1, terminal: 'expansion-hook:Phase 2 supplies consumer' },
  plank: { massPerUnitKg: 1, terminal: 'consumed' },
  copper_ingot: { massPerUnitKg: 1, terminal: 'consumed' },
  tin_ingot: { massPerUnitKg: 1, terminal: 'consumed' },
  lead_ingot: { massPerUnitKg: 1, terminal: 'consumed' },
  solder: { massPerUnitKg: 1, terminal: 'consumed' },
  bronze: { massPerUnitKg: 1, terminal: 'expansion-hook:Phase 2 supplies consumer' },
  brass: { massPerUnitKg: 1, terminal: 'expansion-hook:Phase 2 supplies consumer' },
  alumina: { massPerUnitKg: 1, terminal: 'consumed' },
  aluminum: { massPerUnitKg: 1, terminal: 'consumed' },
  oxygen: { massPerUnitKg: 1, terminal: 'consumed' },
  argon: { massPerUnitKg: 1, terminal: 'consumed' },
  slag: { massPerUnitKg: 1, terminal: 'consumed' },
  biofuel: { massPerUnitKg: 1, terminal: 'expansion-hook:Phase 2 supplies consumer' },
  iron_ingot: { massPerUnitKg: 1, terminal: 'consumed' },
  coke: { massPerUnitKg: 1, terminal: 'consumed' },
  pig_iron: { massPerUnitKg: 1, terminal: 'consumed' },
  bolt: { massPerUnitKg: 0.05, terminal: 'consumed' },
  lumber: { massPerUnitKg: 1, terminal: 'consumed' },
  glass: { massPerUnitKg: 1, terminal: 'consumed' },
  steel: { massPerUnitKg: 1, terminal: 'consumed' },
  gear: { massPerUnitKg: 2, terminal: 'consumed' },
  foundation_kit: { massPerUnitKg: 100, terminal: 'consumed' },
  foundation_kit_enriched: { massPerUnitKg: 300, terminal: 'consumed' },
  foundation_kit_refined: { massPerUnitKg: 800, terminal: 'consumed' },
  naphtha: { massPerUnitKg: 1, volumePerUnitL: 1, terminal: 'consumed' },
  chlorine: { massPerUnitKg: 1, volumePerUnitL: 1, terminal: 'consumed' },
  lubricant: { massPerUnitKg: 1, volumePerUnitL: 1, terminal: 'consumed' },
  diesel: { massPerUnitKg: 1, volumePerUnitL: 1, terminal: 'consumed' },
  wire: { massPerUnitKg: 0.5, terminal: 'consumed' },
  saltwater_cell: { massPerUnitKg: 2.5, energyPerUnitKWh: 0.5, terminal: 'expansion-hook:Phase 2 supplies consumer' },
  heavy_oil: { massPerUnitKg: 1, volumePerUnitL: 1, terminal: 'expansion-hook:Phase 2 supplies consumer' },
  tar: { massPerUnitKg: 1, volumePerUnitL: 1, terminal: 'expansion-hook:Phase 2 supplies consumer' },
  asphalt: { massPerUnitKg: 1, terminal: 'expansion-hook:Phase 2 supplies consumer' },
  plastic_precursor: { massPerUnitKg: 1, volumePerUnitL: 1, terminal: 'consumed' },
  rigid_plastic: { massPerUnitKg: 1, terminal: 'consumed' },
  flexible_plastic: { massPerUnitKg: 1, terminal: 'consumed' },
  synthetic_rubber: { massPerUnitKg: 1, terminal: 'expansion-hook:Phase 2 supplies consumer' },
  sheet_metal: { massPerUnitKg: 5, terminal: 'expansion-hook:Phase 2 supplies consumer' },
  pipe: { massPerUnitKg: 4, terminal: 'consumed' },
  steel_beam: { massPerUnitKg: 50, terminal: 'consumed' },
  bearing: { massPerUnitKg: 0.3, terminal: 'consumed' },
  spring: { massPerUnitKg: 0.2, terminal: 'consumed' },
  heavy_cable: { massPerUnitKg: 8, terminal: 'expansion-hook:Phase 2 supplies consumer' },
  battery: { massPerUnitKg: 5, energyPerUnitKWh: 1, terminal: 'consumed' },
  glass_panel: { massPerUnitKg: 3, terminal: 'expansion-hook:Phase 2 supplies consumer' },
  coolant: { massPerUnitKg: 1, terminal: 'consumed' },
  ceramic_insulator: { massPerUnitKg: 1, terminal: 'expansion-hook:Phase 2 supplies consumer' },
  sulfuric_acid: { massPerUnitKg: 1.84, volumePerUnitL: 1, terminal: 'consumed' },
  hydrochloric_acid: { massPerUnitKg: 1.19, volumePerUnitL: 1, terminal: 'expansion-hook:Phase 2 supplies consumer' },
  sodium_hydroxide: { massPerUnitKg: 1, volumePerUnitL: 1, terminal: 'consumed' },
  phosphor: { massPerUnitKg: 1, terminal: 'expansion-hook:Phase 2 supplies consumer' },
  liquid_nitrogen: { massPerUnitKg: 1, volumePerUnitL: 1, terminal: 'consumed' },
  silicon: { massPerUnitKg: 1, terminal: 'consumed' },
  silicon_wafer: { massPerUnitKg: 0.13, terminal: 'consumed' },
  transistor: { massPerUnitKg: 0.001, terminal: 'consumed' },
  capacitor: { massPerUnitKg: 0.005, energyPerUnitKWh: 0.1, terminal: 'consumed' },
  resistor: { massPerUnitKg: 0.001, terminal: 'consumed' },
  memory_module: { massPerUnitKg: 0.05, terminal: 'expansion-hook:Phase 2 supplies consumer' },
  nitrogen: { massPerUnitKg: 1, terminal: 'consumed' },
  cryo_coolant: { massPerUnitKg: 1, volumePerUnitL: 1, terminal: 'consumed' },
  aviation_kerosene: { massPerUnitKg: 1, volumePerUnitL: 1, terminal: 'expansion-hook:Phase 2 supplies consumer' },
  microchip: { massPerUnitKg: 0.1, terminal: 'consumed' },
  gold_ore: { massPerUnitKg: 1, terminal: 'expansion-hook:Phase 2 supplies consumer' },
  silver_ore: { massPerUnitKg: 1, terminal: 'expansion-hook:Phase 2 supplies consumer' },
  rare_earth: { massPerUnitKg: 1, terminal: 'consumed' },
  uranium_ore: { massPerUnitKg: 1, terminal: 'consumed' },
  memetic_core: { massPerUnitKg: 1, terminal: 'consumed' },
  helium_3: { massPerUnitKg: 0.001, terminal: 'consumed' },
  cryogenic_hydrogen: { massPerUnitKg: 1, volumePerUnitL: 1, terminal: 'consumed' },
  quantum_chip: { massPerUnitKg: 1, terminal: 'consumed' },
  exotic_alloy: { massPerUnitKg: 1, terminal: 'consumed' },
  ai_core: { massPerUnitKg: 1, terminal: 'consumed' },
  carbon_fiber: { massPerUnitKg: 1, terminal: 'consumed' },
  casimir_energy: { massPerUnitKg: 0, energyPerUnitKWh: 1, terminal: 'consumed' },
  reality_anchor: { massPerUnitKg: 1, terminal: 'consumed' },
  plasma_charge: { massPerUnitKg: 1, energyPerUnitKWh: 10, terminal: 'expansion-hook:Phase 2 supplies consumer' },
  eldritch_processor: { massPerUnitKg: 1, terminal: 'consumed' },
  phase_converter: { massPerUnitKg: 1, terminal: 'consumed' },
  aetheric_current: { massPerUnitKg: 1, terminal: 'consumed' },
  tachyon_stream: { massPerUnitKg: 1, terminal: 'consumed' },
  dark_matter: { massPerUnitKg: 1, terminal: 'consumed' },
  strange_matter: { massPerUnitKg: 1, terminal: 'consumed' },
  quantum_foam: { massPerUnitKg: 1, terminal: 'expansion-hook:Phase 2 supplies consumer' },
  spacetime_fragment: { massPerUnitKg: 1, terminal: 'consumed' },
  higgs_flux: { massPerUnitKg: 1, terminal: 'expansion-hook:Phase 2 supplies consumer' },
  zero_point_flux: { massPerUnitKg: 1, terminal: 'consumed' },
  neutronium: { massPerUnitKg: 1, terminal: 'expansion-hook:Phase 2 supplies consumer' },
  probability_calculator: { massPerUnitKg: 1, terminal: 'expansion-hook:Phase 2 supplies consumer' },
  dimensional_fold: { massPerUnitKg: 1, terminal: 'consumed' },
  causal_regulator: { massPerUnitKg: 1, terminal: 'consumed' },
  tachyonic_transmitter: { massPerUnitKg: 1, terminal: 'consumed' },
  aether_beacon: { massPerUnitKg: 1, terminal: 'expansion-hook:Phase 2 supplies consumer' },
  reality_engine: { massPerUnitKg: 1, terminal: 'expansion-hook:Phase 2 supplies consumer' },
  singularity_battery_unit: { massPerUnitKg: 1, terminal: 'expansion-hook:Phase 2 supplies consumer' },
  ascendant_core: { massPerUnitKg: 1, terminal: 'gameplay-sink' },
  antimatter_propellant: { massPerUnitKg: 1e-12, terminal: 'expansion-hook:Phase 2 supplies consumer' },
  scanner_sat: { massPerUnitKg: 500, terminal: 'gameplay-sink' },
  relay_sat: { massPerUnitKg: 500, terminal: 'gameplay-sink' },
  orbital_insertion_package: { massPerUnitKg: 500, terminal: 'consumed' },
  sweeper_sat: { massPerUnitKg: 500, terminal: 'gameplay-sink' },
  mirror_sat: { massPerUnitKg: 500, terminal: 'gameplay-sink' },
  repair_drone: { massPerUnitKg: 200, terminal: 'gameplay-sink' },
  repair_pack: { massPerUnitKg: 1, terminal: 'consumed' },
  pcb: { massPerUnitKg: 0.2, terminal: 'consumed' },
  circuit_board: { massPerUnitKg: 0.5, terminal: 'consumed' },
  processor: { massPerUnitKg: 0.1, terminal: 'consumed' },
  computing_module: { massPerUnitKg: 1, terminal: 'consumed' },
  genesis_cell: { massPerUnitKg: 1, terminal: 'gameplay-sink' },
  time_crystal: { massPerUnitKg: 1, terminal: 'consumed' },
  antimatter_capsule: { massPerUnitKg: 1e-12, terminal: 'consumed' },
  nuclear_fuel_rod: { massPerUnitKg: 1, energyPerUnitKWh: 1000, terminal: 'consumed' },
  plasma_containment_vessel: { massPerUnitKg: 1, terminal: 'consumed' },
  singularity_sensor: { massPerUnitKg: 1, terminal: 'expansion-hook:Phase 2 supplies consumer' },
  cryo_containment_unit: { massPerUnitKg: 1, terminal: 'expansion-hook:Phase 2 supplies consumer' },
  particle_accelerator_core: { massPerUnitKg: 1, terminal: 'expansion-hook:Phase 2 supplies consumer' },
  self_replication_module: { massPerUnitKg: 1, terminal: 'expansion-hook:Phase 2 supplies consumer' },
  mercury: { massPerUnitKg: 1, terminal: 'expansion-hook:amalgamation chemistry / chlor-alkali Hg-cell variant' },
  diamond_ore: { massPerUnitKg: 1, terminal: 'consumed' },
  cryogenic_compound: { massPerUnitKg: 1, terminal: 'consumed' },
  magnetic_alloy: { massPerUnitKg: 1, terminal: 'consumed' },
  lithium: { massPerUnitKg: 1, terminal: 'consumed' },
  magnet: { massPerUnitKg: 50, terminal: 'consumed' },
  electric_motor: { massPerUnitKg: 10, terminal: 'consumed' },
  generator: { massPerUnitKg: 50, terminal: 'expansion-hook:Phase 2 supplies consumer' },
  pump: { massPerUnitKg: 8, terminal: 'expansion-hook:Phase 2 supplies consumer' },
  hydraulic_actuator: { massPerUnitKg: 15, terminal: 'expansion-hook:Phase 2 supplies consumer' },
  pneumatic_actuator: { massPerUnitKg: 10, terminal: 'expansion-hook:Phase 2 supplies consumer' },
  solar_cell: { massPerUnitKg: 0.5, terminal: 'expansion-hook:Phase 2 supplies consumer' },
  fuel_cell: { massPerUnitKg: 5, terminal: 'consumed' },
  optical_glass: { massPerUnitKg: 1, terminal: 'consumed' },
  glass_fiber: { massPerUnitKg: 1, terminal: 'consumed' },
  optical_fiber: { massPerUnitKg: 1, terminal: 'consumed' },
  dilute_brine: { massPerUnitKg: 1, volumePerUnitL: 1, terminal: 'consumed' },
  concentrated_brine: { massPerUnitKg: 1, volumePerUnitL: 1, terminal: 'consumed' },
  he3_dilute: { massPerUnitKg: 1, volumePerUnitL: 1, terminal: 'expansion-hook:Phase 2 supplies consumer' },
  mn_nodule: { massPerUnitKg: 1, terminal: 'expansion-hook:Phase 2 supplies consumer' },
  re_nodule: { massPerUnitKg: 1, terminal: 'consumed' },
  co_nodule: { massPerUnitKg: 1, terminal: 'consumed' },
  methane_hydrate: { massPerUnitKg: 1, volumePerUnitL: 1, terminal: 'expansion-hook:Phase 2 supplies consumer' },
  heavy_isotope_slurry: { massPerUnitKg: 1, volumePerUnitL: 1, terminal: 'consumed' },
  vent_sulfide: { massPerUnitKg: 1, volumePerUnitL: 1, terminal: 'expansion-hook:Phase 2 supplies consumer' },
  vent_exotic: { massPerUnitKg: 1, terminal: 'consumed' },
  lithium_brine: { massPerUnitKg: 1, volumePerUnitL: 1, terminal: 'expansion-hook:Phase 2 supplies consumer' },
  bromine: { massPerUnitKg: 1, volumePerUnitL: 1, terminal: 'expansion-hook:Phase 2 supplies consumer' },
  rare_earth_concentrate: { massPerUnitKg: 1, terminal: 'expansion-hook:Phase 2 supplies consumer' },
  refined_cobalt: { massPerUnitKg: 1, terminal: 'expansion-hook:Phase 2 supplies consumer' },
  exotic_alloy_seed: { massPerUnitKg: 1, terminal: 'consumed' },
  tritium_seed: { massPerUnitKg: 1, terminal: 'expansion-hook:Phase 2 supplies consumer' },
  heavy_water: { massPerUnitKg: 1, volumePerUnitL: 1, terminal: 'consumed' },
  mining_crystal_t1: { massPerUnitKg: 1, terminal: 'gameplay-sink' },
  mining_crystal_t2: { massPerUnitKg: 1, terminal: 'gameplay-sink' },
  mining_crystal_t3: { massPerUnitKg: 1, terminal: 'gameplay-sink' },
  forestry_crystal_t1: { massPerUnitKg: 1, terminal: 'gameplay-sink' },
  forestry_crystal_t2: { massPerUnitKg: 1, terminal: 'gameplay-sink' },
  forestry_crystal_t3: { massPerUnitKg: 1, terminal: 'gameplay-sink' },
  drilling_crystal_t1: { massPerUnitKg: 1, terminal: 'gameplay-sink' },
  drilling_crystal_t2: { massPerUnitKg: 1, terminal: 'gameplay-sink' },
  drilling_crystal_t3: { massPerUnitKg: 1, terminal: 'gameplay-sink' },
  robotics_crystal_t1: { massPerUnitKg: 1, terminal: 'gameplay-sink' },
  robotics_crystal_t2: { massPerUnitKg: 1, terminal: 'gameplay-sink' },
  robotics_crystal_t3: { massPerUnitKg: 1, terminal: 'gameplay-sink' },
  smelting_crystal_t1: { massPerUnitKg: 1, terminal: 'gameplay-sink' },
  smelting_crystal_t2: { massPerUnitKg: 1, terminal: 'gameplay-sink' },
  smelting_crystal_t3: { massPerUnitKg: 1, terminal: 'gameplay-sink' },
  chemistry_crystal_t1: { massPerUnitKg: 1, terminal: 'gameplay-sink' },
  chemistry_crystal_t2: { massPerUnitKg: 1, terminal: 'gameplay-sink' },
  chemistry_crystal_t3: { massPerUnitKg: 1, terminal: 'gameplay-sink' },
  electronics_crystal_t1: { massPerUnitKg: 1, terminal: 'gameplay-sink' },
  electronics_crystal_t2: { massPerUnitKg: 1, terminal: 'gameplay-sink' },
  electronics_crystal_t3: { massPerUnitKg: 1, terminal: 'gameplay-sink' },
  power_systems_crystal_t1: { massPerUnitKg: 1, terminal: 'gameplay-sink' },
  power_systems_crystal_t2: { massPerUnitKg: 1, terminal: 'gameplay-sink' },
  power_systems_crystal_t3: { massPerUnitKg: 1, terminal: 'gameplay-sink' },
  storage_crystal_t1: { massPerUnitKg: 1, terminal: 'gameplay-sink' },
  storage_crystal_t2: { massPerUnitKg: 1, terminal: 'gameplay-sink' },
  storage_crystal_t3: { massPerUnitKg: 1, terminal: 'gameplay-sink' },
  transport_crystal_t1: { massPerUnitKg: 1, terminal: 'gameplay-sink' },
  transport_crystal_t2: { massPerUnitKg: 1, terminal: 'gameplay-sink' },
  transport_crystal_t3: { massPerUnitKg: 1, terminal: 'gameplay-sink' },
  network_crystal_t1: { massPerUnitKg: 1, terminal: 'gameplay-sink' },
  network_crystal_t2: { massPerUnitKg: 1, terminal: 'gameplay-sink' },
  network_crystal_t3: { massPerUnitKg: 1, terminal: 'gameplay-sink' },
  launch_crystal_t1: { massPerUnitKg: 1, terminal: 'gameplay-sink' },
  launch_crystal_t2: { massPerUnitKg: 1, terminal: 'gameplay-sink' },
  launch_crystal_t3: { massPerUnitKg: 1, terminal: 'gameplay-sink' },
  communication_crystal_t1: { massPerUnitKg: 1, terminal: 'gameplay-sink' },
  communication_crystal_t2: { massPerUnitKg: 1, terminal: 'gameplay-sink' },
  communication_crystal_t3: { massPerUnitKg: 1, terminal: 'gameplay-sink' },
  discovery_crystal_t1: { massPerUnitKg: 1, terminal: 'gameplay-sink' },
  discovery_crystal_t2: { massPerUnitKg: 1, terminal: 'gameplay-sink' },
  discovery_crystal_t3: { massPerUnitKg: 1, terminal: 'gameplay-sink' },
  resilience_crystal_t1: { massPerUnitKg: 1, terminal: 'gameplay-sink' },
  resilience_crystal_t2: { massPerUnitKg: 1, terminal: 'gameplay-sink' },
  resilience_crystal_t3: { massPerUnitKg: 1, terminal: 'gameplay-sink' },
  patronage_crystal_t1: { massPerUnitKg: 1, terminal: 'gameplay-sink' },
  patronage_crystal_t2: { massPerUnitKg: 1, terminal: 'gameplay-sink' },
  patronage_crystal_t3: { massPerUnitKg: 1, terminal: 'gameplay-sink' },
  aquaculture_crystal_t1: { massPerUnitKg: 1, terminal: 'gameplay-sink' },
  aquaculture_crystal_t2: { massPerUnitKg: 1, terminal: 'gameplay-sink' },
  aquaculture_crystal_t3: { massPerUnitKg: 1, terminal: 'gameplay-sink' },
  hydroprocessing_crystal_t1: { massPerUnitKg: 1, terminal: 'gameplay-sink' },
  hydroprocessing_crystal_t2: { massPerUnitKg: 1, terminal: 'gameplay-sink' },
  hydroprocessing_crystal_t3: { massPerUnitKg: 1, terminal: 'gameplay-sink' },
  submarine_crystal_t1: { massPerUnitKg: 1, terminal: 'gameplay-sink' },
  submarine_crystal_t2: { massPerUnitKg: 1, terminal: 'gameplay-sink' },
  submarine_crystal_t3: { massPerUnitKg: 1, terminal: 'gameplay-sink' },
  oceanography_crystal_t1: { massPerUnitKg: 1, terminal: 'gameplay-sink' },
  oceanography_crystal_t2: { massPerUnitKg: 1, terminal: 'gameplay-sink' },
  oceanography_crystal_t3: { massPerUnitKg: 1, terminal: 'gameplay-sink' },
  // Phase 2 — SI-units rework new resources (§08)
  co: { massPerUnitKg: 1, terminal: 'expansion-hook:CO afterburn / oxidation chain' },
  co2: { massPerUnitKg: 1, terminal: 'expansion-hook:weather penalty + sequestration (Phase 6)' },
  refinery_gas: { massPerUnitKg: 1, terminal: 'expansion-hook:residential heating / petrochem feedstock' },
  wood_tar: { massPerUnitKg: 1, terminal: 'expansion-hook:creosote / wood-preservative chain' },
  water_vapor: { massPerUnitKg: 1, terminal: 'expansion-hook:condensing-loop / humidity / fresh-water reclamation' },
  aviation_kerosene_crude: { massPerUnitKg: 1, terminal: 'expansion-hook:Phase 2 supplies consumer' },
  mill_scale: { massPerUnitKg: 1, terminal: 'expansion-hook:scrap remelt / cement kiln aggregate / brick pigment' },
  calcium_sulfonate: { massPerUnitKg: 1, terminal: 'consumed' },
  air: { massPerUnitKg: 1, terminal: 'expansion-hook:Phase 2 supplies consumer' },
  cryo_coolant_vented: { massPerUnitKg: 1, terminal: 'expansion-hook:re-liquefaction loop / closed-cycle recovery' },
};

export const RECIPE_SPECULATIVE: Readonly<Partial<Record<RecipeId, 'fantasy chemistry' | 'narrative cost' | true>>> = {
  pyroforge: 'fantasy chemistry',
  cryogenic_compute_center: 'fantasy chemistry',
  carbon_forge: 'fantasy chemistry',
  reality_forge: 'fantasy chemistry',
  antimatter_refinery: 'fantasy chemistry',
  casimir_tap: 'fantasy chemistry',
  zero_point_extractor: 'fantasy chemistry',
  neutronium_extractor: 'fantasy chemistry',
  memetic_forge: 'fantasy chemistry',
  quantum_manipulator: 'fantasy chemistry',
  eldritch_refiner: 'fantasy chemistry',
  phase_refiner: 'fantasy chemistry',
  aetheric_conduit: 'fantasy chemistry',
  spacetime_resonator: 'fantasy chemistry',
  eldritch_sieve: 'fantasy chemistry',
  plasma_forge: 'fantasy chemistry',
  genesis_forge: 'fantasy chemistry',
  ascendant_assembly: 'fantasy chemistry',
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
  | 'logistics'
  | 'environment';

/** All recipe categories, useful for initialising per-category records to 1.0. */
export const ALL_RECIPE_CATEGORIES: ReadonlyArray<RecipeCategory> = [
  'extraction',
  'smelting',
  'chemistry',
  'manufacturing',
  'electronics',
  'power',
  'logistics',
  'environment',
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
  /** Per Phase 2 spec §9. Names a legitimate mass-balance violation that
   *  the mass-balance auditor must skip. Recognized values:
   *  'fuel-combustion-CO₂', 'atmosphere', 'BF-top-gas-trace',
   *  'electrode-graphite-consumed', 'evaporation-water-vapor',
   *  'hydrocracker-light-ends-vented', 'hydrotreatment-H2S-and-light-gas',
   *  'process-losses + HCl', 'saltwater_cell-encapsulates-electrolyte'. */
  readonly exogenousFlow?: string;
  /** Magnitude of the exogenous flow in kg per cycle. REQUIRED when
   *  exogenousFlow === 'fuel-combustion-CO₂' (consumed by the Phase 8 CO₂
   *  accrual hook). Optional otherwise. */
  readonly exogenousFlowKg?: number;
  /** Marks a recipe as biogenic-CO₂ (charcoal_kiln, biomass_plant). Phase 6
   *  weather coupling reads this for a forest-regrowth net-zero offset. */
  readonly biogenic?: true;
  readonly category: RecipeCategory;
  /** If set, outputs cycle through these options deterministically per §8.10. */
  readonly rotateOutputs?: ReadonlyArray<Partial<Record<ResourceId, number>>>;
}

/**
 * A recipe id. Most ids match a `BuildingDefId` 1:1 — the recipe table is
 * keyed by the building that runs it. A few synthetic ids cover variant
 * recipes for a single building kind, selected at runtime by
 * `resolveRecipe`:
 *
 *   - `mine_on_ore`  — Mine on an ore-vein footprint  → iron_ore
 *   - `mine_on_coal` — Mine on a coal-vein footprint → coal
 *   - `steel_mill_from_scrap` — Steel Mill running the §6.7 substitution:
 *                               2 scrap → 1 steel + 1 slag (same 600s cycle
 *                               as the base recipe so output rate is
 *                               preserved). Resolver picks this variant
 *                               when the island has no pig_iron stockpile
 *                               but does have scrap on hand. Inputs are
 *                               NOT mixed within a cycle; the building
 *                               runs one variant or the other per tick
 *                               and the piecewise integrator re-resolves
 *                               at each event (e.g. pig_iron depletion).
 *   - `nodule_concentrator_re` / `nodule_concentrator_co` — Nodule
 *                               Concentrator per-output variants. The §3
 *                               chain examples list distinct feedstocks
 *                               for rare_earth_concentrate (re_nodule +
 *                               sulfuric_acid) vs refined_cobalt
 *                               (co_nodule + sulfuric_acid). Each variant
 *                               burns ONE nodule type per cycle, restoring
 *                               the spec-aligned 1:1 feedstock cost
 *                               (the original combined-inputs recipe burnt
 *                               both nodule types each cycle for one output).
 *                               Resolver routes by inventory presence:
 *                               re_nodule on hand → _re variant; else
 *                               co_nodule on hand → _co variant; else
 *                               fall back to _re so the bottleneck surfaces
 *                               in `inputAvail` (mirrors steel_mill).
 *   - `vent_mineral_refinery_exotic` / `vent_mineral_refinery_tritium` —
 *                               Vent Mineral Refinery per-output variants.
 *                               _exotic: vent_exotic + casimir_energy →
 *                               exotic_alloy_seed. _tritium:
 *                               heavy_isotope_slurry + casimir_energy →
 *                               tritium_seed. Same per-cycle isolation as
 *                               the nodule_concentrator variants — fixes
 *                               the original combined-inputs recipe that
 *                               burnt vent_exotic + heavy_isotope_slurry
 *                               + casimir_energy each cycle for one
 *                               rotation output (3× the spec feedstock
 *                               cost). Resolver routes by inventory.
 *
 * The legacy `mine` entry stays as a fallback recipe (= same as
 * `mine_on_ore`) so callers that don't pass a terrain closure into
 * `resolveRecipe` keep the pre-tile-aware behaviour.
 */
export type RecipeId =
  | BuildingDefId
  | 'mine_on_ore'
  | 'mine_on_coal'
  | 'steel_mill_from_scrap'
  | 'nodule_concentrator_re'
  | 'nodule_concentrator_co'
  | 'vent_mineral_refinery_exotic'
  | 'vent_mineral_refinery_tritium'
  | 'sheet_mill'
  // Task 6: synthetic recipe ids for Skill Forge crystal variants.
  | 'skill_forge_mining_t2'
  | 'skill_forge_mining_t3'
  | 'skill_forge_forestry_t1'
  | 'skill_forge_forestry_t2'
  | 'skill_forge_forestry_t3'
  | 'skill_forge_drilling_t1'
  | 'skill_forge_drilling_t2'
  | 'skill_forge_drilling_t3'
  | 'skill_forge_robotics_t1'
  | 'skill_forge_robotics_t2'
  | 'skill_forge_robotics_t3'
  | 'skill_forge_smelting_t1'
  | 'skill_forge_smelting_t2'
  | 'skill_forge_smelting_t3'
  | 'skill_forge_chemistry_t1'
  | 'skill_forge_chemistry_t2'
  | 'skill_forge_chemistry_t3'
  | 'skill_forge_electronics_t1'
  | 'skill_forge_electronics_t2'
  | 'skill_forge_electronics_t3'
  | 'skill_forge_power_systems_t1'
  | 'skill_forge_power_systems_t2'
  | 'skill_forge_power_systems_t3'
  | 'skill_forge_storage_t1'
  | 'skill_forge_storage_t2'
  | 'skill_forge_storage_t3'
  | 'skill_forge_transport_t1'
  | 'skill_forge_transport_t2'
  | 'skill_forge_transport_t3'
  | 'skill_forge_network_t1'
  | 'skill_forge_network_t2'
  | 'skill_forge_network_t3'
  | 'skill_forge_launch_t1'
  | 'skill_forge_launch_t2'
  | 'skill_forge_launch_t3'
  | 'skill_forge_communication_t1'
  | 'skill_forge_communication_t2'
  | 'skill_forge_communication_t3'
  | 'skill_forge_discovery_t1'
  | 'skill_forge_discovery_t2'
  | 'skill_forge_discovery_t3'
  | 'skill_forge_resilience_t1'
  | 'skill_forge_resilience_t2'
  | 'skill_forge_resilience_t3'
  | 'skill_forge_patronage_t1'
  | 'skill_forge_patronage_t2'
  | 'skill_forge_patronage_t3'
  | 'skill_forge_aquaculture_t1'
  | 'skill_forge_aquaculture_t2'
  | 'skill_forge_aquaculture_t3'
  | 'skill_forge_hydroprocessing_t1'
  | 'skill_forge_hydroprocessing_t2'
  | 'skill_forge_hydroprocessing_t3'
  | 'skill_forge_submarine_t1'
  | 'skill_forge_submarine_t2'
  | 'skill_forge_submarine_t3'
  | 'skill_forge_oceanography_t1'
  | 'skill_forge_oceanography_t2'
  | 'skill_forge_oceanography_t3';

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
 *                        §6.7 substitution: when an island has no pig_iron
 *                        stockpile but has scrap, `resolveRecipe` switches
 *                        the building to the synthetic `steel_mill_from_scrap`
 *                        recipe (2 scrap → 1 steel + 1 slag, same cycleSec).
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
    cycleSec: 20, // auto-derived (gen-cyclesec): density × footprint × M
    inputs: {},
    outputs: { iron_ore: 1 },
    exogenousFlow: 'terrain',
    category: 'extraction',
  },
  // §8.1 Mine variants — tile-dependent recipe selection. The two entries
  // differ only in output: ore-vein footprint → iron_ore; coal-vein
  // footprint → coal. Inputs/cycleSec/category identical so a build-order
  // change in placement doesn't shift any other downstream rate.
  mine_on_ore: {
    cycleSec: 20, // auto-derived (gen-cyclesec): density × footprint × M
    inputs: {},
    outputs: { iron_ore: 1 },
    exogenousFlow: 'terrain',
    category: 'extraction',
  },
  mine_on_coal: {
    cycleSec: 20, // auto-derived (gen-cyclesec): density × footprint × M
    inputs: {},
    outputs: { coal: 1 },
    exogenousFlow: 'terrain',
    category: 'extraction',
  },
  logger: {
    cycleSec: 1404.1, // auto-derived (gen-cyclesec): density × footprint × M
    inputs: {},
    outputs: { wood: 1 },
    exogenousFlow: 'terrain',
    category: 'extraction',
  },
  // §8.1 T2 Heavy Logger: 3× wood throughput vs T1 Logger.
  heavy_logger: {
    cycleSec: 351, // auto-derived (gen-cyclesec): density × footprint × M
    inputs: {},
    outputs: { wood: 1 },
    exogenousFlow: 'terrain',
    category: 'extraction',
  },
  // §8.1 T2 Deep Mine: 3× ore throughput vs T1 Mine. Output is iron_ore
  // (the only ore vein the live game currently surfaces; deeper-vein
  // variants like copper / nickel land alongside their resource catalog
  // additions).
  deep_mine: {
    cycleSec: 13.3, // auto-derived (gen-cyclesec): density × footprint × M
    inputs: {},
    outputs: { iron_ore: 1 },
    exogenousFlow: 'terrain',
    category: 'extraction',
  },

  // T1 smelting — rebalanced for idle-game scale, step #19 (×10)
  smelter: {
    cycleSec: 2981.3, // auto-derived (gen-cyclesec): density × footprint × M
    inputs: { iron_ore: 10, coal: 3 },
    outputs: { iron_ingot: 6, slag: 2, co: 5 },
    category: 'smelting',
  },

  // T1 manufacturing — rebalanced for idle-game scale, step #19 (×10)
  workshop: {
    cycleSec: 4300, // auto-derived (gen-cyclesec): density × footprint × M
    inputs: { iron_ore: 1, coal: 1 },
    outputs: { bolt: 1 },
    category: 'manufacturing',
  },
  // §15.6 saltwater-cell bootstrap — T1 manufacturing recipe. 40s cycle,
  // home-Plains-only inputs so battery_bank no longer chains through the
  // T3 lithium gate. Wire is the T2-chokepoint bottleneck per spec §05.
  cell_press: {
    cycleSec: 537495.7, // auto-derived (gen-cyclesec): density × footprint × M
    inputs: { saltwater: 1, iron_ingot: 1, wire: 1 },
    outputs: { saltwater_cell: 1 },
    category: 'manufacturing',
  },

  // T1 power-burn: kept at short cycles so power keeps up with consumers
  // (per rebalance spec step #19 — power buildings stay at original scale).
  coal_gen: {
    cycleSec: 2,
    inputs: { coal: 1 },
    outputs: {},
    exogenousFlow: 'fuel-combustion-CO₂',
    exogenousFlowKg: 2.42,
    category: 'power',
  },
  biomass_plant: {
    cycleSec: 2,
    inputs: { wood: 1 },
    outputs: {},
    exogenousFlow: 'fuel-combustion-energy',
    category: 'power',
  },
  // §8.5 T2 power: Cryogenic Generator burns cryo_coolant as fuel.
  cryogenic_generator: {
    cycleSec: 20,
    inputs: { cryo_coolant: 1, fresh_water: 1 },
    outputs: { cryo_coolant_vented: 0.7, nitrogen: 0.3 },
    exogenousFlow: 'fuel-combustion-energy',
    category: 'power',
  },
  // §8.5 T3 power: Nuclear Reactor burns nuclear_fuel_rod (T4 endgame
  // fuel, §6.5). Cycle bumped to 600s to reflect slow fuel-rod burn.
  nuclear_reactor: {
    cycleSec: 200,
    inputs: { nuclear_fuel_rod: 1 },
    outputs: {},
    exogenousFlow: 'fuel-combustion-energy',
    category: 'power',
  },

  // T2 smelting — rebalanced for idle-game scale, step #19 (×40)
  coke_oven: {
    cycleSec: 214998.3, // auto-derived (gen-cyclesec): density × footprint × M
    inputs: { coal: 10 },
    outputs: { coke: 7, wood_tar: 0.4, hydrogen: 0.5, co2: 1, refinery_gas: 1.1 },
    category: 'smelting',
  },
  blast_furnace: {
    cycleSec: 6217.4, // auto-derived (gen-cyclesec): density × footprint × M
    inputs: { iron_ore: 35, coke: 18, limestone: 10 },
    outputs: { pig_iron: 20, slag: 6, co2: 35 },
    category: 'smelting',
    exogenousFlow: 'BF-top-gas-trace',
    exogenousFlowKg: 0,
  },
  steel_mill: {
    cycleSec: 4222.6, // auto-derived (gen-cyclesec): density × footprint × M
    inputs: { pig_iron: 100, quicklime: 7, oxygen: 9 },
    outputs: { steel: 85, slag: 23, co: 7, co2: 1 },
    category: 'smelting',
  },
  // §6.7 Steel Mill scrap-substitution variant. Same cycleSec + outputs as
  // the base `steel_mill` recipe (spec literal: "produces the same output
  // rate either way"); the only difference is the input — 2 scrap per cycle
  // replacing 1 pig iron at the spec's 2:1 ratio. Synthetic recipe id (no
  // matching BuildingDefId) selected at runtime by `resolveRecipe` when the
  // base Steel Mill building has scrap on hand but no pig_iron stockpile.
  steel_mill_from_scrap: {
    cycleSec: 72.8, // auto-derived (gen-cyclesec): density × footprint × M
    inputs: { scrap: 2 },
    outputs: { steel: 1, slag: 1 },
    category: 'smelting',
  },
  // §6.7: Steel Mill Scrap — alternate T2 recipe using 2 scrap → 1 steel + 1 slag.
  steel_mill_scrap: {
    cycleSec: 72.8, // auto-derived (gen-cyclesec): density × footprint × M
    inputs: { scrap: 2 },
    outputs: { steel: 1, slag: 1 },
    category: 'smelting',
  },
  // T3 smelting — Oxygen Converter (§6.7). Higher-throughput steel
  // from pig iron + scrap + oxygen. Scrap substitution: 2 Scrap = 1 Pig
  // iron's worth of steel input (per §6.7 Steel-recipe substitution).
  // §5.2 heat-source adjacency required.
  oxygen_converter: {
    // rebalanced step-19 idle-game scale (missed in original sweep)
    cycleSec: 163.8, // auto-derived (gen-cyclesec): density × footprint × M
    inputs: { pig_iron: 1, scrap: 1, oxygen: 2 },
    outputs: { steel: 2 },
    category: 'smelting',
  },
  // §6.7 Slag reprocessing — T2 smelting-byproduct refiner.
  slag_reprocessor: {
    cycleSec: 8322.5, // auto-derived (gen-cyclesec): density × footprint × M
    inputs: { slag: 10 },  // batch input keeps the yield low
    outputs: { gold_ore: 1, silver_ore: 1, rare_earth: 1 },
    category: 'smelting',
    // §6.7 "trace minerals at low yield": 10 slag in, one of each trace
    // mineral out. Tune yields in Appendix A balance pass; this matches
    // the spec's "low yield" qualifier (1/30 = 3.3% per slag unit).
  },

  // T2 manufacturing — rebalanced for idle-game scale, step #19 (×40)
  assembler: {
    cycleSec: 573.3, // auto-derived (gen-cyclesec): density × footprint × M
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
    cycleSec: 28666.4, // auto-derived (gen-cyclesec): density × footprint × M
    inputs: { iron_ingot: 5, wood: 10, bolt: 5 },
    outputs: { foundation_kit: 1 },
    category: 'manufacturing',
  },

  // T3 smelting (higher-throughput steel alternative) — rebalanced for idle-game scale, step #19 (×20)
  electric_arc_furnace: {
    cycleSec: 8908.6, // auto-derived (gen-cyclesec): density × footprint × M
    inputs: { scrap: 100, quicklime: 3 },
    outputs: { steel: 95, slag: 5, co2: 1 },
    category: 'smelting',
    exogenousFlow: 'electrode-graphite-consumed',
    exogenousFlowKg: 0,
  },

  // T4 endgame chain (§6.5 / §7.11 / §8.2 / §9.5)
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
    cycleSec: 600, // rebalanced for idle-game scale, step #19 (×60: was 30s); 2026-05-18 ÷3 for display visibility (was 1800s)
    inputs: { helium_3: 1 },
    outputs: {},
    exogenousFlow: 'fuel-combustion-energy',
    category: 'power',
  },

  // T4 biome-locked smelting — Volcanic-only Pyroforge produces Exotic Alloy
  // from Steel + Helium-3 fuel. Per §9.5, only producer of Exotic Alloy in
  // the world. §5.2 heat-source adjacency required (see heat.ts).
  pyroforge: {
    cycleSec: 3822.2, // auto-derived (gen-cyclesec): density × footprint × M
    inputs: { steel: 5, helium_3: 1 },
    outputs: { exotic_alloy: 1 },
    category: 'smelting',
  },

  // T4 biome-locked electronics — Arctic-only Cryogenic Compute Center
  // produces AI Cores from Steel + Quantum Chip. Per §9.5, only producer of
  // AI Cores in the world. Arctic ambient cold should halve compute-recipe
  // power draw; currently a tuning placeholder, modelled at static 1200W
  // pending balance pass.
  cryogenic_compute_center: {
    cycleSec: 7166609.3, // auto-derived (gen-cyclesec): density × footprint × M
    inputs: { steel: 3, quantum_chip: 1, argon: 1 },
    outputs: { ai_core: 1 },
    category: 'electronics',
  },

  // Phase 11 — T4 endgame (Task 11.2): Particle Accelerator produces
  // Antimatter Capsules from Hydrogen + Exotic Alloy + Microchip.
  // Not biome-locked. Tagged `electronics` per §7.11.
  particle_accelerator: {
    cycleSec: 600, // pinned: near-zero-mass output (antimatter_capsule 1e-12 kg) — same slow-cycle convention as antimatter_refinery
    inputs: { hydrogen: 10, exotic_alloy: 1, microchip: 5 },
    outputs: { antimatter_capsule: 1 },
    category: 'electronics',
  },

  // Phase 11 — T4 endgame (Task 11.2): Quantum Chip Fabricator replaces
  // particle_accelerator as the quantum_chip producer.
  quantum_chip_fab: {
    cycleSec: 3822191.6, // auto-derived (gen-cyclesec): density × footprint × M
    inputs: { steel: 4, pig_iron: 4 },
    outputs: { quantum_chip: 1 },
    category: 'electronics',
  },

  // Phase 11 — T4 endgame (Task 11.1): Quantum Manipulator → time_crystal.
  quantum_manipulator: {
    cycleSec: 764438.3, // auto-derived (gen-cyclesec): density × footprint × M
    inputs: { helium_3: 1, exotic_alloy: 1 },
    outputs: { time_crystal: 1 },
    category: 'manufacturing',
  },

  // Phase 16.1 — §6.4 uranium extractor (Task 16.1). Closes the uranium_ore
  // producer gap: previously uranium_ore had no extractor, only a consumer.
  uranium_mine: {
    cycleSec: 3440, // auto-derived (gen-cyclesec): density × footprint × M
    inputs: {},
    outputs: { uranium_ore: 1 },
    exogenousFlow: 'terrain',
    category: 'extraction',
  },

  // Phase 11 — T4 endgame (Task 11.3): Fuel Rod Assembler → nuclear_fuel_rod.
  fuel_rod_assembler: {
    cycleSec: 286.7, // auto-derived (gen-cyclesec): density × footprint × M
    inputs: { uranium_ore: 5, stainless_steel: 2, coolant: 2 },
    outputs: { nuclear_fuel_rod: 1 },
    category: 'manufacturing',
  },

  // Phase 11 — T4 endgame (Task 11.4): Five T4 component assemblers.
  plasma_containment_assembler: {
    cycleSec: 286.7, // auto-derived (gen-cyclesec): density × footprint × M
    inputs: { exotic_alloy: 1, magnet: 4, steel: 5 },
    outputs: { plasma_containment_vessel: 1 },
    category: 'manufacturing',
  },
  singularity_sensor_lab: {
    cycleSec: 2687478.5, // auto-derived (gen-cyclesec): density × footprint × M
    inputs: { quantum_chip: 1, optical_fiber: 4, magnet: 2 },
    outputs: { singularity_sensor: 1 },
    category: 'electronics',
  },
  cryo_containment_assembler: {
    cycleSec: 286.7, // auto-derived (gen-cyclesec): density × footprint × M
    inputs: { cryogenic_compound: 1, stainless_steel: 2, glass_fiber: 4 },
    outputs: { cryo_containment_unit: 1 },
    category: 'manufacturing',
  },
  accelerator_core_lab: {
    cycleSec: 286.7, // auto-derived (gen-cyclesec): density × footprint × M
    inputs: { magnet: 8, exotic_alloy: 1, optical_fiber: 4 },
    outputs: { particle_accelerator_core: 1 },
    category: 'electronics',
  },
  self_replication_lab: {
    cycleSec: 127.4, // auto-derived (gen-cyclesec): density × footprint × M
    inputs: { ai_core: 1, microchip: 8, electric_motor: 4, computing_module: 2 },
    outputs: { self_replication_module: 1 },
    category: 'manufacturing',
  },

  // §9.5 Carbon Forge: produces Carbon Fiber. Optical/Glass fiber variants
  // are separate-recipe deferrals (the 1:1 recipe-per-defId design ships a
  // single output; carbon_fiber is the primary Forest bottleneck per §9.5).
  // Optical fiber + glass fiber recipes can land later as separate def-ids
  // if needed, or via a recipe-rotation extension.
  carbon_forge: {
    cycleSec: 1528.9, // auto-derived (gen-cyclesec): density × footprint × M
    inputs: { wood: 5, coke: 2 },
    outputs: { carbon_fiber: 1 },
    category: 'smelting',
  },

  // §04: Skill Forge — first crystal recipe (Mining Crystal T1).
  // Confirms the craft pipeline works end-to-end before adding all 45 recipes.
  skill_forge: {
    cycleSec: 286.7, // auto-derived (gen-cyclesec): density × footprint × M
    inputs: { iron_ore: 100, microchip: 4, reality_anchor: 1 },
    outputs: { mining_crystal_t1: 1 },
    category: 'electronics',
  },

  // Task 6: remaining crystal recipes (57 new recipes for 19 families × 3 tiers + mining T2/T3).
  skill_forge_mining_t2: {
    cycleSec: 286.7, // auto-derived (gen-cyclesec): density × footprint × M
    inputs: { steel: 50, microchip: 8, reality_anchor: 2 },
    outputs: { mining_crystal_t2: 1 },
    category: 'electronics',
  },
  skill_forge_mining_t3: {
    cycleSec: 286.7, // auto-derived (gen-cyclesec): density × footprint × M
    inputs: { exotic_alloy: 10, ai_core: 2, reality_anchor: 4 },
    outputs: { mining_crystal_t3: 1 },
    category: 'electronics',
  },
  skill_forge_forestry_t1: {
    cycleSec: 286.7, // auto-derived (gen-cyclesec): density × footprint × M
    inputs: { wood: 100, microchip: 4, reality_anchor: 1 },
    outputs: { forestry_crystal_t1: 1 },
    category: 'electronics',
  },
  skill_forge_forestry_t2: {
    cycleSec: 286.7, // auto-derived (gen-cyclesec): density × footprint × M
    inputs: { lumber: 50, microchip: 8, reality_anchor: 2 },
    outputs: { forestry_crystal_t2: 1 },
    category: 'electronics',
  },
  skill_forge_forestry_t3: {
    cycleSec: 286.7, // auto-derived (gen-cyclesec): density × footprint × M
    inputs: { carbon_fiber: 20, ai_core: 2, reality_anchor: 4 },
    outputs: { forestry_crystal_t3: 1 },
    category: 'electronics',
  },
  skill_forge_drilling_t1: {
    cycleSec: 286.7, // auto-derived (gen-cyclesec): density × footprint × M
    inputs: { stone: 100, microchip: 4, reality_anchor: 1 },
    outputs: { drilling_crystal_t1: 1 },
    category: 'electronics',
  },
  skill_forge_drilling_t2: {
    cycleSec: 286.7, // auto-derived (gen-cyclesec): density × footprint × M
    inputs: { steel: 50, microchip: 8, reality_anchor: 2 },
    outputs: { drilling_crystal_t2: 1 },
    category: 'electronics',
  },
  skill_forge_drilling_t3: {
    cycleSec: 286.7, // auto-derived (gen-cyclesec): density × footprint × M
    inputs: { diamond_ore: 20, ai_core: 2, reality_anchor: 4 },
    outputs: { drilling_crystal_t3: 1 },
    category: 'electronics',
  },
  skill_forge_robotics_t1: {
    cycleSec: 286.7, // auto-derived (gen-cyclesec): density × footprint × M
    inputs: { gear: 20, microchip: 4, reality_anchor: 1 },
    outputs: { robotics_crystal_t1: 1 },
    category: 'electronics',
  },
  skill_forge_robotics_t2: {
    cycleSec: 286.7, // auto-derived (gen-cyclesec): density × footprint × M
    inputs: { electric_motor: 10, microchip: 8, reality_anchor: 2 },
    outputs: { robotics_crystal_t2: 1 },
    category: 'electronics',
  },
  skill_forge_robotics_t3: {
    cycleSec: 286.7, // auto-derived (gen-cyclesec): density × footprint × M
    inputs: { ai_core: 2, quantum_chip: 2, reality_anchor: 4 },
    outputs: { robotics_crystal_t3: 1 },
    category: 'electronics',
  },
  skill_forge_smelting_t1: {
    cycleSec: 286.7, // auto-derived (gen-cyclesec): density × footprint × M
    inputs: { iron_ore: 100, coke: 20, reality_anchor: 1 },
    outputs: { smelting_crystal_t1: 1 },
    category: 'electronics',
  },
  skill_forge_smelting_t2: {
    cycleSec: 286.7, // auto-derived (gen-cyclesec): density × footprint × M
    inputs: { steel: 30, microchip: 8, reality_anchor: 2 },
    outputs: { smelting_crystal_t2: 1 },
    category: 'electronics',
  },
  skill_forge_smelting_t3: {
    cycleSec: 286.7, // auto-derived (gen-cyclesec): density × footprint × M
    inputs: { exotic_alloy: 10, ai_core: 2, reality_anchor: 4 },
    outputs: { smelting_crystal_t3: 1 },
    category: 'electronics',
  },
  skill_forge_chemistry_t1: {
    cycleSec: 286.7, // auto-derived (gen-cyclesec): density × footprint × M
    inputs: { sulfur: 50, microchip: 4, reality_anchor: 1 },
    outputs: { chemistry_crystal_t1: 1 },
    category: 'electronics',
  },
  skill_forge_chemistry_t2: {
    cycleSec: 286.7, // auto-derived (gen-cyclesec): density × footprint × M
    inputs: { sulfuric_acid: 30, microchip: 8, reality_anchor: 2 },
    outputs: { chemistry_crystal_t2: 1 },
    category: 'electronics',
  },
  skill_forge_chemistry_t3: {
    cycleSec: 286.7, // auto-derived (gen-cyclesec): density × footprint × M
    inputs: { exotic_alloy_seed: 10, ai_core: 2, reality_anchor: 4 },
    outputs: { chemistry_crystal_t3: 1 },
    category: 'electronics',
  },
  skill_forge_electronics_t1: {
    cycleSec: 286.7, // auto-derived (gen-cyclesec): density × footprint × M
    inputs: { microchip: 20, wire: 20, reality_anchor: 1 },
    outputs: { electronics_crystal_t1: 1 },
    category: 'electronics',
  },
  skill_forge_electronics_t2: {
    cycleSec: 286.7, // auto-derived (gen-cyclesec): density × footprint × M
    inputs: { quantum_chip: 5, microchip: 10, reality_anchor: 2 },
    outputs: { electronics_crystal_t2: 1 },
    category: 'electronics',
  },
  skill_forge_electronics_t3: {
    cycleSec: 286.7, // auto-derived (gen-cyclesec): density × footprint × M
    inputs: { ai_core: 2, quantum_chip: 5, reality_anchor: 4 },
    outputs: { electronics_crystal_t3: 1 },
    category: 'electronics',
  },
  skill_forge_power_systems_t1: {
    cycleSec: 286.7, // auto-derived (gen-cyclesec): density × footprint × M
    inputs: { coal: 100, microchip: 4, reality_anchor: 1 },
    outputs: { power_systems_crystal_t1: 1 },
    category: 'electronics',
  },
  skill_forge_power_systems_t2: {
    cycleSec: 286.7, // auto-derived (gen-cyclesec): density × footprint × M
    inputs: { battery: 20, microchip: 8, reality_anchor: 2 },
    outputs: { power_systems_crystal_t2: 1 },
    category: 'electronics',
  },
  skill_forge_power_systems_t3: {
    cycleSec: 286.7, // auto-derived (gen-cyclesec): density × footprint × M
    inputs: { nuclear_fuel_rod: 5, ai_core: 2, reality_anchor: 4 },
    outputs: { power_systems_crystal_t3: 1 },
    category: 'electronics',
  },
  skill_forge_storage_t1: {
    cycleSec: 286.7, // auto-derived (gen-cyclesec): density × footprint × M
    inputs: { wood: 100, microchip: 4, reality_anchor: 1 },
    outputs: { storage_crystal_t1: 1 },
    category: 'electronics',
  },
  skill_forge_storage_t2: {
    cycleSec: 286.7, // auto-derived (gen-cyclesec): density × footprint × M
    inputs: { steel: 30, microchip: 8, reality_anchor: 2 },
    outputs: { storage_crystal_t2: 1 },
    category: 'electronics',
  },
  skill_forge_storage_t3: {
    cycleSec: 286.7, // auto-derived (gen-cyclesec): density × footprint × M
    inputs: { foundation_kit_refined: 10, ai_core: 2, reality_anchor: 4 },
    outputs: { storage_crystal_t3: 1 },
    category: 'electronics',
  },
  skill_forge_transport_t1: {
    cycleSec: 286.7, // auto-derived (gen-cyclesec): density × footprint × M
    inputs: { bolt: 50, microchip: 4, reality_anchor: 1 },
    outputs: { transport_crystal_t1: 1 },
    category: 'electronics',
  },
  skill_forge_transport_t2: {
    cycleSec: 286.7, // auto-derived (gen-cyclesec): density × footprint × M
    inputs: { gear: 20, microchip: 8, reality_anchor: 2 },
    outputs: { transport_crystal_t2: 1 },
    category: 'electronics',
  },
  skill_forge_transport_t3: {
    cycleSec: 286.7, // auto-derived (gen-cyclesec): density × footprint × M
    inputs: { steel_beam: 20, ai_core: 2, reality_anchor: 4 },
    outputs: { transport_crystal_t3: 1 },
    category: 'electronics',
  },
  skill_forge_network_t1: {
    cycleSec: 286.7, // auto-derived (gen-cyclesec): density × footprint × M
    inputs: { wire: 50, microchip: 4, reality_anchor: 1 },
    outputs: { network_crystal_t1: 1 },
    category: 'electronics',
  },
  skill_forge_network_t2: {
    cycleSec: 286.7, // auto-derived (gen-cyclesec): density × footprint × M
    inputs: { optical_fiber: 20, microchip: 8, reality_anchor: 2 },
    outputs: { network_crystal_t2: 1 },
    category: 'electronics',
  },
  skill_forge_network_t3: {
    cycleSec: 286.7, // auto-derived (gen-cyclesec): density × footprint × M
    inputs: { quantum_chip: 5, ai_core: 2, reality_anchor: 4 },
    outputs: { network_crystal_t3: 1 },
    category: 'electronics',
  },
  skill_forge_launch_t1: {
    cycleSec: 286.7, // auto-derived (gen-cyclesec): density × footprint × M
    inputs: { steel: 50, microchip: 4, reality_anchor: 1 },
    outputs: { launch_crystal_t1: 1 },
    category: 'electronics',
  },
  skill_forge_launch_t2: {
    cycleSec: 286.7, // auto-derived (gen-cyclesec): density × footprint × M
    inputs: { fuel_cell: 10, microchip: 8, reality_anchor: 2 },
    outputs: { launch_crystal_t2: 1 },
    category: 'electronics',
  },
  skill_forge_launch_t3: {
    cycleSec: 286.7, // auto-derived (gen-cyclesec): density × footprint × M
    inputs: { ascendant_core: 1, ai_core: 2, reality_anchor: 4 },
    outputs: { launch_crystal_t3: 1 },
    category: 'electronics',
  },
  skill_forge_communication_t1: {
    cycleSec: 286.7, // auto-derived (gen-cyclesec): density × footprint × M
    inputs: { copper_ingot: 50, microchip: 4, reality_anchor: 1 },
    outputs: { communication_crystal_t1: 1 },
    category: 'electronics',
  },
  skill_forge_communication_t2: {
    cycleSec: 286.7, // auto-derived (gen-cyclesec): density × footprint × M
    inputs: { transistor: 20, microchip: 8, reality_anchor: 2 },
    outputs: { communication_crystal_t2: 1 },
    category: 'electronics',
  },
  skill_forge_communication_t3: {
    cycleSec: 286.7, // auto-derived (gen-cyclesec): density × footprint × M
    inputs: { tachyonic_transmitter: 2, ai_core: 2, reality_anchor: 4 },
    outputs: { communication_crystal_t3: 1 },
    category: 'electronics',
  },
  skill_forge_discovery_t1: {
    cycleSec: 286.7, // auto-derived (gen-cyclesec): density × footprint × M
    inputs: { quartz: 50, microchip: 4, reality_anchor: 1 },
    outputs: { discovery_crystal_t1: 1 },
    category: 'electronics',
  },
  skill_forge_discovery_t2: {
    cycleSec: 286.7, // auto-derived (gen-cyclesec): density × footprint × M
    inputs: { glass: 30, microchip: 8, reality_anchor: 2 },
    outputs: { discovery_crystal_t2: 1 },
    category: 'electronics',
  },
  skill_forge_discovery_t3: {
    cycleSec: 286.7, // auto-derived (gen-cyclesec): density × footprint × M
    inputs: { scanner_sat: 1, ai_core: 2, reality_anchor: 4 },
    outputs: { discovery_crystal_t3: 1 },
    category: 'electronics',
  },
  skill_forge_resilience_t1: {
    cycleSec: 286.7, // auto-derived (gen-cyclesec): density × footprint × M
    inputs: { brick: 100, microchip: 4, reality_anchor: 1 },
    outputs: { resilience_crystal_t1: 1 },
    category: 'electronics',
  },
  skill_forge_resilience_t2: {
    cycleSec: 286.7, // auto-derived (gen-cyclesec): density × footprint × M
    inputs: { concrete: 50, microchip: 8, reality_anchor: 2 },
    outputs: { resilience_crystal_t2: 1 },
    category: 'electronics',
  },
  skill_forge_resilience_t3: {
    cycleSec: 286.7, // auto-derived (gen-cyclesec): density × footprint × M
    inputs: { repair_pack: 10, ai_core: 2, reality_anchor: 4 },
    outputs: { resilience_crystal_t3: 1 },
    category: 'electronics',
  },
  skill_forge_patronage_t1: {
    cycleSec: 286.7, // auto-derived (gen-cyclesec): density × footprint × M
    inputs: { plank: 50, microchip: 4, reality_anchor: 1 },
    outputs: { patronage_crystal_t1: 1 },
    category: 'electronics',
  },
  skill_forge_patronage_t2: {
    cycleSec: 286.7, // auto-derived (gen-cyclesec): density × footprint × M
    inputs: { lumber: 30, microchip: 8, reality_anchor: 2 },
    outputs: { patronage_crystal_t2: 1 },
    category: 'electronics',
  },
  skill_forge_patronage_t3: {
    cycleSec: 286.7, // auto-derived (gen-cyclesec): density × footprint × M
    inputs: { foundation_kit_enriched: 10, ai_core: 2, reality_anchor: 4 },
    outputs: { patronage_crystal_t3: 1 },
    category: 'electronics',
  },
  skill_forge_aquaculture_t1: {
    cycleSec: 286.7, // auto-derived (gen-cyclesec): density × footprint × M
    inputs: { fresh_water: 100, microchip: 4, reality_anchor: 1 },
    outputs: { aquaculture_crystal_t1: 1 },
    category: 'electronics',
  },
  skill_forge_aquaculture_t2: {
    cycleSec: 286.7, // auto-derived (gen-cyclesec): density × footprint × M
    inputs: { salt: 50, microchip: 8, reality_anchor: 2 },
    outputs: { aquaculture_crystal_t2: 1 },
    category: 'electronics',
  },
  skill_forge_aquaculture_t3: {
    cycleSec: 286.7, // auto-derived (gen-cyclesec): density × footprint × M
    inputs: { heavy_water: 20, ai_core: 2, reality_anchor: 4 },
    outputs: { aquaculture_crystal_t3: 1 },
    category: 'electronics',
  },
  skill_forge_hydroprocessing_t1: {
    cycleSec: 286.7, // auto-derived (gen-cyclesec): density × footprint × M
    inputs: { crude_oil: 50, microchip: 4, reality_anchor: 1 },
    outputs: { hydroprocessing_crystal_t1: 1 },
    category: 'electronics',
  },
  skill_forge_hydroprocessing_t2: {
    cycleSec: 286.7, // auto-derived (gen-cyclesec): density × footprint × M
    inputs: { diesel: 30, microchip: 8, reality_anchor: 2 },
    outputs: { hydroprocessing_crystal_t2: 1 },
    category: 'electronics',
  },
  skill_forge_hydroprocessing_t3: {
    cycleSec: 286.7, // auto-derived (gen-cyclesec): density × footprint × M
    inputs: { cryogenic_hydrogen: 20, ai_core: 2, reality_anchor: 4 },
    outputs: { hydroprocessing_crystal_t3: 1 },
    category: 'electronics',
  },
  skill_forge_submarine_t1: {
    cycleSec: 286.7, // auto-derived (gen-cyclesec): density × footprint × M
    inputs: { steel: 50, microchip: 4, reality_anchor: 1 },
    outputs: { submarine_crystal_t1: 1 },
    category: 'electronics',
  },
  skill_forge_submarine_t2: {
    cycleSec: 286.7, // auto-derived (gen-cyclesec): density × footprint × M
    inputs: { battery: 20, microchip: 8, reality_anchor: 2 },
    outputs: { submarine_crystal_t2: 1 },
    category: 'electronics',
  },
  skill_forge_submarine_t3: {
    cycleSec: 286.7, // auto-derived (gen-cyclesec): density × footprint × M
    inputs: { fuel_cell: 10, ai_core: 2, reality_anchor: 4 },
    outputs: { submarine_crystal_t3: 1 },
    category: 'electronics',
  },
  skill_forge_oceanography_t1: {
    cycleSec: 286.7, // auto-derived (gen-cyclesec): density × footprint × M
    inputs: { sand: 100, microchip: 4, reality_anchor: 1 },
    outputs: { oceanography_crystal_t1: 1 },
    category: 'electronics',
  },
  skill_forge_oceanography_t2: {
    cycleSec: 286.7, // auto-derived (gen-cyclesec): density × footprint × M
    inputs: { glass: 30, microchip: 8, reality_anchor: 2 },
    outputs: { oceanography_crystal_t2: 1 },
    category: 'electronics',
  },
  skill_forge_oceanography_t3: {
    cycleSec: 286.7, // auto-derived (gen-cyclesec): density × footprint × M
    inputs: { optical_fiber: 20, ai_core: 2, reality_anchor: 4 },
    outputs: { oceanography_crystal_t3: 1 },
    category: 'electronics',
  },

  // T5 Transcendent chain (§6.6 / §7.12 / §8.10)
  //   casimir_tap     → 1 casimir_energy / 1800s (no inputs; §8.10 "free vacuum energy";
  //                     2026-05-18 ÷3 for display visibility → now 600s)
  //   reality_forge   → 1 reality_anchor / 24h cycle from §7.12 spec literal
  //                     (4 ai_core + 1 antimatter_capsule + 1 time_crystal + 1 exotic_alloy;
  //                     2026-05-18 ÷3 for display visibility → now 8h cycle)

  // T5 raw extraction — placeholder for the §8.10 Casimir Tap. Spec cycle
  // 30 min to 4 h; already at 1800s (30 min lower bound) — skip rebalance
  // per step-19 spec (casimir_tap already at correct scale).
  // 2026-05-18 ÷3 for display visibility → now 600s (10 min).
  casimir_tap: {
    cycleSec: 600, // already at idle-game scale (30 min) — not multiplied in step #19; 2026-05-18 ÷3 for display visibility (was 1800s)
    inputs: {},
    outputs: { casimir_energy: 1 },
    category: 'power',
  },

  // Phase 12 — T5 transcendent field extractors (Task 12.1)
  zero_point_extractor: {
    cycleSec: 17199862.4, // auto-derived (gen-cyclesec): density × footprint × M
    inputs: {},
    outputs: { zero_point_flux: 1 },
    category: 'extraction',
  },
  neutronium_extractor: {
    cycleSec: 17199862.4, // auto-derived (gen-cyclesec): density × footprint × M
    inputs: {},
    outputs: { neutronium: 1 },
    category: 'extraction',
  },

  // Phase 12 — T5 component labs (Task 12.2)
  probability_calculator_lab: {
    cycleSec: 7644383.3, // auto-derived (gen-cyclesec): density × footprint × M
    inputs: { quantum_chip: 4, casimir_energy: 1, ai_core: 1 },
    outputs: { probability_calculator: 1 },
    category: 'manufacturing',
  },
  dimensional_fold_lab: {
    cycleSec: 7644383.3, // auto-derived (gen-cyclesec): density × footprint × M
    inputs: { spacetime_fragment: 1, exotic_alloy: 2, eldritch_processor: 1 },
    outputs: { dimensional_fold: 1 },
    category: 'manufacturing',
  },
  causal_regulator_lab: {
    cycleSec: 7644383.3, // auto-derived (gen-cyclesec): density × footprint × M
    inputs: { time_crystal: 1, phase_converter: 2, reality_anchor: 1 },
    outputs: { causal_regulator: 1 },
    category: 'manufacturing',
  },

  // Phase 12 — T5 component labs (Task 12.3)
  tachyonic_transmitter_lab: {
    cycleSec: 7644383.3, // auto-derived (gen-cyclesec): density × footprint × M
    inputs: { tachyon_stream: 1, optical_fiber: 8, ai_core: 1 },
    outputs: { tachyonic_transmitter: 1 },
    category: 'manufacturing',
  },
  aether_beacon_lab: {
    cycleSec: 7644383.3, // auto-derived (gen-cyclesec): density × footprint × M
    inputs: { aetheric_current: 1, casimir_energy: 1, magnet: 4 },
    outputs: { aether_beacon: 1 },
    category: 'manufacturing',
  },
  reality_engine_lab: {
    cycleSec: 7644383.3, // auto-derived (gen-cyclesec): density × footprint × M
    inputs: { reality_anchor: 1, dimensional_fold: 1, causal_regulator: 1 },
    outputs: { reality_engine: 1 },
    category: 'manufacturing',
  },
  singularity_battery_factory: {
    cycleSec: 23888.7, // auto-derived (gen-cyclesec): density × footprint × M
    inputs: { phase_converter: 2, dark_matter: 1, casimir_energy: 1 },
    outputs: { singularity_battery_unit: 1 },
    category: 'manufacturing',
  },

  // T5 manufacturing — Reality Forge. §7.12 spec literal: 24h cycle.
  // 2026-05-18 ÷3 for display visibility → now 8h cycle.
  reality_forge: {
    cycleSec: 42999.7, // auto-derived (gen-cyclesec): density × footprint × M
    inputs: { ai_core: 4, antimatter_capsule: 1, time_crystal: 1, exotic_alloy: 1 },
    outputs: { reality_anchor: 1 },
    category: 'manufacturing',
  },

  // Step-18 recipe graph closure (§7.1-§7.12)
  // The next block of recipes closes the resource graph: every resource
  // referenced as a recipe INPUT must have at least one producer. Cycle
  // times are placeholders chosen for "demonstrably tickable, not
  // balanced" — a later pass will rebalance. §8.1 tile-gating is live
  // for all extractors (placement + runtime).

  // T1 extraction (§7.1 / §8.1 raws) — rebalanced for idle-game scale, step #19 (×10).
  // All have empty `inputs` and a single-resource output — same shape as the existing Mine/Logger.
  quarry: {
    cycleSec: 40, // auto-derived (gen-cyclesec): density × footprint × M
    inputs: {},
    outputs: { stone: 1 },
    exogenousFlow: 'terrain',
    category: 'extraction',
  },
  sand_pit: {
    cycleSec: 40, // auto-derived (gen-cyclesec): density × footprint × M
    inputs: {},
    outputs: { sand: 1 },
    exogenousFlow: 'terrain',
    category: 'extraction',
  },
  well: {
    cycleSec: 16.4, // auto-derived (gen-cyclesec): density × footprint × M
    inputs: {},
    outputs: { fresh_water: 1 },
    exogenousFlow: 'terrain',
    category: 'extraction',
  },
  coastal_pump: {
    cycleSec: 16.4, // auto-derived (gen-cyclesec): density × footprint × M
    inputs: {},
    outputs: { saltwater: 1 },
    exogenousFlow: 'terrain',
    category: 'extraction',
  },
  quartz_mine: {
    cycleSec: 40, // auto-derived (gen-cyclesec): density × footprint × M
    inputs: {},
    outputs: { quartz: 1 },
    exogenousFlow: 'terrain',
    category: 'extraction',
  },
  limestone_quarry: {
    cycleSec: 40, // auto-derived (gen-cyclesec): density × footprint × M
    inputs: {},
    outputs: { limestone: 1 },
    exogenousFlow: 'terrain',
    category: 'extraction',
  },
  clay_pit_extractor: {
    cycleSec: 40, // auto-derived (gen-cyclesec): density × footprint × M
    inputs: {},
    outputs: { clay: 1 },
    exogenousFlow: 'terrain',
    category: 'extraction',
  },
  sulfur_mine: {
    cycleSec: 20, // auto-derived (gen-cyclesec): density × footprint × M
    inputs: {},
    outputs: { sulfur: 1 },
    exogenousFlow: 'terrain',
    category: 'extraction',
  },
  phosphate_mine: {
    cycleSec: 20, // auto-derived (gen-cyclesec): density × footprint × M
    inputs: {},
    outputs: { phosphate: 1 },
    exogenousFlow: 'terrain',
    category: 'extraction',
  },
  graphite_mine: {
    cycleSec: 20, // auto-derived (gen-cyclesec): density × footprint × M
    inputs: {},
    outputs: { graphite: 1 },
    exogenousFlow: 'terrain',
    category: 'extraction',
  },
  copper_mine: {
    cycleSec: 20, // auto-derived (gen-cyclesec): density × footprint × M
    inputs: {},
    outputs: { copper_ore: 1 },
    exogenousFlow: 'terrain',
    category: 'extraction',
  },
  tin_mine: {
    cycleSec: 20, // auto-derived (gen-cyclesec): density × footprint × M
    inputs: {},
    outputs: { tin_ore: 1 },
    exogenousFlow: 'terrain',
    category: 'extraction',
  },
  lead_mine: {
    cycleSec: 20, // auto-derived (gen-cyclesec): density × footprint × M
    inputs: {},
    outputs: { lead_ore: 1 },
    exogenousFlow: 'terrain',
    category: 'extraction',
  },
  bauxite_mine: {
    cycleSec: 20, // auto-derived (gen-cyclesec): density × footprint × M
    inputs: {},
    outputs: { bauxite: 1 },
    exogenousFlow: 'terrain',
    category: 'extraction',
  },

  // Phase 2 — T1 refined chains (§6.2 / §7.5)
  limekiln: {
    cycleSec: 119443.5, // auto-derived (gen-cyclesec): density × footprint × M
    inputs: { limestone: 25 },
    outputs: { quicklime: 14, co2: 11 },
    exogenousFlow: 'fuel-combustion-CO₂',
    exogenousFlowKg: 5,
    category: 'chemistry',
  },
  lime_slaker: {
    cycleSec: 905.3, // auto-derived (gen-cyclesec): density × footprint × M
    inputs: { quicklime: 1, fresh_water: 1 },
    outputs: { slaked_lime: 1 },
    category: 'chemistry',
  },
  brick_kiln: {
    cycleSec: 64499.5, // auto-derived (gen-cyclesec): density × footprint × M
    inputs: { clay: 6 },
    outputs: { brick: 5, water_vapor: 1 },
    category: 'chemistry',
  },
  mortar_mixer: {
    cycleSec: 905.3, // auto-derived (gen-cyclesec): density × footprint × M
    inputs: { sand: 1, quicklime: 1 },
    outputs: { mortar: 1 },
    category: 'chemistry',
  },
  cement_mill: {
    cycleSec: 9957.8, // auto-derived (gen-cyclesec): density × footprint × M
    inputs: { quicklime: 8, clay: 2, sand: 1 },
    outputs: { cement: 11 },
    exogenousFlow: 'fuel-combustion-CO₂',
    exogenousFlowKg: 4,
    category: 'chemistry',
  },
  concrete_plant: {
    cycleSec: 5431.5, // auto-derived (gen-cyclesec): density × footprint × M
    inputs: { cement: 1, sand: 2, stone: 3, fresh_water: 0.5 },
    outputs: { concrete: 6 },
    exogenousFlow: 'evaporation-water-vapor',
    category: 'chemistry',
  },
  charcoal_kiln: {
    cycleSec: 171998.6, // auto-derived (gen-cyclesec): density × footprint × M
    inputs: { wood: 8 },
    outputs: { charcoal: 2, wood_tar: 1, co2: 2, water_vapor: 3 },
    biogenic: true,
    category: 'chemistry',
  },
  plank_mill: {
    cycleSec: 171998.6, // auto-derived (gen-cyclesec): density × footprint × M
    inputs: { lumber: 1 },
    outputs: { plank: 2 },
    category: 'manufacturing',
  },
  copper_smelter: {
    cycleSec: 2774.2, // auto-derived (gen-cyclesec): density × footprint × M
    inputs: { copper_ore: 1, coal: 1 },
    outputs: { copper_ingot: 1 },
    category: 'smelting',
  },
  tin_smelter: {
    cycleSec: 2774.2, // auto-derived (gen-cyclesec): density × footprint × M
    inputs: { tin_ore: 1, coal: 1 },
    outputs: { tin_ingot: 1 },
    category: 'smelting',
  },
  lead_smelter: {
    cycleSec: 2774.2, // auto-derived (gen-cyclesec): density × footprint × M
    inputs: { lead_ore: 1, coal: 1 },
    outputs: { lead_ingot: 1 },
    category: 'smelting',
  },
  solder_alloyer: {
    cycleSec: 5548.3, // auto-derived (gen-cyclesec): density × footprint × M
    inputs: { tin_ingot: 1, lead_ingot: 1 },
    outputs: { solder: 2 },
    category: 'manufacturing',
  },
  // Phase 7 — Bronze + Brass (§7.2)
  bronze_alloyer: {
    cycleSec: 5548.3, // auto-derived (gen-cyclesec): density × footprint × M
    inputs: { copper_ingot: 1, tin_ingot: 1 },
    outputs: { bronze: 2 },
    category: 'manufacturing',
  },
  brass_alloyer: {
    cycleSec: 5548.3, // auto-derived (gen-cyclesec): density × footprint × M
    inputs: { copper_ingot: 1, zinc_ingot: 1 },
    outputs: { brass: 2 },
    category: 'manufacturing',
  },
  // Phase 8 — Aluminum chain (§7.3)
  alumina_refinery: {
    cycleSec: 2774.2, // auto-derived (gen-cyclesec): density × footprint × M
    inputs: { bauxite: 1, sodium_hydroxide: 1 },
    outputs: { alumina: 1 },
    category: 'chemistry',
  },
  aluminum_smelter: {
    cycleSec: 819041.1, // auto-derived (gen-cyclesec): density × footprint × M
    inputs: { alumina: 1 },
    outputs: { aluminum: 1 },
    category: 'smelting',
  },

  // Phase 3 — T2-T3 steel alloy chains (§6.1 / §6.4 / §7.1)
  manganese_mine: {
    cycleSec: 20, // auto-derived (gen-cyclesec): density × footprint × M
    inputs: {},
    outputs: { manganese_ore: 1 },
    exogenousFlow: 'terrain',
    category: 'extraction',
  },
  manganese_smelter: {
    cycleSec: 2774.2, // auto-derived (gen-cyclesec): density × footprint × M
    inputs: { manganese_ore: 1, coal: 1 },
    outputs: { manganese_ingot: 1 },
    category: 'smelting',
  },
  carbon_steel_mill: {
    cycleSec: 152.9, // auto-derived (gen-cyclesec): density × footprint × M
    inputs: { steel: 1, manganese_ingot: 1 },
    outputs: { carbon_steel: 1 },
    category: 'manufacturing',
  },
  zinc_mine: {
    cycleSec: 20, // auto-derived (gen-cyclesec): density × footprint × M
    inputs: {},
    outputs: { zinc_ore: 1 },
    exogenousFlow: 'terrain',
    category: 'extraction',
  },
  zinc_smelter: {
    cycleSec: 2774.2, // auto-derived (gen-cyclesec): density × footprint × M
    inputs: { zinc_ore: 1, coal: 1 },
    outputs: { zinc_ingot: 1 },
    category: 'smelting',
  },
  galvanizing_bath: {
    cycleSec: 152.9, // auto-derived (gen-cyclesec): density × footprint × M
    inputs: { steel: 1, zinc_ingot: 1 },
    outputs: { galvanized_steel: 1 },
    category: 'manufacturing',
  },
  chromium_mine: {
    cycleSec: 20, // auto-derived (gen-cyclesec): density × footprint × M
    inputs: {},
    outputs: { chromium_ore: 1 },
    exogenousFlow: 'terrain',
    category: 'extraction',
  },
  chromium_smelter: {
    // bumped from 80s → 250s: T1-speed smelting T3-weight ingots was an XP-arbitrage
    // exploit (Agent C finding — T1 80s smelter producing VI-15 outputs).
    cycleSec: 2774.2, // auto-derived (gen-cyclesec): density × footprint × M
    inputs: { chromium_ore: 1, coal: 1 },
    outputs: { chromium_ingot: 1 },
    category: 'smelting',
  },
  nickel_mine: {
    cycleSec: 20, // auto-derived (gen-cyclesec): density × footprint × M
    inputs: {},
    outputs: { nickel_ore: 1 },
    exogenousFlow: 'terrain',
    category: 'extraction',
  },
  nickel_smelter: {
    // bumped from 80s → 250s: XP-arbitrage fix — same rationale as chromium_smelter.
    cycleSec: 2774.2, // auto-derived (gen-cyclesec): density × footprint × M
    inputs: { nickel_ore: 1, coal: 1 },
    outputs: { nickel_ingot: 1 },
    category: 'smelting',
  },
  stainless_steel_mill: {
    cycleSec: 152.9, // auto-derived (gen-cyclesec): density × footprint × M
    inputs: { steel: 1, chromium_ingot: 1, nickel_ingot: 1 },
    outputs: { stainless_steel: 1 },
    category: 'manufacturing',
  },
  tungsten_mine: {
    cycleSec: 20, // auto-derived (gen-cyclesec): density × footprint × M
    inputs: {},
    outputs: { tungsten_ore: 1 },
    exogenousFlow: 'terrain',
    category: 'extraction',
  },
  tungsten_smelter: {
    // bumped from 80s → 250s: XP-arbitrage fix — same rationale as chromium_smelter.
    cycleSec: 2774.2, // auto-derived (gen-cyclesec): density × footprint × M
    inputs: { tungsten_ore: 1, coal: 1 },
    outputs: { tungsten_ingot: 1 },
    category: 'smelting',
  },
  tool_steel_mill: {
    cycleSec: 152.9, // auto-derived (gen-cyclesec): density × footprint × M
    inputs: { steel: 1, tungsten_ingot: 1 },
    outputs: { tool_steel: 1 },
    category: 'manufacturing',
  },

  // T1 manufacturing / chemistry — T0 raws → T1 refined. Rebalanced for idle-game scale, step #19 (×10).
  lumber_mill: {
    cycleSec: 85999.3, // auto-derived (gen-cyclesec): density × footprint × M
    inputs: { wood: 1 },
    outputs: { lumber: 1 },
    category: 'manufacturing',
  },
  glassworks: {
    cycleSec: 22337.5, // auto-derived (gen-cyclesec): density × footprint × M
    inputs: { sand: 1 },
    outputs: { glass: 1 },
    category: 'manufacturing',
    // §5.2 mentions Glassworks as a heat-driven recipe; intentionally NOT
    // marked `requiresHeat` in this step. Step's scope is the §5.2 iron/steel
    // chain (Coke Oven / Blast Furnace / EAF / Pyroforge). Glassworks heat
    // gating ships when chemistry recipes that depend on heat also do.
  },
  evaporator: {
    cycleSec: 19111, // auto-derived (gen-cyclesec): density × footprint × M
    inputs: { saltwater: 1 },
    outputs: { salt: 1 },
    category: 'manufacturing',
    // Salt feeds the salt-pathway `chemical_reactor` (Salt + power →
    // Chlorine + Sodium hydroxide), giving evaporator output a downstream
    // consumer for the alumina + lubricant chains.
  },
  electrolyzer: {
    cycleSec: 206398.3, // auto-derived (gen-cyclesec): density × footprint × M
    inputs: { fresh_water: 9 },
    outputs: { hydrogen: 1, oxygen: 8 },
    category: 'chemistry',
  },
  biofuel_plant: {
    cycleSec: 358.3, // auto-derived (gen-cyclesec): density × footprint × M
    inputs: { wood: 2 },
    outputs: { biofuel: 1 },
    category: 'chemistry',
    // §11.7 drone-fuel chain closure: biofuel was previously seeded but
    // had no producer. Biofuel Plant is the canonical T1 producer.
  },

  // T2 extraction — petrochemical raws. Rebalanced for idle-game scale, step #19 (×40).
  pump_jack: {
    cycleSec: 430, // auto-derived (gen-cyclesec): density × footprint × M
    inputs: {},
    outputs: { crude_oil: 1 },
    exogenousFlow: 'terrain',
    category: 'extraction',
    // §8.1 catalog: requires `oil_well` terrain tile. Tile gating is
    // implemented via `requiredTile` in building-defs.ts.
  },
  gas_extractor: {
    cycleSec: 430, // auto-derived (gen-cyclesec): density × footprint × M
    inputs: {},
    outputs: { natural_gas: 1 },
    exogenousFlow: 'terrain',
    category: 'extraction',
    // Orphan output: no current consumer (§7.3 ammonia/syngas variants
    // STILL-DEFERRED). Producer ships so the resource isn't a permanent
    // sink-without-source if a consumer recipe lands later.
  },

  // T2 petrochemical / refining — rebalanced for idle-game scale, step #19 (×40).
  // Each split into its own building since the engine's 1:1 recipe-per-defId
  // model doesn't support multi-recipe selection without infrastructure expansion.
  naphtha_cracker: {
    // rebalanced for idle-game scale, step #19 (×40: was 15s); bumped 600→1000
    // to reduce XP-arbitrage: T0/T1 inputs → T2-weight outputs at T1 throughput.
    cycleSec: 546, // auto-derived (gen-cyclesec): density × footprint × M
    inputs: { crude_oil: 20 },
    outputs: { naphtha: 3, aviation_kerosene_crude: 3, diesel: 5, heavy_oil: 6, refinery_gas: 3 },
    category: 'chemistry',
  },
  // Phase 4 — T2 deep-fraction crude oil cracker (§7.4)
  crude_oil_cracker: {
    // bumped 600→1200: produces 3 outputs (heavy_oil, tar, asphalt) — longer
    // pace is proportionally fair; also closes XP-arbitrage per Agent C finding.
    cycleSec: 81.9, // auto-derived (gen-cyclesec): density × footprint × M
    inputs: { crude_oil: 3 },
    outputs: { heavy_oil: 1, tar: 1, asphalt: 1 },
    category: 'chemistry',
  },
  // Phase 4 — T2 plastic precursor polymerizer (§7.4)
  plastic_polymerizer_a: {
    cycleSec: 358.3, // auto-derived (gen-cyclesec): density × footprint × M
    inputs: { naphtha: 1 },
    outputs: { plastic_precursor: 1 },
    category: 'chemistry',
  },
  // Phase 4 — T2 split plastic presses (§7.4)
  rigid_plastic_press: {
    cycleSec: 358.3, // auto-derived (gen-cyclesec): density × footprint × M
    inputs: { plastic_precursor: 1 },
    outputs: { rigid_plastic: 1 },
    category: 'manufacturing',
  },
  flexible_plastic_press: {
    cycleSec: 358.3, // auto-derived (gen-cyclesec): density × footprint × M
    inputs: { plastic_precursor: 1 },
    outputs: { flexible_plastic: 1 },
    category: 'manufacturing',
  },
  rubber_synthesizer: {
    cycleSec: 358.3, // auto-derived (gen-cyclesec): density × footprint × M
    inputs: { plastic_precursor: 1 },
    outputs: { synthetic_rubber: 1 },
    category: 'manufacturing',
  },
  // Phase 5 — T2 chemistry chain (§7.5)
  sulfuric_acid_plant: {
    cycleSec: 1438.5, // auto-derived (gen-cyclesec): density × footprint × M
    inputs: { sulfur: 1, fresh_water: 2 },
    outputs: { sulfuric_acid: 1 },
    category: 'chemistry',
  },
  hcl_plant: {
    cycleSec: 930.4, // auto-derived (gen-cyclesec): density × footprint × M
    inputs: { salt: 1, sulfuric_acid: 1 },
    outputs: { hydrochloric_acid: 1 },
    category: 'chemistry',
  },
  // Phase 5 — T3 chemistry chain (§7.5)
  phosphor_plant: {
    cycleSec: 781.8, // auto-derived (gen-cyclesec): density × footprint × M
    inputs: { phosphate: 1, sulfuric_acid: 1 },
    outputs: { phosphor: 1 },
    category: 'chemistry',
  },
  cryo_air_separator: {
    cycleSec: 19.6, // auto-derived (gen-cyclesec): density × footprint × M
    inputs: { nitrogen: 1 },
    outputs: { liquid_nitrogen: 1 },
    category: 'chemistry',
  },
  chlor_alkali_plant: {
    // rebalanced for idle-game scale, step #19 (×40: was 20s); bumped 800→1200
    // to reduce XP-arbitrage per Agent C finding (T0 saltwater → T2-weight outputs).
    cycleSec: 877193, // auto-derived (gen-cyclesec): density × footprint × M
    inputs: { salt: 117, fresh_water: 36 },
    outputs: { chlorine: 71, sodium_hydroxide: 80, hydrogen: 2 },
    category: 'chemistry',
    // Real co-output per §7.5; consumer in §7.3 alumina chain.
  },
  chemical_reactor: {
    // Task 0.2 — calcium_sulfonate producer (closes lubricant-chain gap).
    // Replaces the §7.5 electrolysis placeholder (chlorine + NaOH covered by
    // chlor_alkali_plant; this building now hosts the grease/additive chemistry).
    // Mass balance: sulfur(1×1) + quicklime(1×1) + heavy_oil(1×1) = 3 kg in
    //               calcium_sulfonate(3×1) = 3 kg out  →  Δ = 0 ✓
    cycleSec: 2345.4, // auto-derived (gen-cyclesec): density × footprint × M
    inputs: { sulfur: 1, quicklime: 1, heavy_oil: 1 },
    outputs: { calcium_sulfonate: 3 },
    category: 'chemistry',
  },
  lubricant_refinery: {
    cycleSec: 614.3, // auto-derived (gen-cyclesec): density × footprint × M
    inputs: { heavy_oil: 5, chlorine: 5, calcium_sulfonate: 1 },
    outputs: { lubricant: 10 },
    category: 'chemistry',
    exogenousFlow: 'process-losses + HCl',
    // Lubricant feeds the §4.7 per-tier maintenance recipes (see
    // `src/maintenance.ts:65-78` — every tier from T1 to T6 lists
    // lubricant in its bill of materials).
  },
  diesel_refinery: {
    cycleSec: 626.6, // auto-derived (gen-cyclesec): density × footprint × M
    inputs: { heavy_oil: 10, hydrogen: 1 },
    outputs: { diesel: 10, sulfur: 0.2 },
    category: 'chemistry',
    exogenousFlow: 'hydrocracker-light-ends-vented',
    // §11.7 drone tier: diesel = T2 drone fuel. The drone fuel-tier
    // selection isn't wired into drones.ts yet — diesel is a
    // stockpile-only fuel until §11.7 lands.
  },
  metal_rolling_mill: {
    cycleSec: 3784, // auto-derived (gen-cyclesec): density × footprint × M
    inputs: { steel: 11 },
    outputs: { wire: 20, mill_scale: 1 },
    category: 'manufacturing',
    // §7.1 spec lists multiple Steel Mill outputs (wire, sheet_metal,
    // pipe, beam); this Steel Mill ships wire only (input to the
    // Lithography Lab → microchip recipe). sheet_metal, pipe, and beam
    // are produced by dedicated `sheet_metal_mill`, `pipe_mill`, and
    // `beam_mill` defs (see below). Consumers exist for pipe (assembly
    // recipes); sheet_metal / steel_beam still await downstream demand.
  },

  // T3 chemistry / electronics — rebalanced for idle-game scale, step #19 (×20).
  silicon_crusher: {
    cycleSec: 2774.2, // auto-derived (gen-cyclesec): density × footprint × M
    inputs: { quartz: 1 },
    outputs: { silicon: 1 },
    category: 'smelting',
    // §7.4: spec uses `silicon_wafer` as the lithography input, refined
    // from `silicon`. The `wafer_lab` + `silicon_wafer` def + resource
    // ship below, but Lithography Lab still consumes silicon directly —
    // the wafer-intermediate chain is unwired.
  },
  air_separator: {
    cycleSec: 1960.1, // auto-derived (gen-cyclesec): density × footprint × M
    inputs: { air: 100 },
    outputs: { nitrogen: 75.5, oxygen: 23.2, argon: 1.3 },
    category: 'chemistry',
    exogenousFlow: 'atmosphere',
  },
  cryo_lab: {
    cycleSec: 19.6, // auto-derived (gen-cyclesec): density × footprint × M
    inputs: { hydrogen: 1, nitrogen: 1 },
    outputs: { cryo_coolant: 1 },
    category: 'chemistry',
  },
  cryo_compressor: {
    cycleSec: 19.6, // auto-derived (gen-cyclesec): density × footprint × M
    inputs: { hydrogen: 1, cryo_coolant: 1 },
    outputs: { cryogenic_hydrogen: 1 },
    category: 'chemistry',
    // T4 fuel chain closure: `cryogenic_hydrogen` was previously in the
    // catalog with no producer. Cryo Compressor closes the producer side
    // even though the T4 consumer (Fusion Core II / launch fuel)
    // remains STILL-DEFERRED.
  },
  kerosene_refinery: {
    cycleSec: 273, // auto-derived (gen-cyclesec): density × footprint × M
    inputs: { aviation_kerosene_crude: 10, hydrogen: 1 },
    outputs: { aviation_kerosene: 10 },
    category: 'chemistry',
    exogenousFlow: 'hydrotreatment-H2S-and-light-gas',
    // §11.7: aviation_kerosene = T3 drone fuel. Drone fuel-tier
    // selection STILL-DEFERRED.
  },
  lithography_lab: {
    cycleSec: 67187, // auto-derived (gen-cyclesec): density × footprint × M
    inputs: { silicon: 1, wire: 1 },
    outputs: { microchip: 1 },
    category: 'electronics',
    // Microchip feeds the §7.7 electronics chain: pcb_etcher (PCBs) →
    // circuit_assembler → processor_fab → compute_module_fab. Those
    // recipes ship below in this same file (search for `pcb_etcher`).
  },
  // Phase 9 — Task 9.1: high-purity silicon → wafer (§7.7)
  wafer_lab: {
    cycleSec: 155276.5, // auto-derived (gen-cyclesec): density × footprint × M
    inputs: { silicon: 1 },
    outputs: { silicon_wafer: 1 },
    category: 'electronics',
  },
  // Phase 9 — Task 9.2: wafer + graphite → transistor / capacitor / resistor (§7.7)
  transistor_doping: {
    cycleSec: 10749.9, // auto-derived (gen-cyclesec): density × footprint × M
    inputs: { silicon_wafer: 1, graphite: 1 },
    outputs: { transistor: 4 },
    category: 'electronics',
  },
  capacitor_doping: {
    cycleSec: 53749.6, // auto-derived (gen-cyclesec): density × footprint × M
    inputs: { silicon_wafer: 1, graphite: 1 },
    outputs: { capacitor: 4 },
    category: 'electronics',
  },
  resistor_doping: {
    cycleSec: 10749.9, // auto-derived (gen-cyclesec): density × footprint × M
    inputs: { silicon_wafer: 1, graphite: 1 },
    outputs: { resistor: 4 },
    category: 'electronics',
  },
  // Phase 9 — Task 9.3: Memory Lab (§7.7). PCB + transistors + capacitors + resistors + solder → memory_module.
  memory_lab: {
    cycleSec: 119443.5, // auto-derived (gen-cyclesec): density × footprint × M
    inputs: { pcb: 1, transistor: 4, capacitor: 4, resistor: 4, solder: 1 },
    // output doubled: was 1 — XP-net-negative recipe fix (Agent C, VI < 0.15).
    outputs: { memory_module: 2 },
    category: 'electronics',
  },
  drilling_rig: {
    cycleSec: 800, // pinned: near-zero-mass output (helium_3 0.001 kg) — prevents ~1s density-derived XP fountain
    inputs: {},
    outputs: { helium_3: 1 },
    exogenousFlow: 'terrain',
    category: 'extraction',
    // §8.1: Drilling Rig requires `helium_vent` tile. Tile gating is
    // implemented — `validatePlacement` enforces this via `requiredTile`.
    // Closes the helium_3 producer gap: previously seeded as 50 on
    // forest-ne but with no replenishment.
  },

  // T5 raw extractors (§8.10 / step-18 closure) — rebalanced for idle-game scale, step #19 (×8)
  // §8.10 spec describes deterministic per-cycle output rotation across
  // multiple raws ("deterministic given world seed + cycle index"). The
  // step-18 simplification: each extractor outputs a single raw per
  // cycle, with §8.10 rotation logic now shipped (rotateOutputs). Cycle times were at the
  // §8.10 lower bound (600-720s); multiplied ×8 for idle-game scale.
  // Power consumption per §8.10 is in the 60-100 kW range (very large).
  aetheric_conduit: {
    cycleSec: 7644383.3, // auto-derived (gen-cyclesec): density × footprint × M
    inputs: {},
    outputs: { aetheric_current: 1 },
    rotateOutputs: [{ aetheric_current: 1 }, { quantum_foam: 1 }],
    category: 'extraction',
  },
  spacetime_resonator: {
    cycleSec: 7644383.3, // auto-derived (gen-cyclesec): density × footprint × M
    inputs: {},
    outputs: { spacetime_fragment: 1 },
    rotateOutputs: [{ spacetime_fragment: 1 }, { tachyon_stream: 1 }],
    category: 'extraction',
  },
  eldritch_sieve: {
    cycleSec: 7644383.3, // auto-derived (gen-cyclesec): density × footprint × M
    inputs: {},
    outputs: { dark_matter: 1 },
    rotateOutputs: [{ dark_matter: 1 }, { strange_matter: 1 }, { higgs_flux: 1 }],
    category: 'extraction',
  },

  // T5 refining (§7.12 step-18 closure) — rebalanced for idle-game scale, step #19 (×8).
  plasma_forge: {
    cycleSec: 7644383.3, // auto-derived (gen-cyclesec): density × footprint × M
    inputs: { exotic_alloy: 1, casimir_energy: 1 },
    outputs: { plasma_charge: 1 },
    category: 'manufacturing',
    // §11.7: plasma_charge = T5 propellant (drone fuel tier 5). Drone
    // fuel-tier selection STILL-DEFERRED.
  },
  eldritch_refiner: {
    cycleSec: 7644383.3, // auto-derived (gen-cyclesec): density × footprint × M
    inputs: { dark_matter: 1, strange_matter: 1 },
    outputs: { eldritch_processor: 1 },
    category: 'manufacturing',
  },
  phase_refiner: {
    cycleSec: 7644383.3, // auto-derived (gen-cyclesec): density × footprint × M
    inputs: { aetheric_current: 1, tachyon_stream: 1 },
    outputs: { phase_converter: 1 },
    category: 'manufacturing',
  },

  // T5→T6 transition + T6 Orbital (§13.4 / §14.10 / step 20)
  // §14.2-14.8 / §14.12 launch + debris + lodge + repair mechanics are
  // live (`orbital.ts`); these recipes produce real consumable payloads
  // and fuel. §14.10 spec recipe inputs that aren't yet in the catalog
  // (Spacetime fragment, Aluminum, Magnet, Optical Fiber, Memetic Core,
  // Brick, Carbon Fiber) are simplified to catalog-resident inputs of
  // the same tier-weight — full §14.10 fidelity awaits the missing
  // intermediates.

  // §13.4 / §14.1: Ascendant Assembly produces the Ascendant Core (T5→T6
  // bridge artifact). Cycle is 2 hours of real time — the artifact's
  // weight-and-cost framing makes it a meaningful gate. First local
  // production auto-flips `state.ascendantCoreCrafted` (economy.ts §13
  // auto-flip block), opening the T6 launch UI.
  // 2026-05-18 ÷3 for display visibility → now 40 min cycle (was 2h).
  ascendant_assembly: {
    cycleSec: 429996.6, // auto-derived (gen-cyclesec): density × footprint × M
    inputs: { reality_anchor: 3, eldritch_processor: 1, ai_core: 5, computing_module: 2 },
    outputs: { ascendant_core: 1 },
    category: 'manufacturing',
  },

  // §13.4 Genesis Cell — T5 transcendent artifact. Spec literal:
  //   4 reality_anchor + 1 zero_point_flux + 2 causal_regulator
  //   + 1 memetic_core + 24h cycle → 1 genesis_cell
  // 86400 sec = 24h is the longest cycle in the catalog; this is a slow
  // late-game build, not a "victory" — the spec is explicit that there is
  // no finish state and the game continues indefinitely.
  // 2026-05-18 ÷3 for display visibility → now 8h cycle (was 24h).
  genesis_forge: {
    cycleSec: 429996.6, // auto-derived (gen-cyclesec): density × footprint × M
    inputs: { reality_anchor: 4, zero_point_flux: 1, causal_regulator: 2, memetic_core: 1 },
    outputs: { genesis_cell: 1 },
    category: 'manufacturing',
  },

  // §7.12 / §11.7 / §14.10: Antimatter Refinery produces Antimatter Propellant
  // (T6 launch fuel). §7.12 spec literal: 30-min cycle ties T6 fuel back to
  // the T4 antimatter chain (antimatter_capsule + plasma_containment_vessel
  // + cryogenic_hydrogen).
  // 2026-05-18 ÷3 for display visibility → now 10-min cycle (was 30 min).
  antimatter_refinery: {
    cycleSec: 600, // pinned: near-zero-mass output (antimatter_propellant 1e-12 kg) — SPEC §14.10 10-min cycle
    inputs: { antimatter_capsule: 1, plasma_containment_vessel: 1, cryogenic_hydrogen: 5 },
    outputs: { antimatter_propellant: 1 },
    category: 'manufacturing',
  },

  // §14.3 / §14.10: Scanner Sat Assembly. 30-min cycle.
  // 2026-05-18 ÷3 for display visibility → now 10-min cycle.
  scanner_sat_assembly: {
    cycleSec: 9555479.1, // auto-derived (gen-cyclesec): density × footprint × M
    inputs: { exotic_alloy: 4, ai_core: 2, spacetime_fragment: 1, aluminum: 50, orbital_insertion_package: 1 },
    outputs: { scanner_sat: 1 },
    category: 'manufacturing',
  },

  // §14.3 / §14.10: Relay Sat Assembly. 30-min cycle.
  // 2026-05-18 ÷3 for display visibility → now 10-min cycle.
  relay_sat_assembly: {
    cycleSec: 9555479.1, // auto-derived (gen-cyclesec): density × footprint × M
    inputs: { exotic_alloy: 6, ai_core: 1, optical_fiber: 200, orbital_insertion_package: 1 },
    outputs: { relay_sat: 1 },
    category: 'manufacturing',
  },

  // §14.3 / §14.10: Sweeper Sat Assembly. 30-min cycle.
  // 2026-05-18 ÷3 for display visibility → now 10-min cycle.
  sweeper_sat_assembly: {
    cycleSec: 9555479.1, // auto-derived (gen-cyclesec): density × footprint × M
    inputs: { exotic_alloy: 4, ai_core: 1, carbon_steel: 100, magnet: 20, orbital_insertion_package: 1 },
    outputs: { sweeper_sat: 1 },
    category: 'manufacturing',
  },

  // §14.3 / §14.10: Mirror Sat Assembly. 30-min cycle. The 150 Aluminum is
  // bulk reflective surface; the 10 Optical Glass is sun-tracking precision
  // optics. Per-sat fields locked at peakBoost=0.7, rHalf=200 tiles.
  // 2026-05-18 ÷3 for display visibility → now 10-min cycle.
  mirror_sat_assembly: {
    cycleSec: 9555479.1, // auto-derived (gen-cyclesec): density × footprint × M
    inputs: { exotic_alloy: 4, ai_core: 1, aluminum: 150, optical_glass: 10, orbital_insertion_package: 1 },
    outputs: { mirror_sat: 1 },
    category: 'manufacturing',
  },

  // §14.7 / §14.10: OIP Assembly produces the T6 Foundation-Kit-equivalent
  // payload required by every §14.7 launch. 30-min cycle.
  // 2026-05-18 ÷3 for display visibility → now 10-min cycle.
  oip_assembly: {
    cycleSec: 9555479.1, // auto-derived (gen-cyclesec): density × footprint × M
    inputs: { iron_ingot: 100, brick: 30, glass: 20, carbon_fiber: 10, ai_core: 5 },
    outputs: { orbital_insertion_package: 1 },
    category: 'manufacturing',
  },

  // §14.12 / §14.10: Repair Pack Assembly. 10-min cycle.
  // 2026-05-18 ÷3 for display visibility → now ~3.3-min cycle (200s).
  repair_pack_assembly: {
    cycleSec: 127.4, // auto-derived (gen-cyclesec): density × footprint × M
    inputs: { exotic_alloy: 1, lubricant: 5, microchip: 5 },
    outputs: { repair_pack: 1 },
    category: 'manufacturing',
  },

  // §14.12 / §14.10: Repair Drone Assembly. 20-min cycle.
  // 2026-05-18 ÷3 for display visibility → now ~6.7-min cycle (400s).
  repair_drone_assembly: {
    cycleSec: 25481.3, // auto-derived (gen-cyclesec): density × footprint × M
    inputs: { exotic_alloy: 2, carbon_steel: 50, foundation_kit: 1 },
    outputs: { repair_drone: 1 },
    category: 'manufacturing',
  },

  // §12.3: Kit Assembler Enriched (T3). 10-min cycle.
  // 2026-05-18 ÷3 for display visibility → now ~3.3-min cycle (200s).
  kit_assembler_enriched: {
    cycleSec: 85999.3, // auto-derived (gen-cyclesec): density × footprint × M
    inputs: { steel: 5, microchip: 1, wire: 5, gear: 5 },
    outputs: { foundation_kit_enriched: 1 },
    category: 'manufacturing',
  },

  // §12.3: Kit Assembler Refined (T4). 20-min cycle.
  // 2026-05-18 ÷3 for display visibility → now ~6.7-min cycle (400s).
  kit_assembler_refined: {
    cycleSec: 101925.1, // auto-derived (gen-cyclesec): density × footprint × M
    inputs: { stainless_steel: 5, quantum_chip: 1, fuel_cell: 1, computing_module: 1 },
    outputs: { foundation_kit_refined: 1 },
    category: 'manufacturing',
  },

  // T3 microchip intermediate chain (§7.7) — pcb, circuit_board, processor,
  // computing_module. pcb_etcher is the first step; its output feeds
  // circuit_assembler, then processor_fab, then compute_module_fab. These
  // T3 electronics intermediates feed T4+ assembly recipes.
  pcb_etcher: {
    cycleSec: 49142.5, // auto-derived (gen-cyclesec): density × footprint × M
    inputs: { wire: 1, glass: 1 },
    outputs: { pcb: 1 },
    category: 'electronics',
  },
  circuit_assembler: {
    // rebalanced step-19 idle-game scale (missed in original sweep)
    cycleSec: 143.3, // auto-derived (gen-cyclesec): density × footprint × M
    inputs: { pcb: 1, microchip: 2, steel: 1 },
    outputs: { circuit_board: 1 },
    category: 'electronics',
  },
  processor_fab: {
    // rebalanced step-19 idle-game scale (missed in original sweep)
    cycleSec: 358330.5, // auto-derived (gen-cyclesec): density × footprint × M
    inputs: { circuit_board: 2, microchip: 4, exotic_alloy: 1 },
    // output doubled: was 1 — XP-net-negative recipe fix (Agent C, VI < 0.15).
    outputs: { processor: 2 },
    category: 'electronics',
  },
  compute_module_fab: {
    // rebalanced step-19 idle-game scale (missed in original sweep)
    cycleSec: 2388869.8, // auto-derived (gen-cyclesec): density × footprint × M
    inputs: { processor: 2, circuit_board: 4, quantum_chip: 1 },
    // output doubled: was 1 — XP-net-negative recipe fix (Agent C, VI < 0.15).
    outputs: { computing_module: 2 },
    category: 'electronics',
  },
  // Phase 6 — T2 mechanical components (§6.3 / §7.1)
  sheet_mill: {
    cycleSec: 18231.9, // auto-derived (gen-cyclesec): density × footprint × M
    inputs: { steel: 53 },
    outputs: { sheet_metal: 10, mill_scale: 3 },
    category: 'manufacturing',
  },
  pipe_mill: {
    cycleSec: 14447.9, // auto-derived (gen-cyclesec): density × footprint × M
    inputs: { steel: 42 },
    outputs: { pipe: 10, mill_scale: 2 },
    category: 'manufacturing',
  },
  beam_mill: {
    cycleSec: 36119.7, // auto-derived (gen-cyclesec): density × footprint × M
    inputs: { steel: 105 },
    outputs: { steel_beam: 2, mill_scale: 5 },
    category: 'manufacturing',
  },
  // Phase 6 — T2 mechanical fasteners (§6.3)
  bearing_assembler: {
    cycleSec: 2665978.7, // auto-derived (gen-cyclesec): density × footprint × M
    inputs: { steel: 28, lubricant: 3 },
    outputs: { bearing: 100, mill_scale: 1 },
    category: 'manufacturing',
  },
  spring_press: {
    cycleSec: 945992.4, // auto-derived (gen-cyclesec): density × footprint × M
    inputs: { steel: 11 },
    outputs: { spring: 50, mill_scale: 1 },
    category: 'manufacturing',
  },
  // Phase 6 — T2 mechanical components (§6.3)
  cable_mill: {
    cycleSec: 14447.9, // auto-derived (gen-cyclesec): density × footprint × M
    inputs: { steel: 42 },
    outputs: { heavy_cable: 5, mill_scale: 2 },
    category: 'manufacturing',
  },
  // Phase 6 — T3 battery (§6.3 / §7.9)
  battery_factory: {
    cycleSec: 119443.5, // auto-derived (gen-cyclesec): density × footprint × M
    inputs: { lithium: 1, rigid_plastic: 1, wire: 2 },
    outputs: { battery: 1 },
    category: 'manufacturing',
  },
  // Phase 6 — T2 glass_panel (§6.3)
  glass_panel_press: {
    cycleSec: 67012.5, // auto-derived (gen-cyclesec): density × footprint × M
    inputs: { glass: 2 },
    outputs: { glass_panel: 1 },
    category: 'manufacturing',
  },
  // Phase 6 — T2 coolant + ceramic_insulator (§6.3)
  coolant_synthesizer: {
    cycleSec: 716.7, // auto-derived (gen-cyclesec): density × footprint × M
    inputs: { fresh_water: 2, salt: 1, naphtha: 1 },
    outputs: { coolant: 2 },
    category: 'chemistry',
  },
  ceramic_kiln: {
    cycleSec: 10749.9, // auto-derived (gen-cyclesec): density × footprint × M
    inputs: { clay: 2, sand: 1 },
    outputs: { ceramic_insulator: 1 },
    category: 'manufacturing',
  },

  // Phase 10 — T3 minerals + alloy (Task 10.1)
  mercury_well: {
    cycleSec: 3440, // auto-derived (gen-cyclesec): density × footprint × M
    inputs: {},
    outputs: { mercury: 1 },
    exogenousFlow: 'terrain',
    category: 'extraction',
  },
  // Phase 10 — T3 minerals + alloy (Task 10.2)
  diamond_quarry: {
    cycleSec: 40, // auto-derived (gen-cyclesec): density × footprint × M
    inputs: {},
    outputs: { diamond_ore: 1 },
    exogenousFlow: 'terrain',
    category: 'extraction',
  },
  // Phase 10 — T3 minerals + alloy (Task 10.3)
  cryo_compound_lab: {
    cycleSec: 19.6, // auto-derived (gen-cyclesec): density × footprint × M
    inputs: { liquid_nitrogen: 1, cryo_coolant: 1 },
    outputs: { cryogenic_compound: 1 },
    category: 'chemistry',
  },
  // Phase 10 — T3 minerals + alloy (Task 10.4)
  mag_alloyer: {
    cycleSec: 2774.2, // auto-derived (gen-cyclesec): density × footprint × M
    inputs: { iron_ingot: 2, rare_earth: 1 },
    outputs: { magnetic_alloy: 1 },
    category: 'manufacturing',
  },
  // Phase 10b — T3 minerals + alloy (Task 10.4.5)
  lithium_extractor: {
    cycleSec: 3440, // auto-derived (gen-cyclesec): density × footprint × M
    inputs: {},
    outputs: { lithium: 1 },
    exogenousFlow: 'terrain',
    category: 'extraction',
  },
  // Phase 10b — T3 power components (Task 10.5)
  mag_forge: {
    cycleSec: 138708.6, // auto-derived (gen-cyclesec): density × footprint × M
    inputs: { magnetic_alloy: 1, wire: 2 },
    outputs: { magnet: 1 },
    category: 'manufacturing',
  },
  // Phase 10b — T3 power components (Task 10.6)
  motor_assembly: {
    cycleSec: 2866.6, // auto-derived (gen-cyclesec): density × footprint × M
    inputs: { magnet: 1, wire: 4, steel: 1 },
    outputs: { electric_motor: 1 },
    category: 'manufacturing',
  },
  // Phase 10b — T3 power components (Task 10.7)
  generator_lab: {
    cycleSec: 14333.2, // auto-derived (gen-cyclesec): density × footprint × M
    inputs: { magnet: 1, wire: 5, steel: 1, bearing: 2 },
    outputs: { generator: 1 },
    category: 'manufacturing',
  },
  // Phase 10c — T3 mechanical assemblies (Task 10.8)
  pump_assembly: {
    cycleSec: 2293.3, // auto-derived (gen-cyclesec): density × footprint × M
    inputs: { electric_motor: 1, pipe: 2, bearing: 1 },
    outputs: { pump: 1 },
    category: 'manufacturing',
  },
  hydraulic_assembly: {
    cycleSec: 4300, // auto-derived (gen-cyclesec): density × footprint × M
    inputs: { pipe: 2, lubricant: 2, bearing: 1, spring: 1 },
    outputs: { hydraulic_actuator: 1 },
    category: 'manufacturing',
  },
  pneumatic_assembly: {
    cycleSec: 2866.6, // auto-derived (gen-cyclesec): density × footprint × M
    inputs: { pipe: 2, bearing: 1, spring: 1 },
    outputs: { pneumatic_actuator: 1 },
    category: 'manufacturing',
  },
  // Phase 10c — T3 power components (Task 10.9)
  solar_cell_lab: {
    cycleSec: 1343739.3, // auto-derived (gen-cyclesec): density × footprint × M
    inputs: { silicon_wafer: 1, glass: 2, aluminum: 1 },
    outputs: { solar_cell: 1 },
    category: 'electronics',
  },
  // Phase 10c — T3 power components (Task 10.10)
  fuel_cell_lab: {
    cycleSec: 1433.3, // auto-derived (gen-cyclesec): density × footprint × M
    inputs: { hydrogen: 2, rare_earth: 1, flexible_plastic: 1 },
    outputs: { fuel_cell: 1 },
    category: 'manufacturing',
  },
  // Phase 10c — T3 glass/ceramics (Task 10.11)
  optical_glass_kiln: {
    cycleSec: 10749.9, // auto-derived (gen-cyclesec): density × footprint × M
    inputs: { quartz: 2 },
    outputs: { optical_glass: 1 },
    category: 'manufacturing',
  },
  // Phase 10c — T3 fiber spinners (Task 10.12)
  glass_fiber_spinner: {
    cycleSec: 67012.5, // auto-derived (gen-cyclesec): density × footprint × M
    inputs: { glass: 2 },
    outputs: { glass_fiber: 3 },
    category: 'manufacturing',
  },
  optical_fiber_drawer: {
    cycleSec: 688, // auto-derived (gen-cyclesec): density × footprint × M
    inputs: { optical_glass: 1 },
    outputs: { optical_fiber: 2 },
    category: 'manufacturing',
  },

  // Phase 16.2 — §6.6 memetic_core producer (Task 16.2). Closes the
  // memetic_core producer gap. T5 building: eldritch + spacetime → memetic_core.
  memetic_forge: {
    cycleSec: 7644383.3, // auto-derived (gen-cyclesec): density × footprint × M
    inputs: { eldritch_processor: 1, spacetime_fragment: 1, ai_core: 2 },
    outputs: { memetic_core: 1 },
    category: 'manufacturing',
  },

  // §13.3 T5 special buildings — activation recipes (Task 12.4).
  // These buildings consume rare inputs to "activate"; the building itself
  // is the reward. Empty outputs so the economy loop treats them as sinks.
  lattice_node: {
    cycleSec: 14400, // 12h — one node per day per island at most.; 2026-05-18 ÷3 for display visibility (was 43200s; now 4h cycle)
    inputs: { reality_anchor: 2, causal_regulator: 4, memetic_core: 1 },
    outputs: {},
    category: 'manufacturing',
  },
  universe_editor: {
    cycleSec: 7200, // 6h; 2026-05-18 ÷3 for display visibility (was 21600s; now 2h cycle)
    inputs: { reality_anchor: 4, dimensional_fold: 1, causal_regulator: 2 },
    outputs: {},
    category: 'manufacturing',
  },
  // Ocean-layer §3 — Task 8 extractor recipes (5 buildings, 12 outputs).
  //
  // Each ocean extractor cycles through its outputs deterministically via
  // `rotateOutputs` (§8.10) — one output per cycle, picked by world-tick
  // index. Mirrors the existing T5 extractor pattern (aetheric_conduit,
  // spacetime_resonator, eldritch_sieve). Cycle times match the post-÷3
  // rebalance scale: extractors typically run 20-60s per cycle (cf. mine=17s,
  // logger=13s) — ocean extractors run slower (60-120s) to reflect the
  // logistic complexity of ocean platforms vs. a simple land mine.
  //
  // No inputs — all five are terrain-tapped raw extractors. Outputs are the
  // 10 new ResourceIds from the resource summary in §3.
  seawater_intake_rig: {
    // §3 catalog: 2 recipes (dilute_brine, trace deuterium).
    cycleSec: 4.1, // auto-derived (gen-cyclesec): density × footprint × M
    inputs: {},
    outputs: { dilute_brine: 1 },
    rotateOutputs: [
      { dilute_brine: 1 },
      { he3_dilute: 1 }, // trace deuterium — same cycle slot, rare alt.
    ],
    category: 'extraction',
  },
  open_water_extractor: {
    // §3 catalog: 2 recipes (concentrated_brine, He-3 dilute).
    cycleSec: 4.1, // auto-derived (gen-cyclesec): density × footprint × M
    inputs: {},
    outputs: { concentrated_brine: 1 },
    rotateOutputs: [
      { concentrated_brine: 1 },
      { he3_dilute: 1 },
    ],
    category: 'extraction',
  },
  nodule_harvester: {
    // §3 catalog: 3 recipes (Mn / Re / Co nodules).
    cycleSec: 4.1, // auto-derived (gen-cyclesec): density × footprint × M
    inputs: {},
    outputs: { mn_nodule: 1 },
    rotateOutputs: [
      { mn_nodule: 1 },
      { re_nodule: 1 },
      { co_nodule: 1 },
    ],
    category: 'extraction',
  },
  trench_drill: {
    // §3 catalog: 3 recipes (methane_hydrate, heavy_isotope_slurry,
    // vent_sulfide). Slower cycle for T4 endgame extractor (cf. drilling_rig
    // at 800s — trench drill is mid-T4, faster than helium_3).
    cycleSec: 4.1, // auto-derived (gen-cyclesec): density × footprint × M
    inputs: {},
    outputs: { methane_hydrate: 1 },
    rotateOutputs: [
      { methane_hydrate: 1 },
      { heavy_isotope_slurry: 1 },
      { vent_sulfide: 1 },
    ],
    category: 'extraction',
  },
  vent_tap: {
    // §3 catalog: 2 recipes (vent_sulfide, vent_exotic).
    cycleSec: 4.1, // auto-derived (gen-cyclesec): density × footprint × M
    inputs: {},
    outputs: { vent_sulfide: 1 },
    rotateOutputs: [
      { vent_sulfide: 1 },
      { vent_exotic: 1 },
    ],
    category: 'extraction',
  },
  // Ocean-layer §3 — Task 9 processor recipes (4 chemistry processors).
  //
  // One recipe per building, keyed by building id (mirrors Task 8). The
  // multi-output processors use `rotateOutputs` to cycle through their
  // catalog of outputs — same §8.10 deterministic rotation as the Task 8
  // extractors. The Geothermal Vent Generator is a passive power source
  // (no recipe; def.power.produces only — cf. solar_panel / nuclear_reactor).
  //
  // **Per-output variant design** for the divergent-feedstock processors
  // (`nodule_concentrator`, `vent_mineral_refinery`). The §3 chain examples
  // list distinct feedstocks for `rare_earth_concentrate` vs `refined_cobalt`
  // (re_nodule + sulfuric_acid vs co_nodule + sulfuric_acid) and for
  // `exotic_alloy_seed` vs `tritium_seed` (vent_exotic + casimir vs
  // heavy_isotope_slurry + casimir). Each building gets ONE RecipeId per
  // output, mirroring `steel_mill_from_scrap`; `resolveRecipe` routes by
  // inventory presence so each cycle burns only the feedstock(s) the chosen
  // output actually needs. The base `nodule_concentrator` /
  // `vent_mineral_refinery` ids are NOT in the RECIPES map — callers go
  // through `resolveRecipe` and receive the per-output variant.
  //
  // Restores spec-aligned 1:1 feedstock-to-output cost. (The original
  // combined-inputs + rotateOutputs shape — superseded — burnt the union
  // every cycle and produced only one rotation output, wasting half/two
  // thirds of the feedstock per cycle.)
  //
  // Cycle times match the post-÷3 rebalance scale per tier:
  //   T3 chemistry intermediate (Brine Distillation): 120s.
  //   T4 chemistry intermediate (Nodule Concentrator variants): 240s.
  //   T5 chemistry final (Vent Mineral Refinery variants): 480s.
  //   T5 chemistry final (Heavy Water Distiller): 360s.
  brine_distillation_rig: {
    // §3 chain example (Lithium): Seawater Intake → dilute_brine →
    // Brine Distillation Rig → lithium_brine. We rotate three outputs
    // (lithium_brine, salt, bromine) per the catalog "3 recipes" row.
    // The three rotation outputs share a common feedstock (dilute_brine)
    // so rotateOutputs remains the correct shape here — unlike the
    // nodule_concentrator / vent_mineral_refinery cases where the §3
    // chain examples specify distinct per-output feedstocks.
    cycleSec: 19.6, // auto-derived (gen-cyclesec): density × footprint × M
    inputs: { dilute_brine: 5 },
    outputs: { lithium_brine: 1 },
    rotateOutputs: [
      { lithium_brine: 1 },
      { salt: 2 }, // salt re-uses existing chemistry-chain salt id.
      { bromine: 1 },
    ],
    category: 'chemistry',
  },
  // Nodule Concentrator per-output variants. See block comment above.
  nodule_concentrator_re: {
    cycleSec: 347.5, // auto-derived (gen-cyclesec): density × footprint × M
    inputs: { re_nodule: 2, sulfuric_acid: 1 },
    outputs: { rare_earth_concentrate: 1 },
    category: 'chemistry',
  },
  nodule_concentrator_co: {
    cycleSec: 347.5, // auto-derived (gen-cyclesec): density × footprint × M
    inputs: { co_nodule: 2, sulfuric_acid: 1 },
    outputs: { refined_cobalt: 1 },
    category: 'chemistry',
  },
  // Vent Mineral Refinery per-output variants. See block comment above.
  // Casimir_energy gates both per §8.10 Casimir Tap T5 exotic gating.
  vent_mineral_refinery_exotic: {
    cycleSec: 347.5, // auto-derived (gen-cyclesec): density × footprint × M
    inputs: { vent_exotic: 1, casimir_energy: 1 },
    outputs: { exotic_alloy_seed: 1 },
    category: 'chemistry',
  },
  vent_mineral_refinery_tritium: {
    cycleSec: 347.5, // auto-derived (gen-cyclesec): density × footprint × M
    inputs: { heavy_isotope_slurry: 1, casimir_energy: 1 },
    outputs: { tritium_seed: 1 },
    category: 'chemistry',
  },
  heavy_water_distiller: {
    // §3 chain example (Heavy water): Open-Water Extractor →
    // concentrated_brine → Heavy Water Distiller → heavy_water. Single
    // output, no rotation. Per §3 design doc the only input is
    // concentrated_brine — the earlier microchip co-input was an overreach
    // (rationale referenced "precision control electronics", but the spec
    // lists no such input).
    cycleSec: 19.6, // auto-derived (gen-cyclesec): density × footprint × M
    inputs: { concentrated_brine: 4 },
    outputs: { heavy_water: 1 },
    category: 'chemistry',
  },
  // §si-units rev-16 §7.4 — synthetic no-op recipe for CO₂ sink.
  plant_a_tree: {
    cycleSec: 60,
    inputs: {},
    outputs: {},
    category: 'environment',
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

const SPECIAL_RECIPE_IDS = new Set<RecipeId>([
  'mine_on_ore',
  'mine_on_coal',
  'steel_mill_from_scrap',
  'nodule_concentrator_re',
  'nodule_concentrator_co',
  'vent_mineral_refinery_exotic',
  'vent_mineral_refinery_tritium',
]);
export const BASE_RECIPES: Partial<Record<BuildingDefId, Recipe[]>> = {};
for (const [id, recipe] of Object.entries(RECIPES)) {
  if (recipe && !SPECIAL_RECIPE_IDS.has(id as RecipeId)) {
    BASE_RECIPES[id as BuildingDefId] = [recipe];
  }
}

export function availableRecipes(
  buildingDefId: BuildingDefId,
  state: IslandState,
  graph?: Graph,
): Recipe[] {
  const base = BASE_RECIPES[buildingDefId] ?? [];
  const unlocked: Recipe[] = [];
  const nodes = graph?.nodes ?? [];
  for (const nodeId of state.unlockedNodes) {
    const node = nodes.find((n) => n.id === nodeId);
    if (node?.effect.kind === 'unlockRecipe' && node.effect.targetBuilding === buildingDefId) {
      unlocked.push(node.effect.recipe);
    }
  }
  return [...base, ...unlocked];
}

export function resolveRecipe(
  def: BuildingDef,
  b: PlacedBuilding,
  terrainAt?: (x: number, y: number) => TerrainKind,
  inventory?: Partial<Record<ResourceId, number>>,
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
  // §6.7 Steel Mill scrap substitution. Choice is per-tick, driven by the
  // current inventory snapshot. Prefer pig_iron whenever any is on hand;
  // fall back to the scrap variant only when the pig_iron stockpile is
  // empty AND scrap is available. With both stockpiles empty the resolver
  // returns the base recipe so `inputAvail` surfaces the pig_iron shortage
  // in the usual way (returning the scrap variant when neither input is
  // present would mask the real bottleneck behind a less-visible one).
  // Mixed-input cycles are out of scope: the spec literal is "produces
  // the same output rate either way", and `findNextCapEvent` will trip
  // on pig_iron hitting 0 so the segment boundary naturally re-resolves
  // to the scrap variant when the stockpile runs out.
  if (def.id === 'steel_mill' && inventory) {
    const pigIron = inventory.pig_iron ?? 0;
    const scrap = inventory.scrap ?? 0;
    if (pigIron <= 0 && scrap > 0) {
      return RECIPES.steel_mill_from_scrap;
    }
  }
  // Nodule Concentrator per-output routing. The two feedstocks are peers
  // (no "preferred" path like steel_mill's pig_iron over scrap), so the
  // rule is just inventory presence: re_nodule on hand → run the _re
  // variant; else co_nodule on hand → run _co. When both are empty, fall
  // back to _re so `inputAvail` surfaces the re_nodule shortage in the
  // usual way (returning undefined would silently no-op the building, and
  // there is no terrain-validation invariant that guarantees feedstock
  // presence the way `requiredTile` does for Mine). The piecewise
  // integrator re-resolves at each cap event, so the choice flips
  // automatically when one stockpile depletes.
  if (def.id === 'nodule_concentrator') {
    if (inventory) {
      const re = inventory.re_nodule ?? 0;
      const co = inventory.co_nodule ?? 0;
      if (re <= 0 && co > 0) {
        return RECIPES.nodule_concentrator_co;
      }
    }
    return RECIPES.nodule_concentrator_re;
  }
  // Vent Mineral Refinery per-output routing. Same pattern: vent_exotic →
  // _exotic variant; else heavy_isotope_slurry → _tritium variant; else
  // _exotic as the bottleneck-surfacing default.
  if (def.id === 'vent_mineral_refinery') {
    if (inventory) {
      const ex = inventory.vent_exotic ?? 0;
      const tr = inventory.heavy_isotope_slurry ?? 0;
      if (ex <= 0 && tr > 0) {
        return RECIPES.vent_mineral_refinery_tritium;
      }
    }
    return RECIPES.vent_mineral_refinery_exotic;
  }
  // §3.9 cohort — sheet_metal_mill building uses sheet_mill recipe (renamed
  // per rev-16 §3.9 cohort discipline; building id unchanged).
  if (def.id === 'sheet_metal_mill') {
    return RECIPES.sheet_mill;
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

