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
  it('non-multiplier effect kinds get magnitude 0', () => {
    const raws = [node('x', { kind: 'placeholder' })];
    const derived = deriveMagnitudes(raws, []);
    expect(derived[0]!.magnitude).toBe(0);
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
