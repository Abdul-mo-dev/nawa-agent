import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const nativePaths = vi.hoisted(() => new Map<number, string>())
const sheetsHooks = vi.hoisted(() => ({
  opened: undefined as ((contents: { id: number }, filePath: string) => void) | undefined,
}))

vi.mock('electron', () => ({
  dialog: { showOpenDialog: vi.fn(), showSaveDialog: vi.fn(), showMessageBox: vi.fn() },
  ipcMain: { handle: vi.fn(), removeHandler: vi.fn(), rawListeners: () => [] },
  protocol: { handle: vi.fn() },
}))
vi.mock('@genoffice/electron-utils', () => ({ setDefaultSaveDirProvider: vi.fn() }))
vi.mock('@genoffice/ai-provider', () => ({ defaultAiSettings: () => ({}) }))
vi.mock('@genoffice/docx-engine', () => ({ buildBlankDocx: vi.fn() }))
vi.mock('@genoffice/pptx-engine', () => ({ createBlankPptx: vi.fn() }))
vi.mock('@genoffice/xlsx-gateway/gateway/csv-import', () => ({ blankXlsxBuffer: vi.fn() }))
vi.mock('../../pdf/src/main/blank-pdf', () => ({ blankPdfBuffer: vi.fn() }))
vi.mock('../../docs/src/main/docs-main', () => ({
  configureDocsRuntime: vi.fn(),
  registerDocsIpc: vi.fn(),
  teardownDocsRenderer: vi.fn(),
}))
vi.mock('../../sheets/src/main/sheets-main', () => ({
  configureSheetsRuntime: vi.fn(),
  setSheetsWorkbookOpenedHook: vi.fn((hook) => {
    sheetsHooks.opened = hook
  }),
}))
vi.mock('../../slides/src/main/slides-main', () => ({}))
vi.mock('../../slides/src/main/session-state', () => ({ configureSlidesRuntime: vi.fn() }))
vi.mock('../../pdf/src/main/pdf-main', () => ({ configurePdfRuntime: vi.fn() }))
vi.mock('../../markdown/src/main/markdown-main', () => ({
  configureMarkdownRuntime: vi.fn(),
  markdownAdoptSavedPath: vi.fn((contents: { id: number }, filePath: string) =>
    nativePaths.set(contents.id, filePath),
  ),
}))
vi.mock('../../html/src/main/html-main', () => ({
  configureHtmlRuntime: vi.fn(),
  htmlAdoptSavedPath: vi.fn((contents: { id: number }, filePath: string) =>
    nativePaths.set(contents.id, filePath),
  ),
}))

import { ipcMain, protocol } from 'electron'
import { NativeHost } from '../src/main/host'
import { Workspace } from '../server/workspace.mjs'

const cleanup: Array<() => Promise<void>> = []
beforeEach(() => {
  // Each host captures the Electron registration methods once.
  ipcMain.handle = vi.fn()
  ipcMain.removeHandler = vi.fn()
  protocol.handle = vi.fn()
  nativePaths.clear()
})
afterEach(async () => {
  for (const close of cleanup.splice(0)) await close()
})

async function fixture(
  kind: 'markdown' | 'html' | 'docs' | 'sheets',
  extension = kind === 'markdown'
    ? 'md'
    : kind === 'docs'
      ? 'docx'
      : kind === 'sheets'
        ? 'csv'
        : 'html',
) {
  const temp = await mkdtemp(path.join(os.tmpdir(), 'nawa-native-host-'))
  const directory = path.join(temp, 'files')
  await mkdir(directory)
  const absolute = path.join(directory, `original.${extension}`)
  await writeFile(absolute, 'original')
  const workspace = new Workspace({ stateDir: path.join(temp, 'state') })
  await workspace.initialize()
  const mount = await workspace.mount(directory)
  const webContents = {
    id: 1,
    mainFrame: {},
    isDestroyed: () => false,
    close: vi.fn(),
    send: vi.fn(),
  }
  const tab = {
    id: 'tab',
    kind,
    mount: mount.id,
    path: `original.${extension}`,
    absolute,
    revision: (await workspace.read(mount.id, `original.${extension}`)).revision,
    view: { webContents },
  }
  nativePaths.set(webContents.id, absolute)
  const host = new NativeHost(temp, temp)
  const emit = vi.fn()
  host.attach({
    workspace,
    tabs: new Map([[tab.id, tab]]),
    origin: () => 'http://127.0.0.1:1',
    emit,
    addResource: () => '',
  } as any)
  cleanup.push(async () => {
    await host.closeTab(tab as any)
    await rm(temp, { recursive: true, force: true })
  })
  return { host, tab, directory, extension, emit }
}

