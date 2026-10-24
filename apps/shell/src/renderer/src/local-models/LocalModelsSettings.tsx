import { useEffect, useId, useRef, useState, type ReactNode } from 'react'
import type { AiSettings } from '@genoffice/ai-provider/browser'
import type {
  LocalModelProfile,
  LocalModelsConfig,
  LocalModelsSnapshot,
} from '../../../shared/local-models-api'
import type { RagSettings as RagConfiguration } from '../../../shared/rag-api'
import { localModelAlias, newLocalProfile } from '../../../shared/local-model-command'
import { localModelStrings } from '../i18n/strings-local-models'
import { useI18n } from '../locale'
import { usePanelActivity } from '../explorer/panel-state'
import { RagSettings } from '../rag/RagSettings'
import { chatConnection, embeddingConnection } from './connections'
import { LocalProfileEditor } from './LocalProfileEditor'
import { ModelDownloads } from './ModelDownloads'
import './local-models.css'
import { RuntimeSetupPanel } from './RuntimeSetupPanel'
import { runtimeSetupStrings } from '../i18n/strings-runtime-setup'
import { RemoteModelsSettings } from '../remote-models/RemoteModelsSettings'

interface ChatSummary {
  name: string
  model: string
  baseUrl: string
}
function chatSummary(settings: AiSettings): ChatSummary {
  const chosen = settings.chatModels?.find((model) => model.id === settings.defaultChatModelId)
  const config = chosen?.config ?? settings.providers[settings.provider]
  return {
    name: chosen?.name ?? config?.model ?? '',
    model: config?.model ?? '',
    baseUrl: config?.baseUrl ?? '',
  }
}
const shortPath = (value: string) => value.split(/[\\/]/).pop() ?? value
const sameEndpoint = (a: string, b: string) => a.replace(/\/+$/, '') === b.replace(/\/+$/, '')
export function LocalModelsSettings({
  chat,
  applyBlocked = false,
  embeddingSuspended = false,
  openEmbeddingRequest = 0,
}: {
  chat: ReactNode
  applyBlocked?: boolean
  embeddingSuspended?: boolean
  openEmbeddingRequest?: number
}) {
  const { lang } = useI18n(),
    copy = localModelStrings[lang],
    id = useId()
  const [snapshot, setSnapshot] = useState<LocalModelsSnapshot | null>(null),
    [draft, setDraft] = useState<LocalModelsConfig | null>(null)
  const [selected, setSelected] = useState(''),
    [editorOpen, setEditorOpen] = useState(false),
    [runtimeOpen, setRuntimeOpen] = useState(false)
  const [connectionEditor, setConnectionEditor] = useState<'chat' | 'embedding' | null>(null)
  const [visited, setVisited] = useState(new Set<'chat' | 'embedding'>())
  const [currentChat, setCurrentChat] = useState<ChatSummary | null>(null),
    [currentEmbedding, setCurrentEmbedding] = useState<RagConfiguration | null>(null)
  const [embeddingVersion, setEmbeddingVersion] = useState(0)
  const [localBusy, setBusy] = useState(false),
    [downloadPending, setDownloadPending] = useState(false)
  const [setupRunning, setSetupRunning] = useState(false)
  const [remoteEditing, setRemoteEditing] = useState(false),
    [remoteWorking, setRemoteWorking] = useState(false)
  const busy = localBusy || setupRunning || remoteWorking
  const [error, setError] = useState(''),
    [notice, setNotice] = useState('')
  const [confirm, setConfirm] = useState<'profile' | 'refresh' | { model: string } | null>(null)
  const [downloadsOpen, setDownloadsOpen] = useState(false)
  const alive = useRef(true),
    polling = useRef(false),
    editorHeading = useRef<HTMLDivElement>(null),
    confirmation = useRef<HTMLDivElement>(null)
  const dirty = !!draft && !!snapshot && JSON.stringify(draft) !== JSON.stringify(snapshot.config)
  const profile = draft?.profiles.find((p) => p.id === selected),
    runtime = snapshot?.runtimes.find((r) => r.id === selected)
  const active = !!runtime && ['starting', 'running', 'stopping'].includes(runtime.state)
  const anyActive = !!snapshot?.runtimes.some((r) =>
    ['starting', 'running', 'stopping'].includes(r.state),
  )
  const downloading = downloadPending || snapshot?.download.state === 'downloading'
  usePanelActivity(
    'provider',
    'local-models',
    busy
      ? { kind: 'busy', text: copy.working, dirty }
      : dirty
        ? { kind: 'unsaved', text: copy.unsaved }
        : null,
  )
  const accept = (next: LocalModelsSnapshot, replace = false) => {
    if (!alive.current) return
    setSnapshot((previous) =>
      replace || !previous
        ? next
        : { ...next, config: previous.config, revision: previous.revision },
    )
    if (replace) {
      setDraft(next.config)
      setSelected((value) =>
        next.config.profiles.some((p) => p.id === value)
          ? value
          : (next.config.profiles[0]?.id ?? ''),
      )
    }
  }
  const openConnection = (kind: 'chat' | 'embedding') => {
    setVisited((values) => new Set([...values, kind]))
    setConnectionEditor((value) => (value === kind ? null : kind))
  }
  useEffect(() => {
    if (!openEmbeddingRequest) return
    setVisited((values) => new Set([...values, 'embedding']))
    setConnectionEditor('embedding')
  }, [openEmbeddingRequest])
  useEffect(() => {
    if (!confirm) return
    const previous = document.activeElement instanceof HTMLElement ? document.activeElement : null
    const frame = requestAnimationFrame(() => {
      confirmation.current?.scrollIntoView({ block: 'nearest' })
      confirmation.current
        ?.querySelector<HTMLButtonElement>('button')
        ?.focus({ preventScroll: true })
    })
    return () => {
      cancelAnimationFrame(frame)
      if (previous?.isConnected) previous.focus({ preventScroll: true })
    }
  }, [confirm])
  useEffect(() => {
    alive.current = true
    const readChat = () =>
      void window.aiOffice
        .getAiSettings?.()
        .then((settings) => {
          if (alive.current) setCurrentChat(chatSummary(settings))
        })
        .catch((e) => {
          if (alive.current) setError(String(e))
        })
    const readEmbedding = () =>
      void window.nawaRag
        ?.settings()
        .then((view) => {
          if (alive.current) setCurrentEmbedding(view.settings)
        })
        .catch((e) => {
          if (alive.current) setError(String(e))
        })
    readChat()
    readEmbedding()
    const offChat = window.aiOffice.onAiSettingsChanged?.(readChat),
      offEmbedding = window.nawaRag?.onChanged?.(readEmbedding)
    if (window.nawaLocalModels)
      void window.nawaLocalModels
        .inspect()
        .then((next) => accept(next, true))
        .catch((e) => {
          if (alive.current) setError(String(e))
        })
    const timer = setInterval(() => {
      if (!window.nawaLocalModels || polling.current) return
      polling.current = true
      void window.nawaLocalModels
        .inspect()
        .then((next) => accept(next))
        .catch((e) => {
          if (alive.current) setError(String(e))
        })
        .finally(() => {
          polling.current = false
        })
    }, 1000)
    return () => {
      alive.current = false
      clearInterval(timer)
      offChat?.()
      offEmbedding?.()
    }
  }, [])
  const perform = async (work: () => Promise<void>) => {
    setBusy(true)
    setError('')
    setNotice('')
    try {
      await work()
    } catch (e) {
      if (alive.current) setError(e instanceof Error ? e.message : String(e))
    } finally {
      if (alive.current) setBusy(false)
    }
  }
  const update = (patch: Partial<LocalModelProfile>) =>
    setDraft(
      (value) =>
        value && {
          ...value,
          profiles: value.profiles.map((p) => (p.id === selected ? { ...p, ...patch } : p)),
        },
    )
  const save = async (value = draft) => {
    if (!value || !snapshot) return
    accept(await window.nawaLocalModels.save(value, snapshot.revision), true)
    setNotice(copy.saved)
  }
  const showEditor = (profileId: string) => {
    setSelected(profileId)
    setEditorOpen(true)
    setConfirm(null)
    requestAnimationFrame(() => editorHeading.current?.scrollIntoView({ block: 'nearest' }))
  }
  const add = (kind: LocalModelProfile['kind'] = 'chat', modelPath = '') => {
    if (!draft) return
    const next = newLocalProfile(kind, draft.profiles)
    next.name = modelPath
      ? shortPath(modelPath).replace(/\.gguf$/i, '')
      : kind === 'chat'
        ? copy.chatModel
        : copy.embeddingModel
    next.modelPath = modelPath
    setDraft({ ...draft, profiles: [...draft.profiles, next] })
    showEditor(next.id)
    if (!draft.executablePath) setRuntimeOpen(true)
  }
  const choose = (kind: 'model' | 'engine') =>
    perform(async () => {
      const path = await window.nawaLocalModels.choosePath(kind)
      if (path && alive.current) {
        if (kind === 'model') update({ modelPath: path })
        else setDraft((value) => value && { ...value, executablePath: path })
      }
    })
  const isDefault = (p: LocalModelProfile) =>
    p.kind === 'chat'
      ? !!currentChat &&
        currentChat.model === localModelAlias(p) &&
        sameEndpoint(currentChat.baseUrl, `http://127.0.0.1:${p.port}/v1`)
      : currentEmbedding?.backend === 'local' &&
        currentEmbedding.model === localModelAlias(p) &&
        sameEndpoint(currentEmbedding.baseUrl, `http://127.0.0.1:${p.port}/v1`)
  const apply = (p: LocalModelProfile) =>
    perform(async () => {
      if (p.kind === 'chat') {
        const current = await window.aiOffice.getAiSettings()
        await window.aiOffice.setAiSettings(chatConnection(current, p))
        setCurrentChat(chatSummary(await window.aiOffice.getAiSettings()))
        window.dispatchEvent(new Event('nawa:models-changed'))
        setNotice(copy.chatApplied)
      } else {
        const current = await window.nawaRag.settings()
        const next = await window.nawaRag.save(
          embeddingConnection(current.settings, p, `${p.id}:${Date.now()}`),
          '',
        )
        setCurrentEmbedding(next.settings)
        setEmbeddingVersion((value) => value + 1)
        setNotice(copy.embeddingApplied)
      }
    })
  const download = (work: () => Promise<void>) => {
    setError('')
    setNotice('')
    setDownloadPending(true)
    void work()
      .catch((e) => {
        if (alive.current) setError(String(e))
      })
      .finally(() => {
        if (alive.current) setDownloadPending(false)
        void window.nawaLocalModels
          .inspect()
          .then((next) => accept(next))
          .catch(() => {})
      })
  }
  const confirmText =
    confirm === 'profile'
      ? copy.removeConfirm
      : confirm === 'refresh'
        ? copy.refreshDraft
        : copy.deleteModelConfirm
  const embeddingName =
    currentEmbedding?.backend === 'native'
      ? copy.builtInModel
      : currentEmbedding?.backend === 'myagent'
        ? 'MyAgent'
        : currentEmbedding?.model
  return (
    <section className="lm-settings" aria-label={copy.title}>
      <h3 className="set-pane-title">{copy.title}</h3>
      <p className="lm-intro">{copy.overviewIntro}</p>
      <details className="lm-runtime-setup">
        <summary>{runtimeSetupStrings[lang].summary}</summary>
        <RuntimeSetupPanel
          blocked={applyBlocked || dirty || localBusy || remoteEditing || remoteWorking}
          onBusyChange={setSetupRunning}
          onChanged={() => {
            void window.nawaLocalModels
              ?.inspect()
              .then((next) => accept(next, true))
              .catch((cause) => setError(String(cause)))
          }}
        />
      </details>
      <div className="lm-connections">
        <section className="lm-connection-card" aria-labelledby={`${id}-chat-title`}>
          <div className="lm-card-label" id={`${id}-chat-title`}>
            {copy.chatModel}
          </div>
          <strong className="lm-current-model">
            {currentChat?.model ? currentChat.name : copy.notConfigured}
          </strong>
          <span className="lm-card-detail">
            <bdi>{currentChat?.baseUrl || currentChat?.model || copy.chatDescription}</bdi>
          </span>
          <button
            type="button"
            className="set-btn"
            aria-expanded={connectionEditor === 'chat'}
            aria-controls={`${id}-chat-editor`}
            disabled={busy || remoteEditing}
            onClick={() => openConnection('chat')}
          >
            {copy.configureChat}
          </button>
        </section>
        <section className="lm-connection-card" aria-labelledby={`${id}-embedding-title`}>
          <div className="lm-card-label" id={`${id}-embedding-title`}>
            {copy.embeddingModel}
          </div>
          <strong className="lm-current-model">{embeddingName || copy.notConfigured}</strong>
          <span className="lm-card-detail">
            <bdi>
              {currentEmbedding?.backend === 'myagent'
                ? currentEmbedding.serverUrl
                : currentEmbedding?.backend === 'native'
                  ? copy.builtInModel
                  : currentEmbedding?.baseUrl || copy.embeddingDescription}
            </bdi>
          </span>
          <button
            type="button"
            className="set-btn"
            aria-expanded={connectionEditor === 'embedding'}
            aria-controls={`${id}-embedding-editor`}
            disabled={busy || remoteEditing}
            onClick={() => openConnection('embedding')}
          >
            {copy.configureEmbedding}
          </button>
        </section>
      </div>
      <div
        className="lm-connection-editor"
        id={`${id}-chat-editor`}
        hidden={connectionEditor !== 'chat'}
      >
        {visited.has('chat') && chat}
      </div>
      <div
        className="lm-connection-editor"
        id={`${id}-embedding-editor`}
        hidden={connectionEditor !== 'embedding'}
      >
        {visited.has('embedding') && (
          <RagSettings key={embeddingVersion} compact suspended={busy || embeddingSuspended} />
        )}
      </div>
      <RemoteModelsSettings
        blocked={applyBlocked || dirty || localBusy || setupRunning}
        embedding={currentEmbedding}
        onEmbeddingApplied={(settings) => {
          setCurrentEmbedding(settings)
          setEmbeddingVersion((value) => value + 1)
        }}
        onEditingChange={setRemoteEditing}
        onWorkingChange={setRemoteWorking}
      />
      <section className="lm-local-section" aria-labelledby={`${id}-local-title`}>
        <div className="lm-section-heading">
          <div>
            <h4 id={`${id}-local-title`}>{copy.localModels}</h4>
            <p className="lm-hint">{copy.localDescription}</p>
          </div>
          <button
            type="button"
            className="set-btn"
            disabled={busy || remoteEditing || !draft}
            onClick={() => add()}
          >
            {copy.addModel}
          </button>
        </div>
        <details
          className="lm-runtime-setup"
          open={runtimeOpen}
          onToggle={(e) => setRuntimeOpen(e.currentTarget.open)}
        >
          <summary>
            <span>{copy.runtimeSetup}</span>
            <span className="lm-summary-value">
              <bdi>
                {draft?.executablePath ? shortPath(draft.executablePath) : copy.chooseRuntime}
              </bdi>
            </span>
          </summary>
          <label className="lm-field">
            <span>{copy.executable}</span>
            <div className="lm-input-action">
              <input
                className="set-input"
                aria-label={copy.executable}
                dir="ltr"
                disabled={busy || anyActive}
                value={draft?.executablePath ?? ''}
                onChange={(e) =>
                  setDraft((value) => value && { ...value, executablePath: e.target.value })
                }
              />
              <button
                type="button"
                className="set-btn"
                disabled={busy || anyActive}
                onClick={() => void choose('engine')}
              >
                {copy.browse}
              </button>
            </div>
          </label>
          {!!snapshot?.engines.length && (
            <label className="lm-field">
              <span>{copy.installed}</span>
              <select
                className="set-input"
                disabled={busy || anyActive}
                value=""
                onChange={(e) =>
                  setDraft((value) => value && { ...value, executablePath: e.target.value })
                }
              >
                <option value="">{copy.selectEngine}</option>
                {snapshot.engines.map((path) => (
                  <option key={path}>{path}</option>
                ))}
              </select>
            </label>
          )}
          <p className="lm-hint">{copy.sharedRuntime}</p>
        </details>
        {!draft?.profiles.length && <p className="lm-empty">{copy.empty}</p>}
        <div className="lm-model-list">
          {draft?.profiles.map((p) => {
            const view = snapshot?.runtimes.find((r) => r.id === p.id),
              state = view?.state ?? 'stopped',
              running = ['starting', 'running', 'stopping'].includes(state),
              assigned = isDefault(p)
            return (
              <article
                className={`lm-model-row${editorOpen && p.id === selected ? ' is-selected' : ''}`}
                key={p.id}
                aria-label={p.name}
              >
                <div className="lm-model-identity">
                  <button
                    type="button"
                    className="lm-model-name"
                    aria-expanded={editorOpen && p.id === selected}
                    onClick={() => showEditor(p.id)}
                  >
                    {p.name}
                  </button>
                  <span className="lm-model-meta">
                    {p.kind === 'chat' ? copy.chatModel : copy.embeddingModel}
                    <span aria-hidden="true"> · </span>
                    <span className={`lm-state lm-state-${state}`}>{copy[state]}</span>
                    {assigned && <span className="lm-default-badge">{copy.defaultModel}</span>}
                  </span>
                </div>
                <div className="lm-row-actions">
                  <button
                    type="button"
                    className="set-btn"
                    disabled={
                      busy ||
                      (running
                        ? state === 'stopping'
                        : dirty || !p.modelPath || !draft.executablePath)
                    }
                    onClick={() =>
                      void perform(async () =>
                        accept(
                          await window.nawaLocalModels.control(running ? 'stop' : 'start', p.id),
                        ),
                      )
                    }
                  >
                    {running ? copy.stop : copy.start}
                  </button>
                  {!assigned && (
                    <button
                      type="button"
                      className="set-btn"
                      disabled={busy || dirty || applyBlocked || state !== 'running'}
                      onClick={() => void apply(p)}
                    >
                      {p.kind === 'chat' ? copy.useChat : copy.useEmbedding}
                    </button>
                  )}
                  <button
                    type="button"
                    className="set-btn lm-edit-button"
                    aria-label={`${copy.editModel}: ${p.name}`}
                    onClick={() => showEditor(p.id)}
                  >
                    {copy.edit}
                  </button>
                </div>
                {view?.error && (
                  <p className="lm-error lm-row-error" role="alert">
                    {view.error}
                  </p>
                )}
              </article>
            )
          })}
        </div>
        {dirty && !editorOpen && (
          <div className="lm-pending">
            <span>{copy.unsaved}</span>
            <button
              type="button"
              className="set-btn primary"
              disabled={busy}
              onClick={() => void perform(() => save())}
            >
              {copy.save}
            </button>
          </div>
        )}
        {editorOpen && profile && (
          <div ref={editorHeading}>
            <LocalProfileEditor
              profile={profile}
              executable={draft?.executablePath ?? ''}
              modelPaths={snapshot?.models ?? []}
              isNew={!snapshot?.config.profiles.some((p) => p.id === selected)}
              disabled={active}
              busy={busy}
              dirty={dirty}
              logs={runtime?.logs ?? ''}
              copy={copy}
              update={update}
              changeKind={(kind) => {
                if (!draft) return
                const defaults = newLocalProfile(
                  kind,
                  draft.profiles.filter((p) => p.id !== selected),
                )
                update({
                  kind,
                  port: defaults.port,
                  contextSize: defaults.contextSize,
                  pooling: defaults.pooling,
                  arguments: defaults.arguments,
                  name:
                    profile.name === copy.chatModel || profile.name === copy.embeddingModel
                      ? kind === 'chat'
                        ? copy.chatModel
                        : copy.embeddingModel
                      : profile.name,
                })
              }}
              chooseModel={() => void choose('model')}
              save={() => void perform(() => save())}
              close={() => setEditorOpen(false)}
              remove={() => setConfirm('profile')}
            />
            <div className="lm-editor-runtime">
              <span>
                {copy.endpoint}: <code dir="ltr">http://127.0.0.1:{profile.port}/v1</code>
              </span>
              <button
                type="button"
                className="set-btn"
                disabled={busy || dirty || runtime?.state !== 'running'}
                onClick={() =>
                  void perform(async () =>
                    accept(await window.nawaLocalModels.control('restart', profile.id)),
                  )
                }
              >
                {copy.restart}
              </button>
              {isDefault(profile) && (
                <button
                  type="button"
                  className="set-btn"
                  disabled={busy || dirty || applyBlocked || runtime?.state !== 'running'}
                  onClick={() => void apply(profile)}
                >
                  {profile.kind === 'chat' ? copy.useChat : copy.useEmbedding}
                </button>
              )}
            </div>
          </div>
        )}
        {!!draft?.profiles.length && (
          <button
            type="button"
            className="set-btn lm-refresh"
            disabled={busy}
            onClick={() =>
              dirty
                ? setConfirm('refresh')
                : void perform(async () => accept(await window.nawaLocalModels.inspect(), true))
            }
          >
            {copy.refresh}
          </button>
        )}
        {confirm && (
          <div className="lm-confirm" ref={confirmation} role="group" aria-label={confirmText}>
            <p>{confirmText}</p>
            <button
              type="button"
              className="set-btn danger"
              disabled={busy}
              onClick={() =>
                void perform(async () => {
                  if (confirm === 'refresh') accept(await window.nawaLocalModels.inspect(), true)
                  else if (confirm === 'profile' && draft)
                    await save({
                      ...draft,
                      profiles: draft.profiles.filter((p) => p.id !== selected),
                    })
                  else if (typeof confirm === 'object')
                    accept(await window.nawaLocalModels.removeModel(confirm.model))
                  setConfirm(null)
                })
              }
            >
              {confirm === 'refresh' ? copy.refresh : copy.confirm}
            </button>
            <button type="button" className="set-btn" onClick={() => setConfirm(null)}>
              {copy.cancel}
            </button>
          </div>
        )}
      </section>
      <details
        className="lm-download-section"
        open={downloadsOpen}
        onToggle={(e) => setDownloadsOpen(e.currentTarget.open)}
      >
        <summary>{copy.downloadsSetup}</summary>
        <ModelDownloads
          snapshot={snapshot}
          copy={copy}
          busy={busy}
          downloading={downloading}
          perform={perform}
          download={download}
          assign={(path, target) => {
            if (!target) add('chat', path)
            else {
              setDraft(
                (value) =>
                  value && {
                    ...value,
                    profiles: value.profiles.map((p) =>
                      p.id === target ? { ...p, modelPath: path } : p,
                    ),
                  },
              )
              showEditor(target)
            }
            setDownloadsOpen(false)
          }}
          remove={(path) => setConfirm({ model: path })}
        />
      </details>
      {snapshot && ['downloading', 'failed'].includes(snapshot.download.state) && (
        <div className="lm-download" role="status">
          <span>
            {copy.downloadStatus}: {copy[snapshot.download.state]} {snapshot.download.name}
          </span>
          {snapshot.download.total > 0 && (
            <progress
              aria-label={copy.downloadStatus}
              value={snapshot.download.received}
              max={snapshot.download.total}
            />
          )}
          <small>
            {(snapshot.download.received / 1024 ** 3).toFixed(2)} /{' '}
            {(snapshot.download.total / 1024 ** 3).toFixed(2)} GiB
          </small>
          {downloading && (
            <button
              type="button"
              className="set-btn"
              onClick={() =>
                void window.nawaLocalModels.cancelDownload().catch((e) => setError(String(e)))
              }
            >
              {copy.cancel}
            </button>
          )}
          {snapshot.download.error && <p className="lm-error">{snapshot.download.error}</p>}
        </div>
      )}
      {notice && (
        <p className="lm-notice" role="status">
          {notice}
        </p>
      )}
      {error && (
        <p className="lm-error" role="alert">
          {error}
        </p>
      )}
      {!window.nawaLocalModels && (
        <p className="lm-error" role="alert">
          {copy.bridgeUnavailable}
        </p>
      )}
    </section>
  )
}
