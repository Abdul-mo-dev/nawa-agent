import { useContext, useEffect, useId, useRef, type ReactNode } from 'react'
import { createPortal } from 'react-dom'
import { PanelVisibility } from './panel-state'
import { useSidebarText } from './sidebar-i18n'

/** Native modal focus/inert handling, with the same theme as the originating panel. */
export function PanelDialog({
  open,
  title,
  children,
  footer,
  closeDisabled = false,
  className = '',
  onClose,
}: {
  open: boolean
  title: string
  children: ReactNode
  footer?: ReactNode
  closeDisabled?: boolean
  className?: string
  onClose(): void
}) {
  const visible = useContext(PanelVisibility)
  const { s, dir } = useSidebarText()
  const ref = useRef<HTMLDialogElement>(null)
  const id = useId()
  useEffect(() => {
    const dialog = ref.current
    if (!dialog) return
    const previous = document.activeElement instanceof HTMLElement ? document.activeElement : null
    if (open && visible) {
      if (!dialog.open) dialog.showModal()
    } else if (dialog.open) dialog.close()
    return () => {
      if (dialog.open) dialog.close()
      if (open && visible && previous?.isConnected && previous.getClientRects().length)
        previous.focus()
    }
  }, [open, visible])
  return createPortal(
    <dialog
      ref={ref}
      className={`nawa-panel-dialog nawa-panel-theme ${className}`}
      dir={dir}
      aria-labelledby={id}
      onCancel={(event) => {
        event.preventDefault()
        if (!closeDisabled) onClose()
      }}
    >
      <header>
        <h2 id={id}>{title}</h2>
        <button type="button" className="set-btn" disabled={closeDisabled} onClick={onClose}>
          {s('Close')}
        </button>
      </header>
      <div className="nawa-panel-dialog-body">{children}</div>
      {footer && <footer>{footer}</footer>}
    </dialog>,
    document.body,
  )
}
