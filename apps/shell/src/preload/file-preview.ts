import { contextBridge, ipcRenderer } from 'electron'
import { FILE_PREVIEW_CHANNEL, type FilePreviewApi } from '../shared/file-preview'
const api: FilePreviewApi = {
  read: (path) => ipcRenderer.invoke(FILE_PREVIEW_CHANNEL, 'read', path),
  recognizeText: (path, sourceHash) =>
    ipcRenderer.invoke(FILE_PREVIEW_CHANNEL, 'ocr', path, sourceHash),
}
contextBridge.exposeInMainWorld('nawaFilePreview', api)
