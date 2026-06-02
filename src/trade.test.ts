import { describe, expect, it } from 'vitest';
import { advanceIsland, type DefCatalog, type IslandState } from './economy.js';
import { BUILDING_DEFS, type BuildingDef, type BuildingDefId } from './building-defs.js';
import { attachTerrainAt, makeInitialIslandState } from './world.js';
import { generateOffer, applyOffer, DEFAULT_TRADE_TUNING, tierOf, tickTradeOffers, tuningFor, islandHasSignalExchange, effectiveCadenceMs, FLOOR_MS, ONLINE_DT_CAP_MS, type TradeOffer, type TradeRuntime } from './trade.js';
import { blankMultipliers } from './skilltree.js';
import type { ResourceId } from './recipes.js';

/** Strip power from the given defIds so tests exercise production/consumption
 *  without needing a generator (mirrors the powerFreeCatalog() pattern in
 *  economy.test.ts). */
function powerFree(...ids: BuildingDefId[]): DefCatalog {
  const base = { ...BUILDING_DEFS } as Record<BuildingDefId, BuildingDef>;
  for (const id of ids) {
    const { power: _power, ...rest } = base[id];
    base[id] = rest as BuildingDef;
  }
  return base;
}
const POWER_FREE_MINE = powerFree('mine');
const POWER_FREE_WORKSHOP = powerFree('workshop');

function homeState(nowMs = 0): IslandState {
  return makeInitialIslandState(
    attachTerrainAt({
      id: 'home', name: 'home', biome: 'plains', cx: 0, cy: 0,
      majorRadius: 16, minorRadius: 16, populated: true, discovered: true,
      buildings: [{ id: 'b-mine', defId: 'mine', x: 0, y: 0 }],
      modifiers: ['stable'],
    }),
    nowMs,
  );
}

/** A home island whose only relevant building is a Workshop — it CONSUMES
 *  starter iron_ore + coal and PRODUCES bolt, with no producer for the
 *  inputs. Used to prove that consumed-only resources are not recorded. */
function workshopState(nowMs = 0): IslandState {
  return makeInitialIslandState(
    attachTerrainAt({
      id: 'home', name: 'home', biome: 'plains', cx: 0, cy: 0,
      majorRadius: 16, minorRadius: 16, populated: true, discovered: true,
      buildings: [{ id: 'b-workshop', defId: 'workshop', x: 0, y: 0 }],
      modifiers: ['stable'],
    }),
    nowMs,
  );
}

describe('everProduced seen-set', () => {
  it('is empty on a fresh island except for starter inventory', () => {
    const s = homeState();
    expect(s.everProduced).toBeInstanceOf(Set);
    // A fresh plains home holds starter inventory but has produced nothing yet.
    expect(s.everProduced.size).toBe(0);
  });

  it('records a resource the first time production raises its inventory', () => {
    const s = homeState(0);
    advanceIsland(s, 5 * 60 * 1000, { defs: POWER_FREE_MINE }, 0);
    expect(s.everProduced.size).toBeGreaterThan(0);
  });

  it('does NOT record a resource that is only consumed (rate > 0 gate)', () => {
    // Workshop: -iron_ore, -coal → +bolt. iron_ore + coal come from starter
    // inventory and have no producer, so their net rate is negative; only
    // bolt is produced. Per the `rate > 0` gate, consumed-only resources must
    // stay out of everProduced.
    const s = workshopState(0);
    // Clear starter bolt so the workshop's output isn't cap-stalled (fresh
    // bolt cap is 20 < starter 25, which would freeze the building).
    s.inventory.bolt = 0;
    expect(s.inventory.iron_ore).toBeGreaterThan(0); // starter stock present
    expect(s.inventory.coal).toBeGreaterThan(0);
    advanceIsland(s, 60 * 60 * 1000, { defs: POWER_FREE_WORKSHOP }, 0);
    expect(s.inventory.bolt).toBeGreaterThan(0);         // bolt was produced
    expect(s.inventory.iron_ore).toBeLessThan(30);       // iron_ore was consumed
    expect(s.everProduced.has('bolt')).toBe(true);       // produced
    expect(s.everProduced.has('iron_ore')).toBe(false);  // consumed only
    expect(s.everProduced.has('coal')).toBe(false);      // consumed only
  });
});


