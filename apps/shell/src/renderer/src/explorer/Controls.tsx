import { useEffect, useLayoutEffect, useRef } from 'react'
import type { ReactNode, RefObject } from 'react'
import { Icon } from './Icons'
import type { IconName } from './Icons'
import { clamp } from './model'
export function ToolButton({ icon, label, onClick, disabled = false, pressed, text = false }: { icon: IconName; label: string; onClick: () => void; disabled?: boolean; pressed?: boolean; text?: boolean }) {
  return <button type="button" className={`ex-tool${text ? ' with-label' : ''}`} aria-label={label} title={label} aria-pressed={pressed} disabled={disabled} onClick={onClick}><Icon name={icon} />{text && <span>{label}</span>}</button>
}
export function Splitter({ label, value, min, max, reverse = false, onChange }: { label: string; value: number; min: number; max: number; reverse?: boolean; onChange: (value: number) => void }) {
  const drag = useRef<{ x: number; value: number } | null>(null)
  return <div role="separator" aria-label={label} aria-orientation="vertical" aria-valuemin={min} aria-valuemax={max} aria-valuenow={Math.round(value)} tabIndex={0} className="ex-splitter"
    onPointerDown={e => { drag.current = { x: e.clientX, value }; e.currentTarget.setPointerCapture(e.pointerId); e.preventDefault() }}
    onPointerMove={e => { if (drag.current) onChange(clamp(drag.current.value + (e.clientX - drag.current.x) * (reverse ? -1 : 1), min, max)) }}
    onPointerUp={e => { drag.current = null; if (e.currentTarget.hasPointerCapture(e.pointerId)) e.currentTarget.releasePointerCapture(e.pointerId) }}
    onPointerCancel={() => { drag.current = null }} onLostPointerCapture={() => { drag.current = null }}
    onKeyDown={e => { if (e.key === 'ArrowLeft' || e.key === 'ArrowRight') { e.preventDefault(); onChange(clamp(value + (e.key === 'ArrowRight' ? 10 : -10) * (reverse ? -1 : 1), min, max)) } else if (e.key === 'Home' || e.key === 'End') { e.preventDefault(); onChange(e.key === 'Home' ? min : max) } }} />
}
export interface MenuAction { label: string; icon?: IconName; action: () => void; disabled?: boolean; checked?: boolean; danger?: boolean; divider?: boolean; shortcut?: string }
export function Menu({ x, y, actions, onClose }: { x: number; y: number; actions: MenuAction[]; onClose: () => void }) {
  const ref = useRef<HTMLDivElement>(null)
  useLayoutEffect(() => {
    const menu = ref.current
    if (!menu) return
    const previous = document.activeElement as HTMLElement | null
    const rect = menu.getBoundingClientRect()
    menu.style.left = `${Math.max(8, Math.min(x, window.innerWidth - rect.width - 8))}px`
    menu.style.top = `${Math.max(44, Math.min(y, window.innerHeight - rect.height - 8))}px`
    menu.querySelector<HTMLButtonElement>('button:not(:disabled)')?.focus()
    return () => { if (previous?.isConnected) previous.focus({ preventScroll: true }) }
  }, [x, y])
  useEffect(() => {
    const close = (e: PointerEvent) => { if (!ref.current?.contains(e.target as Node)) onClose() }
    document.addEventListener('pointerdown', close, true)
    return () => document.removeEventListener('pointerdown', close, true)
  }, [onClose])
  return <div ref={ref} role="menu" aria-label="Explorer actions" className="ex-menu" style={{ left: x, top: y }} onKeyDown={e => {
    const buttons = [...(ref.current?.querySelectorAll<HTMLButtonElement>('button:not(:disabled)') ?? [])]
    const i = buttons.indexOf(document.activeElement as HTMLButtonElement)
    if (e.key === 'Escape') { e.preventDefault(); onClose() }
    else if (e.key === 'ArrowDown' || e.key === 'ArrowUp') { e.preventDefault(); buttons[(i + (e.key === 'ArrowDown' ? 1 : -1) + buttons.length) % buttons.length]?.focus() }
    else if (e.key === 'Home' || e.key === 'End') { e.preventDefault(); buttons[e.key === 'Home' ? 0 : buttons.length - 1]?.focus() }
    else if (e.key === 'Tab') onClose()
  }}>{actions.map((a, i) => <div key={`${a.label}-${i}`} role="none">{a.divider && <div role="separator" className="ex-menu-separator" />}<button type="button" role={a.checked !== undefined ? 'menuitemcheckbox' : 'menuitem'} aria-checked={a.checked} className={a.danger ? 'ex-danger' : ''} disabled={a.disabled} onClick={() => { onClose(); a.action() }}><span className="ex-menu-icon">{a.checked ? <Icon name="check" size={16} /> : a.icon ? <Icon name={a.icon} size={16} /> : null}</span><span>{a.label}</span>{a.shortcut && <kbd>{a.shortcut}</kbd>}</button></div>)}</div>
}
export function Dialog({ title, children, onClose }: { title: string; children: ReactNode; onClose: () => void }) {
  const ref = useRef<HTMLDivElement>(null)
  useEffect(() => {
    const previous = document.activeElement as HTMLElement | null
    ref.current?.querySelector<HTMLElement>('input, button')?.focus()
    return () => { if (previous?.isConnected) previous.focus() }
  }, [])
  return <div className="ex-dialog-backdrop" onKeyDown={e => {
    if (e.key === 'Escape') { e.preventDefault(); onClose() }
    if (e.key !== 'Tab') return
    const focusable = [...(ref.current?.querySelectorAll<HTMLElement>('button:not(:disabled), input:not(:disabled), [tabindex="0"]') ?? [])]
    const first = focusable[0], last = focusable[focusable.length - 1]
    if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last?.focus() }
    if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first?.focus() }
  }}><div ref={ref} className="ex-dialog" role="dialog" aria-modal="true" aria-labelledby="ex-dialog-title"><h2 id="ex-dialog-title">{title}</h2>{children}</div></div>
}
/** Native editor children sit above shell DOM; reserve the measured slot and hide them for shell dialogs. */
export function useEditorSlot(ref: RefObject<HTMLElement | null>, suspended: boolean) {
  useLayoutEffect(() => {
    const element = ref.current
    if (!element) return
    let frame = 0
    const measure = () => {
      const rect = element.getBoundingClientRect()
      window.nawaExplorer?.setLayout({ left: rect.left, top: rect.top, bottom: Math.max(0, window.innerHeight - rect.bottom), suspended })
    }
    const queue = () => { cancelAnimationFrame(frame); frame = requestAnimationFrame(measure) }
    const observer = new ResizeObserver(queue)
    observer.observe(element)
    window.addEventListener('resize', queue)
    measure()
    return () => { observer.disconnect(); cancelAnimationFrame(frame); window.removeEventListener('resize', queue) }
  }, [ref, suspended])
}
