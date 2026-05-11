// Pure economy math: event-driven piecewise integration per SPEC §15.3.
//
// No PixiJS, no DOM. Functions take an `IslandState` and mutate its
// `inventory`, `xp`, `level`, `unspentSkillPoints`, and `lastTick` fields.
// The pure shape makes the loop independently testable and the offline-catchup
// path (§15.5) trivially correct — the same loop handles 1 frame and 24 hours.
//
// The algorithm at a glance:
//
//   while (t < now) {
//     // 1. Compute per-building rates given current inventory state
//     //    Each building's effective rate = base × inputAvail × outputAvail
//     //    inputAvail is continuous [0,1] (bottleneck ratio)
//     //    outputAvail is binary 0|1 (cap headroom)
//     // 2. Find the next moment something changes (inventory hits 0 or cap)
//     // 3. Integrate over [t, nextEvent] with constant rates
//     // 4. Accrue XP proportional to PRODUCTION (gross outputs), not net flow
//     // 5. Advance t to nextEvent, loop
//   }
//
// Why event-driven: a naive `dt × rate` step over the whole interval would
// overshoot caps (e.g., produce 101 iron_ore when cap is 100) and consume
// inputs after they've gone to zero. Splitting at events keeps each segment
// linear and exact. The integration converges in O(events × resources)
// regardless of `now - lastTick`, so multi-day offline catchup is cheap.

import { IDENTITY_MODIFIER_MULTIPLIERS, type ModifierMultipliers } from './biomes.js';
import { BUILDING_DEFS, type BuildingDef, type BuildingDefId } from './building-defs.js';
import type { PlacedBuilding } from './buildings.js';
import { resolveHeatAssignments, type HeatAssignments } from './heat.js';
import type { TerrainKind } from './island.js';
import { resolveRecipe, XP_WEIGHT, type Recipe, type ResourceId } from './recipes.js';
import { effectiveSkillMultipliers, type NodeId, type SubPathId } from './skilltree.js';
import {
  effectiveSpecializationMultipliers,
  IDENTITY_SPECIALIZATION,
  type RoleId,
  type SpecializationMultipliers,
} from './specialization.js';

/**
 * Optional context object for `computeRates` and `advanceIsland`. Adding
 * new parameters (heat, gates, …) extends this interface rather than
 * growing positional arity.
 */
export interface RatesContext {
  readonly modifierMul?: ModifierMultipliers;
  readonly defs?: DefCatalog;
  readonly specMul?: SpecializationMultipliers;
  readonly ncBuff?: number;
  /** Optional island terrain closure. Threaded to `resolveRecipe` for
   *  tile-dependent recipe selection per §8.1 (Mine produces ore on an
   *  ore-vein footprint, coal on a coal-vein footprint). Undefined =
   *  fall back to the bare-defId recipe (Mine → iron_ore), preserving
   *  pre-tile-aware test/legacy behaviour. The closure is the same
   *  `IslandSpec.terrainAt` field that `renderIsland` consumes — passing
   *  a closure rather than the full IslandSpec keeps economy.ts off the
   *  world.ts import edge. */
  readonly terrainAt?: (x: number, y: number) => TerrainKind;
}

/**
 * The mutable per-island runtime state. `IslandSpec` in world.ts is the
 * static definition (shape, terrain, building positions); `IslandState`
 * carries everything that changes during play. They reference each other
 * by id only.
 */
