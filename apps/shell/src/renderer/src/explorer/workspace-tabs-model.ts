export const WORKSPACE_TABS = ['ai', 'ragAnalytics', 'provider'] as const
export type WorkspaceTab = typeof WORKSPACE_TABS[number]

export function isWorkspaceTab(value: unknown): value is WorkspaceTab {
  return typeof value === 'string' && (WORKSPACE_TABS as readonly string[]).includes(value)
}

/** Manual activation: arrows move focus; Enter/Space activate the focused button. */
export function nextWorkspaceTab(current: WorkspaceTab, key: string, rtl = false): WorkspaceTab | null {
  const index = WORKSPACE_TABS.indexOf(current)
  if (key === 'Home') return WORKSPACE_TABS[0]
  if (key === 'End') return WORKSPACE_TABS[WORKSPACE_TABS.length - 1]
  const delta = key === 'ArrowRight' ? (rtl ? -1 : 1) : key === 'ArrowLeft' ? (rtl ? 1 : -1)
    : key === 'ArrowDown' ? 1 : key === 'ArrowUp' ? -1 : 0
  return delta ? WORKSPACE_TABS[(index + delta + WORKSPACE_TABS.length) % WORKSPACE_TABS.length] : null
}
