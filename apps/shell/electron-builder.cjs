/**
 * electron-builder configuration (moved out of package.json "build" so the
 * auto-update feed URL can be injected at build time instead of living in
 * the repo).
 *
 * GENOFFICE_UPDATE_URL — public base URL of the update channel (the generic
 * provider prefix that serves latest.yml / latest-mac.yml). Required for
 * release builds; CI provides it as a repository secret. For local release
 * builds put it in apps/shell/electron-builder.env (gitignored) — the
 * electron-builder CLI loads that file automatically.
 *
 * When the variable is unset (forks, PR smoke builds, plain local packaging)
 * the publish config is omitted: electron-builder then bakes no
 * app-update.yml into the app and in-app auto-update stays disabled.
 *
 * GENOFFICE_GA4_MEASUREMENT_ID / GENOFFICE_GA4_API_SECRET — GA4 Measurement
 * Protocol credentials for anonymous usage analytics, injected the same way
 * (CI secrets, or apps/shell/electron-builder.env locally). They are written
 * into the packaged app's package.json via extraMetadata and read back by
 * src/main/analytics.ts. When either is unset — every source/fork build —
 * nothing is injected and the app runs with analytics fully disabled.
 *
 * GENOFFICE_FONT_CDN_URL — base URL for the curated downloadable-font catalog.
 * Official release jobs inject it through extraMetadata so the endpoint stays
 * out of source. Without it, font download prompts/catalog entries are hidden;
 * users can still install local font files.
 */

const { execFileSync } = require('node:child_process')
const { existsSync, readFileSync, rmSync, statSync } = require('node:fs')
const { join } = require('node:path')
const editorExtensions = require(join(__dirname, '../../packages/file-formats/src/extensions.json'))
const previewExtensions = require(
  join(__dirname, '../../packages/file-formats/src/preview-extensions.json'),
)
const additionalOfficeAssociations = [
  ['rtf', 'Rich Text Document', 'docx', 'application/rtf'],
  ['odt', 'OpenDocument Text', 'docx', 'application/vnd.oasis.opendocument.text'],
  ['odp', 'OpenDocument Presentation', 'pptx', 'application/vnd.oasis.opendocument.presentation'],
  ['doc', 'Word 97-2003 Document', 'docx', 'application/msword'],
  ['dot', 'Word 97-2003 Template', 'docx', 'application/msword'],
  ['ppt', 'PowerPoint 97-2003 Presentation', 'pptx', 'application/vnd.ms-powerpoint'],
  ['pps', 'PowerPoint 97-2003 Show', 'pptx', 'application/vnd.ms-powerpoint'],
  ['pot', 'PowerPoint 97-2003 Template', 'pptx', 'application/vnd.ms-powerpoint'],
  ['ods', 'OpenDocument Spreadsheet', 'xlsx', 'application/vnd.oasis.opendocument.spreadsheet'],
  [
    'xlsb',
    'Excel Binary Workbook',
    'xlsx',
    'application/vnd.ms-excel.sheet.binary.macroEnabled.12',
  ],
  [
    'dotx',
    'Word Template',
    'docx',
    'application/vnd.openxmlformats-officedocument.wordprocessingml.template',
  ],
  [
    'dotm',
    'Word Macro-Enabled Template',
    'docx',
    'application/vnd.ms-word.template.macroEnabled.12',
  ],
  [
    'docm',
    'Word Macro-Enabled Document',
    'docx',
    'application/vnd.ms-word.document.macroEnabled.12',
  ],
  [
    'xltx',
    'Excel Template',
    'xlsx',
    'application/vnd.openxmlformats-officedocument.spreadsheetml.template',
  ],
  [
    'xltm',
    'Excel Macro-Enabled Template',
    'xlsx',
    'application/vnd.ms-excel.template.macroEnabled.12',
  ],
  [
    'ppsx',
    'PowerPoint Show',
    'pptx',
    'application/vnd.openxmlformats-officedocument.presentationml.slideshow',
  ],
  [
    'ppsm',
    'PowerPoint Macro-Enabled Show',
    'pptx',
    'application/vnd.ms-powerpoint.slideshow.macroEnabled.12',
  ],
  [
    'pptm',
    'PowerPoint Macro-Enabled Presentation',
    'pptx',
    'application/vnd.ms-powerpoint.presentation.macroEnabled.12',
  ],
  [
    'potx',
    'PowerPoint Template',
    'pptx',
    'application/vnd.openxmlformats-officedocument.presentationml.template',
  ],
  [
    'potm',
    'PowerPoint Macro-Enabled Template',
    'pptx',
    'application/vnd.ms-powerpoint.template.macroEnabled.12',
  ],
].map(([ext, name, icon, mimeType]) => ({ ext, name, icon, mimeType, role: 'Editor' }))
function assertFileAssociations() {
  const seen = new Set()
  for (const entry of [
    ...additionalOfficeAssociations,
    ...additionalTextAssociations,
    ...additionalPreviewAssociations,
  ]) {
    if (seen.has(entry.ext)) throw new Error(`duplicate file association: ${entry.ext}`)
    seen.add(entry.ext)
    for (const iconExt of ['icns', 'ico']) {
      if (!existsSync(join(__dirname, `build/${entry.icon}.${iconExt}`))) {
        throw new Error(`file association icon missing: build/${entry.icon}.${iconExt}`)
      }
    }
  }
}
const additionalTextAssociations = editorExtensions.markdown
  .filter((ext) => !['md', 'markdown', 'txt', 'json'].includes(ext))
  .map((ext) => ({
    ext,
    name: `${ext.toUpperCase()} Document`,
    role: 'Editor',
    icon: 'txt',
    mimeType:
      {
        xml: 'application/xml',
        css: 'text/css',
        js: 'text/javascript',
        yaml: 'application/yaml',
        yml: 'application/yaml',
        toml: 'application/toml',
        jsonl: 'application/x-ndjson',
        ndjson: 'application/x-ndjson',
      }[ext] ?? 'text/plain',
  }))
