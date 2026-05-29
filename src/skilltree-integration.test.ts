import { describe, expect, it } from 'vitest';
import {
  buyNode,
  canBuyKeystone,
  buyKeystone,
  costToUnlock,
  DEFAULT_GRAPH,
} from './skilltree.js';
import type { IslandState } from './economy.js';
import {
  FULL_CATALOG,
  KEYSTONE_PREREQS,
  BRIDGE_CATALOG,
} from './skilltree-catalog.js';

function makeState(over: Partial<IslandState> = {}): IslandState {
  return {
    id: 'test',
    buildings: [],
    inventory: {},
    storageCaps: {},
    xp: 0,
    level: 1,
    unspentSkillPoints: 100,
    unlockedNodes: new Set(),
    unlockedEdges: new Set(),
    funnelPending: {},
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
    starterInventoryGrace: {},
    socketBindings: new Map(),
    lastTick: 0,
    ...over,
  } as IslandState;
}

describe('skilltree graph integration', () => {
  it('FULL_CATALOG includes filler + notables + keystones', () => {
    expect(FULL_CATALOG.length).toBeGreaterThan(400);
    const notableCount = FULL_CATALOG.filter((n) => n.id.includes('.notable.')).length;
    const keystoneCount = FULL_CATALOG.filter((n) => n.id.includes('.keystone.')).length;
    expect(notableCount).toBeGreaterThanOrEqual(80);
    expect(keystoneCount).toBeGreaterThanOrEqual(30);
  });

  it('depth-1 filler is buyable end-to-end via buyNode', () => {
    // depth 1/2 require tier 2 (level ≥ 5) under the §9.3 depth→tier gate.
    const state = makeState({ level: 5 });
    const target = 'mining.recipeRate.1';
    expect(state.unlockedNodes.has(target)).toBe(false);
    buyNode(DEFAULT_GRAPH, state, target);
    expect(state.unlockedNodes.has(target)).toBe(true);
  });

  it('depth-2 filler is buyable via buyNode after depth-1 is owned (auto-owns intermediates)', () => {
    const state = makeState({ level: 5 });
    // First buy the root depth-1 node
    buyNode(DEFAULT_GRAPH, state, 'mining.recipeRate.1');
    expect(state.unlockedNodes.has('mining.recipeRate.1')).toBe(true);
    // Then depth-2 is reachable and auto-owns depth-1 (already owned)
    buyNode(DEFAULT_GRAPH, state, 'mining.recipeRate.2');
    expect(state.unlockedNodes.has('mining.recipeRate.2')).toBe(true);
  });

  it('every KeystonePrereq targetNode exists in FULL_CATALOG', () => {
    const ids = new Set(FULL_CATALOG.map((n) => n.id));
    for (const ks of KEYSTONE_PREREQS) {
      expect(ids.has(ks.targetNode as string)).toBe(true);
    }
  });

  it('every KeystonePrereq.requires NodeId exists in FULL_CATALOG', () => {
    const ids = new Set(FULL_CATALOG.map((n) => n.id));
    for (const ks of KEYSTONE_PREREQS) {
      for (const req of ks.requires) {
        expect(ids.has(req as string)).toBe(true);
      }
    }
  });

  it('BRIDGE_CATALOG endpoints exist in FULL_CATALOG', () => {
    const ids = new Set(FULL_CATALOG.map((n) => n.id));
    for (const br of BRIDGE_CATALOG) {
      expect(ids.has(br.from as string)).toBe(true);
      expect(ids.has(br.to as string)).toBe(true);
    }
  });

  it('AND-prereq keystone canBuyKeystone returns false until all prereqs owned', () => {
    const ks = KEYSTONE_PREREQS[0]!;
    const state = makeState({ unspentSkillPoints: ks.cost + 10 });
    // None owned → false
    expect(canBuyKeystone(ks, state)).toBe(false);
    // Own first prereq only → false
    state.unlockedNodes.add(ks.requires[0] as string);
    expect(canBuyKeystone(ks, state)).toBe(false);
    // Own all prereqs → true
    for (const req of ks.requires) {
      state.unlockedNodes.add(req as string);
    }
    expect(canBuyKeystone(ks, state)).toBe(true);
  });

  it('buyKeystone debits SP and adds target to unlockedNodes', () => {
    const ks = KEYSTONE_PREREQS[0]!;
    const state = makeState({
      unspentSkillPoints: ks.cost,
      unlockedNodes: new Set(ks.requires.map((r) => r as string)),
    });
    buyKeystone(ks, state);
    expect(state.unlockedNodes.has(ks.targetNode as string)).toBe(true);
    expect(state.unspentSkillPoints).toBe(0);
  });

  it('costToUnlock returns cheapest path for a chain node when entry is owned', () => {
    // depth-3 target requires tier 3 (level ≥ 15) under the §9.3 gate, else
    // costToUnlock tier-filters the depth-3 node out and returns null.
    const state = makeState({ level: 15 });
    // Own depth-1 so depth-3 becomes reachable
    state.unlockedNodes.add('mining.recipeRate.1');
    const result = costToUnlock(DEFAULT_GRAPH, state.unlockedNodes, state.unlockedEdges, state, 'mining.recipeRate.3');
    expect(result).not.toBeNull();
    // Path should go through depth-2 and depth-3
    expect(result!.path.length).toBe(2);
    expect(result!.totalCost).toBeGreaterThan(0);
  });

  it('DEFAULT_GRAPH has edges and bridges populated', () => {
    expect(DEFAULT_GRAPH.edges.length).toBeGreaterThan(0);
    expect(DEFAULT_GRAPH.bridges.length).toBeGreaterThan(0);
    expect(DEFAULT_GRAPH.graftSockets.length).toBeGreaterThan(0);
  });

  it('node count matches FULL_CATALOG', () => {
    expect(DEFAULT_GRAPH.nodes.length).toBe(FULL_CATALOG.length);
  });
});
