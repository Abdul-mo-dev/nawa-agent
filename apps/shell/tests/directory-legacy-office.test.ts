import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { mkdtemp, mkdir, readFile, writeFile, rm } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { dirname, extname, join, resolve } from 'node:path'
import JSZip from 'jszip'
import { DIRECTORY_PROTOCOL_VERSION, type AgentTransport } from '@genoffice/agent-core'
import {
  OFFICE_IMPORT_EXTENSIONS,
  legacyOfficeTarget,
  officeImportTarget,
  modernOfficePath,
} from '@genoffice/file-formats'
import {
  DirectoryActionManager,
  type ActionDependencies,
} from '../src/main/directory-actions/manager'
import {
  ApprovalController,
  DirectoryActionClient,
} from '../src/renderer/src/directory-actions/controller'
import { actionClaimCorrection } from '../src/renderer/src/directory-actions/evidence'
import {
  fileCapabilities,
  SPREADSHEET_COPY_EXTENSIONS,
  MODERN_OFFICE_COPY_EXTENSIONS,
  directoryImportPath,
} from '../src/shared/file-capabilities'
import type { DirectoryActionsApi, DirectoryCommit } from '../src/shared/directory-actions-api'

let root: string,
  file: string,
  manager: DirectoryActionManager,
  deps: ActionDependencies,
  run: string
const original = Buffer.from('binary legacy original')
const instruction = 'Change the first paragraph to Edited through chat.'

beforeEach(async () => {
  // Owned scratch data stays in the workspace; no user Office files are touched.
  await mkdir(resolve('../../.task'), { recursive: true })
  root = await mkdtemp(join(resolve('../../.task'), 'directory-legacy-'))
  file = join(root, 'report.doc')
  await writeFile(file, original)
  deps = {
    roots: async () => [root],
    stateDirectory: root,
    blank: vi.fn(),
    assertClosed: vi.fn(),
    trash: vi.fn(),
    changed: vi.fn(),
    importOffice: vi.fn(async () => Buffer.from('Before conversion baseline')),
    importWorkbook: vi.fn(async () => ({
      bytes: Buffer.from('Before conversion baseline'),
      warnings: [
        'Workbook import: 2 formulas retained as cached values; 1 sheet had unreadable formulas.',
      ],
    })),
    extract: (path) => readFile(path, 'utf8'),
    review: vi.fn(async (before, after) => ({
      format: extname(after),
      complete: true,
      changed: 1,
      entries: [
        {
          location: 'First paragraph',
          kind: 'text',
          before: before ? await readFile(before, 'utf8') : undefined,
          after: await readFile(after, 'utf8'),
        },
      ],
      warnings: [],
    })),
    quality: vi.fn(async () => ({
      checked: true,
      summary: 'Native check',
      warnings: [],
      images: [],
    })),
    open: vi.fn(async (path) => {
      const kind =
        extname(path) === '.docx'
          ? 'docs'
          : ['.xlsx', '.xlsm'].includes(extname(path))
            ? 'sheets'
            : 'slides'
      const read =
        kind === 'docs'
          ? 'get_document_context'
          : kind === 'sheets'
            ? 'get_workbook_context'
            : 'read_slide'
      const edit =
        kind === 'docs' ? 'replace_blocks' : kind === 'sheets' ? 'propose_operations' : 'apply_ops'
      return {
        describe: async (mode = 'edit') => ({
          kind,
          mode,
          protocolVersion: DIRECTORY_PROTOCOL_VERSION,
          capabilities: { lifecycle: true },
          systemPrompt: 'Edit using the native tool.',
          context: 'First paragraph',
          tools: [read, edit].map((name) => ({
            name,
            description: name,
            inputSchema: { type: 'object' },
          })),
        }),
        verify: async () => null,
        execute: async (call) => {
          if (call.name === edit) await writeFile(path, 'Edited through chat.')
          return {
            output: await readFile(path, 'utf8'),
            summary: 'Native tool completed',
            mutated: call.name === edit,
          }
        },
        save: vi.fn(async () => {}),
        close: vi.fn(async () => {}),
      }
    }),
  }
  manager = new DirectoryActionManager(deps)
  // Selecting the legacy file alone authorizes its reviewed modern sibling.
  run = await manager.begin(1, { opened: null, files: [file], directories: [] })
})
afterEach(async () => {
  await manager.cancelOwner(1)
  await rm(root, { recursive: true, force: true })
})

