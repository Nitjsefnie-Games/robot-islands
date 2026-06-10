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
import { nodeById } from './skilltree.js';
import {
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
 *   9. Absorbed is removed from `world.islands` and `states.delete`'d.
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

  // 1. Append absorbed's primary ellipse as a new extra on absorber.
  if (!absorber.extraEllipses) {
    absorber.extraEllipses = [];
  }
  absorber.extraEllipses.push({
    major: absorbed.majorRadius,
    minor: absorbed.minorRadius,
    rotation: 0,
    offsetX,
    offsetY,
  });
  // If the absorbed island carried any extras of its own (recursive merge
  // history), propagate them too — each extra's offset shifts by the
  // (absorbed - absorber) delta so they land in absorber's local frame.
  if (absorbed.extraEllipses) {
    for (const e of absorbed.extraEllipses) {
      absorber.extraEllipses.push({
        major: e.major,
        minor: e.minor,
        rotation: e.rotation,
        offsetX: e.offsetX + offsetX,
        offsetY: e.offsetY + offsetY,
      });
    }
  }

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

  // 3. Transfer inventory; absorber's cap clamps the result, dropping
  //    overflow. Skip if either state is missing (§3.6 implies both islands
  //    are populated for a merge to make sense).
  if (absorberState && absorbedState) {
    const caps = absorberState.storageCaps;
    for (const r of Object.keys(absorbedState.inventory) as ResourceId[]) {
      const cur = absorberState.inventory[r] ?? 0;
      const incoming = absorbedState.inventory[r] ?? 0;
      const capR = caps[r] ?? 0;
      absorberState.inventory[r] = Math.min(capR, cur + incoming);
    }
  }

  // 4. Skill-point refund. Sum unspent + spent on absorbed, add to
  //    absorber's unspent. Absorbed's unlock set and edge set are
  //    discarded along with the rest of its state.
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

  // 8. Remove absorbed from islands list and states map.
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
 * Only populated islands participate; an unpopulated island has no `state`
 * and §3.6 reasoning ("populated island grows via Land Reclamation Hub
 * until it touches a neighbor") implicitly applies to populated identities.
 *
 * The reported pair carries `(absorber, absorbed)` resolved via
 * `chooseMergeAbsorber`.
 */
export function findNextMerge(
  world: WorldState,
  states: Map<string, IslandState>,
): { absorber: IslandSpec; absorbed: IslandSpec } | null {
  const populated = world.islands.filter((s) => s.populated);
  interface Candidate {
    readonly a: IslandSpec;
    readonly b: IslandSpec;
    readonly combined: number;
    /** Lower of `(a.id, b.id)` — drives the tie break. */
    readonly minId: string;
  }
  const cands: Candidate[] = [];
  // Pre-compute tile counts once per island so an N-pair scan stays O(N²)
  // rather than O(N² × islandTileCount).
  const tileCounts = new Map<string, number>();
  for (const s of populated) tileCounts.set(s.id, islandTileCount(s));
  for (let i = 0; i < populated.length; i++) {
    for (let j = i + 1; j < populated.length; j++) {
      const a = populated[i]!;
      const b = populated[j]!;
      if (!islandsOverlap(a, b)) continue;
      const ta = tileCounts.get(a.id) ?? 0;
      const tb = tileCounts.get(b.id) ?? 0;
      cands.push({
        a,
        b,
        combined: ta + tb,
        minId: a.id < b.id ? a.id : b.id,
      });
    }
  }
  if (cands.length === 0) return null;
  // Sort: largest combined first, then lower minId first.
  cands.sort((p, q) => {
    if (p.combined !== q.combined) return q.combined - p.combined;
    if (p.minId < q.minId) return -1;
    if (p.minId > q.minId) return 1;
    return 0;
  });
  const top = cands[0]!;
  const sa = states.get(top.a.id);
  const sb = states.get(top.b.id);
  // Both states must exist (populated island invariant). If they don't,
  // skip the merge cleanly — no defaults that would mask the bug.
  if (!sa || !sb) return null;
  const decision = chooseMergeAbsorber(top.a, top.b, sa, sb);
  const absorber = decision.absorber === 'a' ? top.a : top.b;
  const absorbed = decision.absorber === 'a' ? top.b : top.a;
  return { absorber, absorbed };
}
