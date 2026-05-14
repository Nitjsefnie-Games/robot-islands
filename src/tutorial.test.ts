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
    seed: 'test-seed',
    endgameState: { achieved: new Set(), firstAchievedMs: null, victoryBannerShown: false },
    latticeActive: false,
    latticeNodeIslands: [],
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
    expect(state.current).toBe('place_mine');
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
        'place_mine',
        'place_workshop',
        'reach_level_5',
        'build_dronepad',
        'dispatch_first_drone',
        'settle_first_island',
        'build_antenna',
      ]),
      current: 'build_antenna',
    };
    const world = makeWorld();
    const newly = checkObjectives(state, world);
    expect(newly).toEqual([]);
    expect(state.current).toBeNull();
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
    const state: TutorialState = { completed: new Set(['place_solar', 'place_mine']), current: 'place_workshop' };
    const world = makeWorld({
      islandStates: new Map([['home', makeIslandState({ buildings: [
        { id: 's1', defId: 'solar', x: 0, y: 0 },
        { id: 'm1', defId: 'mine', x: 1, y: 0 },
        { id: 'w1', defId: 'workshop', x: 2, y: 0 },
      ] })]]),
    });
    checkObjectives(state, world);
    expect(state.current).toBe('reach_level_5');
  });
});
