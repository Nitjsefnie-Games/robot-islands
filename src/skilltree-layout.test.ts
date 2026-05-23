import { describe, it, expect } from 'vitest';
import { computeSkillGraphLayout } from './skilltree-layout.js';
import { DEFAULT_GRAPH } from './skilltree.js';
import { BRANCH_SUBPATHS } from './skilltree.js';
import type { BranchId } from './skilltree.js';

describe('computeSkillGraphLayout', () => {
  it('is deterministic across repeated calls on the same graph', () => {
    const a = computeSkillGraphLayout(DEFAULT_GRAPH);
    const b = computeSkillGraphLayout(DEFAULT_GRAPH);
    expect(a.nodes.size).toBe(b.nodes.size);
    for (const [id, pa] of a.nodes) {
      const pb = b.nodes.get(id);
      expect(pb).toBeDefined();
      expect(pb!.x).toBeCloseTo(pa.x, 6);
      expect(pb!.y).toBeCloseTo(pa.y, 6);
    }
  });

  it('places 5 branch roots at the pentagon radius', () => {
    const layout = computeSkillGraphLayout(DEFAULT_GRAPH);
    const branches = Object.keys(BRANCH_SUBPATHS) as BranchId[];
    expect(branches).toHaveLength(5);
    expect(layout.branchRoots.size).toBe(5);
    for (const b of branches) {
      const p = layout.branchRoots.get(b);
      expect(p).toBeDefined();
      const r = Math.hypot(p!.x, p!.y);
      expect(r).toBeCloseTo(600, 0); // pentagon radius R = 600
    }
  });

  it('assigns coordinates to every node in DEFAULT_GRAPH', () => {
    const layout = computeSkillGraphLayout(DEFAULT_GRAPH);
    for (const n of DEFAULT_GRAPH.nodes) {
      const p = layout.nodes.get(n.id as unknown as Parameters<typeof layout.nodes.get>[0]);
      expect(p).toBeDefined();
      expect(Number.isFinite(p!.x)).toBe(true);
      expect(Number.isFinite(p!.y)).toBe(true);
    }
  });

  it('assigns coordinates to every graft socket', () => {
    const layout = computeSkillGraphLayout(DEFAULT_GRAPH);
    expect(layout.graftSockets.size).toBe(DEFAULT_GRAPH.graftSockets.length);
    for (const s of DEFAULT_GRAPH.graftSockets) {
      expect(layout.graftSockets.has(s.id)).toBe(true);
    }
  });
});
