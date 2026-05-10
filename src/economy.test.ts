// Tests for the event-driven economy tick loop.
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

import type { Building } from './buildings.js';
import {
  advanceIsland,
  computeRates,
  xpForLevel,
  type IslandState,
} from './economy.js';
import { ALL_RESOURCES, type ResourceId } from './recipes.js';

const MINE: Building = {
  kind: 'mine',
  x: 0,
  y: 0,
  width: 2,
  height: 2,
  fill: 0,
  stroke: 0,
  label: 'Mine',
};
const WORKSHOP: Building = {
  kind: 'workshop',
  x: 0,
  y: 0,
  width: 2,
  height: 2,
  fill: 0,
  stroke: 0,
  label: 'Workshop',
};

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

function makeState(over: Partial<IslandState> = {}): IslandState {
  return {
    id: 'test',
    buildings: [],
    inventory: blankInventory(),
    storageCaps: blankCaps(100),
    xp: 0,
    level: 1,
    unspentSkillPoints: 0,
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
    advanceIsland(state, 10_000);
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
    advanceIsland(state, 10_000);
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
    advanceIsland(state, 600_000);
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
    advanceIsland(state, 10_000);
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
    advanceIsland(state, 10_000);
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
    advanceIsland(state, 10_000);
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
    advanceIsland(state, 10_000);
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
    advanceIsland(state, 10_000);
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
    advanceIsland(state, 5_000);
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
    const { production, net } = computeRates(state);
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
    const { byBuilding } = computeRates(state);
    expect(byBuilding[0]?.effectiveRate).toBe(0);
  });

  it('zeroes building rate when outputAvail = 0', () => {
    const state = makeState({
      buildings: [MINE],
      inventory: { ...blankInventory(), iron_ore: 100 }, // at cap
    });
    const { byBuilding } = computeRates(state);
    expect(byBuilding[0]?.effectiveRate).toBe(0);
  });
});

// Building fixtures with §5.1 power fields. Mine and Workshop here override
// the un-powered MINE/WORKSHOP fixtures above so the original tests stay
// power-neutral; the new tests use these explicit-power versions.
const SOLAR: Building = {
  kind: 'solar',
  x: 0, y: 0, width: 1, height: 1,
  fill: 0, stroke: 0, label: 'Solar',
  power: { produces: 50 },
};
const COAL_GEN: Building = {
  kind: 'coal_gen',
  x: 0, y: 0, width: 2, height: 2,
  fill: 0, stroke: 0, label: 'Coal Gen',
  power: { produces: 100 },
};
const MINE_PWR: Building = { ...MINE, power: { consumes: 40 } };
const WORKSHOP_PWR: Building = { ...WORKSHOP, power: { consumes: 60 } };
// Heavier-draw Mine for the partial-brownout test.
const MINE_PWR_80: Building = { ...MINE, power: { consumes: 80 } };

describe('power (§5.1)', () => {
  it('powerFactor = 1 when there are no power consumers', () => {
    // Bare mine, no power field → unchanged behaviour.
    const state = makeState({
      buildings: [MINE],
      inventory: blankInventory(),
    });
    const { power, byBuilding } = computeRates(state);
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
    const { power, byBuilding } = computeRates(state);
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
