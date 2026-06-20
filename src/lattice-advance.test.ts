// §13.3 D-01 — Lattice shared-flow grouped lockstep advance.
//
// Design: docs/superpowers/specs/2026-06-10-lattice-shared-flow-design.md
//
// The bug being fixed: with the Omniscient Lattice active, member islands
// read the unified pool for eligibility (ctx.inventory/ctx.caps) but
// applyRates decremented only the LOCAL island — a member with zero local
// stock ran forever off a partner's stock that never shrank (matter from
// nothing). The fix advances lattice members as ONE net-flow problem with a
// pooled inventory that actually drains, then redistributes the pooled stock
// to members by cap share. These are the 5 design "Tests (minimum)" plus an
// explicit offline-catchup regression.

import { describe, expect, it } from 'vitest';

import {
  BUILDING_DEFS,
  type BuildingDef,
  type BuildingDefId,
} from './building-defs.js';
import type { PlacedBuilding } from './buildings.js';
import {
  advanceIsland,
  computeRates,
  type DefCatalog,
  type IslandState,
  type RatesContext,
} from './economy.js';
import { advanceLatticeGroup } from './lattice-advance.js';
import { ALL_RESOURCES, type ResourceId } from './recipes.js';

// Power- and heat-free catalog: strip power so test islands need no plant,
// and the bare mine/workshop recipes have no heat requirement.
function strippedCatalog(): DefCatalog {
  const base = { ...BUILDING_DEFS } as Record<BuildingDefId, BuildingDef>;
  const strip = (id: BuildingDefId): void => {
    const def = base[id];
    const { power: _power, ...rest } = def;
    base[id] = rest as BuildingDef;
  };
  strip('mine');
  strip('workshop');
  return base;
}
const DEFS: DefCatalog = strippedCatalog();

function blankInventory(): Record<ResourceId, number> {
  const inv2 = {} as Record<ResourceId, number>;
  for (const r of ALL_RESOURCES) inv2[r] = 0;
  return inv2;
}
function blankCaps(value: number): Record<ResourceId, number> {
  const caps = {} as Record<ResourceId, number>;
  for (const r of ALL_RESOURCES) caps[r] = value;
  return caps;
}
function blankFunnel(): Record<ResourceId, number> {
  const f = {} as Record<ResourceId, number>;
  for (const r of ALL_RESOURCES) f[r] = 0;
  return f;
}

function makeState(id: string, over: Partial<IslandState> = {}): IslandState {
  return {
    id,
    buildings: [],
    inventory: blankInventory(),
    storageCaps: blankCaps(1_000_000),
    xp: 0,
    level: 10,
    unspentSkillPoints: 0,
    unlockedNodes: new Set(),
    unlockedEdges: new Set(),
    auraAmpVersion: 0,
    auraAmpCache: null,
    auraAmpCacheVersion: -1,
    co2Kg: 0,
    funnelPending: blankFunnel(),
    aiCoreCrafted: false,
    ascendantCoreCrafted: false,
    lastResetAt: null,
    timeLockBankedMin: 0,
    accelerationQueue: [],
    accelerationRemainingMin: 0,
    bankingEnabled: false,
    genesisTarget: null,
    batteryStoredWs: 0,
    starterInventoryGrace: {} as Record<ResourceId, number>,
    socketBindings: new Map(),
    everProduced: new Set(),
    tradeCooldownMs: 0,
    tradeAcceptCount: 0,
    lastTick: 0,
    ...over,
  };
}

const MINE = (id: string): PlacedBuilding => ({ id, defId: 'mine', x: 0, y: 0 });
const WORKSHOP = (id: string): PlacedBuilding => ({ id, defId: 'workshop', x: 0, y: 0 });

/** Sum a resource across a set of member states. */
function pooled(states: IslandState[], r: ResourceId): number {
  let s = 0;
  for (const st of states) s += st.inventory[r] ?? 0;
  return s;
}

const ctxFor =
  (defs: DefCatalog) =>
  (_state: IslandState): RatesContext => ({ defs });

