import { contextBridge, ipcRenderer } from 'electron'
import { CONVERSATION_CHANNEL, isHistoryScanCancelled, type ConversationHistoryApi } from '../shared/conversation-api'

// Expose named operations only. Arguments are validated again in the trusted worker.
const invoke = async (operation: string, payload?: unknown) => {
  const result = await ipcRenderer.invoke(CONVERSATION_CHANNEL, operation, payload)
  if ((operation === 'capture' || operation === 'compare') && isHistoryScanCancelled(result)) {
    throw Object.assign(new Error('Fingerprint check cancelled.'), { name: 'AbortError' })
  }
  return result
}
const api: ConversationHistoryApi = {
  initialize: legacy => invoke('initialize', { legacy }),
  list: input => invoke('list', input),
  create: input => invoke('create', input),
  get: id => invoke('get', { id }),
  save: input => invoke('save', input),
  rename: (id, title) => invoke('rename', { id, title }),
  delete: id => invoke('delete', { id }),
  capture: input => invoke('capture', input),
  compare: input => invoke('compare', input),
  cancelScan: scanId => invoke('cancelScan', { scanId }),
  revealDatabase: () => invoke('revealDatabase'),
}
contextBridge.exposeInMainWorld('nawaHistory', api)
