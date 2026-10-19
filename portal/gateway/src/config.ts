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
  // --- Media tools via OpenRouter (image, speech, video) ---
  /** Image, speech and video tools via OpenRouter; off until the admin decides on the models */
  MEDIA_ENABLED: z
    .enum(['true', 'false'])
    .default('false')
    .transform((v) => v === 'true'),
  OPENROUTER_API_KEY: z.string().default(''),
  OPENROUTER_BASE_URL: z.url().default('https://openrouter.ai/api/v1'),
  MEDIA_DIR: z.string().default('/data/media'),
  MEDIA_RETENTION_DAYS: z.coerce.number().positive().default(30),
  IMAGE_MODEL: z.string().default('google/gemini-2.5-flash-image'),
  TTS_MODEL: z.string().default('openai/gpt-4o-mini-tts-2025-12-15'),
  TTS_VOICE: z.string().default('alloy'),
  /** Fallback price when OpenRouter reports no cost for a speech request */
  TTS_USD_PER_1K_CHARS: z.coerce.number().nonnegative().default(0.015),
  VIDEO_MODEL: z.string().default('google/veo-3.1'),
  /** Minimum remaining balance before a media request is sent (rough upper cost per call) */
  IMAGE_MIN_BALANCE_USD: z.coerce.number().nonnegative().default(0.2),
  /** Anthropic's price per web search (10 USD per 1000), billed to the person's budget */
  WEB_SEARCH_USD: z.coerce.number().nonnegative().default(0.01),
  TTS_MIN_BALANCE_USD: z.coerce.number().nonnegative().default(0.05),
  VIDEO_MIN_BALANCE_USD: z.coerce.number().nonnegative().default(3),
  /** Admin password/TOTP attempts per IP and 5 minutes; invite joins per IP and 10 minutes */
  ADMIN_LOGIN_RATE_LIMIT: z.coerce.number().int().positive().default(10),
  JOIN_RATE_LIMIT: z.coerce.number().int().positive().default(20),
  /** Code runner (CAD sandbox) inside the Docker network */
  CODE_RUNNER_URL: z.url().default('http://code-runner:8000'),
  /** Second factor (authenticator app) for admins; off by default: admins log in with their password */
  ADMIN_TOTP: z
    .enum(['true', 'false'])
    .default('false')
    .transform((v) => v === 'true'),
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
