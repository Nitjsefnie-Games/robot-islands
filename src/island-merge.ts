// §3.6 Island Joining — pure logic for merging two overlapping islands.
// No PixiJS, no DOM. The economy ticker in main.ts calls `findNextMerge` once
// per tick after `advanceIsland`; a reported pair is passed to `performMerge`.
//
// At most ONE merge runs per tick (§3.6 multi-overlap ordering). Remaining
// overlap pairs re-evaluate on the next tick, by which time the merged
// identity has new ellipses and may overlap further targets.
//
// `chooseMergeAbsorber` is pure (tiebreak ladder); `performMerge` is mutating,
// and the caller owns the at-most-once-per-tick contract.

import type { IslandState } from './economy.js';
import { BUILDING_DEFS } from './building-defs.js';
import { floorScaledCapacity, isOperationalBuilding } from './buildings.js';
import { creditStorageCaps } from './placement.js';
import { cap } from './storage-cap.js';
import { nodeById } from './skilltree.js';
import {
  appendAbsorbedLedger,
  islandsOverlap,
  islandTileCount,
  type IslandSpec,
  type WorldState,
} from './world.js';
import type { ResourceId } from './recipes.js';

/** Why a given island won the absorber slot in `chooseMergeAbsorber`.
 *  Returned for diagnostic / future-UI / test purposes. */
export type MergeReason = 'tile-count' | 'level-tiebreak' | 'id-tiebreak';

/** Result of the absorber decision. `absorber` names which of the two
 *  inputs wins; `reason` exposes why for tests and any future UI surface. */
export interface AbsorberDecision {
  readonly absorber: 'a' | 'b';
  readonly reason: MergeReason;
}

/**
 * Decide which of two overlapping islands absorbs the other per §3.6:
 *
 *   1. Larger tile count wins.
 *   2. On tie, higher level wins.
 *   3. On tie, lower `id` (lexicographically) wins.
 *
 * Pure — does not mutate either input. The `IslandSpec` lookups for tile
 * count happen via `islandTileCount` (which honors `extraEllipses`).
 */
export function chooseMergeAbsorber(
  a: IslandSpec,
  b: IslandSpec,
  sa: IslandState,
  sb: IslandState,
): AbsorberDecision {
  const ta = islandTileCount(a);
  const tb = islandTileCount(b);
  if (ta !== tb) {
    return { absorber: ta > tb ? 'a' : 'b', reason: 'tile-count' };
  }
  if (sa.level !== sb.level) {
    return { absorber: sa.level > sb.level ? 'a' : 'b', reason: 'level-tiebreak' };
  }
  return { absorber: a.id < b.id ? 'a' : 'b', reason: 'id-tiebreak' };
}

/** Total spent-and-unspent skill points on an island — the §3.6 refund
 *  amount. Pure. `unspentSkillPoints` is direct; "spent" is the sum of
 *  `progress.spent` across every sub-path the island has touched (mirrors
 *  the cost a player paid into each sub-path; one point per cost-1 node). */
export function islandRefundedPoints(state: IslandState): number {
  let spent = 0;
  for (const nodeId of state.unlockedNodes) {
    const node = nodeById(nodeId);
    if (node) spent += node.cost;
  }
  return state.unspentSkillPoints + spent;
}

