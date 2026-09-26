import type { AgentSkill } from './skill'
import type { AgentToolCall, AgentToolDef, ToolExecution } from './types'

/** Only in-document tools may run on the staged copy. No file/export/network tools. */
const ALLOWED: Record<string, ReadonlySet<string>> = Object.fromEntries(Object.entries({
  docs: ['get_document_context','read_blocks','insert_content','replace_blocks','replace_selection','apply_ops','read_revisions','accept_changes','reject_changes','read_comments','reply_comment','resolve_comment','insert_footnote','insert_endnote','delete_note','edit_note','read_notes','add_comment','delete_comment','insert_chart','edit_chart','set_header_footer'],
  sheets: ['get_workbook_context','read_range','aggregate_range','load_guide','read_formats','read_sheet_features','read_cells','find_cells','select_range','trace_precedents','trace_dependents','propose_operations'],
  slides: ['read_slide','apply_ops','load_guide','edit_chart'],
  pdf: ['read_pages','search_text','goto_page','markup_text','read_annotations','add_note','reply_note','edit_note','delete_markup','delete_note','edit_text','edit_block','move_text_block','insert_text','add_form_mark','list_inserted_text','edit_inserted_text','move_inserted_text','delete_inserted_text','list_page_images','transform_image','rotate_image','flip_image','set_image_opacity','crop_image','delete_image','list_form_fields','apply_ops','get_outline'],
  markdown: ['get_document_context','read_blocks','apply_ops','read_frontmatter'],
  html: ['get_outline','read_source','apply_ops'],
}).map(([kind, names]) => [kind, new Set(names)]))

export interface DirectoryEditorDescription {
  kind: string
  systemPrompt: string
  context: string
  tools: AgentToolDef[]
}
interface Command { id: string; path: string; command: 'describe' | 'execute' | 'cancel'; call?: AgentToolCall }
interface Bridge {
  onCommand(handler: (command: Command) => void): () => void
  reply(id: string, result: unknown, error?: string): void
}
interface Binding {
  path: string | null | undefined
  kind: string
  loop: { busy: boolean; directorySkill: AgentSkill } | null
  settle?: () => Promise<void>
}
const same = (a: string, b: string) => {
  const clean = (p: string) => p.replace(/\\/g, '/')
  const left = clean(a), right = clean(b)
  return /^[a-z]:\//i.test(left) || left.startsWith('//') ? left.toLowerCase() === right.toLowerCase() : left === right
}

/** Installed by each editor next to its normal chat loop. Reuses that loop's real skill. */
export function registerDirectoryEditor(getBinding: () => Binding): () => void {
  const bridge = (window as unknown as { nawaEditorBridge?: Bridge }).nawaEditorBridge
  if (!bridge) return () => {}
  let disposed = false
  let controller: AbortController | null = null
  const unsubscribe = bridge.onCommand(request => {
    if (request.command === 'cancel') { controller?.abort(); return }
    void (async () => {
      const binding = getBinding()
      if (!binding.path || !same(binding.path, request.path) || !binding.loop) throw new Error('Editor is not ready for this staging file.')
      if (binding.loop.busy || controller) throw new Error('The editor is busy. Try again after its current operation.')
      const skill = binding.loop.directorySkill
      const tools = skill.tools.filter(tool => ALLOWED[binding.kind]?.has(tool.name))
      if (!tools.length) throw new Error('This editor exposes no staged-edit tools.')
      if (request.command === 'describe') return {
        kind: binding.kind,
        systemPrompt: skill.systemPrompt,
        context: skill.buildContext?.() ?? '',
        tools,
      } satisfies DirectoryEditorDescription
      const call = request.call
      if (!call || !tools.some(tool => tool.name === call.name)) throw new Error('Tool is not permitted in a directory staging session.')
      const abort = new AbortController(); controller = abort
      try {
        const result: ToolExecution = await skill.executeTool(call, abort.signal)
        await binding.settle?.()
        // Let queued React/editor state commit before the next read or native save.
        await new Promise(resolve => setTimeout(resolve, 40))
        if (abort.signal.aborted || disposed) throw new Error('Staged edit was cancelled.')
        return result
      } finally { if (controller === abort) controller = null }
    })().then(result => { if (!disposed) bridge.reply(request.id, result) }, cause => {
      if (!disposed) bridge.reply(request.id, null, cause instanceof Error ? cause.message : String(cause))
    })
  })
  return () => { disposed = true; controller?.abort(); unsubscribe() }
}
