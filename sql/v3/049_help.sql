-- Questions people asked in the search box that had no good help answer (for admins to add one).
CREATE TABLE IF NOT EXISTS help_questions (
  id         serial PRIMARY KEY,
  user_id    int REFERENCES users(id) ON DELETE SET NULL,
  question   text NOT NULL,
  page       text,
  done       boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT now()
);
