// src/tutorial.ts — 32-step tutorial state machine + predicate helpers.
//
// Per rev-16 §11.2 + spec §05. Pure module — no DOM imports.
// Phase 7 commit 3 (new TUTORIAL_STEPS array + lifecycle functions).
// Backward-compatible exports for the pre-Phase-7 objective system
// (OBJECTIVES / checkObjectives / xpBumpPercentForCompletion) are
// retained so existing callers in main.ts, tutorial-ui.ts, and
// tutorial.test.ts continue to compile and pass.

import { BUILDING_DEFS } from './building-defs.js';
import type { BuildingDefId } from './building-defs.js';
import type { PlacedBuilding } from './buildings.js';
import { borderTiles, footprintKeySet, touchesBorder } from './adjacency.js';
import type { ResourceId } from './recipes.js';
import { tierForLevel } from './skilltree.js';
import type { WorldState } from './world.js';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type ObjectiveId = string;

export type TutorialPriority = 'critical' | 'recommended' | 'optional';

export interface TutorialStep {
  readonly id: ObjectiveId;
  readonly mechanic: string;
  readonly triggerCondition: (world: WorldState) => boolean;
  readonly hint: string;
  readonly expectedAction: string | null;
  readonly dismissalCondition: (world: WorldState) => boolean;
  readonly priority: TutorialPriority;
}

/** Runtime tutorial state.
 *
 *  `completed` is a Set at runtime (matches the shape seeded by
 *  `makeInitialWorld` and deserialized by persistence.ts).  The
 *  new Phase-7 helpers add `completedAt` for TTL-based soft-dismiss.
 */
export interface TutorialState {
  completed: Set<ObjectiveId>;
  current: ObjectiveId | null;
  completedAt?: Record<ObjectiveId, number>;
}

// ---------------------------------------------------------------------------
// Predicate helpers
// ---------------------------------------------------------------------------

/** True if any island has a placed (constructed) building whose defId
 *  matches any entry in `kinds`. */
function hasBuilding(w: WorldState, kinds: BuildingDefId[]): boolean {
  for (const isl of w.islands) {
    for (const b of isl.buildings) {
      if (kinds.includes(b.defId)) return true;
    }
  }
  return false;
}

/** True if any island state has ever held > 0 of resource `r`. */
function invSeen(w: WorldState, r: ResourceId): boolean {
  for (const s of w.islandStates?.values() ?? []) {
    if ((s.inventory[r] ?? 0) > 0) return true;
  }
  return false;
}

/** True if any island state currently holds >= `n` of resource `r`. */
function invAtLeast(w: WorldState, r: ResourceId, n: number): boolean {
  for (const s of w.islandStates?.values() ?? []) {
    if ((s.inventory[r] ?? 0) >= n) return true;
  }
  return false;
}

/** True if the player recently tried to place a building of `defId`
 *  and was rejected (missing resource / prereq).  Phase 5 wires
 *  `world.recentBuildAttempts`; until then this always returns false. */
function attemptedBuild(w: WorldState, defId: BuildingDefId): boolean {
  // TODO Phase 5 wire-up: world.recentBuildAttempts: Set<BuildingDefId>
  const attempts = (w as unknown as Record<string, unknown>).recentBuildAttempts as
    | Set<BuildingDefId>
    | undefined;
  return attempts?.has(defId) ?? false;
}

/** True if at least one placed building of `defId` has an adjacent
 *  heat-emitting building (Coal Furnace, Geothermal Vent, etc.). */
function hasAdjacentHeat(w: WorldState, defId: BuildingDefId): boolean {
  for (const isl of w.islands) {
    const targets: PlacedBuilding[] = [];
    const sources: PlacedBuilding[] = [];
    for (const b of isl.buildings) {
      if (b.defId === defId) targets.push(b);
      if (BUILDING_DEFS[b.defId]?.heatSource) sources.push(b);
    }
    if (targets.length === 0 || sources.length === 0) continue;
    for (const t of targets) {
      const fp = footprintKeySet(t, BUILDING_DEFS);
      const border = borderTiles(fp);
      for (const s of sources) {
        if (s.id === t.id) continue;
        if (touchesBorder(s, border, BUILDING_DEFS)) return true;
      }
    }
  }
  return false;
}

