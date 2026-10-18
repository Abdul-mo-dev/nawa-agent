import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { resolve } from 'node:path'
import { runInNewContext } from 'node:vm'
import { describe, expect, it } from 'vitest'

const require = createRequire(import.meta.url)
const shellRoot = resolve(import.meta.dirname, '..')
const shellPackage = JSON.parse(readFileSync(resolve(shellRoot, 'package.json'), 'utf-8')) as {
  version: string
  dependencies: { '@napi-rs/canvas': string }
}
const CLI_BUNDLE_REL = '../../packages/cli/dist/genoffice.cjs'

interface Rebuild {
  script: string
  appVersion: string | undefined
}

/**
 * Loads the real packaging config and drives its beforePack hook with a stand-in
 * CLI bundle: `rebuiltWith` is the version the fake rebuild bakes in, so the hook
 * sees exactly what a real GENOFFICE_APP_VERSION rebuild would leave behind.
 */
function loadConfig(opts: {
  baked: string
  extraMetadataVersion?: string
  rebuildApplies?: boolean
  missing?: string
  rootCanvasVersion?: string
  forbiddenEmbedding?: 'input' | 'import'
}): {
  config: { beforePack: (context: { electronPlatformName: string }) => Promise<void> }
  rebuilds: Rebuild[]
} {
  const rebuilds: Rebuild[] = []
  let baked = opts.baked
  const configModule = { exports: {} as Record<string, unknown> }
  runInNewContext(readFileSync(resolve(shellRoot, 'electron-builder.cjs'), 'utf8'), {
    module: configModule,
    __dirname: shellRoot,
    process: { platform: 'linux', arch: 'x64', env: {}, execPath: '/usr/bin/node' },
    require: (id: string) => {
      if (id === './package.json') return shellPackage
      if (id === 'node:child_process') {
        return {
          execFileSync: (_file: string, args: string[], runOpts: { env?: NodeJS.ProcessEnv }) => {
            rebuilds.push({ script: args[0], appVersion: runOpts.env?.GENOFFICE_APP_VERSION })
            if (opts.rebuildApplies !== false) baked = runOpts.env?.GENOFFICE_APP_VERSION ?? baked
            return Buffer.from('')
          },
        }
      }
      if (id === 'node:fs') {
        return {
          ...require(id),
          existsSync: (file: string) =>
            !opts.missing || String(file) !== resolve(shellRoot, opts.missing),
          statSync: () => ({ isFile: () => true }),
          readFileSync: (path: string, encoding: string) => {
            if (
              String(path).endsWith('embedding/metafile.json') ||
              String(path).endsWith('embedding\\metafile.json')
            ) {
              return JSON.stringify({
                inputs:
                  opts.forbiddenEmbedding === 'input' ? { 'node_modules/sharp/index.js': {} } : {},
                outputs: {
                  'runtime.mjs': {
                    imports: opts.forbiddenEmbedding === 'import' ? [{ path: 'sharp' }] : [],
                  },
                },
              })
            }
            if (
              String(path) === resolve(shellRoot, '../../node_modules/@napi-rs/canvas/package.json')
            ) {
              return JSON.stringify({
                version: opts.rootCanvasVersion ?? shellPackage.dependencies['@napi-rs/canvas'],
              })
            }
            if (String(path).endsWith('genoffice.cjs')) {
              return `const __cliAppVersion = ${JSON.stringify(baked)};\n`
            }
            // Packaging also gates on a generated third-party notice. Serve a
            // valid one so the CLI version check is what these tests exercise.
            if (String(path).endsWith('THIRD-PARTY-NOTICES.txt')) {
              return '@embedpdf/pdfium\nCopyright 2014 PDFium Authors\nApache License\n'
            }
            return require('node:fs').readFileSync(path, encoding as BufferEncoding)
          },
        }
      }
      return require(id)
    },
  })
  const config = configModule.exports as {
    beforePack: (context: { electronPlatformName: string }) => Promise<void>
    extraMetadata?: { version?: string }
  }
  if (opts.extraMetadataVersion) {
    config.extraMetadata = { ...(config.extraMetadata ?? {}), version: opts.extraMetadataVersion }
  }
  return { config, rebuilds }
}

