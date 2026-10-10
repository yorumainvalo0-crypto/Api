declare module 'word-extractor' {
  interface WordDocument {
    getBody(): string
    getFootnotes(): string
    getEndnotes(): string
    getHeaders(options?: { includeFooters?: boolean }): string
    getFooters(): string
    getAnnotations(): string
    getTextboxes(options?: { includeHeadersAndFooters?: boolean; includeBody?: boolean }): string
  }

  class WordExtractor {
    extract(source: string | Buffer): Promise<WordDocument>
  }

  export default WordExtractor
}
