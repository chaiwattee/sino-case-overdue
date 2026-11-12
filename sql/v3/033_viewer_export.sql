-- Viewers export customer cases (to send to customers). Applies the new default to a saved permission matrix too.
UPDATE settings SET value = jsonb_set(value, '{viewer,export}', '"all"')
 WHERE key = 'permissions' AND value ? 'viewer';
