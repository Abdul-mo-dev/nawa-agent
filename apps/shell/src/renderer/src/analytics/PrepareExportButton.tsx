import { useSidebarText } from '../explorer/sidebar-i18n'
import { useRef } from 'react'

/** The existing directory chat owns the agent run, progress, cancellation and results. */
export function PrepareExportButton({ paths, folder, disabled, onPrepare }: {
  paths: readonly string[]; folder: string | null; disabled: boolean
  onPrepare: (paths: string[], folder: string | null) => void | Promise<void>
}) {
  const { s } = useSidebarText()
  const locked = useRef(false)
  const hint = !paths.length ? 'Select individual table files first.' : paths.length > 256 ? 'Select at most 256 files.'
    : 'Ask the agent to prepare and review selected tables, then export SQLite. Source files are kept unchanged.'
  return <button type="button" className="ws-chat-close" title={s(hint)} disabled={disabled || !paths.length || paths.length > 256}
    onClick={() => { if (locked.current) return; locked.current = true; void Promise.resolve(onPrepare([...paths], folder)).finally(() => { locked.current = false }) }}>{s('Prepare & export')}</button>
}
