-- Avatar per user: a preset key (e.g. 'fox') or 'photo:<file name>' for an uploaded photo. NULL = initial of the name.
ALTER TABLE users ADD COLUMN IF NOT EXISTS avatar text;
