import { Readability } from '@mozilla/readability'
import { parseHTML } from 'linkedom'
import { parseDocument } from './dom'
import TurndownService from 'turndown'

export interface ExtractedPage {
  url: string
  title: string
  markdown: string
  truncated: boolean
}

const turndown = new TurndownService({
  headingStyle: 'atx',
  codeBlockStyle: 'fenced',
  bulletListMarker: '-',
})
turndown.remove(['script', 'style', 'noscript', 'iframe', 'svg', 'canvas', 'form'])

/** Default budget of characters returned to the model per page (~6k tokens). */
export const DEFAULT_MAX_CHARS = 24_000

/**
 * Turns an HTML page into readable Markdown: Readability extracts the main article,
 * falling back to the whole body for pages it cannot handle (docs, listings).
 */
export function extractReadable(
  html: string,
  url: string,
  maxChars = DEFAULT_MAX_CHARS,
): ExtractedPage {
  const document = parseDocument(html)
  const fallbackTitle = document.querySelector('title')?.textContent?.trim() ?? url

  let title = fallbackTitle
  let contentHtml: string | undefined
  try {
    // Readability mutates the document, so give it its own copy.
    const copy = (
      parseHTML(html) as unknown as { document: ConstructorParameters<typeof Readability>[0] }
    ).document
    const article = new Readability(copy, {
      charThreshold: 200,
    }).parse()
    if (article?.content && (article.textContent ?? '').trim().length > 200) {
      contentHtml = article.content
      title = article.title?.trim() || fallbackTitle
    }
  } catch {
    // Fall through to the body.
  }
  contentHtml ??= document.querySelector('main')?.innerHTML ?? document.body?.innerHTML ?? ''

  let markdown = turndown
    .turndown(contentHtml)
    .replace(/\n{3,}/g, '\n\n')
    .trim()
  const truncated = markdown.length > maxChars
  if (truncated) markdown = `${markdown.slice(0, maxChars)}\n\n[… gekürzt]`
  return { url, title, markdown, truncated }
}
