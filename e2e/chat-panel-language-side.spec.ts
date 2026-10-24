import { test, expect, type Page, type Locator } from '@playwright/test'
import { mkdir, mkdtemp, writeFile, readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { AI_PANEL_SIDE_LABELS } from '../packages/ui/src/strings-ai-panel-side'
import { launchShell, closeAndSaveVideo, waitForPageWithUrl, screenshotPath } from './helpers'

async function language(page: Page, from: 'en' | 'ar', to: 'en' | 'ar') {
  await page
    .getByRole('button', { name: from === 'en' ? 'Settings' : 'الإعدادات', exact: true })
    .click()
  await page
    .locator('.set-nav-item')
    .filter({ hasText: from === 'en' ? 'General' : 'عام' })
    .click()
  await page
    .getByRole('button', { name: from === 'en' ? 'Language' : 'اللغة', exact: true })
    .click()
  await page.getByRole('option', { name: to === 'en' ? 'English' : 'العربية', exact: true }).click()
  await expect(page.locator('html')).toHaveAttribute('dir', to === 'ar' ? 'rtl' : 'ltr')
  await page.locator('.set-close').click()
}

async function directoryPosition(page: Page, panel: Locator, side: 'left' | 'right') {
  await expect(page.locator('html')).toHaveAttribute('data-ai-panel-side', side)
  const nav = (await page.locator('.ex-navigation').boundingBox())!
  const content = (await page.locator('.ex-center').boundingBox())!
  const chat = (await panel.boundingBox())!
  const rtl = (await page.locator('html').getAttribute('dir')) === 'rtl'
  expect(rtl ? nav.x > content.x : nav.x < content.x).toBe(true)
  expect(rtl ? nav.x >= chat.x + chat.width : nav.x + nav.width <= chat.x).toBe(true)
  expect(side === 'left' ? chat.x < content.x : chat.x > content.x).toBe(true)
}

async function resize(page: Page, panel: Locator, side: 'left' | 'right') {
  const before = (await panel.boundingBox())!.width
  const handle = (await page.locator('.ex-assistant-splitter').boundingBox())!
  const x = handle.x + handle.width / 2
  await page.mouse.move(x, handle.y + 100)
  await page.mouse.down()
  await page.mouse.move(x + (side === 'left' ? 35 : -35), handle.y + 100, { steps: 5 })
  await page.mouse.up()
  await expect.poll(async () => (await panel.boundingBox())!.width).toBeGreaterThan(before + 25)
}

test('chat positions stay physical across language changes and synchronize between directory and file chats', async () => {
  const scratch = await mkdtemp(join(tmpdir(), 'nawa-chat-side-language-'))
  const folder = join(scratch, 'Documents'),
    userDataDir = join(scratch, 'state')
  await mkdir(folder)
  await mkdir(userDataDir)
  await writeFile(join(folder, 'sales.csv'), 'product,amount\nA,10\nB,20\n')
  await writeFile(
    join(userDataDir, 'workspace-folders.json'),
    JSON.stringify({ version: 1, roots: [folder] }),
  )
  const launched = await launchShell({
    userDataDir,
    onboardingSeen: true,
    videoDir: 'chat-side-language',
  })
  const { page } = launched
  const fixture = join(__dirname, 'assets/justify-pagegap-fr.docx')
  try {
    await page.getByRole('treeitem', { name: 'Documents', exact: true }).click()
    const row = page.locator('.ex-file-row').filter({ hasText: 'sales.csv' })
    await row.getByRole('checkbox').check()
    await expect(row).toHaveAttribute('aria-selected', 'true')
    const panel = page.locator('.nawa-workspace-control-panel')
    const draft = panel.locator('.ai-input-box textarea')
    const history = panel.locator('.nawa-history-dropdown select')
    const model = panel.locator('.nawa-chat-model-control select')
    await draft.fill('مسودة محفوظة عند تغيير اللغة وموقع المحادثة')
    const conversation = await history.inputValue(),
      selectedModel = await model.inputValue()
    await directoryPosition(page, panel, 'left')
    await panel.getByRole('button', { name: AI_PANEL_SIDE_LABELS.en.right, exact: true }).click()
    await directoryPosition(page, panel, 'right')
    await resize(page, panel, 'right')
    await expect(row).toHaveAttribute('aria-selected', 'true')
    await language(page, 'en', 'ar')
    await expect(row).toHaveAttribute('aria-selected', 'true')
    await directoryPosition(page, panel, 'right')
    await expect(page.locator('.ex-navigation')).toHaveCSS('direction', 'rtl')
    await expect(page.locator('.ex-center')).toHaveCSS('direction', 'rtl')
    await expect(panel).toHaveCSS('direction', 'rtl')
    await expect(panel.locator('.nawa-chat-header')).toHaveCSS('direction', 'rtl')
    const moveLeft = panel.getByRole('button', { name: AI_PANEL_SIDE_LABELS.ar.left, exact: true })
    await expect(moveLeft).toHaveAttribute('data-tip', AI_PANEL_SIDE_LABELS.ar.left)
    await moveLeft.click()
    await directoryPosition(page, panel, 'left')
    await resize(page, panel, 'left')
    await expect(draft).toHaveValue('مسودة محفوظة عند تغيير اللغة وموقع المحادثة')
    await expect(history).toHaveValue(conversation)
    await expect(model).toHaveValue(selectedModel)
    await expect(row).toHaveClass(/is-selected/)
    await page.screenshot({ path: screenshotPath('directory-chat-arabic-left') })
    await panel.getByRole('button', { name: 'توسيع اللوحة', exact: true }).click()
    await expect(panel).toHaveClass(/is-expanded/)
    expect((await panel.boundingBox())!.x).toBeCloseTo(12, 0)
    await panel.getByRole('button', { name: AI_PANEL_SIDE_LABELS.ar.right, exact: true }).click()
    const expanded = (await panel.boundingBox())!
    expect(expanded.x + expanded.width).toBeCloseTo(await page.evaluate(() => innerWidth - 12), 0)
    const titlebar = (await page.locator('.tab-bar').boundingBox())!
    expect(expanded.y).toBeGreaterThan(titlebar.y + titlebar.height)
    await panel.getByRole('button', { name: 'إرساء اللوحة', exact: true }).click()
    await directoryPosition(page, panel, 'right')

    await page.evaluate((path) => window.aiOffice.openPath(path), fixture)
    const editor = await waitForPageWithUrl(launched.app, '://docs/')
    await expect(editor.locator('.ProseMirror').first()).toBeVisible()
    await expect(editor.locator('html')).toHaveAttribute('dir', 'rtl')
    await expect
      .poll(async () => editor.evaluate(() => innerWidth))
      .toBeCloseTo((await page.locator('.ex-center').boundingBox())!.width, 0)
    await expect(editor.locator('.ai-panel')).toHaveCSS('direction', 'rtl')
    await expect(editor.locator('.editor-scroll')).toHaveCSS('direction', 'ltr')
    const dock = editor.locator('.ai-dock'),
      content = editor.locator('.app-content')
    expect((await dock.boundingBox())!.x).toBeGreaterThan((await content.boundingBox())!.x)
    const fileDraft = editor.locator('.ai-composer textarea')
    await fileDraft.fill('File chat draft survives language and side changes')
    await editor.getByRole('button', { name: AI_PANEL_SIDE_LABELS.ar.left, exact: true }).click()
    await expect(page.locator('html')).toHaveAttribute('data-ai-panel-side', 'left')
    expect((await dock.boundingBox())!.x).toBeLessThan((await content.boundingBox())!.x)
    await editor.screenshot({ path: screenshotPath('file-chat-arabic-left') })
    await page.locator('.tab-item.tab-home').click()
    await directoryPosition(page, panel, 'left')
    await expect(draft).toHaveValue('مسودة محفوظة عند تغيير اللغة وموقع المحادثة')
    await language(page, 'ar', 'en')
    await directoryPosition(page, panel, 'left')
    await expect(editor.locator('html')).toHaveAttribute('dir', 'ltr')
    await panel.getByRole('button', { name: AI_PANEL_SIDE_LABELS.en.right, exact: true }).click()
    await expect(editor.locator('html')).toHaveAttribute('data-ai-panel-side', 'right')
    await page.locator('.tab-item').filter({ hasText: 'justify-pagegap-fr.docx' }).click()
    expect((await dock.boundingBox())!.x).toBeGreaterThan((await content.boundingBox())!.x)
    await expect(fileDraft).toHaveValue('File chat draft survives language and side changes')
    const saved = JSON.parse(await readFile(join(userDataDir, 'app-settings.json'), 'utf8'))
    expect(saved.aiPanelSide).toBe('right')
  } finally {
    await closeAndSaveVideo(launched, 'chat-side-language')
  }
  const restarted = await launchShell({
    userDataDir,
    lang: 'ar',
    videoDir: 'chat-side-language-restart',
  })
  try {
    await directoryPosition(
      restarted.page,
      restarted.page.locator('.nawa-workspace-control-panel'),
      'right',
    )
  } finally {
    await closeAndSaveVideo(restarted, 'chat-side-language-restart')
  }
})
