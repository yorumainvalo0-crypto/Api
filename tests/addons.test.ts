import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { zipSync, strToU8 } from 'fflate'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { AddonStore } from '../src/main/addons/addon-store'
import {
  AddonError,
  archiveUrl,
  downloadRepo,
  extractArchive,
  findCandidates,
  parseRepoRef,
  writeSubtree,
} from '../src/main/addons/github-archive'
import { parseSkillMarkdown, toAddonName } from '../src/main/addons/manifest'
import { registryToEntry, searchRegistry, toRegistryServer } from '../src/main/addons/registry'
import type { Cipher } from '../src/main/storage/secret-store'

const cipher: Cipher = {
  isAvailable: () => true,
  encrypt: (s) => Buffer.from(s.split('').reverse().join('')),
  decrypt: (b) => b.toString().split('').reverse().join(''),
}

/** Builds a GitHub-style archive (everything inside "<repo>-main/"). */
function repoZip(files: Record<string, string>): Uint8Array {
  return zipSync(
    Object.fromEntries(Object.entries(files).map(([p, c]) => [`skills-main/${p}`, strToU8(c)])),
  )
}

const SKILL = (name: string, description: string) =>
  `---\nname: ${name}\ndescription: ${description}\n---\n# ${name}\n\nAnleitung …\n`

let dir: string
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'aiw-addons-'))
})
afterEach(() => rmSync(dir, { recursive: true, force: true }))

function store() {
  return new AddonStore(
    {
      skillsDir: join(dir, 'agent-config', 'skills'),
      pluginsDir: join(dir, 'addons', 'plugins'),
      stateFile: join(dir, 'addons', 'addons.json'),
    },
    cipher,
  )
}

describe('manifests', () => {
  it('reads skill frontmatter incl. multi-line descriptions', () => {
    expect(parseSkillMarkdown(SKILL('pdf', 'PDFs bearbeiten'), 'x')).toEqual({
      name: 'pdf',
      description: 'PDFs bearbeiten',
    })
    expect(
      parseSkillMarkdown('---\nname: a\ndescription: >\n  Zeile eins\n  Zeile zwei\n---\n', 'x')
        .description,
    ).toBe('Zeile eins Zeile zwei')
    expect(parseSkillMarkdown('# Nur Titel\nText', 'ordner')).toEqual({
      name: 'ordner',
      description: 'Nur Titel',
    })
    expect(toAddonName('Mein Größter Skill!')).toBe('mein-groesster-skill')
  })
})

describe('GitHub archives', () => {
  it('parses repository references', () => {
    expect(parseRepoRef('anthropics/skills')).toEqual({
      owner: 'anthropics',
      repo: 'skills',
      ref: undefined,
      subPath: '',
    })
    expect(parseRepoRef('https://github.com/a/b/tree/dev/skills/pdf')).toEqual({
      owner: 'a',
      repo: 'b',
      ref: 'dev',
      subPath: 'skills/pdf',
    })
    expect(archiveUrl(parseRepoRef('a/b'))).toBe('https://codeload.github.com/a/b/zip/HEAD')
    expect(() => parseRepoRef('https://gitlab.com/a/b')).toThrow(AddonError)
  })

  it('finds skills and plugins, keeping plugin skills inside their plugin', () => {
    const files = extractArchive(
      repoZip({
        'README.md': '# Repo',
        'skills/pdf/SKILL.md': SKILL('pdf', 'PDFs'),
        'skills/pdf/scripts/tool.py': 'print(1)',
        'skills/xlsx/SKILL.md': SKILL('xlsx', 'Tabellen'),
        'plugins/demo/.claude-plugin/plugin.json':
          '{"name":"demo","description":"Demo","version":"1.0.0"}',
        'plugins/demo/skills/inner/SKILL.md': SKILL('inner', 'Teil des Plugins'),
      }),
    )
    expect(findCandidates(files).map((c) => `${c.kind}:${c.name}:${c.relPath}`)).toEqual([
      'plugin:demo:plugins/demo',
      'skill:pdf:skills/pdf',
      'skill:xlsx:skills/xlsx',
    ])
    expect(findCandidates(files, 'skills/xlsx').map((c) => c.name)).toEqual(['xlsx'])
  })

  it('refuses archive paths that escape the target folder', () => {
    const files = new Map([['skills/evil/../../../outside.txt', strToU8('x')]])
    expect(() => writeSubtree(files, 'skills/evil', join(dir, 't'))).toThrow(/Unsicherer Pfad/)
    expect(existsSync(join(dir, 'outside.txt'))).toBe(false)
  })

  it('downloads through codeload and reports missing repositories', async () => {
    const zip = repoZip({ 'SKILL.md': SKILL('solo', 'Einzel-Skill') })
    const ok = (async () => new Response(zip)) as unknown as typeof fetch
    const files = await downloadRepo(parseRepoRef('a/solo'), ok)
    expect(findCandidates(files)).toMatchObject([{ kind: 'skill', name: 'solo', relPath: '' }])
    const missing = (async () => new Response('', { status: 404 })) as unknown as typeof fetch
    await expect(downloadRepo(parseRepoRef('a/nope'), missing)).rejects.toThrow(/nicht gefunden/)
  })
})

