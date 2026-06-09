// ============================================================================
// U45 — TIER RESET probe (SOURCE side of wall).
// ----------------------------------------------------------------------------
// Drives the ORIGINAL tier-reset logic (src/tier-reset.ts) against minimal
// duck-typed island states and serializes EXACT gate decisions, cost, refund,
// and post-reset field deltas to neutral JSON goldens at
//   packages/sim/goldens/tier_reset.json
//
// Behavior exercised (all from src/tier-reset.ts + its deps):
//   - cost(level): { steel, gear } scaling with level^2.
//   - cooldown constant (24h, wall-clock ms).
//   - gate(state, now): three-way reject (tier / cooldown / resources) in a
//     FIXED priority order, else ok.
//   - reset(state, now): in-place mutation — deduct cost, refund owned-node
//     skill points, clear node/edge sets, reset level/xp, stamp last-reset,
//     bump the mutation counter, clear role-declared timestamp; PRESERVE
//     buildings / inventory(minus cost) / storage / funnel-pending / the two
//     once-ever core-crafted flags.
//
// Source SYMBOL names are NOT transcribed into the spec/goldens. Node ids
// (mining.recipeRate.1, …) are CONTENT and cross verbatim. Field names in the
// golden JSON use NEUTRAL terms (see u45_tier_reset.namemap.md).
// ============================================================================

import { writeFileSync, mkdirSync } from 'node:fs';
import {
  TIER_RESET_COOLDOWN_MS,
  tierResetCost,
  canTierReset,
  executeTierReset,
} from '/root/robot-islands/src/tier-reset.js';
import { nodeById, NODE_CATALOG } from '/root/robot-islands/src/skilltree.js';

const OUT_DIR = '/root/islands/packages/sim/goldens';
mkdirSync(OUT_DIR, { recursive: true });

// ---- minimal duck-typed island state (only fields the unit reads/writes) ----
function mkState(over: any = {}): any {
  const s: any = {
    inventory: {} as Record<string, number>,
    unlockedNodes: new Set<string>(),
    unlockedEdges: new Set<string>(),
    unspentSkillPoints: 0,
    auraAmpVersion: 0,
    declaredAt: null,
    level: 1,
    xp: 0,
    lastResetAt: null,
    // preserved-only fields — present so we can assert non-mutation:
    buildings: over.buildings ?? [{ defId: 'x', x: 0, y: 0 }],
    storageCaps: over.storageCaps ?? { steel: 99999, gear: 99999 },
    funnelPending: over.funnelPending ?? { iron_ore: 7 },
    aiCoreCrafted: over.aiCoreCrafted ?? false,
    ascendantCoreCrafted: over.ascendantCoreCrafted ?? false,
  };
  Object.assign(s, over);
  return s;
}

// Snapshot the mutable, behaviorally-relevant projection of a state.
function snap(s: any) {
  return {
    inventory: { ...s.inventory },
    owned_node_count: s.unlockedNodes.size,
    owned_edge_count: s.unlockedEdges.size,
    unspent_sp: s.unspentSkillPoints,
    mutation_counter: s.auraAmpVersion,
    role_declared_at: s.declaredAt,
    level: s.level,
    xp: s.xp,
    last_reset_at: s.lastResetAt,
    buildings_count: s.buildings.length,
    storage_caps: { ...s.storageCaps },
    funnel_pending: { ...s.funnelPending },
    ai_core_crafted: s.aiCoreCrafted,
    ascendant_core_crafted: s.ascendantCoreCrafted,
  };
}

const HOUR_MS = 60 * 60 * 1000;

const cases: any[] = [];

// =========================================================================
// PART A — cost(level): EXACT { steel = level^2, gear = floor(level^2/2) }.
// =========================================================================
const costLevels = [1, 5, 14, 15, 16, 20, 29, 30, 49, 50, 51, 100];
const cost_cases = costLevels.map((level) => ({
  level,
  cost: tierResetCost(level),
}));

// =========================================================================
// PART B — gate(state, now): three-way reject priority + ok.
//   Tier band: level<15 -> below T3. Cooldown: now - last < 24h.
//   Resources: steel < cost.steel OR gear < cost.gear.
// =========================================================================
function gateCase(id: string, desc: string, state: any, now: number) {
  const result = canTierReset(state, now);
  cases.push({ id, desc, gate: result, now });
}

