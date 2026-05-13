// Orbital mechanics: satellite data model, launch logic, and dispatch.
//
// Pure layer — no PixiJS, no DOM. All state mutations go through explicit
// functions so the simulation is testable without a renderer.
//
// §14.2 Spaceport + §14.7 launch success rolls with failure modes + upgrade lifecycle.

import { inv } from './economy.js';
import { makeSeededRng } from './rng.js';
import type { ResourceId } from './recipes.js';
import type { WorldState } from './world.js';

export type SatelliteVariant = 'scanner' | 'sweeper' | 'comm';

export interface SatBufferEntry {
  readonly type: 'discovery' | 'weather' | 'debris';
  readonly payload: unknown;
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
}

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
 *     mechanics are deferred to a later step
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
  const successRate = Math.min(0.99, baseSuccess);
  const rng = makeSeededRng(`${world.seed}_launch_${nowMs}`);
  if (rng() > successRate) {
    // Failure: pad explosion (30%) or orbit explosion (70%).
    if (rng() < 0.30) {
      // Pad explosion: destroy spaceport.
      state.buildings = state.buildings.filter((b) => b.defId !== 'spaceport');
    }
    // Orbit explosion: deferred — no debris field yet.
    return { ok: false, reason: 'launch-failure' };
  }

  // Deduct consumables.
  for (const [res, qty] of Object.entries(needed)) {
    state.inventory[res as ResourceId] -= qty ?? 0;
  }

  const sat: Satellite = {
    id: `sat_${nowMs}`,
    variant,
    spaceportIslandId,
    x: spec.cx + 100,
    y: spec.cy + 100,
    commRange: variant === 'comm' ? 500 : 200,
    coverageRadius: variant === 'scanner' ? 400 : 0,
    fuel: 100,
    lodges: { scan: 0, weather: 0, comm: 0 },
    locked: true,
    pendingRepairDroneId: null,
    buffer: [],
  };

  world.satellites.push(sat);
  return { ok: true, sat };
}

// ---------------------------------------------------------------------------
// Comm graph BFS
// ---------------------------------------------------------------------------

function getEntityById(
  world: WorldState,
  id: string,
): { x: number; y: number; commRange: number } | null {
  const island = world.islands.find((i) => i.id === id);
  if (island) return { x: island.cx, y: island.cy, commRange: 200 }; // ground station range
  const sat = world.satellites.find((s) => s.id === id);
  if (sat) return { x: sat.x, y: sat.y, commRange: sat.commRange };
  return null;
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

// ---------------------------------------------------------------------------
// Store-and-forward buffering
// ---------------------------------------------------------------------------

export function appendSatBuffer(sat: Satellite, entry: SatBufferEntry): void {
  if (sat.buffer.length >= 100) {
    sat.buffer.shift();
  }
  sat.buffer.push(entry);
}

export function flushSatBuffer(sat: Satellite): SatBufferEntry[] {
  const entries = [...sat.buffer];
  sat.buffer = [];
  return entries;
}

/**
 * Upgrade the Spaceport on an island to the next tier.
 *
 * Cost table:
 *   - Tier 1 → 2: 5 phase_converter, 2 eldritch_processor, 50 cryogenic_hydrogen
 *   - Tier 2 → 3: 10 reality_anchor, 5 eldritch_processor, 100 antimatter_propellant
 *
 * Returns `{ ok: true }` on success, or `{ ok: false, reason }` when the island
 * or spaceport is missing, the tier is already maxed, or resources are insufficient.
 */
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
    ? { phase_converter: 5, eldritch_processor: 2, cryogenic_hydrogen: 50 }
    : { reality_anchor: 10, eldritch_processor: 5, antimatter_propellant: 100 };

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
