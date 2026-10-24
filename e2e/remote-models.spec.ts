import { test, expect, type Page } from '@playwright/test'
import { createServer } from 'node:http'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { launchShell, closeAndSaveVideo, screenshotPath } from './helpers'

async function openModels(page: Page, settings = 'Settings', models = 'AI & Models') {
  const welcome = page.getByRole('dialog').filter({ has: page.locator('.runtime-setup') })
  if (await page.evaluate(async () => (await window.nawaRuntimeSetup!.inspect()).offer)) {
    await expect(welcome).toBeVisible()
    await welcome.locator('header button').click()
  }
  await page.getByRole('button', { name: settings, exact: true }).click()
  await page.getByRole('button', { name: models, exact: true }).click()
}
test('remote chat and embedding profiles persist, use their own protected credentials, and apply to real consumers', async () => {
  test.setTimeout(180000)
  const calls: { model: string; authorization: string; input?: unknown }[] = []
  const server = createServer(async (request, response) => {
    const chunks: Buffer[] = []
    for await (const chunk of request) chunks.push(Buffer.from(chunk))
    const body = chunks.length ? JSON.parse(Buffer.concat(chunks).toString('utf8')) : {}
    const authorization = request.headers.authorization ?? ''
    calls.push({ model: body.model ?? '$catalog', authorization, input: body.input })
    if (request.method === 'GET' && request.url === '/v1/models') {
      const models =
        authorization === 'Bearer chat-key-a'
          ? ['chat-a', 'chat-a-extra']
          : authorization === 'Bearer chat-key-b'
            ? ['chat-b']
            : authorization === 'Bearer embedding-key'
              ? ['embed-a']
              : null
      response.writeHead(models ? 200 : 401, { 'Content-Type': 'application/json' })
      response.end(JSON.stringify({ data: models?.map((id) => ({ id })) ?? [] }))
      return
    }
    const expected =
      body.model === 'chat-a'
        ? 'chat-key-a'
        : body.model === 'chat-b'
          ? 'chat-key-b'
          : 'embedding-key'
    if (authorization !== `Bearer ${expected}`) {
      response.writeHead(401)
      response.end()
      return
    }
    if (request.url === '/v1/embeddings') {
      response.setHeader('Content-Type', 'application/json')
      response.end(
        JSON.stringify({
          data: body.input.map((_value: string, index: number) => ({
            index,
            embedding: [1, 0, 0],
          })),
        }),
      )
      return
    }
    if (request.url === '/v1/chat/completions') {
      response.writeHead(200, { 'Content-Type': 'text/event-stream' })
      const proof = /VERIFIED_[a-z0-9]+/i.exec(JSON.stringify(body.messages))?.[0]
      const nonce = body.tools?.[0]?.function?.parameters?.properties?.nonce?.enum?.[0]
      const delta = proof
        ? { content: proof }
        : {
            tool_calls: [
              {
                index: 0,
                id: 'probe-call',
                type: 'function',
                function: { name: 'nawa_capability_check', arguments: JSON.stringify({ nonce }) },
              },
            ],
          }
      response.write(
        `data: ${JSON.stringify({ choices: [{ index: 0, delta, finish_reason: null }] })}\n\n`,
      )
      response.write(
        `data: ${JSON.stringify({ choices: [{ index: 0, delta: {}, finish_reason: proof ? 'stop' : 'tool_calls' }] })}\n\n`,
      )
      response.end('data: [DONE]\n\n')
      return
    }
    response.writeHead(404)
    response.end()
  })
  await new Promise<void>((done) => server.listen(0, '127.0.0.1', done))
  const address = server.address() as { port: number },
    baseUrl = `http://127.0.0.1:${address.port}/v1`
  const root = await mkdtemp(join(tmpdir(), 'nawa-remote-models-'))
  let launched = await launchShell({
    userDataDir: root,
    onboardingSeen: true,
    videoDir: 'remote-models',
  })
  try {
    let page = launched.page
    await openModels(page)
    let panel = page.getByRole('region', { name: 'Remote models', exact: true })
    const addChat = async (name: string, model: string, key: string) => {
      await panel.getByRole('button', { name: 'Add remote model', exact: true }).click()
      const editor = panel.getByRole('form', { name: 'Edit remote model', exact: true })
      await editor.getByLabel('Display name', { exact: true }).fill(name)
      await editor.getByLabel('API base URL', { exact: true }).fill(baseUrl)
      await editor.getByLabel('API key (optional)', { exact: true }).fill(key)
      await expect(
        editor
          .getByLabel('Available models', { exact: true })
          .locator(`option[value="model:${model}"]`),
      ).toHaveCount(1)
      await editor.getByLabel('Available models', { exact: true }).selectOption(`model:${model}`)
      await editor.getByRole('button', { name: 'Test connection', exact: true }).click()
      await expect(panel.getByText('Connection verified.', { exact: true })).toBeVisible()
      await editor.getByRole('button', { name: 'Save profile', exact: true }).click()
      await expect(editor).toBeHidden()
    }
    await addChat('Remote chat A', 'chat-a', 'chat-key-a')
    let chatA = panel.getByRole('article').filter({ hasText: 'Remote chat A' })
    await chatA.getByRole('button', { name: 'Use as default', exact: true }).click()
    await expect(chatA.getByText('Default', { exact: true })).toBeVisible()
    await addChat('Remote chat B', 'chat-b', 'chat-key-b')
    await chatA.getByRole('button', { name: 'Edit', exact: true }).click()
    let editor = panel.getByRole('form', { name: 'Edit remote model', exact: true })
    await expect(editor.getByLabel('API key (optional)', { exact: true })).toHaveValue('')
    await expect(editor.getByLabel('API key (optional)', { exact: true })).toHaveAttribute(
      'placeholder',
      /Saved key/,
    )
    await editor.getByLabel('Display name', { exact: true }).fill('Remote chat renamed')
    await editor.getByRole('button', { name: 'Test connection', exact: true }).click()
    await expect(panel.getByText('Connection verified.', { exact: true })).toBeVisible()
    await editor.getByRole('button', { name: 'Save profile', exact: true }).click()
    await expect(editor).toBeHidden()
    await panel.getByRole('button', { name: 'Add remote model', exact: true }).click()
    editor = panel.getByRole('form', { name: 'Edit remote model', exact: true })
    await editor.getByLabel('Use this model for', { exact: true }).selectOption('embedding')
    await editor.getByLabel('Display name', { exact: true }).fill('Remote vectors')
    await editor.getByLabel('API base URL', { exact: true }).fill(baseUrl)
    await editor.getByLabel('API key (optional)', { exact: true }).fill('embedding-key')
    await expect(
      editor
        .getByLabel('Available models', { exact: true })
        .locator('option[value="model:embed-a"]'),
    ).toHaveCount(1)
    await editor.getByLabel('Available models', { exact: true }).selectOption('model:embed-a')
    await editor.getByText('Embedding options', { exact: true }).click()
    await editor.getByLabel('Document prefix', { exact: true }).fill('document: ')
    await editor.getByLabel('Query prefix', { exact: true }).fill('query: ')
    await editor.getByRole('button', { name: 'Test connection', exact: true }).click()
    await expect(panel.getByText(/Connection verified\. 3/)).toBeVisible()
    await editor.getByRole('button', { name: 'Save profile', exact: true }).click()
    await expect(editor).toBeHidden()
    const vectors = panel.getByRole('article').filter({ hasText: 'Remote vectors' })
    expect((await page.evaluate(() => window.nawaRag.settings())).settings.enabled).toBe(false)
    await vectors.getByRole('button', { name: 'Use as default', exact: true }).click()
    await expect(vectors.getByText('Default', { exact: true })).toBeVisible()
    const configured = await page.evaluate(async () => ({
      chat: await window.aiOffice.getAiSettings(),
      embeddings: await window.nawaRemoteEmbeddings.list(),
      rag: await window.nawaRag.settings(),
    }))
    const chosen = configured.chat.chatModels!.find(
      (profile) => profile.id === configured.chat.defaultChatModelId,
    )!
    expect(chosen.name).toBe('Remote chat renamed')
    expect(chosen.config.apiKey).not.toBe('chat-key-a')
    expect(configured.rag.settings).toMatchObject({
      baseUrl,
      model: 'embed-a',
      dimensions: 3,
      documentPrefix: 'document: ',
      queryPrefix: 'query: ',
    })
    expect(configured.embeddings.profiles[0].hasKey).toBe(true)
    expect(await readFile(join(root, 'ai-settings.json'), 'utf8')).not.toContain('chat-key-a')
    expect(
      await readFile(join(root, 'remote-models/embedding-profiles-v1.json'), 'utf8'),
    ).not.toContain('embedding-key')
    expect(
      calls
        .filter((call) => call.model === 'chat-a')
        .every((call) => call.authorization === 'Bearer chat-key-a'),
    ).toBe(true)
    expect(
      calls.some((call) => call.model === 'chat-b' && call.authorization === 'Bearer chat-key-b'),
    ).toBe(true)
    expect(
      calls.some(
        (call) => call.model === 'embed-a' && call.authorization === 'Bearer embedding-key',
      ),
    ).toBe(true)
    for (const key of ['chat-key-a', 'chat-key-b', 'embedding-key'])
      expect(
        calls.some((call) => call.model === '$catalog' && call.authorization === `Bearer ${key}`),
      ).toBe(true)
    await page.screenshot({ path: screenshotPath('remote-models-profiles') })
    await closeAndSaveVideo(launched, 'remote-models')
    launched = await launchShell({
      userDataDir: root,
      onboardingSeen: true,
      videoDir: 'remote-models-restart',
    })
    page = launched.page
    await openModels(page)
    panel = page.getByRole('region', { name: 'Remote models', exact: true })
    await expect(panel.getByRole('article')).toHaveCount(3)
    chatA = panel.getByRole('article').filter({ hasText: 'Remote chat renamed' })
    await expect(chatA.getByText('Default', { exact: true })).toBeVisible()
    await expect(chatA.getByRole('button', { name: 'Delete', exact: true })).toBeDisabled()
    await chatA.getByRole('button', { name: 'Edit', exact: true }).click()
    editor = panel.getByRole('form', { name: 'Edit remote model', exact: true })
    await editor.getByLabel('Display name', { exact: true }).fill('Conflicting edit')
    await page.evaluate(async () => {
      const current = await window.aiOffice.getAiSettings()
      await window.aiOffice.setAiSettings({ ...current, maxOutputTokens: 2048 })
    })
    await editor.getByRole('button', { name: 'Save profile', exact: true }).click()
    await expect(panel.getByRole('alert')).toContainText('changed in another editor')
    await expect(editor.getByLabel('Display name', { exact: true })).toHaveValue('Conflicting edit')
    await editor.getByRole('button', { name: 'Cancel', exact: true }).click()
    await panel.getByRole('button', { name: 'Discard changes', exact: true }).click()
    const chatB = panel.getByRole('article').filter({ hasText: 'Remote chat B' })
    await chatB.getByRole('button', { name: 'Delete', exact: true }).click()
    await panel
      .getByRole('alertdialog')
      .getByRole('button', { name: 'Delete', exact: true })
      .click()
    await expect(panel.getByRole('article')).toHaveCount(2)
  } finally {
    await closeAndSaveVideo(launched, 'remote-models-restart')
    await new Promise<void>((done) => server.close(() => done()))
    await rm(root, { recursive: true, force: true })
  }
})

