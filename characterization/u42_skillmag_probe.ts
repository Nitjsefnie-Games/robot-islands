// U42 characterization dumper — filler archetypes & magnitude derivation.
// Throwaway probe; runs the ORIGINAL and emits goldens JSON to stdout.
import {
  ALL_FILLER_NODES,
  ALL_ARCHETYPE_PREFIXES,
} from '../src/skilltree-archetypes.js';
import {
  deriveMagnitudes,
  effectKey,
  inferTier,
  POOL_TARGETS,
  ADDITIVE_POOL_TARGETS,
  TIER_WEIGHTS,
  FILLER_GROWTH,
  type RawSkillNode,
} from '../src/skilltree-derive-magnitudes.js';
import type { SkillEffect } from '../src/skilltree.js';

// ---------------------------------------------------------------------------
// SECTION A (EXACT): generation outputs — the raw filler nodes.
// id, subPath, depth, cost, effect (kind + extras), description.
// ---------------------------------------------------------------------------
// Output projection uses neutral key names — the original's node-shape field
// names do not cross the wall (implementer names its own data shape).
const generation = ALL_FILLER_NODES.map((n) => ({
  id: n.id,
  sub_path: n.subPath,
  depth: n.depth,
  cost: n.cost,
  effect: n.effect,
  description: n.description,
}));

// ---------------------------------------------------------------------------
// Helpers for INVARIANT checks.
// ---------------------------------------------------------------------------
function group(nodes: ReadonlyArray<{ id: string; effect: SkillEffect; magnitude: number }>) {
  const byKey = new Map<string, { id: string; magnitude: number; tier: string }[]>();
  for (const n of nodes) {
    const k = effectKey(n.effect);
    const t = inferTier(n as RawSkillNode, ALL_ARCHETYPE_PREFIXES);
    if (!byKey.has(k)) byKey.set(k, []);
    byKey.get(k)!.push({ id: n.id, magnitude: n.magnitude, tier: t });
  }
  return byKey;
}

// ---------------------------------------------------------------------------
// SECTION B (INVARIANT): real filler-only pools. For each effect-key present
// among ALL_FILLER_NODES, record target, computed product/sum, and tier shares.
// (Every real pool here is filler-only, so wF normalizes to 1.0.)
// ---------------------------------------------------------------------------
const derivedReal = deriveMagnitudes(ALL_FILLER_NODES, ALL_ARCHETYPE_PREFIXES);
const realByKey = group(derivedReal);

const realPools: Record<string, unknown> = {};
for (const [k, members] of realByKey) {
  const additive = k in ADDITIVE_POOL_TARGETS;
  const target = additive ? ADDITIVE_POOL_TARGETS[k]! : POOL_TARGETS[k]!;
  let product = 1;
  let sum = 0;
  for (const m of members) {
    product *= 1 + m.magnitude;
    sum += m.magnitude;
  }
  // filler ramp ratios (consecutive, sorted by trailing depth segment)
  const fillers = members
    .filter((m) => m.tier === 'filler')
    .sort((a, b) => {
      const da = Number(a.id.slice(a.id.lastIndexOf('.') + 1));
      const db = Number(b.id.slice(b.id.lastIndexOf('.') + 1));
      return da - db;
    });
  const ratios: number[] = [];
  for (let i = 1; i < fillers.length; i++) {
    ratios.push(fillers[i].magnitude / fillers[i - 1].magnitude);
  }
  realPools[k] = {
    additive,
    target,
    n_members: members.length,
    tiers_present: {
      keystone: members.filter((m) => m.tier === 'keystone').length,
      notable: members.filter((m) => m.tier === 'notable').length,
      filler: members.filter((m) => m.tier === 'filler').length,
    },
    product: additive ? null : product,
    sum: additive ? sum : null,
    ramp_ratios: ratios,
  };
}

// ---------------------------------------------------------------------------
// SECTION C (INVARIANT): SYNTHETIC mixed-tier pools — exercise the 50:30:20
// tier-weight split, which real filler-only pools never trigger.
// ---------------------------------------------------------------------------
function synthNode(id: string, effect: SkillEffect): RawSkillNode {
  return {
    id,
    subPath: 'mining',
    depth: 1,
    cost: 1,
    effect,
    description: 'synthetic',
  } as RawSkillNode;
}

// Multiplicative mixed pool: 1 keystone + 1 notable + 3 filler, one effect-key.
// Use commRangeMul (POOL_TARGET 10). keystone via '.keystone.' id; filler via a
// real archetype prefix 'communication.commRange'; notable = anything else.
const synthMul: RawSkillNode[] = [
  synthNode('communication.keystone.bigDish', { kind: 'commRangeMul' } as SkillEffect),
  synthNode('communication.notable.relay', { kind: 'commRangeMul' } as SkillEffect),
  synthNode('communication.commRange.1', { kind: 'commRangeMul' } as SkillEffect),
  synthNode('communication.commRange.2', { kind: 'commRangeMul' } as SkillEffect),
  synthNode('communication.commRange.3', { kind: 'commRangeMul' } as SkillEffect),
];

// Additive mixed pool: 1 keystone + 1 notable + 3 filler, launchSuccessAdditive (0.50).
const synthAdd: RawSkillNode[] = [
  synthNode('launch.keystone.guidance', { kind: 'launchSuccessAdditive' } as SkillEffect),
  synthNode('launch.notable.checklist', { kind: 'launchSuccessAdditive' } as SkillEffect),
  synthNode('launch.success.1', { kind: 'launchSuccessAdditive' } as SkillEffect),
  synthNode('launch.success.2', { kind: 'launchSuccessAdditive' } as SkillEffect),
  synthNode('launch.success.3', { kind: 'launchSuccessAdditive' } as SkillEffect),
];

