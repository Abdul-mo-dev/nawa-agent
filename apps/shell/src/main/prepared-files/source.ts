import { readdir } from 'node:fs/promises'
import { dirname, relative, sep } from 'node:path'
import { authorizePath, samePath, within } from '../directory-actions/file-safety'

/** A missing path is a deletion only when an authorized ancestor can be listed. */
export async function confirmedMissing(roots: string[], path: string): Promise<boolean> {
  const root = roots.find((candidate) => within(candidate, path))
  if (!root) return false
  await authorizePath(roots, root)
  let parent = dirname(path)
  while (within(root, parent)) {
    try {
      await authorizePath(roots, parent)
      const names = await readdir(parent)
      const next = relative(parent, path).split(sep)[0]!
      return !names.some((name) =>
        process.platform === 'win32' ? name.toLowerCase() === next.toLowerCase() : name === next,
      )
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
      if (samePath(root, parent)) return false
      parent = dirname(parent)
    }
  }
  return false
}
