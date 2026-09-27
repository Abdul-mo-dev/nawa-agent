import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { mkdtemp, writeFile, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { DirectoryActionManager, type ActionDependencies } from '../src/main/directory-actions/manager'
import { hashFile } from '../src/main/directory-actions/file-safety'
import type { MyAgentSource, MyAgentToolResponse } from '../src/shared/myagent-tools-api'

let root: string, file: string, run: string, manager: DirectoryActionManager, deps: ActionDependencies, source: MyAgentSource
const bridge = vi.fn<ActionDependencies['myAgentTools'] extends infer T ? NonNullable<T> : never>()
const catalog = (): MyAgentToolResponse => ({ available: true, tools: [{ name: 'text_read_lines', description: 'Read', inputSchema: {} }], sources: [], files: [{ path: file, documentId: source.documentId, status: 'ready' }], warnings: [], total: 1, nextOffset: null })
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'nawa-tool-scope-')); file = join(root, 'report.txt'); await writeFile(file, 'saved evidence')
  source = { path: file, server: 'http://localhost:5187', documentId: 'doc', contentHash: await hashFile(file), indexRevision: 'v1', datasetRevision: null }
  bridge.mockReset(); bridge.mockImplementation(async (_paths, _session, action) => action === 'execute'
    ? { sources: [source], tool: 'text_read_lines', succeeded: true, content: 'saved evidence', error: null, warnings: [] } : catalog())
  deps = { roots: async () => [root], stateDirectory: root, myAgentTools: bridge, blank: vi.fn(), open: vi.fn(), assertClosed: vi.fn(), trash: vi.fn(), extract: vi.fn(), changed: vi.fn() }
  manager = new DirectoryActionManager(deps); run = await manager.begin(1, { opened: root, files: [file], directories: [] })
})
afterEach(async () => { await manager.cancelOwner(1); await rm(root, { recursive: true, force: true }) })