export interface IslandState {
  /** Stable id matching the IslandSpec this state belongs to. */
  readonly id: string;
  /** Buildings on this island. Live reference to `IslandSpec.buildings` (NOT
   *  a copy — see `makeInitialIslandState`), so step-2.5 placement pushes
   *  into a single shared array and the economy loop sees the new building
   *  on the next tick without an explicit sync step. Recipe lookup is via
   *  RECIPES[b.defId]; per-kind static data (power, footprint) is via
   *  BUILDING_DEFS[b.defId]. */
  buildings: PlacedBuilding[];
  /** Current per-resource stockpile. Missing keys read as 0. */
  inventory: Record<ResourceId, number>;
  /** Per-resource storage cap. Missing keys read as 0 (no storage). */
  readonly storageCaps: Record<ResourceId, number>;
  /** Cumulative XP. Levels are derived by repeatedly draining `xp` against
   *  thresholds; we keep the residual XP toward the next level here. */
  xp: number;
  /** Current level. Starts at 1. Uncapped per §9.1. */
  level: number;
  /** Skill points granted by level-ups but not yet spent. */
  unspentSkillPoints: number;
  /** Set of unlocked skill-tree node ids (§9.3). */
  unlockedNodes: Set<NodeId>;
  /** Per-sub-path progress, sparse: only sub-paths with ≥1 spent point have entries. */
  subPathProgress: Map<SubPathId, { spent: number; complete: boolean }>;
  /** Pending bonus XP credits per resource per §10 (Funneling). When a route
   *  delivers `r` to this island and the island is below the funneling tier
   *  cap, `r × xp_weight[r] × funneling_bonus_percent` accumulates here. The
   *  credit is drained when a local recipe CONSUMES `r` (one bonus-XP unit
   *  per unit consumed, capped at the pending balance). Missing keys read
   *  as 0 — `makeInitialIslandState` seeds all ResourceIds to 0 explicitly
   *  so the deductions in `accrueXp` never see undefined. */
  funnelPending: Record<ResourceId, number>;
  /** §9.4 declared specialization role, or `null` for the Generalist
   *  baseline. Step-10 mutates this exactly once per island (declaration is
   *  one-way; the §9.7 Tier Reset path that clears it back to null is
   *  deferred). The economy reads this each frame via
   *  `effectiveSpecializationMultipliers` to fold the role's buff/penalty
   *  into the rate, storage, and XP multipliers. */
  specializationRole: RoleId | null;
  /** Wall-clock timestamp (ms) at which the player declared the current role.
   *  Null until the first declaration. Carries no economic semantics in
   *  step 10 — it's a UX hook for the §9.7 Tier Reset cooldown timer
   *  (reset disallowed within 24 real-time hours of the last reset). */
  declaredAt: number | null;
  /** §13.1 T5 access gate. Becomes `true` the first time the island has ever
   *  produced (and counted in `production` of) an AI core, and stays true
   *  thereafter. Composed with `level >= 50` by `t5Unlocked` (skilltree.ts) /
   *  `buildingUnlocked` to gate the T5 catalog rows. Step-13 deferral: the
   *  automatic flip-on-first-ai_core production-trigger is deferred to
   *  step 14; in step 13 the flag is seeded manually on the demo island. */
  aiCoreCrafted: boolean;
  /** Wall-clock timestamp of the last advance, in milliseconds. */
  lastTick: number;
}

/**
 * Safe inventory read. `noUncheckedIndexedAccess` makes every `inv[r]`
 * return `number | undefined`, so we centralise the `?? 0` here.
 */
export function inv(state: IslandState, r: ResourceId): number {
  return state.inventory[r] ?? 0;
}

/**
 * Safe cap read; missing key means no storage for that resource. Applies the
 * skill-tree storage multiplier (§9.3 Storage sub-path) so every read path —
 * outputAvail, findNextCapEvent, applyRates — uses the same effective cap.
 *
 * The HUD reads `state.storageCaps[r]` directly (it predates skills) and so
 * still displays nominal caps; the economy uses these effective caps. That
 * UX inconsistency is left to a later step alongside the broader storage UI.
 */
export function cap(state: IslandState, r: ResourceId): number {
  const nominal = state.storageCaps[r] ?? 0;
  if (nominal === 0) return 0;
  const skillMul = effectiveSkillMultipliers(state).storageCap;
  // Specialization storage multiplier (§9.4 logistics_hub) reads from state
  // so every cap()-call site (outputAvail, findNextCapEvent, applyRates, the
  // HUD) sees the same effective cap without threading specMul as a param.
  // Identity role → 1.0, composes cleanly.
  const specMul = effectiveSpecializationMultipliers(state.specializationRole).storageCapMul;
  return nominal * skillMul * specMul;
}

/**
 * Per-building rates as computed at the START of a sub-interval, before
 * integrating. `production` is gross outputs (what the building tries to
 * make per second); `consumption` is gross inputs. `production` is the
 * value that feeds the XP formula per §9.1.
 *
 * Per §15.3 with §5.1 power: `effectiveRate = baseRate × inputAvail ×
 * (consumesPower ? powerFactor : 1)`, where `baseRate = (1/cycleSec) ×
 * outputAvail × buffStack`. `buffStack` (§15.3 — adjacency, specialization,
 * Network Consciousness) is still 1 in step 4; `powerFactor` lives on the
 * `PowerBalance` returned by `computeRates` and is recomputed each call.
 * The four-pass implementation in `computeRates` documents how the
 * inputAvail/powerFactor circular dependency is broken (nominal-rate
 * inputAvail, post-applied powerFactor).
 */
