-- Canonical full schema for a NEW, empty D1 database.
-- Do not run this file against an existing database; existing production/staging
-- databases already contain these tables and migrations 1-3.
PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS schema_migrations (
  version INTEGER PRIMARY KEY,
  applied_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  description TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS users (
  id TEXT PRIMARY KEY,
  display_name TEXT NOT NULL,
  login_code_hash TEXT NOT NULL,
  role TEXT NOT NULL DEFAULT 'member' CHECK (role IN ('admin','moderator','member')),
  is_active INTEGER NOT NULL DEFAULT 1 CHECK (is_active IN (0,1)),
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  guardian_code_hash TEXT NOT NULL DEFAULT '',
  person_code_hash TEXT NOT NULL DEFAULT '',
  session_version INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_users_name_active ON users(display_name, is_active);

CREATE TABLE IF NOT EXISTS rooms (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  is_active INTEGER NOT NULL DEFAULT 1 CHECK (is_active IN (0,1)),
  max_members INTEGER NOT NULL DEFAULT 200 CHECK (max_members BETWEEN 1 AND 500),
  created_by TEXT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  FOREIGN KEY (created_by) REFERENCES users(id)
);

CREATE TABLE IF NOT EXISTS room_members (
  room_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  joined_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  PRIMARY KEY (room_id,user_id),
  FOREIGN KEY (room_id) REFERENCES rooms(id) ON DELETE CASCADE,
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_room_members_user ON room_members(user_id);

CREATE TABLE IF NOT EXISTS security_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id TEXT,
  room_id TEXT,
  event_type TEXT NOT NULL,
  details_json TEXT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  FOREIGN KEY (user_id) REFERENCES users(id),
  FOREIGN KEY (room_id) REFERENCES rooms(id)
);
CREATE INDEX IF NOT EXISTS idx_security_events_created ON security_events(created_at);
CREATE INDEX IF NOT EXISTS idx_security_events_room ON security_events(room_id,created_at);

CREATE TABLE IF NOT EXISTS sfu_sessions (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  room_id TEXT NOT NULL,
  session_type TEXT NOT NULL CHECK(session_type IN ('publisher','subscriber')),
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  status TEXT NOT NULL DEFAULT 'created' CHECK(status IN ('created','published','subscribed','closed')),
  mid TEXT,
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  FOREIGN KEY(user_id) REFERENCES users(id) ON DELETE CASCADE,
  FOREIGN KEY(room_id) REFERENCES rooms(id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_sfu_sessions_user ON sfu_sessions(user_id, created_at);
CREATE INDEX IF NOT EXISTS idx_sfu_sessions_room ON sfu_sessions(room_id, created_at);
CREATE INDEX IF NOT EXISTS idx_sfu_sessions_room_status ON sfu_sessions(room_id, status, session_type);

INSERT OR IGNORE INTO rooms (id, name, max_members) VALUES
  ('management', 'مدیریت', 100),
  ('khademin', 'خادمین', 100),
  ('nazm', 'نظم', 100),
  ('sound', 'صوت', 100),
  ('tadarokat', 'تدارکات', 100),
  ('paziraei', 'پذیرایی', 100);

INSERT OR IGNORE INTO schema_migrations (version, description) VALUES
  (1, 'Add separate guardian/person credential hashes and lookup indexes'),
  (2, 'Add session revocation version and owned SFU session registry'),
  (3, 'Track SFU publication lifecycle and media transceiver identifiers');
