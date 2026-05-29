import { describe, expect, it } from 'vitest';

import type { IslandState } from './economy.js';
import { type ResourceId } from './recipes.js';
import type { PlacedBuilding } from './buildings.js';
import {
  TUTORIAL_STEPS,
  currentStep,
  checkDismissals,
  markCompleted,
  skipAll,
  restart,
  checkObjectives,
  type ObjectiveId,
  type TutorialState,
} from './tutorial.js';
import { serializeWorld, deserializeWorld, type SaveSnapshot } from './persistence.js';
import { makeInitialWorld } from './world.js';
import type { IslandSpec, WorldState } from './world.js';

// ---------------------------------------------------------------------------
// Backward-compat helpers (pre-Phase-7 checkObjectives tests)
// ---------------------------------------------------------------------------

function makeWorld(over: Partial<WorldState> = {}): WorldState {
  return {
    islands: [],
    drones: [],
    routes: [],
    vehicles: [],
    revealedCells: new Set(),
    satellites: [],
    repairDrones: [],
    debrisFields: [],
    seed: 'test-seed',
    endgameState: { achieved: new Set(), firstAchievedMs: null },
    latticeActive: false,
    latticeNodeIslands: [],
    commPackets: [],
    totalCo2Kg: 0,
    playerLat: null,
    playerLon: null,
    oceanCells: new Map(),
    depthRevealedCells: new Set(),
    recentBuildAttempts: new Set(),
    recentBuildAttemptTs: new Map(),
    ...over,
  };
}

function makeIslandState(over: Partial<IslandState> = {}): IslandState {
  return {
    id: 'home',
    buildings: [],
    inventory: {} as Record<string, number>,
    storageCaps: {} as Record<string, number>,
    xp: 0,
    level: 1,
    unspentSkillPoints: 0,
    unlockedNodes: new Set(),
    unlockedEdges: new Set(),
    auraAmpVersion: 0,
    auraAmpCache: null,
    auraAmpCacheVersion: -1,
    co2Kg: 0,
    funnelPending: {} as Record<string, number>,
    declaredAt: null,
    aiCoreCrafted: false,
    ascendantCoreCrafted: false,
    lastResetAt: null,
    timeLockBankedMin: 0,
    accelerationQueue: [],
    accelerationRemainingMin: 0,
    bankingEnabled: false,
    genesisTarget: null,
    batteryStoredWs: 0,
    starterInventoryGrace: {} as Record<ResourceId, number>,
    socketBindings: new Map(),
    lastTick: 0,
    ...over,
  };
}

// ---------------------------------------------------------------------------
// New helpers (Phase 7 commit 6)
// ---------------------------------------------------------------------------

function makeTestWorld(over: Partial<WorldState> = {}): WorldState {
  const { spec, state } = makeTestIsland('home');
  return {
    islands: [spec],
    islandStates: new Map([['home', state]]),
    drones: [],
    routes: [],
    vehicles: [],
    revealedCells: new Set(),
    satellites: [],
    repairDrones: [],
    debrisFields: [],
    seed: 'test-seed',
    endgameState: { achieved: new Set(), firstAchievedMs: null },
    latticeActive: false,
    latticeNodeIslands: [],
    commPackets: [],
    totalCo2Kg: 0,
    playerLat: null,
    playerLon: null,
    oceanCells: new Map(),
    depthRevealedCells: new Set(),
    recentBuildAttempts: new Set(),
    recentBuildAttemptTs: new Map(),
    ...over,
  };
}

function makeTestIsland(id: string): { spec: IslandSpec; state: IslandState } {
  const buildings: PlacedBuilding[] = [];
  const spec: IslandSpec = {
    id,
    name: id,
    biome: 'plains',
    cx: 0,
    cy: 0,
    majorRadius: 14,
    minorRadius: 14,
    populated: true,
    discovered: true,
    buildings,
    modifiers: [],
  };
  const state: IslandState = {
    id,
    buildings,
    inventory: {} as Record<ResourceId, number>,
    storageCaps: {} as Record<ResourceId, number>,
    xp: 0,
    level: 1,
    unspentSkillPoints: 0,
    unlockedNodes: new Set(),
    unlockedEdges: new Set(),
    auraAmpVersion: 0,
    auraAmpCache: null,
    auraAmpCacheVersion: -1,
    co2Kg: 0,
    funnelPending: {} as Record<ResourceId, number>,
    declaredAt: null,
    aiCoreCrafted: false,
    ascendantCoreCrafted: false,
    lastResetAt: null,
    timeLockBankedMin: 0,
    accelerationQueue: [],
    accelerationRemainingMin: 0,
    bankingEnabled: false,
    genesisTarget: null,
    batteryStoredWs: 0,
    starterInventoryGrace: {} as Record<ResourceId, number>,
    socketBindings: new Map(),
    lastTick: 0,
  };
  return { spec, state };
}

