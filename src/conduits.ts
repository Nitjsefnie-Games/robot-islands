// Pure cluster-conduit helpers — the graph/attachment/legality CORE of the
// §4.5 cluster-conduit feature. No PixiJS, no DOM.
//
// A "conduit" building (`cluster_conduit` / `lattice_conduit`, category
// `logistics`, no recipe/power) wires same-category producers together so a
// building 4-adjacent to a wired conduit earns the §4.5 cluster bonus across
// distance. `World.conduitLinks` (an order-insensitive list of conduit-id
// pairs) is the persisted edge set; this module turns it into connected
// components and resolves which buildings attach to which conduit, then emits
// the per-category union pairs the economy/UI tasks consume. This file owns no
// economy or render wiring — it is pure graph + tile-adjacency math.
//
// Deviation from the lead's reference (reported in task-3-report.md): the world
// type in this repo is `WorldState`, not `World` — the reference's `World` does
// not exist. Every signature uses the real `WorldState`; the locked public
// shape is otherwise preserved exactly.

import { BUILDING_DEFS, type BuildingDef, type BuildingDefId } from './building-defs.js';
import { type PlacedBuilding, participatesInCluster } from './buildings.js';
import { borderTiles, footprintKeySet, touchesBorder } from './adjacency.js';
import type { WorldState } from './world.js';

/** The two conduit defIds (§4.5). */
export const CONDUIT_DEF_IDS: ReadonlySet<BuildingDefId> = new Set<BuildingDefId>([
  'cluster_conduit',
  'lattice_conduit',
]);

export function isConduit(defId: BuildingDefId): boolean {
  return CONDUIT_DEF_IDS.has(defId);
}

/** Canonical (order-insensitive) ordering of a link's two ids. */
const canon = (a: string, b: string): [string, string] => (a < b ? [a, b] : [b, a]);

/** building id -> island id, across every island. */
export function buildingIslandIndex(world: WorldState): Map<string, string> {
  const idx = new Map<string, string>();
  for (const isl of world.islands) for (const b of isl.buildings) idx.set(b.id, isl.id);
  return idx;
}

function buildingById(world: WorldState, id: string): PlacedBuilding | undefined {
  for (const isl of world.islands) {
    const b = isl.buildings.find((x) => x.id === id);
    if (b) return b;
  }
  return undefined;
}

/**
 * Wire legality (§4.5). Illegal if: a===b (self); either id is missing or not a
 * conduit; or the link already exists (order-insensitive). For conduits on
 * DIFFERENT islands the wire is legal ONLY if BOTH are `lattice_conduit`;
 * same-island wires are legal for any conduit type.
 */
export function canWire(world: WorldState, aId: string, bId: string): { ok: boolean; reason?: string } {
  if (aId === bId) return { ok: false, reason: 'self' };
  const a = buildingById(world, aId);
  const b = buildingById(world, bId);
  if (!a || !b) return { ok: false, reason: 'missing' };
  if (!isConduit(a.defId) || !isConduit(b.defId)) return { ok: false, reason: 'not-conduit' };
  const [c0, c1] = canon(aId, bId);
  if (
    world.conduitLinks.some((l) => {
      const [x, y] = canon(l.a, l.b);
      return x === c0 && y === c1;
    })
  )
    return { ok: false, reason: 'duplicate' };
  const idx = buildingIslandIndex(world);
  if (idx.get(aId) !== idx.get(bId)) {
    if (a.defId !== 'lattice_conduit' || b.defId !== 'lattice_conduit')
      return { ok: false, reason: 'cross-island-needs-lattice' };
  }
  return { ok: true };
}

/** Add a wire after validating via `canWire`; no-op when illegal. Stored in
 *  canonical (a < b) order so dedup/removal are order-insensitive. */
export function addConduitLink(world: WorldState, aId: string, bId: string): void {
  if (!canWire(world, aId, bId).ok) return;
  const [a, b] = canon(aId, bId);
  world.conduitLinks.push({ a, b });
}

/** Remove the wire between two conduit ids (order-insensitive). */
export function removeConduitLink(world: WorldState, aId: string, bId: string): void {
  const [c0, c1] = canon(aId, bId);
  world.conduitLinks = world.conduitLinks.filter((l) => {
    const [x, y] = canon(l.a, l.b);
    return !(x === c0 && y === c1);
  });
}

/** Drop every link touching `buildingId` (called when a conduit is removed). */
export function pruneConduitLinksForBuilding(world: WorldState, buildingId: string): void {
  world.conduitLinks = world.conduitLinks.filter((l) => l.a !== buildingId && l.b !== buildingId);
}

