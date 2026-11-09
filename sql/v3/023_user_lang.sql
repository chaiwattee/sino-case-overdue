-- Display language per person: 'th' (default) or 'en'.
ALTER TABLE users ADD COLUMN IF NOT EXISTS lang text NOT NULL DEFAULT 'th' CHECK (lang IN ('th','en'));
