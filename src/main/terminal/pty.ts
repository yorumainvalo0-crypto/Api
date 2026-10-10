import { createRequire } from 'node:module'
import type * as NodePty from '@lydell/node-pty'
import { toUnpackedPath } from '../agent/executable'

export type PtyModule = typeof NodePty
export type Pty = NodePty.IPty

let cached: PtyModule | undefined

/**
 * Loads node-pty (prebuilt N-API binaries, no rebuild for Electron needed). In a packaged app it
 * is loaded from app.asar.unpacked (see electron-builder.yml): on Windows it starts a worker
 * script and a helper process by file path, which cannot live inside the asar archive.
 */
export function loadPty(): PtyModule {
  if (!cached) {
    const require = createRequire(import.meta.url)
    cached = require(toUnpackedPath(require.resolve('@lydell/node-pty'))) as PtyModule
  }
  return cached
}

/** Output is batched for this long before it is emitted (keeps IPC traffic low). */
const FLUSH_DELAY_MS = 16
/** A batch is flushed immediately once it reaches this size. */
const FLUSH_SIZE = 64 * 1024
/** Grace period between SIGHUP and SIGKILL on POSIX. */
const KILL_GRACE_MS = 2000

export interface PtySpawnOptions {
  file: string
  args: string[]
  cwd: string
  env: Record<string, string>
  cols: number
  rows: number
}

export interface PtySessionEvents {
  onData: (data: string) => void
  onExit: (exitCode: number | null, signal: number | null) => void
}

/** One shell in a pseudo terminal; output is batched like the old command runner did. */
export class PtySession {
  private pending = ''
  private timer: NodeJS.Timeout | undefined
  private exited = false
  private readonly pty: Pty

  constructor(
    options: PtySpawnOptions,
    private readonly events: PtySessionEvents,
    ptyModule: PtyModule = loadPty(),
  ) {
    this.pty = ptyModule.spawn(options.file, options.args, {
      name: 'xterm-256color',
      cols: options.cols,
      rows: options.rows,
      cwd: options.cwd,
      env: options.env,
    })
    this.pty.onData((data) => this.push(data))
    this.pty.onExit(({ exitCode, signal }) => {
      if (this.exited) return
      this.exited = true
      this.flush()
      this.events.onExit(exitCode, signal ? signal : null)
    })
  }

  get pid(): number {
    return this.pty.pid
  }

  get running(): boolean {
    return !this.exited
  }

  write(data: string | Buffer): void {
    if (!this.exited) this.pty.write(data)
  }

  resize(cols: number, rows: number): void {
    if (this.exited) return
    try {
      this.pty.resize(cols, rows)
    } catch {
      // The process may have exited in the meantime.
    }
  }

  /** Ends the shell (SIGHUP on POSIX, then SIGKILL if it is still alive after a grace period). */
  kill(): void {
    if (this.exited) return
    try {
      this.pty.kill()
    } catch {
      // Already gone.
    }
    if (process.platform === 'win32') return
    setTimeout(() => {
      if (this.exited) return
      try {
        this.pty.kill('SIGKILL')
      } catch {
        // Already gone.
      }
    }, KILL_GRACE_MS).unref()
  }

  private push(data: string): void {
    if (!data) return
    this.pending += data
    if (this.pending.length >= FLUSH_SIZE) this.flush()
    else this.timer ??= setTimeout(() => this.flush(), FLUSH_DELAY_MS)
  }

  private flush(): void {
    if (this.timer) clearTimeout(this.timer)
    this.timer = undefined
    if (!this.pending) return
    const data = this.pending
    this.pending = ''
    this.events.onData(data)
  }
}