/** True if any two buildings with the same defId share an edge
 *  (4-neighbour adjacency) on the same island. */
function hasAdjacentSameType(w: WorldState): boolean {
  for (const isl of w.islands) {
    const buildings = isl.buildings;
    for (let i = 0; i < buildings.length; i++) {
      const a = buildings[i]!;
      const fpA = footprintKeySet(a, BUILDING_DEFS);
      const borderA = borderTiles(fpA);
      for (let j = i + 1; j < buildings.length; j++) {
        const b = buildings[j]!;
        if (b.defId !== a.defId) continue;
        if (touchesBorder(b, borderA, BUILDING_DEFS)) return true;
      }
    }
  }
  return false;
}

/** Soft-dismiss helper: true if `id` has been completed for at least
 *  `ttlMs` milliseconds.  Relies on `completedAt` timestamps written
 *  by `markCompleted`. */
function stepCompleted(w: WorldState, id: ObjectiveId, ttlMs: number): boolean {
  const ts = w.tutorialState;
  if (!ts) return false;
  const when = ts.completedAt?.[id];
  if (when == null) return false;
  return Date.now() - when >= ttlMs;
}

// ---------------------------------------------------------------------------
// Inline predicate helpers (used by individual steps)
// ---------------------------------------------------------------------------

function settledCount(w: WorldState): number {
  return w.islands.filter(i => i.populated).length;
}

function discoveredIslandCount(w: WorldState): number {
  return w.islands.filter(i => i.discovered).length;
}

function maxIslandLevel(w: WorldState): number {
  let max = 0;
  for (const s of w.islandStates?.values() ?? []) {
    if (s.level > max) max = s.level;
  }
  return max;
}

function unlockedNodeCount(w: WorldState): number {
  let count = 0;
  for (const s of w.islandStates?.values() ?? []) {
    count += s.unlockedNodes.size;
  }
  return count;
}

function anyResourceAtCap(w: WorldState): boolean {
  for (const s of w.islandStates?.values() ?? []) {
    for (const r of Object.keys(s.inventory) as ResourceId[]) {
      const cap = s.storageCaps[r] ?? 0;
      if (cap > 0 && (s.inventory[r] ?? 0) >= cap) return true;
    }
  }
  return false;
}

function hasBuildingUnderConstruction(_w: WorldState, _tier: number): boolean {
  // TODO Phase 5 wire-up: construction-time tracking on buildings.
  return false;
}

function solarBufferExhausted(_w: WorldState): boolean {
  // TODO Phase 5 wire-up: track overnight battery depletion.
  return false;
}

function anyBuildingNeedsMaintenance(_w: WorldState): boolean {
  // TODO Phase 5 wire-up: maintenance-threshold flags on buildings.
  return false;
}

function routeAttemptedPastRange(_w: WorldState): boolean {
  // TODO Phase 5 wire-up: record failed route attempts past antenna range.
  return false;
}

// ---------------------------------------------------------------------------
// 32-step TUTORIAL_STEPS
// ---------------------------------------------------------------------------

