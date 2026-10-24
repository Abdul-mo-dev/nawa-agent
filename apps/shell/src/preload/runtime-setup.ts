import { contextBridge, ipcRenderer } from 'electron'
import { RUNTIME_SETUP_CHANNEL, type RuntimeSetupApi } from '../shared/runtime-setup-api'

const invoke = (action: string, ...args: unknown[]) =>
  ipcRenderer.invoke(RUNTIME_SETUP_CHANNEL, action, ...args)
const api: RuntimeSetupApi = {
  inspect: () => invoke('inspect'),
  install: (options) => invoke('install', options),
  cancel: () => invoke('cancel'),
  dismiss: () => invoke('dismiss'),
  activated: (kinds) => invoke('activated', kinds),
  reveal: () => invoke('reveal'),
  openLanguages: () => invoke('openLanguages'),
}
contextBridge.exposeInMainWorld('nawaRuntimeSetup', api)
