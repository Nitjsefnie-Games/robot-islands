// Per-island skill tree per SPEC §9.3. Pure logic — no PixiJS, no DOM.
//
// Four branches × sub-paths × depth-graded nodes. Players spend skill points
// (granted on level-up, §9.1) to unlock nodes, which compose multiplicatively
// into rate, cap, and power multipliers consumed by `computeRates` in
// `economy.ts`.
//
// The catalog now implements depth 1-15 for all sub-paths (11 legacy + 4
// Orbital = 15 sub-paths × 15 depths = 225 nodes total). Depth 6+ nodes use
// `structural` placeholder effects pending future mechanic implementation.
//
// Several depth-1 effects are `placeholder` because step 5 has no economic
// surface to express them yet: Robotics (construction speed; placement
// isn't built), Transport (route capacity; routes aren't built), Network
// (teleporter; STILL-DEFERRED). They consume points and unlock their depth-2
// successors normally; their `kind: 'placeholder'` effect is a no-op in
// `effectiveSkillMultipliers`. Later steps activate them.

import type { BuildingDefId } from './building-defs.js';
import type { IslandState } from './economy.js';
import type { RecipeCategory } from './recipes.js';
import { ALL_RECIPE_CATEGORIES } from './recipes.js';
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
  | { readonly kind: 'launchSuccessAdditive' };

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
  return spec.buildings.some((b) => b.defId === 'spaceport');
}

/** Tier required to purchase a node at the given depth per §9.3. */
export function tierRequiredForDepth(depth: number): Tier {
  if (depth >= 8) return 6;
  if (depth >= 5) return 5;
  if (depth >= 4) return 4;
  if (depth >= 3) return 3;
  return 2;
}

export function costForDepth(depth: number): number {
  return 2 ** (depth - 1);
}

