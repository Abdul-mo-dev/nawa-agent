import { test, expect } from '@playwright/test'
import { createServer } from 'node:http'
import { copyFile, mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { closeAndSaveVideo, launchShell, screenshotPath, waitForPageWithUrl } from './helpers'

test('Japanese, Arabic and English previews retain pane placement in a narrow dark window', async () => {
  const launched = await launchShell({
    onboardingSeen: true,
    lang: 'ja',
    videoDir: 'preview-languages',
  })
  const { page } = launched
  try {
    await page.evaluate(
      (path) => window.aiOffice.openPath(path),
      resolve('test-files/extended-formats/sample.msg'),
    )
    const pane = page.getByRole('region', { name: 'ファイルのプレビュー', exact: true })
    await expect(pane.getByRole('button', { name: 'ファイルを閉じる', exact: true })).toBeVisible()
    const bounds = (await page.locator('.file-preview-pane').boundingBox())!
    for (const [settings, general, language, option, close] of [
      ['設定', '一般', '言語', 'العربية', 'إغلاق الملف'],
      ['الإعدادات', 'عام', 'اللغة', 'English', 'Close file'],
    ] as const) {
      await page.getByRole('button', { name: settings, exact: true }).click()
      await page.locator('.set-nav-item').filter({ hasText: general }).click()
      await page.getByRole('button', { name: language, exact: true }).click()
      await page.getByRole('option', { name: option, exact: true }).click()
      await page.locator('.set-close').click()
      await expect(
        page.locator('.file-preview-toolbar').getByRole('button', { name: close, exact: true }),
      ).toBeVisible()
      await expect(page.locator('.file-preview-toolbar')).toHaveCSS('direction', 'ltr')
      const next = (await page.locator('.file-preview-pane').boundingBox())!
      expect(next.x).toBe(bounds.x)
      expect(next.width).toBe(bounds.width)
    }
    await page.evaluate(() => window.aiOffice.setTheme('dark'))
    await launched.app.evaluate(({ BrowserWindow }) =>
      BrowserWindow.getAllWindows()[0].setSize(760, 640),
    )
    await expect.poll(() => page.evaluate(() => innerWidth)).toBeLessThan(800)
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1)).toBe(
      true,
    )
    await expect(page.locator('.file-preview-message')).toBeVisible()
    await page.screenshot({ path: screenshotPath('preview-narrow-dark') })
  } finally {
    await closeAndSaveVideo(launched, 'preview-languages')
  }
})

