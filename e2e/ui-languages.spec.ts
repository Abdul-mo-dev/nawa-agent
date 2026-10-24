import { test, expect } from '@playwright/test'
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { strings } from '../apps/shell/src/renderer/src/strings'
import { launchShell, closeAndSaveVideo, screenshotPath } from './helpers'

test('offers shipped languages and mirrors Arabic interface layout when switching languages', async () => {
  const launched = await launchShell({
    onboardingSeen: true,
    settings: { language: 'fr' },
    env: { GENOFFICE_LANG: '' },
    videoDir: 'ui-languages',
  })
  const { page, userDataDir } = launched
  try {
    await expect(page.locator('html')).toHaveAttribute('lang', 'en-US')
    expect(await page.evaluate(() => window.aiOffice.getLanguage())).toBe('en')
    await page.getByRole('button', { name: strings.en.settings, exact: true }).click()
    await page.locator('.set-nav-item').filter({ hasText: strings.en.setSecGeneral }).click()

    const layoutSelectors = [
      '.tab-strip',
      '.ex-history',
      '.ex-search',
      '.ex-navigation',
      '.ex-center',
      '.set-nav',
      '.set-pane',
      '.set-close',
    ]
    const originalLayout = await Promise.all(
      layoutSelectors.map((selector) => page.locator(selector).boundingBox()),
    )

    let current: 'en' | 'ja' | 'ar' = 'en'
    for (const next of ['ja', 'ar', 'en'] as const) {
      await page.getByRole('button', { name: strings[current].language, exact: true }).click()
      await expect(page.getByRole('option')).toHaveText(['العربية', 'English', '日本語'])
      const label = { en: 'English', ja: '日本語', ar: 'العربية' }[next]
      await page.getByRole('option', { name: label, exact: true }).click()
      await expect(page.locator('html')).toHaveAttribute(
        'lang',
        { en: 'en-US', ja: 'ja-JP', ar: 'ar-SA' }[next],
      )
      await expect(page.locator('html')).toHaveAttribute('dir', next === 'ar' ? 'rtl' : 'ltr')
      const newButton = await page.locator('.ex-new-button').boundingBox()
      const assistantButton = await page.locator('.ex-assistant-toggle').boundingBox()
      expect(
        next === 'ar' ? assistantButton!.x < newButton!.x : assistantButton!.x > newButton!.x,
      ).toBe(true)
      for (const [index, selector] of layoutSelectors.entries()) {
        const box = await page.locator(selector).boundingBox()
        expect(box, `${selector} is visible in ${next}`).not.toBeNull()
        if (next !== 'ar') {
          expect(box!.x, `${selector} restores its horizontal position in ${next}`).toBeCloseTo(
            originalLayout[index]!.x,
            0,
          )
          expect(box!.width, `${selector} restores its width in ${next}`).toBeCloseTo(
            originalLayout[index]!.width,
            0,
          )
        }
      }
      const nav = (await page.locator('.ex-navigation').boundingBox())!
      const content = (await page.locator('.ex-center').boundingBox())!
      const settingsNav = (await page.locator('.set-nav').boundingBox())!
      const settingsPane = (await page.locator('.set-pane').boundingBox())!
      const close = (await page.locator('.set-close').boundingBox())!
      const title = (await page.locator('.set-title').boundingBox())!
      expect(next === 'ar' ? nav.x > content.x : nav.x < content.x).toBe(true)
      expect(next === 'ar' ? settingsNav.x > settingsPane.x : settingsNav.x < settingsPane.x).toBe(
        true,
      )
      expect(next === 'ar' ? close.x < title.x : close.x > title.x).toBe(true)
      await expect(page.locator('.ex-history .ex-icon').first()).toHaveCSS(
        'transform',
        next === 'ar' ? 'matrix(-1, 0, 0, 1, 0, 0)' : 'none',
      )
      const textDirection = next === 'ar' ? 'rtl' : 'ltr'
      await expect(page.locator('.set-title')).toHaveCSS('direction', textDirection)
      await expect(page.locator('.set-field-label').first()).toHaveCSS('direction', textDirection)
      await expect(page.locator('.set-dd .gs-dd-value').first()).toHaveCSS(
        'direction',
        textDirection,
      )
      if (next !== 'ja') {
        await page.screenshot({ path: screenshotPath(`ui-layout-${next}`) })
      }
      await expect
        .poll(
          async () =>
            JSON.parse(await readFile(join(userDataDir, 'app-settings.json'), 'utf8')).language,
        )
        .toBe(next)
      current = next
    }
  } finally {
    await closeAndSaveVideo(launched, 'ui-languages')
  }
})

