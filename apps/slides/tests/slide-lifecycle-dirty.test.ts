import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { copyFile, mkdtemp, readFile, rm } from 'node:fs/promises'
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  configureDirectoryStage,
  registerDirectoryStage,
} from '../../../packages/electron-utils/src/directory-stage'

const handlers = new Map<string, (...args: never[]) => unknown>()
const saveChoice = vi.hoisted(() => ({ path: '' }))

vi.mock('electron', () => ({
  app: {
    getPath: () => tmpdir(),
    getName: () => 'slides-test',
    getVersion: () => '0',
    whenReady: () => Promise.resolve(),
  },
  dialog: {
    showSaveDialog: vi.fn(async () => ({ canceled: !saveChoice.path, filePath: saveChoice.path })),
    showMessageBox: vi.fn(async () => ({ response: 0 })),
  },
  safeStorage: { isEncryptionAvailable: () => false },
  clipboard: { writeBuffer: () => {} },
  ipcMain: {
    handle: (channel: string, fn: (...args: never[]) => unknown) => handlers.set(channel, fn),
    on: () => {},
    removeHandler: () => {},
  },
  BrowserWindow: class {
    static getFocusedWindow() {
      return null
    }
    static fromWebContents() {
      return null
    }
  },
  webContents: { getAllWebContents: () => [], fromId: () => null },
  Menu: { buildFromTemplate: () => ({}), setApplicationMenu: () => {} },
  session: {
    defaultSession: { protocol: {}, setDisplayMediaRequestHandler: () => {} },
  },
  nativeImage: {},
  shell: {},
  desktopCapturer: { getSources: async () => [] },
  WebContentsView: class {},
}))
// The shaping chain loads a harfbuzz wasm that cannot resolve in the unit-test env;
// none of the handlers under test measure text.
vi.mock('../src/main/shaped-metrics', () => ({
  shapedMetricsReady: async () => {},
  refineComplexWidths: async () => {},
  complexScriptOf: () => null,
  initShapedMetrics: () => {},
  gtMeasure: (t: string) => ({ width: t.length * 8 }),
  shapedFamily: () => null,
  shapedMeasure: () => ({ width: 0 }),
}))
// Mock the LibreOffice converter so CI covers the legacy dirty/save-blocked path
// without requiring an installed LibreOffice.
vi.mock('@genoffice/electron-utils/legacy-office', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@genoffice/electron-utils/legacy-office')>()
  return {
    ...actual,
    findLibreOffice: async () => '/mock/soffice',
    importLegacyOffice: async (sourcePath: string) => {
      const { createBlankPptx } = await import('@genoffice/pptx-engine')
      const extension = sourcePath.split('.').pop()?.toLowerCase() ?? 'ppt'
      return {
        bytes: Buffer.from(await createBlankPptx()),
        extension,
        suggestSaveAs: sourcePath.replace(/\.[^.]+$/, '.pptx'),
      }
    },
  }
})

import { createBlankPptx, openPptx } from '@genoffice/pptx-engine'
import { registerSlidesIpc, slidesIsDirty } from '../src/main/slides-main'
import { sessions, type Session } from '../src/main/session-state'
import { dialog } from 'electron'

const WC = 1
const FIT = 1280
const event = { sender: { id: WC } } as never

function call(channel: string, ...args: unknown[]): unknown {
  const fn = handlers.get(channel)
  if (!fn) throw new Error(`handler not registered: ${channel}`)
  return (fn as (...a: unknown[]) => unknown)(event, ...args)
}

let session: Session

/** The real predicate behind the close guard, the 30s autosave tick and the AutoSave poll. */
function dirty(): boolean {
  return slidesIsDirty(WC)
}

beforeAll(() => {
  // registerSlidesIpc is guarded by a module-level flag, so it must run exactly once
  registerSlidesIpc()
})

beforeEach(async () => {
  saveChoice.path = ''
  sessions.clear()
  session = {
    path: '',
    fitWidthPx: FIT,
    undoStack: [],
    redoStack: [],
    opened: await openPptx(await createBlankPptx()),
  }
  sessions.set(WC, session)
})

