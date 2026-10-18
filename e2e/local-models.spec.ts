import { test, expect } from '@playwright/test'
import { mkdtemp, writeFile, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createServer } from 'node:net'
import { launchShell } from './helpers'

test('model overview shows both defaults, keeps advanced controls collapsed, and has one embedding editor', async () => {
  const scratch = await mkdtemp(join(tmpdir(), 'nawa-model-overview-')),
    model = join(scratch, 'example.gguf'),
    engine = join(scratch, 'llama-server.exe')
  await writeFile(model, Buffer.from([71, 71, 85, 70, 3, 0, 0, 0]))
  await writeFile(engine, 'test-only engine')
  const launched = await launchShell({ onboardingSeen: true, videoDir: 'model-overview' }),
    chatPort = await freePort(),
    embeddingPort = await freePort()
  try {
    await launched.page.evaluate(
      async ({ model, engine, chatPort, embeddingPort }) => {
        const snapshot = await window.nawaLocalModels.inspect()
        const common = {
          modelPath: model,
          contextSize: 8192,
          gpuLayers: 'auto' as const,
          threads: 0,
          pooling: 'model' as const,
          autoStart: false,
          arguments: [],
        }
        await window.nawaLocalModels.save(
          {
            executablePath: engine,
            profiles: [
              {
                ...common,
                id: 'overview-chat',
                name: 'Gemma 4 E4B',
                alias: 'gemma-4-e4b',
                kind: 'chat',
                port: chatPort,
              },
              {
                ...common,
                id: 'overview-embedding',
                name: 'EmbeddingGemma 2',
                alias: 'embeddinggemma-2',
                kind: 'embedding',
                port: embeddingPort,
              },
            ],
          },
          snapshot.revision,
        )
        const ai = await window.aiOffice.getAiSettings()
        const config = {
          apiKey: '',
          model: 'gemma-4-e4b',
          baseUrl: `http://127.0.0.1:${chatPort}/v1`,
          policy: { mode: 'local' as const, contextTokens: 8192, outputTokens: 1024 },
        }
        ai.provider = 'custom'
        ai.providers.custom = config
        ai.chatModels = [
          { id: 'overview-default', name: 'Gemma 4 E4B', provider: 'custom', config },
        ]
        ai.defaultChatModelId = 'overview-default'
        await window.aiOffice.setAiSettings(ai)
        const rag = await window.nawaRag.settings()
        await window.nawaRag.save(
          {
            ...rag.settings,
            backend: 'local',
            enabled: true,
            baseUrl: `http://127.0.0.1:${embeddingPort}/v1`,
            model: 'embeddinggemma-2',
            dimensions: 768,
          },
          '',
        )
      },
      { model, engine, chatPort, embeddingPort },
    )
    await openModels(launched.page)
    await expect(launched.page.locator('.lm-connection-card')).toHaveCount(2)
    await expect(launched.page.locator('.lm-connection-card').first()).toContainText('Gemma 4 E4B')
    await expect(launched.page.locator('.lm-connection-card').nth(1)).toContainText(
      'embeddinggemma-2',
    )
    await expect(launched.page.locator('.lm-default-badge')).toHaveCount(2)
    await expect(launched.page.getByRole('tablist')).toHaveCount(0)
    await expect(launched.page.locator('.lm-editor')).toHaveCount(0)
    await expect(launched.page.getByLabel('llama-server executable', { exact: true })).toBeHidden()
    await expect(launched.page.getByLabel('Hugging Face repository', { exact: true })).toBeHidden()
    await launched.page.screenshot({ path: 'e2e/artifacts/model-overview-light.png' })
    await launched.page.evaluate(() => (document.documentElement.dataset.theme = 'dark'))
    await launched.page.screenshot({ path: 'e2e/artifacts/model-overview-dark.png' })
    await launched.page
      .getByRole('button', { name: 'Edit model: Gemma 4 E4B', exact: true })
      .click()
    await expect(launched.page.getByLabel('Served model alias', { exact: true })).toBeHidden()
    await launched.page.locator('.lm-advanced > summary').click()
    await expect(launched.page.getByLabel('Served model alias', { exact: true })).toHaveValue(
      'gemma-4-e4b',
    )
    await launched.page.getByRole('button', { name: 'Close editor', exact: true }).click()
    await launched.page.getByRole('button', { name: 'Knowledge', exact: true }).click()
    await expect(launched.page.locator('.nawa-knowledge-settings .nawa-rag-settings')).toHaveCount(
      0,
    )
    await launched.page
      .getByRole('button', { name: 'Configure models in AI & Models', exact: true })
      .click()
    await expect(
      launched.page.getByRole('button', { name: 'Configure embeddings', exact: true }),
    ).toHaveAttribute('aria-expanded', 'true')
    await expect(launched.page.locator('.nawa-rag-settings')).toHaveCount(1)
    await expect(
      launched.page.locator('.nawa-rag-settings').getByLabel('Embedding model', { exact: true }),
    ).toBeVisible()
  } finally {
    await launched.app.close()
    await rm(scratch, { recursive: true, force: true })
  }
})

