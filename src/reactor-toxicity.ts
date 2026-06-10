// §4.5 Chemical Reactor toxicity event. Pure module — no PixiJS, no DOM.
//
// Any chemical_reactor adjacent to another rolls 5%/real-time-hour; on a hit,
// throughput drops to 50% for 1 hour then auto-resolves. Rolls are seeded from
// `${worldSeed}_toxicity_${reactorId}_${hourTick}` so offline catchup produces
// identical outcomes regardless of segment granularity.

import { collectNeighbors } from './adjacency.js';
import { makeSeededRng } from './rng.js';
import type { PlacedBuilding } from './buildings.js';

export const TOXICITY_ROLL_PROBABILITY = 0.05;
export const TOXICITY_HOUR_MS = 60 * 60 * 1000;
export const TOXICITY_DURATION_MS = 60 * 60 * 1000;

/** True iff `reactor` is a chemical_reactor with at least one adjacent
 *  chemical_reactor neighbor (per §4.5 "adjacent to another Chemical
 *  Reactor"). */
export function isReactorAdjacentToReactor(
  reactor: PlacedBuilding,
  allBuildings: ReadonlyArray<PlacedBuilding>,
): boolean {
  if (reactor.defId !== 'chemical_reactor') return false;
  const neighbors = collectNeighbors(reactor, allBuildings);
  return neighbors.some((n) => n.defId === 'chemical_reactor');
}

/** True iff `reactor` is currently under an active toxicity penalty. */
export function isInToxicityPeriod(
  reactor: PlacedBuilding,
  nowMs: number,
): boolean {
  return (
    reactor.toxicityExpiryMs !== undefined && nowMs < reactor.toxicityExpiryMs
  );
}

/** Per-building output multiplier from toxicity state. 0.5 inside the
 *  toxicity period, 1.0 otherwise. Non-reactor buildings always return 1.0. */
export function toxicityMultiplier(
  reactor: PlacedBuilding,
  nowMs: number,
): number {
  if (reactor.defId !== 'chemical_reactor') return 1.0;
  return isInToxicityPeriod(reactor, nowMs) ? 0.5 : 1.0;
}

/** Deterministic toxicity roll for one reactor at one hour-tick. */
export function rollToxicityForHour(
  worldSeed: string,
  reactorId: string,
  hourTick: number,
): boolean {
  const rng = makeSeededRng(
    `${worldSeed}_toxicity_${reactorId}_${hourTick}`,
  );
  return rng() < TOXICITY_ROLL_PROBABILITY;
}

/** Advance toxicity rolls across the interval `(prevMs, nowMs]`. Mutates
 *  `toxicityExpiryMs` on any reactor whose 5%/hr roll triggers. Returns
 *  the list of reactor ids whose state changed (for telemetry / UI). */
export function advanceToxicityRolls(
  allBuildings: ReadonlyArray<PlacedBuilding>,
  worldSeed: string,
  prevMs: number,
  nowMs: number,
): string[] {
  const triggered: string[] = [];
  const startHour = Math.floor(prevMs / TOXICITY_HOUR_MS);
  const endHour = Math.floor(nowMs / TOXICITY_HOUR_MS);
  if (endHour <= startHour) return triggered;
  for (const reactor of allBuildings) {
    if (reactor.defId !== 'chemical_reactor') continue;
    if (!isReactorAdjacentToReactor(reactor, allBuildings)) continue;
    for (let h = startHour + 1; h <= endHour; h++) {
      const hourBoundaryMs = h * TOXICITY_HOUR_MS;
      if (isInToxicityPeriod(reactor, hourBoundaryMs)) continue;
      if (rollToxicityForHour(worldSeed, reactor.id, h)) {
        reactor.toxicityExpiryMs = hourBoundaryMs + TOXICITY_DURATION_MS;
        triggered.push(reactor.id);
      }
    }
  }
  return triggered;
}