describe('AddonStore', () => {
  it('installs skills from a repo, toggles and removes them', () => {
    const s = store()
    const files = extractArchive(
      repoZip({ 'skills/pdf/SKILL.md': SKILL('pdf', 'PDFs'), 'skills/pdf/a.txt': 'x' }),
    )
    const [candidate] = findCandidates(files)
    if (!candidate) throw new Error('no candidate')
    expect(s.installFromRepo(files, candidate)).toBe('pdf')
    expect(readFileSync(join(dir, 'agent-config', 'skills', 'pdf', 'a.txt'), 'utf8')).toBe('x')
    expect(s.listSkills()).toMatchObject([{ name: 'pdf', description: 'PDFs', enabled: true }])
    expect(s.agentConfig().skills).toEqual(['pdf'])

    s.setSkillEnabled('pdf', false)
    expect(s.agentConfig().skills).toEqual([])
    s.removeSkill('pdf')
    expect(s.listSkills()).toEqual([])
  })

  it('imports local plugin folders and passes enabled plugins to the agent', () => {
    const src = join(dir, 'src-plugin')
    mkdirSync(join(src, '.claude-plugin'), { recursive: true })
    mkdirSync(join(src, 'node_modules', 'x'), { recursive: true })
    writeFileSync(
      join(src, '.claude-plugin', 'plugin.json'),
      '{"name":"Mein Plugin","version":"2.0.0"}',
    )
    writeFileSync(join(src, 'node_modules', 'x', 'big.js'), 'x')
    const s = store()
    expect(s.installFromFolder(src)).toEqual({ kind: 'plugin', name: 'mein-plugin' })
    expect(existsSync(join(dir, 'addons', 'plugins', 'mein-plugin', 'node_modules'))).toBe(false)
    expect(s.agentConfig().plugins).toEqual([
      { type: 'local', path: join(dir, 'addons', 'plugins', 'mein-plugin') },
    ])
    expect(() => s.installFromFolder(join(dir, 'leer'))).toThrow()
  })

  it('encrypts MCP secrets, never exposes them and keeps them on edit', () => {
    const s = store()
    s.saveMcpServer({
      name: 'github',
      enabled: true,
      description: '',
      source: 'manual',
      transport: {
        type: 'stdio',
        command: 'npx',
        args: ['-y', 'gh-mcp'],
        env: { TOKEN: 'geheim' },
      },
    })
    const raw = readFileSync(join(dir, 'addons', 'addons.json'), 'utf8')
    expect(raw).not.toContain('geheim')
    const [view] = s.listMcpServers()
    expect(view?.secretKeys).toEqual(['TOKEN'])
    expect(view?.transport).toMatchObject({ env: { TOKEN: '' } })

    // Editing with an empty value keeps the stored secret.
    s.saveMcpServer({
      name: 'github',
      enabled: true,
      description: 'neu',
      source: 'manual',
      transport: { type: 'stdio', command: 'npx', args: ['-y', 'gh-mcp@2'], env: { TOKEN: '' } },
    })
    expect(s.agentConfig().mcpServers['github']).toEqual({
      type: 'stdio',
      command: 'npx',
      args: ['-y', 'gh-mcp@2'],
      env: { TOKEN: 'geheim' },
    })
    s.setMcpServerEnabled('github', false)
    expect(s.agentConfig().mcpServers).toEqual({})
    s.removeMcpServer('github')
    expect(s.listMcpServers()).toEqual([])
  })
})

describe('MCP registry', () => {
  const fixture = readFileSync(join(import.meta.dirname, 'fixtures', 'mcp-registry.json'), 'utf8')

  it('maps real registry entries to installable servers', async () => {
    const fetchImpl = (async () => new Response(fixture)) as unknown as typeof fetch
    const servers = await searchRegistry('filesystem', fetchImpl)
    expect(servers.length).toBeGreaterThan(0)
    expect(new Set(servers.map((s) => s.name)).size).toBe(servers.length)
    expect(
      servers.every((s) => ['npm', 'pypi', 'remote', 'unsupported'].includes(s.install.kind)),
    ).toBe(true)
  })

  it('builds stdio entries (with Windows shim) and validates required env vars', () => {
    const server = toRegistryServer({
      server: {
        name: 'io.github.foo/files',
        description: 'Dateien',
        version: '1.2.0',
        packages: [
          {
            registryType: 'npm',
            identifier: '@foo/files-mcp',
            version: '1.2.0',
            transport: { type: 'stdio' },
            environmentVariables: [
              { name: 'ROOT', isRequired: true },
              { name: 'MODE', default: 'read' },
            ],
          },
        ],
      },
    })
    if (!server) throw new Error('not parsed')
    expect(() => registryToEntry(server, {}, 'linux')).toThrow(/ROOT/)
    expect(registryToEntry(server, { ROOT: '/data' }, 'linux').transport).toEqual({
      type: 'stdio',
      command: 'npx',
      args: ['-y', '@foo/files-mcp@1.2.0'],
      env: { ROOT: '/data', MODE: 'read' },
    })
    expect(registryToEntry(server, { ROOT: 'C:\\daten' }, 'win32').transport).toMatchObject({
      command: 'cmd',
      args: ['/c', 'npx', '-y', '@foo/files-mcp@1.2.0'],
    })
    const remote = toRegistryServer({
      server: {
        name: 'x/remote',
        remotes: [{ type: 'streamable-http', url: 'https://mcp.example/mcp' }],
      },
    })
    expect(remote && registryToEntry(remote, {}).transport).toEqual({
      type: 'http',
      url: 'https://mcp.example/mcp',
      headers: {},
    })
  })
})
