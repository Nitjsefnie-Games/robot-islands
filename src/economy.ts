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

import { checkGates, computeBuffStack } from './adjacency.js';
import { IDENTITY_MODIFIER_MULTIPLIERS, type ModifierMultipliers } from './biomes.js';
import { nextConstructionCompletionMs, tickConstruction } from './construction.js';
import { RESOURCE_STORAGE_CATEGORY } from './storage-categories.js';
import {
  BUILDING_DEFS,
  buildingUnlocked,
  type BuildingDef,
  type BuildingDefId,
} from './building-defs.js';
import { hasOperationalBuilding, isOperationalBuilding, type PlacedBuilding } from './buildings.js';
import type { WorldState } from './world.js';
import { isOceanTile } from './world.js';
import { dayPhaseName, nextPhaseBoundaryMs, nextSolarBoundaryMs, solarMultiplier } from './daynight.js';
import { weather } from './weather.js';
import { resolveHeatAssignments, type HeatAssignments } from './heat.js';
import type { TerrainKind } from './island.js';
import { footprintTiles } from './shape-mask.js';
import {
  accrueOperatingTime,
  maintenanceFactor,
  nextMaintenanceBoundaryMs,
  pickMostDegradedTarget,
  tryAutoMaintain,
} from './maintenance.js';
import { advanceToxicityRolls, toxicityMultiplier } from './reactor-toxicity.js';
import { makeSeededRng } from './rng.js';
import { nextRotateOutputBoundaryMs, resolveRecipe, resolveRotatingOutput, XP_WEIGHT, type Recipe, type ResourceId } from './recipes.js';
import { effectiveSkillMultipliers, skillPointsForLevelUp, type NodeId, effectiveTierShift, tierForLevel, skillUnlockedAdjacencyRules, type SkillMultipliers, DEFAULT_GRAPH, type ConditionalEffectCondition } from './skilltree.js';
import type { CrystalId, EdgeId, Graph } from './skilltree-graph.js';
import { networkedIslandIds } from './network-consciousness.js';

/** Per-battery-def electrical buffer capacity in W-seconds. Summed across
 *  every operational battery on an island to compute total cap. Buildings
 *  not in this table contribute 0 — non-battery buildings ignore the path. */
export const BATTERY_CAPACITY_WS: Readonly<Partial<Record<BuildingDefId, number>>> = {
  battery_bank:        5_000      * 3600,
  capacitor_bank:      100_000    * 3600,
  flywheel_array:      2_000_000  * 3600,
  singularity_battery: 50_000_000 * 3600,
};

/** Total per-island battery capacity in W-seconds, summed across operational
 *  batteries × the skill-tree batteryCapacity multiplier. */
export function batteryCapacityWs(state: IslandState, mul: SkillMultipliers): number {
  let raw = 0;
  for (const b of state.buildings) {
    if (!isOperationalBuilding(b)) continue;
    const per = BATTERY_CAPACITY_WS[b.defId] ?? 0;
    raw += per;
  }
  return raw * mul.batteryCapacity;
}

/**
 * §4 ocean-layer paused-state reasons (Task 10). Set on `PlacedBuilding.paused`
 * by `computeRates` when an ocean platform's preconditions fail; cleared
 * (undefined) when they recover. Per the §4 design doc edge cases:
 *
 *   - `'anchor-depopulated'`: the platform's `anchorIslandId` names an
 *     island that no longer exists OR whose `populated` flag is false.
 *     The anchor was abandoned, tier-reset, or deleted — the platform has
 *     no inventory to credit and no power pool to draw from, so it halts
 *     entirely. Repopulating the anchor clears the state.
 *   - `'terrain-lost'`: the cell the platform sits on is no longer ocean
 *     (defensive — would require future land-reclamation to overlap the
 *     cell; not expected in initial scope). Mirrors §4's "Terrain access
 *     lost (hypothetical future event removing a vent)" edge case.
 *
 * `'anchor-disconnected'` (in the original spec draft) was dropped in the
 * a92efa2 revision: `submarine_cable` is a `RouteType` rather than a
 * tile-placed component, so there's no cable-graph to break. Anchoring is
 * a declarative field, not a graph relationship.
 */
export type PausedReason = 'anchor-depopulated' | 'terrain-lost';

/**
 * Optional context object for `computeRates` and `advanceIsland`. Adding
 * new parameters (heat, gates, …) extends this interface rather than
 * growing positional arity.
 */
export interface RatesContext {
  readonly modifierMul?: ModifierMultipliers;
  readonly defs?: DefCatalog;
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
  /** §13.3 acceleration multiplier from Time Lock spend. Default 1 (no acceleration). */
  readonly accelerationMul?: number;
  /** World seed for deterministic §8.10 output rotation. */
  readonly worldSeed?: string;
  /** §3.5 Geothermal Active: free heat for all requiresHeat buildings on this island. */
  readonly geothermalActive?: boolean;
  /** §13.3 Omniscient Lattice: unified inventory override. When provided,
   *  `inputAvail` stockpile checks read from this map instead of the local
   *  island inventory, enabling cross-island consumption. */
  readonly inventory?: Record<ResourceId, number>;
  /** §13.3 Omniscient Lattice: buildings on other lattice islands that count
   *  as neighbors for buff-adjacency and gate-adjacency despite physical
   *  distance. */
  readonly crossIsland?: ReadonlyArray<PlacedBuilding>;
  /** §13.3 Omniscient Lattice: unified storage-cap override. When provided,
   *  `cap()` reads from this map instead of the local island storageCaps,
   *  enabling summed caps across the Lattice network. */
  readonly caps?: Record<ResourceId, number>;
  /** Pre-computed base SkillMultipliers for this advanceIsland call.
   *  Read-only. Populated by advanceIsland at the top of the call;
   *  threaded into cap() (and its inner-loop callers) so we don't
   *  recompute the skill-mul fold per cap() invocation. Consumers
   *  must NOT layer conditional bonuses onto this object —
   *  that's a separate per-segment local in computeRates. */
  readonly baseMult?: SkillMultipliers;
  /** §5.3 Inter-island cable network balance for THIS island's connected-
   *  cable component this tick. When `cableComponent.unified === true`,
   *  Pass 3 replaces this island's local `producedW / consumedW` brownout
   *  with the component-wide `producedTotal / consumedTotal` brownout —
   *  every island in the component shares one brownout factor. When `false`
   *  (or undefined), Pass 3 falls back to local raw balance and cables are
   *  inert for this tick. Pre-computed once per tick by
   *  `computeCableNetworkBalance` (routes.ts) and threaded per-island into
   *  the ctx by main.ts. */
  readonly cableComponent?: CableComponentBalance;
  /** §14.3 Mirror Sat aggregate boost: sum of `mirrorBoost(sat, islandCentre)`
   *  over every locked mirror sat in the world whose contribution survives
   *  the per-sat 0.05 cutoff. Composes additively with `solarMultiplier(t)`
   *  in the §2.7 gate (`effectiveSolar = min(1, ramp + Σ boost)`). Default 0
   *  preserves baseline §2.7 behaviour for islands without any mirror
   *  coverage (and for unit tests that omit it). Pre-computed once per
   *  island per tick in main.ts via `effectiveSolarBoostFor`. */
  readonly solarBoost?: number;
  /** §4 ocean-layer (Task 10). Threaded into `computeRates` so an ocean
   *  platform's anchor-populated / cell-still-ocean checks can resolve
   *  against the live world. Optional for back-compat with the many tests
   *  and legacy callers that pre-date the ocean layer — when omitted, any
   *  building with `def.oceanPlacement === true` is treated as paused with
   *  reason `'anchor-depopulated'` (defensive: with no world to resolve
   *  the anchor, the platform cannot safely produce). Production callers
   *  (main.ts) MUST pass `world` so platforms function. */
  readonly world?: WorldState;
  /** terrain_modifier v5 callback — invoked once per modifier whose shot
   *  countdown reached ≤ 0 in the current segment. Receives the building's
   *  id; the caller (main.ts) is expected to dispatch resolveShot + a
   *  rebuildWorldLayers() call. The callback fires INSIDE advanceIsland so
   *  multi-segment catch-up resolves shots in simulated-time order. */
  readonly onTerrainShotFire?: (buildingId: string) => void;
}

/**
 * §5.3 per-component cable-network balance for one tick. Produced by
 * `computeCableNetworkBalance` (routes.ts); consumed in `computeRates` Pass 3.
 *
 * Per-tick, per connected-cable component:
 *   - `producedTotal` / `consumedTotal` sum local raw W across every island
 *     in the component (pre-Singularity-Battery — the battery is local-only).
 *   - `requiredTransmission = min(surplus, deficit)` is the wattage that
 *     must physically traverse cables to balance the component.
 *   - The gate passes iff `cableCapacityTotal >= requiredTransmission`. T5
 *     Spacetime Anchor links (`route.type === 'spacetime'`) count as
 *     infinite-capacity for this gate, so any component containing one
 *     trivially passes.
 *   - When `unified === true`, every island in the component shares the
 *     brownout factor `min(1, producedTotal / consumedTotal)`. When false,
 *     each island falls back to its own local balance (cables inert for
 *     this tick). Binary — no partial flow.
 *
 * Islands with no cable / spacetime route touching them get a synthetic
 * trivial component (`unified: false`, capacity 0, equivalent to "no cables").
 */
