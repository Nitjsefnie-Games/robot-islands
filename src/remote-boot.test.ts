import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import { isRemoteBootEnabled, loadStoredPlayerLatLon, storePlayerLatLon } from './remote-boot.js';

describe('isRemoteBootEnabled', () => {
  beforeEach(() => {
    vi.stubGlobal('location', { search: '' } as unknown as Location);
    vi.stubGlobal('localStorage', { getItem: vi.fn(() => null), setItem: vi.fn(() => undefined) } as unknown as Storage);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('returns true by default', () => {
    expect(isRemoteBootEnabled()).toBe(true);
  });

  it('returns false when localStorage ri_server is "0"', () => {
    (globalThis.localStorage.getItem as ReturnType<typeof vi.fn>).mockReturnValue('0');
    expect(isRemoteBootEnabled()).toBe(false);
  });

  it('returns false when URL server param is "0"', () => {
    vi.stubGlobal('location', { search: '?server=0' } as unknown as Location);
    expect(isRemoteBootEnabled()).toBe(false);
  });

  it('returns true for other server param values', () => {
    vi.stubGlobal('location', { search: '?server=1' } as unknown as Location);
    expect(isRemoteBootEnabled()).toBe(true);
    vi.stubGlobal('location', { search: '?server=true' } as unknown as Location);
    expect(isRemoteBootEnabled()).toBe(true);
  });

  it('returns true when localStorage is inaccessible', () => {
    vi.stubGlobal('localStorage', new Proxy({} as Storage, {
      get() {
        throw new Error('localStorage denied');
      },
    }));
    expect(isRemoteBootEnabled()).toBe(true);
  });
});

describe('loadStoredPlayerLatLon', () => {
  beforeEach(() => {
    vi.stubGlobal('location', { search: '' } as unknown as Location);
    vi.stubGlobal('localStorage', { getItem: vi.fn(() => null), setItem: vi.fn(() => undefined) } as unknown as Storage);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('returns null in LOCAL mode', () => {
    vi.stubGlobal('location', { search: '?server=0' } as unknown as Location);
    (globalThis.localStorage.getItem as ReturnType<typeof vi.fn>).mockReturnValue('{"lat":40,"lon":-74}');
    expect(loadStoredPlayerLatLon()).toBeNull();
  });

  it('returns null when nothing is stored in REMOTE mode', () => {
    expect(loadStoredPlayerLatLon()).toBeNull();
  });

  it('returns stored lat/lon in REMOTE mode', () => {
    (globalThis.localStorage.getItem as ReturnType<typeof vi.fn>).mockReturnValue('{"lat":40.7,"lon":-74.0}');
    expect(loadStoredPlayerLatLon()).toEqual({ lat: 40.7, lon: -74 });
  });

  it('returns null for malformed JSON in REMOTE mode', () => {
    (globalThis.localStorage.getItem as ReturnType<typeof vi.fn>).mockReturnValue('not-json');
    expect(loadStoredPlayerLatLon()).toBeNull();
  });

  it('returns null for invalid shape in REMOTE mode', () => {
    (globalThis.localStorage.getItem as ReturnType<typeof vi.fn>).mockReturnValue('{"lat":"forty"}');
    expect(loadStoredPlayerLatLon()).toBeNull();
  });
});

describe('storePlayerLatLon', () => {
  beforeEach(() => {
    vi.stubGlobal('location', { search: '' } as unknown as Location);
    vi.stubGlobal('localStorage', { getItem: vi.fn(() => null), setItem: vi.fn(() => undefined) } as unknown as Storage);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('does nothing in LOCAL mode', () => {
    vi.stubGlobal('location', { search: '?server=0' } as unknown as Location);
    storePlayerLatLon(40.7, -74);
    expect(globalThis.localStorage.setItem).not.toHaveBeenCalled();
  });

  it('writes JSON to localStorage in REMOTE mode', () => {
    storePlayerLatLon(40.7, -74);
    expect(globalThis.localStorage.setItem).toHaveBeenCalledTimes(1);
    expect(globalThis.localStorage.setItem).toHaveBeenCalledWith('ri_player_latlon', '{"lat":40.7,"lon":-74}');
  });

  it('swallows localStorage errors silently', () => {
    vi.stubGlobal('localStorage', new Proxy({} as Storage, {
      get() {
        throw new Error('localStorage denied');
      },
    }));
    expect(() => storePlayerLatLon(0, 0)).not.toThrow();
  });
});
