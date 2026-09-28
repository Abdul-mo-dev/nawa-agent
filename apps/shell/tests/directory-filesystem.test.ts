import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { mkdtemp, writeFile, readFile, mkdir, rm, readdir, symlink, link, rename } from 'node:fs/promises'
import { existsSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { DirectoryActionManager, type ActionDependencies } from '../src/main/directory-actions/manager'
import { prepareFilesystemAction, commitFilesystemAction } from '../src/main/directory-actions/filesystem-actions'
import { ApprovalController, DirectoryActionClient, directoryMutationSkill } from '../src/renderer/src/directory-actions/controller'
import { filesystemProposal } from '../src/renderer/src/directory-actions/filesystem-tools'
import { actionClaimCorrection } from '../src/renderer/src/directory-actions/evidence'
import { directoryRoute } from '../src/renderer/src/directory-actions/routing'
import { directoryCommitText, type DirectoryProposal, type DirectoryActionsApi } from '../src/shared/directory-actions-api'

let root: string, file: string, folder: string, destination: string, manager: DirectoryActionManager, run: string, deps: ActionDependencies
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'nawa-fs-'))
  file = join(root, 'source.bin'); folder = join(root, 'selected-folder'); destination = join(root, 'destination')
  await writeFile(file, Buffer.from([0, 1, 2, 255])); await mkdir(folder); await mkdir(destination)
  await writeFile(join(folder, 'child.txt'), 'child data')
  deps = { roots: async () => [root], stateDirectory: root, blank: vi.fn(), open: vi.fn(), extract: vi.fn(),
    assertClosed: vi.fn(), trash: vi.fn(async path => { await rename(path, join(root, 'test-trash')) }), changed: vi.fn() }
  manager = new DirectoryActionManager(deps)
  run = await manager.begin(1, { opened: root, files: [file], directories: [folder, destination] })
})
afterEach(async () => { await manager.cancelOwner(1); await rm(root, { recursive: true, force: true }) })
const proposal = (operation: DirectoryProposal['operation'], path = file, destination?: string): DirectoryProposal => ({ operation, path, destination, instruction: 'Requested test action' })
async function approved(request: DirectoryProposal) {
  const item = await manager.propose(1, run, request)
  expect(await manager.prepare(1, item.id)).toBeNull()
  return item
}

