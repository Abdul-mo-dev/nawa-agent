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
  status: 'ready' | 'needs-index' | 'unavailable'
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
}
export interface MyAgentToolResult {
  tool: string
  succeeded: boolean
  content: string
  error: string | null
  sources: MyAgentSource[]
  warnings: string[]
  coverage?: MyAgentToolCoverage
}
export type MyAgentToolAction = 'catalog' | 'execute' | 'verify'
export type MyAgentToolResponse = MyAgentToolCatalog | MyAgentToolResult
