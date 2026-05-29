// Canonical source for the cycleSec rebalance. See
// docs/superpowers/specs/2026-05-29-throughput-density-table.md for provenance.
import type { BuildingDefId } from './building-defs.js';
import { RESOURCE_META } from './recipes.js';

/** Global pace multiplier: fixes a 1-floor Mine to 20 s — 1/(8.6 × 4 × 20). */
export const M = 1.4535e-3;

/** Areal throughput density (kg·s⁻¹·m⁻²) per archetype (real 24/7 nameplate). */
export const ARCHETYPE_DENSITY = {
  hard_rock_mining: 8.6, water_pump: 42, logging: 0.49, oil_gas_well: 0.40,
  surface_quarry: 4.3, deep_drill: 0.05, blast_furnace: 0.75, bof_steel: 2.1,
  eaf_steel: 1.3, nonferrous_smelter: 0.062, aluminum: 1.4e-4, cement_kiln: 0.19,
  lime_kiln: 0.036, brick_ceramic_kiln: 0.016, coke_oven: 0.008, glass_furnace: 0.0077,
  crude_refining: 2.8, air_separation: 3.9, electrolysis: 0.03, acids: 0.22,
  polymers: 0.48, rolling_mill: 0.5, machining: 0.002, assembly: 0.6,
  battery_cells: 0.0032, wafer_fab: 6.4e-5, pcb_fab: 7e-4,
  // fantasy / endgame (no real basis — tier-anchored, see spec §3 / table §03)
  fantasy_quantum_chip: 2e-5, fantasy_ai_core: 6e-6, fantasy_exotic_alloy: 0.02,
  fantasy_carbon_fiber: 0.05, fantasy_reality: 1e-3, fantasy_casimir: 4e-3,
  fantasy_t4: 1e-4, fantasy_t5: 1e-5, fantasy_t6: 1e-6, fantasy_satellite: 4e-3,
} as const;
export type Archetype = keyof typeof ARCHETYPE_DENSITY;

