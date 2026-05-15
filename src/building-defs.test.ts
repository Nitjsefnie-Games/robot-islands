// Building catalog completeness + tier-gating tests per SPEC §9.2.
//
// Every BuildingDefId in the type literal MUST have a corresponding entry
// in BUILDING_DEFS — otherwise indexed access `BUILDING_DEFS[b.defId]`
// returns undefined at runtime and rendering / economy lookups silently
// break. `noUncheckedIndexedAccess` only catches array reads; Record
// reads are fine until the runtime lookup fails.

import { describe, expect, it } from 'vitest';

import {
  ALL_BUILDING_DEF_IDS,
  BUILDING_DEFS,
  buildingUnlocked,
  canPlaceOnIsland,
  unlockedDefs,
  type BuildingDefId,
} from './building-defs.js';
import { SHAPES, shapeHeight, shapeWidth } from './shape-mask.js';
import { RECIPES } from './recipes.js';
import type { IslandSpec } from './world.js';

// Hand-mirrored list of every id in the union. If a new id is added to
// BuildingDefId, both this list AND BUILDING_DEFS must grow together —
// the completeness test below catches drift.
const KNOWN_DEF_IDS: ReadonlyArray<BuildingDefId> = [
  'mine',
  'workshop',
  'solar',
  'coal_gen',
  'dock',
  'dronepad',
  'patron_hub',
  'logger',
  'smelter',
  'crate',
  'silo',
  'biomass_plant',
  'coke_oven',
  'blast_furnace',
  'steel_mill',
  'oxygen_converter',
  'slag_reprocessor',
  'assembler',
  'fabricator',
  'precision_lab',
  'singularity_forge',
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
  'comm_sat_assembly',
  'orbital_insertion_assembly',
  // Step-18 recipe-graph closure (§7.1-§7.12)
  'quarry',
  'sand_pit',
  'well',
  'coastal_pump',
  'quartz_mine',
  'lumber_mill',
  'glassworks',
  'evaporator',
  'electrolyzer',
  'biofuel_plant',
  'pump_jack',
  'gas_extractor',
  'naphtha_cracker',
  'chlor_alkali_plant',
  'chemical_reactor',
  'lubricant_refinery',
  'diesel_refinery',
  'metal_rolling_mill',
  'silicon_crusher',
  'air_separator',
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
    // §4.6 categorized routing: storage carries { category, capacity }.
    expect(BUILDING_DEFS.crate.storage).toEqual({ category: 'generic', capacity: 100 });
    expect(BUILDING_DEFS.silo.storage).toEqual({ category: 'dry_goods', capacity: 2000 });
    expect(BUILDING_DEFS.tank.storage).toEqual({ category: 'liquid_gas', capacity: 2000 });
    expect(BUILDING_DEFS.cold_storage.storage).toEqual({ category: 'temp_sensitive', capacity: 1500 });
    expect(BUILDING_DEFS.component_warehouse.storage).toEqual({ category: 'components', capacity: 2000 });
    expect(BUILDING_DEFS.vault.storage).toEqual({ category: 'rare', capacity: 5000 });
    // Non-storage defs must not declare `storage` (would silently
    // contribute to aggregateStorageCaps otherwise).
    expect(BUILDING_DEFS.mine.storage).toBeUndefined();
    expect(BUILDING_DEFS.workshop.storage).toBeUndefined();
    expect(BUILDING_DEFS.solar.storage).toBeUndefined();
  });
});

