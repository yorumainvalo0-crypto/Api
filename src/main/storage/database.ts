import { mkdirSync } from 'node:fs'
import { dirname } from 'node:path'
import { DatabaseSync } from 'node:sqlite'

type Migration = string | ((db: DatabaseSync) => void)

/** Ordered schema migrations; index + 1 is stored in PRAGMA user_version. */
const MIGRATIONS: Migration[] = [
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
  // v3: usage log per provider/model (kept when chats are deleted), per-session snapshots and
  // the last context-window usage per chat.
  (db) => {
    db.exec(`
      CREATE TABLE usage (
        id TEXT PRIMARY KEY,
        request_id TEXT NOT NULL,
        chat_id TEXT NOT NULL,
        provider TEXT NOT NULL,
        model TEXT NOT NULL,
        input_tokens INTEGER NOT NULL DEFAULT 0,
        output_tokens INTEGER NOT NULL DEFAULT 0,
        cache_read_tokens INTEGER NOT NULL DEFAULT 0,
        cache_write_tokens INTEGER NOT NULL DEFAULT 0,
        cost_usd REAL NOT NULL DEFAULT 0,
        created_at INTEGER NOT NULL
      );
      CREATE INDEX usage_created_idx ON usage(created_at);
      CREATE TABLE usage_snapshots (
        chat_id TEXT PRIMARY KEY,
        session_id TEXT NOT NULL,
        models_json TEXT NOT NULL
      );
      CREATE TABLE chat_context (
        chat_id TEXT PRIMARY KEY,
        context_json TEXT NOT NULL
      );
    `)
    backfillUsage(db)
  },
]

/**
 * Older versions stored the SDK's cumulative session cost on every answer, so resumed chats
 * were counted several times. Turn those into per-answer costs and log them as usage
 * (token counts are unknown for these answers).
 */
function backfillUsage(db: DatabaseSync): void {
  const chats = db.prepare('SELECT id, provider, model FROM chats').all() as {
    id: string
    provider: string
    model: string
  }[]
  const select = db.prepare(
    `SELECT id, cost_usd, created_at FROM messages
     WHERE chat_id = ? AND role = 'assistant' AND cost_usd IS NOT NULL ORDER BY created_at`,
  )
  const update = db.prepare('UPDATE messages SET cost_usd = ? WHERE id = ?')
  const insert = db.prepare(
    `INSERT INTO usage (id, request_id, chat_id, provider, model, cost_usd, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
  )
  for (const chat of chats) {
    let previous = 0
    for (const row of select.all(chat.id) as {
      id: string
      cost_usd: number
      created_at: number
    }[]) {
      const cost = row.cost_usd >= previous ? row.cost_usd - previous : row.cost_usd
      previous = row.cost_usd
      if (cost !== row.cost_usd) update.run(cost, row.id)
      if (cost > 0) {
        insert.run(
          `legacy-${row.id}`,
          row.id,
          chat.id,
          chat.provider,
          chat.model,
          cost,
          row.created_at,
        )
      }
    }
  }
}

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
      const migration = MIGRATIONS[version] ?? ''
      if (typeof migration === 'string') db.exec(migration)
      else migration(db)
      db.exec(`PRAGMA user_version = ${version + 1}`)
      db.exec('COMMIT')
    } catch (error) {
      db.exec('ROLLBACK')
      throw error
    }
  }
}
