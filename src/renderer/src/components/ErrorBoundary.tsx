import { Component, type ErrorInfo, type ReactNode } from 'react'

interface State {
  error: Error | null
}

/** Shows a recoverable error screen instead of a blank window when rendering fails. */
export class ErrorBoundary extends Component<{ children: ReactNode }, State> {
  override state: State = { error: null }

  static getDerivedStateFromError(error: Error): State {
    return { error }
  }

  override componentDidCatch(error: Error, info: ErrorInfo): void {
    console.error('UI error', error, info.componentStack)
  }

  override render() {
    if (!this.state.error) return this.props.children
    return (
      <div className="flex h-full items-center justify-center p-8">
        <div className="max-w-lg space-y-3 rounded-lg border border-red-300 p-6 dark:border-red-900">
          <h1 className="text-lg font-semibold">Da ist etwas schiefgelaufen</h1>
          <p className="text-sm text-zinc-500">
            Die Oberfläche ist auf einen Fehler gestoßen. Deine Chats sind gespeichert.
          </p>
          <pre className="max-h-40 overflow-auto rounded bg-zinc-100 p-2 text-xs dark:bg-zinc-900">
            {this.state.error.message}
          </pre>
          <div className="flex gap-2">
            <button
              type="button"
              onClick={() => this.setState({ error: null })}
              className="rounded-md border border-zinc-300 px-3 py-1 text-sm dark:border-zinc-700"
            >
              Erneut versuchen
            </button>
            <button
              type="button"
              onClick={() => window.location.reload()}
              className="rounded-md bg-blue-600 px-3 py-1 text-sm text-white"
            >
              Neu laden
            </button>
          </div>
        </div>
      </div>
    )
  }
}