export interface CableComponentBalance {
  readonly unified: boolean;
  readonly producedTotal: number;
  readonly consumedTotal: number;
  readonly cableCapacityTotal: number;
  readonly requiredTransmission: number;
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
  /** Set of unlocked skill-tree node ids (§9.3).
   *  Mutations must bump `auraAmpVersion` — see §05 of the
   *  adjacency-cache spec for the enumerated mutation sites. */
  unlockedNodes: Set<NodeId>;
  /** Set of owned graph edge ids. An edge can be owned even when its endpoint
   *  is reached via another path (redundant unlocks are allowed).
   *  Mutations must bump `auraAmpVersion` — see §05 of the
   *  adjacency-cache spec for the enumerated mutation sites. */
  unlockedEdges: Set<EdgeId>;
  /** §perf-2026-05-27 adjacency-cache Layer 2: bumped on every mutation
   *  of `unlockedNodes` / `unlockedEdges`. Cache key for
   *  computeAuraAmplifiers' per-state aura-amp memoization. Starts at 0;
   *  monotonically increases. See spec §05 for the enumerated bump sites. */
  auraAmpVersion: number;
  /** Memoized `computeAuraAmplifiers` result. Null on cold start /
   *  post-load (seeded by deserialize). Valid iff
   *  `auraAmpCacheVersion === auraAmpVersion`. NOT persisted — stripped on
   *  serialize. Callers MUST treat the returned `Map` as read-only — mutating
   *  it poisons the cache for all subsequent reads. */
  auraAmpCache: Map<NodeId, number> | null;
  auraAmpCacheVersion: number;
  /** §si-units-2026-05-28 Phase 1: per-island cumulative CO₂ emitted in kg.
   *  Phase 2 of the rework adds per-recipe emissions; Phase 5 drains via
   *  wastewater_treatment + exhaust_scrubber; Phase 6 reads for weather. */
  co2Kg: number;
  /** Pending bonus XP credits per resource per §10 (Funneling). When a route
   *  delivers `r` to this island and the island is below the funneling tier
   *  cap, `r × xp_weight[r] × funneling_bonus_percent` accumulates here. The
   *  credit is drained when a local recipe CONSUMES `r` (one bonus-XP unit
   *  per unit consumed, capped at the pending balance). Missing keys read
   *  as 0 — `makeInitialIslandState` seeds all ResourceIds to 0 explicitly
   *  so the deductions in `accrueXp` never see undefined. */
  funnelPending: Record<ResourceId, number>;
  /** Wall-clock timestamp (ms) at which the player declared the current role.
   *  Null until the first declaration. Carries no economic semantics in
   *  step 10 — it's a UX hook for the §9.7 Tier Reset cooldown timer
   *  (reset disallowed within 24 real-time hours of the last reset). */
  declaredAt: number | null;
  /** §13.1 T5 access gate. Becomes `true` the first time the island has ever
   *  produced (and counted in `production` of) an AI core, and stays true
   *  thereafter. Composed with `level >= 50` by `t5Unlocked` (skilltree.ts) /
   *  `buildingUnlocked` to gate the T5 catalog rows. Auto-flip lives at
   *  `economy.ts` line ~1115 — `state.aiCoreCrafted = true` runs on first
   *  ai_core production. The forest-ne demo also seeds it manually via
   *  main.ts for DEMO_ISLANDS_TEST_FIXTURE callers. */
  aiCoreCrafted: boolean;
  /** §14.1 T6 access gate (first half). Becomes `true` the first time this
   *  island has ever produced an `ascendant_core`. Composed with "Spaceport
   *  placed on this island" by `t6Unlocked` (skilltree.ts) / `buildingUnlocked`
   *  to gate the T6 catalog rows. Auto-flip lives at `economy.ts` line ~1118
   *  — `state.ascendantCoreCrafted = true` runs on first ascendant_core
   *  production. The forest-ne demo also seeds it manually via main.ts for
   *  DEMO_ISLANDS_TEST_FIXTURE callers. The Spaceport itself is exempt from
   *  the second half of the gate (chicken-and-egg per §14.1) — see
   *  `buildingUnlocked`. */
  ascendantCoreCrafted: boolean;
  /** Tutorial progress flag — `true` once this island has ever produced
   *  lubricant. Drives the `produce_lubricant` objective. The inventory
   *  level can't be used: §4.7 maintenance auto-consumes lubricant the
   *  moment a building needs it, so a stockpile check is unwinnable. The
   *  flag auto-flips on first lubricant production in `advanceIsland`'s
   *  integrator. Optional for forward-compat — a legacy save lacking it
   *  reads as falsy and re-arms on the next production tick. */
  lubricantProduced?: boolean;
  /** Tutorial progress flag — `true` once this island has ever produced
   *  bolts. Drives the `produce_bolts` objective. Same rationale as
   *  `lubricantProduced`: T1 maintenance auto-consumes 5 bolts, so a
   *  stockpile check is unwinnable. Auto-flips in the integrator. */
  boltProduced?: boolean;
  /** Wall-clock timestamp (`performance.now()` domain, matching `lastTick`
   *  and `declaredAt`) of the last §9.7 Tier Reset on this island, or null
   *  if the island has never been reset. Drives the 24-hour cooldown gate
   *  in `canTierReset`. Null on a fresh island; stamped by
   *  `executeTierReset(state, nowMs)`. perfShift-ed on deserialize alongside
   *  `declaredAt`, so the cooldown gate reads a real elapsed value across
   *  save/load. */
  lastResetAt: number | null;
  /** Wall-clock timestamp of the last advance, in milliseconds. */
  lastTick: number;
  /** §13.3 Time Lock banked time in minutes. One per Time Lock building. */
  timeLockBankedMin: number;
  /** §13.3 Currently active acceleration queue. */
  accelerationQueue: Array<{ readonly sourceIslandId: string; readonly durationMin: number }>;
  /** §13.3 Remaining minutes of current acceleration (0 if none). */
  accelerationRemainingMin: number;
  /** §13.3 Whether this island banks time instead of advancing when offline. */
  bankingEnabled: boolean;
  /** §13.3 Target resource for Genesis Chamber, or null if inactive. */
  genesisTarget: ResourceId | null;
  /** Per-island electrical energy buffer (W-seconds). Filled by power surplus,
   *  drained into deficits via the §5.1 brownout path. Generalised across the
   *  battery ladder (T2 battery_bank / T3 capacitor_bank / T4 flywheel_array /
   *  T5 singularity_battery). Capacity = batteryCapacityWs(state, mul). */
  batteryStoredWs: number;
  /** §12.4 Starter inventory grace cap — per-resource one-time allowance
   *  that lets a new colony hold kit-delivered raws even with zero storage.
   *  Shrinks resource-by-resource as normal cap meets or exceeds inventory. */
  starterInventoryGrace: Record<ResourceId, number>;
  /** Socket id → bound crystal id. Empty on a fresh island. */
  socketBindings: Map<string, CrystalId>;
}

/**
 * Safe inventory read. `noUncheckedIndexedAccess` makes every `inv[r]`
 * return `number | undefined`, so we centralise the `?? 0` here.
 */
/**
 * §13.3 Genesis Chamber tier-based power draw (kilowatts). Converted to
 * watts inside `computeRates` by multiplying by 1000.
 */
const GENESIS_POWER_KW: Record<number, number> = {
  1: 50,
  2: 500,
  3: 5000,
  4: 50000,
};

/** §13.3 Genesis Chamber cycle time in seconds. */
const GENESIS_CYCLE_SEC = 300; // 5 minutes per unit

/** Derive the economic tier of a resource from its XP weight. */
function tierForResource(r: ResourceId): number {
  const w = XP_WEIGHT[r];
  if (w === 1) return 0; // T0
  if (w === 3) return 1;
  if (w === 10) return 2;
  if (w === 30) return 3;
  if (w === 100) return 4;
  if (w === 300) return 5;
  if (w === 1000) return 6;
  return 1;
}

/** Compute the variance factor for high_wind modifier. Deterministic per
 *  (islandId, second). Returns 1 when variance is inactive. */
function computeVarianceFactor(state: IslandState, modifierMul: ModifierMultipliers, nowMs: number): number {
  if (!modifierMul.outputVariance) return 1;
  const varianceRng = makeSeededRng(`${state.id}_variance_${Math.floor(nowMs / 1000)}`);
  return 0.8 + varianceRng() * 0.4; // ±20%
}

/** Set the Genesis Chamber target resource. Returns false if the target is
 *  outside the T1-T4 band (including T0 and T5+). */
export function setGenesisTarget(state: IslandState, target: ResourceId): boolean {
  const tier = tierForResource(target);
  if (tier > 4 || tier < 1) return false;
  state.genesisTarget = target;
  return true;
}

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
export function cap(
  state: IslandState,
  r: ResourceId,
  override?: Record<ResourceId, number>,
  opts?: { ignoreGrace?: boolean },
  mult?: SkillMultipliers,
): number {
  const nominal = override?.[r] ?? state.storageCaps[r] ?? 0;
  if (nominal === 0) return 0;
  const resolvedMult = mult ?? effectiveSkillMultipliers(state);
  const skillMul = resolvedMult.storageCap;
  // Storage sub-path (depth ≥ 2): per-category cap multiplier on top of the
  // uniform skill mul. Looks up the resource's storage category — if it
  // hasn't been categorised yet (forward-compat with new resources) the
  // lookup returns undefined and the category-mul defaults to 1.
  const cat = RESOURCE_STORAGE_CATEGORY[r];
  const catMul = cat ? resolvedMult.storageCategoryCap[cat] ?? 1 : 1;
  const computedCap = nominal * skillMul * catMul;
  if (opts?.ignoreGrace) return computedCap;
  const grace = state.starterInventoryGrace[r] ?? 0;
  return Math.max(computedCap, grace);
}

/** §12.4: clear starter inventory grace for a single resource when its
 *  normal cap meets or exceeds current inventory. */
export function clearGraceIfRedundant(
  state: IslandState,
  r: ResourceId,
  baseMult?: SkillMultipliers,
): void {
  const grace = state.starterInventoryGrace[r] ?? 0;
  if (grace <= 0) return;
  const normalCap = cap(state, r, undefined, { ignoreGrace: true }, baseMult);
  if (normalCap >= (state.inventory[r] ?? 0)) {
    state.starterInventoryGrace[r] = 0;
  }
}

