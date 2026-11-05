-- A case taken before the customer is known (email from an unknown or personal domain, or a name typed
-- in LINE that matched no customer). The engineer calls back and confirms the customer on the case page.
ALTER TABLE cases ADD COLUMN IF NOT EXISTS customer_unconfirmed text;   -- what we know: sender domain/email or typed name

-- Email from unknown domains is now accepted as a normal request (team confirms the customer later).
UPDATE settings SET value = jsonb_set(value, '{email,unknownDomain}', '"accept"')
 WHERE key = 'intake' AND value->'email'->>'unknownDomain' = 'hold';
