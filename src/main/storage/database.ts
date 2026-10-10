import { mkdirSync } from 'node:fs'
import { dirname } from 'node:path'
import { DatabaseSync } from 'node:sqlite'

/** Ordered schema migrations; index + 1 is stored in PRAGMA user_version. */
const MIGRATIONS: string[] = [
  `
  CREATE TABLE chats (
    id TEXT PRIMARY KEY,
    title TEXT NOT NULL,
    provider TEXT NOT NULL,
    model TEXT NOT NULL,
    sdk_session_id TEXT,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
  );
  CREATE TABLE messages (
    id TEXT PRIMARY KEY,
    chat_id TEXT NOT NULL REFERENCES chats(id) ON DELETE CASCADE,
    role TEXT NOT NULL,
    text TEXT NOT NULL,
    attachments_json TEXT NOT NULL DEFAULT '[]',
    tools_json TEXT NOT NULL DEFAULT '[]',
    error TEXT,
    cost_usd REAL,
    duration_ms INTEGER,
    created_at INTEGER NOT NULL
  );
  CREATE INDEX messages_chat_idx ON messages(chat_id, created_at);
  CREATE INDEX chats_updated_idx ON chats(updated_at DESC);
  `,
  // v2: coding mode (project folder + permission mode) and ordered message parts.
  `
  ALTER TABLE chats ADD COLUMN mode TEXT NOT NULL DEFAULT 'chat';
  ALTER TABLE chats ADD COLUMN project_path TEXT;
  ALTER TABLE chats ADD COLUMN permission_mode TEXT NOT NULL DEFAULT 'default';
  ALTER TABLE messages ADD COLUMN parts_json TEXT NOT NULL DEFAULT '[]';
  `,
]

export function openDatabase(path: string): DatabaseSync {
  if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true })
  const db = new DatabaseSync(path)
  db.exec('PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON;')
  migrate(db)
  return db
}

function migrate(db: DatabaseSync): void {
  const row = db.prepare('PRAGMA user_version').get() as { user_version: number } | undefined
  const current = row?.user_version ?? 0
  for (let version = current; version < MIGRATIONS.length; version++) {
    db.exec('BEGIN')
    try {
      db.exec(MIGRATIONS[version] ?? '')
      db.exec(`PRAGMA user_version = ${version + 1}`)
      db.exec('COMMIT')
    } catch (error) {
      db.exec('ROLLBACK')
      throw error
    }
  }
}
