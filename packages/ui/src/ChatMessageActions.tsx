import { useEffect, useId, useLayoutEffect, useRef, useState, type ReactNode } from 'react'
import type { Lang } from '@genoffice/i18n'
import { IconBranch, IconCheck, IconCopy, IconPencil, IconRefresh, IconTrash } from './icons'
import './chat-management.css'

export const CHAT_LABELS = {
  en: {
    copy: 'Copy',
    copied: 'Copied',
    edit: 'Edit',
    save: 'Save & send',
    cancel: 'Cancel',
    more: 'Message actions',
    branch: 'Branch into new chat',
    remove: 'Delete from here',
    confirm: 'Delete',
    retry: 'Try again',
    regenerate: 'Regenerate answer',
    versions: 'Conversation versions',
    undo: 'Undo',
    undoChat: 'Undo chat change',
    explanation: 'Explanation only · No file changes',
    fileChanges: 'File changes',
    currentFiles: 'Uses current file versions',
    preserved: 'The original continuation is saved in conversation versions.',
    deleteCount: (n: number) =>
      `Remove ${n} exchange${n === 1 ? '' : 's'} from this point? File changes remain in your files.`,
    failed: 'Action failed. Try again.',
    newChat: 'New chat',
    history: 'Conversation history',
    archive: 'Archive',
    trash: 'Trash',
    restore: 'Restore',
    rename: 'Rename',
    export: 'Export Markdown',
    exportJson: 'Export JSON',
    title: 'Conversation title',
    saveTitle: 'Save title',
    permanent: 'Delete permanently',
    permanentHint: 'Permanently delete this conversation and its saved versions?',
    empty: 'No conversations here.',
    search: 'Search conversations',
    active: 'Active',
    archived: 'Archived',
    original: 'Original',
    pause: 'Queue paused. Resume when ready.',
  },
  ja: {
    copy: 'コピー',
    copied: 'コピー済み',
    edit: '編集',
    save: '保存して送信',
    cancel: 'キャンセル',
    more: 'メッセージの操作',
    branch: '新しいチャットに分岐',
    remove: 'ここから削除',
    confirm: '削除',
    retry: '再試行',
    regenerate: '回答を再生成',
    versions: '会話のバージョン',
    undo: '元に戻す',
    undoChat: '会話の変更を元に戻す',
    explanation: '説明のみ・ファイルの変更なし',
    fileChanges: 'ファイルの変更',
    currentFiles: '現在のファイルを使用',
    preserved: '元の会話はバージョンに保存されます。',
    deleteCount: (n: number) =>
      `ここから ${n} 件のやり取りを削除しますか？ファイルの変更は保持されます。`,
    failed: '操作に失敗しました。再試行してください。',
    newChat: '新しいチャット',
    history: '会話履歴',
    archive: 'アーカイブ',
    trash: 'ゴミ箱',
    restore: '復元',
    rename: '名前を変更',
    export: 'Markdown を書き出す',
    exportJson: 'JSON を書き出す',
    title: '会話のタイトル',
    saveTitle: 'タイトルを保存',
    permanent: '完全に削除',
    permanentHint: '会話と保存されたバージョンを完全に削除しますか？',
    empty: '会話がありません。',
    search: '会話を検索',
    active: '最近の会話',
    archived: 'アーカイブ済み',
    original: '元の会話',
    pause: '待機を一時停止しました。準備ができたら再開してください。',
  },
  ar: {
    copy: 'نسخ',
    copied: 'تم النسخ',
    edit: 'تعديل',
    save: 'حفظ وإرسال',
    cancel: 'إلغاء',
    more: 'إجراءات الرسالة',
    branch: 'تفريع إلى محادثة جديدة',
    remove: 'حذف من هنا',
    confirm: 'حذف',
    retry: 'إعادة المحاولة',
    regenerate: 'إعادة إنشاء الإجابة',
    versions: 'إصدارات المحادثة',
    undo: 'تراجع',
    undoChat: 'تراجع عن تغيير المحادثة',
    explanation: 'شرح فقط · دون تغيير الملفات',
    fileChanges: 'تغييرات الملفات',
    currentFiles: 'تستخدم إصدارات الملفات الحالية',
    preserved: 'تم حفظ المتابعة الأصلية في إصدارات المحادثة.',
    deleteCount: (n: number) => `حذف ${n} من التبادلات من هذه النقطة؟ تبقى تغييرات الملفات محفوظة.`,
    failed: 'تعذر تنفيذ الإجراء. حاول مجدداً.',
    newChat: 'محادثة جديدة',
    history: 'سجل المحادثات',
    archive: 'أرشفة',
    trash: 'المحذوفات',
    restore: 'استعادة',
    rename: 'إعادة تسمية',
    export: 'تصدير Markdown',
    exportJson: 'تصدير JSON',
    title: 'عنوان المحادثة',
    saveTitle: 'حفظ العنوان',
    permanent: 'حذف نهائي',
    permanentHint: 'هل تريد حذف المحادثة وإصداراتها المحفوظة نهائياً؟',
    empty: 'لا توجد محادثات هنا.',
    search: 'البحث في المحادثات',
    active: 'النشطة',
    archived: 'المؤرشفة',
    original: 'الأصلية',
    pause: 'تم إيقاف قائمة الانتظار مؤقتاً. استأنف عندما تكون جاهزاً.',
  },
} satisfies Record<Lang, object>

