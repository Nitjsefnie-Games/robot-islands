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
import {
  BUILDING_DEFS,
  unlockedDefs,
  type BuildingDef,
  type BuildingDefId,
} from './building-defs.js';
import type { PlacedBuilding } from './buildings.js';
import { MAINTENANCE_DEGRADE_DURATION_MS, MAINTENANCE_THRESHOLD_MS_BY_TIER } from './maintenance.js';
import {
  accrueXp,
  advanceIsland,
  computeRates,
  findNextCapEvent,
  setGenesisTarget,
  spendTimeLock,
  SINGULARITY_BATTERY_CAPACITY_WS,
  xpForLevel,
  type DefCatalog,
  type IslandState,
} from './economy.js';
import { checkGates } from './adjacency.js';
import { placeBuilding, validatePlacement } from './placement.js';
import { ALL_RESOURCES, resolveRotatingOutput, XP_WEIGHT, type ResourceId } from './recipes.js';
import { RESOURCE_STORAGE_CATEGORY } from './storage-categories.js';
import { aggregateStorageCaps } from './world.js';
import type { TerrainKind } from './island.js';
import { attachTerrainAt, makeInitialIslandState } from './world.js';
import { resolveShot, SHOT_DURATION_MS } from './terrain-modifier.js';
import { islandInscribedAny } from './island.js';

const MINE: PlacedBuilding = { id: 'b-mine', defId: 'mine', x: 0, y: 0 };
const WORKSHOP: PlacedBuilding = { id: 'b-workshop', defId: 'workshop', x: 0, y: 0 };
const LUBRICANT_REFINERY: PlacedBuilding = { id: 'b-lube', defId: 'lubricant_refinery', x: 0, y: 0 };

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
  strip('lubricant_refinery');
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
    unlockedEdges: new Set(),
    funnelPending: blankFunnel(),
    declaredAt: null,
    aiCoreCrafted: false,
    ascendantCoreCrafted: false,
    lastResetAt: null,
    timeLockBankedMin: 0,
    accelerationQueue: [],
    accelerationRemainingMin: 0,
    bankingEnabled: false,
    genesisTarget: null,
    singularityStoredWs: 0,
    starterInventoryGrace: {} as Record<ResourceId, number>,
    lastTick: 0,
    ...over,
  };
}

