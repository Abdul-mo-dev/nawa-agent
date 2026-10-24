import { contextBridge, ipcRenderer } from 'electron'
import {
  REMOTE_EMBEDDING_CHANNEL,
  REMOTE_EMBEDDING_CHANGED,
  type RemoteEmbeddingApi,
} from '../shared/remote-models-api'
const invoke = (action: string, ...args: unknown[]) =>
  ipcRenderer.invoke(REMOTE_EMBEDDING_CHANNEL, action, ...args)
const api: RemoteEmbeddingApi = {
  list: () => invoke('list'),
  save: (profile, revision, key) => invoke('save', profile, revision, key),
  remove: (id, revision) => invoke('remove', id, revision),
  apply: (id, revision) => invoke('apply', id, revision),
  test: (profile, key) => invoke('test', profile, key),
  models: (profile, key) => invoke('models', profile, key),
  onChanged: (callback) => {
    const listener = () => callback()
    ipcRenderer.on(REMOTE_EMBEDDING_CHANGED, listener)
    return () => {
      ipcRenderer.removeListener(REMOTE_EMBEDDING_CHANGED, listener)
    }
  },
}
contextBridge.exposeInMainWorld('nawaRemoteEmbeddings', api)
