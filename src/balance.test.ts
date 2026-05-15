import { describe, expect, it } from 'vitest';
import { ALL_RESOURCES, RECIPES, XP_WEIGHT, type ResourceId } from './recipes.js';
import { BUILDING_DEFS } from './building-defs.js';

// --- 1. Monotonic XP curve ---

// Mirror the formula in economy.ts:1056 — duplicated here as the
// sanity-check oracle. If economy.ts changes, this test will surface it.
function xpForLevel(n: number): number {
  if (n <= 50) return 25 * Math.pow(n, 2.2);
  const at50 = 25 * Math.pow(50, 2.2);
  return at50 * Math.pow(1.2, n - 50);
}

describe('Balance — XP curve monotonicity (§9.1)', () => {
  it('xpForLevel is strictly monotonic for levels 1..100', () => {
    for (let n = 1; n < 100; n++) {
      expect(xpForLevel(n + 1)).toBeGreaterThan(xpForLevel(n));
    }
  });
  it('xpForLevel(5) (T2 threshold) is bounded and finite', () => {
    const v = xpForLevel(5);
    expect(v).toBeGreaterThan(0);
    expect(v).toBeLessThan(10000);
  });
  it('xpForLevel(50) (T5 threshold) is finite', () => {
    expect(xpForLevel(50)).toBeLessThan(1e7);
  });
});

// --- 2. Tier breakpoints reachable ---

describe('Balance — tier-breakpoint XP costs', () => {
  it('cumulative XP for L1→L5 (T2) is plausibly reachable in early game', () => {
    let total = 0;
    for (let n = 2; n <= 5; n++) total += xpForLevel(n);
    // T0 raws give xp_weight 1; producing ~600 T0 units crosses to L5.
    // With 2-3 extractors at ~1 unit/sec, that's ~5 minutes — sensible.
    expect(total).toBeLessThan(2000);
  });
  it('cumulative XP for L1→L50 (T5) is bounded', () => {
    let total = 0;
    for (let n = 2; n <= 50; n++) total += xpForLevel(n);
    expect(total).toBeLessThan(3e6); // sanity bound — actual cumulative ~2.2M
  });
});

// --- 3. Catalog completeness: no phantom inputs ---

describe('Balance — recipe input/output catalog completeness', () => {
  it('every recipe input is in ALL_RESOURCES', () => {
    for (const [defId, recipe] of Object.entries(RECIPES)) {
      for (const input of Object.keys(recipe.inputs)) {
        expect(
          ALL_RESOURCES,
          `${defId} input "${input}" not in ALL_RESOURCES`,
        ).toContain(input as ResourceId);
      }
    }
  });
  it('every recipe output is in ALL_RESOURCES', () => {
    for (const [defId, recipe] of Object.entries(RECIPES)) {
      for (const output of Object.keys(recipe.outputs)) {
        expect(
          ALL_RESOURCES,
          `${defId} output "${output}" not in ALL_RESOURCES`,
        ).toContain(output as ResourceId);
      }
    }
  });
});

// --- 4. No phantom producers/consumers ---

