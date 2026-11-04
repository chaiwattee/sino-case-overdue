-- Manager adjustments to the monthly KPI score (±10 with a reason). The score itself is computed from case data.
CREATE TABLE kpi_adjustments (
  month       text NOT NULL,              -- YYYY-MM
  user_id     int NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  points      int NOT NULL CHECK (points BETWEEN -10 AND 10),
  reason      text NOT NULL,
  adjusted_by int REFERENCES users(id) ON DELETE SET NULL,
  updated_at  timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (month, user_id)
);