describe('legacy presentation import and first save', () => {
  it.each(['ppt', 'pps', 'pot'])(
    'opens .%s, edits, cancels, then saves a modern copy',
    async (extension) => {
      const root = await mkdtemp(join(tmpdir(), 'nawa-slides-legacy-'))
      const source = join(root, `source.${extension}`)
      const contents = { id: WC, isDestroyed: () => false, send: vi.fn() }
      const invoke = (channel: string, ...args: unknown[]) => {
        const handler = handlers.get(channel) as (...args: unknown[]) => unknown
        return handler({ sender: contents }, ...args)
      }
      try {
        const fixture =
          extension === 'ppt'
            ? resolve(
                import.meta.dirname,
                '../../../packages/file-parse/tests/fixtures/legacy-sample.ppt',
              )
            : resolve(
                import.meta.dirname,
                '../../../packages/electron-utils/tests/fixtures/legacy-office',
                `legacy-sample.${extension}`,
              )
        await copyFile(fixture, source)
        const original = await readFile(source)
        const opened = (await invoke('slides:open-path', source, FIT)) as {
          path: string
          importedFrom: string
          slides: unknown[]
        }
        expect(opened.path).toBe(source)
        expect(opened.importedFrom).toBe(extension)
        expect(opened.slides.length).toBeGreaterThan(0)
        session = sessions.get(WC)!
        const initialCount = session.opened.deck.slides.length
        invoke('slides:add-blank-slide', { sourceIndex: 0, before: false, fitWidthPx: FIT })
        expect(dirty()).toBe(true)
        await expect(invoke('slides:save')).resolves.toMatchObject({ ok: false })
        expect(session.path).toBe(source)
        expect(dirty()).toBe(true)
        expect(await readFile(source)).toEqual(original)
        const options = vi.mocked(dialog.showSaveDialog).mock.calls.at(-1)![0] as {
          defaultPath: string
          filters: { extensions: string[] }[]
        }
        expect(options.defaultPath).toBe(join(root, 'source.pptx'))
        expect(options.filters[0].extensions).toEqual([
          'pptx',
          'ppsx',
          'potx',
          'pptm',
          'ppsm',
          'potm',
        ])
        saveChoice.path = source
        await expect(invoke('slides:save')).resolves.toMatchObject({
          ok: false,
          error: expect.stringContaining('Save as'),
        })
        expect(await readFile(source)).toEqual(original)
        saveChoice.path = join(root, 'edited.pptx')
        await expect(invoke('slides:save')).resolves.toMatchObject({
          ok: true,
          path: saveChoice.path,
        })
        expect(dirty()).toBe(false)
        const reopened = await openPptx(await readFile(saveChoice.path))
        expect(reopened.deck.slides.length).toBe(initialCount + 1)
        expect(await readFile(source)).toEqual(original)
      } finally {
        sessions.clear()
        await rm(root, { recursive: true, force: true })
      }
    },
    120_000,
  )
})

function firstLayoutPath(): string {
  const r = call('slides:get-layouts') as { layouts: { path: string }[] } | null
  const path = r?.layouts[0]?.path
  if (!path) throw new Error('blank deck exposed no slide layout')
  return path
}

describe('slide lifecycle marks the session dirty', () => {
  it('insertBlankSlide leaves the session dirty', () => {
    expect(dirty()).toBe(false)
    call('slides:add-blank-slide', { sourceIndex: 0, before: false, fitWidthPx: FIT })
    expect(session.opened.deck.slides).toHaveLength(2)
    expect(dirty()).toBe(true)
  })

  it('insertSlideWithLayout leaves the session dirty', () => {
    const layoutPath = firstLayoutPath()
    expect(dirty()).toBe(false)
    call('slides:add-slide-with-layout', { sourceIndex: 0, layoutPath, fitWidthPx: FIT })
    expect(session.opened.deck.slides).toHaveLength(2)
    expect(dirty()).toBe(true)
  })

  it('duplicateSlide leaves the session dirty', () => {
    expect(dirty()).toBe(false)
    call('slides:add-slide', { sourceIndex: 0, fitWidthPx: FIT })
    expect(session.opened.deck.slides).toHaveLength(2)
    expect(dirty()).toBe(true)
  })

  it('pasteSlide leaves the session dirty', () => {
    call('slides:copy-slides', { slideIndexes: [0] })
    expect(dirty()).toBe(false)
    call('slides:paste-slide', { afterIndex: 0, fitWidthPx: FIT })
    expect(session.opened.deck.slides).toHaveLength(2)
    expect(dirty()).toBe(true)
  })

  it('deleteSlide leaves the session dirty', () => {
    call('slides:add-blank-slide', { sourceIndex: 0, before: false, fitWidthPx: FIT })
    // the insert above already flagged the session; a clean deck proves the delete is what flags it
    session.metaDirty = false
    expect(dirty()).toBe(false)
    call('slides:delete-slide', 0)
    expect(session.opened.deck.slides).toHaveLength(1)
    expect(dirty()).toBe(true)
  })
})

describe('directory stage save boundary', () => {
  it('saves the staged deck while denying redirected saves and native exports', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'nawa-slides-stage-'))
    const output = join(dir, 'output.pptx')
    const contents = { id: WC }
    registerDirectoryStage(contents, output)
    configureDirectoryStage(contents, 'edit')
    const invoke = (channel: string, ...args: unknown[]) => {
      const handler = handlers.get(channel) as ((...args: unknown[]) => unknown) | undefined
      if (!handler) throw new Error(`handler not registered: ${channel}`)
      return handler({ sender: contents }, ...args)
    }
    try {
      session.path = join(dir, 'unapproved.pptx')
      await expect(invoke('slides:save')).rejects.toThrow('staged output')
      await expect(invoke('slides:save-as', 'elsewhere.pptx')).rejects.toThrow('directory workflow')
      await expect(
        invoke('slides:export-images', { dir, baseName: 'unapproved', pngsBase64: ['aGVsbG8='] }),
      ).rejects.toThrow('directory workflow')

      session.path = output
      await expect(invoke('slides:save')).resolves.toMatchObject({ ok: true, path: output })
      expect((await readFile(output)).subarray(0, 2).toString()).toBe('PK')
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })
})
