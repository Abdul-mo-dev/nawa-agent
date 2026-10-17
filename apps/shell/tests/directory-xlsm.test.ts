import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { DIRECTORY_PROTOCOL_VERSION } from '@genoffice/agent-core'
import {
  DirectoryActionManager,
  type ActionDependencies,
} from '../src/main/directory-actions/manager'

let root: string
let file: string
let original: Buffer
let manager: DirectoryActionManager
let deps: ActionDependencies
let run: string

beforeEach(async () => {
  await mkdir(resolve('../../.task'), { recursive: true })
  root = await mkdtemp(join(resolve('../../.task'), 'directory-xlsm-'))
  file = join(root, 'macro.xlsm')
  original = await readFile(resolve('../../test-files/xlsm-chat/sample.xlsm'))
  await writeFile(file, original)
  deps = {
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
      summary: 'Workbook checked',
      warnings: [],
      images: [],
    })),
    review: vi.fn(async () => ({
      format: 'xlsm',
      complete: true,
      changed: 1,
      entries: [],
      warnings: [],
    })),
    open: vi.fn(async (path) => ({
      describe: async (mode = 'edit') => ({
        kind: 'sheets',
        mode,
        protocolVersion: DIRECTORY_PROTOCOL_VERSION,
        capabilities: { lifecycle: true },
        systemPrompt: 'Use the native workbook tools.',
        context: 'Active sheet: Sheet1 (id=sheet1)',
        tools: ['get_workbook_context', 'propose_operations'].map((name) => ({
          name,
          description: name,
          inputSchema: { type: 'object' },
        })),
      }),
      verify: async () => null,
      execute: async (call) => {
        if (call.name === 'propose_operations') await writeFile(path, 'Edited staged XLSM')
        return {
          output: 'Workbook tool completed',
          summary: 'Workbook tool completed',
          mutated: call.name === 'propose_operations',
        }
      },
      save: async () => {},
      close: async () => {},
    })),
  }
  manager = new DirectoryActionManager(deps)
  run = await manager.begin(1, { opened: null, files: [file], directories: [] })
})

afterEach(async () => {
  await manager.cancelOwner(1)
  await rm(root, { recursive: true, force: true })
})

it('updates a selected XLSM through the Sheets editor after review and keeps a backup', async () => {
  const inspection = await manager.inspections.open(1, run, file)
  expect(inspection.kind).toBe('sheets')
  expect(inspection.mode).toBe('read')
  expect(inspection.tools.some((tool) => tool.name === 'propose_operations')).toBe(false)
  await manager.inspections.close(1, run, inspection.id)
  const quality = await manager.validateFile(1, run, file)
  expect(quality.checked).toBe(true)
  expect(vi.mocked(deps.quality!).mock.calls[0][0]).toMatch(/\.xlsm$/)
  const proposal = await manager.propose(1, run, {
    operation: 'update',
    path: file,
    instruction: 'Edit cell A1',
  })
  expect(proposal.operation).toBe('update')
  expect(proposal.path).toBe(file)
  expect(proposal.sourcePath).toBeUndefined()
  const description = await manager.prepare(1, proposal.id)
  expect(description?.kind).toBe('sheets')
  expect(vi.mocked(deps.open).mock.calls.at(-1)?.[0]).toMatch(/\.xlsm$/)
  await manager.execute(1, proposal.id, {
    id: 'edit',
    name: 'propose_operations',
    input: {},
  })
  const preview = await manager.preview(1, proposal.id)
  expect(preview.operation).toBe('update')
  expect(preview.afterText).toBe('Edited staged XLSM')
  expect(preview.review?.complete).toBe(true)
  expect(await readFile(file)).toEqual(original)
  const receipt = await manager.commit(1, proposal.id)
  expect(receipt.operation).toBe('update')
  expect(receipt.path).toBe(file)
  expect(receipt.backupPath).toBeTruthy()
  expect(await readFile(receipt.backupPath!)).toEqual(original)
  expect(await readFile(file, 'utf8')).toBe('Edited staged XLSM')
  expect(deps.importOffice).not.toHaveBeenCalled()
  expect(deps.importWorkbook).not.toHaveBeenCalled()
  expect(deps.blank).not.toHaveBeenCalled()
})

it('requires a selected existing XLSM and rejects creation without a source', async () => {
  await expect(
    manager.propose(1, run, {
      operation: 'create',
      path: join(root, 'new.xlsm'),
      instruction: 'Create workbook',
    }),
  ).rejects.toThrow(/DOCM\/XLSM require existing files/)
  await expect(
    manager.propose(1, run, {
      operation: 'update',
      path: join(root, 'unselected.xlsm'),
      instruction: 'Edit workbook',
    }),
  ).rejects.toThrow('not explicitly selected')
  expect(await readFile(file)).toEqual(original)
})

it('refuses to save when the XLSM source changes after review', async () => {
  const proposal = await manager.propose(1, run, {
    operation: 'update',
    path: file,
    instruction: 'Edit cell A1',
  })
  await manager.prepare(1, proposal.id)
  await manager.execute(1, proposal.id, {
    id: 'edit',
    name: 'propose_operations',
    input: {},
  })
  await manager.preview(1, proposal.id)
  await writeFile(file, 'Changed outside Nawa')
  await expect(manager.commit(1, proposal.id)).rejects.toThrow('changed')
  expect(await readFile(file, 'utf8')).toBe('Changed outside Nawa')
})
