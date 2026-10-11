import { describe, expect, it } from 'vitest'
import {
  buildSandboxSettings,
  detectSandbox,
  effectivePermissionMode,
  toolchainDirs,
  type SandboxProbe,
} from '../src/main/agent/sandbox'
import { buildTerminalClaudeSettings } from '../src/main/terminal/claude-settings'
import { PathGuardServer } from '../src/main/terminal/guard-server'
import { GUARDED_TOOLS } from '../src/main/agent/path-guard'

const probe = (patch: Partial<SandboxProbe> = {}): SandboxProbe => ({
  which: (name) => `/usr/bin/${name}`,
  bwrapWorks: () => true,
  exists: () => true,
  ...patch,
})

describe('detectSandbox', () => {
  it('is active on Linux only with working bubblewrap and socat', () => {
    expect(detectSandbox('linux', {}, probe())).toMatchObject({ active: true })
    const noSocat = detectSandbox(
      'linux',
      {},
      probe({ which: (n) => (n === 'bwrap' ? '/b' : undefined) }),
    )
    expect(noSocat.active).toBe(false)
    expect(noSocat.summary).toMatch(/socat fehlt/)
    expect(noSocat.summary).toMatch(/NICHT auf den Arbeitsordner beschränkt/)
    const broken = detectSandbox('linux', {}, probe({ bwrapWorks: () => false }))
    expect(broken).toMatchObject({ active: false })
  })

  it('is active on macOS with sandbox-exec', () => {
    expect(detectSandbox('darwin', {}, probe()).active).toBe(true)
    expect(detectSandbox('darwin', {}, probe({ exists: () => false })).active).toBe(false)
  })

  it('never claims a sandbox on Windows', () => {
    const status = detectSandbox('win32', {}, probe())
    expect(status.active).toBe(false)
    expect(status.summary).toMatch(/Windows/)
    expect(status.summary).toMatch(/NICHT auf den Arbeitsordner beschränkt/)
    // File tools stay confined, and the text says so.
    expect(status.summary).toMatch(/Bearbeiten von Dateien bleibt auf den Ordner beschränkt/)
  })
})

describe('buildSandboxSettings', () => {
  it('confines writes to the work folder and hides the home folder', () => {
    const settings = buildSandboxSettings({
      workFolder: '/home/max/projekt',
      readRoots: ['/home/max/.config/aiw/chats/1/attachments'],
      pathDirs: [
        '/usr/bin',
        '/home/max/.nvm/versions/node/v22.18.0/bin',
        '/home/max/.local/bin',
        '/home/max/.config/aiw/terminal/bin',
        '/home/max/bin',
        'relative/bin',
      ],
      hidden: ['/home/max/.config/aiw'],
      home: '/home/max',
      platform: 'linux',
    })
    expect(settings).toMatchObject({
      enabled: true,
      failIfUnavailable: true,
      autoAllowBashIfSandboxed: false,
      allowUnsandboxedCommands: false,
    })
    expect(settings.filesystem?.allowWrite).toEqual(['/home/max/projekt'])
    expect(settings.filesystem?.denyWrite).toEqual([
      '/home/max/projekt/.git/hooks',
      '/home/max/projekt/.git/config',
    ])
    expect(settings.filesystem?.denyRead).toEqual(['/home/max', '/mnt', '/media'])
    expect(settings.filesystem?.allowRead).toEqual([
      '/home/max/projekt',
      '/home/max/.config/aiw/chats/1/attachments',
      '/home/max/.nvm/versions/node/v22.18.0',
      '/home/max/.local',
      '/home/max/bin',
      '/home/max/.gitconfig',
      '/home/max/.config/git',
    ])
    expect(settings.credentials?.envVars?.map((v) => `${v.name}:${v.mode}`)).toEqual([
      'ANTHROPIC_API_KEY:deny',
      'ANTHROPIC_AUTH_TOKEN:deny',
    ])
  })

  it('finds tool folders inside the Windows profile', () => {
    expect(
      toolchainDirs(
        [
          'C:\\Windows\\System32',
          'C:\\Users\\Max\\AppData\\Local\\Programs\\Python\\Python313\\Scripts',
          'c:\\users\\max\\.cargo\\bin',
          'C:\\Users\\Max',
        ],
        'C:\\Users\\Max',
        [],
        'win32',
      ),
    ).toEqual([
      'C:\\Users\\Max\\AppData\\Local\\Programs\\Python\\Python313',
      'c:\\users\\max\\.cargo',
    ])
  })
})

