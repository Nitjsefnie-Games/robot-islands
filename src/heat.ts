// Heat-source adjacency resolution per SPEC §5.2.
//
// Heat is NOT a grid. It is an N:1 adjacency relationship between heat-consuming
// buildings (Blast Furnace, Pyroforge, Electric Arc Furnace, Coke Oven) and
// heat-source buildings (Coal Furnace, Geothermal Vent, Plasma Heater, Fusion
// Core). A single source serves any number of adjacent consumers; the source's
// fuel consumption (if any) multiplies by the count of consumers it serves.
//
// Algorithm (§5.2):
//
//   For each consumer in lex-sorted-id order:
//     - Compute the consumer's 4-neighbor border tiles (exclude self-footprint).
//     - Find all source buildings whose footprint overlaps any border tile.
//     - Priority:
//         a) If any FREE source (Geothermal/Plasma/Fusion) is adjacent →
//            hasHeat=true, no fuel cost increment.
//         b) Else if any COAL source is adjacent → hasHeat=true; assign to the
//            lowest-id coal source; increment its served count.
//         c) Else → hasHeat=false. Consumer cannot operate this tick.
//
// Pure module — no PixiJS, no DOM. Imports `footprintTiles` from placement.ts
// and BUILDING_DEFS from building-defs.ts.
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
import { footprintTiles, type Rotation } from './placement.js';

/**
 * Result of heat-assignment resolution for an island's current building list.
 *
 *   - `hasHeat[buildingId]` is `true` iff the consumer at that id has an
 *     adjacent heat source (free or coal) and may therefore operate.
 *     Non-heat-requiring buildings are absent from the map.
 *   - `coalConsumersByFurnace[furnaceId]` is the number of consumers currently
 *     assigned to that coal-burning source. Furnaces with zero served consumers
 *     are absent from the map (callers should treat missing keys as 0).
 *   - `assignedSource[consumerId]` records WHICH source each consumer is
 *     assigned to (free or coal). Drives the inspector's "adjacent: <id>"
 *     readout. Non-heat-requiring buildings and unassigned (hasHeat=false)
 *     consumers are absent.
 */
export interface HeatAssignments {
  readonly hasHeat: Map<string, boolean>;
  readonly coalConsumersByFurnace: Map<string, number>;
  readonly assignedSource: Map<string, string>;
}

/** Empty result, used when an island has no consumers + no sources. */
export const EMPTY_HEAT_ASSIGNMENTS: HeatAssignments = {
  hasHeat: new Map(),
  coalConsumersByFurnace: new Map(),
  assignedSource: new Map(),
};

/** All footprint tiles a building occupies, computed via `footprintTiles` with
 *  the building's nominal width/height and rotation. Returned as a Set of
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
  if (consumers.length === 0) {
    return { hasHeat, coalConsumersByFurnace, assignedSource };
  }

  // Lex-sort consumers and coal sources by id for determinism per §5.2
  // ("the engine walks consumers in ascending building-ID order"). Free
  // sources don't need sorting (the first match suffices; no fuel cost).
  const sortedConsumers = [...consumers].sort((a, b) => a.id.localeCompare(b.id));
  const sortedCoal = [...coalSources].sort((a, b) => a.id.localeCompare(b.id));

  for (const consumer of sortedConsumers) {
    const fp = footprintKeySet(consumer);
    const border = borderTiles(fp);

    // Priority A: any free source adjacent? First-match wins (no fuel cost,
    // assignment choice is purely cosmetic for the inspector readout).
    let freeMatch: PlacedBuilding | null = null;
    for (const src of freeSources) {
      if (sourceTouchesBorder(src, border)) {
        freeMatch = src;
        break;
      }
    }
    if (freeMatch) {
      hasHeat.set(consumer.id, true);
      assignedSource.set(consumer.id, freeMatch.id);
      continue;
    }

    // Priority B: lowest-id coal source adjacent. Walk pre-sorted list and
    // pick the first one whose footprint touches the consumer's border.
    let coalMatch: PlacedBuilding | null = null;
    for (const src of sortedCoal) {
      if (sourceTouchesBorder(src, border)) {
        coalMatch = src;
        break;
      }
    }
    if (coalMatch) {
      hasHeat.set(consumer.id, true);
      assignedSource.set(consumer.id, coalMatch.id);
      const prev = coalConsumersByFurnace.get(coalMatch.id) ?? 0;
      coalConsumersByFurnace.set(coalMatch.id, prev + 1);
      continue;
    }

    // Priority C: no source adjacent. Consumer cannot operate.
    hasHeat.set(consumer.id, false);
  }

  return { hasHeat, coalConsumersByFurnace, assignedSource };
}