test('a failed remote capability test is retained when the profile is saved', async () => {
  const server = createServer(async (request, response) => {
    for await (const _chunk of request) {
      /* drain the synthetic test request */
    }
    response.writeHead(200, { 'Content-Type': 'text/event-stream' })
    response.end(
      `data: ${JSON.stringify({ choices: [{ index: 0, delta: { content: 'Plain text only.' }, finish_reason: 'stop' }] })}\n\ndata: [DONE]\n\n`,
    )
  })
  await new Promise<void>((done) => server.listen(0, '127.0.0.1', done))
  const port = (server.address() as { port: number }).port
  const root = await mkdtemp(join(tmpdir(), 'nawa-remote-capability-'))
  const launched = await launchShell({
    userDataDir: root,
    onboardingSeen: true,
    videoDir: 'remote-models-capability',
  })
  try {
    await openModels(launched.page)
    const panel = launched.page.getByRole('region', { name: 'Remote models', exact: true })
    await panel.getByRole('button', { name: 'Add remote model', exact: true }).click()
    const editor = panel.getByRole('form', { name: 'Edit remote model', exact: true })
    await editor.getByLabel('Display name', { exact: true }).fill('Plain chat')
    await editor.getByLabel('API base URL', { exact: true }).fill(`http://127.0.0.1:${port}/v1`)
    await editor.getByLabel('Model ID or alias', { exact: true }).fill('plain')
    await editor.getByLabel('API key (optional)', { exact: true }).fill('nawa:stored-api-key:v1')
    await editor.getByRole('button', { name: 'Test connection', exact: true }).click()
    await expect(panel.getByRole('alert')).toContainText('saved-key marker is not an API key')
    await editor.getByLabel('API key (optional)', { exact: true }).fill('')
    await editor.getByRole('button', { name: 'Test connection', exact: true }).click()
    await expect(panel.getByRole('alert')).toContainText('did not return a valid function call')
    await editor.getByRole('button', { name: 'Save profile', exact: true }).click()
    await expect(editor).toBeHidden()
    const settings = await launched.page.evaluate(() => window.aiOffice.getAiSettings())
    expect(
      settings.chatModels!.find((profile) => profile.name === 'Plain chat')!.config.policy!.tested!
        .tools,
    ).toBe(false)
  } finally {
    await closeAndSaveVideo(launched, 'remote-models-capability')
    await new Promise<void>((done) => server.close(() => done()))
    await rm(root, { recursive: true, force: true })
  }
})

