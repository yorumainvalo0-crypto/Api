import { TextDecoder } from 'node:util'

/**
 * Small, forgiving RTF-to-text converter. It keeps paragraphs, tabs, simple tables and all
 * characters (code-page escapes `\'xx` and Unicode `\uN`), and skips non-text destinations
 * such as font/colour tables, stylesheets, pictures and `\*` groups.
 */

const SKIP_DESTINATIONS = new Set([
  'fonttbl',
  'colortbl',
  'stylesheet',
  'info',
  'pict',
  'object',
  'objdata',
  'themedata',
  'colorschememapping',
  'datastore',
  'latentstyles',
  'listtable',
  'listoverridetable',
  'revtbl',
  'rsidtbl',
  'generator',
  'xmlnstbl',
  'mmathPr',
  'header',
  'headerl',
  'headerr',
  'headerf',
  'footer',
  'footerl',
  'footerr',
  'footerf',
  'filetbl',
  'pgdsctbl',
  'nonshppict',
  'fldinst',
  'bkmkstart',
  'bkmkend',
  'protusertbl',
  'userprops',
  'wgrffmtfilter',
  'docvar',
  'atnauthor',
  'atnid',
  'annotation',
  'xe',
  'tc',
])

const SYMBOLS: Record<string, string> = {
  emdash: '—',
  endash: '–',
  bullet: '•',
  lquote: '‘',
  rquote: '’',
  ldblquote: '“',
  rdblquote: '”',
  emspace: ' ',
  enspace: ' ',
  qmspace: ' ',
  zwj: '',
  zwnj: '',
  ltrmark: '',
  rtlmark: '',
}

interface GroupState {
  skip: boolean
  /** Number of fallback characters after `\uN` (\ucN). */
  uc: number
}

function decoderFor(codePage: number): TextDecoder {
  const label =
    codePage === 65001
      ? 'utf-8'
      : codePage === 932
        ? 'shift_jis'
        : codePage === 936
          ? 'gbk'
          : codePage === 949
            ? 'euc-kr'
            : codePage === 950
              ? 'big5'
              : codePage === 10000
                ? 'macintosh'
                : codePage >= 874 && codePage <= 1258
                  ? `windows-${codePage}`
                  : 'windows-1252'
  try {
    return new TextDecoder(label)
  } catch {
    return new TextDecoder('windows-1252')
  }
}