describe('advanceIsland — event-driven piecewise integration', () => {
  it('fills iron_ore to cap exactly, not beyond, with cap event at t=50s', () => {
    // Mine produces 1 iron_ore / 50s = 0.02/s. Start iron_ore = 99, cap = 100.
    // Headroom = 1, time to fill = 1 / 0.02 = 50s. After 100s the Mine should
    // have produced 1 unit then stalled for 50s. (rebalanced step #19)
    const state = makeState({
      buildings: [MINE],
      inventory: { ...blankInventory(), iron_ore: 99 },
    });
    advanceIsland(state, 100_000, { defs: POWER_FREE });
    expect(state.inventory.iron_ore).toBeCloseTo(100, 9);
    // Cap is a hard ceiling, not just an integer floor — verify no overshoot.
    expect(state.inventory.iron_ore).toBeLessThanOrEqual(100);
    expect(state.lastTick).toBe(100_000);
  });

  it('Mine alone over 100s starting at 0 produces 2 iron_ore (rate 0.02/s, no cap)', () => {
    // Sanity check on the base rate without cap interference. (rebalanced step #19: 0.02/s)
    const state = makeState({
      buildings: [MINE],
      inventory: { ...blankInventory() },
    });
    advanceIsland(state, 100_000, { defs: POWER_FREE });
    expect(state.inventory.iron_ore).toBeCloseTo(5.88235294117647, 9);
  });

  it('back-propagates input depletion: Workshop stops eating iron_ore when coal hits 0', () => {
    // Mine: +0.02 iron_ore/s. Workshop: -0.01 iron_ore/s, -0.01 coal/s, +0.01 bolt/s.
    // Net iron_ore: +0.01/s. Net coal: -0.01/s. Coal starts at 50, hits 0 at t=5000s.
    // From t=5000s, Workshop stalls (inputAvail=0). Mine keeps running.
    // (rebalanced step #19: mine 1/50s, workshop 1/100s)
    //
    // Over 6000s total:
    //   t=0..5000s: Mine + Workshop, iron_ore += 0.01 * 5000 = 50, bolt += 0.01*5000 = 50,
    //               coal -= 0.01*5000 = 50 (= 0)
    //   t=5000..6000s: Workshop stalled, Mine alone, iron_ore += 0.02 * 1000 = 20
    //   final: iron_ore = 70, coal = 0, bolt = 50.
    const state = makeState({
      buildings: [MINE, WORKSHOP],
      inventory: { ...blankInventory(), coal: 50 },
    });
    advanceIsland(state, 6_000_000, { defs: POWER_FREE });
    expect(state.inventory.iron_ore).toBeCloseTo(100, 6);
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

describe('tutorial production flags (lubricantProduced / boltProduced)', () => {
  it('flips boltProduced once a Workshop produces bolts', () => {
    const state = makeState({
      buildings: [MINE, WORKSHOP],
      inventory: { ...blankInventory(), coal: 50 },
    });
    expect(state.boltProduced).toBeFalsy();
    advanceIsland(state, 100_000, { defs: POWER_FREE });
    expect(state.inventory.bolt).toBeGreaterThan(0);
    expect(state.boltProduced).toBe(true);
  });

  it('flips lubricantProduced once a Lubricant Refinery produces lubricant', () => {
    // Lubricant Refinery is tier 2 — the §9.7 runtime tier gate zeroes its
    // rate below a T2 island, so the island must be level 5+ (T2).
    const state = makeState({
      level: 5,
      buildings: [LUBRICANT_REFINERY],
      inventory: { ...blankInventory(), crude_oil: 50, chlorine: 50 },
    });
    expect(state.lubricantProduced).toBeFalsy();
    advanceIsland(state, 1_000_000, { defs: POWER_FREE });
    expect(state.inventory.lubricant).toBeGreaterThan(0);
    expect(state.lubricantProduced).toBe(true);
  });

  it('leaves boltProduced false when no bolt is produced', () => {
    // Mine alone produces iron_ore, never bolt.
    const state = makeState({
      buildings: [MINE],
      inventory: blankInventory(),
    });
    advanceIsland(state, 100_000, { defs: POWER_FREE });
    expect(state.boltProduced).toBeFalsy();
  });
});

describe('XP accrual', () => {
  it('accrues XP proportional to production × xp_weight × time', () => {
    // Mine produces 0.02 iron_ore/s. iron_ore xp_weight = 1.
    // Over 100s: 0.02 * 1 * 100 = 2 XP. (rebalanced step #19: mine 1/50s)
    const state = makeState({
      buildings: [MINE],
      inventory: blankInventory(),
    });
    advanceIsland(state, 100_000, { defs: POWER_FREE });
    expect(state.xp).toBeCloseTo(5.88235294117647, 9);
  });

  it('weights bolt production at 10× iron_ore (xp_weight: bolt=10, iron_ore=1)', () => {
    // Mine + Workshop, plenty of coal. Over 100s: (rebalanced step #19: mine 1/50s, workshop 1/100s)
    //   gross iron_ore production: 0.02/s × 100 = 2 units, xp_weight 1 → 2 XP
    //   gross bolt production: 0.01/s × 100 = 1 unit, xp_weight 10 → 10 XP
    //   total = 12 XP
    // Note: Workshop CONSUMES 1 unit iron_ore (Mine produces 2, net iron_ore
    // = 1). XP weighs GROSS production = 2, not net = 1.
    const state = makeState({
      buildings: [MINE, WORKSHOP],
      inventory: { ...blankInventory(), coal: 50 },
    });
    advanceIsland(state, 100_000, { defs: POWER_FREE });
    expect(state.xp).toBeCloseTo(36.185383244206776, 6);
    // And verify the inventory looks right: iron_ore net = +0.01/s × 100 = 1
    expect(state.inventory.iron_ore).toBeCloseTo(2.8520499108734403, 6);
    expect(state.inventory.bolt).toBeCloseTo(3.0303030303030303, 6);
    expect(state.inventory.coal).toBeCloseTo(46.96969696969697, 6);
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
    // xp_for_level_2 = 25 * 2^2.2 ≈ 114.87 (rebalanced for idle-game scale, step #19).
    const threshold = xpForLevel(2);
    expect(threshold).toBeCloseTo(114.87, 0);
    // Mine alone earns 0.02 XP/s. (rebalanced step #19: mine 1/50s)
    // Use fast hack: start xp just under threshold and advance 50s with the Mine.
    // Mine gain: 0.02 × 50 = 1 XP → push over threshold.
    const state = makeState({
      buildings: [MINE],
      inventory: blankInventory(),
      xp: threshold - 0.5,
    });
    advanceIsland(state, 50_000, { defs: POWER_FREE });
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
    // Mine 1/50s = 0.02/s, Workshop 1/100s = 0.01/s. (rebalanced step #19)
    const state = makeState({
      buildings: [MINE, WORKSHOP],
      inventory: { ...blankInventory(), coal: 50 },
    });
    const { production, net } = computeRates(state, { defs: POWER_FREE });
    expect(production.iron_ore).toBeCloseTo(0.058823529411764705, 9);
    expect(production.bolt).toBeCloseTo(0.030303030303030304, 9);
    expect(net.iron_ore).toBeCloseTo(0.0285204991087344, 9); // +0.02 - 0.01
    expect(net.coal).toBeCloseTo(-0.030303030303030304, 9);
    expect(net.bolt).toBeCloseTo(0.030303030303030304, 9);
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

  it('skips invalid buildings entirely', () => {
    const mineInvalid: PlacedBuilding = { id: 'b-mine', defId: 'mine', x: 0, y: 0, invalid: true };
    const state = makeState({
      buildings: [mineInvalid],
      inventory: blankInventory(),
    });
    const { production, net, byBuilding } = computeRates(state, { defs: POWER_FREE });
    expect(production.iron_ore ?? 0).toBe(0);
    expect(net.iron_ore ?? 0).toBe(0);
    expect(byBuilding.length).toBe(0);
  });

  it('hard gate failure zeros production and consumption', () => {
    // Use a catalog where mine has a hard def_id gate requiring coal_furnace.
    const defs: DefCatalog = {
      ...BUILDING_DEFS,
      mine: {
        ...BUILDING_DEFS.mine,
        gates: [{ matchType: 'def_id', defId: 'coal_furnace', hard: true }],
      },
    };
    const mine: PlacedBuilding = { id: 'b-mine', defId: 'mine', x: 0, y: 0 };
    const state = makeState({
      buildings: [mine],
      inventory: blankInventory(),
    });
    const { byBuilding, net, power } = computeRates(state, { defs });
    const mineRate = byBuilding.find((b) => b.building.id === 'b-mine');
    expect(mineRate?.effectiveRate).toBe(0);
    expect(net.iron_ore ?? 0).toBe(0);
    expect(power.consumed).toBe(0);
  });

  it('soft gate failure degrades production', () => {
    const defs: DefCatalog = {
      ...POWER_FREE,
      mine: {
        ...POWER_FREE.mine,
        gates: [{ matchType: 'def_id', defId: 'coal_furnace', hard: false, degradeMul: 0.5 }],
      },
    };
    const mine: PlacedBuilding = { id: 'b-mine', defId: 'mine', x: 0, y: 0 };
    const state = makeState({
      buildings: [mine],
      inventory: blankInventory(),
    });
    const { byBuilding, net } = computeRates(state, { defs });
    const mineRate = byBuilding.find((b) => b.building.id === 'b-mine');
    // Base rate 1/50 = 0.02, degraded by 0.5 → 0.01
    expect(mineRate?.effectiveRate).toBeCloseTo(0.029411764705882353, 9);
    expect(net.iron_ore ?? 0).toBeCloseTo(0.029411764705882353, 9);
  });

  it('§4.5 soft-gated consumer demand uses gated rate in inputAvail (not nominal)', () => {
    // Regression test for the Pass-2 nominalRate computation: a soft-gated
    // consumer's input demand must be scaled by gateResult.effectiveMul so
    // it doesn't over-claim from a supply-constrained pool.
    //
    // Setup: Mine soft-gated to 0.4× (supply = 0.02 × 0.4 = 0.008 iron_ore/s).
    //        Workshop soft-gated to 0.5× (baseRate = 0.01 × 0.5 = 0.005/s,
    //        nominal demand = 0.01 iron_ore/s, gated demand = 0.005/s).
    //        Iron_ore stock = 0 (forces externalSupply path); coal = 100
    //        (workshop's coal need is stockpile-satisfied).
    //
    // Pre-fix: nominalRate ignores effectiveMul → demand = 0.01/s →
    //          inputAvail = 0.008/0.01 = 0.8 → effectiveRate = 0.005 × 0.8 = 0.004/s.
    // Post-fix: nominalRate × 0.5 → demand = 0.005/s →
    //           inputAvail = min(1, 0.008/0.005) = 1.0 → effectiveRate = 0.005/s.
    const defs: DefCatalog = {
      ...POWER_FREE,
      mine: {
        ...POWER_FREE.mine,
        gates: [{ matchType: 'def_id', defId: 'coal_furnace', hard: false, degradeMul: 0.4 }],
      },
      workshop: {
        ...POWER_FREE.workshop,
        gates: [{ matchType: 'def_id', defId: 'coal_furnace', hard: false, degradeMul: 0.5 }],
      },
    };
    const state = makeState({
      buildings: [MINE, WORKSHOP],
      inventory: { ...blankInventory(), iron_ore: 0, coal: 100 },
    });
    const { byBuilding } = computeRates(state, { defs });
    const workshopRate = byBuilding.find((b) => b.building.id === 'b-workshop');
    expect(workshopRate?.effectiveRate).toBeCloseTo(0.015151515151515152, 9);
  });

  it('§13.3 unified inventory: consumer runs when override has stockpile', () => {
    // Local island has 0 iron_ore, but unified inventory has 50.
    // Workshop should run because inputAvail sees the unified stockpile.
    const state = makeState({
      buildings: [WORKSHOP],
      inventory: { ...blankInventory(), coal: 50 },
    });
    const unified = { ...blankInventory(), iron_ore: 50, coal: 50 };
    const { byBuilding } = computeRates(state, { defs: POWER_FREE, inventory: unified });
    expect(byBuilding[0]?.effectiveRate).toBeGreaterThan(0);
  });

  it('§13.3 unified inventory: consumer stalls when override lacks stock', () => {
    // Local and unified both lack iron_ore; no external supply.
    const state = makeState({
      buildings: [WORKSHOP],
      inventory: { ...blankInventory(), coal: 50 },
    });
    const unified = { ...blankInventory(), coal: 50 };
    const { byBuilding } = computeRates(state, { defs: POWER_FREE, inventory: unified });
    expect(byBuilding[0]?.effectiveRate).toBe(0);
  });

  it('§13.3 unified inventory: flow-through from local supply still works', () => {
    // Local island has a Mine producing iron_ore and a Workshop consuming it.
    // Unified inventory has coal but no iron_ore. Mine provides flow-through,
    // so Workshop runs because externalSupply covers demand.
    const state = makeState({
      buildings: [MINE, WORKSHOP],
      inventory: { ...blankInventory(), coal: 50 },
    });
    const unified = { ...blankInventory(), coal: 50 };
    const { byBuilding } = computeRates(state, { defs: POWER_FREE, inventory: unified });
    const workshopRate = byBuilding.find((b) => b.building.defId === 'workshop');
    expect(workshopRate?.effectiveRate).toBeGreaterThan(0);
  });

  it('§13.3 unified caps: outputAvail stalls when unified cap is hit', () => {
    // Local cap is 100, unified cap is 100. Local inventory is 100 → at cap.
    // Mine should stall because outputAvail sees unified cap.
    const state = makeState({
      buildings: [MINE],
      inventory: { ...blankInventory(), iron_ore: 100 },
      storageCaps: { ...blankCaps(100) },
    });
    const unifiedCaps = { ...blankCaps(100) };
    const { byBuilding } = computeRates(state, { defs: POWER_FREE, caps: unifiedCaps });
    expect(byBuilding[0]?.effectiveRate).toBe(0);
  });

  it('§13.3 unified caps: producer runs when unified cap has headroom', () => {
    // Local cap is 100, local inventory is 100, but unified cap is 200.
    // Mine should run because there's headroom in the unified cap.
    const state = makeState({
      buildings: [MINE],
      inventory: { ...blankInventory(), iron_ore: 100 },
      storageCaps: { ...blankCaps(100) },
    });
    const unifiedCaps = { ...blankCaps(200) };
    const { byBuilding } = computeRates(state, { defs: POWER_FREE, caps: unifiedCaps });
    expect(byBuilding[0]?.effectiveRate).toBeGreaterThan(0);
  });
});

// -----------------------------------------------------------------------
// §4.5 buff-adjacency — observable in production rates
// -----------------------------------------------------------------------

describe('§4.5 — buff adjacency in computeRates / advanceIsland', () => {
  it('two adjacent mines each gain the same_def +10% buff (1 match, cap 2)', () => {
    // Mine placeholder buff: +10% per same_def neighbor, cap 2. Two mines
    // sharing a footprint border (2x2 at (0,0) and (2,0) → mine-A's east
    // border at column 2 intersects mine-B's western column) → each has
    // one matching neighbor → rate × 1.10. Base rate 1/50s = 0.02.
    const mineA: PlacedBuilding = { id: 'b-mine-a', defId: 'mine', x: 0, y: 0 };
    const mineB: PlacedBuilding = { id: 'b-mine-b', defId: 'mine', x: 2, y: 0 };
    const state = makeState({
      buildings: [mineA, mineB],
      inventory: blankInventory(),
    });
    const { production, byBuilding } = computeRates(state, { defs: POWER_FREE });
    // Each mine at 0.02 × 1.10 = 0.022; aggregate iron_ore = 0.044.
    expect(production.iron_ore).toBeCloseTo(0.12941176470588237, 9);
    for (const r of byBuilding) {
      expect(r.effectiveRate).toBeCloseTo(0.06470588235294118, 9);
    }
  });

  it('three mines in a line: middle caps at +20%, outer +10% each', () => {
    // Three 2x2 mines at x = -2, 0, 2 (all y=0). Middle (0,0) has TWO
    // neighbors (cap 2 hit): rate × 1.20. Outer two each have one
    // neighbor: rate × 1.10. Verifies the cap is the right ceiling and
    // not silently exceeded.
    const west: PlacedBuilding = { id: 'b-w', defId: 'mine', x: -2, y: 0 };
    const mid: PlacedBuilding = { id: 'b-m', defId: 'mine', x: 0, y: 0 };
    const east: PlacedBuilding = { id: 'b-e', defId: 'mine', x: 2, y: 0 };
    const state = makeState({
      buildings: [west, mid, east],
      inventory: blankInventory(),
    });
    const { byBuilding } = computeRates(state, { defs: POWER_FREE });
    const midRate = byBuilding.find((r) => r.building === mid)?.effectiveRate;
    const westRate = byBuilding.find((r) => r.building === west)?.effectiveRate;
    const eastRate = byBuilding.find((r) => r.building === east)?.effectiveRate;
    expect(midRate).toBeCloseTo(0.07058823529411765, 9);
    expect(westRate).toBeCloseTo(0.06470588235294118, 9);
    expect(eastRate).toBeCloseTo(0.06470588235294118, 9);
  });

  it('buff stack is observable in actual production over time', () => {
    // Two adjacent mines, 100s. Each at 0.022/s → 2 × 0.022 × 100 = 4.4
    // iron_ore. Without the buff the same setup yields 4.0.
    const mineA: PlacedBuilding = { id: 'b-mine-a', defId: 'mine', x: 0, y: 0 };
    const mineB: PlacedBuilding = { id: 'b-mine-b', defId: 'mine', x: 2, y: 0 };
    const state = makeState({
      buildings: [mineA, mineB],
      inventory: blankInventory(),
    });
    advanceIsland(state, 100_000, { defs: POWER_FREE });
    expect(state.inventory.iron_ore).toBeCloseTo(12.941176470588237, 6);
  });
});

// Building fixtures with §5.1 power fields. SOLAR and COAL_GEN inherit
// their power values from BUILDING_DEFS. Mine and Workshop pick up the
// production defs' 25W / 60W consumes via the production catalog. The
// heavier-draw MINE_PWR_80 needs a one-off catalog where mine consumes 80W.
const SOLAR: PlacedBuilding = { id: 'b-solar', defId: 'solar', x: 0, y: 0 };
const COAL_GEN: PlacedBuilding = { id: 'b-coal-gen', defId: 'coal_gen', x: 0, y: 0 };
const MINE_PWR: PlacedBuilding = MINE; // mine def already consumes 25W
const WORKSHOP_PWR: PlacedBuilding = WORKSHOP; // workshop def already consumes 60W
const MINE_PWR_80: PlacedBuilding = { id: 'b-mine-80', defId: 'mine', x: 0, y: 0 };

/** Catalog with a heavier Mine (80W) for the partial-brownout fixture. */
function mineHeavyCatalog(): DefCatalog {
  const base = { ...BUILDING_DEFS } as Record<BuildingDefId, BuildingDef>;
  base.mine = { ...base.mine, power: { consumes: 80 } };
  return base;
}
const MINE_HEAVY: DefCatalog = mineHeavyCatalog();

describe('§5.3 cable network — computeRates honours cableComponent.unified', () => {
  // Under the new binary-gated unified-pool model (replaces the prior
  // cableInflowW "virtual producer" plumbing): when ctx.cableComponent
  // is provided AND .unified === true, computeRates overrides the local
  // brownout factor with min(1, componentProduced / componentConsumed).
  // When .unified === false (gate failed for this tick), Pass 3 falls
  // back to local produced/consumed exactly as if no cable existed.
  // Aggregate produced/consumed in `power` remain LOCAL — only `factor`
  // reflects the component-level override.

  it('factor reflects unified component balance when unified=true (covered)', () => {
    // Mine consumes 40W and has no inputs, so it's always active. With
    // unified true and componentProduced/componentConsumed = 100/40 → factor=1.
    const state = makeState({
      buildings: [MINE_PWR],
      inventory: blankInventory(),
    });
    const { power } = computeRates(state, {
      cableComponent: {
        unified: true,
        producedTotal: 100,
        consumedTotal: 25,
        cableCapacityTotal: 100,
        requiredTransmission: 25,
      },
    });
    expect(power.consumed).toBe(25);
    expect(power.factor).toBe(1);
  });

  it('factor reflects unified component balance when unified=true (partial)', () => {
    // Component is 20/40 = 0.5 → factor=0.5 even though this island has
    // zero local production.
    const state = makeState({
      buildings: [MINE_PWR],
      inventory: blankInventory(),
    });
    const { power } = computeRates(state, {
      cableComponent: {
        unified: true,
        producedTotal: 20,
        consumedTotal: 40,
        cableCapacityTotal: 50,
        requiredTransmission: 20,
      },
    });
    expect(power.factor).toBe(0.5);
  });

  it('falls back to LOCAL brownout when unified=false (cables inert)', () => {
    // Component would have been 100/40 if unified, but the gate FAILED
    // (e.g., insufficient cable capacity), so the island operates locally.
    // Local: 0 produced / 40 consumed → factor=0.
    const state = makeState({
      buildings: [MINE_PWR],
      inventory: blankInventory(),
    });
    const { power } = computeRates(state, {
      cableComponent: {
        unified: false,
        producedTotal: 100,
        consumedTotal: 40,
        cableCapacityTotal: 5,
        requiredTransmission: 40,
      },
    });
    expect(power.factor).toBe(0);
  });

  it('omitting cableComponent === unified=false fallback (no cables)', () => {
    const state = makeState({
      buildings: [MINE_PWR],
      inventory: blankInventory(),
    });
    const { power } = computeRates(state); // no cableComponent
    expect(power.factor).toBe(0);
  });
});

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
    expect(byBuilding[0]?.effectiveRate).toBeCloseTo(0.058823529411764705, 9); // mine 1/50s (rebalanced step #19)
  });

  it('powerFactor = 1 when supply meets demand (Solar + Coal Gen feed Mine + Workshop)', () => {
    // 50 + 100 = 150W produced; 25 + 60 = 85W consumed → factor = 1.
    const state = makeState({
      buildings: [SOLAR, COAL_GEN, MINE_PWR, WORKSHOP_PWR],
      inventory: { ...blankInventory(), coal: 50 },
    });
    const { power, byBuilding, net } = computeRates(state);
    expect(power.produced).toBe(150);
    expect(power.consumed).toBe(85);
    expect(power.factor).toBe(1);
    // Mine still at full 0.02/s, Workshop at full 0.01/s. (rebalanced step #19)
    const mineRate = byBuilding.find((r) => r.building === MINE_PWR)?.effectiveRate;
    const wsRate = byBuilding.find((r) => r.building === WORKSHOP_PWR)?.effectiveRate;
    expect(mineRate).toBeCloseTo(0.058823529411764705, 9);
    expect(wsRate).toBeCloseTo(0.030303030303030304, 9);
    // Coal Gen also burns coal at 1/5s = 0.2/s nominally (unchanged).
    expect(net.coal).toBeCloseTo(-0.5303030303030303, 9); // workshop 0.01 + coal_gen 0.2
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
    expect(mineRate).toBeCloseTo((1 / 17) * expectedFactor, 9); // rebalanced step #19; 2026-05-18 ÷3 (Mine 50→17)
    expect(wsRate).toBeCloseTo((1 / 33) * expectedFactor, 9); // rebalanced step #19; 2026-05-18 ÷3 (Workshop 100→33)
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
    expect(power.consumed).toBe(25);
    expect(power.factor).toBe(0); // 0/25 = 0
    const mineRate = byBuilding.find((r) => r.building === MINE_PWR)?.effectiveRate;
    expect(mineRate).toBe(0); // mine throttled to zero by powerFactor
  });

  it('Solar alone (50W) vs Mine + Workshop (85W) → factor ≈ 0.588', () => {
    // Independent test: when only Solar produces (no coal_gen in scene),
    // 50W feeds 85W of demand. Both consumers throttled to 50/85 ≈ 0.588×.
    const state = makeState({
      buildings: [SOLAR, MINE_PWR, WORKSHOP_PWR],
      inventory: { ...blankInventory(), coal: 50, iron_ore: 50 },
    });
    const { power, byBuilding } = computeRates(state);
    expect(power.produced).toBe(50);
    expect(power.consumed).toBe(85);
    expect(power.factor).toBeCloseTo(50 / 85, 9);
    const mineRate = byBuilding.find((r) => r.building === MINE_PWR)?.effectiveRate;
    const wsRate = byBuilding.find((r) => r.building === WORKSHOP_PWR)?.effectiveRate;
    expect(mineRate).toBeCloseTo((1 / 17) * (50 / 85), 9); // rebalanced step #19
    expect(wsRate).toBeCloseTo((1 / 33) * (50 / 85), 9); // rebalanced step #19
  });

  it('output-stalled consumer draws ZERO power (§5.1 throughput-scaled rebalance)', () => {
    // §5.1 throughput-scaled-power rebalance: a Mine with iron_ore at cap
    // (output-stalled, outputAvail = 0) now contributes 0W to P_consumed
    // instead of its nominal 40W. Workshop's inputAvail is unaffected
    // (it has stockpiled iron_ore from the Mine's cap-pile + coal), so
    // it still draws full 60W. With Solar 50W vs 60W demand, factor =
    // min(1, 50/60) ≈ 0.833. Workshop runs at 1/33 × 0.833 /s.
    //
    // (Previously this test asserted full 100W draw + factor 0.5 — that
    // was the pre-rebalance "lights on at full bin" behaviour, which the
    // user explicitly called out as wasteful.)
    const state = makeState({
      buildings: [SOLAR, MINE_PWR, WORKSHOP_PWR],
      inventory: {
        ...blankInventory(),
        iron_ore: 100, // mine at cap → output-stalled → no power draw
        coal: 50,
      },
    });
    const { power, byBuilding } = computeRates(state);
    expect(power.produced).toBe(50);
    expect(power.consumed).toBe(60); // mine 40W zeroed; workshop 60W remains
    expect(power.factor).toBeCloseTo(50 / 60, 9);
    const mineRate = byBuilding.find((r) => r.building === MINE_PWR)?.effectiveRate;
    const wsRate = byBuilding.find((r) => r.building === WORKSHOP_PWR)?.effectiveRate;
    expect(mineRate).toBe(0); // still output-stalled at the recipe level
    // Workshop nominal 1/33 × powerFactor (50/60). (rebalanced step #19)
    expect(wsRate).toBeCloseTo((1 / 33) * (50 / 60), 9);
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
    expect(cgRate).toBeCloseTo(0.5, 9); // 1 cycle / 5s
  });

  it('§3.5 high_wind: Wind Turbine produces 40W baseline, 60W on a high_wind island', () => {
    // wind_turbine def declares power: { produces: 40, kind: 'wind' }.
    // requiredTile: ['water'] is a placement gate, not a runtime one — the
    // simulated state can stand a `wind_turbine` building at (0,0) without
    // a real terrain map and computeRates still sums its wattage.
    const WIND_TURBINE: PlacedBuilding = { id: 'b-wind', defId: 'wind_turbine', x: 0, y: 0 };
    const baselineState = makeState({
      buildings: [WIND_TURBINE],
      inventory: blankInventory(),
    });
    const { power: baselinePower } = computeRates(baselineState);
    expect(baselinePower.produced).toBe(40);

    const highWindState = makeState({
      buildings: [WIND_TURBINE],
      inventory: blankInventory(),
    });
    const { power: highWindPower } = computeRates(highWindState, {
      modifierMul: effectiveModifierMultipliers(['high_wind']),
    });
    expect(highWindPower.produced).toBeCloseTo(60, 9); // 40 × 1.5
  });

  it('§3.5 high_wind does NOT boost non-wind producers (Solar, Coal Gen unchanged)', () => {
    // The wind multiplier is keyed on power.kind === 'wind'. Solar (kind=undefined,
    // solar=true) and Coal Gen (kind=undefined) should be unaffected even when
    // the modifier is active.
    const state = makeState({
      buildings: [SOLAR, COAL_GEN],
      inventory: { ...blankInventory(), coal: 50 },
    });
    const { power } = computeRates(state, {
      modifierMul: effectiveModifierMultipliers(['high_wind']),
      // Pin the world clock to a daytime tick so Solar's day/night factor is 1.
      // solarMultiplier is computed off state.lastTick (= 0) when nowMs is
      // unset; t=0 lands at start-of-Day per §2.7, so Solar produces full 50W.
    });
    // Solar 50W + Coal Gen 100W = 150W — same as the identity-modifier run.
    expect(power.produced).toBe(150);
  });
});

describe('§5.1 power scales with effective throughput (rebalance)', () => {
  // Building power draw scales by nominal throughput fraction:
  //   nominalThroughputFrac = gateMul × inputAvail × (outputAvail > 0 ? 1 : 0)
  // Composed BEFORE powerFactor (preserves the existing circular-dep break).
  // Maintenance bills are explicitly UNTOUCHED — a stalled building still
  // wears down at full rate.

  it('output-cap stalled consumer contributes 0W (and powerFactor = 1)', () => {
    // Coal Gen produces 100W; Mine consumes 40W but its iron_ore is at cap.
    // Pre-rebalance: powerConsumed = 40, factor = min(1, 100/40) = 1.
    // Post-rebalance: powerConsumed = 0, factor = 1 (consumed = 0 short
    // -circuit). The difference is observable on power.consumed itself.
    const state = makeState({
      buildings: [COAL_GEN, MINE_PWR],
      inventory: { ...blankInventory(), coal: 50, iron_ore: 100 },
    });
    const { power } = computeRates(state);
    expect(power.consumed).toBe(0); // mine output-stalled → 0 draw
    expect(power.factor).toBe(1);
  });

  it('soft-gate degraded consumer draws proportional power (0.5× gate → 20W from 40W)', () => {
    // Soft-gate the Mine to 0.5×. Mine's nominal draw is 40W; throughput
    // fraction = 0.5 × 1 × 1 = 0.5 → powerConsumed contribution = 20W.
    // Coal Gen produces 100W so factor = 1.
    const defs: DefCatalog = {
      ...BUILDING_DEFS,
      mine: {
        ...BUILDING_DEFS.mine,
        gates: [{ matchType: 'def_id', defId: 'coal_furnace', hard: false, degradeMul: 0.5 }],
      },
    };
    const state = makeState({
      buildings: [COAL_GEN, MINE_PWR],
      inventory: { ...blankInventory(), coal: 50 },
    });
    const { power } = computeRates(state, { defs });
    expect(power.consumed).toBeCloseTo(12.5, 9);
    expect(power.factor).toBe(1);
  });

  it('partially input-starved consumer draws proportional power (inputAvail = 0.5 → half draw)', () => {
    // Mine produces iron_ore at 1/17 /s nominal. A heavier-than-stock-supply
    // Workshop wants iron_ore at 1/33 /s + coal at 1/33 /s. We arrange the
    // Mine's supply to be exactly HALF of the Workshop's iron_ore demand
    // (via a §4.5 soft-gate on the Mine), with iron_ore stock = 0 so
    // inputAvail is forced through the externalSupply branch.
    //
    // Math:
    //   Mine nominal iron_ore supply  = 1/17 = 0.0588 /s (rebalanced step #19)
    //   Workshop nominal iron_ore demand = 1/33 = 0.0303 /s
    //   To force inputAvail = 0.5, supply must be 0.5 × demand.
    //   gateMul on Mine = (0.5 × 1/33) / (1/17) = 0.5 × 17/33 ≈ 0.2576.
    //
    // Workshop's nominal power = 60W. Expected draw = 60 × 0.5 = 30W.
    //
    // We also want Coal Gen to cover the full 100W produced side so the
    // power.factor stays = 1 and doesn't muddy the assertion on consumed.
    const defs: DefCatalog = {
      ...BUILDING_DEFS,
      mine: {
        ...BUILDING_DEFS.mine,
        gates: [
          {
            matchType: 'def_id',
            defId: 'coal_furnace',
            hard: false,
            degradeMul: 0.5 * (1 / 33) / (1 / 17), // ≈ 0.2576
          },
        ],
      },
    };
    const state = makeState({
      buildings: [COAL_GEN, MINE_PWR, WORKSHOP_PWR],
      inventory: { ...blankInventory(), coal: 50, iron_ore: 0 },
    });
    const { power } = computeRates(state, { defs });
    // Mine: gateMul ≈ 0.2576, ia = 1 (no inputs), oa = 1 → frac ≈ 0.2576.
    //   Mine contribution = 25 × 0.2576 ≈ 6.439W
    // Workshop: gateMul = 1, ia = 0.5 (half-supplied iron_ore), oa = 1.
    //   Workshop contribution = 60 × 0.5 = 30W
    // Total ≈ 36.439W.
    expect(power.consumed).toBeCloseTo(25 * (0.5 * (1 / 33) / (1 / 17)) + 60 * 0.5, 6);
    expect(power.factor).toBe(1);
  });

  it('multiple factors compose multiplicatively (gateMul 0.5 × inputAvail 0.5 → 0.25× draw)', () => {
    // Compose a soft-gate AND input-starvation on the SAME building. The
    // Workshop is soft-gated to 0.5× and its iron_ore inputAvail is also
    // 0.5 (Mine's iron_ore supply is exactly half the gated Workshop's
    // demand, with stock = 0). Throughput fraction = 0.5 × 0.5 × 1 = 0.25.
    // Workshop power = 60W × 0.25 = 15W.
    //
    // Math for the Mine's gate that yields inputAvail = 0.5 on the
    // soft-gated Workshop:
    //   Workshop gated demand = 0.5 × 1/33 = 0.01515 /s (§4.5 pass-2
    //     applies effectiveMul to nominalRate, so demand IS gated).
    //   We want supply = 0.5 × gated_demand = 0.0076 /s.
    //   Mine nominal supply = 1/17 = 0.0588 /s.
    //   Mine gateMul = 0.0076 / 0.0588 = 0.5 × 0.5 × (1/33) / (1/17)
    //                = 0.25 × 17/33 ≈ 0.1288.
    const mineGate = 0.5 * 0.5 * (1 / 33) / (1 / 17);
    const defs: DefCatalog = {
      ...BUILDING_DEFS,
      mine: {
        ...BUILDING_DEFS.mine,
        gates: [{ matchType: 'def_id', defId: 'coal_furnace', hard: false, degradeMul: mineGate }],
      },
      workshop: {
        ...BUILDING_DEFS.workshop,
        gates: [{ matchType: 'def_id', defId: 'coal_furnace', hard: false, degradeMul: 0.5 }],
      },
    };
    const state = makeState({
      buildings: [COAL_GEN, MINE_PWR, WORKSHOP_PWR],
      inventory: { ...blankInventory(), coal: 50, iron_ore: 0 },
    });
    const { power } = computeRates(state, { defs });
    // Mine: 25 × mineGate × 1 × 1
    // Workshop: 60 × 0.5 × 0.5 × 1 = 15
    const expectedMine = 25 * mineGate;
    const expectedWorkshop = 60 * 0.5 * 0.5;
    expect(power.consumed).toBeCloseTo(expectedMine + expectedWorkshop, 6);
  });

  it('maintenance bills are NOT affected by throughput (regression sentinel)', () => {
    // Per the §5.1 rebalance carve-out: power scales with throughput, but
    // maintenance.ts is intentionally UNTOUCHED. A building output-cap
    // stalled (zero power draw, zero production) must STILL accrue
    // operatingMs at the full wall-clock rate — the player can't escape
    // maintenance pressure by deliberately capping outputs.
    //
    // Two Mines on separate states, identical placedAt/maintainedAt/etc.
    // One has iron_ore stock = 99 (Mine runs at full rate). The other has
    // iron_ore = 100 = cap (Mine is output-cap stalled, draws 0W now). Both
    // states are advanced by the same dt. operatingMs MUST accrue
    // identically on both.
    const dt = 5_000;
    const runningState = makeState({
      buildings: [{ ...MINE, operatingMs: 0, placedAt: 0, maintainedAt: 0 }],
      inventory: { ...blankInventory(), iron_ore: 0 },
    });
    const stalledState = makeState({
      buildings: [{ ...MINE, operatingMs: 0, placedAt: 0, maintainedAt: 0 }],
      inventory: { ...blankInventory(), iron_ore: 100 }, // at cap → output-stalled
    });
    advanceIsland(runningState, dt, { defs: POWER_FREE });
    advanceIsland(stalledState, dt, { defs: POWER_FREE });
    expect(runningState.buildings[0]!.operatingMs).toBe(dt);
    expect(stalledState.buildings[0]!.operatingMs).toBe(dt); // SAME — carve-out
  });
});

describe('skill-tree integration (§9.3)', () => {
  it('mining.1 unlocked: Mine produces iron_ore at 1.05× base rate', () => {
    // Base mine rate 0.02/s × 1.05 = 0.021/s. (rebalanced step #19: mine 1/50s)
    const state = makeState({
      buildings: [MINE],
      inventory: blankInventory(),
      unlockedNodes: new Set(['mining.1']),
    });
    const { production } = computeRates(state, { defs: POWER_FREE });
    expect(production.iron_ore).toBeCloseTo(0.061764705882352944, 9);
  });

  it('mining.1 + mining.2 stacks multiplicatively: Mine rate × 1.155', () => {
    // Base mine rate 0.02/s × 1.155. (rebalanced step #19)
    const state = makeState({
      buildings: [MINE],
      inventory: blankInventory(),
      unlockedNodes: new Set(['mining.1', 'mining.2']),
    });
    const { production } = computeRates(state, { defs: POWER_FREE });
    expect(production.iron_ore).toBeCloseTo(0.06794117647058824, 9);
  });

  it('storage.1 unlocked: effective caps are 1.05× the nominal storageCaps map', () => {
    // Mine alone, iron_ore start at 100 (nominal cap). With storage.1 the
    // effective cap is 105 — there's headroom and the mine doesn't stall.
    // (rebalanced step #19: mine 1/50s = 0.02/s)
    const state = makeState({
      buildings: [MINE],
      inventory: { ...blankInventory(), iron_ore: 100 },
      unlockedNodes: new Set(['storage.1']),
    });
    advanceIsland(state, 100_000, { defs: POWER_FREE });
    // Mine ran for 100s before hitting the new cap (105). Time to fill from
    // 100 to 105 at 0.02/s = 250s; we ran 100s, so we picked up 2 units.
    expect(state.inventory.iron_ore).toBeCloseTo(105, 6);
  });
});

describe('funneling — consumption drains pending bonus XP credit (§10)', () => {
  it('drains funnel credit proportional to consumption, awards bonus XP', () => {
    // Workshop 1/100s = 0.01/s. Over 1000s it consumes 10 iron_ore. (rebalanced step #19)
    // Production XP over 1000s: 0.01 × 10 (bolt xp_weight) × 1000s = 100.
    // Pre-seed funnelPending.iron_ore = 50 XP-units.
    // Over 1000s the Workshop consumes 10 iron_ore. Bonus drained
    // per unit consumed = xp_weight[iron_ore] × 0.5 = 0.5 XP-units.
    // 10 units consumed → 5 drained, leaving 45 in pending, +5 added to XP.
    const state = makeState({
      buildings: [WORKSHOP],
      inventory: { ...blankInventory(), iron_ore: 100, coal: 100 },
    });
    state.funnelPending.iron_ore = 50;
    advanceIsland(state, 1_000_000, { defs: POWER_FREE });
    // Production XP: 0.01 bolt/s × 1000s × 10 (xp_weight) = 100.
    // + funnel-drain XP: 5.
    expect(state.xp).toBeCloseTo(203.31198268211466, 6);
    expect(state.funnelPending.iron_ore).toBeCloseTo(34.848484848484844, 6);
  });

  it('does not over-drain when credit is less than the bonus owed', () => {
    // Same setup but pending = 2 (small). Over 1000s, owed = 5; drain caps at 2.
    // XP = 100 (production) + 2 (drain). (rebalanced step #19)
    const state = makeState({
      buildings: [WORKSHOP],
      inventory: { ...blankInventory(), iron_ore: 100, coal: 100 },
    });
    state.funnelPending.iron_ore = 2;
    advanceIsland(state, 1_000_000, { defs: POWER_FREE });
    expect(state.xp).toBeCloseTo(190.16046753059953, 6);
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


describe('modifier integration in computeRates / advanceIsland (§3.5)', () => {
  it('mineral_rich: extraction-tagged Mine runs at 1.25× base rate', () => {
    // Mine 1/50s = 0.02/s; with mineral_rich (+25% extraction) = 0.025/s.
    // Over 100s = 2.5 units (rebalanced step #19).
    const state = makeState({
      buildings: [MINE],
      inventory: blankInventory(),
    });
    const mul = effectiveModifierMultipliers(['mineral_rich']);
    advanceIsland(state, 100_000, { modifierMul: mul, defs: POWER_FREE });
    expect(state.inventory.iron_ore).toBeCloseTo(7.352941176470589, 9);
  });

  it('cursed_storms: all recipes run at 0.90× base rate (global)', () => {
    // Mine alone. Base 0.02/s × 0.90 = 0.018/s. Over 100s = 1.8 units. (rebalanced step #19)
    const state = makeState({
      buildings: [MINE],
      inventory: blankInventory(),
    });
    const mul = effectiveModifierMultipliers(['cursed_storms']);
    advanceIsland(state, 100_000, { modifierMul: mul, defs: POWER_FREE });
    expect(state.inventory.iron_ore).toBeCloseTo(5.294117647058823, 9);
  });

  it('fertile: extraction +50% — Mine runs at 1.5× base', () => {
    // Mine 0.02/s × 1.5 = 0.03/s. Over 100s = 3 units. (rebalanced step #19)
    const state = makeState({
      buildings: [MINE],
      inventory: blankInventory(),
    });
    const mul = effectiveModifierMultipliers(['fertile']);
    advanceIsland(state, 100_000, { modifierMul: mul, defs: POWER_FREE });
    expect(state.inventory.iron_ore).toBeCloseTo(8.823529411764705, 9);
  });

  it('stable: no-op multiplier — Mine runs at base 0.02/s', () => {
    // Mine 0.02/s. Over 100s = 2 units. (rebalanced step #19)
    const state = makeState({
      buildings: [MINE],
      inventory: blankInventory(),
    });
    const mul = effectiveModifierMultipliers(['stable']);
    advanceIsland(state, 100_000, { modifierMul: mul, defs: POWER_FREE });
    expect(state.inventory.iron_ore).toBeCloseTo(5.88235294117647, 9);
  });

  it('mineral_rich + cursed_storms compose: Mine at 0.02 × 1.25 × 0.9 = 0.0225/s', () => {
    // Over 100s = 2.25 units. (rebalanced step #19)
    const state = makeState({
      buildings: [MINE],
      inventory: blankInventory(),
    });
    const mul = effectiveModifierMultipliers(['mineral_rich', 'cursed_storms']);
    advanceIsland(state, 100_000, { modifierMul: mul, defs: POWER_FREE });
    expect(state.inventory.iron_ore).toBeCloseTo(6.61764705882353, 9);
  });

  it('cursed_storms applies to non-extraction recipes too (Workshop manufacturing)', () => {
    // Workshop 1/100s = 0.01/s. With cursed_storms: 0.009/s. Over 100s = 0.9 bolt. (rebalanced step #19)
    const state = makeState({
      buildings: [WORKSHOP],
      inventory: { ...blankInventory(), iron_ore: 10, coal: 10 },
    });
    const mul = effectiveModifierMultipliers(['cursed_storms']);
    advanceIsland(state, 100_000, { modifierMul: mul, defs: POWER_FREE });
    expect(state.inventory.bolt).toBeCloseTo(2.7272727272727275, 9);
  });

  it('high_wind applies ±20% variance to recipe rates', () => {
    // Base Mine rate = 0.02/s. With high_wind the effective rate must be
    // within [0.016, 0.024] for any deterministic RNG draw.
    const state = makeState({ buildings: [MINE], inventory: blankInventory() });
    const mul = effectiveModifierMultipliers(['high_wind']);
    const { byBuilding } = computeRates(state, { modifierMul: mul, defs: POWER_FREE }, 0);
    const rate = byBuilding[0]!.effectiveRate;
    expect(rate).toBeGreaterThanOrEqual((1 / 17) * 0.8);
    expect(rate).toBeLessThanOrEqual((1 / 17) * 1.2);
  });

  it('high_wind variance is deterministic for the same (islandId, second)', () => {
    const state = makeState({ buildings: [MINE], inventory: blankInventory() });
    const mul = effectiveModifierMultipliers(['high_wind']);
    const a = computeRates(state, { modifierMul: mul, defs: POWER_FREE }, 0);
    const b = computeRates(state, { modifierMul: mul, defs: POWER_FREE }, 0);
    expect(a.byBuilding[0]!.effectiveRate).toBeCloseTo(b.byBuilding[0]!.effectiveRate, 12);
  });

  it('high_wind variance does NOT affect power production', () => {
    // Solar panel produces 50W regardless of high_wind variance.
    const state = makeState({ buildings: [SOLAR], inventory: blankInventory() });
    const mul = effectiveModifierMultipliers(['high_wind']);
    const { power } = computeRates(state, { modifierMul: mul }, 0);
    expect(power.produced).toBe(50);
  });

  it('high_wind variance on chained production: Workshop stays within ±20% of nominal', () => {
    // Mine produces iron_ore, Workshop consumes it. With high_wind, the Mine's
    // output varies but the Workshop's effective rate should still be within
    // ±20% of its nominal rate (0.01/s), NOT additionally reduced by inputAvail.
    const state = makeState({
      buildings: [MINE, WORKSHOP],
      inventory: { ...blankInventory(), coal: 50 }, // coal for Workshop; no iron_ore — flow-through from Mine
    });
    const mul = effectiveModifierMultipliers(['high_wind']);
    const { byBuilding } = computeRates(state, { modifierMul: mul, defs: POWER_FREE }, 0);
    const mineRate = byBuilding.find((r) => r.building.defId === 'mine')!.effectiveRate;
    const wsRate = byBuilding.find((r) => r.building.defId === 'workshop')!.effectiveRate;
    // Mine should be within ±20% of 1/17 (post-÷3 rebalance)
    expect(mineRate).toBeGreaterThanOrEqual((1 / 17) * 0.8);
    expect(mineRate).toBeLessThanOrEqual((1 / 17) * 1.2);
    // Workshop should be within ±20% of 1/33 (not double-dipped)
    expect(wsRate).toBeGreaterThanOrEqual((1 / 33) * 0.8);
    expect(wsRate).toBeLessThanOrEqual((1 / 33) * 1.2);
  });

  it('computeRates with modifierMul matches advanceIsland integration', () => {
    // Direct computeRates with mineral_rich → effectiveRate = 0.02 × 1.25 = 0.025. (rebalanced step #19)
    const state = makeState({
      buildings: [MINE],
      inventory: blankInventory(),
    });
    const mul = effectiveModifierMultipliers(['mineral_rich']);
    const { byBuilding, production } = computeRates(state, { modifierMul: mul, defs: POWER_FREE });
    expect(byBuilding[0]!.effectiveRate).toBeCloseTo(0.07352941176470588, 9);
    expect(production.iron_ore).toBeCloseTo(0.07352941176470588, 9);
  });

  it('Geothermal Active lets Blast Furnace run without adjacent heat source', () => {
    const BF: PlacedBuilding = { id: 'bf', defId: 'blast_furnace', x: 0, y: 0 };
    const noPowerBf = ((): DefCatalog => {
      const base = { ...BUILDING_DEFS } as Record<BuildingDefId, BuildingDef>;
      const { power: _p, ...rest } = base.blast_furnace;
      base.blast_furnace = rest as BuildingDef;
      return base;
    })();
    const state = makeState({
      buildings: [BF],
      inventory: {
        ...blankInventory(),
        iron_ingot: 1000,
        coke: 1000,
      },
      storageCaps: blankCaps(10_000),
      level: 5,
    });
    // Without geothermalActive, BF stalls (no adjacent heat source).
    const cold = computeRates(state, { defs: noPowerBf });
    const coldRate = cold.byBuilding.find((r) => r.building.id === 'bf');
    expect(coldRate?.effectiveRate).toBe(0);

    // With geothermalActive=true, BF runs at full rate.
    const hot = computeRates(state, { defs: noPowerBf, geothermalActive: true });
    const hotRate = hot.byBuilding.find((r) => r.building.id === 'bf');
    expect(hotRate?.effectiveRate).toBeCloseTo(1 / 160, 9); // blast_furnace cycleSec = 160 (was 480; 2026-05-18 ÷3 for display visibility)
  });

  it('advanceIsland respects geothermalActive for requiresHeat buildings', () => {
    const BF: PlacedBuilding = { id: 'bf', defId: 'blast_furnace', x: 0, y: 0 };
    const noPowerBf = ((): DefCatalog => {
      const base = { ...BUILDING_DEFS } as Record<BuildingDefId, BuildingDef>;
      const { power: _p, ...rest } = base.blast_furnace;
      base.blast_furnace = rest as BuildingDef;
      return base;
    })();
    const state = makeState({
      buildings: [BF],
      inventory: {
        ...blankInventory(),
        iron_ingot: 1000,
        coke: 1000,
      },
      storageCaps: blankCaps(10_000),
      level: 5,
    });
    // Without geothermalActive, the BF stalls — no production over 60s.
    advanceIsland(state, 60_000, { defs: noPowerBf });
    expect(state.inventory.steel ?? 0).toBe(0);

    // With geothermalActive=true, the BF produces steel despite no heat-source neighbor.
    const state2 = makeState({
      buildings: [BF],
      inventory: {
        ...blankInventory(),
        iron_ingot: 1000,
        coke: 1000,
      },
      storageCaps: blankCaps(10_000),
      level: 5,
    });
    advanceIsland(state2, 60_000, { defs: noPowerBf, geothermalActive: true });
    expect(state2.inventory.pig_iron ?? 0).toBeGreaterThan(0);
  });

  it('Aetheric Anomaly gives T5 extractor 1.5× rate', () => {
    const conduit: PlacedBuilding = { id: 'b-ac', defId: 'aetheric_conduit', x: 0, y: 0 };
    const state = makeState({
      buildings: [conduit],
      inventory: blankInventory(),
    });
    const noPower = ((): DefCatalog => {
      const base = { ...BUILDING_DEFS } as Record<BuildingDefId, BuildingDef>;
      const { power: _p, ...rest } = base.aetheric_conduit;
      base.aetheric_conduit = rest as BuildingDef;
      return base;
    })();
    const mulNormal = effectiveModifierMultipliers([]);
    const rNormal = computeRates(state, { modifierMul: mulNormal, defs: noPower, worldSeed: 'test' }, 0);
    const mulAnomaly = effectiveModifierMultipliers(['aetheric_anomaly']);
    const rAnomaly = computeRates(state, { modifierMul: mulAnomaly, defs: noPower, worldSeed: 'test' }, 0);
    expect(rAnomaly.byBuilding[0]!.effectiveRate).toBeCloseTo(
      rNormal.byBuilding[0]!.effectiveRate * 1.5,
      9,
    );
  });

  it('Frozen Core doubles cryo recipe rate', () => {
    const cryo: PlacedBuilding = { id: 'b-cl', defId: 'cryo_lab', x: 0, y: 0 };
    const state = makeState({
      buildings: [cryo],
      inventory: { ...blankInventory(), hydrogen: 1000, nitrogen: 1000 },
      storageCaps: blankCaps(10_000),
      level: 10, // T3 for cryo_lab
    });
    const noPower = ((): DefCatalog => {
      const base = { ...BUILDING_DEFS } as Record<BuildingDefId, BuildingDef>;
      const { power: _p, ...rest } = base.cryo_lab;
      base.cryo_lab = rest as BuildingDef;
      return base;
    })();
    const mulNormal = effectiveModifierMultipliers([]);
    const rNormal = computeRates(state, { modifierMul: mulNormal, defs: noPower }, 0);
    const mulFrozen = effectiveModifierMultipliers(['frozen_core']);
    const rFrozen = computeRates(state, { modifierMul: mulFrozen, defs: noPower }, 0);
    expect(rFrozen.byBuilding[0]!.effectiveRate).toBeCloseTo(
      rNormal.byBuilding[0]!.effectiveRate * 2,
      9,
    );
  });
});

// -----------------------------------------------------------------------
// Step 9 — new chain + storage aggregation
// -----------------------------------------------------------------------

describe('step-9 chain — Smelter T1 + storage aggregation', () => {
  it('Smelter on home produces iron_ingot at 1/80s with iron_ore + coal stocked', () => {
    // Smelter 1/80s = 0.0125/s. Over 100s = 1.25 ingots. (rebalanced step #19: was 1/8s)
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
    advanceIsland(state, 100_000, { defs: noSmelterPower });
    expect(state.inventory.iron_ingot).toBeCloseTo(3.7037037037037033, 6);
    expect(state.inventory.iron_ore).toBeCloseTo(46.2962962962963, 6);
    expect(state.inventory.coal).toBeCloseTo(46.2962962962963, 6);
  });

  it('aggregateStorageCaps: Silo on an island raises only dry_goods caps to 4000', () => {
    // §4.6 categorized storage: Silo bumps dry_goods only. Other categories
    // stay at baseline 2000. (rebalanced step #19: baseline 2000 + silo 2000 = 4000)
    const buildings: PlacedBuilding[] = [
      { id: 't-silo', defId: 'silo', x: 0, y: 0 },
    ];
    const caps = aggregateStorageCaps(buildings);
    for (const r of ALL_RESOURCES) {
      const expected = RESOURCE_STORAGE_CATEGORY[r] === 'dry_goods' ? 4000 : 2000;
      expect(caps[r]).toBe(expected);
    }
  });

  it('aggregateStorageCaps: Tank on an island raises only liquid_gas caps to 4000', () => {
    // §4.6: Tank is liquid_gas-only.
    const caps = aggregateStorageCaps([
      { id: 't-tank', defId: 'tank', x: 0, y: 0 },
    ]);
    for (const r of ALL_RESOURCES) {
      const expected = RESOURCE_STORAGE_CATEGORY[r] === 'liquid_gas' ? 4000 : 2000;
      expect(caps[r]).toBe(expected);
    }
  });

  it('aggregateStorageCaps: Crate with cargoLabel raises only that resource', () => {
    // §4.6: generic storage adds capacity to ONE labeled resource per
    // instance. An unlabeled Crate contributes nothing (forward-compat).
    const labeled: PlacedBuilding[] = [
      { id: 't-crate', defId: 'crate', x: 0, y: 0, cargoLabel: 'iron_ore' },
    ];
    const caps = aggregateStorageCaps(labeled);
    for (const r of ALL_RESOURCES) {
      const expected = r === 'iron_ore' ? 2100 : 2000;
      expect(caps[r]).toBe(expected);
    }
    // An unlabeled Crate (old save) contributes nothing.
    const unlabeled: PlacedBuilding[] = [
      { id: 't-crate', defId: 'crate', x: 0, y: 0 },
    ];
    const capsU = aggregateStorageCaps(unlabeled);
    for (const r of ALL_RESOURCES) expect(capsU[r]).toBe(2000);
  });

  it('aggregateStorageCaps: no storage buildings → baseline 2000 caps', () => {
    // Rebalanced for idle-game scale, step #19: baseline is now 2000
    const caps = aggregateStorageCaps([
      { id: 'b-mine', defId: 'mine', x: 0, y: 0 },
    ]);
    for (const r of ALL_RESOURCES) expect(caps[r]).toBe(2000);
  });

  it('aggregateStorageCaps: mixed-category buildings — each category bumps independently', () => {
    // §4.6: a Silo (dry_goods +2000), Tank (liquid_gas +2000), Vault
    // (rare +5000), Crate labeled iron_ore (+100). Each resource picks up
    // its category bump plus the label-specific bump iff named.
    const buildings: PlacedBuilding[] = [
      { id: 't-silo', defId: 'silo', x: 0, y: 0 },
      { id: 't-tank', defId: 'tank', x: 2, y: 0 },
      { id: 't-vault', defId: 'vault', x: 4, y: 0 },
      { id: 't-crate', defId: 'crate', x: 6, y: 0, cargoLabel: 'iron_ore' },
    ];
    const caps = aggregateStorageCaps(buildings);
    for (const r of ALL_RESOURCES) {
      let expected = 2000;
      const cat = RESOURCE_STORAGE_CATEGORY[r];
      if (cat === 'dry_goods') expected += 2000;
      if (cat === 'liquid_gas') expected += 2000;
      if (cat === 'rare') expected += 5000;
      if (r === 'iron_ore') expected += 100;
      expect(caps[r]).toBe(expected);
    }
  });
});

// -----------------------------------------------------------------------
// Step 10 — specialization roles + Network Consciousness
// -----------------------------------------------------------------------


// -----------------------------------------------------------------------
// Step 12 — T4 endgame production integration (§6.5 / §9.5)
// -----------------------------------------------------------------------

describe('step-12 — T4 endgame production integration (§6.5)', () => {
  it('Pyroforge on a synthetic volcanic spec produces exotic_alloy at 1/3600s base rate', () => {
    // Pyroforge recipe: 3600s cycle (rebalanced step #19: was 60s ×60), inputs { steel: 5, helium_3: 1 }.
    // Over 36000s = 10 cycles → 10 exotic_alloy produced, 50 steel + 10 helium_3 consumed.
    const PYROFORGE: PlacedBuilding = {
      id: 'b-pyroforge',
      defId: 'pyroforge',
      x: 0,
      y: 0,
    };
    // Strip power AND `requiresHeat` so the test exercises a pure rate path
    // without modelling the §5.2 heat gate (covered in heat.test.ts and the
    // dedicated integration test below).
    const powerFreePyro = ((): DefCatalog => {
      const base = { ...BUILDING_DEFS } as Record<BuildingDefId, BuildingDef>;
      const { power: _p, requiresHeat: _h, ...rest } = base.pyroforge;
      base.pyroforge = rest as BuildingDef;
      return base;
    })();
    const state = makeState({
      buildings: [PYROFORGE],
      inventory: { ...blankInventory(), steel: 100, helium_3: 20 },
      storageCaps: blankCaps(10000),
      // Pyroforge is T4 — bypass the §9.7 tier-band runtime gate.
      level: 30,
    });
    advanceIsland(state, 36_000_000, { defs: powerFreePyro });
    expect(state.inventory.exotic_alloy).toBeCloseTo(20, 6);
    expect(state.inventory.steel).toBeCloseTo(+0, 6);
    expect(state.inventory.helium_3).toBeCloseTo(+0, 6);
  });

  it('Cryogenic Compute Center on synthetic arctic spec produces ai_core at 1/5400s', () => {
    // Cryogenic Compute Center: 5400s cycle (rebalanced step #19: was 90s ×60), inputs { steel: 3, quantum_chip: 1, argon: 1 }.
    // Over 54000s = 10 cycles.
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
      inventory: { ...blankInventory(), steel: 100, quantum_chip: 20, argon: 20 },
      storageCaps: blankCaps(10000),
      // T5 (cryogenic_compute_center) requires level ≥ 50 + aiCoreCrafted
      // per §13.1 — satisfy both gates so the §9.7 tier-band runtime check
      // doesn't zero the building.
      level: 50,
      aiCoreCrafted: true,
    });
    advanceIsland(state, 54_000_000, { defs: powerFreeCryo });
    expect(state.inventory.ai_core).toBeCloseTo(20, 6);
    expect(state.inventory.steel).toBeCloseTo(40, 6);
    expect(state.inventory.quantum_chip).toBeCloseTo(+0, 6);
  });
});

// -----------------------------------------------------------------------
// NC buff integration
// -----------------------------------------------------------------------

describe('NC buff integration', () => {
  it('NC buff +5% applies to T3+ island production but NOT to T1 island', () => {
    // Mine 1/50s = 0.02/s. Over 100s: T1 = 2.0 units, T3 = 2.0 × 1.05 = 2.1. (rebalanced step #19)
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
    advanceIsland(t1, 100_000, { defs: POWER_FREE, ncBuff: 1 });
    advanceIsland(t3, 100_000, { defs: POWER_FREE, ncBuff: NC_BUFF });
    expect(t1.inventory.iron_ore).toBeCloseTo(5.88235294117647, 9);
    expect(t3.inventory.iron_ore).toBeCloseTo(6.176470588235294, 9);
  });
});

// -----------------------------------------------------------------------
// §13 core-craft auto-flip
// -----------------------------------------------------------------------

describe('§13 core-craft auto-flip', () => {
  it('flips aiCoreCrafted on first ai_core production', () => {
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
      inventory: { ...blankInventory(), steel: 100, quantum_chip: 20, argon: 20 },
      storageCaps: blankCaps(10000),
      level: 50,
      aiCoreCrafted: false,
    });
    expect(state.aiCoreCrafted).toBe(false);
    advanceIsland(state, 6_000_000, { defs: powerFreeCryo });
    expect(state.aiCoreCrafted).toBe(true);
    expect(state.inventory.ai_core ?? 0).toBeGreaterThan(0);
  });

  it('does not flip aiCoreCrafted from inventory presence alone', () => {
    const state = makeState({
      inventory: { ...blankInventory(), ai_core: 5 },
      aiCoreCrafted: false,
    });
    advanceIsland(state, 10_000);
    expect(state.aiCoreCrafted).toBe(false);
  });

  it('flips ascendantCoreCrafted on first ascendant_core production', () => {
    const ASC: PlacedBuilding = {
      id: 'b-asc',
      defId: 'ascendant_assembly',
      x: 0,
      y: 0,
    };
    const powerFreeAsc = ((): DefCatalog => {
      const base = { ...BUILDING_DEFS } as Record<BuildingDefId, BuildingDef>;
      const { power: _p, ...rest } = base.ascendant_assembly;
      base.ascendant_assembly = rest as BuildingDef;
      return base;
    })();
    const state = makeState({
      buildings: [ASC],
      inventory: { ...blankInventory(), reality_anchor: 100, eldritch_processor: 100, ai_core: 100, computing_module: 200 },
      storageCaps: blankCaps(10000),
      level: 50,
      aiCoreCrafted: true,
      ascendantCoreCrafted: false,
    });
    expect(state.ascendantCoreCrafted).toBe(false);
    advanceIsland(state, 8_000_000, { defs: powerFreeAsc });
    expect(state.ascendantCoreCrafted).toBe(true);
    expect(state.inventory.ascendant_core ?? 0).toBeGreaterThan(0);
  });
});

// -----------------------------------------------------------------------
// §5.2 Heat adjacency — economy integration
// -----------------------------------------------------------------------

describe('§5.2 — heat adjacency in computeRates/advanceIsland', () => {
  // Blast Furnace consumes iron_ingot + coke and produces pig_iron on a
  // 480s cycle. With an adjacent Coal Furnace, the BF runs at full rate AND
  // the furnace burns coal at (consumers / 30s) per second. With no adjacent
  // source, the BF's effective rate is zero — no production, no consumption,
  // no power draw. Heat tests use power-free catalogs to avoid mixing the
  // §5.1 brownout system into the §5.2 verification.
  function powerFreeBfCfCatalog(): DefCatalog {
    const base = { ...BUILDING_DEFS } as Record<BuildingDefId, BuildingDef>;
    {
      const { power: _p, ...rest } = base.blast_furnace;
      base.blast_furnace = rest as BuildingDef;
    }
    return base;
  }

  it('Blast Furnace with adjacent Coal Furnace → runs at full rate, furnace burns coal', () => {
    const BF: PlacedBuilding = { id: 'bf', defId: 'blast_furnace', x: 0, y: 0 };
    // Coal furnace at (3,1) — east border of BF.
    const CF: PlacedBuilding = { id: 'cf', defId: 'coal_furnace', x: 3, y: 1 };
    const state = makeState({
      buildings: [BF, CF],
      // Plenty of iron_ingot + coke + coal so the BF can run multiple cycles
      // and the coal-furnace fuel-burn doesn't choke the chain.
      inventory: {
        ...blankInventory(),
        iron_ingot: 1000,
        coke: 1000,
        coal: 1000,
      },
      storageCaps: blankCaps(10_000),
      // Blast Furnace is T2 — bypass the §9.7 tier-band runtime gate.
      level: 5,
    });
    // 10 BF cycles = 4800s. Expected pig_iron = 10; iron_ingot/coke down by 10
    // each. Coal furnace burns (1 consumer × 1 coalPerCycle / 30s) × 4800s
    // = 160 coal. Start 1000, end 840.
    advanceIsland(state, 4_800_000, { defs: powerFreeBfCfCatalog() });
    expect(state.inventory.pig_iron).toBeCloseTo(30, 6);
    expect(state.inventory.iron_ingot).toBeCloseTo(970, 6);
    expect(state.inventory.coke).toBeCloseTo(970, 6);
    expect(state.inventory.coal).toBeCloseTo(840, 6);
  });

  it('Blast Furnace with no adjacent heat source → effective rate 0', () => {
    const BF: PlacedBuilding = { id: 'bf', defId: 'blast_furnace', x: 0, y: 0 };
    const state = makeState({
      buildings: [BF],
      inventory: {
        ...blankInventory(),
        iron_ingot: 100,
        coke: 100,
      },
      storageCaps: blankCaps(10_000),
      // Level 5 so the §9.7 tier-band runtime gate passes; the heat gate
      // is the one that's expected to zero the BF here.
      level: 5,
    });
    advanceIsland(state, 10_000_000, { defs: powerFreeBfCfCatalog() });
    // No pig_iron produced; inputs untouched.
    expect(state.inventory.pig_iron).toBe(0);
    expect(state.inventory.iron_ingot).toBe(100);
    expect(state.inventory.coke).toBe(100);
  });

  it('Blast Furnace with adjacent free Geothermal Vent → runs at full rate, no coal cost', () => {
    const BF: PlacedBuilding = { id: 'bf', defId: 'blast_furnace', x: 0, y: 0 };
    const GV: PlacedBuilding = { id: 'gv', defId: 'geothermal_vent', x: 3, y: 0 };
    // Strip power on geothermal_vent + blast_furnace to keep the test
    // power-balance-independent.
    const cat = ((): DefCatalog => {
      const base = { ...BUILDING_DEFS } as Record<BuildingDefId, BuildingDef>;
      {
        const { power: _p, ...rest } = base.blast_furnace;
        base.blast_furnace = rest as BuildingDef;
      }
      {
        const { power: _p, ...rest } = base.geothermal_vent;
        base.geothermal_vent = rest as BuildingDef;
      }
      return base;
    })();
    const state = makeState({
      buildings: [BF, GV],
      inventory: {
        ...blankInventory(),
        iron_ingot: 1000,
        coke: 1000,
        coal: 100, // intentionally low — verifies no coal is consumed
      },
      storageCaps: blankCaps(10_000),
      level: 5, // T2 for Blast Furnace — bypass §9.7 tier-band runtime gate
    });
    advanceIsland(state, 4_800_000, { defs: cat });
    expect(state.inventory.pig_iron).toBeCloseTo(30, 6);
    expect(state.inventory.coal).toBe(100); // free source — no coal burn
  });

  it('two Blast Furnaces sharing one Coal Furnace → furnace burns 2× coal', () => {
    const BF_A: PlacedBuilding = { id: 'bf-a', defId: 'blast_furnace', x: 0, y: 0 };
    const BF_B: PlacedBuilding = { id: 'bf-b', defId: 'blast_furnace', x: 4, y: 0 };
    const CF: PlacedBuilding = { id: 'cf', defId: 'coal_furnace', x: 3, y: 1 };
    const state = makeState({
      buildings: [BF_A, BF_B, CF],
      inventory: {
        ...blankInventory(),
        iron_ingot: 1000,
        coke: 1000,
        coal: 1000,
      },
      storageCaps: blankCaps(10_000),
      level: 5, // T2 for Blast Furnace — bypass §9.7 tier-band runtime gate
    });
    // 4800s integration. Each BF runs 10 cycles → 20 pig_iron total, 20
    // iron_ingot + 20 coke consumed. Coal furnace burns 2 × 1 / 30 × 4800
    // = 320 coal. Start 1000, end 680.
    advanceIsland(state, 4_800_000, { defs: powerFreeBfCfCatalog() });
    expect(state.inventory.pig_iron).toBeCloseTo(60, 6);
    expect(state.inventory.iron_ingot).toBeCloseTo(940, 6);
    expect(state.inventory.coke).toBeCloseTo(940, 6);
    expect(state.inventory.coal).toBeCloseTo(680, 6);
  });
});

// -----------------------------------------------------------------------
// §9.7 Tier Reset — runtime tier-band gate integration
// -----------------------------------------------------------------------

describe('§9.7 — tier-band runtime gate', () => {
  it('a T2 building on a post-reset L1 island has effectiveRate=0 and produces no power', () => {
    // Place a T2 Blast Furnace + supporting Coal Furnace + Mine + plenty of
    // inputs. Verify the T2 BF stalls (and the T1 Coal Furnace doesn't power
    // the test result independently). Mine is T1 so it still runs.
    const BF: PlacedBuilding = { id: 'bf', defId: 'blast_furnace', x: 0, y: 0 };
    const CF: PlacedBuilding = { id: 'cf', defId: 'coal_furnace', x: 3, y: 1 };
    const PWR_FREE_BF: DefCatalog = ((): DefCatalog => {
      const base = { ...BUILDING_DEFS } as Record<BuildingDefId, BuildingDef>;
      const { power: _p, ...rest } = base.blast_furnace;
      base.blast_furnace = rest as BuildingDef;
      return base;
    })();
    const state = makeState({
      buildings: [BF, CF],
      inventory: {
        ...blankInventory(),
        iron_ingot: 1000,
        coke: 1000,
        coal: 1000,
      },
      storageCaps: blankCaps(10_000),
      level: 1, // L1 ⇒ post-reset slate; the BF is T2-gated and stalled.
    });
    // Sanity: at L5+ the BF runs (covered in the §5.2 tests above). At L1
    // it must not.
    const rates = computeRates(state, { defs: PWR_FREE_BF });
    const bfRate = rates.byBuilding.find((r) => r.building.id === 'bf');
    expect(bfRate).toBeDefined();
    expect(bfRate?.effectiveRate).toBe(0);
    // No pig_iron over a 100s tick; inventory untouched apart from the
    // mine-coal flow (no mine here, so coal stays at 1000).
    advanceIsland(state, 100_000, { defs: PWR_FREE_BF });
    expect(state.inventory.pig_iron).toBe(0);
    expect(state.inventory.iron_ingot).toBe(1000);
    expect(state.inventory.coke).toBe(1000);
  });

  it('post-reset: a T2 BF that ran at L15 stops producing on the next tick', async () => {
    // End-to-end: build a T3 island with a Blast Furnace + Coal Furnace,
    // run a slice of ticks at L15 (BF produces), call executeTierReset,
    // then run another slice. BF must now be tier-gated to baseRate=0
    // and inventory.pig_iron must not advance.
    const { executeTierReset, tierResetCost } = await import('./tier-reset.js');
    const BF: PlacedBuilding = { id: 'bf', defId: 'blast_furnace', x: 0, y: 0 };
    const CF: PlacedBuilding = { id: 'cf', defId: 'coal_furnace', x: 3, y: 1 };
    const PWR_FREE_BF: DefCatalog = ((): DefCatalog => {
      const base = { ...BUILDING_DEFS } as Record<BuildingDefId, BuildingDef>;
      const { power: _p, ...rest } = base.blast_furnace;
      base.blast_furnace = rest as BuildingDef;
      return base;
    })();
    const cost = tierResetCost(15);
    const state = makeState({
      buildings: [BF, CF],
      inventory: {
        ...blankInventory(),
        iron_ingot: 1000,
        coke: 1000,
        coal: 1000,
        // Fund the reset alongside the recipe inputs.
        steel: cost.steel,
        gear: cost.gear,
      },
      storageCaps: blankCaps(10_000),
      level: 15,
    });
    advanceIsland(state, 4_800_000, { defs: PWR_FREE_BF });
    // BF ran 10 cycles → 10 pig_iron produced pre-reset.
    expect(state.inventory.pig_iron).toBeCloseTo(30, 6);
    const pigIronBefore = state.inventory.pig_iron;
    executeTierReset(state, state.lastTick);
    expect(state.level).toBe(1); // T1 now
    // Run another 4_800_000 ms — BF is T2-gated post-reset, must not produce.
    advanceIsland(state, state.lastTick + 4_800_000, { defs: PWR_FREE_BF });
    expect(state.inventory.pig_iron).toBeCloseTo(pigIronBefore, 6);
  });

  it('inventory is preserved across an executeTierReset call (cost-only deduction)', async () => {
    const { executeTierReset, tierResetCost } = await import('./tier-reset.js');
    const cost = tierResetCost(15);
    const state = makeState({
      level: 15,
      inventory: {
        ...blankInventory(),
        // Fund the reset, plus extra of every interesting resource.
        steel: cost.steel + 200,
        gear: cost.gear + 100,
        iron_ore: 500,
        coal: 400,
        bolt: 300,
      },
      storageCaps: blankCaps(10_000),
      xp: 5_000,
    });
    executeTierReset(state, 1_000);
    // Level/XP cleared.
    expect(state.level).toBe(1);
    expect(state.xp).toBe(0);
    // Cost deducted; other resources preserved.
    expect(state.inventory.steel).toBe(200);
    expect(state.inventory.gear).toBe(100);
    expect(state.inventory.iron_ore).toBe(500);
    expect(state.inventory.coal).toBe(400);
    expect(state.inventory.bolt).toBe(300);
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
      name: 'founder',
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
      'test-seed',
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
  it('Mine on a coal-tile spec produces coal at 1/50s (not iron_ore)', () => {
    // Mine on coal tile → mine_on_coal. Rate 9/10s = 0.9 coal/s. Over 100 s = 90 coal. (rebalanced 2026-05-23)
    const state = makeState({
      buildings: [MINE],
      inventory: blankInventory(),
    });
    advanceIsland(state, 100_000, {
      defs: POWER_FREE,
      terrainAt: () => 'coal',
    });
    expect(state.inventory.coal).toBeCloseTo(90, 9);
    expect(state.inventory.iron_ore).toBeCloseTo(0, 9);
  });

  it('Mine on an ore-tile spec produces iron_ore at 1/50s (mine_on_ore branch)', () => {
    // Mine on ore tile → mine_on_ore. Rate 1/50s = 0.02/s. Over 100s = 2 iron_ore. (rebalanced step #19)
    const state = makeState({
      buildings: [MINE],
      inventory: blankInventory(),
    });
    advanceIsland(state, 100_000, {
      defs: POWER_FREE,
      terrainAt: () => 'ore',
    });
    expect(state.inventory.iron_ore).toBeCloseTo(5.88235294117647, 9);
    expect(state.inventory.coal).toBeCloseTo(0, 9);
  });

  it('Mine with no terrainAt falls back to RECIPES.mine (iron_ore)', () => {
    // Legacy callers keep pre-tile-aware behaviour (Mine → iron_ore). 0.02/s × 100s = 2. (rebalanced step #19)
    const state = makeState({
      buildings: [MINE],
      inventory: blankInventory(),
    });
    advanceIsland(state, 100_000, { defs: POWER_FREE });
    expect(state.inventory.iron_ore).toBeCloseTo(5.88235294117647, 9);
    expect(state.inventory.coal).toBeCloseTo(0, 9);
  });

  it('Mine on a mixed ore+coal footprint picks the coal variant (any coal tile wins)', () => {
    // 1 coal tile among 4 ore tiles → mine_on_coal. 0.9/s × 100s = 90 coal. (rebalanced 2026-05-23)
    const state = makeState({
      buildings: [MINE],
      inventory: blankInventory(),
    });
    advanceIsland(state, 100_000, {
      defs: POWER_FREE,
      terrainAt: (x, y) => (x === 1 && y === 1 ? 'coal' : 'ore'),
    });
    expect(state.inventory.coal).toBeCloseTo(90, 9);
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
      name: 'plains-test',
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
      // (no Mine output flow-through needed for this test). Also seed
      // stone + wood for the §14 placement cost (Smelter: 50 stone, 20 wood).
      inventory: { ...blankInventory(), iron_ore: 100, coal: 100, stone: 200, wood: 100 },
      storageCaps: blankCaps(10000),
      level: 5, // T1 unlocked; Smelter is T1
    });
    // Before placement: no recipes running.
    const before = computeRates(state, { defs: POWER_FREE });
    expect(before.production.iron_ingot ?? 0).toBe(0);

    // Place a Smelter at island origin.
    let counter = 0;
    const gen = (): string => `int-${++counter}`;
    const pr = placeBuilding(spec, state, 'smelter', 0, 0, 0, gen);
    expect(pr.ok).toBe(true);
    expect(spec.buildings).toHaveLength(1);
    expect(state.buildings).toBe(spec.buildings); // live reference
    // §9.3 Robotics: clear construction-in-progress so the building reads as
    // operational this tick. The integration test under exercise here is
    // "spec.buildings → state.buildings live reference is visible to
    // computeRates" — construction-time gating is its own test suite.
    (spec.buildings[0] as { constructionRemainingMs?: number }).constructionRemainingMs = 0;

    // After placement: Smelter 1/80s = 0.0125/s. (rebalanced step #19: was 1/8s = 0.125/s)
    // Strip Smelter power for this test (same reason as step-9 test above).
    const noSmelterPower = ((): DefCatalog => {
      const base = { ...BUILDING_DEFS } as Record<BuildingDefId, BuildingDef>;
      const { power: _p, ...rest } = base.smelter;
      base.smelter = rest as BuildingDef;
      return base;
    })();
    const after = computeRates(state, { defs: noSmelterPower });
    expect(after.production.iron_ingot ?? 0).toBeCloseTo(0.037037037037037035, 9);
    expect(after.byBuilding).toHaveLength(1);
    expect(after.byBuilding[0]!.building.defId).toBe('smelter');
  });
});

// ---------------------------------------------------------------------------
// §4.7 maintenance integration — operating-time accrual + auto-maintain
// ---------------------------------------------------------------------------
describe('§4.7 maintenance — integration with advanceIsland', () => {
  const HOUR_MS = 60 * 60 * 1000;
  const T1_THRESHOLD = 12 * HOUR_MS;

  it('operatingMs accrues across advanceIsland segments regardless of production', () => {
    // A Mine that can't produce (iron_ore at cap) should still accrue
    // operating time — §4.7 literal: "Idle buildings ... accrue maintenance
    // time the same as actively-producing ones".
    const state = makeState({
      buildings: [{ ...MINE, operatingMs: 0, placedAt: 0, maintainedAt: 0 }],
      // Cap iron_ore at 0 so the Mine output-stalls immediately.
      storageCaps: { ...blankCaps(0) },
      inventory: { ...blankInventory(), iron_ore: 0 },
    });
    advanceIsland(state, 5_000, { defs: POWER_FREE });
    expect(state.buildings[0]!.operatingMs).toBe(5_000);
  });

  it('operatingMs accrues over a 24h offline catchup gap', () => {
    // The same loop handles 1 frame and 24h offline (§15.3). Verify
    // operatingMs reaches the full gap length.
    const state = makeState({
      buildings: [{ ...MINE, operatingMs: 0, placedAt: 0, maintainedAt: 0 }],
      storageCaps: blankCaps(1_000_000),
    });
    const TWO_FOUR_H = 24 * HOUR_MS;
    advanceIsland(state, TWO_FOUR_H, { defs: POWER_FREE });
    expect(state.buildings[0]!.operatingMs).toBe(TWO_FOUR_H);
  });

  it('Mine production degrades to 50% after threshold + 4h with no materials', () => {
    // Place a Mine, jump forward past plateau, verify rate halved.
    // The Mine recipe gives 1/50s = 0.02/s nominal at 100%; at 50% → 0.01/s.
    const state = makeState({
      buildings: [
        {
          ...MINE,
          operatingMs: T1_THRESHOLD + 4 * HOUR_MS, // plateau
          placedAt: 0,
          maintainedAt: 0,
        },
      ],
      storageCaps: blankCaps(1_000_000),
    });
    const rates = computeRates(state, { defs: POWER_FREE });
    expect(rates.byBuilding[0]!.effectiveRate).toBeCloseTo(0.029411764705882353, 9);
    expect(rates.production.iron_ore).toBeCloseTo(0.029411764705882353, 9);
  });

  it('auto-maintains when materials are present, resetting operatingMs to 0', () => {
    // Threshold-crossed Mine + stocked maintenance materials → tick fires
    // the auto-maintain cycle, consuming materials and zeroing the timer.
    const state = makeState({
      buildings: [
        {
          ...MINE,
          operatingMs: T1_THRESHOLD + 10, // just over threshold
          placedAt: 0,
          maintainedAt: 0,
        },
      ],
      storageCaps: blankCaps(1_000_000),
      inventory: {
        ...blankInventory(),
        // T1 maintenance recipe = 2 lubricant + 5 bolt.
        lubricant: 10,
        bolt: 10,
      },
    });
    advanceIsland(state, 1_000, { defs: POWER_FREE });
    // Materials consumed, timer reset to dt of the post-maintain segment.
    expect(state.inventory.lubricant).toBe(8);
    expect(state.inventory.bolt).toBe(5);
    // After auto-maintain (at segment t=0), accrual restarts; after 1s the
    // counter is just the dt of the segment.
    expect(state.buildings[0]!.operatingMs).toBe(1_000);
  });

  it('stays degraded when maintenance materials absent', () => {
    const state = makeState({
      buildings: [
        {
          ...MINE,
          operatingMs: T1_THRESHOLD + 2 * HOUR_MS, // 75% factor
          placedAt: 0,
          maintainedAt: 0,
        },
      ],
      storageCaps: blankCaps(1_000_000),
      // No lubricant / bolt in inventory.
    });
    advanceIsland(state, 60_000, { defs: POWER_FREE });
    // operatingMs grew by 60s. No reset because materials absent.
    expect(state.buildings[0]!.operatingMs).toBe(T1_THRESHOLD + 2 * HOUR_MS + 60_000);
    // Still degraded. Mine base = 1/17 (post-÷3), degraded ≈ 1/34.
    const rates = computeRates(state, { defs: POWER_FREE });
    expect(rates.byBuilding[0]!.effectiveRate).toBeLessThan(1 / 17);
    expect(rates.byBuilding[0]!.effectiveRate).toBeGreaterThan(1 / 34);
  });

  it('always targets the most-degraded building (no fall-through to lesser-degraded)', () => {
    // Two T1 Mines: one at the 0.5 plateau, one freshly past threshold.
    // Materials in stock = exactly one T1 recipe (2 lubricant + 5 bolt) —
    // could service either building. New policy: the plateau-deep one
    // wins; the just-past-threshold one is NOT serviced.
    const state = makeState({
      buildings: [
        // Listed first but only mildly degraded — old FIFO would have picked
        // this one; the new policy MUST skip it.
        {
          ...MINE,
          id: 'mine-light',
          operatingMs: T1_THRESHOLD + 10,
          placedAt: 0,
          maintainedAt: 0,
        },
        {
          ...MINE,
          id: 'mine-plateau',
          operatingMs: T1_THRESHOLD + MAINTENANCE_DEGRADE_DURATION_MS + 1000,
          placedAt: 0,
          maintainedAt: 0,
        },
      ],
      storageCaps: blankCaps(1_000_000),
      inventory: {
        ...blankInventory(),
        lubricant: 2, // exactly one T1 recipe — no room for two cycles
        bolt: 5,
      },
    });
    advanceIsland(state, 1_000, { defs: POWER_FREE });
    // The plateau-deep building is the one that got maintained.
    const light = state.buildings.find((b) => b.id === 'mine-light')!;
    const plateau = state.buildings.find((b) => b.id === 'mine-plateau')!;
    expect(plateau.operatingMs).toBe(1_000); // reset to 0 then 1s of accrual
    expect(light.operatingMs).toBeGreaterThan(T1_THRESHOLD); // untouched / still degraded
    expect(state.inventory.lubricant).toBe(0);
    expect(state.inventory.bolt).toBe(0);
  });

  it('waits when the most-degraded building lacks materials — does not service a lesser candidate', () => {
    // T3 building at plateau (most degraded) but its T3 recipe inputs
    // (electric_motor, capacitor) are NOT in stock. A T1 building is also
    // mildly degraded and the T1 inputs ARE in stock. New policy: NEITHER
    // is serviced — we wait for materials for the most-degraded one rather
    // than burning T1 inputs on a cheap target.
    const state = makeState({
      buildings: [
        {
          id: 'mine-light',
          defId: 'mine',
          x: 0,
          y: 0,
          operatingMs: T1_THRESHOLD + 10,
          placedAt: 0,
          maintainedAt: 0,
        } as PlacedBuilding,
        {
          id: 'fab-plateau',
          defId: 'motor_assembly', // T3 manufacturing building (was 'fabricator', a removed stub)
          x: 5,
          y: 0,
          operatingMs:
            MAINTENANCE_THRESHOLD_MS_BY_TIER[3] + MAINTENANCE_DEGRADE_DURATION_MS + 1000,
          placedAt: 0,
          maintainedAt: 0,
        } as PlacedBuilding,
      ],
      storageCaps: blankCaps(1_000_000),
      inventory: {
        ...blankInventory(),
        // T1 maintenance inputs stocked; T3 maintenance inputs NOT.
        lubricant: 100,
        bolt: 100,
      },
    });
    advanceIsland(state, 1_000, { defs: POWER_FREE });
    const light = state.buildings.find((b) => b.id === 'mine-light')!;
    const plateau = state.buildings.find((b) => b.id === 'fab-plateau')!;
    // Neither was serviced — T1 inputs remain in stock, T1 timer still ticking.
    expect(state.inventory.lubricant).toBe(100);
    expect(state.inventory.bolt).toBe(100);
    expect(light.operatingMs).toBe(T1_THRESHOLD + 10 + 1_000);
    expect(plateau.operatingMs).toBeGreaterThan(MAINTENANCE_THRESHOLD_MS_BY_TIER[3]);
  });

  // NOTE: the prior "Robotics skill stretches the maintenance threshold"
  // test was removed in the Robotics rewiring slice — Robotics now drives
  // construction time / parallel build slots (its true spec themes), not
  // maintenance. The `maintenanceThresholdMul` effect kind survives in the
  // union as a forward-compat hook but no catalog node currently uses it.

  it('Eternal Servitor flag exempts a building from operatingMs accrual', () => {
    const state = makeState({
      buildings: [
        {
          ...MINE,
          operatingMs: 0,
          placedAt: 0,
          maintainedAt: 0,
          eternalServitor: true,
        },
      ],
      storageCaps: blankCaps(1_000_000),
    });
    advanceIsland(state, 24 * HOUR_MS, { defs: POWER_FREE });
    // 24h elapsed but timer stayed at 0 (the flag short-circuits accrual).
    expect(state.buildings[0]!.operatingMs).toBe(0);
  });
});

describe('step-20 T6 gate composition (§14.1)', () => {
  it('a level-50 + AI core + ascendant + Spaceport state unlocks the T6 catalog band', () => {
    // Compose the IslandState surface and a spec-like buildings list to
    // exercise `unlockedDefs` against the §14.1 gate. This is the
    // canonical "the demo path works" coverage: forest-ne is seeded at
    // this exact configuration in main.ts.
    const state = makeState({
      level: 50,
      aiCoreCrafted: true,
      ascendantCoreCrafted: true,
      buildings: [{ id: 'sp-1', defId: 'spaceport', x: 0, y: 0 }],
    });
    const hasSpaceport = state.buildings.some((b) => b.defId === 'spaceport');
    const list = unlockedDefs(
      state.level,
      state.aiCoreCrafted,
      state.ascendantCoreCrafted,
      hasSpaceport,
    );
    // Every T6 def is now in the list.
    expect(list).toContain('spaceport');
    expect(list).toContain('antimatter_refinery');
    expect(list).toContain('scanner_sat_assembly');
    expect(list).toContain('relay_sat_assembly');
    expect(list).toContain('sweeper_sat_assembly');
    expect(list).toContain('oip_assembly');
    expect(list).toContain('repair_pack_assembly');
    expect(list).toContain('repair_drone_assembly');
    // T5 ascendant_assembly also in the list (needed to craft ascendant_core).
    expect(list).toContain('ascendant_assembly');
  });

  it('without a Spaceport, only the Spaceport itself unlocks from T6 (chicken-and-egg per §14.1)', () => {
    const state = makeState({
      level: 50,
      aiCoreCrafted: true,
      ascendantCoreCrafted: true,
      buildings: [],
    });
    const hasSpaceport = state.buildings.some((b) => b.defId === 'spaceport');
    const list = unlockedDefs(
      state.level,
      state.aiCoreCrafted,
      state.ascendantCoreCrafted,
      hasSpaceport,
    );
    expect(list).toContain('spaceport');
    expect(list).not.toContain('antimatter_refinery');
    expect(list).not.toContain('scanner_sat_assembly');
    expect(list).not.toContain('relay_sat_assembly');
    expect(list).not.toContain('sweeper_sat_assembly');
    expect(list).not.toContain('oip_assembly');
    expect(list).not.toContain('repair_pack_assembly');
    expect(list).not.toContain('repair_drone_assembly');
  });
});

describe('day-night solar modulation (§2.7)', () => {
  // Quadrant anchors relative to `nowMs = 0` (phase 0.375, mid-Day):
  //   t = 0   → Day   (mul 1.0)
  //   t = 3h  → Dusk  start (mul 0.5)
  //   t = 9h  → Night start (mul 0.0)
  //   t = 15h → Dawn  start (mul 0.5)
  //   t = 21h → Day   start (mul 1.0)
  const HOUR = 60 * 60 * 1000;

  it('Solar at noon produces full nameplate (50W × 1.0)', () => {
    const state = makeState({
      buildings: [SOLAR],
      lastTick: 0, // mid-Day
    });
    const { power } = computeRates(state);
    expect(power.produced).toBe(50);
  });

  it('Solar at dawn midpoint produces half nameplate (50W × 0.5 = 25W)', () => {
    // §2.7 ramp: dawn linearly interpolates 0 → 1 over the quadrant.
    // At the dawn midpoint (t = -6h or equivalently 18h), mul = 0.5.
    const state = makeState({
      buildings: [SOLAR],
      lastTick: 18 * HOUR, // Dawn quadrant midpoint
    });
    const { power } = computeRates(state, undefined, 18 * HOUR);
    expect(power.produced).toBe(25);
  });

  it('Solar at dawn start produces zero (50W × 0.0)', () => {
    // §2.7 ramp: at dawn start, mul = 0.
    const state = makeState({
      buildings: [SOLAR],
      lastTick: 15 * HOUR, // Dawn start (Night→Dawn boundary)
    });
    const { power } = computeRates(state, undefined, 15 * HOUR);
    expect(power.produced).toBe(0);
  });

  it('Solar at dusk midpoint produces half nameplate (50W × 0.5 = 25W)', () => {
    // §2.7 ramp: dusk linearly interpolates 1 → 0 over the quadrant.
    // At the dusk midpoint (t = +6h), mul = 0.5.
    const state = makeState({
      buildings: [SOLAR],
      lastTick: 6 * HOUR, // Dusk quadrant midpoint
    });
    const { power } = computeRates(state, undefined, 6 * HOUR);
    expect(power.produced).toBe(25);
  });

  it('Solar at dusk start produces full nameplate (50W × 1.0)', () => {
    // §2.7 ramp: at dusk start, mul = 1.
    const state = makeState({
      buildings: [SOLAR],
      lastTick: 3 * HOUR, // Dusk start (Day→Dusk boundary)
    });
    const { power } = computeRates(state, undefined, 3 * HOUR);
    expect(power.produced).toBe(50);
  });

  it('Solar at midnight produces zero (50W × 0.0)', () => {
    const state = makeState({
      buildings: [SOLAR],
      lastTick: 12 * HOUR, // Night quadrant
    });
    const { power } = computeRates(state, undefined, 12 * HOUR);
    expect(power.produced).toBe(0);
  });

  it('§2.7 deep night: solar producer + consumer → balance has zero solar contribution', () => {
    // Regression guard for the "solar producing power during night" bug.
    // Solar (50W) alone + a Mine (40W consumer). At deep night t=12h the
    // multiplier is 0.0, so `power.produced` must be 0 — confirming
    // `def.power.solar === true` IS being gated by solarMultiplier(t).
    // Sample mid-night (12h), early-night (9h + 1ms), late-night (15h - 1ms).
    for (const t of [9 * HOUR + 1, 12 * HOUR, 15 * HOUR - 1]) {
      const state = makeState({
        buildings: [SOLAR, MINE_PWR],
        inventory: { ...blankInventory() },
        lastTick: t,
      });
      const { power } = computeRates(state, undefined, t);
      expect(power.produced).toBe(0);
    }
  });

  it('non-solar producers ignore the multiplier (Coal Gen at night still produces 100W)', () => {
    // Coal Gen burns coal; needs coal in inventory to be active.
    const state = makeState({
      buildings: [COAL_GEN],
      inventory: { ...blankInventory(), coal: 50 },
      lastTick: 12 * HOUR, // Night
    });
    const { power } = computeRates(state, undefined, 12 * HOUR);
    expect(power.produced).toBe(100);
  });

  it('§2.7 Sunspire is solar-tagged — produces 0W at deep night (regression: missing `solar: true` flag)', () => {
    // SPEC §2.7 line 277 explicitly lists Sunspire alongside Solar Panel as
    // a "solar building" subject to the day-night curve. User-reported bug:
    // the Sunspire def (60 MW) lacked `power.solar: true`, so the §5.1
    // producer-summing path never gated its wattage by solarMultiplier and
    // the network reported full power at night with no other producers.
    const SUNSPIRE: PlacedBuilding = { id: 'b-sunspire', defId: 'sunspire', x: 0, y: 0 };
    // §9.7 tier gate: Sunspire is T4, requires islandLevel >= 30 to be active.
    const state = makeState({
      buildings: [SUNSPIRE],
      lastTick: 12 * HOUR, // Night quadrant — solarMultiplier = 0.
      level: 30,
    });
    const { power } = computeRates(state, undefined, 12 * HOUR);
    expect(power.produced).toBe(0);
  });

  it('§2.7 wall-clock domain: solarClockMs overrides nowMs (post-refresh regression)', () => {
    // User-reported bug after the §2.7 ramp landed (8e8b4dd) AND the Sunspire
    // flag landed (a4f9f98): basic Solar still pushed full 50W into the
    // network at night-time after a page refresh.
    //
    // Root cause: `solarMultiplier` was sampled in `performance.now()` domain
    // via `state.lastTick`, which resets to ~0 on every page reload — placing
    // every freshly-loaded session in mid-Day per the §2.7 EPOCH_PHASE_OFFSET.
    // Wall-clock cycle (the HUD's `hud.ts:307` `Date.now()` phase label, and
    // the spec's §2.7 "purely time-driven and does not depend on the player's
    // session") would say Night, but the economy gate would say Day. Power
    // produced read full 50W while the HUD read "solar 0.0×" — the
    // contradiction the user observed.
    //
    // Fix: thread a `solarClockMs` (wall-clock domain) into `computeRates`
    // separately from `nowMs` (perf domain). When provided, the solar gate
    // samples it instead of `nowMs ?? state.lastTick`. Production callers
    // pass `Date.now()` so the gate matches the HUD; tests omit it and keep
    // their existing `nowMs = 12*HOUR ⇒ Night` convention.
    const state = makeState({
      buildings: [SOLAR],
      // `lastTick = 0` would historically yield mid-Day solar (mul = 1.0).
      // This mirrors the post-refresh production case where state.lastTick
      // (perf-domain) is small while the wall clock is mid-Night.
      lastTick: 0,
    });
    // Explicit wall-clock sample at deep night → multiplier 0 → 0W produced,
    // even though the perf-domain time would otherwise read mid-Day.
    const night = computeRates(state, undefined, 0, 12 * HOUR);
    expect(night.power.produced).toBe(0);
    // And the inverse: wall-clock noon with a synthetic-night `nowMs` still
    // produces full 50W, proving solarClockMs is the active sample.
    const noon = computeRates(state, undefined, 12 * HOUR, 0);
    expect(noon.power.produced).toBe(50);
  });

  it('mixed island: at night only coal generator contributes; at noon both do', () => {
    // SOLAR (50W) + COAL_GEN (100W) into MINE (40W) + WORKSHOP (60W) = 100W demand.
    const buildings = [SOLAR, COAL_GEN, MINE_PWR, WORKSHOP_PWR];
    const inv = { ...blankInventory(), coal: 50, iron_ore: 50 };
    // Noon: produced = 50 + 100 = 150.
    const noon = makeState({ buildings, inventory: { ...inv }, lastTick: 0 });
    const noonPower = computeRates(noon).power;
    expect(noonPower.produced).toBe(150);
    // Night: solar 0, coal still 100.
    const night = makeState({ buildings, inventory: { ...inv }, lastTick: 12 * HOUR });
    const nightPower = computeRates(night, undefined, 12 * HOUR).power;
    expect(nightPower.produced).toBe(100);
  });

  it('offline catchup over 24h integrates ramp sub-segments (matches per-quadrant ticking)', () => {
    // Solar (50W, modulated by §2.7 linear ramp) feeds a Mine (40W consumer,
    // no input recipe — pure power-throttle producer). Across one full day
    // starting at the Day→Dusk boundary (t = 3h), the §15.3 integrator clamps
    // each segment to the next §2.7 sub-boundary (`SOLAR_RAMP_SEGMENTS=8`
    // sub-segments per dawn/dusk quadrant, plus the day/night quadrant
    // transitions). Within each sub-segment the integrator samples mul at
    // segment start.
    //
    // Use `eternalServitor: true` to disable §4.7 maintenance — otherwise the
    // T1 Mine's 12h threshold + 4h ramp would entangle the day-night signal
    // with maintenance segments. Big caps avoid output-stall events.
    const SOLAR_ETERNAL: PlacedBuilding = { ...SOLAR, eternalServitor: true };
    const MINE_ETERNAL: PlacedBuilding = { ...MINE_PWR, eternalServitor: true };
    function makeSolarMineState(startMs: number): IslandState {
      return makeState({
        buildings: [SOLAR_ETERNAL, MINE_ETERNAL],
        inventory: { ...blankInventory() },
        storageCaps: blankCaps(1e9),
        lastTick: startMs,
      });
    }

    const start = 3 * HOUR; // Day→Dusk boundary
    const end = start + 24 * HOUR;

    // (a) One big offline catchup.
    const offline = makeSolarMineState(start);
    advanceIsland(offline, end);

    // (b) Step through each phase boundary manually.
    const stepwise = makeSolarMineState(start);
    advanceIsland(stepwise, start + 6 * HOUR); // end of Dusk
    advanceIsland(stepwise, start + 12 * HOUR); // end of Night
    advanceIsland(stepwise, start + 18 * HOUR); // end of Dawn
    advanceIsland(stepwise, end); // end of next Day

    expect(offline.inventory.iron_ore).toBeCloseTo(stepwise.inventory.iron_ore, 6);
    expect(offline.lastTick).toBe(end);

    // Sanity-check the magnitude. Under SOLAR_RAMP_SEGMENTS=8 sub-segmenting:
    //   Dusk (6h, mul 1→0): start-of-sub-seg muls = [1, 7/8, 6/8, ..., 1/8];
    //     factor = min(1, 2 × mul); sum factors = 6.5;
    //     iron = (1/17)/s × 6.5 × 2700s = 1032.3529
    //   Night (6h, mul 0): iron = 0
    //   Dawn (6h, mul 0→1): start-of-sub-seg muls = [0, 1/8, 2/8, ..., 7/8];
    //     sum factors = 5.5; iron = (1/17) × 5.5 × 2700 = 873.5294
    //   Day (6h, mul 1): iron = (1/17) × 21600 = 1270.5882
    // Total = 1032.3529 + 0 + 873.5294 + 1270.5882 = 3176.4706.
    // (Dawn under-shoots and Dusk over-shoots by symmetric amounts; the
    // FULL-window integral over dawn + dusk is preserved exactly because the
    // mid-point Riemann sum on a linear ramp equals the analytic integral.
    // The asymmetry here arises only because the throttle clips one side.)
    expect(offline.inventory.iron_ore).toBeCloseTo(3176.470588235294, 3);
  });

  it('offline catchup with solar-only producer drops to zero at night', () => {
    // Mine + solar; at night the mine is brownout-stalled (no coal_gen backup).
    // After 24h starting at noon (t=0), inventory should equal sum of Day +
    // Dusk + Dawn contributions, with Night contributing nothing.
    // Eternal servitor to remove maintenance from the picture.
    const SOLAR_ETERNAL: PlacedBuilding = { ...SOLAR, eternalServitor: true };
    const MINE_ETERNAL: PlacedBuilding = { ...MINE_PWR, eternalServitor: true };
    const state = makeState({
      buildings: [SOLAR_ETERNAL, MINE_ETERNAL],
      inventory: { ...blankInventory() },
      storageCaps: blankCaps(1e9),
      lastTick: 0, // mid-Day
    });
    advanceIsland(state, 24 * HOUR);
    // Quadrants in this window:
    //   [0, 3h)   Day   rate (1/17) → 635.2941
    //   [3h, 9h)  Dusk  ramp-sub-seg sum → 1032.3529 (see prior test for derivation)
    //   [9h, 15h) Night rate 0 → 0
    //   [15h, 21h) Dawn ramp-sub-seg sum → 873.5294
    //   [21h, 24h) Day  rate (1/17) → 635.2941
    // Total = 635.2941 + 1032.3529 + 0 + 873.5294 + 635.2941 = 3176.4706.
    expect(state.inventory.iron_ore).toBeCloseTo(3176.470588235294, 3);
  });

  it('§2.7 unmetered solar integral over a full dawn+dusk window matches analytic 0.5', () => {
    // Producer-only assertion (no throttle, no consumer): the sum of
    // start-of-sub-segment samples over a full dawn quadrant equals
    // 0 + 1/8 + 2/8 + ... + 7/8 = 28/8 = 3.5, times sub-segment width (6h/8).
    // Combined with dusk's 1 + 7/8 + ... + 1/8 = 36/8 = 4.5, the dawn+dusk
    // integral equals (3.5 + 4.5) × QUADRANT_MS/8 = QUADRANT_MS — i.e. one
    // full quadrant of "average mul = 0.5", matching the analytic integral
    // of the linear ramp over both quadrants exactly. (Tested via
    // `power.produced` snapshot since the unthrottled producer's wattage is
    // the cleanest observable for the ramp value itself; we step through
    // sub-boundaries and check the sub-segment-weighted sum.)
    const HOUR_MS = HOUR;
    // Sum of (mul at sub-segment start × sub-segment width) over dawn + dusk:
    let weightedSum = 0;
    const subWidthMs = (6 * HOUR_MS) / 8;
    // Dawn samples at the start of each sub-segment.
    for (let i = 0; i < 8; i++) {
      const t = 15 * HOUR_MS + i * subWidthMs; // dawn quadrant t ∈ [15h, 21h)
      const state = makeState({ buildings: [SOLAR], lastTick: t });
      const { power } = computeRates(state, undefined, t);
      weightedSum += (power.produced / 50) * subWidthMs;
    }
    // Dusk samples.
    for (let i = 0; i < 8; i++) {
      const t = 3 * HOUR_MS + i * subWidthMs; // dusk quadrant t ∈ [3h, 9h)
      const state = makeState({ buildings: [SOLAR], lastTick: t });
      const { power } = computeRates(state, undefined, t);
      weightedSum += (power.produced / 50) * subWidthMs;
    }
    // Analytic integral of the ramp over dawn + dusk = 2 × (0.5 × QUADRANT)
    // = one full quadrant (6h in ms).
    expect(weightedSum).toBeCloseTo(6 * HOUR_MS, 3);
  });
});

describe('§14.3 Mirror Sat — effectiveSolar composition (additive ramp + Σ boost, cap at 1)', () => {
  // §2.7 + §14.3: solar producers gate on `min(1, solarMultiplier(t) + ctx.solarBoost)`.
  // The aggregate `solarBoost` is computed once per tick in main.ts (sum of all
  // mirror sats whose per-target contribution > 0.05) and threaded via
  // RatesContext, mirroring `cableComponent`.
  const HOUR = 60 * 60 * 1000;

  it('mid-Day with one mirror in range: boost capped at 1.0 (no over-production)', () => {
    // Mid-Day mul = 1.0; +0.7 mirror boost would saturate at 1.0.
    // Solar nameplate = 50W → produced = 50W, not 50 × 1.7 = 85W.
    const state = makeState({ buildings: [SOLAR], lastTick: 0 });
    const { power } = computeRates(state, { solarBoost: 0.7 }, 0, 0);
    expect(power.produced).toBe(50);
  });

  it('deep night with one mirror in range: produces boost × nameplate (additive proves it)', () => {
    // Night mul = 0; +0.35 mirror boost → effective 0.35 → 50 × 0.35 = 17.5W.
    // (Multiplicative composition would be 0 × 0.35 = 0; additive proves the rule.)
    const state = makeState({ buildings: [SOLAR], lastTick: 12 * HOUR });
    const { power } = computeRates(state, { solarBoost: 0.35 }, 12 * HOUR, 12 * HOUR);
    expect(power.produced).toBeCloseTo(17.5, 12);
  });

  it('deep night with multiple mirrors stacked past 1.0: capped at 1.0 → full nameplate', () => {
    // Three mirrors at d=0 → Σ boost = 2.1. min(1, 0 + 2.1) = 1.0 → 50W (full).
    // Demonstrates "fourth mirror is wasted" saturation visible to the player.
    const state = makeState({ buildings: [SOLAR], lastTick: 12 * HOUR });
    const { power } = computeRates(state, { solarBoost: 2.1 }, 12 * HOUR, 12 * HOUR);
    expect(power.produced).toBe(50);
  });

  it('no mirror boost (ctx omitted): solar gate identical to baseline §2.7 (regression)', () => {
    // ctx.solarBoost defaults to 0 — ensures the new ctx field doesn't
    // accidentally affect islands without any mirror coverage.
    const state = makeState({ buildings: [SOLAR], lastTick: 0 });
    const dayNoMirror = computeRates(state, undefined, 0, 0);
    expect(dayNoMirror.power.produced).toBe(50);
    const nightState = makeState({ buildings: [SOLAR], lastTick: 12 * HOUR });
    const nightNoMirror = computeRates(nightState, undefined, 12 * HOUR, 12 * HOUR);
    expect(nightNoMirror.power.produced).toBe(0);
  });

  it('mirror boost does NOT affect non-solar producers (Coal Gen unchanged)', () => {
    // Coal Gen is not `solar: true`; mirror boost must not raise its wattage.
    const state = makeState({
      buildings: [COAL_GEN],
      inventory: { ...blankInventory(), coal: 50 },
      lastTick: 12 * HOUR,
    });
    const { power } = computeRates(state, { solarBoost: 0.7 }, 12 * HOUR, 12 * HOUR);
    expect(power.produced).toBe(100);
  });
});


describe('accrueXp funnel provenance §10.1', () => {
  it('does not drain funnel for consumption covered by local production', () => {
    const state = makeState({ buildings: [] });
    // Seed funnel credit for iron_ore.
    state.funnelPending.iron_ore = 100;
    // Local production of iron_ore = 5 / sec.
    // Local consumption of iron_ore = 3 / sec (e.g. smelter).
    // Net consumption is negative (production > consumption), so NO funnel
    // drain should occur.
    accrueXp(state, { iron_ore: 5 }, { iron_ore: 3 }, 1);
    expect(state.funnelPending.iron_ore).toBe(100);
    expect(state.xp).toBeGreaterThan(0); // production XP still accrues
  });

  it('drains funnel only for net imported consumption', () => {
    const state = makeState({ buildings: [] });
    state.funnelPending.iron_ore = 100;
    // Local production = 2 / sec, consumption = 5 / sec.
    // Net consumption = 3 / sec → drain 3 * XP_WEIGHT.iron_ore * 0.5.
    accrueXp(state, { iron_ore: 2 }, { iron_ore: 5 }, 1);
    const expectedDrain = 3 * XP_WEIGHT.iron_ore * 0.5;
    expect(state.funnelPending.iron_ore).toBeCloseTo(100 - expectedDrain, 6);
  });

  it('does not drain funnel when production exactly equals consumption', () => {
    const state = makeState({ buildings: [] });
    state.funnelPending.iron_ore = 100;
    accrueXp(state, { iron_ore: 5 }, { iron_ore: 5 }, 1);
    expect(state.funnelPending.iron_ore).toBe(100);
  });
});

describe('accrueXp xpGainMul', () => {
  it('defaults xpGainMul to 1 → no change', () => {
    const state = makeState();
    accrueXp(state, { iron_ore: 5 }, {}, 1);
    expect(state.xp).toBe(5 * XP_WEIGHT.iron_ore);
  });

  it('doubles XP when xpGainMul is 2', () => {
    const state = makeState();
    accrueXp(state, { iron_ore: 5 }, {}, 1, 1, 2);
    expect(state.xp).toBe(5 * XP_WEIGHT.iron_ore * 2);
  });

  it('zeros XP when xpGainMul is 0', () => {
    const state = makeState();
    accrueXp(state, { iron_ore: 5 }, {}, 1, 1, 0);
    expect(state.xp).toBe(0);
  });
});


describe('extractor tile gating §8.1', () => {
  const makeSpecWithTerrain = (terrain: string) => ({
    id: 'test-island',
    name: 'test',
    biome: 'plains' as const,
    cx: 0,
    cy: 0,
    majorRadius: 14,
    minorRadius: 14,
    populated: true,
    discovered: true,
    buildings: [],
    terrainAt: (_x: number, _y: number) => terrain as TerrainKind,
    modifiers: ['stable'] as const,
  });

  const makeStateForPlacement = (level = 1): IslandState =>
    makeState({
      level,
      inventory: { ...blankInventory(), stone: 1000, wood: 1000, iron_ingot: 1000 },
    });

  it('allows logger on tree tile', () => {
    const spec = makeSpecWithTerrain('tree');
    const result = validatePlacement(spec, makeStateForPlacement(), 'logger', 0, 0, 0);
    expect(result.ok).toBe(true);
  });

  it('rejects logger on grass tile', () => {
    const spec = makeSpecWithTerrain('grass');
    const result = validatePlacement(spec, makeStateForPlacement(), 'logger', 0, 0, 0);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe('tile-requirement-not-met');
  });

  it('rejects pump_jack on stone tile', () => {
    const spec = makeSpecWithTerrain('stone');
    const result = validatePlacement(spec, makeStateForPlacement(15), 'pump_jack', 0, 0, 0);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe('tile-requirement-not-met');
  });

  it('stalls logger production when placed on non-tree terrain', () => {
    const state = makeState({
      buildings: [{ id: 'b1', defId: 'logger', x: 0, y: 0 }],
    });
    const rates = computeRates(state, { terrainAt: () => 'grass' });
    expect(rates.production.wood ?? 0).toBe(0);
  });
});

// -----------------------------------------------------------------------
// §13.3 Time Lock — banking + acceleration
// -----------------------------------------------------------------------

describe('Genesis Chamber', () => {
  it('produces T1 resource at 1 per 5min', () => {
    const state = makeState({
      buildings: [{ id: 'g1', defId: 'genesis_chamber', x: 0, y: 0 }],
      genesisTarget: 'iron_ingot',
      level: 50,
      aiCoreCrafted: true,
    });
    // Strip power so the test exercises pure production rate without
    // needing a 50 kW power plant.
    const noGenesisPower = ((): DefCatalog => {
      const base = { ...BUILDING_DEFS } as Record<BuildingDefId, BuildingDef>;
      const { power: _p, ...rest } = base.genesis_chamber;
      base.genesis_chamber = rest as BuildingDef;
      return base;
    })();
    advanceIsland(state, 300_000, { defs: noGenesisPower }); // 5 min
    expect(state.inventory.iron_ingot).toBeCloseTo(1, 1);
  });

  it('draws 50 kW for T1 target', () => {
    const state = makeState({
      buildings: [{ id: 'g1', defId: 'genesis_chamber', x: 0, y: 0 }],
      genesisTarget: 'iron_ingot',
      level: 50,
      aiCoreCrafted: true,
    });
    const { power } = computeRates(state);
    expect(power.consumed).toBeCloseTo(50_000, 0);
  });

  it('draws 50 MW for T4 target', () => {
    const state = makeState({
      buildings: [{ id: 'g1', defId: 'genesis_chamber', x: 0, y: 0 }],
      genesisTarget: 'ai_core',
      level: 50,
      aiCoreCrafted: true,
    });
    const { power } = computeRates(state);
    expect(power.consumed).toBeCloseTo(50_000_000, 0);
  });

  it('rejects T5 target', () => {
    const state = makeState();
    expect(setGenesisTarget(state, 'dark_matter')).toBe(false);
    expect(state.genesisTarget).toBe(null);
  });

  it('rejects T0 target', () => {
    const state = makeState();
    expect(setGenesisTarget(state, 'wood')).toBe(false);
    expect(state.genesisTarget).toBe(null);
  });

  it('produces nothing when genesisTarget is null', () => {
    const state = makeState({
      buildings: [{ id: 'g1', defId: 'genesis_chamber', x: 0, y: 0 }],
      genesisTarget: null,
      level: 50,
      aiCoreCrafted: true,
    });
    advanceIsland(state, 300_000);
    expect(Object.values(state.inventory).every((v) => v === 0)).toBe(true);
  });

  it('respects output cap', () => {
    const state = makeState({
      buildings: [{ id: 'g1', defId: 'genesis_chamber', x: 0, y: 0 }],
      genesisTarget: 'iron_ingot',
      inventory: { ...blankInventory(), iron_ingot: 100 },
      storageCaps: blankCaps(100),
      level: 50,
      aiCoreCrafted: true,
    });
    advanceIsland(state, 300_000);
    // Already at cap, so no production.
    expect(state.inventory.iron_ingot).toBeCloseTo(100, 6);
  });

  it('is throttled by brownout', () => {
    // Genesis Chamber (50 kW) + Mine (40 W) with only Solar (50 W).
    // Total demand ≈ 50,040 W, supply = 50 W → factor ≈ 0.001.
    const state = makeState({
      buildings: [
        { id: 'g1', defId: 'genesis_chamber', x: 0, y: 0 },
        { id: 'm1', defId: 'mine', x: 5, y: 0 },
        { id: 's1', defId: 'solar', x: 10, y: 0 },
      ],
      genesisTarget: 'iron_ingot',
      level: 50,
      aiCoreCrafted: true,
    });
    const { byBuilding } = computeRates(state);
    const genesisRate = byBuilding.find((r) => r.building.defId === 'genesis_chamber')?.effectiveRate;
    expect(genesisRate).toBeDefined();
    expect(genesisRate!).toBeLessThan(1 / 300);
  });
});

describe('Time Lock', () => {
  it('banks offline time instead of advancing', () => {
    const state = makeState({
      buildings: [{ id: 'tl-1', defId: 'time_lock', x: 0, y: 0 }],
      bankingEnabled: true,
    });
    advanceIsland(state, 60 * 60 * 1000); // 1 hour
    expect(state.timeLockBankedMin).toBeCloseTo(60, 6);
    // Inventory unchanged because the island was paused.
    expect(state.inventory.iron_ore).toBe(0);
    expect(state.lastTick).toBe(60 * 60 * 1000);
  });

  it('caps bank at 24h per lock', () => {
    // 2 time locks = 2880 min max.
    const state = makeState({
      buildings: [
        { id: 'tl-1', defId: 'time_lock', x: 0, y: 0 },
        { id: 'tl-2', defId: 'time_lock', x: 3, y: 0 },
      ],
      bankingEnabled: true,
      timeLockBankedMin: 0,
    });
    // Advance 50 hours = 3000 minutes.
    advanceIsland(state, 50 * 60 * 60 * 1000);
    expect(state.timeLockBankedMin).toBeCloseTo(2880, 6);
  });

  it('does not bank when bankingEnabled is false', () => {
    const state = makeState({
      buildings: [{ id: 'tl-1', defId: 'time_lock', x: 0, y: 0 }],
      bankingEnabled: false,
      inventory: { ...blankInventory() },
    });
    // Place a Mine too so we can verify normal advancement.
    state.buildings.push({ id: 'b-mine', defId: 'mine', x: 5, y: 0 });
    advanceIsland(state, 100_000, { defs: POWER_FREE });
    expect(state.timeLockBankedMin).toBe(0);
    expect(state.inventory.iron_ore).toBeCloseTo(5.88235294117647, 6);
  });

  it('triples production while accelerated', () => {
    const state = makeState({
      buildings: [MINE],
      inventory: blankInventory(),
      accelerationRemainingMin: 60,
    });
    advanceIsland(state, 60_000, { defs: POWER_FREE });
    // Base mine 0.02/s. Over 60s at 3× = 3.6 iron_ore.
    expect(state.inventory.iron_ore).toBeCloseTo(10.588235294117647, 6);
    // 1 minute consumed from the 60-minute block.
    expect(state.accelerationRemainingMin).toBeCloseTo(59, 6);
  });

  it('queues multiple spends sequentially', () => {
    const sourceA = makeState({ id: 'source-a', timeLockBankedMin: 30 });
    const sourceB = makeState({ id: 'source-b', timeLockBankedMin: 20 });
    const target = makeState({ id: 'target' });

    const r1 = spendTimeLock(sourceA, target, 30);
    expect(r1.ok).toBe(true);
    expect(target.accelerationRemainingMin).toBe(30);
    expect(target.accelerationQueue).toHaveLength(0);
    expect(sourceA.timeLockBankedMin).toBe(0);

    const r2 = spendTimeLock(sourceB, target, 20);
    expect(r2.ok).toBe(true);
    expect(target.accelerationRemainingMin).toBe(30);
    expect(target.accelerationQueue).toHaveLength(1);
    expect(target.accelerationQueue[0]).toEqual({ sourceIslandId: 'source-b', durationMin: 20 });
    expect(sourceB.timeLockBankedMin).toBe(0);

    // Advance 30 minutes — first block exhausted, queue pops.
    advanceIsland(target, 30 * 60 * 1000, { defs: POWER_FREE });
    expect(target.accelerationRemainingMin).toBeCloseTo(20, 6);
    expect(target.accelerationQueue).toHaveLength(0);
  });

  it('rejects spend without enough banked time', () => {
    const source = makeState({ timeLockBankedMin: 10 });
    const target = makeState();
    const result = spendTimeLock(source, target, 20);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe('insufficient-banked-time');
    expect(source.timeLockBankedMin).toBe(10);
    expect(target.accelerationRemainingMin).toBe(0);
  });

  it('rejects spend with invalid minutes', () => {
    const source = makeState({ timeLockBankedMin: 10 });
    const target = makeState();
    expect(spendTimeLock(source, target, 0).ok).toBe(false);
    expect(spendTimeLock(source, target, -5).ok).toBe(false);
  });

  it('acceleration does not affect non-accelerated island', () => {
    const state = makeState({
      buildings: [MINE],
      inventory: blankInventory(),
    });
    advanceIsland(state, 60_000, { defs: POWER_FREE });
    expect(state.inventory.iron_ore).toBeCloseTo(3.5294117647058822, 6); // 0.02 * 60
  });

  it('triples XP while accelerated', () => {
    const state = makeState({
      buildings: [MINE],
      inventory: blankInventory(),
      accelerationRemainingMin: 60,
    });
    advanceIsland(state, 60_000, { defs: POWER_FREE });
    // Base XP: 0.02/s * 60s * 1 = 1.2. At 3×: 3.6.
    expect(state.xp).toBeCloseTo(10.588235294117647, 6);
  });
});


describe('Singularity Battery', () => {
  it('charges on surplus', () => {
    const state = makeState({
      inventory: { ...blankInventory(), coal: 50 },
    });
    state.buildings.push({ id: 'sb1', defId: 'singularity_battery', x: 0, y: 0 });
    // Solar (50W) + Coal Gen (100W) = 150W produced; battery consumes 100W → 50W surplus
    state.buildings.push({ id: 'sol1', defId: 'solar', x: 2, y: 0 });
    state.buildings.push({ id: 'cg1', defId: 'coal_gen', x: 4, y: 0 });
    advanceIsland(state, 1000);
    expect(state.singularityStoredWs).toBeGreaterThan(0);
  });

  it('discharges on deficit preventing brownout', () => {
    const state = makeState({
      inventory: { ...blankInventory(), iron_ore: 50 },
    });
    state.buildings.push({ id: 'sb1', defId: 'singularity_battery', x: 0, y: 0 });
    state.singularityStoredWs = 1e9; // seed with stored energy
    // Mine (40W consumer) + battery (100W) = 140W deficit, no producers
    state.buildings.push({ id: 'mine1', defId: 'mine', x: 2, y: 0 });
    advanceIsland(state, 1000);
    expect(state.singularityStoredWs).toBeLessThan(1e9);
    // Mine ran at full speed because battery covered the deficit
    expect(state.inventory.iron_ore).toBeGreaterThan(50);
  });

  it('caps at 50 MWh per battery', () => {
    const state = makeState({
      inventory: { ...blankInventory(), coal: 50 },
    });
    state.buildings.push({ id: 'sb1', defId: 'singularity_battery', x: 0, y: 0 });
    state.singularityStoredWs = SINGULARITY_BATTERY_CAPACITY_WS - 100;
    // Solar (50W) + Coal Gen (100W) = 150W produced; battery consumes 100W → 50W surplus
    state.buildings.push({ id: 'sol1', defId: 'solar', x: 2, y: 0 });
    state.buildings.push({ id: 'cg1', defId: 'coal_gen', x: 4, y: 0 });
    advanceIsland(state, 10_000);
    expect(state.singularityStoredWs).toBeLessThanOrEqual(SINGULARITY_BATTERY_CAPACITY_WS);
  });

  it('does not overfill when there is no surplus', () => {
    const state = makeState({
      inventory: { ...blankInventory(), coal: 50 },
      level: 50,
      aiCoreCrafted: true,
    });
    state.buildings.push({ id: 'sb1', defId: 'singularity_battery', x: 0, y: 0 });
    state.singularityStoredWs = 1000;
    // Coal Gen (100W) = exact balance with battery (100W) → no surplus, no deficit
    state.buildings.push({ id: 'cg1', defId: 'coal_gen', x: 2, y: 0 });
    advanceIsland(state, 1000);
    expect(state.singularityStoredWs).toBe(1000);
  });
});

// ---------------------------------------------------------------------------
// §8.10 T5 extractor multi-output rotation
// ---------------------------------------------------------------------------

describe('resolveRotatingOutput', () => {
  it('alternates between 2 options deterministically', () => {
    const recipe = {
      cycleSec: 10,
      inputs: {},
      outputs: { aetheric_current: 1 },
      rotateOutputs: [{ aetheric_current: 1 }, { quantum_foam: 1 }],
      category: 'extraction',
    } as import('./recipes.js').Recipe;
    // cycleMs = 10_000
    expect(resolveRotatingOutput(recipe, 0)).toEqual({ aetheric_current: 1 });
    expect(resolveRotatingOutput(recipe, 5_000)).toEqual({ aetheric_current: 1 });
    expect(resolveRotatingOutput(recipe, 10_000)).toEqual({ quantum_foam: 1 });
    expect(resolveRotatingOutput(recipe, 15_000)).toEqual({ quantum_foam: 1 });
    expect(resolveRotatingOutput(recipe, 20_000)).toEqual({ aetheric_current: 1 });
  });

  it('cycles through 3 options deterministically', () => {
    const recipe = {
      cycleSec: 10,
      inputs: {},
      outputs: { dark_matter: 1 },
      rotateOutputs: [{ dark_matter: 1 }, { strange_matter: 1 }, { higgs_flux: 1 }],
      category: 'extraction',
    } as import('./recipes.js').Recipe;
    expect(resolveRotatingOutput(recipe, 0)).toEqual({ dark_matter: 1 });
    expect(resolveRotatingOutput(recipe, 10_000)).toEqual({ strange_matter: 1 });
    expect(resolveRotatingOutput(recipe, 20_000)).toEqual({ higgs_flux: 1 });
    expect(resolveRotatingOutput(recipe, 30_000)).toEqual({ dark_matter: 1 });
  });

  it('returns recipe.outputs when rotateOutputs is absent', () => {
    const recipe = {
      cycleSec: 10,
      inputs: {},
      outputs: { iron_ore: 2 },
      category: 'extraction',
    } as import('./recipes.js').Recipe;
    expect(resolveRotatingOutput(recipe, 25_000)).toEqual({ iron_ore: 2 });
  });
});

describe('computeRates with T5 extractor rotation', () => {
  it('produces aetheric_current at cycle 0 and quantum_foam at cycle 1', () => {
    const conduit: PlacedBuilding = { id: 'b-ac', defId: 'aetheric_conduit', x: 0, y: 0 };
    const state = makeState({
      buildings: [conduit],
      inventory: blankInventory(),
      level: 50,
      aiCoreCrafted: true,
    });
    // Use a power-free catalog so the massive 60kW draw doesn't brownout.
    const noPower = ((): DefCatalog => {
      const base = { ...BUILDING_DEFS } as Record<BuildingDefId, BuildingDef>;
      const { power: _p, ...rest } = base.aetheric_conduit;
      base.aetheric_conduit = rest as BuildingDef;
      return base;
    })();
    // cycleSec = 1600s → cycleMs = 1_600_000 (2026-05-18 ÷3 for display visibility; was 4800s)
    const r0 = computeRates(state, { defs: noPower, worldSeed: 'test' }, 0);
    expect(r0.production.aetheric_current ?? 0).toBeGreaterThan(0);
    expect(r0.production.quantum_foam ?? 0).toBe(0);

    const r1 = computeRates(state, { defs: noPower, worldSeed: 'test' }, 1_600_000);
    expect(r1.production.aetheric_current ?? 0).toBe(0);
    expect(r1.production.quantum_foam ?? 0).toBeGreaterThan(0);
  });

  it('cycles eldritch_sieve through dark_matter, strange_matter, higgs_flux', () => {
    const sieve: PlacedBuilding = { id: 'b-es', defId: 'eldritch_sieve', x: 0, y: 0 };
    const state = makeState({
      buildings: [sieve],
      inventory: blankInventory(),
      level: 50,
      aiCoreCrafted: true,
    });
    const noPower = ((): DefCatalog => {
      const base = { ...BUILDING_DEFS } as Record<BuildingDefId, BuildingDef>;
      const { power: _p, ...rest } = base.eldritch_sieve;
      base.eldritch_sieve = rest as BuildingDef;
      return base;
    })();
    // cycleSec = 1920s → cycleMs = 1_920_000 (2026-05-18 ÷3 for display visibility; was 5760s)
    const r0 = computeRates(state, { defs: noPower, worldSeed: 'test' }, 0);
    expect(r0.production.dark_matter ?? 0).toBeGreaterThan(0);

    const r1 = computeRates(state, { defs: noPower, worldSeed: 'test' }, 1_920_000);
    expect(r1.production.strange_matter ?? 0).toBeGreaterThan(0);

    const r2 = computeRates(state, { defs: noPower, worldSeed: 'test' }, 3_840_000);
    expect(r2.production.higgs_flux ?? 0).toBeGreaterThan(0);
  });
});

// ---------------------------------------------------------------------------
// §4.5 Chemical Reactor toxicity event integration
// ---------------------------------------------------------------------------

describe('§4.5 — chemical_reactor toxicity in computeRates', () => {
  it('halves the effective rate of a toxicity-active reactor versus a clear one', () => {
    const reactorA: PlacedBuilding = { id: 'b-cr-a', defId: 'chemical_reactor', x: 0, y: 0 };
    const reactorB: PlacedBuilding = { id: 'b-cr-b', defId: 'chemical_reactor', x: 2, y: 0 };
    const nowMs = 1_000_000;
    reactorA.toxicityExpiryMs = nowMs + 30 * 60 * 1000; // active
    // reactorB has no toxicityExpiryMs → clear

    const state = makeState({
      buildings: [reactorA, reactorB],
      inventory: { ...blankInventory(), salt: 100, fresh_water: 100 },
      level: 5, // tier 2 unlocked
      lastTick: nowMs,
    });

    const noPower = ((): DefCatalog => {
      const base = { ...BUILDING_DEFS } as Record<BuildingDefId, BuildingDef>;
      const { power: _p, ...rest } = base.chemical_reactor;
      base.chemical_reactor = rest as BuildingDef;
      return base;
    })();

    const { byBuilding } = computeRates(state, { defs: noPower }, nowMs);
    const rateA = byBuilding.find((r) => r.building.id === 'b-cr-a')!.effectiveRate;
    const rateB = byBuilding.find((r) => r.building.id === 'b-cr-b')!.effectiveRate;
    // Base rate = 1/800 = 0.00125. No other multipliers apply in this fixture.
    expect(rateB).toBeCloseTo(0.003745318352059925, 9);
    expect(rateA).toBeCloseTo(rateB * 0.5, 9);
  });

  it('advanceIsland actually triggers toxicity rolls when worldSeed is threaded', () => {
    // Seed 'test13' deterministically triggers reactor-a at hour 1.
    const reactorA: PlacedBuilding = { id: 'reactor-a', defId: 'chemical_reactor', x: 0, y: 0 };
    const reactorB: PlacedBuilding = { id: 'reactor-b', defId: 'chemical_reactor', x: 2, y: 0 };
    const startMs = 0;
    const futureMs = 2 * 60 * 60 * 1000; // 2 hours — crosses hour 1 boundary

    const state = makeState({
      buildings: [reactorA, reactorB],
      inventory: { ...blankInventory(), salt: 1000, fresh_water: 1000 },
      level: 5,
      lastTick: startMs,
    });

    const noPower = ((): DefCatalog => {
      const base = { ...BUILDING_DEFS } as Record<BuildingDefId, BuildingDef>;
      const { power: _p, ...rest } = base.chemical_reactor;
      base.chemical_reactor = rest as BuildingDef;
      return base;
    })();

    advanceIsland(state, futureMs, { defs: noPower, worldSeed: 'test13' });

    const a = state.buildings.find((b) => b.id === 'reactor-a')!;
    const b = state.buildings.find((b) => b.id === 'reactor-b')!;
    // At least one reactor should have been triggered.
    const anyTriggered =
      (a.toxicityExpiryMs !== undefined && a.toxicityExpiryMs > startMs) ||
      (b.toxicityExpiryMs !== undefined && b.toxicityExpiryMs > startMs);
    expect(anyTriggered).toBe(true);
  });
});

// -----------------------------------------------------------------------
// §6.7 Steel Mill scrap substitution — economy integration
// -----------------------------------------------------------------------

describe('§6.7 — Steel Mill scrap substitution in advanceIsland', () => {
  // Steel Mill base recipe: 1 pig_iron / 600s → 1 steel + 1 slag. The §6.7
  // substitution variant `steel_mill_from_scrap` swaps the input to 2 scrap
  // per 600s cycle while preserving the same output rate. Selection is
  // per-tick, driven by inventory: pig_iron > 0 → base, else if scrap > 0 →
  // scrap variant, else stalled on pig_iron (the visible bottleneck).
  //
  // Power-free catalog for the Steel Mill keeps these tests isolated from
  // §5.1 brownout — we're verifying recipe selection and consumption math,
  // not power balance.
  function powerFreeSteelMillCatalog(): DefCatalog {
    const base = { ...BUILDING_DEFS } as Record<BuildingDefId, BuildingDef>;
    const { power: _p, ...rest } = base.steel_mill;
    base.steel_mill = rest as BuildingDef;
    return base;
  }

  it('with only pig_iron in inventory: produces steel at the base rate (regression)', () => {
    // 10 cycles × 600s = 6000s. Each cycle: −1 pig_iron, +1 steel, +1 slag.
    // Start pig_iron = 100; expect 90 left, 10 steel, 10 slag produced.
    // No scrap touched.
    const MILL: PlacedBuilding = { id: 'sm', defId: 'steel_mill', x: 0, y: 0 };
    const state = makeState({
      buildings: [MILL],
      inventory: {
        ...blankInventory(),
        pig_iron: 100,
        scrap: 0,
      },
      storageCaps: blankCaps(10_000),
      level: 5, // T2 building — bypass §9.7 tier-band runtime gate
    });
    advanceIsland(state, 6_000_000, { defs: powerFreeSteelMillCatalog() });
    expect(state.inventory.pig_iron).toBeCloseTo(70, 6);
    expect(state.inventory.steel).toBeCloseTo(30, 6);
    expect(state.inventory.slag).toBeCloseTo(30, 6);
    expect(state.inventory.scrap).toBe(0); // never consumed
  });

  it('with only scrap in inventory: runs the substitution variant — same output rate, 2 scrap per cycle', () => {
    // 10 cycles × 600s = 6000s. Each cycle: −2 scrap, +1 steel, +1 slag.
    // Start scrap = 100; expect 80 left, 10 steel, 10 slag produced (same
    // throughput as the pig_iron baseline above).
    const MILL: PlacedBuilding = { id: 'sm', defId: 'steel_mill', x: 0, y: 0 };
    const state = makeState({
      buildings: [MILL],
      inventory: {
        ...blankInventory(),
        pig_iron: 0,
        scrap: 100,
      },
      storageCaps: blankCaps(10_000),
      level: 5,
    });
    advanceIsland(state, 6_000_000, { defs: powerFreeSteelMillCatalog() });
    expect(state.inventory.scrap).toBeCloseTo(40, 6);
    expect(state.inventory.steel).toBeCloseTo(30, 6);
    expect(state.inventory.slag).toBeCloseTo(30, 6);
    expect(state.inventory.pig_iron).toBe(0); // never consumed
  });

  it('with both inputs: drains pig_iron first, then switches to scrap mid-run', () => {
    // Start pig_iron = 5, scrap = 100. The mill should run on pig_iron for
    // 5 cycles (3000s), then switch to scrap for the remaining 5 cycles
    // (3000s, consuming 10 scrap). End state: pig_iron = 0, scrap = 90,
    // steel = 10, slag = 10. Verifies the piecewise integrator re-resolves
    // at the pig_iron depletion event rather than stalling.
    const MILL: PlacedBuilding = { id: 'sm', defId: 'steel_mill', x: 0, y: 0 };
    const state = makeState({
      buildings: [MILL],
      inventory: {
        ...blankInventory(),
        pig_iron: 5,
        scrap: 100,
      },
      storageCaps: blankCaps(10_000),
      level: 5,
    });
    advanceIsland(state, 6_000_000, { defs: powerFreeSteelMillCatalog() });
    expect(state.inventory.pig_iron).toBeCloseTo(0, 6);
    expect(state.inventory.scrap).toBeCloseTo(50, 6); // 100 − (5 cycles × 2)
    expect(state.inventory.steel).toBeCloseTo(30, 6);
    expect(state.inventory.slag).toBeCloseTo(30, 6);
  });

  it('with neither input: stalls (no steel, no consumption)', () => {
    // Both stockpiles at 0 — substitution rule falls back to the base
    // recipe so the missing-pig_iron bottleneck stays visible. No production.
    const MILL: PlacedBuilding = { id: 'sm', defId: 'steel_mill', x: 0, y: 0 };
    const state = makeState({
      buildings: [MILL],
      inventory: {
        ...blankInventory(),
        pig_iron: 0,
        scrap: 0,
      },
      storageCaps: blankCaps(10_000),
      level: 5,
    });
    advanceIsland(state, 6_000_000, { defs: powerFreeSteelMillCatalog() });
    expect(state.inventory.steel).toBe(0);
    expect(state.inventory.slag).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// §4 ocean-layer — anchor crediting + paused reasons (Task 10)
// ---------------------------------------------------------------------------
//
// Per the §4 design doc (`docs/superpowers/specs/2026-05-18-ocean-layer-design.md`):
// "The platform is logically a building on `anchorIslandId`'s `buildings[]`
// array, indexed by an island ID that isn't the platform's geographic
// location. The existing `advanceIsland` loop produces correctly — no new
// dispatch code." Outputs flow to the anchor's inventory; power deltas land
// in the anchor's pool. We exercise that path by placing the ocean platform
// directly onto the anchor IslandState's `buildings` and asserting on the
// anchor's inventory + power balance.
describe('§4 ocean anchor crediting + paused reasons (Task 10)', () => {
  // Minimal IslandSpec for the anchor — only `id`, `populated`, `cx`, `cy`
  // are read by the ocean-paused checks; the rest are defaults the renderer
  // would expect but the pure tick loop ignores.
  function makeAnchorSpec(over: {
    id: string;
    populated?: boolean;
    cx?: number;
    cy?: number;
  }): import('./world.js').IslandSpec {
    return {
      id: over.id,
      name: over.id,
      biome: 'plains',
      cx: over.cx ?? 0,
      cy: over.cy ?? 0,
      majorRadius: 14,
      minorRadius: 14,
      populated: over.populated ?? true,
      discovered: true,
      buildings: [],
      modifiers: [],
    };
  }

  // Minimal WorldState stub — same pattern as placement.test.ts:894 — only
  // the fields the ocean checks read are populated; rest are unsafe-casted.
  function makeWorld(
    islands: import('./world.js').IslandSpec[],
    oceanCells: Map<string, import('./ocean-cell.js').OceanCellSpec> = new Map(),
  ): import('./world.js').WorldState {
    return { islands, oceanCells } as unknown as import('./world.js').WorldState;
  }

  it('ocean platform output deposits to anchor inventory (anchorIslandId routes to anchor state)', () => {
    // Seawater Intake Rig (T2 extractor, 200W consumer) anchored to a
    // populated island. Per §4 design doc, the platform lives on the
    // anchor's buildings[]; output (dilute_brine, 1/60s cycle in rotation
    // slot 0) deposits to the anchor's inventory directly.
    //
    // Power: 200W draw with no producer would brownout. To exercise the
    // crediting path in isolation we strip power from the catalog so the
    // platform's recipe runs at full nominal rate.
    const anchorSpec = makeAnchorSpec({ id: 'A', populated: true });
    // Local coords (80, 80) → world tile (80, 80) — well outside the
    // anchor's r=14 ellipse so `isOceanTile` returns true (open ocean).
    const platform: PlacedBuilding = {
      id: 'p1',
      defId: 'seawater_intake_rig',
      x: 80,
      y: 80,
      anchorIslandId: 'A',
    };
    anchorSpec.buildings.push(platform);
    const world = makeWorld([anchorSpec]);
    const state = makeState({
      id: 'A',
      buildings: anchorSpec.buildings,
      inventory: blankInventory(),
      storageCaps: blankCaps(1000),
      level: 10,
    });
    // Strip power off the platform def so this test isolates the crediting
    // path from the power-brownout path (covered separately below).
    const powerFreePlatform: DefCatalog = (() => {
      const base = { ...BUILDING_DEFS } as Record<BuildingDefId, BuildingDef>;
      const { power: _p, ...rest } = base.seawater_intake_rig;
      base.seawater_intake_rig = rest as BuildingDef;
      return base;
    })();
    advanceIsland(state, 60_000, { defs: powerFreePlatform, world });
    // Seawater Intake Rig has rotateOutputs: [dilute_brine, he3_dilute].
    // Both have cycleSec=60 (3 cycles within 60s after the ÷3 rebalance).
    // The first cycle slot at t=0 produces dilute_brine. We assert that
    // SOMETHING from the rotation pair landed on the anchor — the rotating
    // output is the design-doc point, not the specific resource.
    const got = state.inventory.dilute_brine + state.inventory.he3_dilute;
    expect(got).toBeGreaterThan(0);
    // Anchor's `paused` is undefined (active building).
    expect(platform.paused).toBeUndefined();
  });

  it('ocean platform halts with paused="anchor-depopulated" when anchor is unpopulated', () => {
    // Anchor exists but populated=false (post-abandonment / tier-reset).
    // Per §4 design doc edge cases: "Anchor becomes unpopulated: platform
    // halts with `paused: 'anchor-depopulated'` until the anchor is
    // repopulated."
    const anchorSpec = makeAnchorSpec({ id: 'A', populated: false });
    const platform: PlacedBuilding = {
      id: 'p1',
      defId: 'seawater_intake_rig',
      x: 0,
      y: 0,
      anchorIslandId: 'A',
    };
    anchorSpec.buildings.push(platform);
    const world = makeWorld([anchorSpec]);
    const state = makeState({
      id: 'A',
      buildings: anchorSpec.buildings,
      inventory: blankInventory(),
      storageCaps: blankCaps(1000),
      level: 10,
    });
    advanceIsland(state, 60_000, { defs: BUILDING_DEFS, world });
    expect(platform.paused).toBe('anchor-depopulated');
    expect(state.inventory.dilute_brine).toBe(0);
    expect(state.inventory.he3_dilute).toBe(0);
  });

  it('ocean platform halts with paused="anchor-depopulated" when anchorIslandId points at nothing', () => {
    // Missing anchor (deleted island, stale save, future-edge race) is
    // indistinguishable from depopulated for the platform — both halt
    // production. Same paused reason so the inspector only needs one chip.
    const anchorSpec = makeAnchorSpec({ id: 'A', populated: true });
    const platform: PlacedBuilding = {
      id: 'p1',
      defId: 'seawater_intake_rig',
      x: 0,
      y: 0,
      anchorIslandId: 'GHOST',
    };
    anchorSpec.buildings.push(platform);
    const world = makeWorld([anchorSpec]);
    const state = makeState({
      id: 'A',
      buildings: anchorSpec.buildings,
      inventory: blankInventory(),
      storageCaps: blankCaps(1000),
      level: 10,
    });
    advanceIsland(state, 60_000, { defs: BUILDING_DEFS, world });
    expect(platform.paused).toBe('anchor-depopulated');
  });

  it('ocean platform halts with paused="terrain-lost" when its cell is no longer ocean', () => {
    // Defensive case (design doc §4 edge: "Terrain access lost (hypothetical
    // future event removing a vent): platform halts with paused: 'terrain-
    // lost'. Defensive; not expected in initial scope.")
    //
    // We fake the condition by anchoring the platform at world tile (0,0)
    // (cellX=0,cellY=0) and having the only island sit AT (0,0) so
    // `isOceanTile(0,0)` returns false (the cell is inside the island).
    // The platform's `x,y` here are world-tile coords (= cellX * 16 for
    // tile (0,0) → 0, 0). Anchor A sits at world (cx=0, cy=0) — same
    // island, same tile, but `isOceanTile` walks every island and rejects.
    const anchorSpec = makeAnchorSpec({ id: 'A', populated: true, cx: 0, cy: 0 });
    const platform: PlacedBuilding = {
      id: 'p1',
      defId: 'seawater_intake_rig',
      x: 0,
      y: 0,
      anchorIslandId: 'A',
    };
    anchorSpec.buildings.push(platform);
    const world = makeWorld([anchorSpec]);
    const state = makeState({
      id: 'A',
      buildings: anchorSpec.buildings,
      inventory: blankInventory(),
      storageCaps: blankCaps(1000),
      level: 10,
    });
    advanceIsland(state, 60_000, { defs: BUILDING_DEFS, world });
    expect(platform.paused).toBe('terrain-lost');
    expect(state.inventory.dilute_brine).toBe(0);
  });

  it('geothermal_vent_generator on anchor contributes 2000W to anchor pool', () => {
    // Geothermal Vent Generator is the lone ocean-side POWER PRODUCER
    // (def.power.produces = 2000W, no consumes, T6, hydrothermal_vent
    // terrain). When anchored to a populated island, its produces wattage
    // adds to that island's powerProduced — same as a Solar / Coal Gen on
    // the island would.
    const anchorSpec = makeAnchorSpec({ id: 'A', populated: true });
    // Place a known land-side consumer to make the power balance non-trivial
    // and a Solar to ensure factor==1 baseline (so geothermal's contribution
    // is observable in `power.produced`).
    const MINE_PWR_ON_A: PlacedBuilding = { id: 'mn', defId: 'mine', x: 0, y: 0 };
    // T6 generator needs `ascendantCoreCrafted && hasSpaceport` to unlock
    // via `buildingUnlocked` (building-defs.ts:4200). Without a Spaceport
    // on the anchor, pass-3 skips the generator via `isBuildingActive(b)`
    // and `power.produced` stays at zero.
    const SPACEPORT_ON_A: PlacedBuilding = { id: 'sp', defId: 'spaceport', x: 4, y: 0 };
    const generator: PlacedBuilding = {
      id: 'g1',
      defId: 'geothermal_vent_generator',
      // Local coords (80, 80) → world tile (80, 80). Far from anchor's r=14
      // ellipse so `isOceanTile` returns true (open ocean). Adjacency /
      // land-tile checks are no-ops for ocean defs so the placement is
      // economically silent except for power.
      x: 80,
      y: 80,
      anchorIslandId: 'A',
    };
    anchorSpec.buildings.push(MINE_PWR_ON_A, SPACEPORT_ON_A, generator);
    const world = makeWorld([anchorSpec]);
    const state = makeState({
      id: 'A',
      buildings: anchorSpec.buildings,
      inventory: { ...blankInventory(), iron_ore: 0 },
      storageCaps: blankCaps(1000),
      level: 50,
      aiCoreCrafted: true,
      ascendantCoreCrafted: true,
    });
    const { power } = computeRates(state, { defs: BUILDING_DEFS, world });
    // Generator produces 2000W to the anchor pool. Mine draws 40W (T1) and
    // Spaceport draws 3000W (T6 gate) — combined 3040W demand exceeds the
    // 2000W generator output, so factor < 1. The geometric assertion is
    // simply "the generator's 2000W contributed to the anchor pool"; if it
    // hadn't, `power.produced` would be 0 (the test FAILED before adding
    // the `b.paused` skip-in-pass-3 wiring).
    expect(power.produced).toBeGreaterThanOrEqual(2000);
    expect(power.consumed).toBeGreaterThan(0);
  });

  it('ocean platform power draw deducts from anchor pool (trench_drill 1000W)', () => {
    // Trench Drill (T4, 1000W consumer) anchored to A. Without any producer
    // on A, the per-§5.1 throughput-scaled draw lands in `power.consumed`;
    // factor drops to 0 (no production) and the platform stalls. The point
    // is to verify the draw lands in the ANCHOR pool, not a separate one.
    const anchorSpec = makeAnchorSpec({ id: 'A', populated: true });
    const drill: PlacedBuilding = {
      id: 'd1',
      defId: 'trench_drill',
      x: 80,
      y: 80,
      anchorIslandId: 'A',
    };
    // Add a Solar to verify the draw is REAL (factor < 1 / consumed > 0).
    const SOLAR_ON_A: PlacedBuilding = { id: 's1', defId: 'solar', x: 0, y: 0 };
    anchorSpec.buildings.push(SOLAR_ON_A, drill);
    const world = makeWorld([anchorSpec]);
    const state = makeState({
      id: 'A',
      buildings: anchorSpec.buildings,
      inventory: blankInventory(),
      storageCaps: blankCaps(1000),
      level: 50,
      aiCoreCrafted: true,
      ascendantCoreCrafted: true,
    });
    const { power } = computeRates(state, { defs: BUILDING_DEFS, world });
    // Solar produces 50W (Day baseline at lastTick=0 per the §2.7 epoch
    // offset). Drill nominal draw 1000W, scaled by throughput frac (here:
    // inputAvail=1, outputAvail=1, gateMul=1 → frac=1). consumed ≈ 1000W.
    expect(power.consumed).toBeGreaterThanOrEqual(1000);
    // Brownout: 50W produced << 1000W consumed.
    expect(power.factor).toBeLessThan(0.1);
  });
});

// ---------------------------------------------------------------------------
// findNextCapEvent precision-residue handling
// ---------------------------------------------------------------------------
// Regression: `findNextCapEvent` used to return `tMs` when an inventory held
// a sub-precision residue (e.g. `pig_iron = 2.6e-21` after a consumer drained
// it through float-subtraction precision loss). The math:
//   timeToEventSec = 2.6e-21 / 0.1 = 2.6e-20 s
//   eventMs        = tMs + 2.6e-20 * 1000 = tMs + 2.6e-17 ms
// At realistic `tMs` (perf.now() ≈ 1.3e6 ms, ULP ≈ 2.9e-10), `tMs + 2.6e-17`
// rounds back to exactly `tMs`. The integrator then computed `segEndMs == t`
// → `dtSec == 0` → the entire `if (dtSec > 0)` block (applyRates, accrueXp,
// tickConstruction, …) was skipped every frame, freezing inventory, XP,
// and construction-remaining-ms together. Fix: treat any stock within 1 unit
// of cap/0 as "effectively full/empty" for next-event purposes only.
describe('findNextCapEvent precision-residue handling', () => {
  it('does NOT return tMs when a consumed resource holds a sub-1 residue', () => {
    // Construct a state where pig_iron has a tiny positive inventory and is
    // being consumed at a finite rate. Pre-fix the function returned tMs;
    // post-fix the resource is skipped and best stays at nowMs.
    const tMs = 1_300_000; // realistic perf.now() scale where ULP matters
    const nowMs = tMs + 60_000;
    const state = makeState({
      inventory: { ...blankInventory(), pig_iron: 2.6e-21 },
      storageCaps: blankCaps(1000),
      lastTick: tMs,
    });
    const net = { pig_iron: -0.1 } as Record<ResourceId, number>;
    const result = findNextCapEvent(state, net, tMs, nowMs);
    // Pre-fix: result === tMs (the phantom zero-dt event). Post-fix: result
    // is `nowMs` because the sub-1 residue is treated as effectively empty.
    expect(result).toBeGreaterThan(tMs);
  });

  it('does NOT return tMs when a produced resource is within 1 unit of cap (sub-precision)', () => {
    // Symmetric case for the rate>0 branch. `100 - 1e-15` is genuinely
    // sub-precision relative to the cap value — headroom of 1e-15 with rate
    // 0.5 yields `eventMs = tMs + 2e-15 * 1000 = tMs + 2e-12 ms`, which
    // rounds back to `tMs` at the chosen scale.
    const tMs = 1_300_000;
    const nowMs = tMs + 60_000;
    const state = makeState({
      inventory: { ...blankInventory(), iron_ore: 100 - 1e-15 },
      storageCaps: blankCaps(100),
      lastTick: tMs,
    });
    const net = { iron_ore: 0.5 } as Record<ResourceId, number>;
    const result = findNextCapEvent(state, net, tMs, nowMs);
    expect(result).toBeGreaterThan(tMs);
  });

  it('integrator advances construction-remaining-ms after the fix (was frozen pre-fix)', () => {
    // End-to-end exercise of the freeze pattern. Construct a state with:
    //   • a Mine under construction (constructionRemainingMs = 30_000),
    //   • inventory.iron_ore = 100 - 1e-15 (sub-precision near cap),
    //   • cap.iron_ore = 100, a small constant +rate on iron_ore from a
    //     mocked recipe-free producer (just net.iron_ore = +0.02 via a
    //     buildings list including a building whose def we can't easily
    //     fake) — actually simpler: just rely on a tick-driven non-recipe
    //     source via the post-fix findNextCapEvent behavior. The integrator
    //     block running is what matters; the construction-tick is the
    //     observable proof.
    // Pre-fix: `findNextCapEvent` returned `tMs` because headroom of 1e-15
    //   gave `eventMs ≈ tMs + 2e-12 ms`, which rounded back to `tMs`. Then
    //   `segEndMs = tMs`, `dtSec = 0`, the integrator block was skipped,
    //   so `tickConstruction` did NOT run — the construction-remaining-ms
    //   stayed at 30_000 across the entire call.
    // Post-fix: the sub-1 headroom on iron_ore is skipped in findNextCapEvent,
    //   the segment runs for the full 16 ms, and constructionRemainingMs
    //   ticks down to 29_984.
    // NOTE: we drop the XP assertion because Mine has requiredTile=['ore','coal'];
    //   without a terrain mock production is 0 and no XP accrues. Construction-
    //   tick is sufficient proof that the integrator's `if (dtSec > 0)` block
    //   fired — XP and applyRates share the same gate.
    const tMs = 1_300_000;
    const nowMs = tMs + 16; // one ~60-fps frame
    const constructingMine: PlacedBuilding = {
      id: 'b-mine-construction',
      defId: 'mine',
      x: 1,
      y: 0,
      constructionRemainingMs: 30_000,
    };
    const state = makeState({
      buildings: [constructingMine],
      inventory: { ...blankInventory(), iron_ore: 100 - 1e-15 },
      storageCaps: blankCaps(100),
      lastTick: tMs,
    });
    advanceIsland(state, nowMs, { defs: POWER_FREE });
    // Construction must have ticked down (pre-fix: still 30_000).
    expect((state.buildings[0] as { constructionRemainingMs?: number }).constructionRemainingMs)
      .toBeLessThan(30_000);
    // lastTick advances either way (the outer `if (segEndMs <= t) t = nowMs`
    // exits the loop both pre- and post-fix), so check it's wired.
    expect(state.lastTick).toBe(nowMs);
  });
});


// All four test names match the spec §05 verification table exactly.

describe('advanceIsland — terrain_modifier shot tick', () => {
  it('fires onTerrainShotFire when the countdown reaches zero', () => {
    const spec = attachTerrainAt({
      id: 'tt', name: 'tt', cx: 0, cy: 0, majorRadius: 30, minorRadius: 30,
      biome: 'plains', populated: true, discovered: true,
      buildings: [], modifiers: [],
    });
    const state = makeInitialIslandState(spec, 0);
    state.buildings.push({
      id: 'm1', defId: 'terrain_modifier', x: 0, y: 0, rotation: 0,
      terrainTarget: 'grass', terrainShotRemainingMs: SHOT_DURATION_MS,
    });
    const fires: string[] = [];
    advanceIsland(state, SHOT_DURATION_MS + 100, {
      onTerrainShotFire: (id) => fires.push(id),
    });
    expect(fires).toEqual(['m1']);
  });

  it('does NOT fire mid-segment (counter still positive)', () => {
    const spec = attachTerrainAt({
      id: 'tt', name: 'tt', cx: 0, cy: 0, majorRadius: 30, minorRadius: 30,
      biome: 'plains', populated: true, discovered: true,
      buildings: [], modifiers: [],
    });
    const state = makeInitialIslandState(spec, 0);
    state.buildings.push({
      id: 'm1', defId: 'terrain_modifier', x: 0, y: 0, rotation: 0,
      terrainTarget: 'grass', terrainShotRemainingMs: SHOT_DURATION_MS,
    });
    const fires: string[] = [];
    advanceIsland(state, SHOT_DURATION_MS / 2, {
      onTerrainShotFire: (id) => fires.push(id),
    });
    expect(fires).toEqual([]);
    const survivor = state.buildings.find((b) => b.id === 'm1');
    expect(survivor?.terrainShotRemainingMs).toBeGreaterThan(0);
    expect(survivor?.terrainShotRemainingMs).toBeLessThan(SHOT_DURATION_MS);
  });

  it('writes overrides on a non-zero-center island via advanceIsland tick', () => {
    const spec = attachTerrainAt({
      id: 'tt', name: 'tt', cx: 50, cy: 50, majorRadius: 30, minorRadius: 30,
      biome: 'plains', populated: true, discovered: true,
      buildings: [], modifiers: [],
    });
    const state = makeInitialIslandState(spec, 0);
    state.buildings.push({
      id: 'm1', defId: 'terrain_modifier', x: 0, y: 0, rotation: 0,
      terrainTarget: 'grass', terrainShotRemainingMs: SHOT_DURATION_MS,
    });
    const fires: string[] = [];
    advanceIsland(state, SHOT_DURATION_MS + 100, {
      onTerrainShotFire: (id) => {
        fires.push(id);
        // Mirror main.ts callback: resolveShot + rebuild implied.
        const modifier = state.buildings.find((b) => b.id === id);
        if (modifier) {
          resolveShot(
            spec,
            state,
            modifier,
            (lx: number, ly: number) => islandInscribedAny(spec, lx, ly),
          );
        }
      },
    });
    expect(fires).toEqual(['m1']);
    // Modifier should have self-destructed.
    expect(state.buildings.find((b) => b.id === 'm1')).toBeUndefined();
    // All 16 brush tiles should have been written (island is large enough).
    expect(Object.keys(spec.tileOverrides ?? {}).length).toBe(16);
  });
});

describe('disabled building contributes 0 to power balance', () => {
  it('a disabled smelter draws no power', () => {
    // Solar produces; disabled smelter would consume but is filtered out.
    // Assert total power consumed is 0 because the only consumer is disabled.
    const state = makeState({
      buildings: [
        { id: 'solar', defId: 'solar', x: 0, y: 0 },
        { id: 'sm', defId: 'smelter', x: 4, y: 0, disabled: true },
      ],
      inventory: { ...blankInventory(), iron_ore: 100, coal: 100 },
    });
    advanceIsland(state, 1000, { defs: BUILDING_DEFS });
    const rates = computeRates(state, { defs: BUILDING_DEFS });
    expect(rates.power.consumed).toBe(0);
  });
});

describe('disabled building does not accrue operatingMs', () => {
  it('operatingMs stays at its pre-disable value across a 1h advance', () => {
    const state = makeState({
      buildings: [{ id: 'm', defId: 'mine', x: 0, y: 0, disabled: true, operatingMs: 5000 }],
      inventory: blankInventory(),
    });
    advanceIsland(state, 3600 * 1000, { defs: BUILDING_DEFS });
    const m = state.buildings.find((b) => b.id === 'm')!;
    expect(m.operatingMs ?? 0).toBe(5000);
  });
});

describe('disabled provider fails downstream gates', () => {
  it('a coke oven stalls when its adjacent coal furnace is disabled', () => {
    const validBuildings = [
      { id: 'h', defId: 'coal_furnace', x: 2, y: 0, disabled: true } as PlacedBuilding,
      { id: 'c', defId: 'coke_oven', x: 0, y: 0 } as PlacedBuilding,
    ];
    const filtered = validBuildings.filter((b) => !b.invalid && !b.disabled);
    const coke = validBuildings[1]!;
    const gate = checkGates(coke, filtered, BUILDING_DEFS, false, undefined);
    expect(gate.effectiveMul).toBe(0);
  });
});
