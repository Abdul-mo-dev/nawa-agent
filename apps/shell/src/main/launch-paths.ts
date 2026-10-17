import { EDITOR_FILE_EXTENSIONS, extensionPattern } from '@genoffice/file-formats'
import { existsSync } from 'node:fs'

/** Every extension the suite opens; also the contract the packaged file
 *  associations must advertise (tests/file-associations.test.ts), so a file
 *  the app accepts is one the OS can send it. */
export const LAUNCHABLE_EXTS = EDITOR_FILE_EXTENSIONS

const SUPPORTED_LAUNCH_RE = extensionPattern(LAUNCHABLE_EXTS)
const UNSUPPORTED_LAUNCH_RE = /\.(rtf|pages|key|numbers)$/i

interface LaunchPayload {
  launchPaths?: unknown
  launchPath?: unknown
}

function payloadLaunchPaths(additionalData: unknown): string[] {
  if (!additionalData || typeof additionalData !== 'object') return []
  const data = additionalData as LaunchPayload
  const paths = Array.isArray(data.launchPaths)
    ? data.launchPaths.filter((path): path is string => typeof path === 'string' && path.length > 0)
    : []
  if (typeof data.launchPath === 'string' && data.launchPath.length > 0) paths.push(data.launchPath)
  return paths
}

export function collectLaunchPaths(
  argv: readonly string[],
  additionalData?: unknown,
  exists: (path: string) => boolean = existsSync,
): string[] {
  const supported = argv.filter((path) => SUPPORTED_LAUNCH_RE.test(path) && exists(path))
  const payload = payloadLaunchPaths(additionalData)
  const fallback =
    supported.length === 0 && payload.length === 0
      ? argv.find((path) => UNSUPPORTED_LAUNCH_RE.test(path) && exists(path))
      : undefined
  return [...new Set([...supported, ...payload, ...(fallback ? [fallback] : [])])]
}
