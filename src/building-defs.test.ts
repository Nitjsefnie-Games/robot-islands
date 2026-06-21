// Building catalog completeness + tier-gating tests per SPEC §9.2.
//
// Every BuildingDefId in the type literal MUST have a corresponding entry
// in BUILDING_DEFS — otherwise indexed access `BUILDING_DEFS[b.defId]`
// returns undefined at runtime and rendering / economy lookups silently
// break. `noUncheckedIndexedAccess` only catches array reads; Record
// reads are fine until the runtime lookup fails.

import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';

import {
  ALL_BUILDING_DEF_IDS,
  BUILDING_DEFS,
  CATEGORY_ADJACENCY_RATE,
  LAND_TILE_COST,
  buildingUnlocked,
  canPlaceOnIsland,
  unlockedDefs,
  type BuildingDefId,
} from './building-defs.js';
import { SHAPES, shapeHeight, shapeWidth } from './shape-mask.js';
import { RECIPES, RESOURCE_META, type ResourceId } from './recipes.js';
import { buildingForRecipe } from './recipe-density.js';
import type { IslandSpec } from './world.js';

// Hand-mirrored list of every id in the union. If a new id is added to
// BuildingDefId, both this list AND BUILDING_DEFS must grow together —
// the completeness test below catches drift.
const KNOWN_DEF_IDS: ReadonlyArray<BuildingDefId> = [
  'iron_mine',
  'workshop',
  'solar',
  'coal_gen',
  'dock',
  'dronepad',
  'patron_hub',
  'logger',
  'smelter',
  'crate',
  'demolition_yard',
  'silo',
  'biomass_plant',
  'coke_oven',
  'blast_furnace',
  'steel_mill',
  'steel_mill_scrap',
  'oxygen_converter',
  'slag_reprocessor',
  'assembler',
  'tank',
  'cold_storage',
  'component_warehouse',
  'electric_arc_furnace',
  'vault',
  'platform_constructor',
  // Step-12 T4 endgame (§6.5 / §9.5)
  'fusion_core',
  'pyroforge',
  'cryogenic_compute_center',
  'particle_accelerator',
  'launch_tower',
  'quantum_manipulator',
  'quantum_chip_fab',
  'fuel_rod_assembler',
  'plasma_containment_assembler',
  'singularity_sensor_lab',
  'cryo_containment_assembler',
  'accelerator_core_lab',
  'self_replication_lab',
  // §04: Skill Forge — T4 production building for crafting Skill Crystals.
  'skill_forge',
  // §9.5 biome-locked uniques (Mass Driver + Carbon Forge + Tidal Array + Sunspire)
  'mass_driver',
  'carbon_forge',
  'tidal_array',
  'sunspire',
  // Step-13 T5 transcendent (§13.2 / §8.4 / §8.5 / §8.9)
  'casimir_tap',
  'reality_forge',
  'singularity_battery',
  'time_lock',
  'genesis_chamber',
  'universe_editor',
  'lattice_node',
  // §11.6 / §13.3
  'path_drone_foundry',
  'probability_engine',
  // Step-20 T5→T6 transition + T6 Orbital (§13.4 / §14.2 / §14.10)
  'ascendant_assembly',
  'spaceport',
  'orbital_tracking_station',
  'antimatter_refinery',
  'scanner_sat_assembly',
  'relay_sat_assembly',
  'mirror_sat_assembly',
  'oip_assembly',
  'repair_drone_assembly',
  // Step-18 recipe-graph closure (§7.1-§7.12)
  'quarry',
  'sand_pit',
  'well',
  'coastal_pump',
  // §15.6 saltwater-cell bootstrap — registered with the T1 manufacturing-adjacent block.
  'cell_press',
  'quartz_mine',
  'lumber_mill',
  'glassworks',
  'evaporator',
  'electrolyzer',
  'biofuel_plant',
  'pump_jack',
  'gas_extractor',
  'naphtha_cracker',
  'crude_oil_cracker',
  'tar_refinery',
  'vapor_condenser',
  'cryo_reliquefier',
  'mill_scale_sinter',
  'plastic_polymerizer_a',
  'rigid_plastic_press',
  'flexible_plastic_press',
  'rubber_synthesizer',
  'sulfuric_acid_plant',
  'hcl_plant',
  'phosphor_plant',
  'chlor_alkali_plant',
  'chemical_reactor',
  'lubricant_refinery',
  'diesel_refinery',
  'metal_rolling_mill',
  'silicon_crusher',
  'air_separator',
  'cryo_air_separator',
  'cryo_lab',
  'cryo_compressor',
  'kerosene_refinery',
  'lithography_lab',
  'pcb_etcher',
  'circuit_assembler',
  'processor_fab',
  'compute_module_fab',
  'drilling_rig',
  'limestone_quarry',
  'clay_pit_extractor',
  'sulfur_mine',
  'phosphate_mine',
  'graphite_mine',
  'copper_mine',
  'tin_mine',
  'lead_mine',
  'bauxite_mine',
  // Phase 3 — T2 steel alloy chains (§6.1 / §7.1)
  'manganese_mine',
  'manganese_smelter',
  'carbon_steel_mill',
  'zinc_mine',
  'zinc_smelter',
  'galvanizing_bath',
  'chromium_mine',
  'chromium_smelter',
  'nickel_mine',
  'nickel_smelter',
  'stainless_steel_mill',
  'tungsten_mine',
  'tungsten_smelter',
  'tool_steel_mill',
  // Phase 2 — T1 refined chains (§6.2 / §7.5)
  'limekiln',
  'lime_slaker',
  'brick_kiln',
  'aetheric_conduit',
  'spacetime_resonator',
  'eldritch_sieve',
  'plasma_forge',
  'eldritch_refiner',
  'phase_refiner',
  // §5.2 / §8.6 Heat Sources
  'coal_furnace',
  'geothermal_vent',
  'plasma_heater',
  // Lighthouse vision tiers (§15.x — Lighthouse vision)
  'lighthouse_t1',
  'lighthouse_t2',
  'lighthouse_t3',
  'lighthouse_t4',
  'lighthouse_t5',
  'lighthouse_t6',
  // §11 telemetry antennas (Antenna placeholder — tune in Appendix A)
  'antenna_t1',
  'antenna_t2',
  'antenna_t3',
  'antenna_t4',
  'antenna_t5',
  'antenna_t6',
  // §2.6 weather stations
  'weather_station_t2',
  'advanced_weather_station_t3',
  // §8.1 T2 extraction
  'heavy_logger',
  'deep_mine',
  // §8.5 power generation
  'wind_turbine',
  'cryogenic_generator',
  'nuclear_reactor',
  // §8.7 cooling / treatment
  'cooling_tower',
  'wastewater_treatment',
  'exhaust_scrubber',
  // §8.8 / §8.9 logistics + special buildings
  'airship_dock',
  'teleporter_pad',
  'spacetime_anchor',
  'power_substation',
  'terrain_modifier',
  // Phase 6 — T2 mechanical components (§6.3)
  'sheet_metal_mill',
  'pipe_mill',
  'beam_mill',
  'bearing_assembler',
  'spring_press',
  'cable_mill',
  'battery_factory',
  'glass_panel_press',
  'coolant_synthesizer',
  'ceramic_kiln',
  // Phase 9 — Electronics chain (§7.7)
  'wafer_lab',
  'transistor_doping',
  'capacitor_doping',
  'resistor_doping',
  // T3 minerals + alloy
  'mercury_well',
  'diamond_quarry',
  'cryo_compound_lab',
  'mag_alloyer',
  'lithium_extractor',
  // T3 power components
  'mag_forge',
  'motor_assembly',
  'generator_lab',
  // T3 mechanical assemblies
  'hydraulic_assembly',
  'pneumatic_assembly',
  'fuel_cell_lab',
  // T3 glass/ceramics + fiber spinners
  'optical_glass_kiln',
  'glass_fiber_spinner',
  'optical_fiber_drawer',
  // Foundation Kit variants
  'kit_assembler_enriched',
  'kit_assembler_refined',
  // T2-T4 battery defs
  'battery_bank',
  'capacitor_bank',
  'flywheel_array',
];

// Helper: build a minimal IslandSpec for the canPlaceOnIsland tests. The
// pure helper only reads `biome` and `artificial`, so we can elide the
// other fields safely behind the IslandSpec contract.
function fakeSpec(biome: IslandSpec['biome'], artificial = false): IslandSpec {
  return {
    id: 'test',
    name: 'test',
    biome,
    cx: 0,
    cy: 0,
    majorRadius: 4,
    minorRadius: 4,
    populated: true,
    discovered: true,
    buildings: [],
    modifiers: [],
    artificial,
  };
}

