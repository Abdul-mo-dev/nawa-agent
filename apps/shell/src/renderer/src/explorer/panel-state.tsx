import { createContext, useContext, useEffect } from 'react'
import type { WorkspaceTab } from './workspace-tabs-model'

export interface PanelActivity {
  kind: 'busy' | 'attention' | 'error' | 'unsaved'
  text: string
}
export const PanelVisibility = createContext(true)
export const PanelActivityContext = createContext<
  (tab: WorkspaceTab, source: string, activity: PanelActivity | null) => void
>(() => {})

/** Tab changes and presentation changes do not own the lifetime of a running task. */
export function usePanelActivity(
  tab: WorkspaceTab,
  source: string,
  activity: PanelActivity | null,
) {
  const publish = useContext(PanelActivityContext)
  const kind = activity?.kind,
    text = activity?.text
  useEffect(() => {
    publish(tab, source, kind && text ? { kind, text } : null)
    return () => publish(tab, source, null)
  }, [publish, tab, source, kind, text])
}

export function mostImportantActivity(
  values: Array<PanelActivity | undefined>,
): PanelActivity | undefined {
  const priority = { attention: 0, error: 1, busy: 2, unsaved: 3 }
  return values
    .filter((value): value is PanelActivity => !!value)
    .sort((a, b) => priority[a.kind] - priority[b.kind])[0]
}
