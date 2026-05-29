// Pure runtime-magnitude derivation for the skill catalog. Replaces the
// hand-authored magnitudes that the 2026-05-25 rebalance shipped. See
// docs/superpowers/specs/2026-05-26-skilltree-computed-magnitudes-design.html.

import type { SkillEffect, SkillNode } from './skilltree.js';

export type NodeTier = 'keystone' | 'notable' | 'filler';

/** SkillNode pre-magnitude-derivation. The catalog authors emit these;
 *  `deriveMagnitudes` returns full SkillNode shapes with magnitudes
 *  filled in. `tier` is optional — inferTier() handles the standard cases. */
export interface RawSkillNode extends Omit<SkillNode, 'magnitude'> {
  readonly tier?: NodeTier;
}

export const TIER_WEIGHTS = { keystone: 0.50, notable: 0.30, filler: 0.20 } as const;
export const FILLER_GROWTH = 1.10 as const;
const BISECTION_ITERATIONS = 80;

/** Per-effect-kind product cap targets. Singleton multiplier kinds cap at
 *  ×10, shared-pool sides at ×√10, xpGain at ×3. Same as the 2026-05-25
 *  rebalance — only the per-node distribution changes in this spec. */
export const POOL_TARGETS: Readonly<Record<string, number>> = {
  'recipeRateMul:extraction': Math.sqrt(10),
  'recipeRateMul:chemistry': 10,
  'recipeRateMul:smelting': 10,
  'recipeRateMul:electronics': 10,
  'recipeRateMul:manufacturing': 10,
  'powerConsumptionMul': Math.sqrt(10),
  // Shared cap for all magic material-input-efficiency nodes across the three
  // refinement sub-paths (smelting/chemistry/electronics inputEff chains).
  // deriveMagnitudes groups by effect-key globally, so Π(1+m) over all
  // recipeInputMul nodes hits this single target. Treated as an ordinary
  // reduction pool (like powerConsumptionMul) — no special-casing.
  'recipeInputMul': 1.5,
  'commRangeMul': 10,
  'scannerCoverageMul': 10,
  'storageCategoryCapMul:dry_goods': Math.sqrt(10),
  'storageCategoryCapMul:liquid_gas': Math.sqrt(10),
  'storageCategoryCapMul:components': Math.sqrt(10),
  'storageCategoryCapMul:rare': Math.sqrt(10),
  'routeCapacityMul': 10,
  'maintenanceThresholdMul': 10,
  'mineYieldBonusMul': Math.sqrt(10),
  'droneScanRadiusMul': 10,
  'satBufferCapMul': 10,
  'powerProductionMul': Math.sqrt(10),
  'droneFuelEfficiencyMul': 10,
  'airshipRangeMul': 10,
  'debrisProtectionMul': 10,
  'batteryCapacityMul': 10,
  'mineRareTrickleMul': 10,
  'constructionTimeMul': 10,
  'loggerYieldBonusMul': Math.sqrt(10),
  'xpGainMul:(global)': 3,
  'scannerDwellRateMul': 10,
  'teleporterEfficiencyMul': 10,
  'repairDroneReliabilityMul': 10,
  'padExplosionReduceMul': 10,
  'satFuelReserveMul': 10,
  'loggerExoticTrickleMul': 10,
  'drillYieldBonusMul': Math.sqrt(10),
  'aquacultureYieldBonusMul': Math.sqrt(10),
  'patronageYieldBonusMul': Math.sqrt(10),
  't5ExtractorYieldBonusMul': Math.sqrt(10),
};

/** Canonical effect-key for grouping. Matches the existing scripts/
 *  skilltree-magnitudes.ts logic exactly so POOL_TARGETS keys line up. */
export function effectKey(e: SkillEffect): string {
  if (e.kind === 'recipeRateMul') return `recipeRateMul:${e.category}`;
  if (e.kind === 'storageCategoryCapMul') return `storageCategoryCapMul:${e.category}`;
  if (e.kind === 'xpGainMul') return `xpGainMul:${e.category ?? '(global)'}`;
  return e.kind;
}

/** Tier-inference rules in priority order. Pure: depends only on id +
 *  the supplied list of known archetype prefixes. */
export function inferTier(
  node: RawSkillNode,
  archetypePrefixes: ReadonlyArray<string>,
): NodeTier {
  if (node.tier !== undefined) return node.tier;
  if (node.id.includes('.keystone.')) return 'keystone';
  for (const p of archetypePrefixes) {
    if (node.id.startsWith(p + '.')) return 'filler';
  }
  return 'notable';
}

