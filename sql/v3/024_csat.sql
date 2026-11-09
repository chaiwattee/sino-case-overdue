-- Customer satisfaction: one survey per closed customer case (cases that came from a customer request).
CREATE TABLE IF NOT EXISTS case_csat (
  id          serial PRIMARY KEY,
  case_id     int NOT NULL UNIQUE REFERENCES cases(id) ON DELETE CASCADE,
  intake_id   int REFERENCES intakes(id) ON DELETE SET NULL,
  token       text NOT NULL UNIQUE,
  channel     text NOT NULL,              -- email (same thread) | link (new email) | line (chatbot webhook)
  sent_to     text,
  sent_at     timestamptz NOT NULL DEFAULT now(),
  expires_at  timestamptz NOT NULL,
  rating      smallint CHECK (rating BETWEEN 1 AND 5),
  comment     text,
  rated_at    timestamptz,
  alerted_at  timestamptz
);
CREATE INDEX IF NOT EXISTS case_csat_rated ON case_csat (rated_at) WHERE rating IS NOT NULL;
