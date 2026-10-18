import { expect, test, type Page } from '@playwright/test'
import { createServer } from 'node:http'
import { mkdtemp, readFile, writeFile, copyFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { createCanvas, GifEncoder } from '@napi-rs/canvas'
import * as TIFF from 'utif2'
import { closeAndSaveVideo, launchShell, waitForPageWithUrl, type LaunchedApp } from './helpers'

async function open(launched: LaunchedApp, path: string, host: string): Promise<Page> {
  await launched.page.evaluate((file) => window.aiOffice.openPath(file), path)
  const editor = await waitForPageWithUrl(launched.app, `://${host}/`)
  await expect(editor.locator('.nawa-chat-brand')).toHaveText('Nawa')
  return editor
}

async function expectSidebarChatColors(launched: LaunchedApp, page: Page, selectors: string[]) {
  for (const mode of ['light', 'dark', 'system-dark', 'system-light'] as const) {
    for (const target of new Set([launched.page, page])) {
      await target.emulateMedia({ colorScheme: mode.endsWith('dark') ? 'dark' : 'light' })
      await target.evaluate((theme) => {
        if (theme.startsWith('system')) document.documentElement.removeAttribute('data-theme')
        else document.documentElement.setAttribute('data-theme', theme)
      }, mode)
    }
    const sidebar = await launched.page
      .locator('.ex-navigation')
      .evaluate((element) => getComputedStyle(element).backgroundColor)
    expect(sidebar).not.toBe('rgb(255, 255, 255)')
    await expect
      .poll(
        () =>
          page.evaluate(
            (targets) =>
              targets.map((selector) => {
                const element = document.querySelector(selector)
                return element ? getComputedStyle(element).backgroundColor : `Missing ${selector}`
              }),
            selectors,
          ),
        { message: `${mode} chat backgrounds must match the main sidebar` },
      )
      .toEqual(selectors.map(() => sidebar))
  }
}

test('image previews retain native decoding and bounded vision attachments without Sharp', async () => {
  const scratch = await mkdtemp(join(tmpdir(), 'nawa-image-codecs-'))
  const canvas = createCanvas(8, 6)
  canvas.getContext('2d').fillStyle = '#ff0000'
  canvas.getContext('2d').fillRect(0, 0, 8, 6)
  for (const format of ['png', 'jpeg', 'webp', 'gif'] as const)
    await writeFile(join(scratch, `sample.${format}`), await canvas.encode(format))
  await writeFile(
    join(scratch, 'sample.tiff'),
    Buffer.from(TIFF.encodeImage(new Uint8Array(canvas.data()).buffer, 8, 6)),
  )
  const animation = new GifEncoder(8, 6)
  animation.addFrame(new Uint8Array(canvas.data()), 8, 6, { delay: 100 })
  canvas.getContext('2d').fillStyle = '#00ff00'
  canvas.getContext('2d').fillRect(0, 0, 8, 6)
  animation.addFrame(new Uint8Array(canvas.data()), 8, 6, { delay: 100 })
  await writeFile(join(scratch, 'animated.gif'), animation.finish())
  const launched = await launchShell({ onboardingSeen: true, videoDir: 'reliability-image-codecs' })
  try {
    for (const name of [
      'sample.png',
      'sample.jpeg',
      'sample.webp',
      'sample.gif',
      'sample.tiff',
      'animated.gif',
    ]) {
      const path = join(scratch, name)
      await launched.page.evaluate((file) => window.aiOffice.openPath(file), path)
      const preview = await launched.page.evaluate(
        (file) => window.nawaFilePreview.read(file),
        path,
      )
      expect(preview.error).toBeUndefined()
      expect(preview.image).toMatch(/^data:image\/png;base64,/)
      expect(preview.visionImage).toMatch(/^data:image\/jpeg;base64,/)
      await expect(launched.page.locator('.file-preview-pane img').first()).toBeVisible()
    }
  } finally {
    await closeAndSaveVideo(launched, 'reliability-image-codecs')
  }
})

for (const host of ['markdown', 'html'] as const) {
  test(`${host} preserves UTF-16 and refuses an external overwrite`, async () => {
    const scratch = await mkdtemp(join(tmpdir(), 'nawa-safe-text-'))
    const file = join(scratch, host === 'html' ? 'encoding.html' : 'encoding.json')
    const text = host === 'html' ? '<p>مرحبا 日本語</p>\r\n' : '{"text":"مرحبا 日本語"}\r\n'
    const bytes = Buffer.concat([Buffer.from([255, 254]), Buffer.from(text, 'utf16le')])
    await writeFile(file, bytes)
    const launched = await launchShell({ onboardingSeen: true, videoDir: `reliability-${host}` })
    try {
      const editor = await open(launched, file, host)
      const decoded = await editor.evaluate(
        async ({ host, file }) => {
          const api = host === 'html' ? window.htmlApi : window.markdownApi
          return api.readFile(file)
        },
        { host, file },
      )
      expect(decoded).toBe(text)
      const save = (value: string) =>
        editor.evaluate(
          async ({ host, value }) => {
            const api = host === 'html' ? window.htmlApi : window.markdownApi
            return api.save({ mode: 'save', text: value })
          },
          { host, value },
        )
      expect((await save(text.replace(/\r\n/g, '\n'))).ok).toBe(true)
      expect(await readFile(file)).toEqual(bytes)
      const external = Buffer.from('Changed by another editor\n')
      await writeFile(file, external)
      const conflict = await save('Stale local change')
      expect(conflict.ok).toBe(false)
      expect(conflict.error).toContain('changed outside Nawa')
      expect(await readFile(file)).toEqual(external)
    } finally {
      await closeAndSaveVideo(launched, `reliability-${host}`)
    }
  })
}

test('closed Word tabs release their WebContents and the shell stays responsive', async () => {
  test.setTimeout(150_000)
  const scratch = await mkdtemp(join(tmpdir(), 'nawa-doc-disposal-'))
  const file = join(scratch, 'document.docx')
  await copyFile(resolve('test-files/legacy-office/document-sample.docx'), file)
  const launched = await launchShell({ onboardingSeen: true, videoDir: 'reliability-disposal' })
  try {
    const count = () =>
      launched.app.evaluate(({ webContents }) => webContents.getAllWebContents().length)
    const baseline = await count()
    for (let cycle = 0; cycle < 5; cycle++) {
      await open(launched, file, 'docs')
      const tab = await launched.page.evaluate(
        async (path) => (await window.aiOfficeTabs.list()).find((item) => item.filePath === path),
        file,
      )
      expect(tab).toBeTruthy()
      await launched.page.evaluate((id) => window.aiOfficeTabs.close(id), tab!.id)
      await expect.poll(count, { timeout: 20_000 }).toBe(baseline)
      await expect(launched.page.locator('.ex-new-button')).toBeVisible()
    }
  } finally {
    await closeAndSaveVideo(launched, 'reliability-disposal')
  }
})

test('HTML remote content requires opt-in and can be revoked', async ({
  browserName: _browserName,
}, info) => {
  let requests = 0
  const server = createServer((_request, response) => {
    requests++
    response.end('ok')
  })
  await new Promise<void>((done) => server.listen(0, '127.0.0.1', done))
  const port = (server.address() as { port: number }).port
  const scratch = await mkdtemp(join(tmpdir(), 'nawa-remote-html-'))
  const file = join(scratch, 'network.html')
  await writeFile(
    file,
    `<!doctype html><body><p id="local">Local scripts work</p><script>
document.getElementById('local').dataset.ready='yes';
setInterval(()=>fetch('http://127.0.0.1:${port}/beacon',{mode:'no-cors'}).catch(()=>{}),100);
</script></body>`,
  )
  const launched = await launchShell({ onboardingSeen: true, videoDir: 'reliability-network' })
  try {
    const editor = await open(launched, file, 'html')
    const local = editor.frameLocator('iframe').first().locator('#local')
    await expect(local).toHaveAttribute('data-ready', 'yes')
    await editor.waitForTimeout(500)
    expect(requests).toBe(0)
    await editor.getByRole('button', { name: 'Allow remote content', exact: true }).click()
    await expect.poll(() => requests).toBeGreaterThan(0)
    await editor.getByRole('button', { name: 'Block remote content', exact: true }).click()
    await expect(editor.locator('.preview-network-controls')).toContainText(
      'Remote content is blocked',
    )
    await editor.waitForTimeout(250)
    const stoppedAt = requests
    await editor.waitForTimeout(500)
    expect(requests).toBe(stoppedAt)
    await editor.screenshot({ path: info.outputPath('remote-blocked.png') })
  } finally {
    await closeAndSaveVideo(launched, 'reliability-network')
    await new Promise<void>((done) => server.close(() => done()))
  }
})

test('preview chat persists incomplete outcomes and excludes them after reopening', async () => {
  const requests: string[] = []
  const server = createServer(async (request, response) => {
    let body = ''
    for await (const chunk of request) body += chunk
    if (!request.url?.includes('chat/completions')) return response.end('{"input_tokens":100}')
    requests.push(body)
    response.writeHead(200, { 'Content-Type': 'text/event-stream' })
    const send = (delta: object, finish_reason: string | null) =>
      response.write(
        `data: ${JSON.stringify({ id: 'reliability', choices: [{ index: 0, delta, finish_reason }] })}\n\n`,
      )
    send({ role: 'assistant', content: 'PARTIAL_SENTINEL incomplete answer' }, null)
    send({}, 'length')
    response.end('data: [DONE]\n\n')
  })
  await new Promise<void>((done) => server.listen(0, '127.0.0.1', done))
  const port = (server.address() as { port: number }).port
  const scratch = await mkdtemp(join(tmpdir(), 'nawa-incomplete-preview-'))
  const file = join(scratch, 'message.eml')
  await copyFile(resolve('test-files/extended-formats/sample.eml'), file)
  let launched = await launchShell({ onboardingSeen: true, videoDir: 'reliability-incomplete' })
  try {
    const { userDataDir } = launched
    await launched.page.evaluate(async (baseUrl) => {
      const settings = await window.aiOffice.getAiSettings()
      settings.provider = 'custom'
      settings.providers.custom = { baseUrl, model: 'reliability', apiKey: '' }
      settings.gskToolsEnabled = false
      await window.aiOffice.setAiSettings(settings)
    }, `http://127.0.0.1:${port}/v1`)
    const show = async () => {
      await launched.page.evaluate((path) => window.aiOffice.openPath(path), file)
      return launched.page.locator('.preview-assistant')
    }
    let panel = await show()
    await panel.locator('textarea').fill('First question')
    await panel.locator('.ai-send-btn').click()
    await expect(panel.getByRole('button', { name: 'Retry', exact: true })).toBeVisible()
    await expect
      .poll(() =>
        launched.page.evaluate(async (folder) => {
          const { conversations } = await window.nawaHistory.list({ folder })
          return conversations[0]
            ? (await window.nawaHistory.get(conversations[0].id))?.messages.at(-1)?.request?.outcome
            : null
        }, file),
      )
      .toBe('incomplete')
    await closeAndSaveVideo(launched, 'reliability-incomplete-first')
    launched = await launchShell({
      userDataDir,
      onboardingSeen: true,
      videoDir: 'reliability-incomplete-reopen',
    })
    panel = await show()
    await expect(panel.getByRole('button', { name: 'Retry', exact: true })).toBeVisible()
    await panel.locator('textarea').fill('Second question')
    await panel.locator('.ai-send-btn').click()
    await expect.poll(() => requests.length).toBe(2)
    expect(requests[1]).not.toContain('PARTIAL_SENTINEL')
  } finally {
    await closeAndSaveVideo(launched, 'reliability-incomplete-reopen')
    await new Promise<void>((done) => server.close(() => done()))
  }
})

test('every editor and preview supports wide resizing and sidebar colors in Arabic', async ({
  browserName: _browserName,
}, info) => {
  test.setTimeout(180_000)
  const scratch = await mkdtemp(join(tmpdir(), 'nawa-resize-contract-'))
  const html = join(scratch, 'page.html'),
    markdown = join(scratch, 'note.md'),
    pdf = join(scratch, 'page.pdf')
  await writeFile(html, '<!doctype html><p>مرحبا 日本語</p>')
  await writeFile(markdown, '# مرحبا 日本語\n')
  const { PDFDocument } = await import('pdf-lib')
  const document = await PDFDocument.create()
  document.addPage()
  await writeFile(pdf, await document.save())
  const launched = await launchShell({
    onboardingSeen: true,
    lang: 'ar',
    videoDir: 'reliability-resize',
    settings: { defaultSaveDir: scratch },
  })
  try {
    await launched.app.evaluate(({ BrowserWindow }) => {
      BrowserWindow.getAllWindows()[0]!.setContentSize(1600, 950)
    })
    await launched.page.getByRole('treeitem').first().click()
    await expect(launched.page.locator('.workspace-chat-main')).toBeVisible()
    await expectSidebarChatColors(launched, launched.page, [
      '.nawa-workspace-control-panel',
      '.nawa-workspace-control-panel .nawa-chat-header',
      '.nawa-chat-context-toolbar',
      '.workspace-chat-main',
      '.workspace-chat-main .ws-chat-scroll',
      '.ws-chat-footer',
    ])
    const directoryHandle = launched.page.locator('.ex-assistant-splitter')
    await directoryHandle.press('End')
    await expect
      .poll(() =>
        launched.page
          .locator('.nawa-workspace-control-panel')
          .evaluate((element) => element.getBoundingClientRect().width),
      )
      .toBeGreaterThan(720)
    await launched.page.reload()
    await expect
      .poll(() =>
        launched.page
          .locator('.nawa-workspace-control-panel')
          .evaluate((element) => element.getBoundingClientRect().width),
      )
      .toBeGreaterThan(720)
    await launched.page.locator('.nawa-workspace-expand').click()
    await expect
      .poll(() =>
        launched.page
          .locator('.nawa-workspace-control-panel')
          .evaluate((element) => element.getBoundingClientRect().width / window.innerWidth),
      )
      .toBeGreaterThan(0.9)
    await launched.page.locator('.nawa-workspace-expand').click()
    for (const [source, host] of [
      ['test-files/legacy-office/document-sample.docx', 'docs'],
      ['test-files/spreadsheet-chat/source/binary.xlsx', 'sheets'],
      ['test-files/legacy-office/source/presentation-sample.pptx', 'slides'],
      [pdf, 'pdf'],
      [markdown, 'markdown'],
      [html, 'html'],
    ]) {
      const editor = await open(launched, resolve(source!), host!)
      const handle = editor.locator('.ai-panel-resizer')
      await expect(handle).toHaveAttribute('tabindex', '0')
      await handle.focus()
      await handle.press('Home')
      await expect(handle).toHaveAttribute('aria-valuenow', '280')
      await handle.press('ArrowRight')
      await expect(handle).toHaveAttribute('aria-valuenow', '290')
      await handle.press('End')
      expect(Number(await handle.getAttribute('aria-valuenow'))).toBeGreaterThan(720)
      const controls = await handle.getAttribute('aria-controls')
      const panel = editor.locator(`[id="${controls}"]`)
      await expect
        .poll(() => panel.evaluate((element) => element.getBoundingClientRect().width))
        .toBeGreaterThan(720)
      const { width, available } = await panel.evaluate((element) => {
        const host = element.closest('.sheet-body, .ai-dock')!
        return {
          width: element.getBoundingClientRect().width,
          available: host.matches('.sheet-body')
            ? host.clientWidth
            : host.parentElement!.clientWidth,
        }
      })
      expect(width).toBeGreaterThan(available * 0.6)
      await expectSidebarChatColors(launched, editor, [
        '.nawa-chat-panel',
        '.nawa-chat-header',
        '.chat-session-toolbar',
        '.ai-chat',
        '.ai-composer',
      ])
      expect(await editor.locator('html').getAttribute('dir')).toBe('rtl')
      if (host === 'html') await editor.screenshot({ path: info.outputPath('arabic-resize.png') })
    }
    await launched.page.evaluate(
      (path) => window.aiOffice.openPath(path),
      resolve('test-files/extended-formats/sample.eml'),
    )
    const handle = launched.page.locator('.preview-assistant .ai-panel-resizer')
    await handle.focus()
    await handle.press('Home')
    await expect(handle).toHaveAttribute('aria-valuenow', '280')
    await handle.press('ArrowRight')
    await expect(handle).toHaveAttribute('aria-valuenow', '290')
    const dock = launched.page.locator('.file-preview-ai')
    const drag = await handle.boundingBox()
    await launched.page.mouse.move(drag!.x + drag!.width / 2, drag!.y + drag!.height / 2)
    await launched.page.mouse.down()
    await launched.page.mouse.move(
      await launched.page.evaluate(() => window.innerWidth - 16),
      drag!.y + drag!.height / 2,
      { steps: 10 },
    )
    await launched.page.mouse.up()
    await expect
      .poll(() => dock.evaluate((element) => element.getBoundingClientRect().width))
      .toBeGreaterThan(720)
    const { width, available } = await dock.evaluate((element) => ({
      width: element.getBoundingClientRect().width,
      available: element.parentElement!.clientWidth,
    }))
    expect(width).toBeGreaterThan(available * 0.6)
    expect(available - width).toBeGreaterThanOrEqual(239)
    await expectSidebarChatColors(launched, launched.page, [
      '.preview-assistant',
      '.preview-assistant .nawa-chat-header',
      '.preview-assistant .chat-session-toolbar',
      '.preview-assistant .ws-chat-scroll',
      '.preview-assistant .ws-chat-composer',
    ])
  } finally {
    await closeAndSaveVideo(launched, 'reliability-resize')
  }
})

test('stopping or closing preview chat persists cancellation and permits a new question', async () => {
  const requests: string[] = []
  const server = createServer(async (request, response) => {
    let body = ''
    for await (const chunk of request) body += chunk
    if (!request.url?.includes('chat/completions')) return response.end('{"input_tokens":100}')
    requests.push(body)
    response.writeHead(200, { 'Content-Type': 'text/event-stream' })
    const send = (delta: object, finish_reason: string | null) =>
      response.write(
        `data: ${JSON.stringify({ id: 'cancel-test', choices: [{ index: 0, delta, finish_reason }] })}\n\n`,
      )
    const stopped = body.includes('STOP_RUN'),
      closed = body.includes('CLOSE_RUN')
    send(
      {
        role: 'assistant',
        content: stopped ? 'CANCELLED_SENTINEL' : closed ? 'CLOSED_SENTINEL' : 'COMPLETE_RESPONSE',
      },
      null,
    )
    if (stopped || closed) return
    send({}, 'stop')
    response.end('data: [DONE]\n\n')
  })
  await new Promise<void>((done) => server.listen(0, '127.0.0.1', done))
  const port = (server.address() as { port: number }).port
  const scratch = await mkdtemp(join(tmpdir(), 'nawa-preview-cancel-'))
  const file = join(scratch, 'conversation.eml')
  await copyFile(resolve('test-files/extended-formats/sample.eml'), file)
  const launched = await launchShell({ onboardingSeen: true, videoDir: 'reliability-cancel' })
  try {
    await launched.page.evaluate(async (baseUrl) => {
      const settings = await window.aiOffice.getAiSettings()
      settings.provider = 'custom'
      settings.providers.custom = { baseUrl, model: 'cancel-test', apiKey: '' }
      settings.gskToolsEnabled = false
      await window.aiOffice.setAiSettings(settings)
    }, `http://127.0.0.1:${port}/v1`)
    const openChat = async () => {
      await launched.page.evaluate((path) => window.aiOffice.openPath(path), file)
      return launched.page.locator('.preview-assistant')
    }
    let panel = await openChat()
    const sendQuestion = async (text: string) => {
      await panel.locator('textarea').fill(text)
      await panel.locator('.ai-send-btn').click()
    }
    await sendQuestion('STOP_RUN')
    await expect(panel).toContainText('CANCELLED_SENTINEL')
    await panel.getByRole('button', { name: 'Stop', exact: true }).click()
    await sendQuestion('After stop')
    await expect(panel).toContainText('COMPLETE_RESPONSE')
    expect(requests[1]).not.toContain('CANCELLED_SENTINEL')
    await sendQuestion('CLOSE_RUN')
    await expect(panel).toContainText('CLOSED_SENTINEL')
    const tab = await launched.page.evaluate(
      async (path) => (await window.aiOfficeTabs.list()).find((item) => item.filePath === path),
      file,
    )
    await launched.page.evaluate((id) => window.aiOfficeTabs.close(id), tab!.id)
    panel = await openChat()
    await expect(panel.getByRole('button', { name: 'Retry', exact: true })).toHaveCount(2)
    await sendQuestion('After close')
    await expect.poll(() => requests.length).toBe(4)
    expect(requests[3]).not.toContain('CANCELLED_SENTINEL')
    expect(requests[3]).not.toContain('CLOSED_SENTINEL')
    await expect
      .poll(() =>
        launched.page.evaluate(async (folder) => {
          const { conversations } = await window.nawaHistory.list({ folder })
          const record = conversations[0] && (await window.nawaHistory.get(conversations[0].id))
          return record?.messages
            .filter((message) => message.role === 'assistant')
            .map((message) => message.request?.outcome)
        }, file),
      )
      .toEqual(['cancelled', 'completed', 'cancelled', 'completed'])
    await writeFile(
      file,
      'Subject: Changed snapshot\r\nContent-Type: text/plain; charset=utf-8\r\n\r\nCHANGED_SNAPSHOT\r\n',
    )
    await launched.page.getByRole('button', { name: 'Refresh preview', exact: true }).click()
    await expect(launched.page.locator('.file-preview-message')).toContainText('CHANGED_SNAPSHOT')
    await sendQuestion('After refresh')
    await expect.poll(() => requests.length).toBe(5)
    expect(requests[4]).not.toContain('COMPLETE_RESPONSE')
  } finally {
    await closeAndSaveVideo(launched, 'reliability-cancel')
    server.closeAllConnections()
    await new Promise<void>((done) => server.close(() => done()))
  }
})
