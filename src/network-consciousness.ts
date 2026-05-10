// Network Consciousness milestone per SPEC §9.6. Pure logic — no PixiJS,
// no DOM. Counts the player's T3+ islands and resolves the active milestone
// into a global production buff applied per frame in `main.ts`.
//
// Step-10 simplification: §9.6 defines the buff target set as "networked T3+
// islands" — islands route-graph-connected back to home (see §2.4). Step 10
// drops the "networked" qualifier and treats every populated island at T3+
// as participating. The route graph exists (`routes.ts`) but threading the
// reachability check here would dilute the focus of the step; the relaxation
// is documented and flagged for re-tightening once the route system carries
// the connectedness flag natively. Same approach as the §10.1 funnel
// provenance FIXME in `economy.ts`.
//
// FIXME(§9.6): "Networked" is currently simplified to "populated at T3+",
// which over-rewards: an isolated T3 colony with no inbound route still
// receives the global NC buff. Spec requires route-graph reachability to
// home. Lands in step 11 (settlement vehicles) — until then this is
// player-observable behavioral debt, not an internal-only simplification.
//
// Thresholds and buff magnitudes are per §9.6:
//   ≥3 T3+ islands  → milestone 1 / +5%
//   ≥5             → milestone 2 / +10%
//   ≥10            → milestone 3 / +25%
//   ≥20            → milestone 4 / Network Consciousness (still +25%; the
//                    "Omniscient Lattice unlock" downstream effect arrives
//                    with the T5 endgame artifact, not implemented yet).
//
// The buff itself is a single number returned alongside the milestone — the
// caller in `main.ts` decides whether to apply it to a given island (the
// design memo restricts application to T3+ islands, computed per-frame using
// `tierForLevel(state.level) >= 3`).

import type { IslandState } from './economy.js';
import { tierForLevel } from './skilltree.js';

/** Active milestone level. 0 = below all thresholds. */
export type NcMilestone = 0 | 1 | 2 | 3 | 4;

export interface NetworkConsciousnessState {
  /** Number of populated islands at level ≥ 15 (T3+). */
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
 * Aggregate per-island state into the network-consciousness summary.
 *
 * Pure: no mutation, no DOM, no rendering. Iterates the supplied island map
 * once and reads `state.level` to gate the T3+ count. The caller passes
 * `islandStates` exactly as it is held in `main.ts`; the function does not
 * need (and does not consume) `IslandSpec`.
 */
export function computeNcState(
  islandStates: ReadonlyMap<string, IslandState>,
): NetworkConsciousnessState {
  let tier3PlusCount = 0;
  for (const state of islandStates.values()) {
    if (tierForLevel(state.level) >= 3) tier3PlusCount += 1;
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
