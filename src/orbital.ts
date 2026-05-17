// Orbital mechanics: satellite data model, launch logic, and dispatch.
//
// Pure layer — no PixiJS, no DOM. All state mutations go through explicit
// functions so the simulation is testable without a renderer.
//
// §14.2 Spaceport + §14.7 launch success rolls with failure modes + upgrade lifecycle.

import { cellKey, tileToCell } from './discovery.js';
import { inv } from './economy.js';
import { makeSeededRng } from './rng.js';
import { effectiveSkillMultipliers, launchSuccessBonus } from './skilltree.js';
import type { ResourceId } from './recipes.js';
import type { WorldState } from './world.js';

export const SAT_BUFFER_CAP = 100;

/** §14.5 / Appendix A scanner discovery placeholders. */
export const SCANNER_INITIAL_P_PER_TICK = 0.001;
export const SCANNER_ASYMPTOTE_P_PER_TICK = 0.05;
/** Time-constant for the exponential ramp toward asymptote.
 *  ~5 minutes in ms — "a few minutes catches most local islands". */
export const SCANNER_DWELL_TIME_CONSTANT_MS = 5 * 60 * 1000;

/** §14.2 Orbital Tracking Station detection radius. Placeholder — Appendix A.
 *  Chosen to cover a meaningful slice of the orbital arena (multi-cell)
 *  while leaving room for multi-station networks to extend reach. */
export const ORBITAL_TRACKING_DETECTION_RADIUS_TILES = 1500;

export type SatelliteVariant = 'scanner' | 'sweeper' | 'comm';

export interface SatBufferEntry {
  readonly type: 'discovery' | 'weather' | 'debris';
  readonly payload: unknown;
}

/** §14.4 in-flight comm packet. Generated at a satellite, hops one node
 *  per tick toward the nearest Spaceport via greedy BFS routing. */
export interface CommPacket {
  readonly id: string;
  readonly payload: SatBufferEntry;
  /** Id of the node (satellite or island) currently holding the packet.
   *  When this id matches a Spaceport-bearing island, the packet is
   *  delivered and removed in the next tick. */
  currentNodeId: string;
  /** Sat that originated the packet. Useful for telemetry / debug. */
  readonly originSatId: string;
  readonly generatedMs: number;
}

export interface Satellite {
  readonly id: string;
  readonly variant: SatelliteVariant;
  readonly spaceportIslandId: string;
  /** Current lock position in world tiles. */
  x: number;
  y: number;
  /** Onboard comm range in tiles. */
  commRange: number;
  /** Scanner coverage radius in tiles (scanner only). */
  coverageRadius: number;
  /** Remaining maneuvering fuel for relocation. */
  fuel: number;
  /** Lodged debris slowdowns: [scan, weather, comm] each 0-1. */
  lodges: { scan: number; weather: number; comm: number };
  /** Locked (parked) vs in transit. */
  locked: boolean;
  /** If pending repair, the incoming repair drone id. */
  pendingRepairDroneId: string | null;
  /** Store-and-forward buffer for disconnected satellites. */
  buffer: SatBufferEntry[];
  /** Per-sat buffer cap baked at launch from SAT_BUFFER_CAP × the launching
   *  island's Communication-skill bandwidth multiplier. Optional for
   *  forward-compat with sats saved before this field existed (legacy reads
   *  fall back to the global constant). */
  bufferCap?: number;
  /** Per-sat scanner dwell-rate multiplier baked at launch from the
   *  launching island's Discovery-skill dwell-ramp multiplier. Optional
   *  for forward-compat (legacy → 1). Only meaningful for variant: 'scanner'. */
  dwellRateMul?: number;
  /** §14.6 in-flight move target. When set, the satellite is in transit and
   *  unlocked (`locked === false`); on arrival, position is updated and
   *  `movingTo` is cleared. Missing/undefined ≡ stationary. */
  movingTo?: { x: number; y: number; arrivalMs: number };
  /** §14.5 per-cell dwell tracker. Keyed by stratification cellKey
   *  ("cellX,cellY"); values are accumulated ms inside that cell while
   *  locked. Cells that drop out of current coverage on a tick are removed
   *  from this map (per spec "moving the satellite resets ramps in cells
   *  outside the new coverage"). Missing/undefined ≡ no dwell anywhere
   *  (forward-compat for legacy saves). */
  dwellByCellKey?: Record<string, number>;
}

export interface RepairDrone {
  readonly id: string;
  readonly targetSatId: string;
  readonly launchTime: number;
  readonly expectedArrivalTime: number;
}

/** §14.8 debris field anchored to one stratification cell. Multiple fields
 *  exist as separate entries in `world.debrisFields`. */
