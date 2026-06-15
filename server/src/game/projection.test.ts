// server/src/game/projection.test.ts
import { describe, it, expect } from 'vitest';
import { createNewGame } from '../../../src/new-game.js';
import { makeInitialIslandState } from '../../../src/world.js';
import { serializeWorld } from '../../../src/persistence.js';
import type { SaveSnapshot } from '../../../src/persistence.js';
import type { OceanCellSpec } from '../../../src/ocean-cell.js';
import { RARE_TERRAINS } from '../../../src/ocean-cell.js';
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

  describe('fog-sensitive cell collections', () => {
    function makeCellSnapshot(): SaveSnapshot {
      const snap = makeSnapshot();
      // Cells around an undiscovered island that are NOT surface-revealed must
      // be redacted. A separate surface-revealed non-feature cell is kept, and
      // a surface-revealed rare feature without depth-revelation is redacted.
      const unrevealedDeep = '7,7';
      const unrevealedShallow = '7,8';
      const unrevealedFeature = '7,9';
      const revealedShallow = '8,8';
      const revealedFeature = '8,9';
      const depthRevealedFeature = '9,9';
      const oceanCells: Array<[string, OceanCellSpec]> = [
        [unrevealedDeep, { terrain: 'deep' }],
        [unrevealedShallow, { terrain: 'shallows' }],
        [unrevealedFeature, { terrain: 'hydrothermal_vent' }],
        [revealedShallow, { terrain: 'shallows' }],
        [revealedFeature, { terrain: 'nodule_field' }],
        [depthRevealedFeature, { terrain: 'trench' }],
      ];
      const revealedCells = [revealedShallow, revealedFeature, depthRevealedFeature];
      const depthRevealedCells = [depthRevealedFeature];
      return {
        ...snap,
        world: {
          ...snap.world,
          oceanCells: [...(snap.world.oceanCells ?? []), ...oceanCells].sort((a, b) =>
            a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0,
          ),
          revealedCells: [...(snap.world.revealedCells ?? []), ...revealedCells].sort(),
          depthRevealedCells: [...(snap.world.depthRevealedCells ?? []), ...depthRevealedCells].sort(),
          generatedCells: [...(snap.world.generatedCells ?? []), '99,99'].sort(),
        },
      };
    }

    it('drops oceanCells around an undiscovered island', () => {
      const input = makeCellSnapshot();
      const output = projectSnapshotForClient(input);
      const keptKeys = output.world.oceanCells?.map(([k]) => k) ?? [];
      expect(keptKeys).not.toContain('7,7');
      expect(keptKeys).not.toContain('7,8');
      expect(keptKeys).not.toContain('7,9');
    });

    it('keeps a surface-revealed non-feature oceanCell', () => {
      const input = makeCellSnapshot();
      const output = projectSnapshotForClient(input);
      const keptKeys = output.world.oceanCells?.map(([k]) => k) ?? [];
      expect(keptKeys).toContain('8,8');
      const cell = output.world.oceanCells?.find(([k]) => k === '8,8');
      expect(cell?.[1].terrain).toBe('shallows');
    });

    it('drops a rare-feature cell that is revealed but not depth-revealed', () => {
      const input = makeCellSnapshot();
      expect(input.world.revealedCells).toContain('8,9');
      expect(input.world.depthRevealedCells).not.toContain('8,9');
      const output = projectSnapshotForClient(input);
      const kept = output.world.oceanCells?.find(([k]) => k === '8,9');
      expect(kept).toBeUndefined();
    });

    it('keeps a depth-revealed rare-feature cell', () => {
      const input = makeCellSnapshot();
      const output = projectSnapshotForClient(input);
      const cell = output.world.oceanCells?.find(([k]) => k === '9,9');
      expect(cell).toBeDefined();
      expect(cell![1].terrain).toBe('trench');
    });

    it('redacts generatedCells from the wire payload', () => {
      const input = makeCellSnapshot();
      expect(input.world.generatedCells?.length).toBeGreaterThan(0);
      const output = projectSnapshotForClient(input);
      expect(output.world.generatedCells).toBeUndefined();
    });

    it('does not mutate input cell collections', () => {
      const input = makeCellSnapshot();
      const beforeOcean = input.world.oceanCells?.map(([k, c]) => [k, c.terrain] as const);
      const beforeGenerated = input.world.generatedCells;
      projectSnapshotForClient(input);
      expect(input.world.oceanCells?.map(([k, c]) => [k, c.terrain] as const)).toEqual(beforeOcean);
      expect(input.world.generatedCells).toEqual(beforeGenerated);
    });
  });

  describe('feature terrain coverage', () => {
    it('covers every rare terrain defined by RARE_TERRAINS', () => {
      for (const terrain of RARE_TERRAINS) {
        const snap = makeSnapshot();
        const key = '42,42';
        const input: SaveSnapshot = {
          ...snap,
          world: {
            ...snap.world,
            oceanCells: [[key, { terrain }]],
            revealedCells: [key],
            depthRevealedCells: [],
          },
        };
        const output = projectSnapshotForClient(input);
        expect(output.world.oceanCells?.some(([k]) => k === key)).toBe(false);
      }
    });
  });
});
