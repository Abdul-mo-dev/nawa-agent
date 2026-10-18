import type { AgentRunResult } from './loop'

export type AgentRunOutcome = 'completed' | 'cancelled' | 'incomplete' | 'failed'
export type AgentRunNotice = 'stopped' | 'outputLimit' | 'turnLimit' | 'noReply'

/** One terminal-state policy for every chat adapter, independent of UI language. */
export function agentRunCompletion(result: AgentRunResult): {
  outcome: AgentRunOutcome
  notice?: AgentRunNotice
} {
  if (result.cancelled) return { outcome: 'cancelled', notice: 'stopped' }
  if (result.truncated) return { outcome: 'incomplete', notice: 'outputLimit' }
  if (result.turnLimit) return { outcome: 'incomplete', notice: 'turnLimit' }
  if (!result.text.trim()) return { outcome: 'incomplete', notice: 'noReply' }
  return { outcome: 'completed' }
}
