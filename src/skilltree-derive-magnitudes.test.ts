import { describe, it, expect } from 'vitest';
import {
  inferTier,
  deriveMagnitudes,
  effectKey,
  POOL_TARGETS,
  FILLER_GROWTH,
  type RawSkillNode,
} from './skilltree-derive-magnitudes.js';

const ARCHETYPE_PREFIXES = ['mining.recipeRate', 'forestry.yieldBonus'];

function node(id: string, effect: any, opts: Partial<RawSkillNode> = {}): RawSkillNode {
  return { id: id as any, subPath: 'mining' as any, depth: 1, cost: 1, effect, description: '', ...opts };
}

describe('inferTier', () => {
  it('keystone via .keystone. substring', () => {
    expect(inferTier(node('mining.keystone.veinmaster', { kind: 'mineYieldBonusMul' }), ARCHETYPE_PREFIXES)).toBe('keystone');
  });
  it('filler via archetype prefix match', () => {
    expect(inferTier(node('mining.recipeRate.3', { kind: 'recipeRateMul', category: 'extraction' }), ARCHETYPE_PREFIXES)).toBe('filler');
  });
  it('notable fallthrough', () => {
    expect(inferTier(node('deepVeinSurveying', { kind: 'mineYieldBonusMul' }), ARCHETYPE_PREFIXES)).toBe('notable');
  });
  it('explicit tier override wins', () => {
    expect(inferTier(node('mining.keystone.x', { kind: 'mineYieldBonusMul' }, { tier: 'notable' }), ARCHETYPE_PREFIXES)).toBe('notable');
  });
});

describe('deriveMagnitudes — product invariant', () => {
  it('cap holds for routeCapacityMul under (3K, 11N, 8F) shape', () => {
    const raws: RawSkillNode[] = [];
    for (let i = 0; i < 3; i++) raws.push(node(`transport.keystone.k${i}`, { kind: 'routeCapacityMul' }));
    for (let i = 0; i < 11; i++) raws.push(node(`notable${i}`, { kind: 'routeCapacityMul' }));
    for (let i = 1; i <= 8; i++) raws.push(node(`mining.recipeRate.${i}`, { kind: 'routeCapacityMul' }));
    const derived = deriveMagnitudes(raws, ['mining.recipeRate']);
    const product = derived.reduce((acc, n) => acc * (1 + n.magnitude), 1);
    expect(product).toBeCloseTo(POOL_TARGETS['routeCapacityMul']!, 3);
  });
  it('redistributes weight when keystone tier is empty', () => {
    const raws: RawSkillNode[] = [node('notable1', { kind: 'batteryCapacityMul' })];
    for (let i = 1; i <= 8; i++) raws.push(node(`mining.recipeRate.${i}`, { kind: 'batteryCapacityMul' }));
    const derived = deriveMagnitudes(raws, ['mining.recipeRate']);
    const product = derived.reduce((acc, n) => acc * (1 + n.magnitude), 1);
    expect(product).toBeCloseTo(10, 3);
    const notable = derived.find(n => n.id === 'notable1')!;
    // lone notable absorbs 60% of log-budget (0.30 + 0.30/2 = 0.60) → ×10^0.6 = ×3.98
    expect(notable.magnitude).toBeCloseTo(3.981 - 1, 2);
  });
  it('filler chain depth-1 < depth-last under growth=1.10', () => {
    const raws: RawSkillNode[] = [];
    for (let i = 1; i <= 8; i++) raws.push(node(`mining.recipeRate.${i}`, { kind: 'drillYieldBonusMul' }));
    const derived = deriveMagnitudes(raws, ['mining.recipeRate']);
    const sorted = [...derived].sort((a, b) => a.magnitude - b.magnitude);
    expect(sorted[7]!.magnitude / sorted[0]!.magnitude).toBeCloseTo(Math.pow(FILLER_GROWTH, 7), 3);
  });
  it('multi-chain product invariant: two archetype prefixes same effect kind', () => {
    const raws: RawSkillNode[] = [];
    for (let i = 1; i <= 4; i++) {
      raws.push(node(`mining.recipeRate.${i}`, { kind: 'recipeRateMul', category: 'extraction' }));
    }
    for (let i = 1; i <= 3; i++) {
      raws.push(node(`forestry.recipeRate.${i}`, { kind: 'recipeRateMul', category: 'extraction' }));
    }
    const derived = deriveMagnitudes(raws, ['mining.recipeRate', 'forestry.recipeRate']);
    const product = derived.reduce((acc, n) => acc * (1 + n.magnitude), 1);
    expect(product).toBeCloseTo(POOL_TARGETS['recipeRateMul:extraction']!, 3);
  });
  it('non-multiplier effect kinds get magnitude 0', () => {
    const raws = [node('x', { kind: 'placeholder' })];
    const derived = deriveMagnitudes(raws, []);
    expect(derived[0]!.magnitude).toBe(0);
  });
  it('startDepth-offset filler chain: product hits target (solver consumes absolute-depth exponents)', () => {
    // Decoupled from FULL_CATALOG: a synthetic startDepth>1 chain. Ids .3 .4 .5 .6
    // → fillerDepth 3..6 → emission exponents 2..5 (NOT 0..3). The solver must
    // consume those same absolute-depth exponents or the product overshoots
    // (the bug was 1.63 vs 1.5). Tight precision so a position-based regression
    // bites immediately.
    const raws: RawSkillNode[] = [];
    for (let d = 3; d <= 6; d++) {
      raws.push(node(`smelting.inputEff.${d}`, { kind: 'recipeInputMul', reduce: true }, { depth: d }));
    }
    const derived = deriveMagnitudes(raws, ['smelting.inputEff']);
    const product = derived.reduce((acc, n) => acc * (1 + n.magnitude), 1);
    expect(product).toBeCloseTo(POOL_TARGETS['recipeInputMul']!, 9);
  });
});

describe('recipeInputMul shared pool (§v2-rebalance magic chain)', () => {
  it('POOL_TARGETS recipeInputMul is 1.5', () => {
    expect(POOL_TARGETS['recipeInputMul']).toBeCloseTo(1.5, 12);
  });

  it('product of (1+magnitude) over ALL recipeInputMul nodes in the real catalog ≈ 1.5 (shared pool, not per-chain)', async () => {
    const { FULL_CATALOG } = await import('./skilltree-catalog.js');
    const recipeInputNodes = FULL_CATALOG.filter((n) => effectKey(n.effect) === 'recipeInputMul');
    // 3 sub-paths × 4 nodes each = 12 magic nodes.
    expect(recipeInputNodes.length).toBe(12);
    const product = recipeInputNodes.reduce((acc, n) => acc * (1 + n.magnitude), 1);
    expect(product).toBeCloseTo(POOL_TARGETS['recipeInputMul']!, 9);
  });
});

describe('effectKey', () => {
  it('composes recipeRateMul + category', () => {
    expect(effectKey({ kind: 'recipeRateMul', category: 'chemistry' } as any)).toBe('recipeRateMul:chemistry');
  });
  it('defaults xpGain category to (global)', () => {
    expect(effectKey({ kind: 'xpGainMul' } as any)).toBe('xpGainMul:(global)');
  });
});
