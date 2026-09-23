import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, writeFile, readFile, rm, symlink, link, rename, readdir } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, dirname, parse, resolve } from 'node:path'
import { WorkspaceFolderStore, containsPath } from '../../apps/shell/src/main/workspace-folders.ts'
import {
  HISTORY_LIMIT, loadMessages, saveMessages, historyKey, draftKey,
  relativeDocumentName, WorkspaceRequestGate,
} from '../../apps/shell/src/renderer/src/workspace-chat-state.ts'

async function fixture(t, initial = false) {
  const base = await mkdtemp(join(tmpdir(), 'nawa-workspace-test-'))
  t.after(() => rm(base, { recursive: true, force: true }))
  const a = join(base, 'Project A'), b = join(base, 'Project B'), child = join(a, 'Research')
  await mkdir(child, { recursive: true }); await mkdir(b)
  const statePath = join(base, 'state', 'workspace-folders.json')
  const store = new WorkspaceFolderStore({ statePath, ...(initial ? { initialRoot: () => a } : {}) })
  return { base, a, b, child, statePath, store }
}

function memoryStorage() {
  const entries = new Map()
  return {
    getItem: (key) => entries.get(key) ?? null,
    setItem: (key, value) => entries.set(key, value),
  }
}

test('multiple roots persist and reopen independently', async (t) => {
  const { a, b, statePath, store } = await fixture(t)
  await store.add(a); await store.add(b)
  assert.deepEqual((await store.list()).map((x) => x.path), [a, b])
  const reopened = new WorkspaceFolderStore({ statePath })
  assert.deepEqual((await reopened.list()).map((x) => x.path), [a, b])
})

test('adding the same canonical folder twice does not duplicate its tab', async (t) => {
  const { a, child, store } = await fixture(t)
  await store.add(a); await store.add(join(child, '..'))
  assert.equal((await store.list()).length, 1)
})

test('concurrent folder additions serialize without losing either folder', async (t) => {
  const { a, b, store } = await fixture(t)
  await Promise.all([store.add(a), store.add(b), store.add(a)])
  assert.deepEqual((await store.list()).map((x) => x.path).sort(), [a, b].sort())
})

test('minus removes metadata only; disk files and other folder registrations remain', async (t) => {
  const { a, b, store } = await fixture(t)
  const document = join(a, 'report.md')
  await writeFile(document, 'Keep this report')
  await store.add(a); await store.add(b); await store.remove(a)
  assert.equal(await readFile(document, 'utf8'), 'Keep this report')
  assert.deepEqual((await store.list()).map((x) => x.path), [b])
  await assert.rejects(store.scope(a), /not in the workspace/)
})

test('legacy save folder migrates once, not whenever Settings changes', async (t) => {
  const { a, b, statePath, store } = await fixture(t, true)
  assert.deepEqual((await store.list()).map((x) => x.path), [a])
  const reopened = new WorkspaceFolderStore({ statePath, initialRoot: () => b })
  assert.deepEqual((await reopened.list()).map((x) => x.path), [a])
})

test('removing the last root persists an empty workspace across restarts', async (t) => {
  const { a, statePath, store } = await fixture(t, true)
  await store.list(); await store.remove(a)
  const reopened = new WorkspaceFolderStore({ statePath, initialRoot: () => a })
  assert.deepEqual(await reopened.list(), [])
})

test('missing root remains visible and can be removed without stat-ing it', async (t) => {
  const { a, store } = await fixture(t)
  await store.add(a); await rm(a, { recursive: true })
  assert.equal((await store.list())[0].usable, false)
  await store.remove(a)
  assert.deepEqual(await store.list(), [])
})

test('corrupt saved registration is rejected without overwriting it', async (t) => {
  const { statePath, store } = await fixture(t)
  await mkdir(dirname(statePath), { recursive: true })
  await writeFile(statePath, '{bad json')
  await assert.rejects(store.list())
  assert.equal(await readFile(statePath, 'utf8'), '{bad json')
})

test('invalid root paths and non-directory picker results are rejected', async (t) => {
  const { a, store } = await fixture(t)
  await writeFile(join(a, 'report.md'), 'report')
  await assert.rejects(store.add('relative/path'), /absolute/)
  await assert.rejects(store.add(join(a, 'report.md')), /not a folder/)
  await assert.rejects(store.remove('bad\0path'), /Invalid/)
})

test('failed root addition leaves the existing registration unchanged', async (t) => {
  const { a, base, store, statePath } = await fixture(t)
  await store.add(a)
  const before = await readFile(statePath, 'utf8')
  await assert.rejects(store.add(join(base, 'missing')))
  assert.equal(await readFile(statePath, 'utf8'), before)
  assert.deepEqual((await store.list()).map((x) => x.path), [a])
})

