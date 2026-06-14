// server/src/game/intents.ts
//
// Intent catalog + dispatch table (slice-3 design §3). Each entry maps a wire
// intent `type` to a handler that re-runs the existing pure `src/` entry
// function against the account's AUTHORITATIVE live game. The handler:
//   1. validates the payload shape (client numbers are never trusted),
//   2. resolves the target island spec + state from `game`,
//   3. pre-checks affordability/legality against authoritative state where the
//      pure function trusts its caller (design §6 trust-surface), and
//   4. calls the pure function and reports {ok} from its outcome.
//
// Handlers MUST NOT throw for an illegal/unaffordable/malformed request — they
// return {ok:false, error}. (The runner additionally try/catches as a backstop
// for unexpected throws.) No DB, no WS here — this module stays pure-ish and
// testable without either.

import type { LiveGame } from './runtime.js';
import type { IslandSpec } from '../../../src/world.js';
import type { IslandState } from '../../../src/economy.js';
import { renameIsland, validateIslandName, type Biome } from '../../../src/world.js';
import { editIslandBiome } from '../../../src/universe-editor.js';
import {
  constructIsland,
  makeArtificialIdGenerator,
  validateConstruction,
} from '../../../src/artificial-island.js';
import { BUILDING_DEFS, type BuildingDefId } from '../../../src/building-defs.js';
import {
  placeBuilding,
  validatePlacement,
  validateOceanPlacement,
  demolishBuilding,
  cancelConstruction,
  applyUpgrade,
  setBuildingActiveFloors,
  relocateBuilding,
  applyRelabelStorageCap,
} from '../../../src/placement.js';
import type { TerrainKind } from '../../../src/island.js';
import { displayedFloorLevel } from '../../../src/floor-levels.js';
import { dispatchDrone, firePulse, type DroneTier } from '../../../src/drones.js';
import {
  createRouteFromBuilding,
  routeProfileForBuilding,
  islandHasTeleporterPad,
  reorderPriorityList,
} from '../../../src/routes.js';
import {
  buyNode,
  nodePurchaseStatus,
  keystonePrereqFor,
  DEFAULT_GRAPH,
  effectiveGraph,
  canBuyKeystone,
  buyKeystone,
  bindCrystal,
  unbindCrystal,
} from '../../../src/skilltree.js';
import { CRYSTAL_CATALOG } from '../../../src/skilltree-crystals.js';
import { canTierReset, executeTierReset } from '../../../src/tier-reset.js';
import {
  dispatchVehicle,
  settleViaSpacetimeAnchor,
  type VehicleKind,
  type VehicleTier,
} from '../../../src/settlement.js';
import {
  launchSatellite,
  upgradeSpaceport,
  requestSatMove,
  dispatchRepairDrone,
  type SatelliteVariant,
} from '../../../src/orbital.js';
import { expandIsland, canExpandIsland, type Axis } from '../../../src/land-reclamation.js';
import { BIOME_DEFS } from '../../../src/biomes.js';
import { ALL_RESOURCES, type ResourceId } from '../../../src/recipes.js';
import type { Rotation } from '../../../src/shape-mask.js';
import { CARGO_WILDCARD, type CargoEntry, type CargoMode } from '../../../src/route-cargo.js';
import type { CrystalId } from '../../../src/skilltree-graph.js';
import { CELL_SIZE_TILES } from '../../../src/constants.js';

export type IntentResult = { ok: true } | { ok: false; error: string };

export interface IntentHandler {
  apply(game: LiveGame, payload: unknown, now: number): IntentResult;
}

function isValidResourceId(v: unknown): v is ResourceId {
  return typeof v === 'string' && (ALL_RESOURCES as ReadonlyArray<string>).includes(v);
}

function isValidCargoMode(v: unknown): v is CargoMode {
  return v === 'priority' || v === 'waterfall' || v === 'split' || v === 'balanced';
}

function isValidVehicleKind(v: unknown): v is VehicleKind {
  return v === 'ship' || v === 'helicopter';
}

function isValidVehicleTier(v: unknown): v is VehicleTier {
  return typeof v === 'number' && Number.isInteger(v) && v >= 1 && v <= 4;
}

function isValidSatelliteVariant(v: unknown): v is SatelliteVariant {
  return v === 'scanner' || v === 'sweeper' || v === 'relay' || v === 'mirror';
}

function resolveRoute(game: LiveGame, routeId: string) {
  return game.world.routes.find((r) => r.id === routeId);
}

/** Authoritative cargo-array validation: each entry must name a real resource
 *  (or the 'all' wildcard), weights must be positive, floor percentages in
 *  [0,100], and at most one wildcard/duplicate explicit resource may appear —
 *  mirroring the routes-UI invariants. */
function validateCargoList(cargo: unknown): { ok: true; list: CargoEntry[] } | { ok: false; error: string } {
  if (!Array.isArray(cargo)) return { ok: false, error: 'cargo must be an array' };
  const list: CargoEntry[] = [];
  const seen = new Set<string>();
  let seenAll = false;
  for (const entry of cargo) {
    if (!isRecord(entry)) return { ok: false, error: 'cargo entry must be an object' };
    const { resourceId, weight, sourceFloorPct } = entry;
    if (typeof resourceId !== 'string') return { ok: false, error: 'cargo entry resourceId must be a string' };
    if (resourceId !== CARGO_WILDCARD && !isValidResourceId(resourceId)) {
      return { ok: false, error: `unknown cargo resourceId ${resourceId}` };
    }
    if (resourceId === CARGO_WILDCARD) {
      if (seenAll) return { ok: false, error: 'only one all wildcard allowed' };
      seenAll = true;
    } else {
      if (seen.has(resourceId)) return { ok: false, error: `duplicate cargo resourceId ${resourceId}` };
      seen.add(resourceId);
    }
    if (weight !== undefined) {
      if (typeof weight !== 'number' || !Number.isFinite(weight) || weight <= 0) {
        return { ok: false, error: 'cargo weight must be positive' };
      }
    }
    if (sourceFloorPct !== undefined) {
      if (typeof sourceFloorPct !== 'number' || !Number.isFinite(sourceFloorPct) || sourceFloorPct < 0 || sourceFloorPct > 100) {
        return { ok: false, error: 'cargo sourceFloorPct must be 0..100' };
      }
    }
    list.push({
      resourceId,
      ...(weight !== undefined ? { weight } : {}),
      ...(sourceFloorPct !== undefined ? { sourceFloorPct } : {}),
    } as CargoEntry);
  }
  return { ok: true, list };
}

/** Resolve `{ spec, state }` for an island id against authoritative game state,
 *  or null when either side is missing. `IslandSpec.buildings` and
 *  `IslandState.buildings` are the SAME array reference (see
 *  `makeInitialIslandState`), so the pure fns mutate both consistently. */
function resolveIsland(
  game: LiveGame,
  islandId: string,
): { spec: IslandSpec; state: IslandState } | null {
  const spec = game.world.islands.find((s) => s.id === islandId);
  if (!spec) return null;
  const state = game.islandStates.get(islandId);
  if (!state) return null;
  return { spec, state };
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null;
}

