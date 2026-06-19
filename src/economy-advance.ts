// src/economy-advance.ts
//
// PURE economy-advance orchestration (NO pixi.js / render-layer imports — the
// authoritative server typecheck- and runtime-imports this module cross-
// workspace). This is the single source of truth for ONE full economy advance
// of a world: it builds every island's RatesContext (modifier multipliers, NC
// buff, active-play bonus, terrain closure, lattice/shared-network pooling
// overrides, cross-island adjacency, cable-component brownout, geothermal,
// Mirror-Sat solar boost, world, worldSeed) and runs the grouped lattice /
// grouped shared-network / per-island advance loop EXACTLY as the client did
// inline in main.ts's `advanceEconomy`.
//
// The render-side terrain-shot rebuild is the ONLY side effect that leaves the
// pure layer: it is exposed through the optional `hooks.onTerrainShotFire`
// callback. When no hook is supplied (server), terrain-shot resolution STILL
// mutates state via `resolveShot` — only the render rebuild is skipped.
//
// Render/HUD bookkeeping (rebuildWorldLayers, lastIslandCtx, islandNets,
// islandPower, lastNcState, the post-advance HUD computeRates pass) stays in
// main.ts. To let the client repaint panels without recomputing the per-tick
// precompute, this function RETURNS the per-island snapshot RatesContext it
// built (the same object the inspector/HUD reads) plus the NC state.

import {
  advanceIsland,
  type IslandState,
  type RatesContext,
} from './economy.js';
import { effectiveModifierMultipliers, type ModifierMultipliers } from './biomes.js';
import { activeBonusMul } from './active-bonus.js';
import { tierForLevel } from './skilltree.js';
import { computeNcState, type NetworkConsciousnessState } from './network-consciousness.js';
import { computeSharedNetworkState } from './network.js';
import {
  computeLatticeActive,
  crossIslandNeighbors,
  latticeInventory,
  latticeStorageCaps,
} from './lattice.js';
import { advanceLatticeGroup } from './lattice-advance.js';
import { advanceSharedNetworkGroup, sharedResourceSet } from './shared-network-advance.js';
import { computeCableNetworkBalance } from './routes.js';
import { effectiveSolarBoostFor } from './orbital.js';
import { resolveShot } from './terrain-modifier.js';
import { islandInscribedAny } from './island.js';
import type { ResourceId } from './recipes.js';
import type { PlacedBuilding } from './buildings.js';
import type { IslandSpec, WorldState } from './world.js';

/** Render-side side-effect hooks. Optional — the server passes none, so the
 *  terrain-shot resolution still mutates state but skips the render rebuild. */
export interface EconomyAdvanceHooks {
  /** Invoked when a terrain modifier's shot resolves during the advance, AFTER
   *  `resolveShot` has mutated state. The client uses this to flag a
   *  `rebuildWorldLayers()`; the server omits it (no render layer). */
  readonly onTerrainShotFire?: (islandId: string, buildingId: string) => void;
}

/** What one advance returns so callers can repaint HUD/inspector panels from
 *  the same per-island ctx the advance used (no recompute of the precompute). */
export interface EconomyAdvanceResult {
  /** Network Consciousness state computed this tick (client keeps it for HUD). */
  readonly ncState: NetworkConsciousnessState;
  /** Per-island snapshot RatesContext — the SAME shape main.ts's
   *  `buildIslandRatesContext()` produced (WITHOUT worldSeed / onTerrainShotFire,
   *  which are advance-only). Keyed by island id. The inspector/HUD reads these. */
  readonly islandCtx: Map<string, RatesContext>;
}

/**
 * Advance the entire world economy to `now` (perf clock) / `nowWall` (wall
 * clock) as ONE coherent tick: NC buff, lattice activation + unified pooling,
 * cross-island adjacency, cable-network brownout, Mirror-Sat solar, active-play
 * bonus, geothermal, and per-island modifier multipliers all feed the integrator.
 *
 * Grouped paths (mass-conserving): active-lattice members advance together via
 * `advanceLatticeGroup`; non-lattice cross-island shared-network participants
 * advance together via `advanceSharedNetworkGroup`. Every other island advances
 * per-island via `advanceIsland`. This mirrors main.ts's inline orchestration
 * byte-for-byte; the server now shares the identical path instead of calling
 * `advanceIsland(state, now)` with no ctx.
 */