test('document tree includes files inside leaf folders, not just directories', async (t) => {
  const { a, child, store } = await fixture(t)
  await writeFile(join(a, 'Budget.xlsx'), 'test only')
  await writeFile(join(child, 'brief.md'), '# Brief')
  await store.add(a)
  const root = await store.listFolder(a)
  assert.deepEqual(root.folders.map((x) => x.name), ['Research'])
  assert.deepEqual(root.files.map((x) => x.name), ['Budget.xlsx'])
  const leaf = await store.listFolder(child)
  assert.equal(leaf.folders.length, 0)
  assert.deepEqual(leaf.files.map((x) => x.name), ['brief.md'])
})

test('each subfolder scope includes descendants but excludes its parent and siblings', async (t) => {
  const { a, b, child, store } = await fixture(t)
  const rootFile = join(a, 'root.md'), childFile = join(child, 'child.md'), other = join(b, 'other.md')
  for (const file of [rootFile, childFile, other]) await writeFile(file, file)
  await store.add(a); await store.add(b)
  assert.deepEqual((await store.scope(a)).paths, [rootFile, childFile])
  assert.deepEqual((await store.scope(child)).paths, [childFile])
  assert.deepEqual((await store.scope(b)).paths, [other])
  assert.equal(await store.authorizeFile(child, childFile), childFile)
  await assert.rejects(store.authorizeFile(child, rootFile), /outside/)
  await assert.rejects(store.authorizeFile(a, other), /outside/)
})

test('tree and context exclude hidden directories, lock files, and unsupported files', async (t) => {
  const { a, child, store } = await fixture(t)
  await mkdir(join(a, 'node_modules')); await mkdir(join(a, '.private'))
  for (const relative of ['good.md', '~$lock.docx', '.hidden.md', 'binary.exe', 'node_modules/secret.md', '.private/private.md']) {
    await writeFile(join(a, relative), 'content')
  }
  await store.add(a)
  assert.deepEqual((await store.listFolder(a)).folders.map((x) => x.path), [child])
  assert.deepEqual((await store.scope(a)).paths, [join(a, 'good.md')])
})

test('path boundaries reject sibling prefixes and allow a filesystem root', () => {
  const root = resolve('project'), sibling = resolve('project-other', 'report.md')
  assert.equal(containsPath(root, sibling), false)
  assert.equal(containsPath(root, join(root, 'inside.md')), true)
  assert.equal(containsPath(root, root), true)
  assert.equal(containsPath(parse(root).root, root), true)
})

test('unregistered files and parent traversal cannot become chat context', async (t) => {
  const { a, b, store } = await fixture(t)
  await store.add(a)
  await writeFile(join(b, 'secret.md'), 'secret')
  await assert.rejects(store.authorizeFile(a, join(a, '..', 'Project B', 'secret.md')), /not in/)
  await assert.rejects(store.scope(b), /not in/)
})

test('file and directory links are not followed by the tree or by chat reads', async (t) => {
  const { a, b, child, store } = await fixture(t)
  await store.add(a); await store.add(b)
  const target = join(b, 'secret.md'); await writeFile(target, 'secret')
  try {
    await symlink(target, join(a, 'linked.md'), 'file')
    await symlink(b, join(a, 'linked-folder'), process.platform === 'win32' ? 'junction' : 'dir')
  } catch (error) {
    if (error.code === 'EPERM') { t.skip('OS account cannot create symlinks'); return }
    throw error
  }
  assert.deepEqual((await store.listFolder(a)).folders.map((x) => x.path), [child])
  assert.deepEqual((await store.scope(a)).paths, [])
  await assert.rejects(store.authorizeFile(a, join(a, 'linked.md')))
  await assert.rejects(store.scope(join(a, 'linked-folder')))
})

test('replacing a registered directory with an outside symlink does not grant the new target', async (t) => {
  const { a, b, base, store } = await fixture(t)
  await store.add(a)
  await rename(a, join(base, 'original'))
  try { await symlink(b, a, process.platform === 'win32' ? 'junction' : 'dir') } catch (error) {
    if (error.code === 'EPERM') { t.skip('OS account cannot create symlinks'); return }
    throw error
  }
  assert.equal((await store.list())[0].usable, false)
  await assert.rejects(store.scope(a), /not in/)
})

test('hard-linked files cannot be read as folder chat documents', async (t) => {
  const { a, b, store } = await fixture(t)
  const target = join(b, 'secret.md'); await writeFile(target, 'secret')
  await link(target, join(a, 'linked.md'))
  await store.add(a)
  await assert.rejects(store.authorizeFile(a, join(a, 'linked.md')), /not a link/)
  assert.deepEqual((await store.listFolder(a)).files, [])
})

test('recursive scans stop at the document cap and report truncation', async (t) => {
  const { a, store } = await fixture(t)
  await Promise.all(Array.from({ length: 260 }, (_, i) => writeFile(join(a, `report-${i}.md`), 'x')))
  await store.add(a)
  const scope = await store.scope(a)
  assert.equal(scope.paths.length, 256)
  assert.equal(scope.truncated, true)
})

