// Pure-math tests for the §4.7 maintenance system.
//
// `maintenance.ts` is intentionally pure (no PixiJS / no DOM / no Date.now)
// — every behaviour is testable from a synthetic PlacedBuilding + def. The
// economy-loop integration with the auto-maintain cycle lives in
// `economy.test.ts` so the cap/event-driven loop stays exercised end-to-end.

import { describe, expect, it } from 'vitest';

import { BUILDING_DEFS, type BuildingDef } from './building-defs.js';
import { convertToServitor, displayedFloorLevel, type PlacedBuilding } from './buildings.js';
import type { IslandState } from './economy.js';
import {
  MAINTENANCE_DEGRADE_DURATION_MS,
  MAINTENANCE_RAMP_SEGMENTS,
  MAINTENANCE_THRESHOLD_MS_BY_TIER,
  MAINTENANCE_RECIPES,
  accrueOperatingTime,
  maintenanceFactor,
  nextMaintenanceBoundaryMs,
  pickMostDegradedTarget,
  refreshCostFor,
  tryAutoMaintain,
  tryRefreshMaintenance,
} from './maintenance.js';
import { ALL_RESOURCES, type ResourceId } from './recipes.js';
import type { Tier } from './skilltree.js';

/** A fresh PlacedBuilding fixture with maintenance fields zeroed. The `defId`
 *  selects the tier — `mine` (T1) by default. */
function mkBuilding(
  defId: keyof typeof BUILDING_DEFS = 'mine',
  operatingMs = 0,
): PlacedBuilding {
  return {
    id: 'b-test',
    defId,
    x: 0,
    y: 0,
    operatingMs,
    placedAt: 0,
    maintainedAt: 0,
  };
}

function blankInventory(): Record<ResourceId, number> {
  const inv = {} as Record<ResourceId, number>;
  for (const r of ALL_RESOURCES) inv[r] = 0;
  return inv;
}

const T1_THRESHOLD = MAINTENANCE_THRESHOLD_MS_BY_TIER[1];
const HOUR = 60 * 60 * 1000;

it('T6 maintenance recipe matches §4.7 spec literal (memetic_core, not stand-in)', () => {
  expect(MAINTENANCE_RECIPES[6]).toEqual({
    lubricant: 25,
    reality_anchor: 1,
    memetic_core: 1,
  });
});

