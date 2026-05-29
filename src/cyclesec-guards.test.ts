import { describe, expect, it } from 'vitest';
import { RECIPES } from './recipes.js';
import { BUILDING_DEFS } from './building-defs.js';
import {
  M,
  densityForRecipe,
  buildingForRecipe,
  outputKg,
  shouldDeriveCycleSec,
  archetypeForRecipe,
} from './recipe-density.js';

// Re-export M so the import is used (it is part of the recipe-density API).
void M;
void densityForRecipe;
void outputKg;

describe('coal loop energy-return is physically sane (§ rebalance: EROI grounded, not ad-hoc)', () => {
  // EROI = (electrical energy a generator yields per unit coal) / (energy spent mining that coal).
  // Anchored to EXTERNAL truth: real-world coal EROI ≈ 30-80×; the pre-rebalance loop was an
  // absurd ~360×. Our physics-derived rate lands ~20× — below the real band but same order and
  // net-positive, which the rebalance spec explicitly accepts ("verify the resulting EROI is
  // sane; it's now grounded, not ad-hoc"). The bounds below are tied to meaningful thresholds,
  // NOT chosen to hug 20×: >1 means coal is worth mining at all; <150 catches a regression back
  // toward the historical 360×.
  const gen = BUILDING_DEFS.coal_gen as any;
  const mine = BUILDING_DEFS[buildingForRecipe('mine_on_coal') as keyof typeof BUILDING_DEFS] as any;
  const genR = (RECIPES as any).coal_gen;
  const mineR = (RECIPES as any).mine_on_coal;

  // kW·s of electricity delivered per unit coal burned.
  const energyOutPerCoal = (gen.power.produces * genR.cycleSec) / genR.inputs.coal;
  // kW·s spent mining one unit coal (mine power draw over the mine_on_coal cycle).
  const energyInPerCoal = (mine.power.consumes * mineR.cycleSec) / mineR.outputs.coal;
  const eroi = energyOutPerCoal / energyInPerCoal;

  it('coal is net-energy-worth-mining (EROI > 1×)', () => {
    expect(eroi).toBeGreaterThan(1);
  });
  it('coal EROI has not regressed toward the historical ~360× (EROI < 150×)', () => {
    expect(eroi).toBeLessThan(150);
  });
  it('a fed generator is net-power-positive', () => {
    // mines needed to sustain one generator = gen coal-demand/s ÷ mine coal-supply/s
    const genCoalPerSec = genR.inputs.coal / genR.cycleSec;
    const mineCoalPerSec = mineR.outputs.coal / mineR.cycleSec;
    const minesPerGen = genCoalPerSec / mineCoalPerSec;
    const netKw = gen.power.produces - minesPerGen * mine.power.consumes;
    expect(netKw).toBeGreaterThan(0);
  });
});

describe('cycleSec spread is structurally sane', () => {
  const NON_FANTASY_CEILING_S = 45 * 86400; // 45 days — TYPO SENTINEL, not a design bound.
  //   The long tail is intentional (no compression; 6-order density spread). Fantasy/endgame
  //   recipes are abstracted and may exceed this; the ceiling only guards REAL recipes against
  //   a density typo / zero that would balloon them to years.
  const derived = Object.keys(RECIPES).filter((id) => {
    const r = (RECIPES as any)[id];
    return r && shouldDeriveCycleSec(r);
  });

  it('every derived recipe has a finite cycleSec ≥ 1s (no NaN/Infinity, no sub-floor)', () => {
    for (const id of derived) {
      const c = (RECIPES as any)[id].cycleSec;
      expect(Number.isFinite(c), `${id} cycleSec=${c}`).toBe(true);
      expect(c, `${id} cycleSec=${c}`).toBeGreaterThanOrEqual(1);
    }
  });
  it('no NON-fantasy derived recipe exceeds the typo-sentinel ceiling', () => {
    for (const id of derived) {
      if (archetypeForRecipe(id)?.startsWith('fantasy')) continue; // fantasy abstracted/exempt
      const c = (RECIPES as any)[id].cycleSec;
      expect(c, `${id} cycleSec=${c}s exceeds ${NON_FANTASY_CEILING_S}s sentinel`).toBeLessThanOrEqual(NON_FANTASY_CEILING_S);
    }
  });
});