/**
 * Mutate `world` and `states` in place per §3.6 merge semantics:
 *
 *   1. Append `absorbed`'s ellipse as an extra constituent of `absorber`,
 *      with offset `(absorbed.cx - absorber.cx, absorbed.cy - absorber.cy)`.
 *   2. Each of absorbed's buildings is appended to absorber's `buildings`
 *      array with coordinates shifted by the same offset (so they live in
 *      absorber's local frame). PlacedBuilding is `readonly x/y`, so we
 *      build a fresh object per building — never mutate in place.
 *   3. Absorbed's inventory transfers per-resource: `A.inv[r] = min(A.cap(r),
 *      A.inv[r] + B.inv[r])`. Overflow is silently dropped.
 *   4. Absorbed's spent-and-unspent skill points refund as unspent on
 *      absorber (the player can freely re-spec via the existing skill UI).
 *      `unlockedNodes` and `unlockedEdges` on absorbed are discarded.
 *   5. Absorbed's level and XP are discarded; absorber's are preserved.
 *   6. Routes targeting absorbed redirect to absorber (`route.to = A.id`);
 *      routes leaving absorbed redirect (`route.from = A.id`). Routes
 *      between A and B (in either direction) are deleted (they become
 *      intra-island).
 *   7. Drones whose `fromIslandId === absorbed.id` redirect to absorber.
 *   8. Settlement vehicles whose `target === absorbed.id` retarget to
 *      absorber. Vehicles whose `from === absorbed.id` redirect their
 *      origin (in-flight cargo is unchanged).
 *   9. Satellites whose `spaceportIslandId === absorbed.id` redirect to
 *      absorber (rebuilt because the field is readonly).
 *  10. Comm packets whose `currentNodeId === absorbed.id` redirect to absorber.
 *  11. Lattice node membership (`world.latticeNodeIslands`): any entry for
 *      `absorbed.id` is replaced with `absorber.id` and de-duplicated.
 *  12. Absorbed is removed from `world.islands` and `states.delete`'d.
 *
 * Caller must invoke this AT MOST ONCE per tick (§3.6). After this returns,
 * `absorber` carries the new geometry and any later `islandsOverlap` test
 * sees the union footprint.
 *
 * `absorber.modifiers`, `absorber.name`, and every other field stay as-is
 * — only the geometry, buildings, inventory, and skill-point fields update.
 *
 * Note on building coordinates: by SPEC §3.6 reasoning, two buildings can't
 * collide because the offset is non-zero. We don't verify this — the
 * absorbed island's buildings are pushed alongside absorber's; if a future
 * test fabricates a colliding case, footprint conflict resolution is
 * out-of-scope for §3.6 per the SPEC.
 */
