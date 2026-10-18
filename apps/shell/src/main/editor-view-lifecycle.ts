import type { WebContents } from 'electron'

/** Unload the document before destroying its view. Direct destruction of the live
 * Docs accessibility/editor tree can wedge Electron on Windows. Navigating to a
 * blank document releases that tree first, then the renderer can close normally. */
export async function disposeDocumentContents(contents: WebContents): Promise<void> {
  if (contents.isDestroyed()) return
  try {
    await contents.loadURL('about:blank')
  } catch (cause) {
    if (contents.isDestroyed()) return
    throw cause
  }
  if (!contents.isDestroyed()) contents.close({ waitForBeforeUnload: false })
}
