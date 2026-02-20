-- FTS5 external content table for full-text search on frames
CREATE VIRTUAL TABLE IF NOT EXISTS frames_fts USING fts5(
  name, digest_text, inputs, outputs,
  content='frames', content_rowid='rowid'
);

-- Sync trigger: INSERT
CREATE TRIGGER IF NOT EXISTS frames_ai AFTER INSERT ON frames BEGIN
  INSERT INTO frames_fts(rowid, name, digest_text, inputs, outputs)
  VALUES (new.rowid, new.name, new.digest_text, new.inputs, new.outputs);
END;

-- Sync trigger: UPDATE
CREATE TRIGGER IF NOT EXISTS frames_au AFTER UPDATE ON frames BEGIN
  INSERT INTO frames_fts(frames_fts, rowid, name, digest_text, inputs, outputs)
  VALUES ('delete', old.rowid, old.name, old.digest_text, old.inputs, old.outputs);
  INSERT INTO frames_fts(rowid, name, digest_text, inputs, outputs)
  VALUES (new.rowid, new.name, new.digest_text, new.inputs, new.outputs);
END;

-- BUG: Missing DELETE trigger!
-- When a frame is deleted, the FTS index still contains stale data.
-- Add the missing AFTER DELETE trigger below.
