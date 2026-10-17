import { execFile } from 'node:child_process'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { promisify } from 'node:util'

const executable =
  process.env.NAWA_LIBREOFFICE_PATH ||
  (process.platform === 'win32' ? 'C:/Program Files/LibreOffice/program/soffice.com' : 'soffice')
const profile = await mkdtemp(join(tmpdir(), 'nawa-fixture-profile-'))
try {
  for (const [input, extension, filter] of [
    ['doc', 'dot', 'MS Word 97 Vorlage'],
    ['ppt', 'pps', 'MS PowerPoint 97 AutoPlay'],
    ['ppt', 'pot', 'MS PowerPoint 97 Vorlage'],
  ]) {
    await promisify(execFile)(
      executable,
      [
        `-env:UserInstallation=${pathToFileURL(profile).href}`,
        '--headless',
        '--nologo',
        '--norestore',
        '--convert-to',
        `${extension}:${filter}`,
        '--outdir',
        import.meta.dirname,
        resolve(
          import.meta.dirname,
          '../../../../file-parse/tests/fixtures',
          `legacy-sample.${input}`,
        ),
      ],
      { windowsHide: true, timeout: 90_000 },
    )
  }
} finally {
  await rm(profile, { recursive: true, force: true })
}
