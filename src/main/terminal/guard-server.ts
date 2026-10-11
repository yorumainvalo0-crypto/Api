import { randomBytes, timingSafeEqual } from 'node:crypto'
import { createServer, type IncomingMessage, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { checkToolAccess, hookOutput, type GuardRoots } from '../agent/path-guard'

/**
 * Answers the PreToolUse HTTP hook of `claude` in the terminal with the same path guard the
 * coding chat uses in-process. An HTTP hook needs no script runtime on the user's machine (a
 * command hook would need Node, and ELECTRON_RUN_AS_NODE must not leak into the commands Claude
 * runs). Listens on 127.0.0.1 with a random bearer token per app run; the hook is configured with
 * onFailure "block", so tool calls are refused when the app does not answer.
 */
export class PathGuardServer {
  private server: Server | undefined
  private starting: Promise<{ url: string; token: string }> | undefined
  private readonly token = randomBytes(24).toString('hex')
  private readonly sessions = new Map<string, GuardRoots>()

  register(sessionId: string, roots: GuardRoots): void {
    this.sessions.set(sessionId, roots)
  }

  unregister(sessionId: string): void {
    this.sessions.delete(sessionId)
  }

  /** Answer for one hook request (exported logic for tests without HTTP). */
  decide(sessionId: string, body: unknown): Record<string, unknown> {
    const roots = this.sessions.get(sessionId)
    const input = body && typeof body === 'object' ? (body as Record<string, unknown>) : {}
    if (!roots) {
      return hookOutput({
        action: 'deny',
        reason: 'Von AI Workbench blockiert: Diese Terminal-Sitzung ist nicht mehr aktiv.',
      })
    }
    if (input['hook_event_name'] !== 'PreToolUse' || typeof input['tool_name'] !== 'string') {
      return {}
    }
    const cwd = typeof input['cwd'] === 'string' && input['cwd'] ? input['cwd'] : roots.readWrite[0]
    return hookOutput(
      checkToolAccess(input['tool_name'], input['tool_input'], {
        roots,
        cwd: cwd ?? '/',
        permissionMode:
          typeof input['permission_mode'] === 'string' ? input['permission_mode'] : undefined,
      }),
    )
  }

  /** Starts the server once; the hook URL of a session is `${url}/${sessionId}`. */
  start(): Promise<{ url: string; token: string }> {
    this.starting ??= new Promise((resolve, reject) => {
      const expected = Buffer.from(`Bearer ${this.token}`)
      const server = createServer((req, res) => {
        const auth = Buffer.from(req.headers.authorization ?? '')
        const authorized = auth.length === expected.length && timingSafeEqual(auth, expected)
        const match = /^\/guard\/([\w-]{1,100})$/.exec((req.url ?? '').split('?')[0] ?? '')
        if (req.method !== 'POST' || !match?.[1]) {
          res.writeHead(404).end()
          return
        }
        if (!authorized) {
          res.writeHead(401).end()
          return
        }
        const sessionId = match[1]
        readJson(req)
          .then((body) => {
            const answer = this.decide(sessionId, body)
            res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify(answer))
          })
          .catch(() => {
            if (!res.headersSent) res.writeHead(400).end()
          })
      })
      server.on('error', reject)
      server.listen(0, '127.0.0.1', () => {
        const { port } = server.address() as AddressInfo
        this.server = server
        resolve({ url: `http://127.0.0.1:${port}/guard`, token: this.token })
      })
      server.unref()
    })
    return this.starting
  }

  close(): Promise<void> {
    const server = this.server
    this.server = undefined
    this.starting = undefined
    if (!server) return Promise.resolve()
    return new Promise((resolve) => {
      server.close(() => resolve())
      server.closeAllConnections()
    })
  }
}

/** Write/Edit calls carry the whole file content. */
const MAX_BODY_BYTES = 64 * 1024 * 1024

function readJson(req: IncomingMessage): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = []
    let size = 0
    req.on('data', (chunk: Buffer) => {
      size += chunk.length
      if (size > MAX_BODY_BYTES) {
        reject(new Error('too large'))
        req.destroy()
        return
      }
      chunks.push(chunk)
    })
    req.on('end', () => {
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString('utf8')))
      } catch (error) {
        reject(error instanceof Error ? error : new Error(String(error)))
      }
    })
    req.on('error', reject)
  })
}
