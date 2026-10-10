import { createSdkMcpServer, tool } from '@anthropic-ai/claude-agent-sdk'
import { z } from 'zod'
import type { WebClient } from './web-client'

export const WEB_MCP_SERVER = 'web'
export const WEB_TOOL_NAMES = [
  `mcp__${WEB_MCP_SERVER}__web_search`,
  `mcp__${WEB_MCP_SERVER}__web_fetch`,
]

function errorResult(error: unknown) {
  return {
    content: [
      { type: 'text' as const, text: error instanceof Error ? error.message : String(error) },
    ],
    isError: true,
  }
}

/** In-process MCP server exposing free, key-less web search and page reading to the agent. */
export function createWebMcpServer(client: WebClient) {
  return createSdkMcpServer({
    name: WEB_MCP_SERVER,
    version: '1.0.0',
    instructions:
      'Use web_search to find current information on the internet, then web_fetch to read the ' +
      'most relevant pages. Cite the URLs you used.',
    tools: [
      tool(
        'web_search',
        'Searches the web (DuckDuckGo/Bing, no API key) and returns titles, URLs and snippets.',
        {
          query: z.string().min(1).describe('Search query'),
          max_results: z.number().int().min(1).max(15).optional().describe('Default 8'),
        },
        async ({ query, max_results }) => {
          try {
            const { provider, results } = await client.search(query, max_results ?? 8)
            const text = results
              .map((r, i) => `${i + 1}. ${r.title}\n   ${r.url}\n   ${r.snippet}`)
              .join('\n\n')
            return { content: [{ type: 'text', text: `Suchergebnisse (${provider}):\n\n${text}` }] }
          } catch (error) {
            return errorResult(error)
          }
        },
        { annotations: { readOnlyHint: true, openWorldHint: true } },
      ),
      tool(
        'web_fetch',
        'Loads a web page in a real browser engine and returns its main content as Markdown.',
        {
          url: z.string().describe('Absolute http(s) URL'),
          max_chars: z.number().int().min(1000).max(100_000).optional().describe('Default 24000'),
        },
        async ({ url, max_chars }) => {
          try {
            const page = await client.fetchPage(url, max_chars)
            return {
              content: [
                { type: 'text', text: `# ${page.title}\nQuelle: ${page.url}\n\n${page.markdown}` },
              ],
            }
          } catch (error) {
            return errorResult(error)
          }
        },
        { annotations: { readOnlyHint: true, openWorldHint: true } },
      ),
    ],
  })
}
