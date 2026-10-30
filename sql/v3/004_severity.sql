-- Case severity. Cases imported from Excel (now and in later syncs) default to High;
-- cases opened on the web must pick one.
ALTER TABLE cases ADD COLUMN IF NOT EXISTS severity text;
UPDATE cases SET severity = 'High' WHERE severity IS NULL;
ALTER TABLE cases ALTER COLUMN severity SET DEFAULT 'High';
ALTER TABLE cases ALTER COLUMN severity SET NOT NULL;
ALTER TABLE cases ADD CONSTRAINT cases_severity_chk
  CHECK (severity IN ('Critical', 'High', 'Medium', 'Low', 'Request information'));
CREATE INDEX IF NOT EXISTS cases_severity_idx ON cases (severity) WHERE closed_at IS NULL;
