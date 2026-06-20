// Heat-source adjacency resolution per SPEC §5.2.
//
// Heat is NOT a grid. It is an M:N adjacency relationship (rev #114) between
// heat-consuming buildings (Blast Furnace, Pyroforge, Coke Oven, …) and
// heat-source buildings (Coal Furnace, Geothermal Vent, Plasma Heater, Fusion
// Core). A kW-demand consumer POOLS heat from every adjacent source; a source's
// finite output is shared among the consumers contending for it. Both sides
// floor-scale: capacity = thermalKW·(1+L_source), demand = heatDemandKW·(1+L_c).
//
// Algorithm (§5.2):
//
//   - Boolean-heat consumers (no heatDemandKW): legacy N:1 — need one adjacent
//     source (free-first, else cheapest-coal lowest-id), throttle 1, bill a full
//     coalPerCycle, occupy ZERO thermal capacity.
//   - kW-demand consumers: floor-scaled flow allocation. Fill each consumer's
//     demand in cost order (free, then coal cheapest-coalPerCycle-first); a
//     contended source splits its capacity proportionally among its adjacent
//     consumers, iterated to a fixpoint against a fixed per-pass snapshot.
//     throttle = min(1, served/demand); below MIN_HEAT_FACTOR the consumer
//     stalls (and is un-billed). Coal bills ∝ delivered heat:
//     coalPerCycle·(delivered/thermalKW), returned as a fractional served-count.
//
// Pure module — no PixiJS, no DOM.
//
// Catalog asymmetry note: this resolver reads `requiresHeat` / `heatSource`
// from the canonical `BUILDING_DEFS` table, NOT from the per-call `defs`
// catalog override threaded through `computeRates`/`RatesContext`. That's
// intentional — heat-source / heat-consumer status is treated as a static
// catalog fact (intrinsic to a defId), unlike `power` which test fixtures
// commonly override to isolate non-power code paths. If a future test needs
// to disable heat for a def, it should mutate the catalog imports directly,
// or strip `requiresHeat` from the def via the same `{ requiresHeat: _, ...rest }`
// idiom the economy tests use for `power`.

import { BUILDING_DEFS } from './building-defs.js';
import type { PlacedBuilding } from './buildings.js';
import { activeFloorLevel } from './floor-levels.js';
import { footprintTiles, type Rotation } from './shape-mask.js';

/**
 * Result of heat-assignment resolution for an island's current building list.
 *
 *   - `hasHeat[buildingId]` is `true` iff the consumer at that id has an
 *     adjacent heat source (free or coal) and may therefore operate.
 *     Non-heat-requiring buildings are absent from the map.
 *   - `coalConsumersByFurnace[furnaceId]` is the furnace's fuel served-count
 *     (rev #114): Σ over served kW-demand consumers of `delivered/thermalKW`,
 *     plus 1 per boolean-heat consumer assigned to it — i.e. fractional, not an
 *     integer count. Downstream multiplies `coalPerCycle × served-count` for the
 *     per-cycle coal burn. Furnaces serving nothing are absent (treat as 0).
 *   - `assignedSource[consumerId]` records WHICH source each consumer is
 *     assigned to (free or coal). Drives the inspector's "adjacent: <id>"
 *     readout. Non-heat-requiring buildings and unassigned (hasHeat=false)
 *     consumers are absent.
 */
export interface HeatAssignments {
  readonly hasHeat: Map<string, boolean>;
  readonly coalConsumersByFurnace: Map<string, number>;
  readonly assignedSource: Map<string, string>;
  /** §perf-2026-05-28: Per-consumer throttle factor ∈ [0, 1] from
   *  the rev-16 §5.1 proportional-budget resolver. Missing key reads
   *  as 1.0. Below MIN_HEAT_FACTOR the consumer brownouts (computeRates
   *  zeros baseRate — wired in Phase 3 commit 3). */
  readonly heatThrottleFactor: Map<string, number>;
  /** Per-SOURCE total kW currently delivered to its adjacent consumers (Σ of
   *  this source's allocations). Drives the inspector's "produced N kW / cap
   *  M kW" readout. A source serving nothing is absent (treat as 0). Capacity
   *  itself is `thermalKW · (1 + L_source)` — derive from the def + floor. */
  readonly deliveredBySource: Map<string, number>;
}

/** Empty result, used when an island has no consumers + no sources. */
export const EMPTY_HEAT_ASSIGNMENTS: HeatAssignments = {
  hasHeat: new Map(),
  coalConsumersByFurnace: new Map(),
  assignedSource: new Map(),
  heatThrottleFactor: new Map(),
  deliveredBySource: new Map(),
};