const additionalPreviewAssociations = [
  ...previewExtensions.image,
  ...previewExtensions.message,
].map((ext) => ({
  ext,
  name: `${ext.toUpperCase()} File`,
  role: 'Viewer',
  icon: 'txt',
  mimeType:
    {
      jpg: 'image/jpeg',
      jpeg: 'image/jpeg',
      tif: 'image/tiff',
      tiff: 'image/tiff',
      eml: 'message/rfc822',
      msg: 'application/vnd.ms-outlook',
    }[ext] ?? `image/${ext}`,
}))

function normalizeHttpsBaseUrl(name, value) {
  if (!value || !value.trim()) return null
  try {
    const url = new URL(value.trim())
    if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash) {
      throw new Error('invalid')
    }
    return `${url.origin}${url.pathname.replace(/\/+$/, '')}`
  } catch {
    throw new Error(`${name} must be an HTTPS base URL without credentials, query, or fragment`)
  }
}

const updateUrl = process.env.GENOFFICE_UPDATE_URL
const ga4MeasurementId = process.env.GENOFFICE_GA4_MEASUREMENT_ID
const ga4ApiSecret = process.env.GENOFFICE_GA4_API_SECRET
const fontCdnUrl = normalizeHttpsBaseUrl(
  'GENOFFICE_FONT_CDN_URL',
  process.env.GENOFFICE_FONT_CDN_URL,
)

// GENOFFICE_MAC_X64=1 — opt into packaging the Intel (x64) dmg/zip alongside
// arm64. Off by default: Intel packages must only ever ship signed with the
// company certificate (planned dual-track pipeline), so the current release
// pipeline stays arm64-only. A Nawa distributor must configure its own
// signing identity before publishing either architecture.
const includeMacX64 = process.env.GENOFFICE_MAC_X64 === '1'

// GENOFFICE_WIN_ARM64=1 — package the Windows ARM64 installer instead of x64.
// CI runs it as a second electron-builder pass (own BUILD_DIR) after the
// unchanged x64 pass, so the two never share an output dir or a sidecar path:
// the sidecar comes from the matching cargo target dir and is checked to
// exist at beforePack because electron-builder exits 0 on a missing
// extraResources source (Sheets would ship dead on every ARM install).
const winArm64 = process.env.GENOFFICE_WIN_ARM64 === '1'
// 7-Zip packs ARM64 executables with its ARM64 branch filter, which the NSIS
// install-time extractor (Nsis7z) cannot decode: it silently skips
// Nawa.exe and every dll (electron-builder#9983). BCJ it can decode.
if (winArm64 && !process.env.ELECTRON_BUILDER_7Z_FILTER) {
  process.env.ELECTRON_BUILDER_7Z_FILTER = 'BCJ'
}
const winArch = winArm64 ? 'arm64' : 'x64'
const embeddingRuntimeTargets =
  process.platform === 'win32'
    ? [`win32/${winArch}`]
    : process.platform === 'darwin'
      ? includeMacX64
        ? ['darwin/arm64', 'darwin/x64']
        : ['darwin/arm64']
      : [`linux/${process.arch}`]
const imageRuntimePackages = embeddingRuntimeTargets.map((target) => {
  const [platform, architecture] = target.split('/')
  const suffix = platform === 'win32' ? '-msvc' : platform === 'linux' ? '-gnu' : ''
  return `@napi-rs/canvas-${platform}-${architecture}${suffix}`
})
const winSidecarTarget = winArm64 ? 'aarch64-pc-windows-msvc' : 'x86_64-pc-windows-msvc'
// The standard sheets build uses the host MSVC target and writes target/release.
// ARM64 is cross-compiled into its target-specific directory.
const WIN_SIDECAR = winArm64
  ? `../sheets/native/xlsx-engine/target/${winSidecarTarget}/release/xlsx-sidecar.exe`
  : '../sheets/native/xlsx-engine/target/release/xlsx-sidecar.exe'
const UNIX_SIDECAR = '../sheets/native/xlsx-engine/target/release/xlsx-sidecar'

