import { test, expect } from '@playwright/test'
import { copyFile, link, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { tmpdir } from 'node:os'
import { createHash } from 'node:crypto'
import { launchShell, closeAndSaveVideo, screenshotPath } from './helpers'

test('a packaged first launch offers setup, includes working OCR, and remembers deferral', async () => {
  test.skip(!process.env.NAWA_TEST_EXECUTABLE, 'Run against the packaged Windows executable.')
  const scratch = await mkdtemp(join(tmpdir(), 'nawa-packaged-setup-')),
    userDataDir = join(scratch, 'state'),
    documents = join(scratch, 'Documents')
  await mkdir(userDataDir)
  await mkdir(documents)
  const image = join(documents, 'ocr.png')
  await copyFile(resolve('packages/pdf2docx/ocr-helper/fixtures/smoke-en.png'), image)
  await writeFile(
    join(userDataDir, 'workspace-folders.json'),
    JSON.stringify({ version: 1, roots: [documents] }),
  )
  let launched = await launchShell({
    userDataDir,
    onboardingSeen: true,
    videoDir: 'packaged-runtime-setup',
    openFile: '--nawa-setup',
  })
  try {
    const expectedVersion = JSON.parse(
      await readFile(resolve('apps/shell/package.json'), 'utf8'),
    ).version
    expect(await launched.app.evaluate(({ app }) => app.getVersion())).toBe(expectedVersion)
    const welcome = launched.page
      .getByRole('dialog')
      .filter({ has: launched.page.locator('.runtime-setup') })
    await expect(welcome).toBeVisible()
    await expect(welcome.locator('select')).toHaveValue('cuda')
    expect(
      await welcome
        .locator('select option')
        .evaluateAll((options) => options.map((option) => (option as HTMLOptionElement).value)),
    ).toEqual(['cuda', 'cpu', 'vulkan'])
    const state = await launched.page.evaluate(async () => window.nawaRuntimeSetup!.inspect())
    expect(state).toMatchObject({ offer: true, supported: true, ocr: true, state: 'idle' })
    expect(state.profiles).toEqual([])
    const recognized = await launched.page.evaluate(
      async ({ image, documents }) => {
        const run = await window.nawaDirectory.begin({
          opened: documents,
          files: [image],
          directories: [],
        })
        try {
          return await window.nawaDirectory.readFile(run, image, 0, 12000)
        } finally {
          await window.nawaDirectory.cancel(run)
        }
      },
      { image, documents },
    )
    expect(recognized.untrustedDocumentText).toContain('OCR Smoke Fixture')
    await launched.page.screenshot({ path: screenshotPath('packaged-runtime-setup-welcome') })
    await welcome.getByRole('button', { name: 'Set up later', exact: true }).click()
    await expect(welcome).toBeHidden()
    await closeAndSaveVideo(launched, 'packaged-runtime-setup')
    launched = await launchShell({
      userDataDir,
      onboardingSeen: true,
      videoDir: 'packaged-runtime-setup-reopen',
    })
    await expect(
      launched.page.getByRole('dialog').filter({ has: launched.page.locator('.runtime-setup') }),
    ).toBeHidden()
    expect(
      await launched.page.evaluate(async () => (await window.nawaRuntimeSetup!.inspect()).offer),
    ).toBe(false)
  } finally {
    await closeAndSaveVideo(launched, 'packaged-runtime-setup-reopen')
    await rm(scratch, { recursive: true, force: true })
  }
})

test('Office setup installs to a private path containing spaces and restores it after restart', async () => {
  test.skip(
    process.platform !== 'win32' || !process.env.NAWA_TEST_OFFICE_INSTALLER,
    'Set a cached official LibreOffice MSI to exercise Windows dependency installation.',
  )
  test.setTimeout(240000)
  const scratch = await mkdtemp(join(tmpdir(), 'nawa office setup ')),
    userDataDir = join(scratch, 'state'),
    setupRoot = join(userDataDir, 'setup')
  await mkdir(setupRoot, { recursive: true })
  const installer = join(setupRoot, 'LibreOffice_26.8.1_Win_x86-64.msi')
  await link(process.env.NAWA_TEST_OFFICE_INSTALLER!, installer).catch(() =>
    copyFile(process.env.NAWA_TEST_OFFICE_INSTALLER!, installer),
  )
  let launched = await launchShell({
    userDataDir,
    onboardingSeen: true,
    videoDir: 'runtime-setup-office',
    env: { NAWA_LIBREOFFICE_PATH: join(scratch, 'not-installed.exe') },
  })
  try {
    const page = launched.page
    expect((await page.evaluate(() => window.nawaRuntimeSetup!.inspect())).office).toBeNull()
    if (!(await page.evaluate(async () => (await window.nawaRuntimeSetup!.inspect()).offer))) {
      await page.getByRole('button', { name: 'Settings', exact: true }).click()
      await page.getByRole('button', { name: 'AI & Models', exact: true }).click()
      await page.getByText('Default models and dependencies', { exact: true }).click()
    }
    const panel = page.locator('.runtime-setup')
    await panel.getByLabel('Chat model — Gemma 4 E4B and chat template', { exact: true }).uncheck()
    await panel
      .getByLabel('Embedding model — EmbeddingGemma 2 and projector', { exact: true })
      .uncheck()
    await panel.getByLabel('Download and use llama.cpp', { exact: true }).uncheck()
    await panel.getByRole('button', { name: 'Install and set up', exact: true }).click()
    await expect
      .poll(async () => (await page.evaluate(() => window.nawaRuntimeSetup!.inspect())).state, {
        timeout: 180000,
      })
      .toMatch(/^(ready|failed|canceled)$/)
    const installed = await page.evaluate(() => window.nawaRuntimeSetup!.inspect())
    expect(installed.state, installed.error).toBe('ready')
    await expect(panel.getByText('Setup complete', { exact: true })).toBeVisible()
    expect(installed.office).toContain(join(userDataDir, 'dependencies', 'libreoffice-26.8.1'))
    expect(installed.profiles).toEqual([])
    expect(await readFile(installed.office!)).not.toHaveLength(0)
    await closeAndSaveVideo(launched, 'runtime-setup-office')
    launched = await launchShell({
      userDataDir,
      onboardingSeen: true,
      videoDir: 'runtime-setup-office-reopen',
    })
    expect((await launched.page.evaluate(() => window.nawaRuntimeSetup!.inspect())).office).toBe(
      installed.office,
    )
  } finally {
    await closeAndSaveVideo(launched, 'runtime-setup-office-reopen')
    await rm(scratch, { recursive: true, force: true })
  }
})

for (const locale of [
  {
    lang: 'en',
    settings: 'Settings',
    models: 'AI & Models',
    summary: 'Default models and dependencies',
    install: 'Install and set up',
  },
  {
    lang: 'ar',
    settings: 'الإعدادات',
    models: 'الذكاء الاصطناعي والنماذج',
    summary: 'النماذج الافتراضية والمتطلبات',
    install: 'تثبيت وإعداد',
  },
  {
    lang: 'ja',
    settings: '設定',
    models: 'AI とモデル',
    summary: '既定モデルと必要なツール',
    install: 'インストールして設定',
  },
])
  test(`runtime setup is accessible in ${locale.lang} without adding settings tabs`, async () => {
    const launched = await launchShell({
      onboardingSeen: true,
      lang: locale.lang,
      videoDir: `runtime-setup-${locale.lang}`,
    })
    try {
      // Packaged builds offer setup immediately; source builds expose it in settings.
      const welcome = launched.page
        .getByRole('dialog')
        .filter({ has: launched.page.locator('.runtime-setup') })
      if (
        await launched.page.evaluate(async () => (await window.nawaRuntimeSetup!.inspect()).offer)
      ) {
        await expect(welcome).toBeVisible()
        await welcome.locator('header button').click()
      }
      await launched.page.getByRole('button', { name: locale.settings, exact: true }).click()
      await launched.page.getByRole('button', { name: locale.models, exact: true }).click()
      await launched.page.getByText(locale.summary, { exact: true }).click()
      await expect(
        launched.page.getByRole('button', { name: locale.install, exact: true }),
      ).toBeVisible()
      await expect(launched.page.locator('.runtime-setup input[type=checkbox]')).toHaveCount(6)
      await expect(launched.page.locator('.runtime-setup select')).toHaveValue('cuda')
      await expect(launched.page.locator('.runtime-setup select option')).toHaveCount(3)
      const choices = launched.page.locator('.runtime-setup input[type=checkbox]')
      await choices.nth(0).uncheck()
      await expect(choices.nth(1)).toBeChecked()
      await expect(choices.nth(2)).toBeChecked()
      await choices.nth(2).uncheck()
      await expect(choices.nth(1)).toBeEnabled()
      await expect(choices.nth(1)).toBeChecked()
      await expect(choices.nth(4)).toBeDisabled()
      await expect(choices.nth(5)).toBeDisabled()
      await expect(launched.page.locator('.runtime-setup select')).toBeDisabled()
      await choices.nth(2).check()
      await choices.nth(0).check()
      await expect(launched.page.getByRole('tablist')).toHaveCount(0)
      await expect(launched.page.locator('.runtime-setup')).toContainText('Gemma 4 E4B')
      await expect(launched.page.locator('.runtime-setup')).toContainText('EmbeddingGemma 2')
      for (const theme of ['light', 'dark']) {
        await launched.page.evaluate(
          (value) => (document.documentElement.dataset.theme = value),
          theme,
        )
        await launched.page.screenshot({
          path: screenshotPath(`runtime-setup-${locale.lang}-${theme}`),
        })
        expect(
          await launched.page
            .locator('.set-pane')
            .evaluate((element) => element.scrollWidth <= element.clientWidth + 1),
        ).toBe(true)
      }
    } finally {
      await closeAndSaveVideo(launched, `runtime-setup-${locale.lang}`)
    }
  })

test('default models install from verified cached assets, activate both connections, and retain launch commands', async () => {
  test.skip(
    !process.env.NAWA_TEST_DEFAULT_MODEL_ROOT,
    'Set a local MyAgent model-cache root to verify full-sized default model files.',
  )
  test.setTimeout(360000)
  if (process.env.NAWA_TEST_DEFAULT_MODEL_INFERENCE === '1') test.setTimeout(600000)
  const scratch = await mkdtemp(join(tmpdir(), 'nawa-default-model-setup-')),
    userDataDir = join(scratch, 'state')
  const modelsRoot = join(userDataDir, 'local-models', 'defaults-v1'),
    setupRoot = join(userDataDir, 'setup')
  await mkdir(modelsRoot, { recursive: true })
  await mkdir(setupRoot, { recursive: true })
  const source = process.env.NAWA_TEST_DEFAULT_MODEL_ROOT!
  await link(
    join(source, 'google/gemma-4-E4B-it-qat-q4_0-gguf/gemma-4-E4B_q4_0-it.gguf'),
    join(modelsRoot, 'gemma-4-E4B_q4_0-it.gguf'),
  )
  for (const name of ['embeddinggemma-2-Q8_0.gguf', 'mmproj-embeddinggemma-2-Q8_0.gguf'])
    await link(join(source, 'ggml-org/embeddinggemma-2-GGUF', name), join(modelsRoot, name))
  const template = Buffer.from(
    await (
      await fetch(
        'https://huggingface.co/google/gemma-4-E4B-it-qat-q4_0-unquantized/resolve/476025a01dbf99361c062bbeca3d6a76bb4c4566/chat_template.jinja',
      )
    ).arrayBuffer(),
  )
  expect(createHash('sha256').update(template).digest('hex')).toBe(
    '0a2c8073c878ab1da004bee933a998606537bbb62016310352c7285c3f01c5b5',
  )
  await writeFile(join(modelsRoot, 'chat_template.jinja'), template)
  for (const name of [
    'llama-b11541-bin-win-cuda-12.4-x64.zip',
    'cudart-llama-bin-win-cuda-12.4-x64.zip',
  ]) {
    await link(resolve('.task/runtime-setup-cache', name), join(setupRoot, name)).catch(() =>
      copyFile(resolve('.task/runtime-setup-cache', name), join(setupRoot, name)),
    )
  }
  const launched = await launchShell({
    userDataDir,
    onboardingSeen: true,
    videoDir: 'runtime-setup-defaults',
  })
  try {
    const page = launched.page
    const welcome = page.getByRole('dialog').filter({ has: page.locator('.runtime-setup') })
    if (await page.evaluate(async () => (await window.nawaRuntimeSetup!.inspect()).offer)) {
      await expect(welcome).toBeVisible()
      await welcome.locator('header button').click()
    }
    await page.getByRole('button', { name: 'Settings', exact: true }).click()
    await page.getByRole('button', { name: 'AI & Models', exact: true }).click()
    await page.getByText('Default models and dependencies', { exact: true }).click()
    const panel = page.locator('.runtime-setup')
    await expect(panel.locator('select')).toHaveValue('cuda')
    await panel.getByLabel('Install Office conversion when missing', { exact: true }).uncheck()
    await panel
      .getByLabel('Start selected models now and when Nawa opens', { exact: true })
      .uncheck()
    await panel.getByRole('button', { name: 'Install and set up', exact: true }).click()
    await expect
      .poll(
        async () => {
          const state = await page.evaluate(() => window.nawaRuntimeSetup!.inspect())
          return state.state === 'ready' && state.needsActivation ? 'activating' : state.state
        },
        { timeout: 300000 },
      )
      .toMatch(/^(ready|failed|canceled)$/)
    const result = await page.evaluate(async () => ({
      setup: await window.nawaRuntimeSetup!.inspect(),
      models: await window.nawaLocalModels.inspect(),
      ai: await window.aiOffice.getAiSettings(),
      rag: await window.nawaRag.settings(),
    }))
    expect(result.setup.state, result.setup.error).toBe('ready')
    await expect(panel.getByText('Setup complete', { exact: true })).toBeVisible()
    expect(result.setup.needsActivation).toBe(false)
    expect(result.setup.profiles).toHaveLength(2)
    expect(result.models.config.executablePath).toContain('default-b11541-cuda-x64')
    expect(result.ai.defaultChatModelId).toBe('runtime-nawa-default-chat')
    expect(result.ai.providers.custom?.model).toBe('gemma-4-e4b')
    expect(result.rag.settings).toMatchObject({
      backend: 'local',
      enabled: true,
      model: 'embeddinggemma-2',
      maxInputTokens: 8192,
      documentPrefix: 'title: none | text: ',
      queryPrefix: 'task: search result | query: ',
    })
    expect(JSON.stringify(result.setup.profiles)).not.toContain('MyAgent')
    const command = JSON.parse(await readFile(join(setupRoot, 'chat.command.json'), 'utf8'))
    expect(command.arguments).toContain(join(modelsRoot, 'chat_template.jinja'))
    expect(await readFile(join(setupRoot, 'Start-chat.ps1'), 'utf8')).toContain('@runtimeArgs')
    if (process.env.NAWA_TEST_DEFAULT_MODEL_INFERENCE === '1') {
      for (const kind of ['embedding', 'chat']) {
        const profile = result.setup.profiles.find((value) => value.kind === kind)!
        try {
          await page.evaluate((id) => window.nawaLocalModels.control('start', id), profile.id)
          await expect
            .poll(
              async () => {
                const runtime = (
                  await page.evaluate(() => window.nawaLocalModels.inspect())
                ).runtimes.find((value) => value.id === profile.id)!
                if (runtime.state === 'failed')
                  throw new Error(`${runtime.error}\n${runtime.logs.slice(-1800)}`)
                return runtime.state
              },
              { timeout: 150000 },
            )
            .toBe('running')
          const response = await fetch(
            `http://127.0.0.1:${profile.port}/v1/${kind === 'chat' ? 'chat/completions' : 'embeddings'}`,
            {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify(
                kind === 'chat'
                  ? {
                      model: profile.alias,
                      messages: [{ role: 'user', content: 'Reply with exactly: Nawa ready.' }],
                      max_tokens: 16,
                    }
                  : {
                      model: profile.alias,
                      input: ['task: search result | query: Nawa local files'],
                    },
              ),
            },
          )
          expect(response.ok).toBe(true)
          const body = await response.json()
          if (kind === 'chat')
            expect(body.choices[0].message.content.trim().length).toBeGreaterThan(0)
          else {
            const vector = body.data[0].embedding as number[]
            expect(vector).toHaveLength(768)
            expect(Math.sqrt(vector.reduce((sum, value) => sum + value * value, 0))).toBeCloseTo(
              1,
              3,
            )
          }
        } finally {
          await page.evaluate((id) => window.nawaLocalModels.control('stop', id), profile.id)
        }
      }
    }
    await page.screenshot({ path: screenshotPath('runtime-setup-defaults-complete') })
  } finally {
    await closeAndSaveVideo(launched, 'runtime-setup-defaults')
    await rm(scratch, { recursive: true, force: true })
  }
})