describe('effectivePermissionMode', () => {
  it('keeps auto mode where a Claude classifier is reachable', () => {
    expect(effectivePermissionMode('auto', 'anthropic')).toEqual({ mode: 'auto', note: null })
    expect(effectivePermissionMode('auto', 'openrouter')).toEqual({ mode: 'auto', note: null })
  })

  it('falls back to accepting edits with Ollama and says why', () => {
    const result = effectivePermissionMode('auto', 'ollama')
    expect(result.mode).toBe('acceptEdits')
    expect(result.note).toMatch(/Ollama/)
    expect(effectivePermissionMode('bypassPermissions', 'ollama').mode).toBe('bypassPermissions')
  })
})

describe('terminal settings for claude', () => {
  it('adds a blocking HTTP hook for every file tool and the sandbox', () => {
    const sandbox = buildSandboxSettings({ workFolder: '/w', home: '/h', platform: 'linux' })
    const settings = buildTerminalClaudeSettings({
      guardUrl: 'http://127.0.0.1:1234/guard/s1',
      guardToken: 'tok',
      sandbox,
    })
    expect(settings).toEqual({
      disableAllHooks: false,
      hooks: {
        PreToolUse: [
          {
            matcher: GUARDED_TOOLS.join('|'),
            hooks: [
              {
                type: 'http',
                url: 'http://127.0.0.1:1234/guard/s1',
                headers: { Authorization: 'Bearer tok' },
                timeout: 30,
                onFailure: 'block',
              },
            ],
          },
        ],
      },
      sandbox: {
        ...sandbox,
        // HTTP hooks go through the sandbox proxy, which must let them reach the guard.
        network: { allowedDomains: ['127.0.0.1:1234'] },
      },
    })
    expect(GUARDED_TOOLS).toEqual(expect.arrayContaining(['Read', 'Write', 'Edit', 'NotebookEdit']))
    expect(buildTerminalClaudeSettings({ guardUrl: 'u', guardToken: 't' })).not.toHaveProperty(
      'sandbox',
    )
  })

  it('answers hook requests over HTTP only with the token', async () => {
    const server = new PathGuardServer()
    const { url, token } = await server.start()
    server.register('s1', { readWrite: ['/w'], readOnly: [] })
    const post = (session: string, body: unknown, auth = `Bearer ${token}`) =>
      fetch(`${url}/${session}`, {
        method: 'POST',
        headers: { authorization: auth, 'content-type': 'application/json' },
        body: JSON.stringify(body),
      })
    const hook = (file_path: string) => ({
      hook_event_name: 'PreToolUse',
      tool_name: 'Read',
      tool_input: { file_path },
      cwd: '/w',
    })
    try {
      expect(await (await post('s1', hook('/w/a.txt'))).json()).toEqual({})
      expect(await (await post('s1', hook('/etc/passwd'))).json()).toMatchObject({
        hookSpecificOutput: { permissionDecision: 'deny' },
      })
      expect((await post('s1', hook('/w/a.txt'), 'Bearer falsch')).status).toBe(401)
      // Unknown or ended sessions are refused (fail closed).
      expect(await (await post('s2', hook('/w/a.txt'))).json()).toMatchObject({
        hookSpecificOutput: { permissionDecision: 'deny' },
      })
      server.unregister('s1')
      expect(await (await post('s1', hook('/w/a.txt'))).json()).toMatchObject({
        hookSpecificOutput: { permissionDecision: 'deny' },
      })
    } finally {
      await server.close()
    }
  })
})
