-- 1) Case numbers CASE-<year>-<month>-<run>: the run number is kept (still restarts every year),
--    the month comes from the Start date. The old number is kept so search still finds it.
ALTER TABLE cases ADD COLUMN IF NOT EXISTS case_no_old text;
UPDATE cases
   SET case_no_old = case_no,
       case_no = 'CASE-' || substring(case_no from '^CASE-(\d{4})-') || '-' || to_char(start_date, 'MM') || '-' || substring(case_no from '-(\d+)$')
 WHERE case_no ~ '^CASE-\d{4}-\d+$';
UPDATE case_changes h SET case_no = c.case_no FROM cases c WHERE c.id = h.case_id AND h.case_no IS DISTINCT FROM c.case_no;
UPDATE alert_log a SET case_no = c.case_no FROM cases c WHERE c.id = a.case_id AND a.case_no IS DISTINCT FROM c.case_no;
CREATE INDEX IF NOT EXISTS cases_case_no_old ON cases (case_no_old);

CREATE OR REPLACE FUNCTION cases_assign_no() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE sd date; y int; n int;
BEGIN
  IF NEW.case_no IS NULL OR NEW.case_no = '' THEN
    sd := COALESCE(NEW.start_date, (now() AT TIME ZONE 'Asia/Bangkok')::date);
    y := EXTRACT(YEAR FROM sd)::int;
    INSERT INTO case_seq (year, last) VALUES (y, 1)
      ON CONFLICT (year) DO UPDATE SET last = case_seq.last + 1
      RETURNING last INTO n;
    NEW.case_no := 'CASE-' || y || '-' || to_char(sd, 'MM') || '-' || CASE WHEN n < 10000 THEN lpad(n::text, 4, '0') ELSE n::text END;
  END IF;
  RETURN NEW;
END $$;

-- 2) Contact details on every user (phone shown to customers when the user takes a case).
ALTER TABLE users ADD COLUMN IF NOT EXISTS phone text;
ALTER TABLE users ADD COLUMN IF NOT EXISTS department text;
ALTER TABLE users ADD COLUMN IF NOT EXISTS job_title text;
ALTER TABLE users ADD COLUMN IF NOT EXISTS profile_confirmed_at timestamptz;

-- 3) Role "requester": staff from other teams who sign in with their company Microsoft account.
DO $$
DECLARE c text;
BEGIN
  FOR c IN SELECT conname FROM pg_constraint
           WHERE conrelid = 'users'::regclass AND contype = 'c' AND pg_get_constraintdef(oid) ILIKE '%role%'
  LOOP
    EXECUTE format('ALTER TABLE users DROP CONSTRAINT %I', c);
  END LOOP;
END $$;
ALTER TABLE users ADD CONSTRAINT users_role_check CHECK (role IN ('admin','manager','observer','engineer','viewer','requester'));

-- 4) Internal service requests  SR-<year>-<month>-<run>
CREATE TABLE IF NOT EXISTS sr_seq (year int PRIMARY KEY, last int NOT NULL);

CREATE TABLE IF NOT EXISTS service_requests (
  id              serial PRIMARY KEY,
  sr_no           text UNIQUE,
  team            text NOT NULL REFERENCES teams(code),
  title           text NOT NULL,
  detail          text NOT NULL,
  severity        text NOT NULL CHECK (severity IN ('urgent_high','urgent','normal')),
  customer        text,
  requested_date  date NOT NULL,                 -- what the requester asked for
  target_date     date,                          -- set by the manager on approval
  target_reason   text,                          -- why the manager moved it
  status          text NOT NULL DEFAULT 'pending'
                  CHECK (status IN ('pending','info','in_progress','done','rejected','cancelled')),
  requester_id    int NOT NULL REFERENCES users(id),
  assignee_id     int REFERENCES users(id),
  approved_by     int REFERENCES users(id),
  approved_at     timestamptz,
  manager_note    text,
  category        text,                          -- work type (KPI skill), chosen at approval
  outcome         text CHECK (outcome IN ('delivered','not_possible','duplicate')),
  resolution      text,
  closed_by       int REFERENCES users(id),
  closed_at       timestamptz,
  reopen_count    int NOT NULL DEFAULT 0,
  ext_target      date,                          -- pending target change asked by the assignee
  ext_reason      text,
  ext_by          int REFERENCES users(id),
  ext_at          timestamptz,
  reminded        jsonb NOT NULL DEFAULT '{}',   -- {approval:'YYYY-MM-DD', before:'..', due:'..', overdue:'..'}
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS sr_status ON service_requests (status, team);
CREATE INDEX IF NOT EXISTS sr_requester ON service_requests (requester_id);
CREATE INDEX IF NOT EXISTS sr_assignee ON service_requests (assignee_id);

CREATE OR REPLACE FUNCTION sr_assign_no() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE sd date; y int; n int;
BEGIN
  IF NEW.sr_no IS NULL OR NEW.sr_no = '' THEN
    sd := (COALESCE(NEW.created_at, now()) AT TIME ZONE 'Asia/Bangkok')::date;
    y := EXTRACT(YEAR FROM sd)::int;
    INSERT INTO sr_seq (year, last) VALUES (y, 1) ON CONFLICT (year) DO UPDATE SET last = sr_seq.last + 1 RETURNING last INTO n;
    NEW.sr_no := 'SR-' || y || '-' || to_char(sd, 'MM') || '-' || lpad(n::text, 4, '0');
  END IF;
  RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS sr_assign_no ON service_requests;
CREATE TRIGGER sr_assign_no BEFORE INSERT ON service_requests FOR EACH ROW EXECUTE FUNCTION sr_assign_no();

-- Timeline: submitted, approved, info asked, update from requester, note, extension asked/decided, closed, reopened...
CREATE TABLE IF NOT EXISTS sr_events (
  id          serial PRIMARY KEY,
  sr_id       int NOT NULL REFERENCES service_requests(id) ON DELETE CASCADE,
  kind        text NOT NULL,
  text        text,
  data        jsonb,
  by_user     int REFERENCES users(id),
  created_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS sr_events_sr ON sr_events (sr_id, created_at);

CREATE TABLE IF NOT EXISTS sr_files (
  id          serial PRIMARY KEY,
  sr_id       int NOT NULL REFERENCES service_requests(id) ON DELETE CASCADE,
  event_id    int REFERENCES sr_events(id) ON DELETE SET NULL,
  file_name   text NOT NULL,
  mime        text NOT NULL,
  size        int NOT NULL,
  path        text NOT NULL,
  by_user     int REFERENCES users(id),
  created_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS sr_files_sr ON sr_files (sr_id);