describe('BUILDING_DEFS catalog', () => {
  it('every BuildingDefId in the union has a def entry', () => {
    for (const id of KNOWN_DEF_IDS) {
      const def = BUILDING_DEFS[id];
      expect(def, `missing def for ${id}`).toBeDefined();
      expect(def.id).toBe(id);
    }
  });

  it('ALL_BUILDING_DEF_IDS matches the BUILDING_DEFS keyset', () => {
    const keys = Object.keys(BUILDING_DEFS).sort();
    const list = [...ALL_BUILDING_DEF_IDS].sort();
    expect(list).toEqual(keys);
  });

  it('coal_gen produces 5 MW (5000 kW) of power (energy SI rebalance)', () => {
    expect(BUILDING_DEFS.coal_gen.power?.produces).toBe(5000);
  });

  it('electric_arc_furnace is pure-electric 10 MW (no requiresHeat)', () => {
    expect(BUILDING_DEFS.electric_arc_furnace.power?.consumes).toBe(10000);
    expect(BUILDING_DEFS.electric_arc_furnace.requiresHeat).toBeFalsy();
  });
  it('aluminum_smelter draws 10 MW (Hall-Héroult electrolysis)', () => {
    expect(BUILDING_DEFS.aluminum_smelter.power?.consumes).toBe(10000);
  });

  it('consumer tier nudges land at SI kW', () => {
    expect(BUILDING_DEFS.quarry.power?.consumes).toBe(25);
    expect(BUILDING_DEFS.chromium_smelter.power?.consumes).toBe(80);
    expect(BUILDING_DEFS.glass_fiber_spinner.power?.consumes).toBe(200);
  });

  it('every def declares positive integer footprint dimensions', () => {
    for (const id of KNOWN_DEF_IDS) {
      const def = BUILDING_DEFS[id];
      expect(shapeWidth(def.footprint)).toBeGreaterThan(0);
      expect(shapeHeight(def.footprint)).toBeGreaterThan(0);
      expect(Number.isInteger(shapeWidth(def.footprint))).toBe(true);
      expect(Number.isInteger(shapeHeight(def.footprint))).toBe(true);
    }
  });

  it('tier is within 1..6', () => {
    for (const id of KNOWN_DEF_IDS) {
      const tier = BUILDING_DEFS[id].tier;
      expect(tier).toBeGreaterThanOrEqual(1);
      expect(tier).toBeLessThanOrEqual(6);
    }
  });

  it('every def declares a non-empty glyph (visual polish)', () => {
    // Visual-polish contract: `renderBuildings` stamps a centred glyph on
    // every footprint so the schematic reads at a glance. A missing glyph
    // would render as an empty Text node — silently invisible. Catch that
    // at the catalog level.
    for (const id of KNOWN_DEF_IDS) {
      const def = BUILDING_DEFS[id];
      expect(def.glyph, `missing glyph for ${id}`).toBeDefined();
      expect(def.glyph.length, `glyph for ${id} is empty`).toBeGreaterThan(0);
    }
  });

  it('storage defs declare categorized storage; others do not', () => {
    // §4.6 categorized routing: storage carries { category, capacity }, where
    // `capacity` is a percentage MULTIPLIER (contribution = capacity × base cap).
    expect(BUILDING_DEFS.crate.storage).toEqual({ category: 'generic', capacity: 5 });
    expect(BUILDING_DEFS.silo.storage).toEqual({ category: 'dry_goods', capacity: 2000 });
    expect(BUILDING_DEFS.tank.storage).toEqual({ category: 'liquid_gas', capacity: 1000 });
    expect(BUILDING_DEFS.cold_storage.storage).toEqual({ category: 'temp_sensitive', capacity: 1000 });
    expect(BUILDING_DEFS.component_warehouse.storage).toEqual({ category: 'components', capacity: 1000 });
    expect(BUILDING_DEFS.vault.storage).toEqual({ category: 'rare', capacity: 1000 });
    // Non-storage defs must not declare `storage` (would silently
    // contribute to aggregateStorageCaps otherwise).
    expect(BUILDING_DEFS.iron_mine.storage).toBeUndefined();
    expect(BUILDING_DEFS.workshop.storage).toBeUndefined();
    expect(BUILDING_DEFS.solar.storage).toBeUndefined();
  });

  it('demolition_yard is a T1 special building with a 2x2 footprint and power draw', () => {
    const d = BUILDING_DEFS.demolition_yard;
    expect(d.category).toBe('special');
    expect(d.tier).toBe(1);
    expect(d.footprint.tiles).toHaveLength(4); // square2
    expect(d.power?.consumes).toBe(20);
    expect(d.placementCost).toEqual({ stone: 100, wood: 60, iron_ingot: 20 });
    expect(d.requiredBiomes).toBeUndefined();
  });

  describe('§6.4 mercury_well (T3 mercury extractor)', () => {
    it('is T3 extraction gated to mercury_pit tile', () => {
      const def = BUILDING_DEFS.mercury_well;
      expect(def).toBeDefined();
      expect(def.tier).toBe(3);
      expect(def.category).toBe('extraction');
      expect(def.requiredTile).toEqual(['mercury_pit']);
    });
    it('produces 1 mercury per cycle', () => {
      expect(RECIPES.mercury_well).toBeDefined();
      expect(RECIPES.mercury_well!.outputs).toEqual({ mercury: 1 });
    });
  });

  describe('§6.4 diamond_quarry (T3 diamond_ore extractor)', () => {
    it('is T3 extraction gated to diamond_vein tile', () => {
      const def = BUILDING_DEFS.diamond_quarry;
      expect(def).toBeDefined();
      expect(def.tier).toBe(3);
      expect(def.category).toBe('extraction');
      expect(def.requiredTile).toEqual(['diamond_vein']);
    });
    it('produces 1 diamond_ore per cycle', () => {
      expect(RECIPES.diamond_quarry).toBeDefined();
      expect(RECIPES.diamond_quarry!.outputs).toEqual({ diamond_ore: 1 });
    });
  });

  describe('§6.4 cryo_compound_lab (T3 cryogenic_compound producer)', () => {
    it('is T3, 3x3, chemistry category', () => {
      const def = BUILDING_DEFS.cryo_compound_lab;
      expect(def).toBeDefined();
      expect(def.tier).toBe(3);
      expect(def.footprint.tiles.length).toBe(9);
      expect(def.category).toBe('chemistry');
    });
    it('produces cryogenic_compound from liquid_nitrogen + cryo_coolant', () => {
      expect(RECIPES.cryo_compound_lab).toBeDefined();
      expect(RECIPES.cryo_compound_lab!.inputs).toEqual({ liquid_nitrogen: 1, cryo_coolant: 1 });
      expect(RECIPES.cryo_compound_lab!.outputs).toEqual({ cryogenic_compound: 1 });
    });
  });

  describe('§6.4 mag_alloyer (T3 magnetic_alloy producer)', () => {
    it('is T3, 2x2, manufacturing category', () => {
      const def = BUILDING_DEFS.mag_alloyer;
      expect(def).toBeDefined();
      expect(def.tier).toBe(3);
      expect(def.footprint).toEqual(SHAPES.square2);
      expect(def.category).toBe('manufacturing');
    });
    it('produces magnetic_alloy from iron_ingot + rare_earth', () => {
      expect(RECIPES.mag_alloyer).toBeDefined();
      expect(RECIPES.mag_alloyer!.inputs).toEqual({ iron_ingot: 2, rare_earth: 1 });
      expect(RECIPES.mag_alloyer!.outputs).toEqual({ magnetic_alloy: 1 });
    });
  });

  describe('§6.4 lithium_extractor (T3 lithium extractor)', () => {
    it('is T3 extraction gated to lithium_vein tile', () => {
      const def = BUILDING_DEFS.lithium_extractor;
      expect(def).toBeDefined();
      expect(def.tier).toBe(3);
      expect(def.category).toBe('extraction');
      expect(def.requiredTile).toEqual(['lithium_vein']);
    });
    it('produces 1 lithium per cycle', () => {
      expect(RECIPES.lithium_extractor).toBeDefined();
      expect(RECIPES.lithium_extractor!.outputs).toEqual({ lithium: 1 });
    });
  });

  describe('§6.4/§7.9 mag_forge (T3 magnet producer)', () => {
    it('is T3, 2x2, manufacturing category', () => {
      const def = BUILDING_DEFS.mag_forge;
      expect(def).toBeDefined();
      expect(def.tier).toBe(3);
      expect(def.footprint).toEqual(SHAPES.square2);
      expect(def.category).toBe('manufacturing');
    });
    it('produces magnet from magnetic_alloy + wire', () => {
      expect(RECIPES.mag_forge).toBeDefined();
      expect(RECIPES.mag_forge!.inputs).toEqual({ magnetic_alloy: 1, wire: 2 });
      expect(RECIPES.mag_forge!.outputs).toEqual({ magnet: 1 });
    });
  });

  describe('§6.4/§7.9 motor_assembly (T3 electric_motor producer)', () => {
    it('is T3, 2x2, manufacturing category', () => {
      const def = BUILDING_DEFS.motor_assembly;
      expect(def).toBeDefined();
      expect(def.tier).toBe(3);
      expect(def.footprint).toEqual(SHAPES.square2);
      expect(def.category).toBe('manufacturing');
    });
    it('produces electric_motor from magnet + wire + steel', () => {
      expect(RECIPES.motor_assembly).toBeDefined();
      expect(RECIPES.motor_assembly!.inputs).toEqual({ magnet: 1, wire: 4, steel: 1 });
      expect(RECIPES.motor_assembly!.outputs).toEqual({ electric_motor: 1 });
    });
  });

  describe('§6.4/§7.9 generator_lab (T3 generator producer)', () => {
    it('is T3, 2x2, manufacturing category', () => {
      const def = BUILDING_DEFS.generator_lab;
      expect(def).toBeDefined();
      expect(def.tier).toBe(3);
      expect(def.footprint).toEqual(SHAPES.square2);
      expect(def.category).toBe('manufacturing');
    });
    it('produces generator from magnet + wire + steel + bearing', () => {
      expect(RECIPES.generator_lab).toBeDefined();
      expect(RECIPES.generator_lab!.inputs).toEqual({ magnet: 1, wire: 5, steel: 1, bearing: 2 });
      expect(RECIPES.generator_lab!.outputs).toEqual({ generator: 1 });
    });
  });

  describe('§7.10 hydraulic_assembly (T3 hydraulic_actuator producer)', () => {
    it('is T3, 2x2, manufacturing category', () => {
      const def = BUILDING_DEFS.hydraulic_assembly;
      expect(def).toBeDefined();
      expect(def.tier).toBe(3);
      expect(def.footprint).toEqual(SHAPES.square2);
      expect(def.category).toBe('manufacturing');
    });
    it('produces hydraulic_actuator from pipe + lubricant + bearing + spring', () => {
      expect(RECIPES.hydraulic_assembly).toBeDefined();
      expect(RECIPES.hydraulic_assembly!.inputs).toEqual({ pipe: 2, lubricant: 2, bearing: 1, spring: 1 });
      expect(RECIPES.hydraulic_assembly!.outputs).toEqual({ hydraulic_actuator: 1 });
    });
  });

  describe('§7.10 pneumatic_assembly (T3 pneumatic_actuator producer)', () => {
    it('is T3, 2x2, manufacturing category', () => {
      const def = BUILDING_DEFS.pneumatic_assembly;
      expect(def).toBeDefined();
      expect(def.tier).toBe(3);
      expect(def.footprint).toEqual(SHAPES.square2);
      expect(def.category).toBe('manufacturing');
    });
    it('produces pneumatic_actuator from pipe + bearing + spring', () => {
      expect(RECIPES.pneumatic_assembly).toBeDefined();
      expect(RECIPES.pneumatic_assembly!.inputs).toEqual({ pipe: 2, bearing: 1, spring: 1 });
      expect(RECIPES.pneumatic_assembly!.outputs).toEqual({ pneumatic_actuator: 1 });
    });
  });

  describe('§7.9 fuel_cell_lab (T3 fuel_cell producer)', () => {
    it('is T3, 2x2, manufacturing category', () => {
      const def = BUILDING_DEFS.fuel_cell_lab;
      expect(def).toBeDefined();
      expect(def.tier).toBe(3);
      expect(def.footprint).toEqual(SHAPES.square2);
      expect(def.category).toBe('manufacturing');
    });
    it('produces fuel_cell from hydrogen + rare_earth + flexible_plastic', () => {
      expect(RECIPES.fuel_cell_lab).toBeDefined();
      expect(RECIPES.fuel_cell_lab!.inputs).toEqual({ hydrogen: 2, rare_earth: 1, flexible_plastic: 1 });
      expect(RECIPES.fuel_cell_lab!.outputs).toEqual({ fuel_cell: 1 });
    });
  });

  describe('§6.4/§7.6 optical_glass_kiln (T3 optical_glass producer)', () => {
    it('is T3, 2x2, manufacturing, requires heat', () => {
      const def = BUILDING_DEFS.optical_glass_kiln;
      expect(def).toBeDefined();
      expect(def.tier).toBe(3);
      expect(def.footprint).toEqual(SHAPES.square2);
      expect(def.category).toBe('manufacturing');
      expect(def.requiresHeat).toBe(true);
      expect(def.gates).toEqual([{ matchType: 'heat_source', hard: true }]);
    });
    it('produces optical_glass from quartz', () => {
      expect(RECIPES.optical_glass_kiln).toBeDefined();
      expect(RECIPES.optical_glass_kiln!.inputs).toEqual({ quartz: 2 });
      expect(RECIPES.optical_glass_kiln!.outputs).toEqual({ optical_glass: 1 });
    });
  });

  describe('§7.6 glass_fiber_spinner (T3 glass_fiber producer)', () => {
    it('is T3, 2x2, manufacturing, requires heat', () => {
      const def = BUILDING_DEFS.glass_fiber_spinner;
      expect(def).toBeDefined();
      expect(def.tier).toBe(3);
      expect(def.footprint).toEqual(SHAPES.square2);
      expect(def.category).toBe('manufacturing');
      expect(def.requiresHeat).toBe(true);
      expect(def.gates).toEqual([{ matchType: 'heat_source', hard: true }]);
    });
    it('produces glass_fiber from glass', () => {
      expect(RECIPES.glass_fiber_spinner).toBeDefined();
      expect(RECIPES.glass_fiber_spinner!.inputs).toEqual({ glass: 2 });
      expect(RECIPES.glass_fiber_spinner!.outputs).toEqual({ glass_fiber: 3 });
    });
  });

  describe('§7.6 optical_fiber_drawer (T3 optical_fiber producer)', () => {
    it('is T3, 2x2, manufacturing, requires heat', () => {
      const def = BUILDING_DEFS.optical_fiber_drawer;
      expect(def).toBeDefined();
      expect(def.tier).toBe(3);
      expect(def.footprint).toEqual(SHAPES.square2);
      expect(def.category).toBe('manufacturing');
      expect(def.requiresHeat).toBe(true);
      expect(def.gates).toEqual([{ matchType: 'heat_source', hard: true }]);
    });
    it('produces optical_fiber from optical_glass', () => {
      expect(RECIPES.optical_fiber_drawer).toBeDefined();
      expect(RECIPES.optical_fiber_drawer!.inputs).toEqual({ optical_glass: 1 });
      expect(RECIPES.optical_fiber_drawer!.outputs).toEqual({ optical_fiber: 2 });
    });
  });
});

describe('buildingUnlocked / tier gating (§9.2)', () => {
  it('T1 buildings unlock at level 1', () => {
    expect(buildingUnlocked(1, 'iron_mine')).toBe(true);
    expect(buildingUnlocked(1, 'workshop')).toBe(true);
    expect(buildingUnlocked(1, 'logger')).toBe(true);
    expect(buildingUnlocked(1, 'smelter')).toBe(true);
    expect(buildingUnlocked(1, 'crate')).toBe(true);
    expect(buildingUnlocked(1, 'silo')).toBe(true);
  });

  it('T2 buildings stay locked at level 4 and unlock at level 5', () => {
    // tierForLevel(4) = 1, tierForLevel(5) = 2.
    expect(buildingUnlocked(4, 'coke_oven')).toBe(false);
    expect(buildingUnlocked(4, 'blast_furnace')).toBe(false);
    expect(buildingUnlocked(4, 'steel_mill')).toBe(false);
    expect(buildingUnlocked(4, 'assembler')).toBe(false);
    expect(buildingUnlocked(4, 'tank')).toBe(false);

    expect(buildingUnlocked(5, 'coke_oven')).toBe(true);
    expect(buildingUnlocked(5, 'blast_furnace')).toBe(true);
    expect(buildingUnlocked(5, 'steel_mill')).toBe(true);
    expect(buildingUnlocked(5, 'assembler')).toBe(true);
    expect(buildingUnlocked(5, 'tank')).toBe(true);
  });

  it('T3 buildings stay locked at level 14 and unlock at level 15', () => {
    expect(buildingUnlocked(14, 'electric_arc_furnace')).toBe(false);
    expect(buildingUnlocked(15, 'electric_arc_furnace')).toBe(true);
  });

  it('T1 buildings remain unlocked at higher tiers', () => {
    expect(buildingUnlocked(15, 'iron_mine')).toBe(true);
    expect(buildingUnlocked(30, 'iron_mine')).toBe(true);
    expect(buildingUnlocked(50, 'smelter')).toBe(true);
  });
});

describe('step-12 T4 catalog (§6.5 / §9.5)', () => {
  it('all 9 T4 defs are present with tier 4', () => {
    for (const id of ['fusion_core', 'pyroforge', 'cryogenic_compute_center', 'particle_accelerator', 'launch_tower', 'mass_driver', 'carbon_forge', 'tidal_array', 'sunspire'] as const) {
      expect(BUILDING_DEFS[id]).toBeDefined();
      expect(BUILDING_DEFS[id].tier).toBe(4);
    }
  });

  it('Fusion Core: 4×4, +300 MW (300000 kW) producer, no biome restriction', () => {
    const def = BUILDING_DEFS.fusion_core;
    expect(shapeWidth(def.footprint)).toBe(4);
    expect(shapeHeight(def.footprint)).toBe(4);
    expect(def.power?.produces).toBe(300000);
    expect(def.requiredBiomes).toBeUndefined();
  });

  it('Pyroforge: 3×3, -800W consumer, Volcanic-restricted', () => {
    const def = BUILDING_DEFS.pyroforge;
    expect(shapeWidth(def.footprint)).toBe(3);
    expect(shapeHeight(def.footprint)).toBe(3);
    expect(def.power?.consumes).toBe(800);
    expect(def.requiredBiomes).toEqual(['volcanic']);
  });

  it('Cryogenic Compute Center: 4×4, -1200W consumer, Arctic-restricted', () => {
    const def = BUILDING_DEFS.cryogenic_compute_center;
    expect(shapeWidth(def.footprint)).toBe(4);
    expect(shapeHeight(def.footprint)).toBe(4);
    expect(def.power?.consumes).toBe(1200);
    expect(def.requiredBiomes).toEqual(['arctic']);
  });

  it('Particle Accelerator: 4×4, -1500W consumer, no biome restriction', () => {
    const def = BUILDING_DEFS.particle_accelerator;
    expect(shapeWidth(def.footprint)).toBe(4);
    expect(shapeHeight(def.footprint)).toBe(4);
    expect(def.power?.consumes).toBe(1500);
    expect(def.requiredBiomes).toBeUndefined();
  });

  it('Launch Tower: 3×3, -400W consumer, no biome restriction, no recipe', () => {
    const def = BUILDING_DEFS.launch_tower;
    expect(shapeWidth(def.footprint)).toBe(3);
    expect(shapeHeight(def.footprint)).toBe(3);
    expect(def.power?.consumes).toBe(400);
    expect(def.requiredBiomes).toBeUndefined();
  });

  it('T4 defs gate at level 30 (tierForLevel(30) === 4)', () => {
    expect(buildingUnlocked(29, 'fusion_core')).toBe(false);
    expect(buildingUnlocked(29, 'pyroforge')).toBe(false);
    expect(buildingUnlocked(30, 'fusion_core')).toBe(true);
    expect(buildingUnlocked(30, 'pyroforge')).toBe(true);
    expect(buildingUnlocked(30, 'cryogenic_compute_center')).toBe(true);
    expect(buildingUnlocked(30, 'particle_accelerator')).toBe(true);
    expect(buildingUnlocked(30, 'launch_tower')).toBe(true);
    expect(buildingUnlocked(30, 'mass_driver')).toBe(true);
    expect(buildingUnlocked(30, 'carbon_forge')).toBe(true);
    expect(buildingUnlocked(30, 'tidal_array')).toBe(true);
    expect(buildingUnlocked(30, 'sunspire')).toBe(true);
  });
});

