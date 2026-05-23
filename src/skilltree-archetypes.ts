// Filler archetype generator for skill-tree sub-path content.
//
// Each sub-path is a depth-graded chain of nodes. Rather than hand-writing
// ~25 nodes per sub-path, an archetype template captures the ramp pattern
// (base magnitude, growth factor, cost curve) and `generateFillerNodes`
// produces the `SkillNode[]` array.

import type { SkillEffect, SkillNode, NodeId, SubPathId } from './skilltree.js';

export interface FillerArchetype {
  readonly idPrefix: string;
  readonly effectKind: SkillEffect['kind'];
  readonly effectExtra?: Record<string, unknown>;
  readonly subPath: SubPathId;
  readonly baseMag: number;
  readonly growth: number;
  readonly baseCost: number;
  readonly costGrowth: number;
  readonly count: number;
}

/** Generate a depth-ramped filler chain from an archetype.
 *
 *  Per-node factor follows multiplicative growth:
 *    depth-d factor = (1 + baseMag) * growth^(d-1)
 *  Magnitude is stored as the +bonus (factor - 1), matching the `SkillNode`
 *  convention (0.05 means +5%).
 *
 *  Cost follows geometric growth with rounding per depth. */
export function generateFillerNodes(arch: FillerArchetype): SkillNode[] {
  const nodes: SkillNode[] = [];
  let factor = 1 + arch.baseMag;
  let cost = arch.baseCost;
  for (let d = 0; d < arch.count; d++) {
    const magnitude = factor - 1;
    nodes.push({
      id: `${arch.idPrefix}.${d + 1}` as NodeId,
      subPath: arch.subPath,
      depth: d + 1,
      cost: Math.round(cost),
      magnitude,
      effect: { kind: arch.effectKind, ...(arch.effectExtra ?? {}) } as SkillEffect,
      description: `${arch.subPath} ${arch.effectKind} depth ${d + 1}`,
    });
    factor *= arch.growth;
    cost *= arch.costGrowth;
  }
  return nodes;
}

// ---------------------------------------------------------------------------
// Mining sub-path — first concrete filler content (Task 14)
// ---------------------------------------------------------------------------

export const MINING_FILLER_ARCHETYPES: FillerArchetype[] = [
  {
    idPrefix: 'mining.recipeRate',
    effectKind: 'recipeRateMul',
    effectExtra: { category: 'extraction' },
    subPath: 'mining',
    baseMag: 0.04,
    growth: 1.10,
    baseCost: 1,
    costGrowth: 1.4,
    count: 7,
  },
  {
    idPrefix: 'mining.storageCap',
    effectKind: 'storageCategoryCapMul',
    effectExtra: { category: 'dry_goods' },
    subPath: 'mining',
    baseMag: 0.05,
    growth: 1.08,
    baseCost: 1,
    costGrowth: 1.5,
    count: 6,
  },
  {
    idPrefix: 'mining.yieldBonus',
    effectKind: 'mineYieldBonusMul',
    subPath: 'mining',
    baseMag: 0.05,
    growth: 1.10,
    baseCost: 2,
    costGrowth: 1.6,
    count: 5,
  },
  {
    idPrefix: 'mining.rareTrickle',
    effectKind: 'mineRareTrickleMul',
    subPath: 'mining',
    baseMag: 0.10,
    growth: 1.10,
    baseCost: 3,
    costGrowth: 1.7,
    count: 4,
  },
];

export const MINING_FILLER_NODES = MINING_FILLER_ARCHETYPES.flatMap(generateFillerNodes);