function assertExtraResourceSources() {
  // The gsk CLI tree below is copied verbatim from node_modules, and the
  // nested commander path depends on npm's current hoisting layout — fail the
  // build with a clear message if an install ever changes it, instead of
  // shipping an installer with a broken gsk runtime.
  // LICENSES.chromium.html only exists after the Electron binary download —
  // since Electron 42 that no longer happens during `npm ci` (the postinstall
  // script was replaced by the lazy `install-electron` bin), and electron-builder
  // exits 0 on a missing extraResources source, so without this check the
  // installer would silently ship without the Chromium license.
  for (const rel of [
    '../../node_modules/@genspark/cli',
    '../../node_modules/@genspark/cli/node_modules/commander',
    '../../node_modules/ws',
    '../../node_modules/electron/dist/LICENSES.chromium.html',
    '../../node_modules/@embedpdf/pdfium/dist/pdfium.wasm',
    'out/embedding/runtime.mjs',
    '../../node_modules/@napi-rs/canvas/package.json',
    '../../node_modules/onnxruntime-node/dist',
    ...embeddingRuntimeTargets.map(
      (target) => `../../node_modules/onnxruntime-node/bin/napi-v3/${target}`,
    ),
    ...imageRuntimePackages.map((name) => `../../node_modules/${name}`),
    '../pdf/node_modules/harfbuzzjs/hb-subset.wasm',
  ]) {
    if (!existsSync(join(__dirname, rel))) {
      throw new Error(
        `electron-builder extraResources source missing: ${rel} (npm hoisting changed?)`,
      )
    }
  }
}

// macOS local-OCR helper (scanned-page text recovery): a swiftc output, not
// an npm artifact — compiled here on demand so CI runners and fresh checkouts
// need no manual step. Universal (arm64 + x86_64) when both targets compile,
// host-arch otherwise; mac installers must not silently ship without it.
const VISION_OCR_HELPER = '../../packages/pdf2docx/ocr-helper/vision-ocr'

// Compile the helper. universalOnly=true has NO host-arch fallback: dual-arch
// packaging must fail loudly rather than ship a host-arch binary to both dmgs.
function compileVisionOcr({ universalOnly } = { universalOnly: false }) {
  const src = join(__dirname, `${VISION_OCR_HELPER}.swift`)
  const out = join(__dirname, VISION_OCR_HELPER)
  try {
    try {
      const slices = ['arm64', 'x86_64'].map((arch) => {
        const slice = `${out}.${arch}`
        execFileSync('swiftc', ['-O', src, '-target', `${arch}-apple-macos12`, '-o', slice], {
          stdio: 'inherit',
        })
        return slice
      })
      execFileSync('lipo', ['-create', ...slices, '-output', out], { stdio: 'inherit' })
      for (const slice of slices) rmSync(slice, { force: true })
    } catch (err) {
      if (universalOnly) throw err
      // cross-target SDK unavailable — a host-arch helper still serves this build
      execFileSync('swiftc', ['-O', src, '-o', out], { stdio: 'inherit' })
    }
  } catch (err) {
    throw new Error(`vision-ocr helper compile failed: ${err}`, { cause: err })
  }
}

const WIN_OCR_HELPER = '../../packages/pdf2docx/ocr-helper/win-ocr.exe'

function ensurePlatformHelpers() {
  if (process.platform === 'darwin' && !existsSync(join(__dirname, VISION_OCR_HELPER))) {
    compileVisionOcr()
  }
  if (process.platform === 'win32' && !existsSync(join(__dirname, WIN_OCR_HELPER))) {
    try {
      execFileSync(
        process.execPath,
        [join(__dirname, '../../packages/pdf2docx/ocr-helper/build-win.mjs')],
        { stdio: 'inherit' },
      )
    } catch (err) {
      throw new Error(`win-ocr helper compile failed: ${err}`, { cause: err })
    }
  }
}

// Dual-arch packs share one extraResources path, so the shipped helper must be
// a lipo fat binary. A stale host-arch build (dev path above) is rebuilt in
// place; if a universal build cannot be produced, packaging aborts — otherwise
// the other arch's OCR silently fails and every scanned page ships as bitmap.
function assertUniversalVisionOcr() {
  const helper = join(__dirname, VISION_OCR_HELPER)
  const wanted = ['x86_64', 'arm64']
  const archsOf = () =>
    existsSync(helper)
      ? execFileSync('lipo', ['-archs', helper], { encoding: 'utf8' }).trim().split(/\s+/)
      : []
  if (!wanted.every((w) => archsOf().includes(w))) {
    rmSync(helper, { force: true })
    compileVisionOcr({ universalOnly: true })
  }
  const archs = archsOf()
  for (const want of wanted) {
    if (!archs.includes(want)) {
      throw new Error(
        `vision-ocr helper is [${archs.join(', ')}] but both mac arch packages ship it`,
      )
    }
  }
}

