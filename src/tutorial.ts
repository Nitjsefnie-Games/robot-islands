// src/tutorial.ts — 72-step tutorial state machine + predicate helpers.
//
// Per rev-16 §11.2 + spec §05. Pure module — no DOM imports.

import { BUILDING_DEFS } from './building-defs.js';
import type { BuildingDefId } from './building-defs.js';
import { borderTiles, footprintKeySet, touchesBorder } from './adjacency.js';
import type { ResourceId } from './recipes.js';
import { sumIslandCo2 } from './weather.js';
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
  /** The building defId this step asks the player to place. Set for build
   *  steps; omitted for concept/level/craft steps (expectedAction === null
   *  or a pure-craft milestone). */
  readonly targetDefId?: BuildingDefId;
}

/** Runtime tutorial state.
 *
 *  `completed` is a Set at runtime (matches the shape seeded by
 *  `makeInitialWorld` and deserialized by persistence.ts). `completedAt`
 *  drives TTL-based soft-dismiss.
 */
export interface TutorialState {
  completed: Set<ObjectiveId>;
  current: ObjectiveId | null;
  completedAt?: Record<ObjectiveId, number>;
  /** Wall-clock ms when each step was first surfaced (by `currentStep` on
   *  the tutorial poll). Drives the TTL soft-dismiss for concept steps.
   *  Transient like `completedAt` — never serialized; a step shown before a
   *  save simply re-stamps on its next show after load (TTL restarts). */
  shownAt?: Record<ObjectiveId, number>;
  /** Objective ids whose one-shot XP bump has been paid out. PERMANENT —
   *  preserved across `restart()` and filled by `skipAll`, so re-completing a
   *  reset tutorial grants no XP (closes the restart/skip XP farm). Optional /
   *  absent ≡ empty, lazy-initialised by `markBumpClaimed` (mirrors
   *  `completedAt`/`shownAt`). Persisted (schema v21). */
  xpBumpClaimed?: Set<ObjectiveId>;
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

/** Soft-dismiss helper: true if `id` has been *shown* for at least `ttlMs`
 *  milliseconds. Relies on `shownAt` timestamps written by `markShown` on
 *  the tutorial poll when the step is first surfaced.
 *
 *  This reads `shownAt`, not `completedAt`, on purpose: a concept step's TTL
 *  must be reachable *before* completion. (Reading `completedAt` created a
 *  cycle — `completedAt` is only written by `markCompleted`, which only runs
 *  for ids `checkDismissals` already returns — so the TTL could never fire.) */
function stepShownFor(w: WorldState, id: ObjectiveId, ttlMs: number): boolean {
  const ts = w.tutorialState;
  if (!ts) return false;
  const when = ts.shownAt?.[id];
  if (when == null) return false;
  return Date.now() - when >= ttlMs;
}

// ---------------------------------------------------------------------------
// Inline predicate helpers (used by individual steps)
// ---------------------------------------------------------------------------

function settledCount(w: WorldState): number {
  return w.islands.filter(i => i.populated).length;
}

function maxIslandLevel(w: WorldState): number {
  let max = 0;
  for (const s of w.islandStates?.values() ?? []) {
    if (s.level > max) max = s.level;
  }
  return max;
}

// ---------------------------------------------------------------------------
// 72-step TUTORIAL_STEPS — the final ordered tutorial chain.
//
// Source: docs/superpowers/specs/2026-05-29-tutorial-chain-final.md.
// Build steps carry `targetDefId` (the building defId the step asks the player
// to place); concept `[C]` / level-gate / craft-milestone steps omit it.
//
// Trigger style follows the existing convention: a build step gates on the
// nearest preceding *placed building* AND this target absent; dismiss = this
// target present. Concept/level steps trigger on a real signal and dismiss via
// `maxIslandLevel` / `invSeen` / `invAtLeast` or a `stepShownFor` TTL.
// ---------------------------------------------------------------------------

export const TUTORIAL_STEPS: ReadonlyArray<TutorialStep> = [
  // ---- T1 — Orientation, power, the iron chain (Level 1) ----
  {
    id: '01_location',
    mechanic: 'Location',
    triggerCondition: (w) => w.playerLat == null,
    hint: 'Click where you live — real sunrise & sunset follow real time at that spot.',
    expectedAction: 'Open the map picker, select your latitude/longitude.',
    dismissalCondition: (w) => w.playerLat != null,
    priority: 'critical',
  },
  {
    id: '02_inventory',
    mechanic: 'Your stockpile',
    triggerCondition: (w) => w.playerLat != null,
    hint: 'You start with 1200 stone, 600 wood, 30 iron ore, 80 coal, 60 iron ingots, 25 bolts, 15 limestone, 4 saltwater cells, 5000 scrap, 1 foundation kit.',
    expectedAction: null,
    dismissalCondition: (w) => stepShownFor(w, '02_inventory', 8_000),
    priority: 'recommended',
  },
  {
    id: '03_power',
    mechanic: 'Bootstrap power',
    triggerCondition: (w) => w.playerLat != null && !hasBuilding(w, ['water_wheel', 'windmill_t0']),
    hint: 'Build power first — you have none. Water Wheel on coastal water, or Windmill on grass.',
    expectedAction: 'Place a Water Wheel (50 wood / 30 stone / 5 iron ingot) on water — or Windmill (80 wood / 20 stone / 3 iron ingot) on grass.',
    dismissalCondition: (w) => hasBuilding(w, ['water_wheel', 'windmill_t0']),
    priority: 'critical',
    targetDefId: 'water_wheel',
  },
  {
    id: '04_power_scale',
    mechanic: 'Scale your power',
    triggerCondition: (w) => hasBuilding(w, ['water_wheel', 'windmill_t0']),
    hint: "One source isn't enough — a Mine needs 25 kW, a Water Wheel makes 20 kW. Build several; output throttles (brownout) until supply catches up.",
    expectedAction: 'Place more Water Wheels / Windmills.',
    dismissalCondition: (w) => stepShownFor(w, '04_power_scale', 30_000),
    priority: 'recommended',
  },
  {
    id: '05_quarry',
    mechanic: 'Renewable stone',
    triggerCondition: (w) => hasBuilding(w, ['water_wheel', 'windmill_t0']) && !hasBuilding(w, ['quarry']),
    hint: 'Stone underpins every build — keep it flowing.',
    expectedAction: 'Place a Quarry (120 stone / 80 wood / 30 iron ingot) on a stone 2×2.',
    dismissalCondition: (w) => hasBuilding(w, ['quarry']),
    priority: 'critical',
    targetDefId: 'quarry',
  },
  {
    id: '06_logger',
    mechanic: 'Renewable wood',
    triggerCondition: (w) => hasBuilding(w, ['quarry']) && !hasBuilding(w, ['logger']),
    hint: 'Logger needs no power and keeps wood coming.',
    expectedAction: 'Place a Logger (30 stone / 30 wood / 10 iron ingot) on a tree tile.',
    dismissalCondition: (w) => hasBuilding(w, ['logger']),
    priority: 'critical',
    targetDefId: 'logger',
  },
  {
    id: '07_mine',
    mechanic: 'Extract ore & coal',
    triggerCondition: (w) => hasBuilding(w, ['logger']) && !hasBuilding(w, ['mine']),
    hint: 'Mines pull iron ore (ore vein) and coal (coal vein).',
    expectedAction: 'Place a Mine (200 stone / 80 wood) on an ore or coal vein.',
    dismissalCondition: (w) => hasBuilding(w, ['mine']),
    priority: 'critical',
    targetDefId: 'mine',
  },
  {
    id: '08_tile_gate',
    mechanic: 'Tile-locked',
    triggerCondition: (w) => hasBuilding(w, ['mine']),
    hint: 'Extractors only place where every footprint tile matches the resource — watch the green highlight.',
    expectedAction: null,
    dismissalCondition: (w) => stepShownFor(w, '08_tile_gate', 12_000),
    priority: 'recommended',
  },
  {
    id: '09_clay',
    mechanic: 'Clay for smelting',
    triggerCondition: (w) => hasBuilding(w, ['mine']) && !hasBuilding(w, ['clay_pit_extractor']),
    hint: 'Clay lines the Smelter and feeds concrete & cement. Build on the clay pit.',
    expectedAction: 'Place a Clay Pit Extractor (140 stone / 80 wood) on clay_pit.',
    dismissalCondition: (w) => hasBuilding(w, ['clay_pit_extractor']),
    priority: 'critical',
    targetDefId: 'clay_pit_extractor',
  },
  {
    id: '10_smelter',
    mechanic: 'Smelt iron',
    triggerCondition: (w) => invAtLeast(w, 'iron_ore', 10) && invAtLeast(w, 'coal', 3) && !hasBuilding(w, ['smelter']),
    hint: '10 iron ore + 3 coal → 6 iron ingots (+ slag + CO) — the Tier-2 backbone.',
    expectedAction: 'Place a Smelter (400 stone / 100 clay / 20 wood).',
    dismissalCondition: (w) => hasBuilding(w, ['smelter']),
    priority: 'critical',
    targetDefId: 'smelter',
  },
  {
    id: '11_workshop',
    mechanic: 'Craft bolts',
    triggerCondition: (w) => hasBuilding(w, ['smelter']) && !hasBuilding(w, ['workshop']),
    hint: '1 iron ore + 1 coal → 1 bolt (maintenance & kits).',
    expectedAction: 'Place a Workshop (150 wood / 100 stone / 30 iron ingot).',
    dismissalCondition: (w) => hasBuilding(w, ['workshop']),
    priority: 'critical',
    targetDefId: 'workshop',
  },
  {
    id: '12_adjacency',
    mechanic: 'Adjacency buffs',
    triggerCondition: (w) => hasAdjacentSameType(w),
    hint: 'Cluster same-category buildings: each adjacent same-category building adds a flat +10% to recipe rate (and generator output), uncapped.',
    expectedAction: null,
    dismissalCondition: (w) => stepShownFor(w, '12_adjacency', 30_000),
    priority: 'recommended',
  },
  {
    id: '13_storage',
    mechanic: 'Storage caps',
    triggerCondition: (w) => hasBuilding(w, ['workshop']),
    hint: 'Each resource has a cap — build Crates to raise it.',
    expectedAction: 'Place a Crate (80 wood / 30 stone).',
    dismissalCondition: (w) => hasBuilding(w, ['crate', 'silo']) || stepShownFor(w, '13_storage', 20_000),
    priority: 'recommended',
    targetDefId: 'crate',
  },
  {
    id: '14_maintenance',
    mechanic: 'Maintenance',
    triggerCondition: (w) => hasBuilding(w, ['workshop']),
    hint: "Buildings need upkeep — the orange wrench means it's due.",
    expectedAction: null,
    dismissalCondition: (w) => stepShownFor(w, '14_maintenance', 15_000),
    priority: 'recommended',
  },
  {
    id: '15_co2',
    mechanic: 'CO₂ & climate',
    triggerCondition: (w) => sumIslandCo2(w) >= 100 || hasBuilding(w, ['smelter']),
    hint: 'Your industry emits CO₂ (shown in the HUD). High totals worsen weather.',
    expectedAction: null,
    dismissalCondition: (w) => stepShownFor(w, '15_co2', 15_000),
    priority: 'recommended',
  },

  // ---- T1 → T2 — Concrete, drones, fuel, first expansion (Level 5 gate) ----
  {
    id: '16_tier2',
    mechanic: 'Reach Tier 2',
    triggerCondition: (w) => hasBuilding(w, ['workshop']),
    hint: 'Production earns XP — push the home island to level 5 to unlock Tier 2.',
    expectedAction: null,
    dismissalCondition: (w) => maxIslandLevel(w) >= 5,
    priority: 'critical',
  },
  {
    id: '17_heat_budget',
    mechanic: 'Heat budget',
    triggerCondition: (w) => maxIslandLevel(w) >= 5 && !hasBuilding(w, ['coal_furnace', 'geothermal_vent', 'plasma_heater']),
    hint: 'Heat-using buildings (Limekiln, Cement Mill, Coke Oven, Ceramic Kiln) need an adjacent heat source. One source feeds limited consumers.',
    expectedAction: 'Place a Coal Furnace (50 stone / 20 iron ingot / 30 wood).',
    dismissalCondition: (w) => hasBuilding(w, ['coal_furnace', 'geothermal_vent', 'plasma_heater']),
    priority: 'critical',
    targetDefId: 'coal_furnace',
  },
  {
    id: '18_limestone',
    mechanic: 'Limestone flux',
    triggerCondition: (w) => hasBuilding(w, ['coal_furnace', 'geothermal_vent', 'plasma_heater']) && !hasBuilding(w, ['limestone_quarry']),
    hint: 'Limestone feeds quicklime (cement & steel).',
    expectedAction: 'Place a Limestone Quarry (150 stone / 80 wood / 30 iron ingot) on limestone.',
    dismissalCondition: (w) => hasBuilding(w, ['limestone_quarry']),
    priority: 'critical',
    targetDefId: 'limestone_quarry',
  },
  {
    id: '19_quicklime',
    mechanic: 'Quicklime',
    triggerCondition: (w) => hasBuilding(w, ['limestone_quarry']) && !hasBuilding(w, ['limekiln']),
    hint: '25 limestone → 14 quicklime. Needs adjacent heat.',
    expectedAction: 'Place a Limekiln (200 stone / 40 wood / 30 iron ingot / 50 clay) next to a Coal Furnace.',
    dismissalCondition: (w) => hasBuilding(w, ['limekiln']),
    priority: 'critical',
    targetDefId: 'limekiln',
  },
  {
    id: '20_sand',
    mechanic: 'Sand',
    triggerCondition: (w) => hasBuilding(w, ['limekiln']) && !hasBuilding(w, ['sand_pit']),
    hint: 'Sand → cement, glass, ceramics.',
    expectedAction: 'Place a Sand Pit (120 stone / 80 wood / 20 iron ingot) on sand.',
    dismissalCondition: (w) => hasBuilding(w, ['sand_pit']),
    priority: 'critical',
    targetDefId: 'sand_pit',
  },
  {
    id: '21_water',
    mechanic: 'Fresh water',
    triggerCondition: (w) => hasBuilding(w, ['sand_pit']) && !hasBuilding(w, ['well']),
    hint: 'A Well draws fresh water for concrete, hydrogen, and chemistry.',
    expectedAction: 'Place a Well (20 stone / 20 wood / 5 iron ingot) on water.',
    dismissalCondition: (w) => hasBuilding(w, ['well']),
    priority: 'critical',
    targetDefId: 'well',
  },
  {
    id: '22_saltwater',
    mechanic: 'Saltwater',
    triggerCondition: (w) => hasBuilding(w, ['well']) && !hasBuilding(w, ['coastal_pump']),
    hint: 'A Coastal Pump draws saltwater — feeds salt (→ chlorine) and the Battery cell chain.',
    expectedAction: 'Place a Coastal Pump (30 stone / 20 wood / 10 iron ingot) on water.',
    dismissalCondition: (w) => hasBuilding(w, ['coastal_pump']),
    priority: 'recommended',
    targetDefId: 'coastal_pump',
  },
  {
    id: '23_sulfur',
    mechanic: 'Sulfur',
    triggerCondition: (w) => hasBuilding(w, ['coastal_pump']) && !hasBuilding(w, ['sulfur_mine']),
    hint: 'Sulfur feeds calcium_sulfonate (the lubricant additive) & acids.',
    expectedAction: 'Place a Sulfur Mine (150 stone / 80 wood / 30 iron ingot) on sulfur_vein.',
    dismissalCondition: (w) => hasBuilding(w, ['sulfur_mine']),
    priority: 'recommended',
    targetDefId: 'sulfur_mine',
  },
  {
    id: '24_cement',
    mechanic: 'Cement',
    triggerCondition: (w) => hasBuilding(w, ['sulfur_mine']) && !hasBuilding(w, ['cement_mill']),
    hint: '8 quicklime + 2 clay + 1 sand → 11 cement. Needs adjacent heat.',
    expectedAction: 'Place a Cement Mill (200 stone / 60 iron ingot / 30 wood) next to a Coal Furnace.',
    dismissalCondition: (w) => hasBuilding(w, ['cement_mill']),
    priority: 'critical',
    targetDefId: 'cement_mill',
  },
  {
    id: '25_concrete',
    mechanic: 'Bulk material: concrete',
    triggerCondition: (w) => hasBuilding(w, ['cement_mill']) && !hasBuilding(w, ['concrete_plant']),
    hint: 'cement + sand + stone + water → concrete, the bulk material for every Tier-2 build. (1 cement + 2 sand + 3 stone + 0.5 water → 6 concrete.)',
    expectedAction: 'Place a Concrete Plant (150 stone / 40 iron ingot / 40 wood / 20 clay).',
    dismissalCondition: (w) => hasBuilding(w, ['concrete_plant']),
    priority: 'critical',
    targetDefId: 'concrete_plant',
  },
  {
    id: '26_copper',
    mechanic: 'Copper',
    triggerCondition: (w) => hasBuilding(w, ['concrete_plant']) && !hasBuilding(w, ['copper_smelter']),
    hint: 'Copper ore → copper ingot (wire, electronics, cells).',
    expectedAction: 'Place a Copper Mine (150 stone / 80 wood / 30 iron ingot) on copper_vein, then a Copper Smelter (200 stone / 80 iron ingot / 30 wood / 40 clay).',
    dismissalCondition: (w) => hasBuilding(w, ['copper_smelter']),
    priority: 'critical',
    targetDefId: 'copper_smelter',
  },
  {
    id: '27_glass',
    mechanic: 'Glass',
    triggerCondition: (w) => hasBuilding(w, ['copper_smelter']) && !hasBuilding(w, ['glassworks']),
    hint: 'Sand → glass (electronics, T4 builds).',
    expectedAction: 'Place a Glassworks (200 stone / 40 wood / 30 iron ingot / 20 clay).',
    dismissalCondition: (w) => hasBuilding(w, ['glassworks']),
    priority: 'recommended',
    targetDefId: 'glassworks',
  },
  {
    id: '28_gear',
    mechanic: 'Gears',
    triggerCondition: (w) => hasBuilding(w, ['glassworks']) && !hasBuilding(w, ['assembler']),
    hint: '1 iron ingot + 2 bolts → 1 gear (drones, pumps, mills).',
    expectedAction: 'Place an Assembler (7000 concrete / 4000 stone / 2000 iron ingot / 500 glass / 300 copper ingot).',
    dismissalCondition: (w) => hasBuilding(w, ['assembler']),
    priority: 'critical',
    targetDefId: 'assembler',
  },
  {
    id: '29_dronepad',
    mechanic: 'Drone pad',
    triggerCondition: (w) => hasBuilding(w, ['assembler']) && !hasBuilding(w, ['dronepad']),
    hint: 'Scout the ocean with drones.',
    expectedAction: 'Place a Drone Pad (2000 concrete / 1000 stone / 500 iron ingot / 100 gear).',
    dismissalCondition: (w) => hasBuilding(w, ['dronepad']),
    priority: 'recommended',
    targetDefId: 'dronepad',
  },
  {
    id: '30_biofuel',
    mechanic: 'Drone fuel',
    triggerCondition: (w) => hasBuilding(w, ['dronepad']) && !hasBuilding(w, ['biofuel_plant']),
    hint: '2 wood → 1 biofuel — cheap T1 drone fuel.',
    expectedAction: 'Place a Biofuel Plant (150 stone / 60 wood / 40 iron ingot / 30 clay).',
    dismissalCondition: (w) => hasBuilding(w, ['biofuel_plant']),
    priority: 'recommended',
    targetDefId: 'biofuel_plant',
  },
  {
    id: '31_drone_launch',
    mechanic: 'Launch a drone',
    triggerCondition: (w) => hasBuilding(w, ['dronepad']),
    hint: 'Open Drone Ops (J), pick a T1 drone, arm, click a target tile.',
    expectedAction: null,
    dismissalCondition: (w) => w.drones.length > 0 || stepShownFor(w, '31_drone_launch', 30_000),
    priority: 'recommended',
  },
  {
    id: '32_oil',
    mechanic: 'Crude oil',
    triggerCondition: (w) => hasBuilding(w, ['biofuel_plant']) && !hasBuilding(w, ['pump_jack']),
    hint: 'Crude oil feeds heavy_oil → lubricant & diesel.',
    expectedAction: 'Place a Pump Jack (7000 concrete / 4000 stone / 2000 iron ingot / 150 gear / 200 copper ingot) on oil_well.',
    dismissalCondition: (w) => hasBuilding(w, ['pump_jack']),
    priority: 'recommended',
    targetDefId: 'pump_jack',
  },
  {
    id: '33_salt',
    mechanic: 'Salt',
    triggerCondition: (w) => hasBuilding(w, ['pump_jack']) && !hasBuilding(w, ['evaporator']),
    hint: '1 saltwater → 1 salt (chlorine feedstock).',
    expectedAction: 'Place an Evaporator (30 stone / 20 wood / 10 iron ingot).',
    dismissalCondition: (w) => hasBuilding(w, ['evaporator']),
    priority: 'recommended',
    targetDefId: 'evaporator',
  },
  {
    id: '34_heavy_oil',
    mechanic: 'Heavy oil',
    triggerCondition: (w) => hasBuilding(w, ['evaporator']) && !hasBuilding(w, ['crude_oil_cracker']),
    hint: '3 crude oil → 1 heavy oil (+ tar + asphalt). Heavy oil feeds lubricant & calcium_sulfonate.',
    expectedAction: 'Place a Crude Oil Cracker (25000 concrete / 15000 stone / 10000 iron ingot / 500 gear / 6000 clay / 600 copper ingot).',
    dismissalCondition: (w) => hasBuilding(w, ['crude_oil_cracker']),
    priority: 'recommended',
    targetDefId: 'crude_oil_cracker',
  },
  {
    id: '35_chlorine',
    mechanic: 'Chlorine',
    triggerCondition: (w) => hasBuilding(w, ['crude_oil_cracker']) && !hasBuilding(w, ['chlor_alkali_plant']),
    hint: '117 salt + 36 fresh water → 71 chlorine (+ NaOH + H₂). Chlorine feeds lubricant.',
    expectedAction: 'Place a Chlor-Alkali Plant (10000 concrete / 6000 stone / 3000 iron ingot / 200 gear / 2000 clay / 400 copper ingot).',
    dismissalCondition: (w) => hasBuilding(w, ['chlor_alkali_plant']),
    priority: 'recommended',
    targetDefId: 'chlor_alkali_plant',
  },
  {
    id: '36_calcium_sulfonate',
    mechanic: 'Calcium sulfonate',
    triggerCondition: (w) => hasBuilding(w, ['chlor_alkali_plant']) && !hasBuilding(w, ['chemical_reactor']),
    hint: '1 sulfur + 1 quicklime + 1 heavy oil → 3 calcium sulfonate (the lubricant additive).',
    expectedAction: 'Place a Chemical Reactor (8000 concrete / 5000 stone / 2000 iron ingot / 150 gear / 1500 clay / 300 copper ingot).',
    dismissalCondition: (w) => hasBuilding(w, ['chemical_reactor']),
    priority: 'recommended',
    targetDefId: 'chemical_reactor',
  },
  {
    id: '37_lubricant',
    mechanic: 'Maintenance materials',
    triggerCondition: (w) => hasBuilding(w, ['chemical_reactor']) && !hasBuilding(w, ['lubricant_refinery']),
    hint: '5 heavy_oil + 5 chlorine + 1 calcium_sulfonate → 10 lubricant — every maintenance cycle needs it.',
    expectedAction: 'Place a Lubricant Refinery (12000 concrete / 7000 stone / 4000 iron ingot / 250 gear / 3000 clay / 350 copper ingot).',
    dismissalCondition: (w) => hasBuilding(w, ['lubricant_refinery']),
    priority: 'recommended',
    targetDefId: 'lubricant_refinery',
  },
  {
    id: '38_settle',
    mechanic: 'Settle a new island',
    triggerCondition: (w) => hasBuilding(w, ['lubricant_refinery']) && settledCount(w) < 2,
    hint: 'Load fuel + a Foundation Kit and send a ship from a Shipyard.',
    expectedAction: 'Place a Shipyard (400 stone / 250 wood / 100 iron ingot) on a coastal tile, then settle.',
    dismissalCondition: (w) => settledCount(w) >= 2,
    priority: 'critical',
    targetDefId: 'shipyard',
  },
  {
    id: '39_antenna',
    mechanic: 'Stay connected',
    triggerCondition: (w) => settledCount(w) >= 2 && !hasBuilding(w, ['antenna_t1', 'antenna_t2', 'antenna_t3']),
    hint: 'Antennas extend signal range so drones can transmit.',
    expectedAction: 'Place an Antenna (20 stone / 20 wood / 10 iron ingot / 5 copper ingot).',
    dismissalCondition: (w) => hasBuilding(w, ['antenna_t1', 'antenna_t2', 'antenna_t3']) || stepShownFor(w, '39_antenna', 20_000),
    priority: 'recommended',
    targetDefId: 'antenna_t1',
  },
  {
    id: '40_kit_assembler',
    mechanic: 'Sustain Foundation Kits',
    triggerCondition: (w) => settledCount(w) >= 2 && !hasBuilding(w, ['kit_assembler']),
    hint: '5 iron ingot + 10 wood + 5 bolt → 1 kit, to keep settling.',
    expectedAction: 'Place a Kit Assembler (150 stone / 60 wood / 40 iron ingot / 200 bolt).',
    dismissalCondition: (w) => hasBuilding(w, ['kit_assembler']),
    priority: 'recommended',
    targetDefId: 'kit_assembler',
  },

  // ---- T2 → T3 — Steel, electronics, advanced fuel (Level 15 gate) ----
  {
    id: '41_tier3',
    mechanic: 'Reach Tier 3',
    triggerCondition: (w) => hasBuilding(w, ['kit_assembler']),
    hint: 'Push an island to level 15 for the steel & electronics tier.',
    expectedAction: null,
    dismissalCondition: (w) => maxIslandLevel(w) >= 15,
    priority: 'critical',
  },
  {
    id: '42_scrap_steel',
    mechanic: 'Bootstrap steel from scrap',
    triggerCondition: (w) => maxIslandLevel(w) >= 15 && !hasBuilding(w, ['steel_mill_scrap']),
    hint: 'Your 5000 starter scrap bootstraps steel: 2 scrap → 1 steel.',
    expectedAction: 'Place a Scrap Steel Mill (20000 concrete / 15000 stone / 8000 iron ingot / 500 gear / 5000 clay / 500 copper ingot).',
    dismissalCondition: (w) => hasBuilding(w, ['steel_mill_scrap']),
    priority: 'critical',
    targetDefId: 'steel_mill_scrap',
  },
  {
    id: '43_beams',
    mechanic: 'Steel beams',
    triggerCondition: (w) => hasBuilding(w, ['steel_mill_scrap']) && !hasBuilding(w, ['beam_mill']),
    hint: '105 steel → 2 steel beams — the structural input every steel-tier building needs in bulk.',
    expectedAction: 'Place a Beam Mill (10000 concrete / 6000 stone / 3000 iron ingot / 200 gear / 2000 clay / 200 copper ingot).',
    dismissalCondition: (w) => hasBuilding(w, ['beam_mill']),
    priority: 'critical',
    targetDefId: 'beam_mill',
  },
  {
    id: '44_pipes',
    mechanic: 'Pipes',
    triggerCondition: (w) => hasBuilding(w, ['beam_mill']) && !hasBuilding(w, ['pipe_mill']),
    hint: '42 steel → 10 pipes (Coke Oven, rigs, chemistry).',
    expectedAction: 'Place a Pipe Mill (10000 concrete / 7000 stone / 3500 iron ingot / 250 gear / 2500 clay / 300 copper ingot).',
    dismissalCondition: (w) => hasBuilding(w, ['pipe_mill']),
    priority: 'recommended',
    targetDefId: 'pipe_mill',
  },
  {
    id: '45_coke',
    mechanic: 'Coke',
    triggerCondition: (w) => hasBuilding(w, ['pipe_mill']) && !hasBuilding(w, ['coke_oven']),
    hint: '10 coal → 7 coke (+ byproducts) for the steel chain. Needs adjacent heat.',
    expectedAction: 'Place a Coke Oven (15000 clay / 500 stone / 100 pipe) next to a heat source.',
    dismissalCondition: (w) => hasBuilding(w, ['coke_oven']),
    priority: 'critical',
    targetDefId: 'coke_oven',
  },
  {
    id: '46_oxygen',
    mechanic: 'Industrial gases',
    triggerCondition: (w) => hasBuilding(w, ['coke_oven']) && !hasBuilding(w, ['air_separator']),
    hint: 'Air → nitrogen + oxygen + argon. Oxygen feeds the steel mill; argon feeds the AI Core; nitrogen feeds cryo coolant.',
    expectedAction: 'Place an Air Separator (concrete + glass + copper + brick).',
    dismissalCondition: (w) => hasBuilding(w, ['air_separator']),
    priority: 'critical',
    targetDefId: 'air_separator',
  },
  {
    id: '47_pig_iron',
    mechanic: 'Pig iron',
    triggerCondition: (w) => hasBuilding(w, ['air_separator']) && !hasBuilding(w, ['blast_furnace']),
    hint: '35 iron ore + 18 coke + 10 limestone → 20 pig iron. Needs adjacent heat.',
    expectedAction: 'Place a Blast Furnace (30000 steel beam / 25000 clay / 2000 stone) next to a heat source.',
    dismissalCondition: (w) => hasBuilding(w, ['blast_furnace']),
    priority: 'critical',
    targetDefId: 'blast_furnace',
  },
  {
    id: '48_steel',
    mechanic: 'Steel',
    triggerCondition: (w) => hasBuilding(w, ['blast_furnace']) && !hasBuilding(w, ['steel_mill']),
    hint: '100 pig iron + 7 quicklime + 9 oxygen → 85 steel.',
    expectedAction: 'Place a Steel Mill (25000 steel beam / 8000 clay / 2000 stone).',
    dismissalCondition: (w) => hasBuilding(w, ['steel_mill']),
    priority: 'critical',
    targetDefId: 'steel_mill',
  },
  {
    id: '49_slag',
    mechanic: 'Reclaim slag',
    triggerCondition: (w) => hasBuilding(w, ['steel_mill']) && !hasBuilding(w, ['slag_reprocessor']),
    hint: 'Smelting slag → gold / silver / rare earth. Rare earth feeds magnets.',
    expectedAction: 'Place a Slag Reprocessor (8000 concrete / 6000 stone / 2000 iron ingot / 300 gear / 400 copper ingot).',
    dismissalCondition: (w) => hasBuilding(w, ['slag_reprocessor']) || stepShownFor(w, '49_slag', 20_000),
    priority: 'optional',
    targetDefId: 'slag_reprocessor',
  },
  {
    id: '50_wire',
    mechanic: 'Wire',
    triggerCondition: (w) => hasBuilding(w, ['steel_mill']) && !hasBuilding(w, ['metal_rolling_mill']),
    hint: '11 steel → 20 wire (electronics & cells).',
    expectedAction: 'Place a Metal Rolling Mill (12000 concrete / 7000 stone / 4000 iron ingot / 250 gear / 2500 clay / 400 copper ingot).',
    dismissalCondition: (w) => hasBuilding(w, ['metal_rolling_mill']),
    priority: 'recommended',
    targetDefId: 'metal_rolling_mill',
  },
  {
    id: '51_lead',
    mechanic: 'Lead',
    triggerCondition: (w) => hasBuilding(w, ['metal_rolling_mill']) && !hasBuilding(w, ['lead_smelter']),
    hint: 'Lead ore → lead ingot for Battery Bank plates.',
    expectedAction: 'Place a Lead Mine (150 stone / 80 wood / 30 iron ingot) on lead_vein, then a Lead Smelter (200 stone / 80 iron ingot / 30 wood / 40 clay).',
    dismissalCondition: (w) => hasBuilding(w, ['lead_smelter']),
    priority: 'recommended',
    targetDefId: 'lead_smelter',
  },
  {
    id: '52_battery',
    mechanic: 'Battery storage',
    triggerCondition: (w) => hasBuilding(w, ['lead_smelter']) && !hasBuilding(w, ['battery_bank']),
    hint: 'Cell Press → saltwater cell; Battery Bank stores surplus for night & brownouts. (Coastal Pump from step 22 supplies the saltwater.)',
    expectedAction: 'Place a Cell Press (10 copper ingot / 2 iron ingot / 5 saltwater / 1 wood), then a Battery Bank (20 saltwater cell / 15 wire / 5 steel beam / 30 lead ingot).',
    dismissalCondition: (w) => hasBuilding(w, ['battery_bank']),
    priority: 'recommended',
    targetDefId: 'battery_bank',
  },
  {
    id: '53_silicon',
    mechanic: 'Silicon',
    triggerCondition: (w) => hasBuilding(w, ['battery_bank']) && !hasBuilding(w, ['silicon_crusher']),
    hint: 'Quartz → silicon. Build the Quartz Mine on the second stone cluster.',
    expectedAction: 'Place a Quartz Mine (150 stone / 80 wood / 30 iron ingot) on stone, then a Silicon Crusher (350 steel beam / 5000 concrete / 100 gear / 50 pipe / 300 stone).',
    dismissalCondition: (w) => hasBuilding(w, ['silicon_crusher']),
    priority: 'recommended',
    targetDefId: 'silicon_crusher',
  },
  {
    id: '54_microchips',
    mechanic: 'Microchips',
    triggerCondition: (w) => hasBuilding(w, ['silicon_crusher']) && !hasBuilding(w, ['lithography_lab']),
    hint: '1 silicon + 1 wire → 1 microchip — the core of all advanced tech.',
    expectedAction: 'Place a Lithography Lab (1500 steel beam / 20000 concrete / 500 glass / 200 wire).',
    dismissalCondition: (w) => hasBuilding(w, ['lithography_lab']),
    priority: 'recommended',
    targetDefId: 'lithography_lab',
  },
  {
    id: '55_wafers',
    mechanic: 'Silicon wafers',
    triggerCondition: (w) => hasBuilding(w, ['lithography_lab']) && !hasBuilding(w, ['wafer_lab']),
    hint: '1 silicon → 1 wafer (Quantum Chip Fab input).',
    expectedAction: 'Place a Wafer Lab (800 steel beam / 12000 concrete / 300 glass / 100 microchip / 150 wire).',
    dismissalCondition: (w) => hasBuilding(w, ['wafer_lab']),
    priority: 'recommended',
    targetDefId: 'wafer_lab',
  },
  {
    id: '56_ceramics',
    mechanic: 'Ceramic insulators',
    triggerCondition: (w) => hasBuilding(w, ['wafer_lab']) && !hasBuilding(w, ['ceramic_kiln']),
    hint: '2 clay + 1 sand → 1 ceramic insulator (T4 builds). Needs adjacent heat.',
    expectedAction: 'Place a Ceramic Kiln (5000 concrete / 4000 stone / 1200 iron ingot / 80 gear / 2000 clay) next to a heat source.',
    dismissalCondition: (w) => hasBuilding(w, ['ceramic_kiln']),
    priority: 'recommended',
    targetDefId: 'ceramic_kiln',
  },
  {
    id: '57_magnets',
    mechanic: 'Magnets',
    triggerCondition: (w) => hasBuilding(w, ['ceramic_kiln']) && !hasBuilding(w, ['mag_forge']),
    hint: 'Rare earth → magnetic alloy → magnet (Particle Accelerator).',
    expectedAction: 'Place a Mag Alloyer (500 steel beam / 6000 concrete / 200 ceramic insulator / 100 pipe / 50 microchip), then a Mag Forge (600 steel beam / 7000 concrete / 250 ceramic insulator / 100 pipe / 60 microchip).',
    dismissalCondition: (w) => hasBuilding(w, ['mag_forge']),
    priority: 'optional',
    targetDefId: 'mag_forge',
  },
  {
    id: '58_hydrogen',
    mechanic: 'Hydrogen',
    triggerCondition: (w) => hasBuilding(w, ['ceramic_kiln']) && !hasBuilding(w, ['electrolyzer']),
    hint: '9 fresh water → 1 hydrogen + 8 oxygen (your Well supplies water).',
    expectedAction: 'Place an Electrolyzer (40 stone / 20 wood / 20 iron ingot / 10 copper ingot) — the Well from step 21 feeds it.',
    dismissalCondition: (w) => hasBuilding(w, ['electrolyzer']),
    priority: 'recommended',
    targetDefId: 'electrolyzer',
  },
  {
    id: '59_cryo_coolant',
    mechanic: 'Cryo coolant',
    triggerCondition: (w) => hasBuilding(w, ['electrolyzer']) && !hasBuilding(w, ['cryo_lab']),
    hint: '1 hydrogen + 1 nitrogen → 1 cryo coolant (AI Core, Particle Accelerator, Quantum Manipulator).',
    expectedAction: 'Place a Cryo Lab (600 steel beam / 15000 concrete / 300 ceramic insulator / 150 pipe / 80 microchip).',
    dismissalCondition: (w) => hasBuilding(w, ['cryo_lab']),
    priority: 'recommended',
    targetDefId: 'cryo_lab',
  },
  {
    id: '60_biome',
    mechanic: 'Biome dependencies',
    triggerCondition: (w) => hasBuilding(w, ['cryo_lab']),
    hint: 'Some buildings are biome-locked: Pyroforge needs volcanic, the AI Core needs arctic. Settle accordingly.',
    expectedAction: null,
    dismissalCondition: (w) => stepShownFor(w, '60_biome', 20_000),
    priority: 'recommended',
  },

  // ---- T3 → T4 — Endgame industry (Level 30 gate) ----
  {
    id: '61_tier4',
    mechanic: 'Reach Tier 4',
    triggerCondition: (w) => hasBuilding(w, ['cryo_lab']),
    hint: 'Level an island to 30 for Tier-4 uniques.',
    expectedAction: null,
    dismissalCondition: (w) => maxIslandLevel(w) >= 30,
    priority: 'critical',
  },
  {
    id: '62_quantum_chip',
    mechanic: 'Quantum chips',
    triggerCondition: (w) => maxIslandLevel(w) >= 30 && !hasBuilding(w, ['quantum_chip_fab']),
    hint: '4 steel + 4 pig iron → 1 quantum chip.',
    expectedAction: 'Place a Quantum Chip Fab (8000 steel beam / 4000 glass / 2000 microchip / 1000 ceramic insulator / 200 silicon wafer).',
    dismissalCondition: (w) => hasBuilding(w, ['quantum_chip_fab']),
    priority: 'recommended',
    targetDefId: 'quantum_chip_fab',
  },
  {
    id: '63_ai_core',
    mechanic: 'AI Core (arctic)',
    triggerCondition: (w) => hasBuilding(w, ['quantum_chip_fab']) && !invAtLeast(w, 'ai_core', 1),
    hint: '3 steel + 1 quantum chip + 1 argon → 1 AI Core. Needs an arctic colony. (Cryo coolant from the Cryo Lab, step 59.)',
    expectedAction: 'Place a Cryogenic Compute Center (15000 steel beam / 5000 ceramic insulator / 1000 microchip / 500 cryo coolant / 200 wire) on an arctic island.',
    dismissalCondition: (w) => invAtLeast(w, 'ai_core', 1),
    priority: 'critical',
    targetDefId: 'cryogenic_compute_center',
  },
  {
    id: '64_helium',
    mechanic: 'Helium-3',
    triggerCondition: (w) => invAtLeast(w, 'ai_core', 1) && !hasBuilding(w, ['drilling_rig']),
    hint: 'Drill helium-3 for alloys & power.',
    expectedAction: 'Place a Drilling Rig (1000 steel beam / 12000 concrete / 300 pipe / 150 gear / 100 microchip) on helium_vent.',
    dismissalCondition: (w) => hasBuilding(w, ['drilling_rig']),
    priority: 'recommended',
    targetDefId: 'drilling_rig',
  },
  {
    id: '65_exotic_alloy',
    mechanic: 'Exotic alloy (volcanic)',
    triggerCondition: (w) => hasBuilding(w, ['drilling_rig']) && !hasBuilding(w, ['pyroforge']),
    hint: '5 steel + 1 helium-3 → 1 exotic alloy. Needs a volcanic colony + adjacent heat.',
    expectedAction: 'Place a Pyroforge (10000 steel beam / 3000 clay / 500 microchip / 200 ceramic insulator) on a volcanic island, next to a heat source.',
    dismissalCondition: (w) => hasBuilding(w, ['pyroforge']),
    priority: 'recommended',
    targetDefId: 'pyroforge',
  },
  {
    id: '66_antimatter',
    mechanic: 'Antimatter',
    triggerCondition: (w) => hasBuilding(w, ['pyroforge']) && !hasBuilding(w, ['particle_accelerator']),
    hint: '10 hydrogen + 1 exotic alloy + 5 microchip → 1 antimatter capsule.',
    expectedAction: 'Place a Particle Accelerator (25000 steel beam / 3000 concrete / 2000 magnet / 1000 microchip / 200 cryo coolant).',
    dismissalCondition: (w) => hasBuilding(w, ['particle_accelerator']),
    priority: 'recommended',
    targetDefId: 'particle_accelerator',
  },
  {
    id: '67_time_crystal',
    mechanic: 'Time crystals',
    triggerCondition: (w) => hasBuilding(w, ['particle_accelerator']) && !hasBuilding(w, ['quantum_manipulator']),
    hint: '1 helium-3 + 1 exotic alloy → 1 time crystal.',
    expectedAction: 'Place a Quantum Manipulator (3000 steel beam / 1000 ceramic insulator / 500 cryo coolant / 300 microchip / 200 wire / 100 glass).',
    dismissalCondition: (w) => hasBuilding(w, ['quantum_manipulator']),
    priority: 'recommended',
    targetDefId: 'quantum_manipulator',
  },
  {
    id: '68_weather',
    mechanic: 'Weather & storms',
    triggerCondition: (w) => hasBuilding(w, ['quantum_manipulator']),
    hint: 'Storms damage outdoor buildings; CO₂ worsens their frequency. Wastewater & scrubbers mitigate.',
    expectedAction: null,
    dismissalCondition: (w) => stepShownFor(w, '68_weather', 20_000),
    priority: 'recommended',
  },

  // ---- T4 → T5 — Transcendence (Level 50 + AI Core) ----
  {
    id: '69_tier5',
    mechanic: 'Reach Tier 5',
    triggerCondition: (w) => hasBuilding(w, ['quantum_manipulator']),
    hint: 'Level 50 + a crafted AI Core unlocks the Tier-5 capstone.',
    expectedAction: null,
    dismissalCondition: (w) => maxIslandLevel(w) >= 50 && invSeen(w, 'ai_core'),
    priority: 'critical',
  },
  {
    id: '70_reality_forge',
    mechanic: 'The Reality Forge',
    triggerCondition: (w) => maxIslandLevel(w) >= 50 && invSeen(w, 'ai_core') && !hasBuilding(w, ['reality_forge']),
    hint: 'The Tier-5 capstone that forges Reality Anchors.',
    expectedAction: 'Place a Reality Forge (15000 steel beam / 5000 clay / 800 microchip / 500 ceramic insulator / 300 exotic alloy).',
    dismissalCondition: (w) => hasBuilding(w, ['reality_forge']),
    priority: 'recommended',
    targetDefId: 'reality_forge',
  },
  {
    id: '71_reality_anchor',
    mechanic: 'Reality Anchor',
    triggerCondition: (w) => hasBuilding(w, ['reality_forge']) && !invAtLeast(w, 'reality_anchor', 1),
    hint: '4 AI Cores + 1 antimatter capsule + 1 time crystal + 1 exotic alloy → 1 Reality Anchor (a long craft).',
    expectedAction: null,
    dismissalCondition: (w) => invAtLeast(w, 'reality_anchor', 1),
    priority: 'recommended',
  },
  {
    id: '72_beyond',
    mechanic: 'Beyond',
    triggerCondition: (w) => invAtLeast(w, 'reality_anchor', 1),
    hint: 'Reality Anchors gate the Ascendant path (T6, Spaceport) — the endgame opens from here.',
    expectedAction: null,
    dismissalCondition: (w) => stepShownFor(w, '72_beyond', 15_000),
    priority: 'optional',
  },
];

// ---------------------------------------------------------------------------
// Lifecycle functions
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

/** Stamp the first-show wall-clock time for `id` (idempotent: only the
 *  first call for a given id records a timestamp). Called from the tutorial
 *  poll for the current step so concept-step TTLs can start counting the
 *  moment a step is surfaced. Lazily initialises `tutorialState`/`shownAt`
 *  the same way `markCompleted` does. */
export function markShown(world: WorldState, id: ObjectiveId): void {
  world.tutorialState = world.tutorialState ?? { completed: new Set<ObjectiveId>(), current: null };
  world.tutorialState.shownAt = world.tutorialState.shownAt ?? {};
  if (world.tutorialState.shownAt[id] == null) {
    world.tutorialState.shownAt[id] = Date.now();
  }
}

/** Record that objective `id`'s one-shot tutorial XP bump has been paid.
 *  Lazily initialises `xpBumpClaimed` (mirrors `markCompleted`/`markShown`). */
export function markBumpClaimed(world: WorldState, id: ObjectiveId): void {
  world.tutorialState = world.tutorialState ?? { completed: new Set<ObjectiveId>(), current: null };
  world.tutorialState.xpBumpClaimed = world.tutorialState.xpBumpClaimed ?? new Set<ObjectiveId>();
  world.tutorialState.xpBumpClaimed.add(id);
}

export function skipAll(world: WorldState): void {
  const ids = TUTORIAL_STEPS.map(s => s.id);
  // Skipping forfeits the tutorial XP: mark every objective's bump claimed so a
  // later restart -> re-complete grants nothing. Union with any already-claimed.
  const claimed = new Set<ObjectiveId>(world.tutorialState?.xpBumpClaimed ?? []);
  for (const id of ids) claimed.add(id);
  world.tutorialState = { completed: new Set(ids), current: null, xpBumpClaimed: claimed };
}

export function restart(world: WorldState): void {
  // Preserve the permanent XP-bump ledger so re-completing the reset tutorial
  // grants no XP (restart-XP-farm fix). Only completed/current reset.
  const claimed = world.tutorialState?.xpBumpClaimed;
  world.tutorialState = { completed: new Set<ObjectiveId>(), current: null, xpBumpClaimed: claimed };
}

/** Per-objective one-shot XP bump: the N-th completed objective injects
 *  N% of the next-level XP threshold into the home island's XP bar. */
export function xpBumpPercentForCompletion(completionIndex: number): number {
  return completionIndex;
}

