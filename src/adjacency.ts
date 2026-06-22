// §4.4 / §4.5 buff- and gating-adjacency resolution.
//
// SPEC §4.4: "Adjacency is computed using 4-neighbors. For a multi-tile
// building, the adjacent set is the union of tiles bordering any cell of the
// footprint, minus the footprint itself."
//
// SPEC §4.5 (buff form): "every building gains a multiplier from the
// floor-capacity of the REST of its same-category 4-connected cluster:
// `1 + rate × (K − c_i)`, c = 1 + floorLevel, K = Σ c over the cluster."
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
import { CELL_SIZE_TILES } from './constants.js';
import { activeFloorLevel, type PlacedBuilding } from './buildings.js';
import { footprintTiles, type Rotation } from './shape-mask.js';

/**
 * The actual world tiles a building occupies for adjacency purposes.
 *
 * For land buildings this is just `footprintTiles` (footprint units == tiles).
 *
 * **Ocean platforms (`oceanPlacement: true`) reserve whole stratification
 * CELLS**, not single tiles: their `footprint` dims are cell-units and `b.x/b.y`
 * are tile coords offset by whole cells (`cellIdx × CELL_SIZE_TILES`), so
 * `footprintTiles` alone would return a tiny 1-tile-per-cell footprint sitting
 * in the corner of the first cell — leaving two platforms in physically
 * adjacent ocean cells ~CELL_SIZE_TILES tiles apart and never 4-connected. That
 * is the §4.5 ocean-cluster bug: ocean extractors never earned the per-category
 * cluster bonus. Expanding each footprint cell to its full CELL_SIZE_TILES tile
 * block makes the existing tile-space 4-adjacency test capture CELL adjacency,
 * so platforms in touching cells cluster exactly like adjacent land buildings.
 * This matches what an ocean platform reserves and renders (`renderBuildings`
 * draws `shapeWidth × CELL_SIZE_TILES` per cell) and what `findOceanBuildingAt`
 * hit-tests, so the three views of an ocean footprint finally agree.
 */
function adjacencyFootprintTiles(
  b: PlacedBuilding,
  defs: Readonly<Record<BuildingDefId, BuildingDef>>,
): ReadonlyArray<{ readonly x: number; readonly y: number }> {
  const def = defs[b.defId];
  const rot = (b.rotation ?? 0) as Rotation;
  const cells = footprintTiles(def.footprint, b.x, b.y, rot);
  if (def.oceanPlacement !== true) return cells;
  const out: { x: number; y: number }[] = [];
  for (const c of cells) {
    // `c.x − b.x` / `c.y − b.y` are the normalized cell offsets (0,1,2,…); each
    // footprint unit is one CELL_SIZE_TILES-wide cell at `b.x + offset × CELL`.
    const baseX = b.x + (c.x - b.x) * CELL_SIZE_TILES;
    const baseY = b.y + (c.y - b.y) * CELL_SIZE_TILES;
    for (let dx = 0; dx < CELL_SIZE_TILES; dx++) {
      for (let dy = 0; dy < CELL_SIZE_TILES; dy++) {
        out.push({ x: baseX + dx, y: baseY + dy });
      }
    }
  }
  return out;
}

/** All footprint tiles a building occupies, returned as a Set of "x,y" keys
 *  for O(1) membership tests during border-overlap checks. Ocean platforms are
 *  expanded to their full cell regions (see `adjacencyFootprintTiles`). Mirrors
 *  the helper in heat.ts (kept local so the two adjacency resolvers stay
 *  independent — see module header; heat is unaffected because no ocean def is
 *  a heat source or sits in a land heat field). */
export function footprintKeySet(
  b: PlacedBuilding,
  defs: Readonly<Record<BuildingDefId, BuildingDef>>,
): Set<string> {
  const out = new Set<string>();
  for (const t of adjacencyFootprintTiles(b, defs)) out.add(`${t.x},${t.y}`);
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
  for (const t of adjacencyFootprintTiles(other, defs)) {
    if (border.has(`${t.x},${t.y}`)) return true;
  }
  return false;
}

/**
 * §4.5 floor-capacity a building contributes to its cluster. For an operational
 * building this is `1 + floorLevel` (the same `1 + L` factor as the floor
 * throughput multiplier). A building still UNDER CONSTRUCTION (#35) contributes
 * only its PREVIOUS, completed floor level — `1 + (floorLevel − 1) = floorLevel`
 * — because the floor currently being built does not count toward the bonus
 * until it finishes. A fresh placement (`floorLevel 0`) under construction
 * therefore contributes 0 (neutral: adds nothing to neighbours' bonus) while
 * still connecting its cluster.
 */