// The module trees are electron-vite outputs produced by build:all; a missing
// one means that module's build did not run or failed. electron-builder only
// logs "file source doesn't exist" for an absent extraResources source and
// still exits 0, so without this the installer launches normally and is simply
// missing that editor — it surfaces only when a user opens the tab.
//
// Runs from the beforePack hook, not at module load: gen-third-party-notices
// requires this config to read extraResources, and the dist:* scripts run
// notices before build:all, when the out dirs legitimately don't exist yet.
// When the mac build packages BOTH arches (GENOFFICE_MAC_X64=1) its
// extraResources entry is a single path shared by the two packs, so the
// sidecar there must be a lipo fat binary — a host-arch-only build (the plain
// `native:build` dev path) would silently ship an arm64 sidecar inside the
// Intel dmg, where every workbook open fails. Runs from beforePack, dual-arch
// mac packs only.
function assertUniversalSidecar() {
  const sidecar = join(__dirname, '../sheets/native/xlsx-engine/target/release/xlsx-sidecar')
  if (!existsSync(sidecar)) {
    throw new Error(
      `mac extraResources source missing: ${sidecar} (run "npm run native:build:universal -w @genoffice/sheets" first)`,
    )
  }
  const archs = execFileSync('lipo', ['-archs', sidecar], { encoding: 'utf8' }).trim().split(/\s+/)
  for (const want of ['x86_64', 'arm64']) {
    if (!archs.includes(want)) {
      throw new Error(
        `xlsx-sidecar is [${archs.join(', ')}] but both mac arch packages ship it — ` +
          'run "npm run native:build:universal -w @genoffice/sheets" before packaging mac',
      )
    }
  }
}

function builtFileExists(rel) {
  try {
    return existsSync(join(__dirname, rel)) && statSync(join(__dirname, rel)).isFile()
  } catch {
    return false
  }
}

function assertModuleTreesPresent() {
  const moduleFiles = ['docs', 'sheets', 'slides', 'pdf', 'markdown', 'html'].flatMap((name) =>
    ['main/index.js', 'preload/index.js', 'renderer/index.html'].map(
      (entry) => `../${name}/out/${entry}`,
    ),
  )
  for (const rel of [
    ...moduleFiles,
    'out/main/index.js',
    'out/preload/index.js',
    'out/preload/update.js',
    'out/preload/pdf-password.js',
    'out/renderer/index.html',
    'out/renderer/update.html',
    'out/renderer/pdf-password.html',
    '../../packages/cli/dist/genoffice.cjs',
    '../../packages/cli/dist/node_modules/jsdom/package.json',
  ]) {
    if (!builtFileExists(rel)) {
      throw new Error(
        `electron-builder extraResources source missing: ${rel} (run npm run build:all first)`,
      )
    }
  }
}

function assertNativeSidecar(platform) {
  const rel = platform === 'win32' ? WIN_SIDECAR : UNIX_SIDECAR
  if (!builtFileExists(rel)) {
    throw new Error(
      `${platform} native spreadsheet engine missing: ${rel} (run npm run native:build -w @genoffice/sheets for the target platform first)`,
    )
  }
}

function assertPackagedImageRuntimeVersion() {
  // extraResources copies the root runtime. A nested, patched shell dependency
  // cannot protect a stale root installation left behind by npm hoisting.
  const rel = '../../node_modules/@napi-rs/canvas/package.json'
  const expected = require('./package.json').dependencies['@napi-rs/canvas']
  let actual
  try {
    if (builtFileExists(rel))
      actual = JSON.parse(readFileSync(join(__dirname, rel), 'utf8')).version
  } catch {
    // Report missing and unreadable manifests through the same actionable gate.
  }
  if (actual !== expected) {
    throw new Error(
      `packaged root canvas ${actual ?? 'missing'} does not match the shell pin ${expected} ` +
        '(run npm ci and verify npm ls @napi-rs/canvas before packaging)',
    )
  }
}

function assertTextRuntimeHasNoImageBackend() {
  const rel = 'out/embedding/metafile.json'
  if (!builtFileExists(rel))
    throw new Error('Build the native text embedding runtime before packaging.')
  const metadata = JSON.parse(readFileSync(join(__dirname, rel), 'utf8'))
  for (const input of Object.keys(metadata.inputs)) {
    if (/(?:^|[/\\])node_modules[/\\](?:sharp|@img)(?:[/\\]|$)/u.test(input))
      throw new Error(`Forbidden image dependency in embedding runtime: ${input}`)
  }
  for (const output of Object.values(metadata.outputs)) {
    if (output.imports.some((entry) => entry.path === 'sharp' || entry.path.startsWith('@img/')))
      throw new Error('Forbidden external image dependency in embedding runtime.')
  }
}

const CLI_BUNDLE_REL = '../../packages/cli/dist/genoffice.cjs'
const CLI_BUILD_REL = '../../packages/cli/build.mjs'
const CLI_VERSION_ENV = 'GENOFFICE_APP_VERSION'
const CLI_VERSION_BANNER = /^const __cliAppVersion = ("(?:[^"\\]|\\.)*");$/m

/**
 * The version the packaged app reports: CI's -c.extraMetadata.version deep-merges
 * into the block below, and without it electron-builder ships apps/shell/package.json.
 */
