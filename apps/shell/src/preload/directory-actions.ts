import { FILE_SEARCH_CHANNEL, type FileSearchApi } from '../shared/file-search-api'
import { contextBridge, ipcRenderer } from 'electron'
import { DIRECTORY_ACTION_CHANNEL, type DirectoryActionsApi } from '../shared/directory-actions-api'
export function installDirectoryActionsApi(): void {
  const invoke = (action: string, ...args: unknown[]) => ipcRenderer.invoke(DIRECTORY_ACTION_CHANNEL, action, ...args)
  const api: DirectoryActionsApi = {
    searchContents: (run, query) => invoke('searchContents', run, query),
    validateFile: (run, path) => invoke('validateFile', run, path),
    inspect: (run, path) => invoke('inspect', run, path),
    query: (run, id, call) => invoke('query', run, id, call),
    closeInspection: (run, id) => invoke('closeInspection', run, id),
    verifyInspections: (run, text) => invoke('verifyInspections', run, text),
    verify: (id, text) => invoke('verify', id, text),
    begin: scope => invoke('begin', scope), propose: (run, request) => invoke('propose', run, request),
    prepare: (id, context) => invoke('prepare', id, context),
    pollWorkflow: id => invoke('pollWorkflow', id), respondWorkflow: (id, reply) => invoke('respondWorkflow', id, reply), execute: (id, call) => invoke('execute', id, call),
    preview: id => invoke('preview', id), commit: id => invoke('commit', id),
    discard: id => invoke('discard', id), cancel: run => invoke('cancel', run),
    copyPaths: (paths, target) => invoke('copyPaths', paths, target),
  }
  contextBridge.exposeInMainWorld('nawaDirectory', api)
  const search = (action: string, ...args: unknown[]) => ipcRenderer.invoke(FILE_SEARCH_CHANNEL, action, ...args)
  const fileSearch: FileSearchApi = {
    indexFolder: folder => search('index', folder), search: (folder, query, rerank) => search('search', folder, query, rerank),
    progress: () => search('progress'), cancel: () => search('cancel'), clear: () => search('clear'),
    settings: () => search('settings'), saveSettings: (endpoint, key) => search('saveSettings', endpoint, key),
  }
  contextBridge.exposeInMainWorld('nawaFileSearch', fileSearch)
}
