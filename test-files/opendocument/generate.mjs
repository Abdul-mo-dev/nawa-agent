import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { createHash } from 'node:crypto'
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { delimiter, isAbsolute, join, relative, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { promisify } from 'node:util'
import JSZip from 'jszip'

const directory = import.meta.dirname
const workspace = resolve(directory, '../..')
const taskDirectory = join(workspace, '.task')
await mkdir(taskDirectory, { recursive: true })
const names =
  process.platform === 'win32' ? ['soffice.com', 'soffice.exe'] : ['soffice', 'libreoffice']
const paths = [
  ...(process.env.PATH ?? '').split(delimiter),
  'C:/Program Files/LibreOffice/program',
  '/Applications/LibreOffice.app/Contents/MacOS',
  '/usr/bin',
  '/opt/homebrew/bin',
]
const candidates = process.env.NAWA_LIBREOFFICE_PATH
  ? [process.env.NAWA_LIBREOFFICE_PATH]
  : paths.flatMap((path) => names.map((name) => join(path, name)))
let converter
for (const path of candidates) {
  if (
    await stat(path).then(
      (info) => info.isFile(),
      () => false,
    )
  ) {
    converter = path
    break
  }
}
assert(converter, 'Install LibreOffice or set NAWA_LIBREOFFICE_PATH to generate real ODF fixtures.')
const profile = await mkdtemp(join(taskDirectory, 'odf-generate-'))
const files = []
try {
  for (const [input, extension, filter, mime] of [
    ['document-sample.docx', 'odt', 'writer8', 'application/vnd.oasis.opendocument.text'],
    [
      'presentation-sample.pptx',
      'odp',
      'impress8',
      'application/vnd.oasis.opendocument.presentation',
    ],
  ]) {
    const source = join(directory, '../legacy-office/source', input)
    const { stdout } = await promisify(execFile)(
      converter,
      [
        `-env:UserInstallation=${pathToFileURL(profile).href}`,
        '--headless',
        '--nologo',
        '--nodefault',
        '--nofirststartwizard',
        '--convert-to',
        `${extension}:${filter}`,
        '--outdir',
        directory,
        source,
      ],
      { timeout: 90_000, windowsHide: true },
    )
    console.log(stdout.trim())
    const file = input.replace(/\.[^.]+$/, `.${extension}`)
    const bytes = await readFile(join(directory, file))
    const zip = await JSZip.loadAsync(bytes)
    assert.equal((await zip.file('mimetype').async('string')).trim(), mime)
    assert((await zip.file('content.xml').async('string')).includes('Nawa Legacy Office Test'))
    files.push({
      extension,
      file,
      sha256: createHash('sha256').update(bytes).digest('hex'),
      bytes: bytes.length,
      source: `../legacy-office/source/${input}`,
      filter,
    })
  }
  await writeFile(
    join(directory, 'manifest.json'),
    JSON.stringify({ generatedAt: new Date().toISOString(), files }, null, 2) + '\n',
  )
} finally {
  const owned = relative(taskDirectory, resolve(profile))
  assert(owned && !owned.startsWith('..') && !isAbsolute(owned))
  await rm(profile, { recursive: true, force: true })
}
