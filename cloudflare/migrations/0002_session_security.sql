-- D1 migration 0002: session revocation and SFU session ownership.
-- Applied to hamyar-heyat-db on 2026-11-20.
ALTER TABLE users ADD COLUMN session_version INTEGER NOT NULL DEFAULT 0;

CREATE TABLE IF NOT EXISTS sfu_sessions (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  room_id TEXT NOT NULL,
  session_type TEXT NOT NULL CHECK (session_type IN ('publisher', 'subscriber')),
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
  FOREIGN KEY (room_id) REFERENCES rooms(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_sfu_sessions_user
  ON sfu_sessions(user_id, created_at);

CREATE INDEX IF NOT EXISTS idx_sfu_sessions_room
  ON sfu_sessions(room_id, created_at);

INSERT INTO schema_migrations(version, description)
VALUES (2, 'Add session revocation version and owned SFU session registry');
