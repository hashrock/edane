ALTER TABLE notes ADD COLUMN version INTEGER NOT NULL DEFAULT 0;
CREATE TABLE note_commits (
  note_id TEXT NOT NULL REFERENCES notes(id) ON DELETE CASCADE,
  operation_id TEXT NOT NULL,
  digest TEXT NOT NULL,
  version INTEGER NOT NULL,
  PRIMARY KEY (note_id, operation_id)
);
