// §13.3 D-01 / D-02 — grouped lockstep advance for cross-island shared flow.
//
// Design: docs/superpowers/specs/2026-06-10-lattice-shared-flow-design.md
//
// Pure layer: no PixiJS, no DOM. Imports the economy integrator's exported
// primitives (computeRates / findNextCapEvent / applyRates /
// applySegmentSideEffects) plus the segment-boundary helpers, and orchestrates
// them across a SET of member islands as ONE net-flow problem.
//
// TWO callers share the core `advanceGroup` below:
//
//   • `advanceLatticeGroup` (D-01) — the Omniscient Lattice. Pools ALL
//     resources across members (`pooledResources = null` ⇒ pool everything).
//     Byte-identical to the original D-01 implementation.
//
//   • `advanceSharedNetworkGroup` (D-02, shared-network-advance.ts) — the
//     non-lattice `crossIslandShared` skill network. Pools ONLY the
//     shared-resource SUBSET (`pooledResources = the shared set`); every
//     NON-shared resource stays strictly local (its own inventory/caps, no
//     cross-island throttle/drain). It delegates to `advanceGroup` with the
//     shared set + the Σ-cap override from `sharedStorageCap`.
//
// Why this exists (the D-01/D-02 bug): with cross-island sharing active,
// members' economy reads use the shared pool (ctx.inventory / ctx.caps
// overrides), but the per-island `applyRates` decremented only the LOCAL
// island — a member with zero local stock ran forever off a partner's stock
// that never shrank (matter from nothing). The fix:
//
//   1. UNION SOLVE — each member's pass-2.5 flow solve is fed the union of all
//      members' flow coefficients (via `ctx.flowSiblings`), with cap/zero
//      regimes computed from POOLED inventory vs POOLED caps. Cross-island
//      producers/consumers throttle against each other exactly like
//      same-island flows. The flow solver itself is unchanged. For PARTIAL
//      pooling the sibling specs are RESOURCE-FILTERED to the pooled set, so a
//      building consuming a NON-shared resource never unions across islands.
//   2. POOLED INTEGRATION — the pooled (shared-resource) net flows are summed
//      across members and integrated ONCE against the pooled inventory
//      (clamped to pooled caps), so mass is conserved by construction. Each
//      member's NON-pooled net is integrated LOCALLY via `applyRates`.
//   3. CAP-PROPORTIONAL DISTRIBUTION — after each segment the pooled quantity
//      of each pooled resource is written back to members as
//      `local_i = pooled × cap_i / Σcaps`; resources with `Σcaps = 0` keep
//      their local stocks untouched. No persistence schema bump.
//   4. PER-ISLAND ATTRIBUTION UNCHANGED — XP, wear, maintenance, CO₂, battery,
//      construction all run per-member on that member's own
//      production/byBuilding via the shared `applySegmentSideEffects`.
//
// Non-member / non-participant islands are untouched: they advance via
// `advanceIsland` exactly as before.

import {
  applyRates,
  applySegmentSideEffects,
  batteryCapacityWs,
  BATTERY_EMPTY_THRESHOLD_WS,
  computeRates,
  findNextCapEvent,
  layerConditionalBonuses,
  type IslandState,
  type RatesContext,
} from './economy.js';
import { BUILDING_DEFS } from './building-defs.js';
import { nextRealPhaseBoundaryMs, nextSolarBoundaryMs } from './daynight.js';
import { pickMostDegradedTarget, tryAutoMaintain } from './maintenance.js';
import { advanceToxicityRolls } from './reactor-toxicity.js';
import {
  nextRotateOutputBoundaryMs,
  resolveRecipe,
  type ResourceId,
} from './recipes.js';
import {
  cloneSkillMultipliers,
  DEFAULT_GRAPH,
  effectiveSkillMultipliers,
} from './skilltree.js';
import type { FlowBuildingSpec } from './flow-solver.js';

