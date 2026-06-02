import { describe, expect, it } from 'vitest';
import { computeSharedNetworkState } from './network.js';
import type { WorldState } from './world.js';
import type { IslandState } from './economy.js';
import type { Graph } from './skilltree-graph.js';

describe('computeSharedNetworkState', () => {
  it('aggregates shared inventory across two networked T3+ participants', () => {
    const stateA: IslandState = {
      id: 'home',
      buildings: [],
      inventory: { iron_ore: 100 } as any,
      storageCaps: {} as any,
      xp: 0,
      level: 15,
      unspentSkillPoints: 0,
      unlockedNodes: new Set(['shared.1']),
      unlockedEdges: new Set(),
      auraAmpVersion: 0,
      auraAmpCache: null,
      auraAmpCacheVersion: -1,
      co2Kg: 0,
      funnelPending: {} as any,
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
      starterInventoryGrace: {} as any,
      socketBindings: new Map(),
      everProduced: new Set(),
      lastTick: 0,
    } as IslandState;

    const stateB: IslandState = {
      id: 'b',
      buildings: [],
      inventory: { iron_ore: 50 } as any,
      storageCaps: {} as any,
      xp: 0,
      level: 15,
      unspentSkillPoints: 0,
      unlockedNodes: new Set(['shared.1']),
      unlockedEdges: new Set(),
      auraAmpVersion: 0,
      auraAmpCache: null,
      auraAmpCacheVersion: -1,
      co2Kg: 0,
      funnelPending: {} as any,
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
      starterInventoryGrace: {} as any,
      socketBindings: new Map(),
      everProduced: new Set(),
      lastTick: 0,
    } as IslandState;

    const world: WorldState = {
      islands: [
        { id: 'home', populated: true, cx: 0, cy: 0 } as any,
        { id: 'b', populated: true, cx: 1, cy: 0 } as any,
      ],
      islandStates: new Map([
        ['home', stateA],
        ['b', stateB],
      ]),
      routes: [{ from: 'home', to: 'b' } as any],
      seed: 'test',
      drones: [],
      vehicles: [],
      revealedCells: new Set(),
      satellites: [],
      repairDrones: [],
      debrisFields: [],
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
    } as WorldState;

    const graph: Graph = {
      nodes: [
        {
          id: 'shared.1',
          subPath: 'network',
          depth: 1,
          cost: 1,
          magnitude: 0.05,
          effect: { kind: 'crossIslandShared', shape: { kind: 'sharedInventory', resources: ['iron_ore'] } },
          description: 'shared iron',
        },
      ],
      edges: [],
      bridges: [],
      graftSockets: [],
    };

    const result = computeSharedNetworkState(world, graph);
    expect(result.participantIds.has('home')).toBe(true);
    expect(result.participantIds.has('b')).toBe(true);
    expect(result.sharedInventory.get('iron_ore')).toBe(150);
  });

  it('excludes non-networked islands from shared pool', () => {
    const stateA: IslandState = {
      id: 'home',
      buildings: [],
      inventory: { iron_ore: 100 } as any,
      storageCaps: {} as any,
      xp: 0,
      level: 15,
      unspentSkillPoints: 0,
      unlockedNodes: new Set(['shared.1']),
      unlockedEdges: new Set(),
      auraAmpVersion: 0,
      auraAmpCache: null,
      auraAmpCacheVersion: -1,
      co2Kg: 0,
      funnelPending: {} as any,
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
      starterInventoryGrace: {} as any,
      socketBindings: new Map(),
      everProduced: new Set(),
      lastTick: 0,
    } as IslandState;

    const stateC: IslandState = {
      id: 'c',
      buildings: [],
      inventory: { iron_ore: 999 } as any,
      storageCaps: {} as any,
      xp: 0,
      level: 15,
      unspentSkillPoints: 0,
      unlockedNodes: new Set(['shared.1']),
      unlockedEdges: new Set(),
      auraAmpVersion: 0,
      auraAmpCache: null,
      auraAmpCacheVersion: -1,
      co2Kg: 0,
      funnelPending: {} as any,
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
      starterInventoryGrace: {} as any,
      socketBindings: new Map(),
      everProduced: new Set(),
      lastTick: 0,
    } as IslandState;

    const world: WorldState = {
      islands: [
        { id: 'home', populated: true, cx: 0, cy: 0 } as any,
        { id: 'c', populated: true, cx: 100, cy: 0 } as any,
      ],
      islandStates: new Map([
        ['home', stateA],
        ['c', stateC],
      ]),
      routes: [],
      seed: 'test',
      drones: [],
      vehicles: [],
      revealedCells: new Set(),
      satellites: [],
      repairDrones: [],
      debrisFields: [],
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
    } as WorldState;

    const graph: Graph = {
      nodes: [
        {
          id: 'shared.1',
          subPath: 'network',
          depth: 1,
          cost: 1,
          magnitude: 0.05,
          effect: { kind: 'crossIslandShared', shape: { kind: 'sharedInventory', resources: ['iron_ore'] } },
          description: 'shared iron',
        },
      ],
      edges: [],
      bridges: [],
      graftSockets: [],
    };

    const result = computeSharedNetworkState(world, graph);
    // Only 'home' is networked (no routes, so only home is reachable from home).
    expect(result.participantIds.has('home')).toBe(true);
    expect(result.participantIds.has('c')).toBe(false);
    expect(result.sharedInventory.get('iron_ore')).toBe(100);
  });

  it('excludes islands below T3 from participants', () => {
    const stateA: IslandState = {
      id: 'home',
      buildings: [],
      inventory: { iron_ore: 100 } as any,
      storageCaps: {} as any,
      xp: 0,
      level: 14,
      unspentSkillPoints: 0,
      unlockedNodes: new Set(['shared.1']),
      unlockedEdges: new Set(),
      auraAmpVersion: 0,
      auraAmpCache: null,
      auraAmpCacheVersion: -1,
      co2Kg: 0,
      funnelPending: {} as any,
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
      starterInventoryGrace: {} as any,
      socketBindings: new Map(),
      everProduced: new Set(),
      lastTick: 0,
    } as IslandState;

    const world: WorldState = {
      islands: [
        { id: 'home', populated: true, cx: 0, cy: 0 } as any,
      ],
      islandStates: new Map([
        ['home', stateA],
      ]),
      routes: [],
      seed: 'test',
      drones: [],
      vehicles: [],
      revealedCells: new Set(),
      satellites: [],
      repairDrones: [],
      debrisFields: [],
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
    } as WorldState;

    const graph: Graph = {
      nodes: [
        {
          id: 'shared.1',
          subPath: 'network',
          depth: 1,
          cost: 1,
          magnitude: 0.05,
          effect: { kind: 'crossIslandShared', shape: { kind: 'sharedInventory', resources: ['iron_ore'] } },
          description: 'shared iron',
        },
      ],
      edges: [],
      bridges: [],
      graftSockets: [],
    };

    const result = computeSharedNetworkState(world, graph);
    expect(result.participantIds.has('home')).toBe(false);
    expect(result.sharedInventory.get('iron_ore')).toBeUndefined();
  });

  it('aggregates sharedStorageCap across participants', () => {
    const stateA: IslandState = {
      id: 'home',
      buildings: [],
      inventory: {} as any,
      storageCaps: { iron_ore: 200 } as any,
      xp: 0,
      level: 15,
      unspentSkillPoints: 0,
      unlockedNodes: new Set(['shared.2']),
      unlockedEdges: new Set(),
      auraAmpVersion: 0,
      auraAmpCache: null,
      auraAmpCacheVersion: -1,
      co2Kg: 0,
      funnelPending: {} as any,
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
      starterInventoryGrace: {} as any,
      socketBindings: new Map(),
      everProduced: new Set(),
      lastTick: 0,
    } as IslandState;

    const stateB: IslandState = {
      id: 'b',
      buildings: [],
      inventory: {} as any,
      storageCaps: { iron_ore: 300 } as any,
      xp: 0,
      level: 15,
      unspentSkillPoints: 0,
      unlockedNodes: new Set(['shared.2']),
      unlockedEdges: new Set(),
      auraAmpVersion: 0,
      auraAmpCache: null,
      auraAmpCacheVersion: -1,
      co2Kg: 0,
      funnelPending: {} as any,
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
      starterInventoryGrace: {} as any,
      socketBindings: new Map(),
      everProduced: new Set(),
      lastTick: 0,
    } as IslandState;

    const world: WorldState = {
      islands: [
        { id: 'home', populated: true, cx: 0, cy: 0 } as any,
        { id: 'b', populated: true, cx: 1, cy: 0 } as any,
      ],
      islandStates: new Map([
        ['home', stateA],
        ['b', stateB],
      ]),
      routes: [{ from: 'home', to: 'b' } as any],
      seed: 'test',
      drones: [],
      vehicles: [],
      revealedCells: new Set(),
      satellites: [],
      repairDrones: [],
      debrisFields: [],
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
    } as WorldState;

    const graph: Graph = {
      nodes: [
        {
          id: 'shared.2',
          subPath: 'network',
          depth: 1,
          cost: 1,
          magnitude: 0.05,
          effect: { kind: 'crossIslandShared', shape: { kind: 'sharedStorageCap', resources: ['iron_ore'] } },
          description: 'shared cap',
        },
      ],
      edges: [],
      bridges: [],
      graftSockets: [],
    };

    const result = computeSharedNetworkState(world, graph);
    expect(result.sharedStorageCap.get('iron_ore')).toBe(500);
  });
});