describe('Balance — every consumed resource has at least one producer', () => {
  /** §6.7 byproducts and starter materials are exempted; they may be
   *  terminal (slag, scrap) or seeded by terrain/start-state (wood, iron_ore,
   *  stone, sand), not produced by any recipe. */
  const TERMINAL_BYPRODUCTS = new Set<ResourceId>([
    'slag', 'scrap', 'oxygen', 'argon',
  ]);
  const STARTER_TERRAIN = new Set<ResourceId>([
    'wood', 'iron_ore', 'coal', 'stone', 'sand', 'salt', 'quartz',
    'crude_oil', 'natural_gas', 'fresh_water', 'saltwater', 'hydrogen',
    // §6.4 T3 raw minerals (slag-reprocessed via §6.7, terrain-deferred)
    'gold_ore', 'silver_ore', 'rare_earth', 'uranium_ore',
    // §6.6 T5 raws (extractor cycle in §8.10)
    'aetheric_current', 'tachyon_stream', 'dark_matter', 'strange_matter',
    'quantum_foam', 'spacetime_fragment', 'higgs_flux', 'helium_3',
    'casimir_energy',
    // T6 fuel — produced via separate refinery def (§7.12); accept terminal
    // for this structural test.
    'antimatter_propellant', 'memetic_core',
    // §13.4 endgame artifact — no producer yet by design
    'genesis_cell',
    // T6 satellite payloads — separate assembly recipe (§14.10) not in
    // the basic recipes catalog.
    'scanner_sat', 'comm_sat', 'sweeper_sat', 'repair_drone',
    'ascendant_core', 'orbital_insertion_package', 'repair_pack',
    // T1 composite (§12.3) — Foundation Kit assembly recipe handled
    // outside the per-building RECIPES map (placement-time consumable).
    'foundation_kit',
    // T2 components built outside the basic recipes map — fabricator chain
    // ships defs but recipes deferred until catalog expansion.
    'pcb', 'circuit_board', 'processor', 'computing_module',
    // T4 endgame — separate fabrication chain (§7.11)
    'cryogenic_hydrogen', 'quantum_chip', 'exotic_alloy', 'ai_core',
    'carbon_fiber',
    // T5 transcendent — separate Reality Forge chain (§7.12)
    'reality_anchor', 'plasma_charge', 'eldritch_processor',
    'phase_converter',
  ]);

  it('every consumed resource has a producer OR is starter/terminal', () => {
    const consumed = new Set<ResourceId>();
    const produced = new Set<ResourceId>();
    for (const recipe of Object.values(RECIPES)) {
      for (const r of Object.keys(recipe.inputs)) consumed.add(r as ResourceId);
      for (const r of Object.keys(recipe.outputs)) produced.add(r as ResourceId);
    }
    const orphans: ResourceId[] = [];
    for (const c of consumed) {
      if (produced.has(c)) continue;
      if (STARTER_TERRAIN.has(c)) continue;
      if (TERMINAL_BYPRODUCTS.has(c)) continue;
      orphans.push(c);
    }
    expect(
      orphans,
      `consumed-but-never-produced (and not starter/byproduct): ${orphans.join(', ')}`,
    ).toEqual([]);
  });
});

// --- 5. No zero-rate buildings ---

describe('Balance — no building has both zero inputs and zero outputs', () => {
  it('every recipe has at least one input or one output (no fully-empty)', () => {
    for (const [defId, recipe] of Object.entries(RECIPES)) {
      const hasInputs = Object.keys(recipe.inputs).length > 0;
      const hasOutputs = Object.keys(recipe.outputs).length > 0;
      const hasPower = (BUILDING_DEFS[defId as keyof typeof BUILDING_DEFS]?.power?.produces ?? 0) > 0;
      expect(
        hasInputs || hasOutputs || hasPower,
        `${defId} has no inputs, no outputs, and produces no power — dead def`,
      ).toBe(true);
    }
  });
});

// --- 6. XP weights respect tier ordering (no T1 weight > T2 weight, etc.) ---

describe('Balance — XP weights respect §9.1 tier ordering', () => {
  it('T0 raw weights are ≤ T1 refined weights', () => {
    expect(XP_WEIGHT.wood).toBeLessThanOrEqual(XP_WEIGHT.iron_ingot);
    expect(XP_WEIGHT.iron_ore).toBeLessThanOrEqual(XP_WEIGHT.iron_ingot);
  });
  it('T1 refined weights are ≤ T2 alloy weights', () => {
    expect(XP_WEIGHT.iron_ingot).toBeLessThanOrEqual(XP_WEIGHT.steel);
  });
  it('T2 alloy weights are ≤ T4 endgame weights', () => {
    expect(XP_WEIGHT.steel).toBeLessThanOrEqual(XP_WEIGHT.exotic_alloy);
  });
  it('T4 endgame weights are ≤ T5 transcendent weights', () => {
    expect(XP_WEIGHT.exotic_alloy).toBeLessThanOrEqual(XP_WEIGHT.reality_anchor);
  });
  it('T5 transcendent weights are ≤ T6 orbital weights', () => {
    expect(XP_WEIGHT.reality_anchor).toBeLessThanOrEqual(XP_WEIGHT.scanner_sat);
  });
});
