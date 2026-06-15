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

/** Fog projection: the server runs the full authoritative world (including every
 *  undiscovered island) for catch-up, but the wire payload sent to the client
 *  must redact islands the player has not discovered and has not populated.
 *  Discovery is whole-island: an island is kept if `discovered === true` or
 *  `populated === true`. Populated implies discovered, but both predicates are
 *  checked defensively.
 *
 *  Returns a NEW snapshot; the input is not mutated. */
export function projectSnapshotForClient(snapshot: SaveSnapshot): SaveSnapshot {
  return {
    ...snapshot,
    world: {
      ...snapshot.world,
      islands: snapshot.world.islands.filter((i) => i.discovered === true || i.populated === true),
    },
  };
}