/**
 * Pooling configuration for `advanceGroup`.
 *   - `resources === null`  ⇒ pool EVERY resource (the D-01 lattice path).
 *   - `resources` a Set     ⇒ pool ONLY those resources (the D-02 shared-
 *                             network path); everything else stays local.
 *   - `capOverride`         ⇒ per-resource Σcap override for pooled resources
 *                             (D-02 uses `sharedStorageCap`; resources absent
 *                             from the map fall back to Σ member local caps).
 *                             `null` ⇒ always Σ member local caps (D-01).
 */
interface PoolingConfig {
  readonly resources: ReadonlySet<ResourceId> | null;
  readonly capOverride: ReadonlyMap<ResourceId, number> | null;
  /**
   * Per-resource POOLING MEMBERSHIP (D-02 node-holder rule). For shared
   * resource `r`, `holders.get(r)` is the set of island ids that hold a
   * `sharedInventory` node covering `r`; ONLY those islands pool `r` (sum +
   * cap-proportional redistribute). An island NOT in the set keeps its `r`
   * strictly LOCAL even though `r` is a network-shared resource. Membership is
   * per-(resource, island): `isPooledForIsland`. `null` ⇒ every member pools
   * every pooled resource (the D-01 lattice path, POOL_ALL).
   */
  readonly holders: ReadonlyMap<ResourceId, ReadonlySet<string>> | null;
}

/** Pool everything (D-01). */
const POOL_ALL: PoolingConfig = { resources: null, capOverride: null, holders: null };

/** Is resource `r` a shared/pooled resource at all under this config?
 *  (Resource-level gate, island-independent — used to decide whether `r`
 *  belongs to the pooled regime vs the strictly-local regime.) */
function isPooled(cfg: PoolingConfig, r: ResourceId): boolean {
  return cfg.resources === null || cfg.resources.has(r);
}

/** Does island `islandId` pool resource `r` under this config? POOL_ALL ⇒
 *  always (lattice). Partial ⇒ `r` is shared AND `islandId` holds a node for
 *  `r`. An island that is networked but lacks the node for `r` keeps `r` local. */
function isPooledForIsland(cfg: PoolingConfig, r: ResourceId, islandId: string): boolean {
  if (cfg.resources === null) return true; // POOL_ALL — D-01 lattice
  if (!cfg.resources.has(r)) return false;
  if (cfg.holders === null) return true; // no membership table ⇒ all share
  const set = cfg.holders.get(r);
  return set !== undefined && set.has(islandId);
}

/** Build the pooled (Σ over members) inventory map, restricted to pooled
 *  resources. Non-pooled resources are absent from the returned map, so the
 *  economy's per-key fallback (`ctx.inventory?.[r] ?? state.inventory[r]`)
 *  reads them LOCALLY. */
function pooledInventory(
  states: ReadonlyArray<IslandState>,
  cfg: PoolingConfig,
): Record<ResourceId, number> {
  const out = {} as Record<ResourceId, number>;
  for (const st of states) {
    for (const [r, amt] of Object.entries(st.inventory)) {
      // Only sum r from islands that POOL r (node-holders). A networked
      // participant without r's node keeps r local — not summed here.
      if (!isPooledForIsland(cfg, r as ResourceId, st.id)) continue;
      out[r as ResourceId] = (out[r as ResourceId] ?? 0) + (amt ?? 0);
    }
  }
  return out;
}

/** Build the pooled (Σ over members) storage-cap map, restricted to pooled
 *  resources × node-holders, applying the per-resource Σcap override where
 *  provided. NB: only node-holders' caps count toward Σcaps (redistribution
 *  divisor); a non-holder's local r-cap is irrelevant to r's pool. The
 *  `capOverride` (D-02 sharedStorageCap) replaces the summed value for its
 *  resources — those Σ-caps are already node-holder-scoped at the source
 *  (`network.ts` sums only node-holders into `sharedStorageCap`). */
