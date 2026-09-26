import { isWithin, parentPath, pathKey } from '../explorer/model'

export interface DirectorySelection {
  readonly opened: string | null
  readonly files: readonly string[]
  readonly directories: readonly string[]
}
function valid(path: string): boolean {
  return !!path && !path.includes('\0') && (/^(?:[a-z]:[\\/]|[\\/])/i.test(path)) &&
    !path.replace(/\\/g, '/').split('/').some(part => part === '.' || part === '..')
}
function unique(paths: readonly string[]): readonly string[] {
  return Object.freeze([...new Map(paths.filter(valid).map(path => [pathKey(path), path])).values()])
}
/** Folders authorize names/metadata only. They never expand the file-read allowlist. */
export function selectionSnapshot(opened: string | null, files: readonly string[], directories: readonly string[]): DirectorySelection {
  return Object.freeze({ opened: opened && valid(opened) ? opened : null, files: unique(files), directories: unique(directories) })
}
export function selectionKey(scope: DirectorySelection): string {
  return JSON.stringify([scope.opened ? pathKey(scope.opened) : null,
    scope.files.map(pathKey).sort(), scope.directories.map(pathKey).sort()])
}
export function listingDirectories(scope: DirectorySelection): readonly string[] {
  return unique([...(scope.opened ? [scope.opened] : []), ...scope.directories])
}
export function displayPath(scope: DirectorySelection, path: string): string {
  if (scope.opened && isWithin(path, scope.opened)) {
    return path.replace(/\\/g, '/').slice(scope.opened.replace(/[\\/]+$/, '').length).replace(/^\/+/, '') || '.'
  }
  return path
}
/** Resolve only an exact, previously selected path. Never concatenate model input onto a root. */
export function resolveSelectionPath(scope: DirectorySelection, value: unknown, kind: 'file' | 'directory'): string | undefined {
  if (typeof value !== 'string' || value.includes('\0')) return undefined
  if (value.replace(/\\/g, '/').split('/').some(part => part === '..')) return undefined
  const candidates = kind === 'file' ? scope.files : listingDirectories(scope)
  const matches = candidates.filter(path => {
    if (pathKey(path) === pathKey(value)) return true
    const display = displayPath(scope, path).replace(/\\/g, '/')
    const relative = value.replace(/\\/g, '/')
    const windows = /^[a-z]:/i.test(path) || path.startsWith('\\\\') || path.startsWith('//')
    return windows ? display.toLowerCase() === relative.toLowerCase() : display === relative
  })
  return matches.length === 1 ? matches[0] : undefined
}
export function readFolderFor(path: string): string { return parentPath(path) }
