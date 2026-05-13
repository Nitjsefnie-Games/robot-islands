// §4.4 / §4.5 buff-adjacency resolution.
//
// SPEC §4.4: "Adjacency is computed using 4-neighbors. For a multi-tile
// building, the adjacent set is the union of tiles bordering any cell of the
// footprint, minus the footprint itself."
//
// SPEC §4.5 (buff form): "building gains a multiplier per matching neighbor,
// capped at N. Format: `+X% statKey per adjacent matchType, max N matches`."
//
// `computeBuffStack` returns the multiplicative buff multiplier to apply to
// a building's recipe rate. It walks the focal building's 4-neighbor border,
// collects the set of distinct neighbor building ids that touch the border,
// and for each AdjacencyBuff entry on the focal building's def counts the
// number of neighbors satisfying the entry's `matchKind` predicate (capped
// at `maxMatches`). Multiple entries compose multiplicatively; within a
// single entry, N matches contribute additively as `1 + N × percentPerMatch/100`.
//
// Pure module — no PixiJS, no DOM. The 4-neighbor footprint walk mirrors
// `heat.ts`'s pattern (footprintKeySet → borderTiles); we keep the helpers
// local rather than exporting them from heat.ts so the two resolvers can
// evolve independently. Both compute the same set per §4.4.
//
// Both buff adjacency (`computeBuffStack`) and gating adjacency (`checkGates`)
// are implemented in this module per SPEC §4.5.

import {
  BUILDING_DEFS,
  type AdjacencyBuff,
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

/** Predicate: does `neighbor` satisfy the AdjacencyBuff entry relative to
 *  the focal building? Encapsulates the three matchKind variants per §4.5. */
function neighborMatches(
  focal: PlacedBuilding,
  neighbor: PlacedBuilding,
  entry: AdjacencyBuff,
  defs: Readonly<Record<BuildingDefId, BuildingDef>>,
): boolean {
  switch (entry.matchKind) {
    case 'same_def':
      return neighbor.defId === focal.defId;
    case 'same_category':
      return defs[neighbor.defId].category === defs[focal.defId].category;
    case 'def_id':
      return entry.matchDefId !== undefined && neighbor.defId === entry.matchDefId;
  }
}

/**
 * Compute the multiplicative §4.5 buff stack for the focal building.
 *
 * Walks the focal building's 4-neighbor footprint border once to identify
 * the set of distinct neighboring buildings (de-duplicated by id, so a
 * multi-tile neighbor that shares N border tiles counts as a single
 * neighbor per §4.4's "union of tiles" framing). Then for each
 * AdjacencyBuff entry on the focal def, counts the matching neighbors and
 * applies `1 + min(count, maxMatches) × percentPerMatch/100` to the
 * running product.
 *
 * Returns 1.0 when:
 *   - the focal def has no `adjacencyBuffs`,
 *   - or no neighbors match any entry.
 *
 * Pure function: no input is mutated. The `defs` parameter defaults to the
 * canonical `BUILDING_DEFS` catalog; tests pass overrides to wire
 * placeholder buffs without touching the production catalog. The economy
 * threads its `RatesContext.defs` catalog through so a power-free /
 * heavy-mine test catalog continues to work.
 */
export function computeBuffStack(
  b: PlacedBuilding,
  buildings: ReadonlyArray<PlacedBuilding>,
  defs: Readonly<Record<BuildingDefId, BuildingDef>> = BUILDING_DEFS,
): number {
  const def = defs[b.defId];
  const buffs = def.adjacencyBuffs;
  if (!buffs || buffs.length === 0) return 1;

  const fp = footprintKeySet(b, defs);
  const border = borderTiles(fp);

  // Distinct neighboring buildings (by id) whose footprint touches our
  // border. De-duplication is the §4.4 "union" semantics: a 3×3 neighbor
  // crossing three of the focal's border tiles counts as one neighbor,
  // not three. Self is excluded both by border-tile filtering (own
  // footprint excluded from border) and a defensive id check.
  const neighbors: PlacedBuilding[] = [];
  const seen = new Set<string>();
  for (const other of buildings) {
    if (other.id === b.id) continue;
    if (seen.has(other.id)) continue;
    if (!touchesBorder(other, border, defs)) continue;
    seen.add(other.id);
    neighbors.push(other);
  }

  let stack = 1;
  for (const entry of buffs) {
    let count = 0;
    for (const n of neighbors) {
      if (neighborMatches(b, n, entry, defs)) count++;
    }
    if (count <= 0) continue;
    const effective = Math.min(count, entry.maxMatches);
    stack *= 1 + (effective * entry.percentPerMatch) / 100;
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
  return neighbors;
}

export function gateSatisfied(
  building: PlacedBuilding,
  gate: GateRequirement,
  all: ReadonlyArray<PlacedBuilding>,
  defs: Readonly<Record<BuildingDefId, BuildingDef>> = BUILDING_DEFS,
): boolean {
  const def = defs[building.defId];
  if (!def) return true;
  const neighbors = collectNeighbors(building, all, defs);
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
): GateResult {
  const def = defs[building.defId];
  if (!def.gates || def.gates.length === 0) {
    return { satisfied: true, effectiveMul: 1 };
  }

  const neighbors = collectNeighbors(building, all, defs);

  let minMul = 1;
  for (const gate of def.gates) {
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