/** Each recipe-bearing building → its archetype. (From the companion building→archetype map.) */
export const BUILDING_ARCHETYPE: Partial<Record<BuildingDefId, Archetype>> = {
  // extraction
  mine: 'hard_rock_mining', deep_mine: 'hard_rock_mining',
  copper_mine: 'hard_rock_mining', tin_mine: 'hard_rock_mining', lead_mine: 'hard_rock_mining',
  bauxite_mine: 'hard_rock_mining', manganese_mine: 'hard_rock_mining', zinc_mine: 'hard_rock_mining',
  chromium_mine: 'hard_rock_mining', nickel_mine: 'hard_rock_mining', tungsten_mine: 'hard_rock_mining',
  sulfur_mine: 'hard_rock_mining', phosphate_mine: 'hard_rock_mining', graphite_mine: 'hard_rock_mining',
  quarry: 'surface_quarry', quartz_mine: 'surface_quarry', limestone_quarry: 'surface_quarry',
  sand_pit: 'surface_quarry', clay_pit_extractor: 'surface_quarry', diamond_quarry: 'surface_quarry',
  uranium_mine: 'deep_drill', mercury_well: 'deep_drill', lithium_extractor: 'deep_drill', drilling_rig: 'deep_drill',
  pump_jack: 'oil_gas_well', gas_extractor: 'oil_gas_well',
  well: 'water_pump', coastal_pump: 'water_pump', seawater_intake_rig: 'water_pump',
  open_water_extractor: 'water_pump', nodule_harvester: 'water_pump', trench_drill: 'water_pump', vent_tap: 'water_pump',
  logger: 'logging', heavy_logger: 'logging',
  // smelting
  smelter: 'blast_furnace', blast_furnace: 'blast_furnace',
  steel_mill: 'bof_steel', steel_mill_scrap: 'bof_steel', oxygen_converter: 'bof_steel',
  electric_arc_furnace: 'eaf_steel',
  copper_smelter: 'nonferrous_smelter', tin_smelter: 'nonferrous_smelter', lead_smelter: 'nonferrous_smelter',
  zinc_smelter: 'nonferrous_smelter', chromium_smelter: 'nonferrous_smelter', nickel_smelter: 'nonferrous_smelter',
  tungsten_smelter: 'nonferrous_smelter', manganese_smelter: 'nonferrous_smelter',
  silicon_crusher: 'nonferrous_smelter', slag_reprocessor: 'nonferrous_smelter', alumina_refinery: 'nonferrous_smelter',
  aluminum_smelter: 'aluminum', coke_oven: 'coke_oven', charcoal_kiln: 'coke_oven',
  // kilns
  limekiln: 'lime_kiln', lime_slaker: 'cement_kiln', cement_mill: 'cement_kiln',
  concrete_plant: 'cement_kiln', mortar_mixer: 'cement_kiln',
  brick_kiln: 'brick_ceramic_kiln', ceramic_kiln: 'brick_ceramic_kiln', optical_glass_kiln: 'brick_ceramic_kiln',
  glassworks: 'glass_furnace', glass_panel_press: 'glass_furnace',
  // chemistry
  electrolyzer: 'electrolysis', chlor_alkali_plant: 'electrolysis',
  sulfuric_acid_plant: 'acids', hcl_plant: 'acids', phosphor_plant: 'acids', chemical_reactor: 'acids',
  air_separator: 'air_separation', cryo_air_separator: 'air_separation', cryo_lab: 'air_separation',
  cryo_compressor: 'air_separation', cryogenic_generator: 'air_separation', cryo_compound_lab: 'air_separation',
  naphtha_cracker: 'crude_refining', crude_oil_cracker: 'crude_refining', diesel_refinery: 'crude_refining',
  kerosene_refinery: 'crude_refining', lubricant_refinery: 'crude_refining',
  plastic_polymerizer_a: 'polymers', rubber_synthesizer: 'polymers', coolant_synthesizer: 'polymers', biofuel_plant: 'polymers',
  rigid_plastic_press: 'polymers', flexible_plastic_press: 'polymers',
  evaporator: 'lime_kiln', brine_distillation_rig: 'air_separation', nodule_concentrator: 'acids',
  vent_mineral_refinery: 'acids', heavy_water_distiller: 'air_separation',
  // manufacturing
  workshop: 'machining', assembler: 'assembly', kit_assembler: 'assembly',
  kit_assembler_enriched: 'assembly', kit_assembler_refined: 'assembly',
  bearing_assembler: 'machining', spring_press: 'machining',
  solder_alloyer: 'nonferrous_smelter', bronze_alloyer: 'nonferrous_smelter', brass_alloyer: 'nonferrous_smelter',
  mag_alloyer: 'nonferrous_smelter', mag_forge: 'nonferrous_smelter',
  motor_assembly: 'assembly', pump_assembly: 'assembly', hydraulic_assembly: 'assembly', pneumatic_assembly: 'assembly',
  generator_lab: 'assembly', fuel_cell_lab: 'assembly', fuel_rod_assembler: 'assembly',
  plasma_containment_assembler: 'assembly', cryo_containment_assembler: 'assembly', self_replication_lab: 'assembly',
  sheet_metal_mill: 'rolling_mill', pipe_mill: 'rolling_mill', beam_mill: 'rolling_mill', cable_mill: 'rolling_mill',
  metal_rolling_mill: 'rolling_mill', galvanizing_bath: 'rolling_mill', carbon_steel_mill: 'rolling_mill',
  stainless_steel_mill: 'rolling_mill', tool_steel_mill: 'rolling_mill',
  plank_mill: 'machining', lumber_mill: 'machining', battery_factory: 'battery_cells',
  glass_fiber_spinner: 'glass_furnace', optical_fiber_drawer: 'rolling_mill',
  // electronics
  pcb_etcher: 'pcb_fab', lithography_lab: 'wafer_fab', wafer_lab: 'wafer_fab',
  processor_fab: 'wafer_fab', compute_module_fab: 'wafer_fab',
  transistor_doping: 'wafer_fab', capacitor_doping: 'wafer_fab', resistor_doping: 'wafer_fab',
  memory_lab: 'wafer_fab', circuit_assembler: 'assembly', solar_cell_lab: 'wafer_fab',
  singularity_sensor_lab: 'wafer_fab', accelerator_core_lab: 'assembly',
  // fantasy / endgame
  quantum_chip_fab: 'fantasy_quantum_chip', cryogenic_compute_center: 'fantasy_ai_core',
  pyroforge: 'fantasy_exotic_alloy', carbon_forge: 'fantasy_carbon_fiber',
  reality_forge: 'fantasy_reality', casimir_tap: 'fantasy_casimir',
  particle_accelerator: 'fantasy_t4', quantum_manipulator: 'fantasy_t4',
  // power / special (no real analog; anchored to nearest real archetype or tier band)
  cell_press: 'battery_cells',
  coal_gen: 'assembly', biomass_plant: 'assembly', nuclear_reactor: 'assembly',
  fusion_core: 'fantasy_t4',
  plant_a_tree: 'assembly',
  // T5 endgame labs / extractors / forges / special (tier-scaled fantasy)
  aetheric_conduit: 'fantasy_t5', spacetime_resonator: 'fantasy_t5', eldritch_sieve: 'fantasy_t5',
  zero_point_extractor: 'fantasy_t5', neutronium_extractor: 'fantasy_t5',
  probability_calculator_lab: 'fantasy_t5', dimensional_fold_lab: 'fantasy_t5',
  causal_regulator_lab: 'fantasy_t5', tachyonic_transmitter_lab: 'fantasy_t5',
  aether_beacon_lab: 'fantasy_t5', reality_engine_lab: 'fantasy_t5',
  singularity_battery_factory: 'battery_cells',
  lattice_node: 'fantasy_t5', universe_editor: 'fantasy_t5',
  plasma_forge: 'fantasy_t5', eldritch_refiner: 'fantasy_t5', phase_refiner: 'fantasy_t5',
  memetic_forge: 'fantasy_t5', genesis_forge: 'fantasy_t4', ascendant_assembly: 'fantasy_t4',
  // T6 satellite assemblies + manufacturing
  scanner_sat_assembly: 'fantasy_satellite', relay_sat_assembly: 'fantasy_satellite',
  sweeper_sat_assembly: 'fantasy_satellite', mirror_sat_assembly: 'fantasy_satellite',
  oip_assembly: 'fantasy_satellite',
  repair_pack_assembly: 'assembly', repair_drone_assembly: 'assembly',
  antimatter_refinery: 'fantasy_t6',
  skill_forge: 'assembly',
};

