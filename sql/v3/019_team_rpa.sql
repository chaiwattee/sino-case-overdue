-- New team: RPA.
INSERT INTO teams (code, label, sort) VALUES ('RPA', 'RPA', 6)
ON CONFLICT (code) DO NOTHING;
