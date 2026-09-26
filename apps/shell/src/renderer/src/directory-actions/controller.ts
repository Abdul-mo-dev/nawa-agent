import { AgentLoop, type AgentSkill, type AgentTransport } from '@genoffice/agent-core'
import type { DirectoryActionsApi, DirectoryApproval, DirectoryProposal, DirectoryCommit } from '../../../shared/directory-actions-api'
import { resolveSelectionPath, type DirectorySelection } from '../ai/directory-selection'

export interface ApprovalView { key: number; phase: 'prepare' | 'save'; proposal: DirectoryApproval }
/** Only UI buttons resolve this approval; there is no approve tool in either agent's tool catalog. */
export class ApprovalController {
  private state: ApprovalView | null = null
  private listeners = new Set<() => void>()
  private waiting: ((approved: boolean) => void) | null = null
  private sequence = 0
  subscribe = (listener: () => void) => { this.listeners.add(listener); return () => { this.listeners.delete(listener) } }
  getSnapshot = () => this.state
  request(proposal: DirectoryApproval, phase: ApprovalView['phase']): Promise<boolean> {
    if (this.waiting) throw new Error('Another file approval is already pending.')
    return new Promise(resolve => {
      this.waiting = resolve; this.state = { key: ++this.sequence, phase, proposal }
      this.listeners.forEach(listener => listener())
    })
  }
  decide(key: number, approved: boolean): void {
    if (this.state?.key !== key) return
    const done = this.waiting; this.waiting = null; this.state = null
    this.listeners.forEach(listener => listener()); done?.(approved)
  }
  cancel(): void { if (this.state) this.decide(this.state.key, false) }
}

export class DirectoryActionClient {
  private runPromise: Promise<string> | null = null
  private child: AgentLoop | null = null
  private cancelled = false
  private abortChild: (() => void) | null = null
  constructor(private options: {
    api: DirectoryActionsApi
    selection: DirectorySelection
    approvals: ApprovalController
    transport: () => AgentTransport
    current(): boolean
    activity(text: string): void
    committed(result: DirectoryCommit): void
  }) {}
  private check(): void {
    if (this.cancelled || !this.options.current()) throw new Error('File action cancelled because the chat, model, or selection changed.')
  }
  cancel(): void {
    this.cancelled = true; this.options.approvals.cancel()
    const child = this.child; this.child = null
    this.abortChild?.(); this.abortChild = null
    try { child?.reset() } catch (cause) { console.warn('Nawa: staged agent cleanup failed.', cause) }
    if (this.runPromise) void this.runPromise.then(id => this.options.api.cancel(id)).catch(() => undefined)
  }
  private run(): Promise<string> {
    this.check()
    return this.runPromise ??= this.options.api.begin({
      opened: this.options.selection.opened,
      files: [...this.options.selection.files], directories: [...this.options.selection.directories],
    })
  }
  async perform(request: DirectoryProposal, signal?: AbortSignal): Promise<string> {
    const abort = () => this.cancel()
    if (signal?.aborted) throw new Error('File action cancelled.')
    signal?.addEventListener('abort', abort, { once: true })
    let id: string | undefined
    try {
      const run = await this.run(); this.check()
      const proposal = await this.options.api.propose(run, request); id = proposal.id; this.check()
      if (!await this.options.approvals.request(proposal, 'prepare')) return 'The user declined the file action. No original file was changed. Do not retry this action without a new user request.'
      this.check()
      this.options.activity(request.operation === 'delete' ? 'Moving approved file to the Recycle Bin…' : 'Preparing a copy in the native editor…')
      const description = await this.options.api.prepare(id); this.check()
      let summary = ''
      if (request.operation !== 'delete') {
        if (!description) throw new Error('The native editor did not supply its tools.')
        summary = await new Promise<string>((resolve, reject) => {
          let settled = false
          const done = (text: string, cause?: Error) => {
            if (settled) return; settled = true; clearTimeout(timer)
            this.abortChild = null; this.child = null
            cause ? reject(cause) : resolve(text)
          }
          const timer = setTimeout(() => {
            try { this.child?.reset() } catch (cause) { console.warn('Nawa: staged timeout cleanup failed.', cause) }
            finally { done('', new Error('Native editing exceeded the five-minute limit. Nothing was saved to the original.')) }
          }, 300000)
          this.abortChild = () => done('', new Error('Native editing cancelled.'))
          const loop = new AgentLoop({
            transport: this.options.transport(), maxTurns: 18, maxHistory: 30, compaction: false,
            skill: {
              id: `directory-native-${description.kind}`,
              systemPrompt: description.systemPrompt + '\nYou are editing a private staging copy of one document. Use only the provided in-document tools. Network/media/other-file/export tools are intentionally unavailable. Work on the current staged document; do not create another file. Read the document with the native tools before editing; apply changes, then summarize accurately. The original is NOT saved yet; the user must approve a separate save. Never say the original has been changed.',
              tools: description.tools,
              buildContext: () => description.context,
              executeTool: async call => { this.check(); const result = await this.options.api.execute(proposal.id, call); this.check(); return result },
            },
            events: {
              onToolStart: call => this.options.activity(`Native ${description.kind} editor: ${call.name}`),
              onDone: result => result.cancelled ? done('', new Error('Native editing cancelled.')) : done(result.text),
              onError: message => done('', new Error(message)),
            },
          })
          this.child = loop
          try { loop.run(request.instruction) } catch (cause) { loop.reset(); done('', cause instanceof Error ? cause : new Error(String(cause))) }
        })
        this.check()
        this.options.activity('Saving and comparing the staged copy…')
        const preview = await this.options.api.preview(id); this.check()
        if (!await this.options.approvals.request(preview, 'save')) return 'The user discarded the staged result. The original file was not changed. Do not retry without a new user request.'
        this.check()
      }
      const result = await this.options.api.commit(id)
      this.options.committed(result)
      return JSON.stringify({ status: 'committed', ...result, summary })
    } finally {
      signal?.removeEventListener('abort', abort)
      if (id) await this.options.api.discard(id).catch(() => undefined)
    }
  }
}

