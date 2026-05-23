// Per-island skill tree per SPEC §9.3. Pure logic — no PixiJS, no DOM.
//
// Directed graph model: five branches × 4 sub-paths each. Each sub-path is a
// chain of filler nodes (depth-graded, templated) plus hand-curated notables
// and keystones. Total ~600-800 nodes across the graph.
//
// Players spend skill points (granted on level-up, §9.1) to unlock nodes,
// which compose multiplicatively into rate, cap, and power multipliers
// consumed by `computeRates` in `economy.ts`.
//
// Purchasing uses `costToUnlock` (Dijkstra over the graph from owned nodes)
// and `buyNode` (charges the cheapest-path SP cost, auto-owns intermediates).
// AND-prereq keystones gate via `canBuyKeystone` / `buyKeystone`. Threshold-
// bridges activate when branch-spent thresholds are met.

import type { BuildingDefId } from './building-defs.js';
import { hasOperationalBuilding } from './buildings.js';
import type { IslandState } from './economy.js';
import type { Recipe, RecipeCategory } from './recipes.js';
import { ALL_RECIPE_CATEGORIES } from './recipes.js';
import { ALL_STORAGE_CATEGORIES, type StorageCategory } from './storage-categories.js';
import type { Biome } from './world.js';
import type { Edge, EdgeId, Graph, BridgeEdge, KeystonePrereq } from './skilltree-graph.js';
import { FULL_CATALOG } from './skilltree-catalog.js';

export type BranchId = 'extraction' | 'refinement' | 'logistics' | 'orbital' | 'ocean';

export type SubPathId =
  // Extraction branch
  | 'mining'
  | 'forestry'
  | 'drilling'
  | 'robotics'
  // Refinement branch
  | 'smelting'
  | 'chemistry'
  | 'electronics'
  | 'power_systems'
  // Logistics branch
  | 'storage'
  | 'transport'
  | 'network'
  // Orbital branch
  | 'launch'
  | 'communication'
  | 'discovery'
  | 'resilience'
  // Ocean branch
  | 'patronage'
  | 'aquaculture'
  | 'hydroprocessing'
  | 'submarine'
  | 'oceanography';

/** Node id is `<subPath>.<depth>`, e.g. `mining.1`. */
export type NodeId = string;

/**
 * Tagged effect union for skill nodes. The economy reads only the resolved
 * multipliers from `effectiveSkillMultipliers`, so adding a new effect kind
 * requires both a case here and a fold in that function.
 *
 *   - `recipeRateMul`: multiplies the rate of every recipe matching `category`.
 *   - `storageCapMul`: multiplies every storage cap uniformly.
 *   - `powerProductionMul`: multiplies `building.power.produces`.
 *   - `powerConsumptionMul`: divides `building.power.consumes` (reduce = true
 *     means "lower consumption = good"; multiplier > 1 reduces draw).
 *   - `placeholder`: no economic effect in step 5; reserves the node slot
 *     for a future activation (construction speed, route capacity, etc.).
 */
export type AdjacencyEffectData =
  | { readonly kind: 'pairBoost'; readonly pair: readonly [BuildingDefId, BuildingDefId]; readonly recipeRateBonus: number };

export type StructuralEffectData =
  | { readonly kind: 'sharedPowerGrid' }
  | { readonly kind: 'parallelConstruction'; readonly bonus: number };