export interface DebrisField {
  readonly cellX: number;
  readonly cellY: number;
  /** Discrete fragment count. Reduced by Sweeper Sat cleanup (§14.8 / Task
   *  6.7); never decays over real time. Field is removed when this hits 0. */
  fragments: number;
}

export const DEBRIS_HIT_CONSTANT = 0.0005; // Appendix A placeholder
export const DEBRIS_LODGE_PROBABILITY = 0.9; // §14.8 "high chance"
export const DEBRIS_LODGE_MAGNITUDE = 0.05; // 5% slowdown per lodge
export const ORBIT_EXPLOSION_FRAGMENTS = 20; // §14.8 placeholder
export const SAT_DESTRUCTION_FRAGMENTS = 10; // §14.8 placeholder
export const SAT_CROSS_SECTION: Record<SatelliteVariant, number> = {
  scanner: 1.2, // larger optics
  sweeper: 1.0,
  comm: 0.8, // sleeker
};

/** §14.6 / Appendix A placeholders for satellite maneuvering. */
export const SAT_FUEL_PER_TILE = 0.05; // fuel units per tile of relocation
export const SAT_MOVE_SPEED_TILES_PER_SEC = 5; // travel speed
export const SAT_MOVE_FAILURE_PROBABILITY = 0.02; // §14.6 "low probability"
export const SAT_MOVE_FAILURE_DEBRIS = 10; // fragments seeded on in-transit loss

/** §14.8 / Appendix A: fragments cleared per real-time second per locked Sweeper Sat
 *  inside a debris field. Stacks linearly (multiple Sweepers in same cell add). */
export const SWEEPER_CLEAN_RATE_PER_SEC = 0.1;

/** §14.12 Repair Drone fuel cost per tile of rendezvous distance.
 *  Smaller than satellite launch propellant per spec ("smaller load"). */
export const REPAIR_DRONE_FUEL_PER_TILE = 0.01;
/** Minimum fuel load — covers fixed launch overhead, prevents 0-distance
 *  edge cases. Placeholder Appendix A. */
export const REPAIR_DRONE_MIN_FUEL = 1;

/** Per-variant payload resource id consumed at launch time. */
const PAYLOAD_RESOURCE: Record<SatelliteVariant, ResourceId> = {
  scanner: 'scanner_sat',
  sweeper: 'sweeper_sat',
  comm: 'comm_sat',
};

/**
 * Launch a satellite from a Spaceport.
 *
 * Prerequisites (§14.1 T6 gate):
 *   - The island must have `ascendantCoreCrafted === true`
 *   - The island must have at least one `spaceport` building
 *
 * Consumables (deducted from the island's inventory on success):
 *   - 1 × variant-specific satellite payload (`scanner_sat`, `sweeper_sat`, or `comm_sat`)
 *   - 1 × `orbital_insertion_package`
 *   - 1 × `antimatter_propellant`
 *
 * Success roll:
 *   - Base success rate depends on Spaceport tier: T1 = 30%, T2 = 50%, T3+ = 70%
 *   - Capped at 99% so there is always a small chance of failure
 *   - Deterministic RNG seeded from `${world.seed}_launch_${nowMs}`
 *
 * Failure modes:
 *   - Pad explosion (30% of failures): the Spaceport building is destroyed
 *   - Orbit explosion (70% of failures): satellite is lost; full debris
 *     mechanics are STILL-DEFERRED to a later step
 */
