import { tierForLevel } from './skilltree.js';
import type { WorldState } from './world.js';

export type ObjectiveId =
  | 'place_solar'
  | 'place_logger'
  | 'place_quarry'
  | 'place_mine'
  | 'place_workshop'
  | 'build_biofuel_plant'
  | 'produce_biofuel'
  | 'reach_level_5'
  | 'build_dronepad'
  | 'dispatch_first_drone'
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
  | 'settle_first_island'
  | 'build_antenna'
  // T3 / mid-game gates
  | 'reach_level_15'
  | 'place_steel_mill'
  // T4 endgame approach
  | 'reach_level_30'
  | 'craft_ai_core'
  // T5 transcendence
  | 'reach_level_50'
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
  place_workshop: {
    title: 'Craft Materials',
    hint: 'Place a Workshop to craft iron ingots.',
    check: (w) => Array.from(w.islandStates?.values() ?? []).some(s => s.buildings.some(b => b.defId === 'workshop')),
  },
  build_biofuel_plant: {
    title: 'Cheap Drone Fuel',
    hint: 'Place a Biofuel Plant — 2 wood → 1 biofuel. Powers cheap T1 drones once you have a Drone Pad.',
    check: (w) => Array.from(w.islandStates?.values() ?? []).some(s => s.buildings.some(b => b.defId === 'biofuel_plant')),
  },
  produce_biofuel: {
    title: 'Stockpile Biofuel',
    hint: 'Wait for your Biofuel Plant to produce 10+ biofuel — enough for your first T1 drone dispatch.',
    check: (w) => Array.from(w.islandStates?.values() ?? []).some(s => (s.inventory.biofuel ?? 0) >= 10),
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
  dispatch_first_drone: {
    title: 'Explore',
    hint: 'Open Drone Ops (J), pick T1 drone (biofuel), arm launch, click a target tile.',
    check: (w) => w.drones.length > 0,
  },
  build_lubricant_refinery: {
    title: 'Maintenance Materials',
    hint: 'Resource buildings need maintenance materials after they have been running a while. Build a Lubricant Refinery (T2 chemistry) — lubricant is the base ingredient at every maintenance tier (§4.7).',
    check: (w) => Array.from(w.islandStates?.values() ?? []).some(s => s.buildings.some(b => b.defId === 'lubricant_refinery')),
  },
  produce_lubricant: {
    title: 'Stockpile Lubricant',
    hint: 'Wait for your Lubricant Refinery to produce 3+ lubricant — enough for one T1 maintenance cycle (2 lubricant + 5 bolts).',
    check: (w) => Array.from(w.islandStates?.values() ?? []).some(s => (s.inventory.lubricant ?? 0) >= 3),
  },
  produce_bolts: {
    title: 'Stockpile Bolts',
    hint: 'Your Workshop produces bolts (1 iron_ore + 1 coal → 1 bolt). Stockpile 5+ bolts — the second half of the T1 maintenance recipe.',
    check: (w) => Array.from(w.islandStates?.values() ?? []).some(s => (s.inventory.bolt ?? 0) >= 5),
  },
  maintain_first_building: {
    title: 'First Maintenance Cycle',
    hint: 'When a T1 building hits 12h operating time and you have the materials, auto-maintenance fires (consumes 2 lubricant + 5 bolts, restores 100% efficiency). Watch the inspector for the maintainedAt stamp to advance past placement.',
    check: (w) => Array.from(w.islandStates?.values() ?? []).some(s => s.buildings.some(b => b.maintainedAt != null && b.placedAt != null && b.maintainedAt > b.placedAt)),
  },
  build_diesel_chain: {
    title: 'Diesel for T2 Drones',
    hint: 'T2 drones are tougher in storms and fly farther. Build a Pump Jack, a Naphtha Cracker, and a Diesel Refinery; stockpile 10+ diesel.',
    check: (w) => Array.from(w.islandStates?.values() ?? []).some(s => (s.inventory.diesel ?? 0) >= 10),
  },
  settle_first_island: {
    title: 'Expand',
    hint: 'Send a ship to settle a new island.',
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
  place_steel_mill: {
    title: 'Heavy Industry',
    hint: 'Place a Steel Mill on any T3+ island to produce steel.',
    check: (w) => Array.from(w.islandStates?.values() ?? []).some(s => s.buildings.some(b => b.defId === 'steel_mill')),
  },
  reach_level_30: {
    title: 'Tier 4 Endgame',
    hint: 'Push an island to level 30 to unlock biome-locked T4 uniques (Pyroforge, Cryo Lab, etc.).',
    check: (w) => Array.from(w.islandStates?.values() ?? []).some(s => tierForLevel(s.level) >= 4),
  },
  craft_ai_core: {
    title: 'Synthetic Mind',
    hint: 'Craft an AI Core (Arctic Cryogenic Compute Center) — required for T5 mastery.',
    check: (w) => Array.from(w.islandStates?.values() ?? []).some(s => (s.inventory.ai_core ?? 0) > 0),
  },
  reach_level_50: {
    title: 'Transcendence',
    hint: 'Reach island level 50 to unlock T5 transcendent buildings.',
    check: (w) => Array.from(w.islandStates?.values() ?? []).some(s => tierForLevel(s.level) >= 5),
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
