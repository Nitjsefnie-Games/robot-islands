// Pure graph types for the per-island skill graph. No PixiJS, no DOM.
// Engine: `costToUnlock` finds the cheapest unowned-edge path from the player's
// frontier to a target node, `buyNode` applies it; AND-prereq keystones instead
// gate on full upstream ownership.

import type { BranchId, SubPathId, SkillNode, SkillEffect } from './skilltree.js';

export type NodeId = string & { readonly __nodeBrand: unique symbol };
export type EdgeId = string & { readonly __edgeBrand: unique symbol };

export type EdgePrereqMode = 'single' | 'or' | 'and';

/** Standard graph edge with an SP cost. Used for filler chains and notables. */
export interface Edge {
  readonly id: EdgeId;
  readonly from: NodeId;
  readonly to: NodeId;
  readonly cost: number;          // SP charged when this edge is part of the cheapest path
  readonly mode?: EdgePrereqMode; // default 'single'. 'or' = alt-entry; 'and' = participate in a keystone's AND-prereq
}

/** Threshold-gated edge (Borderlands pattern). Activates when at least one
 *  threshold is met. Belongs to its own catalog so the solver can skip them
 *  with O(1) gate checks instead of scanning every edge. */
export interface BridgeEdge extends Edge {
  readonly threshold: ReadonlyArray<{ readonly branch: BranchId; readonly minSpent: number }>;
}

/** Reserved attachment position for future content. No node attached at v1. */
export interface GraftSocket {
  readonly id: string;
  readonly branchId: BranchId;
  readonly subPathId: SubPathId;
  readonly attachmentDepth: number;
}

export interface Graph {
  readonly nodes: ReadonlyArray<SkillNode>;
  readonly edges: ReadonlyArray<Edge>;
  readonly bridges: ReadonlyArray<BridgeEdge>;
  readonly graftSockets: ReadonlyArray<GraftSocket>;
}

/** AND-prereq spec for keystone nodes. The node is purchasable only when
 *  ALL prereq NodeIds are already in `state.unlockedNodes`. */
export interface KeystonePrereq {
  readonly targetNode: NodeId;
  readonly requires: ReadonlyArray<NodeId>;
  readonly cost: number;
}

export type CrystalId = string & { readonly __crystalBrand: unique symbol };

export interface CrystalDef {
  readonly id: CrystalId;
  readonly displayName: string;
  readonly tier: 1 | 2 | 3;
  readonly eligibleSubPaths: ReadonlyArray<SubPathId>;
  readonly nodes: ReadonlyArray<{
    readonly idSuffix: string;
    readonly cost: number;
    readonly magnitude: number;
    readonly effect: SkillEffect;
    readonly description: string;
    readonly position: { dx: number; dy: number };
  }>;
  readonly edges: ReadonlyArray<{
    readonly fromSuffix: string;
    readonly toSuffix: string;
    readonly cost: number;
  }>;
}
