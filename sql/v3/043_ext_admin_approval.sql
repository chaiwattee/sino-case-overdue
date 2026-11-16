-- Case extensions in two steps: the manager checks the reason and forwards it, an admin approves and sets the
-- number of working days (default 3, or what the requester asked for; weekends and company holidays not counted).
ALTER TABLE case_extensions ADD COLUMN IF NOT EXISTS stage text NOT NULL DEFAULT 'manager' CHECK (stage IN ('manager','admin'));
ALTER TABLE case_extensions ADD COLUMN IF NOT EXISTS req_days int;                 -- working days the requester asked for (optional)
ALTER TABLE case_extensions ADD COLUMN IF NOT EXISTS workdays boolean NOT NULL DEFAULT false; -- days counted as working days
ALTER TABLE case_extensions ADD COLUMN IF NOT EXISTS forwarded_by int REFERENCES users(id) ON DELETE SET NULL;
ALTER TABLE case_extensions ADD COLUMN IF NOT EXISTS forwarded_at timestamptz;
ALTER TABLE case_extensions ADD COLUMN IF NOT EXISTS forward_note text;
ALTER TABLE case_extensions ADD COLUMN IF NOT EXISTS decided_by int REFERENCES users(id) ON DELETE SET NULL;
