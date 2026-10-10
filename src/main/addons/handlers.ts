import { randomUUID } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import type { BrowserWindow } from 'electron'
import { dialog } from 'electron'
import type { z } from 'zod'
import type { addonsContract } from '@shared/ipc-addons'
import type { AddonStore } from './addon-store'
import {
  AddonError,
  downloadRepo,
  findCandidates,
  parseRepoRef,
  type RepoFiles,
} from './github-archive'
import { registryToEntry, searchRegistry } from './registry'
import { toAddonName } from './manifest'

type Handlers = {
  [C in keyof typeof addonsContract]: (
    input: z.infer<(typeof addonsContract)[C]['input']>,
  ) =>
    | z.infer<(typeof addonsContract)[C]['output']>
    | Promise<z.infer<(typeof addonsContract)[C]['output']>>
}

export interface AddonHandlerDeps {
  store: AddonStore
  getWindow: () => BrowserWindow | undefined
  fetchImpl?: typeof fetch
}

/** IPC handlers for the add-on manager; spread into registerIpcHandlers. */
export function createAddonHandlers(deps: AddonHandlerDeps): Handlers {
  const { store } = deps
  // Downloaded repositories waiting for the user to pick what to install (short-lived).
  const scans = new Map<
    string,
    { files: RepoFiles; candidates: ReturnType<typeof findCandidates> }
  >()

  return {
    'addons:overview': () => store.overview(),
    'addons:repo-scan': async ({ repo }) => {
      const ref = parseRepoRef(repo)
      const files = await downloadRepo(ref, deps.fetchImpl)
      const candidates = findCandidates(files, ref.subPath)
      if (candidates.length === 0) {
        throw new AddonError('In diesem Repository wurden keine Skills oder Plugins gefunden.')
      }
      const token = randomUUID()
      scans.clear()
      scans.set(token, { files, candidates })
      return { token, label: `${ref.owner}/${ref.repo}`, candidates }
    },
    'addons:repo-install': ({ token, relPaths }) => {
      const scan = scans.get(token)
      if (!scan) throw new AddonError('Download abgelaufen – bitte erneut suchen.')
      const installed: string[] = []
      const errors: string[] = []
      for (const relPath of relPaths) {
        const candidate = scan.candidates.find((c) => c.relPath === relPath)
        if (!candidate) continue
        try {
          installed.push(store.installFromRepo(scan.files, candidate))
        } catch (error) {
          errors.push(
            `${candidate.name}: ${error instanceof Error ? error.message : String(error)}`,
          )
        }
      }
      return { installed, errors }
    },
    'addons:install-folder': async () => {
      const win = deps.getWindow()
      if (!win) return { installed: null }
      const result = await dialog.showOpenDialog(win, {
        title: 'Skill- oder Plugin-Ordner wählen',
        properties: ['openDirectory'],
      })
      const folder = result.filePaths[0]
      if (result.canceled || !folder) return { installed: null }
      return { installed: store.installFromFolder(folder).name }
    },
    'addons:skill-read': ({ name }) => {
      const skill = store.listSkills().find((s) => s.path.endsWith(toAddonName(name)))
      if (!skill) throw new AddonError('Skill nicht gefunden.')
      return { content: readFileSync(join(skill.path, 'SKILL.md'), 'utf8') }
    },
    'addons:skill-toggle': ({ name, enabled }) => {
      store.setSkillEnabled(name, enabled)
      return { ok: true }
    },
    'addons:skill-remove': ({ name }) => {
      store.removeSkill(name)
      return { ok: true }
    },
    'addons:plugin-toggle': ({ name, enabled }) => {
      store.setPluginEnabled(name, enabled)
      return { ok: true }
    },
    'addons:plugin-remove': ({ name }) => {
      store.removePlugin(name)
      return { ok: true }
    },
    'addons:registry-search': ({ query }) => searchRegistry(query, deps.fetchImpl),
    'addons:registry-install': ({ server, env }) => {
      const entry = registryToEntry(server, env)
      store.saveMcpServer(entry)
      return { name: entry.name }
    },
    'addons:mcp-save': (entry) => {
      store.saveMcpServer(entry)
      return { ok: true }
    },
    'addons:mcp-toggle': ({ name, enabled }) => {
      store.setMcpServerEnabled(name, enabled)
      return { ok: true }
    },
    'addons:mcp-remove': ({ name }) => {
      store.removeMcpServer(name)
      return { ok: true }
    },
  }
}
