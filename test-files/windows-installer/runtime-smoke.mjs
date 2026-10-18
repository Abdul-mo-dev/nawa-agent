/* global window */
import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { createHash } from 'node:crypto'
import { copyFile, mkdir, readFile, writeFile } from 'node:fs/promises'
import { createConnection } from 'node:net'
import { createRequire } from 'node:module'
import { join, resolve } from 'node:path'
import { promisify } from 'node:util'
import { _electron as electron } from 'playwright'

const root = resolve(process.argv[2])
const workspace = resolve(import.meta.dirname, '../..')
const manifest = JSON.parse(await readFile(join(root, 'manifest.json'), 'utf8'))
const executable = join(manifest.installDirectory, manifest.executable)
const profile = join(root, 'runtime-profile')
const fixtures = join(root, 'fixture copies')
await mkdir(profile, { recursive: true })
await mkdir(fixtures, { recursive: true })
await writeFile(
  join(profile, 'app-settings.json'),
  JSON.stringify({
    onboardingSeen: true,
    cliLink: { version: manifest.version, status: 'present' },
  }),
)
const env = {
  ...process.env,
  GENOFFICE_USER_DATA: profile,
  GENOFFICE_AUTH_DIR: join(profile, 'auth'),
  GENOFFICE_NO_SPARE_VIEW: '1',
  GENOFFICE_LANG: 'en',
}
delete env.ELECTRON_RUN_AS_NODE
const hash = (bytes) => createHash('sha256').update(bytes).digest('hex')
const report = {
  testedAt: new Date().toISOString(),
  packaged: false,
  payload: [],
  cases: [],
  cli: [],
  passed: false,
}

async function control(request) {
  const endpoint = JSON.parse(await readFile(join(profile, 'control.json'), 'utf8'))
  return new Promise((resolveReply, reject) => {
    const socket = createConnection(endpoint.endpoint)
    socket.setEncoding('utf8')
    socket.setTimeout(130_000, () => socket.destroy(new Error('Control request timed out')))
    socket.on('error', reject)
    let data = ''
    socket.on('data', (chunk) => {
      data += chunk
      if (!data.includes('\n')) return
      socket.end()
      try {
        resolveReply(JSON.parse(data.slice(0, data.indexOf('\n'))))
      } catch (error) {
        reject(error)
      }
    })
    socket.on('connect', () =>
      socket.write(JSON.stringify({ token: endpoint.token, request }) + '\n'),
    )
  })
}