function pooledCapsMap(
  states: ReadonlyArray<IslandState>,
  cfg: PoolingConfig,
): Record<ResourceId, number> {
  const out = {} as Record<ResourceId, number>;
  for (const st of states) {
    for (const [r, amt] of Object.entries(st.storageCaps)) {
      if (!isPooledForIsland(cfg, r as ResourceId, st.id)) continue;
      out[r as ResourceId] = (out[r as ResourceId] ?? 0) + (amt ?? 0);
    }
  }
  // Apply explicit Σcap overrides (D-02 sharedStorageCap nodes raise the cap).
  if (cfg.capOverride) {
    for (const [r, v] of cfg.capOverride) out[r] = v;
  }
  return out;
}

/**
 * Cap-proportional distribution. Write the pooled quantity of each POOLED
 * resource back to member inventories as `local_i = pooled × cap_i / Σcaps`.
 * Resources where `Σcaps = 0` keep their existing local stocks untouched (the
 * design's freeze case — pooled stock has no cap home to land in). Σcaps is
 * read from `pooledCaps` (which already folded the cap override) so the
 * distribution share matches the integrate clamp. NON-pooled resources are
 * never touched here.
 */
function distributePooled(
  states: ReadonlyArray<IslandState>,
  pool: Record<ResourceId, number>,
  pooledCaps: Record<ResourceId, number>,
  cfg: PoolingConfig,
): void {
  const resources = new Set<ResourceId>();
  for (const r of Object.keys(pool)) {
    if (isPooled(cfg, r as ResourceId)) resources.add(r as ResourceId);
  }

  for (const r of resources) {
    // Redistribute r ONLY to its node-holders, by their caps. The divisor is
    // the Σ of HOLDERS' local caps (not pooledCaps[r], which may fold a
    // sharedStorageCap override over a DIFFERENT — cap-node — holder set);
    // using the actual distributed set's cap sum keeps redistribution exactly
    // mass-conserving. For POOL_ALL every member is a holder, so the divisor
    // equals Σ member caps and this is byte-identical to the D-01 path
    // (pooledCaps[r] == Σ member caps when capOverride is null).
    let totalCap = 0;
    for (const st of states) {
      if (!isPooledForIsland(cfg, r, st.id)) continue;
      totalCap += st.storageCaps[r] ?? 0;
    }
    // POOL_ALL fast path / parity: when no cap override, pooledCaps[r] already
    // equals this sum; reading it keeps the exact float the D-01 path used.
    if (cfg.capOverride === null) totalCap = pooledCaps[r] ?? 0;
    if (totalCap <= 0) continue; // Σcaps = 0 — freeze, leave local stocks be.
    const pooledQty = pool[r] ?? 0;
    for (const st of states) {
      if (!isPooledForIsland(cfg, r, st.id)) continue; // non-holders untouched
      const share = (st.storageCaps[r] ?? 0) / totalCap;
      st.inventory[r] = pooledQty * share;
    }
  }
}

/** Per-member, per-segment computed bundle (round 2 — with the union solve). */
interface MemberSegment {
  readonly state: IslandState;
  readonly net: Record<ResourceId, number>;
  readonly production: Record<ResourceId, number>;
  readonly consumption: Record<ResourceId, number>;
  readonly byBuilding: ReturnType<typeof computeRates>['byBuilding'];
  readonly skillMul: ReturnType<typeof cloneSkillMultipliers>;
  readonly batteryIsLocal: boolean;
  readonly rawBalance: number;
  readonly maxCap: number;
  readonly utilById: Map<string, number>;
  readonly localCtx: RatesContext;
}

/**
 * Advance a group of member islands to `nowMs` as ONE unit. Parameterized by
 * the pooling config: `POOL_ALL` reproduces the D-01 lattice path exactly;
 * a partial config pools only the named resource subset (D-02).
 */
