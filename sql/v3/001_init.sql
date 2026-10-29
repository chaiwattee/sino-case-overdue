-- Sino Case SLA v3 schema (local PostgreSQL in Docker container case-db, database case_tracker).
-- Applied automatically by src/v3/db.js (tracked in schema_migrations).

CREATE TABLE teams (
  code        text PRIMARY KEY,               -- ENGAGE | NEXIDIA | WFM
  label       text NOT NULL,
  sort        int  NOT NULL DEFAULT 0
);
INSERT INTO teams (code, label, sort) VALUES
  ('ENGAGE',  'Engage / NRX / CXone', 1),
  ('NEXIDIA', 'Nexidia', 2),
  ('WFM',     'WFM', 3);

CREATE TABLE users (
  id                    serial PRIMARY KEY,
  email                 text NOT NULL,
  display_name          text NOT NULL,
  role                  text NOT NULL CHECK (role IN ('admin','manager','engineer','viewer')),
  auth_type             text NOT NULL DEFAULT 'sso' CHECK (auth_type IN ('sso','local')),
  password_hash         text,
  must_change_password  boolean NOT NULL DEFAULT false,
  active                boolean NOT NULL DEFAULT true,
  session_version       int NOT NULL DEFAULT 1,       -- bump to sign the user out everywhere
  last_login_at         timestamptz,
  created_by            int REFERENCES users(id) ON DELETE SET NULL,
  created_at            timestamptz NOT NULL DEFAULT now(),
  updated_at            timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX users_email_uq ON users (lower(email));

CREATE TABLE user_teams (
  user_id  int  NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  team     text NOT NULL REFERENCES teams(code),
  PRIMARY KEY (user_id, team)
);

-- Dropdown values (replaces the Settings tab of the Excel files)
CREATE TABLE lookups (
  id          serial PRIMARY KEY,
  kind        text NOT NULL CHECK (kind IN ('site','product','status')),
  value       text NOT NULL,
  is_new      boolean NOT NULL DEFAULT false,      -- added by an owner from the case form, waiting for admin review
  active      boolean NOT NULL DEFAULT true,
  sort        int NOT NULL DEFAULT 0,
  created_by  int REFERENCES users(id) ON DELETE SET NULL,
  created_at  timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX lookups_uq ON lookups (kind, lower(value));

CREATE TABLE cases (
  id          serial PRIMARY KEY,
  team        text NOT NULL REFERENCES teams(code),
  cs_number   text,
  status      text NOT NULL DEFAULT 'In Progress',
  site        text NOT NULL,
  product     text,
  owner_id    int REFERENCES users(id) ON DELETE SET NULL,
  task        text NOT NULL,
  note        text,
  start_at    timestamptz NOT NULL DEFAULT now(),  -- stamped when the case is opened
  start_date  date NOT NULL,
  due_date    date NOT NULL,                       -- start_date + SLA days
  end_date    date,
  closed_at   timestamptz,
  legacy_key  text UNIQUE,                         -- source:row key when imported from Excel
  created_by  int REFERENCES users(id) ON DELETE SET NULL,
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX cases_cs_uq ON cases (team, upper(cs_number)) WHERE cs_number IS NOT NULL AND cs_number <> '';
CREATE INDEX cases_owner_idx ON cases (owner_id);
CREATE INDEX cases_open_idx ON cases (closed_at) WHERE closed_at IS NULL;
CREATE INDEX cases_closed_idx ON cases (closed_at);

-- Append-only, dated activity log per case
CREATE TABLE case_activities (
  id             bigserial PRIMARY KEY,
  case_id        int NOT NULL REFERENCES cases(id) ON DELETE CASCADE,
  activity_date  date NOT NULL,
  kind           text NOT NULL,
  detail         text NOT NULL,
  is_system      boolean NOT NULL DEFAULT false,
  created_by     int REFERENCES users(id) ON DELETE SET NULL,
  created_at     timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX case_activities_case_idx ON case_activities (case_id, activity_date DESC, id DESC);

-- Start date / owner / status history (kept after a case is deleted)
CREATE TABLE case_changes (
  id               bigserial PRIMARY KEY,
  detected_at      timestamptz NOT NULL DEFAULT now(),
  case_id          int REFERENCES cases(id) ON DELETE SET NULL,
  cs_number        text,
  team             text,
  site             text,
  owner_name       text,
  owner_email      text,
  field            text NOT NULL,
  old_value        text,
  new_value        text,
  direction        text,
  reason           text,
  changed_by       int REFERENCES users(id) ON DELETE SET NULL,
  changed_by_name  text
);
CREATE INDEX case_changes_at_idx ON case_changes (detected_at DESC);
CREATE INDEX case_changes_case_idx ON case_changes (case_id);

CREATE TABLE alert_log (
  id           bigserial PRIMARY KEY,
  sent_at      timestamptz NOT NULL DEFAULT now(),
  dedupe_key   text NOT NULL,
  case_id      int REFERENCES cases(id) ON DELETE SET NULL,
  team         text,
  cs_number    text,
  owner        text,
  owner_email  text,
  site         text,
  alert_type   text NOT NULL CHECK (alert_type IN ('r1','r2','overdue')),
  case_age     int,
  to_list      text,
  cc_list      text,
  subject      text,
  ok           boolean NOT NULL DEFAULT true,
  error        text
);
CREATE UNIQUE INDEX alert_log_dedupe_ok ON alert_log (dedupe_key) WHERE ok;
CREATE INDEX alert_log_sent_idx ON alert_log (sent_at DESC);

CREATE TABLE report_schedules (
  id            serial PRIMARY KEY,
  created_at    timestamptz NOT NULL DEFAULT now(),
  name          text NOT NULL,
  enabled       boolean NOT NULL DEFAULT true,
  frequency     text NOT NULL DEFAULT 'weekly' CHECK (frequency IN ('daily','weekly','monthly')),
  day_of_week   int DEFAULT 1 CHECK (day_of_week BETWEEN 1 AND 7),
  day_of_month  int DEFAULT 1 CHECK (day_of_month BETWEEN 1 AND 28),
  send_time     text NOT NULL DEFAULT '08:30',
  range_type    text NOT NULL DEFAULT 'prev_week',
  recipients    text NOT NULL,
  cc            text,
  attach_excel  boolean NOT NULL DEFAULT true,
  last_period   text,
  last_sent_at  timestamptz
);

CREATE TABLE report_log (
  id           bigserial PRIMARY KEY,
  sent_at      timestamptz NOT NULL DEFAULT now(),
  schedule_id  int REFERENCES report_schedules(id) ON DELETE SET NULL,
  title        text,
  range_from   date,
  range_to     date,
  recipients   text,
  cc           text,
  file_name    text,
  ok           boolean NOT NULL DEFAULT true,
  error        text
);

-- Yearly archive: kept permanently (not affected by the 2-year retention)
CREATE TABLE annual_reports (
  year        int PRIMARY KEY,
  created_at  timestamptz NOT NULL DEFAULT now(),
  file_name   text NOT NULL,
  file        bytea NOT NULL,
  recipients  text,
  ok          boolean NOT NULL DEFAULT true,
  error       text
);

CREATE TABLE settings (
  key    text PRIMARY KEY,
  value  jsonb NOT NULL
);

CREATE TABLE password_resets (
  token_hash  text PRIMARY KEY,
  user_id     int NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  expires_at  timestamptz NOT NULL,
  used_at     timestamptz
);

CREATE TABLE audit_log (
  id        bigserial PRIMARY KEY,
  at        timestamptz NOT NULL DEFAULT now(),
  actor_id  int REFERENCES users(id) ON DELETE SET NULL,
  actor     text,
  action    text NOT NULL,
  target    text,
  detail    jsonb
);
CREATE INDEX audit_log_at_idx ON audit_log (at DESC);

INSERT INTO lookups (kind, value, sort) VALUES
  ('status','In Progress',1),('status','Pending',2),('status','Success',3),
  ('status','Resolved',4),('status','Cancel',5),('status','N/A',6),
  ('product','ENGAGE',1),('product','NRX',2),('product','APA',3),
  ('product','WFM',4),('product','NEXIDIA',5),('product','CX ONE QM',6);

INSERT INTO lookups (kind, value, sort)
SELECT 'site', v, row_number() OVER () FROM unnest(ARRAY[
  'Phatra','MTL','KTB','ONCB(ปปส)','KBANK','TISCO','KTB Iphone','OTO SKY','SCB','CardX','AIA','SIPH',
  'AOT','BBL','KTC','AYCAP','AYCAL','NTL','Cannon','Le Bua Hotel','TG','Rama Bangplee','SMK',
  'Phyathai 3','N-Health','Amway','Gulf','Nonthavej','Alliance','BRS','OSP','PIMB','ITONE','Siam smile','LMWN','AIS'
]) AS v;