interface BuildingRate {
  readonly building: PlacedBuilding;
  readonly recipe: Recipe;
  /** Cycles per second this building is currently running at. */
  readonly effectiveRate: number;
}

/** Per-kind catalog lookup. Production callers pass `BUILDING_DEFS` (the
 *  default); tests pass a custom catalog when they need to vary per-kind
 *  power values (e.g., the partial-brownout fixture using a 80W Mine). */
export type DefCatalog = Readonly<Record<BuildingDefId, BuildingDef>>;

/**
 * Compute the binary output-availability factor for a recipe.
 *
 * Per §15.3: "binary; 0 = some output bin at cap; back-propagates upstream".
 * If any of the recipe's outputs is at or above cap, the building stalls
 * entirely (no inputs consumed, no outputs produced, no XP).
 */
function outputAvail(state: IslandState, recipe: Recipe): number {
  for (const [r, _yield] of Object.entries(recipe.outputs)) {
    const id = r as ResourceId;
    if (inv(state, id) >= cap(state, id)) return 0;
  }
  return 1;
}

/**
 * Continuous input-availability factor for a single recipe given the
 * island state AND the tentative production rates of every OTHER recipe
 * in the same tick.
 *
 * Per §15.3: continuous [0,1]; 0 = stalled.
 *
 * Two cases for each input resource `r`:
 *
 *   1. inv(r) > 0: there's stockpile to draw from. inputAvail contribution
 *      for `r` is 1; consumption proceeds at full demand and the event
 *      loop will detect inventory depletion if/when it occurs.
 *
 *   2. inv(r) == 0: no stockpile. Demand can only be satisfied from
 *      simultaneous external production (e.g., Mine producing iron_ore
 *      while Workshop consumes it, both at t=0 with iron_ore=0). If
 *      external supply >= demand, inputAvail = 1 (flow-through). If
 *      external supply < demand, inputAvail = supply/demand (continuous
 *      bottleneck). If supply = 0, inputAvail = 0 (truly stalled).
 *
 * The factor for the recipe is the min across all its inputs (any one
 * bottleneck constrains the whole recipe).
 *
 * `externalSupply` is the gross production rate of each resource summed
 * across all candidate buildings EXCLUDING this one's contribution.
 * Note: a recipe doesn't usually self-supply, but the exclusion keeps
 * the math principled.
 */
function inputAvail(
  state: IslandState,
  recipe: Recipe,
  externalSupply: Record<ResourceId, number>,
  baseRate: number,
): number {
  let factor = 1;
  for (const [r, needPerCycle] of Object.entries(recipe.inputs)) {
    const id = r as ResourceId;
    if (inv(state, id) > 0) continue; // stockpile satisfies demand
    const demand = (needPerCycle ?? 0) * baseRate;
    if (demand <= 0) continue;
    const supply = externalSupply[id] ?? 0;
    if (supply <= 0) return 0; // no inventory + no inflow = stalled
    if (supply < demand) factor = Math.min(factor, supply / demand);
  }
  return factor;
}

/** Aggregated electrical balance for an island this tick (§5.1). */
export interface PowerBalance {
  /** Total W produced by active producers. */
  readonly produced: number;
  /** Total W demanded by active consumers (at nominal full draw — output-stalled
   *  consumers still count, only inputAvail = 0 disables them). */
  readonly consumed: number;
  /** `consumed === 0 ? 1 : min(1, produced / consumed)`. */
  readonly factor: number;
}

/**
 * Compute per-building production rates given the current state.
 * Pure function — does not mutate state.
 *
 * Returns:
 *   `byBuilding`: rate info for each operating building, used by the event
 *                 finder and the inventory-update step
 *   `production`: aggregated PRODUCTION-only rates per resource (gross,
 *                 not net of consumption). Drives XP per §9.1.
 *   `net`: aggregated NET rate per resource (production minus consumption).
 *          Drives inventory updates and the event finder.
 *   `power`: aggregated W produced/consumed and the resulting power_factor.
 */