export function advanceWorldEconomy(
  world: WorldState,
  islandStates: Map<string, IslandState>,
  now: number,
  nowWall: number,
  hooks?: EconomyAdvanceHooks,
): EconomyAdvanceResult {
  // Rebuild the id→spec lookup from the live world (main.ts keeps a cached
  // `islandSpecsById`; here we derive it so the module owns no external state).
  const islandSpecsById = new Map<string, IslandSpec>();
  for (const s of world.islands) islandSpecsById.set(s.id, s);

  // §7.4 single global atmosphere — one shared holder seeded from the world
  // total, threaded into every per-island advance, written back after the loop.
  // (Grouped lattice / shared-network members are CO₂-inert today and are NOT
  // given the holder; only the per-island advanceIsland path carries it.)
  const co2Pool = { kg: world.totalCo2Kg };

  // Per-island modifier multipliers, cached for the duration of this tick.
  const modifierMulCache = new Map<string, ModifierMultipliers>();
  const modifierMulFor = (id: string): ModifierMultipliers => {
    const cached = modifierMulCache.get(id);
    if (cached) return cached;
    const spec = islandSpecsById.get(id);
    const mul = effectiveModifierMultipliers(spec ? spec.modifiers : []);
    modifierMulCache.set(id, mul);
    return mul;
  };

  // §9.6 Network Consciousness buff — applies only to T3+ islands; per-island
  // gating happens here (not inside advanceIsland) so the pure economy doesn't
  // take a dependency on tierForLevel.
  const ncState = computeNcState(world);
  const ncBuffFor = (s: IslandState): number =>
    tierForLevel(s.level) >= 3 ? ncState.globalProductionBuff : 1;

  // §13.3 Omniscient Lattice activation (evaluated against the current node set),
  // then the unified inventory/caps and cross-island adjacency it threads.
  computeLatticeActive(world);
  const unifiedInv = latticeInventory(world);
  const unifiedCaps = latticeStorageCaps(world);
  const crossIslandById = new Map<string, PlacedBuilding[]>();
  if (world.latticeActive) {
    for (const id of world.latticeNodeIslands) {
      const neighbors = crossIslandNeighbors(world, id);
      if (neighbors) crossIslandById.set(id, neighbors);
    }
  }

  // §14.3 Mirror Sat: per-island aggregate solar boost, once per tick.
  const solarBoostByIsland = new Map<string, number>();
  for (const spec of world.islands) {
    if (!spec.populated) continue;
    solarBoostByIsland.set(
      spec.id,
      effectiveSolarBoostFor(world, { x: spec.cx, y: spec.cy }),
    );
  }

  // §5.3 cable network: per-component binary-gated balance, once per tick. The
  // local ctx builder reuses the same modifiers/NC/active-bonus/solar the
  // advance loop sees so the gate decision matches the integrator.
  const cableLocalCtxFor = (id: string): RatesContext => {
    const spec = islandSpecsById.get(id);
    const isLatticeIsland = unifiedInv !== undefined && world.latticeNodeIslands.includes(id);
    const stForCtx = islandStates.get(id);
    return {
      modifierMul: modifierMulFor(id),
      ncBuff: stForCtx ? ncBuffFor(stForCtx) : undefined,
      activeBonusMul: activeBonusMul(world),
      terrainAt: spec?.terrainAt,
      inventory: isLatticeIsland ? unifiedInv : undefined,
      crossIsland: crossIslandById.get(id),
      caps: isLatticeIsland ? unifiedCaps : undefined,
      geothermalActive: spec?.modifiers.includes('geothermal_active') === true,
      solarBoost: solarBoostByIsland.get(id),
    };
  };
  const cableBalances = computeCableNetworkBalance(world, islandStates, cableLocalCtxFor, now, nowWall);
  const sharedNetwork = computeSharedNetworkState(world);

  // §13.3 D-01 lattice grouped lockstep + D-02 shared-network grouped lockstep.
  const latticeActive = unifiedInv !== undefined;
  const isLatticeMember = (id: string): boolean =>
    latticeActive && world.latticeNodeIslands.includes(id);

  // Base RatesContext for a grouped (lattice OR shared-network) member —
  // WITHOUT the pooled inventory/caps/flowSiblings (injected by the group
  // advance). Carries per-island modifiers, terrain, cross-island adjacency,
  // cable component, solar boost, world, worldSeed, and the terrain-shot
  // callback so grouped members get identical side effects to a solo advance.
  const groupedMemberBaseCtx = (s: IslandState): RatesContext => {
    const spec = islandSpecsById.get(s.id);
    const inscribedFor = spec
      ? (lx: number, ly: number) => islandInscribedAny(spec, lx, ly)
      : () => false;
    return {
      modifierMul: modifierMulFor(s.id),
      ncBuff: ncBuffFor(s),
      activeBonusMul: activeBonusMul(world),
      terrainAt: spec?.terrainAt,
      crossIsland: crossIslandById.get(s.id),
      cableComponent: cableBalances.get(s.id),
      geothermalActive: spec?.modifiers.includes('geothermal_active') === true,
      solarBoost: solarBoostByIsland.get(s.id),
      world,
      worldSeed: world.seed,
      onTerrainShotFire: (buildingId) => {
        const modifier = s.buildings.find((b) => b.id === buildingId);
        if (!modifier) return;
        if (spec) resolveShot(spec, s, modifier, inscribedFor);
        hooks?.onTerrainShotFire?.(s.id, buildingId);
      },
    };
  };

  // Advance the active-lattice member group as a unit (mass-conserving).
  if (latticeActive) {
    const memberStates: IslandState[] = [];
    for (const id of world.latticeNodeIslands) {
      const st = islandStates.get(id);
      if (st) memberStates.push(st);
    }
    if (memberStates.length > 0) {
      advanceLatticeGroup(memberStates, now, groupedMemberBaseCtx, nowWall);
    }
  }

  // D-02: advance the non-lattice cross-island shared-network participant group
  // as ONE net-flow problem, pooling ONLY the shared-resource subset.
  const sharedSet = sharedResourceSet(sharedNetwork);
  if (sharedSet.size > 0) {
    const participantStates: IslandState[] = [];
    for (const id of sharedNetwork.participantIds) {
      if (isLatticeMember(id)) continue; // lattice path owns these
      const st = islandStates.get(id);
      if (st) participantStates.push(st);
    }
    if (participantStates.length > 0) {
      advanceSharedNetworkGroup(
        participantStates,
        now,
        groupedMemberBaseCtx,
        sharedSet,
        sharedNetwork.sharedStorageCap,
        sharedNetwork.inventoryHolders,
        nowWall,
      );
    }
  }

  const islandCtx = new Map<string, RatesContext>();
  for (const s of islandStates.values()) {
    const spec = islandSpecsById.get(s.id);
    const isLatticeIsland = isLatticeMember(s.id);
    const isNetParticipant = sharedNetwork.participantIds.has(s.id);
    const crossIsland = crossIslandById.get(s.id);
    const cableComponent = cableBalances.get(s.id);
    const geothermalActive = spec?.modifiers.includes('geothermal_active') === true;
    const inscribedFor = spec
      ? (lx: number, ly: number) => islandInscribedAny(spec, lx, ly)
      : () => false;

    // §Task-19: cross-island shared network overrides (Lattice takes precedence).
    const sharedInventory = isNetParticipant && !isLatticeIsland
      ? Object.fromEntries(sharedNetwork.sharedInventory) as Record<ResourceId, number>
      : undefined;
    const sharedCaps = isNetParticipant && !isLatticeIsland
      ? Object.fromEntries(sharedNetwork.sharedStorageCap) as Record<ResourceId, number>
      : undefined;

    // Shared RatesContext builder — one source for both the advanceIsland call
    // and the snapshot ctx so the inspector uses byte-identical fields.
    const buildIslandRatesContext = (): RatesContext => ({
      modifierMul: modifierMulFor(s.id),
      ncBuff: ncBuffFor(s),
      activeBonusMul: activeBonusMul(world),
      terrainAt: spec?.terrainAt,
      inventory: isLatticeIsland ? unifiedInv : sharedInventory,
      crossIsland,
      caps: isLatticeIsland ? unifiedCaps : sharedCaps,
      cableComponent,
      geothermalActive,
      solarBoost: solarBoostByIsland.get(s.id),
      world,
    });
    // §13.3 D-01 / D-02: grouped islands already advanced above. Only islands on
    // neither grouped path advance per-island here.
    const isSharedParticipant = isNetParticipant && !isLatticeIsland && sharedSet.size > 0;
    if (!isLatticeIsland && !isSharedParticipant) {
      advanceIsland(s, now, {
        ...buildIslandRatesContext(),
        worldSeed: world.seed,
        co2Pool,
        onTerrainShotFire: (buildingId) => {
          const modifier = s.buildings.find((b) => b.id === buildingId);
          if (!modifier) return;
          if (spec) resolveShot(spec, s, modifier, inscribedFor);
          hooks?.onTerrainShotFire?.(s.id, buildingId);
        },
      }, nowWall);
    }
    islandCtx.set(s.id, buildIslandRatesContext());
  }

  // §7.4 write the global atmosphere back once the per-island loop completes.
  world.totalCo2Kg = co2Pool.kg;

  return { ncState, islandCtx };
}