export type SkillEffect =
  | { readonly kind: 'recipeRateMul'; readonly category: RecipeCategory }
  | { readonly kind: 'storageCapMul' }
  | { readonly kind: 'powerProductionMul' }
  | { readonly kind: 'powerConsumptionMul'; readonly reduce: true }
  | { readonly kind: 'placeholder' }
  | { readonly kind: 'unlockRecipe'; readonly targetBuilding: BuildingDefId; readonly recipe: Recipe }
  | { readonly kind: 'exoticAdjacency'; readonly description: string; readonly effect: AdjacencyEffectData }
  | { readonly kind: 'biomeBypass'; readonly buildings: ReadonlyArray<BuildingDefId> }
  | { readonly kind: 'structural'; readonly description: string; readonly data: StructuralEffectData }
  | { readonly kind: 'launchSuccessAdditive' }
  // Wired in the skill-tree-finishing pass — replaces the placeholder /
  // structural slots once the underlying mechanics shipped:
  //   - routeCapacityMul     → routes.ts dispatched-batch capacity per island
  //   - commRangeMul         → orbital.ts ground-station + sat comm range
  //   - maintenanceThresholdMul → maintenance.ts threshold extension factor
  //   - scannerCoverageMul   → orbital.ts Scanner Sat coverage radius
  //   - debrisProtectionMul  → orbital.ts debris lodge probability reduction
  | { readonly kind: 'routeCapacityMul' }
  | { readonly kind: 'commRangeMul' }
  | { readonly kind: 'maintenanceThresholdMul' }
  | { readonly kind: 'scannerCoverageMul' }
  | { readonly kind: 'debrisProtectionMul' }
  // Phase-A shallow wires — added when the prior "skill tree finished"
  // claim missed every spec theme past the headline % bonus per sub-path:
  //   - droneFuelEfficiencyMul → drones.ts dispatch fuel debit
  //   - airshipRangeMul        → routes.ts airship route range/capacity
  //   - padExplosionReduceMul  → orbital.ts launch failure pad-explosion split
  //   - satBufferCapMul        → orbital.ts SAT_BUFFER_CAP scaling per launch
  //   - scannerDwellRateMul    → orbital.ts scanner discovery dwell ramp
  //   - satFuelReserveMul      → orbital.ts launchSatellite starting fuel
  //   - repairDroneReliabilityMul → orbital.ts repair drone success roll
  //   - storageCategoryCapMul  → economy.ts per-category cap aggregation
  | { readonly kind: 'droneFuelEfficiencyMul' }
  | { readonly kind: 'airshipRangeMul' }
  | { readonly kind: 'padExplosionReduceMul' }
  | { readonly kind: 'satBufferCapMul' }
  | { readonly kind: 'scannerDwellRateMul' }
  | { readonly kind: 'satFuelReserveMul' }
  | { readonly kind: 'repairDroneReliabilityMul' }
  | { readonly kind: 'storageCategoryCapMul'; readonly category: StorageCategory }
  // Phase-B deep mechanics (new game systems built so Robotics's spec
  // themes can land for real):
  //   - constructionTimeMul   → construction.ts (divides placement-time)
  //   - parallelBuildCapAdd   → adds to concurrent under-construction slots
  | { readonly kind: 'constructionTimeMul' }
  | { readonly kind: 'parallelBuildCapAdd' }
  // Network sub-path primary mechanic — divides the per-tile biofuel cost
  // of teleporter route dispatch (a new cost added so "Network reach" has
  // something to scale; previously teleporters were free + instant).
  | { readonly kind: 'teleporterEfficiencyMul' }
  // Mining + Forestry secondary themes — building-targeted output bonuses.
  //   - mineYieldBonusMul       → per-Mine recipe rate bonus (vein depth)
  //   - mineRareTrickleMul      → per-Mine continuous helium_3 trickle
  //                               (rare reveal modelled as continuous yield
  //                               since RNG is incompatible with the
  //                               deterministic piecewise integrator)
  //   - loggerYieldBonusMul     → per-Logger recipe rate bonus (regrowth)
  //   - loggerExoticTrickleMul  → per-Logger continuous lumber trickle
  //                               (exotic species → bonus refined output)
  | { readonly kind: 'mineYieldBonusMul' }
  | { readonly kind: 'mineRareTrickleMul' }
  | { readonly kind: 'loggerYieldBonusMul' }
  | { readonly kind: 'loggerExoticTrickleMul' }
  // Robotics tertiary axis — "drone production efficiency". Multiplies the
  // scan radius of dispatched drones for the origin island so the same fuel
  // covers more of the unknown map per round-trip.
  | { readonly kind: 'droneScanRadiusMul' }
  // Phase-C — graph-redesign additions (2026-05-23):
  //   conditionalBonus  → multiplier active only when condition is true
  //   crossIslandShared → resource pool / stat shared across networked T3+ islands
  //   tierBypass        → operate a specific building one tier below requirement
  //   xpGainMul         → multiplies XP gained per production tick
  | { readonly kind: 'conditionalBonus'; readonly multiplier: number;
      readonly appliesTo: RecipeCategory | 'storage' | 'power' | 'xp';
      readonly condition: ConditionalEffectCondition }
  | { readonly kind: 'crossIslandShared'; readonly shape:
      | { readonly kind: 'sharedInventory'; readonly resources: ReadonlyArray<string> }
      | { readonly kind: 'sharedStorageCap'; readonly resources: ReadonlyArray<string> }
      | { readonly kind: 'sharedRouteCapacity' } }
  | { readonly kind: 'tierBypass'; readonly buildings: ReadonlyArray<BuildingDefId>;
      readonly tierShift: 1 }
  | { readonly kind: 'xpGainMul'; readonly category?: RecipeCategory };

/** Closed union of conditions for `conditionalBonus`. Each must be evaluable
 *  in O(1) at tick start; new entries require both a case here and an evaluator
 *  in `evaluateConditionalEffectCondition` in economy.ts. */
export type ConditionalEffectCondition =
  | { readonly kind: 'during-storm' }
  | { readonly kind: 'during-night' }
  | { readonly kind: 'networked-to-N-T3-islands'; readonly n: number }
  | { readonly kind: 'adjacent-tile-is-biome'; readonly biome: Biome };

export interface AuraSpec {
  readonly radius: 1 | 2;
  readonly bonus: number; // e.g. 0.15 → amplifies adjacent nodes' factor by ×1.15
  readonly appliesTo?: string; // optional filter; absent = applies to all effects
}

export interface SkillNode {
  readonly id: NodeId;
  readonly subPath: SubPathId;
  readonly depth: number;
  /** Skill-point cost. Per §9.3: `cost(depth) = 2^(depth - 1)`. */
  readonly cost: number;
  /** Magnitude of the effect (e.g. 0.05 = +5%). Per §9.3 doubles with depth
   *  through depth 5. Stored as the +bonus, not the multiplier (0.05 not 1.05). */
  readonly magnitude: number;
  readonly effect: SkillEffect;
  readonly description: string;
  readonly aura?: AuraSpec;
}

/** Tier required to purchase a node at the given depth, per §9.3. */
export type Tier = 1 | 2 | 3 | 4 | 5 | 6;

/** Branch each sub-path belongs to, for the sequential-sub-path lock (§9.3). */
export const SUBPATH_BRANCH: Readonly<Record<SubPathId, BranchId>> = {
  mining: 'extraction',
  forestry: 'extraction',
  drilling: 'extraction',
  robotics: 'extraction',
  smelting: 'refinement',
  chemistry: 'refinement',
  electronics: 'refinement',
  power_systems: 'refinement',
  storage: 'logistics',
  transport: 'logistics',
  network: 'logistics',
  launch: 'orbital',
  communication: 'orbital',
  discovery: 'orbital',
  resilience: 'orbital',
  patronage: 'logistics',
  aquaculture: 'ocean',
  hydroprocessing: 'ocean',
  submarine: 'ocean',
  oceanography: 'ocean',
};

