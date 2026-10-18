import { describe, expect, it } from 'vitest'
import { createSourceSkill, type SourceAiAccess } from '../src/renderer/ai/source-skill'

function source(initial: string, path = '/config/settings.json') {
  let text = initial
  const access: SourceAiAccess = {
    getText: () => text,
    setText: (value) => {
      text = value
    },
    getPath: () => path,
    getSelection: () => null,
    clearSelection() {},
  }
  return { access, skill: createSourceSkill(() => access) }
}

describe('assistant for the open source file', () => {
  it('reads unsaved live content and refreshes context after manual edits', async () => {
    const { skill, access } = source('{"project":"saved"}')
    expect(JSON.parse(skill.buildContext!()).untrustedSourcePreview).toContain('saved')
    access.setText('{"project":"unsaved 日本語 العربية"}')
    const result = await skill.executeTool({ id: 'read', name: 'read_text', input: {} })
    expect(result.mutated).toBe(false)
    expect(JSON.parse(result.output)).toMatchObject({
      source: 'live-editor-buffer',
      text: access.getText(),
      path: '/config/settings.json',
    })
    expect(JSON.parse(skill.buildContext!()).untrustedSourcePreview).toContain(
      'unsaved 日本語 العربية',
    )
  })
  it('rejects stale edits and updates the actual source buffer rather than Markdown', async () => {
    const { skill, access } = source('{"project":"original","value":1}')
    const { revision } = JSON.parse(
      (await skill.executeTool({ id: 'read', name: 'read_text', input: {} })).output,
    )
    access.setText('{"project":"manually changed","value":1}')
    expect(
      await skill.executeTool({
        id: 'stale',
        name: 'replace_text',
        input: { revision, find: '1', replacement: '2' },
      }),
    ).toMatchObject({ isError: true, mutated: false })
    const current = JSON.parse(
      (await skill.executeTool({ id: 'read2', name: 'read_text', input: {} })).output,
    )
    const result = await skill.executeTool({
      id: 'edit',
      name: 'replace_text',
      input: { revision: current.revision, find: '"value":1', replacement: '"value":2' },
    })
    expect(result.mutated).toBe(true)
    expect(JSON.parse(result.output).saved).toBe(false)
    expect(access.getText()).toBe('{"project":"manually changed","value":2}')
  })
  it('rejects invalid JSON, ambiguous fragments and aborted writes without changing content', async () => {
    const { skill, access } = source('{"a":1,"b":1}')
    const { revision } = JSON.parse(
      (await skill.executeTool({ id: 'r', name: 'read_text', input: {} })).output,
    )
    for (const call of [
      { id: 'invalid', name: 'write_text', input: { revision, text: '{broken' } },
      { id: 'ambiguous', name: 'replace_text', input: { revision, find: '1', replacement: '2' } },
    ])
      expect(await skill.executeTool(call)).toMatchObject({ isError: true, mutated: false })
    const abort = new AbortController()
    abort.abort()
    expect(
      await skill.executeTool(
        { id: 'stop', name: 'write_text', input: { revision, text: '{}' } },
        abort.signal,
      ),
    ).toMatchObject({ isError: true, mutated: false })
    expect(access.getText()).toBe('{"a":1,"b":1}')
  })
  it('pages long files and includes the source selection in context', async () => {
    const { skill, access } = source(
      'first\n日本語 العربية\n' + 'content\n'.repeat(1000),
      '/notes.txt',
    )
    access.getSelection = () => ({ from: 6, to: 17 })
    const context = JSON.parse(skill.buildContext!())
    expect(context.previewTruncated).toBe(true)
    expect(context.selection.text).toBe(access.getText().slice(6, 17))
    const result = JSON.parse(
      (
        await skill.executeTool({
          id: 'page',
          name: 'read_text',
          input: { offset: 6000, maxChars: 400 },
        })
      ).output,
    )
    expect(result.text).toBe(access.getText().slice(6000, 6400))
    expect(result.nextOffset).toBe(6400)
  })
})
