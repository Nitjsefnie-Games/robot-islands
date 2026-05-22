import { describe, expect, it } from 'vitest';

import type { IslandState } from './economy.js';
import { type ResourceId } from './recipes.js';
import { checkObjectives, type ObjectiveId, type TutorialState } from './tutorial.js';
import type { WorldState } from './world.js';

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
    oceanCells: new Map(),
    depthRevealedCells: new Set(),
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
    subPathProgress: new Map(),
    funnelPending: {} as Record<string, number>,
    specializationRole: null,
    declaredAt: null,
    aiCoreCrafted: false,
    ascendantCoreCrafted: false,
    lastResetAt: null,
    timeLockBankedMin: 0,
    accelerationQueue: [],
    accelerationRemainingMin: 0,
    bankingEnabled: false,
    genesisTarget: null,
    singularityStoredWs: 0,
    starterInventoryGrace: {} as Record<ResourceId, number>,
    lastTick: 0,
    ...over,
  };
}

describe('checkObjectives', () => {
  it('advances current when objective is completed', () => {
    const state: TutorialState = { completed: new Set(), current: 'place_solar' };
    const world = makeWorld({
      islandStates: new Map([['home', makeIslandState({ buildings: [{ id: 's1', defId: 'solar', x: 0, y: 0 }] })]]),
    });
    checkObjectives(state, world);
    expect(state.current).toBe('place_logger');
  });

  it('returns newly completed ids', () => {
    const state: TutorialState = { completed: new Set(), current: 'place_solar' };
    const world = makeWorld({
      islandStates: new Map([['home', makeIslandState({ buildings: [{ id: 's1', defId: 'solar', x: 0, y: 0 }] })]]),
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
        'reach_level_30',
        'build_glass_chain',
        'build_hydrogen_chain',
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
      islandStates: new Map([['home', makeIslandState({ buildings: [
        { id: 'q1', defId: 'quarry', x: -11, y: 4 },
        { id: 'm1', defId: 'mine', x: 8, y: 5 },
        { id: 'l1', defId: 'logger', x: 6, y: -3 },
        { id: 's1', defId: 'solar', x: 0, y: 0 },
      ] })]]),
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

  it('place_solar objective detected when solar building exists', () => {
    const state: TutorialState = { completed: new Set(), current: 'place_solar' };
    const world = makeWorld({
      islandStates: new Map([['home', makeIslandState({ buildings: [{ id: 's1', defId: 'solar', x: 0, y: 0 }] })]]),
    });
    const newly = checkObjectives(state, world);
    expect(newly).toContain('place_solar');
    expect(state.completed.has('place_solar')).toBe(true);
  });

  it('dispatch_first_drone detected when drones array non-empty', () => {
    const state: TutorialState = { completed: new Set(['place_solar', 'place_mine', 'place_workshop', 'reach_level_5', 'build_dronepad']), current: 'dispatch_first_drone' };
    const world = makeWorld({
      drones: [{
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
        probabilityBias: 0,
      }],
    });
    const newly = checkObjectives(state, world);
    expect(newly).toContain('dispatch_first_drone');
    expect(state.completed.has('dispatch_first_drone')).toBe(true);
  });

  it('produce_lubricant completes via lubricantProduced flag, not inventory', () => {
    // The flag, not an inventory threshold: §4.7 maintenance auto-consumes
    // lubricant, so a stockpile check would be unwinnable.
    const base = new Set<ObjectiveId>([
      'place_solar', 'place_logger', 'place_quarry', 'place_mine', 'place_workshop',
      'reach_level_5', 'build_dronepad', 'build_biofuel_plant', 'produce_biofuel',
      'dispatch_first_drone', 'build_lubricant_refinery',
    ]);
    const state: TutorialState = { completed: new Set(base), current: 'produce_lubricant' };
    // Empty inventory — only the flag is set.
    const world = makeWorld({
      islandStates: new Map([['home', makeIslandState({ lubricantProduced: true })]]),
    });
    const newly = checkObjectives(state, world);
    expect(newly).toContain('produce_lubricant');
    expect(state.completed.has('produce_lubricant')).toBe(true);
  });

  it('produce_lubricant stays incomplete with lubricant in inventory but flag unset', () => {
    const state: TutorialState = { completed: new Set(), current: 'produce_lubricant' };
    const world = makeWorld({
      islandStates: new Map([['home', makeIslandState({
        inventory: { lubricant: 999 } as Record<string, number>,
      })]]),
    });
    const newly = checkObjectives(state, world);
    expect(newly).not.toContain('produce_lubricant');
  });

  it('produce_bolts completes via boltProduced flag', () => {
    const state: TutorialState = { completed: new Set(), current: 'produce_bolts' };
    const world = makeWorld({
      islandStates: new Map([['home', makeIslandState({ boltProduced: true })]]),
    });
    const newly = checkObjectives(state, world);
    expect(newly).toContain('produce_bolts');
    expect(state.completed.has('produce_bolts')).toBe(true);
  });

  it('does not re-report already-completed objectives', () => {
    const state: TutorialState = { completed: new Set(['place_solar']), current: 'place_mine' };
    const world = makeWorld({
      islandStates: new Map([['home', makeIslandState({ buildings: [
        { id: 's1', defId: 'solar', x: 0, y: 0 },
        { id: 'm1', defId: 'mine', x: 1, y: 0 },
      ] })]]),
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
      islandStates: new Map([['home', makeIslandState({ buildings: [
        { id: 's1', defId: 'solar', x: 0, y: 0 },
        { id: 'l1', defId: 'logger', x: 6, y: -3 },
        { id: 'q1', defId: 'quarry', x: -11, y: 4 },
        { id: 'm1', defId: 'mine', x: 8, y: 5 },
        { id: 'w1', defId: 'workshop', x: 2, y: 2 },
      ] })]]),
    });
    checkObjectives(state, world);
    // build_smelter is the next step after place_workshop — the player hasn't
    // placed a Smelter yet, so the banner skips ahead to that prerequisite.
    expect(state.current).toBe('build_smelter');
  });
});
