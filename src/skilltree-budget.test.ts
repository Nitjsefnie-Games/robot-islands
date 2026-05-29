/**
 * Spec §10 acceptance guard — skill-tree v2 node-budget constraints.
 *
 * Invariants locked in by the de-noding pass (Task 4 of v2 rebalance):
 *   • Every sub-path has ≤ 2 distinct filler lever-families.
 *   • Every sub-path has ≤ 23 total nodes (filler + notables + keystones).
 *
 * Anti-vacuity:
 *   • The sum of filler nodes selected by the `/\.\d+$/` regex across ALL
 *     sub-paths equals `ALL_FILLER_NODES.length` (246) — proving the filter
 *     neither over- nor under-selects.
 *   • The `mining` sub-path resolves to EXACTLY 2 families and > 10 fillers —
 *     proving the family-grouping logic is live on a known-non-trivial case.
 */

import { beforeAll, describe, expect, it } from 'vitest';
import { FULL_CATALOG } from './skilltree-catalog.js';
import { BRANCH_SUBPATHS, type SubPathId, type SkillEffect } from './skilltree.js';
import { ALL_FILLER_NODES } from './skilltree-archetypes.js';

// ---------------------------------------------------------------------------
// Helper: lever-family collapse
// ---------------------------------------------------------------------------

/**
 * Collapses the effect of a filler node into a "lever family" string per
 * the v2-rebalance budget spec:
 *
 *  - `storageCategoryCapMul` (any category) → `"storageCategoryCapMul"`
 *    (4 per-category chains count as ONE capacity family, spec §3).
 *  - `recipeRateMul` → `"recipeRateMul:<category>"`
 *    (extraction vs manufacturing vs smelting vs chemistry ARE distinct families).
 *  - everything else → `effect.kind` (the bare string).
 */
function leverFamily(effect: SkillEffect): string {
  if (effect.kind === 'storageCategoryCapMul') return 'storageCategoryCapMul';
  if (effect.kind === 'recipeRateMul') return `recipeRateMul:${effect.category}`;
  return effect.kind;
}

// ---------------------------------------------------------------------------
// Enumerate all sub-paths from BRANCH_SUBPATHS
// ---------------------------------------------------------------------------

const ALL_SUBPATHS: SubPathId[] = Object.values(BRANCH_SUBPATHS).flat();

// ---------------------------------------------------------------------------
// Pre-compute per-sub-path stats for logging and assertions
// ---------------------------------------------------------------------------

interface SubPathStats {
  subPath: SubPathId;
  totalNodes: number;
  fillerNodes: number;
  fillerFamilies: number;
  familyNames: string[];
}

const SUBPATH_STATS: SubPathStats[] = ALL_SUBPATHS.map((sp) => {
  const allForSP = FULL_CATALOG.filter((n) => n.subPath === sp);
  const fillerForSP = allForSP.filter((n) => /\.\d+$/.test(n.id));
  const familySet = new Set(fillerForSP.map((n) => leverFamily(n.effect)));
  return {
    subPath: sp,
    totalNodes: allForSP.length,
    fillerNodes: fillerForSP.length,
    fillerFamilies: familySet.size,
    familyNames: [...familySet].sort(),
  };
});

// ---------------------------------------------------------------------------
// Main test suite
// ---------------------------------------------------------------------------

describe('skilltree v2 node-budget guard (§10)', () => {
  beforeAll(() => {
    // Surface all 20 sub-path stats in the vitest run so they can be eyeballed.
    console.log('\n[budget-guard] per-sub-path stats:');
    console.table(
      SUBPATH_STATS.map(({ subPath, totalNodes, fillerNodes, fillerFamilies, familyNames }) => ({
        subPath,
        totalNodes,
        fillerNodes,
        fillerFamilies,
        families: familyNames.join(', '),
      })),
    );
  });

  // -------------------------------------------------------------------------
  // Anti-vacuity guard 1: filler filter selects the full catalog filler set
  // -------------------------------------------------------------------------

  it('filler regex selects exactly ALL_FILLER_NODES.length nodes across all sub-paths', () => {
    const totalFillerSelected = SUBPATH_STATS.reduce((s, st) => s + st.fillerNodes, 0);
    expect(totalFillerSelected).toBe(ALL_FILLER_NODES.length); // 246
  });

  // -------------------------------------------------------------------------
  // Anti-vacuity guard 2: a known 2-family sub-path (mining) resolves correctly
  // -------------------------------------------------------------------------

  it('mining resolves to exactly 2 filler families with > 10 filler nodes', () => {
    const miningStats = SUBPATH_STATS.find((s) => s.subPath === 'mining');
    expect(miningStats).toBeDefined();
    expect(miningStats!.fillerFamilies).toBe(2);
    expect(miningStats!.fillerNodes).toBeGreaterThan(10);
  });

  // -------------------------------------------------------------------------
  // Per-sub-path budget assertions
  // -------------------------------------------------------------------------

  for (const stats of SUBPATH_STATS) {
    const { subPath, totalNodes, fillerFamilies } = stats;

    it(`${subPath}: ≤ 2 filler lever-families (got ${fillerFamilies})`, () => {
      expect(
        fillerFamilies,
        `${subPath} has ${fillerFamilies} filler lever-families: ${stats.familyNames.join(', ')}`,
      ).toBeLessThanOrEqual(2);
    });

    it(`${subPath}: ≤ 23 total nodes (got ${totalNodes})`, () => {
      expect(
        totalNodes,
        `${subPath} has ${totalNodes} total nodes (filler + notables + keystones)`,
      ).toBeLessThanOrEqual(23);
    });
  }
});
