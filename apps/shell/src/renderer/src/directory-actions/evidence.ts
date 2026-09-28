import type { AgentMessage } from '@genoffice/agent-core'
import type { HistoryMessage } from '../../../shared/conversation-api'
import type { DirectoryCommit } from '../../../shared/directory-actions-api'

export function actionClaimCorrection(text: string, receipts: readonly DirectoryCommit[], selectedPaths: readonly string[] = []): string | null {
  // Only explicit completed-action claims. Descriptions, negatives and proposed changes are not claims.
  const claims = text.split(/(?<=[.!?])\s+|\n/).filter(sentence => !/\b(?:not|no|never|cannot|can't|couldn't|would|will|should|need|pending|declined|discarded)\b/i.test(sentence) &&
    /\b(?:(?:I|we)(?:'ve| have)?\s+(?:successfully\s+)?(?:permanently\s+)?(?:updated|created|deleted|saved|changed|converted|removed|renamed|moved|copied|duplicated)|(?:changes|file|folder|document|workbook)\s+(?:were|was|has been|have been)\s+(?:successfully\s+)?(?:permanently\s+)?(?:saved|updated|created|changed|deleted|removed|renamed|moved|copied|duplicated))\b/i.test(sentence))
  const pathKey = (path: string) => path.replaceAll('\\', '/').toLowerCase()
  for (const claim of claims) {
    const operations: DirectoryCommit['operation'][] = /\b(?:deleted|removed|Recycle Bin)\b/i.test(claim) ? ['delete', 'delete-folder', 'delete-permanently']
      : /\brenamed\b/i.test(claim) ? ['rename'] : /\bmoved\b/i.test(claim) ? ['move']
      : /\b(?:copied|duplicated)\b/i.test(claim) ? ['copy'] : /\bcreated\b/i.test(claim) ? ['create', 'create-folder'] : ['update', 'create']
    const matching = receipts.filter(receipt => !receipt.status && operations.includes(receipt.operation) &&
      (!/\bpermanently\b/i.test(claim) || receipt.permanent || receipt.operation === 'delete-permanently'))
    const named = [...new Set([...selectedPaths, ...receipts.flatMap(r => r.destination ? [r.destination] : [])])].filter(path => claim.toLowerCase().includes(pathKey(path).split('/').pop()!))
    if (!matching.length || named.some(path => !matching.some(receipt => [receipt.path, receipt.destination].some(p => p && pathKey(p) === pathKey(path)))))
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
