import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { TerminalOutput } from '@shared/schemas/project'
import { shellCommand, TerminalRunner } from '../src/main/project/terminal'

let dir: string
let events: TerminalOutput[]
let runner: TerminalRunner

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'aiw-term-'))
  events = []
  runner = new TerminalRunner((e) => events.push(e))
})
afterEach(() => {
  runner.killAll()
  rmSync(dir, { recursive: true, force: true })
})

function waitForExit(runId: string, timeoutMs = 10_000): Promise<TerminalOutput> {
  return new Promise((resolve, reject) => {
    const started = Date.now()
    const check = () => {
      const exit = events.find((e) => e.runId === runId && e.kind === 'exit')
      if (exit) resolve(exit)
      else if (Date.now() - started > timeoutMs) reject(new Error('timeout'))
      else setTimeout(check, 20)
    }
    check()
  })
}

const output = (runId: string, kind: 'stdout' | 'stderr') =>
  events
    .filter((e) => e.runId === runId && e.kind === kind)
    .map((e) => e.data)
    .join('')

describe('shellCommand', () => {
  it('uses PowerShell on Windows and sh elsewhere', () => {
    const win = shellCommand('dir', 'win32')
    expect(win.file).toBe('powershell.exe')
    expect(win.args.slice(0, 2)).toEqual(['-NoLogo', '-NoProfile'])
    expect(win.args[win.args.length - 2]).toBe('-Command')
    expect(win.args[win.args.length - 1]).toMatch(/dir$/)
    expect(shellCommand('ls', 'linux')).toEqual({ file: '/bin/sh', args: ['-c', 'ls'] })
  })
})

describe('TerminalRunner', () => {
  it('collects stdout and exit code 0', async () => {
    const { runId } = await runner.run(dir, 'echo hallo')
    const exit = await waitForExit(runId)
    expect(exit.exitCode).toBe(0)
    // PowerShell ends lines with CRLF.
    expect(output(runId, 'stdout').replace(/\r\n/g, '\n')).toBe('hallo\n')
  })

  it('runs in the project folder', async () => {
    const { runId } = await runner.run(dir, 'pwd')
    await waitForExit(runId)
    expect(output(runId, 'stdout').trim()).toContain('aiw-term-')
  })

  it('reports non-zero exit codes and stderr', async () => {
    const command =
      process.platform === 'win32'
        ? "[Console]::Error.WriteLine('kaputt'); exit 3"
        : 'echo kaputt >&2; exit 3'
    const { runId } = await runner.run(dir, command)
    const exit = await waitForExit(runId)
    expect(exit.exitCode).toBe(3)
    expect(output(runId, 'stderr').replace(/\r\n/g, '\n')).toBe('kaputt\n')
  })

  it('kills a long-running process tree', async () => {
    const { runId } = await runner.run(dir, 'sleep 30; echo nie')
    expect(runner.activeCount).toBe(1)
    await new Promise((r) => setTimeout(r, 100))
    const started = Date.now()
    expect(runner.kill(runId)).toBe(true)
    const exit = await waitForExit(runId, 5000)
    expect(Date.now() - started).toBeLessThan(4000)
    expect(exit.exitCode).not.toBe(0)
    expect(output(runId, 'stdout')).toBe('')
    expect(runner.kill(runId)).toBe(false)
    expect(runner.activeCount).toBe(0)
  })

  it('rejects an invalid project folder', async () => {
    await expect(runner.run(join(dir, 'fehlt'), 'echo x')).rejects.toThrow(/nicht gefunden/)
  })
})
