-- A customer name typed for the first time on a case waits for a manager of that case's team.
-- The case keeps running (SLA counts) but cannot be closed until the name is approved, renamed or merged.
ALTER TABLE lookups ADD COLUMN IF NOT EXISTS pending      boolean NOT NULL DEFAULT false;
ALTER TABLE lookups ADD COLUMN IF NOT EXISTS team         text;
ALTER TABLE lookups ADD COLUMN IF NOT EXISTS reminded_at  timestamptz;
CREATE INDEX IF NOT EXISTS lookups_pending ON lookups (kind) WHERE pending;
