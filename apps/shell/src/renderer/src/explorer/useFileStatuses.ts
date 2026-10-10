import { useEffect, useState } from 'react'

interface StatusApi<T, P> {
  statuses(paths: string[], verify?: boolean): Promise<T[]>
  progress(): Promise<P>
  onChanged(callback: () => void): () => void
}

/** Only request metadata for visible, authorized files; file events trigger source verification. */
export function useFileStatuses<T extends { path: string }, P>(
  files: Array<{ path: string; mtimeMs: number; sizeBytes: number }>,
  api: StatusApi<T, P> | undefined,
  unavailable: string,
) {
  const key = JSON.stringify(files.map(file => [file.path, file.mtimeMs, file.sizeBytes]))
  const [statuses, setStatuses] = useState<Record<string, T>>({})
  const [progress, setProgress] = useState<P | null>(null)
  const [error, setError] = useState('')
  useEffect(() => {
    let alive = true, pending = false, again = false, force = true, progressPending = false
    let timer: ReturnType<typeof setTimeout> | undefined
    const paths = (JSON.parse(key) as Array<[string, number, number]>).map(row => row[0]).slice(0, 256)
    setStatuses({})
    setProgress(null)
    setError('')
    if (!paths.length) return
    if (!api) { setError(unavailable); return }
    const refreshProgress = async () => {
      if (!alive || progressPending) return
      progressPending = true
      try {
        const value = await api.progress()
        if (alive) setProgress(value)
      } catch { /* Metadata remains useful if progress is temporarily unavailable. */ }
      finally { progressPending = false }
    }
    const refreshStatuses = async () => {
      if (!alive) return
      if (pending) { again = true; return }
      pending = true
      const verify = force
      force = false
      try {
        const values = await api.statuses(paths, verify)
        if (alive) {
          setStatuses(Object.fromEntries(values.map(value => [value.path, value])))
          setError('')
        }
      } catch (cause) {
        if (alive) setError(cause instanceof Error ? cause.message : String(cause))
      } finally {
        pending = false
        if (again && alive) { again = false; schedule() }
      }
    }
    // Progress continues to refresh even while source verification is waiting for a worker.
    const refresh = () => { void refreshProgress(); void refreshStatuses() }
    const schedule = () => {
      if (timer) return
      timer = setTimeout(() => { timer = undefined; refresh() }, 200)
    }
    const verify = () => { force = true; schedule() }
    const off = api.onChanged(schedule)
    const offFiles = window.aiOffice?.onFolderChanged?.(verify)
    window.addEventListener('focus', verify)
    window.addEventListener('nawa:rag-settings-changed', verify)
    const interval = setInterval(schedule, 5000)
    refresh()
    return () => {
      alive = false
      clearTimeout(timer)
      clearInterval(interval)
      off()
      offFiles?.()
      window.removeEventListener('focus', verify)
      window.removeEventListener('nawa:rag-settings-changed', verify)
    }
  }, [key, api, unavailable])
  return { statuses, progress, error }
}