export function launchSatellite(
  world: WorldState,
  spaceportIslandId: string,
  variant: SatelliteVariant,
  nowMs: number,
): { ok: true; sat: Satellite } | { ok: false; reason: string } {
  const state = world.islandStates?.get(spaceportIslandId);
  const spec = world.islands.find((i) => i.id === spaceportIslandId);
  if (!state || !spec) return { ok: false, reason: 'no-island' };
  if (!state.buildings.some((b) => b.defId === 'spaceport')) {
    return { ok: false, reason: 'no-spaceport' };
  }
  if (!state.ascendantCoreCrafted) {
    return { ok: false, reason: 'no-ascendant-core' };
  }

  // Verify consumables.
  const payload = PAYLOAD_RESOURCE[variant];
  const needed: Partial<Record<ResourceId, number>> = {
    [payload]: 1,
    orbital_insertion_package: 1,
    antimatter_propellant: 1,
  };
  for (const [res, qty] of Object.entries(needed)) {
    const have = state.inventory[res as ResourceId] ?? 0;
    if (have < (qty ?? 0)) {
      return { ok: false, reason: 'insufficient-resources' };
    }
  }

  // Roll launch success.
  const spaceport = state.buildings.find((b) => b.defId === 'spaceport')!;
  const spaceportTier = spaceport.tier ?? 1;
  const baseSuccess =
    spaceportTier === 1 ? 0.30 : spaceportTier === 2 ? 0.50 : 0.70;
  // §14.7: additive Orbital launch sub-path bonuses, clamped at 0.99.
  const bonus = launchSuccessBonus(state);
  const successRate = Math.min(0.99, baseSuccess + bonus);
  const rng = makeSeededRng(`${world.seed}_launch_${nowMs}`);
  // Skill bundle for the launching island. Used both here (pad-explosion
  // mitigation) and below (sat fuel reserve, buffer cap).
  const skill = effectiveSkillMultipliers(state);
  if (rng() > successRate) {
    // Failure: pad explosion (30% baseline) or orbit explosion. Launch sub-
    // path's pad-explosion mitigation DIVIDES the pad-explosion share — at
    // multiplier 2 the 30% becomes 15% and the remainder rolls as orbit
    // explosion (less catastrophic; the Spaceport survives).
    const padShare = 0.30 / skill.padExplosionReduce;
    if (rng() < padShare) {
      // Pad explosion: §14.7 spec — revert the Spaceport to tier I (the
      // upgrade investment is lost, but the building itself stays). Prior
      // behaviour filtered the spaceport out of `buildings` entirely; that
      // overshot the spec and was a functional regression.
      (spaceport as { tier?: number }).tier = 1;
    } else {
      // Orbit explosion: §14.8 — debris field forms at the failed lock cell.
      const failedLockX = spec.cx + 100;
      const failedLockY = spec.cy + 100;
      const { cellX, cellY } = tileToCell(failedLockX, failedLockY);
      addDebrisFragments(world, cellX, cellY, ORBIT_EXPLOSION_FRAGMENTS);
    }
    return { ok: false, reason: 'launch-failure' };
  }

  // Deduct consumables.
  for (const [res, qty] of Object.entries(needed)) {
    state.inventory[res as ResourceId] -= qty ?? 0;
  }

  // Skill bonuses baked into the launched sat's geometry — Communication +
  // Network sub-paths boost comm range; Discovery sub-path boosts Scanner
  // coverage; Resilience boosts fuel reserve; Communication boosts buffer
  // cap; Discovery boosts dwell rate. Baked once at launch so subsequent
  // skill purchases don't retroactively grow already-orbiting sats (an
  // existing-sat retrofit is a different mechanic — Repair Drone with
  // upgrade payload, deferred). `skill` was bound above for the pad-
  // explosion mitigation; reused here.
  const sat: Satellite = {
    id: `sat_${nowMs}`,
    variant,
    spaceportIslandId,
    x: spec.cx + 100,
    y: spec.cy + 100,
    commRange: (variant === 'comm' ? 500 : 200) * skill.commRange,
    coverageRadius: variant === 'scanner' ? 400 * skill.scannerCoverage : 0,
    fuel: 100 * skill.satFuelReserve,
    lodges: { scan: 0, weather: 0, comm: 0 },
    locked: true,
    pendingRepairDroneId: null,
    buffer: [],
    bufferCap: Math.floor(SAT_BUFFER_CAP * skill.satBufferCap),
    dwellRateMul: skill.scannerDwellRate,
  };

  world.satellites.push(sat);
  return { ok: true, sat };
}

// ---------------------------------------------------------------------------
// Comm graph BFS
// ---------------------------------------------------------------------------

export function groundStationCommRange(world: WorldState, islandId: string): number {
  const state = world.islandStates?.get(islandId);
  const sp = state?.buildings.find((b) => b.defId === 'spaceport');
  const tier = sp?.tier ?? 1;
  const base = tier === 1 ? 200 : tier === 2 ? 300 : 400;
  // Network + Orbital-Communication sub-paths multiplicatively boost ground-
  // station comm range. State may be undefined for unpopulated islands; the
  // skill multiplier defaults to 1 in that case so the base reach is unchanged.
  if (!state) return base;
  return base * effectiveSkillMultipliers(state).commRange;
}

function getEntityById(
  world: WorldState,
  id: string,
): { x: number; y: number; commRange: number } | null {
  const island = world.islands.find((i) => i.id === id);
  if (island) {
    return { x: island.cx, y: island.cy, commRange: groundStationCommRange(world, id) };
  }
  const sat = world.satellites.find((s) => s.id === id);
  if (sat) return { x: sat.x, y: sat.y, commRange: sat.commRange };
  return null;
}

/** Build the undirected comm graph: a Map<nodeId, Set<nodeId>> linking
 *  every Spaceport-bearing populated island and every locked satellite that
 *  is within `max(range_A, range_B)` of the other node. */
