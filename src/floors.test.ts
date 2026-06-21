// Tests for § floor-upgrade economy scaling (Task 3.2).
//
// Floor level L scales:
//   - production rate        ×(1+L)
//   - power output           ×(1+L)
//   - power draw (consumer)  ×(1+0.5L)

import { describe, expect, it } from 'vitest';

import { floorScaledCapacity, type PlacedBuilding } from './buildings.js';
import { computeRates, type IslandState } from './economy.js';
import { ALL_RESOURCES, type ResourceId } from './recipes.js';
import { RESOURCE_BASE_CAP, RESOURCE_STORAGE_CATEGORY, defaultCapForCategory } from './storage-categories.js';
import { aggregateStorageCaps } from './world.js';

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
    unlockedNodes: new Set(),
    unlockedEdges: new Set(),
    auraAmpVersion: 0,
    auraAmpCache: null,
    auraAmpCacheVersion: -1,
    co2Kg: 0,
    funnelPending: blankInventory(),
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

const EQUINOX_NOON = new Date('2026-03-20T12:00:00Z').getTime();

describe('floor level scales economy', () => {
  it('producer effectiveRate is 4× at floorLevel 3 vs L0', () => {
    const mineL0: PlacedBuilding = { id: 'b-mine-l0', defId: 'iron_mine', x: 0, y: 0 };
    const mineL3: PlacedBuilding = { id: 'b-mine-l3', defId: 'iron_mine', x: 0, y: 0, floorLevel: 3 };
    const genL0: PlacedBuilding = { id: 'b-gen-l0', defId: 'coal_gen', x: 0, y: 0 };
    const genL3: PlacedBuilding = { id: 'b-gen-l3', defId: 'coal_gen', x: 0, y: 0 };

    const invL0 = blankInventory();
    invL0.coal = 100;
    const invL3 = blankInventory();
    invL3.coal = 100;

    const stateL0 = makeState({ buildings: [mineL0, genL0], inventory: invL0 });
    const stateL3 = makeState({ buildings: [mineL3, genL3], inventory: invL3 });

    const ratesL0 = computeRates(stateL0);
    const ratesL3 = computeRates(stateL3);

    const rateL0 = ratesL0.byBuilding[0]!.effectiveRate;
    const rateL3 = ratesL3.byBuilding[0]!.effectiveRate;

    expect(rateL0).toBeGreaterThan(0);
    expect(rateL3).toBeCloseTo(rateL0 * 4, 9);
  });

  it('consumer power.consumed is 2.5× at floorLevel 3 vs L0', () => {
    // Mine consumes power but has no inputs, so nominalThroughputFrac is always 1.
    // The only scaling factor is floorPowerDrawMul.
    const mineL0: PlacedBuilding = { id: 'b-mine-l0', defId: 'iron_mine', x: 0, y: 0 };
    const mineL3: PlacedBuilding = { id: 'b-mine-l3', defId: 'iron_mine', x: 0, y: 0, floorLevel: 3 };

    const stateL0 = makeState({ buildings: [mineL0] });
    const stateL3 = makeState({ buildings: [mineL3] });

    const ratesL0 = computeRates(stateL0);
    const ratesL3 = computeRates(stateL3);

    expect(ratesL3.power.consumed).toBeCloseTo(ratesL0.power.consumed * 2.5, 9);
  });

  it('generator power.produced is 4× at floorLevel 3 vs L0', () => {
    const solarL0: PlacedBuilding = { id: 'b-solar-l0', defId: 'solar', x: 0, y: 0 };
    const solarL3: PlacedBuilding = { id: 'b-solar-l3', defId: 'solar', x: 0, y: 0, floorLevel: 3 };

    // Noon so solarFactor = 1.
    const stateL0 = makeState({ buildings: [solarL0], lastTick: EQUINOX_NOON });
    const stateL3 = makeState({ buildings: [solarL3], lastTick: EQUINOX_NOON });

    const ratesL0 = computeRates(stateL0);
    const ratesL3 = computeRates(stateL3);

    expect(ratesL3.power.produced).toBeCloseTo(ratesL0.power.produced * 4, 9);
  });

  it('genesis_chamber power.consumed is 2.5× at floorLevel 3 vs L0', () => {
    const gcL0: PlacedBuilding = { id: 'b-gc-l0', defId: 'genesis_chamber', x: 0, y: 0 };
    const gcL3: PlacedBuilding = { id: 'b-gc-l3', defId: 'genesis_chamber', x: 0, y: 0, floorLevel: 3 };

    const stateL0 = makeState({
      buildings: [gcL0],
      genesisTarget: 'iron_ingot',
      level: 50,
      aiCoreCrafted: true,
    });
    const stateL3 = makeState({
      buildings: [gcL3],
      genesisTarget: 'iron_ingot',
      level: 50,
      aiCoreCrafted: true,
    });

    const ratesL0 = computeRates(stateL0);
    const ratesL3 = computeRates(stateL3);

    expect(ratesL0.power.consumed).toBeGreaterThan(0);
    expect(ratesL3.power.consumed).toBeCloseTo(ratesL0.power.consumed * 2.5, 9);
  });
});