/** Sub-paths grouped by branch. Order is the order the UI displays them in. */
export const BRANCH_SUBPATHS: Readonly<Record<BranchId, ReadonlyArray<SubPathId>>> = {
  extraction: ['mining', 'forestry', 'drilling', 'robotics'],
  refinement: ['smelting', 'chemistry', 'electronics', 'power_systems'],
  logistics: ['storage', 'transport', 'network', 'patronage'],
  orbital: ['launch', 'communication', 'discovery', 'resilience'],
  ocean: ['aquaculture', 'hydroprocessing', 'submarine', 'oceanography'],
};

/** Display labels for sub-paths. Pure data; UI imports these to render. */
export const SUBPATH_LABEL: Readonly<Record<SubPathId, string>> = {
  mining: 'Mining',
  forestry: 'Forestry',
  drilling: 'Drilling',
  robotics: 'Robotics',
  smelting: 'Smelting',
  chemistry: 'Chemistry',
  electronics: 'Electronics',
  power_systems: 'Power Systems',
  storage: 'Storage',
  transport: 'Transport',
  network: 'Network',
  launch: 'Launch',
  communication: 'Communication',
  discovery: 'Discovery',
  resilience: 'Resilience',
  patronage: 'Patronage',
  aquaculture: 'Aquaculture',
  hydroprocessing: 'Hydroprocessing',
  submarine: 'Submarine',
  oceanography: 'Oceanography',
};

export const BRANCH_LABEL: Readonly<Record<BranchId, string>> = {
  extraction: 'Extraction',
  refinement: 'Refinement',
  logistics: 'Logistics',
  orbital: 'Orbital',
  ocean: 'Ocean',
};

/**
 * Map an island level to its tier per §9.2. Spec ranges overlap at the
 * breakpoint values; the "crossing N unlocks Tier" parentheticals resolve
 * the boundaries: level=5 IS T2, level=15 IS T3, level=30 IS T4, level=50 IS T5.
 *
 * This is tier IDENTIFICATION (which tier band does this level belong to),
 * not full T5 ACCESS — the §13.1 T5 access gate also requires `aiCoreCrafted`,
 * enforced by `t5Unlocked` below and by `buildingUnlocked` in `building-defs.ts`.
 * `tierForLevel(50) === 5` regardless of the AI-core flag because the tier
 * band is a level-bucket concept; the AI-core gate is a separate composability
 * on top.
 *
 * T6 ("Ascendant Core + Spaceport" per §9.2) is never returned by this
 * function — there is no level threshold for T6. T6 access composes
 * orthogonally to level via `t6Unlocked` below (Ascendant Core crafted
 * AND Spaceport placed).
 */
export function tierForLevel(level: number): Tier {
  if (level >= 50) return 5;
  if (level >= 30) return 4;
  if (level >= 15) return 3;
  if (level >= 5) return 2;
  return 1;
}

/**
 * §13.1 T5 access gate: an island unlocks T5 only after BOTH reaching level
 * 50 AND crafting at least one AI core. Pure — takes the minimal duck-typed
 * shape so it can be called with a full `IslandState` or any fixture that
 * carries the two fields. Used by `buildingUnlocked` (for T5 defs) and by
 * any future T5-feature gate (T5 skill-tree sub-paths, T5 recipes, etc.).
 */
export function t5Unlocked(state: { level: number; aiCoreCrafted: boolean }): boolean {
  return state.level >= 50 && state.aiCoreCrafted;
}

/**
 * §14.1 T6 access gate: an island unlocks T6 only after BOTH crafting an
 * Ascendant Core (`ascendantCoreCrafted` flag) AND placing a Spaceport
 * building on that island. Pure — takes the minimal duck-typed shape so
 * it can be called with `(IslandState, IslandSpec)` or with bespoke
 * fixtures. Used as the canonical full-island T6 gate (catalog rows,
 * future T6 skill sub-paths per §14.9, future T6 launch mechanics per
 * §14.2-14.8).
 *
 * Note: `buildingUnlocked` exempts the Spaceport itself from the
 * "Spaceport placed" half of the gate — otherwise the very first
 * Spaceport would be unbuildable. `t6Unlocked` does NOT carry that
 * exemption because it's the full-island gate: pre-Spaceport the
 * island is not in the T6 access band even though one specific def
 * (Spaceport) IS placeable.
 *
 * The `spec` argument's shape is intentionally narrow — only
 * `buildings[].defId` is read — so a synthetic test fixture can pass a
 * minimal stand-in without satisfying the full IslandSpec contract.
 */
export function t6Unlocked(
  state: { ascendantCoreCrafted: boolean },
  spec: { buildings: ReadonlyArray<{ defId: string }> },
): boolean {
  if (!state.ascendantCoreCrafted) return false;
  return hasOperationalBuilding(spec.buildings, 'spaceport');
}

/** Tier required to purchase a node at the given depth per §9.3. */
export function tierRequiredForDepth(depth: number): Tier {
  if (depth >= 8) return 6;
  if (depth >= 5) return 5;
  if (depth >= 4) return 4;
  if (depth >= 3) return 3;
  return 2;
}

/** Spec §9.3 placeholder is `2^(depth-1)`, but combined with the flat
 *  1-point-per-level grant that costs the full tree ~500k levels —
 *  every node past depth ~6 is unreachable. The 1.5 ramp keeps the
 *  shape (each node costs more than the last) while landing the
 *  whole-sub-path total at ~874 points (vs the spec's 32,767) so a
 *  late-game island at L70+ can credibly complete sub-paths. */
