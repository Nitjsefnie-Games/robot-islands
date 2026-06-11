// §13.3 D-01 — Omniscient Lattice grouped lockstep advance.
//
// Design: docs/superpowers/specs/2026-06-10-lattice-shared-flow-design.md
//
// Pure layer: no PixiJS, no DOM. Imports the economy integrator's exported
// primitives (computeRates / findNextCapEvent / applyRates /
// applySegmentSideEffects) plus the segment-boundary helpers, and orchestrates
// them across a SET of lattice member islands as ONE net-flow problem.
//
// Why this exists (the D-01 bug): with the Lattice active, members' economy
// reads use the unified pool (ctx.inventory / ctx.caps overrides), but the
// per-island `applyRates` decremented only the LOCAL island — a member with
// zero local stock ran forever off a partner's stock that never shrank
// (matter from nothing). The fix:
//
//   1. UNION SOLVE — each member's pass-2.5 flow solve is fed the union of all
//      members' flow coefficients (via `ctx.flowSiblings`), with cap/zero
//      regimes computed from POOLED inventory vs POOLED caps. Cross-island
//      producers/consumers throttle against each other exactly like
//      same-island flows. The flow solver itself is unchanged.
//   2. POOLED INTEGRATION — the segment's net flows are summed across members
//      and integrated ONCE against the pooled inventory (clamped to pooled
//      caps), so mass is conserved by construction.
//   3. CAP-PROPORTIONAL DISTRIBUTION — after each segment the pooled quantity
//      of each resource is written back to members as
//      `local_i = pooled × cap_i / Σcaps`; resources with `Σcaps = 0` keep
//      their local stocks untouched. No persistence schema bump — saves
//      already store the distributed per-island inventories.
//   4. PER-ISLAND ATTRIBUTION UNCHANGED — XP, wear, maintenance, CO₂, battery,
//      construction all run per-member on that member's own
//      production/byBuilding via the shared `applySegmentSideEffects`.
//
// Non-lattice islands are untouched: they advance via `advanceIsland` exactly
// as before. This module is only invoked for the active-lattice member group.

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

/** Build the pooled (Σ over members) inventory map. */
function pooledInventory(states: ReadonlyArray<IslandState>): Record<ResourceId, number> {
  const out = {} as Record<ResourceId, number>;
  for (const st of states) {
    for (const [r, amt] of Object.entries(st.inventory)) {
      out[r as ResourceId] = (out[r as ResourceId] ?? 0) + (amt ?? 0);
    }
  }
  return out;
}

/** Build the pooled (Σ over members) storage-cap map. */
function pooledCapsMap(states: ReadonlyArray<IslandState>): Record<ResourceId, number> {
  const out = {} as Record<ResourceId, number>;
  for (const st of states) {
    for (const [r, amt] of Object.entries(st.storageCaps)) {
      out[r as ResourceId] = (out[r as ResourceId] ?? 0) + (amt ?? 0);
    }
  }
  return out;
}

/**
 * §13.3 D-01 cap-proportional distribution. Write the pooled quantity of each
 * resource back to member inventories as `local_i = pooled × cap_i / Σcaps`.
 * Resources where `Σcaps = 0` keep their existing local stocks untouched (the
 * design's freeze case — pooled stock has no cap home to land in).
 */