for (const locale of [
  {
    lang: 'ar',
    settings: 'الإعدادات',
    title: 'الذكاء الاصطناعي والنماذج',
    profiles: 'ملفات التشغيل المحلية',
    add: 'إضافة نموذج محلي',
    role: 'استخدام النموذج من أجل',
    model: 'نموذج GGUF',
    name: 'اسم العرض',
  },
  {
    lang: 'ja',
    settings: '設定',
    title: 'AI とモデル',
    profiles: 'ローカルプロファイル',
    add: 'ローカルモデルを追加',
    role: 'モデルの用途',
    model: 'GGUF モデル',
    name: '表示名',
  },
])
  test(`local model settings support ${locale.lang} and light / dark themes`, async () => {
    const launched = await launchShell({
      onboardingSeen: true,
      lang: locale.lang,
      videoDir: `local-model-${locale.lang}`,
    })
    try {
      await launched.page.getByRole('button', { name: locale.settings, exact: true }).click()
      await launched.page.getByRole('button', { name: locale.title, exact: true }).click()
      await expect(launched.page.getByRole('tablist')).toHaveCount(0)
      await launched.page.getByRole('button', { name: locale.add, exact: true }).click()
      await launched.page.getByLabel(locale.role, { exact: true }).selectOption('embedding')
      await expect(launched.page.getByLabel(locale.model, { exact: true })).toBeVisible()
      await expect(launched.page.getByLabel(locale.name, { exact: true })).toBeVisible()
      await expect(
        launched.page.locator('.lm-fields input[type="number"]').first(),
      ).toHaveAttribute('dir', 'ltr')
      const advanced = launched.page.locator('.lm-advanced > summary')
      await advanced.focus()
      await advanced.press('Enter')
      await expect(launched.page.locator('.lm-advanced')).toHaveAttribute('open', '')
      await advanced.press('Enter')
      for (const theme of ['light', 'dark']) {
        await launched.page.evaluate(
          (theme) => (document.documentElement.dataset.theme = theme),
          theme,
        )
        await expect
          .poll(() =>
            launched.page
              .locator('.lm-connection-card')
              .first()
              .evaluate((element) => getComputedStyle(element).backgroundColor),
          )
          .toBe(theme === 'light' ? 'rgb(250, 250, 250)' : 'rgb(26, 26, 26)')
        await launched.page.locator('.set-pane').evaluate((element) => (element.scrollTop = 0))
        await launched.page.screenshot({
          path: `e2e/artifacts/local-model-${locale.lang}-${theme}.png`,
        })
        expect(
          await launched.page
            .locator('.set-pane')
            .evaluate((element) => element.scrollWidth <= element.clientWidth + 1),
        ).toBe(true)
      }
    } finally {
      await launched.app.close()
    }
  })

test('official catalogs download verified llama.cpp and GGUF packages', async () => {
  test.skip(
    process.env.NAWA_TEST_MODEL_DOWNLOADS !== '1',
    'Enable network downloads explicitly for this integration scenario.',
  )
  test.setTimeout(300000)
  const launched = await launchShell({ onboardingSeen: true, videoDir: 'local-model-downloads' })
  try {
    const result = await launched.page.evaluate(async () => {
      const release = await window.nawaLocalModels.releases()
      const asset = release.assets.find((a) => a.name.includes('bin-win-cpu-x64'))
      if (!asset) throw new Error('No Windows CPU engine asset found.')
      await window.nawaLocalModels.installEngine(asset.id)
      const files = await window.nawaLocalModels.modelFiles('nomic-ai/nomic-embed-text-v1.5-GGUF')
      const file = files.find((f) => f.name === 'nomic-embed-text-v1.5.Q2_K.gguf')
      if (!file) throw new Error('Embedding model fixture is unavailable.')
      await window.nawaLocalModels.downloadModel(file.repository, file.revision, file.name)
      return window.nawaLocalModels.inspect()
    })
    expect(result.engines.length).toBeGreaterThan(0)
    expect(result.models).toHaveLength(1)
    expect(result.download.state).toBe('completed')
    expect((await readFile(result.models[0].path)).subarray(0, 4).toString()).toBe('GGUF')
    await openModels(launched.page)
    await launched.page.locator('.lm-download-section > summary').click()
    await expect(launched.page.getByLabel('Downloaded models', { exact: true })).toBeVisible()
    await launched.page
      .getByLabel('Downloaded models', { exact: true })
      .selectOption(result.models[0].path)
    await launched.page.getByRole('button', { name: 'Use model file', exact: true }).click()
    await expect(launched.page.getByLabel('GGUF model', { exact: true })).toHaveValue(
      result.models[0].path,
    )
    await expect(launched.page.locator('.lm-download-section')).not.toHaveAttribute('open')
  } finally {
    await launched.app.close()
  }
})

