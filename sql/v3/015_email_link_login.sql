-- Sign-in by a one-time link sent to a company email address (staff without a Microsoft 365 account).
-- Such accounts can only be "requester" accounts (auth_type 'email').
DO $$
DECLARE c text;
BEGIN
  FOR c IN SELECT conname FROM pg_constraint
           WHERE conrelid = 'users'::regclass AND contype = 'c' AND pg_get_constraintdef(oid) ILIKE '%auth_type%'
  LOOP
    EXECUTE format('ALTER TABLE users DROP CONSTRAINT %I', c);
  END LOOP;
END $$;
ALTER TABLE users ADD CONSTRAINT users_auth_type_check CHECK (auth_type IN ('sso','local','email'));

CREATE TABLE IF NOT EXISTS login_links (
  id          serial PRIMARY KEY,
  email       text NOT NULL,
  token_hash  text NOT NULL UNIQUE,
  ip          text,
  created_at  timestamptz NOT NULL DEFAULT now(),
  expires_at  timestamptz NOT NULL,
  used_at     timestamptz
);
CREATE INDEX IF NOT EXISTS login_links_email ON login_links (lower(email), created_at);