describe('packaged CLI version agreement', () => {
  it('rebuilds the CLI bundle with the app version when the two disagree', async () => {
    const { config, rebuilds } = loadConfig({ baked: '9.9.9' })
    await config.beforePack({ electronPlatformName: 'linux' })
    expect(rebuilds).toHaveLength(1)
    expect(rebuilds[0].script.replace(/\\/g, '/').endsWith('packages/cli/build.mjs')).toBe(true)
    expect(rebuilds[0].appVersion).toBe(shellPackage.version)
  })

  it('uses the release version electron-builder injects into extraMetadata', async () => {
    const { config, rebuilds } = loadConfig({
      baked: shellPackage.version,
      extraMetadataVersion: '0.5.149',
    })
    await config.beforePack({ electronPlatformName: 'linux' })
    expect(rebuilds).toHaveLength(1)
    expect(rebuilds[0].appVersion).toBe('0.5.149')
  })

  it('leaves an already matching bundle alone', async () => {
    const { config, rebuilds } = loadConfig({ baked: shellPackage.version })
    await config.beforePack({ electronPlatformName: 'linux' })
    expect(rebuilds).toEqual([])
  })

  it('fails the package when the bundle still disagrees after the rebuild', async () => {
    const { config, rebuilds } = loadConfig({ baked: '9.9.9', rebuildApplies: false })
    await expect(config.beforePack({ electronPlatformName: 'linux' })).rejects.toThrow(
      /but the app ships/,
    )
    expect(rebuilds).toHaveLength(1)
  })

  it('packages the CLI bundle whose version the check reads', () => {
    const { config } = loadConfig({ baked: shellPackage.version })
    const shipped = (config as unknown as { extraResources: Array<{ from: string }> })
      .extraResources
    expect(shipped.some((entry) => entry.from === CLI_BUNDLE_REL)).toBe(true)
  })
})

describe('packaged editor completeness', () => {
  for (const editor of ['docs', 'sheets', 'slides', 'pdf', 'markdown', 'html']) {
    for (const entry of ['preload/index.js', 'renderer/index.html']) {
      it(`rejects an existing ${editor} output tree missing ${entry}`, async () => {
        const missing = `../${editor}/out/${entry}`
        const { config } = loadConfig({ baked: shellPackage.version, missing })
        await expect(config.beforePack({ electronPlatformName: 'linux' })).rejects.toThrow(missing)
      })
    }
  }
  for (const platform of ['linux', 'darwin', 'win32']) {
    it(`rejects a missing ${platform} native spreadsheet binary`, async () => {
      const missing = `../sheets/native/xlsx-engine/target/release/xlsx-sidecar${platform === 'win32' ? '.exe' : ''}`
      const { config } = loadConfig({ baked: shellPackage.version, missing })
      await expect(config.beforePack({ electronPlatformName: platform })).rejects.toThrow(
        /native spreadsheet engine missing/,
      )
    })
  }
})

describe('packaged native image runtime', () => {
  it.each(['input', 'import'] as const)(
    'rejects a forbidden embedding %s before packaging',
    async (forbiddenEmbedding) => {
      const { config } = loadConfig({ baked: shellPackage.version, forbiddenEmbedding })
      await expect(config.beforePack({ electronPlatformName: 'linux' })).rejects.toThrow(
        /Forbidden.*image dependency/,
      )
    },
  )

  it('requires an inspected embedding bundle before packaging', async () => {
    const { config } = loadConfig({
      baked: shellPackage.version,
      missing: 'out/embedding/metafile.json',
    })
    await expect(config.beforePack({ electronPlatformName: 'linux' })).rejects.toThrow(
      /Build the native text embedding runtime/,
    )
  })
  it('rejects a stale root canvas even when the shell dependency is patched', async () => {
    const { config } = loadConfig({ baked: shellPackage.version, rootCanvasVersion: '0.34.5' })
    await expect(config.beforePack({ electronPlatformName: 'linux' })).rejects.toThrow(
      `packaged root canvas 0.34.5 does not match the shell pin ${shellPackage.dependencies['@napi-rs/canvas']}`,
    )
  })

  it('rejects a missing root canvas manifest before packaging', async () => {
    const { config } = loadConfig({
      baked: shellPackage.version,
      missing: '../../node_modules/@napi-rs/canvas/package.json',
    })
    await expect(config.beforePack({ electronPlatformName: 'linux' })).rejects.toThrow(
      /extraResources source missing: .*canvas\/package.json/,
    )
  })
})
