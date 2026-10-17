import type { AgentMessage } from '@genoffice/agent-core'
import type { HistoryMessage } from '../../../shared/conversation-api'
import type { DirectoryCommit } from '../../../shared/directory-actions-api'

export function actionClaimCorrection(
  text: string,
  receipts: readonly DirectoryCommit[],
  selectedPaths: readonly string[] = [],
): string | null {
  // Only explicit completed-action claims. Descriptions, negatives and proposed changes are not claims.
  const claims = text
    .split(/(?<=[.!?])\s+|(?<=[。！？])\s*|\n/)
    .filter(
      (sentence) =>
        !/\b(?:not|no|never|cannot|can't|couldn't|would|will|should|need|pending|declined|discarded)\b|لم (?:يتم|أ|ا)|لن |لا يمكن|できません|していません|されていません|未保存|未删除|没有|无法/i.test(
          sentence,
        ) &&
        /\b(?:(?:I|we)(?:'ve| have)?\s+(?:successfully\s+)?(?:permanently\s+)?(?:updated|created|deleted|saved|changed|converted|removed|renamed|moved|copied|duplicated)|(?:changes|file|folder|document|workbook)\s+(?:were|was|has been|have been)\s+(?:successfully\s+)?(?:permanently\s+)?(?:saved|updated|created|changed|deleted|removed|renamed|moved|copied|duplicated))\b|(?:تم\s+|قمت\s+ب)(?:ال)?(?:حفظ|تحديث|إنشاء|انشاء|حذف|تغيير|تحويل|نقل|نسخ|إعادة تسمية)|(?:保存|更新|作成|削除|変更|変換|移動|コピー)(?:しました|されました|済み)|(?:已|已经)(?:保存|更新|创建|删除|修改|转换|移动|复制|重命名)/i.test(
          sentence,
        ),
    )
  const pathKey = (path: string) => path.replaceAll('\\', '/').toLowerCase()
  for (const claim of claims) {
    const operations: DirectoryCommit['operation'][] =
      /\b(?:deleted|removed|Recycle Bin)\b|حذف|削除|删除/i.test(claim)
        ? ['delete', 'delete-folder', 'delete-permanently']
        : /\brenamed\b|إعادة تسمية|名前.*変更|重命名/i.test(claim)
          ? ['rename']
          : /\bmoved\b|نقل|移動|移动/i.test(claim)
            ? ['move']
            : /\b(?:copied|duplicated)\b|نسخ|コピー|复制/i.test(claim)
              ? ['copy']
              : /\bcreated\b|إنشاء|انشاء|作成|创建/i.test(claim)
                ? ['create', 'create-folder']
                : ['update', 'create']
    const matching = receipts.filter(
      (receipt) =>
        !receipt.status &&
        operations.includes(receipt.operation) &&
        (!/\bpermanently\b/i.test(claim) ||
          receipt.permanent ||
          receipt.operation === 'delete-permanently'),
    )
    const named = [
      ...new Set([
        ...selectedPaths,
        ...receipts.flatMap((r) => (r.destination ? [r.destination] : [])),
      ]),
    ].filter((path) => claim.toLowerCase().includes(pathKey(path).split('/').pop()!))
    if (
      !matching.length ||
      named.some(
        (path) =>
          !matching.some((receipt) =>
            [
              receipt.path,
              receipt.destination,
              ...(operations.includes('create') && !operations.includes('update')
                ? [receipt.sourcePath]
                : []),
            ].some((p) => p && pathKey(p) === pathKey(path)),
          ),
      )
    )
      return 'No file commit receipt exists for the claimed action and target in this request. Describe only the confirmed commit receipts; identify declined or unsaved actions accurately.'
  }
  return null
}

export function historyCandidates(messages: readonly HistoryMessage[], contextKey: string) {
  return messages
    .filter(
      (m) =>
        m.role === 'assistant' &&
        m.contextKey === contextKey &&
        m.request?.phase === 'final' &&
        m.request.outcome === 'completed' &&
        !m.error &&
        !m.streaming &&
        m.request.evidence,
    )
    .slice(-20)
    .map((m) => ({ id: m.request!.id, evidence: m.request!.evidence!, citations: m.citations }))
}

export function restoreCompletedHistory(
  messages: readonly HistoryMessage[],
  contextKey: string,
  accepted: readonly string[],
): AgentMessage[] {
  const allowed = new Set(accepted)
  const result: AgentMessage[] = []
  for (const message of messages) {
    const request = message.request
    if (
      !request ||
      message.contextKey !== contextKey ||
      !allowed.has(request.id) ||
      request.outcome !== 'completed' ||
      message.error ||
      message.streaming ||
      !message.text ||
      !['user', 'final'].includes(request.phase)
    )
      continue
    if (request.phase === 'user') result.push({ role: 'user', text: message.text })
    else result.push({ role: 'assistant', text: message.text })
  }
  return result.slice(-40)
}

/** Preserve intent without presenting old actions as outstanding instructions or old answers as current facts. */
export function historicalIntent(messages: readonly HistoryMessage[]): string {
  return messages
    .filter((m) => m.role === 'user')
    .slice(-4)
    .map((m) => m.text.slice(0, 800))
    .join('\n')
}

/** Actual per-file outcomes, independent of model prose and overall request completion. */
export function actionCheckpoints(messages: readonly HistoryMessage[], contextKey: string) {
  return messages
    .filter(
      (message) =>
        message.contextKey === contextKey &&
        message.request?.phase === 'receipt' &&
        message.request.action,
    )
    .slice(-24)
    .map((message) => ({ at: message.createdAt, ...message.request!.action! }))
}

export function isResumeRequest(text: string): boolean {
  return /^(?:resume|continue|carry on|finish(?: the)? remaining (?:work|edits|actions)|استأنف|استأنف العمل|اكمل|أكمل|تابع|تابع العمل|続けて|再開|続きをお願いします|继续|继续执行)[.!。！\s]*$/iu.test(
    text.trim(),
  )
}
