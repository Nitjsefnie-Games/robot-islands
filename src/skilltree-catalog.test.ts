import { describe, expect, it } from 'vitest';
import { NOTABLES, KEYSTONES, FULL_CATALOG, KEYSTONE_PREREQS } from './skilltree-catalog.js';
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

describe('KEYSTONES catalog', () => {
  it('has ~30 keystones', () => {
    expect(KEYSTONES.length).toBeGreaterThanOrEqual(25);
    expect(KEYSTONES.length).toBeLessThanOrEqual(35);
  });

  it('all keystone ids are unique', () => {
    const ids = KEYSTONES.map((n) => n.id);
    const unique = new Set(ids);
    expect(unique.size).toBe(ids.length);
  });

  it('keystone ids do not overlap with notable ids', () => {
    const notableIds = new Set(NOTABLES.map((n) => n.id));
    for (const k of KEYSTONES) {
      expect(notableIds.has(k.id)).toBe(false);
    }
  });

  it('keystone id pattern uses .keystone. segment', () => {
    for (const k of KEYSTONES) {
      expect(k.id).toContain('.keystone.');
    }
  });
});

describe('FULL_CATALOG', () => {
  it('all ids across notables + keystones are unique', () => {
    const ids = FULL_CATALOG.map((n) => n.id);
    const unique = new Set(ids);
    expect(unique.size).toBe(ids.length);
  });
});

describe('KEYSTONE_PREREQS', () => {
  it('has one prereq entry per keystone', () => {
    expect(KEYSTONE_PREREQS.length).toBe(KEYSTONES.length);
  });

  it('every targetNode exists in FULL_CATALOG', () => {
    const catalogIds = new Set(FULL_CATALOG.map((n) => n.id));
    for (const ks of KEYSTONE_PREREQS) {
      expect(catalogIds.has(ks.targetNode as string)).toBe(true);
    }
  });

  it('every requires node exists in FULL_CATALOG', () => {
    const catalogIds = new Set(FULL_CATALOG.map((n) => n.id));
    for (const ks of KEYSTONE_PREREQS) {
      for (const req of ks.requires) {
        expect(catalogIds.has(req as string)).toBe(true);
      }
    }
  });

  it('each keystone requires 2-3 nodes', () => {
    for (const ks of KEYSTONE_PREREQS) {
      expect(ks.requires.length).toBeGreaterThanOrEqual(2);
      expect(ks.requires.length).toBeLessThanOrEqual(3);
    }
  });
});