test('Arabic navigation expands toward the left and resizes from the sidebar edge', async () => {
  const scratch = await mkdtemp(join(tmpdir(), 'nawa-rtl-navigation-'))
  const folder = join(scratch, 'Workspace')
  const userDataDir = join(scratch, 'state')
  await mkdir(join(folder, 'Reports'), { recursive: true })
  await mkdir(userDataDir)
  await writeFile(join(folder, 'Reports', 'notes.md'), '# Notes')
  await writeFile(
    join(userDataDir, 'workspace-folders.json'),
    JSON.stringify({ version: 1, roots: [folder] }),
  )
  const launched = await launchShell({
    userDataDir,
    onboardingSeen: true,
    lang: 'ar',
    videoDir: 'rtl-navigation',
  })
  const { page } = launched
  try {
    const nav = page.locator('.ex-navigation')
    const reports = nav.getByRole('treeitem', { name: 'Reports', exact: true })
    await expect(reports).toHaveAttribute('aria-expanded', 'false')
    await reports.focus()
    await page.keyboard.press('ArrowLeft')
    await expect(reports).toHaveAttribute('aria-expanded', 'true')
    await expect(nav.getByRole('treeitem', { name: 'notes.md', exact: true })).toBeVisible()
    await page.keyboard.press('ArrowRight')
    await expect(reports).toHaveAttribute('aria-expanded', 'false')
    const before = (await nav.boundingBox())!.width
    const splitter = page.locator('.ex-navigation-splitter')
    await splitter.focus()
    await page.keyboard.press('ArrowLeft')
    await expect.poll(async () => (await nav.boundingBox())!.width).toBeCloseTo(before + 10, 0)
    const handle = (await splitter.boundingBox())!
    await page.mouse.move(handle.x + handle.width / 2, handle.y + 80)
    await page.mouse.down()
    await page.mouse.move(handle.x + handle.width / 2 - 35, handle.y + 80, { steps: 5 })
    await page.mouse.up()
    await expect.poll(async () => (await nav.boundingBox())!.width).toBeCloseTo(before + 45, 0)
    await page.screenshot({ path: screenshotPath('arabic-navigation') })
  } finally {
    await closeAndSaveVideo(launched, 'rtl-navigation')
  }
})

test('Arabic tabs reorder in their mirrored visual order', async () => {
  const scratch = await mkdtemp(join(tmpdir(), 'nawa-rtl-tabs-'))
  const firstFile = join(scratch, 'first.md')
  const secondFile = join(scratch, 'second.md')
  await writeFile(firstFile, '# First')
  await writeFile(secondFile, '# Second')
  const launched = await launchShell({ onboardingSeen: true, lang: 'ar', videoDir: 'rtl-tabs' })
  const { page } = launched
  try {
    await page.evaluate((path) => window.aiOffice.openPath(path), firstFile)
    await page.evaluate((path) => window.aiOffice.openPath(path), secondFile)
    const titles = page.locator('.tab-item:not(.tab-home) .tab-title')
    await expect(titles).toHaveText(['first.md', 'second.md'])
    const first = (await page.locator('.tab-item').filter({ hasText: 'first.md' }).boundingBox())!
    const second = (await page.locator('.tab-item').filter({ hasText: 'second.md' }).boundingBox())!
    const home = (await page.locator('.tab-home').boundingBox())!
    expect(home.x).toBeGreaterThan(first.x)
    expect(first.x).toBeGreaterThan(second.x)
    await page.mouse.move(first.x + first.width / 2, first.y + first.height / 2)
    await page.mouse.down()
    await page.mouse.move(second.x + second.width / 4, first.y + first.height / 2, { steps: 12 })
    await page.mouse.up()
    await expect(titles).toHaveText(['second.md', 'first.md'])
    expect((await page.locator('.tab-home').boundingBox())!.x).toBeCloseTo(home.x, 0)
    await page.screenshot({ path: screenshotPath('arabic-tab-order') })
  } finally {
    await closeAndSaveVideo(launched, 'rtl-tabs')
  }
})