export function ChatMessageActions({
  text,
  lang = 'en',
  disabled,
  deleteCount = 1,
  onEdit,
  onRetry,
  onRegenerate,
  onBranch,
  onDelete,
  renderMessage,
}: {
  text: string
  lang?: Lang | undefined
  disabled?: boolean | undefined
  deleteCount?: number | undefined
  onEdit?: ((text: string) => void | Promise<void>) | undefined
  onRetry?: (() => void | Promise<void>) | undefined
  onRegenerate?: (() => void | Promise<void>) | undefined
  onBranch?: (() => void | Promise<void>) | undefined
  onDelete?: (() => void | Promise<void>) | undefined
  renderMessage?: ((editor: ReactNode) => ReactNode) | undefined
}) {
  const labels = CHAT_LABELS[lang]
  const [editing, setEditing] = useState(false),
    [draft, setDraft] = useState(text)
  const [confirming, setConfirming] = useState(false),
    [pending, setPending] = useState(false)
  const [copied, setCopied] = useState(false),
    [error, setError] = useState('')
  const input = useRef<HTMLTextAreaElement>(null)
  const formId = useId()
  useLayoutEffect(() => {
    if (!editing || !input.current) return
    input.current.style.height = '0px'
    input.current.style.height = `${input.current.scrollHeight}px`
  }, [editing, draft])
  useEffect(() => {
    if (editing) input.current?.focus()
  }, [editing])
  useEffect(() => {
    if (!copied) return
    const timer = setTimeout(() => setCopied(false), 1500)
    return () => clearTimeout(timer)
  }, [copied])
  const perform = async (work: () => void | Promise<void>) => {
    if (pending || disabled) return
    setPending(true)
    setError('')
    try {
      await work()
      setEditing(false)
      setConfirming(false)
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : labels.failed)
    } finally {
      setPending(false)
    }
  }
  const editor = editing && (
    <form
      id={formId}
      className="chat-question-edit"
      onSubmit={(event) => {
        event.preventDefault()
        if (draft.trim() && onEdit) void perform(() => onEdit(draft.trim()))
      }}
    >
      <textarea
        ref={input}
        aria-label={labels.edit}
        value={draft}
        disabled={pending || disabled}
        dir="auto"
        rows={1}
        onChange={(event) => setDraft(event.target.value)}
        onKeyDown={(event) => {
          if (event.key === 'Escape' && !pending) {
            event.stopPropagation()
            setEditing(false)
          }
        }}
      />
    </form>
  )
  const controls = (
    <div className="chat-message-actions" dir={lang === 'ar' ? 'rtl' : undefined}>
      {!renderMessage && editor}
      {editing ? (
        <div className="chat-question-edit-controls">
          <p>{labels.preserved}</p>
          <div>
            <button type="button" disabled={pending} onClick={() => setEditing(false)}>
              {labels.cancel}
            </button>
            <button type="submit" form={formId} disabled={pending || disabled || !draft.trim()}>
              {labels.save}
            </button>
          </div>
        </div>
      ) : (
        <div className="chat-message-tools" role="group" aria-label={labels.more}>
          <button
            type="button"
            className="chat-message-icon"
            aria-label={copied ? labels.copied : labels.copy}
            data-tip={copied ? labels.copied : labels.copy}
            onClick={() => {
              void navigator.clipboard
                .writeText(text)
                .then(() => setCopied(true))
                .catch(() => setError(labels.failed))
            }}
          >
            {copied ? <IconCheck /> : <IconCopy />}
          </button>
          {onEdit && (
            <button
              type="button"
              className="chat-message-icon"
              aria-label={labels.edit}
              data-tip={labels.edit}
              disabled={disabled || pending}
              onClick={() => {
                setDraft(text)
                setEditing(true)
                setConfirming(false)
              }}
            >
              <IconPencil />
            </button>
          )}
          {onRetry && (
            <button
              type="button"
              className="chat-message-icon"
              aria-label={labels.retry}
              data-tip={labels.retry}
              disabled={disabled || pending}
              onClick={() => void perform(onRetry)}
            >
              <IconRefresh />
            </button>
          )}
          {onRegenerate && (
            <button
              type="button"
              className="chat-message-icon"
              aria-label={labels.regenerate}
              data-tip={labels.regenerate}
              disabled={disabled || pending}
              onClick={() => void perform(onRegenerate)}
            >
              <IconRefresh />
            </button>
          )}
          {onBranch && (
            <button
              type="button"
              className="chat-message-icon"
              aria-label={labels.branch}
              data-tip={labels.branch}
              disabled={disabled || pending}
              onClick={() => void perform(onBranch)}
            >
              <IconBranch />
            </button>
          )}
          {onDelete && (
            <button
              type="button"
              className="chat-message-icon chat-destructive"
              aria-label={labels.remove}
              data-tip={labels.remove}
              disabled={disabled || pending}
              onClick={() => {
                setConfirming(true)
                setEditing(false)
              }}
            >
              <IconTrash />
            </button>
          )}
        </div>
      )}
      {confirming && (
        <div className="chat-message-edit" role="group" aria-label={labels.remove}>
          <p>{labels.deleteCount(deleteCount)}</p>
          <button type="button" disabled={pending} onClick={() => setConfirming(false)}>
            {labels.cancel}
          </button>
          <button
            type="button"
            className="chat-destructive"
            disabled={disabled || pending}
            onClick={() => onDelete && void perform(onDelete)}
          >
            {labels.confirm}
          </button>
        </div>
      )}
      {error && <p role="alert">{error}</p>}
    </div>
  )
  return renderMessage ? (
    <div className={`chat-question-row${editing ? ' chat-question-row-editing' : ''}`}>
      {renderMessage(editor || null)}
      {controls}
    </div>
  ) : (
    controls
  )
}