describe('advanceLatticeGroup — §13.3 D-01 shared flow', () => {
  it('consumer on A with zero local stock DRAINS the pool and B share shrinks (D-01 regression)', () => {
    // A: workshop consuming iron_ore + coal -> bolt, zero local iron_ore.
    // B: mine producing iron_ore. Coal is abundant in the pool (on B) so the
    // binding input is iron_ore, which only B produces.
    const a = makeState('A', { buildings: [WORKSHOP('w')] });
    const b = makeState('B', { buildings: [MINE('m')] });
    // Seed pooled iron_ore on B and abundant coal on B.
    b.inventory.iron_ore = 1000;
    b.inventory.coal = 1_000_000;

    const startIron = pooled([a, b], 'iron_ore');
    const startBolt = pooled([a, b], 'bolt');
    const startCoal = pooled([a, b], 'coal');

    advanceLatticeGroup([a, b], 600_000, ctxFor(DEFS)); // 10 min

    const endIron = pooled([a, b], 'iron_ore');
    const endBolt = pooled([a, b], 'bolt');
    const endCoal = pooled([a, b], 'coal');

    // Workshop ran: bolts were produced (consumer drew real stock).
    expect(endBolt).toBeGreaterThan(startBolt);
    // Mass conservation across the closed sub-system: every bolt produced
    // consumed exactly one iron_ore and one coal (workshop recipe 1:1:1).
    const bolts = endBolt - startBolt;
    // iron_ore: mine produced some, workshop consumed `bolts`.
    // Conservation check — iron_ore delta = mineProduced - bolts; coal delta =
    // -bolts. The tight invariant we assert: coal drained by exactly bolts,
    // to 1e-9 (this is the "matter from nothing" guard — before the fix the
    // pool never drained).
    expect(startCoal - endCoal).toBeCloseTo(bolts, 9);
    // Pooled iron_ore mass balance: endIron = startIron + mineOutput - bolts.
    // mineOutput is therefore (endIron - startIron + bolts) and must be > 0
    // (the mine ran). The workshop consumed `bolts` iron_ore from the POOL —
    // before the D-01 fix the pool never shrank and B's stock was conjured
    // back; here every consumed unit is accounted for by mass balance.
    const mineOutput = endIron - startIron + bolts;
    expect(mineOutput).toBeGreaterThan(0);
    // Redistribution: A and B both hold a cap-proportional slice; with equal
    // caps the pooled iron_ore splits evenly.
    expect(a.inventory.iron_ore).toBeCloseTo(b.inventory.iron_ore, 6);
  });

  it('cap-proportional distribution: pooled stock splits by cap share; cap-0 island holds 0', () => {
    const a = makeState('A', { buildings: [], storageCaps: blankCaps(0) });
    const b = makeState('B', { buildings: [], storageCaps: blankCaps(0) });
    // No production — pure redistribution test. Pool has 300 iron_ore.
    a.inventory.iron_ore = 300;
    b.inventory.iron_ore = 0;
    // Caps: A=100, B=200 -> A gets 1/3, B gets 2/3 of the pooled 300.
    a.storageCaps.iron_ore = 100;
    b.storageCaps.iron_ore = 200;

    advanceLatticeGroup([a, b], 1000, ctxFor(DEFS));

    expect(a.inventory.iron_ore).toBeCloseTo(100, 6); // 300 * 100/300
    expect(b.inventory.iron_ore).toBeCloseTo(200, 6); // 300 * 200/300

    // Cap-0 case: a resource where A has cap 0 holds 0 of that resource.
    const c = makeState('C', { buildings: [], storageCaps: blankCaps(0) });
    const d = makeState('D', { buildings: [], storageCaps: blankCaps(0) });
    c.inventory.coal = 50;
    d.inventory.coal = 50;
    c.storageCaps.coal = 0; // cap 0 -> holds 0
    d.storageCaps.coal = 500;
    advanceLatticeGroup([c, d], 1000, ctxFor(DEFS));
    expect(c.inventory.coal).toBeCloseTo(0, 6);
    expect(d.inventory.coal).toBeCloseTo(100, 6); // all 100 pooled coal

    // Σcaps = 0 freeze: a resource with zero cap on BOTH islands keeps local
    // stocks untouched.
    const e = makeState('E', { buildings: [], storageCaps: blankCaps(0) });
    const f = makeState('F', { buildings: [], storageCaps: blankCaps(0) });
    e.inventory.wood = 7;
    f.inventory.wood = 3;
    advanceLatticeGroup([e, f], 1000, ctxFor(DEFS));
    expect(e.inventory.wood).toBeCloseTo(7, 6);
    expect(f.inventory.wood).toBeCloseTo(3, 6);
  });

  it('cross-island producer-at-cap throttle θ matches the same-island case (solver-union equivalence)', () => {
    // Scenario: a mine producing iron_ore whose pooled bin is at cap, with a
    // workshop consuming iron_ore. The producer should throttle to exactly the
    // consumer's draw. We compare the SPLIT case (mine on A, workshop on B) to
    // the COLOCATED case (both on one island) — the pooled net iron_ore rate
    // must match.
    const aCoal = 1_000_000;

    // Split across two lattice islands, iron_ore pooled bin at cap (cap 500).
    const a = makeState('A', { buildings: [MINE('m')], storageCaps: blankCaps(1_000_000) });
    const b = makeState('B', { buildings: [WORKSHOP('w')], storageCaps: blankCaps(1_000_000) });
    a.storageCaps.iron_ore = 250;
    b.storageCaps.iron_ore = 250; // pooled iron_ore cap = 500
    a.inventory.iron_ore = 250;
    b.inventory.iron_ore = 250; // pooled iron_ore = 500 (at cap)
    b.inventory.coal = aCoal;

    // Pooled inventory + caps the group sees.
    const pooledInv = blankInventory();
    const pooledCaps = blankCaps(2_000_000);
    for (const r of ALL_RESOURCES) {
      pooledInv[r] = (a.inventory[r] ?? 0) + (b.inventory[r] ?? 0);
      pooledCaps[r] = (a.storageCaps[r] ?? 0) + (b.storageCaps[r] ?? 0);
    }

    // Build sibling flow specs by asking each member for its own specs.
    const aSpecs = computeRates(a, { defs: DEFS, inventory: pooledInv, caps: pooledCaps }, 0).flowSpecs;
    const bSpecs = computeRates(b, { defs: DEFS, inventory: pooledInv, caps: pooledCaps }, 0).flowSpecs;

    const aRes = computeRates(
      a,
      { defs: DEFS, inventory: pooledInv, caps: pooledCaps, flowSiblings: bSpecs },
      0,
    );
    const bRes = computeRates(
      b,
      { defs: DEFS, inventory: pooledInv, caps: pooledCaps, flowSiblings: aSpecs },
      0,
    );
    const splitNetIron = (aRes.net.iron_ore ?? 0) + (bRes.net.iron_ore ?? 0);

    // Colocated: both buildings on one island at the same pooled regime.
    const c = makeState('C', { buildings: [MINE('m2'), WORKSHOP('w2')], storageCaps: blankCaps(2_000_000) });
    c.storageCaps.iron_ore = 500;
    c.inventory.iron_ore = 500; // at cap
    c.inventory.coal = aCoal;
    const cRes = computeRates(c, { defs: DEFS }, 0);
    const coNetIron = cRes.net.iron_ore ?? 0;

    // At the pinned cap the producer throttles to the consumer draw in both
    // cases — net iron_ore ~ 0 (producer matched to consumer). The union solve
    // must reproduce the colocated throttle exactly.
    expect(splitNetIron).toBeCloseTo(coNetIron, 9);
    expect(splitNetIron).toBeCloseTo(0, 9);
  });

  it('deactivation mid-state: shares freeze, per-island advance resumes; mass conserved', () => {
    const a = makeState('A', { buildings: [WORKSHOP('w')] });
    const b = makeState('B', { buildings: [MINE('m')] });
    b.inventory.iron_ore = 1000;
    b.inventory.coal = 1_000_000;

    advanceLatticeGroup([a, b], 300_000, ctxFor(DEFS)); // 5 min grouped

    // Snapshot the frozen per-island shares.
    const aIronFrozen = a.inventory.iron_ore;
    const bIronFrozen = b.inventory.iron_ore;
    const poolAfterGroup = pooled([a, b], 'iron_ore');

    // Deactivation: each island now advances ALONE (no pool). A has its frozen
    // share of iron_ore; it keeps consuming locally until its OWN stock runs
    // out — no more conjuring from B.
    advanceIsland(a, 600_000, { defs: DEFS });
    advanceIsland(b, 600_000, { defs: DEFS });

    // A's iron_ore never went negative and never exceeded its frozen share +
    // any local production (A has no mine, so it can only decrease).
    expect(a.inventory.iron_ore).toBeLessThanOrEqual(aIronFrozen + 1e-9);
    expect(a.inventory.iron_ore).toBeGreaterThanOrEqual(0);
    // B kept producing on its own.
    expect(b.inventory.iron_ore).toBeGreaterThanOrEqual(bIronFrozen - 1e-9);
    // Shares were a clean split at deactivation (pool fully distributed).
    expect(aIronFrozen + bIronFrozen).toBeCloseTo(poolAfterGroup, 6);
  });

  it('lockstep equivalence: group advance ≡ colocated single-island advance', () => {
    // All buildings colocated on one island vs split across a lattice group —
    // the POOLED end-state must match.
    const single = makeState('S', { buildings: [MINE('m'), WORKSHOP('w')] });
    single.inventory.iron_ore = 100;
    single.inventory.coal = 1_000_000;

    const a = makeState('A', { buildings: [MINE('m')] });
    const b = makeState('B', { buildings: [WORKSHOP('w')] });
    // Same total starting stock, split across the group.
    a.inventory.iron_ore = 100;
    b.inventory.coal = 1_000_000;

    advanceIsland(single, 600_000, { defs: DEFS });
    advanceLatticeGroup([a, b], 600_000, ctxFor(DEFS));

    expect(pooled([a, b], 'iron_ore')).toBeCloseTo(single.inventory.iron_ore, 4);
    expect(pooled([a, b], 'bolt')).toBeCloseTo(single.inventory.bolt, 4);
    expect(pooled([a, b], 'coal')).toBeCloseTo(single.inventory.coal, 4);
  });

  it('OFFLINE CATCHUP with lattice active uses the grouped path (no pool desync)', () => {
    // A 24h offline gap advanced as a SINGLE grouped call must equal the same
    // gap advanced in many small grouped steps — and must conserve mass. This
    // is the HIGH-risk path the design flags: if offline catchup advanced
    // per-island it would desync the pool.
    const longGap = 24 * 60 * 60 * 1000; // 24h

    const a1 = makeState('A', { buildings: [WORKSHOP('w')] });
    const b1 = makeState('B', { buildings: [MINE('m')] });
    b1.inventory.iron_ore = 5000;
    b1.inventory.coal = 1_000_000;
    const startCoal = pooled([a1, b1], 'coal');

    // One big offline catchup.
    advanceLatticeGroup([a1, b1], longGap, ctxFor(DEFS));
    const bigBolt = pooled([a1, b1], 'bolt');
    const bigCoal = pooled([a1, b1], 'coal');

    // Mass conservation: coal drained by exactly the bolts produced.
    expect(startCoal - bigCoal).toBeCloseTo(bigBolt, 6);

    // Stepped catchup over the same gap, comparing end-states.
    const a2 = makeState('A', { buildings: [WORKSHOP('w')] });
    const b2 = makeState('B', { buildings: [MINE('m')] });
    b2.inventory.iron_ore = 5000;
    b2.inventory.coal = 1_000_000;
    const step = 60 * 60 * 1000; // 1h steps
    for (let t = step; t <= longGap; t += step) {
      advanceLatticeGroup([a2, b2], t, ctxFor(DEFS));
    }
    expect(pooled([a2, b2], 'bolt')).toBeCloseTo(bigBolt, 2);
    expect(pooled([a2, b2], 'iron_ore')).toBeCloseTo(pooled([a1, b1], 'iron_ore'), 2);
  });

  it('late-lastTick member accrues no XP/wear/CO₂ for the pre-join interval', () => {
    const a = makeState('A', { buildings: [MINE('mA')] });
    const b = makeState('B', { buildings: [MINE('mB')], lastTick: 5000 });
    advanceLatticeGroup([a, b], 10000, ctxFor(DEFS));

    expect(a.xp).toBeGreaterThan(0);
    expect(b.xp).toBeGreaterThan(0);
    expect(b.xp).toBeCloseTo(a.xp * 0.5, 4);

    const aMine = a.buildings.find((b) => b.id === 'mA')!;
    const bMine = b.buildings.find((b) => b.id === 'mB')!;
    expect(aMine.operatingMs).toBeCloseTo(10000, 0);
    expect(bMine.operatingMs).toBeCloseTo(5000, 0);

    // Mines emit no CO₂; the point of the assertion is that the offline member
    // does not inherit side effects from the pooled production.
    expect(a.co2Kg).toBe(0);
    expect(b.co2Kg).toBe(0);
  });

  it('grouped members drain CO₂ from the shared co2Pool, not per-island co2Kg (§7.4)', () => {
    // Regression lock: lattice/shared-network members run side effects through
    // the same applySegmentSideEffects as solo islands. With a shared co2Pool in
    // their ctx, a forest member's trees must drain the GLOBAL pool (so a lattice
    // forest island offsets the world), leaving its per-island co2Kg untouched.
    const pool = { kg: 1000 };
    const treeCtx = (_state: IslandState): RatesContext => ({
      defs: DEFS,
      terrainAt: () => 'tree',
      co2Pool: pool,
    });
    const f = makeState('F', { buildings: [{ id: 't', defId: 'plant_a_tree', x: 0, y: 0 }] });
    const g = makeState('G', { buildings: [MINE('m')] });
    g.inventory.coal = 1_000_000;
    advanceLatticeGroup([f, g], 600_000, treeCtx);
    expect(pool.kg).toBeLessThan(1000); // tree capture drained the global pool
    expect(f.co2Kg).toBe(0);            // per-island scalar untouched
  });

  it('pooled everProduced is attributed to the real producer, not member 0', () => {
    const producer = makeState('producer', { buildings: [MINE('mProd')] });
    const consumer = makeState('consumer', { buildings: [WORKSHOP('w')] });
    consumer.inventory.coal = 1000;
    // consumer listed first so, before the fix, the synthetic pool state would
    // shallow-share its everProduced Set and credit iron_ore to the wrong island.
    advanceLatticeGroup([consumer, producer], 10000, ctxFor(DEFS));

    expect(producer.everProduced.has('iron_ore')).toBe(true);
    expect(consumer.everProduced.has('iron_ore')).toBe(false);
  });
});
