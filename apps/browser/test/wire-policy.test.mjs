import test from 'node:test'
import assert from 'node:assert/strict'
import { encodeWire, decodeWire } from '../server/wire.mjs'
import { validateRpc } from '../server/policy.mjs'
import path from 'node:path'

test('binary IPC roundtrips nested buffers, slices and typed arrays', () => {
  const source = { buffer: new Uint8Array([1, 2, 3]).buffer, nested: [new Uint16Array([1234, 65535]), Buffer.from([0, 255])], slice: new Uint8Array([1, 2, 3, 4]).subarray(1, 3) }
  const result = decodeWire(JSON.parse(JSON.stringify(encodeWire(source))))
  assert.deepEqual([...new Uint8Array(result.buffer)], [1, 2, 3])
  assert.deepEqual([...result.nested[0]], [1234, 65535])
  assert.deepEqual([...result.nested[1]], [0, 255])
  assert.deepEqual([...result.slice], [2, 3])
})

test('wire rejects prototype injection, invalid base64 and malformed typed lengths', () => {
  for (const bad of [JSON.parse('{"__proto__":{"polluted":true}}'), { $genofficeBytes: 'AA==', type: 'Uint16Array' }, { $genofficeBytes: 'NOT BASE64', type: 'Uint8Array' }, { $genofficeBytes: '', type: 'Function' }]) assert.throws(() => decodeWire(bad))
  assert.equal({}.polluted, undefined)
})

const workspace = {
  get() { return { readOnly: false } },
  async fromAbsolute(_mount, value) { if (!value.startsWith(path.resolve('safe') + path.sep)) throw Object.assign(new Error('outside'), { status: 403 }) },
}

test('RPC policy isolates editor scopes and denies OS, AI, clipboard and arbitrary channels', async () => {
  const tab = { kind: 'docs', mount: 'one' }
  for (const channel of ['slides:save', 'app:delete-everything', 'ai:chat', 'shell:open-external', 'docs:print', 'docs:export-html', 'docs:create-document', 'files:read', 'docs:copy-image-to-clipboard']) await assert.rejects(validateRpc(workspace, tab, channel, []), { status: 403 }, channel)
  await validateRpc(workspace, tab, 'app:get-language', [])
  await validateRpc(workspace, tab, 'docs:consume-headless-export', [])
  await validateRpc(workspace, tab, 'docs:consume-new-blank', [])
  await validateRpc(workspace, { ...tab, kind: 'sheets' }, 'sheets:consume-new-blank', [])
})

test('RPC policy rejects unsafe filenames and mounted-path escapes', async () => {
  const tab = { kind: 'docs', mount: 'one' }
  await assert.rejects(validateRpc(workspace, tab, 'docs:save-as', ['../outside.docx', new ArrayBuffer(0)]), { status: 400 })
  await assert.rejects(validateRpc(workspace, tab, 'docs:save', [path.resolve('outside/a.docx'), new ArrayBuffer(0)]), { status: 403 })
  await validateRpc(workspace, tab, 'docs:save', [path.resolve('safe/a.docx'), new ArrayBuffer(0)])
})

test('direct automation save targets and relative filesystem DTO paths are rejected', async () => {
  const tab = { kind: 'docs', mount: 'one' }
  await assert.rejects(validateRpc(workspace, tab, 'docs:save-to', []), { status: 403 })
  await assert.rejects(validateRpc(workspace, { ...tab, kind: 'sheets' }, 'workbook:save', [{ targetPath: path.resolve('safe/copy.xlsx'), mode: 'save-as' }]), { status: 403 })
  await assert.rejects(validateRpc(workspace, { ...tab, kind: 'pdf' }, 'pdf:save', [{ path: 'relative.pdf' }]), { status: 400 })
})

test('scalar open paths and workbook merge arrays cannot bypass mount boundaries', async () => {
  await assert.rejects(validateRpc(workspace, { kind: 'docs', mount: 'one' }, 'docs:open-path', ['../../secret.docx']), { status: 400 })
  await assert.rejects(validateRpc(workspace, { kind: 'docs', mount: 'one' }, 'docs:save-as', ['copy.docx', new ArrayBuffer(0), '../secret.docx']), { status: 400 })
  await assert.rejects(validateRpc(workspace, { kind: 'sheets', mount: 'one' }, 'workbook:open-for-merge', [[path.resolve('outside/book.xlsx')]]), { status: 403 })
  await validateRpc(workspace, { kind: 'sheets', mount: 'one' }, 'workbook:open-for-merge', [[path.resolve('safe/book.xlsx')]])
})
