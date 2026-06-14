// src/new-game.ts
import type { IslandState } from './economy.js';
import { makeInitialIslandState, makeInitialWorld, type WorldState } from './world.js';

/**
 * Build a fresh game (world + per-island state) — the pure new-game path.
 * Extracted from main.ts so the client and the authoritative server construct
 * an initial game identically. §3.7 starter contract: home + new colonies
 * start with EMPTY inventory (makeInitialIslandState provides that).
 */
export function createNewGame(
  nowMs: number,
): { world: WorldState; islandStates: Map<string, IslandState> } {
  const world = makeInitialWorld(nowMs);
  const homeSpec = world.islands.find((s) => s.id === 'home');
  if (!homeSpec) throw new Error('createNewGame: home island missing from world');
  const islandStates = new Map<string, IslandState>();
  islandStates.set('home', makeInitialIslandState(homeSpec, nowMs));
  for (const spec of world.islands) {
    if (spec.id === 'home') continue;
    if (!spec.populated) continue;
    islandStates.set(spec.id, makeInitialIslandState(spec, nowMs));
  }
  world.islandStates = islandStates;
  return { world, islandStates };
}
