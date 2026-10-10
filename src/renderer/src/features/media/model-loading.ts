/*
 * three.js model loading for the 3D viewer. Only imported by the lazily loaded ModelScene so that
 * three.js stays out of the main bundle.
 */
import {
  BufferGeometry,
  Color,
  FileLoader,
  Group,
  Material,
  Mesh,
  MeshStandardMaterial,
  Object3D,
  Points,
  PointsMaterial,
  TextureLoader,
  type Texture,
} from 'three'
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js'
import { OBJLoader } from 'three/examples/jsm/loaders/OBJLoader.js'
import { MTLLoader } from 'three/examples/jsm/loaders/MTLLoader.js'
import { STLLoader } from 'three/examples/jsm/loaders/STLLoader.js'
import { PLYLoader } from 'three/examples/jsm/loaders/PLYLoader.js'
import { fileUrl } from '@shared/ipc'
import {
  decodeDataUri,
  dirWithSeparator,
  joinPath,
  modelLoaderKind,
  objMaterialLibrary,
  plyHasFaces,
  triangleCount,
} from './media-utils'

export interface ModelStats {
  vertices: number
  triangles: number
  points: number
}

const NEUTRAL_COLOR = new Color(0xb8bcc4)

function neutralMaterial(geometry: BufferGeometry): MeshStandardMaterial {
  const hasColors = geometry.hasAttribute('color')
  return new MeshStandardMaterial({
    color: hasColors ? 0xffffff : NEUTRAL_COLOR,
    vertexColors: hasColors,
    roughness: 0.6,
    metalness: 0.05,
    flatShading: !geometry.hasAttribute('normal'),
  })
}

/** Mesh (or point cloud, for PLY files without faces) with a neutral material. */
function meshFromGeometry(geometry: BufferGeometry, isPointCloud: boolean): Object3D {
  if (isPointCloud) {
    const hasColors = geometry.hasAttribute('color')
    geometry.computeBoundingSphere()
    const radius = geometry.boundingSphere?.radius ?? 1
    return new Points(
      geometry,
      new PointsMaterial({
        size: radius / 200,
        vertexColors: hasColors,
        color: hasColors ? 0xffffff : NEUTRAL_COLOR,
      }),
    )
  }
  if (!geometry.hasAttribute('normal')) geometry.computeVertexNormals()
  return new Mesh(geometry, neutralMaterial(geometry))
}

/**
 * Base URL for files referenced by a model (glTF buffers/textures, OBJ materials). The protocol
 * handler decodes the whole path, so appending a raw relative path to the encoded directory works.
 */
function resourceBase(path: string): string {
  return fileUrl(dirWithSeparator(path))
}

/** FileLoader that decodes data: URIs itself – the CSP's connect-src does not allow fetching them. */
class DataUriFileLoader extends FileLoader {
  override load(
    url: string,
    onLoad?: (data: string | ArrayBuffer) => void,
    onProgress?: (event: ProgressEvent) => void,
    onError?: (err: unknown) => void,
  ): void {
    if (!url.startsWith('data:')) {
      super.load(url, onLoad, onProgress, onError)
      return
    }
    queueMicrotask(() => {
      let data: ArrayBuffer
      try {
        data = decodeDataUri(url).buffer
      } catch (e) {
        onError?.(e)
        return
      }
      onLoad?.(this.responseType === 'arraybuffer' ? data : new TextDecoder().decode(data))
    })
  }
}

async function loadGltf(path: string): Promise<Object3D> {
  const loader = new GLTFLoader()
  loader.register((parser) => {
    // GLTFLoader prefers ImageBitmapLoader, which fetch()es blob: URLs of embedded textures –
    // the CSP's connect-src does not allow that. TextureLoader uses <img>, which img-src allows.
    const textureLoader = new TextureLoader(parser.options.manager)
    textureLoader.setCrossOrigin(parser.options.crossOrigin)
    parser.textureLoader = textureLoader
    const fileLoader = new DataUriFileLoader(parser.options.manager)
    fileLoader.setResponseType('arraybuffer')
    parser.fileLoader = fileLoader
    return { name: 'aiw_csp_safe_loaders' }
  })
  loader.setResourcePath(resourceBase(path))
  const gltf = await loader.loadAsync(fileUrl(path))
  return gltf.scene
}