describe('canPlaceOnIsland (§9.5 / step 12)', () => {
  it('unrestricted defs place on any natural biome', () => {
    expect(canPlaceOnIsland(BUILDING_DEFS.fusion_core, fakeSpec('plains'))).toBe(true);
    expect(canPlaceOnIsland(BUILDING_DEFS.fusion_core, fakeSpec('forest'))).toBe(true);
    expect(canPlaceOnIsland(BUILDING_DEFS.fusion_core, fakeSpec('volcanic'))).toBe(true);
    expect(canPlaceOnIsland(BUILDING_DEFS.fusion_core, fakeSpec('arctic'))).toBe(true);
    expect(canPlaceOnIsland(BUILDING_DEFS.particle_accelerator, fakeSpec('desert'))).toBe(true);
    expect(canPlaceOnIsland(BUILDING_DEFS.launch_tower, fakeSpec('coast'))).toBe(true);
    expect(canPlaceOnIsland(BUILDING_DEFS.iron_mine, fakeSpec('plains'))).toBe(true);
  });

  it('unrestricted defs ALSO place on artificial islands', () => {
    // Per §9.5, only biome-locked uniques are banned from artificial
    // islands. Unrestricted defs (Fusion Core, Mine, etc.) are fine.
    expect(canPlaceOnIsland(BUILDING_DEFS.fusion_core, fakeSpec('plains', true))).toBe(true);
    expect(canPlaceOnIsland(BUILDING_DEFS.particle_accelerator, fakeSpec('plains', true))).toBe(true);
    expect(canPlaceOnIsland(BUILDING_DEFS.iron_mine, fakeSpec('plains', true))).toBe(true);
  });

  it('Pyroforge: places on natural Volcanic, rejects other biomes', () => {
    expect(canPlaceOnIsland(BUILDING_DEFS.pyroforge, fakeSpec('volcanic'))).toBe(true);
    expect(canPlaceOnIsland(BUILDING_DEFS.pyroforge, fakeSpec('plains'))).toBe(false);
    expect(canPlaceOnIsland(BUILDING_DEFS.pyroforge, fakeSpec('forest'))).toBe(false);
    expect(canPlaceOnIsland(BUILDING_DEFS.pyroforge, fakeSpec('arctic'))).toBe(false);
    expect(canPlaceOnIsland(BUILDING_DEFS.pyroforge, fakeSpec('coast'))).toBe(false);
    expect(canPlaceOnIsland(BUILDING_DEFS.pyroforge, fakeSpec('desert'))).toBe(false);
  });

  it('Pyroforge: rejects artificial Volcanic island (§9.5 biome-locked-unique gate)', () => {
    expect(canPlaceOnIsland(BUILDING_DEFS.pyroforge, fakeSpec('volcanic', true))).toBe(false);
  });

  it('Cryogenic Compute Center: places on natural Arctic, rejects other biomes', () => {
    expect(canPlaceOnIsland(BUILDING_DEFS.cryogenic_compute_center, fakeSpec('arctic'))).toBe(true);
    expect(canPlaceOnIsland(BUILDING_DEFS.cryogenic_compute_center, fakeSpec('plains'))).toBe(false);
    expect(canPlaceOnIsland(BUILDING_DEFS.cryogenic_compute_center, fakeSpec('volcanic'))).toBe(false);
  });

  it('Cryogenic Compute Center: rejects artificial Arctic island', () => {
    expect(canPlaceOnIsland(BUILDING_DEFS.cryogenic_compute_center, fakeSpec('arctic', true))).toBe(false);
  });

  it('Mass Driver: places on natural Plains, rejects other biomes', () => {
    expect(canPlaceOnIsland(BUILDING_DEFS.mass_driver, fakeSpec('plains'))).toBe(true);
    expect(canPlaceOnIsland(BUILDING_DEFS.mass_driver, fakeSpec('forest'))).toBe(false);
    expect(canPlaceOnIsland(BUILDING_DEFS.mass_driver, fakeSpec('volcanic'))).toBe(false);
    expect(canPlaceOnIsland(BUILDING_DEFS.mass_driver, fakeSpec('arctic'))).toBe(false);
    expect(canPlaceOnIsland(BUILDING_DEFS.mass_driver, fakeSpec('coast'))).toBe(false);
    expect(canPlaceOnIsland(BUILDING_DEFS.mass_driver, fakeSpec('desert'))).toBe(false);
  });

  it('Mass Driver: rejects artificial Plains island', () => {
    expect(canPlaceOnIsland(BUILDING_DEFS.mass_driver, fakeSpec('plains', true))).toBe(false);
  });

  it('Carbon Forge: places on natural Forest, rejects other biomes', () => {
    expect(canPlaceOnIsland(BUILDING_DEFS.carbon_forge, fakeSpec('forest'))).toBe(true);
    expect(canPlaceOnIsland(BUILDING_DEFS.carbon_forge, fakeSpec('plains'))).toBe(false);
    expect(canPlaceOnIsland(BUILDING_DEFS.carbon_forge, fakeSpec('volcanic'))).toBe(false);
    expect(canPlaceOnIsland(BUILDING_DEFS.carbon_forge, fakeSpec('arctic'))).toBe(false);
    expect(canPlaceOnIsland(BUILDING_DEFS.carbon_forge, fakeSpec('coast'))).toBe(false);
    expect(canPlaceOnIsland(BUILDING_DEFS.carbon_forge, fakeSpec('desert'))).toBe(false);
  });

  it('Carbon Forge: rejects artificial Forest island', () => {
    expect(canPlaceOnIsland(BUILDING_DEFS.carbon_forge, fakeSpec('forest', true))).toBe(false);
  });

  it('Tidal Array: places on natural Coast, rejects other biomes', () => {
    expect(canPlaceOnIsland(BUILDING_DEFS.tidal_array, fakeSpec('coast'))).toBe(true);
    expect(canPlaceOnIsland(BUILDING_DEFS.tidal_array, fakeSpec('plains'))).toBe(false);
    expect(canPlaceOnIsland(BUILDING_DEFS.tidal_array, fakeSpec('forest'))).toBe(false);
    expect(canPlaceOnIsland(BUILDING_DEFS.tidal_array, fakeSpec('volcanic'))).toBe(false);
    expect(canPlaceOnIsland(BUILDING_DEFS.tidal_array, fakeSpec('arctic'))).toBe(false);
    expect(canPlaceOnIsland(BUILDING_DEFS.tidal_array, fakeSpec('desert'))).toBe(false);
  });

  it('Tidal Array: rejects artificial Coast island', () => {
    expect(canPlaceOnIsland(BUILDING_DEFS.tidal_array, fakeSpec('coast', true))).toBe(false);
  });

  it('Sunspire: places on natural Desert, rejects other biomes', () => {
    expect(canPlaceOnIsland(BUILDING_DEFS.sunspire, fakeSpec('desert'))).toBe(true);
    expect(canPlaceOnIsland(BUILDING_DEFS.sunspire, fakeSpec('plains'))).toBe(false);
    expect(canPlaceOnIsland(BUILDING_DEFS.sunspire, fakeSpec('forest'))).toBe(false);
    expect(canPlaceOnIsland(BUILDING_DEFS.sunspire, fakeSpec('volcanic'))).toBe(false);
    expect(canPlaceOnIsland(BUILDING_DEFS.sunspire, fakeSpec('arctic'))).toBe(false);
    expect(canPlaceOnIsland(BUILDING_DEFS.sunspire, fakeSpec('coast'))).toBe(false);
  });

  it('Sunspire: rejects artificial Desert island', () => {
    expect(canPlaceOnIsland(BUILDING_DEFS.sunspire, fakeSpec('desert', true))).toBe(false);
  });
});

describe('§9.5 biome-locked uniques', () => {
  it('mass_driver is T4, 4x4, Plains-locked', () => {
    const def = BUILDING_DEFS.mass_driver;
    expect(def.tier).toBe(4);
    expect(def.footprint.tiles.length).toBe(16);
    expect(def.requiredBiomes).toEqual(['plains']);
  });
  it('carbon_forge is T4, 3x3, Forest-locked, requires heat', () => {
    const def = BUILDING_DEFS.carbon_forge;
    expect(def.tier).toBe(4);
    expect(def.footprint.tiles.length).toBe(9);
    expect(def.requiredBiomes).toEqual(['forest']);
    expect(def.requiresHeat).toBe(true);
  });
  it('tidal_array is T4, 3x3, Coast-locked, produces ≥ 10 MW', () => {
    const def = BUILDING_DEFS.tidal_array;
    expect(def.tier).toBe(4);
    expect(def.footprint.tiles.length).toBe(9);
    expect(def.requiredBiomes).toEqual(['coast']);
    expect(def.power?.produces).toBeGreaterThanOrEqual(10000);
  });
  it('sunspire is T4, 3x3, Desert-locked, produces ≥ 10 MW', () => {
    const def = BUILDING_DEFS.sunspire;
    expect(def.tier).toBe(4);
    expect(def.footprint.tiles.length).toBe(9);
    expect(def.requiredBiomes).toEqual(['desert']);
    expect(def.power?.produces).toBeGreaterThanOrEqual(10000);
  });
});

describe('unlockedDefs', () => {
  it('returns every T1 id at level 1', () => {
    const list = unlockedDefs(1);
    // T1 defs in the catalog: mine, workshop, solar, coal_gen, dock,
    // logger, smelter, crate, silo, biomass_plant.
    expect(list).toContain('iron_mine');
    expect(list).toContain('workshop');
    expect(list).toContain('logger');
    expect(list).toContain('smelter');
    expect(list).toContain('silo');
    expect(list).not.toContain('coke_oven');
    expect(list).not.toContain('blast_furnace');
    expect(list).not.toContain('electric_arc_furnace');
  });

  it('returns T1 + T2 ids at level 5', () => {
    const list = unlockedDefs(5);
    expect(list).toContain('iron_mine');
    expect(list).toContain('coke_oven');
    expect(list).toContain('blast_furnace');
    expect(list).toContain('steel_mill');
    expect(list).toContain('assembler');
    expect(list).toContain('tank');
    expect(list).toContain('dronepad');
    expect(list).not.toContain('electric_arc_furnace');
  });

  it('returns T1 + T2 + T3 ids at level 15', () => {
    const list = unlockedDefs(15);
    expect(list).toContain('electric_arc_furnace');
    expect(list).toContain('blast_furnace');
    expect(list).toContain('iron_mine');
    // T4 should NOT yet be unlocked at level 15.
    expect(list).not.toContain('fusion_core');
    expect(list).not.toContain('pyroforge');
  });

  it('returns T1 + T2 + T3 + T4 ids at level 30', () => {
    const list = unlockedDefs(30);
    // All T4 defs are listed regardless of biome — `unlockedDefs` is the
    // tier gate only; `canPlaceOnIsland` is the biome gate (see §9.5).
    expect(list).toContain('fusion_core');
    expect(list).toContain('pyroforge');
    expect(list).toContain('cryogenic_compute_center');
    expect(list).toContain('particle_accelerator');
    expect(list).toContain('launch_tower');
    // T3 / T2 / T1 still present.
    expect(list).toContain('electric_arc_furnace');
    expect(list).toContain('iron_mine');
    // T5 still locked (no aiCoreCrafted flag, and level 30 < 50 anyway).
    expect(list).not.toContain('casimir_tap');
    expect(list).not.toContain('reality_forge');
  });

  it('keeps T5 locked at level 50 without aiCoreCrafted flag', () => {
    // Default third arg is `false` — level alone never unlocks T5 per §13.1.
    const list = unlockedDefs(50);
    expect(list).not.toContain('casimir_tap');
    expect(list).not.toContain('reality_forge');
    expect(list).not.toContain('singularity_battery');
    expect(list).not.toContain('time_lock');
    expect(list).not.toContain('genesis_chamber');
    expect(list).not.toContain('universe_editor');
    expect(list).not.toContain('lattice_node');
    // T1-T4 still listed.
    expect(list).toContain('fusion_core');
    expect(list).toContain('iron_mine');
  });

  it('returns T1..T5 ids at level 50 + aiCoreCrafted', () => {
    const list = unlockedDefs(50, true);
    // All T5 defs unlocked.
    expect(list).toContain('casimir_tap');
    expect(list).toContain('reality_forge');
    expect(list).toContain('singularity_battery');
    expect(list).toContain('time_lock');
    expect(list).toContain('genesis_chamber');
    expect(list).toContain('universe_editor');
    expect(list).toContain('lattice_node');
    // T1-T4 still listed.
    expect(list).toContain('fusion_core');
    expect(list).toContain('iron_mine');
  });
});

describe('dead-def guard: every recipe-implying category has a recipe or power output', () => {
  // Categories that imply a building should have a recipe (or be power-producing).
  const RECIPE_CATEGORIES = new Set([
    'extraction', 'smelting', 'chemistry', 'manufacturing', 'electronics', 'production',
  ]);

  // Legitimate defs that have no recipe today. Storage, logistics, special
  // infrastructure, and passive power sources are allowed.
  const NO_RECIPE_ALLOWLIST: ReadonlyArray<BuildingDefId> = [
    // storage
    'crate', 'silo', 'tank', 'cold_storage', 'component_warehouse', 'vault',
    'battery_bank', 'capacitor_bank', 'flywheel_array',
    // logistics
    'dock', 'dronepad', 'shipyard', 'helipad', 'patron_hub',
    'airship_dock', 'teleporter_pad', 'spacetime_anchor', 'power_substation',
    'signal_exchange',
    // special / infrastructure (no recipe by design)
    'land_reclamation_hub', 'launch_tower', 'platform_constructor',
    'time_lock', 'genesis_chamber',
    'terrain_modifier', 'sonar_buoy', 'spaceport', 'orbital_tracking_station',
    'path_drone_foundry', 'probability_engine',
    // heat sources (passive adjacency enablers, not recipe buildings)
    'coal_furnace', 'geothermal_vent', 'plasma_heater',
    // lighthouses (vision tiers, no recipe)
    'lighthouse_t1', 'lighthouse_t2', 'lighthouse_t3',
    'lighthouse_t4', 'lighthouse_t5', 'lighthouse_t6',
    // antennas (telemetry, no recipe)
    'antenna_t1', 'antenna_t2', 'antenna_t3',
    'antenna_t4', 'antenna_t5', 'antenna_t6',
    // weather stations (no recipe)
    'weather_station_t2', 'advanced_weather_station_t3',
    // cooling / treatment (no recipe)
    'cooling_tower', 'wastewater_treatment', 'exhaust_scrubber',
    // passive power sources (power.produces only, no recipe)
    'solar', 'geothermal_vent_generator', 'newcomen_engine',
    'water_wheel', 'wind_turbine', 'windmill_t0',
    // active power sources that DO have recipes are NOT here.
    // T4 biome-locked power (no recipe)
    'mass_driver', 'sunspire', 'tidal_array',
    // T5 power buffer (no recipe)
    'singularity_battery',
  ];

  it('every manufacturing/extraction/etc. def either has a recipe, produces power, or is allowlisted', () => {
    const allowSet = new Set(NO_RECIPE_ALLOWLIST);
    const violations: string[] = [];
    for (const id of ALL_BUILDING_DEF_IDS) {
      const def = BUILDING_DEFS[id];
      if (!def) continue;
      if (!RECIPE_CATEGORIES.has(def.category)) continue;
      if (allowSet.has(id)) continue;
      if ((def.power?.produces ?? 0) > 0) continue;

      const hasDirectRecipe = (RECIPES as any)[id] !== undefined;
      const hasVariantRecipe = Object.keys(RECIPES).some(
        (rk) => buildingForRecipe(rk) === id,
      );
      if (!hasDirectRecipe && !hasVariantRecipe) {
        violations.push(id);
      }
    }
    expect(violations).toEqual([]);
  });
});

