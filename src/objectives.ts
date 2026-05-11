// Objectives ladder: short-term goals from session 1 up to the §13.4 endgame.
//
// Pure — no PixiJS, no DOM. All checks are synchronous reads against a
// `GameSnapshot` pulled from the live world every frame.
//
// Design: OBJECTIVES is an ordered array; `currentObjective` returns the
// FIRST entry whose `check` returns false. That makes the banner always
// point at "what the player hasn't done yet" without needing a persistent
// completion ledger. Non-monotonic checks (e.g. iron_ingot stock can dip
// below 50 after smelting) may briefly revert — that's acceptable at this
// fidelity level.

import type { IslandSpec, WorldState } from './world.js';
import type { IslandState } from './economy.js';
import type { Route } from './routes.js';
import type { Drone } from './drones.js';

// ---------------------------------------------------------------------------
// Snapshot — what the objective checks can read
// ---------------------------------------------------------------------------

export interface GameSnapshot {
  readonly islands: ReadonlyArray<IslandSpec>;
  readonly islandStates: ReadonlyMap<string, IslandState>;
  readonly activeIslandId: string;
  /** Live drone fleet from WorldState. Needed for dispatch_drone check. */
  readonly drones: ReadonlyArray<Drone>;
  /** All player-created routes. Needed for establish_route check. */
  readonly routes: ReadonlyArray<Route>;
}

// ---------------------------------------------------------------------------
// Objective interface
// ---------------------------------------------------------------------------

export interface Objective {
  readonly id: string;
  readonly label: string;
  readonly description: string;
  readonly check: (snap: GameSnapshot) => boolean;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** True if any populated island has a building with the given defId. */
function anyIslandHasBuilding(snap: GameSnapshot, defId: string): boolean {
  for (const state of snap.islandStates.values()) {
    if (state.buildings.some((b) => b.defId === defId)) return true;
  }
  return false;
}

// ---------------------------------------------------------------------------
// OBJECTIVES ladder (ordered — currentObjective returns first uncomplete)
// ---------------------------------------------------------------------------

export const OBJECTIVES: ReadonlyArray<Objective> = [
  {
    id: 'reach_level_5',
    label: 'Reach Level 5',
    description: 'Reach Level 5 on any island.',
    check: (snap) => {
      for (const state of snap.islandStates.values()) {
        if (state.level >= 5) return true;
      }
      return false;
    },
  },
  {
    id: 'place_smelter',
    label: 'Place a Smelter',
    description: 'Place a Smelter building on any island.',
    check: (snap) => anyIslandHasBuilding(snap, 'smelter'),
  },
  {
    id: 'produce_iron_ingot',
    label: 'Produce 50 Iron Ingot',
    description: 'Accumulate at least 50 iron_ingot in stock on any island.',
    check: (snap) => {
      for (const state of snap.islandStates.values()) {
        if ((state.inventory['iron_ingot'] ?? 0) >= 50) return true;
      }
      return false;
    },
  },
  {
    id: 'place_assembler',
    label: 'Place an Assembler',
    description: 'Place an Assembler building on any island.',
    check: (snap) => anyIslandHasBuilding(snap, 'assembler'),
  },
  {
    id: 'dispatch_drone',
    label: 'Dispatch a Drone',
    description: 'Send a drone to explore the world.',
    // Drone list toggles (drones disappear on return), so we also check for
    // hidden islands that have been revealed — a monotonic signal once any
    // hidden-* island is discovered by drone.
    check: (snap) => {
      if (snap.drones.length >= 1) return true;
      return snap.islands.some(
        (s) => s.id.startsWith('hidden-') && s.discovered,
      );
    },
  },
  {
    id: 'establish_route',
    label: 'Create a Cargo Route',
    description: 'Establish at least one inter-island cargo route.',
    check: (snap) => snap.routes.length >= 1,
  },
  {
    id: 'settle_island',
    label: 'Settle a New Island',
    description: 'Settle a third island (home plus two more).',
    // Count populated islands; ≥ 3 means home + at least two colonies.
    check: (snap) => snap.islands.filter((s) => s.populated).length >= 3,
  },
  {
    id: 'reach_tier_3',
    label: 'Reach Tier 3',
    description: 'Reach Tier 3 (level 15) on any island.',
    check: (snap) => {
      for (const state of snap.islandStates.values()) {
        if (state.level >= 15) return true;
      }
      return false;
    },
  },
  {
    id: 'craft_steel',
    label: 'Produce Steel',
    description: 'Have at least 1 steel in stock on any island.',
    check: (snap) => {
      for (const state of snap.islandStates.values()) {
        if ((state.inventory['steel'] ?? 0) >= 1) return true;
      }
      return false;
    },
  },
  {
    id: 'reach_tier_4',
    label: 'Reach Tier 4',
    description: 'Reach Tier 4 (level 30) on any island.',
    check: (snap) => {
      for (const state of snap.islandStates.values()) {
        if (state.level >= 30) return true;
      }
      return false;
    },
  },
  {
    id: 'craft_ai_core',
    label: 'Craft an AI Core',
    description: 'Have at least 1 ai_core in stock on any island.',
    check: (snap) => {
      for (const state of snap.islandStates.values()) {
        if ((state.inventory['ai_core'] ?? 0) >= 1) return true;
      }
      return false;
    },
  },
  {
    id: 'reach_tier_5',
    label: 'Reach Tier 5',
    description: 'Reach Tier 5 (level 50 + AI Core crafted) on any island.',
    check: (snap) => {
      for (const state of snap.islandStates.values()) {
        if (state.aiCoreCrafted && state.level >= 50) return true;
      }
      return false;
    },
  },
  {
    id: 'craft_reality_anchor',
    label: 'Craft a Reality Anchor',
    description: 'Have at least 1 reality_anchor in stock on any island.',
    check: (snap) => {
      for (const state of snap.islandStates.values()) {
        if ((state.inventory['reality_anchor'] ?? 0) >= 1) return true;
      }
      return false;
    },
  },
  {
    id: 'genesis_cell',
    label: 'Craft Genesis Cell',
    description: '§13.4 endgame: craft a Genesis Cell.',
    // Resource not yet implemented; check always returns false.
    check: () => false,
  },
  {
    id: 'ascendant_core',
    label: 'Craft Ascendant Core',
    description: '§13.4 endgame: construct the Ascendant Core.',
    // Resource not yet implemented; check always returns false.
    check: () => false,
  },
];

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Returns the first objective in OBJECTIVES whose check is not yet satisfied,
 * or null if all objectives are complete.
 */
export function currentObjective(snap: GameSnapshot): Objective | null {
  for (const obj of OBJECTIVES) {
    if (!obj.check(snap)) return obj;
  }
  return null;
}

/**
 * Returns the set of objective ids that are currently satisfied.
 * Walks OBJECTIVES linearly once; O(n × islandStates).
 */
export function completedObjectives(snap: GameSnapshot): Set<string> {
  const done = new Set<string>();
  for (const obj of OBJECTIVES) {
    if (obj.check(snap)) done.add(obj.id);
  }
  return done;
}

/**
 * Build a `GameSnapshot` from the live world + island-state map.
 * Called once per frame in main.ts; cheap (no copies of large arrays).
 */
export function makeGameSnapshot(
  worldState: WorldState,
  islandStates: ReadonlyMap<string, IslandState>,
  activeIslandId: string,
): GameSnapshot {
  return {
    islands: worldState.islands,
    islandStates,
    activeIslandId,
    drones: worldState.drones,
    routes: worldState.routes,
  };
}