function clusterFloorCapacity(b: PlacedBuilding): number {
  const underConstruction = (b.constructionRemainingMs ?? 0) > 0;
  return Math.max(0, activeFloorLevel(b) + (underConstruction ? 0 : 1));
}

// PERF: clusterBonusMuls is an O(N²) border walk (touchesBorder over building
// pairs) that was the top interaction-lag cost — it's re-run for EVERY island on
// every server snapshot (`refreshRetainedRates` → `computeRates`) and once per
// frame by the open buff panel, even though its result is a pure function of the
// island's building LAYOUT (which only changes on place/move/demolish/floor/
// construction). So a single building edit re-derived adjacency for all ~80
// unchanged islands and every repaint. Memoize on an exact layout signature of
// exactly the fields the walk reads: per building, id + defId (category +
// footprint shape) + x/y/rotation (footprint position) + clusterFloorCapacity
// (the floor/construction contribution). Equal signature ⇒ equal layout ⇒ equal
// result; the changed island gets a fresh signature ⇒ recompute. Keyed by
// signature (not object identity) because each deserialize/snapshot builds fresh
// building objects. The returned Map is treated read-only by callers.
interface ClusterMemoEntry { readonly defs: Readonly<Record<BuildingDefId, BuildingDef>>; readonly result: Map<string, number>; }
const clusterMemo = new Map<string, ClusterMemoEntry>();
const CLUSTER_MEMO_CAP = 256;

function clusterLayoutSig(buildings: ReadonlyArray<PlacedBuilding>): string {
  let sig = '';
  for (const b of buildings) {
    sig += `${b.id},${b.defId},${b.x},${b.y},${b.rotation ?? 0},${clusterFloorCapacity(b)};`;
  }
  return sig;
}

// PERF: memoized tile→building-INDEX occupancy over an island's buildings, so
// collectNeighbors (called per building by the §4.5 buff/gate adjacency) finds a
// building's physical neighbours via its own border tiles in O(border) instead
// of an O(N) scan of every building — turning the per-building exotic/gate
// adjacency over a 470-building island from O(N²) into O(N). Keyed by the same
// layout signature (order-sensitive), so a cached index i maps to the current
// array's `all[i]`; equal signature ⇒ equal layout+order ⇒ correct resolution.
const occIndexMemo = new Map<string, { readonly defs: Readonly<Record<BuildingDefId, BuildingDef>>; readonly tileToIdx: Map<string, number> }>();

function occupancyIndex(
  all: ReadonlyArray<PlacedBuilding>,
  defs: Readonly<Record<BuildingDefId, BuildingDef>>,
): Map<string, number> {
  const sig = clusterLayoutSig(all);
  const hit = occIndexMemo.get(sig);
  if (hit !== undefined && hit.defs === defs) return hit.tileToIdx;
  const tileToIdx = new Map<string, number>();
  for (let i = 0; i < all.length; i++) {
    for (const t of footprintKeySet(all[i]!, defs)) tileToIdx.set(t, i);
  }
  if (occIndexMemo.size >= CLUSTER_MEMO_CAP) occIndexMemo.clear();
  occIndexMemo.set(sig, { defs, tileToIdx });
  return tileToIdx;
}

/**
 * §4.5 per-building cluster-bonus multiplier. A building's *cluster* is the
 * maximal set of same-category buildings connected through 4-neighbour links
 * (the §4.4 border test). The bonus is FLOOR-WEIGHTED and neighbours-only:
 * each member gets `1 + CATEGORY_ADJACENCY_RATE[category] × (K − c_i)`, where
 * `c_i = 1 + floorLevel_i` is its own floor-capacity and `K = Σ c_j` over the
 * cluster — so a member's own height does NOT feed its own bonus, but does
 * raise its neighbours'. (When every member is floor-1, `K − c_i = k − 1` and
 * this collapses to the legacy `1 + (k − 1) × rate`.) Connectivity only:
 * enclosed empty tiles do not break a cluster, and a different-category
 * building between two same-category buildings does not bridge them. Physical
 * same-island buildings only — the §13.3 cross-island lattice does NOT feed
 * this term. Returns 1.0 for an isolated building (any floor) or a rate-0 category.
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
 * sums each component's floor-capacity `K = Σ (1 + floorLevel)`, then maps
 * each building to `1 + rate × (K − c_i)` (c_i = 1 + its own floorLevel).
 * O(N²) over the building set —
 * the per-tick hot path (`economy.computeRates`) calls this ONCE per tick and
 * reads per-building values from the returned map, rather than re-deriving a
 * component per building.
 */