describe('step-13 T5 catalog (§13.2 / §8.4 / §8.5 / §8.9)', () => {
  const T5_IDS = [
    'casimir_tap',
    'reality_forge',
    'singularity_battery',
    'time_lock',
    'genesis_chamber',
    'universe_editor',
    'lattice_node',
  ] as const;

  it('all 7 T5 defs are present with tier 5', () => {
    for (const id of T5_IDS) {
      expect(BUILDING_DEFS[id]).toBeDefined();
      expect(BUILDING_DEFS[id].tier).toBe(5);
    }
  });

  it('Casimir Tap: 2×2, +1 GW (1000000 kW) producer, power category', () => {
    const def = BUILDING_DEFS.casimir_tap;
    expect(shapeWidth(def.footprint)).toBe(2);
    expect(shapeHeight(def.footprint)).toBe(2);
    expect(def.power?.produces).toBe(1000000);
    expect(def.category).toBe('power');
    expect(def.requiredBiomes).toBeUndefined();
  });

  it('Reality Forge: 4×4, -3000W consumer, manufacturing', () => {
    const def = BUILDING_DEFS.reality_forge;
    expect(shapeWidth(def.footprint)).toBe(4);
    expect(shapeHeight(def.footprint)).toBe(4);
    expect(def.power?.consumes).toBe(3000);
    expect(def.category).toBe('manufacturing');
  });

  it('Singularity Battery: 2×2, power category with no resource storage, zero standby draw', () => {
    // §8.4 "effectively infinite electrical power storage (not a resource
    // storage building)" — the §4.6 categorized-storage cleanup removed the
    // earlier 10000-cap placeholder. Power-buffer mechanic per §13.3 deferred.
    const def = BUILDING_DEFS.singularity_battery;
    expect(shapeWidth(def.footprint)).toBe(2);
    expect(shapeHeight(def.footprint)).toBe(2);
    expect(def.storage).toBeUndefined();
    expect(def.power?.consumes).toBe(0);
    expect(def.category).toBe('power');
  });

  it('Time Lock / Genesis Chamber / Universe Editor / Lattice Node are special-category placeholders', () => {
    for (const id of ['time_lock', 'genesis_chamber', 'universe_editor', 'lattice_node'] as const) {
      const def = BUILDING_DEFS[id];
      expect(def.category).toBe('special');
      // Mechanics-STILL-DEFERRED defs have no recipe — they're inert catalog rows
      // in step 13 until the §13.3 mechanics land in step 14+.
      expect(def.requiredBiomes).toBeUndefined();
    }
  });

  it('buildingUnlocked: level 49 + aiCoreCrafted=true → T5 locked (level)', () => {
    for (const id of T5_IDS) {
      expect(buildingUnlocked(49, id, true)).toBe(false);
    }
  });

  it('buildingUnlocked: level 50 + aiCoreCrafted=false → T5 locked (AI core)', () => {
    for (const id of T5_IDS) {
      expect(buildingUnlocked(50, id, false)).toBe(false);
    }
  });

  it('buildingUnlocked: level 50 + aiCoreCrafted=true → T5 unlocked', () => {
    for (const id of T5_IDS) {
      expect(buildingUnlocked(50, id, true)).toBe(true);
    }
  });

  it('buildingUnlocked: lower-tier defs unaffected by aiCoreCrafted flag', () => {
    // T1/T2/T3/T4 defs only consult level → tier; aiCoreCrafted has no effect.
    expect(buildingUnlocked(1, 'iron_mine', false)).toBe(true);
    expect(buildingUnlocked(1, 'iron_mine', true)).toBe(true);
    expect(buildingUnlocked(5, 'coke_oven', false)).toBe(true);
    expect(buildingUnlocked(5, 'coke_oven', true)).toBe(true);
    expect(buildingUnlocked(15, 'electric_arc_furnace', false)).toBe(true);
    expect(buildingUnlocked(15, 'electric_arc_furnace', true)).toBe(true);
    expect(buildingUnlocked(30, 'fusion_core', false)).toBe(true);
    expect(buildingUnlocked(30, 'fusion_core', true)).toBe(true);
    // Levels below the tier breakpoint still locked regardless of flag.
    expect(buildingUnlocked(29, 'fusion_core', true)).toBe(false);
  });
});

describe('step-20 T5→T6 Ascendant Assembly (§13.4)', () => {
  it('ascendant_assembly is a T5 def in the catalog', () => {
    const def = BUILDING_DEFS.ascendant_assembly;
    expect(def).toBeDefined();
    expect(def.tier).toBe(5);
    expect(def.category).toBe('manufacturing');
  });

  it('ascendant_assembly is gated by the T5 access gate (level 50 + AI core)', () => {
    // Pre-T5: locked.
    expect(buildingUnlocked(49, 'ascendant_assembly', true)).toBe(false);
    expect(buildingUnlocked(50, 'ascendant_assembly', false)).toBe(false);
    // Post-T5: unlocked.
    expect(buildingUnlocked(50, 'ascendant_assembly', true)).toBe(true);
  });
});

describe('§7.12 tachyonic_transmitter_lab + aether_beacon_lab + reality_engine_lab + singularity_battery_factory (Task 12.3)', () => {
  it('tachyonic_transmitter_lab is T5, 3x3, manufacturing category', () => {
    const def = BUILDING_DEFS.tachyonic_transmitter_lab;
    expect(def).toBeDefined();
    expect(def.tier).toBe(5);
    expect(def.footprint.tiles.length).toBe(9);
    expect(def.category).toBe('manufacturing');
  });
  it('aether_beacon_lab is T5, 3x3, manufacturing category', () => {
    const def = BUILDING_DEFS.aether_beacon_lab;
    expect(def).toBeDefined();
    expect(def.tier).toBe(5);
    expect(def.footprint.tiles.length).toBe(9);
    expect(def.category).toBe('manufacturing');
  });
  it('reality_engine_lab is T5, 3x3, manufacturing category', () => {
    const def = BUILDING_DEFS.reality_engine_lab;
    expect(def).toBeDefined();
    expect(def.tier).toBe(5);
    expect(def.footprint.tiles.length).toBe(9);
    expect(def.category).toBe('manufacturing');
  });
  it('singularity_battery_factory is T5, 3x3, manufacturing category', () => {
    const def = BUILDING_DEFS.singularity_battery_factory;
    expect(def).toBeDefined();
    expect(def.tier).toBe(5);
    expect(def.footprint.tiles.length).toBe(9);
    expect(def.category).toBe('manufacturing');
  });
});

describe('§7.12 probability_calculator_lab + dimensional_fold_lab + causal_regulator_lab (Task 12.2)', () => {
  it('probability_calculator_lab is T5, 3x3, manufacturing category', () => {
    const def = BUILDING_DEFS.probability_calculator_lab;
    expect(def).toBeDefined();
    expect(def.tier).toBe(5);
    expect(def.footprint.tiles.length).toBe(9);
    expect(def.category).toBe('manufacturing');
  });
  it('dimensional_fold_lab is T5, 3x3, manufacturing category', () => {
    const def = BUILDING_DEFS.dimensional_fold_lab;
    expect(def).toBeDefined();
    expect(def.tier).toBe(5);
    expect(def.footprint.tiles.length).toBe(9);
    expect(def.category).toBe('manufacturing');
  });
  it('causal_regulator_lab is T5, 3x3, manufacturing category', () => {
    const def = BUILDING_DEFS.causal_regulator_lab;
    expect(def).toBeDefined();
    expect(def.tier).toBe(5);
    expect(def.footprint.tiles.length).toBe(9);
    expect(def.category).toBe('manufacturing');
  });
});

describe('§8.10 zero_point_extractor + neutronium_extractor (T5 field extractors)', () => {
  it('zero_point_extractor is T5, 2x2, extraction category, no requiredTile', () => {
    const def = BUILDING_DEFS.zero_point_extractor;
    expect(def).toBeDefined();
    expect(def.tier).toBe(5);
    expect(def.footprint).toEqual(SHAPES.square2);
    expect(def.category).toBe('extraction');
    expect(def.requiredTile).toBeUndefined();
  });
  it('neutronium_extractor is T5, 2x2, extraction category, no requiredTile', () => {
    const def = BUILDING_DEFS.neutronium_extractor;
    expect(def).toBeDefined();
    expect(def.tier).toBe(5);
    expect(def.footprint).toEqual(SHAPES.square2);
    expect(def.category).toBe('extraction');
    expect(def.requiredTile).toBeUndefined();
  });
});

describe('chemical_reactor (§8.2 / §7.5)', () => {
  it('ships as a T2 chemistry def with 2x2 footprint', () => {
    const def = BUILDING_DEFS.chemical_reactor;
    expect(def).toBeDefined();
    expect(def.tier).toBe(2);
    expect(def.category).toBe('chemistry');
    expect(def.footprint).toEqual(SHAPES.square2);
  });
  it('produces calcium_sulfonate from sulfur + quicklime + heavy_oil (Task 0.2)', () => {
    const recipe = RECIPES.chemical_reactor!;
    expect(recipe).toBeDefined();
    expect(recipe.inputs).toEqual({ sulfur: 1, quicklime: 1, heavy_oil: 1 });
    // Task 0.2: closes the lubricant-chain gap — calcium_sulfonate consumer
    // (lubricant_refinery) now has a producer.
    expect(recipe.outputs).toEqual({ calcium_sulfonate: 3 });
    expect(recipe.category).toBe('chemistry');
  });
  it('unlocks at level 1 of T2 (uses standard tier-2 unlock per §9.2)', () => {
    expect(buildingUnlocked(10, 'chemical_reactor')).toBe(true);
    expect(buildingUnlocked(1, 'chemical_reactor')).toBe(false);
  });
});

describe('slag_reprocessor (§6.7 byproduct reprocessing)', () => {
  it('ships as a T2 smelting def with 2x2 footprint', () => {
    const def = BUILDING_DEFS.slag_reprocessor;
    expect(def).toBeDefined();
    expect(def.tier).toBe(2);
    expect(def.category).toBe('smelting');
    expect(def.footprint).toEqual(SHAPES.square2);
  });
  it('consumes slag and outputs all three trace minerals', () => {
    const recipe = RECIPES.slag_reprocessor;
    expect(recipe).toBeDefined();
    expect(recipe!.inputs).toEqual({ slag: 10 });
    expect(recipe!.outputs).toEqual({
      gold_ore: 1,
      silver_ore: 1,
      rare_earth: 1,
    });
  });
});

describe('§8.1 limestone_quarry (T1 limestone extractor)', () => {
  it('ships as a T1 extraction def gated to limestone tile', () => {
    const def = BUILDING_DEFS.limestone_quarry;
    expect(def).toBeDefined();
    expect(def.tier).toBe(1);
    expect(def.category).toBe('extraction');
    expect(def.requiredTile).toEqual(['limestone']);
  });
  it('produces 1 limestone per cycle', () => {
    expect(RECIPES.limestone_quarry).toBeDefined();
    expect(RECIPES.limestone_quarry!.outputs).toEqual({ limestone: 1 });
  });
});

describe('§8.1 clay_pit_extractor (T1 clay extractor)', () => {
  it('ships as a T1 extraction def gated to clay_pit tile', () => {
    const def = BUILDING_DEFS.clay_pit_extractor;
    expect(def).toBeDefined();
    expect(def.tier).toBe(1);
    expect(def.category).toBe('extraction');
    expect(def.requiredTile).toEqual(['clay_pit']);
  });
  it('produces 1 clay per cycle', () => {
    expect(RECIPES.clay_pit_extractor).toBeDefined();
    expect(RECIPES.clay_pit_extractor!.outputs).toEqual({ clay: 1 });
  });
});

describe('§8.1 sulfur_mine (T1 sulfur extractor)', () => {
  it('ships as a T1 extraction def gated to sulfur_vein tile', () => {
    const def = BUILDING_DEFS.sulfur_mine;
    expect(def).toBeDefined();
    expect(def.tier).toBe(1);
    expect(def.category).toBe('extraction');
    expect(def.requiredTile).toEqual(['sulfur_vein']);
  });
  it('produces 1 sulfur per cycle', () => {
    expect(RECIPES.sulfur_mine).toBeDefined();
    expect(RECIPES.sulfur_mine!.outputs).toEqual({ sulfur: 1 });
  });
});

describe('§8.1 phosphate_mine (T1 phosphate extractor)', () => {
  it('ships as a T1 extraction def gated to phosphate_deposit tile', () => {
    const def = BUILDING_DEFS.phosphate_mine;
    expect(def).toBeDefined();
    expect(def.tier).toBe(1);
    expect(def.category).toBe('extraction');
    expect(def.requiredTile).toEqual(['phosphate_deposit']);
  });
  it('produces 1 phosphate per cycle', () => {
    expect(RECIPES.phosphate_mine).toBeDefined();
    expect(RECIPES.phosphate_mine!.outputs).toEqual({ phosphate: 1 });
  });
});

describe('§8.1 graphite_mine (T1 graphite extractor)', () => {
  it('ships as a T1 extraction def gated to graphite_vein tile', () => {
    const def = BUILDING_DEFS.graphite_mine;
    expect(def).toBeDefined();
    expect(def.tier).toBe(1);
    expect(def.category).toBe('extraction');
    expect(def.requiredTile).toEqual(['graphite_vein']);
  });
  it('produces 1 graphite per cycle', () => {
    expect(RECIPES.graphite_mine).toBeDefined();
    expect(RECIPES.graphite_mine!.outputs).toEqual({ graphite: 1 });
  });
});

describe('§8.1 copper/tin/lead mines (T1 ore extractors)', () => {
  it('copper_mine is T1 extraction gated to copper_vein', () => {
    const def = BUILDING_DEFS.copper_mine;
    expect(def).toBeDefined();
    expect(def.tier).toBe(1);
    expect(def.category).toBe('extraction');
    expect(def.requiredTile).toEqual(['copper_vein']);
    expect(RECIPES.copper_mine!.outputs).toEqual({ copper_ore: 1 });
  });
  it('tin_mine is T1 extraction gated to tin_vein', () => {
    const def = BUILDING_DEFS.tin_mine;
    expect(def).toBeDefined();
    expect(def.tier).toBe(1);
    expect(def.category).toBe('extraction');
    expect(def.requiredTile).toEqual(['tin_vein']);
    expect(RECIPES.tin_mine!.outputs).toEqual({ tin_ore: 1 });
  });
  it('lead_mine is T1 extraction gated to lead_vein', () => {
    const def = BUILDING_DEFS.lead_mine;
    expect(def).toBeDefined();
    expect(def.tier).toBe(1);
    expect(def.category).toBe('extraction');
    expect(def.requiredTile).toEqual(['lead_vein']);
    expect(RECIPES.lead_mine!.outputs).toEqual({ lead_ore: 1 });
  });
});