it.each(['rename', 'move', 'copy'] as const)('%s preserves arbitrary file bytes without using a document editor', async operation => {
  const target = join(operation === 'rename' ? root : destination, 'new.bin')
  const before = await readFile(file), item = await approved(proposal(operation, file, target))
  expect(item.destination).toBe(target)
  expect(await manager.commit(1, item.id)).toMatchObject({ operation, path: file, destination: target })
  expect(await readFile(target)).toEqual(before)
  expect(existsSync(file)).toBe(operation === 'copy')
  expect(deps.open).not.toHaveBeenCalled(); expect(deps.changed).toHaveBeenCalledWith(target)
  await expect(manager.commit(1, item.id)).rejects.toThrow('no longer active')
})
it('creates exactly one empty folder without native staging', async () => {
  const target = join(destination, 'New folder'), item = await approved(proposal('create-folder', target))
  await manager.commit(1, item.id)
  expect(await readdir(target)).toEqual([]); expect(deps.open).not.toHaveBeenCalled()
})
it('reviews selected folder contents and defaults deletion to the Recycle Bin', async () => {
  const item = await approved(proposal('delete-folder', folder))
  expect(item.inventory).toMatchObject({ files: 1, folders: 1, bytes: 10 })
  expect(item.inventory!.entries).toContain('child.txt')
  await expect(manager.readFile(1, run, join(folder, 'child.txt'))).rejects.toThrow('Select')
  await manager.commit(1, item.id)
  expect(deps.trash).toHaveBeenCalledWith(folder)
  expect(await readFile(join(root, 'test-trash', 'child.txt'), 'utf8')).toBe('child data')
})
it('requires exact typed confirmation in main before permanently deleting a file', async () => {
  const item = await approved(proposal('delete-permanently'))
  for (const value of [undefined, true, 'other.bin']) await expect(manager.commit(1, item.id, value)).rejects.toThrow('exact target name')
  expect(existsSync(file)).toBe(true)
  const receipt = await manager.commit(1, item.id, 'source.bin')
  expect(receipt.permanent).toBe(true); expect(existsSync(file)).toBe(false); expect(deps.trash).not.toHaveBeenCalled()
  expect(directoryCommitText(receipt)).toContain('Permanently deleted')
})
it('permanently removes the approved nested folder inventory with a typed name', async () => {
  await mkdir(join(folder, 'nested')); await writeFile(join(folder, 'nested', 'a.txt'), 'nested')
  const item = await approved({ ...proposal('delete-folder', folder), permanent: true })
  await expect(manager.commit(1, item.id)).rejects.toThrow('exact target name')
  await manager.commit(1, item.id, 'selected-folder')
  expect(existsSync(folder)).toBe(false); expect(existsSync(destination)).toBe(true)
})
it('invalidates prior evidence for deleted folder children and does not grant access to a moved destination', async () => {
  const child = join(folder, 'child.txt')
  run = await manager.begin(1, { opened: root, files: [file, child], directories: [folder, destination] })
  deps.readText = async path => ({ ok: true, text: await readFile(path, 'utf8'), offset: 0, totalChars: 10 })
  await manager.readFile(1, run, child)
  const item = await approved({ ...proposal('delete-folder', folder), permanent: true })
  await manager.commit(1, item.id, 'selected-folder')
  expect((await manager.validateEvidence(1, run)).evidence).toEqual([])
  const target = join(destination, 'moved.bin'), move = await approved(proposal('move', file, target))
  await manager.commit(1, move.id)
  await expect(manager.readFile(1, run, target)).rejects.toThrow('Select')
})
it('cannot commit without approval preparation, after discard, or after selection revocation', async () => {
  const item = await manager.propose(1, run, proposal('copy', file, join(root, 'copy.bin')))
  await expect(manager.commit(1, item.id)).rejects.toThrow('Review')
  await manager.discard(1, item.id)
  await expect(manager.prepare(1, item.id)).rejects.toThrow('no longer active')
  const next = await approved(proposal('delete-permanently'))
  await manager.begin(1, { opened: root, files: [], directories: [] })
  await expect(manager.commit(1, next.id, 'source.bin')).rejects.toThrow()
  expect(existsSync(file)).toBe(true)
})
it('pins main-process permissions to the request snapshot without accepting newly selected paths', async () => {
  const child = join(folder, 'child.txt'), scope = { opened: root, files: [file], directories: [destination] }
  run = await manager.begin(1, scope)
  scope.files.splice(0, 1, child); scope.directories.length = 0
  const target = join(destination, 'copy.bin'), item = await approved(proposal('copy', file, target))
  await manager.commit(1, item.id)
  expect(existsSync(target)).toBe(true)
  await expect(manager.propose(1, run, proposal('delete-permanently', child))).rejects.toThrow('Select')
  run = await manager.begin(1, scope)
  await expect(manager.propose(1, run, proposal('delete-permanently', file))).rejects.toThrow('Select')
})
it('rejects unselected sources, unopened destinations, cross-folder renames and invalid names', async () => {
  await expect(manager.propose(1, run, proposal('copy', join(folder, 'child.txt'), join(root, 'copy.txt')))).rejects.toThrow('Select')
  const unselected = join(root, 'unselected'); await mkdir(unselected)
  await expect(manager.propose(1, run, proposal('move', file, join(unselected, 'copy.bin')))).rejects.toThrow('destination folder')
  await expect(manager.propose(1, run, proposal('rename', file, join(destination, 'copy.bin')))).rejects.toThrow('Rename must stay')
  await expect(manager.propose(1, run, proposal('create-folder', join(root, 'CON')))).rejects.toThrow('valid plain')
  await expect(manager.propose(1, run, proposal('copy', file, file))).rejects.toThrow('must differ')
})
it('never overwrites existing destinations including a collision after approval', async () => {
  await expect(manager.propose(1, run, proposal('create-folder', destination))).rejects.toThrow('already exists')
  const target = join(destination, 'copy.bin'), item = await approved(proposal('copy', file, target))
  await writeFile(target, 'another process')
  await expect(manager.commit(1, item.id)).rejects.toThrow('already exists')
  expect(await readFile(target, 'utf8')).toBe('another process'); expect(existsSync(file)).toBe(true)
})
it('rejects a changed source after approval and an open child in a folder operation', async () => {
  const item = await approved(proposal('move', file, join(destination, 'moved.bin')))
  await writeFile(file, 'changed')
  await expect(manager.commit(1, item.id)).rejects.toThrow('changed after review')
  await manager.discard(1, item.id)
  deps.assertClosed = vi.fn(async path => { if (path.endsWith('child.txt')) throw new Error('File is open') })
  await expect(manager.propose(1, run, proposal('delete-folder', folder))).rejects.toThrow('File is open')
})
it('rejects new or modified folder children after review before any removal', async () => {
  const item = await approved({ ...proposal('delete-folder', folder), permanent: true })
  await writeFile(join(folder, 'new.txt'), 'new data')
  await expect(manager.commit(1, item.id, 'selected-folder')).rejects.toThrow('changed after review')
  expect(await readdir(folder)).toEqual(['child.txt', 'new.txt'])
})
it('protects workspace roots, opened directories and unselected folders', async () => {
  await expect(manager.propose(1, run, proposal('delete-folder', root))).rejects.toThrow('Select')
  run = await manager.begin(1, { opened: folder, files: [], directories: [root, folder] })
  await expect(manager.propose(1, run, proposal('delete-folder', root))).rejects.toThrow('workspace root')
  await expect(manager.propose(1, run, proposal('delete-folder', folder))).rejects.toThrow('opened directory')
})
it('rejects linked folder entries and hardlinked file sources', async () => {
  await symlink(destination, join(folder, 'linked'), process.platform === 'win32' ? 'junction' : 'dir')
  await expect(manager.propose(1, run, proposal('delete-folder', folder))).rejects.toThrow('Linked')
  await link(file, join(root, 'hardlink.bin'))
  await expect(manager.propose(1, run, proposal('delete-permanently'))).rejects.toThrow('Linked')
})
it('reports a partial move if publishing succeeds but the source cannot be removed', async () => {
  const target = join(destination, 'moved.bin'), item = await approved(proposal('move', file, target))
  deps.assertClosed = async () => { if (existsSync(target)) throw new Error('Source became open') }
  const receipt = await manager.commit(1, item.id)
  expect(receipt.status).toBe('partial'); expect(receipt.warnings![0]).toContain('source was not removed')
  expect(await readFile(file)).toEqual(await readFile(target))
  expect(actionClaimCorrection('I moved source.bin.', [receipt], [file])).toContain('No file commit receipt')
})
it('never recursively removes a new child arriving during permanent deletion and reports partial progress', async () => {
  await writeFile(join(folder, 'z.txt'), 'last')
  const request = { ...proposal('delete-folder', folder), permanent: true }
  let deleting = false
  const ctx = { roots: [root], scope: { opened: root, files: [file], directories: [folder] }, assertClosed: async () => {}, check: () => {
    if (deleting && !existsSync(join(folder, 'z.txt'))) writeFileSync(join(folder, 'arrived.txt'), 'must survive')
  } }
  const snapshot = await prepareFilesystemAction(request, ctx); deleting = true
  const receipt = await commitFilesystemAction(request, snapshot, ctx, deps.trash, 'selected-folder')
  expect(receipt.status).toBe('partial'); expect(receipt.warnings![0]).toContain('2 of 3')
  expect(await readFile(join(folder, 'arrived.txt'), 'utf8')).toBe('must survive')
})
it('routes filesystem requests to editing, resolves only selected paths and prevents traversal', () => {
  const scope = { opened: root, files: [file], directories: [folder, destination] }
  for (const text of ['move source.bin', 'copy source.bin', 'duplicate source.bin', 'rename source.bin', 'create folder archive', 'permanently delete source.bin']) expect(directoryRoute(text, scope).intent).toBe('edit')
  expect(filesystemProposal('move_file', { path: file, directory: destination, reason: 'Organize' }, scope)).toMatchObject({ operation: 'move', destination: join(destination, 'source.bin') })
  expect(() => filesystemProposal('copy_file', { path: file, directory: '.', name: '../escape', reason: 'Copy' }, scope)).toThrow('plain')
  expect(() => filesystemProposal('delete_folder', { path: '.', reason: 'Delete' }, scope)).toThrow('Select')
})
it('gates direct actions through one approval, denies retries and never invokes a model/native editor', async () => {
  const approvals = new ApprovalController(), api = { begin: vi.fn().mockResolvedValue('run'), cancel: vi.fn(),
    validateEvidence: vi.fn().mockResolvedValue({ evidence: [], sourceCount: 0, durationMs: 0 }),
    propose: vi.fn(async (_run, request) => ({ id: 'id', ...request, beforeHash: 'hash' })), prepare: vi.fn().mockResolvedValue(null),
    commit: vi.fn(async () => ({ operation: 'copy', path: file, destination: join(root, 'copy.bin') })), discard: vi.fn().mockResolvedValue(undefined), preview: vi.fn() }
  const transport = vi.fn(), client = new DirectoryActionClient({ api: api as unknown as DirectoryActionsApi, selection: { opened: root, files: [file], directories: [] }, approvals, transport, current: () => true, activity: vi.fn(), committed: vi.fn() })
  let allow = true, count = 0
  approvals.subscribe(() => { const view = approvals.getSnapshot(); if (view) { count++; approvals.decide(view.key, allow) } })
  const skill = directoryMutationSkill(client, { opened: root, files: [file], directories: [] })
  expect((await skill.executeTool({ id: 'copy', name: 'copy_file', input: { path: file, directory: '.', name: 'copy.bin', reason: 'Duplicate' } })).mutated).toBe(true)
  expect(count).toBe(1); expect(transport).not.toHaveBeenCalled(); expect(api.preview).not.toHaveBeenCalled()
  allow = false
  const request = proposal('delete-permanently')
  expect(JSON.parse(await client.perform(request)).status).toBe('declined')
  expect(JSON.parse(await client.perform(request)).status).toBe('declined')
  expect(count).toBe(2); expect(api.commit).toHaveBeenCalledOnce()
})
it('requires a typed name in the approval controller as well as the main process', async () => {
  const approvals = new ApprovalController()
  const waiting = approvals.request({ id: 'id', ...proposal('delete-permanently'), beforeHash: 'hash' }, 'prepare')
  const key = approvals.getSnapshot()!.key
  approvals.decide(key, true); expect(approvals.getSnapshot()).not.toBeNull()
  approvals.decide(key, true, 'wrong'); expect(approvals.getSnapshot()).not.toBeNull()
  approvals.decide(key, true, 'source.bin'); expect(await waiting).toBe(true); expect(approvals.confirmation).toBe('source.bin')
})
it('does not use copy/trash receipts to support write/move/permanent-delete claims', () => {
  expect(actionClaimCorrection('I moved source.bin.', [{ operation: 'copy', path: file }], [file])).toContain('No file commit')
  expect(actionClaimCorrection('I updated source.bin.', [{ operation: 'copy', path: file }], [file])).toContain('No file commit')
  expect(actionClaimCorrection('I permanently deleted source.bin.', [{ operation: 'delete', path: file }], [file])).toContain('No file commit')
  expect(actionClaimCorrection('I renamed source.bin to new.bin.', [{ operation: 'rename', path: file, destination: join(root, 'new.bin') }], [file])).toBeNull()
})
