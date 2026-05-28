import { describe, expect, it } from 'vitest';
import { clickToLatLon, shouldShowPicker } from './map-picker.js';

describe('clickToLatLon — equirectangular', () => {
  it('center → (0, 0)', () => expect(clickToLatLon(180, 90, 360, 180)).toEqual({ lat: 0, lon: 0 }));
  it('(270, 45) → (45, 90)', () => expect(clickToLatLon(270, 45, 360, 180)).toEqual({ lat: 45, lon: 90 }));
  it('(90, 135) → (-45, -90)', () => expect(clickToLatLon(90, 135, 360, 180)).toEqual({ lat: -45, lon: -90 }));
  it('corner (0, 0) → (90, -180)', () => expect(clickToLatLon(0, 0, 360, 180)).toEqual({ lat: 90, lon: -180 }));
  it('opposite corner (360, 180) → (-90, 180)', () => expect(clickToLatLon(360, 180, 360, 180)).toEqual({ lat: -90, lon: 180 }));
});

describe('shouldShowPicker', () => {
  it('returns true when either coord is null', () => {
    expect(shouldShowPicker({ playerLat: null, playerLon: null })).toBe(true);
    expect(shouldShowPicker({ playerLat: 40, playerLon: null })).toBe(true);
    expect(shouldShowPicker({ playerLat: null, playerLon: -74 })).toBe(true);
    expect(shouldShowPicker({ playerLat: 40, playerLon: -74 })).toBe(false);
  });
});
