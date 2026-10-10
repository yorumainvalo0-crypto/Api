import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'

const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=',
  'base64',
)

/** Builds a valid binary glTF containing a single triangle (for 3D viewer tests). */
export function minimalGlb(): Buffer {
  const positions = new Float32Array([0, 0, 0, 1, 0, 0, 0, 1, 0])
  const bin = Buffer.from(positions.buffer)
  const json = JSON.stringify({
    asset: { version: '2.0' },
    scene: 0,
    scenes: [{ nodes: [0] }],
    nodes: [{ mesh: 0 }],
    meshes: [{ primitives: [{ attributes: { POSITION: 0 } }] }],
    accessors: [
      {
        bufferView: 0,
        componentType: 5126,
        count: 3,
        type: 'VEC3',
        min: [0, 0, 0],
        max: [1, 1, 0],
      },
    ],
    bufferViews: [{ buffer: 0, byteLength: bin.length }],
    buffers: [{ byteLength: bin.length }],
  })
  const pad = (b: Buffer, fill: number) =>
    Buffer.concat([b, Buffer.alloc((4 - (b.length % 4)) % 4, fill)])
  const jsonChunk = pad(Buffer.from(json), 0x20)
  const binChunk = pad(bin, 0)
  const header = Buffer.alloc(12)
  header.writeUInt32LE(0x46546c67, 0) // "glTF"
  header.writeUInt32LE(2, 4)
  header.writeUInt32LE(12 + 8 + jsonChunk.length + 8 + binChunk.length, 8)
  const chunk = (data: Buffer, type: number) => {
    const head = Buffer.alloc(8)
    head.writeUInt32LE(data.length, 0)
    head.writeUInt32LE(type, 4)
    return Buffer.concat([head, data])
  }
  return Buffer.concat([header, chunk(jsonChunk, 0x4e4f534a), chunk(binChunk, 0x004e4942)])
}

export interface MockComfy {
  url: string
  /** Workflows received on /prompt, in order. */
  prompts: Record<string, { class_type: string; inputs: Record<string, unknown> }>[]
  uploads: string[]
  close: () => Promise<void>
}

/**
 * Minimal ComfyUI API mock: /system_stats, /object_info, /upload/image, /prompt, /history, /view.
 * Workflows with a "SaveGLB" node return a GLB mesh, everything else a PNG.
 */
export interface MockComfyModels {
  checkpoints?: string[]
  unets?: string[]
  clips?: string[]
  vaes?: string[]
}

export async function startMockComfy(
  models: MockComfyModels = { checkpoints: ['sdxl_base.safetensors', 'sd15.ckpt'] },
): Promise<MockComfy> {
  const loaders: Record<string, [string, string[]]> = {
    CheckpointLoaderSimple: ['ckpt_name', models.checkpoints ?? []],
    UNETLoader: ['unet_name', models.unets ?? []],
    CLIPLoader: ['clip_name', models.clips ?? []],
    VAELoader: ['vae_name', models.vaes ?? []],
  }
  const prompts: MockComfy['prompts'] = []
  const uploads: string[] = []
  const pending = new Map<string, { is3d: boolean; polls: number }>()

  const server: Server = createServer((req, res) => {
    const chunks: Buffer[] = []
    req.on('data', (c: Buffer) => chunks.push(c))
    req.on('end', () => {
      const url = new URL(req.url ?? '/', 'http://localhost')
      const json = (status: number, body: unknown) => {
        res.writeHead(status, { 'content-type': 'application/json' })
        res.end(JSON.stringify(body))
      }
      if (url.pathname === '/system_stats') {
        return json(200, { system: { comfyui_version: '0.9.9-mock' } })
      }
      if (url.pathname.startsWith('/object_info/')) {
        const node = decodeURIComponent(url.pathname.slice('/object_info/'.length))
        const loader = loaders[node]
        if (!loader) return json(200, {})
        return json(200, { [node]: { input: { required: { [loader[0]]: [loader[1], {}] } } } })
      }
      if (url.pathname === '/upload/image' && req.method === 'POST') {
        const body = Buffer.concat(chunks).toString('latin1')
        const name = /filename="([^"]+)"/.exec(body)?.[1] ?? 'upload.png'
        uploads.push(name)
        return json(200, { name, subfolder: '', type: 'input' })
      }
      if (url.pathname === '/prompt' && req.method === 'POST') {
        const body = JSON.parse(Buffer.concat(chunks).toString('utf8')) as {
          prompt: MockComfy['prompts'][number]
        }
        const nodes = Object.values(body.prompt)
        if (nodes.some((n) => n.class_type === 'MissingNode')) {
          return json(400, { error: { message: 'Cannot find node MissingNode' } })
        }
        prompts.push(body.prompt)
        const id = `p${prompts.length}`
        pending.set(id, { is3d: nodes.some((n) => n.class_type === 'SaveGLB'), polls: 0 })
        return json(200, { prompt_id: id, number: prompts.length, node_errors: {} })
      }
      if (url.pathname.startsWith('/history/')) {
        const id = decodeURIComponent(url.pathname.slice('/history/'.length))
        const job = pending.get(id)
        if (!job) return json(200, {})
        // Report "still running" on the first poll.
        if (job.polls++ === 0) return json(200, {})
        const outputs = job.is3d
          ? { '9': { '3d': [{ filename: 'mesh_00001_.glb', subfolder: '3d', type: 'output' }] } }
          : {
              '9': {
                images: [
                  { filename: 'ai-workbench_00001_.png', subfolder: '', type: 'output' },
                  { filename: 'preview.png', subfolder: '', type: 'temp' },
                ],
              },
            }
        return json(200, { [id]: { outputs, status: { status_str: 'success', completed: true } } })
      }
      if (url.pathname === '/view') {
        const isGlb = (url.searchParams.get('filename') ?? '').endsWith('.glb')
        res.writeHead(200, { 'content-type': isGlb ? 'model/gltf-binary' : 'image/png' })
        res.end(isGlb ? minimalGlb() : PNG)
        return
      }
      json(404, { error: 'not found' })
    })
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const { port } = server.address() as AddressInfo
  return {
    url: `http://127.0.0.1:${port}`,
    prompts,
    uploads,
    close: () => new Promise((resolve) => server.close(() => resolve())),
  }
}
