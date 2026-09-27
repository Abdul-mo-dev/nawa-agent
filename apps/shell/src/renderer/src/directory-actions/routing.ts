import { composeSkills, type AgentSkill, type AgentToolDef } from '@genoffice/agent-core'
import type { DirectorySelection } from '../ai/directory-selection'

export type DirectoryIntent = 'metadata' | 'tools' | 'lookup' | 'table' | 'reviewed' | 'edit' | 'general'
export interface DirectoryRoute { intent: DirectoryIntent; prepareKnowledge: boolean; maxTurns: number; target?: string }
const sheet = /\.(?:xlsx?|xlsm|csv|tsv|ods)$/i
const name = (path: string) => path.replace(/\\/g, '/').split('/').pop()!.toLowerCase()

// Recognize the whole listing request, including common shorthand and courtesy words.
// Do not match a listing prefix followed by a content filter or a second operation.
const listingItem = '(?:files?|file ?names?|folders?|director(?:y|ies)|dirs?)'
const listingItems = `(?:(?:all(?: the)?|the) )?(?:selected )?${listingItem}(?: (?:and|&) ${listingItem})?`
const listingDirectory = '(?:(?:this|the|my|current|opened|selected) )?(?:(?:current|opened|selected) )?(?:directory|folder|dir)'
const listingLocation = `(?:(?:in|of|from) ${listingDirectory}|here)`
const listingPatterns = [
  new RegExp(`^(?:(?:list|show)(?: me)?|give me a list of) ${listingItems}(?: ${listingLocation})?$`),
  new RegExp(`^(?:what|which) ${listingItem} (?:are|is) ${listingLocation}$`),
  new RegExp(`^(?:what is|what's) in ${listingDirectory}$`),
]
function isMetadataListing(text: string): boolean {
  const normalized = text.replaceAll('’', "'").replace(/\s+/g, ' ').replace(/[?.!]+$/, '').trim()
    .replace(/^(?:(?:please|pls|plz) )?(?:(?:can|could|would|will) you )?(?:(?:please|pls|plz) )?/, '')
    .replace(/(?:,? (?:please|pls|plz))$/, '')
  return listingPatterns.some(pattern => pattern.test(normalized))
}
function oneEdit(a: string, b: string): boolean {
  if (Math.abs(a.length - b.length) > 1) return false
  let i = 0, j = 0, edits = 0
  while (i < a.length && j < b.length) {
    if (a[i] === b[j]) { i++; j++; continue }
    if (++edits > 1) return false
    if (a.length >= b.length) i++
    if (b.length >= a.length) j++
  }
  return edits + (a.length - i) + (b.length - j) <= 1
}
export function directoryRoute(task: string, scope: DirectorySelection): DirectoryRoute {
  const text = task.toLowerCase().trim()
  let intent: DirectoryIntent = 'general'
  if (/\b(?:list|show|name|what are)\b.*\b(?:knowledge tools|tool names|available tools|all tools)\b/.test(text)) intent = 'tools'
  else if (isMetadataListing(text)) intent = 'metadata'
  else if (/\b(?:edit|update|create|delete|remove|convert|format|save|write|merge|rename)\b|عدّل|احذف|أنشئ|編集|作成/.test(text)) intent = 'edit'
  else if (/\b(?:reviewed|approved|exact decimal|accounting|correlation|variance|quantile|statistical)\b/.test(text)) intent = 'reviewed'
  else if (scope.files.some(path => sheet.test(path)) && /\b(?:how many|count|sum|total|average|join|group by|compare|percentage)\b|كم عدد|件数|何人|合計/.test(text)) intent = 'table'
  else if (/\b(?:find|search|which file|contains?|exists|mention)\b|ابحث|どのファイル/.test(text)) intent = 'lookup'
  const matches = scope.files.filter(path => text.includes(name(path)))
  let target = matches.length === 1 ? matches[0] : undefined
  if (!target && !matches.length) {
    const tokens = text.match(/[\w()-]+\.(?:xlsx?|xlsm|csv|tsv|ods)\b/g) ?? []
    const close = scope.files.filter(path => tokens.some(token => oneEdit(token, name(path))))
    if (close.length === 1) target = close[0]
  }
  if (!target && scope.files.length === 1) target = scope.files[0]
  return { intent, target, prepareKnowledge: !!scope.files.length && ['table', 'lookup', 'general'].includes(intent),
    maxTurns: ['metadata', 'tools'].includes(intent) ? 12 : intent === 'edit' ? 60 : 32 }
}

