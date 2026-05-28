import { advanceIsland } from '../economy.js';
import { BUILDING_DEFS, type BuildingDefId } from '../building-defs.js';
import { RECIPES, type ResourceId } from '../recipes.js';
import type { IslandState } from '../economy.js';
import type { PlacedBuilding } from '../buildings.js';
import type { IslandSpec } from '../world.js';
import type { TerrainKind } from '../island.js';

export interface ReachabilityOutcome {
  reached: boolean;
  elapsedMs: number;
  placedBuildings: BuildingDefId[];
  blockedBy: BuildingDefId | null;
  blockingResource: string | null;
}

function canAfford(
  inv: Record<ResourceId, number>,
  cost: Partial<Record<ResourceId, number>> | undefined,
): boolean {
  if (!cost) return true;
  for (const [r, qty] of Object.entries(cost)) {
    if ((inv[r as ResourceId] ?? 0) < (qty ?? 0)) return false;
  }
  return true;
}

function payCost(state: IslandState, cost: Partial<Record<ResourceId, number>> | undefined): void {
  if (!cost) return;
  for (const [r, qty] of Object.entries(cost)) {
    const current = state.inventory[r as ResourceId] ?? 0;
    state.inventory[r as ResourceId] = current - (qty ?? 0);
  }
}

function limitingResource(
  inv: Record<ResourceId, number>,
  cost: Partial<Record<ResourceId, number>> | undefined,
): string | null {
  if (!cost) return null;
  for (const [r, qty] of Object.entries(cost)) {
    if ((inv[r as ResourceId] ?? 0) < (qty ?? 0)) return r;
  }
  return null;
}

function recipeOwner(recipeId: string): BuildingDefId | null {
  if (recipeId in BUILDING_DEFS) return recipeId as BuildingDefId;
  let best: string | null = null;
  for (const b of Object.keys(BUILDING_DEFS)) {
    if (recipeId.startsWith(b) && (best === null || b.length > best.length)) {
      best = b;
    }
  }
  return best as BuildingDefId | null;
}

function closurePredecessors(target: BuildingDefId): Set<ResourceId> {
  const required = new Set<ResourceId>();
  const visited = new Set<ResourceId>();
  const frontier: ResourceId[] = Object.keys(
    BUILDING_DEFS[target].placementCost ?? {},
  ) as ResourceId[];

  while (frontier.length > 0) {
    const r = frontier.pop()!;
    if (visited.has(r)) continue;
    visited.add(r);
    required.add(r);

    for (const [, recipe] of Object.entries(RECIPES)) {
      if (!recipe || !recipe.outputs || recipe.outputs[r] === undefined) continue;
      for (const input of Object.keys(recipe.inputs ?? {})) {
        if (!visited.has(input as ResourceId)) {
          frontier.push(input as ResourceId);
        }
      }
    }
  }

  return required;
}

function findProducers(resource: ResourceId): BuildingDefId[] {
  const producers: BuildingDefId[] = [];
  for (const [recipeId, recipe] of Object.entries(RECIPES)) {
    if (!recipe || !recipe.outputs || recipe.outputs[resource] === undefined) continue;
    const owner = recipeOwner(recipeId);
    if (owner && !producers.includes(owner)) {
      producers.push(owner);
    }
  }
  return producers;
}

function selectBuildingChain(required: Set<ResourceId>): BuildingDefId[] {
  const buildingSet = new Set<BuildingDefId>();

  for (const r of required) {
    const producers = findProducers(r);
    if (producers.length === 0) continue;

    const first = producers[0]!;
    let best = first;
    let bestTier = BUILDING_DEFS[first]?.tier ?? 99;
    for (let i = 1; i < producers.length; i++) {
      const p = producers[i]!;
      const tier = BUILDING_DEFS[p]?.tier ?? 99;
      if (tier < bestTier) {
        best = p;
        bestTier = tier;
      }
    }
    buildingSet.add(best);
  }

  return Array.from(buildingSet).sort((a, b) => {
    const tierA = BUILDING_DEFS[a]?.tier ?? 99;
    const tierB = BUILDING_DEFS[b]?.tier ?? 99;
    return tierA - tierB;
  });
}

let placementCounter = 0;
function freshPlacement(id: BuildingDefId): PlacedBuilding {
  const n = placementCounter++;
  return { id: `reach-${id}-${n}`, defId: id, x: n, y: 0 };
}

export function simulateOptimalPath(
  initial: IslandState,
  deadlineMs: number,
  target: BuildingDefId,
): ReachabilityOutcome {
  const required = closurePredecessors(target);
  const chain = [...selectBuildingChain(required), target];

  const state = initial;
  let elapsedMs = 0;
  const placed: BuildingDefId[] = [];
  const stepMs = 30 * 1000;

  while (elapsedMs < deadlineMs) {
    let placedThisRound = false;
    for (const id of chain) {
      if (placed.includes(id)) continue;
      if (!canAfford(state.inventory, BUILDING_DEFS[id].placementCost)) continue;
      payCost(state, BUILDING_DEFS[id].placementCost);
      state.buildings = [...state.buildings, freshPlacement(id)];
      placed.push(id);
      placedThisRound = true;
      if (id === target) {
        return {
          reached: true,
          elapsedMs,
          placedBuildings: placed,
          blockedBy: null,
          blockingResource: null,
        };
      }
    }
    if (!placedThisRound) {
      advanceIsland(state, elapsedMs + stepMs);
      elapsedMs += stepMs;
    }
  }

  const blockedBy = chain.find((id) => !placed.includes(id)) ?? null;
  return {
    reached: false,
    elapsedMs,
    placedBuildings: placed,
    blockedBy,
    blockingResource: blockedBy
      ? limitingResource(state.inventory, BUILDING_DEFS[blockedBy].placementCost)
      : null,
  };
}

export function makeHomeIslandSpecForReachabilityTest(): IslandSpec {
  const terrainMap: Record<string, TerrainKind> = {
    '0,0': 'ore',
    '1,0': 'coal',
    '2,0': 'water',
    '3,0': 'stone',
    '4,0': 'copper_vein',
    '0,1': 'clay_pit',
    '1,1': 'lead_vein',
    '2,1': 'limestone',
    '3,1': 'water',
    '4,1': 'tree',
  };

  return {
    id: 'reachability-home',
    name: 'Home',
    biome: 'plains',
    cx: 0,
    cy: 0,
    majorRadius: 4,
    minorRadius: 4,
    populated: true,
    discovered: true,
    buildings: [{ id: 'pre-wind', defId: 'wind_turbine', x: 2, y: 0 }],
    modifiers: [],
    terrainAt: (x: number, y: number) => terrainMap[`${x},${y}`] ?? 'grass',
  };
}
