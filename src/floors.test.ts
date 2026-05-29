// Tests for § floor-upgrade economy scaling (Task 3.2).
//
// Floor level L scales:
//   - production rate        ×(1+L)
//   - power output           ×(1+L)
//   - power draw (consumer)  ×(1+0.5L)

import { describe, expect, it } from 'vitest';

import type { PlacedBuilding } from './buildings.js';
import { computeRates, type IslandState } from './economy.js';
import { ALL_RESOURCES, type ResourceId } from './recipes.js';

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
    declaredAt: null,
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
    lastTick: 0,
    ...over,
  };
}

const EQUINOX_NOON = new Date('2026-03-20T12:00:00Z').getTime();

describe('floor level scales economy', () => {
  it('producer effectiveRate is 4× at floorLevel 3 vs L0', () => {
    const mineL0: PlacedBuilding = { id: 'b-mine-l0', defId: 'mine', x: 0, y: 0 };
    const mineL3: PlacedBuilding = { id: 'b-mine-l3', defId: 'mine', x: 0, y: 0, floorLevel: 3 };

    const stateL0 = makeState({ buildings: [mineL0] });
    const stateL3 = makeState({ buildings: [mineL3] });

    const ratesL0 = computeRates(stateL0);
    const ratesL3 = computeRates(stateL3);

    const rateL0 = ratesL0.byBuilding[0]!.effectiveRate;
    const rateL3 = ratesL3.byBuilding[0]!.effectiveRate;

    expect(rateL3).toBeCloseTo(rateL0 * 4, 9);
  });

  it('consumer power.consumed is 2.5× at floorLevel 3 vs L0', () => {
    // Mine consumes power but has no inputs, so nominalThroughputFrac is always 1.
    // The only scaling factor is floorPowerDrawMul.
    const mineL0: PlacedBuilding = { id: 'b-mine-l0', defId: 'mine', x: 0, y: 0 };
    const mineL3: PlacedBuilding = { id: 'b-mine-l3', defId: 'mine', x: 0, y: 0, floorLevel: 3 };

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
});
