import test from 'node:test'
import assert from 'node:assert/strict'
import * as fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { Workspace, relativeParts, revisionOf, KeyedLock } from '../server/workspace.mjs'

async function fixture(t, options = {}) {
  const temp = await fs.mkdtemp(path.join(os.tmpdir(), 'genoffice-browser-'))
  const root = path.join(temp, 'Mounted folder 日本語'); await fs.mkdir(root)
  const outside = path.join(temp, 'outside'); await fs.mkdir(outside)
  const workspace = new Workspace({ stateDir: path.join(temp, 'state'), ...options }); await workspace.initialize()
  const mount = await workspace.mount(root)
  t.after(() => fs.rm(temp, { recursive: true, force: true }))
  return { temp, root, outside, workspace, mount }
}

test('Windows filename and traversal validation on every platform', () => {
  for (const invalid of ['../secret', 'a/../b', './x', 'a//b', '/etc/passwd', 'C:/Windows/x', 'C:\\Windows\\x', '\\\\server\\share', 'a\\b', 'x:stream', 'NUL', 'con.txt', 'COM1.log', 'lpt9', 'COM¹.txt', 'name.', 'name ', '.genoffice-write-123.tmp', 'a\0b', '']) assert.throws(() => relativeParts(invalid, false), undefined, invalid)
  assert.deepEqual(relativeParts(''), [])
  assert.deepEqual(relativeParts('日本語/Quarter 1.txt'), ['日本語', 'Quarter 1.txt'])
})

test('mounts survive a fresh Workspace instance; removed roots are not substituted', async t => {
  const f = await fixture(t)
  const second = new Workspace({ stateDir: path.join(f.temp, 'state') }); await second.initialize()
  assert.equal(second.get(f.mount.id).root, f.root)
  await fs.rename(f.root, f.root + '-moved')
  const third = new Workspace({ stateDir: path.join(f.temp, 'state') }); await third.initialize()
  assert.equal(third.mounts.size, 0)
})

test('create, read, overwrite with revision, enumerate and create directories', async t => {
  const { workspace: w, mount: m, root } = await fixture(t)
  await w.mkdir(m.id, 'sub folder')
  const result = await w.write(m.id, 'sub folder/日本語.txt', Buffer.from('hello\n'), null)
  assert.equal(result.revision, revisionOf(Buffer.from('hello\n')))
  assert.equal((await w.read(m.id, 'sub folder/日本語.txt')).bytes.toString(), 'hello\n')
  const next = await w.write(m.id, 'sub folder/日本語.txt', Buffer.from('edited\n'), result.revision)
  assert.notEqual(next.revision, result.revision)
  assert.equal(await fs.readFile(path.join(root, 'sub folder/日本語.txt'), 'utf8'), 'edited\n')
  assert.equal((await w.list(m.id))[0].kind, 'directory')
  assert.equal((await w.list(m.id, 'sub folder'))[0].name, '日本語.txt')
  assert.ok(!(await fs.readdir(path.join(root, 'sub folder'))).some(n => n.startsWith('.genoffice-write-')))
})

test('external modifications, stale revisions and duplicate creates never clobber', async t => {
  const { workspace: w, mount: m, root } = await fixture(t)
  const first = await w.write(m.id, 'a.txt', Buffer.from('first'), null)
  await assert.rejects(w.write(m.id, 'a.txt', Buffer.from('duplicate'), null), { status: 409 })
  await fs.writeFile(path.join(root, 'a.txt'), 'external')
  await assert.rejects(w.write(m.id, 'a.txt', Buffer.from('stale'), first.revision), { status: 409 })
  assert.equal(await fs.readFile(path.join(root, 'a.txt'), 'utf8'), 'external')
  await assert.rejects(w.write(m.id, 'a.txt', Buffer.from('no revision'), undefined), { status: 428 })
})

test('only one concurrent writer can use a revision or create a new path', async t => {
  const { workspace: w, mount: m } = await fixture(t)
  const first = await w.write(m.id, 'a.txt', Buffer.from('old'), null)
  const results = await Promise.allSettled(['one', 'two', 'three'].map(s => w.write(m.id, 'a.txt', Buffer.from(s), first.revision)))
  assert.equal(results.filter(r => r.status === 'fulfilled').length, 1)
  assert.ok(results.filter(r => r.status === 'rejected').every(r => r.reason.status === 409))
  const create = await Promise.allSettled(['one', 'two'].map(s => w.write(m.id, 'new.txt', Buffer.from(s), null)))
  assert.equal(create.filter(r => r.status === 'fulfilled').length, 1)
})