export const TUTORIAL_STEPS: ReadonlyArray<TutorialStep> = [
  {
    id: '01_map_picker',
    mechanic: 'Map picker',
    triggerCondition: (w) => w.playerLat == null,
    hint: 'Choose your location — real sunrise will follow real time at that spot.',
    expectedAction: 'Open the map picker and select a latitude/longitude.',
    dismissalCondition: (w) => w.playerLat != null,
    priority: 'critical',
  },
  {
    id: '02_bootstrap_power',
    mechanic: 'Bootstrap power',
    triggerCondition: (w) => w.playerLat != null && !hasBuilding(w, ['water_wheel', 'windmill_t0']),
    hint: 'Place a Water Wheel on the freshwater cluster (or Windmill on grass) to power your buildings.',
    expectedAction: 'Place a Water Wheel or Windmill.',
    dismissalCondition: (w) => hasBuilding(w, ['water_wheel', 'windmill_t0']),
    priority: 'critical',
  },
  {
    id: '03_building_placement',
    mechanic: 'Building placement',
    triggerCondition: (w) => hasBuilding(w, ['water_wheel', 'windmill_t0']) && !hasBuilding(w, ['mine']),
    hint: 'Drag the Mine from the build palette onto an ore tile.',
    expectedAction: 'Place a Mine on an ore vein.',
    dismissalCondition: (w) => hasBuilding(w, ['mine']),
    priority: 'critical',
  },
  {
    id: '04_tile_gate',
    mechanic: 'Resource extraction + tile-gate',
    triggerCondition: (w) => hasBuilding(w, ['mine']) && !invSeen(w, 'iron_ore'),
    hint: 'The Mine only extracts on ore tiles — see the green tile-highlight.',
    expectedAction: 'Wait for the Mine to produce iron ore.',
    dismissalCondition: (w) => invSeen(w, 'iron_ore'),
    priority: 'critical',
  },
  {
    id: '05_logger_placement',
    mechanic: 'Logger placement',
    triggerCondition: (w) => invSeen(w, 'iron_ore') && !hasBuilding(w, ['logger']),
    hint: 'Logger on the tree cluster keeps wood coming in.',
    expectedAction: 'Place a Logger on a tree tile.',
    dismissalCondition: (w) => hasBuilding(w, ['logger']),
    priority: 'critical',
  },
  {
    id: '06_iron_chain',
    mechanic: 'Smelter / iron chain',
    triggerCondition: (w) => invAtLeast(w, 'iron_ore', 10) && invAtLeast(w, 'coal', 3),
    hint: 'Smelter turns ore into iron ingots. 10 iron_ore + 3 coal → 6 iron_ingot + 2 slag + 5 CO.',
    expectedAction: 'Place a Smelter and wait for iron ingots.',
    dismissalCondition: (w) => invSeen(w, 'iron_ingot'),
    priority: 'critical',
  },
  {
    id: '07_heat_budget',
    mechanic: 'Heat budget',
    triggerCondition: (w) => hasBuilding(w, ['coke_oven']) && !hasAdjacentHeat(w, 'coke_oven'),
    hint: 'Coke Oven needs adjacent heat. Build a Coal Furnace next to it — and remember, one source feeds limited consumers.',
    expectedAction: 'Place a Coal Furnace adjacent to the Coke Oven.',
    dismissalCondition: (w) => hasAdjacentHeat(w, 'coke_oven') || !hasBuilding(w, ['coke_oven']),
    priority: 'critical',
  },
  {
    id: '08_adjacency_buff',
    mechanic: 'Adjacency buffs',
    triggerCondition: (w) => hasAdjacentSameType(w),
    hint: 'Adjacent same-type buildings get a +10% buff. Cluster wisely.',
    expectedAction: null,
    dismissalCondition: (w) => stepCompleted(w, '08_adjacency_buff', 30_000),
    priority: 'recommended',
  },
  {
    id: '09_copper_prospect',
    mechanic: 'Copper-ore prospecting',
    triggerCondition: (w) => attemptedBuild(w, 'cell_press') && !invSeen(w, 'copper_ingot'),
    hint: 'Cell Press needs copper electrodes. Build a Copper Mine on a copper-ore tile.',
    expectedAction: 'Place a Copper Mine.',
    dismissalCondition: (w) => invSeen(w, 'copper_ingot') || hasBuilding(w, ['copper_mine']),
    priority: 'critical',
  },
  {
    id: '10_limestone',
    mechanic: 'Limestone for steel',
    triggerCondition: (w) => attemptedBuild(w, 'blast_furnace') && !invSeen(w, 'limestone'),
    hint: 'Blast Furnace needs limestone flux. Build a Limestone Quarry on the limestone cluster.',
    expectedAction: 'Place a Limestone Quarry.',
    dismissalCondition: (w) => invSeen(w, 'limestone') || hasBuilding(w, ['limestone_quarry']),
    priority: 'critical',
  },
  {
    id: '11_construction_time',
    mechanic: 'Construction time',
    triggerCondition: (w) => hasBuildingUnderConstruction(w, 2),
    hint: 'Larger buildings take longer to construct.',
    expectedAction: null,
    dismissalCondition: (w) => stepCompleted(w, '11_construction_time', 20_000),
    priority: 'recommended',
  },
  {
    id: '12_storage_caps',
    mechanic: 'Storage caps',
    triggerCondition: (w) => anyResourceAtCap(w),
    hint: 'Each resource has a storage cap. Build Crates (single) or Silos (dry_goods category) to expand.',
    expectedAction: 'Place a Crate or Silo.',
    dismissalCondition: (w) => hasBuilding(w, ['crate', 'silo']) || !anyResourceAtCap(w),
    priority: 'recommended',
  },
  {
    id: '13_battery_bootstrap',
    mechanic: 'Battery Bank bootstrap',
    triggerCondition: (w) => solarBufferExhausted(w) || invAtLeast(w, 'saltwater_cell', 4),
    hint: 'Cell Press → saltwater_cell → Battery Bank stores daytime surplus.',
    expectedAction: 'Build a Battery Bank.',
    dismissalCondition: (w) => hasBuilding(w, ['battery_bank']),
    priority: 'critical',
  },
  {
    id: '14_day_night_solar',
    mechanic: 'Day-night solar',
    triggerCondition: (w) => hasBuilding(w, ['solar']),
    hint: 'Solar produces only when the sun is up. Pair with batteries for night.',
    expectedAction: null,
    dismissalCondition: (w) => stepCompleted(w, '14_day_night_solar', 60_000),
    priority: 'recommended',
  },
  {
    id: '15_co2_tracker',
    mechanic: 'CO₂ tracker',
    triggerCondition: (w) => w.totalCo2Kg >= 100,
    hint: 'Your industry emits CO₂. Tracked in the HUD; high totals worsen weather.',
    expectedAction: null,
    dismissalCondition: (w) => stepCompleted(w, '15_co2_tracker', 15_000),
    priority: 'recommended',
  },
  {
    id: '16_maintenance',
    mechanic: 'Maintenance',
    triggerCondition: (w) => anyBuildingNeedsMaintenance(w),
    hint: 'Buildings need periodic maintenance. The orange wrench means it is due.',
    expectedAction: 'Maintain the building.',
    dismissalCondition: (w) => !anyBuildingNeedsMaintenance(w),
    priority: 'recommended',
  },
  {
    id: '17_drones',
    mechanic: 'Drones',
    triggerCondition: (w) => hasBuilding(w, ['dronepad']),
    hint: 'Drones haul resources between buildings. Set fuel and target.',
    expectedAction: 'Launch a drone route.',
    dismissalCondition: (w) => {
      // TODO Phase 5 wire-up: w.droneRoutes
      const droneRoutes = (w as unknown as Record<string, unknown>).droneRoutes as
        | Set<unknown>
        | undefined;
      return stepCompleted(w, '17_drones', 30_000) || (droneRoutes?.size ?? 0) > 0;
    },
    priority: 'recommended',
  },
  {
    id: '18_lighthouse',
    mechanic: 'Discovery + lighthouse',
    triggerCondition: (w) => hasBuilding(w, ['lighthouse_t1', 'lighthouse_t2']),
    hint: 'Lighthouses extend your vision over the ocean.',
    expectedAction: 'Discover a new island.',
    dismissalCondition: (w) => {
      // TODO Phase 5 wire-up: w.startingDiscovered
      const startingDiscovered = (w as unknown as Record<string, unknown>).startingDiscovered as
        | number
        | undefined;
      return discoveredIslandCount(w) > (startingDiscovered ?? 1);
    },
    priority: 'recommended',
  },
  {
    id: '19_settlement',
    mechanic: 'Settlement vehicles',
    triggerCondition: (w) => {
      const startingDiscovered = (w as unknown as Record<string, unknown>).startingDiscovered as
        | number
        | undefined;
      return discoveredIslandCount(w) > (startingDiscovered ?? 1) && settledCount(w) === 1;
    },
    hint: 'Ships and helicopters carry Foundation Kits to new islands.',
    expectedAction: 'Settle a second island.',
    dismissalCondition: (w) => settledCount(w) >= 2,
    priority: 'critical',
  },
  {
    id: '20_antenna',
    mechanic: 'Antenna + signal range',
    triggerCondition: (w) => routeAttemptedPastRange(w),
    hint: 'Antennas extend signal coverage.',
    expectedAction: 'Place an Antenna.',
    dismissalCondition: (w) => hasBuilding(w, ['antenna_t1', 'antenna_t2', 'antenna_t3']),
    priority: 'recommended',
  },
  {
    id: '21_cargo_routes',
    mechanic: 'Cargo routes',
    triggerCondition: (w) => settledCount(w) >= 2,
    hint: 'Ship routes carry bulk cargo on schedule.',
    expectedAction: 'Create a cargo route.',
    dismissalCondition: (w) => {
      // TODO Phase 5 wire-up: w.cargoRoutes (distinct from w.routes)
      const cargoRoutes = (w as unknown as Record<string, unknown>).cargoRoutes as
        | Set<unknown>
        | undefined;
      return (cargoRoutes?.size ?? 0) >= 1;
    },
    priority: 'recommended',
  },
  {
    id: '22_skill_tree',
    mechanic: 'Skill tree T1 crystals',
    triggerCondition: (w) => maxIslandLevel(w) >= 30,
    hint: 'Spend Skill Crystals at the Skill Forge to unlock buffs.',
    expectedAction: 'Unlock a skill-tree node.',
    dismissalCondition: (w) => unlockedNodeCount(w) > 0,
    priority: 'recommended',
  },
  {
    id: '23_tier_t3',
    mechanic: 'Tier transition T2→T3',
    triggerCondition: (w) => hasBuilding(w, ['steel_mill']),
    hint: 'T3 chemistry / electronics unlocks. New buildings — Electrolyzer, Lithography Lab.',
    expectedAction: null,
    dismissalCondition: (w) => stepCompleted(w, '23_tier_t3', 30_000),
    priority: 'recommended',
  },
  {
    id: '24_reactor_toxicity',
    mechanic: 'Reactor toxicity',
    triggerCondition: (w) => hasBuilding(w, ['nuclear_reactor']),
    hint: 'Reactors leak radiation onto adjacent tiles. Cooling tower + wastewater mitigate.',
    expectedAction: null,
    dismissalCondition: (w) => stepCompleted(w, '24_reactor_toxicity', 60_000),
    priority: 'critical',
  },
  {
    id: '25_biome_gating',
    mechanic: 'Biome dependencies',
    triggerCondition: (w) => attemptedBuild(w, 'pyroforge') || attemptedBuild(w, 'carbon_forge'),
    hint: 'Pyroforge is Volcanic-only. Carbon Forge is Forest-only.',
    expectedAction: null,
    dismissalCondition: (w) => stepCompleted(w, '25_biome_gating', 30_000),
    priority: 'recommended',
  },
  {
    id: '26_weather_storms',
    mechanic: 'Weather + storms',
    triggerCondition: (w) => {
      // TODO Phase 5 wire-up: w.activeStormCount
      const activeStormCount = (w as unknown as Record<string, unknown>).activeStormCount as
        | number
        | undefined;
      return (activeStormCount ?? 0) > 0;
    },
    hint: 'Storms damage outdoor buildings. CO₂ accumulation worsens storm frequency.',
    expectedAction: null,
    dismissalCondition: (w) => {
      const activeStormCount = (w as unknown as Record<string, unknown>).activeStormCount as
        | number
        | undefined;
      return (activeStormCount ?? 0) === 0;
    },
    priority: 'recommended',
  },
  {
    id: '27_land_reclamation',
    mechanic: 'Land reclamation',
    triggerCondition: (w) => hasBuilding(w, ['platform_constructor']),
    hint: 'Reclaim ocean tiles to expand island footprints.',
    expectedAction: 'Reclaim 4 ocean tiles.',
    dismissalCondition: (w) => {
      // TODO Phase 5 wire-up: w.reclaimedTileCount
      const reclaimedTileCount = (w as unknown as Record<string, unknown>).reclaimedTileCount as
        | number
        | undefined;
      return (reclaimedTileCount ?? 0) >= 4;
    },
    priority: 'optional',
  },
  {
    id: '28_tier_t4',
    mechanic: 'Tier T3→T4',
    triggerCondition: (w) => invSeen(w, 'ai_core') || invSeen(w, 'exotic_alloy'),
    hint: 'T4 endgame. Fusion Core + Particle Accelerator unlock.',
    expectedAction: null,
    dismissalCondition: (w) => stepCompleted(w, '28_tier_t4', 30_000),
    priority: 'recommended',
  },
  {
    id: '29_orbital',
    mechanic: 'Orbital satellites',
    triggerCondition: (w) => hasBuilding(w, ['spaceport']),
    hint: 'Satellites extend discovery + comms. Each launch needs Antimatter Propellant + Orbital Insertion Package.',
    expectedAction: 'Launch a satellite.',
    dismissalCondition: (w) => w.satellites.length >= 1,
    priority: 'optional',
  },
  {
    id: '30_network_consciousness',
    mechanic: 'Network consciousness',
    triggerCondition: (w) => settledCount(w) >= 10,
    hint: 'Your network has reached consciousness threshold.',
    expectedAction: null,
    dismissalCondition: (w) => stepCompleted(w, '30_network_consciousness', 15_000),
    priority: 'optional',
  },
  {
    id: '31_tier_reset',
    mechanic: 'Tier reset',
    triggerCondition: (w) => {
      // TODO Phase 5 wire-up: w.tierResetTriggered
      const tierResetTriggered = (w as unknown as Record<string, unknown>).tierResetTriggered as
        | boolean
        | undefined;
      return tierResetTriggered === true;
    },
    hint: 'Tier Reset rebuilds the world with permanent skill carry-over.',
    expectedAction: null,
    dismissalCondition: (w) => {
      const tierResetCount = (w as unknown as Record<string, unknown>).tierResetCount as
        | number
        | undefined;
      return (tierResetCount ?? 0) >= 1;
    },
    priority: 'optional',
  },
  {
    id: '32_genesis_milestone',
    mechanic: 'Genesis milestone',
    triggerCondition: (w) => invAtLeast(w, 'genesis_cell', 1),
    hint: "You've crafted a Genesis Cell. Milestone, not a win condition.",
    expectedAction: null,
    dismissalCondition: (w) => invAtLeast(w, 'genesis_cell', 1),
    priority: 'optional',
  },
];