// B1 — below-T3 dominates everything (no resources, in cooldown — still tier).
gateCase(
  'gate_tier_too_low_dominates',
  'level 14 (<T3), zero inventory, in cooldown -> rejects on tier first',
  mkState({ level: 14, inventory: {}, lastResetAt: 0 }),
  1000, // within 24h of last=0
);

// B2 — exactly level 15 (T3 boundary) with funds & no cooldown -> ok.
gateCase(
  'gate_t3_boundary_ok',
  'level 15 (== T3 entry), funded, never reset -> ok',
  mkState({ level: 15, inventory: { steel: 225, gear: 112 } }),
  10 * HOUR_MS,
);

// B3 — cooldown dominates resources (funded, but reset 1ms ago).
gateCase(
  'gate_cooldown_dominates_resources',
  'level 20, funded, last reset 1ms inside the 24h window -> cooldown reject',
  mkState({ level: 20, inventory: { steel: 999999, gear: 999999 }, lastResetAt: 5 }),
  5 + 1, // elapsed = 1ms < 24h
);

// B4 — cooldown boundary: elapsed exactly 24h -> NOT in cooldown (strict <).
gateCase(
  'gate_cooldown_exact_boundary_releases',
  'elapsed == 24h exactly releases the gate (strict-less comparison), funded -> ok',
  mkState({ level: 20, inventory: { steel: 400, gear: 200 }, lastResetAt: 1000 }),
  1000 + TIER_RESET_COOLDOWN_MS, // elapsed == cooldown exactly
);

// B5 — cooldown boundary: 1ms before 24h -> still in cooldown.
gateCase(
  'gate_cooldown_one_ms_before_boundary',
  'elapsed == 24h - 1ms still in cooldown -> reject',
  mkState({ level: 20, inventory: { steel: 400, gear: 200 }, lastResetAt: 1000 }),
  1000 + TIER_RESET_COOLDOWN_MS - 1,
);

// B6 — lastResetAt null means cooldown never blocks (regardless of now).
gateCase(
  'gate_never_reset_no_cooldown',
  'lastReset null -> cooldown never applies even at now=0, funded -> ok',
  mkState({ level: 30, inventory: { steel: 900, gear: 450 }, lastResetAt: null }),
  0,
);

// B7 — insufficient steel only (gear ample).
gateCase(
  'gate_insufficient_steel',
  'level 15 needs steel 225; has 224 steel, ample gear -> insufficient',
  mkState({ level: 15, inventory: { steel: 224, gear: 999 } }),
  10 * HOUR_MS,
);

// B8 — insufficient gear only (steel ample).
gateCase(
  'gate_insufficient_gear',
  'level 15 needs gear 112; has 111 gear, ample steel -> insufficient',
  mkState({ level: 15, inventory: { steel: 999, gear: 111 } }),
  10 * HOUR_MS,
);

// B9 — exact funds (steel == cost, gear == cost) -> ok (>= passes).
gateCase(
  'gate_exact_funds_ok',
  'level 16: steel 256 == cost, gear 128 == cost -> ok (>= boundary)',
  mkState({ level: 16, inventory: { steel: 256, gear: 128 } }),
  10 * HOUR_MS,
);

// B10 — missing inventory keys read as 0 -> insufficient.
gateCase(
  'gate_missing_keys_as_zero',
  'level 15, inventory {} (keys absent read as 0) -> insufficient',
  mkState({ level: 15, inventory: {} }),
  10 * HOUR_MS,
);

// =========================================================================
// PART C — reset(state, now): EXACT before/after deltas.
// =========================================================================
function resetCase(id: string, desc: string, state: any, now: number) {
  const before = snap(state);
  const cost = tierResetCost(state.level);
  // owned node ids preserved for refund-derivation transparency:
  const ownedNodes = [...state.unlockedNodes];
  executeTierReset(state, now);
  const after = snap(state);
  cases.push({
    id,
    desc,
    now,
    cost,
    owned_node_ids: ownedNodes,
    before,
    after,
  });
}

