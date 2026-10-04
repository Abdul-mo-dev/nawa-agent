import { existsSync } from 'node:fs'
import { join } from 'node:path'

/** Pick a safe, unused PDF path inside the configured Nawa save directory. */
export function uniqueGeneratedPdfPath(
  dir: string,
  suggestedName: string,
  pathExists: (path: string) => boolean = existsSync,
): string {
  // Control characters are intentionally rejected from generated file names.
  // eslint-disable-next-line no-control-regex
  const invalidFileNameCharacters = /[/\\:*?"<>|\u0000-\u001f]/g
  // Strip path segments before replacing invalid characters. Node's basename
  // interprets a colon as a drive separator on Windows and can lose the stem.
  let fileName = String(suggestedName || 'merged.pdf')
    .split(/[/\\]/)
    .at(-1)!
    .replace(invalidFileNameCharacters, '_')
    .trim()
  if (!fileName || fileName === '.' || fileName === '..') fileName = 'merged.pdf'
  if (!/\.pdf$/i.test(fileName)) fileName += '.pdf'

  const stem = fileName.slice(0, -4)
  let candidate = join(dir, fileName)
  for (let i = 2; pathExists(candidate); i++) candidate = join(dir, `${stem}-${i}.pdf`)
  return candidate
}
