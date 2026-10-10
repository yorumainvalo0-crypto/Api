import { describe, expect, it } from 'vitest'
import {
  boxCenterAndRadius,
  decodeDataUri,
  dirWithSeparator,
  fileExtension,
  fitCameraDistance,
  guessMimeType,
  joinPath,
  mediaPreviewForName,
  modelLoaderKind,
  niceGridSize,
  objMaterialLibrary,
  plyHasFaces,
  previewKind,
  triangleCount,
  zoomAt,
} from '../src/renderer/src/features/media/media-utils'

describe('file names', () => {
  it('extracts lower-case extensions', () => {
    expect(fileExtension('C:\\out\\Model.GLB')).toBe('glb')
    expect(fileExtension('/tmp/a.b/c')).toBe('')
    expect(fileExtension('.gitignore')).toBe('')
    expect(fileExtension('archive.tar.gz')).toBe('gz')
  })

  it('maps extensions to loaders', () => {
    expect(modelLoaderKind('a.glb')).toBe('gltf')
    expect(modelLoaderKind('a.gltf')).toBe('gltf')
    expect(modelLoaderKind('a.OBJ')).toBe('obj')
    expect(modelLoaderKind('a.stl')).toBe('stl')
    expect(modelLoaderKind('a.ply')).toBe('ply')
    expect(modelLoaderKind('a.fbx')).toBeNull()
    expect(modelLoaderKind('glb')).toBeNull()
  })

  it('guesses mime types', () => {
    expect(guessMimeType('x.svg')).toBe('image/svg+xml')
    expect(guessMimeType('x.ts')).toBe('text/plain')
    expect(guessMimeType('x.bin')).toBe('application/octet-stream')
  })

  it('chooses the preview kind', () => {
    expect(previewKind({ name: 'a.png', kind: 'image', mimeType: 'image/png' })).toBe('image')
    expect(previewKind({ name: 'a.svg', kind: 'text', mimeType: 'image/svg+xml' })).toBe('image')
    expect(previewKind({ name: 'a.stl', kind: 'file', mimeType: 'model/stl' })).toBe('model3d')
    expect(previewKind({ name: 'a.pdf', kind: 'pdf', mimeType: 'application/pdf' })).toBe('pdf')
    expect(previewKind({ name: 'a.py', kind: 'file', mimeType: '' })).toBe('text')
    expect(previewKind({ name: 'a.zip', kind: 'file', mimeType: 'application/zip' })).toBe('file')
    expect(mediaPreviewForName('x.webp')).toBe('image')
    expect(mediaPreviewForName('x.ply')).toBe('model3d')
    expect(mediaPreviewForName('x.ts')).toBeNull()
  })
})

describe('paths', () => {
  it('joins with the directory separator style', () => {
    expect(joinPath('C:\\proj', 'assets/a.png')).toBe('C:\\proj\\assets\\a.png')
    expect(joinPath('C:\\proj\\', 'a.png')).toBe('C:\\proj\\a.png')
    expect(joinPath('/home/u/proj', 'assets/a.png')).toBe('/home/u/proj/assets/a.png')
  })

  it('extracts the directory', () => {
    expect(dirWithSeparator('C:\\out\\m.gltf')).toBe('C:\\out\\')
    expect(dirWithSeparator('/out/m.gltf')).toBe('/out/')
    expect(dirWithSeparator('m.gltf')).toBe('')
  })

  it('finds the OBJ material library', () => {
    expect(objMaterialLibrary('# x\nmtllib my model.mtl \nv 0 0 0')).toBe('my model.mtl')
    expect(objMaterialLibrary('v 0 0 0')).toBeNull()
  })
})

describe('data URIs', () => {
  it('decodes base64 and percent-encoded payloads', () => {
    expect([...decodeDataUri('data:application/octet-stream;base64,AAEC/w==')]).toEqual([
      0, 1, 2, 255,
    ])
    expect(new TextDecoder().decode(decodeDataUri('data:text/plain,a%20b'))).toBe('a b')
    expect(() => decodeDataUri('blob:x')).toThrow()
  })
})

describe('PLY headers', () => {
  it('detects faces vs. point clouds', () => {
    const mesh = 'ply\r\nformat ascii 1.0\r\nelement vertex 3\r\nelement face 1\r\nend_header\r\n'
    expect(plyHasFaces(mesh)).toBe(true)
    expect(plyHasFaces('ply\nelement vertex 100\nelement face 0\nend_header\n')).toBe(false)
    expect(plyHasFaces('ply\nelement vertex 100\nproperty float x\nend_header\nface 3')).toBe(false)
  })
})

describe('camera fitting', () => {
  it('computes center, size and radius', () => {
    const { center, size, radius } = boxCenterAndRadius([-1, 0, -2], [3, 2, 2])
    expect(center).toEqual([1, 1, 0])
    expect(size).toEqual([4, 2, 4])
    expect(radius).toBeCloseTo(3)
  })

  it('fits a sphere into the narrower field of view', () => {
    // 90° vertical fov, square viewport: d = r / sin(45°)
    expect(fitCameraDistance(1, 90, 1, 1)).toBeCloseTo(Math.SQRT2)
    // Portrait viewports need more distance than landscape ones.
    expect(fitCameraDistance(1, 45, 0.5)).toBeGreaterThan(fitCameraDistance(1, 45, 2))
    expect(fitCameraDistance(1, 45, 2)).toBeCloseTo(fitCameraDistance(1, 45, 1))
    // Degenerate input falls back to a unit radius.
    expect(fitCameraDistance(0, 45, 1)).toBeCloseTo(fitCameraDistance(1, 45, 1))
  })

  it('rounds grid sizes', () => {
    expect(niceGridSize(1)).toBe(5)
    expect(niceGridSize(0.03)).toBeCloseTo(0.1)
    expect(niceGridSize(40)).toBe(200)
    expect(niceGridSize(0)).toBe(5)
  })

  it('counts triangles', () => {
    expect(triangleCount(9, null)).toBe(3)
    expect(triangleCount(4, 6)).toBe(2)
  })
})

describe('image zoom', () => {
  it('zooms around the given point', () => {
    const next = zoomAt({ scale: 1, x: 0, y: 0 }, 2, 100, 50)
    expect(next).toEqual({ scale: 2, x: -100, y: -50 })
    // The point under the cursor stays in place: (p - t) / s is unchanged.
    expect((100 - next.x) / next.scale).toBe(100)
  })

  it('clamps the scale', () => {
    expect(zoomAt({ scale: 1, x: 0, y: 0 }, 1000).scale).toBe(20)
    expect(zoomAt({ scale: 1, x: 0, y: 0 }, 0.0001).scale).toBe(0.1)
  })
})
