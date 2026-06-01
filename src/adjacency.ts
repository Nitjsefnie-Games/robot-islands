// §4.4 / §4.5 buff- and gating-adjacency resolution.
//
// SPEC §4.4: "Adjacency is computed using 4-neighbors. For a multi-tile
// building, the adjacent set is the union of tiles bordering any cell of the
// footprint, minus the footprint itself."
//
// SPEC §4.5 (buff form): "every building gains a uniform multiplier from the
// size of its same-category 4-connected cluster: `1 + (k − 1) × rate`."
//
// Pure module — no PixiJS, no DOM. The 4-neighbor footprint walk mirrors
// `heat.ts`'s pattern (footprintKeySet → borderTiles); we keep the helpers
// local rather than exporting them from heat.ts so the two resolvers can
// evolve independently. Both compute the same set per §4.4.

import {
  BUILDING_DEFS,
  CATEGORY_ADJACENCY_RATE,
  type BuildingDef,
  type BuildingDefId,
  type GateRequirement,
} from './building-defs.js';
import type { PlacedBuilding } from './buildings.js';
import { footprintTiles, type Rotation } from './shape-mask.js';

/** All footprint tiles a building occupies, returned as a Set of "x,y" keys
 *  for O(1) membership tests during border-overlap checks. Mirrors the
 *  helper in heat.ts (kept local so the two adjacency resolvers stay
 *  independent — see module header). */
export function footprintKeySet(
  b: PlacedBuilding,
  defs: Readonly<Record<BuildingDefId, BuildingDef>>,
): Set<string> {
  const def = defs[b.defId];
  const rot = (b.rotation ?? 0) as Rotation;
  const tiles = footprintTiles(def.footprint, b.x, b.y, rot);
  const out = new Set<string>();
  for (const t of tiles) out.add(`${t.x},${t.y}`);
  return out;
}

/** 4-neighbor border tiles of a footprint, EXCLUDING tiles that are part of
 *  the footprint itself (per §4.4: "minus the footprint itself"). Required
 *  for multi-tile buildings — without the exclusion a 2×2 footprint's
 *  internal cardinal neighbors would loop back into its own cells. */
export function borderTiles(footprint: Set<string>): Set<string> {
  const border = new Set<string>();
  for (const key of footprint) {
    const [xs, ys] = key.split(',');
    const x = Number(xs);
    const y = Number(ys);
    const candidates: ReadonlyArray<readonly [number, number]> = [
      [x, y - 1],
      [x, y + 1],
      [x - 1, y],
      [x + 1, y],
    ];
    for (const [nx, ny] of candidates) {
      const nk = `${nx},${ny}`;
      if (!footprint.has(nk)) border.add(nk);
    }
  }
  return border;
}

/** True iff any tile of `other`'s footprint lies in `border`. */
export function touchesBorder(
  other: PlacedBuilding,
  border: Set<string>,
  defs: Readonly<Record<BuildingDefId, BuildingDef>>,
): boolean {
  const def = defs[other.defId];
  const rot = (other.rotation ?? 0) as Rotation;
  const tiles = footprintTiles(def.footprint, other.x, other.y, rot);
  for (const t of tiles) {
    if (border.has(`${t.x},${t.y}`)) return true;
  }
  return false;
}

/**
 * §4.5 per-building cluster-bonus multiplier. A building's *cluster* is the
 * maximal set of same-category buildings connected through 4-neighbour links
 * (the §4.4 border test). Every member of a cluster of size `k` receives the
 * same `1 + (k − 1) × CATEGORY_ADJACENCY_RATE[category]`. Connectivity only:
 * enclosed empty tiles do not break a cluster, and a different-category
 * building between two same-category buildings does not bridge them. Physical
 * same-island buildings only — the §13.3 cross-island lattice does NOT feed
 * this term. Returns 1.0 for an isolated building or a rate-0 category.
 *
 * Implemented via the batch labeller so single- and whole-island callers agree.
 */
export function clusterBonusMul(
  b: PlacedBuilding,
  buildings: ReadonlyArray<PlacedBuilding>,
  defs: Readonly<Record<BuildingDefId, BuildingDef>> = BUILDING_DEFS,
): number {
  return clusterBonusMuls(buildings, defs).get(b.id) ?? 1;
}