export function buildCommGraph(world: WorldState): Map<string, Set<string>> {
  const graph = new Map<string, Set<string>>();
  type Node = { id: string; x: number; y: number; commRange: number };
  const nodes: Node[] = [];
  for (const spec of world.islands) {
    if (!spec.populated) continue;
    const state = world.islandStates?.get(spec.id);
    if (!state?.buildings.some((b) => b.defId === 'spaceport')) continue;
    nodes.push({
      id: spec.id,
      x: spec.cx,
      y: spec.cy,
      commRange: groundStationCommRange(world, spec.id),
    });
  }
  for (const sat of world.satellites) {
    if (!sat.locked) continue;
    nodes.push({ id: sat.id, x: sat.x, y: sat.y, commRange: sat.commRange });
  }
  for (const n of nodes) graph.set(n.id, new Set());
  for (let i = 0; i < nodes.length; i++) {
    for (let j = i + 1; j < nodes.length; j++) {
      const a = nodes[i]!;
      const b = nodes[j]!;
      const dist = Math.hypot(a.x - b.x, a.y - b.y);
      if (dist <= Math.max(a.commRange, b.commRange)) {
        graph.get(a.id)!.add(b.id);
        graph.get(b.id)!.add(a.id);
      }
    }
  }
  return graph;
}

/** Set of node ids that ARE Spaceport-bearing islands (delivery targets). */
function spaceportNodes(world: WorldState): Set<string> {
  const out = new Set<string>();
  for (const spec of world.islands) {
    if (!spec.populated) continue;
    const state = world.islandStates?.get(spec.id);
    if (state?.buildings.some((b) => b.defId === 'spaceport')) out.add(spec.id);
  }
  return out;
}

/** BFS from `startId` toward any node in `targets`. Returns the first hop on
 *  the shortest path (immediate neighbor of startId), with ties broken by
 *  lower id (string compare). Returns null if no path exists. */
export function nextHopToNearestSpaceport(
  graph: Map<string, Set<string>>,
  startId: string,
  targets: Set<string>,
): string | null {
  if (targets.has(startId)) return null; // already delivered
  const neighbors = graph.get(startId);
  if (!neighbors || neighbors.size === 0) return null;
  // BFS distance from each neighbor to closest target. Return the neighbor
  // with the lowest distance (ties → lowest id).
  let bestNeighbor: string | null = null;
  let bestDist = Infinity;
  // Sort neighbors deterministically.
  const sortedNeighbors = [...neighbors].sort();
  for (const nb of sortedNeighbors) {
    if (targets.has(nb)) {
      // direct delivery hop is distance 0 — wins immediately
      return nb;
    }
    // BFS from nb to any target.
    const visited = new Set<string>([startId, nb]);
    const queue: Array<{ id: string; d: number }> = [{ id: nb, d: 0 }];
    let dist = Infinity;
    while (queue.length > 0) {
      const cur = queue.shift()!;
      if (targets.has(cur.id)) {
        dist = cur.d;
        break;
      }
      for (const next of [...(graph.get(cur.id) ?? [])].sort()) {
        if (visited.has(next)) continue;
        visited.add(next);
        queue.push({ id: next, d: cur.d + 1 });
      }
    }
    if (dist < bestDist) {
      bestDist = dist;
      bestNeighbor = nb;
    }
  }
  return bestNeighbor;
}

/** §14.4 per-tick packet propagation. For each packet:
 *    1. If `currentNodeId` no longer exists in the graph → packet lost.
 *    2. If `currentNodeId` is a Spaceport node → delivered; drop packet.
 *    3. Otherwise compute next hop via `nextHopToNearestSpaceport`; if a
 *       valid hop exists, advance. If not, leave packet in place (buffers
 *       locally per the spec's "or buffer locally if no neighbor is in
 *       range" clause).
 *  Returns the list of delivered packets (for telemetry). */
export function tickCommPackets(world: WorldState): CommPacket[] {
  if (world.commPackets.length === 0) return [];
  const graph = buildCommGraph(world);
  const targets = spaceportNodes(world);
  const delivered: CommPacket[] = [];
  const survivors: CommPacket[] = [];
  for (const pkt of world.commPackets) {
    if (!graph.has(pkt.currentNodeId)) {
      // Holder destroyed or otherwise removed → packet lost.
      continue;
    }
    if (targets.has(pkt.currentNodeId)) {
      delivered.push(pkt);
      continue;
    }
    const next = nextHopToNearestSpaceport(graph, pkt.currentNodeId, targets);
    if (next !== null) {
      pkt.currentNodeId = next;
    }
    survivors.push(pkt);
  }
  world.commPackets = survivors;
  return delivered;
}

