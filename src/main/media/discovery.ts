import { z } from 'zod'

export interface DiscoveredService {
  url: string
  version: string
}

export interface DiscoveryResult {
  ollama: DiscoveredService[]
  comfy: DiscoveredService[]
}

/**
 * Ports to probe on this machine: the defaults of Ollama and ComfyUI plus ports that launchers
 * such as Pinokio, Stability Matrix or portable installs commonly assign.
 */
export const CANDIDATE_PORTS: readonly number[] = [
  11434,
  11435,
  8188,
  8189,
  8190,
  8000,
  8001,
  8080,
  7860,
  7861,
  7862,
  7863,
  7864,
  7865,
  3000,
  5000,
  ...Array.from({ length: 41 }, (_, i) => 42000 + i),
]

async function probe(fetchImpl: typeof fetch, url: string, timeoutMs: number): Promise<unknown> {
  try {
    const response = await fetchImpl(url, { signal: AbortSignal.timeout(timeoutMs) })
    if (!response.ok) return undefined
    return (await response.json()) as unknown
  } catch {
    return undefined
  }
}

const OllamaVersionSchema = z.looseObject({ version: z.string() })
const ComfyStatsSchema = z.looseObject({
  system: z.looseObject({ comfyui_version: z.string().optional() }),
})

/** Finds running Ollama and ComfyUI servers on localhost (e.g. started from Pinokio). */
export async function discoverLocalServices(
  options: {
    fetchImpl?: typeof fetch
    host?: string
    ports?: readonly number[]
    timeoutMs?: number
  } = {},
): Promise<DiscoveryResult> {
  const fetchImpl = options.fetchImpl ?? fetch
  const host = options.host ?? '127.0.0.1'
  const timeoutMs = options.timeoutMs ?? 800
  const ports = options.ports ?? CANDIDATE_PORTS
  const result: DiscoveryResult = { ollama: [], comfy: [] }

  await Promise.all(
    ports.map(async (port) => {
      const base = `http://${host}:${port}`
      const [ollama, comfy] = await Promise.all([
        probe(fetchImpl, `${base}/api/version`, timeoutMs),
        probe(fetchImpl, `${base}/system_stats`, timeoutMs),
      ])
      const o = OllamaVersionSchema.safeParse(ollama)
      if (o.success) result.ollama.push({ url: base, version: o.data.version })
      const c = ComfyStatsSchema.safeParse(comfy)
      if (c.success) result.comfy.push({ url: base, version: c.data.system.comfyui_version ?? '?' })
    }),
  )
  const byPort = (a: DiscoveredService, b: DiscoveredService) =>
    Number(new URL(a.url).port) - Number(new URL(b.url).port)
  result.ollama.sort(byPort)
  result.comfy.sort(byPort)
  return result
}
