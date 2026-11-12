-- Cross-team case transfer: the managers of both teams confirm.
-- Accepted -> the old case is closed with status 'Transferred' (end date = acceptance day, so SLA is judged on the
-- old team's Due as usual: on time if moved before Due, late if it was already past Due), and a new linked case is
-- opened for the new team with a fresh SLA from the acceptance day.
CREATE TABLE IF NOT EXISTS case_transfers (
  id             serial PRIMARY KEY,
  case_id        int NOT NULL REFERENCES cases(id) ON DELETE CASCADE,
  from_team      text NOT NULL REFERENCES teams(code),
  to_team        text NOT NULL REFERENCES teams(code),
  reason         text NOT NULL,
  requested_by   int REFERENCES users(id) ON DELETE SET NULL,
  requested_at   timestamptz NOT NULL DEFAULT now(),
  -- source = waiting for a manager of the current team, target = waiting for a manager of the new team
  status         text NOT NULL CHECK (status IN ('source','target','accepted','rejected','cancelled')),
  source_by      int REFERENCES users(id) ON DELETE SET NULL,
  source_at      timestamptz,
  target_by      int REFERENCES users(id) ON DELETE SET NULL,
  target_at      timestamptz,
  decided_by     int REFERENCES users(id) ON DELETE SET NULL,   -- who rejected / cancelled
  decision_note  text,
  new_owner_id   int REFERENCES users(id) ON DELETE SET NULL,
  new_case_id    int REFERENCES cases(id) ON DELETE SET NULL,
  reminded_at    timestamptz
);
CREATE UNIQUE INDEX IF NOT EXISTS case_transfers_open ON case_transfers (case_id) WHERE status IN ('source','target');
CREATE INDEX IF NOT EXISTS case_transfers_status ON case_transfers (status);

ALTER TABLE cases ADD COLUMN IF NOT EXISTS transferred_from int REFERENCES cases(id) ON DELETE SET NULL;
ALTER TABLE cases ADD COLUMN IF NOT EXISTS transferred_to   int REFERENCES cases(id) ON DELETE SET NULL;