describe('§8.1 bauxite_mine (T1 bauxite extractor)', () => {
  it('ships as a T1 extraction def gated to bauxite_vein tile', () => {
    const def = BUILDING_DEFS.bauxite_mine;
    expect(def).toBeDefined();
    expect(def.tier).toBe(1);
    expect(def.category).toBe('extraction');
    expect(def.requiredTile).toEqual(['bauxite_vein']);
  });
  it('produces 1 bauxite per cycle', () => {
    expect(RECIPES.bauxite_mine).toBeDefined();
    expect(RECIPES.bauxite_mine!.outputs).toEqual({ bauxite: 1 });
  });
});

describe('§7.5 limekiln (T1 quicklime producer)', () => {
  it('is T1, 2x2, requires heat, hard heat_source gate', () => {
    const def = BUILDING_DEFS.limekiln;
    expect(def).toBeDefined();
    expect(def.tier).toBe(1);
    expect(def.footprint).toEqual(SHAPES.square2);
    expect(def.requiresHeat).toBe(true);
    expect(def.gates).toEqual([{ matchType: 'heat_source', hard: true }]);
  });
  it('produces quicklime from limestone', () => {
    expect(RECIPES.limekiln).toBeDefined();
    expect(RECIPES.limekiln!.inputs).toEqual({ limestone: 25 });
    expect(RECIPES.limekiln!.outputs).toEqual({ quicklime: 14, co2: 11 });
    expect(RECIPES.limekiln!.exogenousFlow).toBe('fuel-combustion-CO₂');
    expect(RECIPES.limekiln!.exogenousFlowKg).toBe(5);
  });
});

describe('§7.5 lime_slaker (T1 slaked_lime producer)', () => {
  it('is T1, 2x2, no heat requirement', () => {
    const def = BUILDING_DEFS.lime_slaker;
    expect(def).toBeDefined();
    expect(def.tier).toBe(1);
    expect(def.footprint).toEqual(SHAPES.square2);
    expect(def.requiresHeat).toBeUndefined();
  });
  it('produces slaked_lime from quicklime + fresh_water', () => {
    expect(RECIPES.lime_slaker).toBeDefined();
    expect(RECIPES.lime_slaker!.inputs).toEqual({ quicklime: 1, fresh_water: 1 });
    expect(RECIPES.lime_slaker!.outputs).toEqual({ slaked_lime: 1 });
  });
});

describe('§7.6 brick_kiln (T1 brick producer)', () => {
  it('is T1, 2x2, requires heat, hard heat_source gate', () => {
    const def = BUILDING_DEFS.brick_kiln;
    expect(def).toBeDefined();
    expect(def.tier).toBe(1);
    expect(def.footprint).toEqual(SHAPES.square2);
    expect(def.requiresHeat).toBe(true);
    expect(def.gates).toEqual([{ matchType: 'heat_source', hard: true }]);
  });
  it('produces brick from clay', () => {
    expect(RECIPES.brick_kiln).toBeDefined();
    expect(RECIPES.brick_kiln!.inputs).toEqual({ clay: 6 });
    expect(RECIPES.brick_kiln!.outputs).toEqual({ brick: 5, water_vapor: 1 });
  });
});

describe('§7.8 mortar_mixer (T1 mortar producer)', () => {
  it('is T1, 2x2, no heat requirement', () => {
    const def = BUILDING_DEFS.mortar_mixer;
    expect(def).toBeDefined();
    expect(def.tier).toBe(1);
    expect(def.footprint).toEqual(SHAPES.square2);
    expect(def.requiresHeat).toBeUndefined();
  });
  it('produces mortar from sand + quicklime', () => {
    expect(RECIPES.mortar_mixer).toBeDefined();
    expect(RECIPES.mortar_mixer!.inputs).toEqual({ sand: 1, quicklime: 1 });
    expect(RECIPES.mortar_mixer!.outputs).toEqual({ mortar: 1 });
  });
});

describe('§7.8 cement_mill (T1 cement producer)', () => {
  it('is T1, 2x2, requires heat, hard heat_source gate', () => {
    const def = BUILDING_DEFS.cement_mill;
    expect(def).toBeDefined();
    expect(def.tier).toBe(1);
    expect(def.footprint).toEqual(SHAPES.square2);
    expect(def.requiresHeat).toBe(true);
    expect(def.gates).toEqual([{ matchType: 'heat_source', hard: true }]);
  });
  it('produces cement from quicklime + sand + clay', () => {
    expect(RECIPES.cement_mill).toBeDefined();
    expect(RECIPES.cement_mill!.inputs).toEqual({ quicklime: 8, clay: 2, sand: 1 });
    expect(RECIPES.cement_mill!.outputs).toEqual({ cement: 11 });
    expect(RECIPES.cement_mill!.exogenousFlow).toBe('fuel-combustion-CO₂');
    expect(RECIPES.cement_mill!.exogenousFlowKg).toBe(4);
  });
});

describe('§7.8 concrete_plant (T1 concrete producer)', () => {
  it('is T1, 2x2, no heat requirement', () => {
    const def = BUILDING_DEFS.concrete_plant;
    expect(def).toBeDefined();
    expect(def.tier).toBe(1);
    expect(def.footprint).toEqual(SHAPES.square2);
    expect(def.requiresHeat).toBeUndefined();
  });
  it('produces concrete from cement + sand + fresh_water', () => {
    expect(RECIPES.concrete_plant).toBeDefined();
    expect(RECIPES.concrete_plant!.inputs).toEqual({ cement: 1, sand: 2, stone: 3, fresh_water: 0.5 });
    expect(RECIPES.concrete_plant!.outputs).toEqual({ concrete: 6 });
    expect(RECIPES.concrete_plant!.exogenousFlow).toBe('evaporation-water-vapor');
  });
});

describe('§6.2 charcoal_kiln (T1 charcoal producer)', () => {
  it('is T1, 2x2, requires heat, hard heat_source gate', () => {
    const def = BUILDING_DEFS.charcoal_kiln;
    expect(def).toBeDefined();
    expect(def.tier).toBe(1);
    expect(def.footprint).toEqual(SHAPES.square2);
    expect(def.requiresHeat).toBe(true);
    expect(def.gates).toEqual([{ matchType: 'heat_source', hard: true }]);
  });
  it('produces charcoal from wood', () => {
    expect(RECIPES.charcoal_kiln).toBeDefined();
    expect(RECIPES.charcoal_kiln!.inputs).toEqual({ wood: 8 });
    expect(RECIPES.charcoal_kiln!.outputs).toEqual({ charcoal: 2, wood_tar: 1, co2: 2, water_vapor: 3 });
    expect(RECIPES.charcoal_kiln!.biogenic).toBe(true);
  });
});

describe('§6.2 plank_mill (T1 plank producer)', () => {
  it('is T1, 2x2, manufacturing category', () => {
    const def = BUILDING_DEFS.plank_mill;
    expect(def).toBeDefined();
    expect(def.tier).toBe(1);
    expect(def.footprint).toEqual(SHAPES.square2);
    expect(def.category).toBe('manufacturing');
  });
  it('produces 2 plank from 1 lumber', () => {
    expect(RECIPES.plank_mill).toBeDefined();
    expect(RECIPES.plank_mill!.inputs).toEqual({ lumber: 1 });
    expect(RECIPES.plank_mill!.outputs).toEqual({ plank: 2 });
  });
});

describe('§7.2 copper/tin/lead smelters (Task 2.6)', () => {
  it('copper_smelter is T1, 2x2, smelting, no heat requirement', () => {
    const def = BUILDING_DEFS.copper_smelter;
    expect(def).toBeDefined();
    expect(def.tier).toBe(1);
    expect(def.footprint).toEqual(SHAPES.square2);
    expect(def.category).toBe('smelting');
    expect(def.requiresHeat).toBeUndefined();
  });
  it('tin_smelter is T1, 2x2, smelting, no heat requirement', () => {
    const def = BUILDING_DEFS.tin_smelter;
    expect(def).toBeDefined();
    expect(def.tier).toBe(1);
    expect(def.footprint).toEqual(SHAPES.square2);
    expect(def.category).toBe('smelting');
    expect(def.requiresHeat).toBeUndefined();
  });
  it('lead_smelter is T1, 2x2, smelting, no heat requirement', () => {
    const def = BUILDING_DEFS.lead_smelter;
    expect(def).toBeDefined();
    expect(def.tier).toBe(1);
    expect(def.footprint).toEqual(SHAPES.square2);
    expect(def.category).toBe('smelting');
    expect(def.requiresHeat).toBeUndefined();
  });
});

describe('§7.1 manganese_mine (T1 manganese extractor)', () => {
  it('is T1 extraction gated to manganese_vein tile', () => {
    const def = BUILDING_DEFS.manganese_mine;
    expect(def).toBeDefined();
    expect(def.tier).toBe(1);
    expect(def.category).toBe('extraction');
    expect(def.requiredTile).toEqual(['manganese_vein']);
  });
  it('produces 1 manganese_ore per cycle', () => {
    expect(RECIPES.manganese_mine).toBeDefined();
    expect(RECIPES.manganese_mine!.outputs).toEqual({ manganese_ore: 1 });
  });
});

describe('§7.1 manganese_smelter (T1 manganese ingot smelter)', () => {
  it('is T1, 2x2, smelting, no heat requirement', () => {
    const def = BUILDING_DEFS.manganese_smelter;
    expect(def).toBeDefined();
    expect(def.tier).toBe(1);
    expect(def.footprint).toEqual(SHAPES.square2);
    expect(def.category).toBe('smelting');
    expect(def.requiresHeat).toBeUndefined();
  });
  it('produces manganese_ingot from manganese_ore + coal', () => {
    expect(RECIPES.manganese_smelter).toBeDefined();
    expect(RECIPES.manganese_smelter!.inputs).toEqual({ manganese_ore: 1, coal: 1 });
    expect(RECIPES.manganese_smelter!.outputs).toEqual({ manganese_ingot: 1 });
  });
});

describe('§7.1 carbon_steel_mill (T2 carbon steel producer)', () => {
  it('is T2, 3x3, manufacturing category', () => {
    const def = BUILDING_DEFS.carbon_steel_mill;
    expect(def).toBeDefined();
    expect(def.tier).toBe(2);
    expect(def.footprint.tiles.length).toBe(9);
    expect(def.category).toBe('manufacturing');
  });
  it('produces carbon_steel from steel + manganese_ingot', () => {
    expect(RECIPES.carbon_steel_mill).toBeDefined();
    expect(RECIPES.carbon_steel_mill!.inputs).toEqual({ steel: 1, manganese_ingot: 1 });
    expect(RECIPES.carbon_steel_mill!.outputs).toEqual({ carbon_steel: 1 });
  });
});

describe('§7.1 zinc_mine (T1 zinc extractor)', () => {
  it('is T1 extraction gated to zinc_vein tile', () => {
    const def = BUILDING_DEFS.zinc_mine;
    expect(def).toBeDefined();
    expect(def.tier).toBe(1);
    expect(def.category).toBe('extraction');
    expect(def.requiredTile).toEqual(['zinc_vein']);
  });
  it('produces 1 zinc_ore per cycle', () => {
    expect(RECIPES.zinc_mine).toBeDefined();
    expect(RECIPES.zinc_mine!.outputs).toEqual({ zinc_ore: 1 });
  });
});

describe('§7.1 zinc_smelter (T1 zinc ingot smelter)', () => {
  it('is T1, 2x2, smelting, no heat requirement', () => {
    const def = BUILDING_DEFS.zinc_smelter;
    expect(def).toBeDefined();
    expect(def.tier).toBe(1);
    expect(def.footprint).toEqual(SHAPES.square2);
    expect(def.category).toBe('smelting');
    expect(def.requiresHeat).toBeUndefined();
  });
  it('produces zinc_ingot from zinc_ore + coal', () => {
    expect(RECIPES.zinc_smelter).toBeDefined();
    expect(RECIPES.zinc_smelter!.inputs).toEqual({ zinc_ore: 1, coal: 1 });
    expect(RECIPES.zinc_smelter!.outputs).toEqual({ zinc_ingot: 1 });
  });
});

describe('§7.1 galvanizing_bath (T2 galvanized steel producer)', () => {
  it('is T2, 3x3, manufacturing category', () => {
    const def = BUILDING_DEFS.galvanizing_bath;
    expect(def).toBeDefined();
    expect(def.tier).toBe(2);
    expect(def.footprint.tiles.length).toBe(9);
    expect(def.category).toBe('manufacturing');
  });
  it('produces galvanized_steel from steel + zinc_ingot', () => {
    expect(RECIPES.galvanizing_bath).toBeDefined();
    expect(RECIPES.galvanizing_bath!.inputs).toEqual({ steel: 1, zinc_ingot: 1 });
    expect(RECIPES.galvanizing_bath!.outputs).toEqual({ galvanized_steel: 1 });
  });
});

describe('§7.1 chromium_mine (T1 chromium extractor)', () => {
  it('is T1 extraction gated to chromium_vein tile', () => {
    const def = BUILDING_DEFS.chromium_mine;
    expect(def).toBeDefined();
    expect(def.tier).toBe(1);
    expect(def.category).toBe('extraction');
    expect(def.requiredTile).toEqual(['chromium_vein']);
  });
  it('produces 1 chromium_ore per cycle', () => {
    expect(RECIPES.chromium_mine).toBeDefined();
    expect(RECIPES.chromium_mine!.outputs).toEqual({ chromium_ore: 1 });
  });
});

describe('§7.1 chromium_smelter (T1 chromium ingot smelter)', () => {
  it('is T1, 2x2, smelting, no heat requirement', () => {
    const def = BUILDING_DEFS.chromium_smelter;
    expect(def).toBeDefined();
    expect(def.tier).toBe(1);
    expect(def.footprint).toEqual(SHAPES.square2);
    expect(def.category).toBe('smelting');
    expect(def.requiresHeat).toBeUndefined();
  });
  it('produces chromium_ingot from chromium_ore + coal', () => {
    expect(RECIPES.chromium_smelter).toBeDefined();
    expect(RECIPES.chromium_smelter!.inputs).toEqual({ chromium_ore: 1, coal: 1 });
    expect(RECIPES.chromium_smelter!.outputs).toEqual({ chromium_ingot: 1 });
  });
});

describe('§7.1 nickel_mine (T1 nickel extractor)', () => {
  it('is T1 extraction gated to nickel_vein tile', () => {
    const def = BUILDING_DEFS.nickel_mine;
    expect(def).toBeDefined();
    expect(def.tier).toBe(1);
    expect(def.category).toBe('extraction');
    expect(def.requiredTile).toEqual(['nickel_vein']);
  });
  it('produces 1 nickel_ore per cycle', () => {
    expect(RECIPES.nickel_mine).toBeDefined();
    expect(RECIPES.nickel_mine!.outputs).toEqual({ nickel_ore: 1 });
  });
});

