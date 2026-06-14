// server/src/game/projection.ts
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
