import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { extname, join, resolve } from 'node:path'
import { DIRECTORY_PROTOCOL_VERSION } from '@genoffice/agent-core'
import {
  DirectoryActionManager,
  type ActionDependencies,
} from '../src/main/directory-actions/manager'
import { fileCapabilities } from '../src/shared/file-capabilities'

let root: string
let docmFile: string
let dotmFile: string
let pptmFile: string
let ppsmFile: string
let potmFile: string
let docmOriginal: Buffer
let pptOriginal: Buffer

function docsDeps(): ActionDependencies {
  return {
    roots: async () => [root],
    stateDirectory: root,
    blank: vi.fn(),
    assertClosed: vi.fn(),
    trash: vi.fn(),
    changed: vi.fn(),
    importOffice: vi.fn(),
    importWorkbook: vi.fn(),
    extract: (path) => readFile(path, 'utf8'),
    quality: vi.fn(async () => ({
      checked: true,
      summary: 'Document checked',
      warnings: [],
      images: [],
    })),
    review: vi.fn(async () => ({
      format: 'macro',
      complete: true,
      changed: 1,
      entries: [],
      warnings: [],
    })),
    open: vi.fn(async (path) => {
      const ext = extname(path).toLowerCase()
      const kind = ext === '.pptm' || ext === '.ppsm' || ext === '.potm' ? 'slides' : 'docs'
      const read = kind === 'slides' ? 'read_slide' : 'get_document_context'
      const edit = kind === 'slides' ? 'apply_ops' : 'replace_blocks'
      return {
        describe: async (mode = 'edit') => ({
          kind,
          mode,
          protocolVersion: DIRECTORY_PROTOCOL_VERSION,
          capabilities: { lifecycle: true },
          systemPrompt: 'Use the native tools.',
          context: 'Macro document',
          tools: [read, edit].map((name) => ({
            name,
            description: name,
            inputSchema: { type: 'object' },
          })),
        }),
        verify: async () => null,
        execute: async (call) => {
          if (call.name === edit) await writeFile(path, 'Edited staged macro')
          return {
            output: 'Tool completed',
            summary: 'Tool completed',
            mutated: call.name === edit,
          }
        },
        save: async () => {},
        close: async () => {},
      }
    }),
  }
}

beforeEach(async () => {
  await mkdir(resolve('../../.task'), { recursive: true })
  root = await mkdtemp(join(resolve('../../.task'), 'directory-macro-'))
  docmOriginal = await readFile(resolve('../../test-files/docm-chat/sample.docm'))
  pptOriginal = await readFile(
    resolve('../../packages/pptx-engine/tests/fixtures/01_standard_business.pptx'),
  )
  docmFile = join(root, 'macro.docm')
  dotmFile = join(root, 'template.dotm')
  pptmFile = join(root, 'deck.pptm')
  ppsmFile = join(root, 'show.ppsm')
  potmFile = join(root, 'theme.potm')
  await writeFile(docmFile, docmOriginal)
  await writeFile(dotmFile, docmOriginal)
  await writeFile(pptmFile, pptOriginal)
  await writeFile(ppsmFile, pptOriginal)
  await writeFile(potmFile, pptOriginal)
})

afterEach(async () => {
  await rm(root, { recursive: true, force: true })
})

