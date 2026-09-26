import type { AgentSkill, ExecutedToolCall } from './skill'
import type { AgentToolCall, AgentToolDef, ToolExecution } from './types'
import { directoryTools, DIRECTORY_PROTOCOL_VERSION, type DirectorySessionMode } from './directory-capabilities'
import { bindDirectoryWorkflow, cancelDirectoryWorkflow, directoryWorkflowStatus, replyDirectoryWorkflow, directoryPrompt,
  type DirectoryWorkflowOptions, type DirectoryInteractionReply } from './directory-workflow'

export interface DirectoryEditorDescription {
  kind: string
  systemPrompt: string
  context: string
  tools: AgentToolDef[]
  protocolVersion?: number
  mode?: DirectorySessionMode
  capabilities?: { verification: boolean; lifecycle: boolean }
}
interface Command {
  id: string; path: string; command: 'describe' | 'execute' | 'verify' | 'cancel' | 'poll' | 'respond'
  call?: AgentToolCall; mode?: DirectorySessionMode; text?: string
  workflow?: DirectoryWorkflowOptions; response?: DirectoryInteractionReply
}
interface Bridge {
  onCommand(handler: (command: Command) => void): () => void
  reply(id: string, result: unknown, error?: string): void
}
interface NativeLoop {
  busy: boolean
  directorySkill: AgentSkill
  directorySystemSuffix?: string
  resetDirectorySession?(): void
  executeDirectoryTool?(call: AgentToolCall, signal?: AbortSignal): Promise<ToolExecution>
}
interface Binding {
  path: string | null | undefined
  kind: string
  loop: NativeLoop | null
  settle?: () => Promise<void>
  configure?: (options: DirectoryWorkflowOptions) => void | Promise<void>
}
const same = (a: string, b: string) => {
  const clean = (p: string) => p.replace(/\\/g, '/')
  const left = clean(a), right = clean(b)
  return /^[a-z]:\//i.test(left) || left.startsWith('//') ? left.toLowerCase() === right.toLowerCase() : left === right
}

/** One immutable mode per private editor. A read session can NEVER upgrade to editing. */
export function registerDirectoryEditor(getBinding: () => Binding): () => void {
  const bridge = (window as unknown as { nawaEditorBridge?: Bridge }).nawaEditorBridge
  if (!bridge) return () => {}
  let disposed = false, cancelled = false
  let controller: AbortController | null = null
  let mode: DirectorySessionMode | null = null
  let workflow: DirectoryWorkflowOptions | undefined
  let configuration: Promise<void> | null = null
  const executed: ExecutedToolCall[] = []
  const unsubscribe = bridge.onCommand(request => {
    if (!request || typeof request.id !== 'string' || typeof request.path !== 'string') return
    const binding = getBinding()
    if (!binding.path || !same(binding.path, request.path)) {
      bridge.reply(request.id, null, 'Editor is not ready for this staging file.'); return
    }
    if (request.command === 'cancel') { cancelled = true; controller?.abort(); cancelDirectoryWorkflow(); return }
    void (async () => {
      if (disposed || cancelled) throw new Error('Staged editor session was cancelled.')
      if (!binding.loop) throw new Error('Editor is not ready for this staging file.')
      if (request.command === 'poll') return directoryWorkflowStatus()
      if (request.command === 'respond') {
        if (!workflow || !request.response) throw new Error('No active workflow question.')
        replyDirectoryWorkflow(request.response); return { ok: true }
      }
      if (binding.loop.busy || controller) throw new Error('The editor is busy. Try again after its current operation.')
      if (request.command === 'describe') {
        if (request.mode !== 'read' && request.mode !== 'edit') throw new Error('An explicit native session mode is required. Rebuild Nawa.')
        if (mode && mode !== request.mode) throw new Error('A read-only session cannot be upgraded to an editing session.')
        if (!mode) {
          mode = request.mode; binding.loop.resetDirectorySession?.()
          if (request.workflow) {
            if (mode !== 'edit' || !binding.configure) throw new Error('Editor workflow adapter is missing. Rebuild all editors.')
            workflow = structuredClone(request.workflow)
            bindDirectoryWorkflow(workflow)
            configuration = Promise.resolve(binding.configure(workflow))
            await configuration
          }
        } else if (request.workflow && JSON.stringify(request.workflow) !== JSON.stringify(workflow)) {
          throw new Error('Workflow grants cannot change after preparation.')
        }
      }
      if (configuration) await configuration
      if (disposed || cancelled) throw new Error('Staged editor session was cancelled.')
      if (!mode) throw new Error('Describe the native session before executing tools.')
      const skill = binding.loop.directorySkill
      const tools = directoryTools(binding.kind, mode, skill.tools, workflow)
      if (!tools.length) throw new Error('This editor exposes no permitted tools for this session mode.')
      if (request.command === 'describe') return {
        protocolVersion: DIRECTORY_PROTOCOL_VERSION, mode, kind: binding.kind,
        systemPrompt: directoryPrompt([skill.systemPrompt, binding.loop.directorySystemSuffix].filter(Boolean).join('\n'), skill.tools.map(t => t.name), tools.map(t => t.name), mode),
        context: [skill.buildContext?.() ?? '', workflow?.sources.length ? JSON.stringify({ approvedReferences: workflow.sources, note: 'Only these private copies may be used as attached source files. Images are not automatically vision inputs.' }) : ''].filter(Boolean).join('\n'), tools,
        capabilities: { verification: !!skill.verifyResponse, lifecycle: !!binding.loop.executeDirectoryTool },
      } satisfies DirectoryEditorDescription
      if (request.command === 'verify') {
        if (typeof request.text !== 'string' || request.text.length > 128000) throw new Error('Invalid response for verification.')
        // Use the native host's execution ledger, never a caller-supplied claim of success.
        return skill.verifyResponse?.(request.text, [...executed]) ?? null
      }
      if (request.command !== 'execute') throw new Error('Unknown editor command.')
      const call = request.call
      if (!call || typeof call.id !== 'string' || !tools.some(tool => tool.name === call.name)) throw new Error('Tool is not permitted in this directory session.')
      if (!binding.loop.executeDirectoryTool) throw new Error('Native lifecycle bridge is missing. Rebuild every editor and the shell.')
      const abort = new AbortController(); controller = abort
      try {
        const result = await binding.loop.executeDirectoryTool(call, abort.signal)
        await binding.settle?.()
        await new Promise(resolve => setTimeout(resolve, 40))
        if (abort.signal.aborted || disposed || cancelled) throw new Error('Staged edit was cancelled.')
        if (mode === 'read' && result.mutated) {
          cancelled = true
          throw new Error('A read-only native tool unexpectedly mutated its private copy; session revoked. The original was not saved.')
        }
        executed.push({ name: call.name, ok: !result.isError })
        return result
      } finally { if (controller === abort) controller = null }
    })().then(result => { if (!disposed) bridge.reply(request.id, result) }, cause => {
      if (!disposed) bridge.reply(request.id, null, cause instanceof Error ? cause.message : String(cause))
    })
  })
  return () => { disposed = true; controller?.abort(); cancelDirectoryWorkflow(); unsubscribe() }
}