export function directoryMutationSkill(client: DirectoryActionClient, scope: DirectorySelection): AgentSkill {
  return {
    id: 'approved-directory-files',
    systemPrompt: 'You can propose updates, creation, or deletion using update_file, create_file, delete_file. These are approval-gated, NOT automatic writes. Updates and deletions require an individually selected file. Creation requires an opened or explicitly selected folder. The native editor works on a staged copy using the same core editing tools as its normal file chat. The user approves preparing the action and separately approves saving edits/creation. Deletion uses one explicit Recycle Bin approval. Never say a file changed unless the tool returns status=committed. Respect rejection; do not retry a rejected action in this turn. Do not claim unsupported operations succeeded.',
    tools: [
      { name: 'update_file', description: 'Propose editing a selected individual file with its native editor; user approval is required. Give an exact, self-contained edit instruction.', inputSchema: { type: 'object', properties: { path: { type: 'string' }, instruction: { type: 'string' } }, required: ['path','instruction'] } },
      { name: 'create_file', description: 'Propose a new DOCX, XLSX, PPTX, PDF, Markdown or HTML document directly in an opened or selected directory. Never overwrites an existing filename.', inputSchema: { type: 'object', properties: { directory: { type: 'string' }, name: { type: 'string' }, instruction: { type: 'string' } }, required: ['directory','name','instruction'] } },
      { name: 'delete_file', description: 'Propose moving one explicitly selected file to the Recycle Bin. Requires user approval, never permanently deletes.', inputSchema: { type: 'object', properties: { path: { type: 'string' }, reason: { type: 'string' } }, required: ['path','reason'] } },
    ],
    async executeTool(call, signal) {
      try {
        if (!['create_file', 'update_file', 'delete_file'].includes(call.name)) throw new Error('Unknown directory action tool.')
        const args = call.input as Record<string, unknown>
        if (!args || typeof args !== 'object') throw new Error('Invalid file action arguments.')
        let request: DirectoryProposal
        if (call.name === 'create_file') {
          const directory = resolveSelectionPath(scope, args.directory, 'directory')
          if (!directory || typeof args.name !== 'string' || !args.name || /[<>:"/\\|?*\x00-\x1f]/.test(args.name) || args.name === '.' || args.name === '..' || typeof args.instruction !== 'string') throw new Error('Choose the opened/selected directory, a plain filename, and an instruction.')
          const separator = directory.includes('\\') ? '\\' : '/'
          request = { operation: 'create', path: directory.replace(/[\\/]+$/, '') + separator + args.name, instruction: args.instruction }
        } else {
          const path = resolveSelectionPath(scope, args.path, 'file')
          if (!path) throw new Error('Select the individual target file in the main panel first.')
          const instruction = call.name === 'delete_file' ? args.reason : args.instruction
          if (typeof instruction !== 'string' || !instruction.trim()) throw new Error('An explicit instruction or reason is required.')
          request = { operation: call.name === 'delete_file' ? 'delete' : 'update', path, instruction }
        }
        const output = await client.perform(request, signal)
        return { output, summary: output.startsWith('{') ? `${request.operation}: ${request.path}` : 'User declined the file action.', mutated: output.startsWith('{') }
      } catch (cause) { const message = cause instanceof Error ? cause.message : String(cause); return { output: message, summary: message, isError: true, mutated: false } }
    },
  }
}
