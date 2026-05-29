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
import { BUILDING_DEFS } from './building-defs.js';

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
  it('has exactly 72 entries with unique ids', () => {
    expect(TUTORIAL_STEPS.length).toBe(72);
    const ids = new Set(TUTORIAL_STEPS.map((s) => s.id));
    expect(ids.size).toBe(72);
  });
});

// ---------------------------------------------------------------------------
// 2. Guard — targetDefId resolves, requiredTile is named, no dead lambdas
// ---------------------------------------------------------------------------

describe('TUTORIAL_STEPS — guard', () => {
  it('every targetDefId resolves to a real BUILDING_DEFS entry', () => {
    for (const step of TUTORIAL_STEPS) {
      if (step.targetDefId == null) continue;
      expect(BUILDING_DEFS[step.targetDefId], `${step.id} → ${step.targetDefId}`).toBeDefined();
    }
  });

  it("each build step's hint/expectedAction names the target's requiredTile (when it has one)", () => {
    for (const step of TUTORIAL_STEPS) {
      if (step.targetDefId == null) continue;
      const def: { requiredTile?: readonly string[] } = BUILDING_DEFS[step.targetDefId];
      const tiles = def.requiredTile ?? [];
      if (tiles.length === 0) continue; // target has no tile gate (e.g. smelter, copper_smelter)
      const text = `${step.hint} ${step.expectedAction ?? ''}`.toLowerCase();
      const named = tiles.some((t) => text.includes(t.toLowerCase()));
      expect(named, `${step.id} (${step.targetDefId}) must name one of ${tiles.join('/')}`).toBe(true);
    }
  });

  it('every step has real trigger + dismissal functions (no () => false stubs)', () => {
    for (const step of TUTORIAL_STEPS) {
      expect(typeof step.triggerCondition).toBe('function');
      expect(typeof step.dismissalCondition).toBe('function');
      // A trivial `() => false` body is forbidden — reject the literal.
      const tBody = step.triggerCondition.toString().replace(/\s/g, '');
      const dBody = step.dismissalCondition.toString().replace(/\s/g, '');
      expect(tBody, `${step.id} trigger is a dead stub`).not.toMatch(/=>false$/);
      expect(dBody, `${step.id} dismissal is a dead stub`).not.toMatch(/=>false$/);
    }
  });
});

// ---------------------------------------------------------------------------
// 3. Ordering
// ---------------------------------------------------------------------------

describe('TUTORIAL_STEPS — ordering', () => {
  it('currentStep returns step 1 on a fresh world', () => {
    const w = makeTestWorld();
    expect(currentStep(w)?.id).toBe('01_location');
  });

  it('currentStep returns step N+1 after step N is marked completed', () => {
    const w = makeTestWorld({ playerLat: 40 });
    markCompleted(w, '01_location');
    expect(currentStep(w)?.id).toBe('02_inventory');
  });

  it('mid-tutorial state resumes at the right step', () => {
    // playerLat set (01 dismissed) and 02 completed, but NO power building yet
    // — so 03_power is the live step. (Pushing a water_wheel here would
    // satisfy 03's dismissal and surface 04 instead.)
    const w = makeTestWorld({ playerLat: 40 });
    w.tutorialState = {
      completed: new Set(['01_location', '02_inventory']),
      current: '03_power',
    };
    expect(currentStep(w)?.id).toBe('03_power');
  });

  it('the whole chain is walkable in order — every step reachable in sequence', () => {
    // A single forward walk: assert the live step, satisfy its target/gate,
    // mark it complete, repeat. If any trigger were dead/unreachable,
    // currentStep would skip past it and the assert fails AT that step,
    // naming it. Subsumes per-step trigger reachability + ordering.
    const w = makeTestWorld();
    const homeState = w.islandStates!.get('home')!;
    homeState.inventory = {} as Record<ResourceId, number>;

    const placeOnHome = (defId: string, x = 0, y = 0) => {
      w.islands[0]!.buildings.push({
        id: `${defId}_${x}_${y}`,
        defId: defId as PlacedBuilding['defId'],
        x,
        y,
      });
    };

    for (const expected of TUTORIAL_STEPS) {
      expect(currentStep(w)?.id, `chain stalled before ${expected.id}`).toBe(expected.id);
      if (expected.targetDefId) placeOnHome(expected.targetDefId);
      switch (expected.id) {
        case '01_location':
          w.playerLat = 40;
          break;
        case '07_mine':
          placeOnHome('mine', 1, 0); // 2nd mine → hasAdjacentSameType for 12_adjacency
          homeState.inventory.iron_ore = 100; // → 10_smelter trigger
          homeState.inventory.coal = 100;
          break;
        case '16_tier2':
          homeState.level = 5;
          break;
        case '38_settle': {
          const i2 = makeTestIsland('isl2');
          i2.spec.populated = true;
          w.islands.push(i2.spec);
          w.islandStates!.set('isl2', i2.state);
          break;
        }
        case '41_tier3':
          homeState.level = 15;
          break;
        case '61_tier4':
          homeState.level = 30;
          break;
        case '63_ai_core':
          homeState.inventory.ai_core = 1;
          break;
        case '69_tier5':
          homeState.level = 50; // ai_core already seen at step 63
          break;
        case '71_reality_anchor':
          homeState.inventory.reality_anchor = 1;
          break;
        default:
          break;
      }
      markCompleted(w, expected.id);
    }
    expect(currentStep(w)).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// 3b. Dismissal lifecycle (checkDismissals)
// ---------------------------------------------------------------------------

describe('checkDismissals', () => {
  it('reports a build step as dismissable once its target is placed', () => {
    const w = makeTestWorld({ playerLat: 40 });
    expect(checkDismissals(w)).not.toContain('03_power');
    w.islands[0]!.buildings.push({ id: 'b1', defId: 'water_wheel', x: 0, y: 0 });
    expect(checkDismissals(w)).toContain('03_power');
  });

  it('reports a concept step as dismissable after its TTL elapses', () => {
    const w = makeTestWorld({ playerLat: 40 });
    w.tutorialState = {
      completed: new Set(),
      current: null,
      completedAt: { '02_inventory': 0 }, // long-elapsed → TTL satisfied
    };
    expect(checkDismissals(w)).toContain('02_inventory');
  });
});

// ---------------------------------------------------------------------------
// 4. skipAll + restart
// ---------------------------------------------------------------------------

describe('skipAll + restart', () => {
  it('skipAll fills completed with all 72 ids', () => {
    const w = makeTestWorld();
    skipAll(w);
    expect(w.tutorialState!.completed.size).toBe(72);
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
    expect(currentStep(w)?.id).toBe('01_location');
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
    expect(currentStep(restored)?.id).toBe('01_location');
  });

  it('mid-tutorial state round-trips identity', () => {
    const world = makeInitialWorld(0);
    world.tutorialState = {
      completed: new Set(['01_location', '02_inventory']),
      current: '03_power',
    };
    const snap = serializeWorld(world, new Map(), 0);
    const json = JSON.parse(JSON.stringify(snap)) as SaveSnapshot;
    const { world: restored } = deserializeWorld(json, 0, 0);
    expect(restored.tutorialState?.completed).toEqual(
      new Set(['01_location', '02_inventory']),
    );
    expect(restored.tutorialState?.current).toBe('03_power');
  });
});

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