export function computeRates(
  state: IslandState,
  ctx?: RatesContext,
): {
  byBuilding: ReadonlyArray<BuildingRate>;
  production: Record<ResourceId, number>;
  /** Gross consumption rates per resource (always positive). Mirrors
   *  `production`: a building consuming `r` at rate × need contributes
   *  `need × effectiveRate` here. Drives the §10 funneling-credit drain. */
  consumption: Record<ResourceId, number>;
  net: Record<ResourceId, number>;
  power: PowerBalance;
  /** §5.2 heat-assignment snapshot for this tick. Drives the consumer
   *  gate + per-furnace coal multiplier within `computeRates`, and is
   *  surfaced for the inspector UI's heat readout. */
  heat: HeatAssignments;
} {
  const {
    modifierMul = IDENTITY_MODIFIER_MULTIPLIERS,
    defs = BUILDING_DEFS,
    specMul = IDENTITY_SPECIALIZATION,
    ncBuff = 1,
    terrainAt,
  } = ctx ?? {};
  // The §5.1 active flag depends on inputAvail, and inputAvail must be
  // computed at NOMINAL rate (independent of powerFactor) to avoid a circular
  // dependency. PowerFactor is then applied to consumers' final effective
  // rate. As long as all consumers scale by the same factor, the relative
  // supply/demand ratios — and therefore inputAvail — stay correct.
  //
  // Four passes:
  //   1. Tentative baseRate considering only outputAvail (per-recipe cap stall).
  //   2. inputAvail per recipe, using the supply pool from pass 1.
  //   3. P_produced / P_consumed sums over `active` buildings; powerFactor.
  //   4. Final effectiveRate = baseRate × inputAvail × (consumes-power ? powerFactor : 1).
  //
  // Skill multipliers (§9.3) are read once at the top so every pass uses
  // consistent values. Recipe-rate buffs apply to baseRate AND to pass-2's
  // nominalRate (so producer/consumer supply ratios stay correct when only
  // one side is buffed). Power multipliers apply in pass 3.
  const skillMul = effectiveSkillMultipliers(state);
  const buffStack = 1;
  // §5.2: resolve heat assignments BEFORE the per-recipe passes. A consumer
  // with `requiresHeat` and no adjacent Heat Source is forced to baseRate=0
  // in pass-1 (no recipe pickup → no rate, no consumption) and excluded
  // from the pass-3 power balance (per §5.1 "active iff … all gates pass").
  // Coal-source served counts drive a post-pass fuel-burn deduction folded
  // directly into `consumption.coal` / `net.coal`.
  const heat = resolveHeatAssignments(state.buildings);
  interface Tentative {
    readonly building: PlacedBuilding;
    readonly recipe: Recipe;
    /** Base cycles/sec before input-availability throttling. */
    readonly baseRate: number;
  }
  const tentative: Tentative[] = [];
  /** Gross production by resource from all tentatively-running buildings. */
  const tentSupply: Record<ResourceId, number> = {} as Record<ResourceId, number>;
  for (const b of state.buildings) {
    // Tile-aware recipe pickup — see resolveRecipe in recipes.ts. For most
    // buildings this is the same as `RECIPES[def.id]`; Mine branches on
    // its footprint terrain when `terrainAt` is provided.
    const def = defs[b.defId];
    const recipe = resolveRecipe(def, b, terrainAt);
    if (!recipe) continue;
    // §5.2 heat gate: a `requiresHeat` building with no adjacent source
    // is fully stalled this tick — no production, no consumption, no power
    // draw. Recorded as a tentative entry with baseRate=0 so pass-3's
    // power-balance loop also skips it (matched via inputAvail = 0).
    if (def.requiresHeat && heat.hasHeat.get(b.id) !== true) {
      tentative.push({ building: b, recipe, baseRate: 0 });
      continue;
    }
    const oa = outputAvail(state, recipe);
    if (oa === 0) {
      tentative.push({ building: b, recipe, baseRate: 0 });
      continue;
    }
    // Recipe-rate multipliers compose: skill-tree (per-category) × modifier
    // (per-category) × modifier (global) × specialization (per-category) ×
    // specialization (global) × NC global buff. Identity bundles in any of
    // the new factors contribute 1× so existing callers see no change.
    const rateMul =
      (skillMul.recipeRate[recipe.category] ?? 1) *
      (modifierMul.recipeRateByCategory[recipe.category] ?? 1) *
      modifierMul.globalRecipeRate *
      (specMul.recipeRateByCategory[recipe.category] ?? 1) *
      specMul.globalRecipeRate *
      ncBuff;
    const baseRate = (1 / recipe.cycleSec) * buffStack * rateMul;
    tentative.push({ building: b, recipe, baseRate });
    for (const [r, yld] of Object.entries(recipe.outputs)) {
      const id = r as ResourceId;
      tentSupply[id] = (tentSupply[id] ?? 0) + (yld ?? 0) * baseRate;
    }
  }

  // Pass 2: input-availability factor per recipe, computed at the NOMINAL
  // base rate (1 / cycleSec). For an output-stalled building (baseRate = 0),
  // we still need to know its inputAvail because §5.1 active-ness — and
  // therefore power consumption — depends on it independent of output cap.
  // The supply pool excludes this building's own output contribution.
  const inputAvailByIdx = new Array<number>(tentative.length);
  for (let i = 0; i < tentative.length; i++) {
    const t = tentative[i]!;
    // Same compound multiplier as Pass 1 — keeps producer/consumer supply
    // ratios consistent when only one side is buffed.
    const rateMul =
      (skillMul.recipeRate[t.recipe.category] ?? 1) *
      (modifierMul.recipeRateByCategory[t.recipe.category] ?? 1) *
      modifierMul.globalRecipeRate *
      (specMul.recipeRateByCategory[t.recipe.category] ?? 1) *
      specMul.globalRecipeRate *
      ncBuff;
    const nominalRate = (1 / t.recipe.cycleSec) * buffStack * rateMul;
    const externalSupply: Record<ResourceId, number> = {} as Record<ResourceId, number>;
    for (const r of Object.keys(tentSupply) as ResourceId[]) {
      externalSupply[r] = tentSupply[r] ?? 0;
    }
    // Self-exclude only if pass 1 actually contributed (baseRate > 0).
    if (t.baseRate > 0) {
      for (const [r, yld] of Object.entries(t.recipe.outputs)) {
        const id = r as ResourceId;
        externalSupply[id] = (externalSupply[id] ?? 0) - (yld ?? 0) * t.baseRate;
      }
    }
    inputAvailByIdx[i] = inputAvail(state, t.recipe, externalSupply, nominalRate);
  }

  // Pass 3: power balance. A building is `active` for §5.1 iff:
  //   - it has no recipe (Solar / Dock / Crate / Silo — passively active), OR
  //   - its recipe has inputAvail > 0 AND its heat gate (if any) passes.
  // Output-stalled buildings (baseRate = 0 but inputAvail > 0) still count
  // toward P_consumed: the lights are on even when the bin is full. Heat-
  // failed consumers, by contrast, are fully inactive — no power, no
  // production, no consumption — per §5.1 "active iff all gates pass".
  let powerProduced = 0;
  let powerConsumed = 0;
  for (const b of state.buildings) {
    const def = defs[b.defId];
    // §5.2: heat-required consumer with no adjacent source is INACTIVE
    // (zero power draw). Checked before recipe lookup so the gate applies
    // even if the building's recipe is somehow undefined for the variant.
    if (def.requiresHeat && heat.hasHeat.get(b.id) !== true) continue;
    // Same tile-aware resolution as the pass-1 loop. `active` only checks
    // recipe presence here, so the variant chosen doesn't matter — but we
    // pipe it through `resolveRecipe` for symmetry with pass 1 (no caller
    // confusion about which lookup is "the" lookup).
    const recipe = resolveRecipe(def, b, terrainAt);
    let active: boolean;
    if (!recipe) {
      active = true;
    } else {
      const idx = tentative.findIndex((t) => t.building === b);
      const ia = idx >= 0 ? (inputAvailByIdx[idx] ?? 0) : 0;
      active = ia > 0;
    }
    if (!active) continue;
    powerProduced += (def.power?.produces ?? 0) * skillMul.powerProduction;
    // powerConsumption is a "reduction" multiplier (>=1 means lower draw),
    // so we divide. Default 1.0 leaves draw untouched.
    powerConsumed += (def.power?.consumes ?? 0) / skillMul.powerConsumption;
  }
  const powerFactor =
    powerConsumed === 0 ? 1 : Math.min(1, powerProduced / powerConsumed);

  // Pass 4: final effective rate. Apply powerFactor only to consumers
  // (buildings declaring `power.consumes > 0`); producers and neutral
  // buildings ignore it. Output-stalled buildings still finish at 0.
  const byBuilding: BuildingRate[] = [];
  const production: Record<ResourceId, number> = {} as Record<ResourceId, number>;
  const consumption: Record<ResourceId, number> = {} as Record<ResourceId, number>;
  const net: Record<ResourceId, number> = {} as Record<ResourceId, number>;
  for (let i = 0; i < tentative.length; i++) {
    const t = tentative[i]!;
    if (t.baseRate === 0) {
      byBuilding.push({ building: t.building, recipe: t.recipe, effectiveRate: 0 });
      continue;
    }
    const ia = inputAvailByIdx[i] ?? 0;
    const consumesPower = (defs[t.building.defId].power?.consumes ?? 0) > 0;
    const pf = consumesPower ? powerFactor : 1;
    const effectiveRate = t.baseRate * ia * pf;
    byBuilding.push({ building: t.building, recipe: t.recipe, effectiveRate });

    if (effectiveRate === 0) continue;
    for (const [r, yld] of Object.entries(t.recipe.outputs)) {
      const id = r as ResourceId;
      const delta = (yld ?? 0) * effectiveRate;
      production[id] = (production[id] ?? 0) + delta;
      net[id] = (net[id] ?? 0) + delta;
    }
    for (const [r, need] of Object.entries(t.recipe.inputs)) {
      const id = r as ResourceId;
      const delta = (need ?? 0) * effectiveRate;
      consumption[id] = (consumption[id] ?? 0) + delta;
      net[id] = (net[id] ?? 0) - delta;
    }
  }

  // §5.2 coal-furnace fuel burn. Per spec literal: "The Heat Source's fuel
  // consumption multiplies by the number of heat consumers it currently
  // serves." A Coal Furnace with N served consumers burns
  // `coalPerCycle × N / cycleSec` coal per second; with N=0 it burns zero
  // (no implicit "+1 for the furnace's own burn"). Folded into
  // `consumption.coal` / `net.coal` as a post-recipe deduction so
  // `findNextCapEvent` accounts for it when computing the next event.
  // Fixed 30s cycle per §5.2 / §8.5 catalog convention; tied to the def's
  // declared `coalPerCycle` for forward-compat with a future per-furnace
  // efficiency variation.
  const COAL_CYCLE_SEC = 30;
  for (const [furnaceId, servedCount] of heat.coalConsumersByFurnace) {
    if (servedCount <= 0) continue;
    const furnace = state.buildings.find((b) => b.id === furnaceId);
    if (!furnace) continue;
    const def = defs[furnace.defId];
    const coalPerCycle = def.heatSource?.coalPerCycle ?? 0;
    if (coalPerCycle <= 0) continue;
    const burnPerSec = (coalPerCycle * servedCount) / COAL_CYCLE_SEC;
    consumption.coal = (consumption.coal ?? 0) + burnPerSec;
    net.coal = (net.coal ?? 0) - burnPerSec;
  }

  return {
    byBuilding,
    production,
    consumption,
    net,
    power: { produced: powerProduced, consumed: powerConsumed, factor: powerFactor },
    heat,
  };
}

