import { randomUUID } from 'node:crypto'
import type { DatabaseSync } from 'node:sqlite'
import { z } from 'zod'
import {
  AttachmentSchema,
  ChatSummarySchema,
  MessageRoleSchema,
  type Attachment,
  type ChatDetail,
  type ChatMessage,
  type ChatSummary,
} from '@shared/schemas/chat'
import type { ProviderId } from '@shared/schemas/settings'

const ChatRowSchema = z.object({
  id: z.string(),
  title: z.string(),
  provider: z.string(),
  model: z.string(),
  sdk_session_id: z.string().nullable(),
  created_at: z.number(),
  updated_at: z.number(),
})

const MessageRowSchema = z.object({
  id: z.string(),
  chat_id: z.string(),
  role: MessageRoleSchema,
  text: z.string(),
  attachments_json: z.string(),
  tools_json: z.string(),
  error: z.string().nullable(),
  cost_usd: z.number().nullable(),
  duration_ms: z.number().nullable(),
  created_at: z.number(),
})

function toSummary(row: z.infer<typeof ChatRowSchema>): ChatSummary {
  return ChatSummarySchema.parse({
    id: row.id,
    title: row.title,
    provider: row.provider,
    model: row.model,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  })
}

function toMessage(row: z.infer<typeof MessageRowSchema>): ChatMessage {
  return {
    id: row.id,
    chatId: row.chat_id,
    role: row.role,
    text: row.text,
    attachments: z.array(AttachmentSchema).catch([]).parse(JSON.parse(row.attachments_json)),
    tools: z.array(z.string()).catch([]).parse(JSON.parse(row.tools_json)),
    error: row.error,
    costUsd: row.cost_usd,
    durationMs: row.duration_ms,
    createdAt: row.created_at,
  }
}

export interface NewMessage {
  chatId: string
  role: ChatMessage['role']
  text: string
  attachments?: Attachment[]
  tools?: string[]
  error?: string | null
  costUsd?: number | null
  durationMs?: number | null
}

/** Typed persistence for chats and messages. All rows are validated when read. */
export class ChatRepository {
  constructor(
    private readonly db: DatabaseSync,
    private readonly now: () => number = Date.now,
  ) {}

  list(): ChatSummary[] {
    const rows = this.db.prepare('SELECT * FROM chats ORDER BY updated_at DESC').all()
    return rows.map((r) => toSummary(ChatRowSchema.parse(r)))
  }

  create(args: { id?: string; title: string; provider: ProviderId; model: string }): ChatSummary {
    const id = args.id ?? randomUUID()
    const ts = this.now()
    this.db
      .prepare(
        'INSERT INTO chats (id, title, provider, model, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)',
      )
      .run(id, args.title, args.provider, args.model, ts, ts)
    return {
      id,
      title: args.title,
      provider: args.provider,
      model: args.model,
      createdAt: ts,
      updatedAt: ts,
    }
  }

  exists(id: string): boolean {
    return this.db.prepare('SELECT 1 FROM chats WHERE id = ?').get(id) !== undefined
  }

  get(id: string): ChatDetail | undefined {
    const row = this.db.prepare('SELECT * FROM chats WHERE id = ?').get(id)
    if (!row) return undefined
    const messages = this.db
      .prepare('SELECT * FROM messages WHERE chat_id = ? ORDER BY created_at ASC, rowid ASC')
      .all(id)
      .map((r) => toMessage(MessageRowSchema.parse(r)))
    const totalCostUsd = messages.reduce((sum, m) => sum + (m.costUsd ?? 0), 0)
    return { ...toSummary(ChatRowSchema.parse(row)), messages, totalCostUsd }
  }

  rename(id: string, title: string): void {
    this.db
      .prepare('UPDATE chats SET title = ?, updated_at = ? WHERE id = ?')
      .run(title, this.now(), id)
  }

  delete(id: string): void {
    this.db.prepare('DELETE FROM chats WHERE id = ?').run(id)
  }

  getSdkSessionId(id: string): string | undefined {
    const row = this.db.prepare('SELECT sdk_session_id FROM chats WHERE id = ?').get(id) as
      { sdk_session_id: string | null } | undefined
    return row?.sdk_session_id ?? undefined
  }

  setSdkSessionId(id: string, sdkSessionId: string): void {
    this.db.prepare('UPDATE chats SET sdk_session_id = ? WHERE id = ?').run(sdkSessionId, id)
  }

  setModel(id: string, provider: ProviderId, model: string): void {
    this.db
      .prepare('UPDATE chats SET provider = ?, model = ? WHERE id = ?')
      .run(provider, model, id)
  }

  addMessage(message: NewMessage): ChatMessage {
    const id = randomUUID()
    const ts = this.now()
    const full: ChatMessage = {
      id,
      chatId: message.chatId,
      role: message.role,
      text: message.text,
      attachments: message.attachments ?? [],
      tools: message.tools ?? [],
      error: message.error ?? null,
      costUsd: message.costUsd ?? null,
      durationMs: message.durationMs ?? null,
      createdAt: ts,
    }
    this.db
      .prepare(
        `INSERT INTO messages (id, chat_id, role, text, attachments_json, tools_json, error, cost_usd, duration_ms, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        id,
        full.chatId,
        full.role,
        full.text,
        JSON.stringify(full.attachments),
        JSON.stringify(full.tools),
        full.error,
        full.costUsd,
        full.durationMs,
        ts,
      )
    this.db.prepare('UPDATE chats SET updated_at = ? WHERE id = ?').run(ts, full.chatId)
    return full
  }
}
