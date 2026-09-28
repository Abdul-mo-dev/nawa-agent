import type { FileSearchResult } from './file-search-api'
import type { DirectoryEvidence, DirectoryRead, DirectoryValidation } from './directory-evidence'
import type { AnalyticsReadAction } from './analytics-api'
import type { AgentToolCall, ToolExecution, DirectoryEditorDescription, DirectoryWorkflowOptions, DirectoryWorkflowStatus, DirectoryInteractionReply } from '@genoffice/agent-core'

export interface DirectoryReviewEntry {
  location: string
  kind: string
  before?: string
  after?: string
}
export interface DirectoryConversion { source: string; to: string; sheet?: string }
export interface DirectoryQuality { checked: boolean; summary: string; detail?: string; warnings: string[]; images: { page: number; dataUrl: string }[] }
export interface DirectoryReview {
  quality?: DirectoryQuality
  format: string
  complete: boolean
  changed: number
  entries: DirectoryReviewEntry[]
  warnings: string[]
  operations?: { tool: string; summary: string; ok: boolean; input: string }[]
}
export interface DirectoryInspection extends DirectoryEditorDescription {
  id: string
  path: string
  sourceHash: string
  source: 'saved-file-snapshot'
  openedAt: number
}
export interface LinkedImage { path: string; hash: string; source: string }
export interface DirectoryActionScope { opened: string | null; files: string[]; directories: string[] }
export type DirectoryOperation = 'update' | 'create' | 'delete' | 'rename' | 'move' | 'copy' | 'create-folder' | 'delete-folder' | 'delete-permanently'
export const filesystemOperations: readonly DirectoryOperation[] = ['rename', 'move', 'copy', 'create-folder', 'delete-folder', 'delete-permanently']
export const isFilesystemOperation = (operation: DirectoryOperation): boolean => filesystemOperations.includes(operation)
export const isPermanentAction = (proposal: { operation: DirectoryOperation; permanent?: boolean }): boolean => proposal.operation === 'delete-permanently' || proposal.operation === 'delete-folder' && proposal.permanent === true
export const actionName = (operation: DirectoryOperation): string => ({ update: 'Update file', create: 'Create file', delete: 'Move file to Recycle Bin', rename: 'Rename file', move: 'Move file', copy: 'Copy file', 'create-folder': 'Create folder', 'delete-folder': 'Move folder to Recycle Bin', 'delete-permanently': 'Permanently delete file' })[operation]
export interface DirectoryWorkflowRequest { network?: boolean; media?: boolean; sources?: string[]; conversion?: DirectoryConversion; renderPreview?: boolean }
export interface DirectoryPrepareContext { settings?: unknown; task?: string }
export interface DirectoryProposal { operation: DirectoryOperation; path: string; instruction: string; workflow?: DirectoryWorkflowRequest; destination?: string; permanent?: boolean }

export interface DirectoryApproval {
  id: string
  operation: DirectoryOperation
  path: string
  instruction: string
  beforeHash: string | null
  destination?: string
  permanent?: boolean
  inventory?: { files: number; folders: number; bytes: number; entries: string[] }
  workflow?: DirectoryWorkflowRequest
  linkedImages?: string[]
  afterHash?: string
  beforeText?: string
  afterText?: string
  bytes?: number
  review?: DirectoryReview
}
export interface DirectoryCommit { path: string; operation: DirectoryOperation; backupPath?: string; destination?: string; permanent?: boolean; status?: 'partial'; warnings?: string[] }
export function directoryCommitText(result: DirectoryCommit): string {
  const label = result.status === 'partial' ? 'Partially completed action' : result.permanent || result.operation === 'delete-permanently' ? 'Permanently deleted'
    : ({ update: 'Updated', create: 'Created', delete: 'Moved to Recycle Bin', rename: 'Renamed', move: 'Moved', copy: 'Copied', 'create-folder': 'Created folder', 'delete-folder': 'Moved folder to Recycle Bin', 'delete-permanently': 'Permanently deleted' })[result.operation]
  return `${label}: ${result.path}${result.destination ? ` → ${result.destination}` : ''}${result.backupPath ? `\nOriginal backup: ${result.backupPath}` : ''}${result.warnings?.length ? `\n${result.warnings.join('\n')}` : ''}`
}
export interface DirectoryActionsApi {
  myAgentTools?(run: string, action: 'catalog' | 'execute', payload: unknown): Promise<import('./myagent-tools-api').MyAgentToolResponse>
  analytics?(run: string, action: AnalyticsReadAction, payload: unknown): Promise<unknown>
  searchContents(run: string, query: string, paths?: string[]): Promise<FileSearchResult>
  readFile(run: string, path: string, offset?: number, maxChars?: number): Promise<DirectoryRead>
  validateEvidence(run: string): Promise<DirectoryValidation>
  restoreEvidence(run: string, requests: { id: string; evidence: DirectoryEvidence[] }[]): Promise<string[]>
  checkCitation(path: string, sourceHash: string): Promise<boolean>
  validateFile(run: string, path: string): Promise<DirectoryQuality>
  inspect(run: string, path: string): Promise<DirectoryInspection>
  query(run: string, id: string, call: AgentToolCall): Promise<ToolExecution>
  closeInspection(run: string, id: string): Promise<void>
  verifyInspections(run: string, text: string): Promise<string | null>
  verify(id: string, text: string): Promise<string | null>
  begin(scope: DirectoryActionScope): Promise<string>
  propose(run: string, request: DirectoryProposal): Promise<DirectoryApproval>
  prepare(id: string, context?: DirectoryPrepareContext): Promise<DirectoryEditorDescription | null>
  pollWorkflow(id: string): Promise<DirectoryWorkflowStatus>
  respondWorkflow(id: string, reply: DirectoryInteractionReply): Promise<void>
  execute(id: string, call: AgentToolCall): Promise<ToolExecution>
  preview(id: string): Promise<DirectoryApproval>
  commit(id: string, confirmation?: string): Promise<DirectoryCommit>
  discard(id: string): Promise<void>
  cancel(run: string): Promise<void>
  copyPaths(paths: string[], destination: string): Promise<{ copied: { from: string; to: string }[]; failed: { path: string; error: string }[] }>
}
export const DIRECTORY_ACTION_CHANNEL = 'nawa:directory-action'
declare global { interface Window { nawaDirectory: DirectoryActionsApi } }
