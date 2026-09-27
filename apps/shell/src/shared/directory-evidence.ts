import type { MyAgentSource } from './myagent-tools-api'
import type { SourceRef } from './analytics-api'

/** Versioned evidence, never permission to expand an individual-file selection. */
export interface DirectoryEvidence {
  path: string
  hash: string
  myAgent?: MyAgentSource
  analytics?: SourceRef[]
}
export interface DirectoryValidation {
  evidence: DirectoryEvidence[]
  durationMs: number
  sourceCount: number
  httpRequests?: number
}
export interface DirectoryRead {
  path: string
  sourceHash: string
  start: number
  end: number
  total: number
  nextOffset: number | null
  untrustedDocumentText: string
}
export interface DirectoryCitation {
  id: string
  path: string
  sourceHash: string
  locator: string
  excerpt?: string
}
export interface HistoryRequest {
  id: string
  phase: 'user' | 'intermediate' | 'final' | 'receipt'
  outcome: 'running' | 'completed' | 'failed' | 'cancelled' | 'incomplete'
  evidence?: DirectoryEvidence[]
  catalog?: { path: string; content: string }
}