// ---------------------------------------------------------------------------
// New lifecycle functions (Phase 7)
// ---------------------------------------------------------------------------

export function currentStep(world: WorldState): TutorialStep | null {
  const ts = world.tutorialState ?? { completed: new Set<ObjectiveId>(), current: null };
  const completed = ts.completed;
  for (const step of TUTORIAL_STEPS) {
    if (completed.has(step.id)) continue;
    if (step.triggerCondition(world)) return step;
  }
  return null;
}

export function checkDismissals(world: WorldState): ObjectiveId[] {
  const ts = world.tutorialState ?? { completed: new Set<ObjectiveId>(), current: null };
  const completed = ts.completed;
  const dismissed: ObjectiveId[] = [];
  for (const step of TUTORIAL_STEPS) {
    if (completed.has(step.id)) continue;
    if (step.dismissalCondition(world)) dismissed.push(step.id);
  }
  return dismissed;
}

export function markCompleted(world: WorldState, id: ObjectiveId): void {
  world.tutorialState = world.tutorialState ?? { completed: new Set<ObjectiveId>(), current: null };
  world.tutorialState.completed.add(id);
  world.tutorialState.completedAt = world.tutorialState.completedAt ?? {};
  world.tutorialState.completedAt[id] = Date.now();
}

export function skipAll(world: WorldState): void {
  const ids = TUTORIAL_STEPS.map(s => s.id);
  world.tutorialState = {
    completed: new Set(ids),
    current: null,
  };
}

