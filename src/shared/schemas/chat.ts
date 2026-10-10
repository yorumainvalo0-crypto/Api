import { z } from 'zod'
import { ProviderIdSchema } from './settings'

export const AttachmentKindSchema = z.enum(['image', 'pdf', 'text', 'model3d', 'file'])
export type AttachmentKind = z.infer<typeof AttachmentKindSchema>

/** A file stored in the chat workspace and referenced by messages. */
export const AttachmentSchema = z.object({
  id: z.string(),
  name: z.string(),
  mimeType: z.string(),
  size: z.number().int().nonnegative(),
  kind: AttachmentKindSchema,
  /** Absolute path inside the app data directory. */
  path: z.string(),
})
export type Attachment = z.infer<typeof AttachmentSchema>

/** Files handed over by the renderer: a dropped file path or raw data (e.g. a pasted screenshot). */
export const AttachmentInputSchema = z.discriminatedUnion('source', [
  z.object({ source: z.literal('path'), path: z.string().min(1) }),
  z.object({
    source: z.literal('data'),
    name: z.string().min(1),
    mimeType: z.string(),
    base64: z.string().min(1),
  }),
])
export type AttachmentInput = z.infer<typeof AttachmentInputSchema>

export const MessageRoleSchema = z.enum(['user', 'assistant'])

/** One tool invocation by the agent, with its (truncated) result once available. */
export const ToolCallSchema = z.object({
  id: z.string(),
  name: z.string(),
  input: z.unknown(),
  result: z.string().nullable(),
  isError: z.boolean(),
})
export type ToolCall = z.infer<typeof ToolCallSchema>

/** Ordered content of an assistant message: text interleaved with tool calls. */
export const MessagePartSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('text'), text: z.string() }),
  z.object({ type: z.literal('tool'), call: ToolCallSchema }),
])
export type MessagePart = z.infer<typeof MessagePartSchema>

export const ChatMessageSchema = z.object({
  id: z.string(),
  chatId: z.string(),
  role: MessageRoleSchema,
  text: z.string(),
  attachments: z.array(AttachmentSchema),
  /** Assistant messages only; empty for user messages. */
  parts: z.array(MessagePartSchema),
  error: z.string().nullable(),
  costUsd: z.number().nullable(),
  durationMs: z.number().nullable(),
  createdAt: z.number(),
})
export type ChatMessage = z.infer<typeof ChatMessageSchema>

export const ChatModeSchema = z.enum(['chat', 'code'])
export type ChatMode = z.infer<typeof ChatModeSchema>

/** How the coding agent asks before using tools (maps to the SDK permission modes). */
export const AgentPermissionModeSchema = z.enum([
  'default',
  'acceptEdits',
  'plan',
  'bypassPermissions',
])
export type AgentPermissionMode = z.infer<typeof AgentPermissionModeSchema>

export const PERMISSION_MODE_LABELS: Record<AgentPermissionMode, string> = {
  default: 'Immer fragen',
  acceptEdits: 'Dateiänderungen erlauben',
  plan: 'Nur planen',
  bypassPermissions: 'Alles erlauben',
}

export const ChatSummarySchema = z.object({
  id: z.string(),
  title: z.string(),
  provider: ProviderIdSchema,
  model: z.string(),
  mode: ChatModeSchema,
  /** Project folder the coding agent works in (code mode only). */
  projectPath: z.string().nullable(),
  permissionMode: AgentPermissionModeSchema,
  createdAt: z.number(),
  updatedAt: z.number(),
})
export type ChatSummary = z.infer<typeof ChatSummarySchema>

export const ChatDetailSchema = ChatSummarySchema.extend({
  messages: z.array(ChatMessageSchema),
  totalCostUsd: z.number(),
})
export type ChatDetail = z.infer<typeof ChatDetailSchema>

/** Size limits applied before files are sent to a model. */
export const ATTACHMENT_LIMITS = {
  maxFileBytes: 32 * 1024 * 1024,
  maxImageBytes: 5 * 1024 * 1024,
  maxPdfBytes: 32 * 1024 * 1024,
  /** Text files up to this size are inlined into the prompt; larger ones are referenced by path. */
  maxInlineTextBytes: 200 * 1024,
  maxAttachmentsPerMessage: 20,
} as const
