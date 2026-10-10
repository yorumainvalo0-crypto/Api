import { Component, lazy, Suspense, useState, type ReactNode } from 'react'
import { AlertTriangle, Box, Grid3x3, Loader2, RefreshCcw, RotateCw } from 'lucide-react'
import { ViewerButton } from './ImageViewer'
import { formatCount, modelLoaderKind } from './media-utils'
import type { ModelStats } from './model-loading'

// three.js + react-three-fiber live in their own chunk, loaded on first use.
const ModelScene = lazy(() => import('./ModelScene'))

type LoadState =
  | { status: 'loading' }
  | { status: 'ready'; stats: ModelStats }
  | { status: 'error'; message: string }

/**
 * Interactive 3D viewer for .glb/.gltf/.obj/.stl/.ply files: orbit controls, auto-centering,
 * wireframe and auto-rotate toggles. Fills its parent unless `height` (px) is given.
 */
export function ModelViewer(props: { path: string; name: string; height?: number }) {
  // Keyed by path so loading state and toggles reset for another model.
  return <ModelView key={props.path} {...props} />
}

function ModelView(props: { path: string; name: string; height?: number }) {
  const { path, name, height } = props
  const [state, setState] = useState<LoadState>({ status: 'loading' })
  const [wireframe, setWireframe] = useState(false)
  const [autoRotate, setAutoRotate] = useState(false)
  const [resetToken, setResetToken] = useState(0)
  const supported = modelLoaderKind(name) !== null

  return (
    <div
      style={height === undefined ? undefined : { height }}
      className={`relative w-full overflow-hidden bg-gradient-to-b from-zinc-100 to-zinc-200 dark:from-zinc-900 dark:to-zinc-950 ${
        height === undefined ? 'h-full min-h-48' : ''
      }`}
    >
      {!supported ? (
        <Overlay>
          <AlertTriangle size={22} className="text-amber-500" />
          Dieses 3D-Format wird nicht unterstützt.
        </Overlay>
      ) : (
        <SceneErrorBoundary
          onError={(message) => setState({ status: 'error', message })}
          fallback={null}
        >
          <Suspense fallback={null}>
            <ModelScene
              path={path}
              name={name}
              wireframe={wireframe}
              autoRotate={autoRotate}
              resetToken={resetToken}
              onLoaded={(stats) => setState({ status: 'ready', stats })}
              onError={(message) => setState({ status: 'error', message })}
            />
          </Suspense>
        </SceneErrorBoundary>
      )}

      {supported && state.status === 'loading' && (
        <Overlay>
          <Loader2 size={22} className="animate-spin" />
          Lade 3D-Modell …
        </Overlay>
      )}
      {state.status === 'error' && (
        <Overlay>
          <AlertTriangle size={22} className="text-red-500" />
          <span className="font-medium text-zinc-700 dark:text-zinc-200">
            3D-Modell konnte nicht geladen werden.
          </span>
          <span className="max-w-md px-4 text-center text-xs break-words">{state.message}</span>
        </Overlay>
      )}

      {state.status === 'ready' && (
        <>
          <div className="pointer-events-none absolute top-2 left-2 flex items-center gap-1.5 rounded-md bg-white/80 px-2 py-1 text-xs text-zinc-600 shadow-sm dark:bg-zinc-900/80 dark:text-zinc-300">
            <Box size={12} className="shrink-0" />
            {formatCount(state.stats.vertices)} Vertices
            {state.stats.triangles > 0 && <> · {formatCount(state.stats.triangles)} Dreiecke</>}
            {state.stats.points > 0 && <> · {formatCount(state.stats.points)} Punkte</>}
          </div>
          <div className="absolute right-2 bottom-2 flex items-center gap-0.5 rounded-md border border-zinc-200 bg-white/90 p-0.5 text-zinc-600 shadow-sm dark:border-zinc-700 dark:bg-zinc-900/90 dark:text-zinc-300">
            <ViewerButton
              title="Drahtgitter"
              active={wireframe}
              onClick={() => setWireframe((w) => !w)}
            >
              <Grid3x3 size={14} />
            </ViewerButton>
            <ViewerButton
              title="Automatisch drehen"
              active={autoRotate}
              onClick={() => setAutoRotate((r) => !r)}
            >
              <RotateCw size={14} />
            </ViewerButton>
            <ViewerButton title="Ansicht zurücksetzen" onClick={() => setResetToken((t) => t + 1)}>
              <RefreshCcw size={14} />
            </ViewerButton>
          </div>
        </>
      )}
    </div>
  )
}

function Overlay(props: { children: ReactNode }) {
  return (
    <div className="pointer-events-none absolute inset-0 flex flex-col items-center justify-center gap-2 text-sm text-zinc-500">
      {props.children}
    </div>
  )
}

/** Catches render errors of the lazy chunk / WebGL setup (e.g. no WebGL context available). */
class SceneErrorBoundary extends Component<
  { children: ReactNode; fallback: ReactNode; onError: (message: string) => void },
  { failed: boolean }
> {
  override state = { failed: false }

  static getDerivedStateFromError(): { failed: boolean } {
    return { failed: true }
  }

  override componentDidCatch(error: unknown): void {
    this.props.onError(error instanceof Error ? error.message : String(error))
  }

  override render(): ReactNode {
    return this.state.failed ? this.props.fallback : this.props.children
  }
}