async function select(extension: string) {
  file = join(root, `report.${extension}`)
  await writeFile(file, original)
  run = await manager.begin(1, { opened: null, files: [file], directories: [] })
}
async function selectModern(extension: string) {
  file = join(root, `report.${extension}`)
  await writeFile(
    file,
    await readFile(
      resolve(
        extension === 'xltm' ? '../../test-files/xltm-chat' : '../../test-files/modern-office-chat',
        `sample.${extension}`,
      ),
    ),
  )
  run = await manager.begin(1, { opened: null, files: [file], directories: [] })
}
async function prepared() {
  const proposal = await manager.propose(1, run, { operation: 'update', path: file, instruction })
  const description = await manager.prepare(1, proposal.id)
  return { proposal, description }
}
async function edited() {
  const { proposal, description } = await prepared()
  await manager.execute(1, proposal.id, {
    id: 'edit',
    name:
      description!.kind === 'docs'
        ? 'replace_blocks'
        : description!.kind === 'sheets'
          ? 'propose_operations'
          : 'apply_ops',
    input: {},
  })
  return manager.preview(1, proposal.id)
}

it.each(OFFICE_IMPORT_EXTENSIONS)(
  'stages %s chat edits as a new modern copy with a converted before/after review',
  async (extension) => {
    await select(extension)
    expect(fileCapabilities(file)).toMatchObject({
      inspection: true,
      editing: true,
      legacy: legacyOfficeTarget(file) !== undefined,
      editOutput: officeImportTarget(file),
    })
    const preview = await edited()
    expect(preview).toMatchObject({
      operation: 'create',
      path: modernOfficePath(file),
      sourcePath: file,
      beforeHash: null,
      beforeText: 'Before conversion baseline',
      afterText: 'Edited through chat.',
    })
    expect(deps.importOffice).toHaveBeenCalledOnce()
    const snapshot = vi.mocked(deps.importOffice!).mock.calls[0][0]
    expect(snapshot).not.toBe(file)
    expect(await readFile(snapshot)).toEqual(original)
    expect(extname(vi.mocked(deps.open).mock.calls[0][0])).toBe(`.${officeImportTarget(file)}`)
    expect(preview.review?.entries[0]).toMatchObject({
      before: preview.beforeText,
      after: preview.afterText,
    })
    expect(preview.review?.warnings.join(' ')).toMatch(/保持不变|stays unchanged|remains unchanged/)
    expect(existsSync(preview.path)).toBe(false)
    const receipt = await manager.commit(1, preview.id)
    expect(receipt).toEqual({ path: preview.path, operation: 'create', sourcePath: file })
    expect(await readFile(receipt.path, 'utf8')).toBe('Edited through chat.')
    expect(await readFile(file)).toEqual(original)
    expect(deps.blank).not.toHaveBeenCalled()
    expect(existsSync(dirname(snapshot))).toBe(false)
  },
)

