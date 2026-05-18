// Network Consciousness milestone per SPEC §9.6. Pure logic — no PixiJS,
// no DOM. Counts the player's networked T3+ islands and resolves the active
// milestone into a global production buff applied per frame in `main.ts`.
//
// "Networked" means route-graph-reachable from home (§2.4). The BFS walks
// undirected edges: a route A→B makes B reachable from A and vice-versa.
// Only populated islands that are both T3+ and in the networked set count
// toward the milestone thresholds.
//
// Thresholds and buff magnitudes are per §9.6:
//   ≥3 T3+ islands  → milestone 1 / +5%
//   ≥5             → milestone 2 / +10%
//   ≥10            → milestone 3 / +25%
//   ≥20            → milestone 4 / Network Consciousness (still +25%; the
//                    "Omniscient Lattice unlock" downstream effect is live
//                    via `lattice.ts` — see `latticeActive` in world state).
//
// The buff itself is a single number returned alongside the milestone — the
// caller in `main.ts` decides whether to apply it to a given island (the
// design memo restricts application to T3+ islands, computed per-frame using
// `tierForLevel(state.level) >= 3`).

import { tierForLevel } from './skilltree.js';
import type { WorldState } from './world.js';

/** Active milestone level. 0 = below all thresholds. */
export type NcMilestone = 0 | 1 | 2 | 3 | 4;

export interface NetworkConsciousnessState {
  /** Number of populated, networked islands at level ≥ 15 (T3+). */
  readonly tier3PlusCount: number;
  /** Active milestone derived from `tier3PlusCount`. */
  readonly milestone: NcMilestone;
  /** Global production buff (multiplier ≥ 1) the active milestone confers.
   *  Step-10 spec values: 1 / 1.05 / 1.10 / 1.25 / 1.25. */
  readonly globalProductionBuff: number;
}

interface MilestoneRow {
  readonly threshold: number;
  readonly milestone: NcMilestone;
  readonly buff: number;
}

// Ordered HIGH-to-LOW so the first match in `computeNcState` resolves to
// the active milestone without needing to keep state across iterations.
const MILESTONE_TABLE: ReadonlyArray<MilestoneRow> = [
  { threshold: 20, milestone: 4, buff: 1.25 },
  { threshold: 10, milestone: 3, buff: 1.25 },
  { threshold: 5,  milestone: 2, buff: 1.10 },
  { threshold: 3,  milestone: 1, buff: 1.05 },
];

/**
 * BFS over the route graph starting from the (first) populated island
 * treated as home. Returns the set of island ids that are reachable.
 *
 * The graph is treated as undirected for connectivity: a route A→B
 * connects both ends.
 */
export function networkedIslandIds(world: WorldState): Set<string> {
  const home = world.islands.find(i => i.id === 'home' && i.populated);
  if (!home) return new Set();

  // Pre-build undirected adjacency list for O(1) neighbour lookup.
  const adj = new Map<string, string[]>();
  for (const r of world.routes) {
    if (!adj.has(r.from)) adj.set(r.from, []);
    if (!adj.has(r.to))   adj.set(r.to, []);
    adj.get(r.from)!.push(r.to);
    adj.get(r.to)!.push(r.from);
  }

  const visited = new Set<string>();
  const queue = [home.id];
  visited.add(home.id);

  let head = 0;
  while (head < queue.length) {
    const current = queue[head]!;
    head++;
    const neighbors = adj.get(current) ?? [];
    for (const next of neighbors) {
      if (!visited.has(next)) {
        visited.add(next);
        queue.push(next);
      }
    }
  }

  return visited;
}

/**
 * Aggregate world state into the network-consciousness summary.
 *
 * Pure: no mutation, no DOM, no rendering. Computes the route-graph-reachable
 * set from home, then counts populated islands in that set whose level is T3+.
 */
export function computeNcState(world: WorldState): NetworkConsciousnessState {
  const islandStates = world.islandStates;
  if (!islandStates) {
    throw new Error('computeNcState: world.islandStates is missing');
  }
  const networked = networkedIslandIds(world);
  let tier3PlusCount = 0;
  for (const island of world.islands) {
    if (!island.populated) continue;
    if (!networked.has(island.id)) continue;
    const state = islandStates.get(island.id);
    if (state && tierForLevel(state.level) >= 3) {
      tier3PlusCount += 1;
    }
  }
  for (const row of MILESTONE_TABLE) {
    if (tier3PlusCount >= row.threshold) {
      return {
        tier3PlusCount,
        milestone: row.milestone,
        globalProductionBuff: row.buff,
      };
    }
  }
  return {
    tier3PlusCount,
    milestone: 0,
    globalProductionBuff: 1,
  };
}
