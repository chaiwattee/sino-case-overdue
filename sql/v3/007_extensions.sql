-- Case extensions: the owner asks a manager for 7 more days; each approval moves Due by SLA days
-- and the alert rounds (day 3, day 6, overdue) start again for the new period.
ALTER TABLE cases ADD COLUMN ext_count int NOT NULL DEFAULT 0;

CREATE TABLE case_extensions (
  id            serial PRIMARY KEY,
  case_id       int NOT NULL REFERENCES cases(id) ON DELETE CASCADE,
  seq           int NOT NULL,                       -- ครั้งที่ (counts approved + pending requests in order)
  status        text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','approved','rejected','cancelled')),
  reason        text NOT NULL,
  requested_by  int REFERENCES users(id) ON DELETE SET NULL,
  requested_at  timestamptz NOT NULL DEFAULT now(),
  approver_id   int REFERENCES users(id) ON DELETE SET NULL,
  decided_at    timestamptz,
  decision_note text,
  old_due       date NOT NULL,
  new_due       date NOT NULL,
  days          int NOT NULL
);
CREATE INDEX case_extensions_case ON case_extensions (case_id, seq);
CREATE INDEX case_extensions_pending ON case_extensions (approver_id) WHERE status = 'pending';
CREATE UNIQUE INDEX case_extensions_one_pending ON case_extensions (case_id) WHERE status = 'pending';
