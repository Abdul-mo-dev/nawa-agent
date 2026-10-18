import { afterEach, expect, it } from 'vitest'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DirectoryActionManager } from '../src/main/directory-actions/manager'
import { openTextStage } from '../src/main/directory-actions/text-stage'
import { decodeSource, reviewFileChanges, parseFileToText } from '@genoffice/file-parse'
const roots: string[] = []
afterEach(async () => {
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true })
})

it.each(['json', 'mjs', 'cjs', 'yaml', 'xml', 'ps1'])(
  'reviews, backs up and commits a selected .%s source',
  async (extension) => {
    const root = await mkdtemp(join(tmpdir(), 'nawa-text-'))
    roots.push(root)
    const path = join(root, `source.${extension}`)
    const content =
      extension === 'json'
        ? '{\r\n  "title": "日本語",\r\n  "value": 1\r\n}\r\n'
        : 'مرحبا 日本語\r\nvalue = 1\r\n'
    const original = Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from(content, 'utf16le')])
    await writeFile(path, original)
    const manager = new DirectoryActionManager({
      roots: async () => [root],
      stateDirectory: root,
      open: openTextStage,
      blank: async () => '',
      assertClosed: async () => {},
      trash: async () => {},
      changed() {},
      extract: async (file) => {
        const parsed = await parseFileToText(file)
        if (!parsed.ok) throw new Error(parsed.error)
        return parsed.text ?? ''
      },
      review: reviewFileChanges,
    })
    const run = await manager.begin(1, { opened: root, files: [path], directories: [] })
    try {
      const inspection = await manager.inspections.open(1, run, path)
      expect(inspection.tools.map((tool) => tool.name)).toEqual(['read_text'])
      await expect(
        manager.inspections.execute(1, run, inspection.id, {
          id: 'bad',
          name: 'write_text',
          input: {},
        }),
      ).rejects.toThrow('not allowed')
      await manager.inspections.close(1, run, inspection.id)
      const proposal = await manager.propose(1, run, {
        operation: 'update',
        path,
        instruction: 'Change value to 2',
      })
      await expect(manager.commit(1, proposal.id)).rejects.toThrow('Review')
      await manager.prepare(1, proposal.id)
      const read = JSON.parse(
        (await manager.execute(1, proposal.id, { id: 'read', name: 'read_text', input: {} }))
          .output,
      )
      await expect(
        manager.execute(1, proposal.id, {
          id: 'stale',
          name: 'replace_text',
          input: { revision: 'old', find: '1', replacement: '2' },
        }),
      ).rejects.toThrow('revision')
      await manager.execute(1, proposal.id, {
        id: 'edit',
        name: 'replace_text',
        input: {
          revision: read.revision,
          find: extension === 'json' ? '"value": 1' : 'value = 1',
          replacement: extension === 'json' ? '"value": 2' : 'value = 2',
        },
      })
      const preview = await manager.preview(1, proposal.id)
      expect(preview.review?.entries.some((entry) => entry.after?.includes('2'))).toBe(true)
      expect(await readFile(path)).toEqual(original)
      const receipt = await manager.commit(1, proposal.id)
      expect(await readFile(receipt.backupPath!)).toEqual(original)
      const saved = await readFile(path)
      expect(saved.subarray(0, 2)).toEqual(Buffer.from([0xff, 0xfe]))
      expect(decodeSource(saved).text).toBe(content.replace('1', '2'))
    } finally {
      await manager.cancelOwner(1)
    }
  },
)

it('rejects invalid JSON, ambiguous replacements and upgrading read-only sessions', async () => {
  const root = await mkdtemp(join(tmpdir(), 'nawa-source-'))
  roots.push(root)
  const path = join(root, 'settings.json')
  await writeFile(path, '{"a":1,"b":1}')
  const stage = await openTextStage(path)
  await stage.describe('edit')
  const { revision } = JSON.parse(
    (await stage.execute({ id: 'read', name: 'read_text', input: {} })).output,
  )
  await expect(
    stage.execute({
      id: 'ambiguous',
      name: 'replace_text',
      input: { revision, find: '1', replacement: '2' },
    }),
  ).rejects.toThrow('exactly once')
  await expect(
    stage.execute({ id: 'json', name: 'write_text', input: { revision, text: '{broken' } }),
  ).rejects.toThrow()
  await stage.save()
  expect(await readFile(path, 'utf8')).toBe('{"a":1,"b":1}')
  await stage.close()
  await expect(stage.save()).rejects.toThrow('closed')
  const inspection = await openTextStage(path)
  await inspection.describe('read')
  await expect(inspection.describe('edit')).rejects.toThrow('mode')
  await expect(inspection.save()).rejects.toThrow('Read-only')
  await inspection.close()
})
