import type { FileSearchResult } from './file-search-api'
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
export type DirectoryOperation = 'update' | 'create' | 'delete'
export interface DirectoryWorkflowRequest { network?: boolean; media?: boolean; sources?: string[]; conversion?: DirectoryConversion; renderPreview?: boolean }
export interface DirectoryPrepareContext { settings?: unknown; task?: string }
export interface DirectoryProposal { operation: DirectoryOperation; path: string; instruction: string; workflow?: DirectoryWorkflowRequest }

export interface DirectoryApproval {
  id: string
  operation: DirectoryOperation
  path: string
  instruction: string
  beforeHash: string | null
  workflow?: DirectoryWorkflowRequest
  linkedImages?: string[]
  afterHash?: string
  beforeText?: string
  afterText?: string
  bytes?: number
  review?: DirectoryReview
}
export interface DirectoryCommit { path: string; operation: DirectoryOperation; backupPath?: string }
export interface DirectoryActionsApi {
  searchContents(run: string, query: string): Promise<FileSearchResult>
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
  commit(id: string): Promise<DirectoryCommit>
  discard(id: string): Promise<void>
  cancel(run: string): Promise<void>
  copyPaths(paths: string[], destination: string): Promise<{ copied: { from: string; to: string }[]; failed: { path: string; error: string }[] }>
}
export const DIRECTORY_ACTION_CHANNEL = 'nawa:directory-action'
declare global { interface Window { nawaDirectory: DirectoryActionsApi } }
