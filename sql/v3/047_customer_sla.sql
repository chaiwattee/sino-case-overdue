-- SLA length (days) per customer: new cases for this customer get it as their SLA; alert rounds scale with it.
ALTER TABLE customer_profiles ADD COLUMN IF NOT EXISTS sla_days int CHECK (sla_days BETWEEN 1 AND 90);