/**
 * Find the next moment in `[tMs, nowMs]` at which the rate-determining state
 * changes — that is, some inventory will reach 0 (input depleted) or some
 * cap (output filled). If nothing changes in the interval, returns `nowMs`.
 *
 * This is the §15.3 `findNextCapEvent`. We extend it to also report
 * input-depletion events because those are equally important for stopping
 * the integration before consuming a resource past zero.
 *
 * `tMs` and `nowMs` are wall-clock millisecond timestamps; `net` is in
 * units-per-second. We convert via /1000.
 */
export function findNextCapEvent(
  state: IslandState,
  net: Record<ResourceId, number>,
  tMs: number,
  nowMs: number,
): number {
  let best = nowMs;
  for (const r of Object.keys(net) as ResourceId[]) {
    const rate = net[r] ?? 0;
    if (rate === 0) continue;
    const current = inv(state, r);
    let timeToEventSec: number;
    if (rate > 0) {
      // Heading toward cap. If already at/over cap (shouldn't normally
      // happen because outputAvail would have zeroed the rate), skip.
      const capVal = cap(state, r);
      const headroom = capVal - current;
      if (headroom <= 0) continue;
      timeToEventSec = headroom / rate;
    } else {
      // rate < 0, heading toward zero. If already at zero, skip — that
      // input would have set inputAvail=0 and we wouldn't be here.
      if (current <= 0) continue;
      timeToEventSec = current / -rate;
    }
    const eventMs = tMs + timeToEventSec * 1000;
    if (eventMs < best) best = eventMs;
  }
  // Guard against floating-point fuzz: if best is microscopically below tMs
  // (e.g. -1e-12), clamp to tMs so the integration progresses one event at
  // a time without looping.
  if (best < tMs) best = tMs;
  return best;
}

