-- Who/where for audit entries, and faster filtering by action.
ALTER TABLE audit_log ADD COLUMN IF NOT EXISTS ip text;
ALTER TABLE audit_log ADD COLUMN IF NOT EXISTS user_agent text;
CREATE INDEX IF NOT EXISTS audit_log_action_idx ON audit_log (action, at DESC);
