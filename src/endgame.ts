// §13.4 Endgame goals — achievement ledger only.
//
// SPEC §13.4 is explicit: no win screen, no banner, no popup, no
// acknowledgement fires when artifacts complete. EndgameState therefore
// shrinks to the live achievement ledger (`achieved` + `firstAchievedMs`)
// that callers can inspect, with no detection helper of its own.
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
