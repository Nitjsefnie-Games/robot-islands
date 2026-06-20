import { describe, expect, it } from 'vitest';
import { discoverySignature } from './discovery-signature.js';
import type { IslandSpec, WorldState } from './world.js';
import type { PlacedBuilding } from './buildings.js';

function makeSpec(over: Partial<IslandSpec> = {}): IslandSpec {
  return {
    id: 'island1',
    name: 'island1',
    biome: 'plains',
    cx: 0,
    cy: 0,
    majorRadius: 5,
    minorRadius: 5,
    populated: true,
    discovered: true,
    buildings: [],
    modifiers: [],
    ...over,
  };
}

function makeBuilding(over: Partial<PlacedBuilding> & { id: string; defId: PlacedBuilding['defId'] }): PlacedBuilding {
  return { x: 0, y: 0, ...over };
}

function makeWorld(over: Partial<WorldState> & { islands: IslandSpec[] }): WorldState {
  return {
    seed: 'test',
    drones: [],
    routes: [],
    vehicles: [],
    revealedCells: new Set(),
    islandStates: new Map(),
    satellites: [],
    repairDrones: [],
    debrisFields: [],
    tutorialState: { completed: [], current: null },
    latticeActive: false,
    latticeNodeIslands: [],
    activeBonusMs: 0,
    commPackets: [],
    oceanCells: new Set(),
    depthRevealedCells: new Set(),
    totalCo2Kg: 0,
    generatedCells: new Set(),
    recentBuildAttempts: new Set(),
    recentBuildAttemptTs: new Map(),
    ...over,
  } as unknown as WorldState;
}

