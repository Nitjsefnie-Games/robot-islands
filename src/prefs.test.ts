// UI-prefs persistence: clampSaveIntervalSec bounds + loadPrefs/savePrefs
// round-trip and the v1→v2 (camera-only → camera+saveIntervalSec) migration.
//
// idb-keyval is mocked with an in-memory store so we exercise the real
// save/load logic without IndexedDB. This is the one prefs file that drives
// idb — the sibling persistence.test.ts intentionally doesn't.

import { beforeEach, describe, expect, it, vi } from 'vitest';

// In-memory backing store for the mocked idb-keyval. Hoisted-safe: vi.mock's
// factory runs before imports, and we reach this Map lazily inside get/set.
const store = new Map<string, unknown>();
vi.mock('idb-keyval', () => ({
  get: (k: string) => Promise.resolve(store.get(k)),
  set: (k: string, v: unknown) => {
    store.set(k, v);
    return Promise.resolve();
  },
  del: (k: string) => {
    store.delete(k);
    return Promise.resolve();
  },
}));

import {
  clampSaveIntervalSec,
  DEFAULT_SAVE_INTERVAL_SEC,
  loadPrefs,
  MAX_SAVE_INTERVAL_SEC,
  MIN_SAVE_INTERVAL_SEC,
  PREFS_KEY,
  PREFS_VERSION,
  savePrefs,
} from './persistence.js';

beforeEach(() => {
  store.clear();
});

describe('clampSaveIntervalSec', () => {
  it('passes a valid in-range integer through unchanged', () => {
    expect(clampSaveIntervalSec(30)).toBe(30);
    expect(clampSaveIntervalSec(1)).toBe(1);
    expect(clampSaveIntervalSec(600)).toBe(600);
  });

  it('clamps below MIN up to MIN', () => {
    expect(clampSaveIntervalSec(0)).toBe(MIN_SAVE_INTERVAL_SEC);
    expect(clampSaveIntervalSec(-5)).toBe(MIN_SAVE_INTERVAL_SEC);
  });

  it('clamps above MAX down to MAX', () => {
    expect(clampSaveIntervalSec(700)).toBe(MAX_SAVE_INTERVAL_SEC);
    expect(clampSaveIntervalSec(1e9)).toBe(MAX_SAVE_INTERVAL_SEC);
  });

  it('floors fractional values to whole seconds', () => {
    expect(clampSaveIntervalSec(30.9)).toBe(30);
    expect(clampSaveIntervalSec(1.5)).toBe(1);
  });

  it('falls back to the default on non-finite / non-numeric input', () => {
    expect(clampSaveIntervalSec(NaN)).toBe(DEFAULT_SAVE_INTERVAL_SEC);
    expect(clampSaveIntervalSec(Infinity)).toBe(DEFAULT_SAVE_INTERVAL_SEC);
    expect(clampSaveIntervalSec(undefined)).toBe(DEFAULT_SAVE_INTERVAL_SEC);
    expect(clampSaveIntervalSec('30')).toBe(DEFAULT_SAVE_INTERVAL_SEC);
  });
});

describe('savePrefs / loadPrefs round-trip', () => {
  it('round-trips a custom interval at the current version', async () => {
    await savePrefs({ cam: { tx: 12, ty: -34, zoom: 1.5 }, saveIntervalSec: 120 });
    const loaded = await loadPrefs();
    expect(loaded).not.toBeNull();
    expect(loaded?.v).toBe(PREFS_VERSION);
    expect(loaded?.cam).toEqual({ tx: 12, ty: -34, zoom: 1.5 });
    expect(loaded?.saveIntervalSec).toBe(120);
  });

  it('clamps an out-of-range interval on save', async () => {
    await savePrefs({ cam: { tx: 0, ty: 0, zoom: 1 }, saveIntervalSec: 5000 });
    const loaded = await loadPrefs();
    expect(loaded?.saveIntervalSec).toBe(MAX_SAVE_INTERVAL_SEC);
  });

  it('returns null when nothing is stored', async () => {
    expect(await loadPrefs()).toBeNull();
  });
});

describe('v1 → v2 migration', () => {
  it('preserves the camera and defaults the interval for a v1 (cam-only) blob', async () => {
    // A legacy v1 blob: camera only, no saveIntervalSec, plus a stale extra
    // field from an even older revision (must still parse).
    store.set(PREFS_KEY, {
      v: 1,
      cam: { tx: 7, ty: 9, zoom: 2 },
      openPanel: 'construct',
    });
    const loaded = await loadPrefs();
    expect(loaded).not.toBeNull();
    expect(loaded?.v).toBe(PREFS_VERSION);
    expect(loaded?.cam).toEqual({ tx: 7, ty: 9, zoom: 2 });
    expect(loaded?.saveIntervalSec).toBe(DEFAULT_SAVE_INTERVAL_SEC);
  });

  it('rejects a blob whose version is neither 1 nor current', async () => {
    store.set(PREFS_KEY, { v: 99, cam: { tx: 1, ty: 1, zoom: 1 } });
    expect(await loadPrefs()).toBeNull();
  });

  it('rejects a blob with a malformed camera', async () => {
    store.set(PREFS_KEY, { v: 1, cam: { tx: 'oops', ty: 1, zoom: 1 } });
    expect(await loadPrefs()).toBeNull();
  });
});
