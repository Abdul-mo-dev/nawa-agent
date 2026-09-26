import { contextBridge, ipcRenderer } from 'electron'

/** No generic IPC or filesystem API is exposed to page JavaScript. */
export function installDirectoryEditorBridge(): void {
  contextBridge.exposeInMainWorld('nawaEditorBridge', {
    onCommand: (handler: (command: unknown) => void) => {
      const listener = (_event: unknown, command: unknown) => handler(command)
      ipcRenderer.on('nawa:editor-command', listener)
      return () => ipcRenderer.removeListener('nawa:editor-command', listener)
    },
    reply: (id: string, result: unknown, error?: string) => {
      if (typeof id === 'string' && id.length < 100) ipcRenderer.send('nawa:editor-result', { id, result, error })
    },
  })
}