function advanceGroup(
  states: ReadonlyArray<IslandState>,
  nowMs: number,
  ctxFor: (state: IslandState) => RatesContext,
  cfg: PoolingConfig,
  wallClockNowMs?: number,
): void {
  if (states.length === 0) return;
  const wallOffset = (wallClockNowMs ?? nowMs) - nowMs;

  // Per-member base skill multiplier (frozen) — the same value advanceIsland
  // reads off its derivations memo.
  const baseMultByIsland = new Map<string, ReturnType<typeof cloneSkillMultipliers>>();
  const varianceActiveByIsland = new Map<string, boolean>();
  for (const st of states) {
    const bm = cloneSkillMultipliers(effectiveSkillMultipliers(st));
    Object.freeze(bm);
    baseMultByIsland.set(st.id, bm);
    varianceActiveByIsland.set(st.id, ctxFor(st).modifierMul?.outputVariance ?? false);
  }

  // §reactor-toxicity rolls + §12.4 grace shrink + pre-first-segment
  // auto-maintain, per member (mirrors advanceIsland's pre-loop block).
  for (const st of states) {
    const base = ctxFor(st);
    const defs = base.defs ?? BUILDING_DEFS;
    if (base.worldSeed) advanceToxicityRolls(st.buildings, base.worldSeed, st.lastTick, nowMs);
    const thresholdMul = (baseMultByIsland.get(st.id)!).maintenanceThreshold;
    const target = pickMostDegradedTarget(st.buildings, defs, thresholdMul);
    if (target !== null) {
      tryAutoMaintain(target, defs[target.defId], st.inventory, st.lastTick, thresholdMul);
    }
  }

  // Lockstep timeline starts at the EARLIEST member lastTick.
  let t = Infinity;
  for (const st of states) t = Math.min(t, st.lastTick);
  if (t >= nowMs) {
    for (const st of states) st.lastTick = nowMs;
    return;
  }

  for (let safety = 0; safety < 100_000; safety++) {
    if (t >= nowMs) break;

    // Pooled regime for THIS segment (restricted to pooled resources; non-
    // pooled resources are absent ⇒ economy reads them locally per-key).
    const pool = pooledInventory(states, cfg);
    const pooledCaps = pooledCapsMap(states, cfg);

    // ---- Round 1: each member computes its OWN flow specs at the pooled
    // regime (only `flowSpecs` is read). The inventory/caps override is
    // PER-ISLAND: it carries pooled values only for resources THIS island
    // pools (node-holder for r); resources it doesn't pool are omitted, so the
    // economy's per-key fallback reads them from local state.
    const ownSpecs = new Map<string, ReadonlyArray<FlowBuildingSpec>>();
    for (const st of states) {
      const base = ctxFor(st);
      const ctx: RatesContext = {
        ...base,
        accelerationMul: st.accelerationRemainingMin > 0 ? 3 : 1,
        baseMult: baseMultByIsland.get(st.id),
        inventory: islandPooledView(st, pool, cfg),
        caps: islandPooledView(st, pooledCaps, cfg),
      };
      const res = computeRates(st, ctx, t, t + wallOffset);
      ownSpecs.set(st.id, res.flowSpecs);
    }

    // ---- Round 2: each member solves with the UNION (its own buildings +
    // every OTHER member's flow specs as `flowSiblings`). Under PARTIAL
    // pooling the sibling specs are RESOURCE-FILTERED to the pooled set so a
    // building consuming a NON-shared resource never throttles cross-island.
    const segs: MemberSegment[] = [];
    for (const st of states) {
      const base = ctxFor(st);
      const siblings: FlowBuildingSpec[] = [];
      for (const other of states) {
        if (other.id === st.id) continue;
        const s = ownSpecs.get(other.id);
        if (!s) continue;
        for (const e of s) {
          // A sibling flow on `other` only unions across islands for the
          // resources `other` POOLS (node-holder). A resource `other` keeps
          // local must not appear in the union — it never throttles against
          // anyone else's stock. Filter by `other`'s membership.
          const filtered = filterSpecToPooled(e, cfg, other.id);
          if (filtered) siblings.push(filtered);
        }
      }
      const localCtx: RatesContext = {
        ...base,
        accelerationMul: st.accelerationRemainingMin > 0 ? 3 : 1,
        baseMult: baseMultByIsland.get(st.id),
        inventory: islandPooledView(st, pool, cfg),
        caps: islandPooledView(st, pooledCaps, cfg),
        flowSiblings: siblings,
      };
      const res = computeRates(st, localCtx, t, t + wallOffset);

      const skillMul = cloneSkillMultipliers(effectiveSkillMultipliers(st));
      layerConditionalBonuses(skillMul, st, base.world, DEFAULT_GRAPH, t + wallOffset);
      const maxCap = batteryCapacityWs(st, skillMul);
      const rawBalance = res.power.rawProduced - res.power.rawConsumed;
      const batteryIsLocal = !(base.cableComponent?.unified);

      const utilById = new Map<string, number>();
      for (const br of res.byBuilding) utilById.set(br.building.id, br.utilization);

      const online = t >= st.lastTick - 1e-9;
      const net = online ? res.net : ({} as Record<ResourceId, number>);

      segs.push({
        state: st,
        net,
        production: res.production,
        consumption: res.consumption,
        byBuilding: res.byBuilding,
        skillMul,
        batteryIsLocal,
        rawBalance,
        maxCap,
        utilById,
        localCtx,
      });
    }

    // ---- Pooled net flow = Σ member nets, restricted to each member's POOLED
    // resources (node-holders). A non-holder's net for r is NOT summed here —
    // it integrates locally below.
    const pooledNet = {} as Record<ResourceId, number>;
    for (const seg of segs) {
      for (const [r, rate] of Object.entries(seg.net)) {
        if (!isPooledForIsland(cfg, r as ResourceId, seg.state.id)) continue;
        pooledNet[r as ResourceId] = (pooledNet[r as ResourceId] ?? 0) + (rate ?? 0);
      }
    }

    // ---- Segment end = min over members of (resource event over the
    // per-member COMBINED view — pooled stock+net for pooled resources, local
    // stock+net for the rest — plus that member's maintenance/construction/
    // battery/phase/solar/accel/rotation/shot boundaries) and nowMs.
    let segEndMs = nowMs;
    for (const seg of segs) {
      const st = seg.state;
      const base = ctxFor(st);

      // Combined inventory + net: pooled values for the resources THIS member
      // pools, its own local values for the rest. For POOL_ALL this is exactly
      // `pool` / `pooledNet` (byte-identical D-01 path).
      const combinedInv = combinedInventoryFor(st, pool, cfg);
      const combinedNet = combinedNetFor(seg.state.id, seg.net, pooledNet, cfg);

      const memberEvent = findNextCapEvent(
        st,
        combinedNet,
        t,
        nowMs,
        seg.localCtx,
        seg.utilById,
        combinedInv,
      );
      if (memberEvent < segEndMs) segEndMs = memberEvent;

      // A member whose own lastTick is still ahead of the current segment
      // start has not "joined" the lockstep yet. Split at its join moment so
      // per-member factors are constant and the online guard below is exact.
      if (st.lastTick > t) {
        const e = st.lastTick;
        if (e < segEndMs) segEndMs = e;
      }

      // §3.5 high_wind variance re-samples once per second; clamp the segment
      // so the variance factor stays constant inside it.
      if (varianceActiveByIsland.get(st.id)) {
        const e = (Math.floor(t / 1000) + 1) * 1000;
        if (e < segEndMs) segEndMs = e;
      }

      // §13.3 battery boundary (local only).
      if (seg.batteryIsLocal) {
        if (seg.rawBalance > 0 && seg.maxCap > 0 && st.batteryStoredWs < seg.maxCap) {
          const fillTimeSec = (seg.maxCap - st.batteryStoredWs) / seg.rawBalance;
          const e = t + fillTimeSec * 1000;
          if (e < segEndMs) segEndMs = e;
        } else if (seg.rawBalance < 0 && st.batteryStoredWs >= BATTERY_EMPTY_THRESHOLD_WS && seg.maxCap > 0) {
          const depletionTimeSec = st.batteryStoredWs / -seg.rawBalance;
          const e = t + depletionTimeSec * 1000;
          if (e < segEndMs) segEndMs = e;
        }
      }

      // §2.7 phase + solar-ramp boundaries (wall-clock anchored).
      const lat = base.world?.playerLat ?? null;
      const lon = base.world?.playerLon ?? null;
      const phase = nextRealPhaseBoundaryMs(t + wallOffset, lat, lon) - wallOffset;
      if (phase < segEndMs) segEndMs = phase;
      const solarWall = nextSolarBoundaryMs(t + wallOffset);
      if (solarWall !== null) {
        const solar = solarWall - wallOffset;
        if (solar < segEndMs) segEndMs = solar;
      }

      // §13.3 acceleration boundary.
      if (st.accelerationRemainingMin > 0) {
        const e = t + st.accelerationRemainingMin * 60 * 1000;
        if (e < segEndMs) segEndMs = e;
      }

      // §8.10 rotating-output boundary.
      const defs = base.defs ?? BUILDING_DEFS;
      for (const b of st.buildings) {
        if (b.invalid) continue;
        const recipe = resolveRecipe(defs[b.defId], b, base.terrainAt);
        if (!recipe) continue;
        const boundary = nextRotateOutputBoundaryMs(recipe, t);
        if (boundary !== null && boundary < segEndMs) segEndMs = boundary;
      }

      // terrain_modifier v5 shot boundary.
      for (const b of st.buildings) {
        const rem = b.terrainShotRemainingMs;
        if (rem !== undefined && rem > 0) {
          const fireT = t + rem;
          if (fireT < segEndMs) segEndMs = fireT;
        }
      }
    }

    const dtSec = (segEndMs - t) / 1000;
    if (dtSec > 0) {
      // ---- Pooled integration (pooled resources): integrate the pooled
      // inventory by the pooled net over dt, clamped to pooled caps, via a
      // synthetic state so we reuse `applyRates`' exact clamp semantics.
      // The synthetic state MUST have its own `everProduced` Set — sharing the
      // reference with member 0 would mis-attribute every pooled resource to
      // island 0 and starve the real producer.
      const poolState: IslandState = {
        ...segs[0]!.state,
        inventory: { ...pool },
        storageCaps: pooledCaps,
        everProduced: new Set<ResourceId>(),
      };
      applyRates(poolState, pooledNet, dtSec, pooledCaps, baseMultByIsland.get(segs[0]!.state.id));
      distributePooled(states, poolState.inventory, pooledCaps, cfg);

      // Attribute pooled everProduced entries to the actual producing members,
      // not to the synthetic pool state or member 0.
      for (const seg of segs) {
        for (const [r, rate] of Object.entries(seg.net)) {
          const rid = r as ResourceId;
          if ((rate ?? 0) <= 0) continue;
          if (!isPooledForIsland(cfg, rid, seg.state.id)) continue;
          seg.state.everProduced.add(rid);
        }
      }

      // ---- Local integration (NON-pooled resources): each member integrates
      // its own non-pooled net against its OWN inventory + caps. For POOL_ALL
      // every net entry is pooled, so `localNet` is empty and this is a no-op
      // (byte-identical D-01 path).
      for (const seg of segs) {
        const localNet = localNetFor(seg.state.id, seg.net, cfg);
        if (Object.keys(localNet).length > 0) {
          applyRates(seg.state, localNet, dtSec, undefined, baseMultByIsland.get(seg.state.id));
        }
      }

      // ---- Per-member side effects on that member's OWN production.
      // Offline members (their own lastTick is still ahead of this segment)
      // must not accrue XP, wear, CO₂, or battery charge for pre-join time.
      // Construction ticks and terrain-shot counters still run (they are not
      // gated by production), so we pass empty production/byBuilding/util and
      // zero rawBalance instead of skipping the call.
      for (const seg of segs) {
        const st = seg.state;
        const online = t >= st.lastTick - 1e-9;
        const effectByBuilding = online ? seg.byBuilding : [];
        const effectProduction = online ? seg.production : ({} as Record<ResourceId, number>);
        const effectConsumption = online ? seg.consumption : ({} as Record<ResourceId, number>);
        const effectUtilById = online ? seg.utilById : new Map<string, number>();
        const effectRawBalance = online ? seg.rawBalance : 0;
        applySegmentSideEffects(
          st,
          effectByBuilding,
          effectProduction,
          effectConsumption,
          dtSec,
          segEndMs,
          t,
          seg.localCtx,
          seg.skillMul,
          seg.batteryIsLocal,
          effectRawBalance,
          seg.maxCap,
          effectUtilById,
        );
      }
    }

    const segStartMs = t;
    if (segEndMs <= t) {
      t = nowMs;
    } else {
      t = segEndMs;
    }

    // Per-member acceleration-queue consumption + per-segment-boundary
    // auto-maintenance (mirrors advanceIsland's tail).
    for (const seg of segs) {
      const st = seg.state;
      if (st.accelerationRemainingMin > 0) {
        const nextAccelMs = segStartMs + st.accelerationRemainingMin * 60 * 1000;
        const consumedMin = dtSec / 60;
        st.accelerationRemainingMin -= consumedMin;
        if (st.accelerationRemainingMin <= 0 || nextAccelMs <= segEndMs) {
          st.accelerationRemainingMin = 0;
          const next = st.accelerationQueue.shift();
          if (next) st.accelerationRemainingMin = next.durationMin;
        }
      }
      const base = ctxFor(st);
      const defs = base.defs ?? BUILDING_DEFS;
      const thresholdMul = (baseMultByIsland.get(st.id)!).maintenanceThreshold;
      const target = pickMostDegradedTarget(st.buildings, defs, thresholdMul);
      if (target !== null) {
        tryAutoMaintain(target, defs[target.defId], st.inventory, t, thresholdMul);
      }
    }
  }

  for (const st of states) st.lastTick = nowMs;
}