describe('maintenanceFactor', () => {
  it('returns 1.0 at operatingMs = 0', () => {
    const b = mkBuilding('mine', 0);
    expect(maintenanceFactor(b, BUILDING_DEFS.mine)).toBe(1.0);
  });

  it('returns 1.0 just below threshold (threshold - 1)', () => {
    const b = mkBuilding('mine', T1_THRESHOLD - 1);
    expect(maintenanceFactor(b, BUILDING_DEFS.mine)).toBe(1.0);
  });

  it('returns 1.0 exactly at threshold (overshoot = 0)', () => {
    const b = mkBuilding('mine', T1_THRESHOLD);
    expect(maintenanceFactor(b, BUILDING_DEFS.mine)).toBe(1.0);
  });

  it('returns 0.5 at threshold + 4h (plateau)', () => {
    const b = mkBuilding('mine', T1_THRESHOLD + MAINTENANCE_DEGRADE_DURATION_MS);
    expect(maintenanceFactor(b, BUILDING_DEFS.mine)).toBe(0.5);
  });

  it('returns 0.5 at threshold + 8h (well past plateau, clamped)', () => {
    const b = mkBuilding('mine', T1_THRESHOLD + 8 * HOUR);
    expect(maintenanceFactor(b, BUILDING_DEFS.mine)).toBe(0.5);
  });

  it('linearly interpolates at threshold + 2h → 0.75', () => {
    const b = mkBuilding('mine', T1_THRESHOLD + 2 * HOUR);
    expect(maintenanceFactor(b, BUILDING_DEFS.mine)).toBeCloseTo(0.75, 10);
  });

  it('linearly interpolates at threshold + 1h → 0.875', () => {
    const b = mkBuilding('mine', T1_THRESHOLD + 1 * HOUR);
    expect(maintenanceFactor(b, BUILDING_DEFS.mine)).toBeCloseTo(0.875, 10);
  });

  it('linearly interpolates at threshold + 3h → 0.625', () => {
    const b = mkBuilding('mine', T1_THRESHOLD + 3 * HOUR);
    expect(maintenanceFactor(b, BUILDING_DEFS.mine)).toBeCloseTo(0.625, 10);
  });

  it('honours Eternal Servitor exemption regardless of operatingMs', () => {
    const b: PlacedBuilding = { ...mkBuilding('mine', T1_THRESHOLD + 8 * HOUR), eternalServitor: true };
    expect(maintenanceFactor(b, BUILDING_DEFS.mine)).toBe(1.0);
  });

  it('uses each tier-specific threshold', () => {
    // T2 = 16h, T3 = 20h, T4/T5/T6 = 24h. Verify each tier picks its own.
    for (const tier of [1, 2, 3, 4, 5, 6] as ReadonlyArray<Tier>) {
      const threshold = MAINTENANCE_THRESHOLD_MS_BY_TIER[tier];
      // Just-under-threshold → 1.0, just-past plateau → 0.5.
      const fakeDef = { ...BUILDING_DEFS.mine, tier };
      const under = mkBuilding('mine', threshold - 1);
      const past = mkBuilding('mine', threshold + MAINTENANCE_DEGRADE_DURATION_MS + 1);
      expect(maintenanceFactor(under, fakeDef)).toBe(1.0);
      expect(maintenanceFactor(past, fakeDef)).toBe(0.5);
    }
  });

  it('treats missing operatingMs (legacy save forward-compat) as 0', () => {
    const b: PlacedBuilding = { id: 'b', defId: 'mine', x: 0, y: 0 };
    expect(maintenanceFactor(b, BUILDING_DEFS.mine)).toBe(1.0);
  });
});

describe('accrueOperatingTime', () => {
  it('adds dt to operatingMs', () => {
    const b = mkBuilding('mine', 1000);
    accrueOperatingTime(b, 500);
    expect(b.operatingMs).toBe(1500);
  });

  it('treats undefined operatingMs as 0 then adds', () => {
    const b: PlacedBuilding = { id: 'b', defId: 'mine', x: 0, y: 0 };
    accrueOperatingTime(b, 1234);
    expect(b.operatingMs).toBe(1234);
  });

  it('skips Eternal Servitor buildings', () => {
    const b: PlacedBuilding = { ...mkBuilding('mine', 0), eternalServitor: true };
    accrueOperatingTime(b, 5000);
    expect(b.operatingMs).toBe(0);
  });

  it('ignores zero / negative dt', () => {
    const b = mkBuilding('mine', 1000);
    accrueOperatingTime(b, 0);
    accrueOperatingTime(b, -100);
    expect(b.operatingMs).toBe(1000);
  });
});