describe('generateOffer — candidate selection', () => {
  function stocked(): IslandState {
    const s = homeState();
    s.storageCaps.stone = 100; s.inventory.stone = 90;
    s.storageCaps.wood = 100; s.inventory.wood = 10;
    s.everProduced.add('stone'); s.everProduced.add('wood'); s.everProduced.add('iron_ingot');
    s.storageCaps.iron_ingot = 100; s.inventory.iron_ingot = 5;
    return s;
  }

  it('never gets a resource absent from everProduced', () => {
    const s = stocked();
    for (let k = 0; k < 200; k++) {
      const o = generateOffer(s, Math.random, DEFAULT_TRADE_TUNING, 1000);
      if (o) expect(s.everProduced.has(o.get.res)).toBe(true);
    }
  });

  it('never gives a resource it holds zero of', () => {
    const s = stocked();
    for (let k = 0; k < 200; k++) {
      const o = generateOffer(s, Math.random, DEFAULT_TRADE_TUNING, 1000);
      if (o) expect((s.inventory[o.give.res] ?? 0)).toBeGreaterThan(0);
    }
  });

  it('biases the give side toward higher fill% (roll-twice-take-higher)', () => {
    const s = stocked();
    let stoneGives = 0, woodGives = 0;
    for (let k = 0; k < 400; k++) {
      const o = generateOffer(s, Math.random, DEFAULT_TRADE_TUNING, 1000);
      if (!o) continue;
      if (o.give.res === 'stone') stoneGives++;
      if (o.give.res === 'wood') woodGives++;
    }
    expect(stoneGives).toBeGreaterThan(woodGives);
  });

  it('returns null when the only give-resource equals the only ever-produced resource', () => {
    const s = homeState();
    for (const k of Object.keys(s.inventory) as ResourceId[]) s.inventory[k] = 0;
    s.storageCaps.wood = 100; s.inventory.wood = 50;
    s.everProduced.clear(); s.everProduced.add('wood');
    expect(generateOffer(s, () => 0.0, DEFAULT_TRADE_TUNING, 1000)).toBeNull();
  });

  it('returns null when nothing has ever been produced', () => {
    const s = homeState();
    s.storageCaps.stone = 100; s.inventory.stone = 50;
    s.everProduced.clear();
    expect(generateOffer(s, () => 0.0, DEFAULT_TRADE_TUNING, 1000)).toBeNull();
  });

  it('respects the tier-reach cap', () => {
    const s = stocked();
    for (let k = 0; k < 200; k++) {
      const o = generateOffer(s, Math.random, { ...DEFAULT_TRADE_TUNING, maxReach: 1 }, 1000);
      if (o) expect(Math.abs(tierOf(o.get.res) - tierOf(o.give.res))).toBeLessThanOrEqual(1);
    }
  });
});

describe('generateOffer — pricing & size', () => {
  function pair(giveRes: ResourceId, getRes: ResourceId, giveStock: number, getInv: number, getCap: number): IslandState {
    const s = homeState();
    s.storageCaps[giveRes] = giveStock * 2; s.inventory[giveRes] = giveStock;
    s.storageCaps[getRes] = getCap; s.inventory[getRes] = getInv;
    for (const k of Object.keys(s.inventory) as ResourceId[]) {
      if (k !== giveRes && k !== getRes) s.inventory[k] = 0;
    }
    s.everProduced.clear(); s.everProduced.add(getRes); s.everProduced.add(giveRes);
    return s;
  }

  it('moves at most sizePct of the give stock', () => {
    const s = pair('stone', 'wood', 1000, 0, 100000);
    s.everProduced.clear(); s.everProduced.add('wood');
    const o = generateOffer(s, () => 0.0, { ...DEFAULT_TRADE_TUNING, sizePct: 0.10, biasK: 1 }, 1000)!;
    expect(o).not.toBeNull();
    expect(o.give.qty).toBeLessThanOrEqual(1000 * 0.10 + 1e-6);
    expect(o.give.qty).toBeGreaterThan(0);
  });

  it('never exceeds output headroom', () => {
    const s = pair('stone', 'wood', 100000, 99995, 100000);
    s.everProduced.clear(); s.everProduced.add('wood');
    const o = generateOffer(s, () => 0.0, { ...DEFAULT_TRADE_TUNING, sizePct: 1.0, biasK: 1 }, 1000)!;
    expect(o.get.qty).toBeLessThanOrEqual(5 + 1e-6);
  });

  it('applies the rolled spread envelope at Δtier 0 (±25% around center 1)', () => {
    // give-only pool: stone (T0) is the sole inv>0; wood (T0) is the sole ever-produced, headroom present.
    const s = homeState();
    for (const k of Object.keys(s.inventory) as ResourceId[]) s.inventory[k] = 0;
    s.storageCaps.stone = 100000; s.inventory.stone = 1000;
    s.storageCaps.wood = 100000; s.inventory.wood = 0;
    s.everProduced.clear(); s.everProduced.add('wood');

    // rng=0 -> spread = 1*(1 + (0-0.5)*2*0.25) = 0.75
    const lo = generateOffer(s, () => 0.0, { ...DEFAULT_TRADE_TUNING, sizePct: 0.10, biasK: 1 }, 1000)!;
    expect(lo).not.toBeNull();
    expect(lo.give.res).toBe('stone'); expect(lo.get.res).toBe('wood');
    expect(lo.get.qty / lo.give.qty).toBeCloseTo(0.75, 2);

    // rng=1 -> spread = 1*(1 + (1-0.5)*2*0.25) = 1.25
    const hi = generateOffer(s, () => 1.0, { ...DEFAULT_TRADE_TUNING, sizePct: 0.10, biasK: 1 }, 1000)!;
    expect(hi.get.qty / hi.give.qty).toBeCloseTo(1.25, 2);
  });
});