/** Per-island pooled override for `computeRates`: pooled values only for the
 *  resources `st` POOLS (node-holder for r); resources it keeps local are
 *  OMITTED so the economy's per-key fallback (`ctx.x?.[r] ?? local`) reads
 *  them from `st`. For POOL_ALL this returns `source` directly (every resource
 *  pooled — byte-identical D-01 path). */
function islandPooledView(
  st: IslandState,
  source: Record<ResourceId, number>,
  cfg: PoolingConfig,
): Record<ResourceId, number> {
  if (cfg.resources === null) return source; // POOL_ALL — D-01
  const out = {} as Record<ResourceId, number>;
  for (const [r, v] of Object.entries(source)) {
    if (isPooledForIsland(cfg, r as ResourceId, st.id)) out[r as ResourceId] = v ?? 0;
  }
  return out;
}

/** Filter a member's flow spec to the entries `islandId` POOLS. Returns null if
 *  nothing pooled remains (the building's cross-island contribution is entirely
 *  local to its island). For POOL_ALL the spec passes through unchanged. */
function filterSpecToPooled(
  spec: FlowBuildingSpec,
  cfg: PoolingConfig,
  islandId: string,
): FlowBuildingSpec | null {
  if (cfg.resources === null) return spec; // pool-all: identity (D-01)
  const produces: Record<string, number> = {};
  const consumes: Record<string, number> = {};
  let any = false;
  for (const [r, v] of Object.entries(spec.produces)) {
    if (isPooledForIsland(cfg, r as ResourceId, islandId)) { produces[r] = v; any = true; }
  }
  for (const [r, v] of Object.entries(spec.consumes)) {
    if (isPooledForIsland(cfg, r as ResourceId, islandId)) { consumes[r] = v; any = true; }
  }
  return any ? { produces, consumes } : null;
}

