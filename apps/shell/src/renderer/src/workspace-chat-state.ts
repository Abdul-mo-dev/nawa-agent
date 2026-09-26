/** Browser-independent state helpers, also exercised by the workspace regression tests. */
export interface WorkspaceMessage {
  role: 'user' | 'assistant'
  text: string
  error?: boolean
  streaming?: boolean
  contextKey?: string
  modelLabel?: string
}
export interface WorkspaceStorage {
  getItem(key: string): string | null
  setItem(key: string, value: string): void
}

export const HISTORY_LIMIT = 40
export const MAX_CHAT_FILES = 6
export const CHARS_PER_FILE = 12_000

/** Keep the original keys so existing conversations survive the sidebar upgrade. */
export function historyKey(folder: string): string { return `home-ws-chat:${folder}` }
export function draftKey(folder: string): string { return `home-ws-draft:${folder}` }
export function excludedKey(folder: string): string { return `home-ws-excluded:${folder}` }

export function clearMessages(storage: WorkspaceStorage, folder: string): void {
  try {
    storage.setItem(historyKey(folder), '[]')
    storage.setItem(draftKey(folder), '')
  } catch { /* Storage can be unavailable or full; the current session still works. */ }
}

export function loadExcluded(storage: WorkspaceStorage, folder: string): string[] {
  try {
    const value: unknown = JSON.parse(storage.getItem(excludedKey(folder)) ?? '[]')
    return Array.isArray(value) ? value.filter((entry): entry is string => typeof entry === 'string') : []
  } catch { return [] }
}

export function saveExcluded(storage: WorkspaceStorage, folder: string, excluded: readonly string[]): void {
  try { storage.setItem(excludedKey(folder), JSON.stringify([...excluded].slice(0, 512))) } catch { /* ignore */ }
}

export function isUnderDir(dir: string, path: string): boolean {
  const root = dir.replace(/\\/g, '/').replace(/\/$/, '')
  const target = path.replace(/\\/g, '/')
  return target === root || target.startsWith(`${root}/`)
}

export function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes < 0) return '—'
  if (bytes >= 1048576) return `${(bytes / 1048576).toFixed(1)} MB`
  return `${Math.max(1, Math.round(bytes / 1024))} KB`
}

export function loadMessages(storage: WorkspaceStorage, folder: string): WorkspaceMessage[] {
  try {
    const value: unknown = JSON.parse(storage.getItem(historyKey(folder)) ?? '[]')
    if (!Array.isArray(value)) return []
    return value.filter((entry): entry is WorkspaceMessage => {
      if (!entry || typeof entry !== 'object') return false
      return (entry.role === 'user' || entry.role === 'assistant') &&
        typeof entry.text === 'string' && !entry.streaming
    }).slice(-HISTORY_LIMIT)
  } catch { return [] }
}

export function saveMessages(storage: WorkspaceStorage, folder: string, messages: WorkspaceMessage[]): void {
  try {
    storage.setItem(historyKey(folder), JSON.stringify(messages.filter((m) => !m.streaming).slice(-HISTORY_LIMIT)))
  } catch { /* Storage can be unavailable or full; the current session still works. */ }
}

export function relativeDocumentName(folder: string, file: string): string {
  const root = folder.replace(/\\/g, '/').replace(/\/$/, '')
  const path = file.replace(/\\/g, '/')
  // Names are presentation only. The main process independently authorizes every read.
  const insensitive = /^[A-Za-z]:\//.test(path) || path.startsWith('//')
  const prefix = `${root}/`
  const matches = insensitive
    ? path.toLowerCase().startsWith(prefix.toLowerCase()) : path.startsWith(prefix)
  return matches ? path.slice(prefix.length) : path.split('/').pop() || file
}

/** An epoch invalidates both preflight file reads and streamed responses on stop/unmount. */
export class WorkspaceRequestGate {
  private epoch = 0
  private active: number | null = null
  begin(): number | null {
    if (this.active !== null) return null
    this.active = ++this.epoch
    return this.active
  }
  isCurrent(id: number): boolean { return this.active === id }
  finish(id: number): boolean {
    if (!this.isCurrent(id)) return false
    this.active = null
    return true
  }
  cancel(): void { this.epoch++; this.active = null }
}