export function costForDepth(depth: number): number {
  return Math.round(1.5 ** (depth - 1));
}

/** Skill points granted on a single level-up. Spec §9.3 doesn't
 *  prescribe a curve; flat 1/level made the late-game tree unreachable.
 *  The 1.1^L geometric grant keeps early-game grants tiny (L1-L7 still
 *  award 1 point) and ramps so L70 grants ~790 and L100 grants ~13,780.
 *  Combined with costForDepth's slowed ramp, this lands the full tree
 *  around L75 — matching the spec's "very-late-game L70+ reaches
 *  depth 7-10" claim. */
export function skillPointsForLevelUp(level: number): number {
  return Math.max(1, Math.floor(1.1 ** level));
}

/** Cumulative skill points an island SHOULD have received from level 1
 *  through the given level under the current `skillPointsForLevelUp`
 *  schedule. Used by the persistence-layer migration that tops up
 *  islands carried over from the pre-curve flat-1-per-level era so
 *  long-lived saves don't penalise the player for having levelled
 *  before the new grant ramp shipped. */
export function cumulativeSkillPointsForLevel(level: number): number {
  let total = 0;
  for (let l = 1; l <= level; l++) {
    total += skillPointsForLevelUp(l);
  }
  return total;
}

/**
 * Tier gating was removed in the graph redesign (Task 19); kept as a
 * backward-compatibility stub so legacy UI code still compiles.
 */
export function nodeRequiredTier(_node: SkillNode): Tier {
  return 1;
}

// ---------------------------------------------------------------------------
// Validation + spending (backward-compat stubs)
// ---------------------------------------------------------------------------

export type CanSpendReason =
  | 'unknown-node'
  | 'already-unlocked'
  | 'insufficient-points';

export interface CanSpendResult {
  readonly ok: boolean;
  readonly reason?: CanSpendReason;
}

interface Catalog {
  readonly nodes: ReadonlyArray<SkillNode>;
  readonly byId: ReadonlyMap<NodeId, SkillNode>;
  readonly bySubPath: ReadonlyMap<SubPathId, ReadonlyArray<SkillNode>>;
}

function buildCatalog(nodes: ReadonlyArray<SkillNode>): Catalog {
  const byId = new Map<NodeId, SkillNode>();
  const bySubPathMut = new Map<SubPathId, SkillNode[]>();
  for (const n of nodes) {
    byId.set(n.id, n);
    const arr = bySubPathMut.get(n.subPath) ?? [];
    arr.push(n);
    bySubPathMut.set(n.subPath, arr);
  }
  // Sort each sub-path's nodes by ascending depth for prereq lookup.
  const bySubPath = new Map<SubPathId, ReadonlyArray<SkillNode>>();
  for (const [sp, arr] of bySubPathMut) {
    bySubPath.set(sp, arr.slice().sort((a, b) => a.depth - b.depth));
  }
  return { nodes, byId, bySubPath };
}

/** Alias to the new hand-curated + generated catalog for backward compat. */
export const NODE_CATALOG = FULL_CATALOG;

const DEFAULT_CATALOG: Catalog = buildCatalog(NODE_CATALOG);

/** Default skill graph — nodes from the live catalog with no edges. */
export const DEFAULT_GRAPH: Graph = {
  nodes: NODE_CATALOG,
  edges: [],
  bridges: [],
  graftSockets: [],
};

/**
 * Backward-compat spend gate. The graph engine uses `costToUnlock` /
 * `buyNode` for real purchases; this stub remains so legacy UI code compiles.
 */
export function canSpend(
  state: IslandState,
  nodeId: NodeId,
  catalog: ReadonlyArray<SkillNode> = NODE_CATALOG,
): CanSpendResult {
  const cat = catalog === NODE_CATALOG ? DEFAULT_CATALOG : buildCatalog(catalog);
  const node = cat.byId.get(nodeId);
  if (!node) return { ok: false, reason: 'unknown-node' };
  if (state.unlockedNodes.has(nodeId)) {
    return { ok: false, reason: 'already-unlocked' };
  }
  if (state.unspentSkillPoints < node.cost) {
    return { ok: false, reason: 'insufficient-points' };
  }
  return { ok: true };
}

/**
 * Backward-compat point spender. The graph engine uses `buyNode` for real
 * purchases; this stub remains so legacy UI code compiles.
 */
export function spendPoint(
  state: IslandState,
  nodeId: NodeId,
  catalog: ReadonlyArray<SkillNode> = NODE_CATALOG,
): void {
  const cat = catalog === NODE_CATALOG ? DEFAULT_CATALOG : buildCatalog(catalog);
  const node = cat.byId.get(nodeId);
  if (!node) throw new Error(`spendPoint: unknown node ${nodeId}`);
  state.unspentSkillPoints -= node.cost;
  state.unlockedNodes.add(nodeId);
}

// ---------------------------------------------------------------------------
// Effect aggregation
// ---------------------------------------------------------------------------

