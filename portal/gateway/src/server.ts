import cookie from '@fastify/cookie'
import formbody from '@fastify/formbody'
import rateLimit from '@fastify/rate-limit'
import Fastify, { type FastifyInstance } from 'fastify'
import type { Config } from './config.js'
import type { Database } from './db.js'
import { registerMcpRoute } from './mcp.js'
import { createProvider } from './oidc.js'
import { registerAdminRoutes } from './routes/admin.js'
import { registerAuthRoutes } from './routes/auth.js'
import { registerGroupRoutes } from './routes/groups.js'
import { registerJoinRoutes } from './routes/join.js'
import { accountStatusTool } from './tools/account.js'
import type { AppContext } from './web.js'

export interface BuildOptions {
  config: Config
  db: Database
  logger?: boolean
}

export async function buildApp({ config, db, logger = false }: BuildOptions): Promise<FastifyInstance> {
  const app = Fastify({ logger, trustProxy: true })
  const ctx: AppContext = { config, db }

  await app.register(cookie)
  await app.register(rateLimit, { global: false })

  const provider = await createProvider(config, db, `${config.PUBLIC_URL}/oauth/openid/callback`)

  // oidc-provider reads the raw request body itself, so its routes get no body parsers
  await app.register(async (oidc) => {
    oidc.removeAllContentTypeParsers()
    oidc.addContentTypeParser('*', (_req, _payload, done) => done(null))
    const callback = provider.callback()
    const prefix = `${config.basePath}/oidc`
    oidc.all(`${prefix}/*`, (req, reply) => {
      reply.hijack()
      // oidc-provider derives its mount path from originalUrl vs. url (like Express)
      const raw = req.raw as typeof req.raw & { originalUrl?: string }
      const url = raw.url ?? prefix
      raw.originalUrl = url
      raw.url = url.slice(prefix.length) || '/'
      callback(raw, reply.raw)
    })
  })

  // Everything else uses regular form parsing
  await app.register(async (web) => {
    await web.register(formbody)
    registerAuthRoutes(web, ctx, provider)
    registerAdminRoutes(web, ctx)
    registerGroupRoutes(web, ctx)
    registerJoinRoutes(web, ctx)
    registerMcpRoute(web, ctx, [accountStatusTool])
  })

  return app
}
