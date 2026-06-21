// D-02 — non-lattice sharedNetwork grouped lockstep advance (partial pooling).
//
// Companion to lattice-advance.test.ts. The bug being fixed (same class as
// D-01): with a cross-island shared-inventory skill active, non-lattice net
// participants read the SHARED pool for eligibility/caps but applyRates
// decremented only the LOCAL island — partner stock never shrank (matter from
// nothing), AND a single pre-tick snapshot handed to each participant let two
// consumers each drain the full pool in the same tick (within-tick double
// spend). The fix advances participants as ONE net-flow problem, but pools
// ONLY the shared-resource subset; every NON-shared resource stays strictly
// local (its own inventory/caps, no cross-island throttle or drain).

import { describe, expect, it } from 'vitest';

import {
  BUILDING_DEFS,
  type BuildingDef,
  type BuildingDefId,
} from './building-defs.js';
import type { PlacedBuilding } from './buildings.js';
import {
  advanceIsland,
  type DefCatalog,
  type IslandState,
  type RatesContext,
} from './economy.js';
import { advanceSharedNetworkGroup } from './shared-network-advance.js';
import { ALL_RESOURCES, type ResourceId } from './recipes.js';

// Power- and heat-free catalog (mirrors lattice-advance.test.ts).
function strippedCatalog(): DefCatalog {
  const base = { ...BUILDING_DEFS } as Record<BuildingDefId, BuildingDef>;
  const strip = (id: BuildingDefId): void => {
    const def = base[id];
    const { power: _power, ...rest } = def;
    base[id] = rest as BuildingDef;
  };
  strip('iron_mine');
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
    level: 15,
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

const MINE = (id: string): PlacedBuilding => ({ id, defId: 'iron_mine', x: 0, y: 0 });
const WORKSHOP = (id: string): PlacedBuilding => ({ id, defId: 'workshop', x: 0, y: 0 });

function pooled(states: IslandState[], r: ResourceId): number {
  let s = 0;
  for (const st of states) s += st.inventory[r] ?? 0;
  return s;
}

const ctxFor =
  (defs: DefCatalog) =>
  (_state: IslandState): RatesContext => ({ defs });

/** Build the pooled-cap (Σ member nominal caps) map for a shared-resource set. */
function sumCaps(states: IslandState[], shared: ReadonlySet<ResourceId>): Map<ResourceId, number> {
  const m = new Map<ResourceId, number>();
  for (const r of shared) {
    let total = 0;
    for (const st of states) total += st.storageCaps[r] ?? 0;
    m.set(r, total);
  }
  return m;
}

/** Membership table where EVERY state holds a node for EVERY shared resource
 *  (the broad-membership case the (a)-(g) drain/double-spend/local tests use). */
function allHolders(
  states: IslandState[],
  shared: ReadonlySet<ResourceId>,
): Map<ResourceId, ReadonlySet<string>> {
  const m = new Map<ResourceId, ReadonlySet<string>>();
  for (const r of shared) m.set(r, new Set(states.map((s) => s.id)));
  return m;
}

describe('advanceSharedNetworkGroup — D-02 partial pooling', () => {
  it('(a) consumer on A with zero local shared stock DRAINS the pool; B share shrinks; mass conserved', () => {
    // Share iron_ore ONLY. Workshop on A (no local iron_ore) consumes
    // iron_ore (shared, from B via pool) + coal (must be local to A). Mine on
    // B produces iron_ore.
    const shared = new Set<ResourceId>(['iron_ore']);
    const a = makeState('A', { buildings: [WORKSHOP('w')] });
    const b = makeState('B', { buildings: [MINE('m')] });
    a.inventory.coal = 1_000_000; // coal is NON-shared — must be local to A's workshop
    b.inventory.iron_ore = 1000;

    const startIron = pooled([a, b], 'iron_ore');
    const startBolt = pooled([a, b], 'bolt');

    advanceSharedNetworkGroup([a, b], 600_000, ctxFor(DEFS), shared, sumCaps([a, b], shared), allHolders([a, b], shared));

    const endIron = pooled([a, b], 'iron_ore');
    const endBolt = pooled([a, b], 'bolt');
    const bolts = endBolt - startBolt;
    expect(bolts).toBeGreaterThan(0); // workshop ran off pooled iron_ore
    // Mass balance on the SHARED resource: endIron = startIron + mineOutput - bolts.
    const mineOutput = endIron - startIron + bolts;
    expect(mineOutput).toBeGreaterThan(0);
    // Coal (non-shared) drained EXACTLY bolts on A locally; B's coal untouched.
    expect(1_000_000 - a.inventory.coal).toBeCloseTo(bolts, 6);
    expect(b.inventory.coal).toBeCloseTo(0, 9);
    // Redistribution: equal caps -> pooled iron_ore splits evenly.
    expect(a.inventory.iron_ore).toBeCloseTo(b.inventory.iron_ore, 6);
  });

  it('(b) within-tick double-spend prevented: two consumers cannot each drain the full pool', () => {
    // Two workshops (A, C) both consuming shared iron_ore from a finite pool
    // seeded on B; coal local to each consumer. The shared draw must be
    // throttled across both — total iron_ore consumed cannot exceed what ever
    // existed (no double count). To make the throttle BIND, the pool is sized
    // smaller than the two workshops' combined demand over the window so both
    // compete for it (workshop cycleSec is long, so pool must be tiny).
    const shared = new Set<ResourceId>(['iron_ore']);
    const a = makeState('A', { buildings: [WORKSHOP('wa')] });
    const c = makeState('C', { buildings: [WORKSHOP('wc')] });
    const b = makeState('B', { buildings: [] }); // pure stock, no mine
    a.inventory.coal = 1_000_000;
    c.inventory.coal = 1_000_000;
    b.inventory.iron_ore = 0.05; // tiny finite shared pool, no producer

    const startIron = pooled([a, b, c], 'iron_ore');
    advanceSharedNetworkGroup([a, b, c], 36_000_000, ctxFor(DEFS), shared, sumCaps([a, b, c], shared), allHolders([a, b, c], shared)); // 10h

    const endIron = pooled([a, b, c], 'iron_ore');
    const bolts = pooled([a, b, c], 'bolt');
    // Mass conservation: total bolts == total iron_ore drained (1:1). Before the
    // fix each workshop "saw" the full 0.05 pool independently and both produced
    // 0.05 bolts (0.10 total) from a 0.05-unit pool — double-spend.
    expect(bolts).toBeCloseTo(startIron - endIron, 9);
    expect(bolts).toBeLessThanOrEqual(startIron + 1e-9);
    // The pool fully drained and was shared, not double-counted.
    expect(bolts).toBeCloseTo(0.05, 6);
    expect(endIron).toBeCloseTo(0, 9);
  });

  it('(c) a NON-shared resource stays strictly local: no cross-island draw', () => {
    // Share iron_ore ONLY. Coal is NON-shared. Workshop on A has pooled
    // iron_ore available (from B) but ZERO local coal; coal sits on B. The
    // workshop must NOT run — coal is local-only, A cannot draw B's coal.
    const shared = new Set<ResourceId>(['iron_ore']);
    const a = makeState('A', { buildings: [WORKSHOP('w')] });
    const b = makeState('B', { buildings: [] });
    b.inventory.iron_ore = 1000; // shared, reachable by A via pool
    b.inventory.coal = 1_000_000; // NON-shared, only on B
    a.inventory.coal = 0; // A has no local coal

    advanceSharedNetworkGroup([a, b], 600_000, ctxFor(DEFS), shared, sumCaps([a, b], shared), allHolders([a, b], shared));

    // No bolts: A's workshop is starved of coal (a non-shared input), which it
    // can only source locally. B's coal is untouched.
    expect(pooled([a, b], 'bolt')).toBeCloseTo(0, 9);
    expect(b.inventory.coal).toBeCloseTo(1_000_000, 6);
  });

  it('(d) cap-proportional redistribution of a shared resource by participant cap', () => {
    const shared = new Set<ResourceId>(['iron_ore']);
    const a = makeState('A', { buildings: [], storageCaps: blankCaps(0) });
    const b = makeState('B', { buildings: [], storageCaps: blankCaps(0) });
    a.inventory.iron_ore = 300;
    b.inventory.iron_ore = 0;
    a.storageCaps.iron_ore = 100; // 1/3
    b.storageCaps.iron_ore = 200; // 2/3

    advanceSharedNetworkGroup([a, b], 1000, ctxFor(DEFS), shared, sumCaps([a, b], shared), allHolders([a, b], shared));
    expect(a.inventory.iron_ore).toBeCloseTo(100, 6);
    expect(b.inventory.iron_ore).toBeCloseTo(200, 6);

    // A non-shared resource present on the islands is NOT redistributed.
    const c = makeState('C', { buildings: [], storageCaps: blankCaps(0) });
    const d = makeState('D', { buildings: [], storageCaps: blankCaps(0) });
    c.inventory.coal = 60;
    d.inventory.coal = 0;
    c.storageCaps.coal = 100;
    d.storageCaps.coal = 100;
    advanceSharedNetworkGroup([c, d], 1000, ctxFor(DEFS), new Set<ResourceId>(['iron_ore']), new Map(), allHolders([c, d], new Set<ResourceId>(['iron_ore'])));
    // coal is NOT shared -> stays where it was, no redistribution.
    expect(c.inventory.coal).toBeCloseTo(60, 6);
    expect(d.inventory.coal).toBeCloseTo(0, 6);
  });

  it('(e) deactivation freeze: shares freeze, per-island advance resumes; mass conserved', () => {
    const shared = new Set<ResourceId>(['iron_ore']);
    const a = makeState('A', { buildings: [WORKSHOP('w')] });
    const b = makeState('B', { buildings: [MINE('m')] });
    a.inventory.coal = 1_000_000;
    b.inventory.iron_ore = 1000;

    advanceSharedNetworkGroup([a, b], 300_000, ctxFor(DEFS), shared, sumCaps([a, b], shared), allHolders([a, b], shared));

    const aIronFrozen = a.inventory.iron_ore;
    const bIronFrozen = b.inventory.iron_ore;
    const poolAfterGroup = pooled([a, b], 'iron_ore');

    // Deactivation: each advances ALONE. A has no mine and no local coal source
    // (it still has coal), so it consumes its frozen iron_ore share until gone.
    advanceIsland(a, 600_000, { defs: DEFS });
    advanceIsland(b, 600_000, { defs: DEFS });

    expect(a.inventory.iron_ore).toBeLessThanOrEqual(aIronFrozen + 1e-9);
    expect(a.inventory.iron_ore).toBeGreaterThanOrEqual(0);
    expect(b.inventory.iron_ore).toBeGreaterThanOrEqual(bIronFrozen - 1e-9);
    expect(aIronFrozen + bIronFrozen).toBeCloseTo(poolAfterGroup, 6);
  });

  it('(f) offline catchup grouped equivalence + mass conservation over 24h', () => {
    const shared = new Set<ResourceId>(['iron_ore']);
    const longGap = 24 * 60 * 60 * 1000;

    const a1 = makeState('A', { buildings: [WORKSHOP('w')] });
    const b1 = makeState('B', { buildings: [MINE('m')] });
    a1.inventory.coal = 1_000_000;
    b1.inventory.iron_ore = 5000;
    const startCoalA = a1.inventory.coal;

    advanceSharedNetworkGroup([a1, b1], longGap, ctxFor(DEFS), shared, sumCaps([a1, b1], shared), allHolders([a1, b1], shared));
    const bigBolt = pooled([a1, b1], 'bolt');
    // Coal (local, non-shared) drained by exactly bolts on A.
    expect(startCoalA - a1.inventory.coal).toBeCloseTo(bigBolt, 5);

    const a2 = makeState('A', { buildings: [WORKSHOP('w')] });
    const b2 = makeState('B', { buildings: [MINE('m')] });
    a2.inventory.coal = 1_000_000;
    b2.inventory.iron_ore = 5000;
    const step = 60 * 60 * 1000;
    for (let t = step; t <= longGap; t += step) {
      advanceSharedNetworkGroup([a2, b2], t, ctxFor(DEFS), shared, sumCaps([a2, b2], shared), allHolders([a2, b2], shared));
    }
    expect(pooled([a2, b2], 'bolt')).toBeCloseTo(bigBolt, 1);
    expect(pooled([a2, b2], 'iron_ore')).toBeCloseTo(pooled([a1, b1], 'iron_ore'), 1);
  });

  it('(g) single-participant group behaves like a plain advanceIsland', () => {
    const shared = new Set<ResourceId>(['iron_ore']);
    const solo = makeState('S', { buildings: [MINE('m'), WORKSHOP('w')] });
    solo.inventory.iron_ore = 100;
    solo.inventory.coal = 1_000_000;
    const ref = makeState('S', { buildings: [MINE('m'), WORKSHOP('w')] });
    ref.inventory.iron_ore = 100;
    ref.inventory.coal = 1_000_000;

    advanceSharedNetworkGroup([solo], 600_000, ctxFor(DEFS), shared, sumCaps([solo], shared), allHolders([solo], shared));
    advanceIsland(ref, 600_000, { defs: DEFS });

    expect(solo.inventory.iron_ore).toBeCloseTo(ref.inventory.iron_ore, 4);
    expect(solo.inventory.bolt).toBeCloseTo(ref.inventory.bolt, 4);
    expect(solo.inventory.coal).toBeCloseTo(ref.inventory.coal, 4);
  });

  it('(h) per-resource node-holder membership: a networked island WITHOUT the node for r keeps r strictly local', () => {
    // Owner decision: pooling membership is node-holders ONLY, per resource.
    // A holds a sharedInventory node for coal; B is networked T3+ and HAS coal
    // but holds NO coal-sharing node. After advance B's coal must be untouched
    // (strictly local — not summed into the pool, not redistributed); only A's
    // coal participates. No production: this isolates pool membership.
    const shared = new Set<ResourceId>(['coal']);
    const a = makeState('A', { buildings: [] });
    const b = makeState('B', { buildings: [] });
    a.inventory.coal = 40;
    b.inventory.coal = 60;
    // Equal caps so, IF B were wrongly pooled, the 100 pooled coal would split
    // 50/50 and B would drop to 50 — the regression we guard against.
    a.storageCaps.coal = 100;
    b.storageCaps.coal = 100;

    // Membership: ONLY A holds coal's node. (sumCaps over holders = A's cap.)
    const holders = new Map<ResourceId, ReadonlySet<string>>([['coal', new Set(['A'])]]);
    const caps = new Map<ResourceId, number>([['coal', a.storageCaps.coal]]);

    advanceSharedNetworkGroup([a, b], 1000, ctxFor(DEFS), shared, caps, holders);

    // A is the sole holder: its coal pool (just A's 40) redistributes back to A
    // alone -> 40 unchanged. B is NOT a holder: its 60 coal is strictly local,
    // never pooled, never redistributed.
    expect(a.inventory.coal).toBeCloseTo(40, 6);
    expect(b.inventory.coal).toBeCloseTo(60, 6); // untouched — the key assertion
    // Total mass intact.
    expect(pooled([a, b], 'coal')).toBeCloseTo(100, 6);
  });

  it('(h2) node-holder drain stays among holders; a non-holder producer is NOT pooled', () => {
    // Share iron_ore. Holders = {A, B}. C is networked but holds no iron node.
    // A: workshop consuming iron_ore (+local coal). B: holds iron stock (holder).
    // C: a MINE producing iron_ore but NOT a holder -> C's iron accrues LOCALLY
    // and must NOT feed A's workshop via the pool.
    const shared = new Set<ResourceId>(['iron_ore']);
    const a = makeState('A', { buildings: [WORKSHOP('w')] });
    const b = makeState('B', { buildings: [] });
    const c = makeState('C', { buildings: [MINE('m')] });
    a.inventory.coal = 1_000_000;
    b.inventory.iron_ore = 30; // shared pool (A+B holders)
    c.inventory.iron_ore = 0;

    const holders = new Map<ResourceId, ReadonlySet<string>>([['iron_ore', new Set(['A', 'B'])]]);
    const caps = new Map<ResourceId, number>([['iron_ore', (a.storageCaps.iron_ore ?? 0) + (b.storageCaps.iron_ore ?? 0)]]);

    advanceSharedNetworkGroup([a, b, c], 600_000, ctxFor(DEFS), shared, caps, holders);

    const bolts = pooled([a, b, c], 'bolt');
    // The workshop drew from the A+B pool (30 units of iron available there).
    expect(bolts).toBeGreaterThan(0);
    // C is a non-holder: its mine output accrued to C's OWN inventory and was
    // never pooled. The pool (A+B) only ever had 30 iron, so bolts <= 30 — C's
    // production did NOT subsidize A through the pool.
    expect(bolts).toBeLessThanOrEqual(30 + 1e-6);
    expect(c.inventory.iron_ore).toBeGreaterThan(0); // C accumulated locally
    // A+B pooled-iron mass balance: started 30, consumed `bolts`.
    const poolIronAB = (a.inventory.iron_ore ?? 0) + (b.inventory.iron_ore ?? 0);
    expect(poolIronAB).toBeCloseTo(30 - bolts, 6);
  });
});