export interface SkillMultipliers {
  /** Per-category recipe rate multiplier. All categories present, default 1. */
  readonly recipeRate: Record<RecipeCategory, number>;
  /** Uniform storage-cap multiplier. */
  readonly storageCap: number;
  /** Multiplier applied to building.power.produces. */
  readonly powerProduction: number;
  /** Reduction multiplier applied to building.power.consumes — values > 1
   *  reduce draw (divide consumes by this). */
  readonly powerConsumption: number;
  /** Transport sub-path bonus — multiplies route per-batch capacity at the
   *  dispatching island. */
  readonly routeCapacity: number;
  /** Network + Orbital-Communication sub-path bonus — multiplies ground-station
   *  comm range and per-satellite comm range. */
  readonly commRange: number;
  /** Robotics sub-path bonus — multiplies the maintenance threshold (longer
   *  operating-time budget before degradation starts). */
  readonly maintenanceThreshold: number;
  /** Orbital-Discovery sub-path bonus — multiplies Scanner-Sat coverage radius. */
  readonly scannerCoverage: number;
  /** Orbital-Resilience sub-path bonus — multiplies (1 - debris lodge
   *  probability). 1.0 = no protection, 2.0 = halves lodge probability. */
  readonly debrisProtection: number;
  /** Transport sub-path — divides drone biofuel consumption per launch. */
  readonly droneFuelEfficiency: number;
  /** Transport sub-path — multiplies airship route effective range/capacity. */
  readonly airshipRange: number;
  /** Launch sub-path — DIVIDES the pad-explosion share of launch failures
   *  (the 30% baseline). 2.0 = halves the pad-explosion chance, redirecting
   *  failures to (less catastrophic) orbit explosions. */
  readonly padExplosionReduce: number;
  /** Communication sub-path — multiplies SAT_BUFFER_CAP for sats launched
   *  while this multiplier is in effect. */
  readonly satBufferCap: number;
  /** Discovery sub-path — multiplies the scanner discovery dwell rate
   *  (effective P-per-tick for Scanner Sats). */
  readonly scannerDwellRate: number;
  /** Resilience sub-path — multiplies a Satellite's starting onboard fuel. */
  readonly satFuelReserve: number;
  /** Resilience sub-path — DIVIDES repair-drone failure rate. */
  readonly repairDroneReliability: number;
  /** Storage sub-path (depth >= 3 unique unlocks) — per-category cap mul.
   *  Composes multiplicatively with the global `storageCap`. */
  readonly storageCategoryCap: Record<StorageCategory, number>;
  /** Robotics sub-path primary axis — divides building construction time
   *  at placement. Larger = faster builds. */
  readonly constructionTime: number;
  /** Robotics sub-path secondary axis — extra concurrent under-construction
   *  slots on top of the base 1. Stored as the additive bonus, not the
   *  total. Integer-typed at the caller (Math.floor). */
  readonly parallelBuildBonus: number;
  /** Network sub-path primary axis — divides the per-tile biofuel cost of
   *  teleporter route dispatch. Default 1 (full cost). */
  readonly teleporterEfficiency: number;
  /** Mining secondary axis — multiplies Mine-building recipe rates. Stacks
   *  with the global recipeRate.extraction multiplier. */
  readonly mineYieldBonus: number;
  /** Mining tertiary axis — additive bonus rate (units/sec) of helium_3
   *  per Mine on the island. Continuous-yield model of "rare reveal". */
  readonly mineRareTrickleRate: number;
  /** Forestry secondary axis — multiplies Logger-building recipe rates. */
  readonly loggerYieldBonus: number;
  /** Forestry tertiary axis — additive bonus rate (units/sec) of lumber
   *  per Logger on the island. Continuous-yield model of "exotic species". */
  readonly loggerExoticTrickleRate: number;
  /** Robotics tertiary axis — multiplies the scan radius of drones
   *  dispatched from this island. */
  readonly droneScanRadius: number;
  /** Global XP gain multiplier (all categories). */
  readonly xpGain: number;
  /** Per-category XP gain multiplier. */
  readonly xpGainByCategory: Record<RecipeCategory, number>;
}

function blankMultipliers(): SkillMultipliers {
  const recipeRate = {} as Record<RecipeCategory, number>;
  for (const c of ALL_RECIPE_CATEGORIES) recipeRate[c] = 1;
  const storageCategoryCap = {} as Record<StorageCategory, number>;
  for (const c of ALL_STORAGE_CATEGORIES) storageCategoryCap[c] = 1;
  return {
    recipeRate,
    storageCap: 1,
    powerProduction: 1,
    powerConsumption: 1,
    routeCapacity: 1,
    commRange: 1,
    maintenanceThreshold: 1,
    scannerCoverage: 1,
    debrisProtection: 1,
    droneFuelEfficiency: 1,
    airshipRange: 1,
    padExplosionReduce: 1,
    satBufferCap: 1,
    scannerDwellRate: 1,
    satFuelReserve: 1,
    repairDroneReliability: 1,
    storageCategoryCap,
    constructionTime: 1,
    parallelBuildBonus: 0,
    teleporterEfficiency: 1,
    mineYieldBonus: 1,
    mineRareTrickleRate: 0,
    loggerYieldBonus: 1,
    loggerExoticTrickleRate: 0,
    droneScanRadius: 1,
    xpGain: 1,
    xpGainByCategory: Object.fromEntries(ALL_RECIPE_CATEGORIES.map((c) => [c, 1])) as Record<RecipeCategory, number>,
  };
}

/**
 * Fold every unlocked node's effect into a single `SkillMultipliers` bundle.
 * Multiple nodes targeting the same axis compose multiplicatively:
 *   mining.1 (+5%) × mining.2 (+10%) → 1.05 × 1.10 = 1.155×.
 *
 * Aura-bearing notables amplify adjacent owned nodes' factors.
 */
