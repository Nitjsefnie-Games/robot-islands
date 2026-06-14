-- server/migrations/0002_saves.sql
CREATE TABLE IF NOT EXISTS saves (
  user_id        uuid PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  snapshot       jsonb NOT NULL,
  schema_version integer NOT NULL,
  created_at     timestamptz NOT NULL DEFAULT now(),
  updated_at     timestamptz NOT NULL DEFAULT now()
);
