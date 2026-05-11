// Tests for the event-driven economy tick loop.
// (Step 11 also adds an integration test for artificial-island construction
// — placed at the end of this file alongside the chain/step-9 + spec-step-10
// integration tests.)

//
// These are the hard correctness tests for §15.3 piecewise integration:
//
//   - Cap stall: Mine fills iron_ore to exactly cap, not beyond. Demonstrates
//     `findNextCapEvent` honesty: a naive dt×rate over the full interval
//     would overshoot.
//   - Input-depletion back-propagation: Workshop stops consuming when coal
//     runs out at t=500s — does NOT keep eating iron_ore for the remaining
//     100s. Demonstrates `inputAvail = 0` cuts both output AND consumption.
//   - XP accrual proportional to PRODUCTION × xp_weight, not net flow.
//   - Level up when threshold crossed; skill points granted.

import { describe, expect, it } from 'vitest';

import { effectiveModifierMultipliers } from './biomes.js';
import { BUILDING_DEFS, type BuildingDef, type BuildingDefId } from './building-defs.js';
import type { PlacedBuilding } from './buildings.js';
import {
  advanceIsland,
  computeRates,
  xpForLevel,
  type DefCatalog,
  type IslandState,
} from './economy.js';
import { placeBuilding } from './placement.js';
import { ALL_RESOURCES, type ResourceId } from './recipes.js';
import { effectiveSpecializationMultipliers } from './specialization.js';
import { aggregateStorageCaps } from './world.js';

const MINE: PlacedBuilding = { id: 'b-mine', defId: 'mine', x: 0, y: 0 };
const WORKSHOP: PlacedBuilding = { id: 'b-workshop', defId: 'workshop', x: 0, y: 0 };

/** Test catalog where Mine and Workshop have NO power fields so the
 *  power-free test paths exercise the "no consumers" branch in
 *  computeRates. The production catalog (BUILDING_DEFS) gives both
 *  buildings their power-burn defaults; tests that need power-neutral
 *  behaviour swap to this one. */
