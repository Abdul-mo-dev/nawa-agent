// @vitest-environment node
import { copyFile, mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { findLibreOffice } from '@genoffice/electron-utils/legacy-office'
import { parseDocx, saveDocx } from '@genoffice/docx-engine'

const state = vi.hoisted(() => ({
  root: '',
  savePath: '',
  handlers: new Map<string, (...args: unknown[]) => unknown>(),
}))
const contents = { id: 812, isDestroyed: () => false, send: vi.fn() }
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

import { registerDocsIpc } from '../src/main/docs-main'
import { takeHandoff } from '../src/main/byte-handoff'
import { dialog } from 'electron'
const converter = await findLibreOffice()
beforeAll(async () => {
  state.root = await mkdtemp(join(tmpdir(), 'nawa-docs-ipc-'))
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

describe.skipIf(!converter)('Docs legacy import save guards', () => {
  it.each(['doc', 'odt'])(
    'converts .%s, refuses source writes, preserves cancelled edits, and saves a modern file',
    async (extension) => {
      state.savePath = ''
      const source = join(state.root, `source.${extension}`)
      await copyFile(
        extension === 'odt'
          ? resolve(import.meta.dirname, '../../../test-files/opendocument/document-sample.odt')
          : resolve(
              import.meta.dirname,
              '../../../packages/file-parse/tests/fixtures/legacy-sample.doc',
            ),
        source,
      )
      const original = await readFile(source)
      const opened = (await invoke('docs:open-path', source)) as {
        importedFrom: string
        dataUrl: string
      }
      expect(opened.importedFrom).toBe(extension)
      const converted = takeHandoff(opened.dataUrl)!
      const parsed = await parseDocx(converted)
      const bytes = await saveDocx(parsed, [
        ...parsed.blocks.flatMap((block) =>
          block.docxIndex == null
            ? []
            : [{ kind: 'original' as const, docxIndex: block.docxIndex }],
        ),
        { kind: 'xml', xml: '<w:p><w:r><w:t>Saved import edit</w:t></w:r></w:p>' },
      ])
      const data = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength)
      await expect(invoke('docs:save', source, data)).resolves.toMatchObject({
        ok: false,
        error: expect.stringContaining('Save the imported copy'),
      })
      await expect(
        invoke('docs:save-as', `source.${extension}`, data, source),
      ).resolves.toMatchObject({
        ok: false,
      })
      const options = vi.mocked(dialog.showSaveDialog).mock.calls.at(-1)![0] as {
        defaultPath: string
        filters: { extensions: string[] }[]
      }
      expect(options.defaultPath).toBe(join(state.root, 'source.docx'))
      expect(options.filters[0].extensions).toEqual(['docx', 'docm', 'dotx', 'dotm'])
      state.savePath = source
      await expect(
        invoke('docs:save-as', `source.${extension}`, data, source),
      ).resolves.toMatchObject({
        ok: false,
        error: expect.stringContaining('Save as'),
      })
      expect(await readFile(source)).toEqual(original)
      state.savePath = join(state.root, 'edited.docx')
      await expect(
        invoke('docs:save-as', `source.${extension}`, data, source),
      ).resolves.toMatchObject({
        ok: true,
        path: state.savePath,
      })
      const reopened = await parseDocx(await readFile(state.savePath))
      expect(reopened.blocks.length).toBeGreaterThan(parsed.blocks.length)
      expect(await readFile(source)).toEqual(original)
      await expect(invoke('docs:save', state.savePath, data)).resolves.toMatchObject({ ok: true })
    },
    120_000,
  )
})
