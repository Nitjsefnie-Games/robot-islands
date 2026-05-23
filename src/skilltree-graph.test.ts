import { describe, it, expect } from 'vitest';
import type { Edge, BridgeEdge, GraftSocket, Graph, NodeId, EdgeId } from './skilltree-graph.js';

describe('skilltree-graph types', () => {
  it('composes a minimal Graph fixture', () => {
    const e1: Edge = { id: 'e1' as EdgeId, from: 'root.extraction' as NodeId, to: 'mining.1' as NodeId, cost: 1 };
    const bridge: BridgeEdge = {
      id: 'b1' as EdgeId,
      from: 'mining.4' as NodeId,
      to: 'forestry.4' as NodeId,
      cost: 5,
      threshold: [{ branch: 'extraction', minSpent: 8 }],
    };
    const socket: GraftSocket = { id: 'gs1', branchId: 'orbital', subPathId: 'launch', attachmentDepth: 6 };
    const g: Graph = { nodes: [], edges: [e1], bridges: [bridge], graftSockets: [socket] };
    expect(g.edges).toHaveLength(1);
  });
});
