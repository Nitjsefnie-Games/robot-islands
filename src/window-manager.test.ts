import { describe, it, expect, beforeEach, vi } from 'vitest';

// Node test env lacks localStorage; provide a minimal in-memory mock.
if (typeof globalThis.localStorage === 'undefined') {
  class MockStorage {
    private store: Record<string, string> = {};
    getItem(key: string): string | null {
      return this.store[key] ?? null;
    }
    setItem(key: string, value: string): void {
      this.store[key] = value;
    }
    removeItem(key: string): void {
      delete this.store[key];
    }
    clear(): void {
      this.store = {};
    }
  }
  vi.stubGlobal('Storage', MockStorage);
  vi.stubGlobal('localStorage', new MockStorage());
}
import {
  clampToViewport,
  parseLayoutBlob,
  readBlob,
  writeBlob,
  emptyBlob,
  LAYOUT_STORAGE_KEY,
  MIN_PANEL_W,
  MIN_PANEL_H,
  type UiLayoutBlob,
} from './window-manager.js';

describe('clampToViewport', () => {
  const vp = { w: 1100, h: 620 };
  const minVisible = 80;

  it('rect entirely inside the viewport is unchanged', () => {
    const r = { x: 100, y: 100, w: 300, h: 200 };
    expect(clampToViewport(r, vp, minVisible)).toEqual(r);
  });

  it('rect off the right edge is pulled left so minVisible of its width stays on-screen', () => {
    const r = { x: 1300, y: 200, w: 300, h: 200 };
    const out = clampToViewport(r, vp, minVisible);
    // x must be <= vp.w - minVisible (so ≥80px of header is visible).
    expect(out.x).toBeLessThanOrEqual(vp.w - minVisible);
    expect(out.y).toBe(200);
    expect(out.w).toBe(300);
    expect(out.h).toBe(200);
  });

  it('rect off the bottom edge is pulled up so header band stays reachable', () => {
    const r = { x: 200, y: 700, w: 300, h: 200 };
    const out = clampToViewport(r, vp, minVisible);
    // y must be such that y + 22 (header band) <= vp.h — i.e. y <= vp.h - 22.
    expect(out.y).toBeLessThanOrEqual(vp.h - 22);
  });

  it('rect with negative x is pulled to 0 (or up to width-minVisible)', () => {
    const r = { x: -200, y: 50, w: 300, h: 200 };
    const out = clampToViewport(r, vp, minVisible);
    // At minimum, x must be >= minVisible - r.w (so right edge clears minVisible).
    expect(out.x).toBeGreaterThanOrEqual(minVisible - r.w);
  });

  it('rect larger than viewport is capped to fit with gutter', () => {
    const r = { x: 0, y: 0, w: 2000, h: 1500 };
    const out = clampToViewport(r, vp, minVisible);
    expect(out.w).toBeLessThanOrEqual(vp.w);
    expect(out.h).toBeLessThanOrEqual(vp.h);
  });
});

describe('parseLayoutBlob', () => {
  it('returns null for non-object input', () => {
    expect(parseLayoutBlob(null)).toBeNull();
    expect(parseLayoutBlob(42)).toBeNull();
    expect(parseLayoutBlob('hi')).toBeNull();
    expect(parseLayoutBlob([])).toBeNull();
  });

  it('returns null when v is missing or wrong', () => {
    expect(parseLayoutBlob({ panels: {}, globalZCounter: 0 })).toBeNull();
    expect(parseLayoutBlob({ v: 2, panels: {}, globalZCounter: 0 })).toBeNull();
  });

  it('returns null when panels field is malformed', () => {
    expect(parseLayoutBlob({ v: 1, panels: 'oops', globalZCounter: 0 })).toBeNull();
    expect(parseLayoutBlob({ v: 1, panels: [], globalZCounter: 0 })).toBeNull();
  });

  it('drops malformed panel entries but keeps valid ones', () => {
    const raw = {
      v: 1,
      panels: {
        good: { x: 10, y: 20, w: 300, h: 200, zRank: 5 },
        bad_missing_y: { x: 10, w: 300, h: 200, zRank: 5 },
        bad_wrong_type: { x: 'no', y: 0, w: 0, h: 0, zRank: 0 },
      },
      globalZCounter: 5,
    };
    const out = parseLayoutBlob(raw);
    expect(out).not.toBeNull();
    expect(out!.panels.good).toEqual({ x: 10, y: 20, w: 300, h: 200, zRank: 5 });
    expect(out!.panels.bad_missing_y).toBeUndefined();
    expect(out!.panels.bad_wrong_type).toBeUndefined();
    expect(out!.globalZCounter).toBe(5);
  });

  it('coerces non-finite globalZCounter to 0', () => {
    const out = parseLayoutBlob({ v: 1, panels: {}, globalZCounter: NaN });
    expect(out).not.toBeNull();
    expect(out!.globalZCounter).toBe(0);
  });
});

