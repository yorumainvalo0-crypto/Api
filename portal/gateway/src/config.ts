import { z } from 'zod'

const schema = z.object({
  PORT: z.coerce.number().int().default(8080),
  /** Public base URL of the portal, e.g. https://ai.dev.a-b-cloud.de */
  PUBLIC_URL: z.url().transform((u) => u.replace(/\/+$/, '')),
  MONGO_URI: z.string().default('mongodb://mongodb:27017'),
  PORTAL_DB: z.string().default('portal'),
  LIBRECHAT_DB: z.string().default('LibreChat'),
  /** Secret for cookie signing, CSRF tokens and OIDC cookie keys (min 32 chars) */
  PORTAL_SECRET: z.string().min(32),
  OIDC_CLIENT_ID: z.string().default('librechat'),
  OIDC_CLIENT_SECRET: z.string().min(8),
  /** Bearer token LibreChat sends to the MCP endpoint */
  PORTAL_MCP_TOKEN: z.string().min(8),
  /** First admin, created on startup when no admin exists yet */
  PORTAL_ADMIN_USERNAME: z.string().optional(),
  PORTAL_ADMIN_PASSWORD: z.string().min(12).optional(),
  /** Domain for the technical e-mail addresses LibreChat requires */
  USER_EMAIL_DOMAIN: z.string().default('users.portal.invalid'),
  /** Device sessions stay valid this long */
  DEVICE_SESSION_DAYS: z.coerce.number().int().positive().default(180),
  /** Set to false only for local http testing */
  COOKIE_SECURE: z
    .enum(['true', 'false'])
    .default('true')
    .transform((v) => v === 'true'),
})

export type Config = z.infer<typeof schema> & {
  /** Base path all gateway routes live under */
  basePath: '/portal'
  issuer: string
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const parsed = schema.parse(env)
  return { ...parsed, basePath: '/portal', issuer: `${parsed.PUBLIC_URL}/portal/oidc` }
}
