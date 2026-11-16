-- Large projects split into sub-projects (one level): the parent has no tasks of its own and shows the sum of its sub-projects.
ALTER TABLE projects ADD COLUMN IF NOT EXISTS parent_id int REFERENCES projects(id) ON DELETE SET NULL;
CREATE INDEX IF NOT EXISTS projects_parent ON projects (parent_id) WHERE parent_id IS NOT NULL;
-- What the combined customer report shows (parent projects): {"subs":true,"timeline":true,"work":true,"risks":false,"manday":false}
ALTER TABLE projects ADD COLUMN IF NOT EXISTS report_sections jsonb;
-- A task may wait for tasks of a sibling sub-project (same parent), on top of the plan numbers in "pred".
ALTER TABLE project_tasks ADD COLUMN IF NOT EXISTS xpred int[] NOT NULL DEFAULT '{}';
