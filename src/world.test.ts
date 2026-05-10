// Island render-state classification: pure-logic tests for the three-state
// vision model (visible / discovered / unknown).

import { describe, expect, it } from 'vitest';

import {
  DEMO_ISLANDS,
  islandRenderState,
  VISION_RADIUS_TILES,
  type IslandSpec,
} from './world.js';

function makeSpec(over: Partial<IslandSpec>): IslandSpec {
  return {
    id: 'test',
    biome: 'plains',
    cx: 0,
    cy: 0,
    majorRadius: 5,
    minorRadius: 5,
    populated: false,
    discovered: false,
    buildings: [],
    ...over,
  };
}

describe('islandRenderState', () => {
  const sources = [{ cx: 0, cy: 0 }];

  it('classifies a populated island as visible (regardless of `discovered`)', () => {
    const s = makeSpec({ populated: true, discovered: false, cx: 200, cy: 200 });
    // Even far away from any source, populated implies visible — populated
    // islands ARE the vision sources, so they're trivially in vision of self.
    expect(islandRenderState(s, sources, VISION_RADIUS_TILES)).toBe('visible');
  });

  it('classifies a discovered island inside vision radius as visible', () => {
    // Place near origin source: distance 41 < 80.
    const s = makeSpec({ populated: false, discovered: true, cx: 40, cy: -10 });
    expect(islandRenderState(s, sources, VISION_RADIUS_TILES)).toBe('visible');
  });

  it('classifies a discovered island outside vision radius as discovered', () => {
    // Distance 100 > 80.
    const s = makeSpec({ populated: false, discovered: true, cx: 80, cy: 60 });
    expect(islandRenderState(s, sources, VISION_RADIUS_TILES)).toBe('discovered');
  });

  it('classifies an undiscovered island as unknown', () => {
    const s = makeSpec({ populated: false, discovered: false, cx: 40, cy: -10 });
    // Even though it's inside the vision radius, undiscovered short-circuits
    // to unknown — the player just doesn't know it's there.
    expect(islandRenderState(s, sources, VISION_RADIUS_TILES)).toBe('unknown');
  });

  it('handles zero vision sources sanely', () => {
    const s1 = makeSpec({ populated: true });
    const s2 = makeSpec({ populated: false, discovered: true });
    const s3 = makeSpec({ populated: false, discovered: false });
    expect(islandRenderState(s1, [], VISION_RADIUS_TILES)).toBe('visible');
    expect(islandRenderState(s2, [], VISION_RADIUS_TILES)).toBe('discovered');
    expect(islandRenderState(s3, [], VISION_RADIUS_TILES)).toBe('unknown');
  });

  it('treats radius as inclusive on the boundary', () => {
    // Place the island exactly at the boundary distance.
    const s = makeSpec({ populated: false, discovered: true, cx: VISION_RADIUS_TILES, cy: 0 });
    expect(islandRenderState(s, sources, VISION_RADIUS_TILES)).toBe('visible');
  });

  it('matches the demo layout: home visible, forest-ne visible, desert-far discovered, coast-unknown unknown', () => {
    const populatedCentres = DEMO_ISLANDS
      .filter((s) => s.populated)
      .map((s) => ({ cx: s.cx, cy: s.cy }));
    const byId = new Map(DEMO_ISLANDS.map((s) => [s.id, s] as const));
    const get = (id: string): IslandSpec => {
      const s = byId.get(id);
      if (!s) throw new Error(`demo missing ${id}`);
      return s;
    };
    expect(islandRenderState(get('home'), populatedCentres, VISION_RADIUS_TILES)).toBe('visible');
    expect(islandRenderState(get('forest-ne'), populatedCentres, VISION_RADIUS_TILES)).toBe('visible');
    expect(islandRenderState(get('desert-far'), populatedCentres, VISION_RADIUS_TILES)).toBe('discovered');
    expect(islandRenderState(get('coast-unknown'), populatedCentres, VISION_RADIUS_TILES)).toBe('unknown');
  });
});