describe('buildingUnlocked / tier gating (§9.2)', () => {
  it('T1 buildings unlock at level 1', () => {
    expect(buildingUnlocked(1, 'mine')).toBe(true);
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
    expect(buildingUnlocked(15, 'mine')).toBe(true);
    expect(buildingUnlocked(30, 'mine')).toBe(true);
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

  it('Fusion Core: 4×4, +5000W producer, no biome restriction', () => {
    const def = BUILDING_DEFS.fusion_core;
    expect(shapeWidth(def.footprint)).toBe(4);
    expect(shapeHeight(def.footprint)).toBe(4);
    expect(def.power?.produces).toBe(5000);
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
    expect(canPlaceOnIsland(BUILDING_DEFS.mine, fakeSpec('plains'))).toBe(true);
  });

  it('unrestricted defs ALSO place on artificial islands', () => {
    // Per §9.5, only biome-locked uniques are banned from artificial
    // islands. Unrestricted defs (Fusion Core, Mine, etc.) are fine.
    expect(canPlaceOnIsland(BUILDING_DEFS.fusion_core, fakeSpec('plains', true))).toBe(true);
    expect(canPlaceOnIsland(BUILDING_DEFS.particle_accelerator, fakeSpec('plains', true))).toBe(true);
    expect(canPlaceOnIsland(BUILDING_DEFS.mine, fakeSpec('plains', true))).toBe(true);
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
    expect(list).toContain('mine');
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
    expect(list).toContain('mine');
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
    expect(list).toContain('mine');
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
    expect(list).toContain('mine');
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
    expect(list).toContain('mine');
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
    expect(list).toContain('mine');
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

  it('Casimir Tap: 2×2, +8000W producer, power category', () => {
    const def = BUILDING_DEFS.casimir_tap;
    expect(shapeWidth(def.footprint)).toBe(2);
    expect(shapeHeight(def.footprint)).toBe(2);
    expect(def.power?.produces).toBe(8000);
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

  it('Singularity Battery: 2×2, power category with no resource storage, low standby draw', () => {
    // §8.4 "effectively infinite electrical power storage (not a resource
    // storage building)" — the §4.6 categorized-storage cleanup removed the
    // earlier 10000-cap placeholder. Power-buffer mechanic per §13.3 still
    // deferred to step 14+.
    const def = BUILDING_DEFS.singularity_battery;
    expect(shapeWidth(def.footprint)).toBe(2);
    expect(shapeHeight(def.footprint)).toBe(2);
    expect(def.storage).toBeUndefined();
    expect(def.power?.consumes).toBe(100);
    expect(def.category).toBe('power');
  });

  it('Time Lock / Genesis Chamber / Universe Editor / Lattice Node are special-category placeholders', () => {
    for (const id of ['time_lock', 'genesis_chamber', 'universe_editor', 'lattice_node'] as const) {
      const def = BUILDING_DEFS[id];
      expect(def.category).toBe('special');
      // Mechanics-deferred defs have no recipe — they're inert catalog rows
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
    expect(buildingUnlocked(1, 'mine', false)).toBe(true);
    expect(buildingUnlocked(1, 'mine', true)).toBe(true);
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

describe('chemical_reactor (§8.2 / §7.5)', () => {
  it('ships as a T2 chemistry def with 2x2 footprint', () => {
    const def = BUILDING_DEFS.chemical_reactor;
    expect(def).toBeDefined();
    expect(def.tier).toBe(2);
    expect(def.category).toBe('chemistry');
    expect(def.footprint).toEqual(SHAPES.square2);
  });
  it('produces chlorine from salt + fresh_water (§7.5 electrolysis)', () => {
    const recipe = RECIPES.chemical_reactor!;
    expect(recipe).toBeDefined();
    expect(recipe.inputs).toEqual({ salt: 1, fresh_water: 2 });
    expect(recipe.outputs).toEqual({ chlorine: 1 });
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
    'comm_sat_assembly',
    'orbital_insertion_assembly',
  ] as const;
  const ALL_T6_IDS = ['spaceport', ...T6_NON_SPACEPORT_IDS] as const;

  it('all 6 T6 defs are present with tier 6', () => {
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
      'comm_sat_assembly',
      'orbital_insertion_assembly',
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
    expect(buildingUnlocked(1, 'mine', false, false, false)).toBe(true);
    expect(buildingUnlocked(1, 'mine', true, true, true)).toBe(true);
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

  describe('§8.3 manufacturing buildings', () => {
  it('fabricator is T3, 3x3, manufacturing category', () => {
    const def = BUILDING_DEFS.fabricator;
    expect(def.tier).toBe(3);
    expect(def.footprint.tiles.length).toBe(9); // 3x3
    expect(def.category).toBe('manufacturing');
  });
  it('precision_lab is T3, 3x3, manufacturing category', () => {
    const def = BUILDING_DEFS.precision_lab;
    expect(def.tier).toBe(3);
    expect(def.footprint.tiles.length).toBe(9);
    expect(def.category).toBe('manufacturing');
  });
  it('singularity_forge is T4, 4x4, manufacturing category', () => {
    const def = BUILDING_DEFS.singularity_forge;
    expect(def.tier).toBe(4);
    expect(def.footprint.tiles.length).toBe(16);
    expect(def.category).toBe('manufacturing');
  });
});

describe('§8.1 T2 extraction buildings', () => {
    it('heavy_logger is T2, 2x2, requires tree (dense_forest deferred)', () => {
      const def = BUILDING_DEFS.heavy_logger;
      expect(def.tier).toBe(2);
      expect(def.footprint.tiles.length).toBe(4); // 2x2
      expect(def.requiredTile?.length).toBeGreaterThan(0);
    });
    it('deep_mine is T2, 2x3, requires ore vein', () => {
      const def = BUILDING_DEFS.deep_mine;
      expect(def.tier).toBe(2);
      expect(def.footprint.tiles.length).toBe(6); // 2x3
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