// ---------------------------------------------------------------------------
// 1. Integrity
// ---------------------------------------------------------------------------

describe('TUTORIAL_STEPS — integrity', () => {
  it('has exactly 32 entries with unique ids', () => {
    expect(TUTORIAL_STEPS.length).toBe(32);
    const ids = new Set(TUTORIAL_STEPS.map((s) => s.id));
    expect(ids.size).toBe(32);
  });
});

// ---------------------------------------------------------------------------
// 2. Per-step trigger + dismissal
// ---------------------------------------------------------------------------

describe('TUTORIAL_STEPS — per-step trigger + dismissal', () => {
  for (const step of TUTORIAL_STEPS) {
    const triggerReachable = !(
      step.id === '11_construction_time' ||
      step.id === '16_maintenance' ||
      step.id === '20_antenna'
    );

    if (triggerReachable) {
      it(`${step.id} fires on its trigger condition`, () => {
        const w = makeWorldForTrigger(step.id);
        expect(step.triggerCondition(w)).toBe(true);
        expect(currentStep(w)?.id).toBe(step.id);
      });
    } else {
      it.skip(`${step.id} fires on its trigger condition — TODO Phase 5 wire-up`, () => {
        const w = makeWorldForTrigger(step.id);
        expect(step.triggerCondition(w)).toBe(true);
        expect(currentStep(w)?.id).toBe(step.id);
      });
    }

    it(`${step.id} dismisses on its dismissal condition`, () => {
      const w = makeWorldForDismissal(step.id);
      expect(step.dismissalCondition(w)).toBe(true);
      expect(checkDismissals(w)).toContain(step.id);
    });
  }
});

// ---------------------------------------------------------------------------
// 3. Ordering
// ---------------------------------------------------------------------------

describe('TUTORIAL_STEPS — ordering', () => {
  it('currentStep returns step 1 on a fresh world', () => {
    const w = makeTestWorld();
    expect(currentStep(w)?.id).toBe('01_map_picker');
  });

  it('currentStep returns step N+1 after step N is marked completed', () => {
    const w = makeTestWorld({ playerLat: 40 });
    markCompleted(w, '01_map_picker');
    expect(currentStep(w)?.id).toBe('02_bootstrap_power');
  });

  it('mid-tutorial state from a v15 save resumes at the right step', () => {
    const w = makeTestWorld();
    const home = w.islands[0]!;
    home.buildings.push({ id: 'b1', defId: 'water_wheel', x: 0, y: 0 });
    w.tutorialState = {
      completed: new Set(['01_map_picker', '02_bootstrap_power']),
      current: '03_building_placement',
    };
    expect(currentStep(w)?.id).toBe('03_building_placement');
  });
});

// ---------------------------------------------------------------------------
// 4. skipAll + restart
// ---------------------------------------------------------------------------

describe('skipAll + restart', () => {
  it('skipAll fills completed with all 32 ids', () => {
    const w = makeTestWorld();
    skipAll(w);
    expect(w.tutorialState!.completed.size).toBe(32);
    for (const step of TUTORIAL_STEPS) {
      expect(w.tutorialState!.completed.has(step.id)).toBe(true);
    }
  });

  it('skipAll causes currentStep to return null', () => {
    const w = makeTestWorld();
    skipAll(w);
    expect(currentStep(w)).toBeNull();
  });

  it('restart resets completed to empty', () => {
    const w = makeTestWorld();
    skipAll(w);
    restart(w);
    expect(w.tutorialState!.completed.size).toBe(0);
  });

  it('restart causes step 1 to reappear', () => {
    const w = makeTestWorld();
    skipAll(w);
    restart(w);
    expect(currentStep(w)?.id).toBe('01_map_picker');
  });
});

// ---------------------------------------------------------------------------
// 5. Persistence
// ---------------------------------------------------------------------------

