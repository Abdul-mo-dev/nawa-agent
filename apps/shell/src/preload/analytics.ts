import { contextBridge, ipcRenderer } from 'electron'
import { ANALYTICS_CHANNEL, ANALYTICS_CHANGED, type AnalyticsApi } from '../shared/analytics-api'
const call=(action:string,...args:unknown[])=>ipcRenderer.invoke(ANALYTICS_CHANNEL,action,...args)
const api:AnalyticsApi={
  settings:()=>call('settings'),saveSettings:settings=>call('saveSettings',settings),
  importFolder:(folder,recursive,consent)=>call('import',folder,recursive,consent),
  progress:()=>call('progress'),cancel:()=>call('cancel'),statuses:(paths,verify)=>call('statuses',paths,verify),
  catalog:(folder,offset)=>call('catalog',folder,offset),review:(id,generation,policy)=>call('review',id,generation,policy),clear:folder=>call('clear',folder),
  onChanged:callback=>{const listener=()=>callback();ipcRenderer.on(ANALYTICS_CHANGED,listener);return()=>ipcRenderer.removeListener(ANALYTICS_CHANGED,listener)},
}
contextBridge.exposeInMainWorld('nawaAnalytics',api)