describe('§7.1 nickel_smelter (T1 nickel ingot smelter)', () => {
  it('is T1, 2x2, smelting, no heat requirement', () => {
    const def = BUILDING_DEFS.nickel_smelter;
    expect(def).toBeDefined();
    expect(def.tier).toBe(1);
    expect(def.footprint).toEqual(SHAPES.square2);
    expect(def.category).toBe('smelting');
    expect(def.requiresHeat).toBeUndefined();
  });
  it('produces nickel_ingot from nickel_ore + coal', () => {
    expect(RECIPES.nickel_smelter).toBeDefined();
    expect(RECIPES.nickel_smelter!.inputs).toEqual({ nickel_ore: 1, coal: 1 });
    expect(RECIPES.nickel_smelter!.outputs).toEqual({ nickel_ingot: 1 });
  });
});

describe('§7.1 stainless_steel_mill (T3 stainless steel producer)', () => {
  it('is T3, 3x3, manufacturing, requires heat', () => {
    const def = BUILDING_DEFS.stainless_steel_mill;
    expect(def).toBeDefined();
    expect(def.tier).toBe(3);
    expect(def.footprint.tiles.length).toBe(9);
    expect(def.category).toBe('manufacturing');
    expect(def.requiresHeat).toBe(true);
    expect(def.gates).toEqual([{ matchType: 'heat_source', hard: true }]);
  });
  it('produces stainless_steel from steel + chromium_ingot + nickel_ingot', () => {
    expect(RECIPES.stainless_steel_mill).toBeDefined();
    expect(RECIPES.stainless_steel_mill!.inputs).toEqual({ steel: 1, chromium_ingot: 1, nickel_ingot: 1 });
    expect(RECIPES.stainless_steel_mill!.outputs).toEqual({ stainless_steel: 1 });
  });
});

describe('§7.1 tungsten_mine (T1 tungsten extractor)', () => {
  it('is T1 extraction gated to tungsten_vein tile', () => {
    const def = BUILDING_DEFS.tungsten_mine;
    expect(def).toBeDefined();
    expect(def.tier).toBe(1);
    expect(def.category).toBe('extraction');
    expect(def.requiredTile).toEqual(['tungsten_vein']);
  });
  it('produces 1 tungsten_ore per cycle', () => {
    expect(RECIPES.tungsten_mine).toBeDefined();
    expect(RECIPES.tungsten_mine!.outputs).toEqual({ tungsten_ore: 1 });
  });
});

describe('§7.1 tungsten_smelter (T1 tungsten ingot smelter)', () => {
  it('is T1, 2x2, smelting, no heat requirement', () => {
    const def = BUILDING_DEFS.tungsten_smelter;
    expect(def).toBeDefined();
    expect(def.tier).toBe(1);
    expect(def.footprint).toEqual(SHAPES.square2);
    expect(def.category).toBe('smelting');
    expect(def.requiresHeat).toBeUndefined();
  });
  it('produces tungsten_ingot from tungsten_ore + coal', () => {
    expect(RECIPES.tungsten_smelter).toBeDefined();
    expect(RECIPES.tungsten_smelter!.inputs).toEqual({ tungsten_ore: 1, coal: 1 });
    expect(RECIPES.tungsten_smelter!.outputs).toEqual({ tungsten_ingot: 1 });
  });
});

describe('§7.1 tool_steel_mill (T3 tool steel producer)', () => {
  it('is T3, 3x3, manufacturing, requires heat', () => {
    const def = BUILDING_DEFS.tool_steel_mill;
    expect(def).toBeDefined();
    expect(def.tier).toBe(3);
    expect(def.footprint.tiles.length).toBe(9);
    expect(def.category).toBe('manufacturing');
    expect(def.requiresHeat).toBe(true);
    expect(def.gates).toEqual([{ matchType: 'heat_source', hard: true }]);
  });
  it('produces tool_steel from steel + tungsten_ingot', () => {
    expect(RECIPES.tool_steel_mill).toBeDefined();
    expect(RECIPES.tool_steel_mill!.inputs).toEqual({ steel: 1, tungsten_ingot: 1 });
    expect(RECIPES.tool_steel_mill!.outputs).toEqual({ tool_steel: 1 });
  });
});

describe('§7.4 rigid_plastic_press (T2 rigid plastic producer)', () => {
  it('is T2, 2x2, manufacturing category', () => {
    const def = BUILDING_DEFS.rigid_plastic_press;
    expect(def).toBeDefined();
    expect(def.tier).toBe(2);
    expect(def.footprint.tiles.length).toBe(4);
    expect(def.category).toBe('manufacturing');
  });
  it('has power consumption 100W', () => {
    expect(BUILDING_DEFS.rigid_plastic_press.power?.consumes).toBe(100);
  });
});

describe('§7.4 flexible_plastic_press (T2 flexible plastic producer)', () => {
  it('is T2, 2x2, manufacturing category', () => {
    const def = BUILDING_DEFS.flexible_plastic_press;
    expect(def).toBeDefined();
    expect(def.tier).toBe(2);
    expect(def.footprint.tiles.length).toBe(4);
    expect(def.category).toBe('manufacturing');
  });
  it('has power consumption 100W', () => {
    expect(BUILDING_DEFS.flexible_plastic_press.power?.consumes).toBe(100);
  });
});

describe('§7.4 rubber_synthesizer (T2 synthetic rubber producer)', () => {
  it('is T2, 2x2, manufacturing category', () => {
    const def = BUILDING_DEFS.rubber_synthesizer;
    expect(def).toBeDefined();
    expect(def.tier).toBe(2);
    expect(def.footprint.tiles.length).toBe(4);
    expect(def.category).toBe('manufacturing');
  });
  it('has power consumption 100W', () => {
    expect(BUILDING_DEFS.rubber_synthesizer.power?.consumes).toBe(100);
  });
});

describe('§7.4 plastic_polymerizer_a (T2 plastic precursor producer)', () => {
  it('is T2, 2x2, chemistry category', () => {
    const def = BUILDING_DEFS.plastic_polymerizer_a;
    expect(def).toBeDefined();
    expect(def.tier).toBe(2);
    expect(def.footprint.tiles.length).toBe(4);
    expect(def.category).toBe('chemistry');
  });
  it('has power consumption 120W', () => {
    expect(BUILDING_DEFS.plastic_polymerizer_a.power?.consumes).toBe(120);
  });
});

describe('§7.4 crude_oil_cracker (T2 heavy-fraction cracker)', () => {
  it('is T2, 3x3, chemistry category', () => {
    const def = BUILDING_DEFS.crude_oil_cracker;
    expect(def).toBeDefined();
    expect(def.tier).toBe(2);
    expect(def.footprint.tiles.length).toBe(9);
    expect(def.category).toBe('chemistry');
  });
  it('has power consumption 250W', () => {
    expect(BUILDING_DEFS.crude_oil_cracker.power?.consumes).toBe(250);
  });
});

describe('§7.2 solder_alloyer (T2 solder producer)', () => {
  it('is T2, 2x2, manufacturing category', () => {
    const def = BUILDING_DEFS.solder_alloyer;
    expect(def).toBeDefined();
    expect(def.tier).toBe(2);
    expect(def.footprint).toEqual(SHAPES.square2);
    expect(def.category).toBe('manufacturing');
  });
  it('produces 2 solder from tin_ingot + lead_ingot', () => {
    expect(RECIPES.solder_alloyer).toBeDefined();
    expect(RECIPES.solder_alloyer!.inputs).toEqual({ tin_ingot: 1, lead_ingot: 1 });
    expect(RECIPES.solder_alloyer!.outputs).toEqual({ solder: 2 });
  });
});

describe('§7.2 bronze_alloyer (Task 7.1)', () => {
  it('is T2, 2x2, manufacturing category', () => {
    const def = BUILDING_DEFS.bronze_alloyer;
    expect(def).toBeDefined();
    expect(def.tier).toBe(2);
    expect(def.footprint).toEqual(SHAPES.square2);
    expect(def.category).toBe('manufacturing');
  });
  it('produces 2 bronze from copper_ingot + tin_ingot', () => {
    expect(RECIPES.bronze_alloyer).toBeDefined();
    expect(RECIPES.bronze_alloyer!.inputs).toEqual({ copper_ingot: 1, tin_ingot: 1 });
    expect(RECIPES.bronze_alloyer!.outputs).toEqual({ bronze: 2 });
    expect(RECIPES.bronze_alloyer!.cycleSec).toBe(5548.3);
  });
});

describe('§7.2 brass_alloyer (Task 7.2)', () => {
  it('is T2, 2x2, manufacturing category', () => {
    const def = BUILDING_DEFS.brass_alloyer;
    expect(def).toBeDefined();
    expect(def.tier).toBe(2);
    expect(def.footprint).toEqual(SHAPES.square2);
    expect(def.category).toBe('manufacturing');
  });
  it('produces 2 brass from copper_ingot + zinc_ingot', () => {
    expect(RECIPES.brass_alloyer).toBeDefined();
    expect(RECIPES.brass_alloyer!.inputs).toEqual({ copper_ingot: 1, zinc_ingot: 1 });
    expect(RECIPES.brass_alloyer!.outputs).toEqual({ brass: 2 });
    expect(RECIPES.brass_alloyer!.cycleSec).toBe(5548.3);
  });
});

describe('§7.3 alumina_refinery (Task 8.1)', () => {
  it('is T2, 2x2, chemistry category', () => {
    const def = BUILDING_DEFS.alumina_refinery;
    expect(def).toBeDefined();
    expect(def.tier).toBe(2);
    expect(def.footprint).toEqual(SHAPES.square2);
    expect(def.category).toBe('chemistry');
  });
  it('produces alumina from bauxite + sodium_hydroxide', () => {
    expect(RECIPES.alumina_refinery).toBeDefined();
    expect(RECIPES.alumina_refinery!.inputs).toEqual({ bauxite: 1, sodium_hydroxide: 1 });
    expect(RECIPES.alumina_refinery!.outputs).toEqual({ alumina: 1 });
    expect(RECIPES.alumina_refinery!.cycleSec).toBe(2774.2);
  });
});

describe('§7.3 aluminum_smelter (Task 8.2)', () => {
  it('is T3, 2x3, smelting category', () => {
    const def = BUILDING_DEFS.aluminum_smelter;
    expect(def).toBeDefined();
    expect(def.tier).toBe(3);
    expect(def.footprint).toEqual(SHAPES.rect2x3);
    expect(def.category).toBe('smelting');
  });
  it('produces aluminum from alumina', () => {
    expect(RECIPES.aluminum_smelter).toBeDefined();
    expect(RECIPES.aluminum_smelter!.inputs).toEqual({ alumina: 1 });
    expect(RECIPES.aluminum_smelter!.outputs).toEqual({ aluminum: 1 });
    expect(RECIPES.aluminum_smelter!.cycleSec).toBe(819041.1);
  });
});

describe('§7.5 sulfuric_acid_plant (Task 5.1)', () => {
  it('is T2, 2x2, chemistry category', () => {
    const def = BUILDING_DEFS.sulfuric_acid_plant;
    expect(def).toBeDefined();
    expect(def.tier).toBe(2);
    expect(def.footprint).toEqual(SHAPES.square2);
    expect(def.category).toBe('chemistry');
  });
  it('has power consumption 120W', () => {
    expect(BUILDING_DEFS.sulfuric_acid_plant.power?.consumes).toBe(120);
  });
});

describe('§7.5 cryo_air_separator (Task 5.4)', () => {
  it('is T3, 3x3, chemistry category', () => {
    const def = BUILDING_DEFS.cryo_air_separator;
    expect(def).toBeDefined();
    expect(def.tier).toBe(3);
    expect(def.footprint.tiles.length).toBe(9);
    expect(def.category).toBe('chemistry');
  });
  it('has power consumption 400W', () => {
    expect(BUILDING_DEFS.cryo_air_separator.power?.consumes).toBe(400);
  });
});

describe('§7.5 phosphor_plant (Task 5.3)', () => {
  it('is T3, 2x2, chemistry category', () => {
    const def = BUILDING_DEFS.phosphor_plant;
    expect(def).toBeDefined();
    expect(def.tier).toBe(3);
    expect(def.footprint).toEqual(SHAPES.square2);
    expect(def.category).toBe('chemistry');
  });
  it('has power consumption 200W', () => {
    expect(BUILDING_DEFS.phosphor_plant.power?.consumes).toBe(200);
  });
});

describe('§7.5 hcl_plant (Task 5.1)', () => {
  it('is T2, 2x2, chemistry category', () => {
    const def = BUILDING_DEFS.hcl_plant;
    expect(def).toBeDefined();
    expect(def.tier).toBe(2);
    expect(def.footprint).toEqual(SHAPES.square2);
    expect(def.category).toBe('chemistry');
  });
  it('has power consumption 80W', () => {
    expect(BUILDING_DEFS.hcl_plant.power?.consumes).toBe(80);
  });
});

describe('§8.8 shipyard coastal gating', () => {
  it('shipyard has coastal flag', () => {
    expect(BUILDING_DEFS.shipyard.coastal).toBe(true);
  });
});

