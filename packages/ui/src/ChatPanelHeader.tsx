import type { ReactNode } from 'react'
import { htmlDir, type Lang } from '@genoffice/i18n'
import { CHAT_LABELS } from './ChatMessageActions'
import './chat-panel.css'

export function ChatNewButton({
  lang,
  onClick,
  disabled,
}: {
  lang: Lang
  onClick(): void
  disabled?: boolean | undefined
}) {
  const label = CHAT_LABELS[lang].newChat
  return (
    <button
      type="button"
      className="ai-header-btn nawa-chat-new"
      aria-label={label}
      data-tip={label}
      disabled={disabled}
      onClick={onClick}
    >
      <svg
        width="16"
        height="16"
        viewBox="0 0 16 16"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.25"
        strokeLinecap="round"
        strokeLinejoin="round"
        aria-hidden="true"
      >
        <path d="M7 2.5H3A1.5 1.5 0 0 0 1.5 4v7A1.5 1.5 0 0 0 3 12.5h2V15l3-2.5h4a1.5 1.5 0 0 0 1.5-1.5V8" />
        <path d="M11.5 1.5v5M9 4h5" />
      </svg>
    </button>
  )
}

export function ChatPanelHeader({
  lang,
  brand,
  onNewChat,
  disabled,
  newChatControl,
  onCollapse,
  collapseLabel,
  children,
  className = '',
}: {
  lang: Lang
  brand: ReactNode
  onNewChat?: (() => void) | undefined
  disabled?: boolean | undefined
  newChatControl?: ReactNode
  onCollapse?: (() => void) | undefined
  collapseLabel?: string | undefined
  children?: ReactNode
  className?: string | undefined
}) {
  return (
    <header className={`ai-panel-header nawa-chat-header ${className}`} dir={htmlDir(lang)}>
      <span className="ai-panel-title nawa-chat-brand" dir="ltr">
        {brand}
        <span>Nawa</span>
      </span>
      <div className="ai-panel-header-actions nawa-chat-header-actions">
        {newChatControl ??
          (onNewChat && <ChatNewButton lang={lang} onClick={onNewChat} disabled={disabled} />)}
        {children}
        {onCollapse && (
          <button
            type="button"
            className="ai-header-btn ai-panel-collapse"
            aria-label={collapseLabel}
            data-tip={collapseLabel}
            onClick={onCollapse}
          >
            <svg
              width="16"
              height="16"
              viewBox="0 0 16 16"
              fill="none"
              stroke="currentColor"
              strokeWidth="1.25"
              strokeLinecap="round"
              strokeLinejoin="round"
              aria-hidden="true"
            >
              <rect x="1.5" y="2.5" width="13" height="11" rx="1" />
              <path d="M5 2.5v11M11 5.5 8.5 8 11 10.5" />
            </svg>
          </button>
        )}
      </div>
    </header>
  )
}

export function ChatConversationSelector({
  label,
  value,
  title,
  disabled,
  options,
  onSelect,
}: {
  label: string
  value: string
  title?: string | undefined
  disabled?: boolean | undefined
  options: readonly { id: string; title: string }[]
  onSelect(id: string): void
}) {
  return (
    <select
      className="nawa-chat-conversation"
      dir="auto"
      aria-label={label}
      title={title}
      value={value}
      disabled={disabled}
      onChange={(event) => onSelect(event.target.value)}
    >
      {options.map((option) => (
        <option key={option.id} value={option.id}>
          {option.title}
        </option>
      ))}
    </select>
  )
}
