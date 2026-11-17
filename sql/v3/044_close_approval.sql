-- Closing or cancelling a case needs a manager's approval (see closereq.js). The case keeps running until then;
-- once approved its End date is the day the owner asked to close, so a request made in time is not counted late.
CREATE TABLE IF NOT EXISTS case_close_requests (
  id           serial PRIMARY KEY,
  case_id      int NOT NULL REFERENCES cases(id) ON DELETE CASCADE,
  kind         text NOT NULL CHECK (kind IN ('close','cancel')),
  to_status    text NOT NULL,
  payload      jsonb NOT NULL,                 -- the close form (status, resolution, root cause, RCA ...) applied on approval
  state        text NOT NULL DEFAULT 'pending' CHECK (state IN ('pending','approved','rejected','cancelled')),
  requested_by int REFERENCES users(id) ON DELETE SET NULL,
  requested_at timestamptz NOT NULL DEFAULT now(),
  req_date     date NOT NULL,                  -- becomes the case End date when approved
  due_at_req   date,
  decided_by   int REFERENCES users(id) ON DELETE SET NULL,
  decided_at   timestamptz,
  note         text
);
CREATE UNIQUE INDEX IF NOT EXISTS case_close_one_pending ON case_close_requests (case_id) WHERE state = 'pending';
CREATE INDEX IF NOT EXISTS case_close_requested ON case_close_requests (requested_at);
