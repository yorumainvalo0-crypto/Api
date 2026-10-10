import { useMemo } from 'react'

/** Colors unified diff lines (+ green, - red, hunks blue, headers bold). */
export function DiffView(props: { diff: string }) {
  const lines = useMemo(() => {
    const all = props.diff.split('\n')
    if (all[all.length - 1] === '') all.pop()
    return all
  }, [props.diff])

  if (lines.length === 0) {
    return <p className="px-3 py-2 text-xs text-zinc-500">Keine Änderungen.</p>
  }
  return (
    <div className="min-h-0 flex-1 overflow-auto bg-white font-mono text-xs leading-5 dark:bg-zinc-950">
      <div className="min-w-max py-1">
        {lines.map((line, i) => (
          <div key={i} className={`px-3 whitespace-pre ${lineClass(line)}`}>
            {line || ' '}
          </div>
        ))}
      </div>
    </div>
  )
}

function lineClass(line: string): string {
  if (
    line.startsWith('diff ') ||
    line.startsWith('index ') ||
    line.startsWith('+++ ') ||
    line.startsWith('--- ') ||
    line.startsWith('new file') ||
    line.startsWith('deleted file') ||
    line.startsWith('rename ') ||
    line.startsWith('similarity ')
  ) {
    return 'font-semibold text-zinc-600 dark:text-zinc-400'
  }
  if (line.startsWith('@@')) return 'bg-blue-50 text-blue-700 dark:bg-blue-950 dark:text-blue-300'
  if (line.startsWith('+')) {
    return 'bg-green-50 text-green-800 dark:bg-green-950/60 dark:text-green-300'
  }
  if (line.startsWith('-')) return 'bg-red-50 text-red-800 dark:bg-red-950/60 dark:text-red-300'
  if (line.startsWith('…')) return 'text-amber-600'
  return 'text-zinc-700 dark:text-zinc-300'
}
