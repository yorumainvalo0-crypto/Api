import { z } from 'zod'
import type { McpServerEntry, RegistryServer } from '@shared/schemas/addons'
import { AddonError } from './github-archive'
import { toAddonName } from './manifest'

export const REGISTRY_URL = 'https://registry.modelcontextprotocol.io/v0/servers'

const EnvVarSchema = z.looseObject({
  name: z.string(),
  description: z.string().optional(),
  isRequired: z.boolean().optional(),
  isSecret: z.boolean().optional(),
  default: z.string().optional(),
})

const PackageSchema = z.looseObject({
  registryType: z.string(),
  identifier: z.string(),
  version: z.string().optional(),
  transport: z.looseObject({ type: z.string() }).optional(),
  environmentVariables: z.array(EnvVarSchema).optional(),
})

const RemoteSchema = z.looseObject({ type: z.string(), url: z.string() })

const EntrySchema = z.looseObject({
  server: z.looseObject({
    name: z.string(),
    description: z.string().optional(),
    version: z.string().optional(),
    repository: z.looseObject({ url: z.string().optional() }).optional(),
    packages: z.array(PackageSchema).optional(),
    remotes: z.array(RemoteSchema).optional(),
  }),
  _meta: z.record(z.string(), z.unknown()).optional(),
})

const ResponseSchema = z.looseObject({ servers: z.array(z.unknown()) })

/** Maps one registry entry to an installable description (or "unsupported" with a reason). */
export function toRegistryServer(raw: unknown): RegistryServer | undefined {
  const parsed = EntrySchema.safeParse(raw)
  if (!parsed.success) return undefined
  const s = parsed.data.server
  const npm = s.packages?.find(
    (p) => p.registryType === 'npm' && (p.transport?.type ?? 'stdio') === 'stdio',
  )
  const pypi = s.packages?.find(
    (p) => p.registryType === 'pypi' && (p.transport?.type ?? 'stdio') === 'stdio',
  )
  const remote = s.remotes?.find((r) => r.type === 'streamable-http' || r.type === 'http')
  const pkg = npm ?? pypi
  const install: RegistryServer['install'] = npm
    ? { kind: 'npm', packageName: npm.identifier, version: npm.version ?? 'latest' }
    : pypi
      ? { kind: 'pypi', packageName: pypi.identifier, version: pypi.version ?? 'latest' }
      : remote
        ? { kind: 'remote', url: remote.url }
        : { kind: 'unsupported', reason: 'Nur Docker/andere Paketformate – manuell einrichten.' }
  return {
    name: s.name,
    description: s.description ?? '',
    version: s.version ?? '',
    repositoryUrl: s.repository?.url ?? null,
    install,
    envVars: (pkg?.environmentVariables ?? []).map((v) => ({
      name: v.name,
      description: v.description ?? '',
      required: v.isRequired === true,
      secret: v.isSecret === true,
      default: v.default ?? null,
    })),
  }
}

/** Searches the official MCP registry (latest versions only). */
export async function searchRegistry(
  query: string,
  fetchImpl: typeof fetch = fetch,
  limit = 30,
): Promise<RegistryServer[]> {
  const url = `${REGISTRY_URL}?version=latest&limit=${limit}&search=${encodeURIComponent(query.trim())}`
  let response: Response
  try {
    response = await fetchImpl(url, { signal: AbortSignal.timeout(20_000) })
  } catch {
    throw new AddonError('Keine Verbindung zur MCP-Registry.')
  }
  if (!response.ok) throw new AddonError(`MCP-Registry antwortete mit HTTP ${response.status}.`)
  const data = ResponseSchema.safeParse(await response.json().catch(() => undefined))
  if (!data.success) throw new AddonError('Unerwartete Antwort der MCP-Registry.')
  const seen = new Set<string>()
  return data.data.servers.flatMap((raw) => {
    const server = toRegistryServer(raw)
    if (!server || seen.has(server.name)) return []
    seen.add(server.name)
    return [server]
  })
}

/** Builds the config entry for a registry server with the env values the user entered. */
export function registryToEntry(
  server: RegistryServer,
  env: Record<string, string>,
  platform: NodeJS.Platform = process.platform,
): McpServerEntry {
  const missing = server.envVars.filter((v) => v.required && !env[v.name]?.trim() && !v.default)
  if (missing.length) {
    throw new AddonError(`Pflichtangaben fehlen: ${missing.map((v) => v.name).join(', ')}`)
  }
  const values = Object.fromEntries(
    server.envVars
      .map((v) => [v.name, env[v.name]?.trim() || v.default || ''] as const)
      .filter(([, value]) => value !== ''),
  )
  const base = {
    name: toAddonName(server.name.split('/').at(-1) ?? server.name),
    enabled: true,
    description: server.description,
    source: 'registry' as const,
    registryName: server.name,
  }
  // npx/uvx are .cmd shims on Windows and must be started through cmd.
  const shim = (tool: string, args: string[]) =>
    platform === 'win32' ? { command: 'cmd', args: ['/c', tool, ...args] } : { command: tool, args }
  switch (server.install.kind) {
    case 'npm':
      return {
        ...base,
        transport: {
          type: 'stdio',
          ...shim('npx', ['-y', `${server.install.packageName}@${server.install.version}`]),
          env: values,
        },
      }
    case 'pypi':
      return {
        ...base,
        transport: {
          type: 'stdio',
          ...shim('uvx', [`${server.install.packageName}==${server.install.version}`]),
          env: values,
        },
      }
    case 'remote':
      return { ...base, transport: { type: 'http', url: server.install.url, headers: {} } }
    case 'unsupported':
      throw new AddonError(server.install.reason)
  }
}
