-- server/migrations/0003_split_saves.sql
--
-- Shard the monolithic `saves` row (one ~200 KiB+ jsonb blob holding the entire
-- game state) into a per-concern model so storage scales with the game and an
-- island's runtime is no longer wedged inside one ever-growing document:
--   - save_meta    : schema version + save timestamps (one row/account)
--   - save_world   : the world object minus islandStates (one row/account)
--   - save_islands : one row per island runtime state, keyed (user_id, island_id)
--
-- The pure `SaveSnapshot` shape is UNCHANGED — only the storage boundary
-- (server/src/game/persistence.ts) reshapes on write and reassembles on read.
-- The split + reassembly was verified byte-identical against the live save
-- before this migration was committed.

CREATE TABLE IF NOT EXISTS save_meta (
  user_id        uuid PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  schema_version integer NOT NULL,
  -- ms timestamps; double precision holds Date.now()/performance.now() exactly
  -- (< 2^53) and round-trips to a JS number with no int8-as-string handling.
  saved_at       double precision NOT NULL,
  saved_at_perf  double precision NOT NULL,
  created_at     timestamptz NOT NULL DEFAULT now(),
  updated_at     timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS save_world (
  user_id uuid PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  world   jsonb NOT NULL
);

CREATE TABLE IF NOT EXISTS save_islands (
  user_id   uuid    NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  island_id text    NOT NULL,
  -- preserves the islandStates array order for an identical reassembly
  ord       integer NOT NULL,
  state     jsonb   NOT NULL,
  PRIMARY KEY (user_id, island_id)
);
CREATE INDEX IF NOT EXISTS save_islands_user_ord_idx ON save_islands (user_id, ord);

-- Backfill from the monolith (a no-op on a fresh DB where `saves` is empty).
-- Only rows whose account still exists are migrated: an orphaned `saves` row
-- (user_id absent from `users`) cannot satisfy the new tables' FK and is dropped
-- with `saves` below regardless.
INSERT INTO save_meta (user_id, schema_version, saved_at, saved_at_perf)
  SELECT s.user_id,
         (s.snapshot->>'v')::int,
         (s.snapshot->>'savedAt')::double precision,
         (s.snapshot->>'savedAtPerf')::double precision
  FROM saves s
  WHERE EXISTS (SELECT 1 FROM users u WHERE u.id = s.user_id)
  ON CONFLICT (user_id) DO NOTHING;

INSERT INTO save_world (user_id, world)
  SELECT s.user_id, s.snapshot->'world'
  FROM saves s
  WHERE EXISTS (SELECT 1 FROM users u WHERE u.id = s.user_id)
  ON CONFLICT (user_id) DO NOTHING;

INSERT INTO save_islands (user_id, island_id, ord, state)
  SELECT s.user_id, e.value->>'id', (e.ordinality - 1)::int, e.value->'state'
  FROM saves s,
       jsonb_array_elements(s.snapshot->'islandStates') WITH ORDINALITY AS e(value, ordinality)
  WHERE EXISTS (SELECT 1 FROM users u WHERE u.id = s.user_id)
  ON CONFLICT (user_id, island_id) DO NOTHING;

DROP TABLE saves;
