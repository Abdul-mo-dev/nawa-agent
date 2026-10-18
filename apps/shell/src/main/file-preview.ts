import { ipcMain, type WebContents } from 'electron'
import { readFile, stat } from 'node:fs/promises'
import { basename, extname } from 'node:path'
import { createHash } from 'node:crypto'
import sharp from 'sharp'
import {
  PREVIEW_FILE_EXTENSIONS,
  PREVIEW_IMAGE_EXTENSIONS,
  extensionPattern,
} from '@genoffice/file-formats'
import { readMessage } from '@genoffice/file-parse'
import { FILE_PREVIEW_CHANNEL, type FilePreview } from '../shared/file-preview'
import { ocrImage } from './rag/ocr'

export const PREVIEW_RE = extensionPattern(PREVIEW_FILE_EXTENSIONS)
export async function loadFilePreview(path: string): Promise<FilePreview> {
  const result: FilePreview = { path, name: basename(path) }
  try {
    const source = await stat(path)
    if (!source.isFile() || source.size > 64 * 1024 * 1024)
      throw new Error('Preview accepts individual files up to 64 MiB.')
    const extension = extname(path).slice(1).toLowerCase()
    if (!PREVIEW_FILE_EXTENSIONS.includes(extension)) throw new Error('Unsupported preview format.')
    const bytes = await readFile(path)
    if (bytes.length > 64 * 1024 * 1024) throw new Error('Preview exceeds 64 MiB.')
    result.sourceHash = createHash('sha256').update(bytes).digest('hex')
    if (PREVIEW_IMAGE_EXTENSIONS.includes(extension)) {
      // Normalize TIFF and other still frames for Chromium, using the existing image runtime.
      const png = await sharp(bytes, { limitInputPixels: 20_000_000, animated: false })
        .rotate()
        .png()
        .toBuffer()
      result.image = `data:image/png;base64,${png.toString('base64')}`
      const vision = await sharp(png)
        .resize({ width: 1536, height: 1536, fit: 'inside', withoutEnlargement: true })
        .flatten({ background: '#ffffff' })
        .jpeg({ quality: 85 })
        .toBuffer()
      result.visionImage = `data:image/jpeg;base64,${vision.toString('base64')}`
    } else result.message = await readMessage(bytes, extension as 'eml' | 'msg')
  } catch (error) {
    result.error = error instanceof Error ? error.message : String(error)
  }
  return result
}
export function registerFilePreviewIpc(
  isHome: (sender: WebContents) => boolean,
  isOpen: (path: string) => boolean,
): void {
  ipcMain.handle(
    FILE_PREVIEW_CHANNEL,
    async (event, action: unknown, path: unknown, sourceHash: unknown) => {
      if (event.senderFrame !== event.sender.mainFrame || !isHome(event.sender))
        throw new Error('Preview is only available in the workspace.')
      if (typeof path !== 'string' || !isOpen(path))
        throw new Error('Open this file before previewing it.')
      if (action !== 'read' && action !== 'ocr') throw new Error('Unknown preview action.')
      const result = await loadFilePreview(path)
      if (!isOpen(path)) throw new Error('Preview was closed.')
      if (action === 'ocr') {
        if (result.error) throw new Error(result.error)
        if (!result.image || typeof sourceHash !== 'string' || result.sourceHash !== sourceHash)
          throw new Error('The file changed. Refresh the preview before reading its text.')
        const text = await ocrImage(
          Buffer.from(result.image.split(',')[1], 'base64'),
          AbortSignal.timeout(90000),
        )
        if (!isOpen(path)) throw new Error('Preview was closed.')
        if (!text?.trim())
          throw new Error('Local OCR found no readable text, or the OCR helper is unavailable.')
        return text
      }
      return result
    },
  )
}
