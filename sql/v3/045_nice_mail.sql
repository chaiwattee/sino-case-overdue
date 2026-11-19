-- Updates from NICE by email: NICE support mail (copied to a shared mailbox that is a member of support@)
-- is matched to the case by CS Number and added as an "อัปเดตจาก NICE" activity.
CREATE TABLE IF NOT EXISTS nice_mails (
  id           bigserial PRIMARY KEY,
  message_id   text NOT NULL UNIQUE,
  cs_number    text,
  case_id      int REFERENCES cases(id) ON DELETE SET NULL,
  status       text NOT NULL,            -- imported | unmatched | skipped | ignored | error
  reason       text,
  sender       text,
  subject      text,
  updated_by   text,
  nice_at      timestamptz,
  impact       text,
  customer     text,
  description  text,
  body         text,
  portal_url   text,
  received_at  timestamptz,
  handled_by   int REFERENCES users(id) ON DELETE SET NULL,
  handled_at   timestamptz,
  created_at   timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS nice_mails_cs_idx ON nice_mails (lower(cs_number));
CREATE INDEX IF NOT EXISTS nice_mails_status_idx ON nice_mails (status, created_at DESC);
ALTER TABLE cases ADD COLUMN IF NOT EXISTS nice_impact text;
ALTER TABLE cases ADD COLUMN IF NOT EXISTS nice_last_at timestamptz;
