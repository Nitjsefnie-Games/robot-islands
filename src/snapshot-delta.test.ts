// src/snapshot-delta.test.ts
import { describe, it, expect } from 'vitest';
import type { SaveSnapshot } from './persistence.js';
import {
  computeSnapshotDelta,
  applySnapshotDelta,
  jsonEqual,
} from './snapshot-delta.js';

/** Build a minimally-shaped snapshot. The delta codec treats the snapshot as
 *  generic JSON, so loosely-typed fixtures cast to SaveSnapshot exercise the
 *  real code paths without constructing every field of the full schema. */
function snap(partial: {
  v?: number;
  savedAt?: number;
  savedAtPerf?: number;
  world?: Record<string, unknown>;
  islandStates?: Array<{ id: string; state: Record<string, unknown> }>;
}): SaveSnapshot {
  return {
    v: partial.v ?? 25,
    savedAt: partial.savedAt ?? 1000,
    savedAtPerf: partial.savedAtPerf ?? 500,
    world: partial.world ?? {},
    islandStates: partial.islandStates ?? [],
  } as unknown as SaveSnapshot;
}

/** Round-trip invariant: applying the computed delta reproduces `next` exactly. */
function expectRoundTrip(prev: SaveSnapshot, next: SaveSnapshot): void {
  const { delta } = computeSnapshotDelta(prev, next);
  const rebuilt = applySnapshotDelta(prev, delta);
  expect(rebuilt).toEqual(next);
}

describe('jsonEqual', () => {
  it('compares nested objects and arrays structurally', () => {
    expect(jsonEqual({ a: [1, 2], b: { c: 3 } }, { a: [1, 2], b: { c: 3 } })).toBe(true);
    expect(jsonEqual({ a: [1, 2] }, { a: [1, 3] })).toBe(false);
    expect(jsonEqual({ a: 1 }, { a: 1, b: 2 })).toBe(false);
    expect(jsonEqual(null, null)).toBe(true);
    expect(jsonEqual(0, null)).toBe(false);
  });
});

