// Pure-helper tests for the inventory modal panel.
//
// The panel itself is DOM and JSDOM isn't configured in this repo (per
// AGENTS.md "tests target the pure layer only"). The interesting logic is
// the resource categorisation table — verified to be complete and to honour
// the Fuel/Liquid precedence rule from the brief.

import { describe, expect, it } from 'vitest';

import {
  RESOURCE_CATEGORY,
  RESOURCE_FILTER_LABEL,
  RESOURCE_FILTER_ORDER,
  inventoryRowVisible,
} from './inventory-ui.js';
import { ALL_RESOURCES } from './recipes.js';

describe('RESOURCE_CATEGORY', () => {
  it('covers every ResourceId', () => {
    for (const r of ALL_RESOURCES) {
      expect(RESOURCE_CATEGORY[r]).toBeDefined();
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
