import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import { isRemoteBootEnabled } from './remote-boot.js';

describe('isRemoteBootEnabled', () => {
  beforeEach(() => {
    vi.stubGlobal('location', { search: '' } as unknown as Location);
    vi.stubGlobal('localStorage', { getItem: vi.fn(() => null) } as unknown as Storage);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('returns false by default', () => {
    expect(isRemoteBootEnabled()).toBe(false);
  });

  it('returns true when localStorage ri_server is "1"', () => {
    (globalThis.localStorage.getItem as ReturnType<typeof vi.fn>).mockReturnValue('1');
    expect(isRemoteBootEnabled()).toBe(true);
  });

  it('returns true when URL server param is "1"', () => {
    vi.stubGlobal('location', { search: '?server=1' } as unknown as Location);
    expect(isRemoteBootEnabled()).toBe(true);
  });

  it('returns false for other server param values', () => {
    vi.stubGlobal('location', { search: '?server=true' } as unknown as Location);
    expect(isRemoteBootEnabled()).toBe(false);
  });

  it('returns false when localStorage is inaccessible', () => {
    vi.stubGlobal('localStorage', new Proxy({} as Storage, {
      get() {
        throw new Error('localStorage denied');
      },
    }));
    expect(isRemoteBootEnabled()).toBe(false);
  });
});
