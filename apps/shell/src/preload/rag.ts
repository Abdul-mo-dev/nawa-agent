import { contextBridge, ipcRenderer } from 'electron'
import { RAG_CHANNEL, RAG_CHANGED, type RagApi } from '../shared/rag-api'
const api: RagApi = {
  settings: () => ipcRenderer.invoke(RAG_CHANNEL, 'settings'),
  save: (settings, key) => ipcRenderer.invoke(RAG_CHANNEL, 'save', settings, key),
  test: (settings, key) => ipcRenderer.invoke(RAG_CHANNEL, 'test', settings, key),
  index: (folder, recursive, consent) => ipcRenderer.invoke(RAG_CHANNEL, 'index', folder, recursive, consent),
  indexSelected: (folder, paths, consent) => ipcRenderer.invoke(RAG_CHANNEL, 'indexSelected', folder, paths, consent),
  progress: () => ipcRenderer.invoke(RAG_CHANNEL, 'progress'),
  cancel: () => ipcRenderer.invoke(RAG_CHANNEL, 'cancel'),
  statuses: (paths, verify) => ipcRenderer.invoke(RAG_CHANNEL, 'statuses', paths, verify),
  clear: folder => ipcRenderer.invoke(RAG_CHANNEL, 'clear', folder),
  onChanged: callback => { const listener = () => callback(); ipcRenderer.on(RAG_CHANGED, listener); return () => ipcRenderer.off(RAG_CHANGED, listener) },
}
contextBridge.exposeInMainWorld('nawaRag', api)
