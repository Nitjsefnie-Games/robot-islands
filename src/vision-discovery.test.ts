// §2.2 — vision discovers islands. Pure-layer tests for the sweep that flips
// `discovered` on any undiscovered island a vision source overlaps. No PixiJS,
// no DOM; constructs bare IslandSpec/WorldState fixtures.

import { describe, expect, it } from 'vitest';

import { discoverIslandsInVision } from './vision-discovery.js';
import type { PlacedBuilding } from './buildings.js';
import type { IslandSpec, WorldState } from './world.js';

function isl(over: Partial<IslandSpec>): IslandSpec {
  return {
    id: 'i',
    name: 'i',
    biome: 'plains',
    cx: 0,
    cy: 0,
    majorRadius: 5,
    minorRadius: 5,
    populated: false,
    discovered: false,
    buildings: [],
    modifiers: [],
    ...over,
  } as IslandSpec;
}

function makeWorld(islands: IslandSpec[]): WorldState {
  return { islands, revealedCells: new Set<string>() } as unknown as WorldState;
}

describe('discoverIslandsInVision (§2.2 vision discovers islands)', () => {
  it("discovers an undiscovered island overlapping a populated island's vision halo", () => {
    const home = isl({ id: 'home', populated: true, discovered: true });
    // Within home's halo: island ellipse r5 + VISION_PADDING_TILES (10) = 15.
    const near = isl({ id: 'near', cx: 12, cy: 0 });
    const w = makeWorld([home, near]);
    const newly = discoverIslandsInVision(w);
    expect(newly).toContain('near');
    expect(near.discovered).toBe(true);
  });

  it('leaves an island outside every vision source undiscovered', () => {
    const home = isl({ id: 'home', populated: true, discovered: true });
    const far = isl({ id: 'far', cx: 200, cy: 0 });
    const w = makeWorld([home, far]);
    const newly = discoverIslandsInVision(w);
    expect(newly).not.toContain('far');
    expect(far.discovered).toBe(false);
  });

  it('discovers an island inside a Lighthouse circle far beyond the island halo', () => {
    const lighthouse = {
      id: 'lh', defId: 'lighthouse_t6', x: 0, y: 0, rotation: 0,
    } as unknown as PlacedBuilding;
    const home = isl({ id: 'home', populated: true, discovered: true, buildings: [lighthouse] });
    // Beyond the r15 halo but well inside the t6 Lighthouse circle (r300).
    const distant = isl({ id: 'distant', cx: 100, cy: 0 });
    const w = makeWorld([home, distant]);
    const newly = discoverIslandsInVision(w);
    expect(newly).toContain('distant');
    expect(distant.discovered).toBe(true);
  });

  it('is monotonic + idempotent: a second sweep discovers nothing new', () => {
    const home = isl({ id: 'home', populated: true, discovered: true });
    const near = isl({ id: 'near', cx: 12, cy: 0 });
    const w = makeWorld([home, near]);
    expect(discoverIslandsInVision(w)).toContain('near');
    expect(discoverIslandsInVision(w)).toEqual([]);
  });

  it('reveals the FULL island footprint on discovery, including cells outside the vision source', () => {
    // home's halo (ellipse r5 + pad 10 = 15) reaches x=15. A large target
    // straddles that edge: its western cells fall inside the halo (→ found),
    // its eastern cells (cell 1,0 = tiles x16..31) fall OUTSIDE the halo.
    // Discovery is whole-island, so every cell must be revealed — otherwise
    // the eastern half renders as fog (steel-blue) until reload.
    const home = isl({ id: 'home', populated: true, discovered: true });
    const straddle = isl({ id: 'straddle', cx: 14, cy: 0, majorRadius: 10, minorRadius: 10 });
    const w = makeWorld([home, straddle]);
    const newly = discoverIslandsInVision(w);
    expect(newly).toContain('straddle');
    // Cell (1,0) is part of the island but outside the home halo's vision.
    expect(w.revealedCells.has('1,0')).toBe(true);
  });

  it('does not re-report an already-discovered island in vision', () => {
    const home = isl({ id: 'home', populated: true, discovered: true });
    const known = isl({ id: 'known', cx: 12, cy: 0, discovered: true });
    const w = makeWorld([home, known]);
    expect(discoverIslandsInVision(w)).toEqual([]);
  });
});
