-- Customer email is now required on the request form (LINE included): remember it per LINE user to fill the next form.
ALTER TABLE intake_line_users ADD COLUMN IF NOT EXISTS contact_email text;
