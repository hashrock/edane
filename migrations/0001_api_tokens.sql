CREATE TABLE api_tokens (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id),
  name TEXT NOT NULL DEFAULT 'default',
  token_hash TEXT NOT NULL UNIQUE,
  created_at TEXT NOT NULL
);