function packagedAppVersion() {
  const injected = config.extraMetadata && config.extraMetadata.version
  if (typeof injected === 'string' && injected.trim()) return injected.trim()
  return require('./package.json').version
}

function bundledCliVersion(bundlePath) {
  const baked = CLI_VERSION_BANNER.exec(readFileSync(bundlePath, 'utf-8'))
  if (!baked) return null
  try {
    return JSON.parse(baked[1])
  } catch {
    return null
  }
}

/**
 * `genoffice --version` is baked into the CLI bundle, which is built before
 * electron-builder runs and therefore before a release version is known. Rebuild
 * it here with the app version whenever the two disagree, so the packaged
 * command line can never answer with the workspace CLI version.
 */
function ensureCliBundleCarriesAppVersion() {
  const bundlePath = join(__dirname, CLI_BUNDLE_REL)
  const appVersion = packagedAppVersion()
  if (bundledCliVersion(bundlePath) === appVersion) return
  execFileSync(process.execPath, [join(__dirname, CLI_BUILD_REL)], {
    stdio: 'inherit',
    env: { ...process.env, [CLI_VERSION_ENV]: appVersion },
  })
  const baked = bundledCliVersion(bundlePath)
  if (baked !== appVersion) {
    throw new Error(
      `packaged genoffice CLI reports ${baked ?? 'no version'} but the app ships ${appVersion} ` +
        `(rebuild it with ${CLI_VERSION_ENV}=${appVersion})`,
    )
  }
}

const NOTICE_PATH = join(__dirname, 'build/THIRD-PARTY-NOTICES.txt')
const PDFIUM_NOTICE_TERMS = ['@embedpdf/pdfium', 'Copyright 2014 PDFium Authors', 'Apache License']

function hasValidThirdPartyNotice() {
  if (!existsSync(NOTICE_PATH)) return false
  try {
    const text = readFileSync(NOTICE_PATH, 'utf8')
    return PDFIUM_NOTICE_TERMS.every((term) => text.includes(term))
  } catch {
    return false
  }
}

function ensureThirdPartyNotices() {
  if (!hasValidThirdPartyNotice()) {
    execFileSync(process.execPath, [join(__dirname, '../../tools/gen-third-party-notices.mjs')], {
      stdio: 'inherit',
    })
  }
  if (!hasValidThirdPartyNotice()) {
    throw new Error('third-party notice missing PDFium redistribution terms')
  }
}

