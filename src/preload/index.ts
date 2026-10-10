import { contextBridge, ipcRenderer, webUtils, type IpcRendererEvent } from 'electron'
import { IPC_EVENT_PREFIX, IPC_INVOKE_PREFIX } from '@shared/ipc-channels'
import type { WorkbenchApi } from '@shared/ipc'

const api: WorkbenchApi = {
  invoke: (channel, ...args) => ipcRenderer.invoke(`${IPC_INVOKE_PREFIX}${channel}`, ...args),
  on: (event, listener) => {
    const channel = `${IPC_EVENT_PREFIX}${event}`
    const wrapped = (_e: IpcRendererEvent, payload: Parameters<typeof listener>[0]) =>
      listener(payload)
    ipcRenderer.on(channel, wrapped)
    return () => {
      ipcRenderer.removeListener(channel, wrapped)
    }
  },
  getPathForFile: (file) => webUtils.getPathForFile(file),
}

contextBridge.exposeInMainWorld('api', api)
