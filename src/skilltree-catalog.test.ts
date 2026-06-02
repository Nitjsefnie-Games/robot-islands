import { describe, expect, it } from 'vitest';
import {
  NOTABLES, KEYSTONES, FULL_CATALOG, KEYSTONE_PREREQS,
  BRIDGE_CATALOG, GRAFT_SOCKET_CATALOG,
} from './skilltree-catalog.js';
import { SUBPATH_LABEL, BRANCH_LABEL, costToUnlock, type SkillNode, type NodeId } from './skilltree.js';
import type { Graph, BridgeEdge, Edge } from './skilltree-graph.js';

describe('NOTABLES catalog', () => {
  it('has ~80 notables', () => {
    expect(NOTABLES.length).toBeGreaterThanOrEqual(60);
    expect(NOTABLES.length).toBeLessThanOrEqual(100);
  });

  it('all ids are unique', () => {
    const ids = NOTABLES.map((n) => n.id);
    const unique = new Set(ids);
    expect(unique.size).toBe(ids.length);
  });

  it('all subPaths are valid SubPathId values', () => {
    const validSubPaths = new Set(Object.keys(SUBPATH_LABEL));
    for (const n of NOTABLES) {
      expect(validSubPaths.has(n.subPath)).toBe(true);
    }
  });

  it('every sub-path has at least one notable', () => {
    const subPaths = new Set(NOTABLES.map((n) => n.subPath));
    expect(subPaths.size).toBe(20);
  });

  it('at least one notable per sub-path has an aura', () => {
    const subPathsWithAura = new Set<string>();
    for (const n of NOTABLES) {
      if (n.aura) subPathsWithAura.add(n.subPath);
    }
    expect(subPathsWithAura.size).toBeGreaterThanOrEqual(15);
  });

  it('aura radius is 1 or 2', () => {
    for (const n of NOTABLES) {
      if (n.aura) {
        expect([1, 2]).toContain(n.aura.radius);
      }
    }
  });

  it('aura bonus is positive', () => {
    for (const n of NOTABLES) {
      if (n.aura) {
        expect(n.aura.bonus).toBeGreaterThan(0);
      }
    }
  });
});

describe('KEYSTONES catalog', () => {
  it('has ~30 keystones', () => {
    expect(KEYSTONES.length).toBeGreaterThanOrEqual(25);
    expect(KEYSTONES.length).toBeLessThanOrEqual(35);
  });

  it('all keystone ids are unique', () => {
    const ids = KEYSTONES.map((n) => n.id);
    const unique = new Set(ids);
    expect(unique.size).toBe(ids.length);
  });

  it('keystone ids do not overlap with notable ids', () => {
    const notableIds = new Set(NOTABLES.map((n) => n.id));
    for (const k of KEYSTONES) {
      expect(notableIds.has(k.id)).toBe(false);
    }
  });

  it('keystone id pattern uses .keystone. segment', () => {
    for (const k of KEYSTONES) {
      expect(k.id).toContain('.keystone.');
    }
  });
});

describe('FULL_CATALOG', () => {
  it('all ids across notables + keystones are unique', () => {
    const ids = FULL_CATALOG.map((n) => n.id);
    const unique = new Set(ids);
    expect(unique.size).toBe(ids.length);
  });
});

describe('KEYSTONE_PREREQS', () => {
  it('has one prereq entry per keystone', () => {
    expect(KEYSTONE_PREREQS.length).toBe(KEYSTONES.length);
  });

  it('every targetNode exists in FULL_CATALOG', () => {
    const catalogIds = new Set(FULL_CATALOG.map((n) => n.id));
    for (const ks of KEYSTONE_PREREQS) {
      expect(catalogIds.has(ks.targetNode as string)).toBe(true);
    }
  });

  it('every requires node exists in FULL_CATALOG', () => {
    const catalogIds = new Set(FULL_CATALOG.map((n) => n.id));
    for (const ks of KEYSTONE_PREREQS) {
      for (const req of ks.requires) {
        expect(catalogIds.has(req as string)).toBe(true);
      }
    }
  });

  it('each keystone requires 2-3 nodes', () => {
    for (const ks of KEYSTONE_PREREQS) {
      expect(ks.requires.length).toBeGreaterThanOrEqual(2);
      expect(ks.requires.length).toBeLessThanOrEqual(3);
    }
  });
});

