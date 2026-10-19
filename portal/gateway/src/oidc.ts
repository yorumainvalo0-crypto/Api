import { generateKeyPairSync, randomUUID } from 'node:crypto'
import Provider, { type Adapter, type AdapterPayload, type Configuration } from 'oidc-provider'
import type { Config } from './config.js'
import type { Database } from './db.js'
import { userEmail } from './users.js'

/** Lets the adapter class reach the database the provider was created with. */
let adapterDb: Database | null = null

/** Stores all oidc-provider models (sessions, grants, codes, tokens) in one collection. */
class MongoAdapter implements Adapter {
  constructor(private readonly model: string) {}

  private get col() {
    if (!adapterDb) throw new Error('OIDC adapter used before initialisation')
    return adapterDb.col.oidc
  }

  private key(id: string): string {
    return `${this.model}:${id}`
  }

  async upsert(id: string, payload: AdapterPayload, expiresIn?: number): Promise<void> {
    await this.col.updateOne(
      { _id: this.key(id) },
      {
        $set: {
          model: this.model,
          payload: payload as Record<string, unknown>,
          expiresAt: expiresIn ? new Date(Date.now() + expiresIn * 1000) : null,
          ...(payload.uid ? { uid: payload.uid } : {}),
          ...(payload.grantId ? { grantId: payload.grantId } : {}),
          ...(payload.userCode ? { userCode: payload.userCode } : {}),
        },
      },
      { upsert: true },
    )
  }

  async find(id: string): Promise<AdapterPayload | undefined> {
    const doc = await this.col.findOne({ _id: this.key(id) })
    return doc ? (doc.payload as AdapterPayload) : undefined
  }

  async findByUid(uid: string): Promise<AdapterPayload | undefined> {
    const doc = await this.col.findOne({ model: this.model, uid })
    return doc ? (doc.payload as AdapterPayload) : undefined
  }

  async findByUserCode(userCode: string): Promise<AdapterPayload | undefined> {
    const doc = await this.col.findOne({ model: this.model, userCode })
    return doc ? (doc.payload as AdapterPayload) : undefined
  }

  async consume(id: string): Promise<void> {
    await this.col.updateOne(
      { _id: this.key(id) },
      { $set: { 'payload.consumed': Math.floor(Date.now() / 1000) } },
    )
  }

  async destroy(id: string): Promise<void> {
    await this.col.deleteOne({ _id: this.key(id) })
  }

  async revokeByGrantId(grantId: string): Promise<void> {
    await this.col.deleteMany({ grantId })
  }
}

/** Signing keys survive restarts so issued tokens stay verifiable. */
async function loadSigningKeys(db: Database): Promise<Record<string, unknown>[]> {
  const stored = await db.col.settings.findOne({ _id: 'oidc.jwks' })
  if (stored) return stored.value as Record<string, unknown>[]
  const { privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 })
  const jwk = { ...privateKey.export({ format: 'jwk' }), kid: randomUUID(), use: 'sig', alg: 'RS256' }
  await db.col.settings.updateOne({ _id: 'oidc.jwks' }, { $setOnInsert: { value: [jwk] } }, { upsert: true })
  const winner = await db.col.settings.findOne({ _id: 'oidc.jwks' })
  return winner!.value as Record<string, unknown>[]
}

export async function createProvider(config: Config, db: Database, librechatCallbackUrl: string): Promise<Provider> {
  adapterDb = db
  const keys = await loadSigningKeys(db)

  const configuration: Configuration = {
    adapter: MongoAdapter,
    clients: [
      {
        client_id: config.OIDC_CLIENT_ID,
        client_secret: config.OIDC_CLIENT_SECRET,
        redirect_uris: [librechatCallbackUrl],
        post_logout_redirect_uris: [config.PUBLIC_URL, `${config.PUBLIC_URL}/`, `${config.PUBLIC_URL}/login`],
        grant_types: ['authorization_code', 'refresh_token'],
        response_types: ['code'],
        // LibreChat's openid-client default
        token_endpoint_auth_method: 'client_secret_basic',
      },
    ],
    claims: {
      openid: ['sub'],
      profile: ['name', 'preferred_username', 'roles'],
      email: ['email', 'email_verified'],
    },
    // LibreChat reads the claims from the ID token as well as from userinfo
    conformIdTokenClaims: false,
    cookies: { keys: [config.PORTAL_SECRET] },
    jwks: { keys: keys as never },
    features: {
      devInteractions: { enabled: false },
      rpInitiatedLogout: { enabled: true },
    },
    pkce: { required: () => false },
    interactions: {
      url: (_ctx, interaction) => `${config.basePath}/oidc/interaction/${interaction.uid}`,
    },
    // The first-party LibreChat client never asks for consent
    loadExistingGrant: async (ctx) => {
      const grantId =
        ctx.oidc.result?.consent?.grantId ?? ctx.oidc.session?.grantIdFor(ctx.oidc.client!.clientId)
      return grantId ? ctx.oidc.provider.Grant.find(grantId) : undefined
    },
    findAccount: async (_ctx, sub) => {
      const user = await db.col.users.findOne({ _id: sub, status: 'active' })
      if (!user) return undefined
      return {
        accountId: user._id,
        claims: async () => ({
          sub: user._id,
          name: user.username,
          preferred_username: user.username,
          email: userEmail(user.username, config.USER_EMAIL_DOMAIN),
          email_verified: true,
          roles: user.role === 'admin' ? ['admin'] : ['user'],
        }),
      }
    },
    ttl: {
      Session: config.DEVICE_SESSION_DAYS * 86_400,
      Interaction: 3_600,
      Grant: config.DEVICE_SESSION_DAYS * 86_400,
      AuthorizationCode: 60,
      AccessToken: 3_600,
      IdToken: 3_600,
      RefreshToken: 14 * 86_400,
    },
    renderError: async (ctx, out) => {
      ctx.type = 'html'
      ctx.body = `<!doctype html><meta charset="utf-8"><title>Fehler</title><p>Anmeldung fehlgeschlagen: ${String(out.error_description ?? out.error).replace(/[<>&"]/g, '')}</p><p><a href="${config.PUBLIC_URL}/">Zurück</a></p>`
    },
  }

  const provider = new Provider(config.issuer, configuration)
  // TLS ends at nginx; trust X-Forwarded-* headers
  provider.proxy = true
  return provider
}
