import { test, expect } from '@playwright/test'
import { createServer } from 'node:http'
import { mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { closeAndSaveVideo, launchShell, screenshotPath, waitForPageWithUrl } from './helpers'

for (const extension of ['json', 'yaml', 'txt', 'mjs']) {
  test(`${extension}: source file stays in its editor viewport when scrolling`, async () => {
    const scratch = await mkdtemp(join(tmpdir(), 'nawa-source-view-'))
    const path = join(scratch, `large.${extension}`)
    const text =
      extension === 'json'
        ? JSON.stringify(
            Array.from({ length: 3000 }, (_, i) => ({
              id: i,
              content: i % 300 === 0 ? 'long '.repeat(250) : 'small',
            })),
            null,
            2,
          )
        : Array.from(
            { length: 4000 },
            (_, i) => `${i}: ${i % 300 === 0 ? 'long '.repeat(250) : '日本語 العربية small'}`,
          ).join('\n')
    await writeFile(path, text)
    const launched = await launchShell({
      onboardingSeen: true,
      videoDir: `source-view-${extension}`,
    })
    try {
      await launched.page.evaluate((path) => window.aiOffice.openPath(path), path)
      const editor = await waitForPageWithUrl(launched.app, '://markdown/')
      const source = editor.locator('.source-editor'),
        scroller = source.locator('.cm-scroller')
      await expect(scroller).toBeVisible()
      await expect.poll(() => scroller.evaluate((el) => el.clientHeight)).toBeGreaterThan(100)
      await expect(launched.page.locator('.explorer')).toHaveClass(/ex-editor-active/)
      // The native editor initially uses fallback bounds until Explorer measures its slot.
      await expect
        .poll(async () => {
          const expectedWidth = await launched.page
            .locator('.ex-center')
            .evaluate((el) => Math.round(innerWidth - el.getBoundingClientRect().left))
          return (await editor.evaluate(() => innerWidth)) - expectedWidth
        })
        .toBe(0)
      const before = await editor.evaluate(() => {
        const content = document.querySelector('.app-content')!.getBoundingClientRect()
        const source = document.querySelector('.source-editor')!.getBoundingClientRect()
        const scroller = document.querySelector('.cm-scroller')!.getBoundingClientRect()
        const panel = document.querySelector('.ai-dock')!.getBoundingClientRect()
        return {
          content: { x: content.x, width: content.width },
          source: { x: source.x, width: source.width },
          scroller: { width: scroller.width, height: scroller.height },
          panel: { x: panel.x, width: panel.width },
          viewportWidth: innerWidth,
          viewportHeight: innerHeight,
          pageWidth: document.documentElement.scrollWidth,
        }
      })
      expect(before.scroller.height).toBeLessThan(before.viewportHeight - 50)
      expect(before.scroller.width).toBeLessThanOrEqual(before.content.width + 1)
      expect(before.pageWidth).toBeLessThanOrEqual(before.viewportWidth + 1)
      for (const ratio of [0.25, 0.7, 1, 0]) {
        await scroller.evaluate((el, ratio) => {
          el.scrollTop = (el.scrollHeight - el.clientHeight) * ratio
        }, ratio)
        await expect
          .poll(async () => Math.round((await source.boundingBox())!.width))
          .toBe(Math.round(before.source.width))
        await expect
          .poll(async () => Math.round((await scroller.boundingBox())!.width))
          .toBe(Math.round(before.scroller.width))
        await expect
          .poll(() =>
            editor
              .locator('.ai-dock')
              .evaluate((el) => Math.round(el.getBoundingClientRect().width)),
          )
          .toBe(Math.round(before.panel.width))
      }
      await scroller.evaluate((el) => {
        el.scrollTop = el.scrollHeight
      })
      await expect.poll(() => scroller.evaluate((el) => el.scrollTop)).toBeGreaterThan(0)
      expect(
        await launched.page
          .evaluate(() => window.aiOfficeTabs.list())
          .then((tabs) => tabs.find((tab) => tab.active)?.filePath),
      ).toBe(path)
      await editor.screenshot({ path: screenshotPath(`source-view-${extension}`) })
    } finally {
      await closeAndSaveVideo(launched, `source-view-${extension}`)
    }
  })
}

test('the open-file assistant reads unsaved JSON, edits the live buffer, and supports undo and save', async () => {
  const scratch = await mkdtemp(join(tmpdir(), 'nawa-source-assistant-'))
  const path = join(scratch, 'settings.json')
  const original = '\uFEFF{\r\n  "projectCode": "ORIGINAL_DISK_1"\r\n}\r\n'
  await writeFile(path, original)
  const toolCalls: string[] = [],
    reads: string[] = []
  const requests: string[] = []
  const server = createServer(async (request, response) => {
    let raw = ''
    for await (const chunk of request) raw += chunk
    requests.push(raw)
    const body = JSON.parse(raw)
    const messages: {
      role: string
      content?: string
      tool_calls?: { function: { name: string } }[]
    }[] = body.messages
    const lastUser = messages
      .map((message, i) => ({ message, i }))
      .filter(({ message }) => message.role === 'user')
      .at(-1)!
    const turn = messages.slice(lastUser.i + 1)
    const lastCall = turn
      .filter((message) => message.tool_calls?.length)
      .at(-1)
      ?.tool_calls?.at(-1)?.function.name
    const editing = lastUser.message.content?.includes('Change projectCode')
    let name: string | undefined,
      input: Record<string, unknown> = {},
      answer = ''
    if (!lastCall) {
      name = 'read_text'
    } else if (lastCall === 'read_text') {
      const result = JSON.parse(
        turn.filter((message) => message.role === 'tool').at(-1)?.content ?? '{}',
      )
      reads.push(result.text ?? '')
      if (editing) {
        name = 'replace_text'
        input = {
          revision: result.revision,
          find: 'CURRENT_UNSAVED_42',
          replacement: 'UPDATED_LIVE_43',
        }
      } else answer = `The live projectCode is ${JSON.parse(result.text).projectCode}.`
    } else answer = 'Updated projectCode in the open editor.'
    if (name) toolCalls.push(name)
    const delta = name
      ? {
          role: 'assistant',
          tool_calls: [
            {
              index: 0,
              id: `source_${toolCalls.length}`,
              type: 'function',
              function: { name, arguments: JSON.stringify(input) },
            },
          ],
        }
      : { role: 'assistant', content: answer }
    response.writeHead(200, { 'Content-Type': 'text/event-stream' })
    response.write(
      `data: ${JSON.stringify({ id: 'test', choices: [{ index: 0, delta, finish_reason: null }] })}\n\n`,
    )
    response.write(
      `data: ${JSON.stringify({ id: 'test', choices: [{ index: 0, delta: {}, finish_reason: name ? 'tool_calls' : 'stop' }] })}\n\n`,
    )
    response.end('data: [DONE]\n\n')
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const address = server.address() as { port: number }
  const launched = await launchShell({
    onboardingSeen: true,
    videoDir: 'source-file-ai',
  })
  try {
    await launched.page.evaluate(async (baseUrl) => {
      const settings = await window.aiOffice.getAiSettings()
      await window.aiOffice.setAiSettings({
        ...settings,
        defaultChatModelId: 'source-file-test',
        chatModels: [
          {
            id: 'source-file-test',
            name: 'Source file test',
            provider: 'custom',
            config: { baseUrl, model: 'source-file', apiKey: 'test' },
          },
        ],
      })
    }, `http://127.0.0.1:${address.port}/v1`)
    await launched.page.evaluate((path) => window.aiOffice.openPath(path), path)
    const editor = await waitForPageWithUrl(launched.app, '://markdown/')
    await editor.evaluate(() => window.dispatchEvent(new Event('nawa:models-changed')))
    const content = editor.locator('.cm-content')
    await expect(content).toContainText('ORIGINAL_DISK_1')
    await content.click()
    await editor.keyboard.press('ControlOrMeta+a')
    await editor.keyboard.insertText('{\n  "projectCode": "CURRENT_UNSAVED_42"\n}\n')
    await expect(content).toContainText('CURRENT_UNSAVED_42')
    // The shell's open-document reader must see this buffer too, before any disk save.
    const shellRead = await launched.app.evaluate(
      ({ webContents, ipcMain }) =>
        new Promise<{ text?: string; error?: string }>((resolve, reject) => {
          const contents = webContents
            .getAllWebContents()
            .find((item) => item.getURL().includes('://markdown/'))!
          const onResult = (
            event: Electron.IpcMainEvent,
            result: { text?: string; error?: string },
          ) => {
            if (event.sender.id !== contents.id) return
            clearTimeout(timer)
            ipcMain.removeListener('markdown:read-text-result', onResult)
            resolve(result)
          }
          const timer = setTimeout(() => {
            ipcMain.removeListener('markdown:read-text-result', onResult)
            reject(new Error('Open-file read timed out'))
          }, 5000)
          ipcMain.on('markdown:read-text-result', onResult)
          contents.send('markdown:read-text-request')
        }),
    )
    expect(shellRead.error).toBeUndefined()
    expect(shellRead.text).toBe(original.replace('ORIGINAL_DISK_1', 'CURRENT_UNSAVED_42'))
    const panel = editor.locator('.copilot')
    await panel
      .getByRole('combobox', { name: 'Chat model', exact: true })
      .selectOption('source-file-test')
    const draft = panel.locator('textarea')
    await draft.fill('What is projectCode in the open file?')
    await panel.getByRole('button', { name: 'Send', exact: true }).click()
    await expect(panel).toContainText('The live projectCode is CURRENT_UNSAVED_42.', {
      timeout: 30000,
    })
    expect(reads[0]).toContain('CURRENT_UNSAVED_42')
    expect(reads[0]).not.toContain('ORIGINAL_DISK_1')
    expect(await readFile(path, 'utf8')).toBe(original)
    await draft.fill('Change projectCode to UPDATED_LIVE_43 in the open file.')
    await panel.getByRole('button', { name: 'Send', exact: true }).click()
    await expect(content).toContainText('UPDATED_LIVE_43', { timeout: 30000 })
    await expect(panel).toContainText('Updated projectCode in the open editor.')
    expect(toolCalls).toContain('replace_text')
    expect(await readFile(path, 'utf8')).toBe(original)
    await content.click()
    await editor.keyboard.press('ControlOrMeta+z')
    await expect(content).toContainText('CURRENT_UNSAVED_42')
    await editor.keyboard.press(process.platform === 'darwin' ? 'Meta+Shift+z' : 'Control+y')
    await expect(content).toContainText('UPDATED_LIVE_43')
    await editor.keyboard.press('ControlOrMeta+s')
    await expect
      .poll(() => readFile(path, 'utf8'))
      .toBe(original.replace('ORIGINAL_DISK_1', 'UPDATED_LIVE_43'))
    await editor.screenshot({ path: screenshotPath('source-file-ai-live-content') })
  } finally {
    await writeFile(join(scratch, 'model-requests.json'), JSON.stringify(requests, null, 2))
    await closeAndSaveVideo(launched, 'source-file-ai')
    await new Promise<void>((resolve) => server.close(() => resolve()))
  }
})
