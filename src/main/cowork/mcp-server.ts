import { createSdkMcpServer, tool } from '@anthropic-ai/claude-agent-sdk'
import { z } from 'zod'
import { EFFORT_LABELS, type CoworkRole } from '@shared/schemas/settings'

export const COWORK_MCP_SERVER = 'cowork'
export const COWORK_TOOL_NAMES = [`mcp__${COWORK_MCP_SERVER}__delegate`]

export interface SubagentResult {
  text: string
  model: string
  costUsd: number
  isError: boolean
}

export type RunSubagent = (args: {
  role: CoworkRole
  task: string
  context: string | undefined
}) => Promise<SubagentResult>

export function describeRole(role: CoworkRole): string {
  return `${role.id} – ${role.name} (${role.model || 'Standardmodell'}, Effort ${EFFORT_LABELS[role.effort]}): ${role.description}`
}

/** Lets the coordinating model hand subtasks to other roles (separate agents with own model). */
export function createCoworkMcpServer(options: {
  roles: CoworkRole[]
  runSubagent: RunSubagent
  /** Subagents only read/produce files in chat mode, so they may run in parallel there. */
  parallelSafe: boolean
}) {
  const ids = options.roles.map((r) => r.id)
  return createSdkMcpServer({
    name: COWORK_MCP_SERVER,
    version: '1.0.0',
    instructions:
      'delegate hands a self-contained subtask to a subagent with its own model and effort. ' +
      'Call it several times in one turn for independent subtasks; they run in parallel.',
    tools: [
      tool(
        'delegate',
        'Starts a subagent for a self-contained subtask and returns its result. The subagent does ' +
          'not see this conversation: put every needed fact into task/context. Roles:\n' +
          options.roles.map((r) => `- ${describeRole(r)}`).join('\n'),
        {
          role: z.enum(ids as [string, ...string[]]).describe('Role id of the subagent'),
          task: z.string().min(1).max(20_000).describe('Precise instructions for the subagent'),
          context: z
            .string()
            .max(100_000)
            .optional()
            .describe('Background, data or file paths the subagent needs'),
        },
        async ({ role: roleId, task, context }) => {
          const role = options.roles.find((r) => r.id === roleId)
          if (!role) {
            return {
              content: [{ type: 'text' as const, text: `Unbekannte Rolle: ${roleId}` }],
              isError: true,
            }
          }
          try {
            const result = await options.runSubagent({ role, task, context })
            return {
              content: [
                {
                  type: 'text' as const,
                  text: `[Subagent ${role.name} · ${result.model} · $${result.costUsd.toFixed(4)}]\n${result.text}`,
                },
              ],
              ...(result.isError ? { isError: true } : {}),
            }
          } catch (error) {
            return {
              content: [
                {
                  type: 'text' as const,
                  text: `Subagent ${role.name} fehlgeschlagen: ${error instanceof Error ? error.message : String(error)}`,
                },
              ],
              isError: true,
            }
          }
        },
        { annotations: { readOnlyHint: options.parallelSafe } },
      ),
    ],
  })
}
