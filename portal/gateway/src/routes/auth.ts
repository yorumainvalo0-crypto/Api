import type { FastifyInstance, FastifyReply } from 'fastify'
import type Provider from 'oidc-provider'
import { errors } from 'oidc-provider'
import { SESSION_COOKIE, createDeviceSession, deviceLabel, revokeDevice } from '../devices.js'
import { html, page } from '../html.js'
import { checkLoginLink, redeemLoginLink } from '../login-links.js'
import { generateTotpSecret, sign, totpStep, totpUri, verifyPassword, safeEqual } from '../security.js'
import { audit } from '../users.js'
import { type AppContext, checkCsrf, cookieOptions, currentSession, field, qrSvg, sendHtml } from '../web.js'

const PENDING_COOKIE = 'portal_pending'
const PENDING_TTL_MS = 10 * 60_000
/** Wrong TOTP codes (after a correct password) before the account waits TOTP_LOCK_MS */
const TOTP_MAX_FAILURES = 5
const TOTP_LOCK_MS = 15 * 60_000

const REASONS: Record<string, string> = {
  invalid: 'Dieser Login-Code ist ungültig.',
  expired: 'Dieser Login-Code ist abgelaufen. Bitte beim Admin einen neuen anfordern.',
  used: 'Dieser Login-Code wurde schon benutzt. Bitte beim Admin einen neuen anfordern.',
  revoked: 'Dieser Login-Code wurde widerrufen.',
  blocked: 'Dieser Zugang ist gesperrt.',
}

/** Only interaction URLs of this gateway are accepted as login return targets. */
function safeReturnTo(basePath: string, value: string): string | null {
  return new RegExp(`^${basePath}/oidc/interaction/[A-Za-z0-9_-]+$`).test(value) ? value : null
}