async function openModels(page: Awaited<ReturnType<typeof launchShell>>['page']) {
  await page.getByRole('button', { name: 'Settings', exact: true }).click()
  await page.getByRole('button', { name: 'AI & Models', exact: true }).click()
}
const freePort = () =>
  new Promise<number>((resolve) => {
    const server = createServer()
    server.listen(0, '127.0.0.1', () => {
      const port = (server.address() as { port: number }).port
      server.close(() => resolve(port))
    })
  })
test('AI & Models saves profiles, retains collapsed drafts, and restores after relaunch', async () => {
  const scratch = await mkdtemp(join(tmpdir(), 'nawa-model-ui-'))
  const model = join(scratch, 'example.gguf'),
    engine = join(scratch, 'llama-server.exe')
  await writeFile(model, Buffer.from([71, 71, 85, 70, 3, 0, 0, 0]))
  await writeFile(engine, 'test placeholder; never executed')
  const launched = await launchShell({ onboardingSeen: true, videoDir: 'local-models' })
  let second: Awaited<ReturnType<typeof launchShell>> | undefined
  let firstClosed = false
  try {
    await openModels(launched.page)
    await launched.page.getByRole('button', { name: 'Add local model', exact: true }).click()
    await launched.page.getByLabel('Display name', { exact: true }).fill('My local chat')
    await launched.page.getByLabel('GGUF model', { exact: true }).fill(model)
    await launched.page.getByLabel('llama-server executable', { exact: true }).fill(engine)
    await launched.page.getByRole('button', { name: 'Close editor', exact: true }).click()
    await launched.page
      .getByRole('button', { name: 'Edit model: My local chat', exact: true })
      .click()
    await expect(launched.page.getByLabel('Display name', { exact: true })).toHaveValue(
      'My local chat',
    )
    await launched.page.getByRole('button', { name: 'Save profiles', exact: true }).click()
    await expect(launched.page.getByText('Profiles saved.', { exact: true })).toBeVisible()
    await expect(launched.page.getByRole('button', { name: 'Start', exact: true })).toBeEnabled()
    const config = JSON.parse(
      await readFile(join(launched.userDataDir, 'local-models', 'settings-v1.json'), 'utf8'),
    )
    expect(config.profiles[0]).toMatchObject({
      name: 'My local chat',
      modelPath: model,
      port: 8080,
    })
    await launched.page.locator('.lm-advanced > summary').click()
    await launched.page.getByText('Command preview', { exact: true }).click()
    await expect(launched.page.locator('.lm-code').first()).toContainText('--host" "127.0.0.1')
    await launched.page.locator('.set-pane').evaluate((element) => (element.scrollTop = 0))
    await launched.page.screenshot({ path: 'e2e/artifacts/local-model-profiles.png' })
    await launched.app.close()
    firstClosed = true
    second = await launchShell({
      userDataDir: launched.userDataDir,
      videoDir: 'local-models-reopened',
    })
    await openModels(second.page)
    await second.page
      .getByRole('button', { name: 'Edit model: My local chat', exact: true })
      .click()
    await expect(second.page.getByLabel('Display name', { exact: true })).toHaveValue(
      'My local chat',
    )
    await expect(second.page.getByLabel('GGUF model', { exact: true })).toHaveValue(model)
    await second.page.getByRole('button', { name: 'Delete profile', exact: true }).click()
    await second.page.getByRole('button', { name: 'Confirm delete', exact: true }).click()
    await expect(
      second.page.getByText(
        'Create a chat or embedding profile, select a GGUF model, then save and start it.',
        { exact: true },
      ),
    ).toBeVisible()
    expect(await readFile(model)).toHaveLength(8)
  } finally {
    await second?.app.close()
    if (!firstClosed) await launched.app.close()
    await rm(scratch, { recursive: true, force: true })
  }
})