/** Member's view of inventory for the boundary scan: pooled value for the
 *  resources this member pools, local value for the rest. POOL_ALL ⇒ exactly
 *  `pool`. */
function combinedInventoryFor(
  st: IslandState,
  pool: Record<ResourceId, number>,
  cfg: PoolingConfig,
): Record<ResourceId, number> {
  if (cfg.resources === null) return pool;
  const out = {} as Record<ResourceId, number>;
  // Loop 1: emit ONLY the resources this member does NOT pool (its local
  // values). The pooled resources are filled by loop 2 below — emitting them
  // here too would be a dead write (loop 2 overwrites, and a held pooled key
  // may be absent from local inventory anyway).
  for (const [r, v] of Object.entries(st.inventory)) {
    if (!isPooledForIsland(cfg, r as ResourceId, st.id)) out[r as ResourceId] = v ?? 0;
  }
  // Loop 2: overlay all pooled keys this member holds (the authoritative
  // pooled value).
  for (const [r, v] of Object.entries(pool)) {
    if (isPooledForIsland(cfg, r as ResourceId, st.id)) out[r as ResourceId] = v;
  }
  return out;
}

/** Combined net for the boundary scan: pooled net for the resources this
 *  member pools, its own net for the rest. POOL_ALL ⇒ exactly `pooledNet`. */
