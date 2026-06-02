import { describe, expect, it } from 'vitest';
import { advanceIsland, type DefCatalog, type IslandState } from './economy.js';
import { BUILDING_DEFS, type BuildingDef, type BuildingDefId } from './building-defs.js';
import { attachTerrainAt, makeInitialIslandState } from './world.js';
import { generateOffer, applyOffer, DEFAULT_TRADE_TUNING, tierOf, type TradeOffer } from './trade.js';
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

  it('prices per-unit by weight ratio at Δtier 0 (spread center 1)', () => {
    const s = pair('stone', 'wood', 1000, 0, 100000);
    s.everProduced.clear(); s.everProduced.add('wood');
    const o = generateOffer(s, () => 0.5, { ...DEFAULT_TRADE_TUNING, sizePct: 0.10, biasK: 1, spreadShift: 0 }, 1000)!;
    const ratio = o.get.qty / o.give.qty;
    expect(ratio).toBeGreaterThan(0.7);
    expect(ratio).toBeLessThan(1.4);
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
