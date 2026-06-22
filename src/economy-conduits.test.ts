// Tests for threading §4.5 conduit cluster unions through the per-island
// economy derivation memo (`getDerivationsMemo` → `clusterBonusMuls`).
//
// The mechanic: same-category buildings 4-adjacent to wired conduits cluster
// together at FULL strength regardless of physical distance, both SAME-island
// (both attached buildings already in this island's cluster set) and
// CROSS-island (a remote building on another island, supplied to the ctx via
// `conduitRemoteAttached`). A union promotes each member's cluster bonus from
// ×1.0 (lone) to 1 + CATEGORY_ADJACENCY_RATE × (K − c_i).
//
// NON-NEGOTIABLE inert invariant: with empty conduit data the derivation and
// effective rates must be byte-identical to a run with the fields absent — a
// world with no conduit links advances identically (server SHA-256 oracle).

import { beforeEach, describe, expect, it } from 'vitest';

import {
  BUILDING_DEFS,
  type BuildingDef,
  type BuildingDefId,
} from './building-defs.js';
import type { PlacedBuilding } from './buildings.js';
import {
  clearDerivationsMemoForTests,
  computeRates,
  type DefCatalog,
  type IslandState,
  type RatesContext,
} from './economy.js';
import { ALL_RESOURCES, type ResourceId } from './recipes.js';

// Strip power so the mines run at full duty (no brownout) — mirrors economy.test.ts.
function powerFreeCatalog(): DefCatalog {
  const base = { ...BUILDING_DEFS } as Record<BuildingDefId, BuildingDef>;
  const def = base.iron_mine;
  const { power: _power, ...rest } = def;
  base.iron_mine = rest as BuildingDef;
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

function makeState(id: string, buildings: PlacedBuilding[]): IslandState {
  return {
    id,
    buildings,
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
    funnelPending: {} as Record<ResourceId, number>,
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
  };
}

// Two iron mines (extraction, ×0.05 cluster rate, 2×2 footprint) placed far
// apart so they are NOT naturally 4-adjacent — only a conduit union can merge
// them. Each base-produces 0.05 iron_ore/s.
function twoFarMines(): [PlacedBuilding, PlacedBuilding] {
  return [
    { id: 'm1', defId: 'iron_mine', x: 0, y: 0 },
    { id: 'm2', defId: 'iron_mine', x: 10, y: 0 },
  ];
}

beforeEach(() => clearDerivationsMemoForTests());

describe('conduit cluster unions threaded through the economy', () => {
  it('same-island: a conduit union raises both producers’ effective rate', () => {
    const [m1, m2] = twoFarMines();
    const baseCtx: RatesContext = { defs: POWER_FREE };

    const noUnion = computeRates(makeState('isl', [m1, m2]), baseCtx);
    clearDerivationsMemoForTests();
    const withUnion = computeRates(makeState('isl', [m1, m2]), {
      ...baseCtx,
      conduitUnions: [[m1.id, m2.id]],
    });

    // K=2, c_i=1 → bonus 1 + 0.05×(2−1) = 1.05 each; total iron_ore 0.105 vs 0.10.
    expect(withUnion.production.iron_ore ?? 0).toBeGreaterThan(noUnion.production.iron_ore ?? 0);
    expect(withUnion.production.iron_ore ?? 0).toBeCloseTo(0.105, 9);
    expect(noUnion.production.iron_ore ?? 0).toBeCloseTo(0.1, 9);
  });

  it('cross-island: a remote attached building raises the local producer’s rate', () => {
    const [m1, m2] = twoFarMines();
    // Island A holds only m1; m2 lives on another island and is supplied as a
    // remote attached building, with the cross-island union pair.
    const baseCtx: RatesContext = { defs: POWER_FREE };

    const lone = computeRates(makeState('islA', [m1]), baseCtx);
    clearDerivationsMemoForTests();
    const wired = computeRates(makeState('islA', [m1]), {
      ...baseCtx,
      conduitUnions: [[m1.id, m2.id]],
      conduitRemoteAttached: [m2],
    });

    // m1 alone → ×1.0 (0.05). Unioned with the remote m2 → K=2 → ×1.05 (0.0525).
    expect(wired.production.iron_ore ?? 0).toBeGreaterThan(lone.production.iron_ore ?? 0);
    expect(lone.production.iron_ore ?? 0).toBeCloseTo(0.05, 9);
    expect(wired.production.iron_ore ?? 0).toBeCloseTo(0.0525, 9);
  });

  it('inert: empty conduit data yields byte-identical rates to the fields being absent', () => {
    const [m1, m2] = twoFarMines();

    const absent = computeRates(makeState('isl', [m1, m2]), { defs: POWER_FREE });
    clearDerivationsMemoForTests();
    const emptyArrays = computeRates(makeState('isl', [m1, m2]), {
      defs: POWER_FREE,
      conduitUnions: [],
      conduitRemoteAttached: [],
    });

    expect(emptyArrays.production.iron_ore ?? 0).toBe(absent.production.iron_ore ?? 0);
    for (const r of ALL_RESOURCES) {
      expect(emptyArrays.production[r] ?? 0).toBe(absent.production[r] ?? 0);
      expect(emptyArrays.net[r] ?? 0).toBe(absent.net[r] ?? 0);
    }
  });
});
