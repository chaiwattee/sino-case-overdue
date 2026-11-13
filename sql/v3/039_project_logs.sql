-- Project register: risks, issues and change requests, numbered per project and kind (R-1, I-1, CR-1).
CREATE TABLE IF NOT EXISTS project_logs (
  id          serial PRIMARY KEY,
  project_id  int NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  kind        text NOT NULL CHECK (kind IN ('risk','issue','change')),
  no          int NOT NULL,
  title       text NOT NULL,
  detail      text,
  level       text NOT NULL DEFAULT 'medium' CHECK (level IN ('low','medium','high')),
  owner_text  text,
  status      text NOT NULL DEFAULT 'open' CHECK (status IN ('open','closed','proposed','approved','rejected','done')),
  due_date    date,
  impact_days int NOT NULL DEFAULT 0,          -- change request: days it adds to the plan
  impact_md   numeric(6,1) NOT NULL DEFAULT 0, -- change request: man-days it adds
  resolution  text,
  created_by  int REFERENCES users(id) ON DELETE SET NULL,
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now(),
  closed_at   timestamptz,
  UNIQUE (project_id, kind, no)
);
CREATE INDEX IF NOT EXISTS project_logs_p ON project_logs (project_id);
