import { spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import { constants } from 'node:fs'
import { access, copyFile, mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { delimiter, extname, isAbsolute, join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import JSZip from 'jszip'
import {
  officeImportTarget,
  modernOfficePath,
  openDocumentMimeForPath,
  openDocumentManifestEncrypted,
  type OfficeImportExtension,
} from '@genoffice/file-formats'
import { assertZipInflatesWithinLimits } from '@genoffice/zip-gate'

export const MAX_LEGACY_IMPORT_BYTES = 64 * 1024 * 1024
export type LegacyOfficeErrorCode = 'missing' | 'tooLarge' | 'failed' | 'encrypted'

export class LegacyOfficeImportError extends Error {
  constructor(
    public readonly code: LegacyOfficeErrorCode,
    options?: ErrorOptions,
  ) {
    super(`Legacy Office import: ${code}`, options)
    this.name = 'LegacyOfficeImportError'
  }
}

/** No shell lookup: paths with spaces and document names remain literal arguments. */
export async function findLibreOffice(
  executablePath = process.env.NAWA_LIBREOFFICE_PATH,
): Promise<string | null> {
  const names =
    process.platform === 'win32' ? ['soffice.com', 'soffice.exe'] : ['soffice', 'libreoffice']
  const directories = (process.env.PATH ?? '').split(delimiter).filter(Boolean)
  if (process.platform === 'win32') {
    for (const root of [
      process.env.ProgramFiles,
      process.env['ProgramFiles(x86)'],
      'C:/Program Files',
    ]) {
      if (root) directories.push(join(root, 'LibreOffice', 'program'))
    }
  } else if (process.platform === 'darwin') {
    directories.push(
      '/Applications/LibreOffice.app/Contents/MacOS',
      '/opt/homebrew/bin',
      '/usr/local/bin',
    )
  } else {
    directories.push('/usr/bin', '/usr/local/bin', '/opt/libreoffice/program')
  }
  const candidates = executablePath
    ? [executablePath]
    : directories.flatMap((directory) => names.map((name) => join(directory, name)))
  for (const candidate of candidates) {
    try {
      if (!(await stat(candidate)).isFile()) continue
      await access(candidate, process.platform === 'win32' ? constants.F_OK : constants.X_OK)
      return resolve(candidate)
    } catch {
      // An explicit override is authoritative; a typo must not select another executable.
    }
  }
  return null
}

/** Terminate only this conversion's process tree; each run owns an isolated profile. */
function runConverter(
  executable: string,
  args: string[],
  timeoutMs: number,
  signal?: AbortSignal,
): Promise<void> {
  if (signal?.aborted)
    return Promise.reject(new LegacyOfficeImportError('failed', { cause: new Error('aborted') }))
  return new Promise((resolveRun, reject) => {
    const child = spawn(executable, args, {
      shell: false,
      windowsHide: true,
      detached: process.platform !== 'win32',
      stdio: 'pipe',
    })
    child.stdin.end()
    child.stdout.resume()
    let stderr = ''
    child.stderr.on('data', (c) => {
      stderr += c.toString()
      if (stderr.length > 4096) stderr = stderr.slice(-4096)
    })
    const killChild = () => {
      if (!child.pid) return
      if (process.platform === 'win32') {
        const killer = spawn(
          join(process.env.SystemRoot ?? 'C:/Windows', 'System32', 'taskkill.exe'),
          ['/PID', String(child.pid), '/T', '/F'],
          { windowsHide: true, stdio: 'ignore', shell: false },
        )
        killer.on('error', () => child.kill('SIGKILL'))
      } else {
        try {
          process.kill(-child.pid, 'SIGKILL')
        } catch {
          child.kill('SIGKILL')
        }
      }
    }
    let settled = false
    let timedOut = false
    const timer = setTimeout(() => {
      timedOut = true
      killChild()
    }, timeoutMs)
    const fail = (cause: unknown) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      signal?.removeEventListener('abort', onAbort)
      reject(new LegacyOfficeImportError('failed', { cause }))
    }
    const onAbort = () => {
      killChild()
      fail(new Error('aborted'))
    }
    signal?.addEventListener('abort', onAbort, { once: true })
    child.once('error', (error) => {
      fail(stderr ? new Error(stderr, { cause: error }) : error)
    })
    child.once('close', (code) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      signal?.removeEventListener('abort', onAbort)
      if (timedOut || code !== 0)
        reject(
          new LegacyOfficeImportError('failed', { cause: new Error(stderr || `exit ${code}`) }),
        )
      else resolveRun()
    })
  })
}

export interface LegacyOfficeImport {
  bytes: Buffer
  extension: OfficeImportExtension
  suggestSaveAs: string
  sourceHash?: string
}

/** Convert a private source copy and return bytes; no temporary editor paths escape. */
export async function importLegacyOffice(
  sourcePath: string,
  options: {
    executablePath?: string
    tempRoot?: string
    timeoutMs?: number
    signal?: AbortSignal
  } = {},
): Promise<LegacyOfficeImport> {
  const target = officeImportTarget(sourcePath)
  if (!target || !isAbsolute(sourcePath)) throw new LegacyOfficeImportError('failed')
  const sourceStat = await stat(sourcePath)
  if (!sourceStat.isFile()) throw new LegacyOfficeImportError('failed')
  if (sourceStat.size > MAX_LEGACY_IMPORT_BYTES) throw new LegacyOfficeImportError('tooLarge')
  const executable = await findLibreOffice(options.executablePath)
  if (!executable) throw new LegacyOfficeImportError('missing')
  if (options.signal?.aborted)
    throw new LegacyOfficeImportError('failed', { cause: new Error('aborted') })
  const tempRoot = options.tempRoot ?? tmpdir()
  await mkdir(tempRoot, { recursive: true })
  const workDir = await mkdtemp(join(tempRoot, 'nawa-legacy-office-'))
  if (options.signal?.aborted) {
    await rm(workDir, { recursive: true, force: true }).catch(() => {})
    throw new LegacyOfficeImportError('failed', { cause: new Error('aborted') })
  }
  try {
    const inputDir = join(workDir, 'input')
    const outputDir = join(workDir, 'output')
    const profileDir = join(workDir, 'profile')
    await Promise.all([
      mkdir(inputDir),
      mkdir(outputDir),
      mkdir(join(profileDir, 'user'), { recursive: true }),
    ])
    // Disable scripts and Windows OLE automation. Internal chart objects must
    // remain readable: DisableActiveContent would silently drop legacy charts.
    await writeFile(
      join(profileDir, 'user', 'registrymodifications.xcu'),
      '<?xml version="1.0"?><oor:items xmlns:oor="http://openoffice.org/2001/registry">' +
        '<item oor:path="/org.openoffice.Office.Common/Security/Scripting"><prop oor:name="MacroSecurityLevel" oor:op="fuse"><value>3</value></prop></item>' +
        '<item oor:path="/org.openoffice.Office.Common/Security/Scripting"><prop oor:name="DisableMacrosExecution" oor:op="fuse"><value>true</value></prop><prop oor:name="DisableOLEAutomation" oor:op="fuse"><value>true</value></prop><prop oor:name="BlockUntrustedRefererLinks" oor:op="fuse"><value>true</value></prop></item></oor:items>',
    )
    // Fixed safe filenames also prevent a source named like a CLI option becoming a switch.
    const extension = extname(sourcePath).slice(1).toLowerCase() as OfficeImportExtension
    const privateInput = join(inputDir, `document.${extension}`)
    await copyFile(sourcePath, privateInput)
    const copiedSize = (await stat(privateInput)).size
    if (copiedSize > MAX_LEGACY_IMPORT_BYTES) throw new LegacyOfficeImportError('tooLarge')
    const input = await readFile(privateInput)
    const sourceHash = createHash('sha256').update(input).digest('hex')
    const cfb = input
      .subarray(0, 8)
      .equals(Buffer.from([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1]))
    const zip =
      input.length >= 4 &&
      input[0] === 0x50 &&
      input[1] === 0x4b &&
      ((input[2] === 0x03 && input[3] === 0x04) ||
        (input[2] === 0x05 && input[3] === 0x06) ||
        (input[2] === 0x07 && input[3] === 0x08))
    const rtf = target === 'docx' && input.subarray(0, 5).toString('ascii') === '{\\rtf'
    if (!cfb && !zip && !rtf) throw new LegacyOfficeImportError('failed')
    if (cfb && input.includes(Buffer.from('EncryptedPackage', 'utf16le'))) {
      throw new LegacyOfficeImportError('encrypted')
    }
    // Legacy RC4-encrypted CFB files carry no EncryptedPackage stream, so no
    // fast pre-check can detect them here; they surface as 'failed' when the
    // converter cannot produce output. Do NOT block on heuristics.
    if (zip) await assertZipInflatesWithinLimits(input)
    const odfMime = openDocumentMimeForPath(sourcePath)
    if (odfMime) {
      if (!zip) throw new LegacyOfficeImportError('failed')
      const archive = await JSZip.loadAsync(input)
      const mime = await archive.file('mimetype')?.async('string')
      if (mime?.trim() !== odfMime || !archive.file('content.xml'))
        throw new LegacyOfficeImportError('failed')
      const manifest = await archive.file('META-INF/manifest.xml')?.async('string')
      if (!manifest) throw new LegacyOfficeImportError('failed')
      if (openDocumentManifestEncrypted(manifest)) throw new LegacyOfficeImportError('encrypted')
    }
    await runConverter(
      executable,
      [
        `-env:UserInstallation=${pathToFileURL(profileDir).href}`,
        '--headless',
        '--nologo',
        '--nodefault',
        '--norestore',
        '--convert-to',
        target === 'docx' ? 'docx:Office Open XML Text' : 'pptx:Impress MS PowerPoint 2007 XML',
        '--outdir',
        outputDir,
        privateInput,
      ],
      options.timeoutMs ?? 90_000,
      options.signal,
    )
    const outputPath = join(outputDir, `document.${target}`)
    const outputStat = await stat(outputPath)
    if (outputStat.size > MAX_LEGACY_IMPORT_BYTES) throw new LegacyOfficeImportError('tooLarge')
    if (outputStat.size === 0) throw new LegacyOfficeImportError('failed')
    const bytes = await readFile(outputPath)
    await assertZipInflatesWithinLimits(bytes)
    const archive = await JSZip.loadAsync(bytes)
    const mainPart = target === 'docx' ? 'word/document.xml' : 'ppt/presentation.xml'
    if (!archive.file(mainPart) || !archive.file('[Content_Types].xml'))
      throw new LegacyOfficeImportError('failed')
    // Macros have no place in the modern non-macro output advertised by this import.
    if (Object.keys(archive.files).some((name) => /(?:^|\/)vbaProject\.bin$/i.test(name)))
      throw new LegacyOfficeImportError('failed')
    return { bytes, extension, suggestSaveAs: modernOfficePath(sourcePath), sourceHash }
  } catch (error) {
    if (error instanceof LegacyOfficeImportError) throw error
    throw new LegacyOfficeImportError('failed', { cause: error })
  } finally {
    // workDir is exclusively created by mkdtemp inside the caller's temp root.
    await rm(workDir, { recursive: true, force: true }).catch(() => {})
  }
}
