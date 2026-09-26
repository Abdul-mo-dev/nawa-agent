import { contextBridge, ipcRenderer } from 'electron'
import { DIRECTORY_ACTION_CHANNEL, type DirectoryActionsApi } from '../shared/directory-actions-api'
export function installDirectoryActionsApi(): void {
  const invoke = (action: string, ...args: unknown[]) => ipcRenderer.invoke(DIRECTORY_ACTION_CHANNEL, action, ...args)
  const api: DirectoryActionsApi = {
    begin: scope => invoke('begin', scope), propose: (run, request) => invoke('propose', run, request),
    prepare: id => invoke('prepare', id), execute: (id, call) => invoke('execute', id, call),
    preview: id => invoke('preview', id), commit: id => invoke('commit', id),
    discard: id => invoke('discard', id), cancel: run => invoke('cancel', run),
    copyPaths: (paths, target) => invoke('copyPaths', paths, target),
  }
  contextBridge.exposeInMainWorld('nawaDirectory', api)
}