export function performMerge(
  world: WorldState,
  states: Map<string, IslandState>,
  absorber: IslandSpec,
  absorbed: IslandSpec,
): void {
  const absorberState = states.get(absorber.id);
  const absorbedState = states.get(absorbed.id);

  const offsetX = absorbed.cx - absorber.cx;
  const offsetY = absorbed.cy - absorber.cy;

  // §3.6 ownership-ledger maintenance: the absorbed primary lands at this
  // absorber constituent index (1 primary + current extras). Captured BEFORE
  // the extraEllipses append below.
  const ledgerBaseIndex = 1 + (absorber.extraEllipses?.length ?? 0);

  // 1. Append absorbed's primary ellipse as a new extra on absorber.
  if (!absorber.extraEllipses) {
    absorber.extraEllipses = [];
  }
  absorber.extraEllipses.push({
    biome: absorbed.biome,
    // §3.6 terrain seed: the absorbed island's id, so its terrain (resource
    // veins included) reproduces under the lobe's own biome post-merge.
    originId: absorbed.id,
    founderId: absorbed.founderId,
    major: absorbed.majorRadius,
    minor: absorbed.minorRadius,
    rotation: 0,
    offsetX,
    offsetY,
  });
  // If the absorbed island carried any extras of its own (recursive merge
  // history), propagate them too — each extra's offset shifts by the
  // (absorbed - absorber) delta so they land in absorber's local frame. Each
  // keeps its OWN origin biome/seed (falling back to the absorbed primary's).
  if (absorbed.extraEllipses) {
    for (const e of absorbed.extraEllipses) {
      absorber.extraEllipses.push({
        biome: e.biome ?? absorbed.biome,
        originId: e.originId ?? absorbed.id,
        founderId: e.founderId,
        major: e.major,
        minor: e.minor,
        rotation: e.rotation,
        offsetX: e.offsetX + offsetX,
        offsetY: e.offsetY + offsetY,
      });
    }
  }

  // §3.6 fold the absorbed island's ownership claims into the absorber's ledger
  // (remapped by +ledgerBaseIndex). No-op when neither side has a ledger.
  appendAbsorbedLedger(absorber, absorbed, ledgerBaseIndex);

  // 2. Shift absorbed's buildings into absorber's local frame. Build fresh
  //    PlacedBuilding objects because `x` / `y` are `readonly` on the type.
  //    Re-mint ids from shifted coords so two islands that each owned
  //    `placed-0,0` don't collide (§3.6: "All buildings on both islands remain
  //    in place").  Guard the geometrically-impossible collision by suffixing
  //    the absorbed island id.
  const absorberIdSet = new Set(absorber.buildings.map((b) => b.id));
  const idMap = new Map<string, string>();
  for (const b of absorbed.buildings) {
    const newX = b.x + offsetX;
    const newY = b.y + offsetY;
    let newId = `placed-${newX},${newY}`;
    if (absorberIdSet.has(newId)) {
      newId = `${newId}-${absorbed.id}`;
    }
    absorberIdSet.add(newId);
    if (b.id !== newId) idMap.set(b.id, newId);
    absorber.buildings.push({
      ...b,
      id: newId,
      x: newX,
      y: newY,
      anchorIslandId:
        b.anchorIslandId === absorbed.id ? absorber.id : b.anchorIslandId,
    });
  }

  // 2b. Carry absorbed tileOverrides into absorber, shifted by the offset.
  //     Per v5 no_revert lock, conversions are permanent and must survive
  //     the merge.  Absorber's own entries win collisions — matching the
  //     last_placed_wins convention in attachTerrainAt.
  if (absorbed.tileOverrides) {
    if (!absorber.tileOverrides) {
      absorber.tileOverrides = {};
    }
    for (const [key, kind] of Object.entries(absorbed.tileOverrides)) {
      const parts = key.split(',');
      const x = Number(parts[0]);
      const y = Number(parts[1]);
      const shiftedKey = `${x + offsetX},${y + offsetY}`;
      if (!(shiftedKey in absorber.tileOverrides)) {
        absorber.tileOverrides[shiftedKey] = kind;
      }
    }
  }

  // 2c. Credit operational absorbed storage buildings to the absorber's
  //      caps BEFORE the inventory transfer, so overflow isn't silently
  //      dropped against a stale cap.
  if (absorberState) {
    const preCount = absorber.buildings.length - absorbed.buildings.length;
    for (let i = preCount; i < absorber.buildings.length; i++) {
      const b = absorber.buildings[i]!;
      const def = BUILDING_DEFS[b.defId];
      if (!def || !def.storage || !isOperationalBuilding(b)) continue;
      const mult = floorScaledCapacity(b, def.storage.capacity);
      creditStorageCaps(absorberState, b, def, mult);
    }
  }

  // 3. Transfer inventory; absorber's cap clamps the result, dropping
  //    overflow. Skip if either state is missing — the absorbed island may be
  //    non-populated and therefore stateless, and the guard handles that.
  if (absorberState && absorbedState) {
    for (const r of Object.keys(absorbedState.inventory) as ResourceId[]) {
      const cur = absorberState.inventory[r] ?? 0;
      const incoming = absorbedState.inventory[r] ?? 0;
      // Clamp to the EFFECTIVE cap (nominal × §9.3 storage-skill multiplier),
      // not the raw nominal `storageCaps[r]` — using the raw value silently
      // dropped the skill multiplier and discarded the absorber's own
      // inventory down to ~1/mult (the §3.6 merge inventory-loss bug).
      absorberState.inventory[r] = Math.min(cap(absorberState, r), cur + incoming);
    }
  }

  // 4. Skill-point refund. Sum unspent + spent on absorbed, add to
  //    absorber's unspent. The absorbed island may be non-populated and
  //    stateless (no skill points to refund); the guard handles that.
  //    Absorbed's unlock set and edge set are discarded along with the rest
  //    of its state.
  if (absorberState && absorbedState) {
    absorberState.unspentSkillPoints += islandRefundedPoints(absorbedState);
  }

  // 5. Routes: A↔B routes become intra-island (deleted); third-party
  //    routes to/from B redirect to A.  Also rewrite any `sourceBuildingId`
  //    that referenced an absorbed building whose id was re-minted in step 2.
  const newRoutes = [];
  for (const r of world.routes) {
    if (
      (r.from === absorber.id && r.to === absorbed.id) ||
      (r.from === absorbed.id && r.to === absorber.id)
    ) {
      continue;
    }
    // Endpoint redirect. `from`/`to` are readonly on Route, so build a fresh
    // record per affected entry.
    let updated: typeof r | undefined;
    if (r.from === absorbed.id) {
      updated = { ...(updated ?? r), from: absorber.id };
    } else if (r.to === absorbed.id) {
      updated = { ...(updated ?? r), to: absorber.id };
    }
    if (r.sourceBuildingId !== undefined && idMap.has(r.sourceBuildingId)) {
      updated = { ...(updated ?? r), sourceBuildingId: idMap.get(r.sourceBuildingId)! };
    }
    newRoutes.push(updated ?? r);
  }
  world.routes.length = 0;
  for (const r of newRoutes) world.routes.push(r);

  // 6. Drones returning to absorbed redirect to absorber.
  for (let i = 0; i < world.drones.length; i++) {
    const d = world.drones[i]!;
    if (d.fromIslandId === absorbed.id) {
      world.drones[i] = { ...d, fromIslandId: absorber.id };
    }
  }

  // 7. Settlement vehicles to/from absorbed redirect to absorber.
  for (let i = 0; i < world.vehicles.length; i++) {
    const v = world.vehicles[i]!;
    let updated = v;
    if (v.target === absorbed.id) {
      updated = { ...updated, target: absorber.id };
    }
    if (v.from === absorbed.id) {
      updated = { ...updated, from: absorber.id };
    }
    if (updated !== v) world.vehicles[i] = updated;
  }

  // 8. Satellites launched from absorbed redirect to absorber.  Rebuild the
  //    object because `spaceportIslandId` is readonly on `Satellite`.
  for (let i = 0; i < world.satellites.length; i++) {
    const s = world.satellites[i]!;
    if (s.spaceportIslandId === absorbed.id) {
      world.satellites[i] = { ...s, spaceportIslandId: absorber.id };
    }
  }

  // 9. Comm packets currently at absorbed redirect to absorber.
  for (let i = 0; i < world.commPackets.length; i++) {
    const p = world.commPackets[i]!;
    if (p.currentNodeId === absorbed.id) {
      world.commPackets[i] = { ...p, currentNodeId: absorber.id };
    }
  }

  // 10. Lattice node membership: absorbed -> absorber, de-duplicated.
  if (world.latticeNodeIslands.includes(absorbed.id)) {
    world.latticeNodeIslands = world.latticeNodeIslands.filter((id) => id !== absorbed.id);
    if (!world.latticeNodeIslands.includes(absorber.id)) {
      world.latticeNodeIslands.push(absorber.id);
    }
  }

  // 11. Remove absorbed from islands list and states map.
  const idx = world.islands.findIndex((s) => s.id === absorbed.id);
  if (idx >= 0) world.islands.splice(idx, 1);
  states.delete(absorbed.id);
}