let app
try {
  const require = createRequire(import.meta.url)
  const asar = require('@electron/asar')
  const main = asar.extractFile(
    join(manifest.installDirectory, 'resources/app.asar'),
    join('out', 'main', 'index.js'),
  )
  assert(
    !asar
      .listPackage(join(manifest.installDirectory, 'resources/app.asar'))
      .some((file) => /(?:^|[/\\])node_modules[/\\](?:sharp|@img)(?:[/\\]|$)/u.test(file)),
    'Forbidden Sharp/libvips runtime in app.asar',
  )
  const { readdir } = await import('node:fs/promises')
  async function verifyPermissiveImagePayload(directory) {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue
      assert(!['sharp', '@img'].includes(entry.name), `Forbidden image package: ${entry.name}`)
      await verifyPermissiveImagePayload(join(directory, entry.name))
    }
  }
  await verifyPermissiveImagePayload(join(manifest.installDirectory, 'resources'))
  report.payload.push('No Sharp/libvips package in app.asar or external resources')
  assert.equal(
    hash(main),
    hash(await readFile(join(workspace, 'apps/shell/out/main/index.js'))),
    'Packaged Shell main is stale',
  )
  report.payload.push('Shell main SHA-256 matches current build')
  const { readdir: rendererFiles } = await import('node:fs/promises')
  for (const part of [
    'index.html',
    ...(await rendererFiles(join(workspace, 'apps/shell/out/renderer/assets')))
      .filter((file) => /\.(?:js|css)$/u.test(file))
      .map((file) => `assets/${file}`),
  ]) {
    assert.equal(
      hash(
        asar.extractFile(
          join(manifest.installDirectory, 'resources/app.asar'),
          join('out', 'renderer', part),
        ),
      ),
      hash(await readFile(join(workspace, 'apps/shell/out/renderer', part))),
      `Stale shell renderer: ${part}`,
    )
  }
  report.payload.push('Shell renderer HTML, JavaScript and CSS match current build')
  for (const module of ['docs', 'sheets', 'slides', 'pdf', 'markdown', 'html']) {
    for (const part of ['preload/index.js', 'renderer/index.html']) {
      const source = await readFile(join(workspace, 'apps', module, 'out', part))
      const installed = await readFile(
        join(manifest.installDirectory, 'resources/modules', module, part),
      )
      assert.equal(hash(installed), hash(source), `Stale or missing ${module}/${part}`)
    }
    report.payload.push(`${module} preload and renderer match current build`)
  }
  for (const [source, target] of [
    ['apps/sheets/native/xlsx-engine/target/release/xlsx-sidecar.exe', 'native/xlsx-sidecar.exe'],
    ['packages/cli/dist/genoffice.cjs', 'cli/genoffice.cjs'],
    ['node_modules/@embedpdf/pdfium/dist/pdfium.wasm', 'wasm/pdfium.wasm'],
  ]) {
    assert.equal(
      hash(await readFile(join(workspace, source))),
      hash(await readFile(join(manifest.installDirectory, 'resources', target))),
    )
    report.payload.push(`${target} SHA-256 matches source`)
  }
  app = await electron.launch({ executablePath: executable, args: [], env, timeout: 60_000 })
  let stderr = ''
  app.process().stderr?.on('data', (chunk) => {
    stderr = (stderr + chunk.toString()).slice(-16_000)
  })
  app.on('window', (page) =>
    page.on('pageerror', (error) => console.error('Renderer error:', error.message)),
  )
  const runtime = await app.evaluate(({ app }) => ({
    packaged: app.isPackaged,
    version: app.getVersion(),
  }))
  assert(runtime.packaged)
  assert.equal(runtime.version, manifest.version)
  report.packaged = true
  const home = await app.firstWindow()
  await home.waitForFunction(() => !!window.aiOffice?.openPath, undefined, { timeout: 30_000 })
  const samples = [
    ['macro-office-chat/sample.docm', 'block'],
    ['macro-office-chat/sample.pptm', 'slide'],
    ['xlsm-chat/sample.xlsm', 'range'],
    ['xltm-chat/sample.xltm', 'range'],
    ['legacy-office/document-sample.doc', 'block'],
    ['legacy-office/presentation-sample.ppt', 'slide'],
    ['opendocument/document-sample.odt', 'block'],
    ['opendocument/presentation-sample.odp', 'slide'],
    ['spreadsheet-chat/formulas.ods', 'range'],
    ['spreadsheet-chat/sheets.xlsb', 'range'],
    ['spreadsheet-chat/table.tsv', 'range'],
  ]
  for (const [sample, kind] of samples) {
    const source = join(workspace, 'test-files', sample)
    const path = join(fixtures, sample.replaceAll('/', '-'))
    await copyFile(source, path)
    const before = hash(await readFile(path))
    const target =
      kind === 'block'
        ? { kind, block: 0 }
        : kind === 'slide'
          ? { kind, slide: 0 }
          : { kind, range: 'A1:C3' }
    const started = performance.now()
    const opened = await control({ cmd: 'open', path, target })
    if (!opened.ok) {
      console.error('Failed sample:', sample, 'Electron stderr:', stderr)
      for (const page of app.windows())
        console.error(
          'Editor state:',
          page.url(),
          (
            await page
              .locator('body')
              .innerText({ timeout: 2000 })
              .catch(() => 'unavailable')
          ).slice(0, 4000),
        )
    }
    assert(opened.ok, JSON.stringify(opened.error))
    const selected = await control({ cmd: 'selection', path })
    assert(selected.ok, JSON.stringify(selected.error))
    assert.equal(hash(await readFile(path)), before)
    report.cases.push({
      sample,
      readyMs: Math.round(performance.now() - started),
      opened: opened.result,
      selected: selected.result,
      originalUnchanged: true,
      passed: true,
    })
    console.log(`PASS installed runtime: ${sample}`)
  }
  await app.close()
  app = undefined
  for (const args of [
    ['--version'],
    [
      'docs',
      'read',
      join(workspace, 'test-files/legacy-office/source/document-sample.docx'),
      '--json',
    ],
    [
      'sheet',
      'read',
      join(workspace, 'test-files/xlsm-chat/sample.xlsm'),
      '--range',
      'A1:C3',
      '--json',
    ],
  ]) {
    const { stdout } = await promisify(execFile)(
      executable,
      [join(manifest.installDirectory, 'resources/cli/genoffice.cjs'), ...args],
      {
        env: { ...env, ELECTRON_RUN_AS_NODE: '1' },
        windowsHide: true,
        timeout: 60_000,
        maxBuffer: 2 * 1024 * 1024,
      },
    )
    if (args[0] === '--version') assert(stdout.includes(manifest.version))
    else assert.equal(JSON.parse(stdout).status, 'ok', stdout)
    report.cli.push({ command: args.slice(0, 2).join(' '), passed: true })
  }
  report.passed = true
} catch (error) {
  report.error = error.stack || String(error)
  process.exitCode = 1
} finally {
  if (app) await app.close().catch(() => {})
  await writeFile(join(root, 'runtime-report.json'), JSON.stringify(report, null, 2) + '\n')
  if (report.error) console.error(report.error)
}