async function loadObj(path: string): Promise<{ object: Object3D; textured: boolean }> {
  const response = await fetch(fileUrl(path))
  if (!response.ok) throw new Error(`HTTP ${response.status}`)
  const text = await response.text()
  const loader = new OBJLoader()
  const library = objMaterialLibrary(text)
  let textured = false
  if (library) {
    try {
      const mtl = new MTLLoader()
      mtl.setResourcePath(resourceBase(path))
      const dir = dirWithSeparator(path)
      const materials = await mtl.loadAsync(fileUrl(joinPath(dir, library)))
      materials.preload()
      loader.setMaterials(materials)
      textured = true
    } catch {
      // Missing or broken .mtl file: fall back to the neutral material.
    }
  }
  return { object: loader.parse(text), textured }
}

/** Loads a supported 3D file into an Object3D (not yet centered). */
export async function loadModel(path: string, name: string): Promise<Object3D> {
  const kind = modelLoaderKind(name)
  switch (kind) {
    case 'gltf':
      return loadGltf(path)
    case 'obj': {
      const { object, textured } = await loadObj(path)
      if (!textured) {
        object.traverse((child) => {
          if (child instanceof Mesh) {
            disposeMaterial(child.material)
            child.material = neutralMaterial(child.geometry)
          }
        })
      }
      return object
    }
    case 'stl': {
      const geometry = await new STLLoader().loadAsync(fileUrl(path))
      return wrap(meshFromGeometry(geometry, false))
    }
    case 'ply': {
      const data = await fetchBuffer(path)
      const header = new TextDecoder().decode(data.slice(0, Math.min(data.byteLength, 4096)))
      const geometry = new PLYLoader().parse(data)
      return wrap(meshFromGeometry(geometry, !plyHasFaces(header)))
    }
    default:
      throw new Error('Dateiformat wird nicht unterstützt.')
  }
}

async function fetchBuffer(path: string): Promise<ArrayBuffer> {
  const response = await fetch(fileUrl(path))
  if (!response.ok) throw new Error(`HTTP ${response.status}`)
  return response.arrayBuffer()
}

function wrap(object: Object3D): Group {
  const group = new Group()
  group.add(object)
  return group
}

/** Vertex/triangle counts of all meshes and point clouds. */
export function modelStats(root: Object3D): ModelStats {
  const stats: ModelStats = { vertices: 0, triangles: 0, points: 0 }
  root.traverse((child) => {
    if (child instanceof Mesh || child instanceof Points) {
      const geometry = child.geometry as BufferGeometry
      const position = geometry.getAttribute('position') as { count: number } | undefined
      const count = position?.count ?? 0
      stats.vertices += count
      if (child instanceof Points) stats.points += count
      else stats.triangles += triangleCount(count, geometry.index?.count ?? null)
    }
  })
  return stats
}

/** Toggles wireframe rendering on every mesh material. */
export function setWireframe(root: Object3D, enabled: boolean): void {
  root.traverse((child) => {
    if (!(child instanceof Mesh)) return
    const materials: Material[] = Array.isArray(child.material) ? child.material : [child.material]
    for (const material of materials) {
      if ('wireframe' in material) {
        ;(material as MeshStandardMaterial).wireframe = enabled
        material.needsUpdate = true
      }
    }
  })
}

function disposeMaterial(material: Material | Material[]): void {
  for (const m of Array.isArray(material) ? material : [material]) {
    for (const value of Object.values(m)) {
      if (value && typeof value === 'object' && (value as Texture).isTexture) {
        ;(value as Texture).dispose()
      }
    }
    m.dispose()
  }
}

/** Frees the GPU resources (geometries, materials, textures) of a loaded model. */
export function disposeObject(root: Object3D): void {
  root.traverse((child) => {
    if (child instanceof Mesh || child instanceof Points) {
      ;(child.geometry as BufferGeometry).dispose()
      disposeMaterial(child.material as Material | Material[])
    }
  })
}