// C1 — full reset with owned nodes (refund = sum of catalog node costs).
{
  // pick real catalog nodes with known costs; refund = sum of their .cost.
  const picks = NODE_CATALOG.slice(0, 6).map((n) => n.id);
  const refundExpected = picks.reduce((a, id) => a + (nodeById(id)?.cost ?? 0), 0);
  const s = mkState({
    level: 30,
    xp: 12345,
    inventory: { steel: 1000, gear: 600, iron_ore: 50 },
    unspentSkillPoints: 3,
    declaredAt: 777,
    lastResetAt: 100,
    auraAmpVersion: 4,
  });
  for (const id of picks) s.unlockedNodes.add(id);
  s.unlockedEdges.add('e_alpha');
  s.unlockedEdges.add('e_beta');
  resetCase(
    'reset_full_with_owned_nodes',
    'L30 reset: deduct 900/450, refund sum(owned node costs)+existing SP, clear sets, level->1 xp->0',
    s,
    9_000_000,
  );
  // annotate the expected refund delta for self-check transparency
  cases[cases.length - 1].refund_expected = refundExpected;
}

// C2 — reset with an UNKNOWN owned node id -> refunds 0 for it (defensive).
{
  const s = mkState({
    level: 16,
    inventory: { steel: 300, gear: 200 },
    unspentSkillPoints: 0,
    lastResetAt: null,
  });
  s.unlockedNodes.add('___removed_node___');
  s.unlockedNodes.add(NODE_CATALOG[2].id); // cost = 2 (mining.recipeRate.3)
  resetCase(
    'reset_unknown_node_refunds_zero',
    'owned set has one unknown id (refund 0) + one known id -> total refund = known cost only',
    s,
    50_000,
  );
  cases[cases.length - 1].refund_expected = nodeById(NODE_CATALOG[2].id)?.cost ?? 0;
}

// C3 — reset with NO owned nodes -> refund 0, SP unchanged.
{
  const s = mkState({
    level: 15,
    inventory: { steel: 225, gear: 112 },
    unspentSkillPoints: 9,
    declaredAt: 1,
    lastResetAt: 5,
  });
  resetCase(
    'reset_no_owned_nodes',
    'empty owned set -> refund 0, SP unchanged at 9, cost 225/112 deducted',
    s,
    20_000,
  );
}

// C4 — preservation: buildings/storage/funnel/core-flags untouched; inventory
//      keys other than steel/gear untouched; missing steel/gear key -> 0 - cost.
{
  const s = mkState({
    level: 15,
    inventory: { iron_ore: 42 }, // NO steel/gear keys present
    funnelPending: { iron_ore: 7, gear: 3 },
    aiCoreCrafted: true,
    ascendantCoreCrafted: true,
    buildings: [{ defId: 'a' }, { defId: 'b' }, { defId: 'c' }],
    storageCaps: { steel: 1, gear: 2, iron_ore: 3 },
  });
  resetCase(
    'reset_preserves_and_underflows_missing_cost_keys',
    'no steel/gear keys -> deduct drives them to (0-225)/(0-112) negative; iron_ore/funnel/caps/flags preserved',
    s,
    33_000,
  );
}

// C5 — mutation counter increments by exactly 1; role-declared cleared to null.
{
  const s = mkState({
    level: 15,
    inventory: { steel: 225, gear: 112 },
    auraAmpVersion: 41,
    declaredAt: 999999,
  });
  s.unlockedNodes.add(NODE_CATALOG[0].id);
  resetCase(
    'reset_bumps_counter_clears_declared',
    'mutation counter 41->42 (exactly +1); role-declared 999999 -> null; last-reset stamped to now',
    s,
    77_000,
  );
}

const out = {
  meta: {
    unit: 'U45',
    note:
      'Per-island tier reset: cost(level) + three-way gate (tier/cooldown/resources, fixed priority) + in-place reset mutation. EXACT cost/refund/deltas; cooldown is a fixed 24h wall-clock invariant pinned as a constant + strict-< boundary property.',
    case_count: 0, // filled below
  },
  constants: {
    cooldown_ms: TIER_RESET_COOLDOWN_MS,
    cooldown_hours: TIER_RESET_COOLDOWN_MS / HOUR_MS,
    cost_formula: 'steel = level^2 ; gear = floor(level^2 / 2)',
    tier3_min_level: 15,
    gate_priority: ['tier-too-low', 'cooldown-active', 'insufficient-resources'],
  },
  cost_cases,
  cases,
};
out.meta.case_count = cost_cases.length + cases.length;

writeFileSync(
  `${OUT_DIR}/tier_reset.json`,
  JSON.stringify(out, null, 2) + '\n',
);
console.log(
  'wrote tier_reset.json:',
  `${cost_cases.length} cost_cases +`,
  `${cases.length} gate/reset cases =`,
  out.meta.case_count,
  'total',
);
console.log('cooldown_ms =', TIER_RESET_COOLDOWN_MS);