describe('computeSnapshotDelta / applySnapshotDelta round-trip', () => {
  it('reproduces an inventory-number change', () => {
    const prev = snap({
      islandStates: [{ id: 'home', state: { level: 2, lastTick: 100, inventory: { iron: 5, coal: 1 } } }],
    });
    const next = snap({
      savedAt: 2000,
      savedAtPerf: 1500,
      islandStates: [{ id: 'home', state: { level: 2, lastTick: 200, inventory: { iron: 7, coal: 1 } } }],
    });
    expectRoundTrip(prev, next);
  });

  it('reproduces a world scalar change while leaving large arrays alone', () => {
    const buildings = Array.from({ length: 50 }, (_, i) => ({ id: `b${i}`, kind: 'iron_mine' }));
    const prev = snap({ world: { totalCo2Kg: 10, islands: buildings } });
    const next = snap({ world: { totalCo2Kg: 12, islands: buildings } });
    const { delta } = computeSnapshotDelta(prev, next);
    // The unchanged `islands` array must NOT appear in the delta.
    expect(delta.world && 'islands' in delta.world).toBe(false);
    expect(delta.world && 'totalCo2Kg' in delta.world).toBe(true);
    expectRoundTrip(prev, next);
  });

  it('reproduces an array replacement when one element changes', () => {
    const prev = snap({ world: { revealedCells: ['1,1', '1,2'] } });
    const next = snap({ world: { revealedCells: ['1,1', '1,2', '1,3'] } });
    expectRoundTrip(prev, next);
  });

  it('reproduces an added island', () => {
    const prev = snap({ islandStates: [{ id: 'home', state: { level: 1, lastTick: 1 } }] });
    const next = snap({
      islandStates: [
        { id: 'home', state: { level: 1, lastTick: 1 } },
        { id: 'isle2', state: { level: 1, lastTick: 1, inventory: { wood: 3 } } },
      ],
    });
    expectRoundTrip(prev, next);
  });

  it('reproduces a removed island', () => {
    const prev = snap({
      islandStates: [
        { id: 'home', state: { level: 1, lastTick: 1 } },
        { id: 'isle2', state: { level: 1, lastTick: 1 } },
      ],
    });
    const next = snap({ islandStates: [{ id: 'home', state: { level: 1, lastTick: 1 } }] });
    expectRoundTrip(prev, next);
  });

  it('reproduces a deleted nested key', () => {
    const prev = snap({ islandStates: [{ id: 'home', state: { level: 1, lastTick: 1, declaredAt: 5 } }] });
    const next = snap({ islandStates: [{ id: 'home', state: { level: 1, lastTick: 2 } }] });
    expectRoundTrip(prev, next);
  });

  it('preserves legitimate null values (not treated as deletes)', () => {
    const prev = snap({ islandStates: [{ id: 'home', state: { lastTick: 1, declaredAt: 5 } }] });
    const next = snap({ islandStates: [{ id: 'home', state: { lastTick: 2, declaredAt: null } }] });
    expectRoundTrip(prev, next);
    const rebuilt = applySnapshotDelta(prev, computeSnapshotDelta(prev, next).delta);
    expect(rebuilt.islandStates[0]!.state).toHaveProperty('declaredAt', null);
  });

  it('reproduces a schema-version bump', () => {
    const prev = snap({ v: 24 });
    const next = snap({ v: 25 });
    const { delta, substantive } = computeSnapshotDelta(prev, next);
    expect(delta.v).toBe(25);
    expect(substantive).toBe(true);
    expectRoundTrip(prev, next);
  });

  it('keeps island ordering stable across an in-place update', () => {
    const prev = snap({
      islandStates: [
        { id: 'a', state: { lastTick: 1 } },
        { id: 'b', state: { lastTick: 1 } },
        { id: 'c', state: { lastTick: 1 } },
      ],
    });
    const next = snap({
      islandStates: [
        { id: 'a', state: { lastTick: 2 } },
        { id: 'b', state: { lastTick: 2, level: 9 } },
        { id: 'c', state: { lastTick: 2 } },
      ],
    });
    const rebuilt = applySnapshotDelta(prev, computeSnapshotDelta(prev, next).delta);
    expect(rebuilt.islandStates.map((e) => e.id)).toEqual(['a', 'b', 'c']);
    expectRoundTrip(prev, next);
  });
});

describe('keyed-array diffing (by id)', () => {
  it('sends only the changed field of one element in a large keyed array', () => {
    const buildings = (mul: number) =>
      Array.from({ length: 40 }, (_, i) => ({ id: `b${i}`, defId: 'iron_mine', x: i, y: 0, operatingMs: i * mul }));
    const prev = snap({ islandStates: [{ id: 'home', state: { lastTick: 1, buildings: buildings(1) } }] });
    const next = snap({ islandStates: [{ id: 'home', state: { lastTick: 2, buildings: buildings(2) } }] });
    const { delta } = computeSnapshotDelta(prev, next);
    const patch = delta.isUpd![0]!.patch as Record<string, unknown>;
    const bpatch = patch.buildings as Record<string, unknown>;
    expect(bpatch.__keyed).toBe(true);
    // No full-element replacement — every changed building carries just operatingMs.
    const u = bpatch.u as Record<string, Record<string, unknown>>;
    for (const id of Object.keys(u)) {
      expect(Object.keys(u[id]!)).toEqual(['operatingMs']);
    }
    expectRoundTrip(prev, next);
  });

  it('round-trips add / remove / update within a keyed array', () => {
    const prev = snap({ world: { islands: [{ id: 'a', r: 1 }, { id: 'b', r: 2 }, { id: 'c', r: 3 }] } });
    const next = snap({ world: { islands: [{ id: 'a', r: 1 }, { id: 'c', r: 9 }, { id: 'd', r: 4 }] } });
    const { delta } = computeSnapshotDelta(prev, next);
    expect((delta.world!.islands as Record<string, unknown>).__keyed).toBe(true);
    expectRoundTrip(prev, next);
  });

  it('round-trips a reorder of keyed elements', () => {
    const prev = snap({ world: { islands: [{ id: 'a', r: 1 }, { id: 'b', r: 2 }, { id: 'c', r: 3 }] } });
    const next = snap({ world: { islands: [{ id: 'c', r: 3 }, { id: 'a', r: 1 }, { id: 'b', r: 2 }] } });
    const rebuilt = applySnapshotDelta(prev, computeSnapshotDelta(prev, next).delta);
    expect((rebuilt.world.islands as unknown as Array<{ id: string }>).map((e) => e.id)).toEqual(['c', 'a', 'b']);
    expectRoundTrip(prev, next);
  });

  it('falls back to wholesale replace for non-keyed arrays (tuples, strings)', () => {
    const prev = snap({ world: { oceanCells: [['1,1', { t: 'deep' }]], revealedCells: ['1,1'] } });
    const next = snap({ world: { oceanCells: [['1,1', { t: 'deep' }], ['1,2', { t: 'shelf' }]], revealedCells: ['1,1', '1,2'] } });
    const { delta } = computeSnapshotDelta(prev, next);
    // Tuple/string arrays are __set wholesale, not keyed.
    expect((delta.world!.oceanCells as Record<string, unknown>).__set).toBeDefined();
    expectRoundTrip(prev, next);
  });

  it('handles an array going from empty to populated and back', () => {
    const empty = snap({ islandStates: [{ id: 'home', state: { lastTick: 1, buildings: [] } }] });
    const full = snap({ islandStates: [{ id: 'home', state: { lastTick: 2, buildings: [{ id: 'b0', x: 0 }] } }] });
    expectRoundTrip(empty, full);
    expectRoundTrip(full, empty);
  });
});

