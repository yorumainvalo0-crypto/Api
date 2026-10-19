import { randomUUID } from 'node:crypto'
import type { Database, Device, PortalUser } from './db.js'
import { hashToken, randomToken } from './security.js'

export const SESSION_COOKIE = 'portal_sid'

export interface SessionContext {
  device: Device
  user: PortalUser
}

/** Starts a device session; the returned token goes into the session cookie. */
export async function createDeviceSession(
  db: Database,
  user: PortalUser,
  options: { label: string; userAgent: string; days: number },
): Promise<{ token: string; device: Device }> {
  const token = randomToken()
  const now = new Date()
  const device: Device = {
    _id: randomUUID(),
    userId: user._id,
    tokenHash: hashToken(token),
    label: options.label,
    userAgent: options.userAgent.slice(0, 300),
    createdAt: now,
    lastSeenAt: now,
    expiresAt: new Date(now.getTime() + options.days * 86_400_000),
    revokedAt: null,
    adminVerifiedAt: null,
  }
  await db.col.devices.insertOne(device)
  return { token, device }
}

/** Resolves a session cookie to an active device and user, or null. */
export async function resolveSession(db: Database, token: string | undefined): Promise<SessionContext | null> {
  if (!token) return null
  const now = new Date()
  const device = await db.col.devices.findOneAndUpdate(
    { tokenHash: hashToken(token), revokedAt: null, expiresAt: { $gt: now } },
    { $set: { lastSeenAt: now } },
    { returnDocument: 'after' },
  )
  if (!device) return null
  const user = await db.col.users.findOne({ _id: device.userId })
  if (!user || user.status !== 'active') return null
  return { device, user }
}

export async function revokeDevice(db: Database, deviceId: string): Promise<void> {
  await db.col.devices.updateOne({ _id: deviceId, revokedAt: null }, { $set: { revokedAt: new Date() } })
}

export async function revokeAllDevices(db: Database, userId: string): Promise<void> {
  await db.col.devices.updateMany({ userId, revokedAt: null }, { $set: { revokedAt: new Date() } })
}

export async function listDevices(db: Database, userId: string): Promise<Device[]> {
  return db.col.devices.find({ userId }).sort({ createdAt: -1 }).toArray()
}

/** Short human label from a user agent string. */
export function deviceLabel(userAgent: string): string {
  const os = /iPhone|iPad/.test(userAgent)
    ? 'iOS'
    : /Android/.test(userAgent)
      ? 'Android'
      : /Windows/.test(userAgent)
        ? 'Windows'
        : /Mac OS X/.test(userAgent)
          ? 'macOS'
          : /Linux/.test(userAgent)
            ? 'Linux'
            : 'Gerät'
  const browser = /Edg\//.test(userAgent)
    ? 'Edge'
    : /Firefox\//.test(userAgent)
      ? 'Firefox'
      : /Chrome\//.test(userAgent)
        ? 'Chrome'
        : /Safari\//.test(userAgent)
          ? 'Safari'
          : 'Browser'
  return `${browser} auf ${os}`
}
