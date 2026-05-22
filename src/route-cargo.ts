// src/route-cargo.ts — pure: no PixiJS, no world mutation.
import type { ResourceId } from './recipes.js';

export type CargoMode = 'priority' | 'waterfall' | 'split' | 'balanced';

export interface CargoEntry {
  readonly resourceId: ResourceId | 'all';
  /** split mode only; must be > 0; treated as 1 when absent. */
  readonly weight?: number;
  /** optional source-floor gate, 0–100 (% of source cap). Absent = no gate. */
  readonly sourceFloorPct?: number;
}

/** Sentinel value for a CargoEntry that matches every ResourceId not
 *  otherwise listed explicitly in the same cargo. Only valid at
 *  CargoEntry.resourceId; pure helpers expand it before the per-resource
 *  viability check. */
export const CARGO_WILDCARD = 'all' as const;

/** A cargo entry that has already passed the viability gate, with the
 *  per-tick facts the allocator needs. Built by routes.ts's planRouteCargo. */
export interface ViableEntry {
  readonly resourceId: ResourceId;
  readonly weight: number;
  readonly headroom: number;
  readonly sourceAvail: number;
  readonly destFillRatio: number;
}

export interface CargoDemand {
  readonly resourceId: ResourceId;
  readonly amount: number;
}

/** Divide one tick's capacity budget across viable cargo entries per mode.
 *  `entries` are pre-filtered to viable and ordered as in the cargo list. Pure. */
export function planCargo(
  mode: CargoMode,
  entries: ReadonlyArray<ViableEntry>,
  budget: number,
): CargoDemand[] {
  if (entries.length === 0 || budget <= 0) return [];

  if (mode === 'priority') {
    const e = entries[0]!;
    const amount = Math.min(budget, e.headroom);
    return amount > 0 ? [{ resourceId: e.resourceId, amount }] : [];
  }

  if (mode === 'balanced') {
    let best = entries[0]!;
    for (const e of entries) {
      if (e.destFillRatio < best.destFillRatio) best = e; // strict < → ties keep list order
    }
    const amount = Math.min(budget, best.headroom);
    return amount > 0 ? [{ resourceId: best.resourceId, amount }] : [];
  }

  if (mode === 'split') {
    let sumW = 0;
    for (const e of entries) sumW += e.weight;
    if (sumW <= 0) return [];
    const out: CargoDemand[] = [];
    for (const e of entries) {
      const amount = Math.min(budget * (e.weight / sumW), e.headroom);
      if (amount > 0) out.push({ resourceId: e.resourceId, amount });
    }
    return out;
  }

  // waterfall: fill each entry to its source/headroom limit, spill the rest.
  let remaining = budget;
  const out: CargoDemand[] = [];
  for (const e of entries) {
    if (remaining <= 0) break;
    const amount = Math.min(remaining, e.headroom, e.sourceAvail);
    if (amount > 0) {
      out.push({ resourceId: e.resourceId, amount });
      remaining -= amount;
    }
  }
  return out;
}

/** Convert a route that may carry the legacy {filter, priorityList} shape
 *  to the {mode, cargo} shape. Idempotent: a route that already has `mode`
 *  is returned unchanged. */
export function migrateLegacyCargo(
  r: {
    mode?: CargoMode;
    cargo?: CargoEntry[];
    filter?: ResourceId | null;
    priorityList?: ReadonlyArray<ResourceId>;
  },
): { mode: CargoMode; cargo: CargoEntry[] } {
  if (r.mode !== undefined && r.cargo !== undefined) {
    return { mode: r.mode, cargo: r.cargo };
  }
  if (r.filter !== undefined && r.filter !== null) {
    return { mode: 'priority', cargo: [{ resourceId: r.filter }] };
  }
  const list = r.priorityList ?? [];
  return { mode: 'priority', cargo: list.map((resourceId) => ({ resourceId })) };
}
