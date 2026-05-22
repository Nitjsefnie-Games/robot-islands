import { tierForLevel } from './skilltree.js';
import type { WorldState } from './world.js';

export type ObjectiveId =
  | 'place_solar'
  | 'place_logger'
  | 'place_quarry'
  | 'place_mine'
  | 'build_smelter'
  | 'place_workshop'
  | 'build_kit_assembler'
  | 'reach_level_5'
  | 'build_dronepad'
  // Biofuel chain slotted AFTER the Drone Pad: biofuel's only T1 consumer
  // is drone launches, so producing it before the Pad exists wastes
  // wood on an unspendable stockpile. The gate (Drone Pad needs T2) is
  // introduced before the consumer-introducing objectives.
  | 'build_biofuel_plant'
  | 'produce_biofuel'
  | 'dispatch_first_drone'
  | 'build_pump_jack'
  | 'build_chlor_alkali_plant'
  // §4.7 maintenance materials — T1 set (lubricant + bolt). Slotted
  // here so the player sees them once they have T2 access (Lubricant
  // Refinery is T2) but before deeper T2 chains take over. T1
  // buildings hit their 12h maintenance threshold around the same
  // time the player is settling in to the T2 expansion.
  | 'build_lubricant_refinery'
  | 'produce_lubricant'
  | 'produce_bolts'
  | 'maintain_first_building'
  | 'build_diesel_chain'
  | 'build_shipyard'
  | 'settle_first_island'
  | 'build_antenna'
  // T3 / mid-game gates
  | 'reach_level_15'
  | 'build_coke_oven'
  | 'build_blast_furnace'
  | 'place_steel_mill'
  | 'build_rolling_mill'
  | 'build_silicon_chain'
  | 'build_lithography_lab'
  | 'build_air_separator'
  | 'build_drilling_rig'
  // T4 endgame approach
  | 'reach_level_30'
  | 'build_glass_chain'
  | 'build_hydrogen_chain'
  | 'build_quantum_chip_fab'
  | 'craft_ai_core'
  | 'build_pyroforge'
  | 'build_particle_accelerator'
  | 'build_quantum_manipulator'
  // T5 transcendence
  | 'reach_level_50'
  | 'build_reality_forge'
  | 'craft_reality_anchor';

export interface TutorialState {
  completed: Set<ObjectiveId>;
  current: ObjectiveId | null;
}

