-- RCA from NICE: cases with a CS Number (opened with NICE) need the vendor RCA before they can be closed.
ALTER TABLE cases ADD COLUMN IF NOT EXISTS rca_text      text;
ALTER TABLE cases ADD COLUMN IF NOT EXISTS rca_category  text;
ALTER TABLE cases ADD COLUMN IF NOT EXISTS rca_date      date;        -- date NICE sent the RCA
ALTER TABLE cases ADD COLUMN IF NOT EXISTS rca_file      text;        -- stored file name under INTAKE_FILE_DIR/rca
ALTER TABLE cases ADD COLUMN IF NOT EXISTS rca_file_name text;        -- original file name
ALTER TABLE cases ADD COLUMN IF NOT EXISTS rca_file_mime text;
ALTER TABLE cases ADD COLUMN IF NOT EXISTS rca_by        integer REFERENCES users(id);
ALTER TABLE cases ADD COLUMN IF NOT EXISTS rca_at        timestamptz;