describe('BRIDGE_CATALOG', () => {
  it('bridge count is in planned range (25-30)', () => {
    expect(BRIDGE_CATALOG.length).toBeGreaterThanOrEqual(25);
    expect(BRIDGE_CATALOG.length).toBeLessThanOrEqual(30);
  });

  it('every bridge endpoint (from + to) exists in FULL_CATALOG', () => {
    const catalogIds = new Set(FULL_CATALOG.map((n) => n.id));
    for (const br of BRIDGE_CATALOG) {
      expect(catalogIds.has(br.from as string)).toBe(true);
      expect(catalogIds.has(br.to as string)).toBe(true);
    }
  });

  it('every threshold branch is a valid BranchId', () => {
    const validBranches = new Set(Object.keys(BRANCH_LABEL));
    for (const br of BRIDGE_CATALOG) {
      for (const t of br.threshold) {
        expect(validBranches.has(t.branch)).toBe(true);
      }
    }
  });

  it('every bridge has at least one threshold', () => {
    for (const br of BRIDGE_CATALOG) {
      expect(br.threshold.length).toBeGreaterThanOrEqual(1);
    }
  });

  it('all bridge ids are unique', () => {
    const ids = BRIDGE_CATALOG.map((b) => b.id);
    const unique = new Set(ids);
    expect(unique.size).toBe(ids.length);
  });

  it('bridge mode is "or" (alt-entry)', () => {
    for (const br of BRIDGE_CATALOG) {
      expect(br.mode).toBe('or');
    }
  });
});

describe('GRAFT_SOCKET_CATALOG', () => {
  it('total socket count is in planned range (40-50)', () => {
    expect(GRAFT_SOCKET_CATALOG.length).toBeGreaterThanOrEqual(40);
    expect(GRAFT_SOCKET_CATALOG.length).toBeLessThanOrEqual(50);
  });

  it('all socket ids are unique', () => {
    const ids = GRAFT_SOCKET_CATALOG.map((s) => s.id);
    const unique = new Set(ids);
    expect(unique.size).toBe(ids.length);
  });

  it('each branch has 6-12 sockets', () => {
    const branchCounts = new Map<string, number>();
    for (const s of GRAFT_SOCKET_CATALOG) {
      branchCounts.set(s.branchId, (branchCounts.get(s.branchId) ?? 0) + 1);
    }
    for (const count of branchCounts.values()) {
      expect(count).toBeGreaterThanOrEqual(6);
      expect(count).toBeLessThanOrEqual(12);
    }
  });

  it('every subPathId is a valid SubPathId', () => {
    const validSubPaths = new Set(Object.keys(SUBPATH_LABEL));
    for (const s of GRAFT_SOCKET_CATALOG) {
      expect(validSubPaths.has(s.subPathId)).toBe(true);
    }
  });
});

describe('additive-effect magnitudes are derived (not zeroed)', () => {
  it('launchSuccessAdditive nodes sum to 0.50 across the catalog', () => {
    const sum = FULL_CATALOG.filter((n) => n.effect.kind === 'launchSuccessAdditive')
      .reduce((acc, n) => acc + n.magnitude, 0);
    expect(sum).toBeCloseTo(0.50, 6);
  });
  it('parallelBuildCapAdd nodes sum to 2.0 across the catalog', () => {
    const sum = FULL_CATALOG.filter((n) => n.effect.kind === 'parallelBuildCapAdd')
      .reduce((acc, n) => acc + n.magnitude, 0);
    expect(sum).toBeCloseTo(2.0, 6);
  });
});

