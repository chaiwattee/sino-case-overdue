-- Preventive Maintenance job: managers no longer get it by role; an admin names the people who use it
-- (Users → สิทธิ์ตามบทบาท → "ตั้งและแก้งาน PM ตามรอบ" → add people). Applies to a saved permission matrix too.
UPDATE settings SET value = jsonb_set(value, '{manager,pm_manage}', '"none"')
 WHERE key = 'permissions' AND value ? 'manager';
