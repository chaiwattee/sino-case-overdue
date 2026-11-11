-- Customer details and the solution installed at each customer (more than one product), keyed by the site name.
CREATE TABLE IF NOT EXISTS customer_profiles (
  site            text PRIMARY KEY,
  full_name       text,
  location        text,
  contact         text,
  account_manager text,
  engineers       text,
  contract_sla    text,
  remote_access   text,
  notes           text,
  updated_by      int REFERENCES users(id) ON DELETE SET NULL,
  updated_at      timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS customer_products (
  id            serial PRIMARY KEY,
  site          text NOT NULL,
  product       text NOT NULL,
  category      text,
  version       text,
  modules       text[] NOT NULL DEFAULT '{}',
  support_kind  text,
  support_until date,
  team          text,
  notes         text,
  sort          int NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS customer_products_site ON customer_products (lower(site));

-- Service request: the requester confirms the finished work and rates it (1–5).
ALTER TABLE service_requests ADD COLUMN IF NOT EXISTS confirmed_at timestamptz;
ALTER TABLE service_requests ADD COLUMN IF NOT EXISTS rating smallint CHECK (rating BETWEEN 1 AND 5);
ALTER TABLE service_requests ADD COLUMN IF NOT EXISTS rating_note text;
