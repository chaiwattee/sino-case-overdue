-- Customer portal: customer accounts (one company = one site, several accounts), password history, and which
-- case activities a customer may see. Customers see only cases their company reported (email or portal), never internal ones.
CREATE TABLE IF NOT EXISTS portal_users (
  id                  serial PRIMARY KEY,
  site                text NOT NULL,
  username            text NOT NULL,
  display_name        text NOT NULL,
  email               text,
  phone               text,
  password_hash       text NOT NULL,
  must_change         boolean NOT NULL DEFAULT true,
  password_changed_at timestamptz NOT NULL DEFAULT now(),
  failed_count        int NOT NULL DEFAULT 0,
  locked_until        timestamptz,
  active              boolean NOT NULL DEFAULT true,
  session_version     int NOT NULL DEFAULT 1,
  last_login_at       timestamptz,
  created_by          int REFERENCES users(id) ON DELETE SET NULL,
  created_at          timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS portal_users_username ON portal_users (lower(username));
CREATE INDEX IF NOT EXISTS portal_users_site ON portal_users (lower(site));
CREATE TABLE IF NOT EXISTS portal_password_history (
  id         serial PRIMARY KEY,
  user_id    int NOT NULL REFERENCES portal_users(id) ON DELETE CASCADE,
  hash       text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS portal_pwh_user ON portal_password_history (user_id, id DESC);
ALTER TABLE case_activities ADD COLUMN IF NOT EXISTS customer_visible boolean NOT NULL DEFAULT false;
ALTER TABLE case_activities ADD COLUMN IF NOT EXISTS portal_user_id int REFERENCES portal_users(id) ON DELETE SET NULL;
ALTER TABLE intakes ADD COLUMN IF NOT EXISTS portal_user_id int REFERENCES portal_users(id) ON DELETE SET NULL;
