import type { AgentToolCall, ToolExecution } from '@genoffice/agent-core'
import type { DirectoryActivity, DirectoryActivityStep, ActivityStatus } from '../../../shared/directory-activity'

const MAX_STEPS = 100
const SECRET = /^(?:.*(?:api.?key|password|secret|authorization|credential|access.?token|refresh.?token)|headers)$/i

/** Best-effort credential redaction; file contents may still be present in bounded diagnostics. */
export function diagnosticText(value: unknown, limit = 2400): string {
  let raw: string
  try {
    const parsed = typeof value === 'string' ? (() => { try { return JSON.parse(value) } catch { return value } })() : value
    raw = typeof parsed === 'string' ? parsed : JSON.stringify(parsed, (key, item) => {
      if (SECRET.test(key)) return '[redacted]'
      // Provider results often wrap JSON in a content string. Redact inside that envelope too.
      if (typeof item === 'string' && /^[\s]*[\[{]/.test(item)) { try { return JSON.parse(item) } catch { /* Plain text. */ } }
      return item
    }, 2) ?? ''
  } catch { raw = '[Details unavailable]' }
  raw = raw.replace(/\b(Bearer\s+)\S+/gi, '$1[redacted]')
    .replace(/((?:api[-_]?key|password|secret|access[-_]?token|authorization)\s*[=:]\s*["']?)[^\s"'&,}]+/gi, '$1[redacted]')
    .replace(/(https?:\/\/)[^\s/@:]+:[^\s/@]+@/gi, '$1[redacted]@')
    .replace(/data:[^;\s]+;base64,[a-z\d+/=]+/gi, '[image/data omitted]')
  return raw.length > limit ? raw.slice(0, limit) + '\n[Details truncated]' : raw
}

export function activityTargets(input: unknown): string[] {
  if (!input || typeof input !== 'object') return []
  const args = input as Record<string, unknown>
  return [...new Set([args.path, args.directory, ...(Array.isArray(args.paths) ? args.paths : []),
    ...(Array.isArray(args._nawaFiles) ? args._nawaFiles : [])].filter((path): path is string => typeof path === 'string'))].slice(0, 6).map(path => path.slice(0, 320))
}

export function activityToolName(call: AgentToolCall): string {
  return call.name === 'use_knowledge_tool' && typeof call.input?.tool === 'string' ? call.input.tool : call.name
}

export function startActivityStep(activity: DirectoryActivity, step: DirectoryActivityStep): DirectoryActivity {
  const existing = activity.steps.filter(item => item.id !== step.id)
  const excess = Math.max(0, existing.length + 1 - MAX_STEPS)
  return { ...activity, steps: [...existing.slice(excess), step], omitted: activity.omitted + excess }
}

/** Typed summaries survive raw-output truncation; never retain arbitrary result objects here. */
export function activityFacts(output: unknown): Record<string, unknown> | undefined {
  let value: any
  try { value = typeof output === 'string' ? JSON.parse(output) : output } catch { return undefined }
  if (!value || typeof value !== 'object') return undefined
  const facts: Record<string, unknown> = {}
  for (const key of ['tool', 'backend', 'succeeded', 'status', 'cacheHit', 'resultId', 'available', 'loadedTools', 'sourceCount', 'durationMs', 'httpRequests', 'firstEventMs', 'returnedToolCalls', 'advertisedTools', 'stopReason', 'changedMessages', 'removedMessages', 'payloadChars', 'acceptedRequests', 'checkedRequests'])
    if (typeof value[key] === 'boolean' || typeof value[key] === 'number' || typeof value[key] === 'string') facts[key] = typeof value[key] === 'string' ? value[key].slice(0, 200) : value[key]
  if (value.diagnostics) facts.diagnostics = { httpRequests: value.diagnostics.httpRequests, durationMs: value.diagnostics.durationMs }
  if (value.coverage) facts.coverage = { selected: value.coverage.selected, requested: value.coverage.requested?.length,
    covered: value.coverage.covered?.length, completeSelection: value.coverage.completeSelection }
  const sources = value.sources ?? value.evidence
  if (Array.isArray(sources)) {
    facts.sourceCount = sources.length
    facts.sources = sources.slice(0, 12).map(source => ({ path: String(source.path ?? '').slice(0, 500),
      hash: source.contentHash ?? source.sourceHash ?? source.hash, indexRevision: source.indexRevision ?? source.myAgent?.indexRevision,
      datasetRevision: source.datasetRevision ?? source.myAgent?.datasetRevision }))
  }
  if (Array.isArray(value.warnings)) facts.warnings = value.warnings.slice(0, 8).map((warning: unknown) => String(warning).slice(0, 400))
  let content: any
  try { content = typeof value.content === 'string' ? JSON.parse(value.content) : value } catch { content = value }
  for (const key of ['resultId', 'analysisId', 'Truncated', 'truncated', 'nextOffset', 'nextRowOffset', 'totalRows', 'RowCount', 'ReturnedRowCount', 'ElapsedMilliseconds']) {
    const field = content?.[key] ?? content?.result?.[key]
    if (field != null && ['string','number','boolean'].includes(typeof field)) facts[key] = typeof field === 'string' ? field.slice(0, 200) : field
  }
  const rows = content?.rows ?? content?.Rows ?? content?.result?.Rows
  if (Array.isArray(rows)) facts.returnedRows = rows.length
  if (!Object.keys(facts).length) return undefined
  try { return JSON.parse(diagnosticText(facts, 16000)) }
  catch { return { sourceCount: facts.sourceCount, detailsOmitted: true } }
}

export function finishActivityStep(activity: DirectoryActivity, id: string, status: ActivityStatus, summary: string, output?: unknown): DirectoryActivity {
  let result: Record<string, unknown> | undefined
  try { result = typeof output === 'string' ? JSON.parse(output) : output as Record<string, unknown> } catch { /* Plain-text result. */ }
  const sources = Array.isArray(result?.sources) ? result.sources.flatMap(source => source && typeof source.path === 'string' ? [source.path] : []) : []
  const targets = [...activityTargets(result), ...sources].slice(0, 6).map(path => path.slice(0, 320))
  return { ...activity, steps: activity.steps.map(step => step.id === id ? {
    ...step, status, finishedAt: Date.now(), summary: diagnosticText(summary, 360),
    targets: [...new Set([...step.targets, ...targets])].slice(0, 6),
    facts: activityFacts(output),
    ...(output !== undefined ? { output: diagnosticText(output) } : {}),
  } : step) }
}

export function finishActivity(activity: DirectoryActivity, status: ActivityStatus): DirectoryActivity {
  const finishedAt = Date.now()
  return { ...activity, status, finishedAt, steps: activity.steps.map(step => step.status === 'running' || step.status === 'waiting'
    ? { ...step, status: status === 'failed' ? 'failed' : 'cancelled', finishedAt } : step) }
}

export type NativeActivityEvent =
  | { type: 'start'; call: AgentToolCall }
  | { type: 'finish'; call: AgentToolCall; execution: ToolExecution }
  | { type: 'approval'; id: string; phase: 'prepare' | 'save'; path: string; approved?: boolean }

/** Publish at most one text update per frame, and flush before turn boundaries. */
export class TextFrameBuffer {
  private frame: number | null = null
  private latest: string | null = null
  constructor(private publish: (text: string) => void,
    private schedule: (callback: FrameRequestCallback) => number = callback => requestAnimationFrame(callback),
    private unschedule: (id: number) => void = id => cancelAnimationFrame(id)) {}
  push(text: string): void {
    this.latest = text
    if (this.frame === null) this.frame = this.schedule(() => { this.frame = null; this.flush() })
  }
  flush(): void {
    if (this.frame !== null) this.unschedule(this.frame)
    this.frame = null
    const text = this.latest; this.latest = null
    if (text !== null) this.publish(text)
  }
  discard(): void { if (this.frame !== null) this.unschedule(this.frame); this.frame = null; this.latest = null }
}