/** Capability activation changes the next advertised schema set; it never changes file authority. */
export function routedDirectorySkill(route: DirectoryRoute, parts: { reader: AgentSkill; inspection: AgentSkill; analytics: AgentSkill; knowledge: AgentSkill; mutation: AgentSkill }): AgentSkill {
  const active = new Set<string>(['metadata'])
  if (route.intent === 'tools') active.add('knowledge')
  if (['lookup', 'general'].includes(route.intent)) { active.add('reading'); active.add('knowledge') }
  if (route.intent === 'table') active.add('knowledge')
  if (route.intent === 'reviewed') active.add('analysis')
  if (route.intent === 'edit') { active.add('editing'); active.add('reading') }
  const fullKnowledge = route.intent === 'general' || route.intent === 'tools'
  let expandedKnowledge = fullKnowledge
  const discover: AgentToolDef = { name: 'discover_file_tools', description: 'Activate additional file capabilities and return their schemas when the current tools are insufficient. Does not grant file access.', inputSchema: {
    type: 'object', properties: { capability: { type: 'string', enum: ['reading', 'analysis', 'editing', 'knowledge'] } }, required: ['capability'],
  } }
  const selectedParts = () => [
    { ...parts.reader, tools: parts.reader.tools.filter(t => active.has('reading') || t.name !== 'read_file') },
    ...(active.has('reading') ? [parts.inspection] : []),
    ...(active.has('analysis') ? [parts.analytics] : []),
    ...(active.has('knowledge') ? [{ ...parts.knowledge, tools: parts.knowledge.tools.filter(t => expandedKnowledge ||
      ['discover_knowledge_tools', 'use_knowledge_tool'].includes(t.name) ||
      (route.intent === 'table' ? ['spreadsheet_query_sql', 'spreadsheet_catalog_search', 'spreadsheet_describe_dataset'].includes(t.name) : /search|read_neighbors|get_document/.test(t.name))) }] : []),
    ...(active.has('editing') ? [parts.mutation] : []),
  ]
  const composed = () => composeSkills('directory', 'Use the smallest sufficient tool path. Tools can be activated with discover_file_tools if a capability is missing. Do not repeat identical reads when their evidence already answers the question. Cite returned RAG citation IDs as Markdown links; their registered source opens in the evidence viewer.', selectedParts())
  const repetitions = new Map<string, number>()
  return {
    id: 'directory',
    get systemPrompt() { return composed().systemPrompt },
    get tools() { return [...composed().tools, discover] },
    buildContext: () => composed().buildContext?.() ?? '',
    verifyResponse: (text, calls) => parts.mutation.verifyResponse?.(text, calls) ?? null,
    canExecuteParallel: call => ['list_directory', 'list_files', 'search_files'].includes(call.name),
    async executeTool(call, signal) {
      if (call.name === discover.name) {
        const capability = call.input?.capability
        if (typeof capability !== 'string' || !['reading', 'analysis', 'editing', 'knowledge'].includes(capability)) return { output: 'Choose reading, analysis, editing, or knowledge.', summary: 'Invalid capability', isError: true }
        active.add(capability); if (capability === 'knowledge') expandedKnowledge = true
        return { output: JSON.stringify({ capability, tools: composed().tools, guidance: composed().systemPrompt }), summary: `Enabled ${capability} tools`, mutated: false }
      }
      if (['read_file', 'search_contents', 'discover_datasets', 'describe_dataset', 'query_data', 'analyze_data', 'inspect_file', 'query_file', 'use_knowledge_tool'].includes(call.name) || call.name.startsWith('spreadsheet_')) {
        const key = JSON.stringify([call.name, call.input]), count = (repetitions.get(key) ?? 0) + 1
        repetitions.set(key, count)
        if (count > 3) return { output: 'This identical read was already attempted three times. Use the evidence, change the query/range, or report the unresolved limitation.', summary: 'Repeated read stopped', isError: true }
      }
      return composed().executeTool(call, signal)
    },
  }
}