/** Converts RTF source (as latin1/ASCII string) to Markdown-ish plain text. */
export function rtfToText(rtf: string): string {
  let decoder = decoderFor(1252)
  const stack: GroupState[] = []
  let state: GroupState = { skip: false, uc: 1 }
  let out = ''
  let pendingBytes: number[] = []
  /** Fallback characters still to skip after a \uN. */
  let skipChars = 0
  // Table handling: cells of the current row, current cell text.
  let rowCells: string[] = []
  let tableRows = 0
  let inTable = false
  let lineStart = 0

  const flushBytes = (): void => {
    if (pendingBytes.length === 0) return
    out += decoder.decode(new Uint8Array(pendingBytes))
    pendingBytes = []
  }
  /** Text after a finished table starts a new block. */
  const beforeText = (): void => {
    if (tableRows > 0 && !inTable) {
      flushBytes()
      out += '\n'
      tableRows = 0
      lineStart = out.length
    }
  }
  const emit = (text: string): void => {
    if (state.skip) return
    if (text.trim()) beforeText()
    flushBytes()
    out += text
  }
  const endParagraph = (): void => {
    flushBytes()
    if (inTable) {
      // Paragraph inside a table cell: keep the cell on one line.
      out += ' '
      return
    }
    out += '\n'
    lineStart = out.length
  }
  const endCell = (): void => {
    flushBytes()
    rowCells.push(out.slice(lineStart).replace(/\n/g, ' ').trim())
    out = out.slice(0, lineStart)
  }
  const endRow = (): void => {
    flushBytes()
    const rest = out.slice(lineStart).trim()
    if (rest) rowCells.push(rest)
    out = out.slice(0, lineStart)
    if (rowCells.length === 0) return
    const cells = rowCells.map((c) => c.replace(/\|/g, '\\|'))
    if (tableRows === 0 && out.length > 0 && !out.endsWith('\n\n')) out += '\n'
    out += `| ${cells.join(' | ')} |\n`
    if (tableRows === 0) out += `|${cells.map(() => ' --- ').join('|')}|\n`
    tableRows++
    rowCells = []
    lineStart = out.length
  }

  let i = 0
  const n = rtf.length
  while (i < n) {
    const ch = rtf[i]
    if (ch === '{') {
      stack.push(state)
      state = { ...state }
      i++
      // `{\*\dest ...}`: ignorable destination.
      if (rtf.startsWith('\\*', i)) state.skip = true
      continue
    }
    if (ch === '}') {
      flushBytes()
      state = stack.pop() ?? { skip: false, uc: 1 }
      i++
      continue
    }
    if (ch === '\r' || ch === '\n') {
      i++
      continue
    }
    if (ch !== '\\') {
      if (skipChars > 0) {
        skipChars--
      } else {
        emit(ch ?? '')
      }
      i++
      continue
    }

    // Control symbol or word.
    const next = rtf[i + 1]
    if (next === undefined) break
    if (next === "'") {
      const hex = rtf.slice(i + 2, i + 4)
      i += 4
      if (skipChars > 0) {
        skipChars--
        continue
      }
      const byte = Number.parseInt(hex, 16)
      if (!state.skip && Number.isFinite(byte)) {
        if (pendingBytes.length === 0) beforeText()
        pendingBytes.push(byte)
      }
      continue
    }
    if (!/[a-zA-Z]/.test(next)) {
      i += 2
      if (skipChars > 0) {
        skipChars--
        continue
      }
      if (next === '\\' || next === '{' || next === '}') emit(next)
      else if (next === '~') emit('\u00A0')
      else if (next === '_') emit('-')
      else if (next === '\n' || next === '\r') {
        if (!state.skip) endParagraph()
      } else if (next === '*') state.skip = true
      // `\-` (optional hyphen) and others are dropped.
      continue
    }

    const match = /^([a-zA-Z]{1,32})(-?\d{1,10})? ?/.exec(rtf.slice(i + 1, i + 46))
    if (!match) {
      i++
      continue
    }
    i += 1 + match[0].length
    const word = match[1] ?? ''
    const param = match[2] === undefined ? undefined : Number.parseInt(match[2], 10)

    if (word === 'bin' && param !== undefined) {
      i += Math.max(0, param)
      continue
    }
    if (SKIP_DESTINATIONS.has(word)) {
      state.skip = true
      continue
    }
    if (word === 'u' && param !== undefined) {
      const code = param < 0 ? param + 65536 : param
      emit(String.fromCharCode(code))
      skipChars = state.uc
      continue
    }
    // Any other control word ends a pending \uN fallback.
    skipChars = 0
    switch (word) {
      case 'ansicpg':
        if (param !== undefined) decoder = decoderFor(param)
        break
      case 'intbl':
        inTable = true
        break
      case 'pard':
        inTable = false
        break
      case 'uc':
        state.uc = Math.max(0, param ?? 1)
        break
      case 'par':
      case 'sect':
      case 'page':
        if (!state.skip) endParagraph()
        break
      case 'line':
        emit('\n')
        break
      case 'tab':
        emit('\t')
        break
      case 'cell':
      case 'nestcell':
        if (!state.skip) endCell()
        break
      case 'row':
      case 'nestrow':
        if (!state.skip) endRow()
        break
      default: {
        const symbol = SYMBOLS[word]
        if (symbol !== undefined) emit(symbol)
      }
    }
  }
  flushBytes()
  return out
    .replace(/\u00A0/g, ' ')
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
}
