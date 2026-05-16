import { tierForLevel } from './skilltree.js';
import type { WorldState } from './world.js';

export type ObjectiveId =
  | 'place_solar'
  | 'place_logger'
  | 'place_quarry'
  | 'place_mine'
  | 'place_workshop'
  | 'reach_level_5'
  | 'build_dronepad'
  | 'dispatch_first_drone'
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
  | 'craft_reality_anchor'
  // §13.4 victory conditions
  | 'craft_ascendant_core'
  | 'craft_genesis_cell'
  | 'activate_omniscient_lattice';

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
  reach_level_5: {
    title: 'Grow',
    hint: 'Reach level 5 to unlock Tier 2.',
    check: (w) => Array.from(w.islandStates?.values() ?? []).some(s => tierForLevel(s.level) >= 2),
  },
  build_dronepad: {
    title: 'Take Flight',
    hint: 'Build a Drone Pad to scout the world.',
    check: (w) => Array.from(w.islandStates?.values() ?? []).some(s => s.buildings.some(b => b.defId === 'dronepad')),
  },
  dispatch_first_drone: {
    title: 'Explore',
    hint: 'Dispatch your first drone.',
    check: (w) => w.drones.length > 0,
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
  craft_ascendant_core: {
    title: 'Ignite the Ascendant Core',
    hint: 'Build an Ascendant Assembly and produce an Ascendant Core (T5→T6 gate).',
    check: (w) => Array.from(w.islandStates?.values() ?? []).some(s => (s.inventory.ascendant_core ?? 0) > 0),
  },
  craft_genesis_cell: {
    title: 'Forge a Genesis Cell',
    hint: 'Build a Genesis Forge — 24h cycle producing the first §13.4 victory artifact.',
    check: (w) => Array.from(w.islandStates?.values() ?? []).some(s => (s.inventory.genesis_cell ?? 0) > 0),
  },
  activate_omniscient_lattice: {
    title: 'Omniscient Lattice',
    hint: 'Connect enough Lattice Nodes across networked T5 islands to activate the Lattice.',
    check: (w) => w.latticeActive === true,
  },
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