describe('tryAutoMaintain', () => {
  it('does nothing when under threshold', () => {
    const b = mkBuilding('mine', T1_THRESHOLD - 1);
    const inv = blankInventory();
    inv.lubricant = 100;
    inv.bolt = 100;
    expect(tryAutoMaintain(b, BUILDING_DEFS.mine, inv, 999)).toBe(false);
    // No materials consumed.
    expect(inv.lubricant).toBe(100);
    expect(inv.bolt).toBe(100);
    // operatingMs untouched.
    expect(b.operatingMs).toBe(T1_THRESHOLD - 1);
  });

  it('does nothing past threshold when materials missing', () => {
    const b = mkBuilding('mine', T1_THRESHOLD + 10);
    const inv = blankInventory();
    inv.lubricant = 1; // need 2 for T1
    expect(tryAutoMaintain(b, BUILDING_DEFS.mine, inv, 999)).toBe(false);
    // Atomic: nothing consumed when bill incomplete.
    expect(inv.lubricant).toBe(1);
  });

  it('consumes materials and resets operatingMs when bill is satisfied', () => {
    const b = mkBuilding('mine', T1_THRESHOLD + 2 * HOUR);
    const inv = blankInventory();
    inv.lubricant = 10;
    inv.bolt = 10;
    expect(tryAutoMaintain(b, BUILDING_DEFS.mine, inv, 12_345)).toBe(true);
    expect(inv.lubricant).toBe(8); // 10 - 2
    expect(inv.bolt).toBe(5);      // 10 - 5
    expect(b.operatingMs).toBe(0);
    expect(b.maintainedAt).toBe(12_345);
  });

  it('skips Eternal Servitor regardless of operatingMs', () => {
    const b: PlacedBuilding = { ...mkBuilding('mine', T1_THRESHOLD * 10), eternalServitor: true };
    const inv = blankInventory();
    inv.lubricant = 100;
    inv.bolt = 100;
    expect(tryAutoMaintain(b, BUILDING_DEFS.mine, inv, 999)).toBe(false);
    expect(inv.lubricant).toBe(100);
  });
});

describe('nextMaintenanceBoundaryMs', () => {
  it('returns the threshold when under it', () => {
    const b = mkBuilding('mine', 1000);
    expect(nextMaintenanceBoundaryMs(b, BUILDING_DEFS.mine)).toBe(T1_THRESHOLD);
  });

  it('returns the next ramp sub-boundary when in the ramp window', () => {
    // 8 sub-segments per 4h ramp → 30 min each. Starting at threshold + 1h
    // means we've crossed 2 sub-boundaries already; next is at +1.5h.
    const stepMs = MAINTENANCE_DEGRADE_DURATION_MS / MAINTENANCE_RAMP_SEGMENTS;
    const b = mkBuilding('mine', T1_THRESHOLD + HOUR);
    expect(nextMaintenanceBoundaryMs(b, BUILDING_DEFS.mine)).toBe(
      T1_THRESHOLD + 3 * stepMs,
    );
  });

  it('returns the plateau boundary at the end of the last ramp sub-segment', () => {
    // Just before plateau (operating in the last sub-segment) → next is plateau.
    const stepMs = MAINTENANCE_DEGRADE_DURATION_MS / MAINTENANCE_RAMP_SEGMENTS;
    const b = mkBuilding(
      'mine',
      T1_THRESHOLD + MAINTENANCE_DEGRADE_DURATION_MS - stepMs / 2,
    );
    expect(nextMaintenanceBoundaryMs(b, BUILDING_DEFS.mine)).toBe(
      T1_THRESHOLD + MAINTENANCE_DEGRADE_DURATION_MS,
    );
  });

  it('returns null past the plateau', () => {
    const b = mkBuilding('mine', T1_THRESHOLD + 5 * HOUR);
    expect(nextMaintenanceBoundaryMs(b, BUILDING_DEFS.mine)).toBe(null);
  });

  it('returns null for Eternal Servitor', () => {
    const b: PlacedBuilding = { ...mkBuilding('mine', 0), eternalServitor: true };
    expect(nextMaintenanceBoundaryMs(b, BUILDING_DEFS.mine)).toBe(null);
  });
});


// §13.3 Servitor Conversion Kit helpers

function makeStateWithBuilding(overrides: Partial<PlacedBuilding> = {}): IslandState {
  const building: PlacedBuilding = {
    id: 'b-test',
    defId: 'mine',
    x: 0,
    y: 0,
    ...overrides,
  };
  return {
    id: 'test-island',
    buildings: [building],
    inventory: blankInventory(),
    storageCaps: blankInventory(),
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
    everProduced: new Set(),
    tradeCooldownMs: 0,
    tradeAcceptCount: 0,
    lastTick: 0,
  };
}

