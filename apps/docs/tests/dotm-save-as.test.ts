// @vitest-environment node
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { buildBlankDocx } from '@genoffice/docx-engine'
import JSZip from 'jszip'

const state = vi.hoisted(() => ({
  root: '',
  savePath: '',
  handlers: new Map<string, (...args: unknown[]) => unknown>(),
}))
const contents = { id: 813, isDestroyed: () => false, send: vi.fn() }
vi.mock('electron', () => ({
  app: {
    getPath: () => state.root,
    getVersion: () => '0',
    getName: () => 'docs-test',
    whenReady: () => Promise.resolve(),
    on: () => {},
  },
  ipcMain: {
    handle: (key: string, handler: (...args: unknown[]) => unknown) =>
      state.handlers.set(key, handler),
    on: () => {},
    removeHandler: () => {},
  },
  dialog: {
    showSaveDialog: vi.fn(async () => ({ canceled: !state.savePath, filePath: state.savePath })),
    showMessageBox: async () => ({ response: 0 }),
  },
  BrowserWindow: class {
    static getFocusedWindow() {
      return null
    }
    static fromWebContents() {
      return null
    }
  },
  webContents: { fromId: () => contents, getAllWebContents: () => [] },
  protocol: { isProtocolHandled: () => true },
  session: { defaultSession: { removeWordFromSpellCheckerDictionary: () => {} } },
  net: {},
  clipboard: {},
  shell: {},
  nativeImage: {},
  safeStorage: {},
  WebContentsView: class {},
  Menu: { buildFromTemplate: () => ({}), setApplicationMenu: () => {} },
}))

import { readWorkspaceFileText, registerDocsIpc } from '../src/main/docs-main'
import { dialog } from 'electron'

beforeAll(async () => {
  state.root = await mkdtemp(join(tmpdir(), 'nawa-docs-dotm-'))
  registerDocsIpc()
})
afterAll(async () => {
  await rm(state.root, { recursive: true, force: true })
})
function invoke(channel: string, ...args: unknown[]) {
  const handler = state.handlers.get(channel)
  if (!handler) throw new Error(`Missing handler: ${channel}`)
  return handler({ sender: contents }, ...args)
}
async function docxData(): Promise<ArrayBuffer> {
  const bytes = await buildBlankDocx()
  return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer
}
function lastFilters(): { extensions: string[] }[] {
  const options = vi.mocked(dialog.showSaveDialog).mock.calls.at(-1)![0] as {
    filters: { extensions: string[] }[]
  }
  return options.filters
}

describe('Docs Save As macro-template fallback', () => {
  it.each(['docm', 'dotm', 'pptm', 'ppsm', 'potm'])(
    'extracts .%s for the folder-chat preview',
    async (extension) => {
      const result = await readWorkspaceFileText(
        resolve(`../../test-files/macro-office-chat/sample.${extension}`),
        12000,
      )
      expect(result.ok, result.error).toBe(true)
      expect(result.text).toContain('Nawa Legacy Office Test')
    },
  )

  it('saves an existing nonstandard main-part path through the Save As handler', async () => {
    const zip = await JSZip.loadAsync(await buildBlankDocx())
    zip.file('word/trial.xml', await zip.file('word/document.xml')!.async('nodebuffer'))
    zip.remove('word/document.xml')
    for (const name of ['_rels/.rels', '[Content_Types].xml'])
      zip.file(
        name,
        (await zip.file(name)!.async('string')).replaceAll('word/document.xml', 'word/trial.xml'),
      )
    const bytes = await zip.generateAsync({ type: 'nodebuffer' })
    const data = bytes.buffer.slice(
      bytes.byteOffset,
      bytes.byteOffset + bytes.byteLength,
    ) as ArrayBuffer
    state.savePath = join(state.root, 'relocated.dotx')
    const result = (await invoke(
      'docs:save-as',
      'relocated.docx',
      data,
      join(state.root, 'relocated.docx'),
    )) as { ok: boolean; path: string }
    expect(result.ok).toBe(true)
    const saved = await JSZip.loadAsync(await readFile(result.path))
    expect(saved.file('word/trial.xml')).not.toBeNull()
    expect(await saved.file('[Content_Types].xml')!.async('string')).toContain(
      'wordprocessingml.template.main+xml',
    )
  })

  it('keeps a dotm source in dotm when the dialog returns a bare name', async () => {
    const source = join(state.root, 'template.dotm')
    const data = await docxData()
    state.savePath = join(state.root, 'bare-name')
    const result = (await invoke('docs:save-as', 'template.dotm', data, source)) as {
      ok: boolean
      path: string
    }
    expect(lastFilters()[0].extensions).toEqual(['dotm'])
    expect(result.ok).toBe(true)
    expect(result.path).toMatch(/\.dotm$/)
    const zip = await JSZip.loadAsync(await readFile(result.path))
    const types = await zip.file('[Content_Types].xml')!.async('string')
    expect(types).toContain('application/vnd.ms-word.template.macroEnabled.main+xml')
  })

  it('keeps a docm source in docm when the dialog returns a bare name', async () => {
    const source = join(state.root, 'macro.docm')
    const data = await docxData()
    state.savePath = join(state.root, 'bare-docm')
    const result = (await invoke('docs:save-as', 'macro.docm', data, source)) as {
      ok: boolean
      path: string
    }
    expect(lastFilters()[0].extensions).toEqual(['docm'])
    expect(result.ok).toBe(true)
    expect(result.path).toMatch(/\.docm$/)
  })

  it('offers the full Word list for a regular docx source', async () => {
    const source = join(state.root, 'regular.docx')
    const data = await docxData()
    state.savePath = join(state.root, 'regular-copy.docx')
    const result = (await invoke('docs:save-as', 'regular.docx', data, source)) as {
      ok: boolean
      path: string
    }
    expect(lastFilters()[0].extensions).toEqual(['docx', 'docm', 'dotx', 'dotm'])
    expect(result.ok).toBe(true)
    expect(result.path).toMatch(/\.docx$/)
  })
})
