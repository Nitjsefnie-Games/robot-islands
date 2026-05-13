// Tests for the §4.6 resource → storage-category mapping. The mapping is
// pure data, but the catalog has ~50 resources and the test ensures every
// one is bucketed and the category names are well-formed.

import { describe, expect, it } from 'vitest';

import { ALL_RESOURCES } from './recipes.js';
import {
  RESOURCE_STORAGE_CATEGORY,
  type StorageCategory,
} from './storage-categories.js';

const ALL_CATEGORIES: ReadonlyArray<StorageCategory> = [
  'dry_goods',
  'liquid_gas',
  'temp_sensitive',
  'components',
  'rare',
];

describe('RESOURCE_STORAGE_CATEGORY (§4.6)', () => {
  it('assigns every ResourceId to a category', () => {
    for (const r of ALL_RESOURCES) {
      const cat = RESOURCE_STORAGE_CATEGORY[r];
      expect(cat, `missing storage category for ${r}`).toBeDefined();
      // Cast through `as string` so the includes check works under the
      // strict ReadonlyArray<StorageCategory> type — the runtime check is
      // value-equality regardless.
      expect(ALL_CATEGORIES as ReadonlyArray<string>).toContain(cat as string);
    }
  });

  it('categories are well-formed lower-snake strings', () => {
    for (const r of ALL_RESOURCES) {
      const cat = RESOURCE_STORAGE_CATEGORY[r];
      expect(cat).toMatch(/^[a-z]+(_[a-z]+)*$/);
    }
  });

  it('§4.6 spot checks: representative resources land in the right buckets', () => {
    // Dry goods — T0 raws + T1 refined dry.
    expect(RESOURCE_STORAGE_CATEGORY.wood).toBe('dry_goods');
    expect(RESOURCE_STORAGE_CATEGORY.iron_ore).toBe('dry_goods');
    expect(RESOURCE_STORAGE_CATEGORY.coal).toBe('dry_goods');
    expect(RESOURCE_STORAGE_CATEGORY.stone).toBe('dry_goods');
    expect(RESOURCE_STORAGE_CATEGORY.iron_ingot).toBe('dry_goods');
    expect(RESOURCE_STORAGE_CATEGORY.foundation_kit).toBe('dry_goods');
    expect(RESOURCE_STORAGE_CATEGORY.scrap).toBe('dry_goods');

    // Liquid / gas — water, oil, gas, fuels.
    expect(RESOURCE_STORAGE_CATEGORY.fresh_water).toBe('liquid_gas');
    expect(RESOURCE_STORAGE_CATEGORY.saltwater).toBe('liquid_gas');
    expect(RESOURCE_STORAGE_CATEGORY.crude_oil).toBe('liquid_gas');
    expect(RESOURCE_STORAGE_CATEGORY.natural_gas).toBe('liquid_gas');
    expect(RESOURCE_STORAGE_CATEGORY.hydrogen).toBe('liquid_gas');
    expect(RESOURCE_STORAGE_CATEGORY.biofuel).toBe('liquid_gas');
    expect(RESOURCE_STORAGE_CATEGORY.diesel).toBe('liquid_gas');
    expect(RESOURCE_STORAGE_CATEGORY.lubricant).toBe('liquid_gas');
    expect(RESOURCE_STORAGE_CATEGORY.aviation_kerosene).toBe('liquid_gas');
    expect(RESOURCE_STORAGE_CATEGORY.plasma_charge).toBe('liquid_gas');

    // Temp-sensitive — cryo_coolant is the sole live member until
    // cryogenic_compound / liquid_nitrogen / plastics are catalogued.
    expect(RESOURCE_STORAGE_CATEGORY.cryo_coolant).toBe('temp_sensitive');

    // Components — manufactured T2/T3 parts.
    expect(RESOURCE_STORAGE_CATEGORY.bolt).toBe('components');
    expect(RESOURCE_STORAGE_CATEGORY.gear).toBe('components');
    expect(RESOURCE_STORAGE_CATEGORY.wire).toBe('components');
    expect(RESOURCE_STORAGE_CATEGORY.microchip).toBe('components');
    expect(RESOURCE_STORAGE_CATEGORY.quantum_chip).toBe('components');

    // Rare — T4-T5 valuables.
    expect(RESOURCE_STORAGE_CATEGORY.helium_3).toBe('rare');
    expect(RESOURCE_STORAGE_CATEGORY.ai_core).toBe('rare');
    expect(RESOURCE_STORAGE_CATEGORY.exotic_alloy).toBe('rare');
    expect(RESOURCE_STORAGE_CATEGORY.reality_anchor).toBe('rare');
    expect(RESOURCE_STORAGE_CATEGORY.dark_matter).toBe('rare');
    expect(RESOURCE_STORAGE_CATEGORY.strange_matter).toBe('rare');
  });

  it('temp_sensitive category contains the expected cryogenic resources', () => {
    // §4.6 Cold Storage consumers: cryo_coolant is the only catalogued
    // cryogenic resource today. cryogenic_compound and liquid_nitrogen
    // are deferred; no plastics exist in the current catalog.
    const tempSensitiveResources = ALL_RESOURCES.filter(
      (r) => RESOURCE_STORAGE_CATEGORY[r] === 'temp_sensitive',
    );
    expect(tempSensitiveResources).toContain('cryo_coolant');
    expect(tempSensitiveResources.length).toBeGreaterThanOrEqual(1);
  });

  it('every category has at least one assigned resource', () => {
    // Sanity: each non-empty category in the spec must have at least one
    // member in the current catalog so the corresponding specialized
    // storage building actually does something on placement.
    const counts: Record<StorageCategory, number> = {
      dry_goods: 0,
      liquid_gas: 0,
      temp_sensitive: 0,
      components: 0,
      rare: 0,
    };
    for (const r of ALL_RESOURCES) {
      counts[RESOURCE_STORAGE_CATEGORY[r]] += 1;
    }
    expect(counts.dry_goods).toBeGreaterThan(0);
    expect(counts.liquid_gas).toBeGreaterThan(0);
    expect(counts.components).toBeGreaterThan(0);
    expect(counts.rare).toBeGreaterThan(0);
    // temp_sensitive now has a live member (cryo_coolant) so it must
    // be non-zero like every other category.
    expect(counts.temp_sensitive).toBeGreaterThan(0);
  });
});