/** §perf-2026-05-28: brownout threshold per rev-16 §5.1. A consumer
 *  whose proportional throttle factor falls below this value is treated
 *  by computeRates as fully stalled (baseRate=0). Above the threshold,
 *  the consumer runs at `factor × nominal rate`. Exported for tests. */
export const MIN_HEAT_FACTOR = 0.1;

/** All footprint tiles a building occupies, computed via `footprintTiles` with
 *  the building's shape mask and rotation. Returned as a Set of
 *  "x,y" keys for O(1) membership tests during border-overlap checks. */
function footprintKeySet(b: PlacedBuilding): Set<string> {
  const def = BUILDING_DEFS[b.defId];
  const rot = (b.rotation ?? 0) as Rotation;
  const tiles = footprintTiles(def.footprint, b.x, b.y, rot);
  const out = new Set<string>();
  for (const t of tiles) out.add(`${t.x},${t.y}`);
  return out;
}

/** 4-neighbor border tiles of a footprint, EXCLUDING tiles that are part of
 *  the footprint itself. The exclusion matters for >1x1 buildings: a 2x2
 *  footprint's internal cardinal neighbors would otherwise loop back into
 *  the same building, generating spurious "self-adjacency" matches. */
function borderTiles(footprint: Set<string>): Set<string> {
  const border = new Set<string>();
  for (const key of footprint) {
    const [xs, ys] = key.split(',');
    const x = Number(xs);
    const y = Number(ys);
    // 4-neighbor cardinal offsets (N, S, E, W).
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

/** Whether any tile of `source`'s footprint lies in the consumer's `border`
 *  tile set. Pure set intersection probe; O(|sourceFootprint|). */
function sourceTouchesBorder(source: PlacedBuilding, border: Set<string>): boolean {
  const def = BUILDING_DEFS[source.defId];
  const rot = (source.rotation ?? 0) as Rotation;
  const tiles = footprintTiles(def.footprint, source.x, source.y, rot);
  for (const t of tiles) {
    if (border.has(`${t.x},${t.y}`)) return true;
  }
  return false;
}

/**
 * Resolve heat assignments for the given building list per §5.2. Pure: does
 * not mutate any input. Returns a snapshot used downstream by computeRates
 * (consumer gate + per-furnace fuel-burn multiplier) and the inspector UI.
 *
 * `buildings` is an island's PlacedBuilding[] (same array seen by computeRates).
 * Walks every entry once to partition sources from consumers, then walks
 * consumers a second time in lex-sorted-id order to satisfy §5.2's
 * deterministic-assignment requirement.
 */
export function resolveHeatAssignments(
  buildings: ReadonlyArray<PlacedBuilding>,
  geothermalActive: boolean = false,
): HeatAssignments {
  const hasHeat = new Map<string, boolean>();
  const coalConsumersByFurnace = new Map<string, number>();
  const assignedSource = new Map<string, string>();

  // Partition: a building is a consumer if its def has `requiresHeat`; a
  // building is a source if its def has `heatSource`. A def could in theory
  // declare both — none currently do, but the partition handles each axis
  // independently so a future def carrying both flags works.
  const consumers: PlacedBuilding[] = [];
  const freeSources: PlacedBuilding[] = [];
  const coalSources: PlacedBuilding[] = [];
  for (const b of buildings) {
    const def = BUILDING_DEFS[b.defId];
    if (def.requiresHeat) consumers.push(b);
    if (def.heatSource) {
      if (def.heatSource.freeOrCoal === 'free') freeSources.push(b);
      else coalSources.push(b);
    }
  }
  // Lex-sort consumers and coal sources by id for determinism per §5.2
  // ("the engine walks consumers in ascending building-ID order"). Free
  // sources don't need sorting (the first match suffices; no fuel cost).
  const sortedConsumers = [...consumers].sort((a, b) => a.id.localeCompare(b.id));

  if (geothermalActive) {
    const heatThrottleFactor = new Map<string, number>();
    for (const consumer of sortedConsumers) {
      hasHeat.set(consumer.id, true);
      heatThrottleFactor.set(consumer.id, 1);
    }
    return { hasHeat, coalConsumersByFurnace, assignedSource, heatThrottleFactor, deliveredBySource: new Map() };
  }

  if (consumers.length === 0) {
    return { hasHeat, coalConsumersByFurnace, assignedSource, heatThrottleFactor: new Map(), deliveredBySource: new Map() };
  }

  // ── §5.2: floor-scaled, many-sources→one-consumer heat. ──
  // Every heat consumer carries a kW demand (`heatDemandKW`); boolean-heat
  // (adjacency-only, zero-capacity) consumers were retired. Each consumer's
  // floor-scaled demand is met by pooling floor-scaled capacity across ALL
  // adjacent sources (free first, then coal cheapest-first), each source's
  // finite capacity split proportionally among contending consumers. Coal is
  // billed ∝ heat actually delivered.
  //
  // The two floor multipliers MIRROR the power grid (see buildings.ts):
  //   • source capacity = thermalKW · (1 + L)        — floorEffectMul (power OUTPUT)
  //   • consumer demand = heatDemandKW · (1 + 0.5·L) — floorPowerDrawMul (power DRAW)
  // so upgrading a source outpaces upgrading the consumers it feeds, exactly as
  // power production outpaces consumption. Fresh building L=0 → ×1 either way.
  const heatThrottleFactor = new Map<string, number>();
  const EPS = 1e-9;

  const sourceCapacity = (s: PlacedBuilding): number => {
    const t = BUILDING_DEFS[s.defId].heatSource?.thermalKW;
    // floorEffectMul: thermalKW · (1 + L). (null thermalKW ⇒ unbounded source.)
    return t == null ? Infinity : t * (1 + activeFloorLevel(s));
  };
  const consumerDemand = (c: PlacedBuilding): number => {
    const d = BUILDING_DEFS[c.defId].heatDemandKW;
    // floorPowerDrawMul: heatDemandKW · (1 + 0.5·L), matching regular power draw.
    return d == null ? 0 : d * (1 + 0.5 * activeFloorLevel(c));
  };

  // Coal sources cheapest-first (coalPerCycle asc, id) — §5.2 "lowest
  // cost-per-cycle bills first", now governing fill order, not a single pick.
  const sortedCoal = [...coalSources].sort((a, b) => {
    const ca = BUILDING_DEFS[a.defId].heatSource?.coalPerCycle ?? 0;
    const cb = BUILDING_DEFS[b.defId].heatSource?.coalPerCycle ?? 0;
    return ca - cb || a.id.localeCompare(b.id);
  });
  const sortedFree = [...freeSources].sort((a, b) => a.id.localeCompare(b.id));

  // Precompute each consumer's adjacent sources (border ∩ source footprint).
  const adjFree = new Map<string, PlacedBuilding[]>();
  const adjCoal = new Map<string, PlacedBuilding[]>();
  for (const c of sortedConsumers) {
    const border = borderTiles(footprintKeySet(c));
    adjFree.set(c.id, sortedFree.filter((s) => sourceTouchesBorder(s, border)));
    adjCoal.set(c.id, sortedCoal.filter((s) => sourceTouchesBorder(s, border)));
  }

  // Every consumer is kW-demand now (boolean-heat retired). A consumer whose
  // def lacks `heatDemandKW` yields demand 0 — a catalog error (guarded by a
  // test that every `requiresHeat` def carries `heatDemandKW`); it simply gets
  // no allocation and reads as "no heat" rather than crashing.
  const kwConsumers: PlacedBuilding[] = sortedConsumers.filter((c) => consumerDemand(c) > 0);

  // ── kW-demand consumers: floor-scaled M:N flow allocation. ──
  const remDemand = new Map<string, number>();
  for (const c of kwConsumers) remDemand.set(c.id, consumerDemand(c));
  const remCap = new Map<string, number>();
  for (const s of [...sortedFree, ...sortedCoal]) remCap.set(s.id, sourceCapacity(s));
  // alloc[consumerId][sourceId] = kW delivered (drives served, billing, assign).
  const alloc = new Map<string, Map<string, number>>();
  for (const c of kwConsumers) alloc.set(c.id, new Map());

  // Adjacent kW consumers per source (the flow edges), consumer-id ordered.
  const adjConsumers = new Map<string, PlacedBuilding[]>();
  for (const s of [...sortedFree, ...sortedCoal]) {
    adjConsumers.set(s.id, kwConsumers.filter((c) =>
      adjFree.get(c.id)!.some((x) => x.id === s.id) ||
      adjCoal.get(c.id)!.some((x) => x.id === s.id)));
  }

  // Fill in cost order: free tier first, then each coalPerCycle group ascending
  // — cheaper heat consumed before pricier, free before any coal. Within a
  // tier, proportional water-fill iterated to a fixpoint (capping a consumer at
  // its demand frees a shared source's residual for its other neighbours).
  const tiers: PlacedBuilding[][] = [];
  if (sortedFree.length > 0) tiers.push(sortedFree);
  for (let i = 0; i < sortedCoal.length; ) {
    const cost = BUILDING_DEFS[sortedCoal[i]!.defId].heatSource?.coalPerCycle ?? 0;
    const group: PlacedBuilding[] = [];
    while (i < sortedCoal.length &&
           (BUILDING_DEFS[sortedCoal[i]!.defId].heatSource?.coalPerCycle ?? 0) === cost) {
      group.push(sortedCoal[i]!); i++;
    }
    tiers.push(group);
  }

  for (const tier of tiers) {
    for (let pass = 0; pass < 1000; pass++) {
      let progressed = false;
      for (const s of tier) {
        let cap = remCap.get(s.id)!;
        if (cap <= EPS) continue;
        const recv = adjConsumers.get(s.id)!.filter((c) => remDemand.get(c.id)! > EPS);
        if (recv.length === 0) continue;
        let totalRem = 0;
        for (const c of recv) totalRem += remDemand.get(c.id)!;
        if (totalRem <= EPS) continue;
        // Split this pass against a FIXED snapshot of capacity (cap0) and
        // totalRem so every contender gets a true proportional share; consumers
        // capped at their demand leave residual capacity for the next fixpoint
        // pass. (Dividing a running, decremented cap by the original totalRem
        // would skew shares toward whoever is visited first.)
        const cap0 = cap;
        for (const c of recv) {
          const rd = remDemand.get(c.id)!;
          const give = Math.min(rd, cap0 * (rd / totalRem));
          if (give <= EPS) continue;
          remDemand.set(c.id, rd - give);
          cap -= give;
          const m = alloc.get(c.id)!;
          m.set(s.id, (m.get(s.id) ?? 0) + give);
          progressed = true;
        }
        remCap.set(s.id, cap);
      }
      if (!progressed) break;
    }
  }

  // ── Verdict per kW consumer: throttle, stall, assignedSource. ──
  for (const c of kwConsumers) {
    const D = consumerDemand(c);
    const m = alloc.get(c.id)!;
    let served = 0;
    for (const v of m.values()) served += v;
    const throttle = D > 0 ? Math.min(1, served / D) : 1;
    heatThrottleFactor.set(c.id, throttle);
    if (served <= EPS || throttle < MIN_HEAT_FACTOR) {
      // Below the stall floor → no heat; un-bill (clear allocations so the
      // coal-billing pass below counts served consumers only).
      hasHeat.set(c.id, false);
      m.clear();
      continue;
    }
    hasHeat.set(c.id, true);
    // assignedSource = largest contributor (inspector readout); id breaks ties.
    let bestId: string | undefined;
    let bestV = -Infinity;
    for (const [sid, v] of m) {
      if (v > bestV + EPS || (Math.abs(v - bestV) <= EPS && (bestId === undefined || sid < bestId))) {
        bestV = v; bestId = sid;
      }
    }
    if (bestId !== undefined) assignedSource.set(c.id, bestId);
  }

  // ── Per-source delivered kW (inspector "produced N kW" readout) + coal
  // billing ∝ delivered heat. Burn = coalPerCycle·(delivered/thermalKW),
  // returned as a fractional served-count so downstream
  // `coalPerCycle × servedCount / cycle` is unchanged. (Floor cancels: a
  // floor-L furnace at full load delivers thermalKW·(1+L) → served-count 1+L.)
  // Stalled consumers were un-billed (alloc cleared above).
  const deliveredBySource = new Map<string, number>();
  for (const c of kwConsumers) {
    for (const [sid, v] of alloc.get(c.id)!) {
      if (v <= EPS) continue;
      deliveredBySource.set(sid, (deliveredBySource.get(sid) ?? 0) + v);
    }
  }
  for (const s of sortedCoal) {
    const t = BUILDING_DEFS[s.defId].heatSource?.thermalKW;
    if (t == null || t <= 0) continue;
    const delivered = deliveredBySource.get(s.id) ?? 0;
    if (delivered <= EPS) continue;
    coalConsumersByFurnace.set(s.id, (coalConsumersByFurnace.get(s.id) ?? 0) + delivered / t);
  }

  return { hasHeat, coalConsumersByFurnace, assignedSource, heatThrottleFactor, deliveredBySource };
}
