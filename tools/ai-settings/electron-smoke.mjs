/* global window */
/** Windows smoke for both the checkout and an installed/unpacked Nawa.exe. No external network. */
import { _electron as electron } from 'playwright'
import { spawnSync } from 'node:child_process'
import { createServer } from 'node:http'
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import assert from 'node:assert/strict'

const root = resolve('.')
mkdirSync(join(root, '.task'), { recursive: true })
const directory = mkdtempSync(join(root, '.task', 'ai-electron-smoke-'))
const workspace = join(directory, 'smoke-workspace')
mkdirSync(workspace)
writeFileSync(join(workspace, 'notes.md'), '# Smoke workspace\n')
writeFileSync(
  join(directory, 'workspace-folders.json'),
  JSON.stringify({ version: 1, roots: [workspace] }),
)
const packaged = !!process.env.NAWA_SMOKE_EXE
const executablePath = packaged
  ? resolve(process.env.NAWA_SMOKE_EXE)
  : join(root, 'node_modules', 'electron', 'dist', 'electron.exe')
const appArgs = packaged ? [] : [join(root, 'apps', 'shell')]
const env = { ...process.env, GENOFFICE_USER_DATA: directory }
if (packaged) env.GENOFFICE_APP_BIN = executablePath
delete env.ELECTRON_RUN_AS_NODE

const seen = []
const server = createServer((request, response) => {
  seen.push({ path: request.url, authorization: request.headers.authorization })
  request.resume()
  response.writeHead(200, { 'content-type': 'text/event-stream' })
  response.end(
    'data: {"choices":[{"index":0,"delta":{"content":"ok"},"finish_reason":null}]}\n\ndata: {"choices":[{"index":0,"delta":{},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n',
  )
})
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
const address = server.address()
assert.ok(address && typeof address !== 'string')
const baseUrl = `http://127.0.0.1:${address.port}/v1`

try {
  const app = await electron.launch({ executablePath, args: appArgs, env, timeout: 60000 })
  try {
    const page = await app.firstWindow()
    await page.waitForFunction(() => !!window.aiOffice?.getAiSettings, { timeout: 30000 })
    await page.locator('.onb-skip').click()
    await page.getByRole('treeitem', { name: 'smoke-workspace' }).click()
    const sidebar = page.locator('.nawa-workspace-control-panel')
    assert.equal(await sidebar.locator('[role="tab"]').count(), 3)
    for (const tab of ['ai', 'ragAnalytics', 'provider']) {
      const button = sidebar.locator(`[role="tab"][id$="-tab-${tab}"]`)
      await button.click()
      assert.equal(await button.getAttribute('aria-selected'), 'true')
      assert.equal(await sidebar.locator(`.nawa-workspace-panel.is-${tab}`).isVisible(), true)
      if (tab === 'ragAnalytics')
        assert.match(
          await sidebar.locator('.nawa-workspace-context').innerText(),
          /smoke-workspace/,
        )
    }
    const result = await page.evaluate(async (baseUrl) => {
      const settings = await window.aiOffice.getAiSettings()
      settings.provider = 'custom'
      settings.providers.custom = { apiKey: 'fixture-provider-key', model: 'local', baseUrl }
      settings.chatModels = [
        {
          id: 'profile',
          name: 'Profile',
          provider: 'custom',
          config: { apiKey: 'fixture-profile-key', model: 'profile', baseUrl },
        },
      ]
      settings.search.provider = 'tavily'
      settings.search.providers.tavily.apiKey = 'fixture-search-key'
      await window.aiOffice.setAiSettings(settings)
      const view = await window.aiOffice.getAiSettings()
      const leaks =
        JSON.stringify(view).includes('fixture-provider-key') ||
        JSON.stringify(view).includes('fixture-profile-key') ||
        JSON.stringify(view).includes('fixture-search-key')
      const markers =
        view.providers.custom.apiKey === 'nawa:stored-api-key:v1' &&
        view.chatModels[0].config.apiKey === 'nawa:stored-api-key:v1' &&
        view.search.providers.tavily.apiKey === 'nawa:stored-api-key:v1'
      view.providers.custom.model = 'local-updated'
      await window.aiOffice.setAiSettings(view)
      const current = await window.aiOffice.getAiSettings()
      const chunks = []
      const off = window.aiOffice.onAiStreamChunk((chunk) => chunks.push(chunk))
      for (const selectedChatModelId of [undefined, 'profile']) {
        await window.aiOffice.aiStream({
          requestId: crypto.randomUUID(),
          settings: { ...current, selectedChatModelId },
          system: 'test',
          messages: [{ role: 'user', text: 'hello' }],
          tools: [],
          maxTokens: 100,
        })
      }
      await new Promise((resolve, reject) => {
        if (chunks.filter((chunk) => chunk.type === 'done').length >= 2) return resolve()
        const timeout = setTimeout(
          () => reject(new Error('AI stream chunks did not arrive')),
          10000,
        )
        const check = setInterval(() => {
          if (chunks.filter((chunk) => chunk.type === 'done').length < 2) return
          clearInterval(check)
          clearTimeout(timeout)
          resolve()
        }, 10)
      })
      off()
      return {
        leaks,
        markers,
        done: chunks.filter((chunk) => chunk.type === 'done').length,
        errors: chunks.filter((chunk) => chunk.type === 'error').map((chunk) => chunk.error),
      }
    }, baseUrl)
    assert.equal(result.leaks, false)
    assert.equal(result.markers, true)
    assert.deepEqual(result.errors, [])
    assert.equal(result.done, 2)
  } finally {
    await app.close()
  }

  assert.deepEqual(
    seen.map((item) => item.path),
    ['/v1/chat/completions', '/v1/chat/completions'],
  )
  assert.deepEqual(
    seen.map((item) => item.authorization),
    ['Bearer fixture-provider-key', 'Bearer fixture-profile-key'],
  )
  const disk = readFileSync(join(directory, 'ai-settings.json'), 'utf8')
  for (const secret of ['fixture-provider-key', 'fixture-profile-key', 'fixture-search-key'])
    assert.equal(disk.includes(secret), false)

  const headless = spawnSync(executablePath, [...appArgs, '--headless-ai-settings'], {
    env,
    encoding: 'utf8',
    timeout: 30000,
  })
  assert.equal(headless.status, 0, headless.stderr)
  const envelope = JSON.parse(headless.stdout.trim().split(/\r?\n/).at(-1))
  assert.equal(envelope.settings.providers.custom.apiKey, 'fixture-provider-key')
  assert.equal(envelope.settings.chatModels[0].config.apiKey, 'fixture-profile-key')

  const cli = spawnSync(
    process.execPath,
    [
      packaged
        ? join(dirname(executablePath), 'resources', 'cli', 'genoffice.cjs')
        : join(root, 'packages', 'cli', 'dist', 'genoffice.cjs'),
      'capabilities',
      '--json',
    ],
    { env, encoding: 'utf8', timeout: 45000 },
  )
  assert.equal(cli.status, 0, cli.stderr)
  assert.match(cli.stdout, /"via"\s*:\s*"tavily"/)
  console.log(`AI credential smoke passed (${packaged ? 'packaged' : 'checkout'}): ${directory}`)
} finally {
  await new Promise((resolve) => server.close(resolve))
}
