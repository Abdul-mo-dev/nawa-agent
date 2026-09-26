import type { AgentToolDef } from './types'
import type { DirectoryWorkflowOptions } from './directory-workflow'

export type DirectorySessionMode = 'read' | 'edit'
export const DIRECTORY_PROTOCOL_VERSION = 3
// Fail closed: tools absent from the registered native skill are never fabricated.
const EDIT_TOOLS: Record<string, ReadonlySet<string>> = Object.fromEntries(Object.entries({
  docs: ['get_document_context','read_blocks','insert_content','replace_blocks','replace_selection','apply_ops','read_revisions','accept_changes','reject_changes','read_comments','reply_comment','resolve_comment','insert_footnote','insert_endnote','delete_note','edit_note','read_notes','add_comment','delete_comment','insert_chart','edit_chart','set_header_footer'],
  sheets: ['get_workbook_context','read_range','aggregate_range','load_guide','read_formats','read_sheet_features','read_cells','find_cells','select_range','trace_precedents','trace_dependents','propose_operations'],
  slides: ['read_slide','apply_ops','load_guide','edit_chart','execute_slide_script'],
  pdf: ['read_pages','search_text','goto_page','markup_text','read_annotations','add_note','reply_note','edit_note','delete_markup','delete_note','edit_text','edit_block','move_text_block','insert_text','add_form_mark','list_inserted_text','edit_inserted_text','move_inserted_text','delete_inserted_text','list_page_images','transform_image','rotate_image','flip_image','set_image_opacity','crop_image','delete_image','list_form_fields','apply_ops','get_outline'],
  markdown: ['get_document_context','read_blocks','apply_ops','read_frontmatter'],
  html: ['get_outline','read_source','apply_ops'],
}).map(([kind, names]) => [kind, new Set(names)]))


const READ_TOOLS: Record<string, ReadonlySet<string>> = Object.fromEntries(Object.entries({
  docs: ['get_document_context', 'read_blocks', 'read_revisions', 'read_comments', 'read_notes'],
  sheets: ['get_workbook_context', 'read_range', 'aggregate_range', 'load_guide', 'read_formats', 'read_sheet_features', 'read_cells', 'find_cells', 'trace_precedents', 'trace_dependents'],
  slides: ['read_slide', 'load_guide'],
  pdf: ['read_pages', 'search_text', 'read_annotations', 'list_inserted_text', 'list_page_images', 'list_form_fields', 'get_outline'],
  markdown: ['get_document_context', 'read_blocks', 'read_frontmatter'],
  html: ['get_outline', 'read_source'],
}).map(([kind, names]) => [kind, new Set(names)]))

const WORKFLOW_TOOLS: Record<string, readonly string[]> = {
  docs: ['write_document'], markdown: ['write_document'],
  slides: ['ask_clarification', 'plan_deck', 'generate_deck', 'regenerate_slide', 'save_style_template', 'list_style_templates'],
  html: ['ask_clarification', 'plan_page', 'write_document'],
  sheets: ['merge_attached_workbooks'],
}
const NETWORK_TOOLS = new Set(['web_search', 'image_search', 'insert_image'])
const MEDIA_TOOLS = new Set(['generate_image', 'analyze_media'])
export function directoryToolAllowed(kind: string, mode: DirectorySessionMode, name: string, workflow?: DirectoryWorkflowOptions): boolean {
  if ((mode === 'read' ? READ_TOOLS : mode === 'edit' ? EDIT_TOOLS : {})[kind]?.has(name)) return true
  if (mode !== 'edit' || !workflow?.generation) return false
  if (WORKFLOW_TOOLS[kind]?.includes(name)) return name !== 'merge_attached_workbooks' || workflow.sources.length > 0
  if (name === 'read_attachment') return workflow.sources.length > 0
  if (MEDIA_TOOLS.has(name)) return workflow.network && workflow.media
  if (NETWORK_TOOLS.has(name)) return workflow.network
  return false
}
export function directoryTools(kind: string, mode: DirectorySessionMode, tools: AgentToolDef[], workflow?: DirectoryWorkflowOptions): AgentToolDef[] {
  return tools.filter(tool => directoryToolAllowed(kind, mode, tool.name, workflow))
}
