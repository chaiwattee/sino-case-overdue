-- After-hours flag, and details customers add later (form "Add details" or email reply).
ALTER TABLE intakes ADD COLUMN IF NOT EXISTS after_hours boolean NOT NULL DEFAULT false;

CREATE TABLE IF NOT EXISTS intake_updates (
  id          serial PRIMARY KEY,
  intake_id   int NOT NULL REFERENCES intakes(id) ON DELETE CASCADE,
  source      text NOT NULL CHECK (source IN ('form','email')),
  data        jsonb NOT NULL DEFAULT '{}',
  ip          text,
  created_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS intake_updates_intake ON intake_updates (intake_id, created_at);

ALTER TABLE intake_files ADD COLUMN IF NOT EXISTS update_id int REFERENCES intake_updates(id) ON DELETE SET NULL;