/**
 * Per-building rates as computed at the START of a sub-interval, before
 * integrating. `production` is gross outputs (what the building tries to
 * make per second); `consumption` is gross inputs. `production` is the
 * value that feeds the XP formula per §9.1.
 *
 * Per §15.3 with §5.1 power: `effectiveRate = baseRate × inputAvail ×
 * (consumesPower ? powerFactor : 1)`, where `baseRate = (1/cycleSec) ×
 * outputAvail × buffStack`. `buffStack` carries the §4.5 buff-adjacency
 * multiplier (`computeBuffStack` in `adjacency.ts`) per building; it is
 * computed once in pass 1 and reused verbatim in pass 2 so producer /
 * consumer supply ratios stay consistent when only one side is buffed.
 * `powerFactor` lives on the `PowerBalance` returned by `computeRates`
 * and is recomputed each call. The four-pass implementation in
 * `computeRates` documents how the inputAvail/powerFactor circular
 * dependency is broken (nominal-rate inputAvail, post-applied powerFactor).
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
function outputAvail(
  state: IslandState,
  recipe: Recipe,
  nowMs: number,
  caps?: Record<ResourceId, number>,
  baseMult?: SkillMultipliers,
): number {
  const outputs = resolveRotatingOutput(recipe, nowMs);
  for (const [r, _yield] of Object.entries(outputs)) {
    const id = r as ResourceId;
    if (inv(state, id) >= cap(state, id, caps, undefined, baseMult)) return 0;
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
  inventory?: Record<ResourceId, number>,
): number {
  let factor = 1;
  for (const [r, needPerCycle] of Object.entries(recipe.inputs)) {
    const id = r as ResourceId;
    // §si-units Phase 2 — atmosphere intake: bypass inventory check
    // and decrement when both conditions hold.
    if (recipe.exogenousFlow === 'atmosphere' && id === 'air') {
      continue;
    }
    // §13.3 Omniscient Lattice: when an inventory override is provided,
    // stockpile checks read from the unified pool instead of local state.
    const stock = inventory?.[id] ?? state.inventory[id] ?? 0;
    if (stock > 0) continue; // stockpile satisfies demand
    const demand = (needPerCycle ?? 0) * baseRate;
    if (demand <= 0) continue;
    const supply = externalSupply[id] ?? 0;
    if (supply <= 0) return 0; // no inventory + no inflow = stalled
    if (supply < demand) factor = Math.min(factor, supply / demand);
  }
  return factor;
}

/**
 * §4 ocean-layer (Task 10) — check an ocean platform's preconditions and
 * return the `PausedReason` if the building should halt this tick, or `null`
 * if it should proceed. Mutates `b.paused` in place so the inspector and
 * persistence layer see the same value the economy used.
 *
 * Two failure modes, mirroring the §4 design doc edge cases:
 *
 *   1. `'anchor-depopulated'`: `b.anchorIslandId` names a missing island OR
 *      one whose `populated` flag is false. Set this also when the caller
 *      didn't thread a `world` reference (defensive: with no world the
 *      anchor lookup can't run, and an ocean platform whose anchor is
 *      unresolvable must not silently produce — its output has no destination
 *      and its power draw has no pool).
 *   2. `'terrain-lost'`: the platform's geographic cell is no longer ocean
 *      (an island's footprint now overlaps it). Defensive — not expected
 *      in initial scope but cheap to detect.
 *
 * The platform's `b.x, b.y` are island-local tile coords on the anchor
 * (matching the existing per-building convention — `b.x, b.y` is relative
 * to `IslandSpec.cx, cy`). We convert to world-tile coords via
 * `anchor.cx + b.x` (resp. y) and sample `isOceanTile` once at the
 * platform's anchor tile. The placement validator already enforced full-
 * cell ocean coverage at place time, so the per-tick sentinel here is
 * "did anything change at the anchor tile?" A future biome / land-
 * reclamation event could shrink the sampling rigour if needed.
 *
 * NOT a paused reason: power brownout. A platform whose anchor pool has
 * insufficient W falls through the existing §5.1 brownout mechanic
 * (`powerFactor < 1`) — the building stays "active" with degraded rate
 * rather than fully halting. The §4 design doc explicitly calls this out
 * ("Anchor pool has no power: platform halts via the existing brownout
 * mechanic (no new paused reason)").
 */
function oceanPlatformPausedReason(
  b: PlacedBuilding,
  world: WorldState | undefined,
): PausedReason | null {
  if (!world) return 'anchor-depopulated';
  const anchorId = b.anchorIslandId;
  if (!anchorId) return 'anchor-depopulated';
  const anchor = world.islands.find((i) => i.id === anchorId);
  if (!anchor || !anchor.populated) return 'anchor-depopulated';
  // b.x, b.y are island-local on the anchor; lift to world tiles via the
  // anchor centre. isOceanTile rejects any tile inside any island ellipse.
  if (!isOceanTile(world, anchor.cx + b.x, anchor.cy + b.y)) return 'terrain-lost';
  return null;
}

/** Evaluate a single `conditionalBonus` condition against live state.
 *  Returns `false` gracefully when world fields (weather, daynight) are absent. */
export function evaluateConditionalEffectCondition(
  c: ConditionalEffectCondition,
  state: IslandState,
  world: WorldState | undefined,
  nowMs?: number,
): boolean {
  switch (c.kind) {
    case 'during-storm': {
      if (!world || nowMs === undefined) return false;
      const island = world.islands.find((i) => i.id === state.id);
      if (!island) return false;
      const cell = weather(world.seed, island.cx, island.cy, nowMs, island.biome);
      return cell.state === 'storm' || cell.state === 'severe_storm' || cell.state === 'catastrophic';
    }
    case 'during-night': {
      if (nowMs === undefined) return false;
      return dayPhaseName(nowMs) === 'night';
    }
    case 'networked-to-N-T3-islands': {
      if (!world) return false;
      const networked = networkedIslandIds(world);
      let count = 0;
      for (const island of world.islands) {
        if (!networked.has(island.id)) continue;
        const level = world.islandStates?.get(island.id)?.level ?? 1;
        if (tierForLevel(level) >= 3) count++;
      }
      return count >= c.n;
    }
  }
}

/** Layer conditional bonuses on top of an existing `SkillMultipliers` bundle.
 *  Mutates `mul` in place. Caller should pass the result of
 *  `effectiveSkillMultipliers(state)` as the base. */
export function layerConditionalBonuses(
  mul: SkillMultipliers,
  state: IslandState,
  world: WorldState | undefined,
  graph: Graph = DEFAULT_GRAPH,
  nowMs?: number,
): void {
  for (const nodeId of state.unlockedNodes) {
    const node = graph.nodes.find((n) => n.id === nodeId);
    if (!node || node.effect.kind !== 'conditionalBonus') continue;
    if (!evaluateConditionalEffectCondition(node.effect.condition, state, world, nowMs)) continue;
    const effect = node.effect;
    const m = 1 + effect.multiplier;
    if (effect.appliesTo === 'storage') {
      (mul as { storageCap: number }).storageCap *= m;
    } else if (effect.appliesTo === 'power') {
      (mul as { powerProduction: number }).powerProduction *= m;
    } else if (effect.appliesTo === 'xp') {
      (mul as { xpGain: number }).xpGain *= m;
    } else {
      const rr = mul.recipeRate as Record<string, number>;
      const cur = rr[effect.appliesTo] ?? 1;
      rr[effect.appliesTo] = cur * m;
    }
  }
}

