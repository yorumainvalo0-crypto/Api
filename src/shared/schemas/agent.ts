import { z } from 'zod'

export const ChatRequestSchema = z.object({
  sessionId: z.string().min(1),
  prompt: z.string().min(1),
  /** Working directory for the agent. Defaults to the session workspace. */
  cwd: z.string().optional(),
})
export type ChatRequest = z.infer<typeof ChatRequestSchema>

const base = { sessionId: z.string() }

/** Normalized events streamed from the main process to the renderer. */
export const AgentEventSchema = z.discriminatedUnion('type', [
  z.object({ ...base, type: z.literal('init'), model: z.string(), tools: z.array(z.string()) }),
  z.object({ ...base, type: z.literal('text-delta'), text: z.string() }),
  z.object({ ...base, type: z.literal('assistant-text'), text: z.string() }),
  z.object({
    ...base,
    type: z.literal('tool-use'),
    toolUseId: z.string(),
    name: z.string(),
    input: z.unknown(),
  }),
  z.object({
    ...base,
    type: z.literal('result'),
    isError: z.boolean(),
    text: z.string(),
    costUsd: z.number(),
    durationMs: z.number(),
  }),
  z.object({ ...base, type: z.literal('error'), message: z.string() }),
  z.object({ ...base, type: z.literal('done') }),
])
export type AgentEvent = z.infer<typeof AgentEventSchema>
