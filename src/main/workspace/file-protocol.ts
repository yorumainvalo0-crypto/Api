import { pathToFileURL } from 'node:url'
import { net, protocol } from 'electron'
import { FILE_PROTOCOL } from '@shared/ipc'
import { resolveFileUrl } from './paths'

/** Must run before `app.whenReady()`. */
export function registerFileProtocolScheme(): void {
  protocol.registerSchemesAsPrivileged([
    {
      scheme: FILE_PROTOCOL,
      privileges: {
        standard: true,
        secure: true,
        supportFetchAPI: true,
        corsEnabled: true,
        stream: true,
      },
    },
  ])
}

/**
 * Serves files from the app data directory and from project folders the user opened –
 * never arbitrary paths.
 */
export function handleFileProtocol(getRoots: () => string[]): void {
  protocol.handle(FILE_PROTOCOL, async (request) => {
    const target = resolveFileUrl(request.url, getRoots())
    if (!target) return new Response('Forbidden', { status: 403 })
    const response = await net.fetch(pathToFileURL(target).toString())
    // The renderer runs from file:// (origin "null"); allow it to fetch e.g. 3D models.
    const headers = new Headers(response.headers)
    headers.set('Access-Control-Allow-Origin', '*')
    return new Response(response.body, { status: response.status, headers })
  })
}
