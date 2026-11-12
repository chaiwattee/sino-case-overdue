-- PM: an MA form (PDF / Word / Excel) attached to a schedule. Each round's case offers it for download, and the
-- engineer uploads the filled-in copy (case_files.kind = 'ma') before the case can be closed.
ALTER TABLE pm_schedules ADD COLUMN IF NOT EXISTS ma_file_path text;
ALTER TABLE pm_schedules ADD COLUMN IF NOT EXISTS ma_file_name text;
ALTER TABLE pm_schedules ADD COLUMN IF NOT EXISTS ma_file_mime text;
ALTER TABLE pm_schedules ADD COLUMN IF NOT EXISTS ma_file_size int;
ALTER TABLE case_files ADD COLUMN IF NOT EXISTS kind text;
