// src/skilltree-layout.ts
// Pure: computes deterministic positions for every skill-graph node, virtual
// branch-root, and graft socket. No PixiJS, no DOM.
//
// Two-stage:
//   A. Place 5 branch roots on a regular pentagon (radius R).
//   B. For each branch, run Fruchterman–Reingold on the sub-graph of nodes
//      whose subPath belongs to that branch, anchored to the branch root.
//
// Determinism is provided by mulberry32 seeded with the catalog node-count.

import type { Graph, NodeId } from './skilltree-graph.js';
import {
  BRANCH_SUBPATHS,
  SUBPATH_BRANCH,
  type BranchId,
} from './skilltree.js';

export interface Point { readonly x: number; readonly y: number; }

export interface SkillGraphLayout {
  readonly nodes: ReadonlyMap<NodeId, Point>;
  readonly branchRoots: ReadonlyMap<BranchId, Point>;
  readonly graftSockets: ReadonlyMap<string, Point>;
}

const R = 600;       // pentagon radius (world-px)
const K_REPULSION = 8000;
const K_SPRING = 0.1;
const ITERATIONS = 200;
const SUB_RADIUS = 280; // initial scatter radius around each branch root
const SOCKET_OFFSET = 140; // distance beyond the deepest node on its sub-path arc

function mulberry32(seed: number): () => number {
  let t = seed >>> 0;
  return () => {
    t = (t + 0x6D2B79F5) >>> 0;
    let r = Math.imul(t ^ (t >>> 15), 1 | t);
    r = (r + Math.imul(r ^ (r >>> 7), 61 | r)) ^ r;
    return ((r ^ (r >>> 14)) >>> 0) / 4294967296;
  };
}

export function computeSkillGraphLayout(graph: Graph): SkillGraphLayout {
  const rng = mulberry32(graph.nodes.length);

  // Stage A: place 5 branch roots on a regular pentagon.
  const branchRoots = new Map<BranchId, Point>();
  const branches = Object.keys(BRANCH_SUBPATHS) as BranchId[];
  for (let i = 0; i < branches.length; i++) {
    const theta = (i / branches.length) * 2 * Math.PI - Math.PI / 2; // top-first
    branchRoots.set(branches[i]!, { x: R * Math.cos(theta), y: R * Math.sin(theta) });
  }

  // Stage B: per-branch FR sim on the sub-graph.
  const nodes = new Map<NodeId, { x: number; y: number }>();

  for (const branch of branches) {
    const root = branchRoots.get(branch)!;
    const branchNodeList = graph.nodes.filter(
      (n) => SUBPATH_BRANCH[n.subPath] === branch,
    );
    if (branchNodeList.length === 0) continue;

    // Initial scatter: place each node at root + small random offset, biased
    // outward by sub-path index so sub-paths fan out as separate arcs.
    const subPaths = BRANCH_SUBPATHS[branch];
    const pos = new Map<NodeId, { x: number; y: number }>();
    for (const n of branchNodeList) {
      const spIdx = subPaths.indexOf(n.subPath);
      const arcSpread = (Math.PI * 2) / 6; // each sub-path gets ~60° arc
      const spTheta = (spIdx - (subPaths.length - 1) / 2) * arcSpread / Math.max(1, subPaths.length - 1);
      const baseAngle = Math.atan2(root.y, root.x) + spTheta;
      const r0 = SUB_RADIUS * (0.4 + 0.6 * rng());
      pos.set(n.id as unknown as NodeId, {
        x: root.x + r0 * Math.cos(baseAngle) + (rng() - 0.5) * 40,
        y: root.y + r0 * Math.sin(baseAngle) + (rng() - 0.5) * 40,
      });
    }

    // Build adjacency for the branch's sub-graph (only intra-branch edges).
    const branchNodeIds = new Set(branchNodeList.map((n) => n.id));
    const intraEdges = graph.edges.filter(
      (e) => branchNodeIds.has(e.from as unknown as string) &&
             branchNodeIds.has(e.to as unknown as string),
    );

    // Fruchterman–Reingold
    for (let iter = 0; iter < ITERATIONS; iter++) {
      const disp = new Map<NodeId, { x: number; y: number }>();
      for (const id of pos.keys()) disp.set(id, { x: 0, y: 0 });

      // Repulsion (pairwise).
      const arr = [...pos.entries()];
      for (let i = 0; i < arr.length; i++) {
        const [idA, pa] = arr[i]!;
        for (let j = i + 1; j < arr.length; j++) {
          const [idB, pb] = arr[j]!;
          const dx = pa.x - pb.x;
          const dy = pa.y - pb.y;
          const d2 = Math.max(0.01, dx * dx + dy * dy);
          const f = K_REPULSION / d2;
          const d = Math.sqrt(d2);
          const fx = (dx / d) * f;
          const fy = (dy / d) * f;
          disp.get(idA)!.x += fx; disp.get(idA)!.y += fy;
          disp.get(idB)!.x -= fx; disp.get(idB)!.y -= fy;
        }
      }

      // Attraction along edges.
      for (const e of intraEdges) {
        const pa = pos.get(e.from);
        const pb = pos.get(e.to);
        if (!pa || !pb) continue;
        const dx = pa.x - pb.x;
        const dy = pa.y - pb.y;
        const d = Math.max(0.01, Math.hypot(dx, dy));
        const f = K_SPRING * d;
        const fx = (dx / d) * f;
        const fy = (dy / d) * f;
        disp.get(e.from)!.x -= fx;
        disp.get(e.from)!.y -= fy;
        disp.get(e.to)!.x += fx;
        disp.get(e.to)!.y += fy;
      }

      // Anchor pull toward the branch root (so the cluster doesn't drift).
      const anchorK = 0.02;
      for (const [id, p] of pos) {
        disp.get(id)!.x += (root.x - p.x) * anchorK;
        disp.get(id)!.y += (root.y - p.y) * anchorK;
      }

      // Cooling step: cap displacement and apply.
      const temp = 30 * (1 - iter / ITERATIONS);
      for (const [id, p] of pos) {
        const d = disp.get(id)!;
        const mag = Math.max(0.01, Math.hypot(d.x, d.y));
        const capped = Math.min(temp, mag);
        p.x += (d.x / mag) * capped;
        p.y += (d.y / mag) * capped;
      }
    }

    for (const [id, p] of pos) nodes.set(id, p);
  }

  // Graft sockets: place at branch-root + outward radius along sub-path arc,
  // past the deepest node in that sub-path.
  const graftSockets = new Map<string, Point>();
  for (const s of graph.graftSockets) {
    const root = branchRoots.get(s.branchId) ?? { x: 0, y: 0 };
    const subPaths = BRANCH_SUBPATHS[s.branchId] ?? [];
    const spIdx = subPaths.indexOf(s.subPathId);
    const arcSpread = (Math.PI * 2) / 6;
    const spTheta = subPaths.length > 1
      ? (spIdx - (subPaths.length - 1) / 2) * arcSpread / (subPaths.length - 1)
      : 0;
    const baseAngle = Math.atan2(root.y, root.x) + spTheta;
    const r0 = SUB_RADIUS + SOCKET_OFFSET + s.attachmentDepth * 20;
    graftSockets.set(s.id, {
      x: root.x + r0 * Math.cos(baseAngle),
      y: root.y + r0 * Math.sin(baseAngle),
    });
  }

  return { nodes, branchRoots, graftSockets };
}
