import { MongoClient, type Collection, type Db, type ObjectId } from 'mongodb'
import type { Config } from './config.js'

export type Role = 'user' | 'admin'
export type UserStatus = 'active' | 'blocked'

export interface PortalUser {
  /** Also the OIDC subject LibreChat stores as openidId */
  _id: string
  /** Lowercase, unique */
  username: string
  role: Role
  status: UserStatus
  groupId: string | null
  inviteId: string | null
  /** LibreChat's users._id once the user logged in there for the first time */
  librechatUserId: ObjectId | null
  /** Credits still to be booked once the LibreChat account exists */
  pendingStartBudgetUsd: number
  monthlyBudgetUsd: number
  nextResetAt: Date | null
  passwordHash: string | null
  totpSecret: string | null
  /** Secret shown during TOTP enrollment, confirmed by the first valid code */
  totpPendingSecret: string | null
  createdAt: Date
}

export interface Device {
  _id: string
  userId: string
  /** SHA-256 of the session cookie value */
  tokenHash: string
  label: string
  userAgent: string
  createdAt: Date
  lastSeenAt: Date
  expiresAt: Date
  revokedAt: Date | null
  /** Set when an admin passed password + TOTP in this session */
  adminVerifiedAt: Date | null
}

export interface LoginLink {
  _id: string
  userId: string
  tokenHash: string
  maxUses: number
  uses: number
  expiresAt: Date
  note: string
  revokedAt: Date | null
  createdBy: string
  createdAt: Date
}

export interface Group {
  _id: string
  name: string
  defaultStartBudgetUsd: number
  defaultMonthlyBudgetUsd: number
  createdBy: string
  createdAt: Date
}

export interface Invite {
  _id: string
  groupId: string
  /** SHA-256 for lookup; the token itself is kept encrypted so the QR can be shown again */
  tokenHash: string
  tokenEncrypted: string
  maxUses: number
  uses: number
  validFrom: Date
  validUntil: Date
  startBudgetUsd: number
  monthlyBudgetUsd: number
  note: string
  revokedAt: Date | null
  createdBy: string
  createdAt: Date
}

export interface AuditEntry {
  at: Date
  actor: string
  action: string
  target: string | null
  details: Record<string, unknown>
}

export interface OidcRecord {
  _id: string
  model: string
  payload: Record<string, unknown>
  expiresAt: Date | null
  uid?: string
  grantId?: string
  userCode?: string
}

export interface Settings {
  _id: string
  value: unknown
}

export interface Collections {
  users: Collection<PortalUser>
  devices: Collection<Device>
  loginLinks: Collection<LoginLink>
  groups: Collection<Group>
  invites: Collection<Invite>
  audit: Collection<AuditEntry>
  oidc: Collection<OidcRecord>
  settings: Collection<Settings>
}

export interface Database {
  client: MongoClient
  portal: Db
  librechat: Db
  col: Collections
  close(): Promise<void>
}

export async function connectDatabase(config: Pick<Config, 'MONGO_URI' | 'PORTAL_DB' | 'LIBRECHAT_DB'>): Promise<Database> {
  const client = new MongoClient(config.MONGO_URI)
  await client.connect()
  const portal = client.db(config.PORTAL_DB)
  const col: Collections = {
    users: portal.collection('users'),
    devices: portal.collection('devices'),
    loginLinks: portal.collection('loginLinks'),
    groups: portal.collection('groups'),
    invites: portal.collection('invites'),
    audit: portal.collection('audit'),
    oidc: portal.collection('oidc'),
    settings: portal.collection('settings'),
  }
  await ensureIndexes(col, portal)
  return {
    client,
    portal,
    librechat: client.db(config.LIBRECHAT_DB),
    col,
    close: () => client.close(),
  }
}

async function ensureIndexes(col: Collections, portal: Db): Promise<void> {
  await Promise.all([
    col.users.createIndex({ username: 1 }, { unique: true }),
    col.users.createIndex({ librechatUserId: 1 }, { sparse: true }),
    col.devices.createIndex({ tokenHash: 1 }, { unique: true }),
    col.devices.createIndex({ userId: 1 }),
    col.loginLinks.createIndex({ tokenHash: 1 }, { unique: true }),
    col.loginLinks.createIndex({ userId: 1 }),
    col.groups.createIndex({ name: 1 }, { unique: true }),
    col.invites.createIndex({ tokenHash: 1 }, { unique: true }),
    col.invites.createIndex({ groupId: 1 }),
    col.audit.createIndex({ at: -1 }),
    portal.collection('budgetEvents').createIndex({ userId: 1, at: -1 }),
    col.oidc.createIndex({ expiresAt: 1 }, { expireAfterSeconds: 0 }),
    col.oidc.createIndex({ model: 1, uid: 1 }, { sparse: true }),
    col.oidc.createIndex({ model: 1, grantId: 1 }, { sparse: true }),
  ])
}
