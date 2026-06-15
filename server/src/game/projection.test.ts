// server/src/game/projection.test.ts
import { describe, it, expect } from 'vitest';
import { createNewGame } from '../../../src/new-game.js';
import { makeInitialIslandState } from '../../../src/world.js';
import { serializeWorld } from '../../../src/persistence.js';
import type { SaveSnapshot } from '../../../src/persistence.js';
import { projectGame, projectSnapshotForClient } from './projection.js';

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

describe('projectSnapshotForClient', () => {
  function makeSnapshot(): SaveSnapshot {
    const now = 1000;
    const { world, islandStates } = createNewGame(now);
    // Ensure we have islands in all three visibility categories.
    const home = world.islands.find((s) => s.id === 'home')!;
    home.discovered = true;
    home.populated = true;

    const discoveredOnly = world.islands.find((s) => s.id !== 'home' && !s.populated)!;
    discoveredOnly.discovered = true;

    const undiscovered = world.islands.find((s) => s.id !== 'home' && s.id !== discoveredOnly.id && !s.populated)!;
    undiscovered.discovered = false;
    undiscovered.populated = false;

    // The populated island must have a runtime state for serializeWorld.
    if (!islandStates.has(home.id)) {
      islandStates.set(home.id, makeInitialIslandState(home, now));
    }

    return serializeWorld(world, islandStates, now, now);
  }

  it('keeps discovered islands', () => {
    const input = makeSnapshot();
    const beforeIds = input.world.islands.map((i) => i.id);
    const output = projectSnapshotForClient(input);
    const keptIds = output.world.islands.map((i) => i.id);
    const discoveredId = input.world.islands.find((i) => i.discovered && !i.populated)!.id;
    expect(keptIds).toContain(discoveredId);
    expect(beforeIds).toContain(discoveredId);
  });

  it('keeps populated islands', () => {
    const input = makeSnapshot();
    const output = projectSnapshotForClient(input);
    const keptIds = output.world.islands.map((i) => i.id);
    const populatedId = input.world.islands.find((i) => i.populated)!.id;
    expect(keptIds).toContain(populatedId);
  });

  it('omits undiscovered + unpopulated islands', () => {
    const input = makeSnapshot();
    const undiscoveredId = input.world.islands.find((i) => !i.discovered && !i.populated)!.id;
    const output = projectSnapshotForClient(input);
    const keptIds = output.world.islands.map((i) => i.id);
    expect(keptIds).not.toContain(undiscoveredId);
  });

  it('does not mutate the input snapshot', () => {
    const input = makeSnapshot();
    const beforeIds = input.world.islands.map((i) => i.id);
    const beforeLength = input.world.islands.length;
    projectSnapshotForClient(input);
    expect(input.world.islands.length).toBe(beforeLength);
    expect(input.world.islands.map((i) => i.id)).toEqual(beforeIds);
  });

  it('copies other top-level fields verbatim', () => {
    const input = makeSnapshot();
    const output = projectSnapshotForClient(input);
    expect(output.v).toBe(input.v);
    expect(output.savedAt).toBe(input.savedAt);
    expect(output.savedAtPerf).toBe(input.savedAtPerf);
    expect(output.islandStates).toBe(input.islandStates);
    expect(output.world.drones).toBe(input.world.drones);
    expect(output.world.routes).toBe(input.world.routes);
  });
});