function combinedNetFor(
  islandId: string,
  memberNet: Record<ResourceId, number>,
  pooledNet: Record<ResourceId, number>,
  cfg: PoolingConfig,
): Record<ResourceId, number> {
  if (cfg.resources === null) return pooledNet;
  const out = {} as Record<ResourceId, number>;
  for (const [r, v] of Object.entries(memberNet)) {
    if (!isPooledForIsland(cfg, r as ResourceId, islandId)) out[r as ResourceId] = v ?? 0;
  }
  for (const [r, v] of Object.entries(pooledNet)) {
    if (isPooledForIsland(cfg, r as ResourceId, islandId)) out[r as ResourceId] = v ?? 0;
  }
  return out;
}

/** This member's net restricted to the resources it does NOT pool (integrated
 *  locally). POOL_ALL ⇒ empty. */
function localNetFor(
  islandId: string,
  memberNet: Record<ResourceId, number>,
  cfg: PoolingConfig,
): Record<ResourceId, number> {
  const out = {} as Record<ResourceId, number>;
  if (cfg.resources === null) return out;
  for (const [r, v] of Object.entries(memberNet)) {
    if (!isPooledForIsland(cfg, r as ResourceId, islandId)) out[r as ResourceId] = v ?? 0;
  }
  return out;
}

