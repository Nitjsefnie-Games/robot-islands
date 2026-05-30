// src/skilltree-layout.ts
// Pure: computes deterministic positions for every skill-graph node, virtual
// branch-root, and graft socket. No PixiJS, no DOM.
//
// Three-stage:
//   A. Place 5 branch roots on a regular pentagon (radius R).
//   B. Place a sub-anchor per (branch, sub-path) — each sub-path gets its own
//      angular slot in the branch's 72° wedge, at a fixed outward radius.
//   C. Run Fruchterman–Reingold per sub-path (NOT per branch), pulling toward
//      its sub-anchor. Sub-paths can't collapse into each other because each
//      sim sees only intra-sub-path nodes and a sub-path-local anchor.
//
// Determinism is provided by mulberry32 seeded with the catalog node-count.

import type { Graph, NodeId } from './skilltree-graph.js';
import {
  BRANCH_SUBPATHS,
  type BranchId,
  type SubPathId,
} from './skilltree.js';

export interface Point { readonly x: number; readonly y: number; }

export interface SkillGraphLayout {
  readonly nodes: ReadonlyMap<NodeId, Point>;
  readonly branchRoots: ReadonlyMap<BranchId, Point>;
  readonly graftSockets: ReadonlyMap<string, Point>;
}

const R = 600;             // pentagon radius (world-px)
const SUB_ANCHOR_OFFSET = 360; // sub-anchor distance from branch root, outward
const SOCKET_OFFSET = 140; // graft socket distance past the sub-anchor
const K_REPULSION = 6500;
const K_SPRING = 0.12;
const ITERATIONS = 220;
const ANCHOR_K = 0.085;    // strong pull so sub-paths stay tight in their wedge

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

  // Stage A: 5 branch roots on a regular pentagon.
  const branchRoots = new Map<BranchId, Point>();
  const branches = Object.keys(BRANCH_SUBPATHS) as BranchId[];
  for (let i = 0; i < branches.length; i++) {
    const theta = (i / branches.length) * 2 * Math.PI - Math.PI / 2; // top-first
    branchRoots.set(branches[i]!, { x: R * Math.cos(theta), y: R * Math.sin(theta) });
  }

  // Stage B: per-(branch, sub-path) sub-anchors. Each branch owns a 72° wedge;
  // its N sub-paths divide that wedge into N angular slots.
  const subAnchors = new Map<SubPathId, Point>();
  const BRANCH_WEDGE = (2 * Math.PI) / branches.length; // 72°
  for (const branch of branches) {
    const root = branchRoots.get(branch)!;
    const branchAngle = Math.atan2(root.y, root.x);
    const subPaths = BRANCH_SUBPATHS[branch];
    for (let i = 0; i < subPaths.length; i++) {
      // Each sub-path centred in its slot: slot width = wedge/N, slot centre =
      // branchAngle + ((i + 0.5)/N - 0.5) * wedge.
      const offsetFrac = (i + 0.5) / subPaths.length - 0.5;
      const subAngle = branchAngle + offsetFrac * BRANCH_WEDGE;
      const r = R + SUB_ANCHOR_OFFSET;
      subAnchors.set(subPaths[i]!, { x: r * Math.cos(subAngle), y: r * Math.sin(subAngle) });
    }
  }

  // Stage C: per-sub-path FR sim. Each sub-path's nodes are anchored to their
  // own sub-anchor; only intra-sub-path edges feed attraction.
  const nodes = new Map<NodeId, { x: number; y: number }>();

  const nodesBySubPath = new Map<SubPathId, typeof graph.nodes[number][]>();
  for (const n of graph.nodes) {
    const arr = nodesBySubPath.get(n.subPath) ?? [];
    arr.push(n);
    nodesBySubPath.set(n.subPath, arr);
  }

  for (const [subPath, subNodes] of nodesBySubPath) {
    const anchor = subAnchors.get(subPath);
    if (!anchor) continue; // sub-path not assigned to any branch (shouldn't happen)
    if (subNodes.length === 0) continue;

    // Initial scatter around the sub-anchor.
    const pos = new Map<NodeId, { x: number; y: number }>();
    for (const n of subNodes) {
      const a = rng() * Math.PI * 2;
      const r0 = 60 + 40 * rng();
      pos.set(n.id as unknown as NodeId, {
        x: anchor.x + r0 * Math.cos(a),
        y: anchor.y + r0 * Math.sin(a),
      });
    }

    // Intra-sub-path edges only.
    const subIds = new Set(subNodes.map((n) => n.id));
    const intraEdges = graph.edges.filter(
      (e) => subIds.has(e.from as unknown as string) &&
             subIds.has(e.to as unknown as string),
    );

    for (let iter = 0; iter < ITERATIONS; iter++) {
      const disp = new Map<NodeId, { x: number; y: number }>();
      for (const id of pos.keys()) disp.set(id, { x: 0, y: 0 });

      // Pairwise repulsion within the sub-path.
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

      // Edge attraction.
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

      // Sub-anchor pull keeps the cluster inside its wedge.
      for (const [id, p] of pos) {
        disp.get(id)!.x += (anchor.x - p.x) * ANCHOR_K;
        disp.get(id)!.y += (anchor.y - p.y) * ANCHOR_K;
      }

      // Cooling step.
      const temp = 28 * (1 - iter / ITERATIONS);
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

  // Graft sockets: past their sub-anchor, in the same angular slot.
  const graftSockets = new Map<string, Point>();
  for (const s of graph.graftSockets) {
    const anchor = subAnchors.get(s.subPathId);
    if (!anchor) {
      // Fallback to branch root if the sub-path isn't slotted.
      const root = branchRoots.get(s.branchId) ?? { x: 0, y: 0 };
      graftSockets.set(s.id, { x: root.x * 1.4, y: root.y * 1.4 });
      continue;
    }
    // Place outward along the sub-anchor's direction from origin.
    const ar = Math.hypot(anchor.x, anchor.y);
    const ax = anchor.x / ar;
    const ay = anchor.y / ar;
    const r = ar + SOCKET_OFFSET + s.attachmentDepth * 18;
    graftSockets.set(s.id, { x: r * ax, y: r * ay });
  }

  return { nodes, branchRoots, graftSockets };
}
