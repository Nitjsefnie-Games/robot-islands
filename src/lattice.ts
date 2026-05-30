// §13.3 Omniscient Lattice — activation logic and pure helpers.
//
// No PixiJS, no DOM. Activation mutates WorldState in place (sets
// latticeActive + latticeNodeIslands) but does not touch economy state.

import { hasOperationalBuilding, type PlacedBuilding } from './buildings.js';
import { LATTICE_ACTIVATION_THRESHOLD } from './constants.js';
import { networkedIslandIds } from './network-consciousness.js';
import type { ResourceId } from './recipes.js';
import { tierForLevel } from './skilltree.js';
import type { WorldState } from './world.js';

/** §13.3 Network Consciousness threshold for Omniscient Lattice activation.
 *  Re-exported from the canonical `constants.ts`; the same value drives the
 *  milestone-4 row of `MILESTONE_TABLE` in `network-consciousness.ts` so the
 *  two cannot drift. */
export { LATTICE_ACTIVATION_THRESHOLD };

/** §13.3 A T5-mastered island has reached level 50 AND crafted an AI core. */
function isT5Mastered(world: WorldState, islandId: string): boolean {
  const state = world.islandStates?.get(islandId);
  if (!state) return false;
  return tierForLevel(state.level) >= 5 && state.aiCoreCrafted;
}

/** Does the island have at least one valid Lattice Node? */
function hasLatticeNode(spec: WorldState['islands'][number]): boolean {
  return hasOperationalBuilding(spec.buildings, 'lattice_node');
}

/**
 * Compute whether the Omniscient Lattice should be active.
 *
 * Re-evaluates every call (no early-return on a previously-set
 * `latticeActive`): if the strict gate stops being satisfied — e.g. a
 * networked island goes offline, a Lattice Node is destroyed, a route is
 * deleted — the flag flips back to false. The flag re-flips to true the
 * moment the network catches up. This avoids carrying a stale active flag
 * across saves loaded from the older lax-gate version (which counted
 * non-networked T5+Node islands).
 *
 * Strict gate per §13.3 + §9.6: an island counts toward activation only if
 *   (1) it has at least one valid Lattice Node,
 *   (2) its IslandState is T5-mastered (level ≥ 50 AND AI core crafted), and
 *   (3) it is route-graph-reachable from home (the §9.6 Network
 *       Consciousness membership rule).
 *
 * When the count reaches `LATTICE_ACTIVATION_THRESHOLD`, mutates
 * `world.latticeActive` to true and records the participating island IDs in
 * `world.latticeNodeIslands`. Below threshold, mutates back to inactive.
 */
export function computeLatticeActive(world: WorldState): boolean {
  const networked = networkedIslandIds(world);
  const nodeIslands: string[] = [];
  for (const spec of world.islands) {
    if (!networked.has(spec.id)) continue;
    if (!isT5Mastered(world, spec.id)) continue;
    if (!hasLatticeNode(spec)) continue;
    nodeIslands.push(spec.id);
  }
  if (nodeIslands.length >= LATTICE_ACTIVATION_THRESHOLD) {
    world.latticeActive = true;
    world.latticeNodeIslands = nodeIslands;
    return true;
  }
  world.latticeActive = false;
  world.latticeNodeIslands = [];
  return false;
}

/** Set of island IDs that participate in the active Lattice. */
export function latticeIslands(world: WorldState): Set<string> {
  if (!world.latticeActive) return new Set();
  return new Set(world.latticeNodeIslands);
}

/** Pure read — is the Lattice currently active? */
export function isLatticeActive(world: WorldState): boolean {
  return world.latticeActive;
}

/**
 * §13.3 Cross-island adjacency — all valid buildings on OTHER lattice islands.
 *
 * Returns a fresh array of every non-invalid building on lattice islands
 * other than `islandId`. When passed into `computeRates` as
 * `RatesContext.crossIsland`, these buildings count as neighbors for buff
 * and gate adjacency despite physical distance.
 *
 * Returns `undefined` when the Lattice is inactive or `islandId` is not a
 * Lattice island, so callers can use `?? undefined` without branching.
 */
export function crossIslandNeighbors(
  world: WorldState,
  islandId: string,
): PlacedBuilding[] | undefined {
  if (!world.latticeActive) return undefined;
  if (!world.latticeNodeIslands.includes(islandId)) return undefined;

  const out: PlacedBuilding[] = [];
  const seen = new Set<string>();
  for (const otherId of world.latticeNodeIslands) {
    if (otherId === islandId) continue;
    const otherSpec = world.islands.find((i) => i.id === otherId);
    if (!otherSpec) continue;
    for (const b of otherSpec.buildings) {
      if (b.invalid) continue;
      if (seen.has(b.id)) continue;
      seen.add(b.id);
      out.push(b);
    }
  }
  return out;
}

/**
 * §13.3 Summed storage caps across all Lattice islands.
 *
 * Returns a fresh Record summing every ResourceId across the storageCaps of
 * islands in `world.latticeNodeIslands`. Returns `undefined` when the Lattice
 * is inactive so callers can fall back to local caps without branching.
 */
export function latticeStorageCaps(
  world: WorldState,
): Record<ResourceId, number> | undefined {
  if (!world.latticeActive) return undefined;
  const unified: Record<ResourceId, number> = {} as Record<ResourceId, number>;
  for (const id of world.latticeNodeIslands) {
    const state = world.islandStates?.get(id);
    if (!state) continue;
    for (const [r, amt] of Object.entries(state.storageCaps)) {
      unified[r as ResourceId] = (unified[r as ResourceId] ?? 0) + (amt ?? 0);
    }
  }
  return unified;
}

/**
 * §13.3 Unified inventory across all Lattice islands.
 *
 * Returns a fresh Record summing every ResourceId across the inventories of
 * islands in `world.latticeNodeIslands`. Returns `undefined` when the Lattice
 * is inactive so callers can use `?? state.inventory` without branching.
 *
 */
export function latticeInventory(
  world: WorldState,
): Record<ResourceId, number> | undefined {
  if (!world.latticeActive) return undefined;
  const unified: Record<ResourceId, number> = {} as Record<ResourceId, number>;
  for (const id of world.latticeNodeIslands) {
    const state = world.islandStates?.get(id);
    if (!state) continue;
    for (const [r, amt] of Object.entries(state.inventory)) {
      unified[r as ResourceId] = (unified[r as ResourceId] ?? 0) + (amt ?? 0);
    }
  }
  return unified;
}
