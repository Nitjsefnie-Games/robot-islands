// Cross-island shared resource pools (Task 13).

import type { ResourceId } from './recipes.js';
import type { Graph } from './skilltree-graph.js';
import { DEFAULT_GRAPH, tierForLevel } from './skilltree.js';
import type { WorldState } from './world.js';
import { networkedIslandIds } from './network-consciousness.js';

export interface SharedNetworkState {
  readonly sharedInventory: Map<ResourceId, number>;
  readonly sharedStorageCap: Map<ResourceId, number>;
  readonly sharedRouteCapacityBonus: number;
  readonly participantIds: ReadonlySet<string>;
}

export function computeSharedNetworkState(
  world: WorldState,
  graph: Graph = DEFAULT_GRAPH,
): SharedNetworkState {
  const networked = networkedIslandIds(world);
  const sharedInventory = new Map<ResourceId, number>();
  const sharedStorageCap = new Map<ResourceId, number>();
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
      const node = graph.nodes.find((n) => n.id === nodeId);
      if (node?.effect.kind !== 'crossIslandShared') continue;
      const shape = node.effect.shape;
      switch (shape.kind) {
        case 'sharedInventory': {
          for (const r of shape.resources) {
            const amount = state.inventory[r as ResourceId] ?? 0;
            const prev = sharedInventory.get(r as ResourceId) ?? 0;
            sharedInventory.set(r as ResourceId, prev + amount);
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
  };
}
