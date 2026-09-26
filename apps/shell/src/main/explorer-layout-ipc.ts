import { ipcMain } from 'electron'
import type { BrowserWindow, IpcMainEvent } from 'electron'
import { DEFAULT_EXPLORER_LAYOUT, EXPLORER_LAYOUT_CHANNEL, validExplorerLayout } from '../shared/explorer-layout'
import type { ExplorerLayout } from '../shared/explorer-layout'

/** Install per-window and remove on close. Documents/iframes cannot resize or hide views. */
export function registerExplorerLayout(window: BrowserWindow, apply: (layout: ExplorerLayout) => void): void {
  const listener = (event: IpcMainEvent, value: unknown) => {
    if (window.isDestroyed() || event.sender !== window.webContents || event.senderFrame !== window.webContents.mainFrame) return
    if (!validExplorerLayout(value)) return
    const zoom = window.webContents.getZoomFactor()
    apply({ left: value.left * zoom, top: value.top * zoom, bottom: value.bottom * zoom, suspended: value.suspended })
  }
  const reset = () => apply({ ...DEFAULT_EXPLORER_LAYOUT })
  ipcMain.on(EXPLORER_LAYOUT_CHANNEL, listener)
  window.webContents.on('did-start-loading', reset)
  window.webContents.on('render-process-gone', reset)
  window.once('closed', () => ipcMain.removeListener(EXPLORER_LAYOUT_CHANNEL, listener))
}
