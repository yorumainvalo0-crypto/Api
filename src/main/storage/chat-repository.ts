import { randomUUID } from 'node:crypto'
import type { DatabaseSync } from 'node:sqlite'
import { z } from 'zod'
import {
  AgentPermissionModeSchema,
  AttachmentSchema,
  ChatModeSchema,
  ChatSummarySchema,
  MessagePartSchema,
  MessageRoleSchema,
  type AgentPermissionMode,
  type Attachment,
  type ChatDetail,
  type ChatMessage,
  type ChatMode,
  type ChatSummary,
  type MessagePart,
} from '@shared/schemas/chat'
import type { ProviderId } from '@shared/schemas/settings'
import { partsToText } from '@shared/message-parts'

const ChatRowSchema = z.object({
  id: z.string(),
  title: z.string(),
  provider: z.string(),
  model: z.string(),
  mode: ChatModeSchema.catch('chat'),
  project_path: z.string().nullable(),
  permission_mode: AgentPermissionModeSchema.catch('default'),
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
  parts_json: z.string(),
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
    mode: row.mode,
    projectPath: row.project_path,
    permissionMode: row.permission_mode,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  })
}

function parseJson(raw: string): unknown {
  try {
    return JSON.parse(raw)
  } catch {
    return undefined
  }
}

function toMessage(row: z.infer<typeof MessageRowSchema>): ChatMessage {
  let parts = z.array(MessagePartSchema).catch([]).parse(parseJson(row.parts_json))
  // Messages from schema v1 only have text and tool names.
  if (parts.length === 0 && row.role === 'assistant') {
    const legacyTools = z.array(z.string()).catch([]).parse(parseJson(row.tools_json))
    parts = [
      ...legacyTools.map((name, i): MessagePart => ({
        type: 'tool',
        call: { id: `legacy-${i}`, name, input: null, result: null, isError: false },
      })),
      ...(row.text ? [{ type: 'text' as const, text: row.text }] : []),
    ]
  }
  return {
    id: row.id,
    chatId: row.chat_id,
    role: row.role,
    text: row.text,
    attachments: z.array(AttachmentSchema).catch([]).parse(parseJson(row.attachments_json)),
    parts,
    error: row.error,
    costUsd: row.cost_usd,
    durationMs: row.duration_ms,
    createdAt: row.created_at,
  }
}

export interface NewChat {
  id?: string
  title: string
  provider: ProviderId
  model: string
  mode?: ChatMode
  projectPath?: string | null
  permissionMode?: AgentPermissionMode
}

export interface NewMessage {
  chatId: string
  role: ChatMessage['role']
  text?: string
  attachments?: Attachment[]
  parts?: MessagePart[]
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

  create(args: NewChat): ChatSummary {
    const id = args.id ?? randomUUID()
    const ts = this.now()
    this.db
      .prepare(
        `INSERT INTO chats (id, title, provider, model, mode, project_path, permission_mode, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        id,
        args.title,
        args.provider,
        args.model,
        args.mode ?? 'chat',
        args.projectPath ?? null,
        args.permissionMode ?? 'default',
        ts,
        ts,
      )
    return this.summary(id) as ChatSummary
  }

  exists(id: string): boolean {
    return this.db.prepare('SELECT 1 FROM chats WHERE id = ?').get(id) !== undefined
  }

  summary(id: string): ChatSummary | undefined {
    const row = this.db.prepare('SELECT * FROM chats WHERE id = ?').get(id)
    return row ? toSummary(ChatRowSchema.parse(row)) : undefined
  }

  get(id: string): ChatDetail | undefined {
    const summary = this.summary(id)
    if (!summary) return undefined
    const messages = this.db
      .prepare('SELECT * FROM messages WHERE chat_id = ? ORDER BY created_at ASC, rowid ASC')
      .all(id)
      .map((r) => toMessage(MessageRowSchema.parse(r)))
    const totalCostUsd = messages.reduce((sum, m) => sum + (m.costUsd ?? 0), 0)
    return { ...summary, messages, totalCostUsd }
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
    return this.summaryRow(id)?.sdk_session_id ?? undefined
  }

  setSdkSessionId(id: string, sdkSessionId: string): void {
    this.db.prepare('UPDATE chats SET sdk_session_id = ? WHERE id = ?').run(sdkSessionId, id)
  }

  setModel(id: string, provider: ProviderId, model: string): void {
    this.db
      .prepare('UPDATE chats SET provider = ?, model = ? WHERE id = ?')
      .run(provider, model, id)
  }

  setPermissionMode(id: string, mode: AgentPermissionMode): void {
    this.db.prepare('UPDATE chats SET permission_mode = ? WHERE id = ?').run(mode, id)
  }

  addMessage(message: NewMessage): ChatMessage {
    const id = randomUUID()
    const ts = this.now()
    const parts = message.parts ?? []
    const full: ChatMessage = {
      id,
      chatId: message.chatId,
      role: message.role,
      text: message.text ?? partsToText(parts),
      attachments: message.attachments ?? [],
      parts,
      error: message.error ?? null,
      costUsd: message.costUsd ?? null,
      durationMs: message.durationMs ?? null,
      createdAt: ts,
    }
    this.db
      .prepare(
        `INSERT INTO messages (id, chat_id, role, text, attachments_json, parts_json, error, cost_usd, duration_ms, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        id,
        full.chatId,
        full.role,
        full.text,
        JSON.stringify(full.attachments),
        JSON.stringify(full.parts),
        full.error,
        full.costUsd,
        full.durationMs,
        ts,
      )
    this.db.prepare('UPDATE chats SET updated_at = ? WHERE id = ?').run(ts, full.chatId)
    return full
  }

  private summaryRow(id: string): z.infer<typeof ChatRowSchema> | undefined {
    const row = this.db.prepare('SELECT * FROM chats WHERE id = ?').get(id)
    return row ? ChatRowSchema.parse(row) : undefined
  }
}
