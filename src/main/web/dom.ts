import { parseHTML } from 'linkedom'

/** Minimal DOM surface used by the parsers (the main process has no DOM lib types). */
export interface DomElement {
  textContent: string | null
  innerHTML: string
  nextElementSibling: DomElement | null
  classList: { contains(name: string): boolean }
  getAttribute(name: string): string | null
  querySelector(selector: string): DomElement | null
  querySelectorAll(selector: string): ArrayLike<DomElement>
  closest(selector: string): DomElement | null
}

export interface DomDocument {
  body: DomElement | null
  querySelector(selector: string): DomElement | null
  querySelectorAll(selector: string): ArrayLike<DomElement>
}

/** Parses HTML into a lightweight server-side DOM (linkedom). */
export function parseDocument(html: string): DomDocument {
  return (parseHTML(html) as unknown as { document: DomDocument }).document
}
