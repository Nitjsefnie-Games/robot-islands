import { describe, expect, it } from 'vitest';
import { BORDERS_SVG_PATH, buildMapSvg, clickToLatLon, screenToLatLon, shouldShowPicker, WORLD_SVG_PATH } from './map-picker.js';

describe('clickToLatLon — equirectangular', () => {
  it('center → (0, 0)', () => expect(clickToLatLon(180, 90, 360, 180)).toEqual({ lat: 0, lon: 0 }));
  it('(270, 45) → (45, 90)', () => expect(clickToLatLon(270, 45, 360, 180)).toEqual({ lat: 45, lon: 90 }));
  it('(90, 135) → (-45, -90)', () => expect(clickToLatLon(90, 135, 360, 180)).toEqual({ lat: -45, lon: -90 }));
  it('corner (0, 0) → (90, -180)', () => expect(clickToLatLon(0, 0, 360, 180)).toEqual({ lat: 90, lon: -180 }));
  it('opposite corner (360, 180) → (-90, 180)', () => expect(clickToLatLon(360, 180, 360, 180)).toEqual({ lat: -90, lon: 180 }));
});

describe('world land outline renders (regression: blank-map bug)', () => {
  // The original module shipped WORLD_SVG_PATH = 'M0,0' behind a guard that
  // misclassified it as real geography, so the modal drew a blank ocean rect
  // with no continents and nothing testable caught it. These assertions bind
  // "the map actually has land in it" to the suite.

  it('WORLD_SVG_PATH is substantial real geography, not a placeholder', () => {
    expect(WORLD_SVG_PATH.length).toBeGreaterThan(10_000);
    expect(WORLD_SVG_PATH.startsWith('M')).toBe(true);
    // many closed rings (continents + islands)
    expect((WORLD_SVG_PATH.match(/Z/g) ?? []).length).toBeGreaterThan(50);
    expect((WORLD_SVG_PATH.match(/L/g) ?? []).length).toBeGreaterThan(500);
  });

  it('buildMapSvg() embeds the ocean rect AND a non-empty land path', () => {
    const svg = buildMapSvg();
    expect(svg).toContain('viewBox="0 0 360 180"');
    expect(svg).toContain('<rect x="0" y="0" width="360" height="180"');
    // the land <path> must carry the real data, not be absent/degenerate
    expect(svg).toContain(`<path d="${WORLD_SVG_PATH}"`);
  });

  it('projection spans the full world inside the 360×180 viewBox', () => {
    const coords = [...WORLD_SVG_PATH.matchAll(/[ML](-?\d+(?:\.\d+)?) (-?\d+(?:\.\d+)?)/g)];
    expect(coords.length).toBeGreaterThan(1000);
    let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
    for (const m of coords) {
      const x = Number(m[1]); const y = Number(m[2]);
      minX = Math.min(minX, x); maxX = Math.max(maxX, x);
      minY = Math.min(minY, y); maxY = Math.max(maxY, y);
    }
    // every vertex stays inside the viewBox (catches offset / mis-scaled maps)
    expect(minX).toBeGreaterThanOrEqual(0);
    expect(maxX).toBeLessThanOrEqual(360);
    expect(minY).toBeGreaterThanOrEqual(0);
    expect(maxY).toBeLessThanOrEqual(180);
    // land wraps most of the globe horizontally and reaches both hemispheres
    expect(maxX - minX).toBeGreaterThan(300);
    expect(maxY - minY).toBeGreaterThan(120);
  });
});

describe('country borders render', () => {
  it('BORDERS_SVG_PATH is a substantial interior-border polyline set', () => {
    expect(BORDERS_SVG_PATH.length).toBeGreaterThan(5_000);
    expect(BORDERS_SVG_PATH.startsWith('M')).toBe(true);
    // interior borders are open polylines — many M segments, no closing Z
    expect((BORDERS_SVG_PATH.match(/M/g) ?? []).length).toBeGreaterThan(50);
    expect(BORDERS_SVG_PATH).not.toContain('Z');
  });

  it('borders stay inside the viewBox and do not touch the world edges', () => {
    const coords = [...BORDERS_SVG_PATH.matchAll(/[ML](-?\d+(?:\.\d+)?) (-?\d+(?:\.\d+)?)/g)];
    let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
    for (const m of coords) {
      const x = Number(m[1]); const y = Number(m[2]);
      minX = Math.min(minX, x); maxX = Math.max(maxX, x);
      minY = Math.min(minY, y); maxY = Math.max(maxY, y);
    }
    expect(minX).toBeGreaterThan(0);
    expect(maxX).toBeLessThan(360);
    expect(minY).toBeGreaterThan(0);
    expect(maxY).toBeLessThan(180);
  });

  it('buildMapSvg() layers the borders path with fill:none + non-scaling-stroke', () => {
    const svg = buildMapSvg();
    expect(svg).toContain(`<path class="map-picker-borders" d="${BORDERS_SVG_PATH}"`);
    expect(svg).toContain('fill="none"');
    expect(svg).toContain('vector-effect="non-scaling-stroke"');
  });
});

describe('screenToLatLon — pan/zoom aware picking', () => {
  const full = { x: 0, y: 0, w: 360, h: 180 };

  it('reduces to clickToLatLon at the full-world viewBox', () => {
    const cases: Array<[number, number]> = [[180, 90], [270, 45], [90, 135], [0, 0], [360, 180]];
    for (const [x, y] of cases) {
      expect(screenToLatLon(x, y, 360, 180, full)).toEqual(clickToLatLon(x, y, 360, 180));
    }
  });

  it('maps within a zoomed-in viewBox', () => {
    // window centered on (lon 0, lat 0): viewBox [90,45,180,90]
    const vb = { x: 90, y: 45, w: 180, h: 90 };
    // center of the rect → center of the window → (0,0)
    expect(screenToLatLon(180, 90, 360, 180, vb)).toEqual({ lat: 0, lon: 0 });
    // top-left of the rect → viewBox (90,45) → lon -90, lat 45
    expect(screenToLatLon(0, 0, 360, 180, vb)).toEqual({ lat: 45, lon: -90 });
    // bottom-right → viewBox (270,135) → lon 90, lat -45
    expect(screenToLatLon(360, 180, 360, 180, vb)).toEqual({ lat: -45, lon: 90 });
  });
});

describe('shouldShowPicker', () => {
  it('returns true when either coord is null', () => {
    expect(shouldShowPicker({ playerLat: null, playerLon: null })).toBe(true);
    expect(shouldShowPicker({ playerLat: 40, playerLon: null })).toBe(true);
    expect(shouldShowPicker({ playerLat: null, playerLon: -74 })).toBe(true);
    expect(shouldShowPicker({ playerLat: 40, playerLon: -74 })).toBe(false);
  });
});