describe('parseLayoutBlob — degenerate-dimension floor', () => {
  it('rejects an entry with w=1, h=1 (the observed bug state)', () => {
    const raw = {
      v: 1,
      panels: {
        bad: { x: 79, y: 0, w: 1, h: 1, zRank: 294 },
      },
      globalZCounter: 0,
    };
    const result = parseLayoutBlob(raw);
    expect(result).not.toBeNull();
    expect(result!.panels.bad).toBeUndefined();
  });

  it('accepts an entry exactly at the floor (w=MIN_PANEL_W, h=MIN_PANEL_H)', () => {
    const raw = {
      v: 1,
      panels: {
        edge: { x: 0, y: 0, w: MIN_PANEL_W, h: MIN_PANEL_H, zRank: 0 },
      },
      globalZCounter: 0,
    };
    const result = parseLayoutBlob(raw);
    expect(result).not.toBeNull();
    expect(result!.panels.edge).toBeDefined();
    expect(result!.panels.edge!.w).toBe(MIN_PANEL_W);
    expect(result!.panels.edge!.h).toBe(MIN_PANEL_H);
  });

  it('rejects an entry one below either floor', () => {
    const raw = {
      v: 1,
      panels: {
        underW: { x: 0, y: 0, w: MIN_PANEL_W - 1, h: MIN_PANEL_H, zRank: 0 },
        underH: { x: 0, y: 0, w: MIN_PANEL_W, h: MIN_PANEL_H - 1, zRank: 0 },
      },
      globalZCounter: 0,
    };
    const result = parseLayoutBlob(raw);
    expect(result).not.toBeNull();
    expect(result!.panels.underW).toBeUndefined();
    expect(result!.panels.underH).toBeUndefined();
  });

  it('keeps valid entries when invalid ones are present in the same blob', () => {
    const raw = {
      v: 1,
      panels: {
        good: { x: 12, y: 12, w: 300, h: 200, zRank: 5 },
        bad: { x: 79, y: 0, w: 1, h: 1, zRank: 99 },
      },
      globalZCounter: 5,
    };
    const result = parseLayoutBlob(raw);
    expect(result).not.toBeNull();
    expect(result!.panels.good).toBeDefined();
    expect(result!.panels.bad).toBeUndefined();
    expect(result!.globalZCounter).toBe(5);
  });
});

describe('readBlob / writeBlob round-trip', () => {
  beforeEach(() => {
    localStorage.clear();
  });

  it('writeBlob then readBlob returns equivalent data', () => {
    const blob: UiLayoutBlob = {
      v: 1,
      panels: { 'hud-economy': { x: 50, y: 60, w: 300, h: 200, zRank: 1 } },
      globalZCounter: 1,
    };
    writeBlob(blob);
    expect(readBlob()).toEqual(blob);
  });

  it('readBlob returns emptyBlob() when storage is empty', () => {
    expect(readBlob()).toEqual(emptyBlob());
  });

  it('readBlob returns emptyBlob() when stored JSON is malformed', () => {
    localStorage.setItem(LAYOUT_STORAGE_KEY, '{not json');
    expect(readBlob()).toEqual(emptyBlob());
  });

  it('readBlob returns emptyBlob() when stored blob has wrong v', () => {
    localStorage.setItem(
      LAYOUT_STORAGE_KEY,
      JSON.stringify({ v: 99, panels: {}, globalZCounter: 0 }),
    );
    expect(readBlob()).toEqual(emptyBlob());
  });

  it('writeBlob does not throw when localStorage.setItem throws (quota / disabled)', () => {
    const original = Storage.prototype.setItem;
    Storage.prototype.setItem = () => {
      throw new DOMException('Quota exceeded', 'QuotaExceededError');
    };
    try {
      expect(() => writeBlob(emptyBlob())).not.toThrow();
    } finally {
      Storage.prototype.setItem = original;
    }
  });
});