describe('step-20 T6 Orbital catalog (§14 / step 20)', () => {
  const T6_NON_SPACEPORT_IDS = [
    'orbital_tracking_station',
    'antimatter_refinery',
    'scanner_sat_assembly',
    'relay_sat_assembly',
    'sweeper_sat_assembly',
    'mirror_sat_assembly',
    'oip_assembly',
    'repair_pack_assembly',
    'repair_drone_assembly',
  ] as const;
  const ALL_T6_IDS = ['spaceport', ...T6_NON_SPACEPORT_IDS] as const;

  it('all 10 T6 defs are present with tier 6', () => {
    for (const id of ALL_T6_IDS) {
      expect(BUILDING_DEFS[id]).toBeDefined();
      expect(BUILDING_DEFS[id].tier).toBe(6);
    }
  });

  it('Spaceport: 4×4, -3000W consumer, special category, no recipe (gate building)', () => {
    const def = BUILDING_DEFS.spaceport;
    expect(shapeWidth(def.footprint)).toBe(4);
    expect(shapeHeight(def.footprint)).toBe(4);
    expect(def.power?.consumes).toBe(3000);
    expect(def.category).toBe('special');
    expect(def.requiredBiomes).toBeUndefined();
  });

  it('Orbital Tracking Station: 3×3, -80W consumer, special category (§14.2)', () => {
    const def = BUILDING_DEFS.orbital_tracking_station;
    expect(shapeWidth(def.footprint)).toBe(3);
    expect(shapeHeight(def.footprint)).toBe(3);
    expect(def.power?.consumes).toBe(80);
    expect(def.category).toBe('special');
    expect(def.requiredBiomes).toBeUndefined();
  });

  it('Antimatter Refinery: 3×3, -5000W consumer, manufacturing', () => {
    const def = BUILDING_DEFS.antimatter_refinery;
    expect(shapeWidth(def.footprint)).toBe(3);
    expect(shapeHeight(def.footprint)).toBe(3);
    expect(def.power?.consumes).toBe(5000);
    expect(def.category).toBe('manufacturing');
  });

  it('satellite-assembly defs are 3×3 manufacturing consumers', () => {
    for (const id of [
      'scanner_sat_assembly',
      'relay_sat_assembly',
      'sweeper_sat_assembly',
      'mirror_sat_assembly',
      'oip_assembly',
      'repair_pack_assembly',
      'repair_drone_assembly',
    ] as const) {
      const def = BUILDING_DEFS[id];
      expect(shapeWidth(def.footprint)).toBe(3);
      expect(shapeHeight(def.footprint)).toBe(3);
      expect(def.category).toBe('manufacturing');
      expect(def.power?.consumes).toBeGreaterThan(0);
    }
  });

  it('T6 defs are biome-agnostic (per task brief; Spaceport coastal pref documented)', () => {
    for (const id of ALL_T6_IDS) {
      expect(BUILDING_DEFS[id].requiredBiomes).toBeUndefined();
    }
  });

  it('§14.1 gate: Spaceport itself is buildable on ascendantCoreCrafted (chicken-and-egg exemption)', () => {
    // Without ascendantCoreCrafted, the Spaceport itself is locked too —
    // §14.1's first half (Ascendant Core crafted) gates everything T6.
    expect(buildingUnlocked(50, 'spaceport', true, false, false)).toBe(false);
    // With ascendantCoreCrafted but no Spaceport yet, the Spaceport IS
    // buildable (chicken-and-egg resolution: otherwise the gate's second
    // half locks out its own gate building).
    expect(buildingUnlocked(50, 'spaceport', true, true, false)).toBe(true);
    // Once a Spaceport is placed, building another is still allowed by
    // the def gate (placement.ts decides whether multi-Spaceport is OK).
    expect(buildingUnlocked(50, 'spaceport', true, true, true)).toBe(true);
  });

  it('§14.1 gate: non-Spaceport T6 defs require BOTH ascendantCoreCrafted AND hasSpaceport', () => {
    for (const id of T6_NON_SPACEPORT_IDS) {
      // Neither half → locked.
      expect(buildingUnlocked(50, id, true, false, false)).toBe(false);
      // Half a — ascendant only → still locked (no Spaceport).
      expect(buildingUnlocked(50, id, true, true, false)).toBe(false);
      // Half b — Spaceport only → still locked (no Ascendant Core; impossible
      // in practice since Spaceport itself requires ascendantCoreCrafted,
      // but the gate logic must be order-independent).
      expect(buildingUnlocked(50, id, true, false, true)).toBe(false);
      // Both halves → unlocked.
      expect(buildingUnlocked(50, id, true, true, true)).toBe(true);
    }
  });

  it('§14.1 T6 gate: level is NOT a factor (no §9.2 level threshold for T6)', () => {
    // T6 access composes orthogonally to level. A level-1 island with both
    // gates flipped would unlock T6 — though reaching the gates requires
    // T5 mastery in practice (level 50 + AI core for ascendant_assembly).
    expect(buildingUnlocked(1, 'spaceport', false, true, false)).toBe(true);
    expect(buildingUnlocked(1, 'antimatter_refinery', false, true, true)).toBe(true);
  });

  it('lower-tier defs unaffected by ascendantCoreCrafted / hasSpaceport flags', () => {
    // T1/T2/T3/T4 defs only consult level → tier; T6 flags have no effect.
    expect(buildingUnlocked(1, 'iron_mine', false, false, false)).toBe(true);
    expect(buildingUnlocked(1, 'iron_mine', true, true, true)).toBe(true);
    expect(buildingUnlocked(30, 'fusion_core', false, false, false)).toBe(true);
    expect(buildingUnlocked(30, 'fusion_core', true, true, true)).toBe(true);
  });

  it('unlockedDefs at L50 + ai + ascendant + spaceport includes the full T6 band', () => {
    const list = unlockedDefs(50, true, true, true);
    for (const id of ALL_T6_IDS) {
      expect(list).toContain(id);
    }
    // T5 still listed.
    expect(list).toContain('reality_forge');
    expect(list).toContain('ascendant_assembly');
  });

  it('unlockedDefs at L50 + ai + ascendant + no spaceport: only Spaceport from T6', () => {
    const list = unlockedDefs(50, true, true, false);
    expect(list).toContain('spaceport');
    // Other T6 defs gated out.
    for (const id of T6_NON_SPACEPORT_IDS) {
      expect(list).not.toContain(id);
    }
  });

  it('unlockedDefs at L50 + ai + !ascendant: every T6 def locked', () => {
    const list = unlockedDefs(50, true, false, true);
    for (const id of ALL_T6_IDS) {
      expect(list).not.toContain(id);
    }
  });

describe('§8.1 T2 extraction buildings', () => {
    it('heavy_logger is T2, 2x2, requires tree (dense_forest STILL-DEFERRED)', () => {
      const def = BUILDING_DEFS.heavy_logger;
      expect(def.tier).toBe(2);
      expect(def.footprint.tiles.length).toBe(4);
      expect(def.requiredTile?.length).toBeGreaterThan(0);
    });
    it('deep_mine is T2, 2x3, requires ore vein', () => {
      const def = BUILDING_DEFS.deep_mine;
      expect(def.tier).toBe(2);
      expect(def.footprint.tiles.length).toBe(6);
      expect(def.requiredTile).toContain('ore');
    });
  });

  describe('§8.5 power-generation buildings', () => {
    it('wind_turbine is T1, 1x1, produces power for free', () => {
      const def = BUILDING_DEFS.wind_turbine;
      expect(def.tier).toBe(1);
      expect(def.footprint.tiles.length).toBe(1);
      expect(def.power?.produces).toBeGreaterThan(0);
      expect(def.power?.consumes ?? 0).toBe(0);
    });
    it('cryogenic_generator is T2, 2x2, consumes cryo_coolant', () => {
      const def = BUILDING_DEFS.cryogenic_generator;
      expect(def.tier).toBe(2);
      expect(def.footprint.tiles.length).toBe(4);
      expect(def.power?.produces).toBeGreaterThan(0);
      expect(RECIPES.cryogenic_generator!.inputs.cryo_coolant).toBeGreaterThan(0);
    });
    it('nuclear_reactor is T3, 4x4, produces high power', () => {
      const def = BUILDING_DEFS.nuclear_reactor;
      expect(def.tier).toBe(3);
      expect(def.footprint.tiles.length).toBe(16);
      expect(def.power?.produces).toBeGreaterThanOrEqual(1000);
    });
  });

  describe('§8.7 cooling / treatment buildings', () => {
    it('cooling_tower is T2, 2x2', () => {
      const def = BUILDING_DEFS.cooling_tower;
      expect(def.tier).toBe(2);
      expect(def.footprint.tiles.length).toBe(4);
    });
    it('wastewater_treatment is T2, 2x2', () => {
      const def = BUILDING_DEFS.wastewater_treatment;
      expect(def.tier).toBe(2);
      expect(def.footprint.tiles.length).toBe(4);
    });
    it('exhaust_scrubber is T2, 1x1', () => {
      const def = BUILDING_DEFS.exhaust_scrubber;
      expect(def.tier).toBe(2);
      expect(def.footprint.tiles.length).toBe(1);
    });
  });

  describe('§6.3 T2 rolling mills — sheet_metal + pipe + steel_beam (Task 6.1)', () => {
    it('sheet_metal_mill is T2, 2x2, manufacturing, consumes 100W', () => {
      const def = BUILDING_DEFS.sheet_metal_mill;
      expect(def).toBeDefined();
      expect(def.tier).toBe(2);
      expect(def.footprint.tiles.length).toBe(4);
      expect(def.category).toBe('manufacturing');
      expect(def.power?.consumes).toBe(100);
    });
    it('pipe_mill is T2, 2x2, manufacturing, consumes 100W', () => {
      const def = BUILDING_DEFS.pipe_mill;
      expect(def).toBeDefined();
      expect(def.tier).toBe(2);
      expect(def.footprint.tiles.length).toBe(4);
      expect(def.category).toBe('manufacturing');
      expect(def.power?.consumes).toBe(100);
    });
    it('beam_mill is T2, 2x2, manufacturing, consumes 100W', () => {
      const def = BUILDING_DEFS.beam_mill;
      expect(def).toBeDefined();
      expect(def.tier).toBe(2);
      expect(def.footprint.tiles.length).toBe(4);
      expect(def.category).toBe('manufacturing');
      expect(def.power?.consumes).toBe(100);
    });
  });

  describe('§6.3 T2 bearing_assembler + spring_press (Task 6.2)', () => {
    it('bearing_assembler is T2, 2x2, manufacturing, consumes 60W', () => {
      const def = BUILDING_DEFS.bearing_assembler;
      expect(def).toBeDefined();
      expect(def.tier).toBe(2);
      expect(def.footprint.tiles.length).toBe(4);
      expect(def.category).toBe('manufacturing');
      expect(def.power?.consumes).toBe(60);
    });
    it('spring_press is T2, 2x2, manufacturing, consumes 60W', () => {
      const def = BUILDING_DEFS.spring_press;
      expect(def).toBeDefined();
      expect(def.tier).toBe(2);
      expect(def.footprint.tiles.length).toBe(4);
      expect(def.category).toBe('manufacturing');
      expect(def.power?.consumes).toBe(60);
    });
  });

  describe('§6.3 cable_mill (Task 6.3)', () => {
    it('cable_mill is T2, 2x2, manufacturing, consumes 80W', () => {
      const def = BUILDING_DEFS.cable_mill;
      expect(def).toBeDefined();
      expect(def.tier).toBe(2);
      expect(def.footprint.tiles.length).toBe(4);
      expect(def.category).toBe('manufacturing');
      expect(def.power?.consumes).toBe(80);
    });
  });

  describe('§6.3/§7.9 battery_factory (Task 6.4)', () => {
    it('battery_factory is T3, 3x3, manufacturing, consumes 200W', () => {
      const def = BUILDING_DEFS.battery_factory;
      expect(def).toBeDefined();
      expect(def.tier).toBe(3);
      expect(def.footprint.tiles.length).toBe(9);
      expect(def.category).toBe('manufacturing');
      expect(def.power?.consumes).toBe(200);
    });
  });

  describe('§6.3 glass_panel_press (Task 6.5)', () => {
    it('glass_panel_press is T2, 2x2, manufacturing, consumes 60W', () => {
      const def = BUILDING_DEFS.glass_panel_press;
      expect(def).toBeDefined();
      expect(def.tier).toBe(2);
      expect(def.footprint.tiles.length).toBe(4);
      expect(def.category).toBe('manufacturing');
      expect(def.power?.consumes).toBe(60);
    });
  });

  describe('§6.3 coolant_synthesizer + ceramic_kiln (Task 6.6)', () => {
    it('coolant_synthesizer is T2, 2x2, manufacturing, consumes 100W', () => {
      const def = BUILDING_DEFS.coolant_synthesizer;
      expect(def).toBeDefined();
      expect(def.tier).toBe(2);
      expect(def.footprint.tiles.length).toBe(4);
      expect(def.category).toBe('manufacturing');
      expect(def.power?.consumes).toBe(100);
    });
    it('ceramic_kiln is T2, 2x2, manufacturing, requires heat source', () => {
      const def = BUILDING_DEFS.ceramic_kiln;
      expect(def).toBeDefined();
      expect(def.tier).toBe(2);
      expect(def.footprint.tiles.length).toBe(4);
      expect(def.category).toBe('manufacturing');
      expect(def.power?.consumes).toBe(80);
      expect(def.requiresHeat).toBe(true);
    });
  });

  describe('§7.7 wafer_lab (Task 9.1)', () => {
    it('is T3, 3x3, electronics category, consumes 250W', () => {
      const def = BUILDING_DEFS.wafer_lab;
      expect(def).toBeDefined();
      expect(def.tier).toBe(3);
      expect(def.footprint.tiles.length).toBe(9);
      expect(def.category).toBe('electronics');
      expect(def.power?.consumes).toBe(250);
    });
  });

  describe('§7.7 doping chambers (Task 9.2)', () => {
    it('transistor_doping is T3, 2x2, electronics, consumes 150W', () => {
      const def = BUILDING_DEFS.transistor_doping;
      expect(def).toBeDefined();
      expect(def.tier).toBe(3);
      expect(def.footprint.tiles.length).toBe(4);
      expect(def.category).toBe('electronics');
      expect(def.power?.consumes).toBe(150);
    });
    it('capacitor_doping is T3, 2x2, electronics, consumes 150W', () => {
      const def = BUILDING_DEFS.capacitor_doping;
      expect(def).toBeDefined();
      expect(def.tier).toBe(3);
      expect(def.footprint.tiles.length).toBe(4);
      expect(def.category).toBe('electronics');
      expect(def.power?.consumes).toBe(150);
    });
    it('resistor_doping is T3, 2x2, electronics, consumes 150W', () => {
      const def = BUILDING_DEFS.resistor_doping;
      expect(def).toBeDefined();
      expect(def.tier).toBe(3);
      expect(def.footprint.tiles.length).toBe(4);
      expect(def.category).toBe('electronics');
      expect(def.power?.consumes).toBe(150);
    });
  });

  describe('§7.7 memory_lab (Task 9.3)', () => {
    it('is T3, 3x3, electronics category, consumes 250W', () => {
      const def = BUILDING_DEFS.memory_lab;
      expect(def).toBeDefined();
      expect(def.tier).toBe(3);
      expect(def.footprint.tiles.length).toBe(9);
      expect(def.category).toBe('electronics');
      expect(def.power?.consumes).toBe(250);
    });
  });

  describe('§8.8 / §8.9 logistics + special buildings', () => {
    it('airship_dock is T3, 3x3', () => {
      const def = BUILDING_DEFS.airship_dock;
      expect(def.tier).toBe(3);
      expect(def.footprint.tiles.length).toBe(9);
    });
    it('teleporter_pad is T4, 2x2', () => {
      const def = BUILDING_DEFS.teleporter_pad;
      expect(def.tier).toBe(4);
      expect(def.footprint.tiles.length).toBe(4);
    });
    it('spacetime_anchor is T5, 2x2', () => {
      const def = BUILDING_DEFS.spacetime_anchor;
      expect(def.tier).toBe(5);
      expect(def.footprint.tiles.length).toBe(4);
    });
    it('power_substation is T4, 2x2', () => {
      const def = BUILDING_DEFS.power_substation;
      expect(def.tier).toBe(4);
      expect(def.footprint.tiles.length).toBe(4);
    });
    it('terrain_modifier is T2, 2x2', () => {
      const def = BUILDING_DEFS.terrain_modifier;
      expect(def.tier).toBe(2);
      expect(def.footprint.tiles.length).toBe(4);
    });
  });
});

describe('§6.5 quantum_chip_fab (T4 quantum_chip producer, Task 11.2)', () => {
  it('is T4, 3x3, electronics category', () => {
    const def = BUILDING_DEFS.quantum_chip_fab;
    expect(def).toBeDefined();
    expect(def.tier).toBe(4);
    expect(def.footprint.tiles.length).toBe(9);
    expect(def.category).toBe('electronics');
  });
  it('produces quantum_chip from steel + pig_iron', () => {
    expect(RECIPES.quantum_chip_fab).toBeDefined();
    expect(RECIPES.quantum_chip_fab!.inputs).toEqual({ steel: 4, pig_iron: 4, quantum_foam: 1 }); // §12 P3
    expect(RECIPES.quantum_chip_fab!.outputs).toEqual({ quantum_chip: 1 });
    expect(RECIPES.quantum_chip_fab!.cycleSec).toBe(3822191.6);
  });
});

