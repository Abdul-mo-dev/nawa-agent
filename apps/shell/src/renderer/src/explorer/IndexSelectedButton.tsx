import { useEffect, useImperativeHandle, useRef, useState, type Ref } from 'react'
import { isWithin, pathKey } from './model'
import { fileCapabilities } from '../../../shared/file-capabilities'
import { Icon } from './Icons'
import { PanelDialog } from './PanelDialog'
import { usePanelActivity } from './panel-state'
import { useSidebarText } from './sidebar-i18n'

export interface SelectedFileActions {
  prepare(folder: string, paths: readonly string[], mode?: 'all' | 'analysis'): Promise<void>
}

/** The toolbar and context menu share one lock, progress subscription and on-demand details. */
export function IndexSelectedButton({
  folder,
  selectedFiles,
  onOpenSettings,
  actionsRef,
  onBusyChange,
}: {
  folder: string | null
  selectedFiles: string[]
  onOpenSettings(): void
  actionsRef?: Ref<SelectedFileActions>
  onBusyChange?(busy: boolean): void
}) {
  const { s } = useSidebarText()
  const [submitting, setSubmitting] = useState(false),
    [running, setRunning] = useState(false)
  const [errors, setErrors] = useState<string[]>([]),
    [detailsOpen, setDetailsOpen] = useState(false)
  const working = useRef(false),
    alive = useRef(true),
    refresh = useRef<() => void>(() => {})
  useEffect(() => {
    alive.current = true
    let checking = false,
      again = false
    const read = async () => {
      if (checking) {
        again = true
        return
      }
      checking = true
      try {
        do {
          again = false
          const results = await Promise.allSettled([
            window.nawaRag.progress(),
            window.nawaAnalytics.progress(),
          ])
          if (alive.current)
            setRunning(
              results.some((result) => result.status === 'fulfilled' && result.value.running),
            )
        } while (again && alive.current)
      } finally {
        checking = false
      }
    }
    refresh.current = () => {
      void read()
    }
    refresh.current()
    const offRag = window.nawaRag.onChanged(refresh.current),
      offData = window.nawaAnalytics.onChanged(refresh.current)
    return () => {
      alive.current = false
      offRag()
      offData()
    }
  }, [])
  const paths = [...new Set(selectedFiles)]
  const valid =
    !!folder &&
    paths.length > 0 &&
    paths.length <= 256 &&
    paths.every((path) => isWithin(path, folder))
  const busy = submitting || running
  useEffect(() => {
    onBusyChange?.(busy)
  }, [busy, onBusyChange])
  usePanelActivity(
    'ai',
    'selected-index',
    busy
      ? { kind: 'busy', text: s('Indexing selected files') }
      : errors.length
        ? {
            kind: 'error',
            text: s('Some files could not be prepared. See file status for details.'),
          }
        : null,
  )
  const prepare = async (
    requestedFolder: string,
    requestedPaths: readonly string[],
    mode: 'all' | 'analysis' = 'all',
  ) => {
    const requested = [...new Map(requestedPaths.map((path) => [pathKey(path), path])).values()]
    if (
      working.current ||
      busy ||
      !requestedFolder ||
      !requested.length ||
      requested.length > 256 ||
      !requested.every((path) => isWithin(path, requestedFolder))
    )
      return
    // Selection changes never broaden an in-flight request.
    working.current = true
    setSubmitting(true)
    setErrors([])
    const embed = async () => {
      const { settings } = await window.nawaRag.settings()
      const searchable = requested.filter(
        (path) => settings.backend === 'myagent' || fileCapabilities(path).search,
      )
      if (!searchable.length) return
      // Main records setup failures against the requested files for their status tooltips.
      await window.nawaRag.indexSelected(requestedFolder, searchable, true)
    }
    const tables = requested.filter((path) => fileCapabilities(path).analysis)
    try {
      const results = await Promise.allSettled([
        mode === 'all' ? embed() : Promise.resolve(),
        tables.length
          ? window.nawaAnalytics.prepareSelected(requestedFolder, tables)
          : Promise.resolve(),
      ])
      const problems: string[] = []
      for (const [index, result] of results.entries()) {
        if (result.status === 'rejected')
          problems.push(
            `${s(index === 0 ? 'File search' : 'Data analysis')}: ${result.reason instanceof Error ? result.reason.message : String(result.reason)}`,
          )
        else if (index === 1 && result.value) {
          const data = result.value as Awaited<
            ReturnType<typeof window.nawaAnalytics.prepareSelected>
          >
          if (data.failedFiles || data.blockedTables)
            problems.push(
              s(
                'Some tables could not be prepared. Hover over their analysis status in the file table for details.',
              ),
            )
        }
      }
      if (alive.current) {
        setErrors(problems)
      }
    } finally {
      working.current = false
      if (alive.current) {
        setSubmitting(false)
        refresh.current()
      }
    }
  }
  useImperativeHandle(actionsRef, () => ({ prepare }))
  const hint = busy
    ? 'Indexing selected files. Progress is shown in the file table.'
    : !paths.length || !folder
      ? 'Select files in the main panel, then click Index.'
      : paths.length > 256
        ? 'Select at most 256 files.'
        : !valid
          ? 'Select files inside the opened directory.'
          : 'Embed selected files and prepare their tables. Indexed files refresh automatically after saving.'
  return (
    <>
      <button
        type="button"
        className="nawa-index-selected"
        aria-label={s('Index selected files')}
        disabled={!valid || busy}
        aria-busy={busy}
        title={s(hint)}
        onClick={() => {
          if (valid && folder) void prepare(folder, paths)
        }}
      >
        <Icon
          name={busy ? 'refresh' : 'search'}
          size={14}
          className={busy ? 'nawa-index-spinner' : ''}
        />
        {s('Index')}
      </button>
      {errors.length > 0 && (
        <button
          type="button"
          className="ex-tool nawa-index-warning"
          aria-label={s('Indexing details')}
          title={s('Indexing details')}
          onClick={() => setDetailsOpen(true)}
        >
          <Icon name="info" size={16} />
        </button>
      )}
      <PanelDialog
        open={detailsOpen}
        title={s('Indexing details')}
        onClose={() => setDetailsOpen(false)}
      >
        {errors.map((error, index) => (
          <p key={index} role="alert">
            {error}
          </p>
        ))}
        <button
          type="button"
          className="set-btn"
          onClick={() => {
            setDetailsOpen(false)
            onOpenSettings()
          }}
        >
          {s('Knowledge settings')}
        </button>
      </PanelDialog>
    </>
  )
}