export function magnitudeForDepth(depth: number): number {
  if (depth <= 5) {
    return 0.05 * (2 ** (depth - 1));
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

function makeDeepNodes(subPath: SubPathId, baseEffect: SkillEffect): SkillNode[] {
  const nodes: SkillNode[] = [];
  for (let d = 3; d <= 15; d++) {
    const cost = costForDepth(d);
    const mag = magnitudeForDepth(d);
    if (mag > 0) {
      nodes.push({
        id: `${subPath}.${d}`,
        subPath,
        depth: d,
        cost,
        magnitude: mag,
        effect: baseEffect,
        description: `${SUBPATH_LABEL[subPath]} +${(mag * 100).toFixed(0)}%`,
      });
    } else {
      nodes.push({
        id: `${subPath}.${d}`,
        subPath,
        depth: d,
        cost,
        magnitude: 0,
        effect: { kind: 'structural', description: `${subPath} unique unlock (depth ${d})` },
        description: `${SUBPATH_LABEL[subPath]} unique unlock (depth ${d})`,
      });
    }
  }
  return nodes;
}

function makeOrbitalNodes(subPath: SubPathId): SkillNode[] {
  const nodes: SkillNode[] = [];
  for (let d = 1; d <= 15; d++) {
    // Launch sub-path: depth-doubled additive launch-success bonus per
    // §14.7. Other Orbital sub-paths remain structural placeholders for
    // now (wiring STILL-DEFERRED to comm / scanner / resilience polish).
    const isLaunch = subPath === 'launch';
    const effect: SkillEffect = isLaunch
      ? { kind: 'launchSuccessAdditive' }
      : { kind: 'structural', description: `${subPath} depth-${d} unlock` };
    const mag = isLaunch ? magnitudeForDepth(d) : 0;
    nodes.push({
      id: `${subPath}.${d}`,
      subPath,
      depth: d,
      cost: costForDepth(d),
      magnitude: mag,
      effect,
      description: isLaunch
        ? `Launch success +${(mag * 100).toFixed(1)}% (additive, capped at 99%)`
        : `${SUBPATH_LABEL[subPath]} depth-${d} unlock`,
    });
  }
  return nodes;
}

export const NODE_CATALOG: ReadonlyArray<SkillNode> = [
  // Extraction branch
  depth1('mining', rate('extraction'), 'Ore output +5%'),
  depth2('mining', rate('extraction'), 'Ore output +10%'),
  depth1('forestry', rate('extraction'), 'Wood output +5% (latent — Logger pending)'),
  depth2('forestry', rate('extraction'), 'Wood output +10% (latent — Logger pending)'),
  depth1('drilling', rate('extraction'), 'Deep extraction +5% (latent — Drilling Rig pending)'),
  depth2('drilling', rate('extraction'), 'Deep extraction +10% (latent — Drilling Rig pending)'),
  depth1('robotics', { kind: 'placeholder' }, 'Construction speed +5% (placement pending)'),
  depth2('robotics', { kind: 'placeholder' }, 'Construction speed +10% (placement pending)'),

  // Refinement branch
  depth1('smelting', rate('smelting'), 'Smelter rate +5% (latent — Smelter pending)'),
  depth2('smelting', rate('smelting'), 'Smelter rate +10% (latent — Smelter pending)'),
  depth1('chemistry', rate('chemistry'), 'Chem rate +5% (latent — Reactor pending)'),
  depth2('chemistry', rate('chemistry'), 'Chem rate +10% (latent — Reactor pending)'),
  depth1('electronics', rate('electronics'), 'Electronics rate +5% (latent)'),
  depth2('electronics', rate('electronics'), 'Electronics rate +10% (latent)'),
  depth1('power_systems', { kind: 'powerProductionMul' }, 'Power production +5%'),
  depth2('power_systems', { kind: 'powerProductionMul' }, 'Power production +10%'),

  // Logistics branch
  depth1('storage', { kind: 'storageCapMul' }, 'Storage caps +5%'),
  depth2('storage', { kind: 'storageCapMul' }, 'Storage caps +10%'),
  depth1('transport', { kind: 'placeholder' }, 'Route capacity +5% (routes pending)'),
  depth2('transport', { kind: 'placeholder' }, 'Route capacity +10% (routes pending)'),
  depth1('network', { kind: 'placeholder' }, 'Network reach +5% (teleporters pending)'),
  depth2('network', { kind: 'placeholder' }, 'Network reach +10% (teleporters pending)'),

  // Deep nodes (depth 3-15) for existing sub-paths
  ...makeDeepNodes('mining', rate('extraction')),
  ...makeDeepNodes('forestry', rate('extraction')),
  ...makeDeepNodes('drilling', rate('extraction')),
  ...makeDeepNodes('robotics', { kind: 'placeholder' }),
  ...makeDeepNodes('smelting', rate('smelting')),
  ...makeDeepNodes('chemistry', rate('chemistry')),
  ...makeDeepNodes('electronics', rate('electronics')),
  ...makeDeepNodes('power_systems', { kind: 'powerProductionMul' }),
  ...makeDeepNodes('storage', { kind: 'storageCapMul' }),
  ...makeDeepNodes('transport', { kind: 'placeholder' }),
  ...makeDeepNodes('network', { kind: 'placeholder' }),

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
  const targetBranch = SUBPATH_BRANCH[node.subPath];
  for (const [sp, progress] of state.subPathProgress) {
    if (sp === node.subPath) continue;
    if (SUBPATH_BRANCH[sp] !== targetBranch) continue;
    if (progress.complete) continue;
    if (progress.spent >= SUBPATH_COMMIT_THRESHOLD) {
      return { ok: false, reason: 'branch-locked' };
    }
  }
  return { ok: true };
}

/**
 * Apply a purchase. Caller must have verified `canSpend(state, nodeId).ok`.
 * Mutates `state.unspentSkillPoints`, `state.unlockedNodes`, and
 * `state.subPathProgress`.
 *
 * Sub-path completion semantics: a sub-path is `complete` when every node in
 * the catalog belonging to that sub-path has been unlocked. With the full
 * depth-1-15 catalog, "complete" means all 15 nodes owned. A sub-path that
 * was "complete" at one node-catalog version may revert to "in-progress" if
 * new nodes are added — that's by design.
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
  const sub = cat.bySubPath.get(node.subPath) ?? [];
  const prev = state.subPathProgress.get(node.subPath) ?? { spent: 0, complete: false };
  const nextSpent = prev.spent + node.cost;
  const allOwned = sub.every((n) => state.unlockedNodes.has(n.id));
  state.subPathProgress.set(node.subPath, { spent: nextSpent, complete: allOwned });
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
}

function blankMultipliers(): SkillMultipliers {
  const recipeRate = {} as Record<RecipeCategory, number>;
  for (const c of ALL_RECIPE_CATEGORIES) recipeRate[c] = 1;
  return {
    recipeRate,
    storageCap: 1,
    powerProduction: 1,
    powerConsumption: 1,
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
    }
  }
  return {
    recipeRate,
    storageCap,
    powerProduction,
    powerConsumption,
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
