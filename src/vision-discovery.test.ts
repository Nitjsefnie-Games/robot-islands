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
  return { islands } as unknown as WorldState;
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

  it('does not re-report an already-discovered island in vision', () => {
    const home = isl({ id: 'home', populated: true, discovered: true });
    const known = isl({ id: 'known', cx: 12, cy: 0, discovered: true });
    const w = makeWorld([home, known]);
    expect(discoverIslandsInVision(w)).toEqual([]);
  });
});