/** Recipe id → building id. Most recipe ids equal a building id; tile/scrap
 *  variants resolve to their base building. */
export function buildingForRecipe(recipeId: string): BuildingDefId {
  const variant: Record<string, string> = {
    mine_on_ore: 'mine', mine_on_coal: 'mine',
    steel_mill_from_scrap: 'steel_mill_scrap',
    sheet_mill: 'sheet_metal_mill',
    nodule_concentrator_re: 'nodule_concentrator',
    nodule_concentrator_co: 'nodule_concentrator',
    vent_mineral_refinery_exotic: 'vent_mineral_refinery',
    vent_mineral_refinery_tritium: 'vent_mineral_refinery',
  };
  if (recipeId.startsWith('skill_forge_')) return 'skill_forge';
  return (variant[recipeId] ?? recipeId) as BuildingDefId;
}

/** Recipe id → its archetype key (undefined if unmapped). */
export function archetypeForRecipe(recipeId: string): Archetype | undefined {
  return BUILDING_ARCHETYPE[buildingForRecipe(recipeId)];
}

/** Recipe id → areal density. Throws if unmapped (the coverage test forbids that). */
export function densityForRecipe(recipeId: string): number {
  const arch = archetypeForRecipe(recipeId);
  if (!arch) throw new Error(`no archetype for building ${buildingForRecipe(recipeId)} (recipe ${recipeId})`);
  return ARCHETYPE_DENSITY[arch];
}

/** Total output mass (kg) of one recipe cycle, summed over all outputs.
 *  Unknown resources default to 1 kg/unit (matches the generator's prior behavior). */
export function outputKg(recipe: { outputs?: Partial<Record<string, number>> }): number {
  let kg = 0;
  for (const [r, n] of Object.entries(recipe.outputs ?? {})) {
    kg += (n ?? 0) * (RESOURCE_META[r as keyof typeof RESOURCE_META]?.massPerUnitKg ?? 1);
  }
  return kg;
}

/** Whether a recipe's cycleSec should be physics-derived (density × footprint × M).
 *  EXCLUDES power generators (cycleSec governs fuel burn / power cadence, not material
 *  throughput) and any recipe with no material output mass (formula is undefined → would
 *  floor to a bogus 1s). Spec companion table §10. Both the generator and the cycleSec
 *  sanity test import THIS predicate so they can never diverge. */
export function shouldDeriveCycleSec(recipe: { outputs?: Partial<Record<string, number>>; category?: string }): boolean {
  return recipe.category !== 'power' && outputKg(recipe) > 0;
}
