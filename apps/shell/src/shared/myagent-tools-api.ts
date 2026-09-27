/** Sources are resolved in main from selected files, never from model-supplied IDs. */
export interface MyAgentSource {
  path: string
  server: string
  documentId: string
  contentHash: string
  indexRevision: string
  datasetRevision: string | null
}
export interface MyAgentToolDefinition { name: string; description: string; inputSchema: Record<string, unknown> }
export interface MyAgentFileReadiness {
  path: string
  status: 'ready' | 'unchecked' | 'needs-index' | 'unavailable'
  documentId?: string
  reason?: string
}
export interface MyAgentToolCoverage {
  selected: number
  requested: string[]
  covered: string[]
  completeSelection: boolean
}
export interface MyAgentToolCatalog {
  available: boolean
  /** Local request-scoped metadata cache; execution is never cached. */
  cacheHit?: boolean
  tools: MyAgentToolDefinition[]
  names?: string[] | null
  /** False for server metadata; this does not claim any selected file is ready. */
  scopeChecked?: boolean
  selectionFiltered?: boolean
  initialTools?: MyAgentToolDefinition[] | null
  /** Readiness is advisory metadata, never pinned as content evidence. */
  files?: MyAgentFileReadiness[]
  total: number
  nextOffset: number | null
  sources: MyAgentSource[]
  warnings: string[]
  disabled?: boolean
  diagnostics?: { httpRequests: number; durationMs: number }
  /** Set only by the local adapter after checking returned source bytes. */
  localSourcesVerified?: boolean
}
export interface MyAgentToolResult {
  tool: string
  succeeded: boolean
  content: string
  error: string | null
  sources: MyAgentSource[]
  warnings: string[]
  coverage?: MyAgentToolCoverage
  diagnostics?: { httpRequests: number; durationMs: number }
  localSourcesVerified?: boolean
}
export type MyAgentToolAction = 'catalog' | 'execute' | 'verify'
export type MyAgentToolResponse = MyAgentToolCatalog | MyAgentToolResult
