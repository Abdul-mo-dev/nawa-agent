import { contextBridge, ipcRenderer } from 'electron'
import { LOCAL_MODELS_CHANNEL, type LocalModelsApi } from '../shared/local-models-api'
const invoke = (action: string, ...args: unknown[]) =>
  ipcRenderer.invoke(LOCAL_MODELS_CHANNEL, action, ...args)
const api: LocalModelsApi = {
  inspect: () => invoke('inspect'),
  save: (config, revision) => invoke('save', config, revision),
  control: (action, id) => invoke('control', action, id),
  choosePath: (kind) => invoke('choosePath', kind),
  releases: () => invoke('releases'),
  installEngine: (id) => invoke('installEngine', id),
  searchModels: (query) => invoke('searchModels', query),
  modelFiles: (repo) => invoke('modelFiles', repo),
  downloadModel: (repo, revision, name) => invoke('downloadModel', repo, revision, name),
  cancelDownload: () => invoke('cancelDownload'),
  removeModel: (path) => invoke('removeModel', path),
  revealDirectory: () => invoke('revealDirectory'),
}
contextBridge.exposeInMainWorld('nawaLocalModels', api)