export function restart(world: WorldState): void {
  world.tutorialState = { completed: new Set<ObjectiveId>(), current: null };
}

// ---------------------------------------------------------------------------
// Backward-compatible pre-Phase-7 exports
// ---------------------------------------------------------------------------
//
// main.ts, tutorial-ui.ts, and tutorial.test.ts still consume these.
// They are preserved untouched so the suite stays green.

const _OBJECTIVES: Record<
  string,
  { title: string; hint: string; check: (world: WorldState) => boolean }
> = {

  place_solar: {
    title: 'Power Up',
    hint: 'Place a Wind Turbine on a water tile (30 steel, 10 wood). Wind produces power day and night.',
    check: (w) => Array.from(w.islandStates?.values() ?? []).some(s => s.buildings.some(b => b.defId === 'wind_turbine')),
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
    hint: 'Wait for your Lubricant Refinery to start producing lubricant — the base ingredient at every maintenance tier (§4.7).',
    check: (w) => Array.from(w.islandStates?.values() ?? []).some(s => s.lubricantProduced === true),
  },
  produce_bolts: {
    title: 'Produce Bolts',
    hint: 'Wait for your Workshop to start producing bolts (1 iron_ore + 1 coal → 1 bolt) — the second half of the T1 maintenance recipe.',
    check: (w) => Array.from(w.islandStates?.values() ?? []).some(s => s.boltProduced === true),
  },
  maintain_first_building: {
    title: 'First Maintenance Cycle',
    hint: 'When a T1 building hits 12h operating time and you have the materials, auto-maintenance fires (consumes 2 lubricant + 5 bolts, restores 100% efficiency). Watch the inspector for the maintainedAt stamp to advance past placement.',
    check: (w) => Array.from(w.islandStates?.values() ?? []).some(s => s.buildings.some(b => (b as unknown as Record<string, number | null>).maintainedAt != null && (b as unknown as Record<string, number | null>).placedAt != null && (b as unknown as Record<string, number | null>).maintainedAt! > (b as unknown as Record<string, number | null>).placedAt!)),
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
  build_hydrogen_chain: {
    title: 'Hydrogen',
    hint: 'Place a Well and an Electrolyzer — fresh water → hydrogen, the feedstock for high-tier ship and drone fuel.',
    check: (w) => Array.from(w.islandStates?.values() ?? []).some((s) => s.buildings.some((b) => b.defId === 'well')) && Array.from(w.islandStates?.values() ?? []).some((s) => s.buildings.some((b) => b.defId === 'electrolyzer')),
  },
  build_kerosene_refinery: {
    title: 'Aviation Kerosene',
    hint: 'Place a Kerosene Refinery — crude oil + hydrogen → aviation kerosene, the fuel ships and drones need to launch from a Tier 3 island.',
    check: (w) => Array.from(w.islandStates?.values() ?? []).some((s) => s.buildings.some((b) => b.defId === 'kerosene_refinery')),
  },
  build_cryo_fuel_chain: {
    title: 'Cryogenic Hydrogen',
    hint: 'Place a Cryo Lab and a Cryo Compressor — hydrogen + nitrogen → cryo coolant → cryogenic hydrogen, the Tier 4 ship and drone fuel.',
    check: (w) => Array.from(w.islandStates?.values() ?? []).some((s) => s.buildings.some((b) => b.defId === 'cryo_lab')) && Array.from(w.islandStates?.values() ?? []).some((s) => s.buildings.some((b) => b.defId === 'cryo_compressor')),
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
};

/** Backward-compat export: typed as `any` so `tutorial-ui.ts` (which
 *  indexes with `string`) does not hit `noUncheckedIndexedAccess`. */
export const OBJECTIVES = _OBJECTIVES as any;

/** Per-objective one-shot XP bump: the N-th completed objective injects
 *  N% of the next-level XP threshold into the home island's XP bar. */
export function xpBumpPercentForCompletion(completionIndex: number): number {
  return completionIndex;
}

export function checkObjectives(state: TutorialState, world: WorldState): ObjectiveId[] {
  const newlyCompleted: ObjectiveId[] = [];
  for (const [id, obj] of Object.entries(_OBJECTIVES)) {
    if (state.completed.has(id)) continue;
    if (obj.check(world)) {
      state.completed.add(id);
      newlyCompleted.push(id);
    }
  }
  const order = Object.keys(OBJECTIVES) as ObjectiveId[];
  state.current = order.find(id => !state.completed.has(id)) ?? null;
  return newlyCompleted;
}
