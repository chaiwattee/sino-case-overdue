-- A report schedule belongs to whoever made it. One made by a manager covers only that manager's teams (scope_teams);
-- NULL scope = every team, which only an admin can set. Schedules that existed before this are treated as the admin's.
ALTER TABLE report_schedules ADD COLUMN IF NOT EXISTS created_by int REFERENCES users(id) ON DELETE SET NULL;
ALTER TABLE report_schedules ADD COLUMN IF NOT EXISTS scope_teams text[];