test('text decoding preserves UTF-8 BOM and reports CRLF/mixed newlines', async t => {
  const { workspace: w, mount: m } = await fixture(t)
  await w.write(m.id, 'utf8.txt', Buffer.from('\ufeff日本語\r\nline two\r\n'), null)
  const text = await w.text(m.id, 'utf8.txt')
  assert.equal(text.bom, true); assert.equal(text.eol, 'crlf'); assert.equal(text.text, '日本語\r\nline two\r\n')
  await w.write(m.id, 'mixed.txt', Buffer.from('a\r\nb\n'), null)
  assert.equal((await w.text(m.id, 'mixed.txt')).eol, 'mixed')
  await w.write(m.id, 'binary.txt', Buffer.from([255, 254, 0, 1]), null)
  await assert.rejects(w.text(m.id, 'binary.txt'), { status: 415 })
})

test('relative traversal and absolute paths cannot escape a mount', async t => {
  const { workspace: w, mount: m, outside } = await fixture(t)
  await fs.writeFile(path.join(outside, 'secret.txt'), 'secret')
  await assert.rejects(w.read(m.id, '../outside/secret.txt'), { status: 400 })
  await assert.rejects(w.fromAbsolute(m.id, path.join(outside, 'secret.txt')), { status: 403 })
  await assert.rejects(w.fromAbsolute(m.id, path.join(w.get(m.id).root + '-evil', 'x')), { status: 403 })
  await assert.rejects(w.write(m.id, 'missing/child.txt', Buffer.from('x'), null), { code: 'ENOENT' })
})

test('symlinks, Windows junctions and hardlinked files are blocked', async t => {
  const { workspace: w, mount: m, root, outside } = await fixture(t)
  const secret = path.join(outside, 'secret.txt'); await fs.writeFile(secret, 'secret')
  await fs.symlink(outside, path.join(root, 'escape'), process.platform === 'win32' ? 'junction' : 'dir')
  await assert.rejects(w.read(m.id, 'escape/secret.txt'), { status: 403 })
  await assert.rejects(w.write(m.id, 'escape/new.txt', Buffer.from('x'), null), { status: 403 })
  await fs.link(secret, path.join(root, 'hard.txt'))
  await assert.rejects(w.read(m.id, 'hard.txt'), { status: 403 })
  assert.equal((await w.list(m.id)).filter(e => e.kind === 'blocked').length, 2)
  assert.equal(await fs.readFile(secret, 'utf8'), 'secret')
})

test('read-only mounts and maximum file size are enforced', async t => {
  const { workspace: w, mount: m, root } = await fixture(t, { maxBytes: 4 })
  await fs.writeFile(path.join(root, 'large.txt'), '12345')
  await assert.rejects(w.read(m.id, 'large.txt'), { status: 413 })
  await assert.rejects(w.write(m.id, 'large.txt', Buffer.from('12345'), null), { status: 413 })
  m.readOnly = true
  await assert.rejects(w.mkdir(m.id, 'folder'), { status: 403 })
  await assert.rejects(w.write(m.id, 'new.txt', Buffer.from('x'), null), { status: 403 })
})

test('failed lock holders do not poison later operations', async () => {
  const lock = new KeyedLock(); const sequence = []
  const first = lock.run('x', async () => { sequence.push(1); throw new Error('test') })
  const second = lock.run('x', async () => { sequence.push(2); return true })
  await assert.rejects(first); assert.equal(await second, true); assert.deepEqual(sequence, [1, 2])
})

test('overlapping mounts share the same file lock', async t => {
  const { workspace: w, mount: m, root } = await fixture(t)
  await fs.mkdir(path.join(root, 'nested'))
  const child = await w.mount(path.join(root, 'nested'))
  const initial = await w.write(m.id, 'nested/shared.txt', Buffer.from('original'), null)
  assert.equal(w.fileKey(m.id, 'nested/shared.txt'), w.fileKey(child.id, 'shared.txt'))
  const writes = await Promise.allSettled([
    w.write(m.id, 'nested/shared.txt', Buffer.from('parent'), initial.revision),
    w.write(child.id, 'shared.txt', Buffer.from('child'), initial.revision),
  ])
  assert.equal(writes.filter(result => result.status === 'fulfilled').length, 1)
  assert.equal(writes.filter(result => result.status === 'rejected')[0].reason.status, 409)
})
