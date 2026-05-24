import { describe, expect, it } from 'vitest';
import { advanceIsland, batteryCapacityWs } from './economy.js';
import { effectiveSkillMultipliers } from './skilltree.js';
import type { ResourceId } from './recipes.js';
import { ALL_RESOURCES } from './recipes.js';

function blankInventory(): Record<ResourceId, number> {
  const inv = {} as Record<ResourceId, number>;
  for (const r of ALL_RESOURCES) inv[r] = 0;
  return inv;
}

function makeState(
  over: Partial<import('./economy.js').IslandState> = {},
): import('./economy.js').IslandState {
  return {
    id: 'test',
    buildings: [],
    inventory: blankInventory(),
    storageCaps: ((): Record<ResourceId, number> => {
      const caps = {} as Record<ResourceId, number>;
      for (const r of ALL_RESOURCES) caps[r] = 100;
      return caps;
    })(),
    xp: 0,
    level: 1,
    unspentSkillPoints: 0,
    unlockedNodes: new Set(),
    unlockedEdges: new Set(),
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

describe('battery ladder integration', () => {
  it('Battery Bank charges from power surplus and caps at BATTERY_CAPACITY_WS', () => {
    const state = makeState({
      buildings: [
        { id: 'b1', defId: 'battery_bank', x: 0, y: 0 },
        { id: 'f1', defId: 'coal_gen', x: 1, y: 0 },
        { id: 'm1', defId: 'mine', x: 2, y: 0 },
      ],
      inventory: { ...blankInventory(), coal: 10_000, iron_ore: 0 },
    });
    expect(state.batteryStoredWs).toBe(0);
    // Advance ~5 minutes. Coal generator produces 100W, mine consumes 25W;
    // 75W surplus charges the battery.
    advanceIsland(state, 300_000);
    expect(state.batteryStoredWs).toBeGreaterThan(0);
    // Cap is 5 kWh × 3600 = 18_000_000 Ws for one Battery Bank.
    expect(state.batteryStoredWs).toBeLessThanOrEqual(5_000 * 3600);
  });

  it('batteryCapacityWs sums across mixed battery types × batteryCapacity multiplier', () => {
    const state = makeState({
      buildings: [
        { id: 'b1', defId: 'battery_bank', x: 0, y: 0 },
        { id: 'c1', defId: 'capacitor_bank', x: 1, y: 0 },
      ],
    });
    const mul = effectiveSkillMultipliers(state);
    const cap1 = batteryCapacityWs(state, mul);
    expect(cap1).toBe((5_000 + 100_000) * 3600);
    (mul as any).batteryCapacity = 1.30;
    const cap2 = batteryCapacityWs(state, mul);
    expect(cap2).toBeCloseTo((5_000 + 100_000) * 3600 * 1.30, 6);
  });
});