export function connectedSatellites(world: WorldState): Satellite[] {
  const connected = new Set<string>();
  const queue: string[] = [];

  // Seed with all Spaceports on populated islands
  for (const spec of world.islands) {
    if (!spec.populated) continue;
    const state = world.islandStates?.get(spec.id);
    if (state?.buildings.some((b) => b.defId === 'spaceport')) {
      connected.add(spec.id);
      queue.push(spec.id);
    }
  }

  while (queue.length > 0) {
    const currentId = queue.shift()!;
    const currentEntity = getEntityById(world, currentId);
    if (!currentEntity) continue;

    for (const sat of world.satellites) {
      if (connected.has(sat.id)) continue;
      if (!sat.locked) continue; // in-transit satellites are unreachable
      const dist = Math.hypot(sat.x - currentEntity.x, sat.y - currentEntity.y);
      if (dist <= Math.max(currentEntity.commRange, sat.commRange)) {
        connected.add(sat.id);
        queue.push(sat.id);
      }
    }
  }

  return world.satellites.filter((s) => connected.has(s.id));
}

/** §14.2: per-island debris detection radius. Returns
 *  ORBITAL_TRACKING_DETECTION_RADIUS_TILES when the island has at least one
 *  orbital_tracking_station; returns 0 otherwise (no coverage = debris is
 *  invisible). */
export function debrisDetectionRangeForIsland(
  world: WorldState,
  islandId: string,
): number {
  const state = world.islandStates?.get(islandId);
  if (!state) return 0;
  if (!state.buildings.some((b) => b.defId === 'orbital_tracking_station')) {
    return 0;
  }
  return ORBITAL_TRACKING_DETECTION_RADIUS_TILES;
}

// ---------------------------------------------------------------------------
// Store-and-forward buffering
// ---------------------------------------------------------------------------

export function appendSatBuffer(sat: Satellite, entry: SatBufferEntry): void {
  // Per-sat cap baked at launch from Communication skill; fall back to the
  // global constant for legacy sats minted before bufferCap shipped.
  const cap = sat.bufferCap ?? SAT_BUFFER_CAP;
  if (sat.buffer.length >= cap) {
    sat.buffer.shift();
  }
  sat.buffer.push(entry);
}

export function flushSatBuffer(sat: Satellite): SatBufferEntry[] {
  const entries = [...sat.buffer];
  sat.buffer = [];
  return entries;
}

export function dispatchRepairDrone(
  world: WorldState,
  spaceportIslandId: string,
  targetSatId: string,
  nowMs: number,
): { ok: true; drone: RepairDrone } | { ok: false; reason: string } {
  const sat = world.satellites.find((s) => s.id === targetSatId);
  if (!sat) return { ok: false, reason: 'no-satellite' };
  if (sat.pendingRepairDroneId) return { ok: false, reason: 'repair-pending' };

  const state = world.islandStates?.get(spaceportIslandId);
  if (!state) return { ok: false, reason: 'no-island' };
  if (!state.buildings.some((b) => b.defId === 'spaceport')) {
    return { ok: false, reason: 'no-spaceport' };
  }
  if (!state.ascendantCoreCrafted) {
    return { ok: false, reason: 'no-ascendant-core' };
  }

  // §14.12 proportional fuel by rendezvous distance.
  const islandSpec = world.islands.find((i) => i.id === spaceportIslandId);
  if (!islandSpec) return { ok: false, reason: 'no-island' };
  const rendezvousDist = Math.hypot(sat.x - islandSpec.cx, sat.y - islandSpec.cy);
  const fuelLoad = Math.max(
    REPAIR_DRONE_MIN_FUEL,
    rendezvousDist * REPAIR_DRONE_FUEL_PER_TILE,
  );
  if (inv(state, 'repair_pack') < 1) return { ok: false, reason: 'insufficient-repair-pack' };
  if (inv(state, 'antimatter_propellant') < fuelLoad) {
    return { ok: false, reason: 'insufficient-fuel' };
  }

  state.inventory.repair_pack = inv(state, 'repair_pack') - 1;
  state.inventory.antimatter_propellant = inv(state, 'antimatter_propellant') - fuelLoad;

  const travelTimeSec = 100; // placeholder: 100 seconds
  const drone: RepairDrone = {
    id: `repair_${nowMs}`,
    targetSatId,
    launchTime: nowMs,
    expectedArrivalTime: nowMs + travelTimeSec * 1000,
  };

  sat.pendingRepairDroneId = drone.id;
  world.repairDrones.push(drone);
  return { ok: true, drone };
}