it.each([
  ...OFFICE_IMPORT_EXTENSIONS,
  ...SPREADSHEET_COPY_EXTENSIONS,
  ...MODERN_OFFICE_COPY_EXTENSIONS,
])('converts %s inspection snapshots and keeps edit tools unavailable', async (extension) => {
  if (MODERN_OFFICE_COPY_EXTENSIONS.some((modern) => modern === extension))
    await selectModern(extension)
  else await select(extension)
  const sourceBytes = await readFile(file)
  const inspection = await manager.inspections.open(1, run, file)
  expect(inspection.path).toBe(file)
  expect(inspection.context).toContain('converted modern copy')
  expect(
    inspection.tools.some((tool) =>
      ['replace_blocks', 'apply_ops', 'propose_operations'].includes(tool.name),
    ),
  ).toBe(false)
  const read =
    inspection.kind === 'docs'
      ? 'get_document_context'
      : inspection.kind === 'sheets'
        ? 'get_workbook_context'
        : 'read_slide'
  expect(
    (
      await manager.inspections.execute(1, run, inspection.id, {
        id: 'read',
        name: read,
        input: {},
      })
    ).mutated,
  ).toBe(false)
  await expect(
    manager.inspections.execute(1, run, inspection.id, {
      id: 'edit',
      name: 'replace_blocks',
      input: {},
    }),
  ).rejects.toThrow('not allowed')
  await manager.inspections.close(1, run, inspection.id)
  expect(await readFile(file)).toEqual(sourceBytes)
  expect(existsSync(directoryImportPath(file))).toBe(false)
})

it.each(SPREADSHEET_COPY_EXTENSIONS)(
  'stages %s workbook edits as a reviewed XLSX copy with import warnings',
  async (extension) => {
    await select(extension)
    expect(fileCapabilities(file)).toMatchObject({
      inspection: true,
      editing: true,
      editOutput: 'xlsx',
    })
    const preview = await edited()
    expect(preview).toMatchObject({
      operation: 'create',
      path: directoryImportPath(file),
      sourcePath: file,
      beforeText: 'Before conversion baseline',
      afterText: 'Edited through chat.',
    })
    expect(deps.importOffice).not.toHaveBeenCalled()
    expect(deps.importWorkbook).toHaveBeenCalledOnce()
    const snapshot = vi.mocked(deps.importWorkbook!).mock.calls[0][0]
    expect(snapshot).not.toBe(file)
    expect(await readFile(snapshot)).toEqual(original)
    expect(preview.review?.warnings).toContain(
      'Workbook import: 2 formulas retained as cached values; 1 sheet had unreadable formulas.',
    )
    expect(preview.review?.entries[0]).toMatchObject({
      before: preview.beforeText,
      after: preview.afterText,
    })
    expect(existsSync(preview.path)).toBe(false)
    expect(await manager.commit(1, preview.id)).toEqual({
      operation: 'create',
      path: preview.path,
      sourcePath: file,
    })
    expect(await readFile(file)).toEqual(original)
    expect(await readFile(preview.path, 'utf8')).toBe('Edited through chat.')
    expect(existsSync(dirname(snapshot))).toBe(false)
  },
)

it.each(MODERN_OFFICE_COPY_EXTENSIONS)(
  'normalizes %s package type in a private copy and preserves the source on chat save',
  async (extension) => {
    await selectModern(extension)
    const sourceBytes = await readFile(file)
    let stageBytes: Buffer | undefined
    const baseOpen = deps.open
    deps.open = vi.fn(async (path) => {
      stageBytes = await readFile(path)
      return baseOpen(path)
    })
    const preview = await edited()
    const target =
      extension === 'dotx'
        ? 'docx'
        : extension === 'xltx'
          ? 'xlsx'
          : extension === 'xltm'
            ? 'xlsm'
            : 'pptx'
    expect(fileCapabilities(file)).toMatchObject({
      inspection: true,
      editing: true,
      editOutput: target,
      legacy: false,
    })
    expect(preview).toMatchObject({
      operation: 'create',
      path: directoryImportPath(file),
      sourcePath: file,
      beforeHash: null,
      afterText: 'Edited through chat.',
    })
    expect(preview.review?.warnings.join(' ')).toContain(`.${extension}`)
    expect(deps.importOffice).not.toHaveBeenCalled()
    expect(deps.importWorkbook).not.toHaveBeenCalled()
    const stage = await JSZip.loadAsync(stageBytes!)
    const types = await stage.file('[Content_Types].xml')!.async('string')
    expect(types).toContain(
      target === 'xlsm'
        ? 'ms-excel.sheet.macroEnabled.main+xml'
        : `${target === 'docx' ? 'wordprocessingml.document' : target === 'xlsx' ? 'spreadsheetml.sheet' : 'presentationml.presentation'}.main+xml`,
    )
    if (extension === 'xltm') {
      const source = await JSZip.loadAsync(sourceBytes)
      expect(await stage.file('xl/vbaProject.bin')!.async('nodebuffer')).toEqual(
        await source.file('xl/vbaProject.bin')!.async('nodebuffer'),
      )
    }
    expect(await readFile(file)).toEqual(sourceBytes)
    expect(existsSync(preview.path)).toBe(false)
    const receipt = await manager.commit(1, preview.id)
    expect(receipt).toEqual({ path: preview.path, operation: 'create', sourcePath: file })
    expect(await readFile(receipt.path, 'utf8')).toBe('Edited through chat.')
    expect(await readFile(file)).toEqual(sourceBytes)
  },
)

