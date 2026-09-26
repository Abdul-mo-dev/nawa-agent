import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { StringDecoder } from 'node:string_decoder'

/**
 * Shell-main half of the MCP → `Nawa` CLI delegation.
 *
 * The app already ships the CLI (`@genoffice/cli`) and runs it on its own Node
 * runtime, so the headless MCP tools do not reimplement document engines: they
 * spawn the same CLI a shell user or another agent would, with `--json`, and
 * map its result contract (`{ status, command, summary, output_path, detail }`,
 * exit codes 0-4 — see packages/cli/src/result.ts) back to a tool result.
 *
 * Spawning (not importing) is deliberate: the CLI entry bundles jsdom/jszip/
 * undici and the whole engine surface, none of which belongs inside the Electron
 * main bundle. The runner is injectable so unit tests use a fake instead of a
 * process.
 */

/** the CLI's `--json` success payload */
export interface CliJsonOk {
  status: 'ok'
  command: string
  summary: string
  output_path?: string
  detail?: Record<string, unknown>
}

/** the CLI's `--json` error payload; `code` mirrors the process exit code */
export interface CliJsonError {
  status: 'error'
  command: string | null
  code: number
  message: string
  detail?: Record<string, unknown>
}

export interface CliRunOutcome {
  ok: boolean
  /** process exit code, or -1 when the process never started/produced output */
  code: number
  json?: CliJsonOk | CliJsonError
  stdout: string
  stderr: string
}

export interface CliRunOptions {
  /** text piped to stdin (for commands that read `-`, e.g. `create --ops -`) */
  input?: string
  /** abort the child after this long; default 120s (the CLI lazily loads jsdom) */
  timeoutMs?: number
  signal?: AbortSignal
  cwd?: string
  maxOutputBytes?: number
}

export interface CliRunner {
  /** run `Nawa <args> --json`; never rejects — failures come back as `ok:false` */
  run(args: string[], options?: CliRunOptions): Promise<CliRunOutcome>
}

export interface CliRunnerPaths {
  /** node/electron executable that runs the CLI entry */
  executable: string
  /** absolute path to the bundled CLI entry (dist/genoffice.cjs) */
  entry: string
  /** extra environment (the runner adds ELECTRON_RUN_AS_NODE when needed) */
  env?: NodeJS.ProcessEnv
}

function parseJson(stdout: string): CliJsonOk | CliJsonError | undefined {
  const text = stdout.trim()
  if (!text) return undefined
  // the CLI prints exactly one JSON object with --json; take the last line so a
  // stray warning on stdout cannot mask it
  const lastLine = text.split('\n').filter(Boolean).at(-1) ?? text
  try {
    const parsed = JSON.parse(lastLine) as CliJsonOk | CliJsonError
    return parsed && typeof parsed === 'object' && 'status' in parsed ? parsed : undefined
  } catch {
    return undefined
  }
}

export function createCliRunner(paths: CliRunnerPaths): CliRunner {
  return {
    run(args, options = {}) {
      const timeoutMs = options.timeoutMs ?? 120_000
      if (options.signal?.aborted) return Promise.resolve({ ok: false, code: -1, stdout: '', stderr: 'Cancelled' })
      return new Promise<CliRunOutcome>((resolve) => {
        let child: ChildProcessWithoutNullStreams
        try {
          child = spawn(paths.executable, [paths.entry, ...args, '--json'], {
            env: { ...process.env, ELECTRON_RUN_AS_NODE: '1', ...paths.env },
            windowsHide: true,
            cwd: options.cwd,
            shell: false,
            detached: process.platform !== 'win32',
          })
        } catch (cause) {
          resolve({ ok: false, code: -1, stdout: '', stderr: String(cause) })
          return
        }
        let stdout = ''
        let stderr = ''
        let settled = false
        let outputBytes = 0
        const outputDecoder = new StringDecoder('utf8')
        const errorDecoder = new StringDecoder('utf8')
        const finish = (outcome: CliRunOutcome): void => {
          if (settled) return
          settled = true
          clearTimeout(timer)
          options.signal?.removeEventListener('abort', abort)
          resolve(outcome)
        }
        const terminate = (): void => {
          if (!child.pid) return
          if (process.platform === 'win32') {
            const killer = spawn('taskkill', ['/pid', String(child.pid), '/T', '/F'], { windowsHide: true, shell: false })
            killer.on('error', () => { child.kill() })
            killer.on('close', code => { if (code !== 0) child.kill() })
          } else {
            try { process.kill(-child.pid, 'SIGKILL') } catch { child.kill('SIGKILL') }
          }
        }
        const abort = () => { terminate(); finish({ ok: false, code: -1, stdout, stderr: `${stderr}\nNawa cancelled` }) }
        const timer = setTimeout(() => {
          terminate()
          finish({ ok: false, code: -1, stdout, stderr: `${stderr}\nNawa timed out` })
        }, timeoutMs)
        const max = options.maxOutputBytes ?? 4 * 1024 * 1024
        const append = (chunk: Buffer, err: boolean) => {
          if (settled) return
          outputBytes += chunk.length
          if (outputBytes > max) {
            terminate(); finish({ ok: false, code: -1, stdout, stderr: 'CLI output exceeded its safety limit.' }); return
          }
          if (err) stderr += errorDecoder.write(chunk)
          else stdout += outputDecoder.write(chunk)
        }
        child.stdout?.on('data', (chunk: Buffer) => append(chunk, false))
        child.stderr?.on('data', (chunk: Buffer) => append(chunk, true))
        options.signal?.addEventListener('abort', abort, { once: true })
        if (options.signal?.aborted) abort()
        child.on('error', (err) => {
          finish({ ok: false, code: -1, stdout, stderr: `${stderr}\n${String(err)}` })
        })
        child.on('close', (code) => {
          if (settled) return
          stdout += outputDecoder.end()
          stderr += errorDecoder.end()
          const json = parseJson(stdout)
          finish({
            ok: code === 0 && json?.status === 'ok',
            code: code ?? -1,
            json,
            stdout,
            stderr,
          })
        })
        child.stdin?.on('error', error => {
          if (!settled && (error as NodeJS.ErrnoException).code !== 'EPIPE') {
            terminate()
            finish({ ok: false, code: -1, stdout, stderr: `${stderr}\n${String(error)}` })
          }
        })
        if (options.input !== undefined) child.stdin?.end(options.input)
        else child.stdin?.end()
      })
    },
  }
}

/** turn a failed CLI run into a tool error message an agent can act on */
export function cliErrorMessage(outcome: CliRunOutcome): string {
  if (outcome.json && outcome.json.status === 'error') return outcome.json.message
  const detail = outcome.stderr.trim() || outcome.stdout.trim()
  return detail ? `Nawa failed: ${detail}` : `Nawa exited with code ${outcome.code}`
}