/** Aggregated electrical balance for an island this tick (§5.1). */
export interface PowerBalance {
  /** Total W produced by active producers. */
  readonly produced: number;
  /** Total W demanded by active consumers, scaled per-building by NOMINAL
   *  throughput fraction (gateMul × inputAvail × (outputAvail > 0 ? 1 : 0))
   *  per the §5.1 throughput-scaled-power rebalance. Output-cap stalled and
   *  soft-gate degraded buildings contribute proportionally less (or zero);
   *  heat-failed / hard-gate / tier-gated consumers contribute zero. */
  readonly consumed: number;
  /** `consumed === 0 ? 1 : min(1, produced / consumed)`. */
  readonly factor: number;
  /** Power produced before battery buffer discharge adjustment. */
  readonly rawProduced: number;
  /** Power consumed before battery buffer discharge adjustment. */
  readonly rawConsumed: number;
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
  /** Wall-clock time used for time-of-day modulation (§2.7 solar). Defaults
   *  to `state.lastTick` so test callers with `lastTick = 0` see full solar
   *  output (the §2.7 epoch offset places `nowMs = 0` mid-Day). The
   *  piecewise integrator passes the segment-start `t` here so each segment
   *  uses a constant solar multiplier matching the segment's quadrant.
   *
   *  NOTE: this parameter is in `performance.now()` domain (matches
   *  `state.lastTick`). It is NOT the right domain for `solarMultiplier`,
   *  which per SPEC §2.7 ("purely time-driven and does not depend on the
   *  player's session") must be evaluated in wall-clock domain so the
   *  day-night cycle survives page refreshes. Pass `solarClockMs` to override
   *  the time the solar multiplier samples; if omitted it falls back to
   *  `nowMs` for back-compat with tests that pass synthetic wall-clock-like
   *  values via `nowMs` (e.g. `12 * HOUR` for midnight). */
  nowMs?: number,
  /** §2.7 wall-clock time used SPECIFICALLY for the solar multiplier sample.
   *  Wall-clock domain (Date.now()) so the day-night cycle is independent of
   *  per-page `performance.now()` and survives refreshes. Production callers
   *  pass `Date.now()` (HUD path) or `t_perf + (Date.now() - performance.now())`
   *  (offline-catchup integrator). Tests typically omit it — the fallback to
   *  `nowMs` preserves the existing `lastTick = 12*HOUR ⇒ Night` convention. */
  solarClockMs?: number,
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
    ncBuff = 1,
    terrainAt,
  } = ctx ?? {};
  // Filter out invalid buildings once so they don't participate in heat,
  // buffs, spaceport checks, or power balance. Under-construction buildings
  // (constructionRemainingMs > 0) are ALSO filtered out — they consume
  // neither power nor recipe inputs, contribute zero output, and are
  // invisible to adjacency-buff scans until they finish.
  const validBuildings = state.buildings.filter((b) => isOperationalBuilding(b));
  // §2.7 day-night cycle. `nowMs` defaults to `state.lastTick` so existing
  // callers (and tests) that don't pass an explicit time see the multiplier
  // for the state's own clock. The integrator in `advanceIsland` passes the
  // segment-start time `t` so each segment is integrated at the quadrant's
  // constant multiplier.
  const t = nowMs ?? state.lastTick;
  // §2.7 wall-clock cycle: prefer the wall-clock sample if the caller passed
  // one (production code does — see param doc). Tests typically omit it, so
  // fall back to `t` and keep the long-standing `lastTick = 12*HOUR ⇒ Night`
  // fixture convention working unchanged.
  // §2.7 + §14.3: effective solar multiplier composes the day-night ramp
  // additively with the sum of in-range Mirror Sat boosts (passed in via
  // ctx.solarBoost; defaults to 0 for islands without mirror coverage).
  // Cap at 1.0 so stacking past full-day doesn't over-produce — saturation
  // is visible to the player as "extra mirrors are wasted past full sun".
  // Additive (not multiplicative) so mirrors function at night, where
  // solarMultiplier(night) = 0 would zero out a multiplicative term.
  const rampMul = solarMultiplier(solarClockMs ?? t);
  const solarMul = Math.min(1, rampMul + (ctx?.solarBoost ?? 0));
  const varianceFactor = computeVarianceFactor(state, modifierMul, t);
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
  layerConditionalBonuses(skillMul, state, ctx?.world, DEFAULT_GRAPH, nowMs);
  // §4.5 buff-adjacency stack is per-building, not global — computed
  // lazily inside the pass-1 loop and stashed on the Tentative entry so
  // pass-2's nominalRate sees the same multiplier (preserves
  // producer/consumer supply ratios when only one side is buffed).
  // §5.2: resolve heat assignments BEFORE the per-recipe passes. A consumer
  // with `requiresHeat` and no adjacent Heat Source is forced to baseRate=0
  // in pass-1 (no recipe pickup → no rate, no consumption) and excluded
  // from the pass-3 power balance (per §5.1 "active iff … all gates pass").
  // Coal-source served counts drive a post-pass fuel-burn deduction folded
  // directly into `consumption.coal` / `net.coal`.
  const heat = resolveHeatAssignments(validBuildings, ctx?.geothermalActive ?? false);
  // §9.7 Tier Reset runtime gate. A building whose tier exceeds the island's
  // current tier band (e.g. a T2 building on a post-reset L1 island) is
  // forced to baseRate = 0 in pass-1 and excluded from the pass-3 power
  // balance — mirrors the requiresHeat gate. The gate composes the full
  // `buildingUnlocked` predicate (level tier + AI-core / Ascendant-core /
  // Spaceport flags) so T5 / T6 buildings keep their additional gates
  // beyond plain tier. `hasSpaceport` is precomputed once because the
  // pass-1 / pass-3 loops would otherwise scan `state.buildings` per
  // building.
  const hasSpaceport = hasOperationalBuilding(validBuildings, 'spaceport');
  function isBuildingActive(b: PlacedBuilding): boolean {
    const def = BUILDING_DEFS[b.defId];
    const tierShift = effectiveTierShift(state, b.defId);
    let unlocked = buildingUnlocked(
      state.level,
      b.defId,
      state.aiCoreCrafted,
      state.ascendantCoreCrafted,
      hasSpaceport,
    );
    if (!unlocked && tierShift > 0 && def.tier <= 4) {
      unlocked = tierForLevel(state.level) >= def.tier - tierShift;
    }
    return unlocked;
  }
  interface Tentative {
    readonly building: PlacedBuilding;
    readonly recipe: Recipe;
    /** Base cycles/sec before input-availability throttling. */
    readonly baseRate: number;
    /** §4.5 buff-adjacency multiplier for this building, captured in pass-1
     *  and reused in pass-2's nominal-rate computation. 1.0 when the def
     *  has no `adjacencyBuffs` or no matching neighbors. */
    readonly buffStack: number;
    /** §4.5 soft-gate multiplier: 1.0 when no gate applies, 0.0 for hard-gate
     *  zero, and between 0 and 1 for soft gates. Carried into pass-2 so
     *  nominalRate reflects the gated demand for inputAvail. */
    readonly effectiveMul: number;
  }
  const tentative: Tentative[] = [];
  /** Gross production by resource from all tentatively-running buildings. */
  const tentSupply: Record<ResourceId, number> = {} as Record<ResourceId, number>;
  for (const b of validBuildings) {
    // §4 ocean-layer (Task 10): check ocean-platform preconditions FIRST so
    // a depopulated-anchor / terrain-lost platform contributes nothing to
    // tentSupply (no flow-through), no power balance (pass 3 skips paused),
    // and earns no XP (pass-4 zero rate emits no production entries).
    // Mutates `b.paused` so the inspector and any save round-trip see the
    // same value the tick used. Resolves to undefined on the happy path so
    // a recovered-anchor platform clears its own pause indicator naturally.
    const defForOcean = defs[b.defId];
    if (defForOcean.oceanPlacement === true) {
      const reason = oceanPlatformPausedReason(b, ctx?.world);
      b.paused = reason ?? undefined;
      if (reason !== null) {
        // Push a stub recipe with baseRate=0 so pass-2 / pass-4 see this
        // building as fully stalled (same shape as the heat-gate / output-
        // stalled fallback below). Use an empty recipe so resolveRotatingOutput
        // and inputAvail return harmless zeroes.
        tentative.push({
          building: b,
          recipe: { inputs: {}, outputs: {}, cycleSec: 1, category: 'extraction' },
          baseRate: 0,
          buffStack: 1,
          effectiveMul: 1,
        });
        continue;
      }
    }
    // §13.3 Genesis Chamber — free creation of a player-chosen T1-T4 resource.
    // Handled before the normal recipe path because genesis_chamber has no
    // static RECIPES entry.
    if (b.defId === 'genesis_chamber') {
      if (!isBuildingActive(b)) {
        tentative.push({
          building: b,
          recipe: { inputs: {}, outputs: {}, cycleSec: 1, category: 'manufacturing' },
          baseRate: 0,
          buffStack: 1,
          effectiveMul: 1,
        });
        continue;
      }
      const target = state.genesisTarget;
      if (!target) {
        tentative.push({
          building: b,
          recipe: { inputs: {}, outputs: {}, cycleSec: 1, category: 'manufacturing' },
          baseRate: 0,
          buffStack: 1,
          effectiveMul: 1,
        });
        continue;
      }
      const targetTier = tierForResource(target);
      if (targetTier < 1 || targetTier > 4) {
        tentative.push({
          building: b,
          recipe: { inputs: {}, outputs: {}, cycleSec: 1, category: 'manufacturing' },
          baseRate: 0,
          buffStack: 1,
          effectiveMul: 1,
        });
        continue;
      }
      const syntheticRecipe: Recipe = {
        inputs: {},
        outputs: { [target]: 1 },
        cycleSec: GENESIS_CYCLE_SEC,
        category: 'manufacturing',
      };
      const gateResult = checkGates(b, validBuildings, defs, ctx?.geothermalActive ?? false, ctx?.crossIsland);
      if (gateResult.effectiveMul === 0) {
        tentative.push({ building: b, recipe: syntheticRecipe, baseRate: 0, buffStack: 1, effectiveMul: 0 });
        continue;
      }
      const oa = outputAvail(state, syntheticRecipe, t, ctx?.caps, ctx?.baseMult);
      if (oa === 0) {
        tentative.push({ building: b, recipe: syntheticRecipe, baseRate: 0, buffStack: 1, effectiveMul: gateResult.effectiveMul });
        continue;
      }
      const baseRate = (1 / GENESIS_CYCLE_SEC) * gateResult.effectiveMul;
      tentative.push({ building: b, recipe: syntheticRecipe, baseRate, buffStack: 1, effectiveMul: gateResult.effectiveMul });
      tentSupply[target] = (tentSupply[target] ?? 0) + baseRate;
      continue;
    }

    // Tile-aware recipe pickup — see resolveRecipe in recipes.ts. For most
    // buildings this is the same as `RECIPES[def.id]`; Mine branches on
    // its footprint terrain when `terrainAt` is provided; Steel Mill swaps
    // to the §6.7 scrap-substitution variant when pig_iron is empty but
    // scrap is on hand (inventory snapshot passed through here).
    const def = defs[b.defId];
    const recipe = resolveRecipe(def, b, terrainAt, ctx?.inventory ?? state.inventory);
    if (!recipe) continue;
    // §4.5 buff-adjacency multiplier — computed once per building from its
    // 4-neighbor footprint border. Captured here so pass 2's nominal-rate
    // sees the same factor and producer/consumer supply ratios stay correct.
    // Returns 1.0 when the def has no `adjacencyBuffs` or no matches.
    const exoticRules = skillUnlockedAdjacencyRules(state);
    const buffStack = computeBuffStack(b, validBuildings, defs, undefined, exoticRules);
    // §9.7 Tier Reset runtime gate: a building above the island's current
    // tier band is fully inactive — same shape as the heat / output stall,
    // baseRate=0 + skipped in the pass-3 power balance.
    if (!isBuildingActive(b)) {
      tentative.push({ building: b, recipe, baseRate: 0, buffStack, effectiveMul: 1 });
      continue;
    }
    // §5.2 heat gate: a `requiresHeat` building with no adjacent source
    // is fully stalled this tick — no production, no consumption, no power
    // draw. Recorded as a tentative entry with baseRate=0 so pass-3's
    // power-balance loop also skips it (matched via inputAvail = 0).
    if (def.requiresHeat && heat.hasHeat.get(b.id) !== true) {
      tentative.push({ building: b, recipe, baseRate: 0, buffStack, effectiveMul: 1 });
      continue;
    }
    // §8.1 tile-gating stall: if any footprint tile is outside the allowed
    // set, we zero baseRate so effectiveRate becomes 0 in pass 4. Power/heat
    // draw is preserved by pass 3's existing active-building check.
    if (def.requiredTile && def.requiredTile.length > 0 && terrainAt) {
      let tileOk = true;
      for (const t of footprintTiles(def.footprint, b.x, b.y, (b.rotation ?? 0) as 0 | 1 | 2 | 3)) {
        const k = terrainAt(t.x, t.y);
        if (!def.requiredTile.includes(k)) {
          tileOk = false;
          break;
        }
      }
      if (!tileOk) {
        tentative.push({ building: b, recipe, baseRate: 0, buffStack, effectiveMul: 1 });
        continue;
      }
    }
    // §8.8 coastal placement: at least one footprint tile must be water.
    if (def.coastal && terrainAt) {
      let hasWater = false;
      for (const t of footprintTiles(def.footprint, b.x, b.y, (b.rotation ?? 0) as 0 | 1 | 2 | 3)) {
        if (terrainAt(t.x, t.y) === 'water') {
          hasWater = true;
          break;
        }
      }
      if (!hasWater) {
        tentative.push({ building: b, recipe, baseRate: 0, buffStack, effectiveMul: 1 });
        continue;
      }
    }
    // §4.5 gating adjacency: hard gates zero output; soft gates degrade.
    const gateResult = checkGates(b, validBuildings, defs, ctx?.geothermalActive ?? false, ctx?.crossIsland);
    if (gateResult.effectiveMul === 0) {
      tentative.push({ building: b, recipe, baseRate: 0, buffStack, effectiveMul: 0 });
      continue;
    }
    const oa = outputAvail(state, recipe, t, ctx?.caps, ctx?.baseMult);
    if (oa === 0) {
      tentative.push({ building: b, recipe, baseRate: 0, buffStack, effectiveMul: gateResult.effectiveMul });
      continue;
    }
    // Recipe-rate multipliers compose: skill-tree (per-category) × modifier
    // (per-category) × modifier (global) × NC global buff. Identity bundles
    // in any of the new factors contribute 1× so existing callers see no change.
    const rateMul =
      (skillMul.recipeRate[recipe.category] ?? 1) *
      (modifierMul.recipeRateByCategory[recipe.category] ?? 1) *
      modifierMul.globalRecipeRate *
      ncBuff;
    const isT5Extractor =
      b.defId === 'aetheric_conduit' ||
      b.defId === 'spacetime_resonator' ||
      b.defId === 'eldritch_sieve' ||
      b.defId === 'casimir_tap' ||
      b.defId === 'zero_point_extractor' ||
      b.defId === 'neutronium_extractor';
    const t5Mul = isT5Extractor ? modifierMul.t5ExtractionRateMul : 1;
    const cryoMul = Object.keys(recipe.outputs).some((r) => r.includes('cryo'))
      ? modifierMul.cryoRecipeRateMul
      : 1;
    const baseRate = (1 / recipe.cycleSec) * buffStack * rateMul * gateResult.effectiveMul * t5Mul * cryoMul;
    tentative.push({ building: b, recipe, baseRate, buffStack, effectiveMul: gateResult.effectiveMul });
    const pass1Outputs = resolveRotatingOutput(recipe, t);
    for (const [r, yld] of Object.entries(pass1Outputs)) {
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
    const te = tentative[i]!;
    // Same compound multiplier as Pass 1 — keeps producer/consumer supply
    // ratios consistent when only one side is buffed.
    const rateMul =
      (skillMul.recipeRate[te.recipe.category] ?? 1) *
      (modifierMul.recipeRateByCategory[te.recipe.category] ?? 1) *
      modifierMul.globalRecipeRate *
      ncBuff;
    // §4.5: soft-gate effectiveMul scales nominalRate so inputAvail's
    // demand calculation matches actual consumption under the gate.
    // Without this, a halved consumer over-claims inputs and starves
    // siblings.
    const nominalRate = (1 / te.recipe.cycleSec) * te.buffStack * rateMul * te.effectiveMul;
    const externalSupply: Record<ResourceId, number> = {} as Record<ResourceId, number>;
    for (const r of Object.keys(tentSupply) as ResourceId[]) {
      externalSupply[r] = tentSupply[r] ?? 0;
    }
    // Self-exclude only if pass 1 actually contributed (baseRate > 0).
    if (te.baseRate > 0) {
      const pass2Outputs = resolveRotatingOutput(te.recipe, t);
      for (const [r, yld] of Object.entries(pass2Outputs)) {
        const id = r as ResourceId;
        externalSupply[id] = (externalSupply[id] ?? 0) - (yld ?? 0) * te.baseRate;
      }
    }
    inputAvailByIdx[i] = inputAvail(state, te.recipe, externalSupply, nominalRate, ctx?.inventory);
  }

  // Pass 3: power balance. A building is `active` for §5.1 iff:
  //   - it has no recipe (Solar / Dock / Crate / Silo — passively active), OR
  //   - its recipe has inputAvail > 0 AND its heat gate (if any) passes.
  //
  // Per the §5.1 throughput-scaled-power rebalance: a consumer's draw scales
  // by its NOMINAL throughput fraction:
  //
  //   nominalThroughputFrac = gateResult.effectiveMul   // §4.5 soft-gate (0..1)
  //                         × inputAvail                 // partial sibling supply (0..1)
  //                         × (outputAvail > 0 ? 1 : 0)  // hard 0 on cap-full
  //
  //   powerConsumed += (def.power.consumes / skillMul.powerConsumption)
  //                  × nominalThroughputFrac
  //
  // All three factors are NOMINAL (pre-powerFactor) — they're already in
  // scope from earlier passes or cheap to recompute via `outputAvail()`.
  // Composing here preserves the existing circular-dep break: the chain is
  // `powerConsumed_nominal → powerFactor → effectiveRate`, never the reverse.
  // Output-cap stalled and soft-gate-degraded buildings no longer waste
  // full wattage producing nothing / less. Maintenance bills in
  // `maintenance.ts` are intentionally NOT scaled by throughput — a
  // stalled building still wears down at full rate; the player can't
  // escape maintenance pressure by capping output. Heat-failed consumers
  // remain fully inactive (no power, no production, no consumption) per
  // §5.1 "active iff all gates pass".
  let powerProduced = 0;
  let powerConsumed = 0;
  for (const b of validBuildings) {
    const def = defs[b.defId];
    // §13.3 Genesis Chamber power is handled below with tier-based draw.
    if (b.defId === 'genesis_chamber') continue;
    // §4 ocean-layer (Task 10): a paused ocean platform draws no power
    // (its anchor can't supply it) AND produces no power (its anchor can't
    // consume it). Pass-1 already set `b.paused` from
    // `oceanPlatformPausedReason`; we honour the same flag here to keep the
    // power balance consistent with the pass-1 zero rate.
    if (b.paused) continue;
    // §9.7 Tier Reset runtime gate: tier-gated buildings draw no power and
    // produce no power on a below-tier island (mirrors heat-gate exclusion
    // below). Without this, a post-reset T2 coal_gen would still push W
    // into the balance and a T2 consumer that drew on its own input would
    // still count as a load even though pass-1 zeroed its rate.
    if (!isBuildingActive(b)) continue;
    // §5.2: heat-required consumer with no adjacent source is INACTIVE
    // (zero power draw). Checked before recipe lookup so the gate applies
    // even if the building's recipe is somehow undefined for the variant.
    if (def.requiresHeat && heat.hasHeat.get(b.id) !== true) continue;
    // §4.5 gating adjacency: a building with a failed hard gate draws no power.
    const gateResult = checkGates(b, validBuildings, defs, ctx?.geothermalActive ?? false, ctx?.crossIsland);
    if (gateResult.effectiveMul === 0) continue;
    // Same tile-aware resolution as the pass-1 loop. `active` only checks
    // recipe presence here, so the variant chosen doesn't matter — but we
    // pipe it through `resolveRecipe` for symmetry with pass 1 (no caller
    // confusion about which lookup is "the" lookup).
    const recipe = resolveRecipe(def, b, terrainAt, ctx?.inventory ?? state.inventory);
    // §5.1 throughput-scaled draw: compose the three NOMINAL gates that
    // determine how much work the building actually does this tick. We
    // recompute outputAvail here (cheap, same helper Pass 1 used) rather
    // than threading it through `Tentative`, keeping the diff localised
    // to Pass 3 per the rebalance brief.
    let active: boolean;
    let nominalThroughputFrac: number;
    if (!recipe) {
      active = true;
      nominalThroughputFrac = 1; // Solar / Dock / Crate / Silo — full passive draw if any.
    } else {
      const idx = tentative.findIndex((t) => t.building === b);
      const ia = idx >= 0 ? (inputAvailByIdx[idx] ?? 0) : 0;
      active = ia > 0;
      const oa = outputAvail(state, recipe, t, ctx?.caps, ctx?.baseMult);
      nominalThroughputFrac = gateResult.effectiveMul * ia * oa;
    }
    if (!active) continue;
    const producesBase = def.power?.produces ?? 0;
    // §2.7: solar-tagged producers scale by the current quadrant's average.
    // Non-solar producers (Coal Gen, Biomass, Fusion Core, Casimir Tap) are
    // unaffected — their `solar` flag is undefined / false.
    const solarFactor = def.power?.solar === true ? solarMul : 1;
    // §3.5 High Wind: wind-tagged producers (`power.kind === 'wind'`,
    // currently only `wind_turbine`) get +50% wattage on `high_wind`
    // islands. Non-wind producers ignore the multiplier (defaults to 1×).
    const windFactor = def.power?.kind === 'wind' ? modifierMul.windPowerMul : 1;
    powerProduced += producesBase * solarFactor * windFactor * skillMul.powerProduction;
    // §5.1 rebalance: per-building draw scales by nominal throughput fraction.
    // powerConsumption is a "reduction" multiplier (>=1 means lower draw),
    // so we divide. Default 1.0 leaves draw untouched.
    powerConsumed += ((def.power?.consumes ?? 0) * nominalThroughputFrac) / skillMul.powerConsumption;
  }
  // §13.3 Genesis Chamber tier-based power draw (converted kW → W).
  for (const b of validBuildings) {
    if (b.defId !== 'genesis_chamber') continue;
    if (!isBuildingActive(b)) continue;
    const gcGateResult = checkGates(b, validBuildings, defs, ctx?.geothermalActive ?? false, ctx?.crossIsland);
    if (gcGateResult.effectiveMul === 0) continue;
    if (!state.genesisTarget) continue;
    const targetTier = tierForResource(state.genesisTarget);
    if (targetTier < 1 || targetTier > 4) continue;
    // Output-stalled chambers don't draw power (no production = no load).
    if (inv(state, state.genesisTarget) >= cap(state, state.genesisTarget, undefined, undefined, ctx?.baseMult)) continue;
    powerConsumed += (GENESIS_POWER_KW[targetTier]! * 1000) / skillMul.powerConsumption;
  }

  // §13.3 Battery buffer — cover deficit from stored energy. Local
  // only: batteries don't contribute wattage to the §5.3 cable network
  // pool (the network was analysed pre-battery via `computeIslandLocalPower`).
  const batteryCap = batteryCapacityWs(state, skillMul);
  const rawProduced = powerProduced;
  const rawConsumed = powerConsumed;
  if (batteryCap > 0 && powerProduced < powerConsumed && state.batteryStoredWs > 0) {
    powerProduced = powerConsumed; // cover full deficit
  }

  // §5.3 cable-network unification: when this island's connected-cable
  // component passes the per-tick gate, every island in the component
  // shares ONE brownout factor computed from component-wide produced /
  // consumed. Otherwise, fall back to the local raw balance (above) —
  // cables are inert for this tick. Binary: no partial flow. The Singularity
  // Battery's local deficit-cover (just above) is bypassed when unified —
  // a unified component balances at the network level, not per-island.
  let powerFactor: number;
  const cableComponent = ctx?.cableComponent;
  if (cableComponent !== undefined && cableComponent.unified) {
    powerFactor =
      cableComponent.consumedTotal === 0
        ? 1
        : Math.min(1, cableComponent.producedTotal / cableComponent.consumedTotal);
  } else {
    powerFactor =
      powerConsumed === 0 ? 1 : Math.min(1, powerProduced / powerConsumed);
  }

  // Pass 4: final effective rate. Apply powerFactor only to consumers
  // (buildings declaring `power.consumes > 0`); producers and neutral
  // buildings ignore it. Output-stalled buildings still finish at 0.
  const byBuilding: BuildingRate[] = [];
  const production: Record<ResourceId, number> = {} as Record<ResourceId, number>;
  const consumption: Record<ResourceId, number> = {} as Record<ResourceId, number>;
  const net: Record<ResourceId, number> = {} as Record<ResourceId, number>;
  for (let i = 0; i < tentative.length; i++) {
    const te = tentative[i]!;
    if (te.baseRate === 0) {
      byBuilding.push({ building: te.building, recipe: te.recipe, effectiveRate: 0 });
      continue;
    }
    const ia = inputAvailByIdx[i] ?? 0;
    const consumesPower = (defs[te.building.defId].power?.consumes ?? 0) > 0;
    const pf = consumesPower ? powerFactor : 1;
    // §4.7 maintenance factor on the production-side recipe rate. Power
    // producers' W output stays full — `power.produces` is summed before
    // this loop in Pass 3 — which is a deliberate gap: the spec phrases
    // degradation as "output efficiency", ambiguous for power buildings,
    // and applying maintenance to power would cascade into the brownout
    // factor and double-dip on consumers. Resource recipes only.
    const mf = maintenanceFactor(te.building, defs[te.building.defId], skillMul.maintenanceThreshold);
    const accelMul = ctx?.accelerationMul ?? 1;
    const toxMul = toxicityMultiplier(te.building, t);
    // Per-building-type yield bonus (Mining "vein depth", Forestry "regrowth")
    // stacks multiplicatively on top of the global recipeRate.extraction mul
    // for the matching building defId. Mine, deep_mine, heavy_mine etc all
    // share the 'mine' family — match by id prefix to cover variants.
    const defId = te.building.defId;
    let buildingBonus = 1;
    if (defId === 'mine' || defId === 'deep_mine' || defId === 'copper_mine'
        || defId === 'tin_mine' || defId === 'lead_mine' || defId === 'bauxite_mine'
        || defId === 'quartz_mine' || defId === 'sulfur_mine' || defId === 'phosphate_mine'
        || defId === 'graphite_mine' || defId === 'limestone_quarry'
        || defId === 'quarry' || defId === 'uranium_mine') {
      buildingBonus = skillMul.mineYieldBonus;
    } else if (defId === 'logger' || defId === 'heavy_logger') {
      buildingBonus = skillMul.loggerYieldBonus;
    } else if (defId === 'pump_jack' || defId === 'drilling_rig' || defId === 'trench_drill') {
      buildingBonus = skillMul.drillYieldBonus;
    } else if (defId === 'patron_hub') {
      buildingBonus = skillMul.patronageYieldBonus;
    } else if (defId === 'aetheric_conduit' || defId === 'spacetime_resonator'
        || defId === 'eldritch_sieve' || defId === 'casimir_tap'
        || defId === 'zero_point_extractor' || defId === 'neutronium_extractor') {
      buildingBonus = skillMul.t5ExtractorYieldBonus;
    }
    // Note: aquacultureYieldBonus has no consumer in building-defs.ts today.
    // The multiplier folds but is dormant until aquaculture buildings land.
    const effectiveRate = te.baseRate * ia * pf * mf * accelMul * varianceFactor * toxMul * buildingBonus;
    byBuilding.push({ building: te.building, recipe: te.recipe, effectiveRate });

    if (effectiveRate === 0) continue;
    const pass4Outputs = resolveRotatingOutput(te.recipe, t);
    for (const [r, yld] of Object.entries(pass4Outputs)) {
      const id = r as ResourceId;
      const delta = (yld ?? 0) * effectiveRate;
      production[id] = (production[id] ?? 0) + delta;
      net[id] = (net[id] ?? 0) + delta;
    }
    for (const [r, need] of Object.entries(te.recipe.inputs)) {
      const id = r as ResourceId;
      // §si-units Phase 2 — atmosphere intake: bypass inventory decrement.
      if (te.recipe.exogenousFlow === 'atmosphere' && id === 'air') {
        continue;
      }
      const delta = (need ?? 0) * effectiveRate;
      consumption[id] = (consumption[id] ?? 0) + delta;
      net[id] = (net[id] ?? 0) - delta;
    }
  }

  // §9.3 Mining "rare reveal" + Forestry "exotic species" — continuous
  // trickle bonuses applied per qualifying building on the island. The
  // trickle rate is additive per node in the fold; a player with mining.3
  // sees a small helium_3 / per-Mine rate added here, scaling with the
  // count of Mines on the island. Skipped entirely when the multiplier
  // is 0 (no nodes unlocked) for symmetry with no-op pass.
  // §3.5 Cursed Storms doubles both trickle rates via `rareFindMul`. The
  // multiplier composes with the existing skill-tree per-node accumulation
  // so depth-3 Mining + Cursed Storms gives the full 2× boost on top of
  // the depth scaling, matching the spec's "doubled rare finds" intent.
  if (skillMul.mineRareTrickleRate > 0) {
    let mines = 0;
    for (const b of validBuildings) {
      if (b.defId === 'mine' || b.defId === 'deep_mine') mines++;
    }
    const rare = mines * skillMul.mineRareTrickleRate * modifierMul.rareFindMul;
    if (rare > 0) {
      production.helium_3 = (production.helium_3 ?? 0) + rare;
      net.helium_3 = (net.helium_3 ?? 0) + rare;
    }
  }
  if (skillMul.loggerExoticTrickleRate > 0) {
    let loggers = 0;
    for (const b of validBuildings) {
      if (b.defId === 'logger' || b.defId === 'heavy_logger') loggers++;
    }
    const exotic = loggers * skillMul.loggerExoticTrickleRate * modifierMul.rareFindMul;
    if (exotic > 0) {
      production.lumber = (production.lumber ?? 0) + exotic;
      net.lumber = (net.lumber ?? 0) + exotic;
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
    const furnace = validBuildings.find((b) => b.id === furnaceId);
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
    power: { produced: powerProduced, consumed: powerConsumed, factor: powerFactor, rawProduced, rawConsumed },
    heat,
  };
}

/**
 * Find the next moment in `[tMs, nowMs]` at which the rate-determining state
 * changes — that is, some inventory will reach 0 (input depleted), some cap
 * (output filled), or any building's §4.7 maintenance factor crosses a
 * boundary (entering degraded state, advancing one sub-segment of the linear
 * ramp, or reaching the 0.5 plateau). If nothing changes in the interval,
 * returns `nowMs`.
 *
 * This is the §15.3 `findNextCapEvent`. We extend it to also report
 * input-depletion events because those are equally important for stopping
 * the integration before consuming a resource past zero. And — since step-§4.7
 * — maintenance boundaries: without these, a 24h offline catchup would
 * integrate one giant segment at start-of-segment maintenance factor
 * (typically 1.0), missing the degradation entirely. Each sub-segment then
 * integrates at the start-of-segment factor; since the linear ramp is
 * monotonically DECREASING, that over-estimates production within the ramp.
 * The `MAINTENANCE_RAMP_SEGMENTS` constant in `maintenance.ts` bounds the
 * over-count to roughly `0.5 / (2 × ramp_segments)`.
 *
 * `tMs` and `nowMs` are wall-clock millisecond timestamps; `net` is in
 * units-per-second. We convert via /1000.
 *
 * `ctx.defs` is consulted for per-building tier lookups; defaults to
 * `BUILDING_DEFS` to keep the bare-arity signature for legacy callers.
 */
export function findNextCapEvent(
  state: IslandState,
  net: Record<ResourceId, number>,
  tMs: number,
  nowMs: number,
  ctx?: RatesContext,
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
      // Treat headroom < 1 unit as "effectively full" — a sub-1 residue
      // (e.g. cap - 1e-15 from float-subtraction precision loss) yields
      // `timeToEventSec ≈ 0`, and `tMs + tiny*1000` rounds back to `tMs`
      // at realistic perf.now() scales (~1e6 ms ULP ≈ 2e-10), which then
      // makes segEndMs == t, dtSec == 0, and the entire integrator block
      // (applyRates, accrueXp, tickConstruction) is skipped every frame —
      // a production-freeze bug. The 1-unit threshold is for next-event
      // purposes only; applyRates retains float storage so slow producers
      // still accumulate fractional units across segments.
      const capVal = cap(state, r, ctx?.caps, undefined, ctx?.baseMult);
      const headroom = capVal - current;
      if (headroom < 1) continue;
      timeToEventSec = headroom / rate;
    } else {
      // rate < 0, heading toward zero. If already at zero, skip — that
      // input would have set inputAvail=0 and we wouldn't be here.
      // Treat sub-1 inventory as "effectively empty" for the same
      // precision-residue reason as the cap branch above: a 2.6e-21 stock
      // with a finite consumption rate computes `timeToEventSec ≈ 5e-19`,
      // which after `tMs + that*1000` rounds back to `tMs` and freezes
      // the integrator. The threshold matches the cap-side branch for
      // symmetry; the same applyRates float-storage caveat applies.
      if (current < 1) continue;
      timeToEventSec = current / -rate;
    }
    const eventMs = tMs + timeToEventSec * 1000;
    if (eventMs < best) best = eventMs;
  }
  // §4.7 maintenance-boundary events. For each building with a pending
  // boundary in operatingMs, emit `tMs + (boundary - operating)` as a
  // candidate event. This keeps long catchup segments honest: a 24h offline
  // gap on a T1 building (12h threshold → 4h ramp → plateau) becomes at
  // most three segments instead of one.
  const defs = ctx?.defs ?? BUILDING_DEFS;
  // Robotics skill: stretches the maintenance threshold. The boundary
  // walker must see the same threshold the per-segment integrator does,
  // otherwise long offline catchup splits at the wrong moment.
  const thresholdMul = (ctx?.baseMult ?? effectiveSkillMultipliers(state)).maintenanceThreshold;
  for (const b of state.buildings) {
    if (b.disabled === true) continue;
    const def = defs[b.defId];
    const boundary = nextMaintenanceBoundaryMs(b, def, thresholdMul);
    if (boundary === null) continue;
    const operating = b.operatingMs ?? 0;
    const eventMs = tMs + (boundary - operating);
    if (eventMs > tMs && eventMs < best) best = eventMs;
  }
  // §9.3 Robotics: under-construction completion events. The integrator
  // must split a segment at the moment a building flips operational so the
  // post-completion segment integrates with the newly-active production.
  const constructionEvent = nextConstructionCompletionMs(state.buildings, tMs);
  if (constructionEvent !== null && constructionEvent > tMs && constructionEvent < best) {
    best = constructionEvent;
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
function applyRates(
  state: IslandState,
  net: Record<ResourceId, number>,
  dtSec: number,
  caps?: Record<ResourceId, number>,
  baseMult?: SkillMultipliers,
): void {
  for (const r of Object.keys(net) as ResourceId[]) {
    const rate = net[r] ?? 0;
    if (rate === 0) continue;
    const next = inv(state, r) + rate * dtSec;
    const clamped = Math.min(cap(state, r, caps, undefined, baseMult), Math.max(0, next));
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
export function accrueXp(
  state: IslandState,
  production: Partial<Record<ResourceId, number>>,
  consumption: Partial<Record<ResourceId, number>>,
  dtSec: number,
  xpMul: number = 1,
  xpGainMul: number = 1,
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
  // §10.1 funnel provenance: we approximate per-batch tracking by draining
  // only net consumption (local production shields local use). True batch
  // provenance is STILL-DEFERRED because the current model has no inventory lots.
  for (const r of Object.keys(consumption) as ResourceId[]) {
    const consRate = consumption[r] ?? 0;
    if (consRate <= 0) continue;
    const prodRate = production[r] ?? 0;
    const netRate = Math.max(0, consRate - prodRate);
    if (netRate <= 0) continue;
    const netConsumed = netRate * dtSec;
    const pending = state.funnelPending[r] ?? 0;
    if (pending <= 0) continue;
    const want = netConsumed * (XP_WEIGHT[r] ?? 0) * FUNNELING_BONUS_PERCENT_FOR_DRAIN;
    const drawn = Math.min(want, pending);
    state.funnelPending[r] = pending - drawn;
    gain += drawn;
  }
  // §9.4 research_beacon: total XP gain × xpMul (default 1, identity).
  // Applied AFTER the funnel drain so funneled bonus XP also scales — the
  // spec is silent on the interaction but treating the role as a uniform
  // XP multiplier is the simpler invariant.
  state.xp += gain * xpMul * xpGainMul;
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
    // Skill-point grant scales with level (1.1^L floor) so the late-game
    // tree (depth 6+ nodes costing 8-292 points each under the new
    // costForDepth curve) is actually reachable. See `skillPointsForLevelUp`
    // and the cumulative-points worked example in its doc comment.
    state.unspentSkillPoints += skillPointsForLevelUp(state.level);
  }
}

/**
 * §13.3 Time Lock spend — transfer banked minutes from a source island to
 * accelerate a target island at 3× tick rate. Queued sequentially if the
 * target already has an active acceleration.
 */
export function spendTimeLock(
  sourceState: IslandState,
  targetState: IslandState,
  minutes: number,
): { ok: true } | { ok: false; reason: 'insufficient-banked-time' | 'invalid-minutes' } {
  if (minutes <= 0) return { ok: false, reason: 'invalid-minutes' };
  if (sourceState.timeLockBankedMin < minutes) {
    return { ok: false, reason: 'insufficient-banked-time' };
  }
  if (targetState.accelerationRemainingMin > 0) {
    targetState.accelerationQueue.push({ sourceIslandId: sourceState.id, durationMin: minutes });
  } else {
    targetState.accelerationRemainingMin = minutes;
  }
  sourceState.timeLockBankedMin -= minutes;
  return { ok: true };
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
  /** §2.7 wall-clock anchor (Date.now()) corresponding to `nowMs`. Production
   *  callers MUST pass this so the day-night cycle is independent of
   *  per-page `performance.now()` and survives refreshes (spec: "purely
   *  time-driven and does not depend on the player's session"). The
   *  integrator computes a `wallOffset = wallClockNowMs - nowMs` once and
   *  threads `t + wallOffset` to both `solarMultiplier` (via
   *  `computeRates(.., solarClockMs)`) AND the segment-boundary helpers
   *  (`nextPhaseBoundaryMs`, `nextSolarBoundaryMs`) so phase transitions
   *  inside a multi-hour offline catchup fall on the wall-clock quadrant
   *  edges, not on the page-local perf-clock quadrant edges.
   *
   *  When omitted, falls back to using `nowMs` directly as the wall-clock —
   *  the long-standing test convention (`nowMs = 12*HOUR ⇒ Night`). */
  wallClockNowMs?: number,
): void {
  const { defs = BUILDING_DEFS } = ctx ?? {};
  // §2.7 perf→wall offset. `wallClockNowMs - nowMs` is constant across this
  // advance call, so each segment's wall-clock time is `t + wallOffset`.
  // Tests that omit `wallClockNowMs` fall back to `wallOffset = 0` — the
  // existing "lastTick is the wall clock" convention.
  const wallOffset = (wallClockNowMs ?? nowMs) - nowMs;
  if (nowMs <= state.lastTick) {
    state.lastTick = nowMs;
    return;
  }
  // Per-tick base skill multiplier. unlockedNodes / unlockedEdges
  // do not mutate during this advanceIsland call (level-ups don't
  // auto-spend points; spend paths are UI-driven outside the tick),
  // so this object is constant for the duration. Freeze to catch
  // accidental mutation in dev.
  const baseMult = effectiveSkillMultipliers(state);
  Object.freeze(baseMult);  // shallow — covers all primitive fields
  // §13.3 Time Lock banking: if the island has at least one Time Lock and
  // banking is enabled, accumulate offline time into the bank instead of
  // advancing production.
  const timeLockCount = state.buildings.filter((b) => b.defId === 'time_lock').length;
  if (timeLockCount > 0 && state.bankingEnabled) {
    const maxBank = timeLockCount * 24 * 60; // 24 hours per Lock in minutes
    const offlineMin = (nowMs - state.lastTick) / 60000;
    state.timeLockBankedMin = Math.min(maxBank, state.timeLockBankedMin + offlineMin);
    state.lastTick = nowMs;
    return; // skip normal advancement — island is paused while banking
  }
  // §12.4: shrink starter inventory grace as normal caps catch up.
  for (const r of Object.keys(state.starterInventoryGrace) as ResourceId[]) {
    clearGraceIfRedundant(state, r, baseMult);
  }
  let t = state.lastTick;
  if (ctx?.worldSeed) {
    advanceToxicityRolls(state.buildings, ctx.worldSeed, state.lastTick, nowMs);
  }
  // Robotics sub-path bonus: stretches maintenance thresholds (longer
  // operating-time budget before degradation begins). Read once and reused
  // across every maintenance check in this advanceIsland call.
  const maintenanceThresholdMul = baseMult.maintenanceThreshold;
  // §4.7: attempt auto-maintain BEFORE the first segment too — a save loaded
  // with materials in inventory and an over-threshold building should
  // self-heal on the next tick without waiting for the next inventory
  // boundary. Policy (per pickMostDegradedTarget): only the single
  // most-degraded building is considered; if its tier recipe isn't fully
  // in stock, no maintenance fires this pass — the building waits rather
  // than letting a less-critical building consume the materials.
  {
    const target = pickMostDegradedTarget(state.buildings, defs, maintenanceThresholdMul);
    if (target !== null) {
      tryAutoMaintain(target, defs[target.defId], state.inventory, t, maintenanceThresholdMul);
    }
  }
  for (let safety = 0; safety < 10000; safety++) {
    if (t >= nowMs) break;
    // §13.3 acceleration multiplier from Time Lock spend.
    const effectiveCtx: RatesContext = {
      ...ctx,
      accelerationMul: state.accelerationRemainingMin > 0 ? 3 : 1,
      baseMult,
    };
    // §2.7: pass `t` so the solar multiplier reflects this segment's
    // quadrant, not start-of-tick. Without this, a 24h offline gap would
    // integrate one constant solar multiplier across all four phases.
    // Wall-clock conversion: `t + wallOffset` lifts the perf-domain segment
    // time into the Date.now() domain `solarMultiplier` expects per spec.
    const { production, consumption, net, power } = computeRates(
      state,
      effectiveCtx,
      t,
      t + wallOffset,
    );
    // §13 auto-flip: first local production of ai_core / ascendant_core
    if (!state.aiCoreCrafted && (production.ai_core ?? 0) > 0) {
      state.aiCoreCrafted = true;
    }
    if (!state.ascendantCoreCrafted && (production.ascendant_core ?? 0) > 0) {
      state.ascendantCoreCrafted = true;
    }
    // Tutorial-objective flip: first local production of lubricant / bolts.
    // Tracked as "ever produced" because §4.7 maintenance auto-consumes
    // both, making an inventory-stockpile objective unwinnable.
    if (!state.lubricantProduced && (production.lubricant ?? 0) > 0) {
      state.lubricantProduced = true;
    }
    if (!state.boltProduced && (production.bolt ?? 0) > 0) {
      state.boltProduced = true;
    }
    // §13.3 Battery buffer — bound segment to battery depletion/fill so the
    // piecewise integrator stays exact (rates are constant within a segment).
    const validBuildings = state.buildings.filter((b) => !b.invalid);
    const skillMul = effectiveSkillMultipliers(state);
    layerConditionalBonuses(skillMul, state, ctx?.world, DEFAULT_GRAPH, nowMs);
    const maxCap = batteryCapacityWs(state, skillMul);
    const rawBalance = power.rawProduced - power.rawConsumed;
    let nextBatteryMs = Infinity;
    if (rawBalance > 0 && maxCap > 0 && state.batteryStoredWs < maxCap) {
      const surplus = rawBalance;
      const fillTimeSec = (maxCap - state.batteryStoredWs) / surplus;
      nextBatteryMs = t + fillTimeSec * 1000;
    } else if (rawBalance < 0 && state.batteryStoredWs > 0 && maxCap > 0) {
      const deficit = -rawBalance;
      const depletionTimeSec = state.batteryStoredWs / deficit;
      nextBatteryMs = t + depletionTimeSec * 1000;
    }
    const nextEventMs = findNextCapEvent(state, net, t, nowMs, effectiveCtx);
    // terrain_modifier v5 — segment-end clamp by the soonest pending shot.
    // Without this, a 30s segment containing a 4s shot would integrate past
    // fire-time and ResolveShot would land at the wrong simulated moment.
    let nextShotMs = Infinity;
    for (const b of state.buildings) {
      const rem = b.terrainShotRemainingMs;
      if (rem !== undefined && rem > 0) {
        const fireT = t + rem;
        if (fireT < nextShotMs) nextShotMs = fireT;
      }
    }
    // §2.7: bound the segment to the next phase boundary so the constant-
    // rate invariant of §15.3 still holds across day-night transitions. A
    // quadrant lasts 6h; offline catchup of N days produces ≤ 4N + extras
    // segments instead of an under-integrated single segment.
    //
    // The boundary helpers expect wall-clock domain (the cycle is wall-clock
    // anchored per spec §2.7). Lift `t` by `wallOffset`, compute the next
    // wall-clock boundary, then drop back to perf-domain by subtracting
    // `wallOffset` so the segment-end clamp at `Math.min(...)` below stays
    // in the same domain as `nowMs` / `nextEventMs` / etc.
    const nextPhaseMs = nextPhaseBoundaryMs(t + wallOffset) - wallOffset;
    // §2.7 ramp sub-segment boundary: inside Dawn / Dusk, solarMultiplier
    // varies linearly. The §15.3 piecewise-constant-rate invariant requires
    // each segment to integrate a constant rate, so we sub-divide the ramp
    // into `SOLAR_RAMP_SEGMENTS` evenly-spaced sub-segments and clamp the
    // segment end to the next ramp tick. Inside the flat Day / Night
    // quadrants this collapses to `nextPhaseBoundaryMs(t)`.
    const nextSolarBoundaryWall = nextSolarBoundaryMs(t + wallOffset);
    const nextSolarMs = nextSolarBoundaryWall === null ? Infinity : nextSolarBoundaryWall - wallOffset;
    // §13.3 bound segment to the end of active acceleration so the multiplier
    // stays constant within the segment.
    let nextAccelMs = Infinity;
    if (state.accelerationRemainingMin > 0) {
      nextAccelMs = t + state.accelerationRemainingMin * 60 * 1000;
    }
    // §8.10 rotating-output boundary: if any building has `rotateOutputs`,
    // clamp the segment so the output set stays constant within it.
    let nextRotationMs = Infinity;
    for (const b of validBuildings) {
      const def = defs[b.defId];
      const recipe = resolveRecipe(def, b, ctx?.terrainAt);
      if (!recipe) continue;
      const boundary = nextRotateOutputBoundaryMs(recipe, t);
      if (boundary !== null && boundary < nextRotationMs) {
        nextRotationMs = boundary;
      }
    }
    // Clamp to nowMs; findNextCapEvent already returns nowMs when nothing
    // changes, but if all rates are zero we still need to exit the loop.
    const segEndMs = Math.min(nextEventMs, nextPhaseMs, nextSolarMs, nextAccelMs, nextBatteryMs, nextRotationMs, nextShotMs, nowMs);
    const dtSec = (segEndMs - t) / 1000;
    if (dtSec > 0) {
      applyRates(state, net, dtSec, ctx?.caps, baseMult);
      accrueXp(state, production, consumption, dtSec, 1, skillMul.xpGain);
      // §13.3 Battery buffer — apply charge/discharge over the segment.
      if (rawBalance > 0 && maxCap > 0) {
        const chargeWs = rawBalance * dtSec;
        const charge = Math.min(chargeWs, maxCap - state.batteryStoredWs);
        state.batteryStoredWs += charge;
      } else if (rawBalance < 0 && state.batteryStoredWs > 0) {
        const deficitWs = -rawBalance * dtSec;
        const discharge = Math.min(deficitWs, state.batteryStoredWs);
        state.batteryStoredWs -= discharge;
      }
      levelUpIfReady(state);
      // terrain_modifier v5 — decrement and fire. After the segment integrates,
      // every modifier's counter loses (segEndMs - t) ms. Counters that reach
      // ≤ 0 fire the shot. We collect fires and dispatch after the loop because
      // resolveShot mutates state.buildings (splicing the modifier out).
      // NOTE: resolveShot may splice state.buildings during the callback;
      // subsequent loops over state.buildings must not assume length stability.
      const dtMs = segEndMs - t;
      if (dtSec > 0 && ctx?.onTerrainShotFire) {
        const toFire: string[] = [];
        for (const b of state.buildings) {
          const rem = b.terrainShotRemainingMs;
          if (rem === undefined) continue;
          const next = rem - dtMs;
          (b as { terrainShotRemainingMs?: number }).terrainShotRemainingMs = Math.max(0, next);
          if (rem > 0 && next <= 0) toFire.push(b.id);
        }
        for (const id of toFire) ctx.onTerrainShotFire(id);
      }
      // §4.7 operating-time accrual: every building accrues regardless of
      // whether it produced this segment (§4.7 literal: "Idle buildings,
      // stalled buildings, and inactive buildings ... accrue maintenance
      // time the same as actively-producing ones"). Done AFTER applyRates
      // so the maintenance factor used inside computeRates was computed
      // at the start-of-segment operatingMs, matching §15.3's piecewise-
      // constant-rate invariant.
      for (const b of state.buildings) {
        // §9.3 construction: tick down remaining time; operating-time
        // only accrues once the build is complete (the spec's "Idle
        // buildings ... accrue maintenance time" intent covers placed
        // buildings, not still-under-construction shells).
        const wasUnderConstruction = (b.constructionRemainingMs ?? 0) > 0;
        if (wasUnderConstruction) {
          tickConstruction(b, dtMs);
          continue;
        }
        // §NEW building-disable: player-disabled buildings freeze in place —
        // no operatingMs accrual, no maintenance degradation. Re-enable
        // resumes accrual at the frozen operatingMs value.
        if (b.disabled === true) continue;
        // §4.7 maintenance interpretation: skip accrual for buildings
        // with no productive recipe outputs. The maintenanceFactor is
        // only multiplied into recipe `effectiveRate`; a building whose
        // contribution is power / storage / signal-range / vehicle
        // dispatch (Solar, Crate, Antenna, Drone Pad, Shipyard, etc.)
        // sees zero gameplay change from degrading, so burning materials
        // to keep it "maintained" is pointless. Resource-producing
        // recipes (Mine, Smelter, Reactor, …) accrue and need
        // maintenance as before. Coal Gen / similar recipes with empty
        // outputs are treated as non-productive (their output is
        // electricity, modelled outside `recipe.outputs`).
        const recipe = resolveRecipe(BUILDING_DEFS[b.defId], b, ctx?.terrainAt);
        if (!recipe) continue;
        if (Object.keys(recipe.outputs).length === 0) continue;
        accrueOperatingTime(b, dtMs);
      }
    }
    // Advance t. If no progress was made (dt = 0 and segEnd === t) but we
    // haven't reached nowMs, force advance to avoid an infinite loop. This
    // can happen if all rates are zero — there's nothing to integrate.
    if (segEndMs <= t) {
      t = nowMs;
    } else {
      t = segEndMs;
    }
    // §13.3 acceleration queue: consume the elapsed real-time minutes from
    // the active acceleration block. If the boundary was hit, zero it and
    // pop the next queued entry (if any).
    if (state.accelerationRemainingMin > 0) {
      const consumedMin = dtSec / 60;
      state.accelerationRemainingMin -= consumedMin;
      if (state.accelerationRemainingMin <= 0 || nextAccelMs <= segEndMs) {
        state.accelerationRemainingMin = 0;
        const next = state.accelerationQueue.shift();
        if (next) {
          state.accelerationRemainingMin = next.durationMin;
        }
      }
    }
    // §4.7 auto-maintenance check. Fires at every segment boundary —
    // including inventory-cap/floor boundaries where a maintenance material
    // may have just arrived from a route delivery or a recipe completion.
    // Targeting policy (pickMostDegradedTarget): always the single
    // most-degraded over-threshold building. If its tier recipe isn't
    // fully in stock, NO maintenance fires this segment — the building
    // waits rather than letting a less-critical one consume materials.
    {
      const target = pickMostDegradedTarget(state.buildings, defs, maintenanceThresholdMul);
      if (target !== null) {
        tryAutoMaintain(target, defs[target.defId], state.inventory, t, maintenanceThresholdMul);
      }
    }
  }
  state.lastTick = nowMs;
}
