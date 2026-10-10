export interface DiffLine {
  kind: 'same' | 'add' | 'remove'
  text: string
}

/** Above this many line pairs the LCS table gets too big; fall back to remove-all/add-all. */
const MAX_CELLS = 4_000_000

/** Minimal line-based diff (LCS) for showing agent edits. */
export function diffLines(before: string, after: string): DiffLine[] {
  const a = before === '' ? [] : before.split('\n')
  const b = after === '' ? [] : after.split('\n')

  if (a.length * b.length > MAX_CELLS) {
    return [
      ...a.map((text): DiffLine => ({ kind: 'remove', text })),
      ...b.map((text): DiffLine => ({ kind: 'add', text })),
    ]
  }

  // lcs[i][j] = length of the LCS of a[i..] and b[j..]
  const cols = b.length + 1
  const lcs = new Uint32Array((a.length + 1) * cols)
  for (let i = a.length - 1; i >= 0; i--) {
    for (let j = b.length - 1; j >= 0; j--) {
      lcs[i * cols + j] =
        a[i] === b[j]
          ? (lcs[(i + 1) * cols + j + 1] ?? 0) + 1
          : Math.max(lcs[(i + 1) * cols + j] ?? 0, lcs[i * cols + j + 1] ?? 0)
    }
  }

  const out: DiffLine[] = []
  let i = 0
  let j = 0
  while (i < a.length && j < b.length) {
    if (a[i] === b[j]) {
      out.push({ kind: 'same', text: a[i] ?? '' })
      i++
      j++
    } else if ((lcs[(i + 1) * cols + j] ?? 0) >= (lcs[i * cols + j + 1] ?? 0)) {
      out.push({ kind: 'remove', text: a[i] ?? '' })
      i++
    } else {
      out.push({ kind: 'add', text: b[j] ?? '' })
      j++
    }
  }
  while (i < a.length) out.push({ kind: 'remove', text: a[i++] ?? '' })
  while (j < b.length) out.push({ kind: 'add', text: b[j++] ?? '' })
  return out
}