describe('§13.3 Servitor Conversion', () => {
  it('converts a T4 building when materials present', () => {
    const state = makeStateWithBuilding({ defId: 'fusion_core' /* T4 */ });
    state.inventory.lubricant = 10;
    state.inventory.exotic_alloy = 1;
    state.inventory.microchip = 1;
    state.inventory.eldritch_processor = 1;
    state.inventory.phase_converter = 1;
    const r = convertToServitor(state, state.buildings[0]!.id, BUILDING_DEFS);
    expect(r.ok).toBe(true);
    expect(state.buildings[0]!.eternalServitor).toBe(true);
    // Materials consumed:
    expect(state.inventory.lubricant).toBe(0);
    expect(state.inventory.exotic_alloy).toBe(0);
    expect(state.inventory.microchip).toBe(0);
    expect(state.inventory.eldritch_processor).toBe(0);
    expect(state.inventory.phase_converter).toBe(0);
  });

  it('rejects when materials insufficient', () => {
    const state = makeStateWithBuilding({ defId: 'fusion_core' /* T4 */ });
    // Insufficient: missing eldritch_processor.
    state.inventory.lubricant = 10;
    state.inventory.exotic_alloy = 1;
    state.inventory.microchip = 1;
    state.inventory.phase_converter = 1;
    const r = convertToServitor(state, state.buildings[0]!.id, BUILDING_DEFS);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe('insufficient-materials');
    expect(state.buildings[0]!.eternalServitor).toBeUndefined();
    // Inventory unchanged:
    expect(state.inventory.lubricant).toBe(10);
  });

  it('rejects when building already a servitor', () => {
    const state = makeStateWithBuilding({ defId: 'fusion_core' });
    (state.buildings[0] as { eternalServitor?: true }).eternalServitor = true;
    // Stuff inventory.
    state.inventory.eldritch_processor = 1; state.inventory.phase_converter = 1;
    state.inventory.lubricant = 10; state.inventory.exotic_alloy = 1; state.inventory.microchip = 1;
    const r = convertToServitor(state, state.buildings[0]!.id, BUILDING_DEFS);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe('already-servitor');
  });

  it('per-tier cost matches §13.3 — T5 building uses T5 maintenance recipe', () => {
    const state = makeStateWithBuilding({ defId: 'reality_forge' /* T5 */ });
    state.inventory.lubricant = 15;
    state.inventory.phase_converter = 2;       // 1 in maintenance recipe + 1 for kit
    state.inventory.eldritch_processor = 2;    // 1 in maintenance recipe + 1 for kit
    const r = convertToServitor(state, state.buildings[0]!.id, BUILDING_DEFS);
    expect(r.ok).toBe(true);
    expect(state.inventory.lubricant).toBe(0);
    expect(state.inventory.phase_converter).toBe(0);
    expect(state.inventory.eldritch_processor).toBe(0);
  });
});

