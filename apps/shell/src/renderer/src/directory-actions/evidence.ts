import type { AgentMessage } from '@genoffice/agent-core'
import type { HistoryMessage } from '../../../shared/conversation-api'
import type { DirectoryCommit } from '../../../shared/directory-actions-api'

export function actionClaimCorrection(text: string, receipts: readonly DirectoryCommit[], selectedPaths: readonly string[] = []): string | null {
  // Only explicit completed-action claims. Descriptions, negatives and proposed changes are not claims.
  const claims = text.split(/(?<=[.!?])\s+|\n/).filter(sentence => !/\b(?:not|no|never|cannot|can't|couldn't|would|will|should|need|pending|declined|discarded)\b/i.test(sentence) &&
    /\b(?:(?:I|we)(?:'ve| have)?\s+(?:successfully\s+)?(?:updated|created|deleted|saved|changed|converted|removed)|(?:changes|file|document|workbook)\s+(?:were|was|has been|have been)\s+(?:successfully\s+)?(?:saved|updated|created|changed|deleted|removed))\b/i.test(sentence))
  const pathKey = (path: string) => path.replaceAll('\\', '/').toLowerCase()
  for (const claim of claims) {
    const operation = /\b(?:deleted|removed)\b/i.test(claim) ? 'delete' : /\bcreated\b/i.test(claim) ? 'create' : 'write'
    const matching = receipts.filter(receipt => operation === 'write' ? receipt.operation !== 'delete' : receipt.operation === operation)
    const named = selectedPaths.filter(path => claim.toLowerCase().includes(pathKey(path).split('/').pop()!))
    if (!matching.length || named.some(path => !matching.some(receipt => pathKey(receipt.path) === pathKey(path))))
      return 'No file commit receipt exists for the claimed action and target in this request. Describe only the confirmed commit receipts; identify declined or unsaved actions accurately.'
  }
  return null
}

export function historyCandidates(messages: readonly HistoryMessage[], contextKey: string) {
  return messages.filter(m => m.role === 'assistant' && m.contextKey === contextKey && m.request?.phase === 'final' &&
    m.request.outcome === 'completed' && !m.error && !m.streaming && m.request.evidence)
    .slice(-20).map(m => ({ id: m.request!.id, evidence: m.request!.evidence!, citations: m.citations }))
}

export function restoreCompletedHistory(messages: readonly HistoryMessage[], contextKey: string, accepted: readonly string[]): AgentMessage[] {
  const allowed = new Set(accepted)
  const result: AgentMessage[] = []
  for (const message of messages) {
    const request = message.request
    if (!request || message.contextKey !== contextKey || !allowed.has(request.id) || request.outcome !== 'completed' ||
        message.error || message.streaming || !message.text || !['user', 'final'].includes(request.phase)) continue
    if (request.phase === 'user') result.push({ role: 'user', text: message.text })
    else result.push({ role: 'assistant', text: message.text })
  }
  return result.slice(-40)
}

/** Preserve intent without presenting old actions as outstanding instructions or old answers as current facts. */
export function historicalIntent(messages: readonly HistoryMessage[]): string {
  return messages.filter(m => m.role === 'user').slice(-4).map(m => m.text.slice(0, 800)).join('\n')
}