/**
 * Advance a group of active-lattice member islands to `nowMs` as ONE unit
 * (D-01). Pools ALL resources across members. See module header.
 *
 * @param states  the member island states (≥ 1).
 * @param nowMs   perf-domain target time.
 * @param ctxFor  per-member base RatesContext (this function INJECTS
 *                `inventory`/`caps`/`baseMult`/`accelerationMul`/`flowSiblings`).
 * @param wallClockNowMs  §2.7 wall-clock anchor for `nowMs`.
 */
export function advanceLatticeGroup(
  states: ReadonlyArray<IslandState>,
  nowMs: number,
  ctxFor: (state: IslandState) => RatesContext,
  wallClockNowMs?: number,
): void {
  advanceGroup(states, nowMs, ctxFor, POOL_ALL, wallClockNowMs);
}

/**
 * D-02 — advance a non-lattice cross-island shared-network participant group
 * to `nowMs` as ONE unit, pooling ONLY the shared-resource subset. Every
 * NON-shared resource stays strictly local. See module header + shared-network-
 * advance.ts (this is exported there as `advanceSharedNetworkGroup`).
 *
 * @param sharedResources  resources behind the active `crossIslandShared`
 *                         skill nodes (sharedInventory ∪ sharedStorageCap).
 * @param sharedCaps       Σ-cap override from `sharedStorageCap` (per resource).
 * @param holders          per-resource POOLING MEMBERSHIP — `holders.get(r)`
 *                         is the set of island ids that hold a `sharedInventory`
 *                         node for `r`. ONLY those islands pool `r`; others keep
 *                         `r` strictly local (D-02 node-holder rule).
 */
export function advanceSharedGroup(
  states: ReadonlyArray<IslandState>,
  nowMs: number,
  ctxFor: (state: IslandState) => RatesContext,
  sharedResources: ReadonlySet<ResourceId>,
  sharedCaps: ReadonlyMap<ResourceId, number>,
  holders: ReadonlyMap<ResourceId, ReadonlySet<string>>,
  wallClockNowMs?: number,
): void {
  advanceGroup(
    states,
    nowMs,
    ctxFor,
    { resources: sharedResources, capOverride: sharedCaps, holders },
    wallClockNowMs,
  );
}