describe('§6.5 quantum_manipulator (T4 time_crystal producer, Task 11.1)', () => {
  it('is T4, 3x3, manufacturing category', () => {
    const def = BUILDING_DEFS.quantum_manipulator;
    expect(def).toBeDefined();
    expect(def.tier).toBe(4);
    expect(def.footprint.tiles.length).toBe(9);
    expect(def.category).toBe('manufacturing');
  });
  it('has power consumption 1000W', () => {
    expect(BUILDING_DEFS.quantum_manipulator.power?.consumes).toBe(1000);
  });
  it('produces time_crystal from helium_3 + exotic_alloy', () => {
    expect(RECIPES.quantum_manipulator).toBeDefined();
    expect(RECIPES.quantum_manipulator!.inputs).toEqual({ helium_3: 1, exotic_alloy: 1 });
    expect(RECIPES.quantum_manipulator!.outputs).toEqual({ time_crystal: 1 });
    expect(RECIPES.quantum_manipulator!.cycleSec).toBe(764438.3);
  });
});

describe('§6.5 fuel_rod_assembler (T4 nuclear_fuel_rod producer, Task 11.3)', () => {
  it('is T4, 2x2, manufacturing category', () => {
    const def = BUILDING_DEFS.fuel_rod_assembler;
    expect(def).toBeDefined();
    expect(def.tier).toBe(4);
    expect(def.footprint.tiles.length).toBe(4);
    expect(def.category).toBe('manufacturing');
  });
  it('has power consumption 400W', () => {
    expect(BUILDING_DEFS.fuel_rod_assembler.power?.consumes).toBe(400);
  });
  it('produces nuclear_fuel_rod from uranium_ore + stainless_steel + coolant', () => {
    expect(RECIPES.fuel_rod_assembler).toBeDefined();
    expect(RECIPES.fuel_rod_assembler!.inputs).toEqual({ uranium_ore: 5, stainless_steel: 2, coolant: 2 });
    expect(RECIPES.fuel_rod_assembler!.outputs).toEqual({ nuclear_fuel_rod: 1 });
    expect(RECIPES.fuel_rod_assembler!.cycleSec).toBe(286.7);
  });
});

describe('plasma_containment_assembler (Task 11.4)', () => {
  it('is T4 manufacturing with 2x2 footprint', () => {
    const def = BUILDING_DEFS.plasma_containment_assembler;
    expect(def).toBeDefined();
    expect(def.tier).toBe(4);
    expect(def.footprint.tiles.length).toBe(4);
    expect(def.category).toBe('manufacturing');
  });
  it('has power consumption 600W', () => {
    expect(BUILDING_DEFS.plasma_containment_assembler.power?.consumes).toBe(600);
  });
  it('produces plasma_containment_vessel from exotic_alloy + magnet + steel', () => {
    expect(RECIPES.plasma_containment_assembler).toBeDefined();
    expect(RECIPES.plasma_containment_assembler!.inputs).toEqual({ exotic_alloy: 1, magnet: 4, steel: 5 });
    expect(RECIPES.plasma_containment_assembler!.outputs).toEqual({ plasma_containment_vessel: 1 });
    expect(RECIPES.plasma_containment_assembler!.cycleSec).toBe(286.7);
  });
});

describe('singularity_sensor_lab (Task 11.4)', () => {
  it('is T4 electronics with 2x2 footprint', () => {
    const def = BUILDING_DEFS.singularity_sensor_lab;
    expect(def).toBeDefined();
    expect(def.tier).toBe(4);
    expect(def.footprint.tiles.length).toBe(4);
    expect(def.category).toBe('electronics');
  });
  it('has power consumption 500W', () => {
    expect(BUILDING_DEFS.singularity_sensor_lab.power?.consumes).toBe(500);
  });
  it('produces singularity_sensor from quantum_chip + optical_fiber + magnet', () => {
    expect(RECIPES.singularity_sensor_lab).toBeDefined();
    expect(RECIPES.singularity_sensor_lab!.inputs).toEqual({ quantum_chip: 1, optical_fiber: 4, magnet: 2 });
    expect(RECIPES.singularity_sensor_lab!.outputs).toEqual({ singularity_sensor: 1 });
    expect(RECIPES.singularity_sensor_lab!.cycleSec).toBe(2687478.5);
  });
});

describe('cryo_containment_assembler (Task 11.4)', () => {
  it('is T4 manufacturing with 2x2 footprint', () => {
    const def = BUILDING_DEFS.cryo_containment_assembler;
    expect(def).toBeDefined();
    expect(def.tier).toBe(4);
    expect(def.footprint.tiles.length).toBe(4);
    expect(def.category).toBe('manufacturing');
  });
  it('has power consumption 500W', () => {
    expect(BUILDING_DEFS.cryo_containment_assembler.power?.consumes).toBe(500);
  });
  it('produces cryo_containment_unit from cryogenic_compound + stainless_steel + glass_fiber', () => {
    expect(RECIPES.cryo_containment_assembler).toBeDefined();
    expect(RECIPES.cryo_containment_assembler!.inputs).toEqual({ cryogenic_compound: 1, stainless_steel: 2, glass_fiber: 4 });
    expect(RECIPES.cryo_containment_assembler!.outputs).toEqual({ cryo_containment_unit: 1 });
    expect(RECIPES.cryo_containment_assembler!.cycleSec).toBe(286.7);
  });
});

describe('accelerator_core_lab (Task 11.4)', () => {
  it('is T4 electronics with 2x2 footprint', () => {
    const def = BUILDING_DEFS.accelerator_core_lab;
    expect(def).toBeDefined();
    expect(def.tier).toBe(4);
    expect(def.footprint.tiles.length).toBe(4);
    expect(def.category).toBe('electronics');
  });
  it('has power consumption 800W', () => {
    expect(BUILDING_DEFS.accelerator_core_lab.power?.consumes).toBe(800);
  });
  it('produces particle_accelerator_core from magnet + exotic_alloy + optical_fiber', () => {
    expect(RECIPES.accelerator_core_lab).toBeDefined();
    expect(RECIPES.accelerator_core_lab!.inputs).toEqual({ magnet: 8, exotic_alloy: 1, optical_fiber: 4 });
    expect(RECIPES.accelerator_core_lab!.outputs).toEqual({ particle_accelerator_core: 1 });
    expect(RECIPES.accelerator_core_lab!.cycleSec).toBe(286.7);
  });
});

describe('self_replication_lab (Task 11.4)', () => {
  it('is T4 manufacturing with 3x3 footprint', () => {
    const def = BUILDING_DEFS.self_replication_lab;
    expect(def).toBeDefined();
    expect(def.tier).toBe(4);
    expect(def.footprint.tiles.length).toBe(9);
    expect(def.category).toBe('manufacturing');
  });
  it('has power consumption 700W', () => {
    expect(BUILDING_DEFS.self_replication_lab.power?.consumes).toBe(700);
  });
  it('produces self_replication_module from ai_core + microchip + electric_motor + computing_module', () => {
    expect(RECIPES.self_replication_lab).toBeDefined();
    expect(RECIPES.self_replication_lab!.inputs).toEqual({ ai_core: 1, microchip: 8, electric_motor: 4, computing_module: 2 });
    expect(RECIPES.self_replication_lab!.outputs).toEqual({ self_replication_module: 1 });
    expect(RECIPES.self_replication_lab!.cycleSec).toBe(127.4);
  });
});


describe('§12.3 kit_assembler_enriched (Task 13.2)', () => {
  it('is T3 manufacturing with 2x2 footprint', () => {
    const def = BUILDING_DEFS.kit_assembler_enriched;
    expect(def).toBeDefined();
    expect(def.tier).toBe(3);
    expect(def.footprint).toEqual(SHAPES.square2);
    expect(def.category).toBe('manufacturing');
  });
  it('has power consumption 150W', () => {
    expect(BUILDING_DEFS.kit_assembler_enriched.power?.consumes).toBe(150);
  });
  it('produces foundation_kit_enriched from steel + microchip + wire + gear', () => {
    expect(RECIPES.kit_assembler_enriched).toBeDefined();
    expect(RECIPES.kit_assembler_enriched!.inputs).toEqual({ steel: 5, microchip: 1, wire: 5, gear: 5 });
    expect(RECIPES.kit_assembler_enriched!.outputs).toEqual({ foundation_kit_enriched: 1 });
    expect(RECIPES.kit_assembler_enriched!.cycleSec).toBe(85999.3);
  });
});

describe('§12.3 kit_assembler_refined (Task 13.2)', () => {
  it('is T4 manufacturing with 3x3 footprint', () => {
    const def = BUILDING_DEFS.kit_assembler_refined;
    expect(def).toBeDefined();
    expect(def.tier).toBe(4);
    expect(def.footprint.tiles.length).toBe(9);
    expect(def.category).toBe('manufacturing');
  });
  it('has power consumption 300W', () => {
    expect(BUILDING_DEFS.kit_assembler_refined.power?.consumes).toBe(300);
  });
  it('produces foundation_kit_refined from stainless_steel + quantum_chip + fuel_cell + computing_module', () => {
    expect(RECIPES.kit_assembler_refined).toBeDefined();
    expect(RECIPES.kit_assembler_refined!.inputs).toEqual({ stainless_steel: 5, quantum_chip: 1, fuel_cell: 1, computing_module: 1 });
    expect(RECIPES.kit_assembler_refined!.outputs).toEqual({ foundation_kit_refined: 1 });
    expect(RECIPES.kit_assembler_refined!.cycleSec).toBe(101925.1);
  });
});


describe('§6.7 steel_mill_scrap (Task 13.3)', () => {
  it('is T2 smelting with 3x3 footprint', () => {
    const def = BUILDING_DEFS.steel_mill_scrap;
    expect(def).toBeDefined();
    expect(def.tier).toBe(2);
    expect(def.footprint.tiles.length).toBe(9);
    expect(def.category).toBe('smelting');
  });
  it('has power consumption 120W', () => {
    expect(BUILDING_DEFS.steel_mill_scrap.power?.consumes).toBe(120);
  });
  it('produces steel + slag from scrap', () => {
    expect(RECIPES.steel_mill_scrap).toBeDefined();
    expect(RECIPES.steel_mill_scrap!.inputs).toEqual({ scrap: 2 });
    expect(RECIPES.steel_mill_scrap!.outputs).toEqual({ steel: 1, slag: 1 });
    expect(RECIPES.steel_mill_scrap!.cycleSec).toBe(72.8);
  });
});

describe('mass-positive placement check (§9.3)', () => {
  it('every BUILDING_DEFS entry has Σ (units × kg/unit) > 1 kg', () => {
    for (const [id, def] of Object.entries(BUILDING_DEFS)) {
      const mass = Object.entries(def.placementCost ?? {}).reduce(
        (acc, [r, qty]) => acc + (qty as number) * (RESOURCE_META[r as keyof typeof RESOURCE_META]?.massPerUnitKg ?? 0),
        0,
      );
      expect(mass, `${id} has >1 kg embodied mass`).toBeGreaterThan(1);
    }
  });
});

describe('BOM citation snapshot (§9.2)', () => {
  it('every placementCost has a preceding BOM source: or analog: comment', () => {
    const source = readFileSync('src/building-defs.ts', 'utf8');
    const lines = source.split('\n');
    const missing: string[] = [];
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i]!;
      if (line.includes('placementCost:')) {
        const hasCitation = [-1, -2, -3, -4, -5, -6, -7, -8, -9, -10].some((dy) =>
          lines[i + dy]?.match(/(BOM source|analog):/),
        );
        if (!hasCitation) missing.push(`line ${i + 1}: ${line.trim()}`);
      }
    }
    expect(missing, 'every placementCost has a BOM citation').toEqual([]);
  });
});

describe('CATEGORY_ADJACENCY_RATE', () => {
  const ALL_CATEGORIES = [
    'extraction', 'smelting', 'chemistry', 'manufacturing', 'electronics',
    'power', 'storage', 'logistics', 'cooling', 'production', 'special',
  ] as const;

  it('defines a rate for every BuildingCategory, seeded at 0.05', () => {
    for (const cat of ALL_CATEGORIES) {
      expect(CATEGORY_ADJACENCY_RATE[cat]).toBe(0.05);
    }
  });

  it('covers every category actually used by a building def', () => {
    for (const def of Object.values(BUILDING_DEFS)) {
      expect(CATEGORY_ADJACENCY_RATE[def.category]).toBeTypeOf('number');
    }
  });
});

describe('LAND_TILE_COST', () => {
  it('is the per-land-tile structural basket', () => {
    expect(LAND_TILE_COST).toEqual({ steel_beam: 1, concrete: 10 });
  });
});

// Resource-graph-closure plan P2 — endgame structural components are consumed
// by the placement cost of the building they belong to (a non-recipe sink ⇒
// gameplay-sink). Each consumer building's tier ≥ the component's producer-lab
// tier, so it's bootstrap-safe. The two fuel-like components
// (antimatter_propellant, plasma_charge) are deferred to P4 (consumed per-use,
// not a structural placement cost).
describe('closure P2 — endgame components consumed by placement cost', () => {
  const COMPONENT_BUILDING: ReadonlyArray<readonly [ResourceId, BuildingDefId]> = [
    ['singularity_battery_unit', 'singularity_battery'],
    ['particle_accelerator_core', 'particle_accelerator'],
    ['cryo_containment_unit', 'cryogenic_compute_center'],
    ['singularity_sensor', 'orbital_tracking_station'],
    ['probability_calculator', 'probability_engine'],
    ['aether_beacon', 'lighthouse_t6'],
    ['reality_engine', 'universe_editor'],
  ];
  for (const [component, building] of COMPONENT_BUILDING) {
    it(`${building} placement cost consumes ${component} (no longer an orphan)`, () => {
      expect(BUILDING_DEFS[building].placementCost?.[component] ?? 0).toBeGreaterThan(0);
      expect(RESOURCE_META[component].terminal).toBe('gameplay-sink');
    });
  }
});

describe('§5.2 heat — every requiresHeat def carries a kW demand (boolean heat retired)', () => {
  it('every requiresHeat building has a positive heatDemandKW', () => {
    for (const [id, def] of Object.entries(BUILDING_DEFS)) {
      if (!def.requiresHeat) continue;
      expect(def.heatDemandKW, `${id} requiresHeat but has no heatDemandKW`).toBeDefined();
      expect(def.heatDemandKW!, `${id} heatDemandKW must be > 0`).toBeGreaterThan(0);
    }
  });

  it('every heatSource def carries a positive thermalKW', () => {
    for (const [id, def] of Object.entries(BUILDING_DEFS)) {
      if (!def.heatSource) continue;
      expect(def.heatSource.thermalKW, `${id} heatSource must have thermalKW`).toBeDefined();
      expect(def.heatSource.thermalKW!, `${id} thermalKW must be > 0`).toBeGreaterThan(0);
    }
  });
});