export function effectiveSkillMultipliers(
  state: IslandState,
  graph: Graph = DEFAULT_GRAPH,
): SkillMultipliers {
  const cat = graph.nodes === NODE_CATALOG ? DEFAULT_CATALOG : buildCatalog(graph.nodes);
  const out = blankMultipliers();
  // Mutate-in-place pattern; readonly types on the returned object describe
  // the consumer contract, not the local builder.
  const recipeRate = out.recipeRate as Record<RecipeCategory, number>;
  let storageCap = 1;
  let powerProduction = 1;
  let powerConsumption = 1;
  let routeCapacity = 1;
  let commRange = 1;
  let maintenanceThreshold = 1;
  let scannerCoverage = 1;
  let debrisProtection = 1;
  let droneFuelEfficiency = 1;
  let airshipRange = 1;
  let padExplosionReduce = 1;
  let satBufferCap = 1;
  let scannerDwellRate = 1;
  let satFuelReserve = 1;
  let repairDroneReliability = 1;
  let constructionTime = 1;
  let parallelBuildBonus = 0;
  let teleporterEfficiency = 1;
  let mineYieldBonus = 1;
  let mineRareTrickleRate = 0;
  let loggerYieldBonus = 1;
  let loggerExoticTrickleRate = 0;
  let droneScanRadius = 1;
  let xpGain = 1;
  // Rare-trickle additive base rate per skill node. Continuous yield model
  // — at depth 1 each Mine produces an extra `RARE_TRICKLE_BASE × magnitude`
  // helium_3 per second; deeper nodes scale up via the magnitude ramp.
  const RARE_TRICKLE_BASE_PER_SEC = 0.001;
  const EXOTIC_TRICKLE_BASE_PER_SEC = 0.001;
  const storageCategoryCap = out.storageCategoryCap as Record<StorageCategory, number>;
  const xpGainByCategory = { ...out.xpGainByCategory } as Record<RecipeCategory, number>;

  // Aura pre-pass: compute per-node aura amplification multipliers.
  const auraAmp = computeAuraAmplifiers(state, graph);

  for (const nodeId of state.unlockedNodes) {
    const node = cat.byId.get(nodeId);
    if (!node) continue;
    const amp = auraAmp.get(nodeId) ?? 1;
    const m = 1 + node.magnitude * amp;
    switch (node.effect.kind) {
      case 'recipeRateMul': {
        const cur = recipeRate[node.effect.category] ?? 1;
        recipeRate[node.effect.category] = cur * m;
        break;
      }
      case 'storageCapMul':
        storageCap *= m;
        break;
      case 'powerProductionMul':
        powerProduction *= m;
        break;
      case 'powerConsumptionMul':
        powerConsumption *= m;
        break;
      case 'routeCapacityMul':
        routeCapacity *= m;
        break;
      case 'commRangeMul':
        commRange *= m;
        break;
      case 'maintenanceThresholdMul':
        maintenanceThreshold *= m;
        break;
      case 'scannerCoverageMul':
        scannerCoverage *= m;
        break;
      case 'debrisProtectionMul':
        debrisProtection *= m;
        break;
      case 'droneFuelEfficiencyMul':
        droneFuelEfficiency *= m;
        break;
      case 'airshipRangeMul':
        airshipRange *= m;
        break;
      case 'padExplosionReduceMul':
        padExplosionReduce *= m;
        break;
      case 'satBufferCapMul':
        satBufferCap *= m;
        break;
      case 'scannerDwellRateMul':
        scannerDwellRate *= m;
        break;
      case 'satFuelReserveMul':
        satFuelReserve *= m;
        break;
      case 'repairDroneReliabilityMul':
        repairDroneReliability *= m;
        break;
      case 'storageCategoryCapMul': {
        const cur = storageCategoryCap[node.effect.category] ?? 1;
        storageCategoryCap[node.effect.category] = cur * m;
        break;
      }
      case 'constructionTimeMul':
        constructionTime *= m;
        break;
      case 'parallelBuildCapAdd':
        // Additive — each node grants +1 concurrent slot (the magnitude
        // doesn't scale the bonus; depth-2 contributes 1, deeper nodes
        // contribute 1 each).
        parallelBuildBonus += 1;
        break;
      case 'teleporterEfficiencyMul':
        teleporterEfficiency *= m;
        break;
      case 'mineYieldBonusMul':
        mineYieldBonus *= m;
        break;
      case 'mineRareTrickleMul':
        // Additive accumulation — depth-1 adds 0.001 × 1.05; deeper nodes
        // contribute their own magnitude-scaled increments.
        mineRareTrickleRate += RARE_TRICKLE_BASE_PER_SEC * m;
        break;
      case 'loggerYieldBonusMul':
        loggerYieldBonus *= m;
        break;
      case 'loggerExoticTrickleMul':
        loggerExoticTrickleRate += EXOTIC_TRICKLE_BASE_PER_SEC * m;
        break;
      case 'droneScanRadiusMul':
        droneScanRadius *= m;
        break;
      case 'xpGainMul':
        if (node.effect.category !== undefined) xpGainByCategory[node.effect.category] *= m;
        else xpGain *= m;
        break;
      case 'placeholder':
      case 'unlockRecipe':
      case 'exoticAdjacency':
      case 'biomeBypass':
      case 'structural':
      case 'launchSuccessAdditive':
      case 'conditionalBonus':
      case 'crossIslandShared':
      case 'tierBypass':
        break; // non-multiplier kinds — handled by their own engine sites
    }
  }
  return {
    recipeRate,
    storageCap,
    powerProduction,
    powerConsumption,
    routeCapacity,
    commRange,
    maintenanceThreshold,
    scannerCoverage,
    debrisProtection,
    droneFuelEfficiency,
    airshipRange,
    padExplosionReduce,
    satBufferCap,
    scannerDwellRate,
    satFuelReserve,
    repairDroneReliability,
    storageCategoryCap,
    constructionTime,
    parallelBuildBonus,
    teleporterEfficiency,
    mineYieldBonus,
    mineRareTrickleRate,
    loggerYieldBonus,
    loggerExoticTrickleRate,
    droneScanRadius,
    xpGain,
    xpGainByCategory,
  };
}

