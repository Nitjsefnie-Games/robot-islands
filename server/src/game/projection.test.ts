// server/src/game/projection.test.ts
import { describe, it, expect } from 'vitest';
import { createNewGame } from '../../../src/new-game.js';
import { projectGame } from './projection.js';

describe('projectGame', () => {
  it('summarizes every populated island', () => {
    const { world, islandStates } = createNewGame(1000);
    const proj = projectGame({ world, islandStates });
    expect(proj.islands.length).toBe(islandStates.size);
    const home = proj.islands.find((i) => i.id === 'home');
    expect(home).toBeDefined();
    expect(typeof home!.level).toBe('number');
    expect(typeof home!.xp).toBe('number');
  });
});
