// Pure-helper tests for the inventory modal panel. The panel is DOM and JSDOM
// isn't configured here (AGENTS.md "tests target the pure layer only"), so we
// test the resource categorisation table: complete, and honouring the
// Fuel/Liquid precedence rule from the brief.

import { describe, expect, it } from 'vitest';

import {
  RESOURCE_CATEGORY,
  RESOURCE_FILTER_LABEL,
  RESOURCE_FILTER_ORDER,
  inventoryRowVisible,
} from './inventory-ui.js';
import { RATE_WINDOW_MS, averageRate, pruneRateBuffer, type RateSample } from './rate-history.js';
import { ALL_RESOURCES, type ResourceId } from './recipes.js';

describe('RESOURCE_CATEGORY', () => {
  it('covers every ResourceId', () => {
    for (const r of ALL_RESOURCES) {
      expect(RESOURCE_CATEGORY[r]).toBeDefined();
    }
  });

  it('places every resource in a FILTERABLE category (RESOURCE_FILTER_ORDER covers all buckets)', () => {
    // Data-level guard: every RESOURCE_CATEGORY value must be a category in
    // RESOURCE_FILTER_ORDER, so no resource is orphaned into a bucket with no
    // chip (the slag/'misc' bug — misc had a chip suppressed). The chip loop
    // renders all of RESOURCE_FILTER_ORDER, so this keeps the category chips
    // unioning to the full resource list as new categories are added.
    const filterable = new Set(RESOURCE_FILTER_ORDER.filter((c) => c !== 'all'));
    for (const r of ALL_RESOURCES) {
      expect(filterable.has(RESOURCE_CATEGORY[r])).toBe(true);
    }
  });

  it('places T0 raws in the Raw bucket', () => {
    expect(RESOURCE_CATEGORY.wood).toBe('raw');
    expect(RESOURCE_CATEGORY.iron_ore).toBe('raw');
    expect(RESOURCE_CATEGORY.coal).toBe('raw');
    expect(RESOURCE_CATEGORY.stone).toBe('raw');
  });

  it('places fuels in the Fuel bucket (precedence over Raw/Refined)', () => {
    // Biofuel is a Refined T1 product AND a fuel — brief mandates Fuel wins.
    expect(RESOURCE_CATEGORY.biofuel).toBe('fuel');
    expect(RESOURCE_CATEGORY.diesel).toBe('fuel');
    expect(RESOURCE_CATEGORY.aviation_kerosene).toBe('fuel');
    expect(RESOURCE_CATEGORY.cryogenic_hydrogen).toBe('fuel');
    expect(RESOURCE_CATEGORY.plasma_charge).toBe('fuel');
  });

  it('places liquids in the Liquid bucket', () => {
    expect(RESOURCE_CATEGORY.fresh_water).toBe('liquid');
    expect(RESOURCE_CATEGORY.saltwater).toBe('liquid');
    expect(RESOURCE_CATEGORY.crude_oil).toBe('liquid');
    expect(RESOURCE_CATEGORY.hydrogen).toBe('liquid');
    expect(RESOURCE_CATEGORY.nitrogen).toBe('liquid');
  });

  it('places rare T4/T5 raws + components in the Rare bucket', () => {
    expect(RESOURCE_CATEGORY.helium_3).toBe('rare');
    expect(RESOURCE_CATEGORY.casimir_energy).toBe('rare');
    expect(RESOURCE_CATEGORY.reality_anchor).toBe('rare');
    expect(RESOURCE_CATEGORY.dark_matter).toBe('rare');
  });

  it('places refined T1 products in Refined', () => {
    expect(RESOURCE_CATEGORY.iron_ingot).toBe('refined');
    expect(RESOURCE_CATEGORY.lumber).toBe('refined');
    expect(RESOURCE_CATEGORY.glass).toBe('refined');
  });
});

describe('RESOURCE_FILTER_ORDER', () => {
  it('starts with All', () => {
    expect(RESOURCE_FILTER_ORDER[0]).toBe('all');
  });

  it('lists each chip exactly once', () => {
    const seen = new Set<string>();
    for (const c of RESOURCE_FILTER_ORDER) {
      expect(seen.has(c)).toBe(false);
      seen.add(c);
    }
  });

  it('has a label for every chip', () => {
    for (const c of RESOURCE_FILTER_ORDER) {
      expect(RESOURCE_FILTER_LABEL[c]).toBeTruthy();
    }
  });
});