/** A monotonically-unique id generator for a freshly-placed building, scoped to
 *  the island's current building set. Mirrors the placement-UI `placed-N`
 *  shape. Cost is gated BEFORE the id is minted inside `placeBuilding`, so a
 *  rejected placement consumes no slot. */
function makePlacedIdGenerator(spec: IslandSpec): () => string {
  return () => {
    let n = spec.buildings.length;
    let id = `placed-${n}`;
    const taken = new Set(spec.buildings.map((b) => b.id));
    while (taken.has(id)) {
      n += 1;
      id = `placed-${n}`;
    }
    return id;
  };
}

export const INTENTS: Record<string, IntentHandler> = {
  // place-building — reference intent (design §5). Player supplies
  // { islandId, defId, x, y, rotation }; the server derives cost + legality
  // from authoritative state. `placeBuilding` self-validates the §14 cost gate
  // and the §9.3 queue gate (returns {ok:false} for those), but it TRUSTS its
  // caller on geometry/tier/biome/tile (it does NOT re-run those — that is
  // `validatePlacement`'s job). So the authoritative pre-check here is
  // `validatePlacement`, run against server spec+state before applying.
  'place-building': {
    apply(game: LiveGame, payload: unknown, now: number): IntentResult {
      if (!isRecord(payload)) return { ok: false, error: 'malformed payload' };
      const { islandId, defId, x, y, rotation, cargoLabel, anchorIslandId, terrainTarget, terrainShotMs } = payload;
      if (typeof islandId !== 'string') return { ok: false, error: 'islandId must be a string' };
      if (typeof defId !== 'string' || !(defId in BUILDING_DEFS)) {
        return { ok: false, error: 'unknown defId' };
      }
      if (typeof x !== 'number' || !Number.isInteger(x)) return { ok: false, error: 'x must be an integer' };
      if (typeof y !== 'number' || !Number.isInteger(y)) return { ok: false, error: 'y must be an integer' };
      if (rotation !== 0 && rotation !== 1 && rotation !== 2 && rotation !== 3) {
        return { ok: false, error: 'rotation must be 0..3' };
      }
      // Optional payload fields — validate SHAPE here (client values are never
      // trusted); the pure fn owns LEGALITY (§4.6 cargo label, §8.9 terrain
      // modifier, §4 ocean anchoring). Dropping any of these silently was the
      // server-migration regression: e.g. an omitted cargoLabel made every
      // generic-storage building default to iron_ore regardless of the
      // player's picker pick.
      if (cargoLabel !== undefined && !isValidResourceId(cargoLabel)) {
        return { ok: false, error: 'cargoLabel must be a valid resource id' };
      }
      if (anchorIslandId !== undefined && typeof anchorIslandId !== 'string') {
        return { ok: false, error: 'anchorIslandId must be a string' };
      }
      if (terrainTarget !== undefined && typeof terrainTarget !== 'string') {
        return { ok: false, error: 'terrainTarget must be a string' };
      }
      if (terrainShotMs !== undefined && (typeof terrainShotMs !== 'number' || !Number.isFinite(terrainShotMs))) {
        return { ok: false, error: 'terrainShotMs must be a finite number' };
      }
      const island = resolveIsland(game, islandId);
      if (!island) return { ok: false, error: 'unknown island' };
      const { spec, state } = island;
      const typedDefId = defId as BuildingDefId;
      const rot = rotation as Rotation;
      const def = BUILDING_DEFS[typedDefId];

      // Authoritative legality pre-check — recomputed from server state; the
      // client's claim is never trusted. Ocean defs route through the ocean
      // validator (validatePlacement rejects them with 'def-is-ocean' by
      // design); land/terrain defs go through validatePlacement. For ocean
      // defs x/y are anchor-LOCAL tile coords (client convention, see
      // placement-ui.ts ocean path), so convert back to world-cell indices by
      // adding the anchor centre and dividing by CELL_SIZE_TILES before validating.
      if (def.oceanPlacement === true) {
        const ov = validateOceanPlacement(game.world, typedDefId, (x + spec.cx) / CELL_SIZE_TILES, (y + spec.cy) / CELL_SIZE_TILES);
        if (!ov.ok) return { ok: false, error: ov.reason ?? 'illegal ocean placement' };
      } else {
        const v = validatePlacement(spec, state, typedDefId, x, y, rot);
        if (!v.ok) return { ok: false, error: v.reason ?? 'illegal placement' };
      }

      // Apply via the pure entry fn. It re-checks the cost + queue gates and
      // deducts cost from authoritative inventory only on the success path.
      // Forward every player-supplied field the LOCAL gateway forwards
      // (mutation-gateway.ts) so REMOTE placement matches LOCAL exactly.
      const result = placeBuilding(
        spec, state, typedDefId, x, y, rot, makePlacedIdGenerator(spec),
        now,
        isValidResourceId(cargoLabel) ? cargoLabel : undefined,
        typeof anchorIslandId === 'string' ? anchorIslandId : undefined,
        typeof terrainTarget === 'string' ? (terrainTarget as TerrainKind) : undefined,
        typeof terrainShotMs === 'number' ? terrainShotMs : undefined,
      );
      if (!result.ok) return { ok: false, error: result.reason };
      return { ok: true };
    },
  },

  // demolish-building — refunding intent (§6.7). Player supplies
  // { islandId, buildingId }. `demolishBuilding` self-validates existence
  // (returns {ok:false, reason:'not-found'} for an unknown id) and computes
  // the 30% scrap + 50% material refund from authoritative invested cost.
  // No affordability gate (it credits, never charges), so the handler's job is
  // payload-shape validation + island/target resolution; the pure fn owns the
  // legality (building must exist).
  'demolish-building': {
    apply(game: LiveGame, payload: unknown): IntentResult {
      if (!isRecord(payload)) return { ok: false, error: 'malformed payload' };
      const { islandId, buildingId } = payload;
      if (typeof islandId !== 'string') return { ok: false, error: 'islandId must be a string' };
      if (typeof buildingId !== 'string') return { ok: false, error: 'buildingId must be a string' };
      const island = resolveIsland(game, islandId);
      if (!island) return { ok: false, error: 'unknown island' };
      const r = demolishBuilding(island.spec, island.state, buildingId);
      if (!r.ok) return { ok: false, error: r.reason ?? 'demolish failed' };
      return { ok: true };
    },
  },

  // cancel-construction — refunding intent. Player supplies
  // { islandId, buildingId }. `cancelConstruction` self-validates: it rejects
  // an unknown id ('not-found') and a building that is neither building nor has
  // queued upgrade jobs ('not-building'), refunding 100% of materials on the
  // success path. No affordability gate. Handler validates payload + resolves
  // the island; the pure fn owns the "is there a cancellable job" legality.
  'cancel-construction': {
    apply(game: LiveGame, payload: unknown): IntentResult {
      if (!isRecord(payload)) return { ok: false, error: 'malformed payload' };
      const { islandId, buildingId } = payload;
      if (typeof islandId !== 'string') return { ok: false, error: 'islandId must be a string' };
      if (typeof buildingId !== 'string') return { ok: false, error: 'buildingId must be a string' };
      const island = resolveIsland(game, islandId);
      if (!island) return { ok: false, error: 'unknown island' };
      const r = cancelConstruction(island.spec, island.state, buildingId);
      if (!r.ok) return { ok: false, error: r.reason ?? 'cancel failed' };
      return { ok: true };
    },
  },

  // upgrade-building — §9.3 queued construction job. Player supplies
  // { islandId, buildingId }. The server derives the ascending upgrade cost
  // from authoritative floor state. `applyUpgrade` self-validates the cost gate
  // ('insufficient-resources') AND the §9.3 queue gate ('queue-full'), and
  // deducts cost from authoritative inventory only on the success path — so no
  // separate handler-side affordability pre-check is needed beyond payload
  // validation + island resolution. (The trust surface here is satisfied by the
  // pure fn's own affordabilityShortfall check against server inventory.)
  'upgrade-building': {
    apply(game: LiveGame, payload: unknown): IntentResult {
      if (!isRecord(payload)) return { ok: false, error: 'malformed payload' };
      const { islandId, buildingId } = payload;
      if (typeof islandId !== 'string') return { ok: false, error: 'islandId must be a string' };
      if (typeof buildingId !== 'string') return { ok: false, error: 'buildingId must be a string' };
      const island = resolveIsland(game, islandId);
      if (!island) return { ok: false, error: 'unknown island' };
      const r = applyUpgrade(island.spec, island.state, buildingId);
      if (!r.ok) return { ok: false, error: r.reason ?? 'upgrade failed' };
      return { ok: true };
    },
  },

  // set-active-floors — §4.5 free toggle. Player supplies
  // { islandId, buildingId, disabledFloors }. No cost. `setBuildingActiveFloors`
  // CLAMPS an out-of-range value silently to ok:true, so an under-validating
  // handler would let a client send garbage that maps to an unintended floor
  // count. Authoritative pre-check: resolve the building from server state and
  // reject a disabledFloors outside [0, displayedFloorLevel] BEFORE applying, so
  // the request must name a real, in-range floor count. (Existence is also
  // re-checked by the pure fn's 'not-found'.)
  'set-active-floors': {
    apply(game: LiveGame, payload: unknown): IntentResult {
      if (!isRecord(payload)) return { ok: false, error: 'malformed payload' };
      const { islandId, buildingId, disabledFloors } = payload;
      if (typeof islandId !== 'string') return { ok: false, error: 'islandId must be a string' };
      if (typeof buildingId !== 'string') return { ok: false, error: 'buildingId must be a string' };
      if (typeof disabledFloors !== 'number' || !Number.isInteger(disabledFloors) || disabledFloors < 0) {
        return { ok: false, error: 'disabledFloors must be a non-negative integer' };
      }
      const island = resolveIsland(game, islandId);
      if (!island) return { ok: false, error: 'unknown island' };
      const b = island.spec.buildings.find((bb) => bb.id === buildingId);
      if (!b) return { ok: false, error: 'not-found' };
      // Authoritative range gate: the client can't disable more floors than the
      // building actually has (the pure fn would silently clamp instead).
      if (disabledFloors > displayedFloorLevel(b)) {
        return { ok: false, error: 'disabledFloors out of range' };
      }
      const r = setBuildingActiveFloors(island.spec, island.state, buildingId, disabledFloors);
      if (!r.ok) return { ok: false, error: r.reason ?? 'set-active-floors failed' };
      return { ok: true };
    },
  },

  // dispatch-drone — §11.5/§11.7 scout launch. Player supplies
  // { islandId, originX, originY, dirX, dirY, fuelLoaded }. `dispatchDrone`
  // self-validates direction ('invalid-direction'), the per-pad in-flight cap
  // ('already-in-flight'), and the §11.7 tier-matched fuel grade + amount
  // against authoritative origin inventory ('insufficient-fuel') — deducting
  // fuel and appending the Drone to world.drones only on success. The fuel
  // check IS the affordability gate and it runs on server state, so the handler
  // validates payload shape (all six numbers finite) + resolves the origin
  // island; the pure fn owns fuel-grade/amount legality.
  'dispatch-drone': {
    apply(game: LiveGame, payload: unknown, now: number): IntentResult {
      if (!isRecord(payload)) return { ok: false, error: 'malformed payload' };
      const { islandId, originX, originY, dirX, dirY, fuelLoaded, waypoints, selectedTier } = payload;
      if (typeof islandId !== 'string') return { ok: false, error: 'islandId must be a string' };
      for (const [name, v] of [
        ['originX', originX], ['originY', originY],
        ['dirX', dirX], ['dirY', dirY], ['fuelLoaded', fuelLoaded],
      ] as const) {
        if (typeof v !== 'number' || !Number.isFinite(v)) {
          return { ok: false, error: `${name} must be a finite number` };
        }
      }
      // Optional path-mode fields. Dropping these silently was a migration
      // regression: a T5 path-drawn drone (waypoints) became a straight-line
      // default-tier drone server-side, and the tier picker was ignored.
      let typedWaypoints: ReadonlyArray<{ x: number; y: number }> | undefined;
      if (waypoints !== undefined) {
        if (!Array.isArray(waypoints)) return { ok: false, error: 'waypoints must be an array' };
        const wp: Array<{ x: number; y: number }> = [];
        for (const p of waypoints) {
          if (!isRecord(p) || typeof p.x !== 'number' || !Number.isFinite(p.x) || typeof p.y !== 'number' || !Number.isFinite(p.y)) {
            return { ok: false, error: 'each waypoint must be { x:number, y:number }' };
          }
          wp.push({ x: p.x, y: p.y });
        }
        typedWaypoints = wp;
      }
      let typedTier: DroneTier | undefined;
      if (selectedTier !== undefined) {
        if (typeof selectedTier !== 'number' || !Number.isInteger(selectedTier) || selectedTier < 1 || selectedTier > 6) {
          return { ok: false, error: 'selectedTier must be an integer 1..6' };
        }
        typedTier = selectedTier as DroneTier;
      }
      const island = resolveIsland(game, islandId);
      if (!island) return { ok: false, error: 'unknown island' };
      const r = dispatchDrone(
        game.world, island.state,
        originX as number, originY as number,
        dirX as number, dirY as number,
        fuelLoaded as number, now,
        typedWaypoints,
        typedTier,
      );
      if (!r.ok) return { ok: false, error: r.reason };
      return { ok: true };
    },
  },

  // create-route — §2.4 inter-island transport. Player supplies
  // { fromIslandId, toIslandId, buildingId, filterResource? }. No cost.
  // `createRouteFromBuilding` returns null only when the building is not a
  // transport def, and does NOT append to world.routes — the caller must push.
  // It TRUSTS its caller on island existence, eligibility, building ownership,
  // distinctness, and the teleporter→pad rule.
  //
  // ELIGIBILITY (anti-cheat): per §2.4 routes connect islands that the player
  // has settled, and the routes-UI builds BOTH the FROM and TO dropdowns
  // exclusively from `populatedIslands()` (`src/routes-ui.ts`). So both
  // endpoints MUST be populated — a crafted intent must not be able to route
  // to/from an unpopulated (unsettled) island. The authoritative pre-check
  // therefore requires: both island specs exist on server state, both are
  // populated, they're distinct, the building exists on the FROM island, it has
  // a route profile, and a teleporter route requires a teleporter pad on the TO
  // island. The server computes distance from authoritative island centres
  // (never trusts a client distance), then pushes the route.
  'create-route': {
    apply(game: LiveGame, payload: unknown): IntentResult {
      if (!isRecord(payload)) return { ok: false, error: 'malformed payload' };
      const { fromIslandId, toIslandId, buildingId, filterResource } = payload;
      if (typeof fromIslandId !== 'string') return { ok: false, error: 'fromIslandId must be a string' };
      if (typeof toIslandId !== 'string') return { ok: false, error: 'toIslandId must be a string' };
      if (typeof buildingId !== 'string') return { ok: false, error: 'buildingId must be a string' };
      if (filterResource !== undefined && filterResource !== null && typeof filterResource !== 'string') {
        return { ok: false, error: 'filterResource must be a string when present' };
      }
      if (typeof filterResource === 'string' && !isValidResourceId(filterResource)) {
        return { ok: false, error: 'unknown filterResource' };
      }
      if (fromIslandId === toIslandId) return { ok: false, error: 'from and to must differ' };
      const fromSpec = game.world.islands.find((s) => s.id === fromIslandId);
      if (!fromSpec) return { ok: false, error: 'unknown from island' };
      const toSpec = game.world.islands.find((s) => s.id === toIslandId);
      if (!toSpec) return { ok: false, error: 'unknown to island' };
      // §2.4 eligibility: both endpoints must be populated (settled). The
      // routes-UI only ever offers populated islands; the server enforces it.
      if (!fromSpec.populated) return { ok: false, error: 'from island is not populated' };
      if (!toSpec.populated) return { ok: false, error: 'to island is not populated' };
      const building = fromSpec.buildings.find((b) => b.id === buildingId);
      if (!building) return { ok: false, error: 'building not on from island' };
      const profile = routeProfileForBuilding(building.defId);
      if (profile === null) return { ok: false, error: 'building is not a transport building' };
      if (profile.type === 'teleporter' && !islandHasTeleporterPad(toSpec)) {
        return { ok: false, error: 'destination has no teleporter pad' };
      }
      const dx = fromSpec.cx - toSpec.cx;
      const dy = fromSpec.cy - toSpec.cy;
      const dist = Math.sqrt(dx * dx + dy * dy);
      const filter = (filterResource === undefined || filterResource === null) ? null : (filterResource as ResourceId);
      const route = createRouteFromBuilding(building, fromIslandId, toIslandId, filter, dist);
      if (route === null) return { ok: false, error: 'route could not be created' };
      game.world.routes.push(route);
      return { ok: true };
    },
  },

  // unlock-skill-node — §9.3 skill purchase. Player supplies
  // { islandId, nodeId }. The XP/SP path is TODO-flagged sensitive (design §6).
  // `buyNode` THROWS for an illegal target (insufficient SP, tier-locked,
  // unreachable, unknown) rather than returning a result, so the runner's
  // try/catch is the only backstop — but per the no-throw handler contract we
  // must NOT rely on it: we pre-check with `nodePurchaseStatus` (the canonical
  // single-source predicate buyNode's own acceptance mirrors) against
  // authoritative state and reject anything that isn't 'purchasable' BEFORE
  // calling buyNode. This validates unspentSkillPoints covers the path cost and
  // the depth→tier gate, on server state.
  //
  // KEYSTONE EXCLUSION: a keystone is identified by `keystonePrereqFor(nodeId)`
  // returning a prereq spec (non-keystones return undefined). Keystones are
  // purchased only via `buyKeystone` (AND-prereqs + flat SP cost) — NOT via
  // `buyNode`, which has no keystone branch and would THROW 'unreachable' for
  // one (keystone targets are excluded from pathing adjacency). Worse,
  // `nodePurchaseStatus` reports a keystone with met prereqs + enough SP as
  // 'purchasable', so the status check alone would forward it into buyNode's
  // throw. We therefore reject keystone targets explicitly BEFORE the status
  // check so no keystone ever reaches buyNode.
  'unlock-skill-node': {
    apply(game: LiveGame, payload: unknown): IntentResult {
      if (!isRecord(payload)) return { ok: false, error: 'malformed payload' };
      const { islandId, nodeId } = payload;
      if (typeof islandId !== 'string') return { ok: false, error: 'islandId must be a string' };
      if (typeof nodeId !== 'string') return { ok: false, error: 'nodeId must be a string' };
      const island = resolveIsland(game, islandId);
      if (!island) return { ok: false, error: 'unknown island' };
      const { state } = island;
      // Anti-cheat: keystones are not in this intent's surface — buyNode throws
      // for them and the no-throw contract forbids leaning on the runner's
      // try/catch. Reject before any buyNode path can be reached.
      if (keystonePrereqFor(nodeId) !== undefined) {
        return { ok: false, error: 'keystone not purchasable via this intent' };
      }
      // Authoritative purchasability pre-check (anti-cheat): SP sufficiency +
      // depth→tier gate + reachability, all recomputed from server state. Only
      // a 'purchasable' status proceeds.
      const graph = effectiveGraph(state);
      const status = nodePurchaseStatus(graph, state, nodeId);
      if (status !== 'purchasable') return { ok: false, error: status };
      buyNode(graph, state, nodeId);
      return { ok: true };
    },
  },

  // relocate-building — §4 building move. Player supplies
  // { islandId, buildingId, x, y, rotation? }. `relocateBuilding` self-validates
  // geometry/tier/terrain via `validatePlacement` and charges a half-fee from
  // authoritative inventory; the handler only validates payload shape.
  'relocate-building': {
    apply(game: LiveGame, payload: unknown): IntentResult {
      if (!isRecord(payload)) return { ok: false, error: 'malformed payload' };
      const { islandId, buildingId, x, y, rotation } = payload;
      if (typeof islandId !== 'string') return { ok: false, error: 'islandId must be a string' };
      if (typeof buildingId !== 'string') return { ok: false, error: 'buildingId must be a string' };
      if (typeof x !== 'number' || !Number.isInteger(x)) return { ok: false, error: 'x must be an integer' };
      if (typeof y !== 'number' || !Number.isInteger(y)) return { ok: false, error: 'y must be an integer' };
      if (rotation !== undefined && rotation !== 0 && rotation !== 1 && rotation !== 2 && rotation !== 3) {
        return { ok: false, error: 'rotation must be 0..3' };
      }
      const island = resolveIsland(game, islandId);
      if (!island) return { ok: false, error: 'unknown island' };
      const rot = rotation === undefined ? undefined : (rotation as Rotation);
      const r = relocateBuilding(island.spec, island.state, buildingId, x, y, rot);
      if (!r.ok) return { ok: false, error: r.reason ?? 'relocate failed' };
      return { ok: true };
    },
  },

  // set-force-run — §4.6 per-building production override. Player supplies
  // { islandId, buildingId, forceRun: boolean }. No cost; authoritative pre-
  // check is just building existence/ownership on the island.
  'set-force-run': {
    apply(game: LiveGame, payload: unknown): IntentResult {
      if (!isRecord(payload)) return { ok: false, error: 'malformed payload' };
      const { islandId, buildingId, forceRun } = payload;
      if (typeof islandId !== 'string') return { ok: false, error: 'islandId must be a string' };
      if (typeof buildingId !== 'string') return { ok: false, error: 'buildingId must be a string' };
      if (typeof forceRun !== 'boolean') return { ok: false, error: 'forceRun must be a boolean' };
      const island = resolveIsland(game, islandId);
      if (!island) return { ok: false, error: 'unknown island' };
      const b = island.spec.buildings.find((bb) => bb.id === buildingId);
      if (!b) return { ok: false, error: 'not-found' };
      b.forceRun = forceRun ? true : undefined;
      return { ok: true };
    },
  },

  // relabel-cargo — §4.6 generic-storage cargo label change. Player supplies
  // { islandId, buildingId, newLabel }. `applyRelabelStorageCap` moves the
  // storage-cap contribution from the old label to the new one; the handler
  // validates the building is generic-storage and the new label is a real
  // ResourceId, then updates `building.cargoLabel`.
  'relabel-cargo': {
    apply(game: LiveGame, payload: unknown): IntentResult {
      if (!isRecord(payload)) return { ok: false, error: 'malformed payload' };
      const { islandId, buildingId, newLabel } = payload;
      if (typeof islandId !== 'string') return { ok: false, error: 'islandId must be a string' };
      if (typeof buildingId !== 'string') return { ok: false, error: 'buildingId must be a string' };
      if (typeof newLabel !== 'string' || !isValidResourceId(newLabel)) {
        return { ok: false, error: 'newLabel must be a valid resource id' };
      }
      const island = resolveIsland(game, islandId);
      if (!island) return { ok: false, error: 'unknown island' };
      const b = island.spec.buildings.find((bb) => bb.id === buildingId);
      if (!b) return { ok: false, error: 'not-found' };
      const def = BUILDING_DEFS[b.defId];
      if (!def.storage || def.storage.category !== 'generic') {
        return { ok: false, error: 'building is not generic storage' };
      }
      applyRelabelStorageCap(island.state, b, def, b.cargoLabel, newLabel);
      b.cargoLabel = newLabel;
      return { ok: true };
    },
  },

  // expand-island — §3.4 Land Reclamation Hub action. Player supplies
  // { islandId, axis: 'major'|'minor' }. `expandIsland` self-validates via
  // `canExpandIsland` (hub presence, biome cap, inventory) and deducts cost
  // from authoritative inventory, so no separate handler affordability pre-
  // check is needed beyond shape validation.
  'expand-island': {
    apply(game: LiveGame, payload: unknown): IntentResult {
      if (!isRecord(payload)) return { ok: false, error: 'malformed payload' };
      const { islandId, axis } = payload;
      if (typeof islandId !== 'string') return { ok: false, error: 'islandId must be a string' };
      if (axis !== 'major' && axis !== 'minor') return { ok: false, error: 'axis must be major or minor' };
      const island = resolveIsland(game, islandId);
      if (!island) return { ok: false, error: 'unknown island' };
      // Authoritative gate mirror: expandIsland is a no-op when canExpandIsland
      // fails, but we surface the reason instead of silently succeeding.
      const can = canExpandIsland(island.spec, island.state, axis as Axis);
      if (!can.ok) return { ok: false, error: can.reason ?? 'expand failed' };
      expandIsland(island.spec, island.state, axis as Axis);
      return { ok: true };
    },
  },

  // rename-island — §3 player-mutable display name. Player supplies
  // { islandId, name }. `renameIsland` self-validates length/empty/control-char
  // and mutates only `spec.name`; the handler validates island existence.
  'rename-island': {
    apply(game: LiveGame, payload: unknown): IntentResult {
      if (!isRecord(payload)) return { ok: false, error: 'malformed payload' };
      const { islandId, name } = payload;
      if (typeof islandId !== 'string') return { ok: false, error: 'islandId must be a string' };
      if (typeof name !== 'string') return { ok: false, error: 'name must be a string' };
      const island = resolveIsland(game, islandId);
      if (!island) return { ok: false, error: 'unknown island' };
      const r = renameIsland(island.spec, name);
      if (!r.ok) return { ok: false, error: r.reason ?? 'rename failed' };
      return { ok: true };
    },
  },

  // edit-biome — §13.3 Universe Editor biome reassignment. Player supplies
  // { islandId, biomeId }. `editIslandBiome` self-validates the Universe Editor
  // presence, resource cost, and biome legality, deducts cost, and mutates the
  // island biome + modifiers + terrain.
  'edit-biome': {
    apply(game: LiveGame, payload: unknown): IntentResult {
      if (!isRecord(payload)) return { ok: false, error: 'malformed payload' };
      const { islandId, biomeId } = payload;
      if (typeof islandId !== 'string') return { ok: false, error: 'islandId must be a string' };
      if (typeof biomeId !== 'string') return { ok: false, error: 'biomeId must be a string' };
      if (!(biomeId in BIOME_DEFS)) return { ok: false, error: 'unknown biome' };
      const r = editIslandBiome(game.world, islandId, biomeId as Biome);
      if (!r.ok) return { ok: false, error: r.reason ?? 'edit biome failed' };
      return { ok: true };
    },
  },

  // construct-island — §2.5 artificial island construction. Player supplies
  // { founderIslandId, biome, majorRadius, minorRadius, cx, cy, displayName? }.
  // The server mints the new island id and timestamp from authoritative state;
  // it never trusts a client-supplied id. `validateConstruction` gates tier,
  // Platform Constructor presence, biome, radii, and materials.
  'construct-island': {
    apply(game: LiveGame, payload: unknown, now: number): IntentResult {
      if (!isRecord(payload)) return { ok: false, error: 'malformed payload' };
      const { founderIslandId, biome, majorRadius, minorRadius, cx, cy, displayName } = payload;
      if (typeof founderIslandId !== 'string') return { ok: false, error: 'founderIslandId must be a string' };
      if (typeof biome !== 'string') return { ok: false, error: 'biome must be a string' };
      if (!(biome in BIOME_DEFS)) return { ok: false, error: 'unknown biome' };
      if (typeof majorRadius !== 'number' || !Number.isInteger(majorRadius) || majorRadius <= 0) {
        return { ok: false, error: 'majorRadius must be a positive integer' };
      }
      if (typeof minorRadius !== 'number' || !Number.isInteger(minorRadius) || minorRadius <= 0) {
        return { ok: false, error: 'minorRadius must be a positive integer' };
      }
      if (typeof cx !== 'number' || !Number.isFinite(cx)) return { ok: false, error: 'cx must be finite' };
      if (typeof cy !== 'number' || !Number.isFinite(cy)) return { ok: false, error: 'cy must be finite' };
      if (displayName !== undefined && typeof displayName !== 'string') {
        return { ok: false, error: 'displayName must be a string' };
      }
      const founder = resolveIsland(game, founderIslandId);
      if (!founder) return { ok: false, error: 'unknown founder island' };
      const req = { biome: biome as Biome, majorRadius, minorRadius };
      const can = validateConstruction(founder.state, founder.spec, req);
      if (!can.ok) return { ok: false, error: can.reason ?? 'construction invalid' };
      const id = makeArtificialIdGenerator(game.world)();
      let name: string | undefined;
      if (typeof displayName === 'string') {
        const v = validateIslandName(displayName);
        if (v.ok) name = v.name;
      }
      try {
        const { newSpec, newState } = constructIsland(
          game.world.seed,
          founder.state,
          founder.spec,
          req,
          { cx, cy },
          id,
          now,
          name,
        );
        game.world.islands.push(newSpec);
        game.islandStates.set(newSpec.id, newState);
        return { ok: true };
      } catch (e) {
        return { ok: false, error: e instanceof Error ? e.message : 'construction failed' };
      }
    },
  },

  // fire-t4-pulse — §11.5 T4 omnidirectional discovery pulse. Player supplies
  // { islandId }. `firePulse` self-validates launch-tower presence, tier-4
  // island, and `cryogenic_hydrogen` fuel on hand; the handler only validates
  // island existence.
  'fire-t4-pulse': {
    apply(game: LiveGame, payload: unknown, now: number): IntentResult {
      if (!isRecord(payload)) return { ok: false, error: 'malformed payload' };
      const { islandId } = payload;
      if (typeof islandId !== 'string') return { ok: false, error: 'islandId must be a string' };
      const island = resolveIsland(game, islandId);
      if (!island) return { ok: false, error: 'unknown island' };
      const r = firePulse(game.world, island.state, now);
      if (!r.ok) return { ok: false, error: r.reason ?? 'pulse failed' };
      return { ok: true };
    },
  },

  // delete-route — §2.4 soft-delete a route. Player supplies { routeId }.
  // Authoritative pre-check: the route must exist. `draining = true` stops new
  // dispatch and lets in-flight cargo land before tickRoutes prunes it.
  'delete-route': {
    apply(game: LiveGame, payload: unknown): IntentResult {
      if (!isRecord(payload)) return { ok: false, error: 'malformed payload' };
      const { routeId } = payload;
      if (typeof routeId !== 'string') return { ok: false, error: 'routeId must be a string' };
      const route = resolveRoute(game, routeId);
      if (!route) return { ok: false, error: 'route not found' };
      route.draining = true;
      return { ok: true };
    },
  },

  // set-route-mode — change how a route divides capacity across cargo. Player
  // supplies { routeId, mode }. Validates mode is a real CargoMode and the
  // route exists.
  'set-route-mode': {
    apply(game: LiveGame, payload: unknown): IntentResult {
      if (!isRecord(payload)) return { ok: false, error: 'malformed payload' };
      const { routeId, mode } = payload;
      if (typeof routeId !== 'string') return { ok: false, error: 'routeId must be a string' };
      if (!isValidCargoMode(mode)) return { ok: false, error: 'invalid cargo mode' };
      const route = resolveRoute(game, routeId);
      if (!route) return { ok: false, error: 'route not found' };
      route.mode = mode;
      return { ok: true };
    },
  },

  // set-cargo-weight — split-mode weight for one cargo entry. Player supplies
  // { routeId, cargoIndex, weight }. Validates the route, index bounds, and
  // positive weight.
  'set-cargo-weight': {
    apply(game: LiveGame, payload: unknown): IntentResult {
      if (!isRecord(payload)) return { ok: false, error: 'malformed payload' };
      const { routeId, cargoIndex, weight } = payload;
      if (typeof routeId !== 'string') return { ok: false, error: 'routeId must be a string' };
      if (typeof cargoIndex !== 'number' || !Number.isInteger(cargoIndex) || cargoIndex < 0) {
        return { ok: false, error: 'cargoIndex must be a non-negative integer' };
      }
      if (typeof weight !== 'number' || !Number.isFinite(weight) || weight <= 0) {
        return { ok: false, error: 'weight must be positive' };
      }
      const route = resolveRoute(game, routeId);
      if (!route) return { ok: false, error: 'route not found' };
      if (cargoIndex >= route.cargo.length) return { ok: false, error: 'cargoIndex out of range' };
      route.cargo[cargoIndex] = { ...route.cargo[cargoIndex]!, weight };
      return { ok: true };
    },
  },

  // set-cargo-floor-pct — source-floor gate for one cargo entry. Player supplies
  // { routeId, cargoIndex, sourceFloorPct }. Validates 0..100.
  'set-cargo-floor-pct': {
    apply(game: LiveGame, payload: unknown): IntentResult {
      if (!isRecord(payload)) return { ok: false, error: 'malformed payload' };
      const { routeId, cargoIndex, sourceFloorPct } = payload;
      if (typeof routeId !== 'string') return { ok: false, error: 'routeId must be a string' };
      if (typeof cargoIndex !== 'number' || !Number.isInteger(cargoIndex) || cargoIndex < 0) {
        return { ok: false, error: 'cargoIndex must be a non-negative integer' };
      }
      const hasFloor = sourceFloorPct !== undefined;
      if (hasFloor && (typeof sourceFloorPct !== 'number' || !Number.isFinite(sourceFloorPct) || sourceFloorPct < 0 || sourceFloorPct > 100)) {
        return { ok: false, error: 'sourceFloorPct must be 0..100' };
      }
      const route = resolveRoute(game, routeId);
      if (!route) return { ok: false, error: 'route not found' };
      if (cargoIndex >= route.cargo.length) return { ok: false, error: 'cargoIndex out of range' };
      const entry = route.cargo[cargoIndex]!;
      route.cargo[cargoIndex] = hasFloor
        ? { resourceId: entry.resourceId, weight: entry.weight, sourceFloorPct }
        : { resourceId: entry.resourceId, weight: entry.weight };
      return { ok: true };
    },
  },

  // reorder-route-cargo — priority/waterfall ordering. Player supplies
  // { routeId, srcIndex, dstIndex }. Uses the same `reorderPriorityList` helper
  // as the routes-UI.
  'reorder-route-cargo': {
    apply(game: LiveGame, payload: unknown): IntentResult {
      if (!isRecord(payload)) return { ok: false, error: 'malformed payload' };
      const { routeId, srcIndex, dstIndex } = payload;
      if (typeof routeId !== 'string') return { ok: false, error: 'routeId must be a string' };
      if (typeof srcIndex !== 'number' || !Number.isInteger(srcIndex) || srcIndex < 0) {
        return { ok: false, error: 'srcIndex must be a non-negative integer' };
      }
      if (typeof dstIndex !== 'number' || !Number.isInteger(dstIndex) || dstIndex < 0) {
        return { ok: false, error: 'dstIndex must be a non-negative integer' };
      }
      const route = resolveRoute(game, routeId);
      if (!route) return { ok: false, error: 'route not found' };
      if (srcIndex >= route.cargo.length || dstIndex >= route.cargo.length) {
        return { ok: false, error: 'index out of range' };
      }
      route.cargo = reorderPriorityList(route.cargo, srcIndex, dstIndex) as CargoEntry[];
      return { ok: true };
    },
  },

  // set-route-cargo — replace the whole cargo list (add/remove). Player supplies
  // { routeId, cargo: CargoEntry[] }. The server validates every entry against
  // the authoritative resource catalog and the no-duplicate/no-multi-wildcard
  // invariant before replacing.
  'set-route-cargo': {
    apply(game: LiveGame, payload: unknown): IntentResult {
      if (!isRecord(payload)) return { ok: false, error: 'malformed payload' };
      const { routeId, cargo } = payload;
      if (typeof routeId !== 'string') return { ok: false, error: 'routeId must be a string' };
      const route = resolveRoute(game, routeId);
      if (!route) return { ok: false, error: 'route not found' };
      const v = validateCargoList(cargo);
      if (!v.ok) return { ok: false, error: v.error };
      route.cargo = v.list;
      return { ok: true };
    },
  },

  // buy-keystone — §9.3 AND-prereq keystone purchase. Player supplies
  // { islandId, nodeId }. `buyKeystone` throws on illegal requests, so the
  // handler pre-checks with `canBuyKeystone` against authoritative state (all
  // prereq nodes owned + enough unspent SP) before deducting SP.
  'buy-keystone': {
    apply(game: LiveGame, payload: unknown): IntentResult {
      if (!isRecord(payload)) return { ok: false, error: 'malformed payload' };
      const { islandId, nodeId } = payload;
      if (typeof islandId !== 'string') return { ok: false, error: 'islandId must be a string' };
      if (typeof nodeId !== 'string') return { ok: false, error: 'nodeId must be a string' };
      const island = resolveIsland(game, islandId);
      if (!island) return { ok: false, error: 'unknown island' };
      const ks = keystonePrereqFor(nodeId);
      if (ks === undefined) return { ok: false, error: 'not a keystone' };
      if (!canBuyKeystone(ks, island.state)) return { ok: false, error: 'prereqs or sp not met' };
      buyKeystone(ks, island.state);
      return { ok: true };
    },
  },

  // bind-crystal — §9.3 graft-socket binding. Player supplies
  // { islandId, socketId, crystalId }. Consumes one crystal from authoritative
  // inventory and refunds any previously-bound crystal + mini-tree SP. The pure
  // `bindCrystal` throws on bad input, so the handler pre-checks socket/crystal
  // existence, sub-path eligibility, and inventory.
  'bind-crystal': {
    apply(game: LiveGame, payload: unknown): IntentResult {
      if (!isRecord(payload)) return { ok: false, error: 'malformed payload' };
      const { islandId, socketId, crystalId } = payload;
      if (typeof islandId !== 'string') return { ok: false, error: 'islandId must be a string' };
      if (typeof socketId !== 'string') return { ok: false, error: 'socketId must be a string' };
      if (typeof crystalId !== 'string') return { ok: false, error: 'crystalId must be a string' };
      const island = resolveIsland(game, islandId);
      if (!island) return { ok: false, error: 'unknown island' };
      const socket = DEFAULT_GRAPH.graftSockets.find((s) => s.id === socketId);
      if (!socket) return { ok: false, error: 'unknown socket' };
      const crystal = CRYSTAL_CATALOG.find((c) => c.id === crystalId);
      if (!crystal) return { ok: false, error: 'unknown crystal' };
      if (!crystal.eligibleSubPaths.includes(socket.subPathId)) {
        return { ok: false, error: 'crystal ineligible for socket sub-path' };
      }
      const rid = crystalId as ResourceId;
      if ((island.state.inventory[rid] ?? 0) <= 0) {
        return { ok: false, error: 'crystal not in inventory' };
      }
      bindCrystal(island.state, socketId, crystalId as CrystalId);
      return { ok: true };
    },
  },

  // unbind-crystal — §9.3 graft-socket unbinding. Player supplies
  // { islandId, socketId }. Returns the bound crystal to authoritative inventory
  // and refunds mini-tree SP via `unbindCrystal` (no-op if socket empty).
  'unbind-crystal': {
    apply(game: LiveGame, payload: unknown): IntentResult {
      if (!isRecord(payload)) return { ok: false, error: 'malformed payload' };
      const { islandId, socketId } = payload;
      if (typeof islandId !== 'string') return { ok: false, error: 'islandId must be a string' };
      if (typeof socketId !== 'string') return { ok: false, error: 'socketId must be a string' };
      const island = resolveIsland(game, islandId);
      if (!island) return { ok: false, error: 'unknown island' };
      unbindCrystal(island.state, socketId);
      return { ok: true };
    },
  },

  // tier-reset — §9.7 revert a T3+ island to T1, refunding spent SP. Player
  // supplies { islandId }. `executeTierReset` trusts its caller (it can drive
  // inventory negative and bypass the cooldown), so the handler pre-checks with
  // `canTierReset` against authoritative state before applying.
  'tier-reset': {
    apply(game: LiveGame, payload: unknown, now: number): IntentResult {
      if (!isRecord(payload)) return { ok: false, error: 'malformed payload' };
      const { islandId } = payload;
      if (typeof islandId !== 'string') return { ok: false, error: 'islandId must be a string' };
      const island = resolveIsland(game, islandId);
      if (!island) return { ok: false, error: 'unknown island' };
      const can = canTierReset(island.state, now);
      if (!can.ok) return { ok: false, error: can.reason ?? 'tier reset failed' };
      executeTierReset(island.state, now);
      return { ok: true };
    },
  },

  // dispatch-settler — §12.6 launch a ship/helicopter to settle a discovered,
  // unpopulated island. Player supplies { originIslandId, targetIslandId, kind,
  // tier, fuelLoaded, foundationKitCount }. `dispatchVehicle` self-validates
  // launch building, fuel grade/amount, kit count, range, and one-in-flight cap;
  // the handler validates payload shape and endpoint existence/ownership.
  'dispatch-settler': {
    apply(game: LiveGame, payload: unknown, now: number): IntentResult {
      if (!isRecord(payload)) return { ok: false, error: 'malformed payload' };
      const { originIslandId, targetIslandId, kind, tier, fuelLoaded, foundationKitCount } = payload;
      if (typeof originIslandId !== 'string') return { ok: false, error: 'originIslandId must be a string' };
      if (typeof targetIslandId !== 'string') return { ok: false, error: 'targetIslandId must be a string' };
      if (!isValidVehicleKind(kind)) return { ok: false, error: 'kind must be ship or helicopter' };
      if (!isValidVehicleTier(tier)) return { ok: false, error: 'tier must be 1..4' };
      if (typeof fuelLoaded !== 'number' || !Number.isFinite(fuelLoaded) || fuelLoaded <= 0) {
        return { ok: false, error: 'fuelLoaded must be positive' };
      }
      if (typeof foundationKitCount !== 'number' || !Number.isInteger(foundationKitCount) || foundationKitCount < 1) {
        return { ok: false, error: 'foundationKitCount must be a positive integer' };
      }
      if (originIslandId === targetIslandId) return { ok: false, error: 'origin and target must differ' };
      const origin = resolveIsland(game, originIslandId);
      if (!origin) return { ok: false, error: 'unknown origin island' };
      const targetSpec = game.world.islands.find((s) => s.id === targetIslandId);
      if (!targetSpec) return { ok: false, error: 'unknown target island' };
      if (!targetSpec.discovered) return { ok: false, error: 'target not discovered' };
      if (targetSpec.populated) return { ok: false, error: 'target already populated' };
      const r = dispatchVehicle(
        game.world, origin.spec, origin.state, targetSpec,
        kind, tier, fuelLoaded, foundationKitCount, now,
      );
      if (!r.ok) return { ok: false, error: r.reason };
      return { ok: true };
    },
  },

  // settle-via-spacetime — §12.6 instant T5 settlement via Spacetime Anchor.
  // Player supplies { originIslandId, targetIslandId }. `settleViaSpacetimeAnchor`
  // self-validates the anchor, refined kit, and target eligibility, then
  // populates the target.
  'settle-via-spacetime': {
    apply(game: LiveGame, payload: unknown, now: number): IntentResult {
      if (!isRecord(payload)) return { ok: false, error: 'malformed payload' };
      const { originIslandId, targetIslandId } = payload;
      if (typeof originIslandId !== 'string') return { ok: false, error: 'originIslandId must be a string' };
      if (typeof targetIslandId !== 'string') return { ok: false, error: 'targetIslandId must be a string' };
      if (originIslandId === targetIslandId) return { ok: false, error: 'origin and target must differ' };
      const origin = resolveIsland(game, originIslandId);
      if (!origin) return { ok: false, error: 'unknown origin island' };
      const targetSpec = game.world.islands.find((s) => s.id === targetIslandId);
      if (!targetSpec) return { ok: false, error: 'unknown target island' };
      if (!targetSpec.discovered) return { ok: false, error: 'target not discovered' };
      if (targetSpec.populated) return { ok: false, error: 'target already populated' };
      const r = settleViaSpacetimeAnchor(game.world, game.islandStates, originIslandId, targetIslandId, now);
      if (!r.ok) return { ok: false, error: r.reason };
      return { ok: true };
    },
  },

  // launch-satellite — §14.2 T6 orbital launch. Player supplies
  // { islandId, variant, targetX, targetY }. `launchSatellite` self-validates
  // spaceport, ascendant core, payload resources, target range, and the success
  // roll; deducts cost and (on success) appends a satellite.
  'launch-satellite': {
    apply(game: LiveGame, payload: unknown, now: number): IntentResult {
      if (!isRecord(payload)) return { ok: false, error: 'malformed payload' };
      const { islandId, variant, targetX, targetY } = payload;
      if (typeof islandId !== 'string') return { ok: false, error: 'islandId must be a string' };
      if (!isValidSatelliteVariant(variant)) return { ok: false, error: 'variant must be scanner, sweeper, relay, or mirror' };
      if (typeof targetX !== 'number' || !Number.isFinite(targetX)) return { ok: false, error: 'targetX must be finite' };
      if (typeof targetY !== 'number' || !Number.isFinite(targetY)) return { ok: false, error: 'targetY must be finite' };
      const r = launchSatellite(game.world, islandId, variant, targetX, targetY, now);
      if (!r.ok) return { ok: false, error: r.reason };
      return { ok: true };
    },
  },

  // upgrade-spaceport — §14.2 Spaceport tier upgrade. Player supplies
  // { islandId }. `upgradeSpaceport` self-validates spaceport presence and
  // resource cost, then bumps the building tier.
  'upgrade-spaceport': {
    apply(game: LiveGame, payload: unknown): IntentResult {
      if (!isRecord(payload)) return { ok: false, error: 'malformed payload' };
      const { islandId } = payload;
      if (typeof islandId !== 'string') return { ok: false, error: 'islandId must be a string' };
      const r = upgradeSpaceport(game.world, islandId);
      if (!r.ok) return { ok: false, error: r.reason };
      return { ok: true };
    },
  },

  // move-satellite — §14.6 in-orbit relocation. Player supplies
  // { satId, targetX, targetY }. `requestSatMove` self-validates sat existence,
  // not-already-moving, not-pending-repair, locked, and onboard fuel sufficiency.
  'move-satellite': {
    apply(game: LiveGame, payload: unknown, now: number): IntentResult {
      if (!isRecord(payload)) return { ok: false, error: 'malformed payload' };
      const { satId, targetX, targetY } = payload;
      if (typeof satId !== 'string') return { ok: false, error: 'satId must be a string' };
      if (typeof targetX !== 'number' || !Number.isFinite(targetX)) return { ok: false, error: 'targetX must be finite' };
      if (typeof targetY !== 'number' || !Number.isFinite(targetY)) return { ok: false, error: 'targetY must be finite' };
      const r = requestSatMove(game.world, satId, targetX, targetY, now);
      if (!r.ok) return { ok: false, error: r.reason };
      return { ok: true };
    },
  },

  // dispatch-repair-drone — §14.12 send a repair drone to a satellite. Player
  // supplies { islandId, satId }. `dispatchRepairDrone` self-validates the
  // spaceport, ascendant core, repair pack, and antimatter propellant, then
  // appends a RepairDrone.
  'dispatch-repair-drone': {
    apply(game: LiveGame, payload: unknown, now: number): IntentResult {
      if (!isRecord(payload)) return { ok: false, error: 'malformed payload' };
      const { islandId, satId } = payload;
      if (typeof islandId !== 'string') return { ok: false, error: 'islandId must be a string' };
      if (typeof satId !== 'string') return { ok: false, error: 'satId must be a string' };
      const r = dispatchRepairDrone(game.world, islandId, satId, now);
      if (!r.ok) return { ok: false, error: r.reason };
      return { ok: true };
    },
  },

  // UNWIRED: convert-to-servitor. The pure entry function lives in
  // `src/buildings.ts`, which imports `pixi.js` for rendering. Importing it into
  // the server would drag the renderer into the authoritative layer, violating
  // the pure/render split. Left for a future slice that extracts or mirrors the
  // pure logic without the PixiJS dependency.
  //
  // UNWIRED: reject-trade. Trade offers are runtime-only and unpersisted on the
  // client; there is no authoritative offer state server-side to validate
  // against. Wired only when server-deterministic trade offers land.
};