/**
 * Find the merge pair to process this tick. Returns null when no pair of
 * islands overlaps. Per §3.6:
 *
 *   - Order pairs by combined tile count (largest first).
 *   - On combined-tile-count ties, prefer the pair whose lower-id member
 *     is lexicographically smallest (deterministic tiebreak).
 *
 * A merge pair needs at least one populated island; two unpopulated islands
 * never merge. When both islands are populated the absorber is resolved via
 * `chooseMergeAbsorber`. When exactly one is populated, it is always the
 * absorber and the non-populated neighbour becomes a constituent lobe.
 *
 * The reported pair carries `(absorber, absorbed)` accordingly.
 */
type MergeResult = { absorber: IslandSpec; absorbed: IslandSpec } | null;

// PERF: findNextMerge runs every world-systems step (~480× for an 8-min offline
// catch-up) and its O(N²) islandsOverlap scan dominated catch-up CPU. The scan's
// result is a pure function of ALL islands' id + geometry + populated bit —
// none of which change between steps except via a merge or a settlement-vehicle
// population (both of which change the signature). So memoize on an exact
// signature of exactly those inputs (O(N) to build vs the O(N²) scan it guards):
// equal signature ⇒ equal scan inputs ⇒ equal result. Correctness note: a
// non-null result is never served from cache twice — the caller performs the
// merge that same step, mutating geometry ⇒ the next signature differs ⇒
// recompute (which re-reads `states` for the absorber choice). Only null results
// are reused, and while the signature holds no overlap can appear, so reuse is
// exact. Single-entry: a catch-up processes one account's run at a time; a
// different account's ids yield a different signature (miss).
let _mergeSig: string | null = null;
let _mergeResult: MergeResult = null;

