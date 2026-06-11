// D-02 — non-lattice cross-island shared-network grouped lockstep advance.
//
// Design: docs/superpowers/specs/2026-06-10-lattice-shared-flow-design.md
// (the partial-pooling generalization of D-01; see lattice-advance.ts header).
//
// Pure layer: no PixiJS, no DOM. Thin wrapper over `advanceSharedGroup`
// (lattice-advance.ts) that derives the shared-resource SET and the Σ-cap
// override from a `SharedNetworkState` and advances the participant group as
// ONE net-flow problem, pooling ONLY the shared-resource subset.
//
// THE BUG (same class as D-01): `computeSharedNetworkState` summed
// participants' inventories for skill-shared resources into a read-only
// `sharedInventory` snapshot; main.ts injected that snapshot as each
// participant's `ctx.inventory`/`ctx.caps`. `computeRates` read the POOLED
// total for the eligibility/cap gate, but per-island `applyRates` decremented
// ONLY the local island — partner stock never shrank (matter from nothing).
// Worse, the single pre-tick snapshot was handed to each participant
// independently, so two consumers could each drain the FULL pool in one tick
// (within-tick double-spend). The grouped lockstep advance fixes both: one
// pooled integration that actually drains + redistributes, and a single
// shared timeline so consumers throttle against each other.

import type { IslandState, RatesContext } from './economy.js';
import { advanceSharedGroup } from './lattice-advance.js';
import type { ResourceId } from './recipes.js';
import type { SharedNetworkState } from './network.js';

/**
 * The set of resources pooled across the shared network = the union of the
 * resources behind `sharedInventory` nodes and `sharedStorageCap` nodes.
 * (A resource may have a shared cap without shared inventory, or vice versa;
 * either way it is pooled — the cap raises headroom, the inventory pools the
 * stock, and the grouped advance handles both consistently.)
 */
export function sharedResourceSet(net: SharedNetworkState): Set<ResourceId> {
  const set = new Set<ResourceId>();
  for (const r of net.sharedInventory.keys()) set.add(r);
  for (const r of net.sharedStorageCap.keys()) set.add(r);
  return set;
}

/**
 * Advance a non-lattice shared-network participant group to `nowMs` as ONE
 * unit, pooling ONLY the shared-resource subset (`sharedResources`) AND only
 * across each resource's NODE-HOLDERS (`holders` — the D-02 node-holder rule:
 * an island that never bought the sharing skill for `r` keeps its `r` strictly
 * local). Caps for pooled resources use `sharedCaps` (Σ of participant nominal
 * caps from `sharedStorageCap`) where present, else Σ node-holder local caps.
 * NON-shared resources, and shared resources on non-holder islands, stay
 * strictly local. Delegates to `advanceSharedGroup` (lattice-advance.ts).
 */
export function advanceSharedNetworkGroup(
  states: ReadonlyArray<IslandState>,
  nowMs: number,
  ctxFor: (state: IslandState) => RatesContext,
  sharedResources: ReadonlySet<ResourceId>,
  sharedCaps: ReadonlyMap<ResourceId, number>,
  holders: ReadonlyMap<ResourceId, ReadonlySet<string>>,
  wallClockNowMs?: number,
): void {
  advanceSharedGroup(states, nowMs, ctxFor, sharedResources, sharedCaps, holders, wallClockNowMs);
}