describe('inventoryRowVisible — "show empty" toggle', () => {
  it('hides count=0 rows when showEmpty=false (default)', () => {
    // iron_ore has stock, wood is empty
    expect(inventoryRowVisible('iron_ore', 5, 'all', '', false)).toBe(true);
    expect(inventoryRowVisible('wood', 0, 'all', '', false)).toBe(false);
  });

  it('shows count=0 rows when showEmpty=true', () => {
    expect(inventoryRowVisible('iron_ore', 5, 'all', '', true)).toBe(true);
    expect(inventoryRowVisible('wood', 0, 'all', '', true)).toBe(true);
  });

  it('treats negative stock as empty when showEmpty=false', () => {
    // defensive — shouldn't happen, but the predicate is `<= 0`
    expect(inventoryRowVisible('wood', -1, 'all', '', false)).toBe(false);
    expect(inventoryRowVisible('wood', -1, 'all', '', true)).toBe(true);
  });

  it('applies the activeFilter on top of the showEmpty toggle', () => {
    // wood is a raw — visible under 'raw' filter, hidden under 'fuel'
    expect(inventoryRowVisible('wood', 5, 'raw', '', false)).toBe(true);
    expect(inventoryRowVisible('wood', 5, 'fuel', '', false)).toBe(false);
    // showEmpty doesn't override a category mismatch
    expect(inventoryRowVisible('wood', 0, 'fuel', '', true)).toBe(false);
  });

  it('applies the search query on top of the showEmpty toggle', () => {
    // search matches "iron" — iron_ore visible, wood not
    expect(inventoryRowVisible('iron_ore', 5, 'all', 'iron', false)).toBe(true);
    expect(inventoryRowVisible('wood', 5, 'all', 'iron', false)).toBe(false);
    // showEmpty doesn't override a search miss
    expect(inventoryRowVisible('wood', 0, 'all', 'iron', true)).toBe(false);
  });
});

describe('averageRate', () => {
  const mkInv = (
    over: Partial<Record<ResourceId, number>>,
  ): Record<ResourceId, number> => {
    const base = {} as Record<ResourceId, number>;
    for (const r of ALL_RESOURCES) base[r] = 0;
    return { ...base, ...over };
  };

  it('returns an empty record for fewer than 2 samples', () => {
    expect(averageRate([])).toEqual({});
    expect(averageRate([{ t: 1000, inv: mkInv({ iron_ore: 5 }) }])).toEqual({});
  });

  it('returns an empty record when the span is under 250ms', () => {
    const buffer: RateSample[] = [
      { t: 1000, inv: mkInv({ iron_ore: 0 }) },
      { t: 1100, inv: mkInv({ iron_ore: 10 }) },
    ];
    expect(averageRate(buffer)).toEqual({});
  });

  it('computes a partial-window average over 1s of history', () => {
    const buffer: RateSample[] = [
      { t: 1000, inv: mkInv({ iron_ore: 0 }) },
      { t: 2000, inv: mkInv({ iron_ore: 10 }) },
    ];
    expect(averageRate(buffer).iron_ore).toBeCloseTo(10, 9);
  });

  it('uses only the oldest and newest samples across the window', () => {
    const buffer: RateSample[] = [
      { t: 0, inv: mkInv({ iron_ore: 0 }) },
      { t: 2500, inv: mkInv({ iron_ore: 999 }) }, // midpoint must be ignored
      { t: 5000, inv: mkInv({ iron_ore: 50 }) },
    ];
    expect(averageRate(buffer).iron_ore).toBeCloseTo(10, 9);
  });

  it('reads 0 for a cap-pinned resource (no stock movement)', () => {
    const buffer: RateSample[] = [
      { t: 0, inv: mkInv({ iron_ore: 100 }) },
      { t: 5000, inv: mkInv({ iron_ore: 100 }) },
    ];
    expect(averageRate(buffer).iron_ore).toBe(0);
  });

  it('computes a negative rate for a draining resource', () => {
    const buffer: RateSample[] = [
      { t: 0, inv: mkInv({ coal: 50 }) },
      { t: 2000, inv: mkInv({ coal: 10 }) },
    ];
    expect(averageRate(buffer).coal).toBeCloseTo(-20, 9);
  });
});

describe('pruneRateBuffer', () => {
  const inv = {} as Record<ResourceId, number>; // values irrelevant to pruning

  it('keeps the whole buffer when it spans less than the window', () => {
    const buffer: RateSample[] = [
      { t: 1000, inv },
      { t: 3000, inv },
      { t: 5000, inv },
    ];
    pruneRateBuffer(buffer, 5000);
    expect(buffer.map((s) => s.t)).toEqual([1000, 3000, 5000]);
  });

  it('drops samples older than the window but keeps one past the edge', () => {
    // cutoff = now - RATE_WINDOW_MS = 4000. t=0 and t=1000 are both older
    // than the cutoff; t=1000 is retained as the single sample past the edge
    // so the window still spans a full RATE_WINDOW_MS.
    const now = RATE_WINDOW_MS + 4000;
    const buffer: RateSample[] = [
      { t: 0, inv },
      { t: 1000, inv },
      { t: 4000, inv },
      { t: now, inv },
    ];
    pruneRateBuffer(buffer, now);
    expect(buffer.map((s) => s.t)).toEqual([1000, 4000, now]);
  });

  it('never prunes below 2 samples', () => {
    const buffer: RateSample[] = [
      { t: 0, inv },
      { t: 100, inv },
    ];
    pruneRateBuffer(buffer, 1_000_000);
    expect(buffer.length).toBe(2);
  });
});
