-- Projects phase 2: progress report for the customer (PDF by email) and the PM schedule made at hand-over.
ALTER TABLE projects ADD COLUMN IF NOT EXISTS report_to    text;
ALTER TABLE projects ADD COLUMN IF NOT EXISTS report_cc    text;
ALTER TABLE projects ADD COLUMN IF NOT EXISTS report_freq  text NOT NULL DEFAULT 'off';   -- off | monthly | biweekly
ALTER TABLE projects ADD COLUMN IF NOT EXISTS report_note  text;                          -- "needed from the customer", typed by the PM
ALTER TABLE projects ADD COLUMN IF NOT EXISTS report_last  date;
ALTER TABLE pm_schedules ADD COLUMN IF NOT EXISTS project_id int REFERENCES projects(id) ON DELETE SET NULL;
