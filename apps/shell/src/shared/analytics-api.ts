/** Wire contracts contain JSON data only. The chat model never receives a database connection. */
export const ANALYTICS_CHANNEL = 'nawa:analytics'
export const ANALYTICS_CHANGED = 'nawa:analytics-changed'
export const ANALYTICS_VERSION = '1.0.0'
export type DataType = 'text' | 'integer' | 'decimal' | 'real' | 'date' | 'boolean'
export interface DataColumn {
  id: string
  name: string
  type: DataType
  scale: number
  role: 'identifier' | 'dimension' | 'measure'
  unit: string
  nullable: boolean
  description: string
}
export interface TablePolicy {
  name: string
  description: string
  grain: string
  headerRow: number
  firstRow: number
  lastRow: number | null
  firstColumn: number
  lastColumn: number
  columns: DataColumn[]
  key: string[]
  currencyColumn: string | null
  includeHiddenRows: boolean
  skipRows: number[]
  formulaPolicy: 'reject' | 'saved-cache'
  confirmed: boolean
}
export interface SourceRef { path: string; hash: string; datasetId: string; generation: string }
export interface Dataset {
  id: string
  path: string
  sourceHash: string
  generation: string
  name: string
  sheet: string
  range: string
  kind: string
  status: 'needs-review' | 'ready'
  policy: TablePolicy
  rows: number
  rawRows: number
  excludedRows: number
  formulaCells: number
  warnings: string[]
  profile: Record<string, unknown>
  preview: { row: number; values: string[] }[]
  importedAt: number
  preparedPolicy?: { policy: TablePolicy; validatedRows: number; excludedRows: number; createdAt: number; notes?: string[] }
  preparationError?: string
  approval?: { by: 'user' | 'agent'; at: number; reason: string }
}
export interface AnalyticsSettings {
  allowAgentPreparation: boolean
  allowAgentApproval: boolean
  maxFileMiB: number
  maxRows: number
  maxColumns: number
  queryTimeoutSeconds: number
  maxGroups: number
  resultRows: number
  retainedResults: number
}
export const DEFAULT_ANALYTICS_SETTINGS: AnalyticsSettings = {
  allowAgentPreparation: false,
  allowAgentApproval: false,
  maxFileMiB: 2048, maxRows: 2000000, maxColumns: 512,
  queryTimeoutSeconds: 45, maxGroups: 20000, resultRows: 100, retainedResults: 500,
}
export interface AnalyticsFileStatus {
  path: string
  state: 'not-imported' | 'importing' | 'needs-review' | 'ready' | 'changed' | 'failed' | 'unsupported'
  message: string
  tables: number
  rows: number
  sourceHash?: string
}
export interface AnalyticsProgress {
  running: boolean
  folder: string
  current: string
  scanned: number
  imported: number
  unchanged: number
  failed: number
  rows: number
  message: string
  incomplete: boolean
}
export interface AnalyticsPreparationSummary {
  selectedFileCount: number
  imported: number
  unchanged: number
  failedFiles: number
  unsupportedFiles: number
  approvedTables: number
  alreadyReady: number
  readyTables: number
  draftTables: number
  reviewTables: number
  blockedTables: number
  issues: { kind: string; path: string; reason: string; datasetId?: string; name?: string; sheet?: string }[]
  issuesTruncated: boolean
}
export interface AnalyticsTableExport {
  datasetId: string
  sourcePath: string
  name: string
  sheet: string
  generation: string
  sourceHash: string
  fileName: string
  sqlTable?: string
  rows: number
}
export interface AnalyticsPrepareExportResult {
  exportDirectory: string
  manifestPath: string
  databasePath: string
  exports: AnalyticsTableExport[]
  preparation: AnalyticsPreparationSummary
  sources: SourceRef[]
}
export type FilterOp = 'eq' | 'ne' | 'gt' | 'gte' | 'lt' | 'lte' | 'in' | 'contains' | 'is-null' | 'not-null'
export interface DataFilter { column: string; op: FilterOp; value?: unknown }
export interface GroupSpec { column: string; period?: 'day' | 'month' | 'year'; as?: string }
export interface DataMetric {
  op: 'count' | 'count-distinct' | 'sum' | 'mean' | 'min' | 'max' | 'ratio-of-sums'
  column?: string
  denominatorColumn?: string
  multiplyBy?: 1 | 100
  as: string
}
export interface JoinSpec { datasetId: string; leftKeys: string[]; rightKeys: string[]; kind: 'left' | 'inner' }
export interface DataQuery {
  datasetIds: string[]
  filters?: DataFilter[]
  groupBy?: GroupSpec[]
  metrics?: DataMetric[]
  columns?: string[]
  join?: JoinSpec
  orderBy?: { column: string; descending?: boolean }[]
  limit?: number
}
export interface AnalysisRequest {
  datasetIds: string[]
  method: 'describe' | 'correlation' | 'compare-periods'
  column?: string
  otherColumn?: string
  filters?: DataFilter[]
  dateColumn?: string
  groupColumn?: string
  current?: { from: string; to: string }
  previous?: { from: string; to: string }
}
export interface AnalyticsResult {
  id: string
  createdAt: number
  operation: string
  sources: SourceRef[]
  sql: string[]
  parameters: unknown[][]
  population: Record<string, unknown>
  columns: Record<string, unknown>[]
  rows: Record<string, unknown>[]
  totalResultRows: number
  displayedRows: number
  outputTruncated: boolean
  inputSampled: false
  warnings: string[]
  summary?: Record<string, unknown>
  request: unknown
}
export type AnalyticsAgentAction = 'discover' | 'describe' | 'query' | 'sql' | 'analyze' | 'result' | 'drill' | 'verify' | 'prepare' | 'propose-policy' | 'export-sqlite'
/** Compatibility alias for existing directory clients. Direct review/clear actions remain UI-only. */
export type AnalyticsReadAction = AnalyticsAgentAction
export interface AnalyticsEnvelope { value: unknown; sources: SourceRef[]; policyChanges?: { datasetId: string; previousGeneration: string; generation: string; sourceHash: string }[] }
export interface AnalyticsApi {
  settings(): Promise<{ settings: AnalyticsSettings; databasePath: string; backend: string }>
  saveSettings(settings: AnalyticsSettings): Promise<void>
  importFolder(folder: string, recursive: boolean, consent: boolean): Promise<AnalyticsProgress>
  progress(): Promise<AnalyticsProgress>
  cancel(): Promise<void>
  statuses(paths: string[], verify?: boolean): Promise<AnalyticsFileStatus[]>
  catalog(folder: string, offset?: number): Promise<{ datasets: Dataset[]; files: AnalyticsFileStatus[]; truncated: boolean; total: number; nextOffset: number | null }>
  review(datasetId: string, expectedGeneration: string, policy: TablePolicy): Promise<Dataset>
  clear(folder: string): Promise<void>
  onChanged(callback: () => void): () => void
}
declare global { interface Window { nawaAnalytics: AnalyticsApi } }