export interface ExoticAdjacencyRule {
  readonly pair: readonly [BuildingDefId, BuildingDefId];
  readonly recipeRateBonus: number;
}

export function skillUnlockedAdjacencyRules(
  state: IslandState,
  graph: Graph = DEFAULT_GRAPH,
): ReadonlyArray<ExoticAdjacencyRule> {
  const rules: ExoticAdjacencyRule[] = [];
  for (const nodeId of state.unlockedNodes) {
    const node = graph.nodes.find((n) => n.id === nodeId);
    if (node?.effect.kind === 'exoticAdjacency' && node.effect.effect.kind === 'pairBoost') {
      rules.push({ pair: node.effect.effect.pair, recipeRateBonus: node.effect.effect.recipeRateBonus });
    }
  }
  return rules;
}

/** For each owned node, compute the multiplicative aura amplification.
 *  An aura with bonus=0.15 on a node X amplifies adjacent owned nodes' factors
 *  by ×1.15. Multiple auras stack multiplicatively, capped at ×1.50 per node. */
function computeAuraAmplifiers(state: IslandState, graph: Graph): Map<NodeId, number> {
  const amp = new Map<NodeId, number>();
  const neighbours = buildAdjacency(graph);

  for (const nodeId of state.unlockedNodes) {
    const node = graph.nodes.find((n) => n.id === nodeId);
    if (node?.aura === undefined) continue;
    const { radius, bonus } = node.aura;
    const reachable = nodesWithinRadius(nodeId, radius, neighbours);
    for (const r of reachable) {
      if (!state.unlockedNodes.has(r)) continue;
      const cur = amp.get(r) ?? 1;
      const next = Math.min(1.5, cur * (1 + bonus));
      amp.set(r, next);
    }
  }
  return amp;
}

function buildAdjacency(graph: Graph): Map<NodeId, NodeId[]> {
  const adj = new Map<NodeId, NodeId[]>();
  for (const e of graph.edges) {
    const from = e.from as NodeId;
    const to = e.to as NodeId;
    const fList = adj.get(from) ?? [];
    fList.push(to);
    adj.set(from, fList);
    const tList = adj.get(to) ?? [];
    tList.push(from);
    adj.set(to, tList);
  }
  return adj;
}

function nodesWithinRadius(start: NodeId, radius: number, adj: Map<NodeId, NodeId[]>): NodeId[] {
  const result = new Set<NodeId>();
  const visited = new Set<NodeId>([start]);
  let frontier = [start];
  for (let d = 0; d < radius; d++) {
    const nextFrontier: NodeId[] = [];
    for (const node of frontier) {
      for (const nbr of adj.get(node) ?? []) {
        if (!visited.has(nbr)) {
          visited.add(nbr);
          result.add(nbr);
          nextFrontier.push(nbr);
        }
      }
    }
    frontier = nextFrontier;
  }
  return [...result];
}

/** §14.7 sum of Orbital `launch` sub-path additive bonuses for this island.
 *  Each unlocked launch.* node contributes its magnitude additively. Other
 *  sub-paths and other branches contribute 0. */
export function launchSuccessBonus(
  state: IslandState,
  catalog: ReadonlyArray<SkillNode> = NODE_CATALOG,
): number {
  const cat = catalog === NODE_CATALOG ? DEFAULT_CATALOG : buildCatalog(catalog);
  let bonus = 0;
  for (const nodeId of state.unlockedNodes) {
    const node = cat.byId.get(nodeId);
    if (!node) continue;
    if (node.effect.kind !== 'launchSuccessAdditive') continue;
    bonus += node.magnitude;
  }
  return bonus;
}

export function hasBiomeBypass(
  state: IslandState,
  defId: BuildingDefId,
  graph: Graph = DEFAULT_GRAPH,
): boolean {
  for (const nodeId of state.unlockedNodes) {
    const node = graph.nodes.find((n) => n.id === nodeId);
    if (node?.effect.kind === 'biomeBypass' && node.effect.buildings.includes(defId)) return true;
  }
  return false;
}

export function effectiveTierShift(
  state: IslandState,
  defId: BuildingDefId,
  graph: Graph = DEFAULT_GRAPH,
): number {
  for (const nodeId of state.unlockedNodes) {
    const node = graph.nodes.find((n) => n.id === nodeId);
    if (node?.effect.kind === 'tierBypass' && node.effect.buildings.includes(defId)) {
      return node.effect.tierShift;
    }
  }
  return 0;
}

/** Look up a node by id from the default catalog. Returns undefined if unknown. */
export function nodeById(id: NodeId): SkillNode | undefined {
  return DEFAULT_CATALOG.byId.get(id);
}

/**
 * True if `state` has at least one skill-tree node it can buy right now.
 * Composition: NODE_CATALOG.some(canSpend.ok) with early exit. Used by
 * the HUD island-bar to surface a global "claim available" cue without
 * the player opening the skill-tree modal.
 *
 * The graph engine uses `costToUnlock` / `buyNode` for real purchases;
 * this predicate is a backward-compat stub that checks points + ownership.
 */