export function clusterBonusMuls(
  buildings: ReadonlyArray<PlacedBuilding>,
  defs: Readonly<Record<BuildingDefId, BuildingDef>> = BUILDING_DEFS,
  conduitUnions?: ReadonlyArray<readonly [string, string]>,
): Map<string, number> {
  let sig = clusterLayoutSig(buildings);
  if (conduitUnions && conduitUnions.length > 0) {
    for (const [a, b] of conduitUnions) sig += `|c:${a},${b}`;
  }
  const hit = clusterMemo.get(sig);
  if (hit !== undefined && hit.defs === defs) return hit.result;

  const n = buildings.length;
  const footprints = buildings.map((b) => footprintKeySet(b, defs));
  const borders = footprints.map((fp) => borderTiles(fp));

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

  // PERF: O(N) spatial adjacency instead of the old O(N²) pairwise touchesBorder
  // scan — the home island has ~470 buildings, so N² ≈ 220k checks per recompute
  // (re-run on every building edit, where the changed layout forces a fresh
  // recompute that the memo can't skip). Build a tile→owning-building index over
  // every footprint tile, then for each building look up only its OWN border
  // tiles' occupants and union same-category neighbours. Identical clusters:
  // building j neighbours i iff some tile of j lies in i's border (exactly the
  // old `touchesBorder(j, borders[i])`), which is the same as "i's border tile
  // is occupied by j". Real placements never overlap, so each tile has one owner.
  const occupant = new Map<string, number>();
  for (let i = 0; i < n; i++) for (const t of footprints[i]!) occupant.set(t, i);
  for (let i = 0; i < n; i++) {
    const cat = defs[buildings[i]!.defId].category;
    for (const bt of borders[i]!) {
      const j = occupant.get(bt);
      if (j === undefined || j === i || defs[buildings[j]!.defId].category !== cat) continue;
      union(i, j);
    }
  }

  // §4.5 conduit unions: merge wired same-category buildings into one component.
  if (conduitUnions && conduitUnions.length > 0) {
    const indexById = new Map<string, number>();
    buildings.forEach((b, i) => indexById.set(b.id, i));
    for (const [aId, bId] of conduitUnions) {
      const ia = indexById.get(aId);
      const ib = indexById.get(bId);
      if (ia === undefined || ib === undefined) continue; // not in this pass's set
      if (defs[buildings[ia]!.defId].category !== defs[buildings[ib]!.defId].category) continue;
      union(ia, ib);
    }
  }

  // §4.5 floor-weighted component capacity: a component's "size" is the sum of
  // its members' floor-capacity c (see `clusterFloorCapacity`), NOT a raw
  // head-count — so a floor-upgraded building contributes its capacity to its
  // neighbours' bonus.
  const compCap = new Map<number, number>();
  for (let i = 0; i < n; i++) {
    const r = find(i);
    compCap.set(r, (compCap.get(r) ?? 0) + clusterFloorCapacity(buildings[i]!));
  }

  const out = new Map<string, number>();
  for (let i = 0; i < n; i++) {
    const b = buildings[i]!;
    const rate = CATEGORY_ADJACENCY_RATE[defs[b.defId].category] ?? 0;
    if (rate === 0) { out.set(b.id, 1); continue; }
    // Neighbours-only: exclude this building's own capacity from its own bonus,
    // so a lone building (any floor) gets ×1.0 and a building's own height
    // drives only its floor multiplier, not its cluster term.
    const K = compCap.get(find(i)) ?? 1;
    out.set(b.id, 1 + rate * (K - clusterFloorCapacity(b)));
  }
  if (clusterMemo.size >= CLUSTER_MEMO_CAP) clusterMemo.clear();
  clusterMemo.set(sig, { defs, result: out });
  return out;
}

/**
 * §4.5 buff-adjacency multiplier for the focal building.
 *
 * Returns `clusterBonusMul × Π(exotic-pair bonuses)`. The cluster term
 * (floor-weighted, neighbours-only across the same-category 4-connected cluster — see `clusterBonusMul`) uses
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
  // O(border) physical-neighbour lookup via the memoized occupancy index: a
  // building is a neighbour iff it occupies one of this building's border tiles
  // (exactly the old `touchesBorder(other, border)`). Border-tile order differs
  // from the old all-scan order, but callers use the set (some()/count), not the
  // order. `seen` dedups a multi-tile neighbour spanning several border tiles.
  const occ = occupancyIndex(all, defs);
  for (const bt of border) {
    const j = occ.get(bt);
    if (j === undefined) continue;
    const other = all[j]!;
    if (other.id === building.id || seen.has(other.id)) continue;
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
