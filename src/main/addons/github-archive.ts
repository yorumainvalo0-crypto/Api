import { mkdirSync, writeFileSync } from 'node:fs'
import { dirname, join, normalize, sep } from 'node:path'
import { unzipSync } from 'fflate'
import type { RepoCandidate } from '@shared/schemas/addons'
import { parsePluginManifest, parseSkillMarkdown } from './manifest'

export class AddonError extends Error {
  override name = 'AddonError'
}

/** Max size of a downloaded repository archive. */
const MAX_ARCHIVE_BYTES = 50 * 1024 * 1024

export interface RepoRef {
  owner: string
  repo: string
  /** Branch, tag or commit; undefined = default branch. */
  ref: string | undefined
  /** Sub folder to limit the search to. */
  subPath: string
}

/** Accepts "owner/repo", "https://github.com/owner/repo" and ".../tree/<ref>/<path>". */
export function parseRepoRef(input: string): RepoRef {
  const trimmed = input
    .trim()
    .replace(/\.git$/, '')
    .replace(/\/+$/, '')
  const short = /^([\w.-]+)\/([\w.-]+)$/.exec(trimmed)
  if (short?.[1] && short[2])
    return { owner: short[1], repo: short[2], ref: undefined, subPath: '' }
  let url: URL
  try {
    url = new URL(trimmed)
  } catch {
    throw new AddonError('Bitte „besitzer/repo“ oder eine GitHub-URL angeben.')
  }
  if (url.hostname !== 'github.com')
    throw new AddonError('Nur GitHub-Repositories werden unterstützt.')
  const [owner, repo, kind, ref, ...rest] = url.pathname.split('/').filter(Boolean)
  if (!owner || !repo) throw new AddonError('Ungültige GitHub-URL.')
  return {
    owner,
    repo,
    ref: kind === 'tree' || kind === 'blob' ? ref : undefined,
    subPath: kind === 'tree' || kind === 'blob' ? rest.join('/') : '',
  }
}

export function archiveUrl(ref: RepoRef): string {
  const target = ref.ref ? `refs/heads/${ref.ref}` : 'HEAD'
  return `https://codeload.github.com/${ref.owner}/${ref.repo}/zip/${target}`
}

/** In-memory repository snapshot: paths without the archive's top-level folder. */
export type RepoFiles = Map<string, Uint8Array>

export async function downloadRepo(
  ref: RepoRef,
  fetchImpl: typeof fetch = fetch,
): Promise<RepoFiles> {
  let response = await fetchImpl(archiveUrl(ref), { signal: AbortSignal.timeout(60_000) })
  // A tag or commit instead of a branch name.
  if (response.status === 404 && ref.ref) {
    response = await fetchImpl(
      `https://codeload.github.com/${ref.owner}/${ref.repo}/zip/${ref.ref}`,
      { signal: AbortSignal.timeout(60_000) },
    )
  }
  if (response.status === 404) throw new AddonError('Repository oder Branch nicht gefunden.')
  if (!response.ok) throw new AddonError(`Download fehlgeschlagen (HTTP ${response.status}).`)
  const buffer = new Uint8Array(await response.arrayBuffer())
  if (buffer.length > MAX_ARCHIVE_BYTES)
    throw new AddonError('Repository ist zu groß (max. 50 MB).')
  return extractArchive(buffer)
}

export function extractArchive(zip: Uint8Array): RepoFiles {
  let entries: Record<string, Uint8Array>
  try {
    entries = unzipSync(zip)
  } catch {
    throw new AddonError('Archiv konnte nicht entpackt werden.')
  }
  const files: RepoFiles = new Map()
  for (const [name, data] of Object.entries(entries)) {
    if (name.endsWith('/')) continue
    // GitHub archives wrap everything in "<repo>-<ref>/".
    const path = name.split('/').slice(1).join('/')
    if (path) files.set(path, data)
  }
  return files
}

const decoder = new TextDecoder()

/** Finds skills (folders with SKILL.md) and plugins (.claude-plugin/plugin.json). */
export function findCandidates(files: RepoFiles, subPath = ''): RepoCandidate[] {
  const prefix = subPath ? `${subPath.replace(/\/+$/, '')}/` : ''
  const candidates: RepoCandidate[] = []
  const pluginRoots = new Set<string>()

  for (const [path, data] of files) {
    if (!path.startsWith(prefix)) continue
    if (path.endsWith('.claude-plugin/plugin.json')) {
      const root = path.slice(0, -'.claude-plugin/plugin.json'.length).replace(/\/$/, '')
      const manifest = parsePluginManifest(decoder.decode(data))
      if (!manifest) continue
      pluginRoots.add(root)
      candidates.push({
        kind: 'plugin',
        name: manifest.name,
        description: manifest.description,
        relPath: root,
      })
    }
  }
  for (const [path, data] of files) {
    if (!path.startsWith(prefix) || !/(^|\/)SKILL\.md$/i.test(path)) continue
    const root = path.replace(/\/?SKILL\.md$/i, '')
    // Skills inside a plugin are installed together with the plugin.
    if ([...pluginRoots].some((p) => p === '' || root === p || root.startsWith(`${p}/`))) continue
    const meta = parseSkillMarkdown(decoder.decode(data), root.split('/').at(-1) || 'skill')
    candidates.push({
      kind: 'skill',
      name: meta.name,
      description: meta.description,
      relPath: root,
    })
  }
  return candidates.sort((a, b) => a.kind.localeCompare(b.kind) || a.name.localeCompare(b.name))
}

/** Writes all files below `relPath` into `target`, refusing paths that escape it. */
export function writeSubtree(files: RepoFiles, relPath: string, target: string): number {
  const prefix = relPath ? `${relPath}/` : ''
  let count = 0
  for (const [path, data] of files) {
    if (!path.startsWith(prefix)) continue
    const rel = normalize(path.slice(prefix.length))
    if (
      !rel ||
      rel.startsWith(`..${sep}`) ||
      rel === '..' ||
      rel.startsWith(sep) ||
      /^[a-z]:/i.test(rel)
    ) {
      throw new AddonError(`Unsicherer Pfad im Archiv: ${path}`)
    }
    const out = join(target, rel)
    mkdirSync(dirname(out), { recursive: true })
    writeFileSync(out, data)
    count++
  }
  return count
}