/**
 * Apply net rates to inventory over `dtSec`. Clamps results to
 * `[0, cap]` to absorb any sub-microsecond floating-point overshoot. The
 * clamping is defense-in-depth — `findNextCapEvent` should ensure the
 * integration segment ends exactly when the boundary is hit, but the
 * clamp guarantees no NaN-cascade if a rate calculation drifts.
 */
function applyRates(state: IslandState, net: Record<ResourceId, number>, dtSec: number): void {
  for (const r of Object.keys(net) as ResourceId[]) {
    const rate = net[r] ?? 0;
    if (rate === 0) continue;
    const next = inv(state, r) + rate * dtSec;
    const clamped = Math.min(cap(state, r), Math.max(0, next));
    state.inventory[r] = clamped;
  }
}

/**
 * Accrue XP from production over `dtSec`. Per §9.1, only PRODUCTION is
 * weighted (consumption does not subtract XP, and a building whose output
 * is at cap produces zero, so it earns nothing for that segment).
 *
 * §10 Funneling: in addition to production XP, this segment's consumption
 * drains any pending funnel credit accrued from inbound routes. The
 * credit was stored at delivery as `amount × xp_weight × bonus_percent`,
 * so the drain per consumed unit of `r` is exactly `xp_weight × bonus_percent`
 * — pulled from `funnelPending[r]` up to its current balance. Existing
 * funnel credits continue to drain even after the island crosses the
 * tier cap (only further accumulation stops, per §10 literal reading).
 */
