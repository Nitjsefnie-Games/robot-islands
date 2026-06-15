// server/src/game/projection.ts
import type { SaveSnapshot } from '../../../src/persistence.js';
import type { LiveGame } from './runtime.js';

export interface IslandProjection {
  readonly id: string;
  readonly level: number;
  readonly xp: number;
  readonly inventory: Readonly<Record<string, number>>;
}
export interface GameProjection { readonly islands: ReadonlyArray<IslandProjection>; }

export function projectGame(game: LiveGame): GameProjection {
  const islands: IslandProjection[] = [];
  for (const [id, state] of game.islandStates) {
    islands.push({ id, level: state.level, xp: state.xp, inventory: { ...state.inventory } });
  }
  return { islands };
}

/** Rare-feature terrains that leak strategic position even when a cell is
 *  surface-revealed. They require depth-revelation before the client may see
 *  the terrain kind (the client still renders them as implicit 'deep' when
 *  redacted, which is correct for unrevealed seabed). Kept in sync with
 *  `src/ocean-cell.ts`. */
const FEATURE_TERRAINS = new Set(['hydrothermal_vent', 'nodule_field', 'trench']);

/** Fog projection: the server runs the full authoritative world (including every
 *  undiscovered island) for catch-up, but the wire payload sent to the client
 *  must redact islands the player has not discovered and has not populated.
 *  Discovery is whole-island: an island is kept if `discovered === true` or
 *  `populated === true`. Populated implies discovered, but both predicates are
 *  checked defensively.
 *
 *  Additionally, fog-sensitive cell collections are trimmed:
 *   - `oceanCells` only keeps entries whose key is in `revealedCells`; rare-
 *     feature cells additionally require `depthRevealedCells`.
 *   - `generatedCells` is omitted entirely (it is only used for persistence /
 *     load-time reconstruction, not for remote runtime rendering).
 *
 *  Returns a NEW snapshot; the input is not mutated. */
export function projectSnapshotForClient(snapshot: SaveSnapshot): SaveSnapshot {
  const revealed = new Set(snapshot.world.revealedCells ?? []);
  const depth = new Set(snapshot.world.depthRevealedCells ?? []);
  const oceanCells = (snapshot.world.oceanCells ?? []).filter(([key, cell]) => {
    if (!revealed.has(key)) return false;
    if (FEATURE_TERRAINS.has(cell.terrain) && !depth.has(key)) return false;
    return true;
  });
  return {
    ...snapshot,
    world: {
      ...snapshot.world,
      islands: snapshot.world.islands.filter((i) => i.discovered === true || i.populated === true),
      oceanCells,
      generatedCells: undefined,
    },
  };
}
