// §13.4 Endgame goals — achievement ledger only.
//
// SPEC §13.4 is explicit: no win screen/banner/popup fires on artifact
// completion, so EndgameState is just the live achievement ledger callers
// inspect, with no detection helper of its own.
//
// Pure layer — no PixiJS, no DOM. Leaf consumer of world/economy types.

export type VictoryCondition =
  | 'genesis_cell_crafted'
  | 'omniscient_lattice_active'
  | 'ascendant_core_crafted';

export interface EndgameState {
  /** Conditions achieved so far. */
  achieved: Set<VictoryCondition>;
  /** Timestamp of first achievement (for save-display). */
  firstAchievedMs: number | null;
}

export function makeInitialEndgameState(): EndgameState {
  return {
    achieved: new Set(),
    firstAchievedMs: null,
  };
}