describe('persistence — tutorialState', () => {
  it('pre-Phase-7 save (tutorialState undefined) loads with empty completed', () => {
    const world = makeInitialWorld(0);
    const snap = serializeWorld(world, new Map(), 0);
    const json = JSON.parse(JSON.stringify(snap)) as SaveSnapshot;
    delete (json.world as unknown as Record<string, unknown>).tutorialState;
    const { world: restored } = deserializeWorld(json, 0, 0);
    expect(restored.tutorialState?.completed.size).toBe(0);
    expect(currentStep(restored)?.id).toBe('01_map_picker');
  });

  it('v15 save with mid-tutorial state round-trips identity', () => {
    const world = makeInitialWorld(0);
    world.tutorialState = {
      completed: new Set(['01_map_picker', '02_bootstrap_power']),
      current: '03_building_placement',
    };
    const snap = serializeWorld(world, new Map(), 0);
    const json = JSON.parse(JSON.stringify(snap)) as SaveSnapshot;
    const { world: restored } = deserializeWorld(json, 0, 0);
    expect(restored.tutorialState?.completed).toEqual(
      new Set(['01_map_picker', '02_bootstrap_power']),
    );
    expect(restored.tutorialState?.current).toBe('03_building_placement');
  });
});

// ---------------------------------------------------------------------------
// Per-step world factories
// ---------------------------------------------------------------------------

function makeWorldForTrigger(stepId: string): WorldState {
  const idx = TUTORIAL_STEPS.findIndex((s) => s.id === stepId);
  const completedBefore =
    idx > 0 ? new Set(TUTORIAL_STEPS.slice(0, idx).map((s) => s.id)) : new Set<string>();

  const w = makeTestWorld();
  w.tutorialState = { completed: completedBefore, current: null };

  const home = w.islands[0]!;
  const homeState = w.islandStates!.get('home')!;

  switch (stepId) {
    case '01_map_picker':
      // playerLat is already null
      break;

    case '02_bootstrap_power':
      w.playerLat = 40;
      break;

    case '03_building_placement':
      w.playerLat = 40;
      home.buildings.push({ id: 'b1', defId: 'water_wheel', x: 0, y: 0 });
      break;

    case '04_tile_gate':
      w.playerLat = 40;
      home.buildings.push({ id: 'b1', defId: 'water_wheel', x: 0, y: 0 });
      home.buildings.push({ id: 'b2', defId: 'mine', x: 1, y: 0 });
      break;

    case '05_logger_placement':
      w.playerLat = 40;
      home.buildings.push({ id: 'b1', defId: 'water_wheel', x: 0, y: 0 });
      home.buildings.push({ id: 'b2', defId: 'mine', x: 1, y: 0 });
      homeState.inventory = { iron_ore: 1 } as Record<ResourceId, number>;
      break;

    case '06_iron_chain':
      w.playerLat = 40;
      home.buildings.push({ id: 'b1', defId: 'water_wheel', x: 0, y: 0 });
      home.buildings.push({ id: 'b2', defId: 'mine', x: 1, y: 0 });
      home.buildings.push({ id: 'b3', defId: 'logger', x: 2, y: 0 });
      homeState.inventory = { iron_ore: 10, coal: 3 } as Record<ResourceId, number>;
      break;

    case '07_heat_budget':
      w.playerLat = 40;
      home.buildings.push({ id: 'b1', defId: 'coke_oven', x: 0, y: 0 });
      break;

    case '08_adjacency_buff':
      home.buildings.push({ id: 'b1', defId: 'mine', x: 0, y: 0 });
      home.buildings.push({ id: 'b2', defId: 'mine', x: 1, y: 0 });
      break;

    case '09_copper_prospect':
      w.recentBuildAttempts.add('cell_press');
      break;

    case '10_limestone':
      w.recentBuildAttempts.add('blast_furnace');
      break;

    case '11_construction_time':
      // unreachable — guarded by .skip
      break;

    case '12_storage_caps':
      homeState.inventory = { wood: 100 } as Record<ResourceId, number>;
      (homeState as unknown as Record<string, unknown>).storageCaps = { wood: 100 } as Record<ResourceId, number>;
      break;

    case '13_battery_bootstrap':
      homeState.inventory = { saltwater_cell: 4 } as Record<ResourceId, number>;
      break;

    case '14_day_night_solar':
      home.buildings.push({ id: 'b1', defId: 'solar', x: 0, y: 0 });
      break;

    case '15_co2_tracker':
      w.totalCo2Kg = 100;
      break;

    case '16_maintenance':
      // unreachable — guarded by .skip
      break;

    case '17_drones':
      home.buildings.push({ id: 'b1', defId: 'dronepad', x: 0, y: 0 });
      break;

    case '18_lighthouse':
      home.buildings.push({ id: 'b1', defId: 'lighthouse_t1', x: 0, y: 0 });
      break;

    case '19_settlement': {
      const island2 = makeTestIsland('island2');
      island2.spec.populated = false;
      island2.spec.discovered = true;
      w.islands.push(island2.spec);
      w.islandStates!.set('island2', island2.state);
      (w as unknown as Record<string, unknown>).startingDiscovered = 1;
      break;
    }

    case '20_antenna':
      // unreachable — guarded by .skip
      break;

    case '21_cargo_routes': {
      const island2 = makeTestIsland('island2');
      island2.spec.populated = true;
      island2.spec.discovered = true;
      w.islands.push(island2.spec);
      w.islandStates!.set('island2', island2.state);
      break;
    }

    case '22_skill_tree':
      homeState.level = 30;
      break;

    case '23_tier_t3':
      home.buildings.push({ id: 'b1', defId: 'steel_mill', x: 0, y: 0 });
      break;

    case '24_reactor_toxicity':
      home.buildings.push({ id: 'b1', defId: 'nuclear_reactor', x: 0, y: 0 });
      break;

    case '25_biome_gating':
      w.recentBuildAttempts.add('pyroforge');
      break;

    case '26_weather_storms':
      (w as unknown as Record<string, unknown>).activeStormCount = 1;
      break;

    case '27_land_reclamation':
      home.buildings.push({ id: 'b1', defId: 'platform_constructor', x: 0, y: 0 });
      break;

    case '28_tier_t4':
      homeState.inventory = { ai_core: 1 } as Record<ResourceId, number>;
      break;

    case '29_orbital':
      home.buildings.push({ id: 'b1', defId: 'spaceport', x: 0, y: 0 });
      break;

    case '30_network_consciousness': {
      for (let i = 2; i <= 10; i++) {
        const isl = makeTestIsland(`island${i}`);
        isl.spec.populated = true;
        w.islands.push(isl.spec);
        w.islandStates!.set(isl.spec.id, isl.state);
      }
      break;
    }

    case '31_tier_reset':
      (w as unknown as Record<string, unknown>).tierResetTriggered = true;
      break;

    case '32_genesis_milestone':
      homeState.inventory = { genesis_cell: 1 } as Record<ResourceId, number>;
      break;

    default:
      throw new Error(`unknown stepId: ${stepId}`);
  }

  return w;
}