for (const locale of [
  {
    lang: 'ar',
    settings: 'الإعدادات',
    models: 'الذكاء الاصطناعي والنماذج',
    remote: 'النماذج البعيدة',
    add: 'إضافة نموذج بعيد',
  },
  {
    lang: 'ja',
    settings: '設定',
    models: 'AI とモデル',
    remote: 'リモートモデル',
    add: 'リモートモデルを追加',
  },
])
  test(`remote model profiles are accessible in ${locale.lang} and both themes`, async () => {
    const launched = await launchShell({
      onboardingSeen: true,
      lang: locale.lang,
      videoDir: `remote-models-${locale.lang}`,
    })
    try {
      await openModels(launched.page, locale.settings, locale.models)
      const panel = launched.page.getByRole('region', { name: locale.remote, exact: true })
      await panel.getByRole('button', { name: locale.add, exact: true }).click()
      await expect(panel.locator('form select').first()).toHaveValue('chat')
      await panel.locator('form select').first().selectOption('embedding')
      await expect(panel.locator('form input[type=checkbox]')).toBeVisible()
      await expect(launched.page.getByRole('tablist')).toHaveCount(0)
      for (const theme of ['light', 'dark']) {
        await launched.page.evaluate((value) => {
          document.documentElement.dataset.theme = value
        }, theme)
        expect(
          await launched.page
            .locator('.set-pane')
            .evaluate((element) => element.scrollWidth <= element.clientWidth + 1),
          JSON.stringify(
            await launched.page.locator('.set-pane').evaluate((pane) => {
              const bounds = pane.getBoundingClientRect()
              return {
                width: pane.clientWidth,
                scroll: pane.scrollWidth,
                outside: [...pane.querySelectorAll('*')]
                  .filter((node) => node.getBoundingClientRect().right > bounds.right + 1)
                  .slice(0, 12)
                  .map((node) => ({
                    tag: node.tagName,
                    class: String(node.className),
                    width: node.getBoundingClientRect().width,
                    min: getComputedStyle(node).minWidth,
                    text: node.textContent?.slice(0, 70),
                  })),
              }
            }),
          ),
        ).toBe(true)
        await launched.page.screenshot({
          path: screenshotPath(`remote-models-${locale.lang}-${theme}`),
        })
      }
    } finally {
      await closeAndSaveVideo(launched, `remote-models-${locale.lang}`)
    }
  })
