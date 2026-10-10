// Minimal stdio MCP server used by the add-on integration test.
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import { z } from 'zod'

const server = new McpServer({ name: 'echo', version: '1.0.0' })
server.tool('echo', 'Echoes text back', { text: z.string() }, async ({ text }) => ({
  content: [{ type: 'text', text: `ECHO:${text}:${process.env.ECHO_SECRET ?? ''}` }],
}))
await server.connect(new StdioServerTransport())
