import { parseDocument } from './dom'

export interface SearchResult {
  title: string
  url: string
  snippet: string
}

function clean(text: string | null | undefined): string {
  return (text ?? '').replace(/\s+/g, ' ').trim()
}

function isHttpUrl(url: string): boolean {
  return /^https?:\/\//i.test(url)
}

/** True if the page is a bot check / captcha instead of results. */
export function isChallengePage(html: string): boolean {
  return /anomaly\.js|challenge-form|unfortunately, bots use|captcha|unusual traffic/i.test(html)
}

/** DuckDuckGo wraps result links as //duckduckgo.com/l/?uddg=<encoded target>. */
export function unwrapDuckDuckGoLink(href: string): string {
  try {
    const url = new URL(href, 'https://duckduckgo.com')
    const target = url.searchParams.get('uddg')
    return target ? decodeURIComponent(target) : url.toString()
  } catch {
    return href
  }
}

/** Bing wraps result links as /ck/a?...&u=a1<base64url target>. */
export function unwrapBingLink(href: string): string {
  try {
    const url = new URL(href, 'https://www.bing.com')
    if (!url.pathname.startsWith('/ck/')) return url.toString()
    const encoded = url.searchParams.get('u')
    if (!encoded?.startsWith('a1')) return url.toString()
    return Buffer.from(encoded.slice(2), 'base64url').toString('utf8')
  } catch {
    return href
  }
}

function dedupe(results: SearchResult[], max: number): SearchResult[] {
  const seen = new Set<string>()
  const out: SearchResult[] = []
  for (const r of results) {
    if (!r.title || !isHttpUrl(r.url) || seen.has(r.url)) continue
    seen.add(r.url)
    out.push(r)
    if (out.length >= max) break
  }
  return out
}

/** Parses https://lite.duckduckgo.com/lite/ result pages (table layout). */
export function parseDuckDuckGoLite(html: string, max = 10): SearchResult[] {
  const document = parseDocument(html)
  const results: SearchResult[] = []
  for (const link of Array.from(document.querySelectorAll('a.result-link'))) {
    // The snippet lives in a following table row.
    let row = link.closest('tr')?.nextElementSibling ?? null
    let snippet = ''
    for (let i = 0; i < 3 && row; i++, row = row.nextElementSibling) {
      const cell = row.querySelector('.result-snippet')
      if (cell) {
        snippet = clean(cell.textContent)
        break
      }
    }
    results.push({
      title: clean(link.textContent),
      url: unwrapDuckDuckGoLink(link.getAttribute('href') ?? ''),
      snippet,
    })
  }
  return dedupe(results, max)
}

/** Parses https://html.duckduckgo.com/html/ result pages. */
export function parseDuckDuckGoHtml(html: string, max = 10): SearchResult[] {
  const document = parseDocument(html)
  const results: SearchResult[] = []
  for (const node of Array.from(document.querySelectorAll('.result'))) {
    if (node.classList.contains('result--ad')) continue
    const link = node.querySelector('a.result__a')
    if (!link) continue
    results.push({
      title: clean(link.textContent),
      url: unwrapDuckDuckGoLink(link.getAttribute('href') ?? ''),
      snippet: clean(node.querySelector('.result__snippet')?.textContent),
    })
  }
  return dedupe(results, max)
}

/** Parses Bing web result pages. */
export function parseBing(html: string, max = 10): SearchResult[] {
  const document = parseDocument(html)
  const results: SearchResult[] = []
  for (const node of Array.from(document.querySelectorAll('li.b_algo'))) {
    const link = node.querySelector('h2 a')
    if (!link) continue
    const snippet = node.querySelector(
      '.b_caption p, p.b_lineclamp2, p.b_lineclamp3, p.b_lineclamp4, p',
    )
    results.push({
      title: clean(link.textContent),
      url: unwrapBingLink(link.getAttribute('href') ?? ''),
      snippet: clean(snippet?.textContent).replace(/^\d{1,2}\.\d{1,2}\.\d{4}\s*·\s*/, ''),
    })
  }
  return dedupe(results, max)
}

/** Parses the Wikipedia search API (JSON). */
export function parseWikipedia(json: string, lang: string, max = 10): SearchResult[] {
  try {
    const data = JSON.parse(json) as { query?: { search?: { title: string; snippet: string }[] } }
    return dedupe(
      (data.query?.search ?? []).map((r) => ({
        title: r.title,
        url: `https://${lang}.wikipedia.org/wiki/${encodeURIComponent(r.title.replace(/ /g, '_'))}`,
        snippet: clean(r.snippet.replace(/<[^>]+>/g, '')),
      })),
      max,
    )
  } catch {
    return []
  }
}