it.each(MODERN_OFFICE_COPY_EXTENSIONS)(
  'validates %s through a private regular-format package',
  async (extension) => {
    await selectModern(extension)
    const sourceBytes = await readFile(file)
    const result = await manager.validateFile(1, run, file)
    const target =
      extension === 'dotx'
        ? 'docx'
        : extension === 'xltx'
          ? 'xlsx'
          : extension === 'xltm'
            ? 'xlsm'
            : 'pptx'
    expect(extname(vi.mocked(deps.quality!).mock.calls[0][0])).toBe(`.${target}`)
    expect(result.warnings.join(' ')).toContain(`.${extension}`)
    expect(await readFile(file)).toEqual(sourceBytes)
    expect(existsSync(directoryImportPath(file))).toBe(false)
  },
)

it('rejects a damaged template package before opening a native editor', async () => {
  await select('dotx')
  await expect(prepared()).rejects.toThrow('zip:')
  expect(deps.open).not.toHaveBeenCalled()
  expect(existsSync(directoryImportPath(file))).toBe(false)
  expect(await readFile(file)).toEqual(original)
})

it('rejects a source changed during workbook conversion', async () => {
  await select('ods')
  deps.importWorkbook = vi.fn(async () => {
    await writeFile(file, 'Changed during workbook conversion')
    return { bytes: Buffer.from('converted'), warnings: [] }
  })
  await expect(prepared()).rejects.toThrow('source changed')
  expect(deps.open).not.toHaveBeenCalled()
  expect(existsSync(directoryImportPath(file))).toBe(false)
})

it('cancels an in-flight workbook conversion without opening or publishing its result', async () => {
  await select('csv')
  let finish!: (value: { bytes: Buffer; warnings: string[] }) => void
  deps.importWorkbook = vi.fn(
    () =>
      new Promise((resolve) => {
        finish = resolve
      }),
  )
  const proposal = await manager.propose(1, run, { operation: 'update', path: file, instruction })
  const preparation = expect(manager.prepare(1, proposal.id)).rejects.toThrow('no longer active')
  await vi.waitFor(() => expect(deps.importWorkbook).toHaveBeenCalledOnce())
  await manager.discard(1, proposal.id)
  finish({ bytes: Buffer.from('converted'), warnings: [] })
  await preparation
  expect(deps.open).not.toHaveBeenCalled()
  expect(existsSync(directoryImportPath(file))).toBe(false)
  expect(await readFile(file)).toEqual(original)
})

it('retains native spreadsheet validation warnings after converting the private snapshot', async () => {
  await select('xlsb')
  const result = await manager.validateFile(1, run, file)
  expect(extname(vi.mocked(deps.quality!).mock.calls[0][0])).toBe('.xlsx')
  expect(result.warnings[0]).toContain('2 formulas')
  expect(await readFile(file)).toEqual(original)
})

