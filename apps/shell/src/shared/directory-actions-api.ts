import type { AgentToolCall, ToolExecution, DirectoryEditorDescription } from '@genoffice/agent-core'

export interface DirectoryActionScope { opened: string | null; files: string[]; directories: string[] }
export type DirectoryOperation = 'update' | 'create' | 'delete'
export interface DirectoryProposal { operation: DirectoryOperation; path: string; instruction: string }
export interface DirectoryApproval {
  id: string
  operation: DirectoryOperation
  path: string
  instruction: string
  beforeHash: string | null
  afterHash?: string
  beforeText?: string
  afterText?: string
  bytes?: number
}
export interface DirectoryCommit { path: string; operation: DirectoryOperation; backupPath?: string }
export interface DirectoryActionsApi {
  begin(scope: DirectoryActionScope): Promise<string>
  propose(run: string, request: DirectoryProposal): Promise<DirectoryApproval>
  prepare(id: string): Promise<DirectoryEditorDescription | null>
  execute(id: string, call: AgentToolCall): Promise<ToolExecution>
  preview(id: string): Promise<DirectoryApproval>
  commit(id: string): Promise<DirectoryCommit>
  discard(id: string): Promise<void>
  cancel(run: string): Promise<void>
  copyPaths(paths: string[], destination: string): Promise<{ copied: { from: string; to: string }[]; failed: { path: string; error: string }[] }>
}
export const DIRECTORY_ACTION_CHANNEL = 'nawa:directory-action'
declare global { interface Window { nawaDirectory: DirectoryActionsApi } }
