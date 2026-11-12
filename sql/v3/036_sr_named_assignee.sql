-- A team may run with only its manager in the system (e.g. BSC): the manager names the person who does the work
-- without that person having an account. The name (and an optional email for notifications) is kept per team so it
-- can be picked again; the manager updates and closes the request on their behalf.
CREATE TABLE IF NOT EXISTS team_contacts (
  id          serial PRIMARY KEY,
  team        text NOT NULL REFERENCES teams(code) ON DELETE CASCADE,
  name        text NOT NULL,
  email       text,
  active      boolean NOT NULL DEFAULT true,
  created_by  int REFERENCES users(id) ON DELETE SET NULL,
  created_at  timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS team_contacts_name ON team_contacts (team, lower(name));
ALTER TABLE service_requests ADD COLUMN IF NOT EXISTS assignee_ext_name  text;
ALTER TABLE service_requests ADD COLUMN IF NOT EXISTS assignee_ext_email text;
