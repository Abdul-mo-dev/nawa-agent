import type { ConversationHistoryApi, ConversationRecord, HistorySave, LegacyConversation } from '../../../shared/conversation-api'

/** Serialize saves per conversation; an old async response must never replace a newer draft. */
export class ConversationBuffer {
  private record: ConversationRecord
  private generation = 0
  private savedGeneration = 0
  private pending: Promise<void> | null = null
  private listeners = new Set<() => void>()
  private failure: string | null = null

  constructor(record: ConversationRecord, private readonly api: ConversationHistoryApi) { this.record = record }
  getSnapshot = (): ConversationRecord => this.record
  subscribe = (callback: () => void): (() => void) => {
    this.listeners.add(callback)
    return () => this.listeners.delete(callback)
  }
  get dirty(): boolean { return this.generation !== this.savedGeneration }
  get error(): string | null { return this.failure }
  private emit(): void { for (const callback of this.listeners) callback() }
  edit(change: (record: ConversationRecord) => ConversationRecord): void {
    const next = change(this.record)
    if (next === this.record) return
    if (next.id !== this.record.id) throw new Error('Cannot change a buffer\'s conversation ID.')
    this.record = next
    this.generation++
    this.emit()
  }
  /** Save at most one snapshot; suitable for the bounded autosave timer during streaming. */
  saveOnce = (): Promise<void> => {
    if (this.pending) return this.pending
    if (!this.dirty) return Promise.resolve()
    const generation = this.generation
    const record = this.record
    const payload: HistorySave = {
      id: record.id, revision: record.revision, draft: record.draft, modelId: record.modelId,
      messages: record.messages, baselineId: record.baselineId, lastChatAt: record.lastChatAt,
    }
    this.pending = this.api.save(payload).then(result => {
      this.savedGeneration = generation
      this.failure = null
      this.record = { ...this.record, revision: result.revision, updatedAt: result.updatedAt, title: result.title }
      this.emit()
    }).catch((error: unknown) => {
      this.failure = error instanceof Error ? error.message : String(error)
      // Notify without replacing the buffered content. The UI offers an explicit Retry.
      this.record = { ...this.record }
      this.emit()
      throw error
    }).finally(() => { this.pending = null })
    return this.pending
  }
  /** Use after cancelling a run and before switching chats or closing the sidebar. */
  flush = async (): Promise<void> => {
    if (this.pending) await this.pending
    while (this.dirty) await this.saveOnce()
  }
}

const detachedBuffers = new Set<ConversationBuffer>()
export function retainUntilSaved(buffer: ConversationBuffer): void {
  detachedBuffers.add(buffer)
  void buffer.flush().then(() => detachedBuffers.delete(buffer)).catch(() => undefined)
}
export async function flushDetachedBuffers(): Promise<void> {
  for (const buffer of detachedBuffers) { await buffer.flush(); detachedBuffers.delete(buffer) }
}

/** Import remaining legacy chats, not just the opened folder; never delete the source keys. */
export function collectLegacyChats(storage: Pick<Storage, 'length' | 'key' | 'getItem'>): LegacyConversation[] {
  const conversations = new Set<string>()
  for (let i = 0; i < storage.length; i++) {
    const name = storage.key(i) ?? ''
    for (const prefix of ['home-ws-chat:', 'home-ws-draft:']) {
      if (name.startsWith(prefix)) conversations.add(name.slice(prefix.length))
    }
  }
  const result: LegacyConversation[] = []
  for (const conversation of conversations) {
    let messages: unknown[] = []
    try { const parsed: unknown = JSON.parse(storage.getItem(`home-ws-chat:${conversation}`) ?? '[]'); if (Array.isArray(parsed)) messages = parsed }
    catch { /* A corrupt transcript must not block importing other chats. */ }
    const draft = storage.getItem(`home-ws-draft:${conversation}`) ?? ''
    if (!messages.length && !draft) continue
    const folder = conversation === 'nawa-main-selection' ? null : conversation
    result.push({ key: `home-ws-chat:${conversation}`, folder,
      folderName: folder?.replace(/\\/g, '/').split('/').filter(Boolean).pop() || 'Workspace',
      draft, modelId: storage.getItem(`nawa.chat-model:${conversation}`) || '', messages })
  }
  return result
}
let initialization: Promise<{ databasePath: string; imported: number }> | null = null
export function initializeHistory(): Promise<{ databasePath: string; imported: number }> {
  if (initialization) return initialization
  initialization = (async () => {
    if (!window.nawaHistory) throw new Error('History preload is missing. Rebuild the shell, fully close Nawa, and restart it.')
    const initial = await window.nawaHistory.initialize()
    let legacy: LegacyConversation[] = []
    try { legacy = collectLegacyChats(localStorage) } catch { /* localStorage can be disabled. */ }
    let imported = 0
    for (let i = 0; i < legacy.length; i += 20) {
      const result = await window.nawaHistory.initialize(legacy.slice(i, i + 20))
      imported += result.imported
    }
    return { databasePath: initial.databasePath, imported }
  })().catch((error: unknown) => { initialization = null; throw error })
  return initialization
}
