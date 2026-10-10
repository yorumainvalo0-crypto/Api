import { Plus, Trash2 } from 'lucide-react'
import { btnSmCls, inputCls } from './styles'

export interface KeyValueRow {
  key: string
  value: string
  /** A value is already stored (never sent to the UI); an empty value keeps it. */
  stored: boolean
}

/** Editable list of key/value pairs (environment variables, HTTP headers). */
export function KeyValueEditor(props: {
  rows: KeyValueRow[]
  onChange: (rows: KeyValueRow[]) => void
  keyPlaceholder: string
  valuePlaceholder: string
  addLabel: string
}) {
  const { rows, onChange } = props

  const patch = (index: number, change: Partial<KeyValueRow>) =>
    onChange(rows.map((r, i) => (i === index ? { ...r, ...change } : r)))

  return (
    <div className="space-y-2">
      {rows.map((row, i) => {
        const keepStored = row.stored && row.value === ''
        return (
          // Rows have no stable identity; inputs are fully controlled so index keys are safe.
          <div key={i} className="flex gap-2">
            <input
              value={row.key}
              placeholder={props.keyPlaceholder}
              readOnly={row.stored}
              aria-label="Name"
              onChange={(e) => patch(i, { key: e.target.value })}
              className={`${inputCls} flex-1 font-mono`}
            />
            <input
              value={row.value}
              type={row.stored || row.value ? 'password' : 'text'}
              placeholder={keepStored ? '•••• gespeichert' : props.valuePlaceholder}
              aria-label="Wert"
              autoComplete="off"
              onChange={(e) => patch(i, { value: e.target.value })}
              className={`${inputCls} flex-[2] font-mono`}
            />
            <button
              type="button"
              title="Zeile entfernen"
              onClick={() => onChange(rows.filter((_, j) => j !== i))}
              className="rounded-md border border-zinc-300 px-2 text-zinc-500 hover:bg-zinc-100 dark:border-zinc-700 dark:hover:bg-zinc-800"
            >
              <Trash2 size={14} />
            </button>
          </div>
        )
      })}
      <button
        type="button"
        className={btnSmCls}
        onClick={() => onChange([...rows, { key: '', value: '', stored: false }])}
      >
        <Plus size={12} />
        {props.addLabel}
      </button>
    </div>
  )
}

/** Rows -> record; rows without a key are dropped. Stored secrets with no new value send ''. */
export function rowsToRecord(rows: KeyValueRow[]): Record<string, string> {
  const out: Record<string, string> = {}
  for (const row of rows) {
    const key = row.key.trim()
    if (key) out[key] = row.value
  }
  return out
}

/** Record + list of keys with a stored secret -> rows (stored keys appear even if absent). */
export function recordToRows(
  record: Record<string, string>,
  secretKeys: readonly string[],
): KeyValueRow[] {
  const keys = [...new Set([...Object.keys(record), ...secretKeys])]
  return keys.map((key) => ({
    key,
    value: record[key] ?? '',
    stored: secretKeys.includes(key),
  }))
}