describe('applyOffer', () => {
  function offerOn(s: IslandState, give: ResourceId, giveQty: number, get: ResourceId, getQty: number): TradeOffer {
    return { id: 'o1', islandId: s.id, give: { res: give, qty: giveQty }, get: { res: get, qty: getQty }, spawnedAt: 0, expiresAt: 1 };
  }

  it('subtracts give and adds get exactly', () => {
    const s = homeState();
    s.storageCaps.stone = 1000; s.inventory.stone = 500;
    s.storageCaps.wood = 1000; s.inventory.wood = 100;
    applyOffer(s, offerOn(s, 'stone', 50, 'wood', 40));
    expect(s.inventory.stone).toBe(450);
    expect(s.inventory.wood).toBe(140);
  });

  it('grants no XP', () => {
    const s = homeState();
    s.storageCaps.stone = 1000; s.inventory.stone = 500;
    s.storageCaps.wood = 1000; s.inventory.wood = 0;
    const xpBefore = s.xp;
    applyOffer(s, offerOn(s, 'stone', 50, 'wood', 40));
    expect(s.xp).toBe(xpBefore);
  });

  it('re-clamps when stock fell below the offer since spawn', () => {
    const s = homeState();
    s.storageCaps.stone = 1000; s.inventory.stone = 30;
    s.storageCaps.wood = 1000; s.inventory.wood = 0;
    const moved = applyOffer(s, offerOn(s, 'stone', 50, 'wood', 40));
    expect(s.inventory.stone).toBe(0);
    expect(s.inventory.wood).toBeCloseTo(40 * (30 / 50), 6);
    expect(moved.give).toBeCloseTo(30, 6);
  });

  it('re-clamps to output headroom', () => {
    const s = homeState();
    s.storageCaps.stone = 1000; s.inventory.stone = 500;
    s.storageCaps.wood = 100; s.inventory.wood = 90;
    applyOffer(s, offerOn(s, 'stone', 50, 'wood', 40));
    expect(s.inventory.wood).toBe(100);
  });
});

describe('signal exchange building', () => {
  it('exists as a cheap T1 logistics 1x1 building with no recipe, power, or storage', () => {
    const def = (BUILDING_DEFS as Record<string, any>)['signal_exchange'];
    expect(def).toBeDefined();
    expect(def.category).toBe('logistics');
    expect(def.tier).toBe(1);
    expect(def.recipe).toBeUndefined();
    expect(def.power).toBeUndefined();
    expect(def.storage).toBeUndefined();
    const total = Object.values(def.placementCost as Record<string, number>).reduce((a, b) => a + b, 0);
    expect(total).toBeLessThanOrEqual(110); // <= crate's 80+30
  });
});

