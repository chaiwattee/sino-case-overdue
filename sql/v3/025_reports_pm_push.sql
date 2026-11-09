-- Monthly PDF report to each customer.
CREATE TABLE IF NOT EXISTS customer_reports (
  site          text PRIMARY KEY,
  enabled       boolean NOT NULL DEFAULT false,
  recipients    text NOT NULL DEFAULT '',
  cc            text NOT NULL DEFAULT '',
  last_ym       text,
  last_sent_at  timestamptz,
  updated_by    int REFERENCES users(id) ON DELETE SET NULL,
  updated_at    timestamptz NOT NULL DEFAULT now()
);

-- Preventive maintenance: a case is opened automatically on each round, with a checklist.
CREATE TABLE IF NOT EXISTS pm_schedules (
  id            serial PRIMARY KEY,
  title         text NOT NULL,
  site          text NOT NULL,
  product       text,
  team          text NOT NULL REFERENCES teams(code),
  owner_id      int REFERENCES users(id) ON DELETE SET NULL,
  every_months  int NOT NULL DEFAULT 3 CHECK (every_months BETWEEN 1 AND 24),
  next_date     date NOT NULL,
  checklist     text[] NOT NULL DEFAULT '{}',
  note          text,
  active        boolean NOT NULL DEFAULT true,
  last_case_id  int REFERENCES cases(id) ON DELETE SET NULL,
  created_by    int REFERENCES users(id) ON DELETE SET NULL,
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE cases ADD COLUMN IF NOT EXISTS pm_schedule_id int REFERENCES pm_schedules(id) ON DELETE SET NULL;
CREATE TABLE IF NOT EXISTS case_checklist (
  id        serial PRIMARY KEY,
  case_id   int NOT NULL REFERENCES cases(id) ON DELETE CASCADE,
  seq       int NOT NULL,
  item      text NOT NULL,
  done      boolean NOT NULL DEFAULT false,
  note      text,
  done_by   int REFERENCES users(id) ON DELETE SET NULL,
  done_at   timestamptz,
  UNIQUE (case_id, seq)
);

-- Photos / files the team attaches to a case (from the phone camera or a computer).
CREATE TABLE IF NOT EXISTS case_files (
  id          serial PRIMARY KEY,
  case_id     int NOT NULL REFERENCES cases(id) ON DELETE CASCADE,
  file_name   text NOT NULL,
  mime        text NOT NULL,
  size        int NOT NULL,
  path        text NOT NULL,
  caption     text,
  created_by  int REFERENCES users(id) ON DELETE SET NULL,
  created_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS case_files_case ON case_files (case_id);

-- Phone / browser notifications (Web Push).
CREATE TABLE IF NOT EXISTS push_subscriptions (
  id          serial PRIMARY KEY,
  user_id     int NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  endpoint    text NOT NULL UNIQUE,
  p256dh      text NOT NULL,
  auth        text NOT NULL,
  user_agent  text,
  created_at  timestamptz NOT NULL DEFAULT now(),
  last_ok_at  timestamptz
);
CREATE INDEX IF NOT EXISTS push_subscriptions_user ON push_subscriptions (user_id);
