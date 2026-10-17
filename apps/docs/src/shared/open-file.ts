import { EDITOR_EXTENSIONS, extensionPattern } from '@genoffice/file-formats'

const DOCS_RE = extensionPattern(EDITOR_EXTENSIONS.docs)

export function findDocxPath(argv: readonly string[]): string | null {
  return (
    argv.find((arg) => {
      const value = arg.trim()
      return value.length > 0 && !value.startsWith('-') && DOCS_RE.test(value)
    }) ?? null
  )
}
