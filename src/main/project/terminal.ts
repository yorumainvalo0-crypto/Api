import { execFile, spawn, type ChildProcess } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { StringDecoder } from 'node:string_decoder'
import type { TerminalOutput } from '@shared/schemas/project'
import { resolveProjectRoot } from './files'

/** Output is batched for this long before it is emitted (keeps IPC traffic low). */
const FLUSH_DELAY_MS = 16
/** A batch is flushed immediately once it reaches this size. */
const FLUSH_SIZE = 64 * 1024
/** Grace period between SIGTERM and SIGKILL on POSIX. */
const KILL_GRACE_MS = 1500

/** Shell invocation for a command line on the given platform. */
export function shellCommand(
  command: string,
  platform: NodeJS.Platform = process.platform,
): { file: string; args: string[] } {
  if (platform === 'win32') {
    // Force UTF-8 so umlauts survive the pipe (PowerShell defaults to the OEM code page).
    const prelude =
      '[Console]::OutputEncoding=[System.Text.Encoding]::UTF8;$OutputEncoding=[System.Text.Encoding]::UTF8;'
    return {
      file: 'powershell.exe',
      args: [
        '-NoLogo',
        '-NoProfile',
        '-NonInteractive',
        '-ExecutionPolicy',
        'Bypass',
        '-Command',
        `${prelude}${command}`,
      ],
    }
  }
  return { file: '/bin/sh', args: ['-c', command] }
}

interface Run {
  child: ChildProcess
  finished: boolean
  pending: { stdout: string; stderr: string }
  timer: NodeJS.Timeout | undefined
}

/** Runs non-interactive shell commands and streams their output via `emit`. */
export class TerminalRunner {
  private readonly runs = new Map<string, Run>()

  constructor(private readonly emit: (event: TerminalOutput) => void) {}

  async run(projectPath: string, command: string): Promise<{ runId: string }> {
    const cwd = await resolveProjectRoot(projectPath)
    const runId = randomUUID()
    const { file, args } = shellCommand(command)
    const isWindows = process.platform === 'win32'
    const child = spawn(file, args, {
      cwd,
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
      // Own process group on POSIX so kill() reaches grandchildren too.
      detached: !isWindows,
      env: process.env,
    })
    const run: Run = {
      child,
      finished: false,
      pending: { stdout: '', stderr: '' },
      timer: undefined,
    }
    this.runs.set(runId, run)

    for (const kind of ['stdout', 'stderr'] as const) {
      const decoder = new StringDecoder('utf8')
      const stream = child[kind]
      stream?.on('data', (chunk: Buffer) => this.push(runId, run, kind, decoder.write(chunk)))
      stream?.on('end', () => this.push(runId, run, kind, decoder.end()))
    }

    child.on('error', (error) => {
      if (run.finished) return
      this.flush(runId, run)
      this.emit({
        runId,
        kind: 'error',
        data: `Befehl konnte nicht gestartet werden: ${error.message}`,
      })
      this.finish(runId, run, null)
    })
    child.on('close', (code) => {
      if (run.finished) return
      this.finish(runId, run, code)
    })
    return { runId }
  }

  /** Kills the process tree of a run. Returns false if the run is unknown or already done. */
  kill(runId: string): boolean {
    const run = this.runs.get(runId)
    if (!run || run.finished) return false
    killTree(run.child)
    return true
  }

  killAll(): void {
    for (const runId of this.runs.keys()) this.kill(runId)
  }

  /** Number of runs that have not finished yet. */
  get activeCount(): number {
    return this.runs.size
  }

  private push(runId: string, run: Run, kind: 'stdout' | 'stderr', data: string): void {
    if (!data) return
    run.pending[kind] += data
    if (run.pending[kind].length >= FLUSH_SIZE) {
      this.flush(runId, run)
    } else {
      run.timer ??= setTimeout(() => this.flush(runId, run), FLUSH_DELAY_MS)
    }
  }

  private flush(runId: string, run: Run): void {
    if (run.timer) clearTimeout(run.timer)
    run.timer = undefined
    for (const kind of ['stdout', 'stderr'] as const) {
      const data = run.pending[kind]
      if (!data) continue
      run.pending[kind] = ''
      this.emit({ runId, kind, data })
    }
  }

  private finish(runId: string, run: Run, exitCode: number | null): void {
    this.flush(runId, run)
    run.finished = true
    this.runs.delete(runId)
    this.emit({ runId, kind: 'exit', data: '', exitCode })
  }
}

function killTree(child: ChildProcess): void {
  const pid = child.pid
  if (pid === undefined) return
  if (process.platform === 'win32') {
    execFile('taskkill', ['/pid', String(pid), '/T', '/F'], { windowsHide: true }, () => {
      // Ignore errors: the process may have exited in the meantime.
    })
    return
  }
  const signalGroup = (signal: NodeJS.Signals) => {
    try {
      process.kill(-pid, signal)
    } catch {
      try {
        child.kill(signal)
      } catch {
        // Already gone.
      }
    }
  }
  signalGroup('SIGTERM')
  const timer = setTimeout(() => {
    if (child.exitCode === null && child.signalCode === null) signalGroup('SIGKILL')
  }, KILL_GRACE_MS)
  timer.unref()
  child.once('close', () => clearTimeout(timer))
}
