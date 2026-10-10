export type DocumentKind = 'word' | 'spreadsheet' | 'presentation'

export interface ExtractedDocument {
  kind: DocumentKind
  markdown: string
  truncated: boolean
  /** Short German description, e.g. "PowerPoint, 12 Folien". */
  summary: string
}

/** Result of a converter before truncation. */
export interface ConvertedDocument {
  kind: DocumentKind
  markdown: string
  summary: string
}