function makeWorldForDismissal(stepId: string): WorldState {
  const w = makeTestWorld();
  const home = w.islands[0]!;
  const homeState = w.islandStates!.get('home')!;

  switch (stepId) {
    case '01_map_picker':
      w.playerLat = 40;
      break;

    case '02_bootstrap_power':
      home.buildings.push({ id: 'b1', defId: 'water_wheel', x: 0, y: 0 });
      break;

    case '03_building_placement':
      home.buildings.push({ id: 'b1', defId: 'mine', x: 0, y: 0 });
      break;

    case '04_tile_gate':
      homeState.inventory = { iron_ore: 1 } as Record<ResourceId, number>;
      break;

    case '05_logger_placement':
      home.buildings.push({ id: 'b1', defId: 'logger', x: 0, y: 0 });
      break;

    case '06_iron_chain':
      homeState.inventory = { iron_ingot: 1 } as Record<ResourceId, number>;
      break;

    case '07_heat_budget':
      // dismissal: hasAdjacentHeat || !hasBuilding(['coke_oven'])
      // fresh world has no coke_oven, so dismissal is true
      break;

    case '08_adjacency_buff':
      w.tutorialState = {
        completed: new Set(),
        current: null,
        completedAt: { '08_adjacency_buff': 0 },
      };
      break;

    case '09_copper_prospect':
      homeState.inventory = { copper_ingot: 1 } as Record<ResourceId, number>;
      break;

    case '10_limestone':
      homeState.inventory = { limestone: 1 } as Record<ResourceId, number>;
      break;

    case '11_construction_time':
      w.tutorialState = {
        completed: new Set(),
        current: null,
        completedAt: { '11_construction_time': 0 },
      };
      break;

    case '12_storage_caps':
      // dismissal: hasBuilding(['crate','silo']) || !anyResourceAtCap
      // fresh world has no resources at cap, so dismissal is true
      break;

    case '13_battery_bootstrap':
      home.buildings.push({ id: 'b1', defId: 'battery_bank', x: 0, y: 0 });
      break;

    case '14_day_night_solar':
      w.tutorialState = {
        completed: new Set(),
        current: null,
        completedAt: { '14_day_night_solar': 0 },
      };
      break;

    case '15_co2_tracker':
      w.tutorialState = {
        completed: new Set(),
        current: null,
        completedAt: { '15_co2_tracker': 0 },
      };
      break;

    case '16_maintenance':
      // dismissal: !anyBuildingNeedsMaintenance(w) which is always true
      break;

    case '17_drones':
      (w as unknown as Record<string, unknown>).droneRoutes = new Set(['route1']);
      break;

    case '18_lighthouse': {
      const island2 = makeTestIsland('island2');
      island2.spec.discovered = true;
      w.islands.push(island2.spec);
      w.islandStates!.set('island2', island2.state);
      (w as unknown as Record<string, unknown>).startingDiscovered = 1;
      break;
    }

    case '19_settlement': {
      const island2 = makeTestIsland('island2');
      island2.spec.populated = true;
      w.islands.push(island2.spec);
      w.islandStates!.set('island2', island2.state);
      break;
    }

    case '20_antenna':
      home.buildings.push({ id: 'b1', defId: 'antenna_t1', x: 0, y: 0 });
      break;

    case '21_cargo_routes':
      (w as unknown as Record<string, unknown>).cargoRoutes = new Set(['route1']);
      break;

    case '22_skill_tree':
      homeState.unlockedNodes.add('mining.1');
      break;

    case '23_tier_t3':
      w.tutorialState = {
        completed: new Set(),
        current: null,
        completedAt: { '23_tier_t3': 0 },
      };
      break;

    case '24_reactor_toxicity':
      w.tutorialState = {
        completed: new Set(),
        current: null,
        completedAt: { '24_reactor_toxicity': 0 },
      };
      break;

    case '25_biome_gating':
      w.tutorialState = {
        completed: new Set(),
        current: null,
        completedAt: { '25_biome_gating': 0 },
      };
      break;

    case '26_weather_storms':
      // activeStormCount defaults to 0, so dismissal is true
      break;

    case '27_land_reclamation':
      (w as unknown as Record<string, unknown>).reclaimedTileCount = 4;
      break;

    case '28_tier_t4':
      w.tutorialState = {
        completed: new Set(),
        current: null,
        completedAt: { '28_tier_t4': 0 },
      };
      break;

    case '29_orbital':
      w.satellites.push({ id: 'sat1' } as unknown as WorldState['satellites'][number]);
      break;

    case '30_network_consciousness':
      w.tutorialState = {
        completed: new Set(),
        current: null,
        completedAt: { '30_network_consciousness': 0 },
      };
      break;

    case '31_tier_reset':
      (w as unknown as Record<string, unknown>).tierResetCount = 1;
      break;

    case '32_genesis_milestone':
      homeState.inventory = { genesis_cell: 1 } as Record<ResourceId, number>;
      break;

    default:
      throw new Error(`unknown stepId: ${stepId}`);
  }

  return w;
}

