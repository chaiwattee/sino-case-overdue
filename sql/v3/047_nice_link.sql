-- NICE mails not matched to a case: managers link them to cases of their own team (or open a case from them),
-- a link can be undone for 7 days, and "not our team" hides an item for that person only.
ALTER TABLE nice_mails ADD COLUMN IF NOT EXISTS activity_id int;      -- the activity this mail made (removed on undo)
ALTER TABLE nice_mails ADD COLUMN IF NOT EXISTS linked_by   int REFERENCES users(id) ON DELETE SET NULL;
ALTER TABLE nice_mails ADD COLUMN IF NOT EXISTS linked_at   timestamptz;
ALTER TABLE nice_mails ADD COLUMN IF NOT EXISTS link_kind   text;     -- link | new
ALTER TABLE nice_mails ADD COLUMN IF NOT EXISTS hidden_for  int[] NOT NULL DEFAULT '{}';