export function hasPickableSkill(state: IslandState): boolean {
  for (const node of NODE_CATALOG) {
    if (canSpend(state, node.id).ok) return true;
  }
  return false;
}

/** Result of `costToUnlock` — the cheapest edge path to a target node. */
export interface CheapestPathResult {
  readonly path: ReadonlyArray<Edge>;
  readonly totalCost: number;
}

/** Multi-source Dijkstra. Sources are all currently-owned nodes (their distance
 *  is 0). Edge weights are the SP cost of each edge. Threshold-bridge edges are
 *  included only when their threshold is currently met (caller resolves this
 *  via `isBridgeActive` and passes the filtered edge set). Returns the
 *  cheapest path from any owned source to the target. Null = unreachable. */
export function costToUnlock(
  graph: Graph,
  ownedNodes: ReadonlySet<NodeId>,
  ownedEdges: ReadonlySet<EdgeId>,
  state: IslandState,
  target: NodeId,
): CheapestPathResult | null {
  if (ownedNodes.has(target)) return { path: [], totalCost: 0 };

  // Build adjacency from outgoing edges (since edges are directed).
  const adjacency = new Map<NodeId, Edge[]>();
  const allEdges: Edge[] = [
    ...graph.edges,
    ...graph.bridges.filter((b) => isBridgeActive(b, state, graph)),
  ];
  for (const e of allEdges) {
    const list = adjacency.get(e.from as NodeId) ?? [];
    list.push(e);
    adjacency.set(e.from as NodeId, list);
  }

  // Standard Dijkstra with multi-source seeding.
  const distance = new Map<NodeId, number>();
  const previous = new Map<NodeId, Edge>();
  const queue: Array<{ node: NodeId; cost: number }> = [];
  for (const n of ownedNodes) {
    distance.set(n, 0);
    queue.push({ node: n, cost: 0 });
  }

  while (queue.length > 0) {
    queue.sort((a, b) => a.cost - b.cost); // O(n log n) per pop; fine at ~500-1000 nodes
    const { node: u, cost: cu } = queue.shift()!;
    if (cu > (distance.get(u) ?? Infinity)) continue;
    if (u === target) break;

    for (const e of adjacency.get(u) ?? []) {
      // Skip edges already owned (they're free to traverse).
      const edgeCost = ownedEdges.has(e.id) ? 0 : e.cost;
      const next = cu + edgeCost;
      if (next < (distance.get(e.to as NodeId) ?? Infinity)) {
        distance.set(e.to as NodeId, next);
        previous.set(e.to as NodeId, e);
        queue.push({ node: e.to as NodeId, cost: next });
      }
    }
  }

  const total = distance.get(target);
  if (total === undefined) return null;

  // Walk back to reconstruct the path.
  const path: Edge[] = [];
  let cur: NodeId | undefined = target;
  while (cur !== undefined && !ownedNodes.has(cur)) {
    const e = previous.get(cur);
    if (e === undefined) break;
    path.unshift(e);
    cur = e.from as NodeId;
  }

  return { path, totalCost: total };
}

/** Charge SP and mutate state to own the cheapest-path edges and nodes leading
 *  to `target`. Throws on unreachable target or insufficient SP. No-op if
 *  target is already owned. */
export function buyNode(graph: Graph, state: IslandState, target: NodeId): void {
  if (state.unlockedNodes.has(target)) return;

  const result = costToUnlock(graph, state.unlockedNodes, state.unlockedEdges, state, target);
  if (result === null) throw new Error(`buyNode: unreachable target ${target}`);
  if (state.unspentSkillPoints < result.totalCost) {
    throw new Error(
      `buyNode: insufficient SP (need ${result.totalCost}, have ${state.unspentSkillPoints})`,
    );
  }

  state.unspentSkillPoints -= result.totalCost;
  for (const e of result.path) {
    state.unlockedNodes.add(e.to as NodeId);
    state.unlockedEdges.add(e.id as EdgeId);
  }
}

/** Gate predicate for AND-prereq keystones. True when all required upstream
 *  nodes are owned, the target is not already owned, and the player has
 *  enough unspent SP for the flat keystone cost. */
export function canBuyKeystone(ks: KeystonePrereq, state: IslandState): boolean {
  if (state.unlockedNodes.has(ks.targetNode as NodeId)) return false;
  if (state.unspentSkillPoints < ks.cost) return false;
  for (const req of ks.requires) {
    if (!state.unlockedNodes.has(req as NodeId)) return false;
  }
  return true;
}

/** Charge the flat keystone cost and add the target node to unlockedNodes.
 *  Throws if canBuyKeystone returns false. */
export function buyKeystone(ks: KeystonePrereq, state: IslandState): void {
  if (!canBuyKeystone(ks, state)) {
    throw new Error(`buyKeystone: prereqs unsatisfied for ${ks.targetNode}`);
  }
  state.unspentSkillPoints -= ks.cost;
  state.unlockedNodes.add(ks.targetNode as NodeId);
}

function isBridgeActive(bridge: BridgeEdge, state: IslandState, graph: Graph): boolean {
  return bridge.threshold.some(({ branch, minSpent }) => spentInBranch(state, branch, graph) >= minSpent);
}

function spentInBranch(state: IslandState, branchId: BranchId, graph: Graph): number {
  let sum = 0;
  for (const e of graph.edges) {
    if (state.unlockedEdges.has(e.id as EdgeId)) {
      const node = graph.nodes.find((n) => n.id === e.to);
      if (node !== undefined && SUBPATH_BRANCH[node.subPath] === branchId) sum += e.cost;
    }
  }
  return sum;
}
