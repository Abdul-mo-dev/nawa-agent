import { useId, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import './file-status.css'

export type FileStatusState = 'busy' | 'ready' | 'waiting' | 'failed' | 'attention' | 'unavailable'

/** File readiness stays in Explorer. Hover and keyboard focus expose the same details. */
export function FileStatusIcon({ state, label, details = [], percent }: {
  state: FileStatusState
  label: string
  details?: string[]
  percent?: number
}) {
  const id = useId()
  const anchor = useRef<HTMLSpanElement>(null)
  const [position, setPosition] = useState<{ left: number; top: number; above: boolean } | null>(null)
  const show = () => {
    const bounds = anchor.current?.getBoundingClientRect()
    if (!bounds) return
    setPosition({
      left: Math.max(12, Math.min(bounds.left, window.innerWidth - Math.min(320, window.innerWidth - 24) - 12)),
      top: bounds.bottom + 8,
      above: bounds.bottom > window.innerHeight - 200,
    })
  }
  const progress = percent === undefined ? undefined : Math.max(0, Math.min(100, percent))
  return <>
    <span ref={anchor} className={`nawa-file-status is-${state}`} role="img" tabIndex={0} title=""
      aria-label={label} aria-describedby={position ? id : undefined} data-state={state}
      onMouseEnter={show} onMouseLeave={() => setPosition(null)} onFocus={show} onBlur={() => setPosition(null)}
      onClick={event => event.stopPropagation()} onDoubleClick={event => event.stopPropagation()}
      onKeyDown={event => {
        event.stopPropagation()
        if (event.key === 'Escape') setPosition(null)
      }}>
      <svg width="18" height="18" viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
        {state === 'busy' ? <>
          <circle cx="10" cy="10" r="7" opacity=".2" />
          {progress !== undefined && <circle cx="10" cy="10" r="8.5" strokeWidth="1"
            pathLength="100" strokeDasharray={`${progress} 100`} transform="rotate(-90 10 10)" />}
          <circle className="nawa-file-status-spinner" cx="10" cy="10" r={progress === undefined ? 7 : 5.5}
            pathLength="100" strokeDasharray="28 100" transform="rotate(-90 10 10)" />
        </> : state === 'ready' ? <path d="m4 10 4 4 8-9" />
          : state === 'waiting' ? <><circle cx="10" cy="10" r="7" /><path d="M10 6v4l3 2" /></>
            : state === 'failed' ? <path d="m5 5 10 10M15 5 5 15" />
              : state === 'attention' ? <><path d="m10 3 8 14H2Z" /><path d="M10 8v3M10 14h.01" /></>
                : <path d="M5 10h10" />}
      </svg>
    </span>
    {position && createPortal(<div id={id} role="tooltip" dir="auto" className="nawa-file-status-tooltip"
      style={{ left: position.left, top: position.above ? (anchor.current?.getBoundingClientRect().top ?? position.top) - 8 : position.top,
        transform: position.above ? 'translateY(-100%)' : undefined }}>
      <strong>{label}</strong>
      {details.filter(Boolean).map((detail, index) => <div key={index}>{detail}</div>)}
    </div>, document.body)}
  </>
}
