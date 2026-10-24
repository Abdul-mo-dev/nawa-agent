import type { RagFileStatus, RagProgress } from '../../../shared/rag-api'
import { RAG_IMAGE_EXTENSIONS, RAG_IMAGE_OCR_NOTICE } from '@genoffice/file-parse/formats'
import { FileStatusIcon, type FileStatusState } from '../explorer/FileStatusIcon'
import { pathKey } from '../explorer/model'
import { useSidebarText } from '../explorer/sidebar-i18n'
import { useFileStatuses } from '../explorer/useFileStatuses'
import { fileCapabilities } from '../../../shared/file-capabilities'
import { fileStatusHelp } from '../explorer/file-status-help'

const imageExtensions = new Set<string>(RAG_IMAGE_EXTENSIONS.map((extension) => '.' + extension))

export function useRagStatuses(files: Array<{ path: string; mtimeMs: number; sizeBytes: number }>) {
  return useFileStatuses(files, window.nawaRag, 'File search status is unavailable.')
}

export function RagBadge({
  value,
  error,
  progress,
  path = value?.path,
  expanded,
}: {
  value?: RagFileStatus
  error?: string
  progress?: RagProgress | null
  path?: string
  expanded?: boolean
}) {
  const { s } = useSidebarText()
  const active = progress?.running === true
  const job = path
    ? progress?.files?.find((file) => pathKey(file.path) === pathKey(path))
    : undefined
  const current = active && path && pathKey(progress.current) === pathKey(path)
  let state: FileStatusState = 'waiting'
  let label = 'Not indexed'
  const details: string[] = []
  let percent: number | undefined
  if (error) {
    state = 'failed'
    label = 'Status unavailable'
    details.push(error)
  } else if (value?.unsupported) {
    state = 'unavailable'
    label = 'Search unavailable for this format'
  } else if (active && job?.status === 'pending') {
    label = 'Waiting to index'
  } else if (
    (active && (job?.status === 'checking' || job?.status === 'indexing')) ||
    (current && !job) ||
    (!job && value?.status === 'embedding')
  ) {
    state = 'busy'
    label = job?.status === 'checking' ? 'Checking file…' : 'Indexing…'
    if (job?.message || (current && progress?.message))
      details.push(job?.message || progress!.message)
    if (job?.totalChunks && job.completedChunks !== undefined) {
      percent = Math.floor((job.completedChunks / job.totalChunks) * 100)
      details.push(
        s('{completed} of {total} passages embedded · {percent}%', {
          completed: job.completedChunks,
          total: job.totalChunks,
          percent,
        }),
      )
    }
  } else if (
    value?.status === 'failed' ||
    ((job?.status === 'failed' || job?.status === 'canceled') &&
      (active || !value || !['embedded', 'stale', 'unavailable'].includes(value.status)))
  ) {
    state = 'failed'
    label = job?.status === 'canceled' ? 'Indexing stopped' : 'Indexing failed'
    if (job?.error || value?.error) details.push(job?.error || value!.error!)
  } else if (value?.status === 'unavailable') {
    state = 'unavailable'
    label = 'Source file unavailable'
  } else if (value?.status === 'stale') {
    state = 'attention'
    label = /Embedding model\/settings changed/i.test(value.error ?? '')
      ? 'Embedding settings changed — index needs updating'
      : 'File changed — index needs updating'
    if (value.error) details.push(value.error)
    else
      details.push(
        s('The saved file content or embedding settings differ from the indexed snapshot.'),
      )
    details.push(
      s(
        'Right-click the file and choose Reindex / refresh for file chat. Unchanged content is reused.',
      ),
    )
  } else if (value?.status === 'embedded' || job?.status === 'embedded') {
    // The standard OCR coverage notice describes successful text indexing.
    // Additional warnings still need attention, even for a supported image.
    const imageTextIndexed =
      value?.status === 'embedded' &&
      value.chunks > 0 &&
      !value.error &&
      imageExtensions.has(fileCapabilities(path ?? value.path).extension) &&
      value.warnings?.length === 1 &&
      value.warnings[0] === RAG_IMAGE_OCR_NOTICE
    state = value?.partial && !imageTextIndexed ? 'attention' : 'ready'
    label = imageTextIndexed
      ? 'Image text indexed (OCR)'
      : value?.partial
        ? 'Text indexed with limitations'
        : 'Indexed for search'
    if (value?.chunks) details.push(s('{count} passages', { count: value.chunks }))
    if (value?.indexedAt)
      details.push(s('Indexed: {date}', { date: new Date(value.indexedAt).toLocaleString() }))
    if (value?.partial && !imageTextIndexed)
      details.push(
        s(
          'Extracted text was embedded. Some content, layout or visual information may be unavailable. See the details below.',
        ),
      )
  } else if (!value) {
    state = 'busy'
    label = 'Checking file…'
  }
  if (!error && value?.error && !details.includes(value.error)) details.push(value.error)
  const reason = error || job?.error || value?.error || ''
  if (state === 'failed' || state === 'unavailable')
    details.push(
      s(
        fileStatusHelp(
          reason ||
            (value?.unsupported
              ? 'Unsupported format'
              : value?.status === 'unavailable'
                ? 'File unavailable'
                : ''),
          'search',
        ),
      ),
    )
  else if (
    value?.status === 'stale' &&
    reason &&
    !/content changed|embedding profile changed/i.test(reason)
  )
    details.push(s(fileStatusHelp(reason, 'search')))
  details.push(...(value?.warnings ?? []).map((warning) => s(warning)))
  if (path) {
    const capability = fileCapabilities(path)
    if (capability.extension === '.xls')
      details.push(s('Save a copy as XLSX to search, inspect or analyze it.'))
    else if (!capability.inspection && capability.search)
      details.push(
        s(
          'Extracted text is available; native inspection and editing are unavailable for this format.',
        ),
      )
  }
  return (
    <FileStatusIcon
      state={state}
      label={s('Search') + ': ' + s(label)}
      details={details}
      percent={percent}
      expanded={expanded}
    />
  )
}
