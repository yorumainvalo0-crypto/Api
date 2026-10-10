import {
  cpSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs'
import { dirname, join } from 'node:path'
import { z } from 'zod'
import {
  McpServerEntrySchema,
  type AddonsOverview,
  type McpServerEntry,
  type McpServerView,
  type PluginInfo,
  type RepoCandidate,
  type SkillInfo,
} from '@shared/schemas/addons'
import type { Cipher } from '../storage/secret-store'
import { AddonError, writeSubtree, type RepoFiles } from './github-archive'
import { parsePluginManifest, parseSkillMarkdown, toAddonName } from './manifest'

const StateSchema = z.object({
  mcpServers: z.array(McpServerEntrySchema).default([]),
  disabledSkills: z.array(z.string()).default([]),
  disabledPlugins: z.array(z.string()).default([]),
})
type State = z.infer<typeof StateSchema>

const ENCRYPTED_PREFIX = 'enc:'

export interface AddonPaths {
  /** Where the agent runtime discovers user skills (CLAUDE_CONFIG_DIR/skills). */
  skillsDir: string
  pluginsDir: string
  stateFile: string
}

/** Agent configuration the SDK needs for the enabled add-ons. */
export interface AgentAddonConfig {
  mcpServers: Record<
    string,
    | { type: 'stdio'; command: string; args: string[]; env: Record<string, string> }
    | { type: 'http'; url: string; headers: Record<string, string> }
  >
  plugins: { type: 'local'; path: string }[]
  /** Skill names to expose; empty when no skills are installed. */
  skills: string[]
}

/** Manages installed skills, plugins and MCP servers. Secret values are encrypted at rest. */
export class AddonStore {
  constructor(
    private readonly paths: AddonPaths,
    private readonly cipher: Cipher,
  ) {}

  overview(): AddonsOverview {
    return {
      skills: this.listSkills(),
      plugins: this.listPlugins(),
      mcpServers: this.listMcpServers(),
    }
  }

  // --- Skills ---

  listSkills(): SkillInfo[] {
    const state = this.read()
    return this.subdirs(this.paths.skillsDir).flatMap((dir) => {
      const file = join(dir, 'SKILL.md')
      if (!existsSync(file)) return []
      const folder = dir.split(/[\\/]/).at(-1) ?? ''
      const meta = parseSkillMarkdown(readFileSync(file, 'utf8'), folder)
      return [{ ...meta, path: dir, enabled: !state.disabledSkills.includes(folder) }]
    })
  }

  /** Installs a skill or plugin folder from a downloaded repository. */
  installFromRepo(files: RepoFiles, candidate: RepoCandidate): string {
    const name = toAddonName(candidate.name)
    const root = candidate.kind === 'skill' ? this.paths.skillsDir : this.paths.pluginsDir
    const target = join(root, name)
    // Install into a temp folder first so a failed install never leaves half a skill behind.
    const tmp = `${target}.installing`
    rmSync(tmp, { recursive: true, force: true })
    mkdirSync(tmp, { recursive: true })
    try {
      const count = writeSubtree(files, candidate.relPath, tmp)
      if (count === 0) throw new AddonError('Keine Dateien zum Installieren gefunden.')
      const marker = candidate.kind === 'skill' ? 'SKILL.md' : join('.claude-plugin', 'plugin.json')
      if (!existsSync(join(tmp, marker))) throw new AddonError(`${marker} fehlt im Add-on.`)
      rmSync(target, { recursive: true, force: true })
      renameSync(tmp, target)
    } catch (error) {
      rmSync(tmp, { recursive: true, force: true })
      throw error
    }
    return name
  }

  /** Copies a local skill or plugin folder (detected by its manifest). */
  installFromFolder(folder: string): { kind: 'skill' | 'plugin'; name: string } {
    const isPlugin = existsSync(join(folder, '.claude-plugin', 'plugin.json'))
    const isSkill = existsSync(join(folder, 'SKILL.md'))
    if (!isPlugin && !isSkill) {
      throw new AddonError('Der Ordner enthält weder SKILL.md noch .claude-plugin/plugin.json.')
    }
    const displayName = isPlugin
      ? (parsePluginManifest(readFileSync(join(folder, '.claude-plugin', 'plugin.json'), 'utf8'))
          ?.name ?? '')
      : parseSkillMarkdown(
          readFileSync(join(folder, 'SKILL.md'), 'utf8'),
          folder.split(/[\\/]/).at(-1) ?? '',
        ).name
    const name = toAddonName(displayName || (folder.split(/[\\/]/).at(-1) ?? 'addon'))
    const target = join(isPlugin ? this.paths.pluginsDir : this.paths.skillsDir, name)
    rmSync(target, { recursive: true, force: true })
    mkdirSync(dirname(target), { recursive: true })
    cpSync(folder, target, {
      recursive: true,
      filter: (src) => !/[\\/](\.git|node_modules)([\\/]|$)/.test(src),
    })
    return { kind: isPlugin ? 'plugin' : 'skill', name }
  }

  removeSkill(name: string): void {
    rmSync(join(this.paths.skillsDir, toAddonName(name)), { recursive: true, force: true })
  }

  setSkillEnabled(name: string, enabled: boolean): void {
    this.update((s) => ({ ...s, disabledSkills: toggle(s.disabledSkills, name, !enabled) }))
  }

  // --- Plugins ---

  listPlugins(): PluginInfo[] {
    const state = this.read()
    return this.subdirs(this.paths.pluginsDir).flatMap((dir) => {
      const file = join(dir, '.claude-plugin', 'plugin.json')
      if (!existsSync(file)) return []
      const folder = dir.split(/[\\/]/).at(-1) ?? ''
      const manifest = parsePluginManifest(readFileSync(file, 'utf8'))
      if (!manifest) return []
      return [
        { ...manifest, name: folder, path: dir, enabled: !state.disabledPlugins.includes(folder) },
      ]
    })
  }

  removePlugin(name: string): void {
    rmSync(join(this.paths.pluginsDir, toAddonName(name)), { recursive: true, force: true })
  }

  setPluginEnabled(name: string, enabled: boolean): void {
    this.update((s) => ({ ...s, disabledPlugins: toggle(s.disabledPlugins, name, !enabled) }))
  }

  // --- MCP servers ---

  listMcpServers(): McpServerView[] {
    return this.read().mcpServers.map((server) => {
      const secrets =
        server.transport.type === 'stdio' ? server.transport.env : server.transport.headers
      const masked = Object.fromEntries(Object.keys(secrets).map((k) => [k, '']))
      return {
        ...server,
        transport:
          server.transport.type === 'stdio'
            ? { ...server.transport, env: masked }
            : { ...server.transport, headers: masked },
        secretKeys: Object.entries(secrets)
          .filter(([, v]) => v !== '')
          .map(([k]) => k),
      }
    })
  }

  /**
   * Adds or replaces a server. Empty secret values keep the previously stored value, so the UI
   * never needs to see secrets to edit a server.
   */
  saveMcpServer(entry: McpServerEntry): void {
    const parsed = McpServerEntrySchema.parse(entry)
    this.update((state) => {
      const previous = state.mcpServers.find((s) => s.name === parsed.name)
      const prevSecrets =
        previous?.transport.type === 'stdio'
          ? previous.transport.env
          : previous?.transport.type === 'http'
            ? previous.transport.headers
            : {}
      const encryptAll = (values: Record<string, string>) =>
        Object.fromEntries(
          Object.entries(values).map(([k, v]) => [
            k,
            v === '' ? (prevSecrets[k] ?? '') : this.encrypt(v),
          ]),
        )
      const transport =
        parsed.transport.type === 'stdio'
          ? { ...parsed.transport, env: encryptAll(parsed.transport.env) }
          : { ...parsed.transport, headers: encryptAll(parsed.transport.headers) }
      const next = { ...parsed, transport }
      return {
        ...state,
        mcpServers: previous
          ? state.mcpServers.map((s) => (s.name === parsed.name ? next : s))
          : [...state.mcpServers, next],
      }
    })
  }

  setMcpServerEnabled(name: string, enabled: boolean): void {
    this.update((s) => ({
      ...s,
      mcpServers: s.mcpServers.map((m) => (m.name === name ? { ...m, enabled } : m)),
    }))
  }

  removeMcpServer(name: string): void {
    this.update((s) => ({ ...s, mcpServers: s.mcpServers.filter((m) => m.name !== name) }))
  }

  /** Everything the agent needs for the enabled add-ons, with secrets decrypted. */
  agentConfig(): AgentAddonConfig {
    const state = this.read()
    const mcpServers: AgentAddonConfig['mcpServers'] = {}
    for (const server of state.mcpServers) {
      if (!server.enabled) continue
      const t = server.transport
      mcpServers[server.name] =
        t.type === 'stdio'
          ? { type: 'stdio', command: t.command, args: t.args, env: this.decryptAll(t.env) }
          : { type: 'http', url: t.url, headers: this.decryptAll(t.headers) }
    }
    return {
      mcpServers,
      plugins: this.listPlugins()
        .filter((p) => p.enabled)
        .map((p) => ({ type: 'local' as const, path: p.path })),
      skills: this.listSkills()
        .filter((s) => s.enabled)
        .map((s) => s.path.split(/[\\/]/).at(-1) ?? s.name),
    }
  }

  // --- internals ---

  private encrypt(value: string): string {
    if (!this.cipher.isAvailable()) {
      throw new AddonError(
        'Sichere Verschlüsselung ist nicht verfügbar – Zugangsdaten können nicht gespeichert werden.',
      )
    }
    return ENCRYPTED_PREFIX + this.cipher.encrypt(value).toString('base64')
  }

  private decryptAll(values: Record<string, string>): Record<string, string> {
    return Object.fromEntries(
      Object.entries(values).map(([k, v]) => {
        if (!v.startsWith(ENCRYPTED_PREFIX)) return [k, v]
        try {
          return [k, this.cipher.decrypt(Buffer.from(v.slice(ENCRYPTED_PREFIX.length), 'base64'))]
        } catch {
          return [k, '']
        }
      }),
    )
  }

  private subdirs(root: string): string[] {
    try {
      return readdirSync(root)
        .filter((name) => !name.startsWith('.') && !name.endsWith('.installing'))
        .map((name) => join(root, name))
        .filter((path) => statSync(path).isDirectory())
        .sort()
    } catch {
      return []
    }
  }

  private read(): State {
    try {
      return StateSchema.catch(StateSchema.parse({})).parse(
        JSON.parse(readFileSync(this.paths.stateFile, 'utf8')),
      )
    } catch {
      return StateSchema.parse({})
    }
  }

  private update(change: (state: State) => State): void {
    const next = StateSchema.parse(change(this.read()))
    mkdirSync(dirname(this.paths.stateFile), { recursive: true })
    const tmp = `${this.paths.stateFile}.tmp`
    writeFileSync(tmp, JSON.stringify(next, null, 2), { encoding: 'utf8', mode: 0o600 })
    renameSync(tmp, this.paths.stateFile)
  }
}

function toggle(list: string[], name: string, include: boolean): string[] {
  const without = list.filter((n) => n !== name)
  return include ? [...without, name] : without
}
