import { describe, it, expect } from 'vitest';
import { createNewGame } from './new-game.js';

describe('createNewGame', () => {
  it('builds a world with a home island state', () => {
    const { world, islandStates } = createNewGame(1000);
    expect(world.islands.find((s) => s.id === 'home')).toBeDefined();
    expect(islandStates.get('home')).toBeDefined();
  });
  it('creates state for every populated island and none for unpopulated', () => {
    const { world, islandStates } = createNewGame(1000);
    for (const spec of world.islands) {
      if (spec.populated) expect(islandStates.get(spec.id), spec.id).toBeDefined();
      else expect(islandStates.get(spec.id), spec.id).toBeUndefined();
    }
  });
  it('wires world.islandStates to the returned map', () => {
    const { world, islandStates } = createNewGame(1000);
    expect(world.islandStates).toBe(islandStates);
  });
});