it('preserves existing modern siblings and proposes a unique edited filename', async () => {
  await writeFile(modernOfficePath(file), 'Existing modern sibling')
  await writeFile(join(root, 'report-edited.docx'), 'Existing edited sibling')
  const preview = await edited()
  expect(preview.path).toBe(join(root, 'report-edited-2.docx'))
  await manager.commit(1, preview.id)
  expect(await readFile(modernOfficePath(file), 'utf8')).toBe('Existing modern sibling')
  expect(await readFile(join(root, 'report-edited.docx'), 'utf8')).toBe('Existing edited sibling')
})
it('refuses a destination that appears after preview', async () => {
  const preview = await edited()
  await writeFile(preview.path, 'Concurrent file')
  await expect(manager.commit(1, preview.id)).rejects.toThrow('already exists')
  expect(await readFile(preview.path, 'utf8')).toBe('Concurrent file')
  expect(await readFile(file)).toEqual(original)
})
it.each(['before preparation', 'before commit'])(
  'refuses changed source bytes %s',
  async (when) => {
    if (when === 'before preparation') {
      const proposal = await manager.propose(1, run, {
        operation: 'update',
        path: file,
        instruction,
      })
      await writeFile(file, 'Changed by another process')
      await expect(manager.prepare(1, proposal.id)).rejects.toThrow('source changed')
    } else {
      const preview = await edited()
      await writeFile(file, 'Changed by another process')
      await expect(manager.commit(1, preview.id)).rejects.toThrow('source changed')
    }
    expect(existsSync(modernOfficePath(file))).toBe(false)
  },
)
it('rejects a source change during import before opening any native editor', async () => {
  deps.importOffice = vi.fn(async () => {
    await writeFile(file, 'Changed during conversion')
    return Buffer.from('converted')
  })
  await expect(prepared()).rejects.toThrow('source changed')
  expect(deps.open).not.toHaveBeenCalled()
  expect(existsSync(modernOfficePath(file))).toBe(false)
})
it('discards converted edits without publishing either file', async () => {
  const preview = await edited()
  const stage = vi.mocked(deps.open).mock.calls[0][0]
  await manager.discard(1, preview.id)
  expect(existsSync(stage)).toBe(false)
  expect(existsSync(preview.path)).toBe(false)
  expect(await readFile(file)).toEqual(original)
})
it('surfaces converter failures without opening or publishing a file', async () => {
  deps.importOffice = vi.fn(async () => {
    throw new Error('Install LibreOffice to import legacy Office files.')
  })
  await expect(prepared()).rejects.toThrow('Install LibreOffice')
  expect(deps.open).not.toHaveBeenCalled()
  expect(await readFile(file)).toEqual(original)
  expect(existsSync(modernOfficePath(file))).toBe(false)
})
it('keeps selected-file authority and rejects forged destinations or binary creation', async () => {
  const other = join(root, 'unselected.doc')
  await writeFile(other, original)
  await expect(
    manager.propose(1, run, { operation: 'update', path: other, instruction }),
  ).rejects.toThrow('not explicitly selected')
  await expect(
    manager.propose(1, run, {
      operation: 'update',
      path: file,
      instruction,
      destination: join(root, 'forged.docx'),
    }),
  ).rejects.toThrow('Unexpected')
  await expect(
    manager.propose(1, run, { operation: 'create', path: join(root, 'new.doc'), instruction }),
  ).rejects.toThrow('copy-only')
})
it('runs native validation on a converted private file', async () => {
  await manager.validateFile(1, run, file)
  expect(extname(vi.mocked(deps.quality!).mock.calls[0][0])).toBe('.docx')
  expect(await readFile(file)).toEqual(original)
  expect(existsSync(modernOfficePath(file))).toBe(false)
})

