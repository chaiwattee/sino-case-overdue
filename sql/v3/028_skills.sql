-- Skill map: each User's level per product (0–4), filled by Managers or imported from Excel.
CREATE TABLE IF NOT EXISTS user_skills (
  user_id     int NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  product     text NOT NULL,
  level       smallint NOT NULL CHECK (level BETWEEN 0 AND 4),
  note        text,
  updated_by  int REFERENCES users(id) ON DELETE SET NULL,
  updated_at  timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, product)
);
