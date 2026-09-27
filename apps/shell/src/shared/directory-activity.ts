/** Local UI diagnostics only. Never restore these records as model context. */
export type ActivityStatus = 'running' | 'waiting' | 'completed' | 'failed' | 'cancelled' | 'incomplete' | 'skipped'
export interface DirectoryActivityStep {
  id: string
  parentId?: string
  tool: string
  kind: 'preparation' | 'model' | 'tool' | 'native' | 'approval' | 'validation' | 'storage'
  status: ActivityStatus
  startedAt: number
  finishedAt?: number
  summary: string
  targets: string[]
  input?: string
  output?: string
  facts?: Record<string, unknown>
}
export interface DirectoryActivity {
  id: string
  model: string
  selectedFiles: number
  startedAt: number
  finishedAt?: number
  status: ActivityStatus
  steps: DirectoryActivityStep[]
  omitted: number
}