describe('browser native host save workflows', () => {
  for (const extension of ['csv', 'tsv', 'xls']) {
    it(`${extension} import keeps the mounted source identity while the native session uses temporary XLSX bytes`, async () => {
      const { host, tab, directory, emit } = await fixture('sheets', extension)
      const source = tab.absolute
      const internalPath = path.join(path.dirname(directory), 'private-import.xlsx')
      const file = {
        sessionId: 'import-session',
        path: internalPath,
        ...(extension === 'csv' ? { csvPath: source } : { needsSaveAs: true }),
      }
      ipcMain.handle('workbook:select', (event) => {
        sheetsHooks.opened!(event.sender, source)
        return file
      })
      const opened = await host.invoke(tab as any, 'workbook:select', [])
      expect(opened).toEqual({ ...file, path: source })
      expect(tab.absolute).toBe(source)
      expect(tab.path).toBe(`original.${extension}`)
      expect(emit).toHaveBeenCalledWith(
        tab,
        'browser:opened',
        expect.objectContaining({ path: `original.${extension}` }),
      )

      const target = extension === 'csv' ? source : path.join(directory, 'saved.xlsx')
      ipcMain.handle('workbook:save', async (event) => {
        await writeFile(target, 'saved values')
        sheetsHooks.opened!(event.sender, target)
        return {
          canceled: false,
          file: { ...file, path: extension === 'csv' ? internalPath : target },
        }
      })
      const saved = await host.invoke(tab as any, 'workbook:save', [
        { mode: 'save', sessionId: file.sessionId },
      ])
      expect(saved.file.path).toBe(target)
      expect(tab.absolute).toBe(target)
      expect(await readFile(target, 'utf8')).toBe('saved values')
    })
  }

  for (const kind of ['markdown', 'html'] as const) {
    it(`${kind} Save As updates native reload/image identity and preserves the source file`, async () => {
      const { host, tab, directory, extension, emit } = await fixture(kind)
      const target = path.join(directory, `copy.${extension}`)
      ipcMain.handle(`${kind}:consume-pending`, (event) => nativePaths.get(event.sender.id))
      emit.mockImplementation((_tab, channel, request) => {
        if (channel === 'browser:dialog') {
          void host.replyDialog(tab as any, {
            id: request.id,
            value: { path: `copy.${extension}` },
          })
        }
      })
      const result = await host.invoke(tab as any, `${kind}:save`, [
        { mode: 'saveAs', text: 'new copy' },
      ])
      expect(result).toEqual({ ok: true, path: target })
      expect(await readFile(path.join(directory, `original.${extension}`), 'utf8')).toBe('original')
      expect(await readFile(target, 'utf8')).toBe('new copy')
      expect(await host.invoke(tab as any, `${kind}:consume-pending`, [])).toBe(target)
      await host.invoke(tab as any, `${kind}:save`, [{ mode: 'save', text: 'updated copy' }])
      expect(await readFile(target, 'utf8')).toBe('updated copy')
      expect(await readFile(path.join(directory, `original.${extension}`), 'utf8')).toBe('original')
    })
  }

  it('document-replace confirmation can await a nested Save without deadlocking the tab', async () => {
    const { host, tab } = await fixture('docs')
    ipcMain.handle('docs:save', async (_event, target: string, bytes: Uint8Array) => {
      await writeFile(target, bytes)
      return { ok: true }
    })
    ipcMain.handle('docs:confirm-document-replace', async () => {
      const saved = await host.invoke(tab as any, 'docs:save', [
        tab.absolute,
        Buffer.from('saved first'),
      ])
      return saved.ok === true
    })
    expect(await host.invoke(tab as any, 'docs:confirm-document-replace', [])).toBe(true)
    expect(await readFile(tab.absolute, 'utf8')).toBe('saved first')
  })
})
