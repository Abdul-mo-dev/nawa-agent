/** Tab order and keyboard behavior are shared by the UI and focused tests. */
export const INSPECTOR_TABS = ['ai', 'details', 'rag', 'analytics'] as const
export type InspectorTab = typeof INSPECTOR_TABS[number]
export function isInspectorTab(value: unknown): value is InspectorTab {
  return typeof value === 'string' && (INSPECTOR_TABS as readonly string[]).includes(value)
}
/** Manual activation: arrows move focus; Enter/Space activate the focused button. */
export function nextInspectorTab(current: InspectorTab, key: string, rtl = false): InspectorTab | null {
  const index = INSPECTOR_TABS.indexOf(current)
  if (key === 'Home') return INSPECTOR_TABS[0]
  if (key === 'End') return INSPECTOR_TABS[INSPECTOR_TABS.length - 1]
  const delta = key === 'ArrowRight' ? (rtl ? -1 : 1) : key === 'ArrowLeft' ? (rtl ? 1 : -1)
    : key === 'ArrowDown' ? 2 : key === 'ArrowUp' ? -2 : 0
  return delta ? INSPECTOR_TABS[(index + delta + INSPECTOR_TABS.length) % INSPECTOR_TABS.length] : null
}