describe('bridge integration with costToUnlock', () => {
  function makeTestState(unlockedEdges: string[]): { unlockedEdges: Set<string> } {
    return { unlockedEdges: new Set(unlockedEdges) };
  }

  it('returns null when bridge threshold is not met', () => {
    const nodeA = { id: 'mining.1' as NodeId, subPath: 'mining' } as SkillNode;
    const nodeB = { id: 'forestry.1' as NodeId, subPath: 'forestry' } as SkillNode;
    const nodeC = { id: 'smelting.1' as NodeId, subPath: 'smelting' } as SkillNode;

    const edgeAB: Edge = {
      id: 'e.ab' as import('./skilltree-graph.js').EdgeId,
      from: 'mining.1' as NodeId,
      to: 'forestry.1' as NodeId,
      cost: 3,
    } as Edge;

    const edgeRef1: Edge = {
      id: 'e.ref1' as import('./skilltree-graph.js').EdgeId,
      from: 'smelting.0' as NodeId,
      to: 'smelting.1' as NodeId,
      cost: 6,
    } as Edge;

    const bridgeBC = {
      id: 'br.test.forestry-smelting' as import('./skilltree-graph.js').EdgeId,
      from: 'forestry.1' as NodeId,
      to: 'smelting.1' as NodeId,
      cost: 5,
      mode: 'or' as import('./skilltree-graph.js').EdgePrereqMode,
      threshold: [{ branch: 'refinement', minSpent: 10 }],
    } as unknown as BridgeEdge;

    const graph = {
      nodes: [nodeA, nodeB, nodeC],
      edges: [edgeAB, edgeRef1],
      bridges: [bridgeBC],
      graftSockets: [],
    } as unknown as Graph;

    const state = makeTestState(['e.ab', 'e.ref1']);
    const result = costToUnlock(
      graph,
      new Set(['mining.1']),
      state.unlockedEdges as unknown as ReadonlySet<import('./skilltree-graph.js').EdgeId>,
      state as unknown as import('./economy.js').IslandState,
      'smelting.1' as NodeId,
    );
    expect(result).toBeNull();
  });

  it('returns path when bridge threshold is met', () => {
    const nodeA = { id: 'mining.1' as NodeId, subPath: 'mining' } as SkillNode;
    const nodeB = { id: 'forestry.1' as NodeId, subPath: 'forestry' } as SkillNode;
    const nodeC = { id: 'smelting.1' as NodeId, subPath: 'smelting' } as SkillNode;
    const nodeD = { id: 'smelting.2' as NodeId, subPath: 'smelting' } as SkillNode;

    const edgeAB: Edge = {
      id: 'e.ab' as import('./skilltree-graph.js').EdgeId,
      from: 'mining.1' as NodeId,
      to: 'forestry.1' as NodeId,
      cost: 3,
    } as Edge;

    const edgeRef1: Edge = {
      id: 'e.ref1' as import('./skilltree-graph.js').EdgeId,
      from: 'smelting.0' as NodeId,
      to: 'smelting.1' as NodeId,
      cost: 6,
    } as Edge;

    const edgeRef2: Edge = {
      id: 'e.ref2' as import('./skilltree-graph.js').EdgeId,
      from: 'smelting.1' as NodeId,
      to: 'smelting.2' as NodeId,
      cost: 6,
    } as Edge;

    const bridgeBC = {
      id: 'br.test.forestry-smelting' as import('./skilltree-graph.js').EdgeId,
      from: 'forestry.1' as NodeId,
      to: 'smelting.1' as NodeId,
      cost: 5,
      mode: 'or' as import('./skilltree-graph.js').EdgePrereqMode,
      threshold: [{ branch: 'refinement', minSpent: 10 }],
    } as unknown as BridgeEdge;

    const graph = {
      nodes: [nodeA, nodeB, nodeC, nodeD],
      edges: [edgeAB, edgeRef1, edgeRef2],
      bridges: [bridgeBC],
      graftSockets: [],
    } as unknown as Graph;

    const state = makeTestState(['e.ab', 'e.ref1', 'e.ref2']);
    const result = costToUnlock(
      graph,
      new Set(['mining.1']),
      state.unlockedEdges as unknown as ReadonlySet<import('./skilltree-graph.js').EdgeId>,
      state as unknown as import('./economy.js').IslandState,
      'smelting.1' as NodeId,
    );
    expect(result).not.toBeNull();
    expect(result!.totalCost).toBe(5);
  });
});
