import type { Lang } from '@genoffice/i18n'

/** Labels for the queued-messages strip above the AI composer (all editors share them). */
export interface AiQueueStripLabels {
  /** collapsed strip title, e.g. "3 queued" */
  queuedCount: (n: number) => string
  clearTitle: string
  editTitle: string
  removeTitle: string
  /** hold the queue: the run in flight finishes, nothing after it starts */
  pauseTitle: string
  /** let the queue run again */
  resumeTitle: string
  /** strip hint while the gate is closed */
  pausedHint: string
  /** row tooltip: press and drag to change the order (Alt+arrows for keyboards) */
  moveTitle: string
  /** composer placeholder while a reply runs and Enter queues instead of sending */
  queuePlaceholder: string
}

export const AI_QUEUE_LABELS: Record<Lang, AiQueueStripLabels> = {
  en: {
    queuedCount: (n) => `${n} queued · not sent`,
    clearTitle: 'Clear queued messages',
    editTitle: 'Edit queued message',
    removeTitle: 'Remove queued message',
    pauseTitle: 'Pause the queue',
    resumeTitle: 'Resume the queue',
    pausedHint: 'Paused',
    moveTitle: 'Drag to reorder (or Alt+↑/↓)',
    queuePlaceholder: 'Enter to queue · Esc to stop',
  },
  ja: {
    queuedCount: (n) => `${n} 件が待機中・未送信`,
    clearTitle: '待機中のメッセージを削除',
    editTitle: '待機中のメッセージを編集',
    removeTitle: '待機中のメッセージを取り除く',
    pauseTitle: '待機を一時停止',
    resumeTitle: '待機を再開',
    pausedHint: '一時停止中',
    moveTitle: 'ドラッグで並べ替え（または Alt+↑/↓）',
    queuePlaceholder: 'Enter で待機 · Esc で停止',
  },
  ar: {
    queuedCount: (n) => `${n} في قائمة الانتظار · لم ترسل بعد`,
    clearTitle: 'إفراغ الرسائل المنتظرة',
    editTitle: 'تعديل الرسالة المنتظرة',
    removeTitle: 'إزالة الرسالة المنتظرة',
    pauseTitle: 'إيقاف الانتظار مؤقتًا',
    resumeTitle: 'متابعة الانتظار',
    pausedHint: 'موقوف مؤقتًا',
    moveTitle: 'اسحب لإعادة الترتيب (أو Alt+↑/↓)',
    queuePlaceholder: 'Enter للانتظار · Esc للإيقاف',
  },
}
