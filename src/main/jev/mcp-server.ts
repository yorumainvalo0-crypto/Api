import { createSdkMcpServer, tool } from '@anthropic-ai/claude-agent-sdk'
import { z } from 'zod'
import { formatJevResponse, JevQuestionSchema, type JevClient, type JevResponse } from './client'

export const JEV_MCP_SERVER = 'jev'
export const JEV_TOOL_NAMES = [`mcp__${JEV_MCP_SERVER}__evaluate`]

/** In-process MCP server that lets any chat model ask TypeSafe's Jev for typed decisions. */
export function createJevMcpServer(
  client: JevClient,
  onUsage?: (usage: NonNullable<JevResponse['usage']>) => void,
) {
  return createSdkMcpServer({
    name: JEV_MCP_SERVER,
    version: '1.0.0',
    instructions:
      'evaluate asks the Jev decision model typed questions about some input and returns ' +
      'calibrated probabilities: choice (pick one of up to 255 options), score (rate on 2–10 ' +
      'levels) and noul (yes/no as probability). Use it for fast classification, routing, ' +
      'scoring, deduplication and checking your own output; ask several questions in one call. ' +
      'It cannot write text or explain.',
    tools: [
      tool(
        'evaluate',
        'Ask TypeSafe Jev one or more typed questions about a state (text, JSON object or array). ' +
          'Returns choices, scores or yes-probabilities with confidence. Not for generating text.',
        {
          state: z
            .union([z.string(), z.record(z.string(), z.unknown()), z.array(z.unknown())])
            .describe('The input to judge: text, a JSON object or a JSON array'),
          questions: z
            .record(z.string(), JevQuestionSchema)
            .refine((q) => Object.keys(q).length > 0, 'At least one question')
            .describe('Map of question id → question. All are answered in one call.'),
        },
        async ({ state, questions }) => {
          try {
            const response = await client.evaluate(state, questions)
            if (response.usage) onUsage?.(response.usage)
            return { content: [{ type: 'text' as const, text: formatJevResponse(response) }] }
          } catch (error) {
            return {
              content: [
                {
                  type: 'text' as const,
                  text: error instanceof Error ? error.message : String(error),
                },
              ],
              isError: true,
            }
          }
        },
        { annotations: { readOnlyHint: true, openWorldHint: true } },
      ),
    ],
  })
}