test('local llama-server starts, serves verified embeddings, restarts, and stops on Nawa exit', async () => {
  test.skip(
    !process.env.NAWA_TEST_LLAMA_SERVER || !process.env.NAWA_TEST_EMBEDDING_MODEL,
    'Set local llama-server and embedding GGUF fixture paths to exercise inference.',
  )
  test.setTimeout(180000)
  const launched = await launchShell({ onboardingSeen: true, videoDir: 'local-model-inference' }),
    port = await freePort()
  let pid: number | undefined
  try {
    await launched.page.evaluate(
      async ({ executable, model, port }) => {
        const snapshot = await window.nawaLocalModels.inspect()
        await window.nawaLocalModels.save(
          {
            executablePath: executable!,
            profiles: [
              {
                id: 'live-embedding',
                name: 'Live embeddings',
                kind: 'embedding',
                modelPath: model!,
                port,
                contextSize: 512,
                gpuLayers: 0,
                threads: 2,
                pooling: 'mean',
                autoStart: false,
                arguments: [],
              },
            ],
          },
          snapshot.revision,
        )
      },
      {
        executable: process.env.NAWA_TEST_LLAMA_SERVER,
        model: process.env.NAWA_TEST_EMBEDDING_MODEL,
        port,
      },
    )
    await openModels(launched.page)
    await launched.page.getByRole('button', { name: 'Start', exact: true }).click()
    await expect(launched.page.locator('.lm-state')).toHaveText('Running', { timeout: 90000 })
    pid = await launched.page.evaluate(
      async () => (await window.nawaLocalModels.inspect()).runtimes[0].pid,
    )
    expect(pid).toBeGreaterThan(0)
    const response = await fetch(`http://127.0.0.1:${port}/v1/embeddings`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: 'live-embedding',
        input: ['search_document: Nawa reads local files.', 'search_query: local files'],
      }),
    })
    expect(response.ok).toBe(true)
    const body = (await response.json()) as { data: { embedding: number[] }[] }
    expect(body.data).toHaveLength(2)
    expect(body.data[0].embedding.length).toBeGreaterThan(100)
    const norm = Math.sqrt(body.data[0].embedding.reduce((sum, n) => sum + n * n, 0))
    expect(norm).toBeCloseTo(1, 3)
    await launched.page.getByRole('button', { name: 'Use for embeddings', exact: true }).click()
    await expect(
      launched.page.getByText(
        'Selected for local embeddings. Re-index affected files in Knowledge.',
        { exact: true },
      ),
    ).toBeVisible()
    expect(
      await launched.page.evaluate(async () => (await window.nawaRag.settings()).settings),
    ).toMatchObject({
      backend: 'local',
      baseUrl: `http://127.0.0.1:${port}/v1`,
      model: 'live-embedding',
      enabled: true,
    })
    await launched.page.getByRole('button', { name: 'Stop', exact: true }).click()
    await expect(launched.page.locator('.lm-state')).toHaveText('Stopped')
    expect(() => process.kill(pid!, 0)).toThrow()
    await launched.page.getByRole('button', { name: 'Start', exact: true }).click()
    await expect(launched.page.locator('.lm-state')).toHaveText('Running', { timeout: 90000 })
    await launched.page
      .getByRole('button', { name: 'Edit model: Live embeddings', exact: true })
      .click()
    const beforeRestart = await launched.page.evaluate(
      async () => (await window.nawaLocalModels.inspect()).runtimes[0].pid,
    )
    await launched.page.getByRole('button', { name: 'Restart', exact: true }).click()
    await expect
      .poll(
        async () => {
          const runtime = await launched.page.evaluate(
            async () => (await window.nawaLocalModels.inspect()).runtimes[0],
          )
          return runtime.state === 'running' && runtime.pid !== beforeRestart
        },
        { timeout: 90000 },
      )
      .toBe(true)
    pid = await launched.page.evaluate(
      async () => (await window.nawaLocalModels.inspect()).runtimes[0].pid,
    )
  } finally {
    await launched.app.close()
  }
  expect(() => process.kill(pid!, 0)).toThrow()
})
