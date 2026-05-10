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

import type { Building } from './buildings.js';
import { RECIPES, XP_WEIGHT, type Recipe, type ResourceId } from './recipes.js';

/**
 * The mutable per-island runtime state. `IslandSpec` in world.ts is the
 * static definition (shape, terrain, building positions); `IslandState`
 * carries everything that changes during play. They reference each other
 * by id only.
 */
export interface IslandState {
  /** Stable id matching the IslandSpec this state belongs to. */
  readonly id: string;
  /** Buildings on this island (mirrored from spec, kept here so the economy
   *  loop never needs the spec). Recipe lookup is via RECIPES[kind]. */
  readonly buildings: ReadonlyArray<Building>;
  /** Current per-resource stockpile. Missing keys read as 0. */
  inventory: Record<ResourceId, number>;
  /** Per-resource storage cap. Missing keys read as 0 (no storage). */
  readonly storageCaps: Record<ResourceId, number>;
  /** Cumulative XP. Levels are derived by repeatedly draining `xp` against
   *  thresholds; we keep the residual XP toward the next level here. */
  xp: number;
  /** Current level. Starts at 1. Uncapped per §9.1. */
  level: number;
  /** Skill points granted by level-ups but not yet spent. Step 3 has no
   *  skill-tree UI so these only accumulate. */
  unspentSkillPoints: number;
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

/** Safe cap read; missing key means no storage for that resource. */
export function cap(state: IslandState, r: ResourceId): number {
  return state.storageCaps[r] ?? 0;
}

/**
 * Per-building rates as computed at the START of a sub-interval, before
 * integrating. `production` is gross outputs (what the building tries to
 * make per second); `consumption` is gross inputs. `production` is the
 * value that feeds the XP formula per §9.1.
 *
 * For step 3, `effectiveRate = (1 / cycleSec) × inputAvail × outputAvail`.
 * `powerFactor` (§5.1) and `buffStack` (§15.3) are 1 and folded into the
 * formula explicitly so future steps can extend without restructuring.
 */
interface BuildingRate {
  readonly building: Building;
  readonly recipe: Recipe;
  /** Cycles per second this building is currently running at. */
  readonly effectiveRate: number;
}

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
export function computeRates(state: IslandState): {
  byBuilding: ReadonlyArray<BuildingRate>;
  production: Record<ResourceId, number>;
  net: Record<ResourceId, number>;
  power: PowerBalance;
} {
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
  const buffStack = 1;
  interface Tentative {
    readonly building: Building;
    readonly recipe: Recipe;
    /** Base cycles/sec before input-availability throttling. */
    readonly baseRate: number;
  }
  const tentative: Tentative[] = [];
  /** Gross production by resource from all tentatively-running buildings. */
  const tentSupply: Record<ResourceId, number> = {} as Record<ResourceId, number>;
  for (const b of state.buildings) {
    const recipe = RECIPES[b.kind];
    if (!recipe) continue;
    const oa = outputAvail(state, recipe);
    if (oa === 0) {
      tentative.push({ building: b, recipe, baseRate: 0 });
      continue;
    }
    const baseRate = (1 / recipe.cycleSec) * buffStack;
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
    const nominalRate = (1 / t.recipe.cycleSec) * buffStack;
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

  // Pass 3: power balance. A building is `active` for §5.1 iff its recipe
  // has inputAvail > 0 (gates are deferred — terrain/heat land later). A
  // recipe-less building (e.g., Solar Panel) is unconditionally active.
  // Output-stalled buildings (baseRate = 0 but inputAvail > 0) still count
  // toward P_consumed: the lights are on even when the bin is full.
  let powerProduced = 0;
  let powerConsumed = 0;
  for (const b of state.buildings) {
    const recipe = RECIPES[b.kind];
    let active: boolean;
    if (!recipe) {
      active = true;
    } else {
      const idx = tentative.findIndex((t) => t.building === b);
      const ia = idx >= 0 ? (inputAvailByIdx[idx] ?? 0) : 0;
      active = ia > 0;
    }
    if (!active) continue;
    powerProduced += b.power?.produces ?? 0;
    powerConsumed += b.power?.consumes ?? 0;
  }
  const powerFactor =
    powerConsumed === 0 ? 1 : Math.min(1, powerProduced / powerConsumed);

  // Pass 4: final effective rate. Apply powerFactor only to consumers
  // (buildings declaring `power.consumes > 0`); producers and neutral
  // buildings ignore it. Output-stalled buildings still finish at 0.
  const byBuilding: BuildingRate[] = [];
  const production: Record<ResourceId, number> = {} as Record<ResourceId, number>;
  const net: Record<ResourceId, number> = {} as Record<ResourceId, number>;
  for (let i = 0; i < tentative.length; i++) {
    const t = tentative[i]!;
    if (t.baseRate === 0) {
      byBuilding.push({ building: t.building, recipe: t.recipe, effectiveRate: 0 });
      continue;
    }
    const ia = inputAvailByIdx[i] ?? 0;
    const consumesPower = (t.building.power?.consumes ?? 0) > 0;
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
      net[id] = (net[id] ?? 0) - delta;
    }
  }

  return {
    byBuilding,
    production,
    net,
    power: { produced: powerProduced, consumed: powerConsumed, factor: powerFactor },
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
 */
function accrueXp(
  state: IslandState,
  production: Record<ResourceId, number>,
  dtSec: number,
): void {
  let gain = 0;
  for (const r of Object.keys(production) as ResourceId[]) {
    const rate = production[r] ?? 0;
    if (rate <= 0) continue;
    const w = XP_WEIGHT[r];
    gain += rate * w * dtSec;
  }
  state.xp += gain;
}

/**
 * XP required to reach level `n` from level `n - 1`. Two-segment curve per
 * §9.1: polynomial 100·n^2.2 for n ≤ 50, exponential past 50.
 *
 * `n` is the LEVEL being entered (n=2 is "reach level 2 from level 1").
 * Level 1 is the starting point and costs 0.
 */
export function xpForLevel(n: number): number {
  if (n <= 1) return 0;
  if (n <= 50) return 100 * Math.pow(n, 2.2);
  const at50 = 100 * Math.pow(50, 2.2);
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
export function advanceIsland(state: IslandState, nowMs: number): void {
  if (nowMs <= state.lastTick) {
    state.lastTick = nowMs;
    return;
  }
  let t = state.lastTick;
  for (let safety = 0; safety < 10000; safety++) {
    if (t >= nowMs) break;
    const { production, net } = computeRates(state);
    const nextEventMs = findNextCapEvent(state, net, t, nowMs);
    // Clamp to nowMs; findNextCapEvent already returns nowMs when nothing
    // changes, but if all rates are zero we still need to exit the loop.
    const segEndMs = Math.min(nextEventMs, nowMs);
    const dtSec = (segEndMs - t) / 1000;
    if (dtSec > 0) {
      applyRates(state, net, dtSec);
      accrueXp(state, production, dtSec);
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