function mergeSignature(islands: ReadonlyArray<IslandSpec>): string {
  let sig = '';
  for (const s of islands) {
    sig += `${s.id}:${s.populated ? 1 : 0}:${s.cx},${s.cy},${s.majorRadius},${s.minorRadius}`;
    if (s.extraEllipses) {
      for (const e of s.extraEllipses) sig += `;${e.major},${e.minor},${e.offsetX},${e.offsetY}`;
    }
    sig += '|';
  }
  return sig;
}

export function findNextMerge(
  world: WorldState,
  states: Map<string, IslandState>,
): MergeResult {
  const populated = world.islands.filter((s) => s.populated);
  const sig = mergeSignature(world.islands);
  if (sig === _mergeSig) return _mergeResult;
  // Memoize ONLY the (common) no-merge result. A non-null result carries spec
  // references and is consumed by an immediate performMerge that mutates the
  // geometry; never serve it from cache, so there is no way to hand a stale
  // spec to a later call (e.g. a hypothetical non-merging inspector). The 480
  // redundant per-step scans during catch-up are all null, so this keeps the win.
  const cache = (r: MergeResult): MergeResult => {
    _mergeSig = r === null ? sig : null;
    _mergeResult = null;
    return r;
  };
  interface Candidate {
    readonly a: IslandSpec;
    readonly b: IslandSpec;
    readonly combined: number;
    /** Lower of `(a.id, b.id)` — drives the tie break. */
    readonly minId: string;
  }
  // A merge needs >=1 populated island. Scan populated (outer) x all islands
  // (inner) so cost stays O(P*N); dedupe each unordered pair once.
  const cands: Candidate[] = [];
  const seen = new Set<string>();
  // Pre-compute tile counts once per island so an N-pair scan stays O(N²)
  // rather than O(N² × islandTileCount).
  const tileCounts = new Map<string, number>();
  for (const s of world.islands) tileCounts.set(s.id, islandTileCount(s));
  for (const p of populated) {
    for (const other of world.islands) {
      if (other.id === p.id) continue;
      const key = p.id < other.id ? `${p.id}|${other.id}` : `${other.id}|${p.id}`;
      if (seen.has(key)) continue;
      seen.add(key);
      if (!islandsOverlap(p, other)) continue;
      const a = p.id < other.id ? p : other;
      const b = p.id < other.id ? other : p;
      cands.push({
        a,
        b,
        combined: (tileCounts.get(a.id) ?? 0) + (tileCounts.get(b.id) ?? 0),
        minId: a.id,
      });
    }
  }
  if (cands.length === 0) return cache(null);
  // Sort: largest combined first, then lower minId first.
  cands.sort((p, q) => {
    if (p.combined !== q.combined) return q.combined - p.combined;
    if (p.minId < q.minId) return -1;
    if (p.minId > q.minId) return 1;
    return 0;
  });
  const top = cands[0]!;
  let absorber: IslandSpec;
  let absorbed: IslandSpec;
  if (top.a.populated && top.b.populated) {
    const sa = states.get(top.a.id);
    const sb = states.get(top.b.id);
    // Both populated => both must have state (the populated invariant). If a
    // state is missing, skip cleanly rather than mask the bug.
    if (!sa || !sb) return cache(null);
    const decision = chooseMergeAbsorber(top.a, top.b, sa, sb);
    absorber = decision.absorber === 'a' ? top.a : top.b;
    absorbed = decision.absorber === 'a' ? top.b : top.a;
  } else {
    // Exactly one populated (the scan guarantees >=1). The populated island
    // owns the surviving identity/state and is always the absorber; the
    // non-populated neighbour becomes a constituent lobe.
    absorber = top.a.populated ? top.a : top.b;
    absorbed = top.a.populated ? top.b : top.a;
    if (!states.get(absorber.id)) return cache(null);
  }
  return cache({ absorber, absorbed });
}
