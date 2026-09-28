import { contextBridge, ipcRenderer } from 'electron'
import { MYAGENT_SETTINGS_CHANNEL, type MyAgentSettingsApi } from '../shared/myagent-settings-api'
const api: MyAgentSettingsApi = {
  inspect: () => ipcRenderer.invoke(MYAGENT_SETTINGS_CHANNEL, 'inspect'),
  diagnostics: () => ipcRenderer.invoke(MYAGENT_SETTINGS_CHANNEL, 'diagnostics'),
  documentTools: request => ipcRenderer.invoke(MYAGENT_SETTINGS_CHANNEL, 'documentTools', request),
  saveConfiguration: (url, revision, patch) => ipcRenderer.invoke(MYAGENT_SETTINGS_CHANNEL, 'saveConfiguration', url, revision, patch),
  local: () => ipcRenderer.invoke(MYAGENT_SETTINGS_CHANNEL, 'local'),
  saveLaunch: settings => ipcRenderer.invoke(MYAGENT_SETTINGS_CHANNEL, 'saveLaunch', settings),
  choosePath: kind => ipcRenderer.invoke(MYAGENT_SETTINGS_CHANNEL, 'choosePath', kind),
  generateKey: () => ipcRenderer.invoke(MYAGENT_SETTINGS_CHANNEL, 'generateKey'),
  control: action => ipcRenderer.invoke(MYAGENT_SETTINGS_CHANNEL, 'control', action),
  model: (action, id) => ipcRenderer.invoke(MYAGENT_SETTINGS_CHANNEL, 'model', action, id),
}
contextBridge.exposeInMainWorld('nawaMyAgent', api)