function distributePooled(
  states: ReadonlyArray<IslandState>,
  pool: Record<ResourceId, number>,
): void {
  // Resource universe: every key present in the pool OR in any member's caps.
  const resources = new Set<ResourceId>();
  for (const r of Object.keys(pool)) resources.add(r as ResourceId);
  for (const st of states) for (const r of Object.keys(st.storageCaps)) resources.add(r as ResourceId);

  for (const r of resources) {
    let totalCap = 0;
    for (const st of states) totalCap += st.storageCaps[r] ?? 0;
    if (totalCap <= 0) continue; // Σcaps = 0 — freeze, leave local stocks be.
    const pooledQty = pool[r] ?? 0;
    for (const st of states) {
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
 * Advance a group of active-lattice member islands to `nowMs` as ONE unit.
 *
 * @param states  the member island states (≥ 1). Single-member groups behave
 *                like a normal advance (pool = the one island).
 * @param nowMs   perf-domain target time (all members advance to this).
 * @param ctxFor  per-member base RatesContext (modifierMul / terrainAt /
 *                crossIsland / geothermal / solarBoost / cableComponent /
 *                world / worldSeed / onTerrainShotFire …). This function
 *                INJECTS `inventory` (pooled), `caps` (pooled), `baseMult`,
 *                `accelerationMul`, and `flowSiblings` (the union) on top.
 * @param wallClockNowMs  §2.7 wall-clock anchor for `nowMs` (Date.now()
 *                domain). Omitted ⇒ falls back to `nowMs` (the test
 *                convention).
 */
export function advanceLatticeGroup(
  states: ReadonlyArray<IslandState>,
  nowMs: number,
  ctxFor: (state: IslandState) => RatesContext,
  wallClockNowMs?: number,
): void {
  if (states.length === 0) return;
  const wallOffset = (wallClockNowMs ?? nowMs) - nowMs;

  // Per-member base skill multiplier (frozen) — the same value advanceIsland
  // reads off its derivations memo (memo.baseSkillMul === effectiveSkillMultipliers).
  const baseMultByIsland = new Map<string, ReturnType<typeof cloneSkillMultipliers>>();
  for (const st of states) {
    const bm = cloneSkillMultipliers(effectiveSkillMultipliers(st));
    Object.freeze(bm);
    baseMultByIsland.set(st.id, bm);
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

  // Lockstep timeline starts at the EARLIEST member lastTick. Members tick
  // together in production, so these are equal; the min keeps a stray
  // earlier-stamped member from being skipped, and the per-member
  // `t >= st.lastTick` guard below stops a later-stamped member from
  // integrating before it came online.
  let t = Infinity;
  for (const st of states) t = Math.min(t, st.lastTick);
  if (t >= nowMs) {
    for (const st of states) st.lastTick = nowMs;
    return;
  }

  for (let safety = 0; safety < 100_000; safety++) {
    if (t >= nowMs) break;

    // Pooled regime for THIS segment — rebuilt each segment because the
    // previous segment's integrate+distribute changed member inventories.
    const pool = pooledInventory(states);
    const pooledCaps = pooledCapsMap(states);

    // ---- Round 1: each member computes its OWN flow specs at the pooled
    // regime (gate-1 coefficients are independent of the solve, so round-1
    // gates don't matter — only `flowSpecs` is read).
    const ownSpecs = new Map<string, ReadonlyArray<FlowBuildingSpec>>();
    for (const st of states) {
      const base = ctxFor(st);
      const ctx: RatesContext = {
        ...base,
        accelerationMul: st.accelerationRemainingMin > 0 ? 3 : 1,
        baseMult: baseMultByIsland.get(st.id),
        inventory: pool,
        caps: pooledCaps,
      };
      const res = computeRates(st, ctx, t, t + wallOffset);
      ownSpecs.set(st.id, res.flowSpecs);
    }

    // ---- Round 2: each member solves with the UNION (its own buildings +
    // every OTHER member's flow specs as `flowSiblings`).
    const segs: MemberSegment[] = [];
    for (const st of states) {
      const base = ctxFor(st);
      // Union of siblings = all members' own specs except this one's.
      const siblings: FlowBuildingSpec[] = [];
      for (const other of states) {
        if (other.id === st.id) continue;
        const s = ownSpecs.get(other.id);
        if (s) for (const e of s) siblings.push(e);
      }
      const localCtx: RatesContext = {
        ...base,
        accelerationMul: st.accelerationRemainingMin > 0 ? 3 : 1,
        baseMult: baseMultByIsland.get(st.id),
        inventory: pool,
        caps: pooledCaps,
        flowSiblings: siblings,
      };
      const res = computeRates(st, localCtx, t, t + wallOffset);

      // Per-member battery + skill-mul (mirrors advanceIsland's per-segment
      // recompute). Battery is inert under a unified cable component.
      const skillMul = cloneSkillMultipliers(effectiveSkillMultipliers(st));
      layerConditionalBonuses(skillMul, st, base.world, DEFAULT_GRAPH, t + wallOffset);
      const maxCap = batteryCapacityWs(st, skillMul);
      const rawBalance = res.power.rawProduced - res.power.rawConsumed;
      const batteryIsLocal = !(base.cableComponent?.unified);

      const utilById = new Map<string, number>();
      for (const br of res.byBuilding) utilById.set(br.building.id, br.utilization);

      // A member not yet online in this timeline contributes no flow.
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

    // ---- Pooled net flow = Σ member nets.
    const pooledNet = {} as Record<ResourceId, number>;
    for (const seg of segs) {
      for (const [r, rate] of Object.entries(seg.net)) {
        pooledNet[r as ResourceId] = (pooledNet[r as ResourceId] ?? 0) + (rate ?? 0);
      }
    }

    // ---- Segment end = min over all members of (pooled resource event,
    // that member's own maintenance/construction boundaries, battery, phase,
    // solar, accel, rotation, shot) and nowMs.
    let segEndMs = nowMs;
    for (const seg of segs) {
      const st = seg.state;
      const base = ctxFor(st);
      // Resource events over the POOLED inventory + pooled caps; the
      // per-member maintenance/construction boundaries are folded in by
      // findNextCapEvent itself (it walks st.buildings).
      const evCtx: RatesContext = {
        ...seg.localCtx,
      };
      const memberEvent = findNextCapEvent(
        st,
        pooledNet,
        t,
        nowMs,
        evCtx,
        seg.utilById,
        pool, // pooled-inventory view for the resource-boundary scan
      );
      if (memberEvent < segEndMs) segEndMs = memberEvent;

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
      // ---- Pooled integration: integrate the pooled inventory by the pooled
      // net over dt, clamped to pooled caps. We model the pool as a synthetic
      // state so we can reuse `applyRates`' exact clamp semantics.
      // NB (storage-category catMul): `applyRates` clamps via
      // `cap(poolState, r, pooledCaps, …, baseMult₀)`, which applies ISLAND-0's
      // storage-category skill multiplier to the summed raw caps. With
      // heterogeneous member storage-category skills the pooled clamp is thus
      // `Σcaps × catMul₀`, not Σ(caps_i × catMul_i). This is deliberate — it
      // matches the `latticeStorageCaps` raw-sum eligibility convention the
      // pool's cap/zero regimes are already computed against, so the integrate
      // bound and the eligibility regime stay consistent.
      const poolState: IslandState = { ...segs[0]!.state, inventory: { ...pool }, storageCaps: pooledCaps };
      applyRates(poolState, pooledNet, dtSec, pooledCaps, baseMultByIsland.get(segs[0]!.state.id));

      // ---- Cap-proportional distribution back to members.
      distributePooled(states, poolState.inventory);

      // ---- Per-member side effects (XP / wear / CO₂ / battery / construction
      // / level-up / terrain shots) on that member's OWN production. These do
      // NOT touch inventory (the pool already integrated + distributed).
      for (const seg of segs) {
        applySegmentSideEffects(
          seg.state,
          seg.byBuilding,
          seg.production,
          seg.consumption,
          dtSec,
          segEndMs,
          t,
          seg.localCtx,
          seg.skillMul,
          seg.batteryIsLocal,
          seg.rawBalance,
          seg.maxCap,
          seg.utilById,
        );
      }
    }

    // Segment-start time, captured BEFORE the timeline advances — the accel
    // boundary below is anchored here exactly as advanceIsland anchors its
    // `nextAccelMs` at the segment-prep `t` (economy.ts).
    const segStartMs = t;
    // Advance the shared timeline.
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
        // §13.3 accel boundary, computed from the START-of-segment remaining
        // (matches advanceIsland's `nextAccelMs = t + remaining*60_000` taken
        // at segment-prep, before the decrement below).
        const nextAccelMs = segStartMs + st.accelerationRemainingMin * 60 * 1000;
        const consumedMin = dtSec / 60;
        st.accelerationRemainingMin -= consumedMin;
        // Mirror advanceIsland's FULL pop condition exactly: pop on the
        // remaining-minutes drain OR when the segment landed on/after the
        // accel boundary (the `nextAccelMs <= segEndMs` disjunct guards the
        // float-residue case where subtraction leaves a sub-epsilon sliver).
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
