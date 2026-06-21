// Pure economy math: event-driven piecewise integration per SPEC §15.3.
//
// No PixiJS, no DOM. Functions take an `IslandState` and mutate its
// `inventory`, `xp`, `level`, `unspentSkillPoints`, and `lastTick` fields.
// The pure shape makes the loop independently testable and the offline-catchup
// path (§15.5) trivially correct — the same loop handles 1 frame and 24 hours.
//
// Why event-driven: a naive `dt × rate` step over the whole interval would
// overshoot caps (e.g., produce 101 iron_ore when cap is 100) and consume
// inputs after they've gone to zero. Splitting at events keeps each segment
// linear and exact. The integration converges in O(events × resources)
// regardless of `now - lastTick`, so multi-day offline catchup is cheap.

import { borderTiles, checkGates, clusterBonusMuls, computeBuffStack, footprintKeySet, touchesBorder, type GateResult } from './adjacency.js';
import { IDENTITY_MODIFIER_MULTIPLIERS, type ModifierMultipliers } from './biomes.js';
import { nextConstructionCompletionMs, tickConstruction } from './construction.js';
import { creditStorageCaps, promoteQueuedBuilds } from './placement.js';
import { RESOURCE_STORAGE_CATEGORY } from './storage-categories.js';
import {
  BUILDING_DEFS,
  buildingUnlocked,
  type BuildingDef,
  type BuildingDefId,
} from './building-defs.js';
import { hasOperationalBuilding, isOperationalBuilding, participatesInCluster, floorLevel, floorScaledCapacity, floorEffectMul, floorPowerDrawMul, activeFloorLevel, activeFloors, type PlacedBuilding } from './buildings.js';
import type { WorldState } from './world.js';
import { isOceanTile } from './world.js';
import { nextRealPhaseBoundaryMs, nextSolarBoundaryMs, realPhaseName, solarMultiplier } from './daynight.js';
import { sumIslandCo2, weather } from './weather.js';
import { resolveHeatAssignments, MIN_HEAT_FACTOR, type HeatAssignments } from './heat.js';
import type { TerrainKind } from './island.js';
import { footprintTiles } from './shape-mask.js';
import {
  accrueOperatingTime,
  maintenanceFactor,
  nextMaintenanceBoundaryMs,
  pickMostDegradedTarget,
  tryAutoMaintain,
} from './maintenance.js';
import { advanceToxicityRolls, TOXICITY_DURATION_MS, toxicityMultiplier } from './reactor-toxicity.js';
import { makeSeededRng } from './rng.js';
import { nextRotateOutputBoundaryMs, resolveRecipe, resolveRotatingOutput, XP_WEIGHT, type Recipe, type ResourceId } from './recipes.js';
import { cloneSkillMultipliers, effectiveSkillMultipliers, skillPointsForLevelUp, type NodeId, effectiveTierShift, tierForLevel, skillUnlockedAdjacencyRules, type SkillMultipliers, DEFAULT_GRAPH, type ConditionalEffectCondition, type ExoticAdjacencyRule } from './skilltree.js';
import { solveFlow, type FlowBuildingSpec } from './flow-solver.js';
import { solveBrownoutFactor, type PowerSample } from './flow-power-fixpoint.js';
import type { CrystalId, EdgeId, Graph } from './skilltree-graph.js';
import { networkedIslandIds } from './network-consciousness.js';
import { isOutputCapExempt } from './output-cap.js';
export { OUTPUT_CAP_EXEMPT } from './output-cap.js';

/** Returns true if any 4-neighbor of `focal` has a `defId` in `defIds`. */
export function hasNeighborWithAnyDefId(
  focal: PlacedBuilding,
  buildings: ReadonlyArray<PlacedBuilding>,
  defIds: ReadonlyArray<BuildingDefId>,
): boolean {
  const fp = footprintKeySet(focal, BUILDING_DEFS);
  const border = borderTiles(fp);
  const wanted = new Set(defIds);
  for (const other of buildings) {
    if (other.id === focal.id) continue;
    if (!wanted.has(other.defId)) continue;
    if (touchesBorder(other, border, BUILDING_DEFS)) return true;
  }
  return false;
}

/** Per-battery-def electrical buffer capacity in (power-unit)·seconds.
 *  Since the canonical power unit is now kW, these values are kW·seconds:
 *    battery_bank        = 5_000   * 3600 kW·s = 5 MWh
 *    capacitor_bank      = 100_000 * 3600 kW·s = 100 MWh
 *    flywheel_array      = 2_000_000 * 3600 kW·s = 2 GWh
 *    singularity_battery = 50_000_000 * 3600 kW·s = 50 GWh
 *  The constant is named BATTERY_CAPACITY_WS for continuity; the "WS"
 *  suffix now means (power-unit)·seconds with power-unit = kW.
 *  Summed across every operational battery on an island to compute total cap.
 *  Buildings not in this table contribute 0 — non-battery buildings ignore the path. */
export const BATTERY_CAPACITY_WS: Readonly<Partial<Record<BuildingDefId, number>>> = {
  battery_bank:        5_000      * 3600,
  capacitor_bank:      100_000    * 3600,
  flywheel_array:      2_000_000  * 3600,
  singularity_battery: 50_000_000 * 3600,
};

/** Anti-freeze threshold (fix 3.4): a `batteryStoredWs` below 1 Ws is
 *  treated as EMPTY by the deficit-cover decision, the depletion-boundary
 *  computation, and the per-segment discharge — and is flushed to 0 when a
 *  discharge leaves less than this. Rationale: a depletion-bounded segment
 *  with ms-rounded dtSec leaves an ~1e-16-relative residue; the next
 *  iteration then "covers" the deficit again and computes a boundary
 *  `t + ~1e-12 ms`, which rounds back to exactly `t` at realistic
 *  perf-clock magnitudes — a zero-length segment whose force-jump skips
 *  ALL remaining integration for the call, every frame. Mirrors the 1-unit
 *  inventory threshold documented in `findNextCapEvent`. 1 Ws = 1 kW for
 *  one millisecond — far below gameplay-visible scale. */
export const BATTERY_EMPTY_THRESHOLD_WS = 1;

/**
 * §15.3 net-flow regime tolerance (issue #112). A resource bin is treated as
 * empty (zero-constrained) at `stock <= STOCK_BOUNDARY_EPS` and full
 * (cap-constrained) at `stock >= cap - STOCK_BOUNDARY_EPS`, rather than at the
 * exact `0` / `cap` boundary. Floating-point arithmetic leaves sub-nanounit
 * DUST at a pinned bin — e.g. a near-empty bin clamped to 0 by `applyRates`
 * while a producer trickles a few atto-units back in. Without this band the
 * regime scan classifies that dust as "not empty", so `solveFlow` never gates
 * the dust-bin consumer/producer, `net` never settles toward 0, and
 * `findNextCapEvent` re-fires a `tMs + 1` event every segment — a flicker that
 * grinds the integrator to its 10k-segment safety cap (~12s of synchronous
 * catch-up). The band is far below any meaningful stock (recipe flows are
 * ≥ ~1e-4 units/s), so a healthy economy's resource never lingers inside it.
 */
export const STOCK_BOUNDARY_EPS = 1e-9;

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
 * There is no `'anchor-disconnected'` reason: `submarine_cable` is a
 * `RouteType` rather than a tile-placed component, so there's no cable-graph
 * to break. Anchoring is a declarative field, not a graph relationship.
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
  /** §7.4 single global atmosphere. When the world driver supplies this shared
   *  mutable holder, `applySegmentSideEffects` accrues emissions to / drains
   *  sinks from it (floored at 0) — making CO₂ global across all islands —
   *  instead of the per-island `state.co2Kg`. Absent ⇒ standalone advance falls
   *  back to `state.co2Kg`, preserving isolated-unit-test semantics. */
  readonly co2Pool?: { kg: number };
  /** §9.9 active-play production bonus — world-level recipe-rate multiplier
   *  (`activeBonusMul(world)` in active-bonus.ts). Unlike `ncBuff`
   *  (per-island, networked T3+ only) this applies to EVERY island.
   *  Default 1 (no bonus). */
  readonly activeBonusMul?: number;
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
  /** §13.3 Omniscient Lattice union flow solve (D-01). Flow coefficients
   *  (gate-1 produces/consumes, units/sec) of the buildings on the OTHER
   *  lattice members. Pass 2.5 appends these to this island's own
   *  `flowBuildings` before `solveFlow`, so the solver throttles producers
   *  and consumers across islands against each other (shared θ/φ + min rule)
   *  exactly as it does same-island flows. Indexed ≥ `tentative.length`, so
   *  passes 3–4 never read their gates back — they exist purely to shape the
   *  shared factors. Pre-computed by `advanceLatticeGroup` (lattice-advance.ts)
   *  from the union of member flow specs. Undefined ⇒ no union (non-lattice
   *  path byte-identical). */
  readonly flowSiblings?: ReadonlyArray<FlowBuildingSpec>;
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
  /** §5.3 cable pre-pass seam: when set, computeRates solves the net-flow
   *  gates against THIS brownout factor (no local pf fixpoint) and reports it
   *  verbatim as `power`. Used by computeCableNetworkBalance's component
   *  fixpoint to probe a member's draw at a candidate shared pf. Distinct from
   *  cableComponent.unified (the FINAL frozen component pf consumed during
   *  advance); fixedPowerFactor takes precedence when both are present. */
  readonly fixedPowerFactor?: number;
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

/** Shorthand for the per-resource stockpile map used in `IslandState`. */
export type Inventory = Record<ResourceId, number>;

/**
 * §4.8 a single QUEUED floor-upgrade job that has not started running yet —
 * one pending upgrade for `buildingId`, beyond whatever upgrade (if any) is
 * currently RUNNING on that building. Ordered globally by `seq` (sourced from
 * `IslandState.nextQueueSeq`) for FIFO promotion. A queued upgrade does NOT
 * set the building's `constructionRemainingMs`, so the building keeps producing
 * at its completed floor until the job promotes to running (`promoteQueuedBuilds`).
 * Cost is paid at enqueue time. `kind` is a union for forward-compat; only
 * 'upgrade' stacks today (placements never stack).
 */