describe('pickMostDegradedTarget', () => {
  const T1_THRESHOLD = MAINTENANCE_THRESHOLD_MS_BY_TIER[1];

  it('returns null when no buildings are over threshold', () => {
    const b1 = mkBuilding('mine', T1_THRESHOLD - 1);
    const b2 = mkBuilding('solar', T1_THRESHOLD - 100);
    expect(pickMostDegradedTarget([b1, b2], BUILDING_DEFS)).toBeNull();
  });

  it('returns null on an empty building list', () => {
    expect(pickMostDegradedTarget([], BUILDING_DEFS)).toBeNull();
  });

  it('picks the single over-threshold building when only one exists', () => {
    const b1 = mkBuilding('mine', T1_THRESHOLD - 1);            // factor 1.0
    const b2 = mkBuilding('mine', T1_THRESHOLD + 1);            // ramp start
    expect(pickMostDegradedTarget([b1, b2], BUILDING_DEFS)).toBe(b2);
  });

  it('picks the most-degraded (lowest factor) when multiple are over threshold', () => {
    // b1 just over threshold, b2 deep in ramp, b3 at plateau.
    const b1 = mkBuilding('mine', T1_THRESHOLD + 1000);
    const b2 = mkBuilding('mine', T1_THRESHOLD + MAINTENANCE_DEGRADE_DURATION_MS / 2);
    const b3 = mkBuilding('mine', T1_THRESHOLD + MAINTENANCE_DEGRADE_DURATION_MS * 2);
    expect(pickMostDegradedTarget([b1, b2, b3], BUILDING_DEFS)).toBe(b3);
  });

  it('breaks ties by array order (first listed wins)', () => {
    const b1 = mkBuilding('mine', T1_THRESHOLD + MAINTENANCE_DEGRADE_DURATION_MS * 2);
    const b2 = mkBuilding('mine', T1_THRESHOLD + MAINTENANCE_DEGRADE_DURATION_MS * 2);
    expect(pickMostDegradedTarget([b1, b2], BUILDING_DEFS)).toBe(b1);
  });

  it('skips Eternal Servitors (their factor is always 1.0)', () => {
    const servitor = mkBuilding('mine', T1_THRESHOLD * 100);
    (servitor as { eternalServitor?: true }).eternalServitor = true;
    const normal = mkBuilding('mine', T1_THRESHOLD + 1);
    expect(pickMostDegradedTarget([servitor, normal], BUILDING_DEFS)).toBe(normal);
  });

  it('skips disabled buildings — a less-degraded enabled sibling is targeted (fix 4.4)', () => {
    // The disabled one is plateau-deep (most degraded); without the filter
    // it would be targeted and — its recipe likely out of stock — block ALL
    // auto-maintenance on the island (caller picks exactly one target).
    const disabled = mkBuilding('mine', T1_THRESHOLD + MAINTENANCE_DEGRADE_DURATION_MS * 2);
    (disabled as { disabledFloors?: number }).disabledFloors = displayedFloorLevel({ floorLevel: 0 });
    const enabled = mkBuilding('mine', T1_THRESHOLD + 1000);
    expect(pickMostDegradedTarget([disabled, enabled], BUILDING_DEFS)).toBe(enabled);
  });

  it('skips invalid buildings (fix 4.4)', () => {
    const invalid = mkBuilding('mine', T1_THRESHOLD + MAINTENANCE_DEGRADE_DURATION_MS * 2);
    (invalid as { invalid?: boolean }).invalid = true;
    const enabled = mkBuilding('mine', T1_THRESHOLD + 1000);
    expect(pickMostDegradedTarget([invalid, enabled], BUILDING_DEFS)).toBe(enabled);
  });

  it('returns null when every degraded building is disabled or invalid (fix 4.4)', () => {
    const disabled = mkBuilding('mine', T1_THRESHOLD + 1000);
    (disabled as { disabledFloors?: number }).disabledFloors = displayedFloorLevel({ floorLevel: 0 });
    const invalid = mkBuilding('mine', T1_THRESHOLD + 1000);
    (invalid as { invalid?: boolean }).invalid = true;
    expect(pickMostDegradedTarget([disabled, invalid], BUILDING_DEFS)).toBeNull();
  });
});


describe('refreshCostFor', () => {
  it('halves each placement-cost resource, floored', () => {
    const def = { placementCost: { stone: 60, wood: 30, iron_ingot: 20 } } as BuildingDef;
    expect(refreshCostFor(def)).toEqual({ stone: 30, wood: 15, iron_ingot: 10 });
  });
  it('drops a resource whose half rounds to 0', () => {
    const def = { placementCost: { stone: 7, wood: 1 } } as BuildingDef;
    expect(refreshCostFor(def)).toEqual({ stone: 3 });
  });
  it('returns {} for a def with no placementCost', () => {
    expect(refreshCostFor({} as BuildingDef)).toEqual({});
  });
});