/** @type {import('electron-builder').Configuration} */
const config = {
  appId: 'com.nawa.app',
  productName: 'Nawa',
  // Resolved from the installed electron package so dependency bumps can
  // never leave a stale hard-coded pin behind (packaging would silently ship
  // the old runtime).
  electronVersion: require('electron/package.json').version,
  electronLanguages: ['en-US', 'en-GB', 'ja', 'ar'],
  directories: {
    output: process.env.BUILD_DIR || 'release',
  },
  files: ['out/main/**', 'out/preload/**', 'out/renderer/**'],
  extraResources: [
    {
      from: 'build/THIRD-PARTY-NOTICES.txt',
      to: 'THIRD-PARTY-NOTICES.txt',
    },
    {
      from: '../../node_modules/electron/dist/LICENSES.chromium.html',
      to: 'LICENSES.chromium.html',
    },
    // Native embeddings run in a Nawa worker. Keep the Node runtime and its
    // N-API dependencies outside asar so dynamic imports and bindings resolve.
    {
      from: 'out/embedding/runtime.mjs',
      to: 'embedding/runtime.mjs',
    },
    {
      from: '../../node_modules/@napi-rs/canvas',
      to: 'image/node_modules/@napi-rs/canvas',
    },
    ...imageRuntimePackages.map((name) => ({
      from: `../../node_modules/${name}`,
      to: `image/node_modules/${name}`,
    })),
    {
      from: '../../node_modules/onnxruntime-node/package.json',
      to: 'embedding/node_modules/onnxruntime-node/package.json',
    },
    {
      from: '../../node_modules/onnxruntime-node/dist',
      to: 'embedding/node_modules/onnxruntime-node/dist',
    },
    ...embeddingRuntimeTargets.map((target) => ({
      from: `../../node_modules/onnxruntime-node/bin/napi-v3/${target}`,
      to: `embedding/node_modules/onnxruntime-node/bin/napi-v3/${target}`,
    })),
    ...['onnxruntime-common'].map((name) => ({
      from: `../../node_modules/${name}`,
      to: `embedding/node_modules/${name}`,
    })),
    {
      from: '../docs/out',
      to: 'modules/docs',
    },
    {
      from: '../sheets/out',
      to: 'modules/sheets',
    },
    {
      from: '../slides/out',
      to: 'modules/slides',
    },
    {
      from: '../pdf/out',
      to: 'modules/pdf',
    },
    {
      from: '../markdown/out',
      to: 'modules/markdown',
    },
    {
      from: '../html/out',
      to: 'modules/html',
    },
    // PDF text editing engines: the bundled main resolves these under
    // Resources/wasm when node_modules is absent (apps/pdf/src/main/wasm-path.ts)
    {
      from: '../../node_modules/@embedpdf/pdfium/dist/pdfium.wasm',
      to: 'wasm/pdfium.wasm',
    },
    {
      from: '../pdf/node_modules/harfbuzzjs/hb-subset.wasm',
      to: 'wasm/hb-subset.wasm',
    },
    // platform system-OCR helpers for scanned-page recovery (each exists only
    // on its own build platform; electron-builder skips absent sources and the
    // engine resolver degrades to the bitmap fallback when missing)
    {
      from: '../../packages/pdf2docx/ocr-helper/vision-ocr',
      to: 'ocr/vision-ocr',
    },
    {
      from: '../../packages/pdf2docx/ocr-helper/win-ocr.exe',
      to: 'ocr/win-ocr.exe',
    },
    {
      from: '../../node_modules/@genspark/cli',
      to: 'gsk/node_modules/@genspark/cli',
    },
    // genoffice command line: runs on the app binary with ELECTRON_RUN_AS_NODE (as
    // the gsk CLI above already does), so the RunAsNode fuse must stay enabled.
    // Layout (Resources/cli next to wasm/, native/, ocr/) is what
    // packages/cli/src/resources.ts expects.
    {
      from: '../../packages/cli/dist/genoffice.cjs',
      to: 'cli/genoffice.cjs',
    },
    {
      from: '../../packages/cli/bin/genoffice',
      to: 'cli/genoffice',
    },
    {
      from: '../../packages/cli/bin/genoffice.cmd',
      to: 'cli/genoffice.cmd',
    },
    // the CLI's version (Settings → Integrations shows it) and the agent skill
    // the same pane installs into Claude Code / Codex / …; bytes identical to the repo file
    {
      from: '../../packages/cli/package.json',
      to: 'cli/package.json',
    },
    {
      from: '../../skills/genoffice/SKILL.md',
      to: 'cli/skills/genoffice/SKILL.md',
    },
    // runtime deps the genoffice bundle leaves external (jsdom for the Word/Markdown
    // paths); collected by packages/cli/collect-deps.mjs during its build
    {
      from: '../../packages/cli/dist/node_modules',
      to: 'cli/node_modules',
    },
    {
      from: '../../node_modules/@genspark/cli/node_modules/commander',
      to: 'gsk/node_modules/commander',
    },
    {
      from: '../../node_modules/ws',
      to: 'gsk/node_modules/ws',
    },
  ],
  // `mimeType` is read only by the Linux target, where it becomes the
  // desktop entry's MimeType= list; associations without it are dropped
  // there. macOS and Windows ignore the field and key off `ext`.
  //
  // `icon` is extension-less on purpose: electron-builder resolves it against
  // build/ as <icon>.icns for the mac CFBundleDocumentTypes entry and
  // <icon>.ico for the NSIS DefaultIcon registry value. Without it both
  // platforms fall back to the app icon, so every associated file shows the
  // bare GenOffice logo instead of a per-type document icon. The icns/ico
  // pairs are generated from the shell renderer's file-type tiles by
  // tools/gen-file-association-icons.mjs.
  fileAssociations: [
    ...additionalPreviewAssociations,
    ...additionalOfficeAssociations,
    ...additionalTextAssociations,
    {
      ext: 'docx',
      name: 'Word Document',
      description: 'Word Document',
      role: 'Editor',
      icon: 'docx',
      mimeType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    },
    {
      ext: 'xlsx',
      name: 'Excel Workbook',
      description: 'Excel Workbook',
      role: 'Editor',
      icon: 'xlsx',
      mimeType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    },
    {
      ext: 'xlsm',
      name: 'Excel Macro-Enabled Workbook',
      role: 'Editor',
      icon: 'xlsx',
      mimeType: 'application/vnd.ms-excel.sheet.macroEnabled.12',
    },
    {
      ext: 'pptx',
      name: 'PowerPoint Presentation',
      description: 'PowerPoint Presentation',
      role: 'Editor',
      icon: 'pptx',
      mimeType: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
    },
    {
      ext: 'xls',
      name: 'Excel 97-2003 Workbook',
      role: 'Editor',
      icon: 'xlsx',
      mimeType: 'application/vnd.ms-excel',
    },
    {
      ext: 'csv',
      name: 'CSV Document',
      role: 'Editor',
      icon: 'xlsx',
      mimeType: 'text/csv',
    },
    {
      // opens as a converted copy and saves as .xlsx (genoffice#1146)
      ext: 'tsv',
      name: 'TSV Document',
      role: 'Editor',
      icon: 'xlsx',
      mimeType: 'text/tab-separated-values',
    },
    {
      ext: 'pdf',
      name: 'PDF Document',
      role: 'Editor',
      icon: 'pdf',
      mimeType: 'application/pdf',
    },
    {
      ext: 'md',
      name: 'Markdown Document',
      role: 'Editor',
      icon: 'md',
      mimeType: 'text/markdown',
    },
    {
      ext: 'markdown',
      name: 'Markdown Document',
      role: 'Editor',
      icon: 'md',
      mimeType: 'text/markdown',
    },
    {
      ext: 'txt',
      name: 'Text Document',
      description: 'Text Document',
      role: 'Editor',
      icon: 'txt',
      mimeType: 'text/plain',
    },
    {
      ext: 'json',
      name: 'JSON Document',
      description: 'JSON Document',
      role: 'Editor',
      icon: 'json',
      mimeType: 'application/json',
    },
    {
      ext: 'html',
      name: 'HTML Document',
      role: 'Editor',
      icon: 'html',
      mimeType: 'text/html',
    },
    {
      ext: 'htm',
      name: 'HTML Document',
      role: 'Editor',
      icon: 'html',
      mimeType: 'text/html',
    },
  ],
  npmRebuild: false,
  mac: {
    // Two separate arch packages (NOT universal): arm64 keeps the exact
    // artifact names and update-feed entries it always had, x64 (opt-in via
    // GENOFFICE_MAC_X64=1, see includeMacX64 above) adds Intel support with
    // electron-builder's default arch-less names (Nawa-<v>.dmg /
    // Nawa-<v>-mac.zip). Both zips land in one latest-mac.yml and
    // electron-updater picks by process.arch. Dual-arch packs ship the same
    // lipo fat xlsx-sidecar (see assertUniversalSidecar above).
    target: [
      { target: 'dmg', arch: includeMacX64 ? ['arm64', 'x64'] : ['arm64'] },
      { target: 'zip', arch: includeMacX64 ? ['arm64', 'x64'] : ['arm64'] },
    ],
    category: 'public.app-category.productivity',
    hardenedRuntime: true,
    gatekeeperAssess: false,
    entitlements: 'build/entitlements.mac.plist',
    entitlementsInherit: 'build/entitlements.mac.plist',
    notarize: true,
    extraResources: [
      {
        from: UNIX_SIDECAR,
        to: 'native/xlsx-sidecar',
      },
    ],
  },
  win: {
    target: [
      {
        target: 'nsis',
        arch: [winArch],
      },
    ],
    extraResources: [
      {
        from: WIN_SIDECAR,
        to: 'native/xlsx-sidecar.exe',
      },
      {
        from: 'build/shell-new',
        to: 'shell-new',
        filter: ['*.docx', '*.xlsx', '*.pptx'],
      },
    ],
  },
  // Linux takes the sidecar from cargo's host-native target/release/, as do
  // macOS and Windows x64. These Linux targets are x64; build on an x64 host
  // so the copied sidecar and embedding runtime match the packaged app.
  linux: {
    // AppImage (self-contained, any distro) + deb (apt install, pulls in the
    // GTK/NSS runtime deps) + rpm (dnf/zypper install on Fedora / RHEL /
    // openSUSE). Product and package names below identify this Nawa build.
    target: [
      { target: 'AppImage', arch: ['x64'] },
      { target: 'deb', arch: ['x64'] },
      { target: 'rpm', arch: ['x64'] },
    ],
    // The repository owner is known; no Nawa contact email is asserted.
    // Release distributors may supply their verified maintainer identity.
    maintainer: process.env.NAWA_LINUX_MAINTAINER?.trim() || 'Abdul-mo-dev',
    vendor: 'Nawa',
    category: 'Office',
    // Icon SET directory, not the single 1024px png: electron-builder does
    // not resize a lone png, so deb/rpm would install only
    // hicolor/1024x1024/apps/nawa.png — a size absent from the hicolor
    // theme index, leaving GNOME/KDE launchers on the generic fallback icon
    // (genspark-ai/genoffice#90). The set ships every standard raster size.
    icon: 'build/icons',
    // mac and win name the binary from productName; linux instead derives it
    // from package.json "name", and "@genoffice/shell" sanitizes to the
    // invalid "@genofficeshell". Setting it explicitly also makes the
    // generated nawa.desktop match the WM_CLASS Electron reports (it
    // takes that from the executable basename), so the running window links
    // back to its launcher entry.
    executableName: 'nawa',
    // Electron takes its X11 app_id from package.json "desktopName"
    // (nawa.desktop); syncDesktopName makes electron-builder name the
    // .desktop file and its StartupWMClass from the same value. Without it
    // StartupWMClass falls back to productName ("Nawa"), which does not
    // match the "nawa" WM_CLASS the window actually reports — and X11
    // compares case-sensitively, so the taskbar shows an unlinked window.
    syncDesktopName: true,
    extraResources: [
      {
        from: UNIX_SIDECAR,
        to: 'native/xlsx-sidecar',
      },
    ],
  },
  // Same "@genoffice/shell" problem as executableName above: the default deb
  // artifact name derives from package.json "name", and the scope's "/" makes
  // fpm treat "@genoffice" as a directory. Pin both the artifact and package
  // names to Nawa so successive Nawa packages upgrade the same application.
  deb: {
    artifactName: 'nawa_${version}_${arch}.deb',
    packageName: 'nawa',
    // expose the genoffice command line shipped inside the app
    afterInstall: 'build/linux-after-install.sh',
    afterRemove: 'build/linux-after-remove.sh',
  },
  // Same "@genoffice/shell" naming problem as deb: spell the artifact name
  // out (${arch} expands to the rpm arch string, x86_64) and pin the rpm
  // Package name so dnf/zypper treat successive releases as upgrades of the
  // same package. Like deb, rpm installs run no in-app updater — users
  // upgrade with `dnf install ./<new>.rpm`. Packaging needs rpmbuild on the
  // build host (the `rpm` apt package on Ubuntu; CI installs it).
  //
  // publish: null (explicit) keeps the rpm out of the electron-updater feed
  // and off the CDN entirely: the rpm is a GitHub-Release download only, so
  // latest-linux.yml keeps listing exactly what the CDN pipeline uploads
  // (AppImage + deb) and the promote workflow needs no rpm alias.
  rpm: {
    artifactName: 'nawa-${version}.${arch}.rpm',
    packageName: 'nawa',
    publish: null,
    afterInstall: 'build/linux-after-install.sh',
    afterRemove: 'build/linux-after-remove.sh',
    // rpmbuild links every packaged ELF file into /usr/lib/.build-id/<hash>.
    // Two Electron apps built on the same Electron release ship identical
    // binaries, so the links are identical too and dnf refuses the install
    // with a file conflict against the other app (genoffice#1145). The links exist only
    // to locate detached debuginfo, which this package does not ship, so turn
    // them off. rpm-level `fpm` (not linux-level) keeps it away from the deb.
    fpm: ['--rpm-rpmbuild-define=_build_id_links none'],
  },
  nsis: {
    artifactName: winArm64 ? 'Nawa-Setup-${version}-arm64.${ext}' : 'Nawa-Setup-${version}.${ext}',
    oneClick: false,
    allowToChangeInstallationDirectory: true,
  },
  beforePack: async (context) => {
    ensurePlatformHelpers()
    assertFileAssociations()
    assertExtraResourceSources()
    ensureThirdPartyNotices()
    assertModuleTreesPresent()
    assertNativeSidecar(context.electronPlatformName)
    assertPackagedImageRuntimeVersion()
    assertTextRuntimeHasNoImageBackend()
    ensureCliBundleCarriesAppVersion()
    if (context.electronPlatformName === 'darwin' && includeMacX64) {
      assertUniversalSidecar()
      assertUniversalVisionOcr()
    }
  },
  dmg: {
    sign: true,
  },
  afterAllArtifactBuild: 'build/notarize-dmg.js',
}