test('ordinary listings preserve file metadata and stars', async (t) => {
  const { a, store } = await fixture(t)
  const path = join(a, 'test.md'); await writeFile(path, 'abc')
  await store.add(a)
  const [entry] = (await store.listFolder(a, new Set([path]))).files
  assert.equal(entry.sizeBytes, 3); assert.equal(entry.ext, 'md'); assert.equal(entry.starred, true)
  assert.ok(entry.mtimeMs > 0)
})

test('unregistering an overlapping root does not revoke a separately registered child', async (t) => {
  const { a, child, store } = await fixture(t)
  const path = join(child, 'notes.md'); await writeFile(path, 'hello')
  await store.add(a); await store.add(child); await store.remove(a)
  assert.deepEqual((await store.scope(child)).paths, [path])
  await assert.rejects(store.scope(a))
})

test('registration writes leave no temporary files behind', async (t) => {
  const { a, b, store, statePath } = await fixture(t)
  await store.add(a); await store.add(b); await store.remove(a)
  assert.deepEqual(await readdir(dirname(statePath)), ['workspace-folders.json'])
})

test('root, subfolder, and another root have isolated conversation histories', () => {
  const storage = memoryStorage()
  const a = '/Projects/A', sub = '/Projects/A/Research', b = '/Projects/B'
  for (const path of [a, sub, b]) saveMessages(storage, path, [{ role: 'user', text: path }])
  for (const path of [a, sub, b]) assert.deepEqual(loadMessages(storage, path), [{ role: 'user', text: path }])
  saveMessages(storage, a, [{ role: 'assistant', text: 'Updated A only' }])
  assert.equal(loadMessages(storage, sub)[0].text, sub)
  assert.equal(loadMessages(storage, b)[0].text, b)
})

test('legacy history keys are kept and streaming placeholders are not persisted', () => {
  const storage = memoryStorage()
  assert.equal(historyKey('/A'), 'home-ws-chat:/A')
  saveMessages(storage, '/A', [{ role: 'user', text: 'hello' }, { role: 'assistant', text: 'partial', streaming: true }])
  assert.deepEqual(loadMessages(storage, '/A'), [{ role: 'user', text: 'hello' }])
})

test('corrupt, invalid, and oversized histories are handled safely', () => {
  const storage = memoryStorage(), key = historyKey('/A')
  storage.setItem(key, '{bad'); assert.deepEqual(loadMessages(storage, '/A'), [])
  storage.setItem(key, JSON.stringify([null, 3, { role: 'system', text: 'bad' }, { role: 'user', text: 5 }, { role: 'user', text: 'good' }]))
  assert.deepEqual(loadMessages(storage, '/A'), [{ role: 'user', text: 'good' }])
  saveMessages(storage, '/A', Array.from({ length: 65 }, (_, i) => ({ role: 'user', text: String(i) })))
  assert.equal(loadMessages(storage, '/A').length, HISTORY_LIMIT)
  assert.equal(loadMessages(storage, '/A')[0].text, '25')
})

test('unavailable storage never crashes loading or saving', () => {
  const storage = { getItem() { throw new Error('denied') }, setItem() { throw new Error('quota') } }
  assert.deepEqual(loadMessages(storage, '/A'), [])
  assert.doesNotThrow(() => saveMessages(storage, '/A', [{ role: 'user', text: 'hello' }]))
})

test('draft keys are distinct for roots and subfolders and separate from history', () => {
  assert.notEqual(draftKey('/A'), draftKey('/A/B'))
  assert.notEqual(draftKey('/A'), historyKey('/A'))
})

test('document citations use relative paths to distinguish same-named documents', () => {
  assert.equal(relativeDocumentName('/A', '/A/Research/notes.md'), 'Research/notes.md')
  assert.equal(relativeDocumentName('C:\\Work', 'c:\\work\\Research\\notes.md'), 'Research/notes.md')
  assert.equal(relativeDocumentName('/', '/report.md'), 'report.md')
  assert.equal(relativeDocumentName('/A', '/AB/report.md'), 'report.md')
})

test('double submissions are rejected until the current request ends', () => {
  const gate = new WorkspaceRequestGate()
  const id = gate.begin()
  assert.equal(typeof id, 'number'); assert.equal(gate.begin(), null)
  assert.equal(gate.finish(id), true)
  assert.equal(typeof gate.begin(), 'number')
})

test('stop during asynchronous preflight invalidates the pending request', async () => {
  const gate = new WorkspaceRequestGate()
  const id = gate.begin()
  const read = Promise.resolve('document text')
  gate.cancel()
  await read
  assert.equal(gate.isCurrent(id), false)
})

test('late completion from an old directory cannot finish the new request', () => {
  const gate = new WorkspaceRequestGate()
  const old = gate.begin(); gate.cancel()
  const current = gate.begin()
  assert.notEqual(current, old)
  assert.equal(gate.finish(old), false)
  assert.equal(gate.isCurrent(current), true)
  assert.equal(gate.finish(current), true)
})
