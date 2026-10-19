import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js'
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js'
import type { FastifyInstance } from 'fastify'
import { ObjectId } from 'mongodb'
import type { z } from 'zod'
import { applyStartBudget } from './budgets.js'
import type { Config } from './config.js'
import type { Database, PortalUser } from './db.js'
import { safeEqual } from './security.js'
import type { AppContext } from './web.js'

export interface ToolContext {
  db: Database
  config: Config
  user: PortalUser
  librechatUserId: ObjectId
  conversationId: string | null
}

export interface PortalTool<Shape extends z.ZodRawShape = z.ZodRawShape> {
  name: string
  title: string
  description: string
  inputSchema: Shape
  run(args: z.infer<z.ZodObject<Shape>>, ctx: ToolContext): Promise<CallToolResult>
}

/** Helper that keeps the argument types of each tool definition. */
export function defineTool<Shape extends z.ZodRawShape>(tool: PortalTool<Shape>): PortalTool {
  return tool as unknown as PortalTool
}

export function textResult(text: string, isError = false): CallToolResult {
  return { content: [{ type: 'text', text }], ...(isError ? { isError: true } : {}) }
}

/** Maps LibreChat's user id (sent as X-User-ID) to the portal user via the OIDC subject. */
export async function resolveToolUser(db: Database, librechatUserId: string): Promise<ToolContext['user'] | null> {
  if (!ObjectId.isValid(librechatUserId)) return null
  const id = new ObjectId(librechatUserId)
  const linked = await db.col.users.findOne({ librechatUserId: id, status: 'active' })
  if (linked) return linked
  const librechatUser = await db.librechat.collection('users').findOne({ _id: id }, { projection: { openidId: 1 } })
  const sub = librechatUser?.openidId
  if (typeof sub !== 'string') return null
  const user = await db.col.users.findOneAndUpdate(
    { _id: sub, status: 'active' },
    { $set: { librechatUserId: id } },
    { returnDocument: 'after' },
  )
  if (user) await applyStartBudget(db, user)
  return user
}

function header(value: string | string[] | undefined): string | null {
  const first = Array.isArray(value) ? value[0] : value
  // Unresolved LibreChat placeholders arrive literally during tool discovery
  return first && !first.startsWith('{{') ? first : null
}

/** Streamable-HTTP MCP endpoint (stateless, JSON responses) for LibreChat. */
export function registerMcpRoute(app: FastifyInstance, ctx: AppContext, tools: PortalTool[]): void {
  app.post(`${ctx.config.basePath}/mcp`, async (req, reply) => {
    const auth = req.headers.authorization ?? ''
    if (!safeEqual(auth, `Bearer ${ctx.config.PORTAL_MCP_TOKEN}`)) {
      return reply.code(401).send({ error: 'unauthorized' })
    }
    const librechatUserId = header(req.headers['x-user-id'])
    const conversationId = header(req.headers['x-conversation-id'])

    const server = new McpServer({ name: 'a-b-cloud-portal', version: '0.1.0' })
    for (const tool of tools) {
      server.registerTool(
        tool.name,
        { title: tool.title, description: tool.description, inputSchema: tool.inputSchema },
        async (args: Record<string, unknown>) => {
          if (!librechatUserId) return textResult('Kein Benutzer übermittelt.', true)
          const user = await resolveToolUser(ctx.db, librechatUserId)
          if (!user) return textResult('Benutzer unbekannt oder gesperrt.', true)
          try {
            return await tool.run(args as never, {
              db: ctx.db,
              config: ctx.config,
              user,
              librechatUserId: new ObjectId(librechatUserId),
              conversationId,
            })
          } catch (error) {
            req.log.error({ err: error, tool: tool.name }, 'tool failed')
            return textResult(`Werkzeug „${tool.name}“ fehlgeschlagen: ${(error as Error).message}`, true)
          }
        },
      )
    }
    // Stateless mode: no session ids (the SDK types do not model this with exactOptionalPropertyTypes)
    const options = { sessionIdGenerator: undefined, enableJsonResponse: true }
    const transport = new StreamableHTTPServerTransport(options as unknown as ConstructorParameters<typeof StreamableHTTPServerTransport>[0])
    reply.hijack()
    reply.raw.on('close', () => {
      void transport.close()
      void server.close()
    })
    await server.connect(transport as unknown as Parameters<typeof server.connect>[0])
    await transport.handleRequest(req.raw, reply.raw, req.body)
  })

  // Stateless server: no SSE stream and no session deletion
  app.get(`${ctx.config.basePath}/mcp`, async (_req, reply) => reply.code(405).send({ error: 'method not allowed' }))
  app.delete(`${ctx.config.basePath}/mcp`, async (_req, reply) => reply.code(405).send({ error: 'method not allowed' }))
}