// startDepth synthetic: filler ids starting at depth 3 → exponents 2,3,4,5.
const synthStartDepth: RawSkillNode[] = [
  synthNode('smelting.inputEff.3', { kind: 'recipeInputMul', reduce: true } as SkillEffect),
  synthNode('smelting.inputEff.4', { kind: 'recipeInputMul', reduce: true } as SkillEffect),
  synthNode('smelting.inputEff.5', { kind: 'recipeInputMul', reduce: true } as SkillEffect),
  synthNode('smelting.inputEff.6', { kind: 'recipeInputMul', reduce: true } as SkillEffect),
];

function analyzeSynth(raw: RawSkillNode[], prefixes: ReadonlyArray<string>) {
  const derived = deriveMagnitudes(raw, prefixes);
  const byKey = group(derived);
  const out: Record<string, unknown> = {};
  for (const [k, members] of byKey) {
    const additive = k in ADDITIVE_POOL_TARGETS;
    const target = additive ? ADDITIVE_POOL_TARGETS[k]! : POOL_TARGETS[k]!;
    const tierGroups: Record<string, { product: number; sum: number; n: number; mags: number[] }> = {};
    let product = 1;
    let sum = 0;
    for (const m of members) {
      product *= 1 + m.magnitude;
      sum += m.magnitude;
      if (!tierGroups[m.tier]) tierGroups[m.tier] = { product: 1, sum: 0, n: 0, mags: [] };
      tierGroups[m.tier].product *= 1 + m.magnitude;
      tierGroups[m.tier].sum += m.magnitude;
      tierGroups[m.tier].n++;
      tierGroups[m.tier].mags.push(m.magnitude);
    }
    // per-tier weight shares: multiplicative → log(subproduct)/log(target);
    // additive → subsum/target.
    const shares: Record<string, number> = {};
    for (const t of Object.keys(tierGroups)) {
      shares[t] = additive
        ? tierGroups[t].sum / target
        : Math.log(tierGroups[t].product) / Math.log(target);
    }
    out[k] = {
      additive,
      target,
      product: additive ? null : product,
      sum: additive ? sum : null,
      tier_shares: shares,
      tier_counts: Object.fromEntries(Object.entries(tierGroups).map(([t, g]) => [t, g.n])),
    };
  }
  return out;
}

// ---------------------------------------------------------------------------
// SECTION D (EXACT): edge behaviors.
// ---------------------------------------------------------------------------
// idempotency: deriveMagnitudes(deriveMagnitudes(x)) === deriveMagnitudes(x)
const once = deriveMagnitudes(ALL_FILLER_NODES, ALL_ARCHETYPE_PREFIXES);
const twice = deriveMagnitudes(once as RawSkillNode[], ALL_ARCHETYPE_PREFIXES);
let idempotent = once.length === twice.length;
let maxIdemDelta = 0;
for (let i = 0; i < once.length; i++) {
  const d = Math.abs(once[i].magnitude - twice[i].magnitude);
  if (d > maxIdemDelta) maxIdemDelta = d;
  if (once[i].id !== twice[i].id) idempotent = false;
}

// unknown effect-key → magnitude 0
const unknownRaw: RawSkillNode[] = [
  synthNode('mystery.node.1', { kind: 'placeholder' } as SkillEffect),
];
const unknownDerived = deriveMagnitudes(unknownRaw, ALL_ARCHETYPE_PREFIXES);

// non-conforming id (no numeric trailing segment) treated as filler with exponent 0.
// Build a filler-only pool with a non-numeric id mixed with numeric ones.
const nonConfRaw: RawSkillNode[] = [
  synthNode('discovery.droneScan.foo', { kind: 'droneScanRadiusMul' } as SkillEffect),
  synthNode('discovery.droneScan.2', { kind: 'droneScanRadiusMul' } as SkillEffect),
];
const nonConfDerived = deriveMagnitudes(nonConfRaw, ['discovery.droneScan']);

const edges = {
  idempotent,
  idempotent_max_delta: maxIdemDelta,
  unknown_kind_magnitude: unknownDerived[0].magnitude,
  nonconforming: nonConfDerived.map((n) => ({ id: n.id, magnitude: n.magnitude })),
};

// ---------------------------------------------------------------------------
// SECTION E: constants snapshot (documented data the implementer needs).
// ---------------------------------------------------------------------------
// Neutral key names — do NOT leak the original's SCREAMING_SNAKE constant names
// across the wall.
const constants = {
  tier_weights: TIER_WEIGHTS,
  filler_growth: FILLER_GROWTH,
  multiplicative_targets: POOL_TARGETS,
  additive_targets: ADDITIVE_POOL_TARGETS,
};

const out = {
  constants,
  generation,
  pools_real: realPools,
  pools_synthetic: {
    multiplicative_mixed: analyzeSynth(synthMul, ALL_ARCHETYPE_PREFIXES),
    additive_mixed: analyzeSynth(synthAdd, ALL_ARCHETYPE_PREFIXES),
    startdepth_filler: analyzeSynth(synthStartDepth, ALL_ARCHETYPE_PREFIXES),
  },
  edges,
};

console.log(JSON.stringify(out, null, 2));
