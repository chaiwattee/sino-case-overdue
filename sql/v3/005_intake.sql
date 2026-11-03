-- Customer case intake: LINE OA chatbot asks our API for a one-time form link, the customer
-- submits the form, the request shows on every dashboard until someone claims it.

-- Per-site settings for intake (owner who sees it first, team the case goes to, uploads allowed).
CREATE TABLE intake_sites (
  site        text PRIMARY KEY,            -- lookups(kind='site').value
  owner_id    int REFERENCES users(id) ON DELETE SET NULL,
  team        text REFERENCES teams(code) ON DELETE SET NULL,
  attachments boolean NOT NULL DEFAULT false,
  updated_at  timestamptz NOT NULL DEFAULT now()
);

-- Other names customers type in chat ("กรุงไทย", "Krungthai") for a site.
CREATE TABLE intake_aliases (
  id     serial PRIMARY KEY,
  site   text NOT NULL,
  alias  text NOT NULL,
  norm   text NOT NULL
);
CREATE UNIQUE INDEX intake_aliases_norm ON intake_aliases (norm);

-- Systems allowed to call the link API (the LINE OA chatbot). Only a hash of the key is stored.
CREATE TABLE intake_api_keys (
  id          serial PRIMARY KEY,
  name        text NOT NULL,
  key_hash    text NOT NULL UNIQUE,
  key_last4   text NOT NULL,
  is_test     boolean NOT NULL DEFAULT false,
  allowed_ips text[] NOT NULL DEFAULT '{}',
  created_by  int REFERENCES users(id) ON DELETE SET NULL,
  created_at  timestamptz NOT NULL DEFAULT now(),
  last_used_at timestamptz,
  revoked_at  timestamptz
);

-- LINE accounts seen through the chatbot, remembered with the company they named.
CREATE TABLE intake_line_users (
  line_user_id  text PRIMARY KEY,
  display_name  text,
  site          text,
  customer_text text,
  contact_name  text,
  contact_phone text,
  blocked       boolean NOT NULL DEFAULT false,
  first_seen    timestamptz NOT NULL DEFAULT now(),
  last_seen     timestamptz NOT NULL DEFAULT now()
);

-- One-time form links. Only a hash of the token is stored.
CREATE TABLE intake_links (
  id            serial PRIMARY KEY,
  token_hash    text NOT NULL UNIQUE,
  api_key_id    int REFERENCES intake_api_keys(id) ON DELETE SET NULL,
  created_by    int REFERENCES users(id) ON DELETE SET NULL,     -- manual links / simulator
  source        text NOT NULL DEFAULT 'api',                     -- api | manual | simulator
  is_test       boolean NOT NULL DEFAULT false,
  site          text,
  customer_text text,
  line_user_id  text,
  contact_name  text,
  contact_phone text,
  contact_email text,
  external_ref  text,
  created_at    timestamptz NOT NULL DEFAULT now(),
  expires_at    timestamptz NOT NULL,
  used_at       timestamptz
);
CREATE INDEX intake_links_line ON intake_links (line_user_id, created_at);

-- Running number per year: REQ-2026-0001.
CREATE TABLE intake_seq (
  year int PRIMARY KEY,
  last int NOT NULL
);

CREATE TABLE intakes (
  id             serial PRIMARY KEY,
  req_no         text NOT NULL UNIQUE,
  link_id        int REFERENCES intake_links(id) ON DELETE SET NULL,
  is_test        boolean NOT NULL DEFAULT false,
  status         text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','claiming','claimed','rejected','duplicate')),
  held           boolean NOT NULL DEFAULT false,      -- burst protection: waits for an admin
  site           text,                                -- null = customer name not recognised
  customer_text  text,
  line_user_id   text,
  new_line       boolean NOT NULL DEFAULT false,      -- first request from this LINE account
  external_ref   text,
  contact_name   text NOT NULL,
  position       text,
  contact_email  text,
  contact_phone  text NOT NULL,
  product        text,
  severity       text NOT NULL,
  started_text   text,
  affected       text,
  customer_ref   text,
  subject        text NOT NULL,
  detail         text NOT NULL,
  ip             text,
  created_at     timestamptz NOT NULL DEFAULT now(),
  last_reminded_at timestamptz,
  reminder_count int NOT NULL DEFAULT 0,
  claimed_at     timestamptz,
  claimed_by     int REFERENCES users(id) ON DELETE SET NULL,
  owner_id       int REFERENCES users(id) ON DELETE SET NULL,
  case_id        int REFERENCES cases(id) ON DELETE SET NULL,
  closed_reason  text,
  duplicate_of   text
);
CREATE INDEX intakes_status ON intakes (status, created_at);
CREATE INDEX intakes_case ON intakes (case_id);

CREATE TABLE intake_files (
  id          serial PRIMARY KEY,
  link_id     int REFERENCES intake_links(id) ON DELETE SET NULL,
  intake_id   int REFERENCES intakes(id) ON DELETE CASCADE,
  file_name   text NOT NULL,
  mime        text NOT NULL,
  size        int NOT NULL,
  path        text NOT NULL,
  created_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX intake_files_intake ON intake_files (intake_id);

-- Events for the chatbot (e.g. case.claimed -> LINE message to the customer), retried until delivered.
CREATE TABLE intake_outbox (
  id          serial PRIMARY KEY,
  event       text NOT NULL,
  intake_id   int REFERENCES intakes(id) ON DELETE SET NULL,
  is_test     boolean NOT NULL DEFAULT false,
  payload     jsonb NOT NULL,
  status      text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','sent','failed','no_url')),
  attempts    int NOT NULL DEFAULT 0,
  next_at     timestamptz NOT NULL DEFAULT now(),
  last_error  text,
  response    text,
  created_at  timestamptz NOT NULL DEFAULT now(),
  sent_at     timestamptz
);
CREATE INDEX intake_outbox_due ON intake_outbox (status, next_at);
