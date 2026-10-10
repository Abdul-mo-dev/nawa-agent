import type { RagFileStatus, RagProgress } from '../../../shared/rag-api'
import { FileStatusIcon, type FileStatusState } from '../explorer/FileStatusIcon'
import { pathKey } from '../explorer/model'
import { useSidebarText } from '../explorer/sidebar-i18n'
import { useFileStatuses } from '../explorer/useFileStatuses'

export function useRagStatuses(files: Array<{ path: string; mtimeMs: number; sizeBytes: number }>) {
  return useFileStatuses(files, window.nawaRag, 'File search status is unavailable.')
}

export function RagBadge({ value, error, progress, path = value?.path }: {
  value?: RagFileStatus; error?: string; progress?: RagProgress | null; path?: string
}) {
  const { s } = useSidebarText()
  const active = progress?.running === true
  const job = active && path ? progress.files?.find(file => pathKey(file.path) === pathKey(path)) : undefined
  const current = active && path && pathKey(progress.current) === pathKey(path)
  let state: FileStatusState = 'waiting'
  let label = 'Not indexed'
  const details: string[] = []
  let percent: number | undefined
  if (error) { state = 'failed'; label = 'Status unavailable'; details.push(error) }
  else if (job?.status === 'pending') { label = 'Waiting to index' }
  else if (job?.status === 'checking' || job?.status === 'indexing' || (current && !job) || (!job && value?.status === 'embedding')) {
    state = 'busy'; label = job?.status === 'checking' ? 'Checking file…' : 'Indexing…'
    if (job?.message || (current && progress?.message)) details.push(job?.message || progress!.message)
    if (job?.totalChunks && job.completedChunks !== undefined) {
      percent = Math.floor(job.completedChunks / job.totalChunks * 100)
      details.push(s('{completed} of {total} passages embedded · {percent}%', {
        completed: job.completedChunks, total: job.totalChunks, percent,
      }))
    }
  } else if (job?.status === 'failed' || job?.status === 'canceled' || value?.status === 'failed') {
    state = 'failed'; label = job?.status === 'canceled' ? 'Indexing stopped' : 'Indexing failed'
    if (job?.error || value?.error) details.push(job?.error || value!.error!)
  } else if (value?.status === 'stale') { state = 'attention'; label = 'File changed — index needs updating' }
  else if (value?.status === 'embedded' || job?.status === 'embedded') {
    state = value?.partial ? 'attention' : 'ready'
    label = value?.partial ? 'Partially indexed' : 'Indexed for search'
    if (value?.chunks) details.push(s('{count} passages', { count: value.chunks }))
    if (value?.indexedAt) details.push(s('Indexed: {date}', { date: new Date(value.indexedAt).toLocaleString() }))
  } else if (!value) { state = 'busy'; label = 'Checking file…' }
  if (!error && value?.error && !details.includes(value.error)) details.push(value.error)
  details.push(...(value?.warnings ?? []))
  return <FileStatusIcon state={state} label={s('Search') + ': ' + s(label)} details={details} percent={percent} />
}