describe('discoverySignature', () => {
  it('is stable when only non-visual building fields change', () => {
    const base = makeBuilding({ id: 'b1', defId: 'workshop', x: 1, y: 2 });
    const spec = makeSpec({ buildings: [base] });
    const world = makeWorld({ islands: [spec] });
    const sig1 = discoverySignature(world);

    const withIgnoreCap = makeSpec({ buildings: [makeBuilding({ id: 'b1', defId: 'workshop', x: 1, y: 2, ignoreCapOverrides: { gear: true } })] });
    expect(discoverySignature(makeWorld({ islands: [withIgnoreCap] }))).toBe(sig1);

    const withPaused = makeSpec({ buildings: [makeBuilding({ id: 'b1', defId: 'workshop', x: 1, y: 2, paused: 'anchor-depopulated' })] });
    expect(discoverySignature(makeWorld({ islands: [withPaused] }))).toBe(sig1);

    const withLabel = makeSpec({ buildings: [makeBuilding({ id: 'b1', defId: 'workshop', x: 1, y: 2, cargoLabel: 'iron_ore' })] });
    expect(discoverySignature(makeWorld({ islands: [withLabel] }))).toBe(sig1);

    const withAnchor = makeSpec({ buildings: [makeBuilding({ id: 'b1', defId: 'workshop', x: 1, y: 2, anchorIslandId: 'other' })] });
    expect(discoverySignature(makeWorld({ islands: [withAnchor] }))).toBe(sig1);

    const withConstruction = makeSpec({ buildings: [makeBuilding({ id: 'b1', defId: 'workshop', x: 1, y: 2, constructionRemainingMs: 5000 })] });
    expect(discoverySignature(makeWorld({ islands: [withConstruction] }))).toBe(sig1);
  });

  it('changes when a building moves', () => {
    const spec1 = makeSpec({ buildings: [makeBuilding({ id: 'b1', defId: 'workshop', x: 1, y: 2 })] });
    const world1 = makeWorld({ islands: [spec1] });
    const sig1 = discoverySignature(world1);

    const spec2 = makeSpec({ buildings: [makeBuilding({ id: 'b1', defId: 'workshop', x: 3, y: 2 })] });
    const sig2 = discoverySignature(makeWorld({ islands: [spec2] }));
    expect(sig2).not.toBe(sig1);

    const spec3 = makeSpec({ buildings: [makeBuilding({ id: 'b1', defId: 'workshop', x: 3, y: 4 })] });
    expect(discoverySignature(makeWorld({ islands: [spec3] }))).not.toBe(sig2);
  });

  it('changes when a building rotates or changes defId', () => {
    const spec1 = makeSpec({ buildings: [makeBuilding({ id: 'b1', defId: 'workshop', x: 1, y: 2 })] });
    const world1 = makeWorld({ islands: [spec1] });
    const sig1 = discoverySignature(world1);

    const spec2 = makeSpec({ buildings: [makeBuilding({ id: 'b1', defId: 'workshop', x: 1, y: 2, rotation: 1 })] });
    const sig2 = discoverySignature(makeWorld({ islands: [spec2] }));
    expect(sig2).not.toBe(sig1);

    const spec3 = makeSpec({ buildings: [makeBuilding({ id: 'b1', defId: 'logger', x: 1, y: 2 })] });
    expect(discoverySignature(makeWorld({ islands: [spec3] }))).not.toBe(sig2);
  });

  it('changes when an island expands', () => {
    const spec1 = makeSpec();
    const world1 = makeWorld({ islands: [spec1] });
    const sig1 = discoverySignature(world1);

    const spec2 = makeSpec({ majorRadius: 6 });
    const sig2 = discoverySignature(makeWorld({ islands: [spec2] }));
    expect(sig2).not.toBe(sig1);

    const spec3 = makeSpec({ majorRadius: 6, minorRadius: 6 });
    expect(discoverySignature(makeWorld({ islands: [spec3] }))).not.toBe(sig2);
  });

  it('changes when extraEllipses change', () => {
    const spec1 = makeSpec();
    const world1 = makeWorld({ islands: [spec1] });
    const sig1 = discoverySignature(world1);

    const spec2 = makeSpec({ extraEllipses: [{ major: 4, minor: 4, rotation: 0, offsetX: 10, offsetY: 0 }] });
    expect(discoverySignature(makeWorld({ islands: [spec2] }))).not.toBe(sig1);
  });

  it('changes when tileOverrides change', () => {
    const spec1 = makeSpec();
    const world1 = makeWorld({ islands: [spec1] });
    const sig1 = discoverySignature(world1);

    const spec2 = makeSpec({ tileOverrides: { '1,2': 'water' } });
    expect(discoverySignature(makeWorld({ islands: [spec2] }))).not.toBe(sig1);
  });

  it('changes when island discovery/populated/modifiers change', () => {
    const spec1 = makeSpec();
    const world1 = makeWorld({ islands: [spec1] });
    const sig1 = discoverySignature(world1);

    const spec2 = makeSpec({ discovered: false });
    const sig2 = discoverySignature(makeWorld({ islands: [spec2] }));
    expect(sig2).not.toBe(sig1);

    const spec3 = makeSpec({ discovered: false, populated: false });
    const sig3 = discoverySignature(makeWorld({ islands: [spec3] }));
    expect(sig3).not.toBe(sig2);

    const spec4 = makeSpec({ populated: false, modifiers: ['fertile'] });
    expect(discoverySignature(makeWorld({ islands: [spec4] }))).not.toBe(sig3);
  });

  it('changes when revealedCells change', () => {
    const spec = makeSpec();
    const revealedCells = new Set<string>();
    const world1 = makeWorld({ islands: [spec], revealedCells });
    const sig1 = discoverySignature(world1);

    revealedCells.add('0,0');
    expect(discoverySignature(world1)).not.toBe(sig1);
  });

  it('changes when only depthRevealedCells change (#78, #83)', () => {
    const spec = makeSpec();
    const revealedCells = new Set<string>(['0,0']);
    const depthRevealedCells = new Set<string>();
    const world1 = makeWorld({ islands: [spec], revealedCells, depthRevealedCells });
    const sig1 = discoverySignature(world1);

    depthRevealedCells.add('0,0');
    expect(discoverySignature(world1)).not.toBe(sig1);

    // Surface reveal count unchanged; depth reveal count is the only delta.
    const sig2 = discoverySignature(world1);
    revealedCells.add('1,1');
    expect(discoverySignature(world1)).not.toBe(sig2);
  });
});