it.each(['doc', 'csv'])(
  'runs the %s child chat loop through native edit tools, approvals and a modern-copy receipt',
  async (extension) => {
    await select(extension)
    const editTool = extension === 'csv' ? 'propose_operations' : 'replace_blocks'
    const approvals = new ApprovalController()
    const phases: string[] = []
    approvals.subscribe(() => {
      const view = approvals.getSnapshot()
      if (view) {
        phases.push(view.phase)
        expect(view.proposal.sourcePath).toBe(file)
        expect(view.proposal.path).toBe(directoryImportPath(file))
        queueMicrotask(() => approvals.decide(view.key, true))
      }
    })
    const receipts: DirectoryCommit[] = []
    let turns = 0
    const transport: AgentTransport = {
      stream(request, callbacks) {
        queueMicrotask(() => {
          expect(request.tools.some((tool) => tool.name === editTool)).toBe(true)
          if (turns++ === 0)
            callbacks.onToolCall({
              id: 'chat-edit',
              name: editTool,
              input:
                extension === 'csv'
                  ? {
                      operations: [
                        {
                          op: 'set_cell',
                          sheetId: 'sheet1',
                          address: 'A1',
                          value: 'Edited through chat.',
                        },
                      ],
                      summary: 'Edit cell A1',
                    }
                  : { startBlockIndex: 0, endBlockIndex: 0, html: '<p>Edited through chat.</p>' },
            })
          else callbacks.onDelta('The staged paragraph was edited.')
          callbacks.onDone()
        })
        return { cancel() {} }
      },
    }
    const api = {
      begin: (scope) => manager.begin(1, scope),
      propose: (id, request) => manager.propose(1, id, request),
      prepare: (id, context) => manager.prepare(1, id, context),
      execute: (id, call) => manager.execute(1, id, call),
      verify: (id, text) => manager.verify(1, id, text),
      preview: (id) => manager.preview(1, id),
      commit: (id) => manager.commit(1, id),
      discard: (id) => manager.discard(1, id),
      cancel: (id) => manager.cancel(1, id),
      validateEvidence: (id) => manager.validateEvidence(1, id),
      pollWorkflow: vi.fn(async () => {
        throw new Error('No native generation workflow')
      }),
    } satisfies Partial<DirectoryActionsApi>
    const client = new DirectoryActionClient({
      api: api as DirectoryActionsApi,
      selection: { opened: null, files: [file], directories: [] },
      approvals,
      transport: () => transport,
      current: () => true,
      activity: vi.fn(),
      committed: (receipt) => receipts.push(receipt),
    })
    const request = { operation: 'update' as const, path: file, instruction }
    const result = JSON.parse(await client.perform(request))
    expect(result).toMatchObject({
      status: 'committed',
      operation: 'create',
      path: directoryImportPath(file),
      sourcePath: file,
    })
    expect(phases).toEqual(['prepare', 'save'])
    expect(turns).toBe(2)
    expect(await readFile(file)).toEqual(original)
    expect(await readFile(result.path, 'utf8')).toBe('Edited through chat.')
    expect(
      actionClaimCorrection(
        `I created report.${extension === 'csv' ? 'xlsx' : 'docx'} from report.${extension}.`,
        receipts,
        [file],
      ),
    ).toBeNull()
    expect(actionClaimCorrection(`I updated report.${extension}.`, receipts, [file])).toContain(
      'No file commit',
    )
    // An explicit continuation reuses the exact prior receipt rather than producing another copy.
    const resumed = new DirectoryActionClient({
      api: api as DirectoryActionsApi,
      selection: { opened: null, files: [file], directories: [] },
      approvals,
      transport: () => transport,
      current: () => true,
      activity: vi.fn(),
      committed: vi.fn(),
      previousActions: receipts,
    })
    expect(JSON.parse(await resumed.perform(request))).toMatchObject({
      reused: true,
      historical: true,
      path: result.path,
    })
    expect(turns).toBe(2)
  },
)
