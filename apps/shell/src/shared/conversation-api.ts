import type { DirectoryActivity } from './directory-activity'
import type { DirectoryCitation, HistoryRequest } from './directory-evidence'
/** Narrow, typed IPC surface. No renderer SQL, database paths, or filesystem handles. */
export const CONVERSATION_CHANNEL = 'nawa:conversation-history:v1'

/** Internal scan reply; the preload converts it to a local rejection without an IPC failure. */
export function isHistoryScanCancelled(value: unknown): value is { cancelled: true } {
  return !!value && typeof value === 'object' && 'cancelled' in value && value.cancelled === true
}

export interface HistoryScope {
  opened: string | null
  files: readonly string[]
  directories: readonly string[]
}

export interface HistoryMessage {
  id: string
  role: 'user' | 'assistant'
  text: string
  instruction?: string
  createdAt: number
  error?: boolean
  streaming?: boolean
  contextKey?: string
  modelLabel?: string
  /** A complete, server-computed content fingerprint; absent for legacy/partial scans. */
  snapshotHash?: string
  /** Bounded local activity; excluded from model history. */
  activity?: DirectoryActivity
  request?: HistoryRequest
  citations?: DirectoryCitation[]
  /** Selection captured at send time; never reconstructed from the live Explorer. */
  scope?: HistoryScope
}

export interface ConversationVersion {
  id: string
  label: string
  createdAt: number
  sourceMessageId: string | null
  parentVersionId?: string | null
  kind: 'original' | 'edit' | 'retry' | 'regenerate' | 'delete'
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
  archivedAt?: number | null
  trashedAt?: number | null
  sourceConversationId?: string | null
}
export interface ConversationRecord extends ConversationSummary {
  revision: number
  draft: string
  messages: HistoryMessage[]
  baselineId: string | null
  lastChatAt: number | null
  activeVersionId?: string
  versions?: ConversationVersion[]
  /** Committed file outcomes survive changing or removing the visible continuation. */
  actions?: HistoryMessage[]
}
export interface ConversationExport {
  conversation: ConversationRecord
  versions: Array<ConversationVersion & { messages: HistoryMessage[]; draft: string }>
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
  /** Incremental checkpoint: supplied messages are upserts, not the whole transcript. */
  delta?: boolean
  removedIds?: string[]
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
  list(input: {
    folder?: string | null
    query?: string
    offset?: number
    view?: 'active' | 'archived' | 'trash'
  }): Promise<{
    conversations: ConversationSummary[]
    total: number
  }>
  create(input: {
    folder: string | null
    folderName: string
    modelId?: string
  }): Promise<ConversationRecord>
  get(id: string): Promise<ConversationRecord>
  export(id: string): Promise<ConversationExport>
  save(input: HistorySave): Promise<{ revision: number; updatedAt: number; title: string }>
  rename(id: string, title: string): Promise<void>
  delete(id: string): Promise<void>
  restore(id: string): Promise<void>
  purge(id: string): Promise<void>
  archive(id: string, archived: boolean): Promise<void>
  branch(input: { id: string; revision: number; messageId: string }): Promise<ConversationRecord>
  revise(input: {
    id: string
    revision: number
    messageId: string
    kind: 'edit' | 'retry' | 'regenerate' | 'delete'
    text?: string
  }): Promise<ConversationRecord>
  switchVersion(input: {
    id: string
    revision: number
    versionId: string
  }): Promise<ConversationRecord>
  capture(input: { id: string; scanId: string; scope: HistoryScope }): Promise<SnapshotSummary>
  compare(input: { id: string; scanId: string }): Promise<HistoryComparison>
  cancelScan(scanId: string): Promise<void>
  revealDatabase(): Promise<void>
}

declare global {
  interface Window {
    nawaHistory: ConversationHistoryApi
  }
}
