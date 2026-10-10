import {
  isChallengePage,
  parseBing,
  parseDuckDuckGoHtml,
  parseDuckDuckGoLite,
  parseWikipedia,
  type SearchResult,
} from './search-parsers'
import { extractReadable, type ExtractedPage } from './extract'

export interface LoadedPage {
  status: number
  finalUrl: string
  body: string
  contentType: string
}

/** Fetches a URL. The app uses Chromium (hidden window) for pages and fetch for search engines. */
export type PageLoader = (url: string, signal?: AbortSignal) => Promise<LoadedPage>

export class WebError extends Error {
  override name = 'WebError'
}

const BROWSER_UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Safari/537.36'

/** Plain HTTP loader with a browser-like user agent. */
export function createFetchLoader(userAgent = BROWSER_UA, timeoutMs = 20_000): PageLoader {
  return async (url, signal) => {
    const timeout = AbortSignal.timeout(timeoutMs)
    const response = await fetch(url, {
      headers: {
        'user-agent': userAgent,
        'accept-language': 'de-DE,de;q=0.9,en;q=0.8',
        accept: 'text/html,application/xhtml+xml,application/json;q=0.9,*/*;q=0.8',
      },
      redirect: 'follow',
      signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
    })
    return {
      status: response.status,
      finalUrl: response.url || url,
      body: await response.text(),
      contentType: response.headers.get('content-type') ?? '',
    }
  }
}

interface SearchProvider {
  name: string
  url: (query: string) => string
  parse: (body: string, max: number) => SearchResult[]
}

const SEARCH_PROVIDERS: SearchProvider[] = [
  {
    name: 'DuckDuckGo',
    url: (q) => `https://lite.duckduckgo.com/lite/?q=${encodeURIComponent(q)}&kl=de-de`,
    parse: parseDuckDuckGoLite,
  },
  {
    name: 'Bing',
    url: (q) => `https://www.bing.com/search?q=${encodeURIComponent(q)}&setlang=de`,
    parse: parseBing,
  },
  {
    name: 'DuckDuckGo (HTML)',
    url: (q) => `https://html.duckduckgo.com/html/?q=${encodeURIComponent(q)}`,
    parse: parseDuckDuckGoHtml,
  },
  {
    name: 'Wikipedia',
    url: (q) =>
      `https://de.wikipedia.org/w/api.php?action=query&list=search&format=json&srlimit=10&srsearch=${encodeURIComponent(q)}`,
    parse: (body, max) => parseWikipedia(body, 'de', max),
  },
]

export interface SearchResponse {
  provider: string
  results: SearchResult[]
  /** Providers that failed before one succeeded (for transparency/debugging). */
  skipped: string[]
}

export interface WebClientOptions {
  searchLoader: PageLoader
  pageLoader: PageLoader
  providers?: SearchProvider[]
  /** Minimum delay between two requests to the same host. */
  minIntervalMs?: number
  cacheTtlMs?: number
  now?: () => number
  sleep?: (ms: number) => Promise<void>
}

interface CacheEntry<T> {
  value: T
  expires: number
}

/** Free web search + page reading with provider fallback, caching and polite rate limiting. */
export class WebClient {
  private readonly providers: SearchProvider[]
  private readonly cache = new Map<string, CacheEntry<unknown>>()
  private readonly lastRequest = new Map<string, number>()
  private readonly now: () => number
  private readonly sleep: (ms: number) => Promise<void>

  constructor(private readonly options: WebClientOptions) {
    this.providers = options.providers ?? SEARCH_PROVIDERS
    this.now = options.now ?? Date.now
    this.sleep = options.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)))
  }

  async search(query: string, maxResults = 8, signal?: AbortSignal): Promise<SearchResponse> {
    const q = query.trim()
    if (!q) throw new WebError('Leere Suchanfrage.')
    const key = `search:${q.toLowerCase()}:${maxResults}`
    const cached = this.fromCache<SearchResponse>(key)
    if (cached) return cached

    const skipped: string[] = []
    for (const provider of this.providers) {
      try {
        const url = provider.url(q)
        const page = await this.throttled(url, () => this.options.searchLoader(url, signal))
        if (page.status >= 400) {
          skipped.push(`${provider.name} (HTTP ${page.status})`)
          continue
        }
        if (isChallengePage(page.body)) {
          skipped.push(`${provider.name} (Bot-Abfrage)`)
          continue
        }
        const results = provider.parse(page.body, maxResults)
        if (results.length === 0) {
          skipped.push(`${provider.name} (keine Treffer)`)
          continue
        }
        const response = { provider: provider.name, results, skipped }
        this.toCache(key, response)
        return response
      } catch (error) {
        if (signal?.aborted) throw error
        skipped.push(`${provider.name} (${error instanceof Error ? error.message : String(error)})`)
      }
    }
    throw new WebError(
      `Keine Suchergebnisse – alle Suchdienste fehlgeschlagen: ${skipped.join(', ')}`,
    )
  }

  async fetchPage(url: string, maxChars?: number, signal?: AbortSignal): Promise<ExtractedPage> {
    let parsed: URL
    try {
      parsed = new URL(url)
    } catch {
      throw new WebError(`Ungültige URL: ${url}`)
    }
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
      throw new WebError('Nur http(s)-Adressen können abgerufen werden.')
    }
    const key = `page:${parsed.toString()}:${maxChars ?? ''}`
    const cached = this.fromCache<ExtractedPage>(key)
    if (cached) return cached

    const page = await this.throttled(parsed.toString(), () =>
      this.options.pageLoader(parsed.toString(), signal),
    )
    if (page.status >= 400) throw new WebError(`Seite antwortete mit HTTP ${page.status}.`)

    let result: ExtractedPage
    if (
      /json|text\/plain|markdown|csv|xml/i.test(page.contentType) &&
      !/html/i.test(page.contentType)
    ) {
      const limit = maxChars ?? 24_000
      result = {
        url: page.finalUrl,
        title: page.finalUrl,
        markdown: page.body.slice(0, limit),
        truncated: page.body.length > limit,
      }
    } else {
      result = extractReadable(page.body, page.finalUrl, maxChars)
    }
    this.toCache(key, result)
    return result
  }

  private async throttled<T>(url: string, run: () => Promise<T>): Promise<T> {
    const host = new URL(url).host
    const interval = this.options.minIntervalMs ?? 1000
    const last = this.lastRequest.get(host)
    if (last !== undefined) {
      const wait = last + interval - this.now()
      if (wait > 0) await this.sleep(wait)
    }
    this.lastRequest.set(host, this.now())
    return run()
  }

  private fromCache<T>(key: string): T | undefined {
    const entry = this.cache.get(key)
    if (!entry) return undefined
    if (entry.expires < this.now()) {
      this.cache.delete(key)
      return undefined
    }
    return entry.value as T
  }

  private toCache(key: string, value: unknown): void {
    this.cache.set(key, { value, expires: this.now() + (this.options.cacheTtlMs ?? 15 * 60_000) })
    // Keep the cache small.
    if (this.cache.size > 200) {
      const oldest = this.cache.keys().next().value
      if (oldest !== undefined) this.cache.delete(oldest)
    }
  }
}
