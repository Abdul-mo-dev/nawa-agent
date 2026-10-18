import { useEffect, useRef, useState } from 'react'
import type { FilePreview as Preview } from '../../shared/file-preview'
import { useI18n } from './locale'
import { previewText, type PreviewLabels } from './file-preview-labels'
import { PreviewAssistant } from './PreviewAssistant'
import { NawaIcon } from './explorer/Icons'
import './file-preview.css'

export function FilePreview({ path, tabId }: { path: string; tabId: string }) {
  const { lang } = useI18n(),
    t = previewText(lang)
  const [preview, setPreview] = useState<Preview | null>(null)
  const [revision, setRevision] = useState(0)
  const [aiOpen, setAiOpen] = useState(true)
  useEffect(() => {
    let live = true
    setPreview(null)
    void window.nawaFilePreview
      .read(path)
      .then((value) => {
        if (live) setPreview(value)
      })
      .catch((error) => {
        if (live)
          setPreview({ path, name: path.split(/[\\/]/).pop() || path, error: String(error) })
      })
    return () => {
      live = false
    }
  }, [path, revision])
  return (
    <section className="file-preview-pane" aria-label={t.title}>
      <header className="file-preview-toolbar">
        <strong dir="auto" title={path}>
          {preview?.name || path.split(/[\\/]/).pop()}
        </strong>
        <button type="button" aria-pressed={aiOpen} onClick={() => setAiOpen((value) => !value)}>
          <NawaIcon size={18} />
          {t.assistant}
        </button>
        <button type="button" onClick={() => setRevision((value) => value + 1)}>
          {t.refresh}
        </button>
        <button type="button" onClick={() => void window.aiOfficeTabs.close(tabId)}>
          {t.close}
        </button>
      </header>
      <div className="file-preview-workspace">
        <div className="file-preview-content">
          {!preview ? (
            <p role="status">{t.loading}</p>
          ) : preview.error ? (
            <p role="alert">{preview.error}</p>
          ) : preview.image ? (
            <ImagePreview key={preview.sourceHash} src={preview.image} name={preview.name} t={t} />
          ) : preview.message ? (
            <article className="file-preview-message">
              <h1 dir="auto">{preview.message.subject || t.subject}</h1>
              <dl>
                {preview.message.headers.map((header, i) => (
                  <div key={i}>
                    <dt>{header.name}</dt>
                    <dd dir="auto">{header.value}</dd>
                  </div>
                ))}
              </dl>
              <pre dir="auto" className="file-preview-body">
                {preview.message.body}
              </pre>
              {!!preview.message.attachments.length && (
                <section>
                  <h2>{t.attachments}</h2>
                  <ul>
                    {preview.message.attachments.map((attachment, i) => (
                      <li key={i} dir="auto">
                        {attachment.name} · {attachment.bytes.toLocaleString()} B
                      </li>
                    ))}
                  </ul>
                </section>
              )}
              {preview.message.warnings.map((warning, i) => (
                <p className="file-preview-warning" key={i}>
                  {warning}
                </p>
              ))}
            </article>
          ) : null}
        </div>
        {preview && !preview.error && (
          <div className="file-preview-ai ai-dock" hidden={!aiOpen}>
            <PreviewAssistant
              key={`${path}:${preview.sourceHash}`}
              preview={preview}
              onCollapse={() => setAiOpen(false)}
            />
          </div>
        )}
      </div>
    </section>
  )
}

function ImagePreview({ src, name, t }: { src: string; name: string; t: PreviewLabels }) {
  const stage = useRef<HTMLDivElement>(null)
  const [size, setSize] = useState({ width: 1, height: 1 })
  const [natural, setNatural] = useState({ width: 1, height: 1 })
  const [zoom, setZoom] = useState<number | null>(null)
  const [offset, setOffset] = useState({ x: 0, y: 0 })
  const drag = useRef<{ x: number; y: number; ox: number; oy: number } | null>(null)
  const fit = Math.min(
    1,
    Math.max(1, size.width - 48) / natural.width,
    Math.max(1, size.height - 48) / natural.height,
  )
  const scale = zoom ?? fit
  useEffect(() => {
    const element = stage.current
    if (!element) return
    const observer = new ResizeObserver(() =>
      setSize({ width: element.clientWidth, height: element.clientHeight }),
    )
    observer.observe(element)
    return () => observer.disconnect()
  }, [])
  const scaleRef = useRef(scale)
  scaleRef.current = scale
  useEffect(() => {
    const element = stage.current
    if (!element) return
    const wheel = (event: WheelEvent) => {
      event.preventDefault()
      setZoom(Math.max(0.05, Math.min(16, scaleRef.current * (event.deltaY > 0 ? 0.8 : 1.25))))
    }
    element.addEventListener('wheel', wheel, { passive: false })
    return () => element.removeEventListener('wheel', wheel)
  }, [])
  return (
    <div className="file-preview-image">
      <div className="file-preview-image-tools" role="toolbar" aria-label={t.title}>
        <button
          type="button"
          aria-label={t.zoomOut}
          onClick={() => setZoom(Math.max(0.05, scale / 1.25))}
        >
          −
        </button>
        <output>{Math.round(scale * 100)}%</output>
        <button
          type="button"
          aria-label={t.zoomIn}
          onClick={() => setZoom(Math.min(16, scale * 1.25))}
        >
          +
        </button>
        <button
          type="button"
          onClick={() => {
            setZoom(null)
            setOffset({ x: 0, y: 0 })
          }}
        >
          {t.fitToWindow}
        </button>
        <button
          type="button"
          onClick={() => {
            setZoom(1)
            setOffset({ x: 0, y: 0 })
          }}
        >
          {t.actualSize}
        </button>
      </div>
      <div
        className="file-preview-image-stage"
        ref={stage}
        onPointerDown={(event) => {
          if (event.button !== 0) return
          event.preventDefault()
          drag.current = { x: event.clientX, y: event.clientY, ox: offset.x, oy: offset.y }
          event.currentTarget.setPointerCapture(event.pointerId)
        }}
        onPointerMove={(event) => {
          const start = drag.current
          if (start)
            setOffset({
              x: start.ox + event.clientX - start.x,
              y: start.oy + event.clientY - start.y,
            })
        }}
        onPointerUp={() => {
          drag.current = null
        }}
        onPointerCancel={() => {
          drag.current = null
        }}
        onLostPointerCapture={() => {
          drag.current = null
        }}
      >
        <img
          src={src}
          alt={name}
          draggable={false}
          onLoad={(event) =>
            setNatural({
              width: event.currentTarget.naturalWidth,
              height: event.currentTarget.naturalHeight,
            })
          }
          style={{
            transform: `translate(-50%, -50%) translate(${offset.x}px, ${offset.y}px) scale(${scale})`,
          }}
        />
      </div>
    </div>
  )
}
