-- Customer requests by email: a shared mailbox (e.g. service@sinostech.co.th) read through Microsoft Graph.

-- Email domains that identify a customer (somying@ktb.co.th -> KTB).
ALTER TABLE intake_sites ADD COLUMN IF NOT EXISTS domains text[] NOT NULL DEFAULT '{}';

-- Requests by email may have no phone number; channel tells where a request came from.
ALTER TABLE intakes ALTER COLUMN contact_phone DROP NOT NULL;
ALTER TABLE intakes ADD COLUMN IF NOT EXISTS channel text NOT NULL DEFAULT 'link';
ALTER TABLE intakes ADD COLUMN IF NOT EXISTS hold_reason text;
UPDATE intakes SET channel = 'line' WHERE line_user_id IS NOT NULL AND channel = 'link';

-- Every message the system looked at, with what it decided (shown on the admin page).
CREATE TABLE IF NOT EXISTS intake_emails (
  id            serial PRIMARY KEY,
  graph_id      text,
  message_id    text NOT NULL UNIQUE,       -- Internet Message-ID, prevents processing a message twice
  conversation_id text,
  from_email    text,
  from_name     text,
  subject       text,
  received_at   timestamptz,
  decision      text NOT NULL CHECK (decision IN ('created','appended','held','ignored','error')),
  reason        text,
  intake_id     int REFERENCES intakes(id) ON DELETE SET NULL,
  case_id       int REFERENCES cases(id) ON DELETE SET NULL,
  is_test       boolean NOT NULL DEFAULT false,
  replied       boolean NOT NULL DEFAULT false,
  created_at    timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS intake_emails_created ON intake_emails (created_at DESC);
CREATE INDEX IF NOT EXISTS intake_emails_intake ON intake_emails (intake_id);
