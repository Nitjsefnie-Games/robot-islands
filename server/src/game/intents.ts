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
import { BUILDING_DEFS, type BuildingDefId } from '../../../src/building-defs.js';
import {
  placeBuilding,
  validatePlacement,
  demolishBuilding,
  cancelConstruction,
  applyUpgrade,
  setBuildingActiveFloors,
} from '../../../src/placement.js';
import { displayedFloorLevel } from '../../../src/floor-levels.js';
import { dispatchDrone } from '../../../src/drones.js';
import {
  createRouteFromBuilding,
  routeProfileForBuilding,
  islandHasTeleporterPad,
} from '../../../src/routes.js';
import { buyNode, nodePurchaseStatus, keystonePrereqFor, DEFAULT_GRAPH } from '../../../src/skilltree.js';
import type { ResourceId } from '../../../src/recipes.js';
import type { Rotation } from '../../../src/shape-mask.js';

export type IntentResult = { ok: true } | { ok: false; error: string };

export interface IntentHandler {
  apply(game: LiveGame, payload: unknown, now: number): IntentResult;
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
    apply(game: LiveGame, payload: unknown): IntentResult {
      if (!isRecord(payload)) return { ok: false, error: 'malformed payload' };
      const { islandId, defId, x, y, rotation } = payload;
      if (typeof islandId !== 'string') return { ok: false, error: 'islandId must be a string' };
      if (typeof defId !== 'string' || !(defId in BUILDING_DEFS)) {
        return { ok: false, error: 'unknown defId' };
      }
      if (typeof x !== 'number' || !Number.isInteger(x)) return { ok: false, error: 'x must be an integer' };
      if (typeof y !== 'number' || !Number.isInteger(y)) return { ok: false, error: 'y must be an integer' };
      if (rotation !== 0 && rotation !== 1 && rotation !== 2 && rotation !== 3) {
        return { ok: false, error: 'rotation must be 0..3' };
      }
      const island = resolveIsland(game, islandId);
      if (!island) return { ok: false, error: 'unknown island' };
      const { spec, state } = island;
      const typedDefId = defId as BuildingDefId;
      const rot = rotation as Rotation;

      // Authoritative legality pre-check: tier-unlock, biome, ellipse bounds,
      // overlap, terrain/coastal, and the §14 cost gate — all recomputed from
      // server state. The client's claim is never trusted.
      const v = validatePlacement(spec, state, typedDefId, x, y, rot);
      if (!v.ok) return { ok: false, error: v.reason ?? 'illegal placement' };

      // Apply via the pure entry fn. It re-checks the cost + queue gates and
      // deducts cost from authoritative inventory only on the success path.
      const result = placeBuilding(spec, state, typedDefId, x, y, rot, makePlacedIdGenerator(spec));
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
      const { islandId, originX, originY, dirX, dirY, fuelLoaded } = payload;
      if (typeof islandId !== 'string') return { ok: false, error: 'islandId must be a string' };
      for (const [name, v] of [
        ['originX', originX], ['originY', originY],
        ['dirX', dirX], ['dirY', dirY], ['fuelLoaded', fuelLoaded],
      ] as const) {
        if (typeof v !== 'number' || !Number.isFinite(v)) {
          return { ok: false, error: `${name} must be a finite number` };
        }
      }
      const island = resolveIsland(game, islandId);
      if (!island) return { ok: false, error: 'unknown island' };
      const r = dispatchDrone(
        game.world, island.state,
        originX as number, originY as number,
        dirX as number, dirY as number,
        fuelLoaded as number, now,
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
      if (filterResource !== undefined && typeof filterResource !== 'string') {
        return { ok: false, error: 'filterResource must be a string when present' };
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
      const filter = filterResource === undefined ? null : (filterResource as ResourceId);
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
      const status = nodePurchaseStatus(DEFAULT_GRAPH, state, nodeId);
      if (status !== 'purchasable') return { ok: false, error: status };
      buyNode(DEFAULT_GRAPH, state, nodeId);
      return { ok: true };
    },
  },
};
