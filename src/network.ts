// Cross-island shared resource pools.

import type { ResourceId } from './recipes.js';
import type { Graph } from './skilltree-graph.js';
import { DEFAULT_GRAPH, graphById, tierForLevel } from './skilltree.js';
import type { WorldState } from './world.js';
import { networkedIslandIds } from './network-consciousness.js';

export interface SharedNetworkState {
  readonly sharedInventory: Map<ResourceId, number>;
  readonly sharedStorageCap: Map<ResourceId, number>;
  readonly sharedRouteCapacityBonus: number;
  readonly participantIds: ReadonlySet<string>;
  /**
   * Per-resource POOLING MEMBERSHIP: for each shared resource `r`, the set of
   * island ids that hold a `sharedInventory` (`crossIslandShared`) node
   * covering `r`. ONLY these islands pool `r` — they contribute their `r` to
   * the pooled sum AND receive `r` back in the cap-proportional
   * redistribution. A networked T3+ participant WITHOUT a node for `r` keeps
   * its `r` strictly LOCAL (not summed, not redistributed). Membership is
   * per-resource: an island may share coal but not iron. The grouped advance
   * (`advanceSharedNetworkGroup`) drives r's pool over this set. Mirrors the
   * `sharedInventory` aggregation exactly — same iterate-`unlockedNodes`,
   * `sharedInventory`-shape path — so the summed pool and its membership can
   * never drift.
   */
  readonly inventoryHolders: Map<ResourceId, ReadonlySet<string>>;
}

export function computeSharedNetworkState(
  world: WorldState,
  graph: Graph = DEFAULT_GRAPH,
): SharedNetworkState {
  const networked = networkedIslandIds(world);
  const byId = graphById(graph);
  const sharedInventory = new Map<ResourceId, number>();
  const sharedStorageCap = new Map<ResourceId, number>();
  const inventoryHolders = new Map<ResourceId, Set<string>>();
  let sharedRouteCapacityBonus = 0;
  const participantIds = new Set<string>();

  for (const island of world.islands) {
    if (!networked.has(island.id)) continue;
    const state = world.islandStates?.get(island.id);
    const level = state?.level ?? 1;
    if (tierForLevel(level) < 3) continue;

    participantIds.add(island.id);

    if (!state) continue;
    for (const nodeId of state.unlockedNodes) {
      const node = byId.get(nodeId as string);
      if (node?.effect.kind !== 'crossIslandShared') continue;
      const shape = node.effect.shape;
      switch (shape.kind) {
        case 'sharedInventory': {
          for (const r of shape.resources) {
            const id = r as ResourceId;
            const amount = state.inventory[id] ?? 0;
            const prev = sharedInventory.get(id) ?? 0;
            sharedInventory.set(id, prev + amount);
            // Record THIS island as a node-holder for r's pool. Tracked even
            // when its current stock is 0 — membership is by node ownership,
            // not by stock, so the island still RECEIVES a redistribution
            // share (by cap) of the pooled r.
            let holders = inventoryHolders.get(id);
            if (!holders) {
              holders = new Set<string>();
              inventoryHolders.set(id, holders);
            }
            holders.add(island.id);
          }
          break;
        }
        case 'sharedStorageCap': {
          for (const r of shape.resources) {
            const nominal = state.storageCaps[r as ResourceId] ?? 0;
            const prev = sharedStorageCap.get(r as ResourceId) ?? 0;
            sharedStorageCap.set(r as ResourceId, prev + nominal);
          }
          break;
        }
        case 'sharedRouteCapacity': {
          sharedRouteCapacityBonus += 1; // placeholder unit
          break;
        }
      }
    }
  }

  return {
    sharedInventory,
    sharedStorageCap,
    sharedRouteCapacityBonus,
    participantIds,
    inventoryHolders,
  };
}
