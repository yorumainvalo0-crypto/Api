import type { ReactNode } from 'react'

/** Accessible on/off switch. */
export function Toggle(props: {
  checked: boolean
  onChange: (checked: boolean) => void
  disabled?: boolean
  label: string
}) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={props.checked}
      aria-label={props.label}
      title={props.label}
      disabled={props.disabled}
      onClick={() => props.onChange(!props.checked)}
      className={`relative inline-flex h-5 w-9 shrink-0 items-center rounded-full transition-colors disabled:opacity-50 ${
        props.checked ? 'bg-blue-600' : 'bg-zinc-300 dark:bg-zinc-700'
      }`}
    >
      <span
        className={`inline-block h-4 w-4 rounded-full bg-white shadow transition-transform ${
          props.checked ? 'translate-x-4.5' : 'translate-x-0.5'
        }`}
      />
    </button>
  )
}

const BADGE_TONES = {
  neutral: 'bg-zinc-100 text-zinc-600 dark:bg-zinc-800 dark:text-zinc-300',
  blue: 'bg-blue-100 text-blue-700 dark:bg-blue-950 dark:text-blue-300',
  green: 'bg-emerald-100 text-emerald-700 dark:bg-emerald-950 dark:text-emerald-300',
  amber: 'bg-amber-100 text-amber-700 dark:bg-amber-950 dark:text-amber-300',
  red: 'bg-red-100 text-red-700 dark:bg-red-950 dark:text-red-300',
} as const

export function Badge(props: { tone?: keyof typeof BADGE_TONES; children: ReactNode }) {
  return (
    <span
      className={`inline-block shrink-0 rounded px-1.5 py-0.5 text-[11px] font-medium ${
        BADGE_TONES[props.tone ?? 'neutral']
      }`}
    >
      {props.children}
    </span>
  )
}

export function ErrorText(props: { children: ReactNode }) {
  return (
    <p role="alert" className="text-sm break-words text-red-600 dark:text-red-400">
      {props.children}
    </p>
  )
}

export function SectionHeader(props: { title: string; count?: number; children?: ReactNode }) {
  return (
    <div className="flex flex-wrap items-center justify-between gap-2">
      <h2 className="font-medium">
        {props.title}
        {props.count !== undefined && (
          <span className="ml-2 text-sm font-normal text-zinc-500">{props.count}</span>
        )}
      </h2>
      {props.children}
    </div>
  )
}
