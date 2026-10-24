import { useEffect, useRef, useState } from 'react'
import type { RuntimeSetupOptions, RuntimeSetupSnapshot } from '../../../shared/runtime-setup-api'
import { runtimeSetupStrings } from '../i18n/strings-runtime-setup'
import { useI18n } from '../locale'
import { usePanelActivity } from '../explorer/panel-state'
import { PanelDialog } from '../explorer/PanelDialog'
import { chatConnection, embeddingConnection } from './connections'
import './runtime-setup.css'

export function RuntimeSetupPanel({
  blocked = false,
  onBusyChange,
  onChanged,
  onDone,
}: {
  blocked?: boolean
  onBusyChange?(busy: boolean): void
  onChanged?(): void
  onDone?(): void
}) {
  const { lang } = useI18n(),
    copy = runtimeSetupStrings[lang]
  const [view, setView] = useState<RuntimeSetupSnapshot | null>(null),
    [working, setWorking] = useState(false),
    [error, setError] = useState('')
  const [options, setOptions] = useState<RuntimeSetupOptions>({
    models: true,
    office: true,
    startModels: true,
    useDefaults: true,
    backend: 'cuda',
  })
  const alive = useRef(true)
  const blockedRef = useRef(blocked)
  blockedRef.current = blocked
  const busy = working || view?.state === 'installing'
  usePanelActivity('provider', 'runtime-setup', busy ? { kind: 'busy', text: copy.working } : null)
  useEffect(() => {
    onBusyChange?.(busy)
  }, [busy, onBusyChange])
  useEffect(() => {
    alive.current = true
    let pending = false
    const read = () => {
      if (!window.nawaRuntimeSetup || pending) return
      pending = true
      void window.nawaRuntimeSetup
        .inspect()
        .then((next) => {
          if (alive.current) setView(next)
        })
        .catch((cause) => {
          if (alive.current) setError(String(cause))
        })
        .finally(() => {
          pending = false
        })
    }
    read()
    const timer = setInterval(read, 1000)
    return () => {
      alive.current = false
      clearInterval(timer)
    }
  }, [])
  const activate = async (result: RuntimeSetupSnapshot) => {
    const chat = result.profiles.find((profile) => profile.kind === 'chat'),
      embedding = result.profiles.find((profile) => profile.kind === 'embedding')
    if (!chat || !embedding)
      throw new Error('Install both default model profiles before activating them.')
    const rag = await window.nawaRag.settings()
    await window.nawaRag.save(
      embeddingConnection(rag.settings, embedding, `nawa-defaults-v1:${Date.now()}`),
      '',
    )
    const ai = await window.aiOffice.getAiSettings()
    await window.aiOffice.setAiSettings(chatConnection(ai, chat))
    await window.nawaRuntimeSetup!.activated()
    window.dispatchEvent(new Event('nawa:models-changed'))
    onChanged?.()
  }
  const perform = async (install: boolean) => {
    if (!window.nawaRuntimeSetup) return
    setWorking(true)
    setError('')
    try {
      const result = install ? await window.nawaRuntimeSetup.install(options) : view!
      if (
        result.state === 'ready' &&
        result.needsActivation &&
        (!install || (options.models && options.useDefaults)) &&
        !blockedRef.current
      )
        await activate(result)
      if (alive.current) setView(await window.nawaRuntimeSetup.inspect())
    } catch (cause) {
      if (alive.current) setError(cause instanceof Error ? cause.message : String(cause))
    } finally {
      onChanged?.()
      if (alive.current) setWorking(false)
    }
  }
  if (!window.nawaRuntimeSetup) return null
  const stage = view?.stage && copy[view.stage as keyof typeof copy]
  return (
    <section className="runtime-setup" aria-label={copy.summary}>
      <p>{copy.intro}</p>
      <p className="runtime-setup-hint">{copy.size}</p>
      <fieldset disabled={busy || blocked || !view?.supported}>
        {(['models', 'office', 'startModels', 'useDefaults'] as const).map((key) => (
          <label className="runtime-setup-choice" key={key}>
            <input
              type="checkbox"
              checked={options[key]}
              disabled={(key === 'startModels' || key === 'useDefaults') && !options.models}
              onChange={(event) =>
                setOptions((previous) => ({ ...previous, [key]: event.target.checked }))
              }
            />
            {copy[key === 'startModels' ? 'start' : key === 'useDefaults' ? 'defaults' : key]}
          </label>
        ))}
        <label className="runtime-setup-field">
          {copy.backend}
          <select
            className="set-input"
            disabled={view?.reuseRuntime}
            value={options.backend}
            onChange={(event) =>
              setOptions((previous) => ({
                ...previous,
                backend: event.target.value as RuntimeSetupOptions['backend'],
              }))
            }
          >
            <option value="cuda">{copy.cuda}</option>
            <option value="cpu">{copy.cpu}</option>
            <option value="vulkan">{copy.vulkan}</option>
          </select>
        </label>
        {view?.reuseRuntime && <p className="runtime-setup-hint">{copy.reuseRuntime}</p>}
      </fieldset>
      <p className="runtime-setup-hint">{copy.included}</p>
      {view && (
        <ul className="runtime-setup-dependencies">
          <li>{view.ocr ? copy.ocrReady : copy.ocrMissing}</li>
          <li>{view.office ? copy.officeReady : copy.officeMissing}</li>
        </ul>
      )}
      <p className="runtime-setup-hint">{copy.licenses}</p>
      {!view?.supported && view && <p>{copy.unsupported}</p>}
      {busy && (
        <div role="status" className="runtime-setup-progress">
          <span>{stage || copy.working}</span>
          {!!view?.total && (
            <>
              <progress aria-label={copy.working} max={view.total} value={view.received} />
              <span dir="ltr">
                {(view.received / 1024 ** 2).toFixed(0)} / {(view.total / 1024 ** 2).toFixed(0)} MiB
              </span>
            </>
          )}
        </div>
      )}
      {view?.state === 'ready' && !view.needsActivation && <p role="status">{copy.ready}</p>}
      {view?.state === 'canceled' && <p role="status">{copy.canceled}</p>}
      {(error || view?.error) && (
        <p className="runtime-setup-error" role="alert">
          {copy.failed}: {error || view?.error}
        </p>
      )}
      <div className="runtime-setup-actions">
        <button
          type="button"
          className="set-btn primary"
          disabled={busy || blocked || !view?.supported || (!options.models && !options.office)}
          onClick={() => void perform(true)}
        >
          {view?.state === 'failed' || view?.state === 'canceled' ? copy.retry : copy.install}
        </button>
        {busy && (
          <button
            type="button"
            className="set-btn"
            onClick={() =>
              void window.nawaRuntimeSetup!.cancel().catch((cause) => setError(String(cause)))
            }
          >
            {copy.cancel}
          </button>
        )}
        {view?.needsActivation && (
          <button
            type="button"
            className="set-btn"
            disabled={busy || blocked}
            onClick={() => void perform(false)}
          >
            {copy.activate}
          </button>
        )}
        {onDone && (
          <button type="button" className="set-btn" disabled={busy} onClick={onDone}>
            {view?.state === 'ready' && !view.needsActivation ? copy.done : copy.later}
          </button>
        )}
        <button
          type="button"
          className="set-btn"
          disabled={busy || !view?.supported}
          onClick={() =>
            void window.nawaRuntimeSetup!.openLanguages().catch((cause) => setError(String(cause)))
          }
        >
          {copy.languages}
        </button>
        <button
          type="button"
          className="set-btn"
          disabled={busy}
          onClick={() =>
            void window.nawaRuntimeSetup!.reveal().catch((cause) => setError(String(cause)))
          }
        >
          {copy.folder}
        </button>
      </div>
    </section>
  )
}

export function RuntimeSetupWelcome({ visible }: { visible: boolean }) {
  const { lang } = useI18n(),
    copy = runtimeSetupStrings[lang]
  const [open, setOpen] = useState(false),
    [busy, setBusy] = useState(false)
  useEffect(() => {
    let alive = true
    if (visible && window.nawaRuntimeSetup)
      void window.nawaRuntimeSetup
        .inspect()
        .then((view) => {
          if (alive) setOpen(view.offer)
        })
        .catch(() => {})
    return () => {
      alive = false
    }
  }, [visible])
  const close = () => {
    if (busy) return
    void window.nawaRuntimeSetup
      ?.dismiss()
      .then(() => setOpen(false))
      .catch(() => {})
  }
  return (
    <PanelDialog
      open={visible && open}
      title={copy.title}
      closeDisabled={busy}
      onClose={close}
      className="runtime-setup-dialog"
    >
      {open && <RuntimeSetupPanel onBusyChange={setBusy} onDone={close} />}
    </PanelDialog>
  )
}
