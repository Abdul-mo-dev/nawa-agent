import type { AnalyticsFileStatus, AnalyticsProgress } from '../../../shared/analytics-api'
import { FileStatusIcon, type FileStatusState } from '../explorer/FileStatusIcon'
import { pathKey } from '../explorer/model'
import { useSidebarText } from '../explorer/sidebar-i18n'
import { useFileStatuses } from '../explorer/useFileStatuses'

export function useAnalyticsStatuses(files: Array<{ path: string; mtimeMs: number; sizeBytes: number }>) {
  return useFileStatuses(files, window.nawaAnalytics, 'Analysis status is unavailable.')
}

export function AnalyticsBadge({ value, error, progress, path = value?.path }: {
  value?: AnalyticsFileStatus; error?: string; progress?: AnalyticsProgress | null; path?: string
}) {
  const { s } = useSidebarText()
  const current = progress?.running && path && pathKey(progress.current) === pathKey(path)
  const queued = progress?.running && path && progress.paths?.some(candidate => pathKey(candidate) === pathKey(path))
  let state: FileStatusState = 'waiting'
  let label = 'Not prepared'
  const details: string[] = []
  if (error) { state = 'failed'; label = 'Status unavailable'; details.push(error) }
  else if (current || value?.state === 'importing') {
    state = 'busy'; label = 'Preparing data…'
    if (current && progress?.message) details.push(progress.message)
    if (current && progress?.currentRows) details.push(s('{count} rows processed', { count: progress.currentRows.toLocaleString() }))
  } else if (queued && value?.state === 'not-imported') { label = 'Waiting to prepare data' }
  else if (value?.state === 'ready') {
    state = 'ready'; label = 'Ready for analysis'
    details.push(s('{tables} tables · {rows} included rows', { tables: value.tables, rows: value.rows.toLocaleString() }))
  } else if (value?.state === 'needs-review') { state = 'attention'; label = 'Needs a decision' }
  else if (value?.state === 'changed') { state = 'attention'; label = 'File changed — data needs updating' }
  else if (value?.state === 'failed') { state = 'failed'; label = 'Data preparation failed' }
  else if (value?.state === 'unsupported') { state = 'unavailable'; label = 'No table data' }
  else if (!value) { state = 'busy'; label = 'Checking file…' }
  if (!error && value?.message && state !== 'busy') details.push(value.message)
  return <FileStatusIcon state={state} label={s('Analysis') + ': ' + s(label)} details={details} />
}
