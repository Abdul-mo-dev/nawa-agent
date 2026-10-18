import { test, expect } from '@playwright/test'
import { copyFile, mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { tmpdir } from 'node:os'
import { createServer } from 'node:http'
import { closeAndSaveVideo, launchShell, screenshotPath, waitForPageWithUrl } from './helpers'

test('images and saved emails open in file tabs, including TIFF', async () => {
  const launched = await launchShell({ onboardingSeen: true, videoDir: 'extended-previews' })
  const { page } = launched
  try {
    for (const extension of ['png', 'tiff']) {
      const path = resolve(`test-files/extended-formats/sample.${extension}`)
      await page.evaluate((path) => window.aiOffice.openPath(path), path)
      const viewer = page.getByRole('region', { name: 'File preview', exact: true })
      await expect(viewer).toBeVisible()
      await expect(viewer.locator('img')).toHaveJSProperty('naturalWidth', 800)
      await viewer.getByRole('button', { name: 'Zoom in' }).click()
      await page.screenshot({ path: screenshotPath(`extended-preview-${extension}`) })
      await viewer.getByRole('button', { name: 'Close file', exact: true }).click()
      await expect(viewer).toHaveCount(0)
    }
    for (const extension of ['eml', 'msg']) {
      await page.evaluate(
        (path) => window.aiOffice.openPath(path),
        resolve(`test-files/extended-formats/sample.${extension}`),
      )
      const preview = page.getByRole('region', { name: 'File preview', exact: true })
      await expect(preview.getByRole('heading', { name: 'Nawa project review' })).toBeVisible()
      await expect(preview).toContainText('sender@example.com')
      await expect(preview).toContainText('日本語 / العربية')
      await expect(preview.locator('iframe, img, script')).toHaveCount(0)
      await page.screenshot({ path: screenshotPath(`extended-preview-${extension}`) })
      await preview.getByRole('button', { name: 'Close file', exact: true }).click()
      await expect(preview).toHaveCount(0)
    }
    await expect(
      page.evaluate(() => window.nawaFilePreview.read('C:/unopened.msg')),
    ).rejects.toThrow('Open this file')
  } finally {
    await closeAndSaveVideo(launched, 'extended-previews')
  }
})

test('Arabic previews keep control placement while using Arabic labels', async () => {
  const launched = await launchShell({
    onboardingSeen: true,
    lang: 'ar',
    videoDir: 'extended-preview-ar',
  })
  try {
    const { page } = launched
    await page.evaluate(
      (path) => window.aiOffice.openPath(path),
      resolve('test-files/extended-formats/sample.png'),
    )
    const image = page.getByRole('region', { name: 'معاينة الملف', exact: true })
    await expect(image).toBeVisible()
    await expect(image.locator('.file-preview-toolbar')).toHaveCSS('direction', 'ltr')
    await image.getByRole('button', { name: 'إغلاق الملف', exact: true }).click()
    await page.evaluate(
      (path) => window.aiOffice.openPath(path),
      resolve('test-files/extended-formats/sample.msg'),
    )
    const message = page.getByRole('region', { name: 'معاينة الملف', exact: true })
    const close = message.getByRole('button', { name: 'إغلاق الملف', exact: true })
    await expect(message.getByRole('heading', { name: 'Nawa project review' })).toBeVisible()
    await expect(message.locator('.file-preview-toolbar')).toHaveCSS('direction', 'ltr')
    await expect(close).toHaveCSS('direction', 'rtl')
    expect((await close.boundingBox())!.x).toBeGreaterThan(
      (await message.locator('.file-preview-toolbar strong').boundingBox())!.x,
    )
    await page.screenshot({ path: screenshotPath('extended-email-ar') })
    await close.click()
  } finally {
    await closeAndSaveVideo(launched, 'extended-preview-ar')
  }
})

test('directory assistant reads email and reviews source edits before saving with a backup', async () => {
  const scratch = await mkdtemp(join(tmpdir(), 'nawa-extended-'))
  const documents = join(scratch, 'Documents'),
    state = join(scratch, 'state')
  await mkdir(documents)
  await mkdir(state)
  const source = join(documents, 'sample.mjs')
  for (const extension of ['mjs', 'msg', 'eml', 'png'])
    await copyFile(
      resolve(`test-files/extended-formats/sample.${extension}`),
      join(documents, `sample.${extension}`),
    )
  await writeFile(
    join(state, 'workspace-folders.json'),
    JSON.stringify({ version: 1, roots: [documents] }),
  )
  const original = await readFile(source)
  const launched = await launchShell({
    userDataDir: state,
    onboardingSeen: true,
    videoDir: 'extended-source',
  })
  try {
    const result = await launched.page.evaluate(
      async ({ source, documents }) => {
        const api = window.nawaDirectory
        const files = [
          source,
          documents + '/sample.eml',
          documents + '/sample.msg',
          documents + '/sample.png',
        ]
        const run = await api.begin({ opened: documents, files, directories: [] })
        try {
          const messages = await Promise.all(
            files.slice(1, 3).map((path) => api.readFile(run, path, 0, 12000)),
          )
          const ocr = await api.readFile(run, files[3]!, 0, 12000)
          const inspection = await api.inspect(run, source)
          const allowed = inspection.tools.map((tool) => tool.name)
          await api.closeInspection(run, inspection.id)
          const proposal = await api.propose(run, {
            operation: 'update',
            path: source,
            instruction: 'Change value from 1 to 2',
          })
          const description = await api.prepare(proposal.id)
          const workflow = await api.pollWorkflow(proposal.id)
          const read = JSON.parse(
            (await api.execute(proposal.id, { id: 'read', name: 'read_text', input: {} })).output,
          )
          await api.execute(proposal.id, {
            id: 'replace',
            name: 'replace_text',
            input: { revision: read.revision, find: 'value = 1', replacement: 'value = 2' },
          })
          const preview = await api.preview(proposal.id)
          return { run, proposal, description, allowed, messages, preview, workflow, ocr }
        } catch (error) {
          await api.cancel(run)
          throw error
        }
      },
      { source, documents },
    )
    expect(result.allowed).toEqual(['read_text'])
    expect(result.description?.kind).toBe('text')
    expect(result.workflow.interaction).toBeNull()
    expect(result.ocr.untrustedDocumentText).toMatch(/NAWA\s+OCR\s+TEST/i)
    expect(
      result.messages.every((message) =>
        message.untrustedDocumentText.includes('日本語 / العربية'),
      ),
    ).toBe(true)
    expect(result.preview.beforeText).toContain('value = 1')
    expect(result.preview.afterText).toContain('value = 2')
    expect(result.preview.review?.quality?.checked).toBe(true)
    expect(await readFile(source)).toEqual(original)
    const receipt = await launched.page.evaluate(
      (id) => window.nawaDirectory.commit(id),
      result.proposal.id,
    )
    expect(await readFile(receipt.backupPath!)).toEqual(original)
    expect(await readFile(source)).toEqual(
      Buffer.from(original.toString('utf8').replace('value = 1', 'value = 2')),
    )
    await launched.page.evaluate((run) => window.nawaDirectory.cancel(run), result.run)
    await launched.page.evaluate((path) => window.aiOffice.openPath(path), source)
    const editor = await waitForPageWithUrl(launched.app, '://markdown/')
    await expect(editor.locator('.cm-content')).toContainText('value = 2')
    await expect(editor.locator('.cm-content')).toContainText('العربية')
    await editor.screenshot({ path: screenshotPath('extended-source-reopen') })
  } finally {
    await closeAndSaveVideo(launched, 'extended-source')
  }
})

test('AI chat completes a source edit through both visible approvals', async () => {
  const scratch = await mkdtemp(join(tmpdir(), 'nawa-text-chat-'))
  const documents = join(scratch, 'Documents'),
    state = join(scratch, 'state')
  await mkdir(documents)
  await mkdir(state)
  const source = join(documents, 'sample.mjs')
  await copyFile(resolve('test-files/extended-formats/sample.mjs'), source)
  const original = await readFile(source)
  await writeFile(
    join(state, 'workspace-folders.json'),
    JSON.stringify({ version: 1, roots: [documents] }),
  )
  const calls: string[] = []
  const server = createServer(async (request, response) => {
    let raw = ''
    for await (const chunk of request) raw += chunk
    const body = JSON.parse(raw)
    const tools: string[] = (body.tools ?? []).map(
      (tool: { function: { name: string } }) => tool.function.name,
    )
    const messages: {
      role: string
      content?: string
      tool_calls?: { function: { name: string } }[]
    }[] = body.messages ?? []
    const lastCall = messages
      .filter((message) => message.role === 'assistant' && message.tool_calls?.length)
      .at(-1)
      ?.tool_calls?.at(-1)?.function.name
    let name: string | undefined,
      input: Record<string, unknown> = {},
      text = ''
    if (tools.includes('read_text')) {
      if (!lastCall) name = 'read_text'
      else if (lastCall === 'read_text') {
        const result = JSON.parse(
          messages.filter((message) => message.role === 'tool').at(-1)?.content ?? '{}',
        )
        name = 'replace_text'
        input = { revision: result.revision, find: 'value = 1', replacement: 'value = 2' }
      } else text = 'Updated the private source copy. Ready for save review.'
    } else if (lastCall === 'update_file')
      text = 'Updated sample.mjs and saved the reviewed changes.'
    else if (tools.includes('update_file')) {
      name = 'update_file'
      input = {
        path: source,
        instruction: 'Change value = 1 to value = 2. Keep the comment and encoding.',
      }
    } else {
      name = 'discover_file_tools'
      input = { capability: 'editing' }
    }
    calls.push(name ?? 'answer')
    response.writeHead(200, { 'Content-Type': 'text/event-stream' })
    const delta = name
      ? {
          role: 'assistant',
          tool_calls: [
            {
              index: 0,
              id: `call_${calls.length}`,
              type: 'function',
              function: { name, arguments: JSON.stringify(input) },
            },
          ],
        }
      : { role: 'assistant', content: text }
    response.write(
      `data: ${JSON.stringify({ id: 'test', object: 'chat.completion.chunk', choices: [{ index: 0, delta, finish_reason: null }] })}\n\n`,
    )
    response.write(
      `data: ${JSON.stringify({ id: 'test', object: 'chat.completion.chunk', choices: [{ index: 0, delta: {}, finish_reason: name ? 'tool_calls' : 'stop' }] })}\n\n`,
    )
    response.end('data: [DONE]\n\n')
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const address = server.address() as { port: number }
  const launched = await launchShell({
    userDataDir: state,
    onboardingSeen: true,
    videoDir: 'extended-chat',
  })
  try {
    const { page } = launched
    await page.evaluate(async (baseUrl) => {
      const settings = await window.aiOffice.getAiSettings()
      await window.aiOffice.setAiSettings({
        ...settings,
        defaultChatModelId: 'local-source',
        chatModels: [
          {
            id: 'local-source',
            name: 'Local source test',
            provider: 'custom',
            config: { baseUrl, apiKey: 'test', model: 'source-test' },
          },
        ],
      })
      window.dispatchEvent(new Event('nawa:models-changed'))
    }, `http://127.0.0.1:${address.port}/v1`)
    await page.getByRole('treeitem', { name: 'Documents', exact: true }).click()
    await page
      .locator('.ex-file-row')
      .filter({ hasText: 'sample.mjs' })
      .getByRole('checkbox')
      .check()
    const panel = page.locator('.nawa-workspace-control-panel')
    const toggle = page.locator('.ex-file-controls .ex-assistant-toggle')
    if (!(await panel.isVisible())) await toggle.click()
    await panel
      .getByRole('combobox', { name: 'Chat model', exact: true })
      .selectOption('local-source')
    await panel
      .getByRole('textbox', { name: 'Message Nawa' })
      .fill('Edit sample.mjs: change value = 1 to value = 2.')
    await panel.getByRole('button', { name: 'Send', exact: true }).click()
    await panel.getByRole('button', { name: 'Review', exact: true }).click()
    const review = page.getByRole('dialog', { name: 'Review assistant actions', exact: true })
    await expect(
      review.getByRole('button', { name: 'Approve preparation', exact: true }),
    ).toBeVisible({ timeout: 30000 })
    expect(await readFile(source)).toEqual(original)
    await review.getByRole('button', { name: 'Approve preparation', exact: true }).click()
    await expect(review.getByRole('button', { name: 'Approve save', exact: true })).toBeVisible({
      timeout: 30000,
    })
    expect(await readFile(source)).toEqual(original)
    await review.getByText('Review text before / after', { exact: false }).click()
    await expect(review).toContainText('value = 2')
    await page.screenshot({ path: screenshotPath('extended-chat-save-review') })
    await review.getByRole('button', { name: 'Approve save', exact: true }).click()
    await expect.poll(async () => (await readFile(source, 'utf8')).includes('value = 2')).toBe(true)
    await expect(panel).toContainText('saved the reviewed changes')
    expect(calls).toContain('update_file')
    expect(calls).toContain('read_text')
    expect(calls).toContain('replace_text')
    expect(await readFile(source)).toEqual(
      Buffer.from(original.toString('utf8').replace('value = 1', 'value = 2')),
    )
  } finally {
    await closeAndSaveVideo(launched, 'extended-chat')
    await new Promise<void>((resolve) => server.close(() => resolve()))
  }
})

test('RTF imports into an editable Docs view', async () => {
  test.setTimeout(180000)
  const launched = await launchShell({
    onboardingSeen: true,
    videoDir: 'extended-rtf',
    openFile: resolve('test-files/extended-formats/sample.rtf'),
  })
  try {
    const editor = await waitForPageWithUrl(launched.app, '://docs/')
    await expect(editor.locator('.editor-scroll')).toContainText('Nawa RTF Import', {
      timeout: 90000,
    })
    await expect(editor.locator('.editor-scroll')).toContainText('日本語')
    await editor.screenshot({ path: screenshotPath('extended-rtf-import') })
  } finally {
    await closeAndSaveVideo(launched, 'extended-rtf')
  }
})
