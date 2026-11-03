-- Case numbers: CASE-<year>-0001, running per year (year of Start date), shown on every screen and email.
-- Existing cases are numbered by Start date (then id) within each year.
CREATE TABLE case_seq (
  year int PRIMARY KEY,
  last int NOT NULL
);

ALTER TABLE cases ADD COLUMN case_no text;

WITH n AS (
  SELECT id, EXTRACT(YEAR FROM start_date)::int AS y,
         row_number() OVER (PARTITION BY EXTRACT(YEAR FROM start_date) ORDER BY start_date, start_at NULLS LAST, id) AS rn
  FROM cases
)
UPDATE cases c SET case_no = 'CASE-' || n.y || '-' || CASE WHEN n.rn < 10000 THEN lpad(n.rn::text, 4, '0') ELSE n.rn::text END
FROM n WHERE n.id = c.id;

INSERT INTO case_seq (year, last)
SELECT EXTRACT(YEAR FROM start_date)::int, count(*) FROM cases GROUP BY 1;

CREATE FUNCTION cases_assign_no() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE y int; n int;
BEGIN
  IF NEW.case_no IS NULL OR NEW.case_no = '' THEN
    y := EXTRACT(YEAR FROM COALESCE(NEW.start_date, (now() AT TIME ZONE 'Asia/Bangkok')::date))::int;
    INSERT INTO case_seq (year, last) VALUES (y, 1)
      ON CONFLICT (year) DO UPDATE SET last = case_seq.last + 1
      RETURNING last INTO n;
    NEW.case_no := 'CASE-' || y || '-' || CASE WHEN n < 10000 THEN lpad(n::text, 4, '0') ELSE n::text END;
  END IF;
  RETURN NEW;
END $$;

CREATE TRIGGER cases_assign_no BEFORE INSERT ON cases FOR EACH ROW EXECUTE FUNCTION cases_assign_no();

ALTER TABLE cases ALTER COLUMN case_no SET NOT NULL;
CREATE UNIQUE INDEX cases_case_no_uq ON cases (case_no);

-- Keep the number on history rows too (they outlive deleted cases).
ALTER TABLE case_changes ADD COLUMN case_no text;
UPDATE case_changes h SET case_no = c.case_no FROM cases c WHERE c.id = h.case_id;
ALTER TABLE alert_log ADD COLUMN case_no text;
UPDATE alert_log a SET case_no = c.case_no FROM cases c WHERE c.id = a.case_id;
