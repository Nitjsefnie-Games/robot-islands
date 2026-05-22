import { describe, expect, it } from 'vitest';

import { BUILDING_DEFS } from './building-defs.js';
import { RECIPES } from './recipes.js';

// Resources the player holds on a fresh game — see `startingInventory()`
// in `world.ts`. Anything else must be produced or extracted.
const START_RESOURCES = ['stone', 'wood', 'foundation_kit'];

interface Recipe {
  readonly inputs: Record<string, number>;
  readonly outputs: Record<string, number>;
}

/**
 * Detect circular placement/recipe deadlocks.
 *
 * A building is "placeable" only once every resource in its `placementCost`
 * is obtainable; a recipe's outputs become obtainable once the building is
 * placeable and the recipe's inputs are obtainable. Starting from the fresh
 * inventory + raw extractors, a reachability fixpoint finds every building
 * that can never be placed. Among those, an SCC in the dependency graph —
 * restricted to edges where EVERY producer of the needed resource is itself
 * blocked — is an essential circular deadlock (e.g. silicon_crusher needs
 * microchip ← lithography_lab needs silicon ← silicon_crusher).
 *
 * Returns the list of deadlock cycles (each a sorted list of building ids).
 */
function findDeadlockCycles(): string[][] {
  const defs = BUILDING_DEFS as Record<string, { placementCost?: Record<string, number> }>;
  const recipes = RECIPES as Record<string, { inputs?: Record<string, number>; outputs?: Record<string, number> } | undefined>;
  const buildingIds = Object.keys(defs);
  const buildingIdSet = new Set(buildingIds);

  // Recipe key -> running building (longest building-id prefix; covers
  // variant keys like `mine_on_ore`).
  const ownerOf = (rk: string): string => {
    if (buildingIdSet.has(rk)) return rk;
    let best: string | null = null;
    for (const b of buildingIds) {
      if (rk.startsWith(b) && (best === null || b.length > best.length)) best = b;
    }
    return best ?? rk;
  };

  const producers = new Map<string, Set<string>>();
  const recipesByBuilding = new Map<string, Recipe[]>();
  for (const [rk, r] of Object.entries(recipes)) {
    if (!r) continue;
    const owner = ownerOf(rk);
    const rec: Recipe = { inputs: r.inputs ?? {}, outputs: r.outputs ?? {} };
    const list = recipesByBuilding.get(owner) ?? [];
    list.push(rec);
    recipesByBuilding.set(owner, list);
    for (const out of Object.keys(rec.outputs)) {
      const set = producers.get(out) ?? new Set<string>();
      set.add(owner);
      producers.set(out, set);
    }
  }

  // Reachability fixpoint.
  const obtainable = new Set<string>(START_RESOURCES);
  const placeable = new Set<string>();
  for (let changed = true; changed; ) {
    changed = false;
    for (const [b, def] of Object.entries(defs)) {
      if (placeable.has(b)) continue;
      if (Object.keys(def.placementCost ?? {}).every((r) => obtainable.has(r))) {
        placeable.add(b);
        changed = true;
      }
    }
    for (const b of placeable) {
      for (const rec of recipesByBuilding.get(b) ?? []) {
        if (Object.keys(rec.inputs).every((r) => obtainable.has(r))) {
          for (const out of Object.keys(rec.outputs)) {
            if (!obtainable.has(out)) {
              obtainable.add(out);
              changed = true;
            }
          }
        }
      }
    }
  }

  const blocked = buildingIds.filter((b) => !placeable.has(b));
  const blockedSet = new Set(blocked);

  // need(B) = placement cost ∪ recipe inputs.
  const need = new Map<string, Set<string>>();
  for (const [b, def] of Object.entries(defs)) {
    const s = new Set<string>(Object.keys(def.placementCost ?? {}));
    for (const rec of recipesByBuilding.get(b) ?? []) {
      for (const k of Object.keys(rec.inputs)) s.add(k);
    }
    need.set(b, s);
  }

  // Essential-deadlock edges: B -> C when C produces a resource B needs and
  // EVERY producer of that resource is blocked (B cannot route around it).
  const adj = new Map<string, Set<string>>();
  for (const b of buildingIds) {
    const out = new Set<string>();
    for (const r of need.get(b) ?? []) {
      const prod = [...(producers.get(r) ?? [])];
      if (prod.length > 0 && prod.every((p) => blockedSet.has(p))) {
        for (const c of prod) out.add(c);
      }
    }
    adj.set(b, out);
  }

  // Tarjan SCC over the blocked subgraph.
  let idx = 0;
  const index = new Map<string, number>();
  const low = new Map<string, number>();
  const onStack = new Set<string>();
  const stack: string[] = [];
  const cycles: string[][] = [];
  const strongconnect = (v: string): void => {
    index.set(v, idx);
    low.set(v, idx);
    idx++;
    stack.push(v);
    onStack.add(v);
    for (const w of adj.get(v) ?? []) {
      if (!blockedSet.has(w)) continue;
      if (!index.has(w)) {
        strongconnect(w);
        low.set(v, Math.min(low.get(v) ?? 0, low.get(w) ?? 0));
      } else if (onStack.has(w)) {
        low.set(v, Math.min(low.get(v) ?? 0, index.get(w) ?? 0));
      }
    }
    if ((low.get(v) ?? 0) === (index.get(v) ?? 0)) {
      const comp: string[] = [];
      let w: string;
      do {
        w = stack.pop() as string;
        onStack.delete(w);
        comp.push(w);
      } while (w !== v);
      const head = comp[0];
      if (head !== undefined && (comp.length > 1 || (adj.get(head)?.has(head) ?? false))) {
        cycles.push([...comp].sort());
      }
    }
  };
  for (const b of blocked) {
    if (!index.has(b)) strongconnect(b);
  }
  return cycles;
}

describe('building dependency graph', () => {
  it('has no circular placement/recipe deadlocks', () => {
    expect(findDeadlockCycles()).toEqual([]);
  });
});
