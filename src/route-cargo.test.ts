import { describe, it, expect } from 'vitest';
import { planCargo, migrateLegacyCargo } from './route-cargo.js';
import type { ViableEntry } from './route-cargo.js';

// helper: a viable entry with sensible defaults
function ve(over: Partial<ViableEntry> & { resourceId: ViableEntry['resourceId'] }): ViableEntry {
  return { weight: 1, headroom: 1000, sourceAvail: 1000, destFillRatio: 0, ...over };
}

describe('planCargo — priority', () => {
  it('gives the whole budget to the first entry, clamped to headroom', () => {
    const out = planCargo('priority', [ve({ resourceId: 'wood' }), ve({ resourceId: 'stone' })], 10);
    expect(out).toEqual([{ resourceId: 'wood', amount: 10 }]);
  });
  it('clamps to the first entry headroom', () => {
    const out = planCargo('priority', [ve({ resourceId: 'wood', headroom: 4 })], 10);
    expect(out).toEqual([{ resourceId: 'wood', amount: 4 }]);
  });
  it('returns [] for no entries', () => {
    expect(planCargo('priority', [], 10)).toEqual([]);
  });
});

describe('planCargo — waterfall', () => {
  it('fills entry 1 to its source limit, spills the rest to entry 2', () => {
    const out = planCargo('waterfall', [
      ve({ resourceId: 'wood', sourceAvail: 3 }),
      ve({ resourceId: 'stone' }),
    ], 10);
    expect(out).toEqual([
      { resourceId: 'wood', amount: 3 },
      { resourceId: 'stone', amount: 7 },
    ]);
  });
  it('stops once the budget is exhausted', () => {
    const out = planCargo('waterfall', [
      ve({ resourceId: 'wood' }),
      ve({ resourceId: 'stone' }),
    ], 10);
    expect(out).toEqual([{ resourceId: 'wood', amount: 10 }]);
  });
  it('clamps each entry to headroom too', () => {
    const out = planCargo('waterfall', [
      ve({ resourceId: 'wood', headroom: 2, sourceAvail: 99 }),
      ve({ resourceId: 'stone' }),
    ], 10);
    expect(out).toEqual([
      { resourceId: 'wood', amount: 2 },
      { resourceId: 'stone', amount: 8 },
    ]);
  });
});

describe('planCargo — split', () => {
  it('divides the budget by normalised weight', () => {
    const out = planCargo('split', [
      ve({ resourceId: 'wood', weight: 2 }),
      ve({ resourceId: 'stone', weight: 1 }),
    ], 9);
    expect(out).toEqual([
      { resourceId: 'wood', amount: 6 },
      { resourceId: 'stone', amount: 3 },
    ]);
  });
  it('a single viable entry takes the whole budget (weights rescale)', () => {
    const out = planCargo('split', [ve({ resourceId: 'wood', weight: 2 })], 9);
    expect(out).toEqual([{ resourceId: 'wood', amount: 9 }]);
  });
});

describe('planCargo — balanced', () => {
  it('picks the entry with the lowest destination fill ratio', () => {
    const out = planCargo('balanced', [
      ve({ resourceId: 'wood', destFillRatio: 0.9 }),
      ve({ resourceId: 'stone', destFillRatio: 0.1 }),
    ], 10);
    expect(out).toEqual([{ resourceId: 'stone', amount: 10 }]);
  });
  it('breaks ties by list order', () => {
    const out = planCargo('balanced', [
      ve({ resourceId: 'wood', destFillRatio: 0.5 }),
      ve({ resourceId: 'stone', destFillRatio: 0.5 }),
    ], 10);
    expect(out).toEqual([{ resourceId: 'wood', amount: 10 }]);
  });
});

describe('migrateLegacyCargo', () => {
  it('a filtered route becomes priority mode with a one-entry list', () => {
    expect(migrateLegacyCargo({ filter: 'iron_ore', priorityList: [] }))
      .toEqual({ mode: 'priority', cargo: [{ resourceId: 'iron_ore' }] });
  });
  it('an any route keeps its list, in priority mode', () => {
    expect(migrateLegacyCargo({ filter: null, priorityList: ['wood', 'coal'] }))
      .toEqual({ mode: 'priority', cargo: [{ resourceId: 'wood' }, { resourceId: 'coal' }] });
  });
  it('an already-migrated route (has mode/cargo) is returned unchanged', () => {
    const r = { mode: 'split' as const, cargo: [{ resourceId: 'wood' as const, weight: 2 }] };
    expect(migrateLegacyCargo(r)).toEqual(r);
  });
});