export function registerAuthRoutes(app: FastifyInstance, ctx: AppContext, provider: Provider): void {
  const { config, db } = ctx
  const base = config.basePath
  const sessionMaxAge = config.DEVICE_SESSION_DAYS * 86_400

  app.get(`${base}/health`, async () => ({ ok: true }))

  // --- QR login link: /portal/l/:token ---
  // GET only shows a button: link previews in messengers and mail scanners must not use up the link
  function linkError(reply: FastifyReply, reason: keyof typeof REASONS) {
    return sendHtml(
      reply,
      page('Login', html`<h1>Anmeldung nicht möglich</h1><div class="card"><p class="error">${REASONS[reason]}</p></div>`, { narrow: true }),
      410,
    )
  }

  app.get<{ Params: { token: string } }>(`${base}/l/:token`, async (req, reply) => {
    const status = await checkLoginLink(db, req.params.token)
    if (!status.ok) return linkError(reply, status.reason)
    reply.header('referrer-policy', 'no-referrer')
    return sendHtml(
      reply,
      page(
        'Anmelden',
        html`<h1>A-B Cloud AI Portal</h1>
          <form method="post" class="card">
            <p>Mit diesem Login-Code wird dieses Gerät angemeldet.</p>
            <button type="submit" id="login-confirm">Auf diesem Gerät anmelden</button>
          </form>`,
        { narrow: true },
      ),
    )
  })

  app.post<{ Params: { token: string } }>(`${base}/l/:token`, async (req, reply) => {
    const result = await redeemLoginLink(db, req.params.token)
    if (!result.ok) return linkError(reply, result.reason)
    const userAgent = req.headers['user-agent'] ?? ''
    const { token } = await createDeviceSession(db, result.user, {
      label: result.link.note || deviceLabel(userAgent),
      userAgent,
      days: config.DEVICE_SESSION_DAYS,
    })
    await audit(db, result.user.username, 'login-link.redeemed', result.user._id, { linkId: result.link._id })
    reply.setCookie(SESSION_COOKIE, token, cookieOptions(config, sessionMaxAge))
    return reply.redirect(`${config.PUBLIC_URL}/`, 303)
  })

  // --- Admin login (password, then TOTP) ---
  app.get<{ Querystring: { returnTo?: string } }>(`${base}/admin/login`, async (req, reply) => {
    return sendHtml(reply, adminLoginPage(req.query.returnTo ?? '', ''))
  })

  function adminLoginPage(returnTo: string, error: string): string {
    return page(
      'Admin-Login',
      html`<h1>Admin-Login</h1>
        <form method="post" class="card">
          ${error ? html`<p class="error">${error}</p>` : ''}
          <input type="hidden" name="returnTo" value="${returnTo}">
          <label for="username">Benutzername</label>
          <input id="username" name="username" autocomplete="username" required>
          <label for="password">Passwort</label>
          <input id="password" name="password" type="password" autocomplete="current-password" required>
          <button type="submit">Weiter</button>
        </form>`,
      { narrow: true },
    )
  }

  app.post(`${base}/admin/login`, { config: { rateLimit: { max: config.ADMIN_LOGIN_RATE_LIMIT, timeWindow: '5 minutes' } } }, async (req, reply) => {
    const username = field(req.body, 'username').trim().toLowerCase()
    const password = field(req.body, 'password')
    const returnTo = field(req.body, 'returnTo')
    const user = await db.col.users.findOne({ username, role: 'admin', status: 'active' })
    const ok = !!user?.passwordHash && (await verifyPassword(password, user.passwordHash))
    if (!user || !ok) {
      await audit(db, username || '?', 'admin.login.failed', null)
      return sendHtml(reply, adminLoginPage(returnTo, 'Benutzername oder Passwort falsch.'), 401)
    }
    if (!user.totpSecret && !user.totpPendingSecret) {
      await db.col.users.updateOne({ _id: user._id }, { $set: { totpPendingSecret: generateTotpSecret() } })
    }
    const expires = Date.now() + PENDING_TTL_MS
    const value = `${user._id}.${expires}`
    reply.setCookie(PENDING_COOKIE, `${value}.${sign(config.PORTAL_SECRET, `pending:${value}`)}`, cookieOptions(config, PENDING_TTL_MS / 1000))
    return reply.redirect(`${base}/admin/totp${returnTo ? `?returnTo=${encodeURIComponent(returnTo)}` : ''}`)
  })

  async function pendingAdmin(cookie: string | undefined) {
    const [userId, expires, signature] = (cookie ?? '').split('.')
    if (!userId || !expires || !signature) return null
    if (!safeEqual(signature, sign(config.PORTAL_SECRET, `pending:${userId}.${expires}`))) return null
    if (Number(expires) < Date.now()) return null
    return db.col.users.findOne({ _id: userId, role: 'admin', status: 'active' })
  }

  async function totpPage(userId: string, returnTo: string, error: string): Promise<string> {
    const user = await db.col.users.findOne({ _id: userId })
    const enrolling = !user?.totpSecret && !!user?.totpPendingSecret
    const setup = enrolling
      ? html`<p>Richte die Zwei-Faktor-Anmeldung ein: QR-Code mit einer Authenticator-App scannen
            (z. B. Google Authenticator, Aegis, 1Password) und den 6-stelligen Code eingeben.</p>
          <div class="qr">${await qrSvg(totpUri(user!.totpPendingSecret!, user!.username, 'A-B Cloud AI Portal'))}</div>
          <p class="muted">Schlüssel manuell: <code>${user!.totpPendingSecret}</code></p>`
      : html`<p>Code aus der Authenticator-App eingeben.</p>`
    return page(
      'Zwei-Faktor-Code',
      html`<h1>Zwei-Faktor-Code</h1>
        <form method="post" class="card">
          ${error ? html`<p class="error">${error}</p>` : ''}
          ${setup}
          <input type="hidden" name="returnTo" value="${returnTo}">
          <label for="code">6-stelliger Code</label>
          <input id="code" name="code" inputmode="numeric" autocomplete="one-time-code" pattern="[0-9 ]{6,7}" required>
          <button type="submit">Anmelden</button>
        </form>`,
      { narrow: true },
    )
  }

  app.get<{ Querystring: { returnTo?: string } }>(`${base}/admin/totp`, async (req, reply) => {
    const user = await pendingAdmin(req.cookies[PENDING_COOKIE])
    if (!user) return reply.redirect(`${base}/admin/login`)
    return sendHtml(reply, await totpPage(user._id, req.query.returnTo ?? '', ''))
  })

  app.post(`${base}/admin/totp`, { config: { rateLimit: { max: config.ADMIN_LOGIN_RATE_LIMIT, timeWindow: '5 minutes' } } }, async (req, reply) => {
    const user = await pendingAdmin(req.cookies[PENDING_COOKIE])
    if (!user) return reply.redirect(`${base}/admin/login`)
    const code = field(req.body, 'code')
    const returnTo = field(req.body, 'returnTo')
    const failures = await db.col.audit.countDocuments({
      target: user._id,
      action: 'admin.totp.failed',
      at: { $gt: new Date(Date.now() - TOTP_LOCK_MS) },
    })
    if (failures >= TOTP_MAX_FAILURES) {
      reply.clearCookie(PENDING_COOKIE, { path: base })
      return sendHtml(reply, adminLoginPage('', 'Zu viele falsche Codes. Bitte 15 Minuten warten.'), 429)
    }
    const secret = user.totpSecret ?? user.totpPendingSecret
    const step = secret ? totpStep(secret, code) : null
    // Each code works once: the step must be newer than the last accepted one
    const accepted =
      step !== null &&
      (
        await db.col.users.updateOne(
          { _id: user._id, $or: [{ totpLastStep: { $exists: false } }, { totpLastStep: { $lt: step } }] },
          { $set: { totpLastStep: step, ...(user.totpSecret ? {} : { totpSecret: secret, totpPendingSecret: null }) } },
        )
      ).modifiedCount === 1
    if (!accepted) {
      await audit(db, user.username, 'admin.totp.failed', user._id)
      return sendHtml(reply, await totpPage(user._id, returnTo, 'Code falsch, abgelaufen oder schon benutzt.'), 401)
    }
    const userAgent = req.headers['user-agent'] ?? ''
    const { token, device } = await createDeviceSession(db, user, {
      label: `Admin: ${deviceLabel(userAgent)}`,
      userAgent,
      days: config.DEVICE_SESSION_DAYS,
    })
    await db.col.devices.updateOne({ _id: device._id }, { $set: { adminVerifiedAt: new Date() } })
    await audit(db, user.username, 'admin.login', user._id)
    reply.clearCookie(PENDING_COOKIE, { path: base })
    reply.setCookie(SESSION_COOKIE, token, cookieOptions(config, sessionMaxAge))
    return reply.redirect(safeReturnTo(base, returnTo) ?? `${base}/admin`)
  })

  app.post(`${base}/logout`, async (req, reply) => {
    const session = await currentSession(ctx, req)
    if (session) {
      if (!checkCsrf(config, session, req.body)) return reply.code(403).send('Ungültiges Formular.')
      await revokeDevice(db, session.device._id)
    }
    reply.clearCookie(SESSION_COOKIE, { path: base })
    return reply.redirect(`${base}/admin/login`)
  })

  // --- OIDC interactions: log the device's user into LibreChat without a prompt ---
  app.get<{ Params: { uid: string } }>(`${base}/oidc/interaction/:uid`, async (req, reply) => {
    let details
    try {
      details = await provider.interactionDetails(req.raw, reply.raw)
    } catch (error) {
      if (error instanceof errors.SessionNotFound) return reply.redirect(`${config.PUBLIC_URL}/`)
      throw error
    }
    const session = await currentSession(ctx, req)
    if (!session) {
      const returnTo = `${base}/oidc/interaction/${req.params.uid}`
      return sendHtml(
        reply,
        page(
          'Anmelden',
          html`<h1>A-B Cloud AI Portal</h1>
            <div class="card">
              <p><strong>Du bist auf diesem Gerät nicht angemeldet.</strong></p>
              <p>Scanne den QR-Code aus deiner Einladung oder bitte den Admin um einen Login-QR-Code.</p>
            </div>
            <p class="muted"><a href="${base}/admin/login?returnTo=${encodeURIComponent(returnTo)}">Admin-Login</a></p>`,
          { narrow: true },
        ),
        401,
      )
    }

    reply.hijack()
    if (details.prompt.name === 'login') {
      await provider.interactionFinished(
        req.raw,
        reply.raw,
        { login: { accountId: session.user._id } },
        { mergeWithLastSubmission: false },
      )
      return
    }
    // consent: grant everything LibreChat asked for (first-party client)
    const { grantId, params } = details
    const grant = grantId
      ? await provider.Grant.find(grantId)
      : new provider.Grant({ accountId: session.user._id, clientId: String(params.client_id) })
    if (!grant) throw new Error('grant not found')
    const missing = details.prompt.details as {
      missingOIDCScope?: string[]
      missingOIDCClaims?: string[]
      missingResourceScopes?: Record<string, string[]>
    }
    if (missing.missingOIDCScope) grant.addOIDCScope(missing.missingOIDCScope.join(' '))
    if (missing.missingOIDCClaims) grant.addOIDCClaims(missing.missingOIDCClaims)
    for (const [indicator, scopes] of Object.entries(missing.missingResourceScopes ?? {})) {
      grant.addResourceScope(indicator, scopes.join(' '))
    }
    const savedGrantId = await grant.save()
    await provider.interactionFinished(
      req.raw,
      reply.raw,
      { consent: { grantId: savedGrantId } },
      { mergeWithLastSubmission: true },
    )
  })
}
