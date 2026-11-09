-- "Deploy": planned patch / upgrade work as its own severity (set by the team, not offered to customers).
ALTER TABLE cases DROP CONSTRAINT IF EXISTS cases_severity_chk;
ALTER TABLE cases ADD CONSTRAINT cases_severity_chk
  CHECK (severity IN ('Critical', 'High', 'Medium', 'Low', 'Request information', 'Deploy'));
