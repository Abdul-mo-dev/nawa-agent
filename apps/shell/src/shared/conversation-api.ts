/** Narrow, typed IPC surface. No renderer SQL, database paths, or filesystem handles. */
export const CONVERSATION_CHANNEL = 'nawa:conversation-history:v1'

export interface HistoryScope {
  opened: string | null
  files: readonly string[]
  directories: readonly string[]
}

export interface HistoryMessage {
  id: string
  role: 'user' | 'assistant'
  text: string
  createdAt: number
  error?: boolean
  streaming?: boolean
  contextKey?: string
  modelLabel?: string
  /** A complete, server-computed content fingerprint; absent for legacy/partial scans. */
  snapshotHash?: string
}

export interface ConversationSummary {
  id: string
  folder: string | null
  folderName: string
  title: string
  createdAt: number
  updatedAt: number
  messageCount: number
  modelId: string
}
export interface ConversationRecord extends ConversationSummary {
  revision: number
  draft: string
  messages: HistoryMessage[]
  baselineId: string | null
  lastChatAt: number | null
}
export interface SnapshotSummary {
  id: string
  hash: string | null
  complete: boolean
  startedAt: number
  finishedAt: number
  fileCount: number
  directoryCount: number
  bytesHashed: number
  issues: string[]
}
export interface HistoryChange {
  kind: 'added' | 'removed' | 'modified' | 'unverified'
  path: string
  entryType: string
}
export interface HistoryComparison {
  status: 'unchanged' | 'changed' | 'incomplete' | 'no-baseline'
  since: number | null
  checkedAt: number
  added: number
  removed: number
  modified: number
  unverified: number
  changes: HistoryChange[]
  issues: string[]
  complete: boolean
  /** Only the first 100 changes are returned; counts always describe the full comparison. */
  truncated: boolean
}
export interface HistorySave {
  id: string
  revision: number
  draft: string
  modelId: string
  messages: HistoryMessage[]
  /** Update the baseline only when a user message is actually committed. */
  baselineId: string | null
  lastChatAt: number | null
}
export interface LegacyConversation {
  key: string
  folder: string | null
  folderName: string
  draft: string
  modelId: string
  messages: unknown[]
}
export interface ConversationHistoryApi {
  initialize(legacy?: LegacyConversation[]): Promise<{ databasePath: string; imported: number }>
  list(input: { folder?: string | null; query?: string; offset?: number }): Promise<{
    conversations: ConversationSummary[]; total: number
  }>
  create(input: { folder: string | null; folderName: string; modelId?: string }): Promise<ConversationRecord>
  get(id: string): Promise<ConversationRecord>
  save(input: HistorySave): Promise<{ revision: number; updatedAt: number; title: string }>
  rename(id: string, title: string): Promise<void>
  delete(id: string): Promise<void>
  capture(input: { id: string; scanId: string; scope: HistoryScope }): Promise<SnapshotSummary>
  compare(input: { id: string; scanId: string }): Promise<HistoryComparison>
  cancelScan(scanId: string): Promise<void>
  revealDatabase(): Promise<void>
}

declare global {
  interface Window { nawaHistory: ConversationHistoryApi }
}