export function tickRepairDrones(world: WorldState, nowMs: number): void {
  const remaining: RepairDrone[] = [];
  for (const drone of world.repairDrones) {
    if (nowMs < drone.expectedArrivalTime) {
      remaining.push(drone);
      continue;
    }

    const sat = world.satellites.find((s) => s.id === drone.targetSatId);
    if (!sat) {
      // Target destroyed before arrival — drone lost
      continue;
    }

    // 5% mechanical failure roll, divided by the dispatching island's
    // Resilience-skill repair-reliability multiplier. The dispatching island
    // is the satellite's owner (sat.spaceportIslandId) — the Repair Drone
    // launches from the same Spaceport that fielded the sat.
    const ownerState = world.islandStates?.get(sat.spaceportIslandId);
    const reliabilityMul = ownerState
      ? effectiveSkillMultipliers(ownerState).repairDroneReliability
      : 1;
    const failureChance = 0.05 / reliabilityMul;
    const rng = makeSeededRng(`${world.seed}_repair_${drone.id}`);
    if (rng() < failureChance) {
      // Lost in transit
      sat.pendingRepairDroneId = null;
      continue;
    }

    // Success: clear all lodges, refuel to full
    sat.lodges = { scan: 0, weather: 0, comm: 0 };
    sat.fuel = 100;
    sat.pendingRepairDroneId = null;
  }
  world.repairDrones = remaining;
}

/**
 * Upgrade the Spaceport on an island to the next tier.
 *
 * Cost table (§14.2 spec literal):
 *   - Tier 1 → 2: 5 phase_converter, 2 memetic_core, 50 cryogenic_hydrogen
 *   - Tier 2 → 3: 10 reality_anchor, 5 memetic_core, 100 antimatter_propellant
 *
 * Returns `{ ok: true }` on success, or `{ ok: false, reason }` when the island
 * or spaceport is missing, the tier is already maxed, or resources are insufficient.
 */
/** Find or create the debris field anchored to a stratification cell.
 *  Adds `fragments` to the existing count or creates a new field. */
export function requestSatMove(
  world: WorldState,
  satId: string,
  targetX: number,
  targetY: number,
  nowMs: number,
): { ok: true; eta: number } | { ok: false; reason: string } {
  const sat = world.satellites.find((s) => s.id === satId);
  if (!sat) return { ok: false, reason: 'no-satellite' };
  if (sat.movingTo) return { ok: false, reason: 'already-moving' };
  if (sat.pendingRepairDroneId) return { ok: false, reason: 'pending-repair' };
  if (!sat.locked) return { ok: false, reason: 'not-locked' };
  const dx = targetX - sat.x;
  const dy = targetY - sat.y;
  const dist = Math.hypot(dx, dy);
  if (dist <= 0) return { ok: false, reason: 'no-distance' };
  const fuelCost = dist * SAT_FUEL_PER_TILE;
  if (sat.fuel < fuelCost) return { ok: false, reason: 'insufficient-fuel' };
  // Spend fuel up-front (committed at command time, mirroring drone fuel
  // semantics in dispatchDrone).
  sat.fuel -= fuelCost;
  const travelSec = dist / SAT_MOVE_SPEED_TILES_PER_SEC;
  sat.movingTo = { x: targetX, y: targetY, arrivalMs: nowMs + travelSec * 1000 };
  sat.locked = false;
  return { ok: true, eta: sat.movingTo.arrivalMs };
}

export function tickSatMovement(world: WorldState, nowMs: number): void {
  if (world.satellites.length === 0) return;
  const survivors: Satellite[] = [];
  for (const sat of world.satellites) {
    if (!sat.movingTo) {
      survivors.push(sat);
      continue;
    }
    if (nowMs < sat.movingTo.arrivalMs) {
      survivors.push(sat);
      continue;
    }
    // Arrival window — roll mechanical-failure.
    const rng = makeSeededRng(`${world.seed}_satmove_${sat.id}_${sat.movingTo.arrivalMs}`);
    if (rng() < SAT_MOVE_FAILURE_PROBABILITY) {
      // Lost in transit — seed debris at the loss cell.
      const { cellX, cellY } = tileToCell(sat.movingTo.x, sat.movingTo.y);
      addDebrisFragments(world, cellX, cellY, SAT_MOVE_FAILURE_DEBRIS);
      // sat is omitted from survivors → destroyed.
      continue;
    }
    // Success: update position, re-lock, clear movingTo.
    sat.x = sat.movingTo.x;
    sat.y = sat.movingTo.y;
    sat.locked = true;
    sat.movingTo = undefined;
    survivors.push(sat);
  }
  world.satellites = survivors;
}

export function addDebrisFragments(
  world: WorldState,
  cellX: number,
  cellY: number,
  fragments: number,
): DebrisField {
  let field = world.debrisFields.find(
    (f) => f.cellX === cellX && f.cellY === cellY,
  );
  if (field) {
    field.fragments += fragments;
    return field;
  }
  field = { cellX, cellY, fragments };
  world.debrisFields.push(field);
  return field;
}