function accrueXp(
  state: IslandState,
  production: Record<ResourceId, number>,
  consumption: Record<ResourceId, number>,
  dtSec: number,
  xpMul: number = 1,
): void {
  let gain = 0;
  for (const r of Object.keys(production) as ResourceId[]) {
    const rate = production[r] ?? 0;
    if (rate <= 0) continue;
    const w = XP_WEIGHT[r];
    gain += rate * w * dtSec;
  }
  // Funnel drain: per consumed unit, withdraw bonus XP credit. The pending
  // balance holds units of XP (already multiplied by xp_weight × bonus at
  // delivery time), so each consumed unit costs `xp_weight × bonus` of
  // credit and returns the same amount as XP.
  // FIXME(§10.1): drain treats any consumption of `r` as if it came from
  // imports. Real spec requires per-batch provenance tracking — when local
  // production also consumes `r`, this overcounts the funnel bonus. Invisible
  // in step 7 because the demo has only one consumer per resource per island.
  for (const r of Object.keys(consumption) as ResourceId[]) {
    const rate = consumption[r] ?? 0;
    if (rate <= 0) continue;
    const consumed = rate * dtSec;
    const pending = state.funnelPending[r] ?? 0;
    if (pending <= 0) continue;
    const want = consumed * (XP_WEIGHT[r] ?? 0) * FUNNELING_BONUS_PERCENT_FOR_DRAIN;
    const drawn = Math.min(want, pending);
    state.funnelPending[r] = pending - drawn;
    gain += drawn;
  }
  // §9.4 research_beacon: total XP gain × xpMul (default 1, identity).
  // Applied AFTER the funnel drain so funneled bonus XP also scales — the
  // spec is silent on the interaction but treating the role as a uniform
  // XP multiplier is the simpler invariant.
  state.xp += gain * xpMul;
}

/** Local constant for the funnel-drain math. Mirrors `FUNNELING_BONUS_PERCENT`
 *  in `routes.ts` — the consumption-side drain rate has to match the
 *  delivery-side credit rate, but `economy.ts` predates `routes.ts` and
 *  importing across modules here would invert the dependency. Defining
 *  the constant in both places with a load-bearing comment is the lesser
 *  evil; if the two ever diverge the funnel-drain test (in
 *  `economy.test.ts`) catches it. */
