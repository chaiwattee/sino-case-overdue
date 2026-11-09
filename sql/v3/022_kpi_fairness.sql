-- Fairer KPI: work points per case (severity × difficulty), a manager's difficulty call per case,
-- and people assigned to one customer are not marked down on customer variety.
ALTER TABLE cases ADD COLUMN IF NOT EXISTS complexity     numeric(3,2);   -- null = automatic; 0.8 easier · 1.2 hard · 1.5 very hard
ALTER TABLE cases ADD COLUMN IF NOT EXISTS complexity_by  integer REFERENCES users(id);
ALTER TABLE users ADD COLUMN IF NOT EXISTS dedicated_customer boolean NOT NULL DEFAULT false;
