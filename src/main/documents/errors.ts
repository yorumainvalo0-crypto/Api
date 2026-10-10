/** Error with a German, user-facing message for unreadable or invalid documents. */
export class DocumentError extends Error {
  override name = 'DocumentError'
}

export const PASSWORD_MESSAGE = 'Die Datei ist passwortgeschützt und kann nicht gelesen werden.'

export function corruptMessage(label: string): string {
  return `Die Datei ist beschädigt oder kein gültiges ${label}.`
}

/** Maps library errors to a DocumentError, keeping DocumentErrors as they are. */
export function toDocumentError(error: unknown, label: string): DocumentError {
  if (error instanceof DocumentError) return error
  const message = error instanceof Error ? error.message : String(error)
  if (/password|encrypt|passwort/i.test(message)) return new DocumentError(PASSWORD_MESSAGE)
  return new DocumentError(corruptMessage(label), { cause: error })
}
