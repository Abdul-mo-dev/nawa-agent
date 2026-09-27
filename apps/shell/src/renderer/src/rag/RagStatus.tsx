import { useEffect, useState } from 'react'
import type { RagFileStatus } from '../../../shared/rag-api'
import './rag.css'
export function useRagStatuses(files: Array<{ path: string; mtimeMs: number; sizeBytes: number }>): { statuses: Record<string, RagFileStatus>; error: string } {
  const key = JSON.stringify(files.map(file => [file.path, file.mtimeMs, file.sizeBytes]))
  const [statuses, setStatuses] = useState<Record<string, RagFileStatus>>({})
  const [error, setError] = useState('')
  useEffect(() => {
    let alive = true, pending = false, again = false, force = true
    let timer: ReturnType<typeof setTimeout> | undefined
    const paths = (JSON.parse(key) as Array<[string, number, number]>).map(row => row[0]).slice(0, 256)
    setStatuses({}); setError('')
    if (!window.nawaRag) { setError('RAG bridge unavailable. Rebuild the shell and its preload.'); return }
    const refresh = async () => {
      if (!alive) return
      if (pending) { again = true; return }
      pending = true; const verify = force; force = false
      try { const values = await window.nawaRag.statuses(paths, verify); if (alive) { setStatuses(Object.fromEntries(values.map(v => [v.path, v]))); setError('') } }
      catch (e) { if (alive) setError(e instanceof Error ? e.message : String(e)) }
      finally { pending = false; if (again && alive) { again = false; schedule() } }
    }
    const schedule = () => { if (timer) return; timer = setTimeout(() => { timer = undefined; void refresh() }, 250) }
    const verify = () => { force = true; schedule() }
    const off = window.nawaRag.onChanged(schedule)
    const offFiles = window.aiOffice.onFolderChanged(verify)
    window.addEventListener('focus', verify)
    const interval = setInterval(schedule, 5000)
    void refresh()
    return () => { alive = false; clearTimeout(timer); clearInterval(interval); off(); offFiles(); window.removeEventListener('focus', verify) }
  }, [key])
  return { statuses, error }
}
export function RagBadge({ value, error }: { value?: RagFileStatus; error?: string }) {
  const labels = { 'not-indexed': 'Not embedded', embedding: 'Embedding…', embedded: 'Embedded', stale: 'Changed — re-index', failed: 'Failed to embed' }
  const status = value?.status, label = error ? 'Status unavailable' : status ? labels[status] + (status === 'embedded' && value?.partial ? ' · text/partial' : '') : 'Checking…'
  const detail = [label, error || value?.error, value?.chunks ? `${value.chunks} chunks` : '', value?.indexedAt ? `Indexed: ${new Date(value.indexedAt).toLocaleString()}` : '', value?.sourceHash ? `SHA-256: ${value.sourceHash}` : '', ...(value?.warnings ?? [])].filter(Boolean).join('\n')
  return <span className={`nawa-rag-badge is-${error ? 'failed' : status ?? 'checking'}`} title={detail} aria-label={detail}>
    <span aria-hidden="true">{status === 'embedded' ? '✓' : status === 'embedding' ? '↻' : status === 'failed' || status === 'stale' || error ? '!' : '○'}</span> {label}
  </span>
}
