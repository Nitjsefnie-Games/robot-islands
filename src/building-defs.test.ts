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
  'logger',
  'smelter',
  'crate',
  'silo',
  'biomass_plant',
  'coke_oven',
  'blast_furnace',
  'steel_mill',
  'assembler',
  'tank',
  'electric_arc_furnace',
  'platform_constructor',
  // Step-12 T4 endgame (§6.5 / §9.5)
  'fusion_core',
  'pyroforge',
  'cryogenic_compute_center',
  'particle_accelerator',
  'launch_tower',
  // Step-13 T5 transcendent (§13.2 / §8.4 / §8.5 / §8.9)
  'casimir_tap',
  'reality_forge',
  'singularity_battery',
  'time_lock',
  'genesis_chamber',
  'universe_editor',
  'lattice_node',
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
  'lubricant_refinery',
  'diesel_refinery',
  'metal_rolling_mill',
  'silicon_crusher',
  'air_separator',
  'cryo_lab',
  'cryo_compressor',
  'kerosene_refinery',
  'lithography_lab',
  'drilling_rig',
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
];

// Helper: build a minimal IslandSpec for the canPlaceOnIsland tests. The
// pure helper only reads `biome` and `artificial`, so we can elide the
// other fields safely behind the IslandSpec contract.
function fakeSpec(biome: IslandSpec['biome'], artificial = false): IslandSpec {
  return {
    id: 'test',
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
      expect(def.width).toBeGreaterThan(0);
      expect(def.height).toBeGreaterThan(0);
      expect(Number.isInteger(def.width)).toBe(true);
      expect(Number.isInteger(def.height)).toBe(true);
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

  it('storage defs declare storageCap; others do not', () => {
    expect(BUILDING_DEFS.crate.storageCap).toBe(100);
    expect(BUILDING_DEFS.silo.storageCap).toBe(2000);
    expect(BUILDING_DEFS.tank.storageCap).toBe(2000);
    // Non-storage defs must not declare storageCap (would silently
    // contribute to aggregateStorageCaps otherwise).
    expect(BUILDING_DEFS.mine.storageCap).toBeUndefined();
    expect(BUILDING_DEFS.workshop.storageCap).toBeUndefined();
    expect(BUILDING_DEFS.solar.storageCap).toBeUndefined();
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
  it('all 5 T4 defs are present with tier 4', () => {
    for (const id of ['fusion_core', 'pyroforge', 'cryogenic_compute_center', 'particle_accelerator', 'launch_tower'] as const) {
      expect(BUILDING_DEFS[id]).toBeDefined();
      expect(BUILDING_DEFS[id].tier).toBe(4);
    }
  });

  it('Fusion Core: 4×4, +5000W producer, no biome restriction', () => {
    const def = BUILDING_DEFS.fusion_core;
    expect(def.width).toBe(4);
    expect(def.height).toBe(4);
    expect(def.power?.produces).toBe(5000);
    expect(def.requiredBiomes).toBeUndefined();
  });

  it('Pyroforge: 3×3, -800W consumer, Volcanic-restricted', () => {
    const def = BUILDING_DEFS.pyroforge;
    expect(def.width).toBe(3);
    expect(def.height).toBe(3);
    expect(def.power?.consumes).toBe(800);
    expect(def.requiredBiomes).toEqual(['volcanic']);
  });

  it('Cryogenic Compute Center: 4×4, -1200W consumer, Arctic-restricted', () => {
    const def = BUILDING_DEFS.cryogenic_compute_center;
    expect(def.width).toBe(4);
    expect(def.height).toBe(4);
    expect(def.power?.consumes).toBe(1200);
    expect(def.requiredBiomes).toEqual(['arctic']);
  });

  it('Particle Accelerator: 4×4, -1500W consumer, no biome restriction', () => {
    const def = BUILDING_DEFS.particle_accelerator;
    expect(def.width).toBe(4);
    expect(def.height).toBe(4);
    expect(def.power?.consumes).toBe(1500);
    expect(def.requiredBiomes).toBeUndefined();
  });

  it('Launch Tower: 3×3, -400W consumer, no biome restriction, no recipe', () => {
    const def = BUILDING_DEFS.launch_tower;
    expect(def.width).toBe(3);
    expect(def.height).toBe(3);
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
});

describe('unlockedDefs', () => {
  it('returns every T1 id at level 1', () => {
    const list = unlockedDefs(1);
    // T1 defs in the catalog: mine, workshop, solar, coal_gen, dock,
    // dronepad, logger, smelter, crate, silo, biomass_plant. (Drone Pad
    // currently sits at T1 for the demo — see building-defs.ts.)
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
    expect(def.width).toBe(2);
    expect(def.height).toBe(2);
    expect(def.power?.produces).toBe(8000);
    expect(def.category).toBe('power');
    expect(def.requiredBiomes).toBeUndefined();
  });

  it('Reality Forge: 4×4, -3000W consumer, manufacturing', () => {
    const def = BUILDING_DEFS.reality_forge;
    expect(def.width).toBe(4);
    expect(def.height).toBe(4);
    expect(def.power?.consumes).toBe(3000);
    expect(def.category).toBe('manufacturing');
  });

  it('Singularity Battery: 2×2, power category with +10000 cap placeholder, low standby draw', () => {
    const def = BUILDING_DEFS.singularity_battery;
    expect(def.width).toBe(2);
    expect(def.height).toBe(2);
    expect(def.storageCap).toBe(10000);
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
