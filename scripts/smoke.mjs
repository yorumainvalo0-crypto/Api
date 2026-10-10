// Launches the built app headlessly with --smoke-test and fails if it does not report OK.
// A local Anthropic-compatible mock is started so a full chat turn can be verified without API keys.
import { spawn } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import electronPath from 'electron'
import { startMockAnthropic } from './mock-anthropic.ts'

const MOCK_REPLY = 'Smoke-Antwort vom Mock'
const userData = mkdtempSync(join(tmpdir(), 'aiw-smoke-'))
// Project folder for the coding-agent part of the smoke test.
const project = join(userData, 'projekt')
mkdirSync(project)
const PROJECT_FILE = join(project, 'smoke.txt')

const mock = await startMockAnthropic((body) => {
  const userBlocks = (body?.messages ?? [])
    .filter((m) => m.role === 'user' && Array.isArray(m.content))
    .flatMap((m) => m.content)
  const text = userBlocks.map((b) => b.text ?? '').join(' ')
  // Coding turn: write a file through the agent's Write tool, then finish.
  if (text.includes('SMOKE-CODE')) {
    return userBlocks.some((b) => b.type === 'tool_result')
      ? { text: 'Datei angelegt.' }
      : {
          text: 'Ich schreibe die Datei.',
          toolUse: { name: 'Write', input: { file_path: PROJECT_FILE, content: 'vom Agenten' } },
        }
  }
  // Chat turn: echo how many images reached the API to verify the attachment pipeline.
  return `${MOCK_REPLY} (Bilder: ${userBlocks.filter((b) => b.type === 'image').length})`
})
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
  env: {
    ...process.env,
    AIW_USER_DATA: userData,
    AIW_SMOKE_MOCK_URL: mock.url,
    AIW_SMOKE_PROJECT: project,
  },
  stdio: ['ignore', 'pipe', 'pipe'],
})

let output = ''
child.stdout.on('data', (d) => (output += d))
child.stderr.on('data', (d) => (output += d))

child.on('exit', async (code) => {
  await mock.close()
  const codeOk = existsSync(PROJECT_FILE) && readFileSync(PROJECT_FILE, 'utf8') === 'vom Agenten'
  rmSync(userData, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 })
  console.log(
    output
      .split('\n')
      .filter((l) => l.startsWith('[smoke]'))
      .join('\n'),
  )
  const chatOk = output.includes(`"chatText":"${MOCK_REPLY} (Bilder: 1)"`)
  if (code === 0 && output.includes('[smoke] OK') && chatOk && codeOk) {
    console.log('Smoke test passed.')
    process.exit(0)
  }
  console.error(output)
  console.error(`Smoke test failed (exit code ${code}, chat ok: ${chatOk}, code ok: ${codeOk}).`)
  process.exit(1)
})
