import { strFromU8, unzipSync, type Unzipped } from 'fflate'
import { DocumentError, PASSWORD_MESSAGE, corruptMessage } from './errors'
import { parseXml, type XmlElement } from './xml'

/** Upper bound for the uncompressed size of a single package part (zip-bomb guard). */
const MAX_ENTRY_BYTES = 256 * 1024 * 1024
const MAX_TOTAL_BYTES = 512 * 1024 * 1024

export type FileSniff = 'zip' | 'cfb' | 'rtf' | 'other'

/** Detects the container format from the first bytes. */
export function sniff(data: Uint8Array): FileSniff {
  if (data[0] === 0x50 && data[1] === 0x4b && (data[2] === 0x03 || data[2] === 0x05)) return 'zip'
  if (data[0] === 0xd0 && data[1] === 0xcf && data[2] === 0x11 && data[3] === 0xe0) return 'cfb'
  const head = Buffer.from(data.subarray(0, 16))
    .toString('latin1')
    .replace(/^\uFEFF|^\xEF\xBB\xBF/, '')
  if (head.trimStart().startsWith('{\\rtf')) return 'rtf'
  return 'other'
}

/**
 * An OOXML file (docx/xlsx/pptx) with a password is stored as an OLE compound file holding an
 * `EncryptedPackage` stream instead of a zip.
 */
export function isEncryptedOoxml(data: Uint8Array): boolean {
  if (sniff(data) !== 'cfb') return false
  const marker = Buffer.from('EncryptedPackage', 'utf16le')
  return Buffer.from(data.buffer, data.byteOffset, data.byteLength).includes(marker)
}

export class Package {
  constructor(
    private readonly files: Unzipped,
    private readonly names: ReadonlySet<string>,
  ) {}

  /** Whether the package contains the part (even if it was not unpacked). */
  has(path: string): boolean {
    return this.names.has(path)
  }

  /** All part names in the package. */
  paths(): string[] {
    return [...this.names]
  }

  text(path: string): string | undefined {
    const data = this.files[path]
    return data ? strFromU8(data) : undefined
  }

  xml(path: string): XmlElement | undefined {
    const text = this.text(path)
    return text === undefined ? undefined : parseXml(text)
  }
}

/**
 * Opens an office zip package. `label` names the format in German error messages
 * (e.g. "Word-Dokument"). Encrypted OOXML files raise the password error.
 */
export function openPackage(
  data: Uint8Array,
  label: string,
  include: (path: string) => boolean = () => true,
): Package {
  if (isEncryptedOoxml(data)) throw new DocumentError(PASSWORD_MESSAGE)
  if (sniff(data) !== 'zip') throw new DocumentError(corruptMessage(label))
  let total = 0
  const names = new Set<string>()
  try {
    const files = unzipSync(data, {
      filter: (file) => {
        names.add(file.name)
        if (file.originalSize > MAX_ENTRY_BYTES) {
          throw new DocumentError('Die Datei enthält zu große Bestandteile und wird nicht gelesen.')
        }
        // Media is never needed for text extraction.
        if (/\.(png|jpe?g|gif|bmp|emf|wmf|tiff?|svg|mp4|mp3|wav|m4a|wdp|bin)$/i.test(file.name)) {
          return false
        }
        if (!include(file.name)) return false
        total += file.originalSize
        if (total > MAX_TOTAL_BYTES) {
          throw new DocumentError('Die Datei ist entpackt zu groß und wird nicht gelesen.')
        }
        return true
      },
    })
    return new Package(files, names)
  } catch (error) {
    if (error instanceof DocumentError) throw error
    throw new DocumentError(corruptMessage(label), { cause: error })
  }
}