describe('tryRefreshMaintenance', () => {
  const T2_THRESHOLD = MAINTENANCE_THRESHOLD_MS_BY_TIER[2];
  const HEAVY = BUILDING_DEFS.heavy_logger;

  function stockedInventory(): Record<ResourceId, number> {
    const inv = blankInventory();
    inv.concrete = 5000;
    inv.stone = 3000;
    inv.iron_ingot = 1500;
    inv.gear = 200;
    inv.copper_ingot = 150;
    return inv;
  }

  it('refreshes a degraded building: deducts half cost, resets operatingMs', () => {
    const b = mkBuilding('heavy_logger', T2_THRESHOLD + HOUR);
    const inv = stockedInventory();
    const ok = tryRefreshMaintenance(b, HEAVY, inv, 5000);
    expect(ok).toBe(true);
    expect(inv.concrete).toBe(1000);
    expect(inv.stone).toBe(500);
    expect(inv.iron_ingot).toBe(500);
    expect(inv.gear).toBe(50);
    expect(inv.copper_ingot).toBe(50);
    expect(b.operatingMs).toBe(0);
    expect(b.maintainedAt).toBe(5000);
    expect(b.placedAt).toBe(0);
  });

  it('refuses a pristine building (operatingMs below threshold), mutates nothing', () => {
    const b = mkBuilding('heavy_logger', T2_THRESHOLD - HOUR);
    const inv = stockedInventory();
    expect(tryRefreshMaintenance(b, HEAVY, inv, 5000)).toBe(false);
    expect(inv.stone).toBe(3000);
    expect(b.operatingMs).toBe(T2_THRESHOLD - HOUR);
  });

  it('refuses an Eternal Servitor, mutates nothing', () => {
    const b: PlacedBuilding = { ...mkBuilding('heavy_logger', T2_THRESHOLD + HOUR), eternalServitor: true };
    const inv = stockedInventory();
    expect(tryRefreshMaintenance(b, HEAVY, inv, 5000)).toBe(false);
    expect(inv.stone).toBe(3000);
  });

  it('refuses a def with no placementCost (free refresh disallowed)', () => {
    const b = mkBuilding('heavy_logger', T2_THRESHOLD + HOUR);
    const def = { tier: 2 } as BuildingDef;
    const inv = stockedInventory();
    expect(tryRefreshMaintenance(b, def, inv, 5000)).toBe(false);
    expect(inv.stone).toBe(3000);
  });

  it('refuses and mutates nothing when inventory is short on any one resource', () => {
    const b = mkBuilding('heavy_logger', T2_THRESHOLD + HOUR);
    const inv = stockedInventory();
    inv.iron_ingot = 5; // need 1000
    expect(tryRefreshMaintenance(b, HEAVY, inv, 5000)).toBe(false);
    expect(inv.stone).toBe(3000); // atomicity — nothing consumed
    expect(inv.concrete).toBe(5000);
    expect(b.operatingMs).toBe(T2_THRESHOLD + HOUR);
  });

  it('honours thresholdMul — a building past base but below scaled threshold is pristine', () => {
    const b = mkBuilding('heavy_logger', T2_THRESHOLD + HOUR);
    const inv = stockedInventory();
    expect(tryRefreshMaintenance(b, HEAVY, inv, 5000, 2)).toBe(false);
    expect(inv.stone).toBe(3000);
  });

  it('result matches tryAutoMaintain — both leave factor 1.0', () => {
    const b = mkBuilding('heavy_logger', T2_THRESHOLD + HOUR);
    tryRefreshMaintenance(b, HEAVY, stockedInventory(), 5000);
    expect(maintenanceFactor(b, HEAVY)).toBe(1.0);
  });
});
