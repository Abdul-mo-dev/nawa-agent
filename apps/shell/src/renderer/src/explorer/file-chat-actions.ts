import type { FolderRoot } from '../../../shared/home-api'
import type { RagFileStatus } from '../../../shared/rag-api'
import { fileCapabilities } from '../../../shared/file-capabilities'
import { isWithin, parentPath, pathKey, type Item } from './model'

/** A folder argument scopes the selected paths; it never grants recursive access. */
export function fileChatSelection(
  items: readonly Item[],
  roots: readonly FolderRoot[],
  folder: string | null,
) {
  const files = [
    ...new Map(
      items.filter((item) => item.kind === 'file').map((item) => [pathKey(item.path), item]),
    ).values(),
  ]
  const authorized =
    files.length > 0 &&
    files.length <= 256 &&
    files.every((item) =>
      roots.some((root) => (root.readable ?? root.usable) && isWithin(item.path, root.path)),
    )
  const commonRoot = roots.find(
    (root) =>
      (root.readable ?? root.usable) && files.every((item) => isWithin(item.path, root.path)),
  )
  const scope =
    authorized && !files.some((item) => item.missing)
      ? folder && files.every((item) => isWithin(item.path, folder))
        ? folder
        : files.length === 1
          ? parentPath(files[0].path)
          : (commonRoot?.path ?? null)
      : null
  return {
    files,
    folder: scope,
    tables: files.filter((item) => fileCapabilities(item.path).analysis),
    authorized,
  }
}

export function fileIndexAction(files: readonly Item[], statuses: Record<string, RagFileStatus>) {
  const byPath = new Map(Object.values(statuses).map((value) => [pathKey(value.path), value]))
  const searchable = files.some((file) => {
    const value = byPath.get(pathKey(file.path))
    return value ? !value.unsupported : fileCapabilities(file.path).search
  })
  const existing = files.some((file) => {
    const value = byPath.get(pathKey(file.path))
    return !!value && (value.status === 'embedded' || value.status === 'stale' || value.chunks > 0)
  })
  return { searchable, label: existing ? ('refreshForChat' as const) : ('indexForChat' as const) }
}
