-- Deploy severity becomes two: product patches (NICE etc.) and Microsoft patches.
ALTER TABLE cases DROP CONSTRAINT IF EXISTS cases_severity_chk;
UPDATE cases SET severity = 'Deploy Product Patch' WHERE severity = 'Deploy';
ALTER TABLE cases ADD CONSTRAINT cases_severity_chk
  CHECK (severity IN ('Critical', 'High', 'Medium', 'Low', 'Request information', 'Deploy Product Patch', 'Deploy MS Patch'));
UPDATE case_activities SET kind = 'Deploy Product Patch' WHERE kind = 'Deploy Patch';

-- Service requests that ask the team to join a meeting need a reason (meetings are routine work of their own).
ALTER TABLE service_requests ADD COLUMN IF NOT EXISTS request_kind text NOT NULL DEFAULT 'general';
ALTER TABLE service_requests ADD COLUMN IF NOT EXISTS meeting_mode text;
ALTER TABLE service_requests ADD COLUMN IF NOT EXISTS meeting_reason text;
ALTER TABLE service_requests DROP CONSTRAINT IF EXISTS service_requests_kind_chk;
ALTER TABLE service_requests ADD CONSTRAINT service_requests_kind_chk CHECK (request_kind IN ('general', 'meeting') AND (meeting_mode IS NULL OR meeting_mode IN ('onsite', 'online')));
