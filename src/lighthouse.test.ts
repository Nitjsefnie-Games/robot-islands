// Lighthouse vision: pure-logic tests for `computeVisionSources` and
// `pointInVision`. The vision model is a union of baseline padded ellipses
// (one per populated constituent) and Lighthouse circles (one per Lighthouse
// building, tier-dependent radius).

import { describe, expect, it } from 'vitest';

import {
  LIGHTHOUSE_VISION_RADII,
  computeVisionSources,
  pointInVision,
} from './lighthouse.js';
import type { IslandSpec } from './world.js';

function makeSpec(over: Partial<IslandSpec>): IslandSpec {
  return {
    id: 'test',
    name: 'test',
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

describe('LIGHTHOUSE_VISION_RADII', () => {
  it('declares the six tier-dependent radii in tiles', () => {
    expect(LIGHTHOUSE_VISION_RADII.lighthouse_t1).toBe(50);
    expect(LIGHTHOUSE_VISION_RADII.lighthouse_t2).toBe(80);
    expect(LIGHTHOUSE_VISION_RADII.lighthouse_t3).toBe(120);
    expect(LIGHTHOUSE_VISION_RADII.lighthouse_t4).toBe(160);
    expect(LIGHTHOUSE_VISION_RADII.lighthouse_t5).toBe(220);
    expect(LIGHTHOUSE_VISION_RADII.lighthouse_t6).toBe(300);
  });

  it('returns undefined for non-lighthouse defIds (gate for the walk)', () => {
    // Non-Lighthouse defs MUST be absent — `computeVisionSources` keys on
    // `LIGHTHOUSE_VISION_RADII[defId]` and a stray entry would emit a
    // bogus circle for, say, every Solar Panel.
    expect(LIGHTHOUSE_VISION_RADII.solar).toBeUndefined();
    expect(LIGHTHOUSE_VISION_RADII.workshop).toBeUndefined();
    expect(LIGHTHOUSE_VISION_RADII.dock).toBeUndefined();
  });
});

describe('computeVisionSources', () => {
  it('emits one baseline ellipse per populated single-ellipse island, no Lighthouses', () => {
    const home = makeSpec({
      id: 'home',
      cx: 0,
      cy: 0,
      majorRadius: 14,
      minorRadius: 14,
      buildings: [],
    });
    const sources = computeVisionSources([home]);
    expect(sources.length).toBe(1);
    const s = sources[0];
    expect(s?.kind).toBe('ellipse');
    if (s?.kind === 'ellipse') {
      expect(s.cx).toBe(0);
      expect(s.cy).toBe(0);
      // Baseline padding = 10 → (24, 24).
      expect(s.major).toBe(24);
      expect(s.minor).toBe(24);
      expect(s.offsetX).toBe(0);
      expect(s.offsetY).toBe(0);
    }
  });

  it('emits no sources when the populated list is empty', () => {
    expect(computeVisionSources([])).toEqual([]);
  });

  it('adds one circle source per Lighthouse on the island', () => {
    const home = makeSpec({
      id: 'home',
      cx: 0,
      cy: 0,
      majorRadius: 14,
      minorRadius: 14,
      buildings: [
        { id: 'lh-1', defId: 'lighthouse_t2', x: 0, y: 0 },
      ],
    });
    const sources = computeVisionSources([home]);
    expect(sources.length).toBe(2);
    expect(sources[0]?.kind).toBe('ellipse');
    const circle = sources[1];
    expect(circle?.kind).toBe('circle');
    if (circle?.kind === 'circle') {
      // Lighthouse footprint is 1×1, building at (0, 0) → centre at (0.5, 0.5).
      expect(circle.cx).toBe(0.5);
      expect(circle.cy).toBe(0.5);
      expect(circle.radius).toBe(80);
    }
  });

  it('emits one circle per Lighthouse when multiple are placed on the same island', () => {
    const home = makeSpec({
      id: 'home',
      cx: 0,
      cy: 0,
      majorRadius: 14,
      minorRadius: 14,
      buildings: [
        { id: 'lh-1', defId: 'lighthouse_t1', x: 5, y: 5 },
        { id: 'lh-2', defId: 'lighthouse_t3', x: -5, y: -5 },
        // Non-Lighthouse buildings must NOT emit a circle source.
        { id: 'solar-1', defId: 'solar', x: 2, y: 2 },
      ],
    });
    const sources = computeVisionSources([home]);
    // 1 baseline ellipse + 2 Lighthouse circles (solar is ignored).
    expect(sources.length).toBe(3);
    expect(sources.filter((s) => s.kind === 'circle').length).toBe(2);
    const radii = sources
      .filter((s) => s.kind === 'circle')
      .map((s) => (s.kind === 'circle' ? s.radius : 0))
      .sort((a, b) => a - b);
    expect(radii).toEqual([50, 120]);
  });

  it('honors per-island centres: Lighthouse on a non-origin island places its circle in world coords', () => {
    const forestNe = makeSpec({
      id: 'forest-ne',
      cx: 40,
      cy: -10,
      majorRadius: 10,
      minorRadius: 10,
      buildings: [
        { id: 'lh-1', defId: 'lighthouse_t1', x: 0, y: 0 },
      ],
    });
    const sources = computeVisionSources([forestNe]);
    const circle = sources.find((s) => s.kind === 'circle');
    expect(circle?.kind).toBe('circle');
    if (circle?.kind === 'circle') {
      // Building at (0, 0) on an island at (40, -10) → footprint centre at
      // (40 + 0 + 0.5, -10 + 0 + 0.5) = (40.5, -9.5).
      expect(circle.cx).toBe(40.5);
      expect(circle.cy).toBe(-9.5);
      expect(circle.radius).toBe(50);
    }
  });

  it('emits one baseline ellipse per constituent of a merged island', () => {
    const merged = makeSpec({
      id: 'merged',
      cx: 0,
      cy: 0,
      majorRadius: 8,
      minorRadius: 8,
      extraEllipses: [
        { major: 6, minor: 6, rotation: 0, offsetX: 20, offsetY: 0 },
      ],
      buildings: [],
    });
    const sources = computeVisionSources([merged]);
    expect(sources.length).toBe(2);
    // Each ellipse uses (major + 10, minor + 10).
    const primary = sources[0];
    const extra = sources[1];
    expect(primary?.kind).toBe('ellipse');
    expect(extra?.kind).toBe('ellipse');
    if (primary?.kind === 'ellipse') {
      expect(primary.major).toBe(18);
      expect(primary.minor).toBe(18);
      expect(primary.offsetX).toBe(0);
    }
    if (extra?.kind === 'ellipse') {
      expect(extra.major).toBe(16);
      expect(extra.minor).toBe(16);
      expect(extra.offsetX).toBe(20);
    }
  });

  it('places a Lighthouse on an absorbed constituent using the spec-local coordinate frame', () => {
    // Per §3.6, after a merge every building's (x, y) is in the absorber's
    // local frame — `performMerge` shifts coordinates at absorption time.
    // The Lighthouse position therefore reads off (spec.cx + b.x, spec.cy
    // + b.y), regardless of which constituent it physically lives on.
    const merged = makeSpec({
      id: 'merged',
      cx: 0,
      cy: 0,
      majorRadius: 8,
      minorRadius: 8,
      extraEllipses: [
        { major: 6, minor: 6, rotation: 0, offsetX: 20, offsetY: 0 },
      ],
      // Lighthouse coordinates have already been shifted into absorber-local
      // form: a Lighthouse "at the centre of the absorbed constituent" stores
      // (x, y) = (offsetX, offsetY) = (20, 0).
      buildings: [
        { id: 'lh-1', defId: 'lighthouse_t1', x: 20, y: 0 },
      ],
    });
    const sources = computeVisionSources([merged]);
    const circle = sources.find((s) => s.kind === 'circle');
    expect(circle?.kind).toBe('circle');
    if (circle?.kind === 'circle') {
      // (spec.cx + b.x + width/2, spec.cy + b.y + height/2) = (20.5, 0.5).
      expect(circle.cx).toBe(20.5);
      expect(circle.cy).toBe(0.5);
    }
  });
});

describe('pointInVision', () => {
  it('returns true for a point inside the baseline ellipse', () => {
    const home = makeSpec({
      id: 'home',
      cx: 0,
      cy: 0,
      majorRadius: 14,
      minorRadius: 14,
      buildings: [],
    });
    const sources = computeVisionSources([home]);
    // Inside the (24, 24) ellipse.
    expect(pointInVision(sources, 0, 0)).toBe(true);
    expect(pointInVision(sources, 10, 10)).toBe(true);
    // Exactly on the boundary (inclusive).
    expect(pointInVision(sources, 24, 0)).toBe(true);
    // Just past the boundary.
    expect(pointInVision(sources, 25, 0)).toBe(false);
  });

  it('returns false for a point outside every source', () => {
    const home = makeSpec({
      id: 'home',
      cx: 0,
      cy: 0,
      majorRadius: 14,
      minorRadius: 14,
      buildings: [],
    });
    const sources = computeVisionSources([home]);
    expect(pointInVision(sources, 100, 100)).toBe(false);
    expect(pointInVision(sources, -50, 0)).toBe(false);
  });

  it('returns true for a point inside a Lighthouse circle but outside baseline', () => {
    const home = makeSpec({
      id: 'home',
      cx: 0,
      cy: 0,
      majorRadius: 14,
      minorRadius: 14,
      buildings: [
        // T2 = 80-tile radius.
        { id: 'lh-1', defId: 'lighthouse_t2', x: 0, y: 0 },
      ],
    });
    const sources = computeVisionSources([home]);
    // (40, -10) is outside the (24, 24) baseline (40²/24² ≈ 2.78) but well
    // inside the 80-tile Lighthouse circle at ~(0.5, 0.5).
    expect(pointInVision(sources, 40, -10)).toBe(true);
    // A point well past the Lighthouse radius is outside.
    expect(pointInVision(sources, 200, 0)).toBe(false);
  });

  it('returns true on the Lighthouse circle boundary (inclusive)', () => {
    const home = makeSpec({
      id: 'home',
      cx: 0,
      cy: 0,
      majorRadius: 14,
      minorRadius: 14,
      buildings: [
        { id: 'lh-1', defId: 'lighthouse_t1', x: -1, y: -1 },
      ],
    });
    // Lighthouse centre is at (-1 + 0.5, -1 + 0.5) = (-0.5, -0.5). Radius 50.
    // A point at (-0.5, 49.5) is exactly on the boundary (Δy = 50, Δx = 0).
    const sources = computeVisionSources([home]);
    expect(pointInVision(sources, -0.5, 49.5)).toBe(true);
    expect(pointInVision(sources, -0.5, 49.6)).toBe(false);
  });

  it('returns false when there are no sources', () => {
    expect(pointInVision([], 0, 0)).toBe(false);
    expect(pointInVision([], 1000, 1000)).toBe(false);
  });
});
