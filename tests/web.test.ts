import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  isChallengePage,
  parseBing,
  parseDuckDuckGoLite,
  parseWikipedia,
  unwrapBingLink,
  unwrapDuckDuckGoLink,
} from '../src/main/web/search-parsers'
import { extractReadable } from '../src/main/web/extract'
import { WebClient, WebError, type LoadedPage, type PageLoader } from '../src/main/web/web-client'

const fixture = (name: string) => readFileSync(join(import.meta.dirname, 'fixtures', name), 'utf8')

const html = (body: string, status = 200): LoadedPage => ({
  status,
  finalUrl: 'https://example.org/',
  body,
  contentType: 'text/html; charset=utf-8',
})

describe('search result parsers (real captured pages)', () => {
  it('parses DuckDuckGo Lite and unwraps redirect links', () => {
    const results = parseDuckDuckGoLite(fixture('ddg-lite.html'))
    expect(results).toHaveLength(10)
    expect(results[0]).toMatchObject({ url: 'https://www.electronjs.org/' })
    expect(results.every((r) => r.url.startsWith('http') && r.title && r.snippet)).toBe(true)
  })

  it('parses Bing and decodes its tracking links', () => {
    const results = parseBing(fixture('bing.html'))
    expect(results.length).toBeGreaterThanOrEqual(5)
    expect(results.some((r) => r.url === 'https://github.com/electron/electron')).toBe(true)
    expect(results.every((r) => !r.url.includes('bing.com/ck/'))).toBe(true)
  })

  it('detects bot challenges', () => {
    expect(isChallengePage(fixture('ddg-challenge.html'))).toBe(true)
    expect(isChallengePage(fixture('ddg-lite.html'))).toBe(false)
  })

  it('unwraps links and parses Wikipedia JSON', () => {
    expect(
      unwrapDuckDuckGoLink('//duckduckgo.com/l/?uddg=https%3A%2F%2Fa.de%2Fx%3Fy%3D1&rut=z'),
    ).toBe('https://a.de/x?y=1')
    const encoded = Buffer.from('https://b.de/seite').toString('base64url')
    expect(unwrapBingLink(`https://www.bing.com/ck/a?!&p=1&u=a1${encoded}&ntb=1`)).toBe(
      'https://b.de/seite',
    )
    expect(
      parseWikipedia(
        JSON.stringify({
          query: { search: [{ title: 'Electron (Software)', snippet: 'Ein <b>Framework</b>' }] },
        }),
        'de',
      ),
    ).toEqual([
      {
        title: 'Electron (Software)',
        url: 'https://de.wikipedia.org/wiki/Electron_(Software)',
        snippet: 'Ein Framework',
      },
    ])
  })
})

describe('extractReadable', () => {
  const article = `<html><head><title>Testseite</title></head><body>
    <nav>Menü Startseite Impressum</nav>
    <article><h1>Wichtige Nachricht</h1>
    ${'<p>Dies ist ein langer Absatz mit Inhalt, damit Readability ihn als Artikel erkennt. </p>'.repeat(12)}
    <pre><code>const x = 1</code></pre></article>
    <script>alert(1)</script><footer>Fußzeile</footer></body></html>`

  it('returns the main content as Markdown without navigation or scripts', () => {
    const page = extractReadable(article, 'https://example.org/a')
    expect(page.title).toContain('Testseite')
    expect(page.markdown).toContain('langer Absatz')
    expect(page.markdown).toContain('const x = 1')
    expect(page.markdown).not.toContain('alert(1)')
    expect(page.markdown).not.toContain('Impressum')
    expect(page.truncated).toBe(false)
  })

  it('truncates long pages', () => {
    const page = extractReadable(article, 'https://example.org/a', 200)
    expect(page.truncated).toBe(true)
    expect(page.markdown).toContain('[… gekürzt]')
  })
})

describe('WebClient', () => {
  const noSleep = { sleep: async () => undefined }

  it('falls back to the next provider on bot challenges and HTTP errors', async () => {
    const seen: string[] = []
    const searchLoader: PageLoader = async (url) => {
      seen.push(new URL(url).host)
      if (url.includes('lite.duckduckgo')) return html(fixture('ddg-challenge.html'))
      return html(fixture('bing.html'))
    }
    const client = new WebClient({ searchLoader, pageLoader: searchLoader, ...noSleep })
    const response = await client.search('electron framework', 3)
    expect(response.provider).toBe('Bing')
    expect(response.results).toHaveLength(3)
    expect(response.skipped[0]).toContain('Bot-Abfrage')
    expect(seen).toEqual(['lite.duckduckgo.com', 'www.bing.com'])

    // Second identical search is served from the cache.
    await client.search('electron framework', 3)
    expect(seen).toHaveLength(2)
  })

  it('reports a German error when every provider fails', async () => {
    const client = new WebClient({
      searchLoader: async () => html('nope', 503),
      pageLoader: async () => html(''),
      ...noSleep,
    })
    await expect(client.search('x')).rejects.toThrow(/alle Suchdienste fehlgeschlagen/)
  })

  it('throttles requests to the same host', async () => {
    let now = 0
    const waits: number[] = []
    const client = new WebClient({
      searchLoader: async () => html(fixture('ddg-lite.html')),
      pageLoader: async () => html('<p>x</p>'),
      minIntervalMs: 1000,
      now: () => now,
      sleep: async (ms) => {
        waits.push(ms)
        now += ms
      },
    })
    await client.search('a')
    now += 300
    await client.search('b')
    expect(waits).toEqual([700])
  })

  it('fetches pages, passes through JSON and rejects non-http URLs', async () => {
    const client = new WebClient({
      searchLoader: async () => html(''),
      pageLoader: async (url) =>
        url.endsWith('.json')
          ? { status: 200, finalUrl: url, body: '{"a":1}', contentType: 'application/json' }
          : html('<html><head><title>T</title></head><body><p>Hallo Welt</p></body></html>'),
      ...noSleep,
    })
    expect((await client.fetchPage('https://example.org/')).markdown).toContain('Hallo Welt')
    expect((await client.fetchPage('https://example.org/data.json')).markdown).toBe('{"a":1}')
    await expect(client.fetchPage('file:///etc/passwd')).rejects.toThrow(WebError)
    await expect(client.fetchPage('kein link')).rejects.toThrow(/Ungültige URL/)
  })
})

describe.runIf(process.env['AIW_LIVE_WEB'] === '1')('live web (opt-in)', () => {
  it('finds results on the real internet', async () => {
    const { createFetchLoader } = await import('../src/main/web/web-client')
    const loader = createFetchLoader()
    const client = new WebClient({ searchLoader: loader, pageLoader: loader })
    const response = await client.search('Electron framework', 5)
    expect(response.results.length).toBeGreaterThan(0)
    const page = await client.fetchPage(response.results[0]?.url ?? '')
    expect(page.markdown.length).toBeGreaterThan(100)
  }, 60_000)
})
