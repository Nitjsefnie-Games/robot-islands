// Structural effect dispatch — catch-all for skill-unlocked engine rewrites.
//
// Each `structural` node carries a `StructuralEffectData` payload. Callers
// query via `hasStructuralEffect(kind, state, graph)` to gate behaviour.

import type { IslandState } from './economy.js';
import type { Graph } from './skilltree-graph.js';
import { DEFAULT_GRAPH, type StructuralEffectData } from './skilltree.js';

export function hasStructuralEffect(
  kind: StructuralEffectData['kind'],
  state: IslandState,
  graph: Graph = DEFAULT_GRAPH,
): boolean {
  for (const nodeId of state.unlockedNodes) {
    const node = graph.nodes.find((n) => n.id === nodeId);
    if (node?.effect.kind === 'structural' && node.effect.data.kind === kind) return true;
  }
  return false;
}