export interface BuildJob {
  readonly seq: number;
  readonly buildingId: string;
  readonly kind: 'upgrade';
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
  /** Resources this island has ever produced (inventory raised above 0 at least
   *  once). Gates the "get" side of Trade Offers. Persisted.
   *
   *  Recording is on NET production (`rate > 0`), i.e. surplus, not gross — a
   *  resource produced and fully consumed within the same integration segment
   *  (net rate 0) is not recorded. */
  everProduced: Set<ResourceId>;
  /** Trade Offers: online-ms remaining until this island's Signal Exchange
   *  may spawn its next offer. Counts down only on online frames (see
   *  `tickTradeOffers`); persisted so a page refresh can't reset the cadence
   *  (closing the infinite-trade-via-refresh exploit). Seeds to 0 — the first
   *  offer is prompt. */
  tradeCooldownMs: number;
  /** Trade Offers: count of timely reactions (accept or manual reject) on this
   *  island. Drives the compounding 1%-per-reaction speedup (see
   *  `effectiveCadenceMs`). Persisted. */
  tradeAcceptCount: number;
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
  /** Wall-clock timestamp (`performance.now()` domain, matching `lastTick`)
   *  of the last §9.7 Tier Reset on this island, or null if the island has
   *  never been reset. Drives the 24-hour cooldown gate in `canTierReset`.
   *  Null on a fresh island; stamped by `executeTierReset(state, nowMs)`.
   *  perfShift-ed on deserialize so the cooldown gate reads a real elapsed
   *  value across save/load. */
  lastResetAt: number | null;
  /** §queue: next FIFO sequence number to stamp on an enqueued build.
   *  Incremented on each enqueue. Optional; absent ≡ 0 (forward-compat). */
  nextQueueSeq?: number;
  /** §4.8 queued upgrade jobs (see `BuildJob`). Optional; absent ≡ [] for
   *  forward-compat with pre-v24 saves. Mutated by `applyUpgrade` (enqueue),
   *  `promoteQueuedBuilds` (dequeue→running), and `cancelConstruction` (LIFO). */
  buildJobs?: BuildJob[];
  /** Wall-clock timestamp of the last advance, in milliseconds. */
  lastTick: number;
  /** §13.3 Time Lock banked time in minutes. One per Time Lock building. */
  timeLockBankedMin: number;
  /** §13.3 Currently active acceleration queue. */
  accelerationQueue: Array<{ readonly durationMin: number }>;
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
export function tierForResource(r: ResourceId): number {
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

/** Variance samples once per real-time second and must not be frozen across a
 *  long catch-up segment, so the integrator clamps segment length to this
 *  period whenever the `high_wind` modifier is active. */
const VARIANCE_SAMPLE_MS = 1000;

/** Compute the variance factor for high_wind modifier. Deterministic per
 *  (islandId, second). Returns 1 when variance is inactive. */
function computeVarianceFactor(state: IslandState, modifierMul: ModifierMultipliers, nowMs: number): number {
  if (!modifierMul.outputVariance) return 1;
  const varianceRng = makeSeededRng(`${state.id}_variance_${Math.floor(nowMs / 1000)}`);
  return 0.8 + varianceRng() * 0.4; // ±20%
}

/** Set the Genesis Chamber target resource. Returns false if the target is
 *  outside the T1-T4 band (including T0 and T5+). Pass `null` to clear the
 *  target and stop production. */
export function setGenesisTarget(state: IslandState, target: ResourceId | null): boolean {
  if (target === null) {
    state.genesisTarget = null;
    return true;
  }
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
// Perf note: callers that don't thread `mult` (UI paths — hud/inventory/
// inspector, per resource per frame) fall back to `effectiveSkillMultipliers`,
// which is memoized at source since §perf-2026-06-10 (skilltree.ts) — the
// fallback is a signature check + clone, not a full graph re-fold.
export function cap(
  state: IslandState,
  r: ResourceId,
  override?: Record<ResourceId, number>,
  opts?: { ignoreGrace?: boolean },
  mult?: SkillMultipliers,
): number {
  const nominal = override?.[r] ?? state.storageCaps[r] ?? 0;
  // §12.4: starter grace must apply even at zero nominal cap — the early
  // return on nominal === 0 sat BEFORE the grace read, which made the kit
  // allowance unreachable for resources with no storage built yet (fix 3.3).
  // The zero short-circuit is kept (skill-mul fold skipped) but now resolves
  // to the grace value unless the caller asked to ignore it.
  if (nominal === 0) {
    if (opts?.ignoreGrace) return 0;
    return state.starterInventoryGrace[r] ?? 0;
  }
  const resolvedMult = mult ?? effectiveSkillMultipliers(state);
  // Storage sub-path (depth ≥ 2): per-category cap multiplier. Looks up the
  // resource's storage category — if it hasn't been categorised yet
  // (forward-compat with new resources) the lookup returns undefined and the
  // category-mul defaults to 1.
  const cat = RESOURCE_STORAGE_CATEGORY[r];
  const catMul = cat ? resolvedMult.storageCategoryCap[cat] ?? 1 : 1;
  const computedCap = nominal * catMul;
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
export interface BuildingRate {
  readonly building: PlacedBuilding;
  readonly recipe: Recipe;
  /** Cycles per second this building is currently running at. */
  readonly effectiveRate: number;
  /** Duty-cycle fraction [0,1] — dynamic gates only (§4.7 net-flow):
   *  adjacency soft-gate × heat throttle × flow-solver gate × powerFactor
   *  (consumers). EXCLUDES maintenanceFactor (no degradation-slows-
   *  degradation feedback), time-acceleration, variance, and static yield
   *  multipliers. Drives operatingMs accrual. */
  readonly utilization: number;
}

/** Per-kind catalog lookup. Production callers pass `BUILDING_DEFS` (the
 *  default); tests pass a custom catalog when they need to vary per-kind
 *  power values (e.g., the partial-brownout fixture using an 80 kW Mine). */
export type DefCatalog = Readonly<Record<BuildingDefId, BuildingDef>>;

/**
 * Compute the binary output-availability factor for a recipe: 0 if any of
 * the recipe's outputs is at or above cap, else 1.
 *
 * §15.3 net-flow rework: NARROWED ROLE. Running buildings (baseRate > 0)
 * are throttled continuously by the pass-2.5 flow-solver gate instead of
 * this binary stall; this helper survives solely for the pass-3 power
 * probe on baseRate-0 buildings (stalled for non-storage reasons).
 */
/** §2.6 non-stored outputs (resource-graph-closure plans P0 + P6). These
 *  resources are produced but never sit in island inventory:
 *
 *  - `co2` is the **single global atmosphere** (§7.4 / closure plan P6): its
 *    climate contribution lives in the per-island `state.co2Kg` scalar
 *    (`advanceIsland`), and the world total is `Σ co2Kg` (`sumIslandCo2`). It
 *    must NOT also sit in inventory — that was a double-booking. So `co2` is
 *    non-stored here while its `co2Kg` accrual continues independently.
 *
 *  Membership means: never written to inventory (`applyRates`), never counted
 *  as a cap-stall (`outputAvail` / the solver's `capConstrained`), and drained
 *  to 0 each `advanceIsland` so a pre-change save can't strand stock.
 *
 *  P4 Phase 1 (task 2): the 6 byproduct gases/solid (`co`, `refinery_gas`,
 *  `wood_tar`, `water_vapor`, `cryo_coolant_vented`, `mill_scale`) moved OUT
 *  of NON_STORED_OUTPUTS into `OUTPUT_CAP_EXEMPT` below — they are now STORED
 *  (so a future consumer recipe can draw them) but per-output cap-exempt (so a
 *  full byproduct bin never throttles its producer's valuable PRIMARY output).
 *  Only `co2` remains non-stored. */
export const NON_STORED_OUTPUTS: ReadonlySet<ResourceId> = new Set<ResourceId>([
  'co2',
]);



function outputAvail(
  building: PlacedBuilding,
  state: IslandState,
  recipe: Recipe,
  nowMs: number,
  caps?: Record<ResourceId, number>,
  baseMult?: SkillMultipliers,
): number {
  const outputs = resolveRotatingOutput(recipe, nowMs);
  for (const [r, _yield] of Object.entries(outputs)) {
    const id = r as ResourceId;
    if (NON_STORED_OUTPUTS.has(id)) continue; // §2.6: not stored — never stalls
    // §4.6 per-output Ignore Cap (task 2): a cap-exempt output is stored up to
    // cap but never stalls its producer — a full bin must not return 0 here.
    // Per-building override (`isOutputCapExempt`) wins over the global default.
    if (isOutputCapExempt(building, id)) continue;
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
 * §15.3 net-flow rework: NARROWED ROLE. Running buildings (baseRate > 0)
 * get their input throttle from the pass-2.5 flow-solver gate (shared φ
 * per zero-pinned resource); this helper survives solely as the pass-3
 * power probe for baseRate-0 buildings.
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
  /** §9.3 magic divisor on per-cycle input demand (≥1; 1 = no effect). */
  recipeInputDiv: number,
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
    const demand = ((needPerCycle ?? 0) / recipeInputDiv) * baseRate;
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
      const cell = weather(world.seed, island.cx, island.cy, nowMs, island.biome, sumIslandCo2(world));
      return cell.state === 'storm' || cell.state === 'severe_storm' || cell.state === 'catastrophic';
    }
    case 'during-night': {
      if (nowMs === undefined) return false;
      return realPhaseName(nowMs, world?.playerLat ?? null, world?.playerLon ?? null) === 'night';
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
      // No-op: storage cap is now per-category (storageCategoryCapMul), there
      // is no uniform storage-cap multiplier. 'storage' is also a *building*
      // category, not a recipe category — no recipe consumes
      // recipeRate['storage'] — so we explicitly drop this here rather than
      // let it fall through to the recipe-rate branch and write a phantom key.
      continue;
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
   *  throughput fraction (gateMul × flow-solver gate g for running
   *  buildings; gateMul × inputAvail × outputAvail probe for baseRate-0
   *  buildings) per the §5.1 throughput-scaled-power rebalance. Storage-
   *  throttled and soft-gate degraded buildings contribute proportionally
   *  less (or zero); heat-failed / hard-gate / tier-gated consumers
   *  contribute zero. */
  readonly consumed: number;
  /** `consumed === 0 ? 1 : min(1, produced / consumed)`. */
  readonly factor: number;
  /** Power produced before battery buffer discharge adjustment. */
  readonly rawProduced: number;
  /** Power consumed before battery buffer discharge adjustment. */
  readonly rawConsumed: number;
}

/** Per-building-type yield bonus (Mining "vein depth", Forestry "regrowth",
 *  …) — stacks multiplicatively on top of the global recipeRate category
 *  mul for the matching building defId. Mine, deep_mine, heavy_mine etc all
 *  share the 'mine' family. Extracted from pass 4 so pass 1 can fold the
 *  same factor into the tentative supply pool (fix 3.7). */
function buildingYieldBonus(defId: BuildingDefId, skillMul: SkillMultipliers): number {
  if (defId === 'iron_mine' || defId === 'coal_mine' || defId === 'deep_mine' || defId === 'copper_mine'
      || defId === 'tin_mine' || defId === 'lead_mine' || defId === 'bauxite_mine'
      || defId === 'quartz_mine' || defId === 'sulfur_mine' || defId === 'phosphate_mine'
      || defId === 'graphite_mine' || defId === 'limestone_quarry'
      || defId === 'quarry' || defId === 'uranium_mine') {
    return skillMul.mineYieldBonus;
  } else if (defId === 'logger' || defId === 'heavy_logger') {
    return skillMul.loggerYieldBonus;
  } else if (defId === 'pump_jack' || defId === 'drilling_rig' || defId === 'trench_drill') {
    return skillMul.drillYieldBonus;
  } else if (defId === 'patron_hub') {
    return skillMul.patronageYieldBonus;
  } else if (defId === 'aetheric_conduit' || defId === 'spacetime_resonator'
      || defId === 'eldritch_sieve' || defId === 'casimir_tap'
      || defId === 'zero_point_extractor' || defId === 'neutronium_extractor') {
    return skillMul.t5ExtractorYieldBonus;
  }
  // Note: aquacultureYieldBonus has no consumer in building-defs.ts today.
  // The multiplier folds but is dormant until aquaculture buildings land.
  return 1;
}

/**
 * §9 Fledgling Island Boost — a level-scaled multiplier on every production
 * recipe's throughput so a freshly-settled island isn't an hours-long slog. It
 * starts at +150% (×2.5) at level 1 and ramps linearly to +0% (×1.0) at level
 * 10, then stays neutral forever. `max(0, …)` self-clamps above level 10 (the
 * boost never goes negative), so no separate guard is needed. Pure function of
 * level; no persisted state. XP accrues on the boosted production (§9.1), so
 * the early levels pass quickly and the island exits the boost window on its
 * own. Applied alongside the other multipliers in `computeRates`' rate product.
 */
export function fledglingRecipeMul(level: number): number {
  return 1 + 1.5 * Math.max(0, (10 - level) / 9);
}

// ───────────────────────────────────────────────────────────────────────────
// §perf-2026-06-10 — signature-keyed memo for adjacency/skill derivations.
//
// computeRates used to re-derive, on EVERY call (every integration segment,
// every frame, every island), a family of values that only change when
// buildings or skills change: cluster-bonus multipliers (`clusterBonusMuls`,
// 20.6% incl in the live-save profile), per-building buff stacks and gate
// results (`computeBuffStack`/`checkGates` via the borderTiles/touchesBorder
// footprint walks, ~25% combined), exotic adjacency rules
// (`skillUnlockedAdjacencyRules`, 5.1% — previously re-folded PER BUILDING
// inside pass 1), per-def tier activation (`isBuildingActive`, 8%), and the
// base skill-multiplier fold (`effectiveSkillMultipliers`).
//
// The cache is SELF-VALIDATING: `derivationsSignature` re-folds every input
// that feeds the cached family on every call and compares it to the
// signature the entry was built for. There are no invalidation call-sites to
// maintain — any mutation that affects a cached derivation changes the
// signature and forces a rebuild, so a missed mutation site can never serve
// stale data. (Same observable-purity story as the weather memo: behavior is
// bit-identical — the cached values were produced by the same code on the
// same inputs — only repeated work is skipped.)
//
// CACHED (constant while the signature is stable):
//   - clusterMuls            — §4.5 cluster-bonus multipliers (eager)
//   - exoticRules            — §9.3 exotic adjacency pair rules (eager)
//   - baseSkillMul           — un-layered effectiveSkillMultipliers fold
//                              (eager; itself a clone served by the source
//                              memo in skilltree.ts since §perf-2026-06-10 —
//                              harmless double-caching, kept layered so the
//                              equivalence argument stays per-memo-local;
//                              ALWAYS cloned before handing out —
//                              layerConditionalBonuses mutates in place, the
//                              Option-B landmine in the 2026-05-27
//                              skillmult-memoize spec)
//   - buffStack / gateResult — per-building-id, lazily filled
//   - activeByDefId          — isBuildingActive verdicts, per defId, lazy
//
// Deliberately LIVE (time- or inventory-varying within a stable signature):
// solar/wind multipliers, variance, maintenanceFactor (operatingMs),
// toxicity, heat assignments + the coal-starvation recompute, recipe
// resolution (§6.7 scrap substitution reads inventory), rotating outputs,
// inputAvail, the pass-2.5 flow solve, the power balance + battery, and the
// fledgling/acceleration/conditional-bonus multipliers.
interface DerivationsMemo {
  /** Signature of the inputs this entry was built for. */
  signature: string;
  /** Def catalog identity guard — tests inject custom catalogs, and the
   *  footprints/categories/gates of every cached derivation come from it.
   *  Compared by reference. */
  defs: DefCatalog;
  clusterMuls: Map<string, number>;
  exoticRules: ReadonlyArray<ExoticAdjacencyRule>;
  baseSkillMul: SkillMultipliers;
  buffStack: Map<string, number>;
  gateResult: Map<string, GateResult>;
  activeByDefId: Map<BuildingDefId, boolean>;
}

const derivationsMemoByIsland = new Map<string, DerivationsMemo>();

/** Test hook: reset the memo so equivalence tests can compare a warm-cache
 *  compute against a cold one (mirrors `clearWeatherCacheForTests`). */
export function clearDerivationsMemoForTests(): void {
  derivationsMemoByIsland.clear();
}

/**
 * Structural signature over every input feeding the cached derivations.
 * Enumerated against the actual functions (see the per-line notes):
 *
 *   - per building: id, defId, x, y, rotation (footprints for cluster /
 *     buff / gate walks), disabled / invalid / under-construction-bit
 *     (`isOperationalBuilding` membership in `validBuildings` — only the
 *     BINARY operational state matters, so construction progress folds as
 *     `>0`, not the remaining ms; a decrementing countdown doesn't thrash
 *     the cache and the completion flip rebuilds it), floorLevel (folded
 *     conservatively; it feeds only live rate math today).
 *     NOT folded: `paused` (mutated by computeRates itself; read live in
 *     pass 3, feeds nothing cached), `eternalServitor` / `operatingMs` /
 *     `toxicityExpiryMs` (feed the live maintenance/toxicity factors only),
 *     `cargoLabel`/`tier`/queue fields (no cached consumer).
 *   - state.level, aiCoreCrafted, ascendantCoreCrafted — `isBuildingActive`
 *     inputs (`buildingUnlocked`, `tierForLevel`). The spaceport half of the
 *     §14.1 gate is derived from the buildings fold above.
 *   - unlockedNodes CONTENTS (not size+last: §9.7 Tier Reset and tests can
 *     remove/replace nodes, so "only grows" does not hold) — feeds
 *     `effectiveSkillMultipliers`, `skillUnlockedAdjacencyRules`,
 *     `effectiveTierShift`. Insertion-order fold: a same-content different-
 *     order set misses and rebuilds (correct, just unmemoized).
 *     `unlockedEdges` feeds NO cached derivation (verified: the skill-mul
 *     fold and aura walk read `unlockedNodes` only) and is not folded.
 *   - geothermalActive, and ctx.crossIsland id+defId pairs — `checkGates`
 *     inputs (§13.3 lattice neighbors match by def only; positions are
 *     irrelevant because `collectNeighbors` adds them unconditionally).
 *
 * String (not number-hash) on purpose: a hash collision would serve stale
 * data; string equality cannot. One join per call, no JSON.stringify.
 */
function derivationsSignature(
  state: IslandState,
  geothermalActive: boolean,
  crossIsland: ReadonlyArray<PlacedBuilding> | undefined,
): string {
  const parts: string[] = [
    String(state.level),
    state.aiCoreCrafted ? '1' : '0',
    state.ascendantCoreCrafted ? '1' : '0',
    geothermalActive ? '1' : '0',
  ];
  for (const b of state.buildings) {
    parts.push(
      `${b.id},${b.defId},${b.x},${b.y},${b.rotation ?? 0},${activeFloors(b) <= 0 ? 1 : 0},${b.invalid === true ? 1 : 0},${(b.constructionRemainingMs ?? 0) > 0 ? 1 : 0},${b.floorLevel ?? 0}`,
    );
  }
  parts.push('#n');
  for (const n of state.unlockedNodes) parts.push(n as string);
  if (crossIsland !== undefined && crossIsland.length > 0) {
    parts.push('#x');
    for (const cb of crossIsland) parts.push(`${cb.id},${cb.defId}`);
  }
  return parts.join(';');
}

function getDerivationsMemo(
  state: IslandState,
  defs: DefCatalog,
  geothermalActive: boolean,
  crossIsland: ReadonlyArray<PlacedBuilding> | undefined,
): DerivationsMemo {
  const signature = derivationsSignature(state, geothermalActive, crossIsland);
  const hit = derivationsMemoByIsland.get(state.id);
  if (hit !== undefined && hit.signature === signature && hit.defs === defs) {
    return hit;
  }
  // §4.5/#35: the cluster set includes UNDER-CONSTRUCTION buildings (excluding
  // only invalid/disabled) so an in-progress shell still bridges its cluster and
  // contributes its completed-floor capacity. `clusterFloorCapacity` discounts
  // the floor being built; the resulting bonus is only ever read for operational
  // buildings (under-construction ones don't produce), so the wider set is safe.
  const clusterBuildings = state.buildings.filter((b) => participatesInCluster(b));
  const entry: DerivationsMemo = {
    signature,
    defs,
    clusterMuls: clusterBonusMuls(clusterBuildings, defs),
    exoticRules: skillUnlockedAdjacencyRules(state),
    baseSkillMul: effectiveSkillMultipliers(state),
    buffStack: new Map(),
    gateResult: new Map(),
    activeByDefId: new Map(),
  };
  derivationsMemoByIsland.set(state.id, entry);
  return entry;
}

// cloneSkillMultipliers moved to skilltree.ts (§perf-2026-06-10) — it now
// lives next to the source memo whose private master it protects, and is
// re-imported above. One clone implementation, one mutation-safety contract.

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
/** Effective inventory for `resolveRecipe` variant selection. `ctx.inventory`
 *  is a PARTIAL pooled override (§13.3 lattice / shared-network), so a bare
 *  `ctx?.inventory ?? state.inventory` lets an empty or partial pool HIDE the
 *  island's own stock — breaking §8.x alt-input variant selection (e.g. a
 *  Chlor-Alkali Plant with its own mercury never picks the mercury-cell recipe
 *  on a shared-network island that pools nothing). Merge the pool OVER the
 *  island's own inventory: pooled values win for shared keys, own stock is kept
 *  for everything else. Returns the bare `state.inventory` (no allocation) when
 *  there is no override — the common, non-networked case. Mirrors the per-key
 *  fallback the heat-fuel path already uses (see the `coalStock` note below). */
export function recipeInventoryFor(
  state: IslandState,
  ctx?: RatesContext,
): Record<ResourceId, number> {
  return ctx?.inventory ? { ...state.inventory, ...ctx.inventory } : state.inventory;
}

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
  /** INTERNAL (fix 4.1 fuel gate) — coal-fired heat sources judged
   *  fuel-starved by a prior pass of this same call. Consumers assigned to
   *  these furnaces are forced to hasHeat=false / factor 0 and the furnaces
   *  bill no coal. Only `computeRates` itself passes this (recursion depth
   *  ≤ 1); external callers must omit it. */
  coalStarvedFurnaces?: ReadonlySet<string>,
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
  /** §13.3 D-01 union flow solve: the gate-1 flow coefficients of THIS
   *  island's operating buildings (the `flowBuildings` array assembled in
   *  pass 2.5, EXCLUDING the synthetic furnace-coal entries and any injected
   *  `ctx.flowSiblings`). `advanceLatticeGroup` collects these across members
   *  to build each member's `flowSiblings` union for the next computeRates
   *  call. Same order/length as `byBuilding`'s producing entries' `tentative`
   *  index — but treated as an opaque coefficient bag by the orchestrator. */
  flowSpecs: ReadonlyArray<FlowBuildingSpec>;
} {
  const {
    modifierMul = IDENTITY_MODIFIER_MULTIPLIERS,
    defs = BUILDING_DEFS,
    ncBuff = 1,
    activeBonusMul = 1,
    terrainAt,
  } = ctx ?? {};
  // §8.x alt-input variant selection reads the island's OWN inventory merged
  // under any partial pooled override (computed once per call, not per building).
  const recipeInv = recipeInventoryFor(state, ctx);
  // Filter out invalid buildings once so they don't participate in heat,
  // buffs, spaceport checks, or power balance. Under-construction buildings
  // (constructionRemainingMs > 0) are ALSO filtered out — they consume
  // neither power nor recipe inputs, contribute zero output, and are
  // invisible to adjacency-buff scans until they finish.
  const validBuildings = state.buildings.filter((b) => isOperationalBuilding(b));
  // §perf-2026-06-10: signature-keyed memo for the adjacency/skill
  // derivations (see the DerivationsMemo block above computeRates).
  const memo = getDerivationsMemo(state, defs, ctx?.geothermalActive ?? false, ctx?.crossIsland);
  // §4.5 cluster-bonus multipliers — labelled once per tick for the whole
  // island; recipe-rate (computeBuffStack) and generator-power both read from
  // this map instead of re-deriving each building's cluster.
  const clusterMuls = memo.clusterMuls;
  // §4.5 gating adjacency, memoized per building id within the signature-
  // stable world (pass 1, pass 3, and the genesis paths all evaluate the
  // same (building, validBuildings, defs, geothermal, crossIsland) tuple).
  const gateFor = (b: PlacedBuilding): GateResult => {
    let r = memo.gateResult.get(b.id);
    if (r === undefined) {
      r = checkGates(b, validBuildings, defs, ctx?.geothermalActive ?? false, ctx?.crossIsland);
      memo.gateResult.set(b.id, r);
    }
    return r;
  };
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
  const rampMul = solarMultiplier(
    solarClockMs ?? t,
    ctx?.world?.playerLat ?? null,
    ctx?.world?.playerLon ?? null,
  );
  const solarMul = Math.min(1, rampMul + (ctx?.solarBoost ?? 0));
  const varianceFactor = computeVarianceFactor(state, modifierMul, t);
  // The §5.1 active flag depends on inputAvail, and inputAvail must be
  // computed at NOMINAL rate (independent of powerFactor) to avoid a circular
  // dependency. PowerFactor is then applied to consumers' final effective
  // rate. As long as all consumers scale by the same factor, the relative
  // supply/demand ratios — and therefore inputAvail — stay correct.
  //
  // Four passes (+ the 2.5 net-flow solve):
  //   1.   Tentative baseRate from the non-storage gates (heat, tiles, tier,
  //        adjacency). Storage state no longer bails here — §15.3 net-flow.
  //   2.   inputAvail per recipe, using the supply pool from pass 1 (kept as
  //        the pass-3 power probe for baseRate-0 buildings).
  //   2.5. Exact net-flow solve → per-building gate g (flow-solver.ts).
  //   3.   P_produced / P_consumed sums over `active` buildings; powerFactor.
  //   4.   Final effectiveRate = baseRate × g × (consumes-power ? powerFactor : 1).
  //
  // Skill multipliers (§9.3) are read once at the top so every pass uses
  // consistent values. Recipe-rate buffs apply to baseRate AND to pass-2's
  // nominalRate (so producer/consumer supply ratios stay correct when only
  // one side is buffed). Power multipliers apply in pass 3.
  const skillMul = cloneSkillMultipliers(memo.baseSkillMul);
  // Conditional bonuses are evaluated in WALL-clock domain (`solarClockMs ?? t`),
  // not perf domain: the during-night condition calls `realPhaseName`, which is
  // astronomically anchored to the Date.now epoch — same reasoning as the
  // `solarMultiplier` sample above (see the `nowMs` param doc).
  layerConditionalBonuses(skillMul, state, ctx?.world, DEFAULT_GRAPH, solarClockMs ?? t);
  // §9.3 magic `recipeInputMul` lever (resolved field: `recipeInput`, ≥1).
  // Divides per-cycle input DEMAND (pass 2) and actual DRAWDOWN (pass 4) so a
  // building with the lever consumes fewer inputs while producing identical
  // outputs. `recipeInput` is never layered by conditional bonuses, so it's
  // safe to read off the injected (frozen) `ctx.baseMult` directly when
  // present — analogous to the read-only injected-mult path in
  // `cap()`/`outputAvail` (mechanism differs: cap() threads the full
  // SkillMultipliers object and recomputes as fallback; here we resolve a
  // scalar and fall back to the already-computed skillMul). In production
  // `ctx.baseMult.recipeInput === skillMul.recipeInput` (both fold the same
  // state), so this is a strict no-op; the injection seam exists for tests.
  const recipeInputDiv = ctx?.baseMult?.recipeInput ?? skillMul.recipeInput;
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
  let heat = resolveHeatAssignments(validBuildings, ctx?.geothermalActive ?? false);
  // Fix 4.1 (recursed pass): apply the fuel-starvation verdict from the
  // first pass — consumers assigned to a starved coal furnace lose heat
  // entirely (hasHeat=false, factor 0) and the furnace bills no coal. See
  // the gate at the bottom of this function for the starvation condition.
  if (coalStarvedFurnaces !== undefined && coalStarvedFurnaces.size > 0) {
    const hasHeat = new Map(heat.hasHeat);
    const coalConsumersByFurnace = new Map(heat.coalConsumersByFurnace);
    const assignedSource = new Map(heat.assignedSource);
    const heatThrottleFactor = new Map(heat.heatThrottleFactor);
    for (const [consumerId, srcId] of heat.assignedSource) {
      if (!coalStarvedFurnaces.has(srcId)) continue;
      hasHeat.set(consumerId, false);
      heatThrottleFactor.set(consumerId, 0);
      assignedSource.delete(consumerId);
    }
    for (const furnaceId of coalStarvedFurnaces) coalConsumersByFurnace.delete(furnaceId);
    heat = { hasHeat, coalConsumersByFurnace, assignedSource, heatThrottleFactor, deliveredBySource: heat.deliveredBySource };
  }
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
    // §perf-2026-06-10: the verdict is a pure function of (defId, level,
    // core flags, hasSpaceport, unlockedNodes) — all folded in the memo
    // signature — so it's memoized per defId.
    const cached = memo.activeByDefId.get(b.defId);
    if (cached !== undefined) return cached;
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
    memo.activeByDefId.set(b.defId, unlocked);
    return unlocked;
  }
  interface Tentative {
    readonly building: PlacedBuilding;
    readonly recipe: Recipe;
    /** Base cycles/sec before input-availability throttling. */
    readonly baseRate: number;
    /** §4.5 category-adjacency × exotic-pair multiplier for this building,
     *  captured in pass-1 and reused in pass-2's nominal-rate computation.
     *  1.0 when no same-category neighbour and no exotic rule applies. */
    readonly buffStack: number;
    /** §4.5 soft-gate multiplier: 1.0 when no gate applies, 0.0 for hard-gate
     *  zero, and between 0 and 1 for soft gates. Carried into pass-2 so
     *  nominalRate reflects the gated demand for inputAvail. */
    readonly effectiveMul: number;
    /** Fix 3.7 — per-building throughput factors that scale BOTH the
     *  building's actual production and its actual drawdown:
     *  `maintenanceFactor × toxicityMultiplier × buildingYieldBonus`.
     *  Folded into pass-1's tentSupply contribution and pass-2's
     *  nominalRate demand so the supply pool only contains units that are
     *  really produced (a maintenance-degraded producer at mf 0.5 must not
     *  "supply" its nominal rate — the consumer would conjure the missing
     *  half via applyRates' clamp). Island-uniform factors (accelMul,
     *  varianceFactor) cancel in the supply/demand ratio and stay
     *  post-applied in pass 4; the powerFactor asymmetry is deliberate —
     *  see the four-pass doc above. */
    readonly perBuildingMul: number;
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
          perBuildingMul: 1,
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
          perBuildingMul: 1,
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
          perBuildingMul: 1,
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
          perBuildingMul: 1,
        });
        continue;
      }
      const syntheticRecipe: Recipe = {
        inputs: {},
        outputs: { [target]: 1 },
        cycleSec: GENESIS_CYCLE_SEC,
        category: 'manufacturing',
      };
      const gateResult = gateFor(b);
      if (gateResult.effectiveMul === 0) {
        tentative.push({ building: b, recipe: syntheticRecipe, baseRate: 0, buffStack: 1, effectiveMul: 0, perBuildingMul: 1 });
        continue;
      }
      const baseRate = (1 / GENESIS_CYCLE_SEC) * gateResult.effectiveMul * floorEffectMul(activeFloorLevel(b));
      // Fix 3.7: same per-building throughput factors pass 4 applies.
      const genesisPbm =
        maintenanceFactor(b, defs[b.defId], skillMul.maintenanceThreshold) *
        toxicityMultiplier(b, t) *
        buildingYieldBonus(b.defId, skillMul);
      tentative.push({ building: b, recipe: syntheticRecipe, baseRate, buffStack: 1, effectiveMul: gateResult.effectiveMul, perBuildingMul: genesisPbm });
      tentSupply[target] = (tentSupply[target] ?? 0) + baseRate * genesisPbm;
      continue;
    }

