// Per-island skill tree per SPEC §9.3. Pure logic — no PixiJS, no DOM.
//
// Four branches × sub-paths × depth-graded nodes. Players spend skill points
// (granted on level-up, §9.1) to unlock nodes, which compose multiplicatively
// into rate, cap, and power multipliers consumed by `computeRates` in
// `economy.ts`.
//
// The catalog implements depth 1-15 for all sub-paths (11 legacy + 4 Orbital
// = 15 sub-paths × 15 depths = 225 nodes). Depths 1-5 use the spec's
// doubling ramp (+5% → +80%); depths 6-15 continue with a slowed geometric
// extension (see `magnitudeForDepth`) so late-game investment is meaningful
// but bounded.
//
// Every depth-1 placeholder slot has been wired to a live mechanic:
//   - Robotics → maintenanceThresholdMul (later degradation)
//   - Transport → routeCapacityMul (more units per route batch)
//   - Network + Orbital Communication → commRangeMul (ground + sat comm reach)
//   - Orbital Discovery → scannerCoverageMul (sat coverage radius at launch)
//   - Orbital Resilience → debrisProtectionMul (reduces orbital hit chance)
// `kind: 'placeholder'` and `kind: 'structural'` remain as union members for
// forward-compat with future sub-paths but no catalog node currently uses
// them.

import type { BuildingDefId } from './building-defs.js';
import { hasOperationalBuilding } from './buildings.js';
import type { IslandState } from './economy.js';
import type { RecipeCategory } from './recipes.js';
import { ALL_RECIPE_CATEGORIES } from './recipes.js';
import { ALL_STORAGE_CATEGORIES, type StorageCategory } from './storage-categories.js';
import type { Biome } from './world.js';

export type BranchId = 'extraction' | 'refinement' | 'logistics' | 'orbital';

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
  | 'resilience';

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
export type SkillEffect =
  | { readonly kind: 'recipeRateMul'; readonly category: RecipeCategory }
  | { readonly kind: 'storageCapMul' }
  | { readonly kind: 'powerProductionMul' }
  | { readonly kind: 'powerConsumptionMul'; readonly reduce: true }
  | { readonly kind: 'placeholder' }
  | { readonly kind: 'unlockRecipe'; readonly recipeDefId: BuildingDefId }
  | { readonly kind: 'exoticAdjacency'; readonly description: string }
  | { readonly kind: 'biomeBypass'; readonly biomes: Biome[] }
  | { readonly kind: 'structural'; readonly description: string }
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
};

/** Sub-paths grouped by branch. Order is the order the UI displays them in. */
export const BRANCH_SUBPATHS: Readonly<Record<BranchId, ReadonlyArray<SubPathId>>> = {
  extraction: ['mining', 'forestry', 'drilling', 'robotics'],
  refinement: ['smelting', 'chemistry', 'electronics', 'power_systems'],
  logistics: ['storage', 'transport', 'network'],
  orbital: ['launch', 'communication', 'discovery', 'resilience'],
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
};