const FUNNELING_BONUS_PERCENT_FOR_DRAIN = 0.5;

/**
 * XP required to reach level `n` from level `n - 1`. Two-segment curve per
 * §9.1: polynomial 100·n^2.2 for n ≤ 50, exponential past 50.
 *
 * `n` is the LEVEL being entered (n=2 is "reach level 2 from level 1").
 * Level 1 is the starting point and costs 0.
 */
export function xpForLevel(n: number): number {
  if (n <= 1) return 0;
  // Rebalanced for idle-game scale, step #19: coefficient ÷4 (100 → 25) so
  // L1→L5 ≈ 1760 XP (~25 min at 1.2 XP/sec). Both segments use 25 to keep
  // the polynomial/exponential boundary continuous at n=50.
  if (n <= 50) return 25 * Math.pow(n, 2.2);
  const at50 = 25 * Math.pow(50, 2.2);
  return at50 * Math.pow(1.2, n - 50);
}

/**
 * Drain accumulated `xp` against level thresholds, leveling up as many times
 * as the buffer supports. Each level grants 1 skill point per §9.1.
 *
 * The XP curve is interpreted as the cost of EACH level transition, not a
 * cumulative total. After leveling up, the residual XP carries forward —
 * a player who overflows level 5 by 30 XP arrives at level 6 with 30 XP
 * banked toward level 7. This matches the typical RPG idiom and keeps the
 * tick-loop math simple (one threshold per check, not cumulative sums).
 */
function levelUpIfReady(state: IslandState): void {
  // Bound the loop defensively — a runaway rate computation shouldn't lock
  // up the tick. 1000 levels in one segment is implausible in normal play.
  for (let safety = 0; safety < 1000; safety++) {
    const need = xpForLevel(state.level + 1);
    if (state.xp < need) return;
    state.xp -= need;
    state.level += 1;
    state.unspentSkillPoints += 1;
  }
}

/**
 * Advance one island from its `lastTick` to `nowMs` via event-driven
 * piecewise integration. Mutates state in place.
 *
 * Loop body per §15.3:
 *   1. computeRates at the current inventory (rates are constant within
 *      a segment by construction)
 *   2. findNextCapEvent — the timestamp of the next inventory transition
 *   3. integrate inventory + accrue XP over [t, nextEvent]
 *   4. levelUpIfReady (the gained XP may cross one or more thresholds)
 *   5. advance t and loop
 *
 * Termination: each iteration either (a) advances t to nowMs and exits, or
 * (b) drives at least one resource to a cap/zero boundary, which changes
 * the rate-set at the next iteration. The number of distinct rate-sets is
 * bounded by 2·|resources| (each resource can be "running" or "stalled"),
 * so the loop is O(resources²) in the worst case. The safety counter is
 * paranoia for floating-point edge cases.
 */
export function advanceIsland(
  state: IslandState,
  nowMs: number,
  ctx?: RatesContext,
): void {
  const { specMul = IDENTITY_SPECIALIZATION } = ctx ?? {};
  if (nowMs <= state.lastTick) {
    state.lastTick = nowMs;
    return;
  }
  let t = state.lastTick;
  for (let safety = 0; safety < 10000; safety++) {
    if (t >= nowMs) break;
    const { production, consumption, net } = computeRates(state, ctx);
    const nextEventMs = findNextCapEvent(state, net, t, nowMs);
    // Clamp to nowMs; findNextCapEvent already returns nowMs when nothing
    // changes, but if all rates are zero we still need to exit the loop.
    const segEndMs = Math.min(nextEventMs, nowMs);
    const dtSec = (segEndMs - t) / 1000;
    if (dtSec > 0) {
      applyRates(state, net, dtSec);
      accrueXp(state, production, consumption, dtSec, specMul.xpMul);
      levelUpIfReady(state);
    }
    // Advance t. If no progress was made (dt = 0 and segEnd === t) but we
    // haven't reached nowMs, force advance to avoid an infinite loop. This
    // can happen if all rates are zero — there's nothing to integrate.
    if (segEndMs <= t) {
      t = nowMs;
    } else {
      t = segEndMs;
    }
  }
  state.lastTick = nowMs;
}
