import { describe, expect, it } from 'vitest';
import { NOTABLES } from './skilltree-catalog.js';
import { SUBPATH_LABEL } from './skilltree.js';

describe('NOTABLES catalog', () => {
  it('has ~80 notables', () => {
    expect(NOTABLES.length).toBeGreaterThanOrEqual(60);
    expect(NOTABLES.length).toBeLessThanOrEqual(100);
  });

  it('all ids are unique', () => {
    const ids = NOTABLES.map((n) => n.id);
    const unique = new Set(ids);
    expect(unique.size).toBe(ids.length);
  });

  it('all subPaths are valid SubPathId values', () => {
    const validSubPaths = new Set(Object.keys(SUBPATH_LABEL));
    for (const n of NOTABLES) {
      expect(validSubPaths.has(n.subPath)).toBe(true);
    }
  });

  it('every sub-path has at least one notable', () => {
    const subPaths = new Set(NOTABLES.map((n) => n.subPath));
    expect(subPaths.size).toBe(20);
  });

  it('at least one notable per sub-path has an aura', () => {
    const subPathsWithAura = new Set<string>();
    for (const n of NOTABLES) {
      if (n.aura) subPathsWithAura.add(n.subPath);
    }
    expect(subPathsWithAura.size).toBeGreaterThanOrEqual(15);
  });

  it('aura radius is 1 or 2', () => {
    for (const n of NOTABLES) {
      if (n.aura) {
        expect([1, 2]).toContain(n.aura.radius);
      }
    }
  });

  it('aura bonus is positive', () => {
    for (const n of NOTABLES) {
      if (n.aura) {
        expect(n.aura.bonus).toBeGreaterThan(0);
      }
    }
  });
});