    // Tile-aware recipe pickup — see resolveRecipe in recipes.ts. For most
    // buildings this is the same as `RECIPES[def.id]`; Mine branches on
    // its footprint terrain when `terrainAt` is provided; Steel Mill swaps
    // to the §6.7 scrap-substitution variant when pig_iron is empty but
    // scrap is on hand (inventory snapshot passed through here).
    const def = defs[b.defId];
    const recipe = resolveRecipe(def, b, terrainAt, recipeInv);
    if (!recipe) continue;
    // §4.5 buff-adjacency multiplier — computed once per building from its
    // 4-neighbor footprint border. Captured here so pass 2's nominal-rate
    // sees the same factor and producer/consumer supply ratios stay correct.
    // Returns 1.0 when no same-category neighbour and no exotic rule applies.
    // Memoized per building id (the exotic rules come from the memo too —
    // previously the rule fold re-ran per building, per call).
    let buffStack = memo.buffStack.get(b.id);
    if (buffStack === undefined) {
      buffStack = computeBuffStack(b, validBuildings, defs, undefined, memo.exoticRules, clusterMuls.get(b.id) ?? 1);
      memo.buffStack.set(b.id, buffStack);
    }
    // Fix 3.7 — per-building throughput factors (maintenance × toxicity ×
    // per-type yield bonus), computed ONCE here and reused by pass-1's
    // tentSupply, pass-2's nominalRate, and pass-4's effectiveRate so the
    // supply pool, the demand, and the realized rate all agree.
    const perBuildingMul =
      maintenanceFactor(b, def, skillMul.maintenanceThreshold) *
      toxicityMultiplier(b, t) *
      buildingYieldBonus(b.defId, skillMul);
    // §9.7 Tier Reset runtime gate: a building above the island's current
    // tier band is fully inactive — same shape as the heat / output stall,
    // baseRate=0 + skipped in the pass-3 power balance.
    if (!isBuildingActive(b)) {
      tentative.push({ building: b, recipe, baseRate: 0, buffStack, effectiveMul: 1, perBuildingMul });
      continue;
    }
    // §5.2 heat gate: a `requiresHeat` building with no adjacent source
    // is fully stalled this tick — no production, no consumption, no power
    // draw. Recorded as a tentative entry with baseRate=0 so pass-3's
    // power-balance loop also skips it (matched via inputAvail = 0).
    let heatFactor = 1;
    if (def.requiresHeat) {
      const factor = heat.heatThrottleFactor.get(b.id) ?? 0;
      if (factor < MIN_HEAT_FACTOR) {
        // Brownout: full stall. Same shape as the pre-Phase-3 boolean gate.
        tentative.push({ building: b, recipe, baseRate: 0, buffStack, effectiveMul: 1, perBuildingMul });
        continue;
      }
      // Partial throttle: multiplied into baseRate and effectiveMul so
      // pass-2's nominal-rate math and pass-4's effectiveRate both pick it up.
      heatFactor = factor;
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
        tentative.push({ building: b, recipe, baseRate: 0, buffStack, effectiveMul: 1, perBuildingMul });
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
        tentative.push({ building: b, recipe, baseRate: 0, buffStack, effectiveMul: 1, perBuildingMul });
        continue;
      }
    }
    // §4.5 gating adjacency: hard gates zero output; soft gates degrade.
    const gateResult = gateFor(b);
    if (gateResult.effectiveMul === 0) {
      tentative.push({ building: b, recipe, baseRate: 0, buffStack, effectiveMul: 0, perBuildingMul });
      continue;
    }
    // Recipe-rate multipliers compose: skill-tree (per-category) × modifier
    // (per-category) × modifier (global) × NC global buff × §9.9 active-play
    // bonus. Identity bundles in any of the new factors contribute 1× so
    // existing callers see no change.
    const rateMul =
      (skillMul.recipeRate[recipe.category] ?? 1) *
      (modifierMul.recipeRateByCategory[recipe.category] ?? 1) *
      modifierMul.globalRecipeRate *
      ncBuff *
      activeBonusMul;
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
    const baseRate = (1 / recipe.cycleSec) * buffStack * rateMul * gateResult.effectiveMul * t5Mul * cryoMul * heatFactor * floorEffectMul(activeFloorLevel(b)) * fledglingRecipeMul(state.level);
    tentative.push({ building: b, recipe, baseRate, buffStack, effectiveMul: gateResult.effectiveMul * heatFactor, perBuildingMul });
    const pass1Outputs = resolveRotatingOutput(recipe, t);
    for (const [r, yld] of Object.entries(pass1Outputs)) {
      const id = r as ResourceId;
      // Fix 3.7: supply only what pass 4 will actually realize — the
      // per-building maintenance/toxicity/yield factors scale the real
      // output, so they must scale the flow-through pool too.
      tentSupply[id] = (tentSupply[id] ?? 0) + (yld ?? 0) * baseRate * perBuildingMul;
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
      ncBuff *
      activeBonusMul;
    // §4.5: soft-gate effectiveMul scales nominalRate so inputAvail's
    // demand calculation matches actual consumption under the gate.
    // Without this, a halved consumer over-claims inputs and starves
    // siblings. Fix 3.7: the per-building factors (maintenance/toxicity/
    // yield) scale the demand for the same reason — pass-4's actual
    // drawdown includes them.
    const nominalRate = (1 / te.recipe.cycleSec) * te.buffStack * rateMul * te.effectiveMul * floorEffectMul(activeFloorLevel(te.building)) * fledglingRecipeMul(state.level) * te.perBuildingMul;
    const externalSupply: Record<ResourceId, number> = {} as Record<ResourceId, number>;
    for (const r of Object.keys(tentSupply) as ResourceId[]) {
      externalSupply[r] = tentSupply[r] ?? 0;
    }
    // Self-exclude only if pass 1 actually contributed (baseRate > 0).
    // Mirrors the pass-1 fold: the contribution was baseRate × perBuildingMul.
    if (te.baseRate > 0) {
      const pass2Outputs = resolveRotatingOutput(te.recipe, t);
      for (const [r, yld] of Object.entries(pass2Outputs)) {
        const id = r as ResourceId;
        externalSupply[id] = (externalSupply[id] ?? 0) - (yld ?? 0) * te.baseRate * te.perBuildingMul;
      }
    }
    inputAvailByIdx[i] = inputAvail(state, te.recipe, externalSupply, nominalRate, recipeInputDiv, ctx?.inventory);
  }

  // §5.2 coal-furnace fuel-burn cycle length — fixed 30s per §5.2 / §8.5
  // catalog convention. Shared by the pass-2.5 synthetic coal consumers
  // below and the post-pass-4 burn fold further down; declared once here.
  const COAL_CYCLE_SEC = 30;

  // Lookup maps to replace O(V²) linear scans in passes 3–4 with O(1)
  // lookups. `tentIdxById` maps building id → index in `tentative`
  // (recipe-less buildings are absent, so the lookup returns undefined).
  const buildingById = new Map<string, PlacedBuilding>();
  for (const b of validBuildings) buildingById.set(b.id, b);
  const tentIdxById = new Map<string, number>();
  for (let i = 0; i < tentative.length; i++) tentIdxById.set(tentative[i]!.building.id, i);

  // Pass 2.5 — exact net-flow solve (§15.3 net-flow rework, see
  // docs/superpowers/specs/2026-06-10-net-flow-economy-design.md).
  // Replaces the binary outputAvail stall: producers at a pinned bin rescale
  // to exactly the consumers' draw (shared θ per resource, min rule per
  // building); consumers at an empty bin rescale to supply (shared φ —
  // supersedes per-consumer inputAvail for RUNNING buildings; inputAvailByIdx
  // above remains solely the pass-3 power probe for baseRate-0 buildings).
  // Coefficients mirror pass-4's realized flows at gate 1: baseRate ×
  // perBuildingMul, inputs ÷ recipeInputDiv. Island-uniform factors (accel,
  // variance) cancel in the ratios; powerFactor stays post-applied (pass 4)
  // with the documented one-segment lag.
  // §5.1 × §15.3 joint fixpoint (see flow-power-fixpoint.ts): a building that
  // draws grid power has its WHOLE realized recipe (both produces and
  // consumes) scaled by the brownout factor pf — the gate g is then solved
  // against those pf-scaled flows so a pinned bin nets to 0 under the realized
  // throughput, even when its producers and consumers differ in power-
  // dependence. `consumesPowerByIdx` is pf-independent (a static def property),
  // so we capture it once and re-scale the coefficients per probed pf.
  const consumesPowerByIdx: boolean[] = tentative.map(
    (te) => (defs[te.building.defId].power?.consumes ?? 0) > 0,
  );
  // Build THIS island's own pf-scaled flow coefficients. pf === 1 reproduces
  // the pre-fixpoint nominal coefficients byte-identically (scale = 1 for
  // every building), so the no-brownout common path is unchanged.
  const buildFlowBuildings = (pf: number): FlowBuildingSpec[] =>
    tentative.map((te, i) => {
      if (te.baseRate <= 0) return { produces: {}, consumes: {} };
      const scale = consumesPowerByIdx[i] ? pf : 1;
      const produces: Record<string, number> = {};
      const outs = resolveRotatingOutput(te.recipe, t);
      for (const [r, yld] of Object.entries(outs)) {
        const flow = (yld ?? 0) * te.baseRate * te.perBuildingMul * scale;
        if (flow > 0) produces[r] = flow;
      }
      const consumes: Record<string, number> = {};
      for (const [r, need] of Object.entries(te.recipe.inputs)) {
        if (te.recipe.exogenousFlow === 'atmosphere' && r === 'air') continue;
        const flow = ((need ?? 0) / recipeInputDiv) * te.baseRate * te.perBuildingMul * scale;
        if (flow > 0) consumes[r] = flow;
      }
      // §4.6 per-output Ignore Cap: build the per-resource exempt set from THIS
      // building's effective override (per-building flag ?? global default) over
      // its current outputs.
      const capExemptOutputs = new Set<ResourceId>();
      for (const r of Object.keys(outs)) {
        const id = r as ResourceId;
        if (isOutputCapExempt(te.building, id)) capExemptOutputs.add(id);
      }
      return { produces, consumes, capExemptOutputs };
    });
  // §13.3 D-01: snapshot THIS island's own (nominal, pf=1) flow specs — the
  // orchestrator unions these (one island's `flowSpecs` becomes another's
  // `flowSiblings`). Siblings arrive PRE-SCALED from their own island's solve,
  // so the union flows are consistent; this island reports its pf=1 specs.
  const ownFlowSpecs: FlowBuildingSpec[] = buildFlowBuildings(1).map((fb) => ({
    produces: { ...fb.produces },
    consumes: { ...fb.consumes },
    ...(fb.capExemptOutputs && fb.capExemptOutputs.size
      ? { capExemptOutputs: new Set(fb.capExemptOutputs) }
      : {}),
  }));
  // §5.2 synthetic coal-burn sinks: pf-INDEPENDENT (a fixed fuel sink, not a
  // power-scaled recipe). SKIPPED when coal is zero-constrained — the binary
  // fuel-starvation recompute (Fix 4.1 below) owns that regime. Computed once.
  const coalBurnSinks: FlowBuildingSpec[] = [];
  // §13.3 D-01 union: the OTHER lattice members' (pre-scaled) flow specs.
  const siblingSpecs: FlowBuildingSpec[] = ctx?.flowSiblings ? [...ctx.flowSiblings] : [];
  // Append the pf-independent synthetics (siblings + coal sinks) after the
  // pf-scaled own entries. These sit at indices ≥ tentative.length; passes 3–4
  // index flowGates only by tentative index, so they are never read back —
  // they exist purely to shape the shared θ/φ factors.
  const withSynthetics = (arr: FlowBuildingSpec[]): FlowBuildingSpec[] => {
    const out = arr.slice();
    for (const sib of siblingSpecs) out.push(sib);
    for (const sink of coalBurnSinks) out.push(sink);
    return out;
  };
  // Cap/zero regime is determined by inventory stock — pf-INDEPENDENT — and
  // scanned once over the FULL union at pf=1 so every lattice member computes
  // an IDENTICAL constraint set (and thus identical gates). pf scaling never
  // changes which resources a building touches (scale > 0 preserves the keys).
  const capConstrained = new Set<string>();
  const zeroConstrained = new Set<string>();
  // NOTE: coalBurnSinks is intentionally still empty at this point — coal participates in the constraint set via recipe entries, not the synthetic sink (sinks are populated below). Do not reorder.
  {
    const regimeScan = withSynthetics(buildFlowBuildings(1));
    for (const fb of regimeScan) {
      for (const r of [...Object.keys(fb.produces), ...Object.keys(fb.consumes)]) {
        const id = r as ResourceId;
        // §2.6: a non-stored output (vented co2) has no inventory bin — it must
        // never cap-constrain (and thus throttle) its producer.
        if (NON_STORED_OUTPUTS.has(id)) continue;
        const stock = ctx?.inventory?.[id] ?? state.inventory[id] ?? 0;
        // Issue #112: classify with STOCK_BOUNDARY_EPS so float DUST at a
        // boundary is treated as pinned and solveFlow gates the dust-bin
        // consumer/producer (net settles toward 0). See the constant's docs.
        if (stock <= STOCK_BOUNDARY_EPS) zeroConstrained.add(r);
        // §4.6 per-output Ignore Cap (task 2): a resource enters capConstrained
        // purely on `stock >= cap` — the per-building exemption is now applied
        // INSIDE the solver (`FlowBuildingSpec.capExemptOutputs`, set from
        // `isOutputCapExempt`), not by suppressing the constraint globally. If
        // EVERY producer of `r` is exempt, the solver's θ entry set for `r` is
        // empty ⇒ θ=1 (no throttle) and no building is gated by `cap:r`; if some
        // producer is NOT exempt, it alone is throttled to the live draw. This
        // is strictly more correct than the old global skip, which exempted
        // even non-exempt producers of a default-exempt resource.
        if (stock >= cap(state, id, ctx?.caps, undefined, ctx?.baseMult) - STOCK_BOUNDARY_EPS) capConstrained.add(r);
      }
    }
  }
  // §5.2 furnace coal burn — cap-side demand (owner decision 2026-06-10, see
  // design doc § flow-solver contract): each billing furnace appends a
  // synthetic consumer entry so a coal producer at a pinned coal bin
  // throttles to recipe-draw + burn. SKIPPED when coal is zero-constrained —
  // the binary fuel-starvation recompute (Fix 4.1 below) owns that regime,
  // and a synthetic entry would let the solver share fuel proportionally,
  // contradicting §5.2's all-or-none heat gate. (capConstrained/zeroConstrained
  // were scanned above: if no recipe touches coal, θ_coal has no producers to
  // throttle and the synthetic entries are inert, which is correct.)
  if (!zeroConstrained.has('coal')) {
    for (const [furnaceId, servedCount] of heat.coalConsumersByFurnace) {
      if (servedCount <= 0) continue;
      const furnace = buildingById.get(furnaceId);
      if (!furnace) continue;
      const coalPerCycle = defs[furnace.defId].heatSource?.coalPerCycle ?? 0;
      if (coalPerCycle <= 0) continue;
      coalBurnSinks.push({
        produces: {},
        consumes: { coal: (coalPerCycle * servedCount) / COAL_CYCLE_SEC },
      });
    }
  }
  // Solve the net-flow gates against the pf-scaled coefficients. The
  // constraint set is pf-independent (scanned once above). At pf=1 this is the
  // pre-fixpoint nominal solve.
  const solveGatesAt = (pf: number): readonly number[] =>
    solveFlow(withSynthetics(buildFlowBuildings(pf)), { capConstrained, zeroConstrained }).gates;

  // Pass 3: power balance. A building is `active` for §5.1 iff:
  //   - it has no recipe (Solar / Dock / Crate / Silo — passively active), OR
  //   - its flow-solver gate g > 0 (running buildings) / its probe
  //     inputAvail > 0 (baseRate-0 buildings), AND its heat gate (if any)
  //     passes.
  //
  // Per the §5.1 throughput-scaled-power rebalance: a consumer's draw scales
  // by its NOMINAL throughput fraction:
  //
  //   nominalThroughputFrac = gateResult.effectiveMul   // §4.5 soft-gate (0..1)
  //                         × g                          // pass-2.5 net-flow gate (0..1)
  //   (or, for baseRate-0 buildings stalled for non-storage reasons,
  //    gateResult.effectiveMul × inputAvail × outputAvail — the probe shape)
  //
  //   powerConsumed += (def.power.consumes / skillMul.powerConsumption)
  //                  × nominalThroughputFrac
  //
  // All factors are NOMINAL (pre-powerFactor) — already in scope from
  // earlier passes or cheap to recompute via `outputAvail()`. Composing
  // here preserves the existing circular-dep break: the chain is
  // `powerConsumed_nominal → powerFactor → effectiveRate`, never the reverse.
  // Storage-throttled and soft-gate-degraded buildings no longer waste
  // full wattage producing nothing / less. §4.7 net-flow NOW scales wear
  // by `BuildingRate.utilization` — duty-cycled operating time, not wall
  // clock (see docs/superpowers/specs/2026-06-10-net-flow-economy-design.md
  // § "Wear, XP, events"). Heat-failed consumers remain fully inactive (no
  // power, no production, no consumption) per §5.1 "active iff all gates
  // pass".
  // Pass-3 power aggregation for a given gate vector; closes over fixed pass-2 state. Called repeatedly by the fixpoint (Task 3) with candidate gates.
  const aggregatePower = (gatesByTentIdx: readonly number[]): PowerSample => {
    let producedW = 0;
    let consumedW = 0;
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
      let heatFactorPass3 = 1;
      if (def.requiresHeat) {
        const factor = heat.heatThrottleFactor.get(b.id) ?? 0;
        if (factor < MIN_HEAT_FACTOR) continue; // brownout — no power draw
        heatFactorPass3 = factor;
      }
      // §4.5 gating adjacency: a building with a failed hard gate draws no power.
      const gateResult = gateFor(b);
      if (gateResult.effectiveMul === 0) continue;
      // Same tile-aware resolution as the pass-1 loop. `active` only checks
      // recipe presence here, so the variant chosen doesn't matter — but we
      // pipe it through `resolveRecipe` for symmetry with pass 1 (no caller
      // confusion about which lookup is "the" lookup).
      const recipe = resolveRecipe(def, b, terrainAt, recipeInv);
      // §5.1 throughput-scaled draw: compose the NOMINAL gates that determine
      // how much work the building actually does this tick. Running buildings
      // (baseRate > 0) use the pass-2.5 flow-solver gate g, which subsumes the
      // old inputAvail × outputAvail pair (§15.3 net-flow rework). Buildings
      // stalled for non-storage reasons (tile gate, tier gate, …) keep the
      // probe draw shape: inputAvail × outputAvail.
      let active: boolean;
      let nominalThroughputFrac: number;
      if (!recipe) {
        active = true;
        nominalThroughputFrac = 1; // Solar / Dock / Crate / Silo — full passive draw if any.
      } else {
        const idx = tentIdxById.get(b.id) ?? -1;
        const te = idx >= 0 ? tentative[idx] : undefined;
        if (te && te.baseRate > 0) {
          const g = gatesByTentIdx[idx] ?? 0;
          active = g > 0;
          nominalThroughputFrac = gateResult.effectiveMul * g;
          // §15.3 net-flow × §5.1: the solver gate throttles a generator's
          // RESOURCE side only, never its W output — power is explicitly
          // outside the solver (design doc §5.1 row: extremes identical).
          // A power PRODUCER whose recipe output sits at a pinned bin
          // (g = 0 — e.g. casimir_tap, cryogenic_generator) stays power-
          // active under the old probe semantics (inputAvail) so its
          // wattage keeps flowing; its consumer-draw scaling stays on g
          // (frac is already 0 here, matching the old ia × oa probe at cap).
          if (!active && (def.power?.produces ?? 0) > 0) {
            active = (inputAvailByIdx[idx] ?? 0) > 0;
          }
        } else {
          // Probe path — buildings stalled for non-storage reasons (tile gate,
          // tier gate, …) keep today's draw shape: inputAvail × outputAvail.
          const ia = idx >= 0 ? (inputAvailByIdx[idx] ?? 0) : 0;
          active = ia > 0;
          const oa = outputAvail(b, state, recipe, t, ctx?.caps, ctx?.baseMult);
          nominalThroughputFrac = gateResult.effectiveMul * ia * oa;
        }
      }
      nominalThroughputFrac *= heatFactorPass3;
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
      // §4.5: generator output scales by the building's cluster-bonus
      // multiplier (clustered generators boost each other). Consumption below
      // is deliberately NOT scaled.
      const clusterMul = clusterMuls.get(b.id) ?? 1;
      producedW += producesBase * floorEffectMul(activeFloorLevel(b)) * solarFactor * windFactor * skillMul.powerProduction * clusterMul;
      // §5.1 rebalance: per-building draw scales by nominal throughput fraction.
      // powerConsumption is a "reduction" multiplier (>=1 means lower draw),
      // so we divide. Default 1.0 leaves draw untouched.
      consumedW += ((def.power?.consumes ?? 0) * floorPowerDrawMul(activeFloorLevel(b)) * nominalThroughputFrac) / skillMul.powerConsumption;
    }
    // §13.3 Genesis Chamber tier-based power draw (converted kW → W).
    for (const b of validBuildings) {
      if (b.defId !== 'genesis_chamber') continue;
      if (!isBuildingActive(b)) continue;
      const gcGateResult = gateFor(b);
      if (gcGateResult.effectiveMul === 0) continue;
      if (!state.genesisTarget) continue;
      const targetTier = tierForResource(state.genesisTarget);
      if (targetTier < 1 || targetTier > 4) continue;
      // Output-stalled chambers don't draw power (no production = no load).
      if (inv(state, state.genesisTarget) >= cap(state, state.genesisTarget, undefined, undefined, ctx?.baseMult)) continue;
      consumedW += (GENESIS_POWER_KW[targetTier]! * 1000 * floorPowerDrawMul(activeFloorLevel(b))) / skillMul.powerConsumption;
    }
    return { producedW, consumedW };
  };

  // §5.1 × §15.3 joint fixpoint composition. The brownout factor pf and the
  // net-flow gate g are mutually dependent (g is solved against pf-scaled
  // coefficients; pf = produced/consumed at those gates). We resolve pf from
  // one of three sources, in precedence order:
  //
  //   1. `fixedPowerFactor` (cable pre-pass probe): pf is dictated by the
  //      caller — solve gates once at that pf, report it verbatim.
  //   2. unified cable component (§5.3): pf is the component-wide scalar — the
  //      component balances at the network level, so NO local fixpoint and NO
  //      local battery deficit-cover (fix 3.5).
  //   3. local pool: run the scalar pf⇄g fixpoint. A local battery that fully
  //      covers the pf=1 deficit yields pf=1 (no brownout), short-circuiting
  //      the fixpoint to a single solve (perf parity for the common case).
  //
  // Gate solves are memoised by pf so each distinct pf costs exactly one
  // solveFlow; a non-brownout pool stays at a single solve.
  // Cache keys are pf values reused VERBATIM (pf=1, fixedPf, or the fixpoint's converged value passed back unchanged) — never a recomputed near-equal, so number-key equality is safe here.
  const gateCache = new Map<number, readonly number[]>();
  const sampleCache = new Map<number, PowerSample>();
  const gatesAt = (pf: number): readonly number[] => {
    let g = gateCache.get(pf);
    if (g === undefined) { g = solveGatesAt(pf); gateCache.set(pf, g); }
    return g;
  };
  const sampleAt = (pf: number): PowerSample => {
    let s = sampleCache.get(pf);
    if (s === undefined) { s = aggregatePower(gatesAt(pf)); sampleCache.set(pf, s); }
    return s;
  };

  const cableComponent = ctx?.cableComponent;
  const fixedPf: number | undefined =
    ctx?.fixedPowerFactor ??
    (cableComponent?.unified
      ? (cableComponent.consumedTotal === 0
          ? 1
          : Math.min(1, cableComponent.producedTotal / cableComponent.consumedTotal))
      : undefined);

  const batteryCap = batteryCapacityWs(state, skillMul);
  // The pf=1 (nominal) sample doubles as the raw pre-battery balance reported
  // in `power`. Always computed (it is the fast-path eval the fixpoint reuses,
  // and the battery decision reads it) — at most one solve.
  const nominalSample = sampleAt(1);
  const rawProduced = nominalSample.producedW;
  const rawConsumed = nominalSample.consumedW;

  let powerFactor: number;
  let flowGates: readonly number[];
  let powerProduced: number;
  let powerConsumed: number;

  if (fixedPf !== undefined) {
    // Sources 1 & 2: pf is owned by the caller / component. Single solve.
    powerFactor = fixedPf;
    flowGates = gatesAt(fixedPf);
    const s = sampleAt(fixedPf);
    powerProduced = s.producedW;
    powerConsumed = s.consumedW;
  } else if (
    // Source 3a: §13.3 local battery buffer covers the pf=1 deficit ⇒ pf=1.
    // Local only (batteries don't feed the §5.3 cable pool); the unified-cable
    // branch above already excludes this via `fixedPf !== undefined`.
    batteryCap > 0 &&
    rawProduced < rawConsumed &&
    state.batteryStoredWs >= BATTERY_EMPTY_THRESHOLD_WS
  ) {
    powerFactor = 1;
    flowGates = gatesAt(1);
    powerProduced = rawConsumed; // cover full deficit (matches legacy report)
    powerConsumed = rawConsumed;
  } else {
    // Source 3b: local pool — converge the scalar pf⇄g fixpoint. The fast path
    // re-evaluates at pf=1 (cache hit ⇒ no extra solve) and returns pf=1 for
    // any surplus pool, byte-identical to the pre-fixpoint common path.
    powerFactor = solveBrownoutFactor((pf) => sampleAt(pf)).powerFactor;
    flowGates = gatesAt(powerFactor);
    const s = sampleAt(powerFactor);
    powerProduced = s.producedW;
    powerConsumed = s.consumedW;
  }

  // Pass 4: final effective rate. Apply powerFactor only to consumers
  // (buildings declaring `power.consumes > 0`); producers and neutral
  // buildings ignore it. Storage throttling arrives via the pass-2.5
  // flow-solver gate g (g=0 ⇒ rate 0, e.g. at cap with no consumer).
  const byBuilding: BuildingRate[] = [];
  const production: Record<ResourceId, number> = {} as Record<ResourceId, number>;
  const consumption: Record<ResourceId, number> = {} as Record<ResourceId, number>;
  const net: Record<ResourceId, number> = {} as Record<ResourceId, number>;
  for (let i = 0; i < tentative.length; i++) {
    const te = tentative[i]!;
    if (te.baseRate === 0) {
      byBuilding.push({ building: te.building, recipe: te.recipe, effectiveRate: 0, utilization: 0 });
      continue;
    }
    const g = flowGates[i] ?? 0;
    const consumesPower = (defs[te.building.defId].power?.consumes ?? 0) > 0;
    const pf = consumesPower ? powerFactor : 1;
    // Fix 3.7: `te.perBuildingMul` carries the §4.7 maintenance factor ×
    // toxicity × per-building-type yield bonus, captured ONCE in pass 1 so
    // the supply pool (pass 1), the demand (pass 2), and the realized rate
    // here all use identical values. Power producers' W output stays full —
    // `power.produces` is summed in Pass 3 — a deliberate gap: the spec
    // phrases degradation as "output efficiency", ambiguous for power
    // buildings, and applying maintenance to power would cascade into the
    // brownout factor and double-dip on consumers. Resource recipes only.
    const accelMul = ctx?.accelerationMul ?? 1;
    const effectiveRate = te.baseRate * g * pf * accelMul * varianceFactor * te.perBuildingMul;
    // §4.7 net-flow: duty-cycle fraction — adjacency soft-gate × heat
    // throttle (te.effectiveMul) × flow-solver gate × powerFactor for
    // consumers. Excludes maintenance/accel/variance/static-yield per the
    // BuildingRate doc.
    const utilization = Math.min(1, Math.max(0, te.effectiveMul * g * pf));
    byBuilding.push({ building: te.building, recipe: te.recipe, effectiveRate, utilization });

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
      // Divides actual drawdown. In the constrained-supply regime this cancels
      // the matching site-1 inflation of inputAvail (net consumption flat,
      // throughput up); when inputs are stocked, site-1 is skipped and only
      // this divisor acts. See the recipeInputDiv resolution block above.
      const delta = ((need ?? 0) * effectiveRate) / recipeInputDiv;
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
  // §9.1 XP accrues only from REALIZED production: a trickle whose output
  // resource is already at cap produces nothing (applyRates would clamp it
  // away) and therefore must not contribute to `production` or earn XP.
  const trickleHeadroom = (r: ResourceId): number =>
    cap(state, r, ctx?.caps, undefined, skillMul) - (ctx?.inventory?.[r] ?? state.inventory[r] ?? 0);
  if (skillMul.mineRareTrickleRate > 0) {
    let mines = 0;
    for (const b of validBuildings) {
      if (b.defId === 'iron_mine' || b.defId === 'coal_mine' || b.defId === 'deep_mine') mines++;
    }
    const rare = mines * skillMul.mineRareTrickleRate * modifierMul.rareFindMul;
    if (rare > 0 && trickleHeadroom('helium_3') > 0) {
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
    if (exotic > 0 && trickleHeadroom('lumber') > 0) {
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
  // Fixed 30s cycle (COAL_CYCLE_SEC, declared above pass 2.5); tied to the
  // def's declared `coalPerCycle` for forward-compat with a future
  // per-furnace efficiency variation.
  for (const [furnaceId, servedCount] of heat.coalConsumersByFurnace) {
    if (servedCount <= 0) continue;
    const furnace = buildingById.get(furnaceId);
    if (!furnace) continue;
    const def = defs[furnace.defId];
    const coalPerCycle = def.heatSource?.coalPerCycle ?? 0;
    if (coalPerCycle <= 0) continue;
    const burnPerSec = (coalPerCycle * servedCount) / COAL_CYCLE_SEC;
    consumption.coal = (consumption.coal ?? 0) + burnPerSec;
    net.coal = (net.coal ?? 0) - burnPerSec;
  }

  // Fix 4.1 — §5.1 "active iff … direct fuel-consumption stockpile (if
  // applicable)" / §5.2 Coal Furnace consumes coal: a coal-fired Heat Source
  // can only serve consumers while the island can actually pay the burn.
  // Gate: when the island's coal stock is empty AND the live net coal flow
  // is negative (production this tick cannot cover the burn folded above),
  // every billing coal furnace is fuel-starved — recompute this tick with
  // those furnaces serving nothing. Without this, applyRates clamps the
  // burn away at 0 stock and consumers keep producing on free heat forever.
  //
  // Design choice: BINARY full stall (not a partial fuel-coverage throttle),
  // matching the §5.2 boolean adjacency gate and the per-source all-or-none
  // semantics of the proportional-throttle pass; a partial split would need
  // an iterative billing fixpoint (less fuel → fewer served → less fuel …).
  // Integrator contract: while coal lasts, rates run full and
  // findNextCapEvent lands the depletion boundary exactly; the recomputed
  // rates at the boundary take this path and show the stall. Recursion depth
  // ≤ 1 — the recursed pass bills no coal, so its net.coal cannot re-trigger
  // the gate (and `coalStarvedFurnaces !== undefined` hard-stops re-entry).
  if (coalStarvedFurnaces === undefined) {
    // Per-key fallback (NOT whole-object `(ctx?.inventory ?? state.inventory)`):
    // a lattice/shared-network ctx.inventory is a PARTIAL pooled override, so a
    // missing coal key must fall back to the island's own coal — else the gate
    // reads coal=0 and spuriously starves the furnace despite real coal on hand.
    const coalStock = ctx?.inventory?.coal ?? state.inventory.coal ?? 0;
    // -1e-12 guard: float residue when live coal production exactly
    // balances the burn must not spuriously starve the furnaces.
    if (coalStock <= 0 && (net.coal ?? 0) < -1e-12) {
      const starved = new Set<string>();
      for (const [furnaceId, servedCount] of heat.coalConsumersByFurnace) {
        if (servedCount <= 0) continue;
        const furnace = buildingById.get(furnaceId);
        if (!furnace) continue;
        if ((defs[furnace.defId].heatSource?.coalPerCycle ?? 0) > 0) {
          starved.add(furnaceId);
        }
      }
      if (starved.size > 0) {
        return computeRates(state, ctx, nowMs, solarClockMs, starved);
      }
    }
  }

  return {
    byBuilding,
    production,
    consumption,
    net,
    power: { produced: powerProduced, consumed: powerConsumed, factor: powerFactor, rawProduced, rawConsumed },
    heat,
    flowSpecs: ownFlowSpecs,
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
 *
 * `utilById` maps building id → segment-constant duty cycle (§4.7 net-flow);
 * absent ⇒ 1 (assume full wear so maintenance boundaries aren't skipped —
 * keeps the bare-arity signature working for direct test callers).
 */
export function findNextCapEvent(
  state: IslandState,
  net: Record<ResourceId, number>,
  tMs: number,
  nowMs: number,
  ctx?: RatesContext,
  utilById?: ReadonlyMap<string, number>,
  /** §13.3 D-01 lattice lockstep: when provided, the resource-boundary scan
   *  reads stock from this POOLED inventory (Σ member inventories) instead of
   *  the local `state.inventory`. `net` is then expected to be the POOLED net
   *  flow and `ctx.caps` the POOLED caps, so a resource hits its boundary
   *  when the whole pool fills/drains — not when one member's slice does. The
   *  maintenance / construction boundaries below stay per-island (this is
   *  called once per member by the orchestrator, which takes the min). */
  pooledInv?: Record<ResourceId, number>,
): number {
  let best = nowMs;
  for (const r of Object.keys(net) as ResourceId[]) {
    const rate = net[r] ?? 0;
    if (rate === 0) continue;
    const current = pooledInv ? (pooledInv[r] ?? 0) : inv(state, r);
    let timeToEventSec: number;
    if (rate > 0) {
      // Heading toward cap. At/over cap already (headroom <= 0): no FUTURE
      // boundary exists — skip. This covers (a) producers outputAvail will
      // stall next pass, and (b) unconditional flows (rare-find trickles,
      // furnace coal burn) pinned at the boundary by applyRates' clamp,
      // which would otherwise emit a `tMs + 1` event every segment forever.
      const capVal = cap(state, r, ctx?.caps, undefined, ctx?.baseMult);
      const headroom = capVal - current;
      if (headroom <= 0) continue;
      timeToEventSec = headroom / rate;
    } else {
      // rate < 0, heading toward zero. Already at zero: skip — that input
      // sets inputAvail=0 (or, for unconditional flows, applyRates pins 0).
      if (current <= 0) continue;
      timeToEventSec = current / -rate;
    }
    // Fix 3.6: a stock within 1 unit of its boundary used to be skipped
    // outright (anti-freeze workaround), which let a (cap-1, cap) stock
    // produce at full rate — and full XP — for an entire offline segment,
    // and a (0,1) stock feed its consumer all segment (conjured inputs).
    // Instead, land the boundary but clamp it to ≥ 1ms ahead so it can't
    // round back to `tMs` at realistic perf.now() magnitudes (the original
    // freeze: segEndMs == t ⇒ dtSec == 0 ⇒ force-jump skips the call).
    // applyRates' exact clamps (`Math.min(cap…)`, `Math.max(0…)`) pin the
    // inventory to exactly cap/0 at the landed boundary, so the NEXT
    // computeRates sees exact-full/exact-empty and stalls the producer/
    // consumer — no recurring-event loop (see the `<= 0` skips above).
    const eventMs = Math.max(tMs + timeToEventSec * 1000, tMs + 1);
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
    if (activeFloors(b) <= 0) continue;
    const def = defs[b.defId];
    // §4.7 / #92: non-productive buildings never accrue wear (the segment
    // loop skips them), so they must not emit maintenance segment boundaries
    // either. Skipping them removes spurious segment splits with no gameplay
    // effect.
    const recipe = resolveRecipe(def, b, ctx?.terrainAt);
    if (!recipe || Object.keys(recipe.outputs).length === 0) continue;
    const boundary = nextMaintenanceBoundaryMs(b, def, thresholdMul);
    if (boundary === null) continue;
    const operating = b.operatingMs ?? 0;
    // Missing entry defaults to 1 here (vs `?? 0` in the wear loop): a
    // boundary walker that can't see a duty cycle stays conservative and
    // still emits the boundary, while the wear accrual treats no-evidence
    // as no duty (don't wear without proof).
    const u = utilById?.get(b.id) ?? 1;
    if (u <= 0) continue; // not wearing — no future boundary this segment
    const eventMs = tMs + (boundary - operating) / u;
    if (eventMs > tMs && eventMs < best) best = eventMs;
  }
  // §9.3 Robotics: under-construction completion events. The integrator
  // must split a segment at the moment a building flips operational so the
  // post-completion segment integrates with the newly-active production.
  const constructionEvent = nextConstructionCompletionMs(state.buildings, tMs);
  if (constructionEvent !== null && constructionEvent > tMs && constructionEvent < best) {
    best = constructionEvent;
  }
  // §4.5 Chemical Reactor toxicity onset/expiry. A reactor's throughput factor
  // changes at the start and end of a toxicity episode, so each transition must
  // be a segment boundary. The roll itself is advanced before the loop; here we
  // only read the resulting `toxicityExpiryMs` and split at the nearest future
  // transition (onset if still before it, expiry if already inside the period).
  for (const b of state.buildings) {
    if (b.toxicityExpiryMs === undefined) continue;
    const def = defs[b.defId];
    if (def.id !== 'chemical_reactor') continue;
    const expiryMs = b.toxicityExpiryMs;
    if (expiryMs <= tMs) continue;
    const onsetMs = expiryMs - TOXICITY_DURATION_MS;
    const candidate = onsetMs > tMs ? onsetMs : expiryMs;
    if (candidate < best) best = candidate;
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
export function applyRates(
  state: IslandState,
  net: Record<ResourceId, number>,
  dtSec: number,
  caps?: Record<ResourceId, number>,
  baseMult?: SkillMultipliers,
): void {
  for (const r of Object.keys(net) as ResourceId[]) {
    // §2.6: non-stored outputs (co2 only — P4 Phase 1 moved the 6 byproducts to
    // OUTPUT_CAP_EXEMPT) are never written to inventory, so they never
    // accumulate, fill a bin, or stall the producer.
    // co2's climate contribution is accrued to state.co2Kg separately.
    if (NON_STORED_OUTPUTS.has(r)) continue;
    const rate = net[r] ?? 0;
    if (rate === 0) continue;
    const next = inv(state, r) + rate * dtSec;
    const clamped = Math.min(cap(state, r, caps, undefined, baseMult), Math.max(0, next));
    state.inventory[r] = clamped;
    if (rate > 0) state.everProduced.add(r);
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
  // Coefficient 25 (idle-game scale): L1→L5 ≈ 1760 XP (~25 min at 1.2 XP/sec).
  // Both segments use 25 to keep the polynomial/exponential boundary
  // continuous at n=50.
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
    targetState.accelerationQueue.push({ durationMin: minutes });
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
/**
 * Per-segment side effects applied AFTER a segment's inventory deltas land
 * (core-flip detection, tutorial flags, §10 CO₂ accrual + sink drain, XP,
 * §13.3 battery charge/discharge, level-up, terrain-shot fire, §4.7 wear +
 * construction tick + storage-cap credit, FIFO queue promotion). Extracted
 * from `advanceIsland`'s segment loop so the §13.3 grouped lattice advance
 * (`lattice-advance.ts`) shares the SAME per-island side-effect application
 * after its pooled inventory integration + distribution. Computes `dtMs`
 * from `segEndMs - t`. Does NOT touch inventory (the caller integrates the
 * net flow — locally via `applyRates`, or pooled-then-distributed for a
 * lattice group) — this keeps the two integration regimes the single point
 * of divergence and everything downstream identical.
 */
export function applySegmentSideEffects(
  state: IslandState,
  byBuilding: ReadonlyArray<BuildingRate>,
  production: Record<ResourceId, number>,
  consumption: Record<ResourceId, number>,
  dtSec: number,
  segEndMs: number,
  t: number,
  ctx: RatesContext | undefined,
  skillMul: SkillMultipliers,
  batteryIsLocal: boolean,
  rawBalance: number,
  maxCap: number,
  utilById: ReadonlyMap<string, number>,
): void {
  // §8.x alt-input variant selection (same merged view as computeRates).
  const recipeInv = recipeInventoryFor(state, ctx);
  // §13 auto-flip: first local production of ai_core / ascendant_core.
  // Inside the dtSec > 0 branch deliberately — a zero-length forced
  // segment integrates nothing, and a positive rate over zero seconds
  // must not grant T5/T6 access (fix 3.2).
  if (!state.aiCoreCrafted && (production.ai_core ?? 0) > 0) {
    state.aiCoreCrafted = true;
  }
  if (!state.ascendantCoreCrafted && (production.ascendant_core ?? 0) > 0) {
    state.ascendantCoreCrafted = true;
  }
  // §10 CO₂ accrual — Phase 2 hook
  // Path 1: co2 produced as a regular recipe output. Biogenic CO₂ is
  // recently-absorbed carbon (e.g. charcoal_kiln), so it is carbon-neutral
  // and does not count toward the climate CO₂ total.
  for (const br of byBuilding) {
    const co2Out = br.recipe.outputs.co2 ?? 0;
    if (co2Out > 0 && !br.recipe.biogenic) {
      const emit = co2Out * br.effectiveRate * dtSec;
      if (ctx?.co2Pool) ctx.co2Pool.kg += emit;
      else state.co2Kg += emit;
    }
  }
  // Path 2: exogenous fuel-combustion CO₂ (not in outputs ledger). Biogenic
  // fuel flows are likewise treated as net-zero.
  for (const br of byBuilding) {
    if (
      br.recipe.exogenousFlow === 'fuel-combustion-CO₂' &&
      br.recipe.exogenousFlowKg &&
      !br.recipe.biogenic
    ) {
      const emit = br.recipe.exogenousFlowKg * br.effectiveRate * dtSec;
      if (ctx?.co2Pool) ctx.co2Pool.kg += emit;
      else state.co2Kg += emit;
    }
  }
  // §si-units rev-16 §7.4: CO₂ sink drain — accrual fires before, drain after.
  const rateById = new Map<string, number>();
  for (const br of byBuilding) {
    rateById.set(br.building.id, br.effectiveRate);
  }
  for (const b of state.buildings) {
    const def = BUILDING_DEFS[b.defId];
    const capture = def.co2CaptureKgPerCycle ?? 0;
    if (capture <= 0) continue;

    // Adjacency gate — exhaust_scrubber requires adjacency to a CO₂ emitter.
    if (def.co2CaptureAdjacency) {
      const has = hasNeighborWithAnyDefId(b, state.buildings, def.co2CaptureAdjacency);
      if (!has) continue;
    }

    const recipe = resolveRecipe(def, b, ctx?.terrainAt, recipeInv);
    const cyclesThisSegment = recipe
      ? (rateById.get(b.id) ?? 0) * dtSec
      : dtSec / 60;
    const drainKg = capture * cyclesThisSegment;
    if (ctx?.co2Pool) ctx.co2Pool.kg = Math.max(0, ctx.co2Pool.kg - drainKg);
    else state.co2Kg = Math.max(0, state.co2Kg - drainKg);
  }
  accrueXp(state, production, consumption, dtSec, 1, skillMul.xpGain);
  // §13.3 Battery buffer — apply charge/discharge over the segment.
  // Skipped entirely under a unified cable component (fix 3.5, see
  // `batteryIsLocal` above).
  if (!batteryIsLocal) {
    // unified — battery inert this segment
  } else if (rawBalance > 0 && maxCap > 0) {
    const chargeWs = rawBalance * dtSec;
    const charge = Math.min(chargeWs, maxCap - state.batteryStoredWs);
    state.batteryStoredWs += charge;
  } else if (rawBalance < 0 && state.batteryStoredWs > 0) {
    if (state.batteryStoredWs < BATTERY_EMPTY_THRESHOLD_WS) {
      // Sub-1-Ws float residue: treated as empty everywhere else this
      // call (no cover, no depletion boundary) — flush it so it can't
      // re-trigger the freeze path on a later call (fix 3.4).
      state.batteryStoredWs = 0;
    } else {
      const deficitWs = -rawBalance * dtSec;
      const discharge = Math.min(deficitWs, state.batteryStoredWs);
      state.batteryStoredWs -= discharge;
      if (state.batteryStoredWs < BATTERY_EMPTY_THRESHOLD_WS) state.batteryStoredWs = 0;
    }
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
  // §4.7 net-flow: wear accrues in utilization-scaled operating time —
  // duty cycle, not wall clock. A building idling against a full bin
  // (u=0) no longer wears; this deliberately inverts the old "can't
  // escape maintenance pressure by capping output" stance (owner
  // decision, see docs/superpowers/specs/2026-06-10-net-flow-economy-design.md).
  // Done AFTER applyRates so the maintenance factor used inside
  // computeRates was computed at the start-of-segment operatingMs,
  // matching §15.3's piecewise-constant-rate invariant.
  for (const b of state.buildings) {
    // §9.3 construction: tick down remaining time; operating-time
    // only accrues once the build is complete (the spec's "Idle
    // buildings ... accrue maintenance time" intent covers placed
    // buildings, not still-under-construction shells).
    const wasUnderConstruction = (b.constructionRemainingMs ?? 0) > 0;
    if (wasUnderConstruction) {
      const justCompleted = tickConstruction(b, dtMs);
      // §storage-timing: storage caps are granted at construction
      // COMPLETION, not at placement/upgrade commit. The tick the build
      // crosses to operational, credit its cap, discriminating by the
      // building's floorLevel at that moment:
      //   - floorLevel 0 → a FRESH placement → credit the base
      //     floorScaledCapacity (== base multiplier at L0).
      //   - floorLevel >= 1 → an UPGRADE → credit the flat per-level
      //     delta storage.capacity (= floorScaledCapacity(L) −
      //     floorScaledCapacity(L−1)).
      // The value is a percentage MULTIPLIER; creditStorageCaps expands it
      // to `mult × storageBaseFor(r)` per affected resource (§4.6).
      // The same loop runs each segment, so offline-catchup builds that
      // complete mid-advance are credited correctly. Mirrors the amounts
      // placeBuilding/applyUpgrade used to grant at commit, just deferred.
      if (justCompleted) {
        const cdef = BUILDING_DEFS[b.defId];
        const storage = cdef.storage;
        if (storage) {
          const mult =
            floorLevel(b) === 0
              ? floorScaledCapacity(b, storage.capacity)
              : storage.capacity;
          creditStorageCaps(state, b, cdef, mult);
        }
      }
      continue;
    }
    // §NEW building-disable: player-disabled buildings freeze in place —
    // no operatingMs accrual, no maintenance degradation. Re-enable
    // resumes accrual at the frozen operatingMs value. A fully floor-
    // disabled building (active 0) freezes the same way; a PARTIALLY
    // floor-disabled building (active ≥ 1) still wears.
    if (activeFloors(b) <= 0) continue;
    // Fix 4.4: invalid buildings are non-operational the same way
    // (mirrors isOperationalBuilding, buildings.ts) — they produce
    // nothing in computeRates, so they must not accrue wear either.
    if (b.invalid === true) continue;
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
    accrueOperatingTime(b, dtMs * (utilById.get(b.id) ?? 0));
  }
  // §queue: after construction ticks, a running slot may have just
  // freed up (build completed). Promote the FIFO queue head so it
  // begins ticking within the same advance call.
  promoteQueuedBuilds(state);
}

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
  // §2.6 vent: non-stored outputs (co2 only — P4 Phase 1 moved the 6 byproducts
  // to OUTPUT_CAP_EXEMPT) never sit in island inventory. Drain any stock here —
  // runtime never writes them (applyRates skips), so the only way a bin is
  // non-zero is a save written before this behavior; clear it so the bin reads
  // empty. co2's climate value is the per-island `co2Kg` scalar (untouched),
  // summed globally by `sumIslandCo2`.
  for (const r of NON_STORED_OUTPUTS) {
    if ((state.inventory[r] ?? 0) !== 0) state.inventory[r] = 0;
  }
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
  // accidental mutation in dev. §perf-2026-06-10: read from the
  // signature-keyed memo (clone — the memoized base is never handed out).
  const baseMult = cloneSkillMultipliers(
    getDerivationsMemo(state, defs, ctx?.geothermalActive ?? false, ctx?.crossIsland).baseSkillMul,
  );
  Object.freeze(baseMult);  // shallow — covers all primitive fields
  // The caller's modifier bundle is stable for the duration of this advance
  // call. When `high_wind` is active its variance sample changes per second,
  // so we clamp each integration segment to the next second boundary.
  const varianceActive = (ctx?.modifierMul ?? IDENTITY_MODIFIER_MULTIPLIERS).outputVariance;
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
    // NB: this overrides any caller-supplied ctx.baseMult — test multiplier
    // injection (e.g. recipeInput) must call computeRates directly, not
    // advanceIsland.
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
    const { byBuilding, production, consumption, net, power } = computeRates(
      state,
      effectiveCtx,
      t,
      t + wallOffset,
    );
    // §13.3 Battery buffer — bound segment to battery depletion/fill so the
    // piecewise integrator stays exact (rates are constant within a segment).
    const validBuildings = state.buildings.filter((b) => !b.invalid);
    // §perf-2026-06-10: re-fetched per segment (NOT hoisted out of the loop)
    // because level-ups / construction completions inside this advance change
    // the signature; the memo hit path makes the steady-state cost a string
    // compare. Clone before layering — layerConditionalBonuses mutates.
    const skillMul = cloneSkillMultipliers(
      getDerivationsMemo(state, defs, ctx?.geothermalActive ?? false, ctx?.crossIsland).baseSkillMul,
    );
    // Per-segment WALL-clock evaluation (`t + wallOffset`, NOT end-of-advance
    // `nowMs`): a multi-hour offline catch-up must evaluate each segment's
    // during-night boolean at the segment's own time. The integrator clamps
    // segments at `nextRealPhaseBoundaryMs` precisely so this boolean is
    // constant within a segment.
    layerConditionalBonuses(skillMul, state, ctx?.world, DEFAULT_GRAPH, t + wallOffset);
    const maxCap = batteryCapacityWs(state, skillMul);
    const rawBalance = power.rawProduced - power.rawConsumed;
    // §5.3 (fix 3.5): under a unified cable component the battery is inert —
    // the component balances produced/consumed at the network level, so a
    // local surplus is already exported (charging off it would double-count)
    // and a local deficit is already covered (discharging into it drains
    // stored energy with zero effect). Gates the boundary computation here
    // AND the charge/discharge application below.
    const batteryIsLocal = !(ctx?.cableComponent?.unified);
    let nextBatteryMs = Infinity;
    if (!batteryIsLocal) {
      // unified — no battery boundary, no charge/discharge this segment
    } else if (rawBalance > 0 && maxCap > 0 && state.batteryStoredWs < maxCap) {
      const surplus = rawBalance;
      const fillTimeSec = (maxCap - state.batteryStoredWs) / surplus;
      nextBatteryMs = t + fillTimeSec * 1000;
    } else if (rawBalance < 0 && state.batteryStoredWs >= BATTERY_EMPTY_THRESHOLD_WS && maxCap > 0) {
      const deficit = -rawBalance;
      const depletionTimeSec = state.batteryStoredWs / deficit;
      nextBatteryMs = t + depletionTimeSec * 1000;
    }
    const utilById = new Map<string, number>();
    for (const br of byBuilding) utilById.set(br.building.id, br.utilization);
    const nextEventMs = findNextCapEvent(state, net, t, nowMs, effectiveCtx, utilById);
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
    const phaseLat = ctx?.world?.playerLat ?? null;
    const phaseLon = ctx?.world?.playerLon ?? null;
    const nextPhaseMs = nextRealPhaseBoundaryMs(t + wallOffset, phaseLat, phaseLon) - wallOffset;
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
    // §3.5 high_wind variance re-samples once per second. The sample is
    // constant within a second, so a long catch-up segment must split at the
    // next second boundary or the integral would use one arbitrary draw for
    // the whole interval.
    let nextVarianceMs = Infinity;
    if (varianceActive) {
      nextVarianceMs = (Math.floor(t / VARIANCE_SAMPLE_MS) + 1) * VARIANCE_SAMPLE_MS;
    }
    // Clamp to nowMs; findNextCapEvent already returns nowMs when nothing
    // changes, but if all rates are zero we still need to exit the loop.
    const segEndMs = Math.min(nextEventMs, nextPhaseMs, nextSolarMs, nextAccelMs, nextBatteryMs, nextRotationMs, nextShotMs, nextVarianceMs, nowMs);
    const dtSec = (segEndMs - t) / 1000;
    if (dtSec > 0) {
      applyRates(state, net, dtSec, ctx?.caps, baseMult);
      applySegmentSideEffects(
        state,
        byBuilding,
        production,
        consumption,
        dtSec,
        segEndMs,
        t,
        ctx,
        skillMul,
        batteryIsLocal,
        rawBalance,
        maxCap,
        utilById,
      );
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
