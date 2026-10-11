import { existsSync, readFileSync } from 'node:fs'
import { spawn } from 'node:child_process'
import { join, resolve } from 'node:path'
import { readAiSettingsFile, setGskProxyUrl } from '@genoffice/ai-search'
import type { AiSettings } from '@genoffice/ai-provider'
import { PROTECTED_AI_KEY_PREFIX } from '@genoffice/electron-utils/ai-settings-store'
import { genofficeUserDataDir } from './gui'
import { packagedResourcesDir } from './resources'
import { appLaunch } from './resources'
import { CliError, EXIT } from './result'

/**
 * The cloud commands (search / image / media) reuse the editors' provider
 * routing: Genspark when signed in (~/.genoffice/auth.json) and cloud tools
 * are on, otherwise the BYOK provider chosen in the app's AI settings. That
 * settings file lives in the shell's Electron userData directory, which Nawa
 * has to locate without Electron.
 */
export function aiSettingsPath(env: NodeJS.ProcessEnv): string {
  return env.GENOFFICE_AI_SETTINGS || join(genofficeUserDataDir(env), 'ai-settings.json')
}

/** Ask the app to unlock protected BYOK keys for this one CLI process. */
export async function loadCloudSettings(env: NodeJS.ProcessEnv): Promise<AiSettings> {
  const path = aiSettingsPath(env)
  if (!existsSync(path) || !readFileSync(path, 'utf8').includes(PROTECTED_AI_KEY_PREFIX))
    return readAiSettingsFile(path)
  if (
    env.GENOFFICE_AI_SETTINGS &&
    resolve(path) !== resolve(join(genofficeUserDataDir(env), 'ai-settings.json'))
  ) {
    throw new CliError(
      EXIT.app,
      'Protected alternate AI settings cannot be unlocked by the app; use its default settings path.',
    )
  }
  const launch = appLaunch(env)
  if (!launch)
    throw new CliError(EXIT.app, 'Nawa is required to unlock its protected AI settings.', {
      hint: 'Install Nawa or set GENOFFICE_APP_BIN.',
    })
  const childEnv = { ...env }
  delete childEnv.ELECTRON_RUN_AS_NODE
  let child: ReturnType<typeof spawn>
  try {
    child = spawn(launch.command, [...launch.args, '--headless-ai-settings'], {
      env: childEnv,
      stdio: ['ignore', 'pipe', 'ignore'],
      windowsHide: true,
    })
  } catch (error) {
    throw new CliError(
      EXIT.app,
      `Could not start Nawa to unlock AI settings: ${error instanceof Error ? error.message : String(error)}`,
    )
  }
  let output = '',
    timedOut = false,
    tooLarge = false
  const timer = setTimeout(() => {
    timedOut = true
    child.kill()
  }, 30_000)
  try {
    const code = await new Promise<number | null>((resolve, reject) => {
      child.on('error', reject)
      child.on('close', resolve)
      child.stdout?.on('data', (chunk: Buffer) => {
        output += chunk.toString('utf8')
        if (output.length > 2_000_000) {
          tooLarge = true
          child.kill()
        }
      })
    })
    if (timedOut) throw new CliError(EXIT.app, 'Nawa timed out while unlocking AI settings.')
    if (tooLarge) throw new CliError(EXIT.app, 'Nawa returned too much AI settings data.')
    for (const line of output.trim().split(/\r?\n/).reverse()) {
      try {
        const result = JSON.parse(line) as {
          status?: string
          settings?: AiSettings
          error?: string
        }
        if (result.status === 'error')
          throw new CliError(EXIT.app, result.error || 'Nawa could not unlock AI settings.')
        if (result.status === 'ok' && code === 0 && result.settings?.providers)
          return result.settings
      } catch (error) {
        if (error instanceof CliError) throw error
      }
    }
    throw new CliError(
      EXIT.app,
      'Nawa did not return unlocked AI settings. Update the installed app or set GENOFFICE_APP_BIN.',
    )
  } catch (error) {
    if (error instanceof CliError) throw error
    throw new CliError(
      EXIT.app,
      `Could not start Nawa to unlock AI settings: ${error instanceof Error ? error.message : String(error)}`,
    )
  } finally {
    clearTimeout(timer)
  }
}

/** First http(s) proxy in the usual environment variables, as the app's main process reads them. */
export function proxyUrlFromEnv(env: NodeJS.ProcessEnv): string | null {
  return (
    [
      env.HTTPS_PROXY,
      env.https_proxy,
      env.HTTP_PROXY,
      env.http_proxy,
      env.ALL_PROXY,
      env.all_proxy,
    ].find((v) => v && /^https?:\/\//.test(v)) ?? null
  )
}

let prepared = false

/** Once per process: proxy for fetch and the gsk children, and the packaged gsk CLI location. */
export async function prepareCloud(env: NodeJS.ProcessEnv): Promise<void> {
  if (prepared) return
  prepared = true
  const proxy = proxyUrlFromEnv(env)
  if (proxy) {
    setGskProxyUrl(proxy)
    const { EnvHttpProxyAgent, setGlobalDispatcher } = await import('undici')
    // Cloud commands also run inside the long-lived MCP process. A plain
    // ProxyAgent would send its local transport (and local model providers)
    // through the remote proxy, even when the caller explicitly bypasses them.
    setGlobalDispatcher(
      new EnvHttpProxyAgent({
        httpProxy: proxy,
        httpsProxy: proxy,
        noProxy: ['localhost', '127.0.0.1', '[::1]', env.no_proxy ?? env.NO_PROXY ?? '']
          .filter(Boolean)
          .join(','),
      }),
    )
  }
  const packaged = packagedResourcesDir()
  if (packaged && !env.GSK_CLI_PATH) {
    const entry = join(packaged, 'gsk', 'node_modules', '@genspark', 'cli', 'dist', 'index.js')
    if (existsSync(entry)) process.env.GSK_CLI_PATH = entry
  }
}