/** Hit probability per tick for one satellite inside a debris field. */
export function debrisHitProbability(
  field: DebrisField,
  sat: Satellite,
): number {
  return Math.min(
    0.99,
    field.fragments * DEBRIS_HIT_CONSTANT * (SAT_CROSS_SECTION[sat.variant] ?? 1),
  );
}

/** Tick debris-field interactions for one frame.
 *
 * For each satellite inside a debris field, rolls hit probability. On hit,
 * rolls lodge (high) vs destruction (low). Lodge: bumps a random sub-stat.
 * Destruction: removes the satellite and seeds SAT_DESTRUCTION_FRAGMENTS
 * into the cell — Kessler cascade emerges naturally.
 *
 * Deterministic — RNG seeded from `${world.seed}_debris_${nowMs}_${sat.id}`. */
export function tickDebris(world: WorldState, nowMs: number): void {
  if (world.debrisFields.length === 0 || world.satellites.length === 0) return;
  const survivors: Satellite[] = [];
  for (const sat of world.satellites) {
    if (!sat.locked) {
      survivors.push(sat);
      continue;
    }
    const { cellX, cellY } = tileToCell(sat.x, sat.y);
    const field = world.debrisFields.find(
      (f) => f.cellX === cellX && f.cellY === cellY,
    );
    if (!field || field.fragments <= 0) {
      survivors.push(sat);
      continue;
    }
    // Orbital-Resilience sub-path: divides the effective hit probability by
    // the launching island's debrisProtection multiplier (1.0 = none, 1.05
    // at depth-1 → ~5% chance reduction, doubling per depth per the standard
    // skill ramp). The lodge-vs-destruction split is left untouched — the
    // mechanic that scales with skill is "do you get hit at all", not "how
    // bad is the consequence" (sat shielding intuition).
    const ownerState = world.islandStates?.get(sat.spaceportIslandId);
    const protection = ownerState
      ? effectiveSkillMultipliers(ownerState).debrisProtection
      : 1;
    const hitP = debrisHitProbability(field, sat) / protection;
    const rng = makeSeededRng(`${world.seed}_debris_${nowMs}_${sat.id}`);
    if (rng() >= hitP) {
      survivors.push(sat);
      continue;
    }
    // HIT — split into lodge vs destruction.
    if (rng() < DEBRIS_LODGE_PROBABILITY) {
      // Lodge — pick a random sub-stat and slow it by DEBRIS_LODGE_MAGNITUDE.
      const which = rng();
      const subStat: 'scan' | 'weather' | 'comm' =
        which < 1 / 3 ? 'scan' : which < 2 / 3 ? 'weather' : 'comm';
      sat.lodges[subStat] = Math.min(
        1,
        sat.lodges[subStat] + DEBRIS_LODGE_MAGNITUDE,
      );
      survivors.push(sat);
    } else {
      // Destruction — sat lost, fragments added to cell.
      addDebrisFragments(world, cellX, cellY, SAT_DESTRUCTION_FRAGMENTS);
      // Note: `sat` does NOT make it into `survivors` — destroyed.
    }
  }
  world.satellites = survivors;
  // Cleanup: drop fields with zero fragments.
  world.debrisFields = world.debrisFields.filter((f) => f.fragments > 0);
}

/** §14.8 Sweeper cleanup tick. For each debris field, sum the count of locked
 *  Sweeper Sats currently inside the field's cell, multiply by tickDeltaMs/1000
 *  × SWEEPER_CLEAN_RATE_PER_SEC, subtract from `field.fragments`. Field
 *  removed (filtered out of `world.debrisFields`) when fragments hit 0.
 *  Returns total fragments removed across all fields (telemetry). */
export function tickSweeperCleanup(world: WorldState, tickDeltaMs: number): number {
  if (world.debrisFields.length === 0) return 0;
  if (world.satellites.length === 0) return 0;
  let totalCleared = 0;
  for (const field of world.debrisFields) {
    let sweepers = 0;
    for (const sat of world.satellites) {
      if (sat.variant !== 'sweeper') continue;
      if (!sat.locked) continue;
      const { cellX, cellY } = tileToCell(sat.x, sat.y);
      if (cellX === field.cellX && cellY === field.cellY) sweepers++;
    }
    if (sweepers === 0) continue;
    const cleared = sweepers * SWEEPER_CLEAN_RATE_PER_SEC * (tickDeltaMs / 1000);
    const actualCleared = Math.min(field.fragments, cleared);
    field.fragments = Math.max(0, field.fragments - cleared);
    totalCleared += actualCleared;
  }
  world.debrisFields = world.debrisFields.filter((f) => f.fragments > 0);
  return totalCleared;
}