// Windows in-package code signing. Security features that judge every PE
// individually (Smart App Control, WDAC/AppLocker, AV heuristics) block
// unsigned child processes — the unsigned xlsx-sidecar.exe died with
// "spawn UNKNOWN" on such machines even though the installer itself was
// signed. When CI exports GENOFFICE_WIN_SIGN_MODE ("test" = alpha
// self-signed PFX, "production" = DigiCert KeyLocker — the two modes of
// scripts/win-sign.cjs, whose env-var contract applies here too), every
// binary electron-builder signs for win (Nawa.exe, the NSIS
// uninstaller, and the installer) goes through that script. The static
// extraResources binaries (xlsx-sidecar.exe, win-ocr.exe) are signed by the
// workflow before packaging since electron-builder does not sign
// extraResources. Unset (local / fork builds) keeps the old behavior:
// electron-builder has no signing config and packages everything unsigned.
const winSignMode = process.env.GENOFFICE_WIN_SIGN_MODE
if (winSignMode) {
  if (winSignMode !== 'test' && winSignMode !== 'production') {
    throw new Error(`GENOFFICE_WIN_SIGN_MODE must be "test" or "production", got "${winSignMode}"`)
  }
  config.win.signtoolOptions = {
    // Single pass per file: the sha1+sha256 dual-signing default is a
    // pre-Win8 relic and would invoke the hook twice per binary.
    signingHashAlgorithms: ['sha256'],
    sign: (configuration) => {
      execFileSync(
        process.execPath,
        [join(__dirname, '../../scripts/win-sign.cjs'), winSignMode, configuration.path],
        { stdio: 'inherit' },
      )
      return Promise.resolve()
    },
  }
}

if (updateUrl) {
  config.publish = [
    {
      provider: 'generic',
      url: updateUrl.replace(/\/+$/, ''),
      channel: 'latest',
    },
  ]
}

// CI's "-c.extraMetadata.version=..." CLI override deep-merges with this block,
// so the version and all injected feature settings survive together.
const extraMetadata = {}
if (ga4MeasurementId && ga4ApiSecret) {
  extraMetadata.genofficeAnalytics = {
    measurementId: ga4MeasurementId,
    apiSecret: ga4ApiSecret,
  }
}
if (fontCdnUrl) extraMetadata.genofficeFontCdn = { baseUrl: fontCdnUrl }
if (Object.keys(extraMetadata).length) config.extraMetadata = extraMetadata

module.exports = config