describe('offer lifecycle', () => {
  function ready(): IslandState {
    const s = homeState();
    s.storageCaps.stone = 100; s.inventory.stone = 90;
    s.everProduced.add('stone'); s.everProduced.add('wood');
    s.storageCaps.wood = 100; s.inventory.wood = 5;
    s.buildings = [...s.buildings, { id: 'b-sx', defId: 'signal_exchange', x: 1, y: 1 }];
    return s;
  }

  it('detects the Signal Exchange building', () => {
    expect(islandHasSignalExchange(ready())).toBe(true);
    expect(islandHasSignalExchange(homeState())).toBe(false);
  });

  it('spawns at most one active offer per island and not before cadence', () => {
    const s = ready();
    const rt: TradeRuntime = { offers: [], nextSpawnAt: new Map() };
    const states = new Map([[s.id, s]]);
    tickTradeOffers(rt, states, Math.random, () => DEFAULT_TRADE_TUNING, 0);
    expect(rt.offers.filter((o) => o.islandId === s.id).length).toBe(1);
    tickTradeOffers(rt, states, Math.random, () => DEFAULT_TRADE_TUNING, 1000);
    expect(rt.offers.filter((o) => o.islandId === s.id).length).toBe(1);
  });

  it('expires offers past expiresAt', () => {
    const s = ready();
    const rt: TradeRuntime = { offers: [], nextSpawnAt: new Map() };
    const states = new Map([[s.id, s]]);
    tickTradeOffers(rt, states, Math.random, () => DEFAULT_TRADE_TUNING, 0);
    expect(rt.offers.length).toBe(1);
    tickTradeOffers(rt, states, Math.random, () => DEFAULT_TRADE_TUNING, 6 * 60 * 1000);
    expect(rt.offers.length).toBe(0);
  });

  it('does NOT respawn after expiry until the cadence has elapsed', () => {
    const s = ready();
    const rt: TradeRuntime = { offers: [], nextSpawnAt: new Map() };
    const states = new Map([[s.id, s]]);
    // t=0: one offer spawns; nextSpawnAt = 0 + 2h cadence.
    tickTradeOffers(rt, states, Math.random, () => DEFAULT_TRADE_TUNING, 0);
    expect(rt.offers.length).toBe(1);
    // t=6min: offer is past its 5-min expiry, pruned to zero.
    tickTradeOffers(rt, states, Math.random, () => DEFAULT_TRADE_TUNING, 6 * 60 * 1000);
    expect(rt.offers.length).toBe(0);
    // t=7min: still before the 2h cadence — nextSpawnAt gate blocks respawn.
    tickTradeOffers(rt, states, Math.random, () => DEFAULT_TRADE_TUNING, 7 * 60 * 1000);
    expect(rt.offers.length).toBe(0);
  });
});

describe('tuningFor', () => {
  const base = blankMultipliers();

  it('tradeFrequencyMul divides cadence', () => {
    expect(tuningFor({ ...base, tradeFrequencyMul: 4 }).cadenceMs).toBe(DEFAULT_TRADE_TUNING.cadenceMs / 4);
  });

  it('tradeSizeMul multiplies sizePct', () => {
    expect(tuningFor({ ...base, tradeSizeMul: 3 }).sizePct).toBeCloseTo(DEFAULT_TRADE_TUNING.sizePct * 3, 9);
  });

  it('tradeReachAdd adds (rounded) to maxReach', () => {
    expect(tuningFor({ ...base, tradeReachAdd: 1 }).maxReach).toBe(DEFAULT_TRADE_TUNING.maxReach + 1);
  });

  it('tradeSpreadShiftAdd adds to spreadShift', () => {
    expect(tuningFor({ ...base, tradeSpreadShiftAdd: 0.08 }).spreadShift).toBeCloseTo(0.08, 9);
  });

  it('clamps a <1 frequency multiplier so cadence never lengthens', () => {
    expect(tuningFor({ ...base, tradeFrequencyMul: 0.5 }).cadenceMs).toBe(DEFAULT_TRADE_TUNING.cadenceMs);
  });

  it('clamps a <1 size multiplier so volume never shrinks', () => {
    expect(tuningFor({ ...base, tradeSizeMul: 0.5 }).sizePct).toBe(DEFAULT_TRADE_TUNING.sizePct);
  });
});

describe('persisted trade-cadence fields', () => {
  it('makeInitialIslandState seeds tradeCooldownMs and tradeAcceptCount to 0', () => {
    const s = homeState();
    expect(s.tradeCooldownMs).toBe(0);
    expect(s.tradeAcceptCount).toBe(0);
  });
});

describe('effectiveCadenceMs', () => {
  it('returns the base cadence at zero accepts', () => {
    expect(effectiveCadenceMs(0, 1_000_000)).toBe(1_000_000);
  });

  it('compounds 1% faster per accept', () => {
    expect(effectiveCadenceMs(1, 1_000_000)).toBeCloseTo(990_000, 5);
    expect(effectiveCadenceMs(2, 1_000_000)).toBeCloseTo(980_100, 5);
  });

  it('roughly halves by ~69 accepts', () => {
    expect(effectiveCadenceMs(69, 1_000_000)).toBeLessThan(505_000);
    expect(effectiveCadenceMs(69, 1_000_000)).toBeGreaterThan(495_000);
  });

  it('never drops below FLOOR_MS no matter the accept count', () => {
    expect(effectiveCadenceMs(100_000, DEFAULT_TRADE_TUNING.cadenceMs)).toBe(FLOOR_MS);
    expect(FLOOR_MS).toBe(60_000);
  });

  it('exposes a positive online-dt cap', () => {
    expect(ONLINE_DT_CAP_MS).toBeGreaterThan(0);
  });
});
