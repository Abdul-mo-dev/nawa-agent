/** Pure Explorer state helpers. File-system authorization always stays in main. */
export type Location = { kind: 'home' | 'recent' | 'starred' } | { kind: 'folder'; path: string }
export type ViewMode = 'details' | 'tiles'
export type SortKey = 'name' | 'modified' | 'type' | 'size'
export interface Item {
  path: string
  name: string
  kind: 'folder' | 'file'
  ext: string
  mtimeMs: number
  sizeBytes: number
  starred?: boolean
  missing?: boolean
}
export interface Preferences {
  navigationWidth: number
  inspectorWidth: number
  navigationVisible: boolean
  pane: 'ai' | 'details' | 'none'
  view: ViewMode
  compact: boolean
  sort: SortKey
  descending: boolean
}
export const DEFAULT_PREFERENCES: Preferences = {
  navigationWidth: 240, inspectorWidth: 360, navigationVisible: true,
  pane: 'ai', view: 'details', compact: false, sort: 'name', descending: false,
}
export const PREFERENCES_KEY = 'nawa.explorer.preferences.v1'
export const LAST_LOCATION_KEY = 'nawa.explorer.location.v1'
export const EXPANDED_KEY = 'nawa.explorer.expanded.v1'
export function clamp(value: number, min: number, max: number): number {
  return Number.isFinite(value) ? Math.max(min, Math.min(max, value)) : min
}
export function parsePreferences(raw: string | null): Preferences {
  try {
    const p = JSON.parse(raw || '{}') as Partial<Preferences> | null
    if (!p || typeof p !== 'object') return { ...DEFAULT_PREFERENCES }
    const d = DEFAULT_PREFERENCES
    return {
      navigationWidth: typeof p.navigationWidth === 'number' && Number.isFinite(p.navigationWidth) ? clamp(p.navigationWidth, 180, 380) : d.navigationWidth,
      inspectorWidth: typeof p.inspectorWidth === 'number' && Number.isFinite(p.inspectorWidth) ? clamp(p.inspectorWidth, 300, 560) : d.inspectorWidth,
      navigationVisible: typeof p.navigationVisible === 'boolean' ? p.navigationVisible : d.navigationVisible,
      pane: p.pane === 'ai' || p.pane === 'details' || p.pane === 'none' ? p.pane : d.pane,
      view: p.view === 'tiles' ? 'tiles' : 'details',
      compact: typeof p.compact === 'boolean' ? p.compact : d.compact,
      sort: p.sort === 'name' || p.sort === 'modified' || p.sort === 'type' || p.sort === 'size' ? p.sort : d.sort,
      descending: typeof p.descending === 'boolean' ? p.descending : d.descending,
    }
  } catch { return { ...DEFAULT_PREFERENCES } }
}
export function isWindowsPath(path: string): boolean { return /^[a-z]:[\\/]/i.test(path) || /^\\\\/.test(path) || /^\/\/[^/]/.test(path) }
export function pathKey(path: string): string {
  const windows = isWindowsPath(path)
  let value = path.replace(/\\/g, '/').replace(/\/+$/, '')
  if (!value && path.startsWith('/')) value = '/'
  return windows ? value.toLowerCase() : value
}
export function samePath(a: string, b: string): boolean { return pathKey(a) === pathKey(b) }
export function isWithin(path: string, root: string): boolean {
  const p = pathKey(path), r = pathKey(root)
  // Reject dot segments in editable addresses; never pretend UI checks authorize access.
  if (path.replace(/\\/g, '/').split('/').some(s => s === '.' || s === '..')) return false
  return p === r || p.startsWith(r === '/' ? '/' : r + '/')
}
export function parentPath(path: string): string {
  const clean = path.replace(/[\\/]+$/, '')
  const cut = Math.max(clean.lastIndexOf('/'), clean.lastIndexOf('\\'))
  if (cut < 0) return path
  if (cut === 0) return clean[0]
  if (cut === 2 && /^[a-z]:/i.test(clean)) return clean.slice(0, 3)
  return clean.slice(0, cut)
}
export function basename(path: string): string { return path.replace(/[\\/]+$/, '').split(/[\\/]/).pop() || path }
export function rootFor(path: string, roots: readonly { path: string }[]): string | undefined {
  return roots.filter(r => isWithin(path, r.path)).sort((a, b) => b.path.length - a.path.length)[0]?.path
}
export function breadcrumbs(path: string, root: string): { name: string; path: string }[] {
  if (!isWithin(path, root)) return [{ name: basename(path), path }]
  const clean = root.replace(/[\\/]+$/, '') || '/'
  const relative = path.slice(root.replace(/[\\/]+$/, '').length).replace(/^[\\/]+/, '')
  const separator = root.includes('\\') ? '\\' : '/'
  const result = [{ name: basename(root), path: root }]
  let current = clean
  for (const name of relative.split(/[\\/]/).filter(Boolean)) {
    current = current.replace(/[\\/]+$/, '') + separator + name
    result.push({ name, path: current })
  }
  return result
}
export function sortItems(items: readonly Item[], key: SortKey, descending: boolean, locale?: string): Item[] {
  const collator = new Intl.Collator(locale, { numeric: true, sensitivity: 'base' })
  return [...items].sort((a, b) => {
    if (a.kind !== b.kind) return a.kind === 'folder' ? -1 : 1
    let value = key === 'modified' ? a.mtimeMs - b.mtimeMs : key === 'size' ? a.sizeBytes - b.sizeBytes
      : key === 'type' ? collator.compare(a.ext, b.ext) : collator.compare(a.name, b.name)
    if (!value) value = collator.compare(a.name, b.name) || a.path.localeCompare(b.path)
    return descending ? -value : value
  })
}
export function selectRange(order: readonly string[], anchor: string | null, target: string, previous: ReadonlySet<string>, additive: boolean): Set<string> {
  const a = anchor ? order.indexOf(anchor) : -1, b = order.indexOf(target)
  const selected = new Set(additive ? previous : [])
  if (b < 0) return selected
  if (a < 0) selected.add(target)
  else for (const p of order.slice(Math.min(a, b), Math.max(a, b) + 1)) selected.add(p)
  return selected
}
export interface Navigation { entries: Location[]; index: number }
export function locationKey(location: Location): string { return location.kind === 'folder' ? `folder:${pathKey(location.path)}` : location.kind }
export function visit(history: Navigation, location: Location): Navigation {
  if (locationKey(history.entries[history.index]) === locationKey(location)) return history
  const entries = [...history.entries.slice(0, history.index + 1), location].slice(-80)
  return { entries, index: entries.length - 1 }
}
export function validName(name: string): boolean {
  return !!name.trim() && !/[<>:"/\\|?*\u0000-\u001f]/.test(name) && !/[. ]$/.test(name)
    && !/^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(name) && name !== '.' && name !== '..'
}
export function sizeLabel(bytes: number, locale?: string): string {
  if (!Number.isFinite(bytes) || bytes < 0) return '—'
  const units = ['B', 'KB', 'MB', 'GB', 'TB']
  const i = bytes === 0 ? 0 : Math.min(4, Math.floor(Math.log(bytes) / Math.log(1024)))
  return `${new Intl.NumberFormat(locale, { maximumFractionDigits: i ? 1 : 0 }).format(bytes / 1024 ** i)} ${units[i]}`
}