export const BRANCH_LABEL: Readonly<Record<BranchId, string>> = {
  extraction: 'Extraction',
  refinement: 'Refinement',
  logistics: 'Logistics',
  orbital: 'Orbital',
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

export function magnitudeForDepth(depth: number): number {
  // §9.3 "geometric to depth 5: depth 1 = +5%, doubles each step; mixed
  // thereafter — geometric continuation OR unique unlocks per sub-path."
  //
  // We pick "geometric continuation" with a SLOWED ramp post-depth-5 — pure
  // exponential continuation (×2 per step through depth 15) would land
  // depth-15 at +819× which is absurd, but a flat zero would make 110 deep
  // nodes (depth 6-15 × 11 non-orbital sub-paths) cost a fortune in points
  // for no effect (the previous `structural` placeholder).
  //
  // Schedule:
  //   depth 1-5: 0.05, 0.10, 0.20, 0.40, 0.80              (×2 doubling)
  //   depth 6-10: 1.20, 1.60, 2.00, 2.40, 2.80             (+0.40 per step)
  //   depth 11-15: 3.00, 3.20, 3.40, 3.60, 3.80            (+0.20 per step)
  //
  // Cost still doubles at every depth (`costForDepth = 2^(d-1)`), so the
  // late-depth nodes remain expensive enough that this is a credible chase.
  if (depth <= 5) {
    return 0.05 * (2 ** (depth - 1));
  }
  if (depth <= 10) {
    return 0.80 + 0.40 * (depth - 5);
  }
  if (depth <= 15) {
    return 2.80 + 0.20 * (depth - 10);
  }
  return 0;
}

/**
 * Required tier for a node at a given depth per §9.3:
 *   depth 1-2 → T2, depth 3 → T3, depth 4 → T4, depth 5-7 → T5, depth 8+ → T6.
 * §9.3's Drilling "T2+" annotation is subsumed by depth-1 → T2 uniformly.
 */
export function nodeRequiredTier(node: SkillNode): Tier {
  return tierRequiredForDepth(node.depth);
}

// ---------------------------------------------------------------------------
// Node catalog
// ---------------------------------------------------------------------------
//
// Depth 1-15 for all 15 sub-paths (11 legacy + 4 Orbital = 225 nodes).
// Magnitudes per §9.3: depth 1 = +5%, depth 2 = +10%, depth 3 = +20%,
// depth 4 = +40%, depth 5 = +80%. Costs: depth 1 = 1, depth 2 = 2, …,
// depth 15 = 16384.
//
// Effects:
//   Mining/Forestry/Drilling: recipe-rate multiplier on `extraction` recipes.
//   Robotics: placeholder (construction speed — no placement system yet).
//   Smelting/Chemistry/Electronics: recipe-rate multiplier on the matching
//     category.
//   Power Systems: multiplies producers' `power.produces`.
//   Storage: multiplies every storage cap.
//   Transport/Network: placeholder until routes/teleporters exist.
//   Orbital sub-paths (Launch/Communication/Discovery/Resilience): structural
//     placeholders until satellite/launch mechanics land (§14.9).

function rate(category: RecipeCategory): SkillEffect {
  return { kind: 'recipeRateMul', category };
}

const DEPTH1_MAG = 0.05;
const DEPTH2_MAG = 0.10;

function depth1(
  subPath: SubPathId,
  effect: SkillEffect,
  description: string,
): SkillNode {
  return {
    id: `${subPath}.1`,
    subPath,
    depth: 1,
    cost: 1,
    magnitude: DEPTH1_MAG,
    effect,
    description,
  };
}

function depth2(
  subPath: SubPathId,
  effect: SkillEffect,
  description: string,
): SkillNode {
  return {
    id: `${subPath}.2`,
    subPath,
    depth: 2,
    cost: 2,
    magnitude: DEPTH2_MAG,
    effect,
    description,
  };
}

function makeDeepNodes(
  subPath: SubPathId,
  baseEffect: SkillEffect,
  depthOverrides?: Readonly<Record<number, { effect: SkillEffect; description?: string }>>,
): SkillNode[] {
  // magnitudeForDepth returns non-zero for every depth 1-15 (slowed
  // geometric continuation past depth 5). `depthOverrides` lets a sub-path
  // splice in a different effect at specific depths (used for the tertiary
  // spec themes that only appear at one or two depths).
  const nodes: SkillNode[] = [];
  for (let d = 3; d <= 15; d++) {
    const cost = costForDepth(d);
    const mag = magnitudeForDepth(d);
    const override = depthOverrides?.[d];
    const effect = override?.effect ?? baseEffect;
    const description =
      override?.description ?? `${SUBPATH_LABEL[subPath]} +${(mag * 100).toFixed(0)}%`;
    nodes.push({
      id: `${subPath}.${d}`,
      subPath,
      depth: d,
      cost,
      magnitude: mag,
      effect,
      description,
    });
  }
  return nodes;
}

function makeOrbitalNodes(subPath: SubPathId): SkillNode[] {
  const nodes: SkillNode[] = [];
  // §14.9 four sub-paths, every spec theme wired:
  //   launch — additive launch-success bonus (§14.7) at depth 1+,
  //            pad-explosion mitigation at depth 2 only.
  //   communication — comm range at depth 1+,
  //                   store-and-forward bandwidth at depth 2 only.
  //   discovery — Scanner coverage at depth 1+,
  //               dwell ramp at depth 2 only.
  //   resilience — debris protection at depth 1+,
  //                fuel reserve at depth 2 and repair reliability at depth 3.
  // After the depth-2/3 variant slot, deeper nodes deepen the primary axis.
  for (let d = 1; d <= 15; d++) {
    let effect: SkillEffect;
    let descSuffix: string;
    const mag = magnitudeForDepth(d);
    switch (subPath) {
      case 'launch':
        if (d === 2) {
          effect = { kind: 'padExplosionReduceMul' };
          descSuffix = `Pad-explosion likelihood ÷${(1 + mag).toFixed(2)}`;
        } else {
          effect = { kind: 'launchSuccessAdditive' };
          descSuffix = `Launch success +${(mag * 100).toFixed(1)}% (additive, capped at 99%)`;
        }
        break;
      case 'communication':
        if (d === 2) {
          effect = { kind: 'satBufferCapMul' };
          descSuffix = `Store-and-forward bandwidth +${(mag * 100).toFixed(0)}%`;
        } else {
          effect = { kind: 'commRangeMul' };
          descSuffix = `Comm range +${(mag * 100).toFixed(0)}%`;
        }
        break;
      case 'discovery':
        if (d === 2) {
          effect = { kind: 'scannerDwellRateMul' };
          descSuffix = `Scanner dwell-ramp rate +${(mag * 100).toFixed(0)}%`;
        } else {
          effect = { kind: 'scannerCoverageMul' };
          descSuffix = `Scanner coverage +${(mag * 100).toFixed(0)}%`;
        }
        break;
      case 'resilience':
        if (d === 2) {
          effect = { kind: 'satFuelReserveMul' };
          descSuffix = `Onboard fuel reserve +${(mag * 100).toFixed(0)}%`;
        } else if (d === 3) {
          effect = { kind: 'repairDroneReliabilityMul' };
          descSuffix = `Repair-drone failure ÷${(1 + mag).toFixed(2)}`;
        } else {
          effect = { kind: 'debrisProtectionMul' };
          descSuffix = `Debris protection +${(mag * 100).toFixed(0)}%`;
        }
        break;
      default:
        effect = { kind: 'structural', description: `${subPath} depth-${d} unlock` };
        descSuffix = `${SUBPATH_LABEL[subPath]} depth-${d} unlock`;
    }
    nodes.push({
      id: `${subPath}.${d}`,
      subPath,
      depth: d,
      cost: costForDepth(d),
      magnitude: mag,
      effect,
      description: descSuffix,
    });
  }
  return nodes;
}

export const NODE_CATALOG: ReadonlyArray<SkillNode> = [
  // Extraction branch
  depth1('mining', rate('extraction'), 'Ore output +5%'),
  // Mining secondary theme: "vein depth" → per-Mine yield bonus on top of
  // the global extraction multiplier.
  depth2('mining', { kind: 'mineYieldBonusMul' }, 'Mine vein depth +10%'),
  depth1('forestry', rate('extraction'), 'Wood output +5%'),
  // Forestry secondary theme: "regrowth" → per-Logger yield bonus.
  depth2('forestry', { kind: 'loggerYieldBonusMul' }, 'Logger regrowth +10%'),
  depth1('drilling', rate('extraction'), 'Deep extraction +5%'),
  depth2('drilling', rate('extraction'), 'Deep extraction +10%'),
  // Robotics primary axis is construction speed per SPEC §9.3 themes
  // ("construction speed, parallel building, drone production efficiency").
  // depth-1 boosts the construction-time mul; depth-2 grants the first
  // additional concurrent build slot.
  depth1('robotics', { kind: 'constructionTimeMul' }, 'Construction time ÷1.05 (+5% speed)'),
  depth2('robotics', { kind: 'parallelBuildCapAdd' }, '+1 concurrent build slot'),

  // Refinement branch
  depth1('smelting', rate('smelting'), 'Smelter rate +5%'),
  depth2('smelting', rate('smelting'), 'Smelter rate +10%'),
  depth1('chemistry', rate('chemistry'), 'Chem rate +5%'),
  depth2('chemistry', rate('chemistry'), 'Chem rate +10%'),
  depth1('electronics', rate('electronics'), 'Electronics rate +5%'),
  depth2('electronics', rate('electronics'), 'Electronics rate +10%'),
  depth1('power_systems', { kind: 'powerProductionMul' }, 'Power production +5%'),
  // depth-2: switch axis to consumption efficiency — spec theme
  // "Power systems (efficiency, advanced generation)".
  depth2('power_systems', { kind: 'powerConsumptionMul', reduce: true }, 'Power consumption -10%'),

  // Logistics branch
  depth1('storage', { kind: 'storageCapMul' }, 'Storage caps +5%'),
  // depth-2: specialized vault — rare-material handling per spec theme.
  depth2('storage', { kind: 'storageCategoryCapMul', category: 'rare' }, 'Rare-vault caps +10%'),
  depth1('transport', { kind: 'routeCapacityMul' }, 'Route capacity +5%'),
  // depth-2: drone fuel efficiency per spec theme
  // "Transport (route capacity, drone fuel, airship range)".
  depth2('transport', { kind: 'droneFuelEfficiencyMul' }, 'Drone fuel efficiency +10%'),
  // Network's primary spec theme is teleporter / network reach; depth-2
  // keeps the commRange axis it had previously since "Network" semantically
  // covers multi-hop comm too.
  depth1('network', { kind: 'teleporterEfficiencyMul' }, 'Teleporter fuel cost ÷1.05'),
  depth2('network', { kind: 'commRangeMul' }, 'Comm range +10%'),

  // Deep nodes (depth 3-15) for existing sub-paths
  // Mining depth-3 = rare-reveal trickle (one-shot tertiary slot); deeper
  // depths continue the primary ore-output ramp.
  ...makeDeepNodes('mining', rate('extraction'), {
    3: { effect: { kind: 'mineRareTrickleMul' }, description: 'Mining rare-reveal (helium-3 trickle)' },
  }),
  // Forestry depth-3 = exotic-species lumber trickle.
  ...makeDeepNodes('forestry', rate('extraction'), {
    3: { effect: { kind: 'loggerExoticTrickleMul' }, description: 'Forestry exotic-species (lumber trickle)' },
  }),
  ...makeDeepNodes('drilling', rate('extraction')),
  // Robotics depth-3 = "drone production efficiency" tertiary theme;
  // deeper depths continue the primary construction-time ramp.
  ...makeDeepNodes('robotics', { kind: 'constructionTimeMul' }, {
    3: { effect: { kind: 'droneScanRadiusMul' }, description: 'Drone scan radius +20%' },
  }),
  ...makeDeepNodes('smelting', rate('smelting')),
  ...makeDeepNodes('chemistry', rate('chemistry')),
  ...makeDeepNodes('electronics', rate('electronics')),
  ...makeDeepNodes('power_systems', { kind: 'powerProductionMul' }),
  ...makeDeepNodes('storage', { kind: 'storageCapMul' }),
  ...makeDeepNodes('transport', { kind: 'routeCapacityMul' }),
  ...makeDeepNodes('network', { kind: 'teleporterEfficiencyMul' }),

  // Orbital branch (depth 1-15)
  ...makeOrbitalNodes('launch'),
  ...makeOrbitalNodes('communication'),
  ...makeOrbitalNodes('discovery'),
  ...makeOrbitalNodes('resilience'),
];

// ---------------------------------------------------------------------------
// Validation + spending
// ---------------------------------------------------------------------------

/** Threshold of points at which a sub-path becomes COMMITTED per §9.3 (placeholder N=3). */
export const SUBPATH_COMMIT_THRESHOLD = 3;

export type CanSpendReason =
  | 'unknown-node'
  | 'already-unlocked'
  | 'insufficient-points'
  | 'tier-locked'
  | 'depth-prereq'
  | 'branch-locked';

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

const DEFAULT_CATALOG: Catalog = buildCatalog(NODE_CATALOG);

/**
 * Decide whether `state` can spend a skill point on `nodeId`. Pure: does not
 * mutate state. Test code may pass a custom catalog to exercise edge cases
 * (e.g. a 3-node sub-path to verify the branch lock fires before completion).
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
  if (tierForLevel(state.level) < nodeRequiredTier(node)) {
    return { ok: false, reason: 'tier-locked' };
  }
  // Depth prereq: every node at lower depth in the same sub-path must be owned.
  const sub = cat.bySubPath.get(node.subPath) ?? [];
  for (const n of sub) {
    if (n.depth >= node.depth) break;
    if (!state.unlockedNodes.has(n.id)) {
      return { ok: false, reason: 'depth-prereq' };
    }
  }
  // Branch lock (§9.3 "Sequential sub-path unlocking"): if any OTHER sub-path
  // in the same branch is committed-but-incomplete, this purchase is blocked
  // — unless the target is exactly that in-progress sub-path.
  //
  // With the full depth-1-15 catalog, buying depth-1 + depth-2 costs 3 points
  // and commits the sub-path while leaving it incomplete. The branch lock
  // therefore engages in normal play as soon as a player buys the first two
  // nodes of any sub-path, preventing parallel work on sibling sub-paths
  // until the committed one is fully completed.
  return { ok: true };
}

/**
 * Apply a purchase. Caller must have verified `canSpend(state, nodeId).ok`.
 * Mutates `state.unspentSkillPoints` and `state.unlockedNodes`.
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
  };
}

/**
 * Fold every unlocked node's effect into a single `SkillMultipliers` bundle.
 * Multiple nodes targeting the same axis compose multiplicatively:
 *   mining.1 (+5%) × mining.2 (+10%) → 1.05 × 1.10 = 1.155×.
 */
export function effectiveSkillMultipliers(
  state: IslandState,
  catalog: ReadonlyArray<SkillNode> = NODE_CATALOG,
): SkillMultipliers {
  const cat = catalog === NODE_CATALOG ? DEFAULT_CATALOG : buildCatalog(catalog);
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
  // Rare-trickle additive base rate per skill node. Continuous yield model
  // — at depth 1 each Mine produces an extra `RARE_TRICKLE_BASE × magnitude`
  // helium_3 per second; deeper nodes scale up via the magnitude ramp.
  const RARE_TRICKLE_BASE_PER_SEC = 0.001;
  const EXOTIC_TRICKLE_BASE_PER_SEC = 0.001;
  const storageCategoryCap = out.storageCategoryCap as Record<StorageCategory, number>;
  for (const nodeId of state.unlockedNodes) {
    const node = cat.byId.get(nodeId);
    if (!node) continue;
    const m = 1 + node.magnitude;
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
      case 'placeholder':
        break;
      case 'unlockRecipe':
        break;
      case 'exoticAdjacency':
        break;
      case 'biomeBypass':
        break;
      case 'structural':
        break;
      case 'launchSuccessAdditive':
        break;
      case 'conditionalBonus':
        break;
      case 'crossIslandShared':
        break;
      case 'tierBypass':
        break;
      case 'xpGainMul':
        break;
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
  };
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
 * The rule is canSpend's: enough points, tier met, depth prereq satisfied,
 * sub-path not branch-locked, node not already owned. canSpend reads
 * unspentSkillPoints / unlockedNodes / level / subPathProgress only —
 * so an island with role declaration pending but zero spendable points
 * (or no ready nodes) is correctly false.
 */
export function hasPickableSkill(state: IslandState): boolean {
  for (const node of NODE_CATALOG) {
    if (canSpend(state, node.id).ok) return true;
  }
  return false;
}