// ---------------------------------------------------------------------------
// Backward-compat checkObjectives tests (pre-Phase-7)
// ---------------------------------------------------------------------------

describe('checkObjectives', () => {
  it('advances current when objective is completed', () => {
    const state: TutorialState = { completed: new Set(), current: 'place_solar' };
    const world = makeWorld({
      islandStates: new Map([
        [
          'home',
          makeIslandState({
            buildings: [{ id: 's1', defId: 'wind_turbine', x: 0, y: 0 }],
          }),
        ],
      ]),
    });
    checkObjectives(state, world);
    expect(state.current).toBe('place_logger');
  });

  it('returns newly completed ids', () => {
    const state: TutorialState = { completed: new Set(), current: 'place_solar' };
    const world = makeWorld({
      islandStates: new Map([
        [
          'home',
          makeIslandState({
            buildings: [{ id: 's1', defId: 'wind_turbine', x: 0, y: 0 }],
          }),
        ],
      ]),
    });
    const newly = checkObjectives(state, world);
    expect(newly).toEqual(['place_solar']);
  });

  it('handles all objectives completed (current = null)', () => {
    const state: TutorialState = {
      completed: new Set<ObjectiveId>([
        'place_solar',
        'place_logger',
        'place_quarry',
        'place_mine',
        'build_smelter',
        'place_workshop',
        'build_kit_assembler',
        'reach_level_5',
        'build_dronepad',
        'build_biofuel_plant',
        'produce_biofuel',
        'dispatch_first_drone',
        'build_pump_jack',
        'build_chlor_alkali_plant',
        'build_lubricant_refinery',
        'produce_lubricant',
        'produce_bolts',
        'maintain_first_building',
        'build_diesel_chain',
        'build_shipyard',
        'settle_first_island',
        'build_antenna',
        'reach_level_15',
        'build_coke_oven',
        'build_blast_furnace',
        'place_steel_mill',
        'build_rolling_mill',
        'build_silicon_chain',
        'build_lithography_lab',
        'build_air_separator',
        'build_drilling_rig',
        'build_hydrogen_chain',
        'build_kerosene_refinery',
        'build_cryo_fuel_chain',
        'reach_level_30',
        'build_glass_chain',
        'build_quantum_chip_fab',
        'craft_ai_core',
        'build_pyroforge',
        'build_particle_accelerator',
        'build_quantum_manipulator',
        'reach_level_50',
        'build_reality_forge',
        'craft_reality_anchor',
      ]),
      current: 'craft_reality_anchor',
    };
    const world = makeWorld();
    const newly = checkObjectives(state, world);
    expect(newly).toEqual([]);
    expect(state.current).toBeNull();
  });

  it('completes objectives based on building PRESENCE, not placement-event order', () => {
    // §3.7 bootstrap path: player follows Solar → Logger → Quarry order, but
    // the tutorial may still be displaying "place_logger" when they reach
    // for Quarry, or they may have placed Quarry before Logger. Every
    // `check()` runs against current presence, so all three objectives
    // settle when their buildings exist — regardless of placement order
    // or which step the banner was currently showing.
    const state: TutorialState = { completed: new Set(), current: 'place_solar' };
    const world = makeWorld({
      // Buildings placed in deliberately scrambled order: Quarry first, then
      // Mine, Logger, then Solar — the opposite of tutorial declaration order.
      islandStates: new Map([
        [
          'home',
          makeIslandState({
            buildings: [
              { id: 'q1', defId: 'quarry', x: -11, y: 4 },
              { id: 'm1', defId: 'mine', x: 8, y: 5 },
              { id: 'l1', defId: 'logger', x: 6, y: -3 },
              { id: 's1', defId: 'wind_turbine', x: 0, y: 0 },
            ],
          }),
        ],
      ]),
    });
    const newly = checkObjectives(state, world);
    expect(newly).toEqual(expect.arrayContaining(['place_solar', 'place_logger', 'place_quarry', 'place_mine']));
    expect(newly).toHaveLength(4);
    expect(state.completed.has('place_solar')).toBe(true);
    expect(state.completed.has('place_logger')).toBe(true);
    expect(state.completed.has('place_quarry')).toBe(true);
    expect(state.completed.has('place_mine')).toBe(true);
    // Current advances to the next uncompleted objective (build_smelter).
    expect(state.current).toBe('build_smelter');
  });

  it('place_solar objective detected when wind_turbine building exists', () => {
    const state: TutorialState = { completed: new Set(), current: 'place_solar' };
    const world = makeWorld({
      islandStates: new Map([
        [
          'home',
          makeIslandState({
            buildings: [{ id: 's1', defId: 'wind_turbine', x: 0, y: 0 }],
          }),
        ],
      ]),
    });
    const newly = checkObjectives(state, world);
    expect(newly).toContain('place_solar');
    expect(state.completed.has('place_solar')).toBe(true);
  });

  it('dispatch_first_drone detected when drones array non-empty', () => {
    const state: TutorialState = {
      completed: new Set([
        'place_solar',
        'place_mine',
        'place_workshop',
        'reach_level_5',
        'build_dronepad',
      ]),
      current: 'dispatch_first_drone',
    };
    const world = makeWorld({
      drones: [
        {
          id: 'drone-1',
          fromIslandId: 'home',
          originX: 0,
          originY: 0,
          dirX: 1,
          dirY: 0,
          outboundTiles: 20,
          scanRadius: 8,
          launchTime: 0,
          expectedReturnTime: 10_000,
          tier: 1,
          fuelLoaded: 10,
          fuelResource: 'biofuel',
          waypoints: [],
          darkMode: false,
          darkModeDiscoveries: [],
          scanBuffer: new Set<string>(),
          probabilityBias: 0,
        },
      ],
    });
    const newly = checkObjectives(state, world);
    expect(newly).toContain('dispatch_first_drone');
    expect(state.completed.has('dispatch_first_drone')).toBe(true);
  });

  it('produce_lubricant completes via lubricantProduced flag, not inventory', () => {
    // The flag, not an inventory threshold: §4.7 maintenance auto-consumes
    // lubricant, so a stockpile check would be unwinnable.
    const base = new Set<ObjectiveId>([
      'place_solar',
      'place_logger',
      'place_quarry',
      'place_mine',
      'place_workshop',
      'reach_level_5',
      'build_dronepad',
      'build_biofuel_plant',
      'produce_biofuel',
      'dispatch_first_drone',
      'build_lubricant_refinery',
    ]);
    const state: TutorialState = { completed: new Set(base), current: 'produce_lubricant' };
    // Empty inventory — only the flag is set.
    const world = makeWorld({
      islandStates: new Map([
        ['home', makeIslandState({ lubricantProduced: true } as Partial<IslandState>)],
      ]),
    });
    const newly = checkObjectives(state, world);
    expect(newly).toContain('produce_lubricant');
    expect(state.completed.has('produce_lubricant')).toBe(true);
  });

  it('produce_lubricant stays incomplete with lubricant in inventory but flag unset', () => {
    const state: TutorialState = { completed: new Set(), current: 'produce_lubricant' };
    const world = makeWorld({
      islandStates: new Map([
        [
          'home',
          makeIslandState({
            inventory: { lubricant: 999 } as Record<string, number>,
          }),
        ],
      ]),
    });
    const newly = checkObjectives(state, world);
    expect(newly).not.toContain('produce_lubricant');
  });

  it('produce_bolts completes via boltProduced flag', () => {
    const state: TutorialState = { completed: new Set(), current: 'produce_bolts' };
    const world = makeWorld({
      islandStates: new Map([
        ['home', makeIslandState({ boltProduced: true } as Partial<IslandState>)],
      ]),
    });
    const newly = checkObjectives(state, world);
    expect(newly).toContain('produce_bolts');
    expect(state.completed.has('produce_bolts')).toBe(true);
  });

  it('does not re-report already-completed objectives', () => {
    const state: TutorialState = { completed: new Set(['place_solar']), current: 'place_mine' };
    const world = makeWorld({
      islandStates: new Map([
        [
          'home',
          makeIslandState({
            buildings: [
              { id: 's1', defId: 'wind_turbine', x: 0, y: 0 },
              { id: 'm1', defId: 'mine', x: 1, y: 0 },
            ],
          }),
        ],
      ]),
    });
    const newly = checkObjectives(state, world);
    expect(newly).toEqual(['place_mine']);
    expect(state.completed.has('place_solar')).toBe(true);
    expect(state.completed.has('place_mine')).toBe(true);
  });

  it('skips ahead to the first uncompleted objective in order', () => {
    const state: TutorialState = {
      completed: new Set(['place_solar', 'place_logger', 'place_quarry', 'place_mine']),
      current: 'place_workshop',
    };
    const world = makeWorld({
      islandStates: new Map([
        [
          'home',
          makeIslandState({
            buildings: [
              { id: 's1', defId: 'wind_turbine', x: 0, y: 0 },
              { id: 'l1', defId: 'logger', x: 6, y: -3 },
              { id: 'q1', defId: 'quarry', x: -11, y: 4 },
              { id: 'm1', defId: 'mine', x: 8, y: 5 },
              { id: 'w1', defId: 'workshop', x: 2, y: 2 },
            ],
          }),
        ],
      ]),
    });
    checkObjectives(state, world);
    // build_smelter is the next step after place_workshop — the player hasn't
    // placed a Smelter yet, so the banner skips ahead to that prerequisite.
    expect(state.current).toBe('build_smelter');
  });
});
