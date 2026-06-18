// server/src/game/persistence.ts
//
// Storage boundary for the authoritative save. The game state is sharded across
// three tables (migration 0003) so it scales with the game instead of living in
// one ever-growing jsonb blob:
//   - save_meta    : schema version + save timestamps
//   - save_world   : the world object minus islandStates
//   - save_islands : one row per island runtime state, keyed (user_id, island_id)
//
// The pure `SaveSnapshot` shape is unchanged: `saveSnapshot` splits it across the
// rows and `loadSnapshot` reassembles an identical snapshot. Reads use a SINGLE
// aggregating query so the lock-free read paths (GET /api/game/state, the WS
// read-only push) cannot observe a torn write — writes run inside the caller's
// per-account transaction (see withAccountTx), so the three-table update is
// atomic and serialized against concurrent intents.

import type { Queryable } from '../db.js';
import type {
  SaveSnapshot,
  SerializedWorld,
  SerializedIslandStateEntry,
} from '../../../src/persistence.js';

export async function hasSave(db: Queryable, userId: string): Promise<boolean> {
  const res = await db.query('SELECT 1 FROM save_meta WHERE user_id = $1', [userId]);
  return (res.rowCount ?? 0) > 0;
}

export async function loadSnapshot(db: Queryable, userId: string): Promise<SaveSnapshot | null> {
  // One statement → one MVCC snapshot → no torn read across the three tables.
  const res = await db.query<{
    schema_version: number;
    saved_at: number;
    saved_at_perf: number;
    world: SerializedWorld;
    island_states: ReadonlyArray<SerializedIslandStateEntry>;
  }>(
    `SELECT m.schema_version, m.saved_at, m.saved_at_perf, w.world,
       COALESCE(
         (SELECT jsonb_agg(jsonb_build_object('id', i.island_id, 'state', i.state) ORDER BY i.ord)
            FROM save_islands i WHERE i.user_id = m.user_id),
         '[]'::jsonb
       ) AS island_states
     FROM save_meta m
     JOIN save_world w ON w.user_id = m.user_id
     WHERE m.user_id = $1`,
    [userId],
  );
  const row = res.rows[0];
  if (!row) return null;
  return {
    v: row.schema_version as SaveSnapshot['v'],
    savedAt: row.saved_at,
    savedAtPerf: row.saved_at_perf,
    world: row.world,
    islandStates: row.island_states,
  };
}

export async function saveSnapshot(db: Queryable, userId: string, snapshot: SaveSnapshot): Promise<void> {
  // MUST run inside the caller's per-account transaction (withAccountTx) so these
  // statements commit atomically and serialize against concurrent intents.
  await db.query(
    `INSERT INTO save_meta (user_id, schema_version, saved_at, saved_at_perf, updated_at)
       VALUES ($1, $2, $3, $4, now())
     ON CONFLICT (user_id) DO UPDATE
       SET schema_version = EXCLUDED.schema_version,
           saved_at       = EXCLUDED.saved_at,
           saved_at_perf  = EXCLUDED.saved_at_perf,
           updated_at     = now()`,
    [userId, snapshot.v, snapshot.savedAt, snapshot.savedAtPerf],
  );
  await db.query(
    `INSERT INTO save_world (user_id, world) VALUES ($1, $2)
     ON CONFLICT (user_id) DO UPDATE SET world = EXCLUDED.world`,
    [userId, JSON.stringify(snapshot.world)],
  );
  // PERF: upsert all island rows in BATCHED multi-row INSERTs instead of one
  // round-trip per island. saveSnapshot runs on every persisted intent (and
  // twice per intent via loadAndCatchUp), and the per-island round-trips were
  // ~all of its ~75ms wall time on a 65-island save. Identical writes (same
  // rows, same ON CONFLICT upsert, same trailing DELETE); only the number of
  // network round-trips changes. Chunked to stay well under Postgres' 65535
  // bind-parameter ceiling (4 params/row → 16k rows/chunk; 1000 is plenty).
  const ids: string[] = [];
  const entries = snapshot.islandStates;
  const CHUNK = 1000;
  for (let start = 0; start < entries.length; start += CHUNK) {
    const chunk = entries.slice(start, start + CHUNK);
    const params: unknown[] = [];
    const rows: string[] = [];
    for (let i = 0; i < chunk.length; i++) {
      const entry = chunk[i]!;
      ids.push(entry.id);
      const b = i * 4;
      rows.push(`($${b + 1}, $${b + 2}, $${b + 3}, $${b + 4})`);
      params.push(userId, entry.id, start + i, JSON.stringify(entry.state));
    }
    await db.query(
      `INSERT INTO save_islands (user_id, island_id, ord, state) VALUES ${rows.join(', ')}
       ON CONFLICT (user_id, island_id) DO UPDATE
         SET ord = EXCLUDED.ord, state = EXCLUDED.state`,
      params,
    );
  }
  // Drop island rows no longer present (e.g. merged-away islands). With no
  // islands, `= ANY('{}')` is always false so this clears every row.
  await db.query('DELETE FROM save_islands WHERE user_id = $1 AND NOT (island_id = ANY($2))', [userId, ids]);
}
