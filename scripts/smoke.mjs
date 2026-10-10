// Launches the built app headlessly with --smoke-test and fails if it does not report OK.
// A local Anthropic-compatible mock is started so a full chat turn can be verified without API keys.
import { spawn } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import electronPath from 'electron'
import { startMockAnthropic } from './mock-anthropic.ts'

const MOCK_REPLY = 'Smoke-Antwort vom Mock'
const mock = await startMockAnthropic(MOCK_REPLY)
const userData = mkdtempSync(join(tmpdir(), 'aiw-smoke-'))
// `--packaged <executable>` runs the smoke test against a packaged build instead of the sources.
const packagedIndex = process.argv.indexOf('--packaged')
const packaged = packagedIndex > -1 ? process.argv[packagedIndex + 1] : undefined
const args = packaged ? ['--smoke-test'] : ['.', '--smoke-test']
// Chromium refuses to run as root without disabling its sandbox (CI containers only).
if (process.platform === 'linux' && process.getuid?.() === 0) args.push('--no-sandbox')

const binary = packaged ?? electronPath
let command = binary
let commandArgs = args
// Use a virtual display on Linux when none is available.
if (process.platform === 'linux' && !process.env.DISPLAY) {
  command = 'xvfb-run'
  commandArgs = ['-a', binary, ...args]
}

const child = spawn(command, commandArgs, {
  env: { ...process.env, AIW_USER_DATA: userData, AIW_SMOKE_MOCK_URL: mock.url },
  stdio: ['ignore', 'pipe', 'pipe'],
})

let output = ''
child.stdout.on('data', (d) => (output += d))
child.stderr.on('data', (d) => (output += d))

child.on('exit', async (code) => {
  await mock.close()
  rmSync(userData, { recursive: true, force: true })
  console.log(
    output
      .split('\n')
      .filter((l) => l.startsWith('[smoke]'))
      .join('\n'),
  )
  const chatOk = output.includes(`"chatText":"${MOCK_REPLY}"`)
  if (code === 0 && output.includes('[smoke] OK') && chatOk) {
    console.log('Smoke test passed.')
    process.exit(0)
  }
  console.error(output)
  console.error(`Smoke test failed (exit code ${code}, chat ok: ${chatOk}).`)
  process.exit(1)
})
