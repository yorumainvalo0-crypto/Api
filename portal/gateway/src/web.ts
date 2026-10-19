import type { FastifyReply, FastifyRequest } from 'fastify'
import QRCode from 'qrcode'
import type { Config } from './config.js'
import type { Database } from './db.js'
import { SESSION_COOKIE, resolveSession, type SessionContext } from './devices.js'
import { html, raw, type SafeHtml } from './html.js'
import { safeEqual, sign } from './security.js'

/** How long a password + TOTP check keeps the admin area unlocked. */
export const ADMIN_VERIFICATION_MS = 7 * 86_400_000

export interface AppContext {
  config: Config
  db: Database
}

export function cookieOptions(config: Config, maxAgeSeconds: number) {
  return {
    path: config.basePath,
    httpOnly: true,
    secure: config.COOKIE_SECURE,
    sameSite: 'lax' as const,
    maxAge: maxAgeSeconds,
  }
}

export async function currentSession(ctx: AppContext, req: FastifyRequest): Promise<SessionContext | null> {
  return resolveSession(ctx.db, req.cookies[SESSION_COOKIE])
}

export function isAdminVerified(session: SessionContext | null): session is SessionContext {
  return (
    !!session &&
    session.user.role === 'admin' &&
    !!session.device.adminVerifiedAt &&
    Date.now() - session.device.adminVerifiedAt.getTime() < ADMIN_VERIFICATION_MS
  )
}

export function csrfToken(config: Config, session: SessionContext): string {
  return sign(config.PORTAL_SECRET, `csrf:${session.device._id}`)
}

export function csrfField(config: Config, session: SessionContext): SafeHtml {
  return html`<input type="hidden" name="_csrf" value="${csrfToken(config, session)}">`
}

export function checkCsrf(config: Config, session: SessionContext, body: unknown): boolean {
  const token = (body as { _csrf?: unknown } | null)?._csrf
  return typeof token === 'string' && safeEqual(token, csrfToken(config, session))
}

export function sendHtml(reply: FastifyReply, body: string, status = 200): FastifyReply {
  return reply.code(status).header('content-type', 'text/html; charset=utf-8').header('cache-control', 'no-store').send(body)
}

export async function qrSvg(text: string): Promise<SafeHtml> {
  return raw(await QRCode.toString(text, { type: 'svg', errorCorrectionLevel: 'M', margin: 1 }))
}

/** Reads a string field from a urlencoded form body. */
export function field(body: unknown, name: string): string {
  const value = (body as Record<string, unknown> | null)?.[name]
  return typeof value === 'string' ? value : ''
}

export function formatDate(date: Date | null | undefined): string {
  if (!date) return '–'
  return date.toLocaleString('de-DE', { timeZone: 'Europe/Berlin', dateStyle: 'short', timeStyle: 'short' })
}