async function roundTrip(file: string, original: Buffer, kind: 'docs' | 'slides') {
  const editTool = kind === 'slides' ? 'apply_ops' : 'replace_blocks'
  const deps = docsDeps()
  const manager = new DirectoryActionManager(deps)
  const run = await manager.begin(1, { opened: null, files: [file], directories: [] })
  try {
    const inspection = await manager.inspections.open(1, run, file)
    expect(inspection.kind).toBe(kind)
    expect(inspection.mode).toBe('read')
    expect(inspection.tools.some((tool) => tool.name === editTool)).toBe(false)
    await manager.inspections.close(1, run, inspection.id)
    const quality = await manager.validateFile(1, run, file)
    expect(quality.checked).toBe(true)
    expect(
      String(vi.mocked(deps.quality!).mock.calls[0][0]).toLowerCase().endsWith(extname(file)),
    ).toBe(true)
    const proposal = await manager.propose(1, run, {
      operation: 'update',
      path: file,
      instruction: 'Edit macro file',
    })
    expect(proposal.operation).toBe('update')
    expect(proposal.path).toBe(file)
    expect(proposal.sourcePath).toBeUndefined()
    const description = await manager.prepare(1, proposal.id)
    expect(description?.kind).toBe(kind)
    expect(
      String(vi.mocked(deps.open).mock.calls.at(-1)?.[0]).toLowerCase().endsWith(extname(file)),
    ).toBe(true)
    await manager.execute(1, proposal.id, { id: 'edit', name: editTool, input: {} })
    const preview = await manager.preview(1, proposal.id)
    expect(preview.operation).toBe('update')
    expect(preview.afterText).toBe('Edited staged macro')
    expect(await readFile(file)).toEqual(original)
    const receipt = await manager.commit(1, proposal.id)
    expect(receipt.operation).toBe('update')
    expect(receipt.path).toBe(file)
    expect(receipt.backupPath).toBeTruthy()
    expect(await readFile(receipt.backupPath!)).toEqual(original)
    expect(await readFile(file, 'utf8')).toBe('Edited staged macro')
    expect(deps.importOffice).not.toHaveBeenCalled()
    expect(deps.importWorkbook).not.toHaveBeenCalled()
    expect(deps.blank).not.toHaveBeenCalled()
  } finally {
    await manager.cancelOwner(1)
  }
}

describe('macro folder-chat in-place edits', () => {
  it('updates a selected DOCM in place with a backup', async () => {
    await roundTrip(docmFile, docmOriginal, 'docs')
  })

  it('updates a selected DOTM in place with a backup', async () => {
    await roundTrip(dotmFile, docmOriginal, 'docs')
  })

  it('updates a selected PPTM in place with a backup', async () => {
    await roundTrip(pptmFile, pptOriginal, 'slides')
  })

  it('accepts PPSM and POTM as native in-place targets', async () => {
    for (const [file, original] of [
      [ppsmFile, pptOriginal],
      [potmFile, pptOriginal],
    ] as const) {
      expect(fileCapabilities(file)).toMatchObject({
        inspection: true,
        editing: true,
        legacy: false,
      })
      expect(fileCapabilities(file).editOutput).toBeUndefined()
      const deps = docsDeps()
      const manager = new DirectoryActionManager(deps)
      const run = await manager.begin(1, { opened: null, files: [file], directories: [] })
      try {
        const proposal = await manager.propose(1, run, {
          operation: 'update',
          path: file,
          instruction: 'Edit show',
        })
        expect(proposal.operation).toBe('update')
        expect(proposal.sourcePath).toBeUndefined()
        await manager.discard(1, proposal.id)
      } finally {
        await manager.cancelOwner(1)
      }
      expect(await readFile(file)).toEqual(original)
    }
  })

  it('blocks blank macro creation and requires explicit selection', async () => {
    const deps = docsDeps()
    const manager = new DirectoryActionManager(deps)
    const run = await manager.begin(1, { opened: null, files: [docmFile], directories: [] })
    try {
      for (const name of ['new.docm', 'new.dotm', 'new.pptm', 'new.ppsm', 'new.potm']) {
        await expect(
          manager.propose(1, run, {
            operation: 'create',
            path: join(root, name),
            instruction: 'Create macro file',
          }),
        ).rejects.toThrow(/DOCM\/XLSM require existing files/)
      }
      await expect(
        manager.propose(1, run, {
          operation: 'update',
          path: join(root, 'unselected.dotm'),
          instruction: 'Edit',
        }),
      ).rejects.toThrow('not explicitly selected')
      expect(await readFile(docmFile)).toEqual(docmOriginal)
    } finally {
      await manager.cancelOwner(1)
    }
  })
})
