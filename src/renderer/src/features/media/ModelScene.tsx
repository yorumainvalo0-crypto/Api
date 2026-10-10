/*
 * The heavy part of the 3D viewer (three.js + react-three-fiber). Loaded lazily by ModelViewer.
 */
import { useEffect, useEffectEvent, useMemo, useRef, useState } from 'react'
import { Canvas, useFrame, useThree } from '@react-three/fiber'
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js'
import { Box3, GridHelper, Vector3, type Material, type Object3D } from 'three'
import {
  disposeObject,
  loadModel,
  modelStats,
  setWireframe,
  type ModelStats,
} from './model-loading'
import { boxCenterAndRadius, fitCameraDistance, niceGridSize } from './media-utils'

export interface ModelSceneProps {
  path: string
  name: string
  wireframe: boolean
  autoRotate: boolean
  /** Changing this value moves the camera back to the initial view. */
  resetToken: number
  onLoaded: (stats: ModelStats) => void
  onError: (message: string) => void
}

interface LoadedModel {
  object: Object3D
  radius: number
  /** Height of the (centered) bounding box. */
  height: number
  /** Largest horizontal extent of the bounding box. */
  footprint: number
}

/** Centers the model at the origin and measures it. */
function prepare(object: Object3D): LoadedModel {
  const box = new Box3().setFromObject(object)
  if (box.isEmpty()) throw new Error('Das Modell enthält keine Geometrie.')
  const { center, size, radius } = boxCenterAndRadius(box.min.toArray(), box.max.toArray())
  object.position.sub(new Vector3(...center))
  return { object, radius, height: size[1], footprint: Math.max(size[0], size[2]) }
}

function describeError(e: unknown): string {
  const message = e instanceof Error ? e.message : String(e)
  if (/draco|meshopt|ktx2|basisu/i.test(message)) {
    return 'Komprimierte glTF-Modelle (Draco/Meshopt/KTX2) werden nicht unterstützt.'
  }
  return message.replace(/^THREE\.\w+:\s*/, '')
}

export default function ModelScene(props: ModelSceneProps) {
  const { path, name, wireframe, autoRotate, resetToken } = props
  const [model, setModel] = useState<LoadedModel | null>(null)
  const onLoaded = useEffectEvent(props.onLoaded)
  const onError = useEffectEvent(props.onError)

  useEffect(() => {
    let cancelled = false
    let loaded: Object3D | null = null
    loadModel(path, name)
      .then((object) => {
        if (cancelled) {
          disposeObject(object)
          return
        }
        loaded = object
        const prepared = prepare(object)
        setModel(prepared)
        onLoaded(modelStats(object))
      })
      .catch((e: unknown) => {
        if (!cancelled) onError(describeError(e))
      })
    return () => {
      cancelled = true
      if (loaded) disposeObject(loaded)
    }
  }, [path, name])

  return (
    <Canvas
      frameloop={autoRotate ? 'always' : 'demand'}
      dpr={[1, 2]}
      camera={{ fov: 45, position: [3, 2, 3], near: 0.01, far: 1000 }}
      gl={{ antialias: true, preserveDrawingBuffer: false }}
    >
      <hemisphereLight args={[0xffffff, 0x8d8d8d, 1.8]} />
      <directionalLight position={[5, 10, 7]} intensity={2.2} />
      <directionalLight position={[-6, 4, -5]} intensity={0.7} />
      <Controls autoRotate={autoRotate} />
      {model && <ModelContent model={model} wireframe={wireframe} resetToken={resetToken} />}
    </Canvas>
  )
}

/** three.js OrbitControls registered as the default controls of the r3f store. */
function Controls(props: { autoRotate: boolean }) {
  const { autoRotate } = props
  const camera = useThree((s) => s.camera)
  const domElement = useThree((s) => s.gl.domElement)
  const set = useThree((s) => s.set)
  const invalidate = useThree((s) => s.invalidate)
  const controlsRef = useRef<OrbitControls | null>(null)
  const autoRotateRef = useRef(autoRotate)

  useEffect(() => {
    const controls = new OrbitControls(camera, domElement)
    controls.enableDamping = true
    controls.autoRotateSpeed = 1.5
    controls.autoRotate = autoRotateRef.current
    const onChange = () => invalidate()
    controls.addEventListener('change', onChange)
    controlsRef.current = controls
    set({ controls })
    return () => {
      controls.removeEventListener('change', onChange)
      controls.dispose()
      controlsRef.current = null
      set({ controls: null })
    }
  }, [camera, domElement, set, invalidate])

  useEffect(() => {
    autoRotateRef.current = autoRotate
    if (controlsRef.current) controlsRef.current.autoRotate = autoRotate
    invalidate()
  }, [autoRotate, invalidate])

  // Damping and auto-rotate need an update per frame; 'change' events request further frames.
  useFrame(() => controlsRef.current?.update())
  return null
}

interface OrbitControlsLike {
  target: Vector3
  minDistance: number
  maxDistance: number
  update: () => void
}

function ModelContent(props: { model: LoadedModel; wireframe: boolean; resetToken: number }) {
  const { model, wireframe, resetToken } = props
  const get = useThree((s) => s.get)
  const invalidate = useThree((s) => s.invalidate)

  const grid = useMemo(() => {
    const size = niceGridSize(Math.max(model.footprint, model.height * 0.5))
    const helper = new GridHelper(size, 20, 0x888888, 0x666666)
    const materials = Array.isArray(helper.material) ? helper.material : [helper.material]
    for (const m of materials as Material[]) {
      m.transparent = true
      m.opacity = 0.45
      m.depthWrite = false
    }
    helper.position.y = -model.height / 2
    return helper
  }, [model])

  useEffect(
    () => () => {
      grid.geometry.dispose()
      const materials = Array.isArray(grid.material) ? grid.material : [grid.material]
      for (const m of materials as Material[]) m.dispose()
    },
    [grid],
  )

  useEffect(() => {
    setWireframe(model.object, wireframe)
    invalidate()
  }, [model, wireframe, invalidate])

  // Fit the camera to the model (initially and on "reset view").
  useEffect(() => {
    const { camera, size, controls } = get()
    const fov = 'fov' in camera ? (camera.fov as number) : 45
    const distance = fitCameraDistance(model.radius, fov, size.width / Math.max(1, size.height))
    const direction = new Vector3(1, 0.65, 1).normalize()
    camera.position.copy(direction.multiplyScalar(distance))
    camera.near = distance / 100
    camera.far = distance * 100
    camera.updateProjectionMatrix()
    const orbit = controls as unknown as OrbitControlsLike | null
    if (orbit) {
      orbit.target.set(0, 0, 0)
      orbit.minDistance = distance / 50
      orbit.maxDistance = distance * 20
      orbit.update()
    }
    invalidate()
  }, [model, resetToken, get, invalidate])

  return (
    <>
      <primitive object={model.object} />
      <primitive object={grid} />
    </>
  )
}