/**
 * Batch form: every building's cluster-bonus multiplier in one pass. Groups
 * by category, unions same-category 4-adjacent buildings (union-find), then
 * maps each building to `1 + (size − 1) × rate`. O(N²) over the building set —
 * the per-tick hot path (`economy.computeRates`) calls this ONCE per tick and
 * reads per-building values from the returned map, rather than re-deriving a
 * component per building.
 */
export function clusterBonusMuls(
  buildings: ReadonlyArray<PlacedBuilding>,
  defs: Readonly<Record<BuildingDefId, BuildingDef>> = BUILDING_DEFS,
): Map<string, number> {
  const n = buildings.length;
  const borders = buildings.map((b) => borderTiles(footprintKeySet(b, defs)));

  // Union-find over building indices.
  const parent = Array.from({ length: n }, (_, i) => i);
  const find = (i: number): number => {
    let r = i;
    while (parent[r]! !== r) r = parent[r]!;
    let cur = i;
    while (parent[cur]! !== r) {
      const next = parent[cur]!;
      parent[cur] = r;
      cur = next;
    }
    return r;
  };
  const union = (a: number, b: number): void => {
    const ra = find(a);
    const rb = find(b);
    if (ra !== rb) parent[ra] = rb;
  };

  for (let i = 0; i < n; i++) {
    const cat = defs[buildings[i]!.defId].category;
    for (let j = i + 1; j < n; j++) {
      if (defs[buildings[j]!.defId].category !== cat) continue;
      // Adjacency is symmetric — test j against i's border.
      if (touchesBorder(buildings[j]!, borders[i]!, defs)) union(i, j);
    }
  }

  const compSize = new Map<number, number>();
  for (let i = 0; i < n; i++) {
    const r = find(i);
    compSize.set(r, (compSize.get(r) ?? 0) + 1);
  }

  const out = new Map<string, number>();
  for (let i = 0; i < n; i++) {
    const b = buildings[i]!;
    const rate = CATEGORY_ADJACENCY_RATE[defs[b.defId].category] ?? 0;
    const k = compSize.get(find(i)) ?? 1;
    out.set(b.id, rate === 0 ? 1 : 1 + (k - 1) * rate);
  }
  return out;
}

/**
 * §4.5 buff-adjacency multiplier for the focal building.
 *
 * Returns `clusterBonusMul × Π(exotic-pair bonuses)`. The cluster term
 * (uniform per same-category 4-connected cluster — see `clusterBonusMul`) uses
 * physical same-island buildings only. The exotic-pair term carries the
 * skill-tree `pairBoost` rewards (`skillUnlockedAdjacencyRules`) and keeps its
 * original neighbour semantics: physical neighbours plus any `crossIsland`
 * lattice buildings. Returns 1.0 when nothing applies.
 *
 * Signature is unchanged from the previous per-def implementation so the
 * economy call site (`computeRates`) needs no edit.
 */
export function computeBuffStack(
  b: PlacedBuilding,
  buildings: ReadonlyArray<PlacedBuilding>,
  defs: Readonly<Record<BuildingDefId, BuildingDef>> = BUILDING_DEFS,
  crossIsland?: ReadonlyArray<PlacedBuilding>,
  exoticRules?: ReadonlyArray<{ readonly pair: readonly [BuildingDefId, BuildingDefId]; readonly recipeRateBonus: number }>,
  /** Precomputed cluster multiplier for `b` (from `clusterBonusMuls`). When
   *  omitted, falls back to a single `clusterBonusMul` call. */
  clusterMul?: number,
): number {
  let stack = clusterMul ?? clusterBonusMul(b, buildings, defs);
  if (exoticRules && exoticRules.length > 0) {
    const neighbors = collectNeighbors(b, buildings, defs, crossIsland);
    for (const rule of exoticRules) {
      if (b.defId === rule.pair[0] && neighbors.some((n) => n.defId === rule.pair[1])) {
        stack *= 1 + rule.recipeRateBonus;
      }
    }
  }
  return stack;
}