/** Compute scanner discovery probability per tick at a given dwell time. */
export function scannerDiscoveryProbability(dwellMs: number): number {
  const range = SCANNER_ASYMPTOTE_P_PER_TICK - SCANNER_INITIAL_P_PER_TICK;
  return (
    SCANNER_INITIAL_P_PER_TICK +
    range * (1 - Math.exp(-dwellMs / SCANNER_DWELL_TIME_CONSTANT_MS))
  );
}

/** Cells covered by a satellite given its current position + coverage radius.
 *  Iterates the bounding box of the coverage circle and admits each cell
 *  whose centre is within `coverageRadius` of the sat. */
export function cellsCoveredBySat(sat: Satellite): Set<string> {
  const covered = new Set<string>();
  if (sat.coverageRadius <= 0) return covered;
  const r = sat.coverageRadius;
  for (let x = sat.x - r; x <= sat.x + r; x += 16) {
    for (let y = sat.y - r; y <= sat.y + r; y += 16) {
      const dx = x - sat.x;
      const dy = y - sat.y;
      if (dx * dx + dy * dy <= r * r) {
        const { cellX, cellY } = tileToCell(x, y);
        covered.add(cellKey(cellX, cellY));
      }
    }
  }
  return covered;
}

/** §14.5 per-tick scanner discovery. Pure helper called from main.ts (or
 *  Task 6.7's combined orbital tick). For each locked Scanner Sat:
 *    1. Compute current covered cell set.
 *    2. Drop dwell entries for cells no longer covered.
 *    3. Bump dwell on each covered cell by `tickDeltaMs`.
 *    4. For each undiscovered island whose centre is in a covered cell,
 *       roll `scannerDiscoveryProbability(dwell)` and reveal on success.
 *  Returns the list of newly-discovered island ids for telemetry. */
export function tickScannerDiscovery(
  world: WorldState,
  tickDeltaMs: number,
  nowMs: number,
): string[] {
  const newlyDiscovered: string[] = [];
  for (const sat of world.satellites) {
    if (sat.variant !== 'scanner') continue;
    if (!sat.locked) continue;
    const covered = cellsCoveredBySat(sat);
    if (!sat.dwellByCellKey) sat.dwellByCellKey = {};
    // Drop dwell entries no longer covered.
    for (const key of Object.keys(sat.dwellByCellKey)) {
      if (!covered.has(key)) delete sat.dwellByCellKey[key];
    }
    // Bump dwell.
    for (const key of covered) {
      sat.dwellByCellKey[key] = (sat.dwellByCellKey[key] ?? 0) + tickDeltaMs;
    }
    // Discovery rolls per island in covered cells.
    const rng = makeSeededRng(`${world.seed}_scan_${sat.id}_${nowMs}`);
    for (const isl of world.islands) {
      if (isl.discovered) continue;
      const { cellX, cellY } = tileToCell(isl.cx, isl.cy);
      const key = cellKey(cellX, cellY);
      if (!covered.has(key)) continue;
      const dwell = sat.dwellByCellKey[key] ?? 0;
      // Discovery sub-path's dwell-ramp bonus inflates EFFECTIVE dwell on
      // this scanner so the saturating-exponential ramp reaches its
      // asymptote sooner. Multiplier ≤ 1 (missing field) leaves base
      // behaviour identical.
      const effectiveDwell = dwell * (sat.dwellRateMul ?? 1);
      const p = scannerDiscoveryProbability(effectiveDwell);
      if (rng() < p) {
        isl.discovered = true;
        newlyDiscovered.push(isl.id);
      }
    }
  }
  return newlyDiscovered;
}

export function upgradeSpaceport(
  world: WorldState,
  islandId: string
): { ok: true } | { ok: false; reason: string } {
  const state = world.islandStates?.get(islandId);
  if (!state) return { ok: false, reason: 'no-island' };
  const sp = state.buildings.find(b => b.defId === 'spaceport');
  if (!sp) return { ok: false, reason: 'no-spaceport' };
  const currentTier = sp.tier ?? 1;
  if (currentTier >= 3) return { ok: false, reason: 'max-tier' };

  const costs = currentTier === 1
    ? { phase_converter: 5, memetic_core: 2, cryogenic_hydrogen: 50 }
    : { reality_anchor: 10, memetic_core: 5, antimatter_propellant: 100 };

  // Check inventory
  for (const [r, amt] of Object.entries(costs)) {
    if (inv(state, r as ResourceId) < amt) return { ok: false, reason: 'insufficient-resources' };
  }
  // Consume
  for (const [r, amt] of Object.entries(costs)) {
    state.inventory[r as ResourceId] = inv(state, r as ResourceId) - amt;
  }
  sp.tier = currentTier + 1;
  return { ok: true };
}
