import { expect, test } from '@playwright/test'
import { createServer } from 'node:http'
import { DatabaseSync } from 'node:sqlite'
import { copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { createCanvas } from '@napi-rs/canvas'
import { closeAndSaveVideo, launchShell, screenshotPath } from './helpers'

test('Index embeds recognized image text and distinguishes successful OCR from a textless image', async () => {
  test.skip(process.platform !== 'win32', 'Exercises the packaged Windows OCR helper.')
  const scratch = await mkdtemp(join(tmpdir(), 'nawa-image-index-'))
  const documents = join(scratch, 'Images'),
    userDataDir = join(scratch, 'state')
  await mkdir(documents)
  await mkdir(userDataDir)
  const image = join(documents, 'readable.png'),
    blank = join(documents, 'blank.png')
  await copyFile(resolve('packages/pdf2docx/ocr-helper/fixtures/smoke-en.png'), image)
  const original = await readFile(image)
  const canvas = createCanvas(64, 64),
    context = canvas.getContext('2d')
  context.fillStyle = '#ffffff'
  context.fillRect(0, 0, 64, 64)
  await writeFile(blank, await canvas.encode('png'))
  await writeFile(
    join(userDataDir, 'workspace-folders.json'),
    JSON.stringify({ version: 1, roots: [documents] }),
  )

  const embeddedInputs: string[] = []
  const server = createServer(async (request, response) => {
    response.setHeader('Content-Type', 'application/json')
    if (request.url !== '/v1/embeddings') {
      response.writeHead(404).end('{}')
      return
    }
    let body = ''
    for await (const chunk of request) body += chunk
    const { input } = JSON.parse(body) as { input: string[] }
    embeddedInputs.push(...input)
    response.end(
      JSON.stringify({ data: input.map((_, index) => ({ index, embedding: [0.6, 0.8] })) }),
    )
  })
  await new Promise<void>((done) => server.listen(0, '127.0.0.1', done))
  const { port } = server.address() as { port: number }
  let launched: Awaited<ReturnType<typeof launchShell>> | undefined
  try {
    launched = await launchShell({ userDataDir, onboardingSeen: true, videoDir: 'image-indexing' })
    const { page } = launched
    await page.evaluate(async (baseUrl) => {
      const view = await window.nawaRag.settings()
      await window.nawaRag.save({
        ...view.settings,
        enabled: true,
        backend: 'local',
        model: 'ocr-test',
        dimensions: 2,
        tokenizer: 'conservative',
        baseUrl,
      })
    }, `http://127.0.0.1:${port}/v1`)
    await page.getByRole('treeitem', { name: 'Images', exact: true }).click()
    const row = page.locator('.ex-file-row').filter({ hasText: 'readable.png' })
    await row.locator('.ex-file-name').click()
    await expect(row).toHaveAttribute('aria-selected', 'true')
    const index = page.getByRole('button', { name: 'Index selected files', exact: true })
    await expect(index).toBeEnabled()
    await index.click()
    const icon = row.locator('.ex-column-indexed [data-state]')
    await expect(icon).toHaveAttribute('aria-label', 'Search: Image text indexed (OCR)')
    await expect(icon).toHaveAttribute('data-state', 'ready')
    expect(embeddedInputs.join('\n')).toContain('OCR Smoke Fixture')
    expect(embeddedInputs.join('\n')).toContain('quick brown fox')
    await icon.hover()
    await expect(page.getByRole('tooltip')).toContainText('visual meaning are not embedded')
    await page.screenshot({ path: screenshotPath('image-text-indexed-ocr') })

    const stored = (() => {
      const db = new DatabaseSync(join(userDataDir, 'rag', 'content-v1.sqlite3'), {
        readOnly: true,
      })
      try {
        return db
          .prepare(
            'SELECT f.status,f.chunks,length(c.text) AS characters,length(c.vector)/4 AS dimensions FROM rag_files f JOIN rag_chunks c ON c.path=f.path',
          )
          .all()
      } finally {
        db.close()
      }
    })()
    expect(stored.length).toBeGreaterThan(0)
    expect(stored[0]).toMatchObject({ status: 'embedded', dimensions: 2 })
    expect(Number(stored[0].characters)).toBeGreaterThan(20)
    const requests = embeddedInputs.length
    await expect(index).toBeEnabled()
    await index.click()
    await expect(index).toBeEnabled()
    expect(embeddedInputs).toHaveLength(requests)

    const blankRow = page.locator('.ex-file-row').filter({ hasText: 'blank.png' })
    await blankRow.locator('.ex-file-name').click()
    await expect(blankRow).toHaveAttribute('aria-selected', 'true')
    await index.click()
    const blankIcon = blankRow.locator('.ex-column-indexed [data-state]')
    await expect(blankIcon).toHaveAttribute('data-state', 'failed')
    await blankIcon.hover()
    await expect(page.getByRole('tooltip')).toContainText('Local OCR found no readable text')
    expect(embeddedInputs).toHaveLength(requests)
    expect(await readFile(image)).toEqual(original)
  } finally {
    if (launched) await closeAndSaveVideo(launched, 'image-indexing')
    await new Promise<void>((done, reject) =>
      server.close((error) => (error ? reject(error) : done())),
    )
    await rm(scratch, { recursive: true, force: true })
  }
})