function powerFreeCatalog(): DefCatalog {
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
const POWER_FREE: DefCatalog = powerFreeCatalog();

function blankInventory(): Record<ResourceId, number> {
  const inv = {} as Record<ResourceId, number>;
  for (const r of ALL_RESOURCES) inv[r] = 0;
  return inv;
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

function makeState(over: Partial<IslandState> = {}): IslandState {
  return {
    id: 'test',
    buildings: [],
    inventory: blankInventory(),
    storageCaps: blankCaps(100),
    xp: 0,
    level: 1,
    unspentSkillPoints: 0,
    unlockedNodes: new Set(),
    subPathProgress: new Map(),
    funnelPending: blankFunnel(),
    specializationRole: null,
    declaredAt: null,
    aiCoreCrafted: false,
    lastTick: 0,
    ...over,
  };
}

describe('advanceIsland — event-driven piecewise integration', () => {
  it('fills iron_ore to cap exactly, not beyond, with cap event at t=5s', () => {
    // Mine produces 1 iron_ore / 5s = 0.2/s. Start iron_ore = 99, cap = 100.
    // Headroom = 1, time to fill = 1 / 0.2 = 5s. After 10s the Mine should
    // have produced 1 unit then stalled for 5s.
    const state = makeState({
      buildings: [MINE],
      inventory: { ...blankInventory(), iron_ore: 99 },
    });
    advanceIsland(state, 10_000, { defs: POWER_FREE });
    expect(state.inventory.iron_ore).toBeCloseTo(100, 9);
    // Cap is a hard ceiling, not just an integer floor — verify no overshoot.
    expect(state.inventory.iron_ore).toBeLessThanOrEqual(100);
    expect(state.lastTick).toBe(10_000);
  });

  it('Mine alone over 10s starting at 0 produces 2 iron_ore (rate 0.2/s, no cap)', () => {
    // Sanity check on the base rate without cap interference.
    const state = makeState({
      buildings: [MINE],
      inventory: { ...blankInventory() },
    });
    advanceIsland(state, 10_000, { defs: POWER_FREE });
    expect(state.inventory.iron_ore).toBeCloseTo(2, 9);
  });

  it('back-propagates input depletion: Workshop stops eating iron_ore when coal hits 0', () => {
    // Mine: +0.2 iron_ore/s. Workshop: -0.1 iron_ore/s, -0.1 coal/s, +0.1 bolt/s.
    // Net iron_ore: +0.1/s. Net coal: -0.1/s. Coal starts at 50, hits 0 at t=500s.
    // From t=500s, Workshop stalls (inputAvail=0). Mine keeps running.
    //
    // Over 600s total:
    //   t=0..500s: Mine + Workshop, iron_ore += 0.1 * 500 = 50, bolt += 0.1*500 = 50,
    //              coal -= 0.1*500 = 50 (= 0)
    //   t=500..600s: Workshop stalled, Mine alone, iron_ore += 0.2 * 100 = 20
    //   final: iron_ore = 70, coal = 0, bolt = 50.
    const state = makeState({
      buildings: [MINE, WORKSHOP],
      inventory: { ...blankInventory(), coal: 50 },
    });
    advanceIsland(state, 600_000, { defs: POWER_FREE });
    expect(state.inventory.iron_ore).toBeCloseTo(70, 6);
    expect(state.inventory.coal).toBeCloseTo(0, 6);
    expect(state.inventory.bolt).toBeCloseTo(50, 6);
  });

  it('cap-stalled building also stops consuming inputs (back-propagation per §4.6)', () => {
    // Workshop produces bolt. Start bolt at cap (100). Workshop should be
    // fully stalled: outputAvail = 0 → effective rate = 0 → iron_ore and
    // coal are NOT consumed.
    const state = makeState({
      buildings: [WORKSHOP],
      inventory: {
        ...blankInventory(),
        iron_ore: 50,
        coal: 50,
        bolt: 100, // at cap
      },
    });
    advanceIsland(state, 10_000, { defs: POWER_FREE });
    expect(state.inventory.iron_ore).toBe(50); // untouched
    expect(state.inventory.coal).toBe(50); // untouched
    expect(state.inventory.bolt).toBe(100); // still at cap
    // No production → no XP
    expect(state.xp).toBe(0);
  });

  it('Workshop stalls immediately when iron_ore is 0 and coal is plentiful', () => {
    // inputAvail = 0 even with one missing input.
    const state = makeState({
      buildings: [WORKSHOP],
      inventory: { ...blankInventory(), coal: 50, iron_ore: 0 },
    });
    advanceIsland(state, 10_000, { defs: POWER_FREE });
    expect(state.inventory.coal).toBe(50); // not eaten
    expect(state.inventory.bolt).toBe(0); // none produced
  });
});

describe('XP accrual', () => {
  it('accrues XP proportional to production × xp_weight × time', () => {
    // Mine produces 0.2 iron_ore/s. iron_ore xp_weight = 1.
    // Over 10s: 0.2 * 1 * 10 = 2 XP.
    const state = makeState({
      buildings: [MINE],
      inventory: blankInventory(),
    });
    advanceIsland(state, 10_000, { defs: POWER_FREE });
    expect(state.xp).toBeCloseTo(2, 9);
  });

  it('weights bolt production at 10× iron_ore (xp_weight: bolt=10, iron_ore=1)', () => {
    // Mine + Workshop, plenty of coal. Over 10s:
    //   gross iron_ore production: 0.2/s × 10 = 2 units, xp_weight 1 → 2 XP
    //   gross bolt production: 0.1/s × 10 = 1 unit, xp_weight 10 → 10 XP
    //   total = 12 XP
    // Note: Workshop CONSUMES 1 unit iron_ore (Mine produces 2, net iron_ore
    // = 1). XP weighs GROSS production = 2, not net = 1.
    const state = makeState({
      buildings: [MINE, WORKSHOP],
      inventory: { ...blankInventory(), coal: 50 },
    });
    advanceIsland(state, 10_000, { defs: POWER_FREE });
    expect(state.xp).toBeCloseTo(12, 6);
    // And verify the inventory looks right: iron_ore net = +0.1/s × 10 = 1
    expect(state.inventory.iron_ore).toBeCloseTo(1, 6);
    expect(state.inventory.bolt).toBeCloseTo(1, 6);
    expect(state.inventory.coal).toBeCloseTo(49, 6);
  });

  it('stalled buildings earn zero XP', () => {
    const state = makeState({
      buildings: [WORKSHOP],
      inventory: { ...blankInventory(), iron_ore: 0, coal: 50 }, // workshop stalls
    });
    advanceIsland(state, 10_000, { defs: POWER_FREE });
    expect(state.xp).toBe(0);
  });
});

describe('Level up', () => {
  it('levels up when XP threshold is crossed and grants a skill point', () => {
    // xp_for_level_2 = 100 * 2^2.2 ≈ 459.48 (placeholder per §9.1).
    const threshold = xpForLevel(2);
    expect(threshold).toBeCloseTo(459.48, 0);
    // Mine alone earns 0.2 XP/s. We can't easily run a Mine that long in a
    // test without coupling to the time formula, so jam XP in directly via
    // a state that's pre-loaded — the levelUp routine runs inside
    // advanceIsland, so we trigger it with one tick that produces > threshold.
    //
    // Easier: 200 Workshops (which we can't actually build) wouldn't be
    // realistic. Use a fast hack: start xp just under threshold and advance
    // 5s with the Mine. Mine gain: 0.2 × 5 = 1 XP → push over threshold.
    const state = makeState({
      buildings: [MINE],
      inventory: blankInventory(),
      xp: threshold - 0.5,
    });
    advanceIsland(state, 5_000, { defs: POWER_FREE });
    expect(state.level).toBe(2);
    expect(state.unspentSkillPoints).toBe(1);
    expect(state.xp).toBeGreaterThanOrEqual(0);
    expect(state.xp).toBeLessThan(xpForLevel(3));
  });

  it('handles multiple level-ups in one segment (XP cascade)', () => {
    // Pre-load enough XP to skip several levels at once. The loop should
    // unwind them all without re-running advanceIsland.
    const need = xpForLevel(2) + xpForLevel(3) + xpForLevel(4);
    const state = makeState({
      buildings: [],
      inventory: blankInventory(),
      xp: need,
    });
    advanceIsland(state, 1);
    expect(state.level).toBe(4);
    expect(state.unspentSkillPoints).toBe(3);
    expect(state.xp).toBeCloseTo(0, 6);
  });
});

describe('computeRates', () => {
  it('returns gross production and net rates correctly', () => {
    const state = makeState({
      buildings: [MINE, WORKSHOP],
      inventory: { ...blankInventory(), coal: 50 },
    });
    const { production, net } = computeRates(state, { defs: POWER_FREE });
    expect(production.iron_ore).toBeCloseTo(0.2, 9);
    expect(production.bolt).toBeCloseTo(0.1, 9);
    expect(net.iron_ore).toBeCloseTo(0.1, 9); // +0.2 - 0.1
    expect(net.coal).toBeCloseTo(-0.1, 9);
    expect(net.bolt).toBeCloseTo(0.1, 9);
  });

  it('zeroes building rate when inputAvail = 0', () => {
    const state = makeState({
      buildings: [WORKSHOP],
      inventory: { ...blankInventory(), iron_ore: 0, coal: 50 },
    });
    const { byBuilding } = computeRates(state, { defs: POWER_FREE });
    expect(byBuilding[0]?.effectiveRate).toBe(0);
  });

  it('zeroes building rate when outputAvail = 0', () => {
    const state = makeState({
      buildings: [MINE],
      inventory: { ...blankInventory(), iron_ore: 100 }, // at cap
    });
    const { byBuilding } = computeRates(state, { defs: POWER_FREE });
    expect(byBuilding[0]?.effectiveRate).toBe(0);
  });
});

// Building fixtures with §5.1 power fields. SOLAR and COAL_GEN inherit
// their power values from BUILDING_DEFS. Mine and Workshop pick up the
// production defs' 40W / 60W consumes via the production catalog. The
// heavier-draw MINE_PWR_80 needs a one-off catalog where mine consumes 80W.
const SOLAR: PlacedBuilding = { id: 'b-solar', defId: 'solar', x: 0, y: 0 };
const COAL_GEN: PlacedBuilding = { id: 'b-coal-gen', defId: 'coal_gen', x: 0, y: 0 };
const MINE_PWR: PlacedBuilding = MINE; // mine def already consumes 40W
const WORKSHOP_PWR: PlacedBuilding = WORKSHOP; // workshop def already consumes 60W
const MINE_PWR_80: PlacedBuilding = { id: 'b-mine-80', defId: 'mine', x: 0, y: 0 };

/** Catalog with a heavier Mine (80W) for the partial-brownout fixture. */
function mineHeavyCatalog(): DefCatalog {
  const base = { ...BUILDING_DEFS } as Record<BuildingDefId, BuildingDef>;
  base.mine = { ...base.mine, power: { consumes: 80 } };
  return base;
}
const MINE_HEAVY: DefCatalog = mineHeavyCatalog();

describe('power (§5.1)', () => {
  it('powerFactor = 1 when there are no power consumers', () => {
    // Bare mine, no power field → unchanged behaviour.
    const state = makeState({
      buildings: [MINE],
      inventory: blankInventory(),
    });
    const { power, byBuilding } = computeRates(state, { defs: POWER_FREE });
    expect(power.produced).toBe(0);
    expect(power.consumed).toBe(0);
    expect(power.factor).toBe(1);
    expect(byBuilding[0]?.effectiveRate).toBeCloseTo(0.2, 9); // mine 1/5s
  });

  it('powerFactor = 1 when supply meets demand (Solar + Coal Gen feed Mine + Workshop)', () => {
    // 50 + 100 = 150W produced; 40 + 60 = 100W consumed → factor = 1.
    const state = makeState({
      buildings: [SOLAR, COAL_GEN, MINE_PWR, WORKSHOP_PWR],
      inventory: { ...blankInventory(), coal: 50 },
    });
    const { power, byBuilding, net } = computeRates(state);
    expect(power.produced).toBe(150);
    expect(power.consumed).toBe(100);
    expect(power.factor).toBe(1);
    // Mine still at full 0.2/s, Workshop at full 0.1/s.
    const mineRate = byBuilding.find((r) => r.building === MINE_PWR)?.effectiveRate;
    const wsRate = byBuilding.find((r) => r.building === WORKSHOP_PWR)?.effectiveRate;
    expect(mineRate).toBeCloseTo(0.2, 9);
    expect(wsRate).toBeCloseTo(0.1, 9);
    // Coal Gen also burns coal at 1/5s = 0.2/s nominally.
    expect(net.coal).toBeCloseTo(-0.1 - 0.2, 9); // workshop 0.1 + coal_gen 0.2
  });

  it('partial brownout: Coal Gen alone (100W) under-supplies Mine 80W + Workshop 60W → factor ≈ 0.714', () => {
    // P_produced = 100, P_consumed = 140, factor = 100/140 ≈ 0.7142857.
    const state = makeState({
      buildings: [COAL_GEN, MINE_PWR_80, WORKSHOP_PWR],
      inventory: { ...blankInventory(), coal: 50 },
    });
    const { power, byBuilding } = computeRates(state, { defs: MINE_HEAVY });
    expect(power.produced).toBe(100);
    expect(power.consumed).toBe(140);
    expect(power.factor).toBeCloseTo(100 / 140, 9);
    const expectedFactor = 100 / 140;
    const mineRate = byBuilding.find((r) => r.building === MINE_PWR_80)?.effectiveRate;
    const wsRate = byBuilding.find((r) => r.building === WORKSHOP_PWR)?.effectiveRate;
    expect(mineRate).toBeCloseTo(0.2 * expectedFactor, 9);
    expect(wsRate).toBeCloseTo(0.1 * expectedFactor, 9);
  });

  it('producer stalled (no fuel): Coal Gen drops out of P_produced when coal=0', () => {
    // Coal Gen has no coal AND no flow-through producer → inputAvail=0
    // → inactive → contributes 0 W. With ONLY Coal Gen as a power source
    // and no Solar, P_produced = 0. Add a Mine consumer (40W) → factor = 0.
    // (Workshop is omitted to avoid the shared-coal-pool conflict: with
    // coal=0, Workshop would also be inactive and drop out, defeating the
    // test of "factor < 1 because the producer stalled".)
    const state = makeState({
      buildings: [COAL_GEN, MINE_PWR],
      inventory: { ...blankInventory(), coal: 0, iron_ore: 50 },
    });
    const { power, byBuilding } = computeRates(state);
    expect(power.produced).toBe(0);
    expect(power.consumed).toBe(40);
    expect(power.factor).toBe(0); // 0/40 = 0
    const mineRate = byBuilding.find((r) => r.building === MINE_PWR)?.effectiveRate;
    expect(mineRate).toBe(0); // mine throttled to zero by powerFactor
  });

  it('Solar alone (50W) vs Mine + Workshop (100W) → factor = 0.5', () => {
    // Independent test: when only Solar produces (no coal_gen in scene),
    // 50W feeds 100W of demand. Both consumers throttled to 0.5×.
    const state = makeState({
      buildings: [SOLAR, MINE_PWR, WORKSHOP_PWR],
      inventory: { ...blankInventory(), coal: 50, iron_ore: 50 },
    });
    const { power, byBuilding } = computeRates(state);
    expect(power.produced).toBe(50);
    expect(power.consumed).toBe(100);
    expect(power.factor).toBe(0.5);
    const mineRate = byBuilding.find((r) => r.building === MINE_PWR)?.effectiveRate;
    const wsRate = byBuilding.find((r) => r.building === WORKSHOP_PWR)?.effectiveRate;
    expect(mineRate).toBeCloseTo(0.2 * 0.5, 9);
    expect(wsRate).toBeCloseTo(0.1 * 0.5, 9);
  });

  it('output-stalled consumer still draws power (lights on at full bin)', () => {
    // Mine has iron_ore at cap (output-stalled, recipe rate 0) but is still
    // active for §5.1 — its inputAvail is 1 (no inputs). It still counts
    // 40W toward P_consumed. With Solar 50W producing and Mine 40W +
    // Workshop 60W demanding = 100W → factor = 0.5. Workshop runs at half.
    const state = makeState({
      buildings: [SOLAR, MINE_PWR, WORKSHOP_PWR],
      inventory: {
        ...blankInventory(),
        iron_ore: 100, // mine at cap → output-stalled but still drawing power
        coal: 50,
      },
    });
    const { power, byBuilding } = computeRates(state);
    expect(power.produced).toBe(50);
    expect(power.consumed).toBe(100); // mine still counts, even output-stalled
    expect(power.factor).toBe(0.5);
    const mineRate = byBuilding.find((r) => r.building === MINE_PWR)?.effectiveRate;
    const wsRate = byBuilding.find((r) => r.building === WORKSHOP_PWR)?.effectiveRate;
    expect(mineRate).toBe(0); // output-stalled
    expect(wsRate).toBeCloseTo(0.1 * 0.5, 9); // half-rate
  });

  it('power_systems.1 unlocked: Coal Gen produces 105W instead of 100W', () => {
    const state = makeState({
      buildings: [COAL_GEN],
      inventory: { ...blankInventory(), coal: 50 },
      unlockedNodes: new Set(['power_systems.1']),
    });
    const { power } = computeRates(state);
    expect(power.produced).toBeCloseTo(105, 9);
  });

  it('Coal Gen with empty outputs is never output-stalled (cap doesn\'t apply)', () => {
    // The empty-outputs recipe path: no resource can be at cap because no
    // resource is produced. Coal Gen should remain active as long as it has
    // coal input. Verify with all inventories at cap except coal still > 0.
    const allCapsAtMax: Record<ResourceId, number> = {} as Record<ResourceId, number>;
    for (const r of ALL_RESOURCES) allCapsAtMax[r] = 100;
    const state = makeState({
      buildings: [COAL_GEN],
      inventory: { ...allCapsAtMax }, // every resource at cap including coal
    });
    const { power, byBuilding } = computeRates(state);
    // Coal Gen has inputAvail=1 (coal in stockpile), outputAvail=1 (no
    // outputs to be capped), so it's active and produces 100W.
    expect(power.produced).toBe(100);
    expect(power.consumed).toBe(0);
    expect(power.factor).toBe(1);
    const cgRate = byBuilding.find((r) => r.building === COAL_GEN)?.effectiveRate;
    expect(cgRate).toBeCloseTo(0.2, 9); // 1 cycle / 5s
  });
});

describe('skill-tree integration (§9.3)', () => {
  it('mining.1 unlocked: Mine produces iron_ore at 1.05× base rate', () => {
    // Base mine rate 0.2/s × 1.05 = 0.21/s.
    const state = makeState({
      buildings: [MINE],
      inventory: blankInventory(),
      unlockedNodes: new Set(['mining.1']),
    });
    const { production } = computeRates(state, { defs: POWER_FREE });
    expect(production.iron_ore).toBeCloseTo(0.21, 9);
  });

  it('mining.1 + mining.2 stacks multiplicatively: Mine rate × 1.155', () => {
    const state = makeState({
      buildings: [MINE],
      inventory: blankInventory(),
      unlockedNodes: new Set(['mining.1', 'mining.2']),
    });
    const { production } = computeRates(state, { defs: POWER_FREE });
    expect(production.iron_ore).toBeCloseTo(0.2 * 1.155, 9);
  });

  it('storage.1 unlocked: effective caps are 1.05× the nominal storageCaps map', () => {
    // Mine alone, iron_ore start at 100 (nominal cap). With storage.1 the
    // effective cap is 105 — there's headroom and the mine doesn't stall.
    const state = makeState({
      buildings: [MINE],
      inventory: { ...blankInventory(), iron_ore: 100 },
      unlockedNodes: new Set(['storage.1']),
    });
    advanceIsland(state, 10_000, { defs: POWER_FREE });
    // Mine ran for 10s before hitting the new cap (105). Time to fill from
    // 100 to 105 at 0.2/s = 25s; we ran 10s, so we picked up 2 units.
    expect(state.inventory.iron_ore).toBeCloseTo(102, 6);
  });
});

describe('funneling — consumption drains pending bonus XP credit (§10)', () => {
  it('drains funnel credit proportional to consumption, awards bonus XP', () => {
    // Workshop consumes 0.1 iron_ore/s + 0.1 coal/s, produces 0.1 bolt/s.
    // Production XP over 10s: 0.1 × 10 (bolt xp_weight) × 10s = 10.
    // Pre-seed funnelPending.iron_ore = 5 XP-units (as if a route had
    // delivered ~3.33 units of iron_ore — 3.33 × 1 (xp_weight) × 0.5
    // (bonus) = 1.67. We just stuff 5 directly here to test the drain
    // math without coupling to delivery-side multiplication.)
    // Over 10s the Workshop consumes 1 unit iron_ore. Bonus drained
    // per unit consumed = xp_weight[iron_ore] × 0.5 = 0.5 XP-units.
    // 1 unit consumed → 0.5 drained, leaving 4.5 in the pending balance,
    // and +0.5 added to total XP gain.
    const state = makeState({
      buildings: [WORKSHOP],
      inventory: { ...blankInventory(), iron_ore: 10, coal: 10 },
    });
    state.funnelPending.iron_ore = 5;
    advanceIsland(state, 10_000, { defs: POWER_FREE });
    // Production XP: 0.1 bolt/s × 10s × 10 (xp_weight) = 10.
    // + funnel-drain XP: 0.5.
    expect(state.xp).toBeCloseTo(10.5, 6);
    expect(state.funnelPending.iron_ore).toBeCloseTo(4.5, 6);
  });

  it('does not over-drain when credit is less than the bonus owed', () => {
    // Same setup but pending = 0.2 (small). Owed bonus over 10s consumption
    // would be 0.5; drain caps at 0.2 (the pending balance), and XP is
    // 10 (production) + 0.2 (drain).
    const state = makeState({
      buildings: [WORKSHOP],
      inventory: { ...blankInventory(), iron_ore: 10, coal: 10 },
    });
    state.funnelPending.iron_ore = 0.2;
    advanceIsland(state, 10_000, { defs: POWER_FREE });
    expect(state.xp).toBeCloseTo(10.2, 6);
    expect(state.funnelPending.iron_ore).toBeCloseTo(0, 6);
  });

  it('does not drain when no consumption (cap-stalled / no recipe)', () => {
    // Bolt at cap → workshop stalled, no consumption, funnel credit
    // untouched.
    const state = makeState({
      buildings: [WORKSHOP],
      inventory: { ...blankInventory(), iron_ore: 10, coal: 10, bolt: 100 },
    });
    state.funnelPending.iron_ore = 5;
    advanceIsland(state, 10_000, { defs: POWER_FREE });
    expect(state.funnelPending.iron_ore).toBeCloseTo(5, 6);
  });
});

describe('xpMul applies to funnel drain', () => {
  // research_beacon role has xpMul = 1.5, globalRecipeRate = 0.75.
  // Workshop with that role:
  //   - recipe rate × 0.75 → consumes iron_ore at 0.1 × 0.75 = 0.075/s
  //   - produces bolt at 0.1 × 0.75 = 0.075/s → production XP = 0.075 × 10 × 10s = 7.5
  //   - funnel drain over 10s: 0.075 × 10 = 0.75 units consumed
  //     → drain owed = 0.75 × xp_weight[iron_ore](1) × 0.5 = 0.375
  //     → after xpMul(1.5): 0.375 × 1.5 = 0.5625 bonus XP from drain
  //   - total XP = 7.5 × 1.5 (production) + 0.5625 (drain) = 11.25 + 0.5625 = 11.8125
  //
  // Baseline (no role, identity multipliers):
  //   - consumes iron_ore at 0.1/s → 1 unit consumed → drain = 1 × 1 × 0.5 = 0.5 bonus XP
  //   - production XP = 0.1 × 10 × 10s = 10; total = 10 + 0.5 = 10.5
  //
  // The drain component is larger for research_beacon (0.5625 vs 0.5) per UNIT
  // of funnelPending consumed — specifically the ratio of total XP gain from drain
  // between the two states reflects both the per-unit rate change AND the xpMul.
  it('research_beacon role: funnel drain is also scaled by xpMul (1.5×)', () => {
    const beaconMul = effectiveSpecializationMultipliers('research_beacon');
    // Baseline state (no role)
    const baseline = makeState({
      buildings: [WORKSHOP],
      inventory: { ...blankInventory(), iron_ore: 10, coal: 10 },
    });
    baseline.funnelPending.iron_ore = 50; // plenty, won't be fully drained
    advanceIsland(baseline, 10_000, { defs: POWER_FREE });
    // baseline production XP: 0.1 bolt/s × 10s × 10 = 10; drain: 0.5
    expect(baseline.xp).toBeCloseTo(10.5, 6);

    // research_beacon state
    const beacon = makeState({
      buildings: [WORKSHOP],
      inventory: { ...blankInventory(), iron_ore: 10, coal: 10 },
      specializationRole: 'research_beacon',
    });
    beacon.funnelPending.iron_ore = 50; // same large pool
    advanceIsland(beacon, 10_000, { defs: POWER_FREE, specMul: beaconMul, ncBuff: 1 });
    // production XP: 0.075/s × 10s × 10 × 1.5(xpMul) = 11.25
    // drain component: 0.75 units consumed × 1 × 0.5 × 1.5(xpMul) = 0.5625
    // total = 11.8125
    expect(beacon.xp).toBeCloseTo(11.8125, 6);
    // The drain alone (XP - production XP) is 1.5× larger per consumed unit
    // versus the baseline: beacon's drain = 0.5625, baseline drain = 0.5.
    // Both scale correctly with xpMul and per-rate differences.
    const baselineDrain = baseline.xp - 10; // baseline production = 10
    const beaconDrain = beacon.xp - 11.25;  // beacon production = 11.25
    // xpMul scaled the drain as well — beacon drain > baseline drain
    expect(beaconDrain).toBeGreaterThan(baselineDrain);
    expect(beaconDrain).toBeCloseTo(0.5625, 6);
    expect(baselineDrain).toBeCloseTo(0.5, 6);
  });
});

describe('modifier integration in computeRates / advanceIsland (§3.5)', () => {
  it('mineral_rich: extraction-tagged Mine runs at 1.25× base rate', () => {
    // Mine alone, no input dependencies. Base 0.2 iron_ore/s; with
    // mineral_rich (+25% extraction) the rate is 0.25/s. Over 10s with
    // headroom, that's 2.5 units (no cap interference at 100 cap).
    const state = makeState({
      buildings: [MINE],
      inventory: blankInventory(),
    });
    const mul = effectiveModifierMultipliers(['mineral_rich']);
    advanceIsland(state, 10_000, { modifierMul: mul, defs: POWER_FREE });
    expect(state.inventory.iron_ore).toBeCloseTo(2.5, 9);
  });

  it('cursed_storms: all recipes run at 0.90× base rate (global)', () => {
    // Mine alone. Base 0.2/s × 0.90 = 0.18/s. Over 10s = 1.8 units.
    const state = makeState({
      buildings: [MINE],
      inventory: blankInventory(),
    });
    const mul = effectiveModifierMultipliers(['cursed_storms']);
    advanceIsland(state, 10_000, { modifierMul: mul, defs: POWER_FREE });
    expect(state.inventory.iron_ore).toBeCloseTo(1.8, 9);
  });

  it('fertile: extraction +50% — Mine runs at 1.5× base', () => {
    const state = makeState({
      buildings: [MINE],
      inventory: blankInventory(),
    });
    const mul = effectiveModifierMultipliers(['fertile']);
    advanceIsland(state, 10_000, { modifierMul: mul, defs: POWER_FREE });
    expect(state.inventory.iron_ore).toBeCloseTo(3, 9);
  });

  it('stable: no-op multiplier — Mine runs at base 0.2/s', () => {
    const state = makeState({
      buildings: [MINE],
      inventory: blankInventory(),
    });
    const mul = effectiveModifierMultipliers(['stable']);
    advanceIsland(state, 10_000, { modifierMul: mul, defs: POWER_FREE });
    expect(state.inventory.iron_ore).toBeCloseTo(2, 9);
  });

  it('mineral_rich + cursed_storms compose: Mine at 0.2 × 1.25 × 0.9 = 0.225/s', () => {
    const state = makeState({
      buildings: [MINE],
      inventory: blankInventory(),
    });
    const mul = effectiveModifierMultipliers(['mineral_rich', 'cursed_storms']);
    advanceIsland(state, 10_000, { modifierMul: mul, defs: POWER_FREE });
    expect(state.inventory.iron_ore).toBeCloseTo(0.2 * 1.25 * 0.9 * 10, 9);
  });

  it('cursed_storms applies to non-extraction recipes too (Workshop manufacturing)', () => {
    // Workshop is `manufacturing` category — the global cursed_storms multiplier
    // should reach it even though `mineral_rich` (extraction-only) would not.
    // Workshop: 1 bolt / 10s with iron_ore + coal stocked. Base rate 0.1 bolt/s.
    // With cursed_storms: 0.09 bolt/s. Over 10s = 0.9 bolt produced.
    const state = makeState({
      buildings: [WORKSHOP],
      inventory: { ...blankInventory(), iron_ore: 10, coal: 10 },
    });
    const mul = effectiveModifierMultipliers(['cursed_storms']);
    advanceIsland(state, 10_000, { modifierMul: mul, defs: POWER_FREE });
    expect(state.inventory.bolt).toBeCloseTo(0.9, 9);
  });

  it('placeholder modifier (high_wind) does not change rates', () => {
    // Sanity check: placeholders contribute 1× and the result is identical
    // to the no-modifier path.
    const stateA = makeState({ buildings: [MINE], inventory: blankInventory() });
    const stateB = makeState({ buildings: [MINE], inventory: blankInventory() });
    advanceIsland(stateA, 10_000, { defs: POWER_FREE });
    advanceIsland(stateB, 10_000, { modifierMul: effectiveModifierMultipliers(['high_wind']), defs: POWER_FREE });
    expect(stateA.inventory.iron_ore).toBeCloseTo(stateB.inventory.iron_ore, 12);
  });

  it('computeRates with modifierMul matches advanceIsland integration', () => {
    // Direct computeRates with mineral_rich → byBuilding effectiveRate = 0.25.
    const state = makeState({
      buildings: [MINE],
      inventory: blankInventory(),
    });
    const mul = effectiveModifierMultipliers(['mineral_rich']);
    const { byBuilding, production } = computeRates(state, { modifierMul: mul, defs: POWER_FREE });
    expect(byBuilding[0]!.effectiveRate).toBeCloseTo(0.25, 9);
    expect(production.iron_ore).toBeCloseTo(0.25, 9);
  });
});

// -----------------------------------------------------------------------
// Step 9 — new chain + storage aggregation
// -----------------------------------------------------------------------

describe('step-9 chain — Smelter T1 + storage aggregation', () => {
  it('Smelter on home produces iron_ingot at 1/8s with iron_ore + coal stocked', () => {
    // Bare Smelter, no inputs deficit. Rate = 1 / 8s = 0.125/s. Over 10s
    // = 1.25 ingots produced; 1 of each input consumed per 8s → 1.25
    // each consumed over 10s.
    const SMELTER: PlacedBuilding = { id: 'b-smelter', defId: 'smelter', x: 0, y: 0 };
    // POWER_FREE only strips mine/workshop; smelter still consumes 50W per
    // its def. Use a custom catalog stripping smelter for this test.
    const noSmelterPower = ((): DefCatalog => {
      const base = { ...BUILDING_DEFS } as Record<BuildingDefId, BuildingDef>;
      const { power: _p, ...rest } = base.smelter;
      base.smelter = rest as BuildingDef;
      return base;
    })();
    const state = makeState({
      buildings: [SMELTER],
      inventory: { ...blankInventory(), iron_ore: 50, coal: 50 },
    });
    advanceIsland(state, 10_000, { defs: noSmelterPower });
    expect(state.inventory.iron_ingot).toBeCloseTo(1.25, 6);
    expect(state.inventory.iron_ore).toBeCloseTo(48.75, 6);
    expect(state.inventory.coal).toBeCloseTo(48.75, 6);
  });

  it('aggregateStorageCaps: Silo on an island raises every cap to 2100', () => {
    const buildings: PlacedBuilding[] = [
      { id: 't-silo', defId: 'silo', x: 0, y: 0 },
    ];
    const caps = aggregateStorageCaps(buildings);
    for (const r of ALL_RESOURCES) {
      expect(caps[r]).toBe(2100); // baseline 100 + silo 2000
    }
  });

  it('aggregateStorageCaps: no storage buildings → baseline 100 caps', () => {
    const caps = aggregateStorageCaps([
      { id: 'b-mine', defId: 'mine', x: 0, y: 0 },
    ]);
    for (const r of ALL_RESOURCES) expect(caps[r]).toBe(100);
  });

  it('aggregateStorageCaps: Crate + Silo + Tank stack additively (100 + 100 + 2000 + 2000)', () => {
    const caps = aggregateStorageCaps([
      { id: 't-crate', defId: 'crate', x: 0, y: 0 },
      { id: 't-silo', defId: 'silo', x: 2, y: 0 },
      { id: 't-tank', defId: 'tank', x: 4, y: 0 },
    ]);
    for (const r of ALL_RESOURCES) expect(caps[r]).toBe(4200);
  });
});

// -----------------------------------------------------------------------
// Step 10 — specialization roles + Network Consciousness
// -----------------------------------------------------------------------

describe('step-10 — specialization role integration (§9.4)', () => {
  it('foundry role: smelting × 1.5, manufacturing × 0.75', () => {
    // Smelter + Workshop on the same island. Foundry buffs smelting and
    // penalises manufacturing; the two effects are observable through
    // production rates after a 1s sample.
    const SMELTER: PlacedBuilding = { id: 'b-smelter', defId: 'smelter', x: 0, y: 0 };
    const WORK: PlacedBuilding = { id: 'b-work', defId: 'workshop', x: 0, y: 0 };
    // Power-free catalog for both — POWER_FREE strips mine/workshop only,
    // and the smelter ships with power.consumes. Strip both here for the test.
    const noPower = ((): DefCatalog => {
      const base = { ...BUILDING_DEFS } as Record<BuildingDefId, BuildingDef>;
      for (const id of ['smelter', 'workshop'] as const) {
        const def = base[id];
        const { power: _power, ...rest } = def;
        base[id] = rest as BuildingDef;
      }
      return base;
    })();
    const foundryMul = effectiveSpecializationMultipliers('foundry');
    const state = makeState({
      buildings: [SMELTER, WORK],
      // Plenty of inputs so neither stalls (Smelter wants iron_ore+coal,
      // Workshop wants iron_ore+coal). Use a big pool so 1s consumption
      // doesn't dent it.
      inventory: { ...blankInventory(), iron_ore: 1000, coal: 1000 },
      storageCaps: blankCaps(10000),
    });
    const { byBuilding } = computeRates(state, { defs: noPower, specMul: foundryMul, ncBuff: 1 });
    // Smelter base rate = 1/8 = 0.125/s. With foundry buff (×1.5) → 0.1875.
    // Workshop base rate = 1/10 = 0.1/s. With foundry penalty (×0.75) → 0.075.
    const smelterRate = byBuilding.find((b) => b.building.defId === 'smelter')!.effectiveRate;
    const workRate = byBuilding.find((b) => b.building.defId === 'workshop')!.effectiveRate;
    expect(smelterRate).toBeCloseTo(0.125 * 1.5, 9);
    expect(workRate).toBeCloseTo(0.1 * 0.75, 9);
  });

  it('research_beacon role: XP gain × 1.5, recipe rates × 0.75', () => {
    // Bare Mine. Base 0.2 iron_ore/s, weight 1 → 0.2 XP/s identity.
    // research_beacon: rate × 0.75 → 0.15 iron_ore/s; XP × 1.5 layered on
    // top of (production × weight). Expected XP over 10s = 0.15 × 1 × 10 × 1.5 = 2.25.
    const beaconMul = effectiveSpecializationMultipliers('research_beacon');
    const state = makeState({
      buildings: [MINE],
      inventory: blankInventory(),
      specializationRole: 'research_beacon',
    });
    advanceIsland(state, 10_000, { defs: POWER_FREE, specMul: beaconMul, ncBuff: 1 });
    // Production: 0.15/s × 10s = 1.5 iron_ore.
    expect(state.inventory.iron_ore).toBeCloseTo(1.5, 9);
    // XP: 1.5 (units) × 1 (weight) × 1.5 (xpMul) = 2.25.
    expect(state.xp).toBeCloseTo(2.25, 9);
  });

  it('NC buff +5% applies to T3+ island production but NOT to T1 island', () => {
    // Two identical bare Mines, one at level 1 (T1, no NC buff) and one at
    // level 15 (T3, the buff applies). Caller is responsible for gating —
    // we simulate the same gating advanceIsland would see by passing
    // ncBuff=1.05 to the T3 state and ncBuff=1.0 to the T1 state.
    const NC_BUFF = 1.05;
    const t1 = makeState({
      buildings: [MINE],
      inventory: blankInventory(),
      level: 1, // T1
    });
    const t3 = makeState({
      buildings: [MINE],
      inventory: blankInventory(),
      level: 15, // T3
    });
    // T1: caller passes ncBuff = 1 (gate closed).
    advanceIsland(t1, 10_000, { defs: POWER_FREE, ncBuff: 1 });
    // T3: caller passes ncBuff = 1.05 (gate open).
    advanceIsland(t3, 10_000, { defs: POWER_FREE, ncBuff: NC_BUFF });
    // Mine produces 1 iron_ore / 5s = 0.2/s. T1 over 10s = 2.0 units; T3
    // over 10s = 2.0 × 1.05 = 2.1 units.
    expect(t1.inventory.iron_ore).toBeCloseTo(2.0, 9);
    expect(t3.inventory.iron_ore).toBeCloseTo(2.1, 9);
  });
});

// -----------------------------------------------------------------------
// Step 12 — T4 endgame production integration (§6.5 / §9.5)
// -----------------------------------------------------------------------

describe('step-12 — T4 endgame production integration (§6.5)', () => {
  it('Pyroforge on a synthetic volcanic spec produces exotic_alloy at 1/60s base rate', () => {
    // Pyroforge recipe: 60s cycle, inputs { steel: 5, helium_3: 1 },
    // outputs { exotic_alloy: 1 }. With sufficient inputs and ample
    // headroom, rate = 1/60 = 0.01667/s. Over 600s = 10 cycles → 10
    // exotic_alloy produced, 50 steel + 10 helium_3 consumed.
    //
    // Power-free catalog: pyroforge nominally consumes 800W. To isolate
    // the production rate we strip its power field — power is its own
    // §5.1 system tested elsewhere.
    const PYROFORGE: PlacedBuilding = {
      id: 'b-pyroforge',
      defId: 'pyroforge',
      x: 0,
      y: 0,
    };
    const powerFreePyro = ((): DefCatalog => {
      const base = { ...BUILDING_DEFS } as Record<BuildingDefId, BuildingDef>;
      const { power: _p, ...rest } = base.pyroforge;
      base.pyroforge = rest as BuildingDef;
      return base;
    })();
    const state = makeState({
      buildings: [PYROFORGE],
      // Inputs sized for the test: 100 steel + 20 helium_3 covers many
      // cycles without running out. Big caps to avoid the cap-stall path.
      inventory: { ...blankInventory(), steel: 100, helium_3: 20 },
      storageCaps: blankCaps(10000),
    });
    advanceIsland(state, 600_000, { defs: powerFreePyro });
    // 600s × (1/60) = 10 exotic_alloy.
    expect(state.inventory.exotic_alloy).toBeCloseTo(10, 6);
    // 10 cycles × 5 steel = 50 consumed, 50 left.
    expect(state.inventory.steel).toBeCloseTo(50, 6);
    // 10 cycles × 1 helium_3 = 10 consumed, 10 left.
    expect(state.inventory.helium_3).toBeCloseTo(10, 6);
  });

  it('Cryogenic Compute Center on synthetic arctic spec produces ai_core at 1/90s', () => {
    // Cryogenic Compute Center: 90s cycle, inputs { steel: 3,
    // quantum_chip: 1 }, outputs { ai_core: 1 }. Over 900s = 10 cycles.
    const CRYO: PlacedBuilding = {
      id: 'b-cryo',
      defId: 'cryogenic_compute_center',
      x: 0,
      y: 0,
    };
    const powerFreeCryo = ((): DefCatalog => {
      const base = { ...BUILDING_DEFS } as Record<BuildingDefId, BuildingDef>;
      const { power: _p, ...rest } = base.cryogenic_compute_center;
      base.cryogenic_compute_center = rest as BuildingDef;
      return base;
    })();
    const state = makeState({
      buildings: [CRYO],
      inventory: { ...blankInventory(), steel: 100, quantum_chip: 20 },
      storageCaps: blankCaps(10000),
    });
    advanceIsland(state, 900_000, { defs: powerFreeCryo });
    expect(state.inventory.ai_core).toBeCloseTo(10, 6);
    // 10 cycles × 3 steel = 30 consumed.
    expect(state.inventory.steel).toBeCloseTo(70, 6);
    // 10 cycles × 1 quantum_chip = 10 consumed.
    expect(state.inventory.quantum_chip).toBeCloseTo(10, 6);
  });
});

// -----------------------------------------------------------------------
// Step 11 — artificial-island construction integration
// -----------------------------------------------------------------------

describe('step-11 — artificial-island construction integration (§2.5)', () => {
  it('founder Plains/T3 with sufficient materials constructs a Plains 4×4 artificial island', async () => {
    // Local import keeps the artificial-island module out of the file-level
    // import block where chain/step-9 tests live. Same vitest-supported
    // import-during-test pattern used by world.ts in step 8 demo wiring.
    const { computeConstructionCost, constructIsland } = await import('./artificial-island.js');
    const PC: PlacedBuilding = { id: 'pc-founder', defId: 'platform_constructor', x: 0, y: 0 };
    // Founder spec: level 15 (T3), one Platform Constructor.
    const founderSpec = {
      id: 'founder',
      biome: 'plains' as const,
      cx: 0,
      cy: 0,
      majorRadius: 14,
      minorRadius: 14,
      populated: true,
      discovered: true,
      buildings: [PC],
      modifiers: [],
    };
    const founderState = makeState({
      buildings: [PC],
      inventory: { ...blankInventory(), steel: 1000, iron_ingot: 1000, wood: 2000 },
      storageCaps: blankCaps(10000),
      level: 15,
    });
    const cost = computeConstructionCost({ biome: 'plains', majorRadius: 4, minorRadius: 4 });
    const result = constructIsland(
      founderState,
      founderSpec,
      { biome: 'plains', majorRadius: 4, minorRadius: 4 },
      { cx: 200, cy: 200 },
      'art-plains-1',
      0,
    );
    // Founder inventory deducted by exactly the cost.
    expect(founderState.inventory.steel).toBe(1000 - cost.steel);
    expect(founderState.inventory.iron_ingot).toBe(1000 - cost.iron_ingot);
    expect(founderState.inventory.wood).toBe(2000 - cost.wood);
    // New island spec/state correctly initialised.
    expect(result.newSpec.artificial).toBe(true);
    expect(result.newSpec.populated).toBe(true);
    expect(result.newSpec.biome).toBe('plains');
    expect(result.newState.level).toBe(1);
    expect(result.newState.id).toBe('art-plains-1');
  });
});

// -----------------------------------------------------------------------
// Step 2.5 — placement integration
// -----------------------------------------------------------------------

// -----------------------------------------------------------------------
// §8.1 tile-dependent Mine recipes
// -----------------------------------------------------------------------

describe('§8.1 — Mine output branches on tile via resolveRecipe', () => {
  it('Mine on a coal-tile spec produces coal at 1/5s (not iron_ore)', () => {
    // Synthetic Mine at (0,0) with a terrainAt closure returning 'coal' for
    // every footprint tile. resolveRecipe should select mine_on_coal →
    // output coal at 1/5s = 0.2/s. Over 10s = 2 units of coal, 0 iron_ore.
    // POWER_FREE strips the Mine's power.consumes so the rate isn't
    // throttled by powerFactor.
    const state = makeState({
      buildings: [MINE],
      inventory: blankInventory(),
    });
    advanceIsland(state, 10_000, {
      defs: POWER_FREE,
      terrainAt: () => 'coal',
    });
    expect(state.inventory.coal).toBeCloseTo(2, 9);
    expect(state.inventory.iron_ore).toBeCloseTo(0, 9);
  });

  it('Mine on an ore-tile spec produces iron_ore at 1/5s (mine_on_ore branch)', () => {
    // Same shape as above but terrainAt is all 'ore' — should match the
    // pre-tile-aware behaviour exactly: 2 iron_ore over 10s.
    const state = makeState({
      buildings: [MINE],
      inventory: blankInventory(),
    });
    advanceIsland(state, 10_000, {
      defs: POWER_FREE,
      terrainAt: () => 'ore',
    });
    expect(state.inventory.iron_ore).toBeCloseTo(2, 9);
    expect(state.inventory.coal).toBeCloseTo(0, 9);
  });

  it('Mine with no terrainAt falls back to RECIPES.mine (iron_ore)', () => {
    // Regression: legacy callers that don't pass `terrainAt` keep the
    // pre-tile-aware behaviour (Mine → iron_ore). This is the codepath
    // every existing economy test uses.
    const state = makeState({
      buildings: [MINE],
      inventory: blankInventory(),
    });
    advanceIsland(state, 10_000, { defs: POWER_FREE });
    expect(state.inventory.iron_ore).toBeCloseTo(2, 9);
    expect(state.inventory.coal).toBeCloseTo(0, 9);
  });

  it('Mine on a mixed ore+coal footprint picks the coal variant (any coal tile wins)', () => {
    // 4 footprint tiles, 1 of them coal — resolveRecipe should select the
    // mine_on_coal variant per the "any coal tile → coal recipe" tiebreak.
    const state = makeState({
      buildings: [MINE],
      inventory: blankInventory(),
    });
    advanceIsland(state, 10_000, {
      defs: POWER_FREE,
      // (1,1) is the bottom-right of the 2×2 anchored at (0,0).
      terrainAt: (x, y) => (x === 1 && y === 1 ? 'coal' : 'ore'),
    });
    expect(state.inventory.coal).toBeCloseTo(2, 9);
    expect(state.inventory.iron_ore).toBeCloseTo(0, 9);
  });
});

describe('step-2.5 — placement is recognised by the live economy', () => {
  it('placing a Smelter on a Plains spec makes computeRates see its iron_ingot recipe', () => {
    // Build a fresh Plains spec with no buildings, run computeRates → no
    // production. Then `placeBuilding` a Smelter (and a Mine to feed it),
    // seed iron_ore + coal, and verify computeRates now reports iron_ingot
    // production. The integration point under test: spec.buildings.push
    // is visible to the economy loop on the next call because
    // state.buildings is a live reference to the same array.
    const spec = {
      id: 'plains-test',
      biome: 'plains' as const,
      cx: 0,
      cy: 0,
      majorRadius: 14,
      minorRadius: 14,
      populated: true,
      discovered: true,
      // Fresh mutable array so placeBuilding can push.
      buildings: [] as PlacedBuilding[],
      modifiers: [],
    };
    // makeState's `buildings: []` overrides into a fresh array; we then
    // reassign so the state shares spec.buildings (mirroring makeInitialIslandState).
    const state = makeState({
      buildings: spec.buildings,
      // Seed iron_ore + coal so the Smelter recipe has inputs from inventory
      // (no Mine output flow-through needed for this test).
      inventory: { ...blankInventory(), iron_ore: 100, coal: 100 },
      storageCaps: blankCaps(10000),
      level: 5, // T1 unlocked; Smelter is T1
    });
    // Before placement: no recipes running.
    const before = computeRates(state, { defs: POWER_FREE });
    expect(before.production.iron_ingot ?? 0).toBe(0);

    // Place a Smelter at island origin.
    let counter = 0;
    const gen = (): string => `int-${++counter}`;
    placeBuilding(spec, state, 'smelter', 0, 0, 0, gen);
    expect(spec.buildings).toHaveLength(1);
    expect(state.buildings).toBe(spec.buildings); // live reference

    // After placement: Smelter (cycle 8s) produces 1 iron_ingot / 8s = 0.125/s.
    // POWER_FREE strips mine/workshop only; Smelter retains its power.consumes,
    // and the test state has no power producers, so powerFactor = 0 → effective
    // rate = 0. Strip Smelter's power too for this test.
    const noSmelterPower = ((): DefCatalog => {
      const base = { ...BUILDING_DEFS } as Record<BuildingDefId, BuildingDef>;
      const { power: _p, ...rest } = base.smelter;
      base.smelter = rest as BuildingDef;
      return base;
    })();
    const after = computeRates(state, { defs: noSmelterPower });
    expect(after.production.iron_ingot ?? 0).toBeCloseTo(0.125, 9);
    expect(after.byBuilding).toHaveLength(1);
    expect(after.byBuilding[0]!.building.defId).toBe('smelter');
  });
});