describe('substantive flag (idle-skip signal)', () => {
  it('is false when only the clock advances (savedAt + per-island lastTick)', () => {
    const prev = snap({
      savedAt: 1000,
      savedAtPerf: 500,
      islandStates: [{ id: 'home', state: { level: 2, lastTick: 100, inventory: { iron: 5 } } }],
    });
    const next = snap({
      savedAt: 2000,
      savedAtPerf: 1500,
      islandStates: [{ id: 'home', state: { level: 2, lastTick: 200, inventory: { iron: 5 } } }],
    });
    const { substantive, delta } = computeSnapshotDelta(prev, next);
    expect(substantive).toBe(false);
    // The clock anchors are still carried so a later substantive frame is correct.
    expect(delta.savedAt).toBe(2000);
    expect(delta.savedAtPerf).toBe(1500);
  });

  it('is true when an inventory number changes', () => {
    const prev = snap({ islandStates: [{ id: 'home', state: { lastTick: 100, inventory: { iron: 5 } } }] });
    const next = snap({ islandStates: [{ id: 'home', state: { lastTick: 200, inventory: { iron: 6 } } }] });
    expect(computeSnapshotDelta(prev, next).substantive).toBe(true);
  });

  it('is true when a world field changes', () => {
    const prev = snap({ world: { totalCo2Kg: 1 } });
    const next = snap({ world: { totalCo2Kg: 2 } });
    expect(computeSnapshotDelta(prev, next).substantive).toBe(true);
  });

  it('is false for two identical snapshots', () => {
    const a = snap({ islandStates: [{ id: 'home', state: { lastTick: 1 } }] });
    const b = snap({ islandStates: [{ id: 'home', state: { lastTick: 1 } }] });
    expect(computeSnapshotDelta(a, b).substantive).toBe(false);
  });
});

describe('immutability', () => {
  it('does not mutate prev when applying a delta', () => {
    const prev = snap({ islandStates: [{ id: 'home', state: { lastTick: 1, inventory: { iron: 5 } } }] });
    const frozen = JSON.parse(JSON.stringify(prev));
    const next = snap({ islandStates: [{ id: 'home', state: { lastTick: 2, inventory: { iron: 9 } } }] });
    applySnapshotDelta(prev, computeSnapshotDelta(prev, next).delta);
    expect(prev).toEqual(frozen);
  });
});