test('preview tabs bind email and image chat to the displayed file and retain separate history', async () => {
  const scratch = await mkdtemp(join(tmpdir(), 'nawa-preview-chat-'))
  const first = join(scratch, 'first.eml'),
    second = join(scratch, 'second.eml'),
    image = join(scratch, 'picture.png')
  const email = (marker: string) =>
    `Subject: ${marker}\r\nFrom: sender@example.com\r\nTo: reader@example.com\r\nMIME-Version: 1.0\r\nContent-Type: text/plain; charset=utf-8\r\n\r\n${marker}\r\n${'Long email content 日本語 العربية.\r\n'.repeat(1000)}`
  await writeFile(first, email('FIRST_MESSAGE_1'))
  await writeFile(second, email('SECOND_MESSAGE_2'))
  await copyFile(resolve('test-files/extended-formats/sample.png'), image)
  let imageInputs = 0
  let ocrReads = 0
  const readPaths: string[] = []
  const server = createServer(async (request, response) => {
    let raw = ''
    for await (const chunk of request) raw += chunk
    const body = JSON.parse(raw)
    const messages = body.messages as {
      role: string
      content?: string | { type: string; text?: string; image_url?: { url: string } }[]
    }[]
    const user = messages.filter((message) => message.role === 'user').at(-1)!
    const content = Array.isArray(user.content)
      ? user.content.map((item) => item.text || '').join('\n')
      : user.content || ''
    const tool = messages.at(-1)?.role === 'tool' ? messages.at(-1) : undefined
    let answer = '',
      call = false
    if (content.includes('"kind":"image"')) {
      const parts = Array.isArray(user.content) ? user.content : []
      if (parts.some((part) => part.image_url?.url.startsWith('data:image/jpeg;base64,'))) {
        imageInputs++
        answer = 'IMAGE_VISIBLE_3: I received the open image.'
      } else if (!tool) call = true
      else {
        const result = JSON.parse(String(tool.content))
        if (/NAWA\s+OCR\s+TEST/i.test(result.text)) ocrReads++
        answer = 'IMAGE_OCR_4: ' + result.text
      }
    } else if (!tool) call = true
    else {
      const result = JSON.parse(String(tool.content))
      readPaths.push(result.path)
      answer = result.text.includes('FIRST_MESSAGE_1')
        ? 'Email content is FIRST_MESSAGE_1.'
        : 'Email content is SECOND_MESSAGE_2.'
    }
    const delta = call
      ? {
          role: 'assistant',
          tool_calls: [
            {
              index: 0,
              id: 'preview_read',
              type: 'function',
              function: { name: 'read_preview', arguments: '{}' },
            },
          ],
        }
      : { role: 'assistant', content: answer }
    response.writeHead(200, { 'Content-Type': 'text/event-stream' })
    response.write(
      `data: ${JSON.stringify({ id: 'preview-test', choices: [{ index: 0, delta, finish_reason: null }] })}\n\n`,
    )
    response.write(
      `data: ${JSON.stringify({ id: 'preview-test', choices: [{ index: 0, delta: {}, finish_reason: call ? 'tool_calls' : 'stop' }] })}\n\n`,
    )
    response.end('data: [DONE]\n\n')
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const port = (server.address() as { port: number }).port
  const launched = await launchShell({ onboardingSeen: true, videoDir: 'preview-chat' })
  const { page } = launched
  try {
    await page.evaluate(async (baseUrl) => {
      const settings = await window.aiOffice.getAiSettings()
      await window.aiOffice.setAiSettings({
        ...settings,
        defaultChatModelId: 'preview-test',
        chatModels: [
          {
            id: 'preview-test',
            name: 'Preview test',
            provider: 'custom',
            config: { baseUrl, model: 'preview-test', apiKey: 'test', policy: { vision: true } },
          },
          {
            id: 'preview-text',
            name: 'Text preview test',
            provider: 'custom',
            config: { baseUrl, model: 'preview-test', apiKey: 'test', policy: { vision: false } },
          },
        ],
      })
    }, `http://127.0.0.1:${port}/v1`)
    const open = async (path: string) => {
      await page.evaluate((path) => window.aiOffice.openPath(path), path)
      await expect(page.locator('.file-preview-toolbar strong')).toHaveText(
        path.split(/[\\/]/).pop()!,
      )
      await expect(page.locator('.preview-assistant textarea')).toBeVisible()
    }
    const ask = async (answer: string, model = 'preview-test') => {
      const assistant = page.locator('.preview-assistant')
      await assistant.getByRole('combobox', { name: 'Chat model', exact: true }).selectOption(model)
      await assistant.locator('textarea').fill('What is in this open file?')
      await assistant.getByRole('button', { name: 'Send', exact: true }).click()
      await expect(assistant.getByRole('log')).toContainText(answer, { timeout: 30000 })
    }
    await open(first)
    const source = page.locator('.file-preview-message'),
      pane = page.locator('.file-preview-pane')
    const width = (await source.boundingBox())!.width
    await source.evaluate((element) => {
      element.scrollTop = element.scrollHeight
    })
    expect((await source.boundingBox())!.width).toBe(width)
    await expect(page.getByRole('dialog', { name: 'File preview' })).toHaveCount(0)
    await ask('Email content is FIRST_MESSAGE_1.')
    await open(second)
    await expect(page.locator('.preview-assistant [role="log"]')).not.toContainText(
      'FIRST_MESSAGE_1',
    )
    await ask('Email content is SECOND_MESSAGE_2.')
    expect(readPaths).toEqual([first, second])
    await open(image)
    await expect(pane.locator('img')).toHaveJSProperty('naturalWidth', 800)
    await ask('IMAGE_VISIBLE_3')
    expect(imageInputs).toBeGreaterThan(0)
    await ask('IMAGE_OCR_4', 'preview-text')
    expect(ocrReads).toBe(1)
    expect(imageInputs).toBe(1)
    await expect
      .poll(() =>
        page.evaluate(() =>
          window.aiOfficeTabs
            .list()
            .then((tabs) => tabs.filter((tab) => tab.kind === 'preview').length),
        ),
      )
      .toBe(3)
    await page.screenshot({ path: screenshotPath('preview-image-assistant') })
    const textFile = join(scratch, 'notes.txt')
    await writeFile(textFile, 'TEXT_EDITOR_5')
    await page.evaluate((path) => window.aiOffice.openPath(path), textFile)
    const textEditor = await waitForPageWithUrl(launched.app, '://markdown/')
    await expect(textEditor.locator('.cm-content')).toContainText('TEXT_EDITOR_5')
    await expect(page.locator('.file-preview-pane')).toHaveCount(0)
    await open(first)
    await expect(page.locator('.preview-assistant [role="log"]')).toContainText(
      'Email content is FIRST_MESSAGE_1.',
    )
    await expect(page.locator('.preview-assistant [role="log"]')).not.toContainText(
      'SECOND_MESSAGE_2',
    )
    expect(
      await page.evaluate(() =>
        window.aiOfficeTabs
          .list()
          .then((tabs) => tabs.filter((tab) => tab.kind === 'preview').length),
      ),
    ).toBe(3)
    await page.screenshot({ path: screenshotPath('preview-email-assistant') })
    await pane.getByRole('button', { name: 'Close file', exact: true }).click()
    await expect(page.evaluate((path) => window.nawaFilePreview.read(path), first)).rejects.toThrow(
      'Open this file',
    )
    expect(await readFile(first, 'utf8')).toBe(email('FIRST_MESSAGE_1'))
    expect(await readFile(second, 'utf8')).toBe(email('SECOND_MESSAGE_2'))
    const snapshot = await page.evaluate((path) => window.nawaFilePreview.read(path), image)
    await writeFile(image, await readFile(resolve('test-files/extended-formats/sample.tiff')))
    await expect(
      page.evaluate(({ path, hash }) => window.nawaFilePreview.recognizeText(path, hash!), {
        path: image,
        hash: snapshot.sourceHash,
      }),
    ).rejects.toThrow('file changed')
  } finally {
    await closeAndSaveVideo(launched, 'preview-chat')
    await new Promise<void>((resolve) => server.close(() => resolve()))
  }
})
