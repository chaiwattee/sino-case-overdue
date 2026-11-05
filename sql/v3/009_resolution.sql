-- Resolution required when a case is closed (from Nov 2026). Older closed cases stay NULL.
ALTER TABLE cases ADD COLUMN IF NOT EXISTS resolution text;
ALTER TABLE cases ADD COLUMN IF NOT EXISTS root_cause text;
ALTER TABLE cases ADD COLUMN IF NOT EXISTS resolved_by int REFERENCES users(id) ON DELETE SET NULL;
ALTER TABLE cases ADD COLUMN IF NOT EXISTS resolved_at timestamptz;
