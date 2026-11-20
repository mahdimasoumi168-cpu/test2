-- Applied to production and staging D1 on 2026-11-20.
ALTER TABLE sfu_sessions ADD COLUMN status TEXT NOT NULL DEFAULT 'created'
  CHECK (status IN ('created', 'published', 'subscribed', 'closed'));
ALTER TABLE sfu_sessions ADD COLUMN mid TEXT;
ALTER TABLE sfu_sessions ADD COLUMN updated_at TEXT NOT NULL
  DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'));
CREATE INDEX idx_sfu_sessions_room_status
  ON sfu_sessions(room_id, status, session_type);
INSERT OR IGNORE INTO schema_migrations(version, description)
  VALUES (3, 'Track SFU publication lifecycle and media transceiver identifiers');