describe('floorScaledCapacity helper', () => {
  it('scales capacity ×(1+L)', () => {
    expect(floorScaledCapacity({ floorLevel: 2 }, 100)).toBe(300);
    expect(floorScaledCapacity({ floorLevel: 9 }, 100)).toBe(1000);
  });

  it('treats absent floorLevel as L0 → ×1', () => {
    expect(floorScaledCapacity({}, 100)).toBe(100);
  });

  it('scales floorLevel beyond 9 without clamping', () => {
    // Effects are now unbounded: floorLevel 10 → ×11, floorLevel 11 → ×12.
    expect(floorScaledCapacity({ floorLevel: 10 }, 100)).toBe(1100);
    expect(floorScaledCapacity({ floorLevel: 11 }, 100)).toBe(1200);
  });

  it('floors negative floorLevel to 0', () => {
    expect(floorScaledCapacity({ floorLevel: -1 }, 100)).toBe(100);
  });
});

describe('aggregateStorageCaps scales by floorLevel', () => {
  it('generic crate with floorLevel 2 contributes ×3', () => {
    const crate: PlacedBuilding = {
      id: 't-crate', defId: 'crate', x: 0, y: 0, cargoLabel: 'iron_ore', floorLevel: 2,
    };
    const caps = aggregateStorageCaps([crate]);
    const base = RESOURCE_BASE_CAP.iron_ore ?? defaultCapForCategory(RESOURCE_STORAGE_CATEGORY.iron_ore);
    expect(caps.iron_ore).toBe(base + 500 * 3);
  });

  it('specialized silo with floorLevel 1 contributes ×2 to dry_goods', () => {
    const silo: PlacedBuilding = {
      id: 't-silo', defId: 'silo', x: 0, y: 0, floorLevel: 1,
    };
    const caps = aggregateStorageCaps([silo]);
    const baseStone = RESOURCE_BASE_CAP.stone ?? defaultCapForCategory(RESOURCE_STORAGE_CATEGORY.stone);
    expect(caps.stone).toBe(baseStone + 200_000 * 2);
    const baseHydrogen = RESOURCE_BASE_CAP.hydrogen ?? defaultCapForCategory(RESOURCE_STORAGE_CATEGORY.hydrogen);
    expect(caps.hydrogen).toBe(baseHydrogen); // not dry_goods
  });

  it('absent floorLevel behaves as L0 → ×1 (unchanged)', () => {
    const crate: PlacedBuilding = {
      id: 't-crate', defId: 'crate', x: 0, y: 0, cargoLabel: 'iron_ore',
    };
    const caps = aggregateStorageCaps([crate]);
    const base = RESOURCE_BASE_CAP.iron_ore ?? defaultCapForCategory(RESOURCE_STORAGE_CATEGORY.iron_ore);
    expect(caps.iron_ore).toBe(base + 500);
  });
});
