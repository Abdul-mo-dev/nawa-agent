import type { AgentSkill } from '@genoffice/agent-core'
import { resolveSelectionPath, type DirectorySelection } from '../ai/directory-selection'
import type { DirectoryActionClient } from './controller'

/** Lazy tool discovery avoids sending six complete editor tool catalogs every turn. */
export function directoryInspectionSkill(client: DirectoryActionClient, scope: DirectorySelection): AgentSkill {
  return {
    id: 'native-file-inspection',
    systemPrompt: `For selected Office files, prefer inspect_file and query_file for structured analysis. These are READ-ONLY: no edit approval is required and the original is never saved. Native tools can inspect workbook ranges, formulas, dependencies, formatting, document blocks or slide structure. inspect_file returns the exact tools for that format; query_file calls one with its real arguments. Use read_file only for plain-text extraction or when native inspection reports an unsupported format. Never pretend text extraction recalculates formulas or reveals image contents. Inspections read SAVED FILE SNAPSHOTS, not unsaved editor changes. Explain this distinction when relevant. Native inspection does not select anything in the user's visible editor. You may hold three inspections; use close_inspection to release one. When asking to edit based on other files, read the evidence first and pass self-contained target instructions to update_file/create_file. A selected folder never grants permission to inspect its children.`,
    tools: [
      { name: 'search_contents', description: 'Search content of ONLY the individually selected files using the local GenOffice FTS5 index (including CJK matching). Never searches unselected children. Returns bounded excerpts with source hashes; not OCR or a formula calculator. No external reranker call.', inputSchema: { type: 'object', properties: { query: { type: 'string', maxLength: 256 } }, required: ['query'] } },
      { name: 'inspect_file', description: 'Open a read-only native session for one selected file. Returns saved-file hash, document context and native read-tool definitions. Never edits or saves.', inputSchema: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'] } },
      { name: 'query_file', description: 'Run an advertised native read tool in a previously opened inspection. Use the exact returned tool name and arguments schema; mutations are rejected by main and native host.', inputSchema: { type: 'object', properties: { inspectionId: { type: 'string' }, tool: { type: 'string' }, arguments: { type: 'object', additionalProperties: true } }, required: ['inspectionId', 'tool', 'arguments'] } },
      { name: 'close_inspection', description: 'Release a native inspection to free its editor resources. Does not save the copy.', inputSchema: { type: 'object', properties: { inspectionId: { type: 'string' } }, required: ['inspectionId'] } },
    ],
    async executeTool(call, signal) {
      const abort = () => client.cancel()
      if (signal?.aborted) return { output: 'Cancelled.', summary: 'Native inspection cancelled', isError: true }
      signal?.addEventListener('abort', abort, { once: true })
      try {
        if (call.name === 'search_contents') {
          if (typeof call.input.query !== 'string') throw new Error('query is required')
          return { output: JSON.stringify(await client.searchContents(call.input.query)), summary: 'Searched selected file contents locally', mutated: false }
        }
        const args = call.input
        if (!args || typeof args !== 'object' || Array.isArray(args)) throw new Error('Native inspection arguments must be an object.')
        if (call.name === 'inspect_file') {
          const path = resolveSelectionPath(scope, args.path, 'file')
          if (!path) throw new Error('Select the individual file in the main panel first.')
          const description = await client.inspect(path)
          const { systemPrompt: _prompt, ...inventory } = description
          return { output: JSON.stringify(inventory), summary: `Inspected saved file: ${path}`, mutated: false }
        }
        if (typeof args.inspectionId !== 'string') throw new Error('inspectionId is required.')
        if (call.name === 'query_file') {
          if (typeof args.tool !== 'string' || !args.arguments || typeof args.arguments !== 'object' || Array.isArray(args.arguments)) throw new Error('A native tool name and arguments object are required.')
          const result = await client.query(args.inspectionId, args.tool, args.arguments as Record<string, unknown>)
          const max = 64000
          return { ...result, mutated: false, output: result.output.length > max ? result.output.slice(0, max) + '\n[Native output truncated; request a narrower range.]' : result.output }
        }
        if (call.name === 'close_inspection') {
          await client.closeInspection(args.inspectionId)
          return { output: 'Inspection closed without saving.', summary: 'Closed native inspection', mutated: false }
        }
        throw new Error('Unknown native inspection tool.')
      } catch (cause) { const text = cause instanceof Error ? cause.message : String(cause); return { output: text, summary: text, isError: true, mutated: false } }
      finally { signal?.removeEventListener('abort', abort) }
    },
  }
}