/** Connected components of the undirected wire graph over conduit ids
 *  (union-find with path compression). Isolated conduits with no links do not
 *  appear (they own no edge). */
export function conduitComponents(world: WorldState): string[][] {
  const ids = new Set<string>();
  for (const l of world.conduitLinks) {
    ids.add(l.a);
    ids.add(l.b);
  }
  const parent = new Map<string, string>();
  for (const id of ids) parent.set(id, id);
  const find = (x: string): string => {
    let r = x;
    while (parent.get(r) !== r) r = parent.get(r)!;
    let c = x;
    while (parent.get(c) !== r) {
      const n = parent.get(c)!;
      parent.set(c, r);
      c = n;
    }
    return r;
  };
  for (const l of world.conduitLinks) {
    const ra = find(l.a);
    const rb = find(l.b);
    if (ra !== rb) parent.set(ra, rb);
  }
  const comps = new Map<string, string[]>();
  for (const id of ids) {
    const r = find(id);
    const arr = comps.get(r) ?? [];
    arr.push(id);
    comps.set(r, arr);
  }
  return [...comps.values()];
}

/** A conduit that `eligibleWireTargets` may propose wiring to. */
export interface WireTarget {
  readonly id: string;
  readonly label: string;
  readonly islandId: string;
}

/** All conduits the given conduit may legally wire to right now (canWire ok),
 *  across all islands. `label` is a human string (displayName + a short
 *  island/coord hint). */
export function eligibleWireTargets(
  world: WorldState,
  conduitId: string,
  defs: Readonly<Record<BuildingDefId, BuildingDef>> = BUILDING_DEFS,
): WireTarget[] {
  const out: WireTarget[] = [];
  for (const isl of world.islands) {
    for (const b of isl.buildings) {
      if (b.id === conduitId) continue;
      if (!isConduit(b.defId)) continue;
      if (!canWire(world, conduitId, b.id).ok) continue;
      const def = defs[b.defId];
      const islandName = isl.name ?? isl.id;
      const label = `${def.displayName} (${islandName} @${b.x},${b.y})`;
      out.push({ id: b.id, label, islandId: isl.id });
    }
  }
  return out;
}

/**
 * Buildings attached to a single conduit (§4.4 border test): same-island,
 * 4-adjacent to the conduit footprint, `participatesInCluster`, and not itself
 * a conduit. Returns [] for an unknown conduit id.
 */
export function attachedBuildings(
  conduitId: string,
  world: WorldState,
  defs: Readonly<Record<BuildingDefId, BuildingDef>> = BUILDING_DEFS,
): PlacedBuilding[] {
  const idx = buildingIslandIndex(world);
  const islandId = idx.get(conduitId);
  if (!islandId) return [];
  const isl = world.islands.find((i) => i.id === islandId);
  const conduit = isl?.buildings.find((b) => b.id === conduitId);
  if (!isl || !conduit) return [];
  const border = borderTiles(footprintKeySet(conduit, defs));
  const out: PlacedBuilding[] = [];
  for (const b of isl.buildings) {
    if (b.id === conduitId || isConduit(b.defId)) continue;
    if (!participatesInCluster(b)) continue;
    if (touchesBorder(b, border, defs)) out.push(b);
  }
  return out;
}

/**
 * Per conduit component, collect every attached building across all conduits in
 * the component, group by the building's category, and within each category
 * emit union pairs chaining those building ids together. Never emits a pair
 * across different categories. A building attached to two conduits in the same
 * component is deduped (appears once → no self-pair). Returns building-id pairs.
 */
export function conduitClusterUnions(
  world: WorldState,
  defs: Readonly<Record<BuildingDefId, BuildingDef>> = BUILDING_DEFS,
): ReadonlyArray<readonly [string, string]> {
  const pairs: Array<readonly [string, string]> = [];
  for (const comp of conduitComponents(world)) {
    const byCat = new Map<string, string[]>();
    for (const cid of comp)
      for (const b of attachedBuildings(cid, world, defs)) {
        const cat = defs[b.defId].category;
        const arr = byCat.get(cat) ?? [];
        arr.push(b.id);
        byCat.set(cat, arr);
      }
    for (const ids of byCat.values()) {
      const uniq = [...new Set(ids)];
      for (let i = 1; i < uniq.length; i++) pairs.push([uniq[i - 1]!, uniq[i]!] as const);
    }
  }
  return pairs;
}
