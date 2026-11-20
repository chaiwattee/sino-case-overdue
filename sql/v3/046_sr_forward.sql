-- Service request sent to the wrong team: that team's manager forwards it to the right team (before approval).
ALTER TABLE service_requests ADD COLUMN IF NOT EXISTS forwarded_at timestamptz;
ALTER TABLE service_requests ADD COLUMN IF NOT EXISTS forwarded_by int REFERENCES users(id) ON DELETE SET NULL;
ALTER TABLE service_requests ADD COLUMN IF NOT EXISTS forwarded_from text;
