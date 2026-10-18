import { describe, expect, it, vi } from 'vitest'
import { createPreviewSkill } from '../src/renderer/src/ai/preview-skill'
import type { FilePreview } from '../src/shared/file-preview'

const message = (path: string, body: string): FilePreview => ({
  path,
  name: path,
  sourceHash: body,
  message: {
    subject: 'Subject',
    headers: [{ name: 'From', value: 'sender@example.com' }],
    body,
    attachments: [{ name: 'notes.pdf', bytes: 10 }],
    warnings: ['Attachment contents unavailable'],
  },
})

describe('open preview assistant', () => {
  it('reads the visible email snapshot, pages long content, and follows a changed file', async () => {
    let preview = message('/first.eml', 'FIRST\n' + 'body '.repeat(3000))
    const recognize = vi.fn()
    const skill = createPreviewSkill(() => preview, recognize)
    const read = await skill.executeTool({
      id: 'read',
      name: 'read_preview',
      input: { maxChars: 100 },
    })
    expect(JSON.parse(read.output)).toMatchObject({ path: '/first.eml', nextOffset: 100 })
    expect(JSON.parse(read.output).text).toContain('FIRST')
    const page = await skill.executeTool({
      id: 'page',
      name: 'read_preview',
      input: { offset: 100, maxChars: 100 },
    })
    expect(JSON.parse(page.output).offset).toBe(100)
    preview = message('/second.msg', 'SECOND')
    expect(JSON.parse(skill.buildContext!()).openFile).toBe('/second.msg')
    const next = JSON.parse(
      (await skill.executeTool({ id: 'next', name: 'read_preview', input: {} })).output,
    )
    expect(next.text).toContain('SECOND')
    expect(next.text).toContain('notes.pdf')
    expect(next.text).toContain('contents not read')
    expect(next.text).not.toContain('FIRST')
    expect(recognize).not.toHaveBeenCalled()
  })
  it('caches OCR only for the same displayed snapshot', async () => {
    let preview: FilePreview = {
      path: '/picture.png',
      name: 'picture.png',
      image: 'data:image/png;base64,AA==',
      sourceHash: 'first',
    }
    const recognize = vi.fn(async () => 'Recognized text')
    const skill = createPreviewSkill(() => preview, recognize)
    for (let i = 0; i < 2; i++) {
      const result = await skill.executeTool({ id: String(i), name: 'read_preview', input: {} })
      expect(JSON.parse(result.output).text).toContain('OCR')
    }
    expect(recognize).toHaveBeenCalledTimes(1)
    preview = { ...preview, sourceHash: 'second' }
    await skill.executeTool({ id: 'updated', name: 'read_preview', input: {} })
    expect(recognize).toHaveBeenCalledTimes(2)
  })
  it('rejects reads cancelled or replaced during OCR', async () => {
    let preview: FilePreview = {
      path: '/picture.png',
      name: 'picture.png',
      image: 'image',
      sourceHash: 'first',
    }
    const skill = createPreviewSkill(
      () => preview,
      async () => {
        preview = { ...preview, sourceHash: 'second' }
        return 'stale text'
      },
    )
    expect(
      await skill.executeTool({ id: 'changed', name: 'read_preview', input: {} }),
    ).toMatchObject({ isError: true, mutated: false })
    expect(
      await skill.executeTool({ id: 'stop', name: 'read_preview', input: {} }, AbortSignal.abort()),
    ).toMatchObject({ isError: true })
    expect(
      await skill.executeTool({ id: 'range', name: 'read_preview', input: { offset: -1 } }),
    ).toMatchObject({ isError: true })
  })
})
