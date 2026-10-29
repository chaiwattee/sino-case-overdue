-- Imported closed cases used the import time as closed_at; use their End date instead
-- (keeps the 2-year retention counted from the real close date).
UPDATE cases
SET closed_at = (end_date + time '18:00') AT TIME ZONE 'Asia/Bangkok'
WHERE legacy_key IS NOT NULL AND end_date IS NOT NULL AND closed_at IS NOT NULL
  AND (closed_at AT TIME ZONE 'Asia/Bangkok')::date <> end_date;
