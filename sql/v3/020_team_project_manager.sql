-- New team: Project Manager (separate from 'NPM & CXone PM').
INSERT INTO teams (code, label, sort) VALUES ('PROJMGR', 'Project Manager', 7)
ON CONFLICT (code) DO NOTHING;
