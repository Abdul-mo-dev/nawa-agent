export const FILE_PREVIEW_CHANNEL = 'home:file-preview'
export interface FilePreview {
  path: string
  name: string
  sourceHash?: string
  image?: string
  /** A bounded view of the same frame for vision requests. */
  visionImage?: string
  message?: {
    subject: string
    headers: { name: string; value: string }[]
    body: string
    attachments: { name: string; bytes: number; mime?: string }[]
    warnings: string[]
  }
  error?: string
}
export interface FilePreviewApi {
  read(path: string): Promise<FilePreview>
  recognizeText(path: string, sourceHash: string): Promise<string>
}
declare global {
  interface Window {
    nawaFilePreview: FilePreviewApi
  }
}
