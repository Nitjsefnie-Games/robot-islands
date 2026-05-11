// Pure-math tests for the §4.7 maintenance system.
//
// `maintenance.ts` is intentionally pure (no PixiJS / no DOM / no Date.now)
// — every behaviour is testable from a synthetic PlacedBuilding + def. The
// economy-loop integration with the auto-maintain cycle lives in
// `economy.test.ts` so the cap/event-driven loop stays exercised end-to-end.

import { describe, expect, it } from 'vitest';

import { BUILDING_DEFS } from './building-defs.js';
import type { PlacedBuilding } from './buildings.js';
import {
  MAINTENANCE_DEGRADE_DURATION_MS,
  MAINTENANCE_RAMP_SEGMENTS,
  MAINTENANCE_THRESHOLD_MS_BY_TIER,
  accrueOperatingTime,
  maintenanceFactor,
  nextMaintenanceBoundaryMs,
  tryAutoMaintain,
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