it('requires discovery, freezes individual selection, and verifies sources before answering', async () => {
  await expect(manager.myAgentTools(1, run, 'execute', { tool: 'text_read_lines', arguments: {} })).rejects.toThrow('Discover')
  expect(bridge).not.toHaveBeenCalled()
  await manager.myAgentTools(1, run, 'catalog', { scope: 'selected' })
  await manager.myAgentTools(1, run, 'execute', { tool: 'text_read_lines', arguments: { documentId: 'doc' } })
  expect(bridge.mock.calls.every(([paths, session]) => paths.length === 1 && paths[0] === file && session === run)).toBe(true)
  await manager.verifySources(1, run)
  expect(bridge.mock.calls.at(-1)?.[2]).toBe('verify')
  await writeFile(file, 'edited after evidence')
  await expect(manager.verifySources(1, run)).rejects.toThrow('source changed')
  expect(deps.open).not.toHaveBeenCalled(); expect(deps.trash).not.toHaveBeenCalled()
})
it('rejects other windows, unadvertised tools, out-of-scope sources and revision mixing', async () => {
  await expect(manager.myAgentTools(2, run, 'catalog', { scope: 'selected' })).rejects.toThrow('expired')
  await manager.myAgentTools(1, run, 'catalog', { scope: 'selected' })
  await expect(manager.myAgentTools(1, run, 'execute', { tool: 'shell_execute', arguments: {} })).rejects.toThrow('Discover')
  await manager.myAgentTools(1, run, 'execute', { tool: 'text_read_lines', arguments: {} })
  source = { ...source, indexRevision: 'v2' }
  await manager.myAgentTools(1, run, 'catalog', { scope: 'selected' })
  await expect(manager.myAgentTools(1, run, 'execute', { tool: 'text_read_lines', arguments: {} })).rejects.toThrow('revisions changed')
  source = { ...source, path: join(root, 'unselected.txt') }
  await expect(manager.myAgentTools(1, run, 'execute', { tool: 'text_read_lines', arguments: {} })).rejects.toThrow('unselected')
})
it('revokes in-flight results when selection changes or the request is cancelled', async () => {
  bridge.mockImplementationOnce(async () => { await manager.begin(1, { opened: root, files: [], directories: [root] }); return catalog() })
  await expect(manager.myAgentTools(1, run, 'catalog', { scope: 'selected' })).rejects.toThrow('expired')
  expect(bridge.mock.calls[0][4].aborted).toBe(true)
})
it('retires obsolete MyAgent evidence after an approved file change so the successful action can be reported', async () => {
  await manager.myAgentTools(1, run, 'catalog', { scope: 'selected' })
  await manager.myAgentTools(1, run, 'execute', { tool: 'text_read_lines', arguments: {} })
  deps.trash = async path => { await rm(path) }
  const proposal = await manager.propose(1, run, { operation: 'delete', path: file, instruction: 'Delete the selected temporary fixture' })
  await manager.prepare(1, proposal.id)
  expect(await manager.commit(1, proposal.id)).toMatchObject({ path: file, operation: 'delete' })
  bridge.mockClear()
  await manager.verifySources(1, run)
  expect(bridge).not.toHaveBeenCalled()
  await expect(manager.myAgentTools(1, run, 'execute', { tool: 'text_read_lines', arguments: {} })).rejects.toThrow('Discover')
})
it('metadata discovery passes no file scope, adds no file evidence and names alone do not enable invocation', async () => {
  await rm(file)
  bridge.mockResolvedValueOnce({ available: true, tools: [], names: ['text_read_lines'], sources: [], total: 1, nextOffset: null, scopeChecked: false, warnings: [] })
  const result = await manager.myAgentTools(1, run, 'catalog', { namesOnly: true })
  expect(result).toMatchObject({ names: ['text_read_lines'], sources: [] })
  expect(bridge.mock.calls[0][0]).toEqual([])
  await manager.verifySources(1, run)
  expect(bridge).toHaveBeenCalledOnce()
  await expect(manager.myAgentTools(1, run, 'execute', { tool: 'text_read_lines', arguments: {} })).rejects.toThrow('Discover')
})
it('metadata discovery does not run existing evidence checks or accept file data', async () => {
  await manager.myAgentTools(1, run, 'catalog', { scope: 'selected' })
  await manager.myAgentTools(1, run, 'execute', { tool: 'text_read_lines', arguments: {} })
  await writeFile(file, 'changed')
  bridge.mockClear()
  bridge.mockResolvedValueOnce({ ...catalog(), sources: [], scopeChecked: false })
  await manager.myAgentTools(1, run, 'catalog', {})
  expect(bridge).toHaveBeenCalledOnce()
  // Previously read content still cannot be reused after a change.
  await expect(manager.verifySources(1, run)).rejects.toThrow('source changed')
  bridge.mockResolvedValueOnce({ ...catalog(), sources: [source] })
  await expect(manager.myAgentTools(1, run, 'catalog', {})).rejects.toThrow('must not contain file evidence')
})

it('selected discovery never pins unused files as evidence', async () => {
  await manager.myAgentTools(1, run, 'catalog', { scope: 'selected' })
  await writeFile(file, 'changed after metadata')
  bridge.mockClear()
  await manager.verifySources(1, run)
  expect(bridge).not.toHaveBeenCalled()
})

it('retains evidence from every targeted subset, including tools advertised by the initial bundle', async () => {
  const other = join(root, 'other.txt'); await writeFile(other, 'second source')
  const second = { ...source, path: other, documentId: 'second', contentHash: await hashFile(other) }
  run = await manager.begin(1, { opened: root, files: [file, other], directories: [] })
  const metadata = { ...catalog(), tools: [], initialTools: [{ name: 'text_read_lines', description: 'Read', inputSchema: {} }] }
  bridge.mockImplementation(async (_paths, _session, action, payload) => action === 'execute'
    ? { sources: [(payload as { paths: string[] }).paths[0] === file ? source : second], tool: 'text_read_lines', succeeded: true, content: 'evidence', error: null, warnings: [] }
    : metadata)
  await manager.myAgentTools(1, run, 'catalog', { scope: 'selected', initial: true })
  for (const path of [file, other]) await manager.myAgentTools(1, run, 'execute', { tool: 'text_read_lines', arguments: {}, paths: [path] })
  await manager.verifySources(1, run)
  expect(bridge.mock.calls.at(-1)?.[0]).toEqual([file, other])
  expect(bridge.mock.calls.at(-1)?.[3]).toMatchObject({ sources: [source, second] })
  await writeFile(file, 'first source changed')
  await expect(manager.verifySources(1, run)).rejects.toThrow('source changed')
})
