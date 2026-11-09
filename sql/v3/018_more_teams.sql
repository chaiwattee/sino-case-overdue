-- New teams: project managers (NPM & CXone) and testers. They can own cases and receive service requests like the others.
INSERT INTO teams (code, label, sort) VALUES
  ('PM',     'NPM & CXone PM', 4),
  ('TESTER', 'Tester',         5)
ON CONFLICT (code) DO NOTHING;
