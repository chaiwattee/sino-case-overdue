-- PM cases have their own SLA length (14 days by default; ordinary cases keep SLA_DAYS). cases.sla_days NULL = the default.
ALTER TABLE pm_schedules ADD COLUMN IF NOT EXISTS sla_days int NOT NULL DEFAULT 14 CHECK (sla_days BETWEEN 1 AND 90);
ALTER TABLE cases ADD COLUMN IF NOT EXISTS sla_days int CHECK (sla_days BETWEEN 1 AND 90);
-- PM cases still open and never extended move to the 14-day Due. Closed and extended ones stay as they were judged.
UPDATE cases c SET sla_days = 14, due_date = c.start_date + 14
 WHERE c.pm_schedule_id IS NOT NULL AND c.closed_at IS NULL AND c.sla_days IS NULL AND c.start_date IS NOT NULL
   AND NOT EXISTS (SELECT 1 FROM case_extensions e WHERE e.case_id = c.id);