/** §4.5 gating adjacency result. */
export interface GateResult {
  readonly satisfied: boolean;
  readonly effectiveMul: number; // 0 if hard gate fails, degradeMul if soft
}

/**
 * §4.5 gating adjacency resolution.
 *
 * Walks the focal building's 4-neighbor footprint border to identify
 * distinct neighboring buildings, then evaluates each `GateRequirement`
 * on the focal def. A hard gate with insufficient matches returns
 * `{ satisfied: false, effectiveMul: 0 }` immediately. Soft gates
 * accumulate the minimum `degradeMul` across all unmet requirements.
 */
export function collectNeighbors(
  building: PlacedBuilding,
  all: ReadonlyArray<PlacedBuilding>,
  defs: Readonly<Record<BuildingDefId, BuildingDef>> = BUILDING_DEFS,
  crossIsland?: ReadonlyArray<PlacedBuilding>,
): PlacedBuilding[] {
  const fp = footprintKeySet(building, defs);
  const border = borderTiles(fp);
  const neighbors: PlacedBuilding[] = [];
  const seen = new Set<string>();
  for (const other of all) {
    if (other.id === building.id) continue;
    if (seen.has(other.id)) continue;
    if (!touchesBorder(other, border, defs)) continue;
    seen.add(other.id);
    neighbors.push(other);
  }
  // §13.3 Omniscient Lattice: cross-island buildings count as neighbors
  // despite physical distance.
  if (crossIsland) {
    for (const other of crossIsland) {
      if (other.id === building.id) continue;
      if (seen.has(other.id)) continue;
      seen.add(other.id);
      neighbors.push(other);
    }
  }
  return neighbors;
}

export function gateSatisfied(
  building: PlacedBuilding,
  gate: GateRequirement,
  all: ReadonlyArray<PlacedBuilding>,
  defs: Readonly<Record<BuildingDefId, BuildingDef>> = BUILDING_DEFS,
  geothermalActive: boolean = false,
  crossIsland?: ReadonlyArray<PlacedBuilding>,
): boolean {
  const def = defs[building.defId];
  if (!def) return true;
  if (geothermalActive && gate.matchType === 'heat_source') return true;
  const neighbors = collectNeighbors(building, all, defs, crossIsland);
  let matches = 0;
  for (const n of neighbors) {
    const nd = defs[n.defId];
    if (!nd) continue;
    if (matchesGate(nd, gate, building.defId)) matches++;
  }
  return matches >= (gate.minCount ?? 1);
}

export function checkGates(
  building: PlacedBuilding,
  all: ReadonlyArray<PlacedBuilding>,
  defs: Readonly<Record<BuildingDefId, BuildingDef>> = BUILDING_DEFS,
  geothermalActive: boolean = false,
  crossIsland?: ReadonlyArray<PlacedBuilding>,
): GateResult {
  const def = defs[building.defId];
  if (!def.gates || def.gates.length === 0) {
    return { satisfied: true, effectiveMul: 1 };
  }

  const neighbors = collectNeighbors(building, all, defs, crossIsland);

  let minMul = 1;
  for (const gate of def.gates) {
    if (geothermalActive && gate.matchType === 'heat_source') continue;
    let matches = 0;
    for (const n of neighbors) {
      const nd = defs[n.defId];
      if (!nd) continue;
      if (matchesGate(nd, gate, building.defId)) matches++;
    }
    const needed = gate.minCount ?? 1;
    if (matches < needed) {
      if (gate.hard) return { satisfied: false, effectiveMul: 0 };
      minMul = Math.min(minMul, gate.degradeMul ?? 0.5);
    }
  }
  return { satisfied: minMul >= 1, effectiveMul: minMul };
}

export function matchesGate(nd: BuildingDef, gate: GateRequirement, focalDefId: BuildingDefId): boolean {
  switch (gate.matchType) {
    case 'same_def':
      return nd.id === focalDefId;
    case 'same_category':
      return nd.category === gate.category;
    case 'def_id':
      return nd.id === gate.defId;
    case 'heat_source':
      return !!nd.heatSource;
  }
  return false;
}