/** Solve for filler baseMag such that the product over every filler node
 *  ∏ (1 + b·g^{exponent}) equals `target`, where `exponents` is the exact
 *  multiset of growth exponents the emission step will use — i.e.
 *  `fillerDepth(id) - 1` for each node. Emission keys magnitude off the
 *  node's absolute depth (the trailing id segment), so a chain that starts
 *  at depth>1 (startDepth) yields exponents that do NOT begin at 0; the
 *  solver must consume those same exponents or the product overshoots.
 *  (Per-chain grouping is irrelevant to the product — b is shared, so the
 *  product is a flat ∏ over the exponent multiset.)
 *  Bisection: monotonic, converges in ~80 iters to 1e-24. */
function solveFillerBaseMag(target: number, exponents: number[], growth: number): number {
  if (exponents.length === 0 || target <= 1) return 0;
  let lo = 0, hi = 1;
  for (let i = 0; i < BISECTION_ITERATIONS; i++) {
    const mid = (lo + hi) / 2;
    let p = 1;
    for (const e of exponents) {
      p *= 1 + mid * Math.pow(growth, e);
    }
    if (p < target) lo = mid; else hi = mid;
  }
  return lo;
}

/** Extract the trailing numeric segment of a filler node's id (e.g.
 *  'mining.recipeRate.3' → 3). Returns null for non-conforming ids. */
function fillerDepth(id: string): number | null {
  const idx = id.lastIndexOf('.');
  if (idx < 0) return null;
  const n = Number(id.slice(idx + 1));
  return Number.isInteger(n) && n > 0 ? n : null;
}

/** Pure: takes raw nodes and returns the same nodes with derived
 *  magnitudes. Idempotent. The product across all nodes of a given
 *  effect kind equals its POOL_TARGETS value exactly. */
export function deriveMagnitudes(
  rawNodes: ReadonlyArray<RawSkillNode>,
  archetypePrefixes: ReadonlyArray<string>,
): ReadonlyArray<SkillNode> {
  // Group by effect-key, count tiers, remember each node's bucket.
  interface Bucket { K: number; N: number; F: number; }
  const buckets = new Map<string, Bucket>();
  const tiers = new Map<string, NodeTier>();  // node.id → tier
  const keys = new Map<string, string>();    // node.id → effect-key
  // effect-key → list of growth exponents the emission step will use, one per
  // filler node (= fillerDepth(id) - 1). Captures startDepth offsets so the
  // solver and emission agree on the product.
  const fillerExponents = new Map<string, number[]>();
  for (const n of rawNodes) {
    const k = effectKey(n.effect);
    if (!(k in POOL_TARGETS)) continue;  // non-multiplier kinds — magnitude irrelevant
    const t = inferTier(n, archetypePrefixes);
    tiers.set(n.id, t);
    keys.set(n.id, k);
    if (!buckets.has(k)) buckets.set(k, { K: 0, N: 0, F: 0 });
    const b = buckets.get(k)!;
    if (t === 'keystone') b.K++;
    else if (t === 'notable') b.N++;
    else {
      b.F++;
      if (!fillerExponents.has(k)) fillerExponents.set(k, []);
      fillerExponents.get(k)!.push((fillerDepth(n.id) ?? 1) - 1);
    }
  }

  // Per-effect-kind tier magnitudes (computed once).
  const mK = new Map<string, number>();
  const mN = new Map<string, number>();
  const fillerBase = new Map<string, number>();
  for (const [k, b] of buckets) {
    const C = POOL_TARGETS[k]!;
    let wK = b.K > 0 ? TIER_WEIGHTS.keystone : 0;
    let wN = b.N > 0 ? TIER_WEIGHTS.notable : 0;
    let wF = b.F > 0 ? TIER_WEIGHTS.filler : 0;
    const sum = wK + wN + wF;
    if (sum === 0) continue;
    wK /= sum; wN /= sum; wF /= sum;
    if (b.K > 0) mK.set(k, Math.pow(C, wK / b.K) - 1);
    if (b.N > 0) mN.set(k, Math.pow(C, wN / b.N) - 1);
    if (b.F > 0) {
      const exponents = fillerExponents.get(k)!;
      fillerBase.set(k, solveFillerBaseMag(Math.pow(C, wF), exponents, FILLER_GROWTH));
    }
  }

  // Emit each node with derived magnitude.
  return rawNodes.map((n): SkillNode => {
    const k = keys.get(n.id);
    if (k === undefined) {
      const { tier: _tier, ...rest } = n;
      return { ...rest, magnitude: 0 };
    }
    const t = tiers.get(n.id)!;
    let m = 0;
    if (t === 'keystone') m = mK.get(k) ?? 0;
    else if (t === 'notable') m = mN.get(k) ?? 0;
    else {
      const b = fillerBase.get(k) ?? 0;
      const d = fillerDepth(n.id) ?? 1;
      m = b * Math.pow(FILLER_GROWTH, d - 1);
    }
    const { tier: _tier, ...rest } = n;
    return { ...rest, magnitude: m };
  });
}