export const OBJECTIVES: Record<ObjectiveId, { title: string; hint: string; check: (world: WorldState) => boolean }> = {
  place_solar: {
    title: 'Power Up',
    hint: 'Place a Solar Panel on any grass tile (20 stone, 10 wood).',
    check: (w) => Array.from(w.islandStates?.values() ?? []).some(s => s.buildings.some(b => b.defId === 'solar')),
  },
  place_logger: {
    title: 'Renewable Wood',
    hint: 'Place a Logger on a tree tile (15 stone, 5 wood). Look for the small tree cluster on the home island.',
    check: (w) => Array.from(w.islandStates?.values() ?? []).some(s => s.buildings.some(b => b.defId === 'logger')),
  },
  place_quarry: {
    title: 'Renewable Stone',
    hint: 'Place a Quarry on a 2×2 stone cluster (25 stone, 15 wood). Look for the dark-grey stone block on the home island.',
    check: (w) => Array.from(w.islandStates?.values() ?? []).some(s => s.buildings.some(b => b.defId === 'quarry')),
  },
  place_mine: {
    title: 'Extract Resources',
    hint: 'Place a Mine on an ore vein or coal vein (30 stone, 15 wood). Wait for Quarry / Logger output if you ran low.',
    check: (w) => Array.from(w.islandStates?.values() ?? []).some(s => s.buildings.some(b => b.defId === 'mine')),
  },
  build_smelter: {
    title: 'Smelt Iron',
    hint: 'Place a Smelter — it turns iron ore + coal into iron ingots, the backbone of every Tier 2 building.',
    check: (w) => Array.from(w.islandStates?.values() ?? []).some((s) => s.buildings.some((b) => b.defId === 'smelter')),
  },
  place_workshop: {
    title: 'Craft Materials',
    hint: 'Place a Workshop — it crafts bolts from iron ore + coal, used for maintenance and foundation kits.',
    check: (w) => Array.from(w.islandStates?.values() ?? []).some(s => s.buildings.some(b => b.defId === 'workshop')),
  },
  build_kit_assembler: {
    title: 'Foundation Kits',
    hint: 'Place a Kit Assembler — it builds Foundation Kits (iron ingots + wood + bolts), required to settle new islands.',
    check: (w) => Array.from(w.islandStates?.values() ?? []).some((s) => s.buildings.some((b) => b.defId === 'kit_assembler')),
  },
  reach_level_5: {
    title: 'Grow',
    hint: 'Reach level 5 to unlock Tier 2 — the Drone Pad is a T2 building.',
    check: (w) => Array.from(w.islandStates?.values() ?? []).some(s => tierForLevel(s.level) >= 2),
  },
  build_dronepad: {
    title: 'Take Flight',
    hint: 'Build a Drone Pad to scout the world.',
    check: (w) => Array.from(w.islandStates?.values() ?? []).some(s => s.buildings.some(b => b.defId === 'dronepad')),
  },
  build_biofuel_plant: {
    title: 'Cheap Drone Fuel',
    hint: 'Place a Biofuel Plant — 2 wood → 1 biofuel. Powers the cheap T1 drones your new Drone Pad can launch.',
    check: (w) => Array.from(w.islandStates?.values() ?? []).some(s => s.buildings.some(b => b.defId === 'biofuel_plant')),
  },
  produce_biofuel: {
    title: 'Stockpile Biofuel',
    hint: 'Wait for your Biofuel Plant to produce 10+ biofuel — enough for your first T1 drone dispatch.',
    check: (w) => Array.from(w.islandStates?.values() ?? []).some(s => (s.inventory.biofuel ?? 0) >= 10),
  },
  dispatch_first_drone: {
    title: 'Explore',
    hint: 'Open Drone Ops (J), pick T1 drone (biofuel), arm launch, click a target tile.',
    check: (w) => w.drones.length > 0,
  },
  build_pump_jack: {
    title: 'Crude Oil',
    hint: 'Place a Pump Jack on an oil well tile — crude oil feeds lubricant and diesel.',
    check: (w) => Array.from(w.islandStates?.values() ?? []).some((s) => s.buildings.some((b) => b.defId === 'pump_jack')),
  },
  build_chlor_alkali_plant: {
    title: 'Chlorine',
    hint: 'Place a Chlor-Alkali Plant — it turns saltwater into chlorine, needed to refine lubricant.',
    check: (w) => Array.from(w.islandStates?.values() ?? []).some((s) => s.buildings.some((b) => b.defId === 'chlor_alkali_plant')),
  },
  build_lubricant_refinery: {
    title: 'Maintenance Materials',
    hint: 'Build a Lubricant Refinery (T2 chemistry) — crude oil + chlorine → lubricant, the base of every maintenance tier (§4.7).',
    check: (w) => Array.from(w.islandStates?.values() ?? []).some(s => s.buildings.some(b => b.defId === 'lubricant_refinery')),
  },
  produce_lubricant: {
    title: 'Produce Lubricant',
    // "Produce", not "stockpile": §4.7 maintenance auto-consumes lubricant
    // the instant a building needs it, so an inventory threshold is
    // unwinnable. `lubricantProduced` flips on first production instead.
    hint: 'Wait for your Lubricant Refinery to start producing lubricant — the base ingredient at every maintenance tier (§4.7).',
    check: (w) => Array.from(w.islandStates?.values() ?? []).some(s => s.lubricantProduced === true),
  },
  produce_bolts: {
    title: 'Produce Bolts',
    // Same auto-consumption reason as `produce_lubricant`: T1 maintenance
    // eats 5 bolts, so track first production via `boltProduced`.
    hint: 'Wait for your Workshop to start producing bolts (1 iron_ore + 1 coal → 1 bolt) — the second half of the T1 maintenance recipe.',
    check: (w) => Array.from(w.islandStates?.values() ?? []).some(s => s.boltProduced === true),
  },
  maintain_first_building: {
    title: 'First Maintenance Cycle',
    hint: 'When a T1 building hits 12h operating time and you have the materials, auto-maintenance fires (consumes 2 lubricant + 5 bolts, restores 100% efficiency). Watch the inspector for the maintainedAt stamp to advance past placement.',
    check: (w) => Array.from(w.islandStates?.values() ?? []).some(s => s.buildings.some(b => b.maintainedAt != null && b.placedAt != null && b.maintainedAt > b.placedAt)),
  },
  build_diesel_chain: {
    title: 'Diesel for T2 Drones',
    hint: 'T2 drones fly farther and shrug off storms. Build a Naphtha Cracker and a Diesel Refinery — your Pump Jack already supplies crude oil; stockpile 10+ diesel.',
    check: (w) => Array.from(w.islandStates?.values() ?? []).some(s => (s.inventory.diesel ?? 0) >= 10),
  },
  build_shipyard: {
    title: 'Build a Shipyard',
    hint: 'Place a Shipyard on a coastal tile — settlement ships launch from here.',
    check: (w) => Array.from(w.islandStates?.values() ?? []).some((s) => s.buildings.some((b) => b.defId === 'shipyard')),
  },
  settle_first_island: {
    title: 'Expand',
    hint: 'Open Settle Ops, load fuel and a Foundation Kit, and send a ship from your Shipyard to settle a new island.',
    check: (w) => w.islands.filter(i => i.populated).length >= 2,
  },
  build_antenna: {
    title: 'Stay Connected',
    hint: 'Build an Antenna so drones can transmit data.',
    check: (w) => Array.from(w.islandStates?.values() ?? []).some(s => s.buildings.some(b => b.defId.startsWith('antenna_'))),
  },
  reach_level_15: {
    title: 'Tier 3',
    hint: 'Reach island level 15 to unlock T3 buildings and the Platform Constructor.',
    check: (w) => Array.from(w.islandStates?.values() ?? []).some(s => tierForLevel(s.level) >= 3),
  },
  build_coke_oven: {
    title: 'Coke for Steel',
    hint: 'Place a Coke Oven — it bakes coal into coke for the steel chain.',
    check: (w) => Array.from(w.islandStates?.values() ?? []).some((s) => s.buildings.some((b) => b.defId === 'coke_oven')),
  },
  build_blast_furnace: {
    title: 'Pig Iron',
    hint: 'Place a Blast Furnace — iron ingots + coke → pig iron.',
    check: (w) => Array.from(w.islandStates?.values() ?? []).some((s) => s.buildings.some((b) => b.defId === 'blast_furnace')),
  },
  place_steel_mill: {
    title: 'Heavy Industry',
    hint: 'Place a Steel Mill — it smelts pig iron into steel, the foundation of Tier 3+.',
    check: (w) => Array.from(w.islandStates?.values() ?? []).some(s => s.buildings.some(b => b.defId === 'steel_mill')),
  },
  build_rolling_mill: {
    title: 'Draw Wire',
    hint: 'Place a Metal Rolling Mill — steel → wire, needed for microchips.',
    check: (w) => Array.from(w.islandStates?.values() ?? []).some((s) => s.buildings.some((b) => b.defId === 'metal_rolling_mill')),
  },
  build_silicon_chain: {
    title: 'Silicon',
    hint: 'Place a Quartz Mine (on a stone tile) and a Silicon Crusher — quartz → silicon.',
    check: (w) => Array.from(w.islandStates?.values() ?? []).some((s) => s.buildings.some((b) => b.defId === 'quartz_mine')) && Array.from(w.islandStates?.values() ?? []).some((s) => s.buildings.some((b) => b.defId === 'silicon_crusher')),
  },
  build_lithography_lab: {
    title: 'Microchips',
    hint: 'Place a Lithography Lab — silicon + wire → microchips, the core of all advanced tech.',
    check: (w) => Array.from(w.islandStates?.values() ?? []).some((s) => s.buildings.some((b) => b.defId === 'lithography_lab')),
  },
  build_air_separator: {
    title: 'Industrial Gases',
    hint: 'Place an Air Separator — it pulls argon, oxygen, and nitrogen from the air.',
    check: (w) => Array.from(w.islandStates?.values() ?? []).some((s) => s.buildings.some((b) => b.defId === 'air_separator')),
  },
  build_drilling_rig: {
    title: 'Helium-3',
    hint: 'Place a Drilling Rig on a helium vent — helium-3 feeds the endgame chains.',
    check: (w) => Array.from(w.islandStates?.values() ?? []).some((s) => s.buildings.some((b) => b.defId === 'drilling_rig')),
  },
  reach_level_30: {
    title: 'Tier 4 Endgame',
    hint: 'Push an island to level 30 to unlock biome-locked T4 uniques (Pyroforge, Cryo Lab, etc.).',
    check: (w) => Array.from(w.islandStates?.values() ?? []).some(s => tierForLevel(s.level) >= 4),
  },
  build_glass_chain: {
    title: 'Glass',
    hint: 'Place a Sand Pit and a Glassworks — sand → glass, required by every Tier 4 building.',
    check: (w) => Array.from(w.islandStates?.values() ?? []).some((s) => s.buildings.some((b) => b.defId === 'sand_pit')) && Array.from(w.islandStates?.values() ?? []).some((s) => s.buildings.some((b) => b.defId === 'glassworks')),
  },
  build_hydrogen_chain: {
    title: 'Hydrogen',
    hint: 'Place a Well and an Electrolyzer — fresh water → hydrogen.',
    check: (w) => Array.from(w.islandStates?.values() ?? []).some((s) => s.buildings.some((b) => b.defId === 'well')) && Array.from(w.islandStates?.values() ?? []).some((s) => s.buildings.some((b) => b.defId === 'electrolyzer')),
  },
  build_quantum_chip_fab: {
    title: 'Quantum Chips',
    hint: 'Place a Quantum Chip Fab — steel + pig iron → quantum chips.',
    check: (w) => Array.from(w.islandStates?.values() ?? []).some((s) => s.buildings.some((b) => b.defId === 'quantum_chip_fab')),
  },
  craft_ai_core: {
    title: 'Synthetic Mind',
    hint: 'Build a Cryogenic Compute Center and craft an AI Core (steel + quantum chip + argon) — required for Tier 5.',
    check: (w) => Array.from(w.islandStates?.values() ?? []).some(s => (s.inventory.ai_core ?? 0) > 0),
  },
  build_pyroforge: {
    title: 'Exotic Alloy',
    hint: 'Place a Pyroforge — steel + helium-3 → exotic alloy.',
    check: (w) => Array.from(w.islandStates?.values() ?? []).some((s) => s.buildings.some((b) => b.defId === 'pyroforge')),
  },
  build_particle_accelerator: {
    title: 'Antimatter',
    hint: 'Place a Particle Accelerator — hydrogen + exotic alloy + microchip → antimatter capsules.',
    check: (w) => Array.from(w.islandStates?.values() ?? []).some((s) => s.buildings.some((b) => b.defId === 'particle_accelerator')),
  },
  build_quantum_manipulator: {
    title: 'Time Crystals',
    hint: 'Place a Quantum Manipulator — helium-3 + exotic alloy → time crystals.',
    check: (w) => Array.from(w.islandStates?.values() ?? []).some((s) => s.buildings.some((b) => b.defId === 'quantum_manipulator')),
  },
  reach_level_50: {
    title: 'Transcendence',
    hint: 'Reach island level 50 to unlock T5 transcendent buildings.',
    check: (w) => Array.from(w.islandStates?.values() ?? []).some(s => tierForLevel(s.level) >= 5),
  },
  build_reality_forge: {
    title: 'The Reality Forge',
    hint: 'Place a Reality Forge — the Tier 5 capstone that forges Reality Anchors.',
    check: (w) => Array.from(w.islandStates?.values() ?? []).some((s) => s.buildings.some((b) => b.defId === 'reality_forge')),
  },
  craft_reality_anchor: {
    title: 'Reality Anchor',
    hint: 'Forge a Reality Anchor in the Reality Forge — foundational T5 component.',
    check: (w) => Array.from(w.islandStates?.values() ?? []).some(s => (s.inventory.reality_anchor ?? 0) > 0),
  },
  // Per spec §13.4: "No win screen. The game continues indefinitely after
  // Ascendant Core; the player has effectively become a god-tier robot
  // consciousness." The tutorial chain therefore deliberately STOPS at
  // craft_reality_anchor — players keep finding things to build past T5
  // without the game framing any artifact as "the finish."
};

export function checkObjectives(state: TutorialState, world: WorldState): ObjectiveId[] {
  const newlyCompleted: ObjectiveId[] = [];
  for (const [id, obj] of Object.entries(OBJECTIVES)) {
    if (state.completed.has(id as ObjectiveId)) continue;
    if (obj.check(world)) {
      state.completed.add(id as ObjectiveId);
      newlyCompleted.push(id as ObjectiveId);
    }
  }
  const order = Object.keys(OBJECTIVES) as ObjectiveId[];
  state.current = order.find(id => !state.completed.has(id)) ?? null;
  return newlyCompleted;
}
