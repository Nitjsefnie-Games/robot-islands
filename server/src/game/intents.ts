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
import { placeBuilding, validatePlacement } from '../../../src/placement.js';
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
};
