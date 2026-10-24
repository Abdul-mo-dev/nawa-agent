import { useCallback, useEffect, useId, useRef, useState } from 'react'
import {
  REDACTED_AI_KEY,
  validateChatModels,
  isLoopbackApiUrl,
  type AiChatModel,
  type AiSettings,
  type AiModelPolicy,
} from '@genoffice/ai-provider/browser'
import type {
  RemoteEmbeddingProfile,
  RemoteEmbeddingSnapshot,
} from '../../../shared/remote-models-api'
import type { RagSettings } from '../../../shared/rag-api'
import { useI18n } from '../locale'
import { remoteModelStrings } from '../i18n/strings-remote-models'
import { usePanelActivity } from '../explorer/panel-state'
import { ModelPolicyEditor } from '../ModelPolicyEditor'
import { RemoteModelPicker } from './RemoteModelPicker'
import './remote-models.css'

type Role = 'chat' | 'embedding'
interface Draft extends RemoteEmbeddingProfile {
  role: Role
  isNew: boolean
  hasKey: boolean
  key?: string
  policy: AiModelPolicy
}
interface Row {
  id: string
  role: Role
  name: string
  model: string
  baseUrl: string
}
const message = (error: unknown) => (error instanceof Error ? error.message : String(error))
const sameUrl = (a: string, b: string) => a.replace(/\/+$/, '') === b.replace(/\/+$/, '')
const blank = (): Draft => ({
  id: `remote-${crypto.randomUUID()}`,
  name: '',
  role: 'chat',
  isNew: true,
  baseUrl: '',
  model: '',
  hasKey: false,
  key: '',
  modelRevision: '',
  dimensions: 0,
  maxInputTokens: 8192,
  documentPrefix: '',
  queryPrefix: '',
  allowRemote: false,
  policy: { mode: 'cloud', contextTokens: 32768, outputTokens: 4096 },
})
function chatProfile(draft: Draft): AiChatModel {
  return {
    id: draft.id,
    name: draft.name.trim(),
    provider: 'custom',
    config: {
      baseUrl: draft.baseUrl.trim().replace(/\/+$/, ''),
      model: draft.model.trim(),
      apiKey: draft.key ?? (draft.hasKey ? REDACTED_AI_KEY : ''),
      policy: draft.policy,
    },
  }
}
export function RemoteModelsSettings({
  blocked = false,
  embedding,
  onEmbeddingApplied,
  onEditingChange,
  onWorkingChange,
}: {
  blocked?: boolean
  embedding: RagSettings | null
  onEmbeddingApplied(settings: RagSettings): void
  onEditingChange(value: boolean): void
  onWorkingChange(value: boolean): void
}) {
  const { lang } = useI18n(),
    copy = remoteModelStrings[lang],
    id = useId()
  const [ai, setAi] = useState<AiSettings | null>(null)
  const [embeddings, setEmbeddings] = useState<RemoteEmbeddingSnapshot | null>(null)
  const [draft, setDraft] = useState<Draft | null>(null)
  const [working, setWorking] = useState(false),
    [error, setError] = useState(''),
    [notice, setNotice] = useState('')
  const [confirm, setConfirm] = useState<Row | 'discard' | null>(null)
  const alive = useRef(true),
    original = useRef(''),
    revision = useRef<string | undefined>('')
  const heading = useRef<HTMLHeadingElement>(null)
  const dirty = !!draft && JSON.stringify(draft) !== original.current
  const editing = !!draft
  const locked = working || blocked
  const chats = (ai?.chatModels ?? []).filter(
    (profile) => profile.provider === 'custom' && !profile.id.startsWith('runtime-'),
  )
  const rows: Row[] = [
    ...chats.map((profile) => ({
      id: profile.id,
      name: profile.name,
      role: 'chat' as const,
      model: profile.config.model,
      baseUrl: profile.config.baseUrl ?? '',
    })),
    ...(embeddings?.profiles ?? []).map((profile) => ({ ...profile, role: 'embedding' as const })),
  ]
  usePanelActivity(
    'provider',
    'remote-models',
    working
      ? { kind: 'busy', text: copy.working, dirty }
      : dirty
        ? { kind: 'unsaved', text: copy.unsaved }
        : null,
  )
  useEffect(() => onEditingChange(editing), [editing, onEditingChange])
  useEffect(() => onWorkingChange(working), [working, onWorkingChange])
  const reload = useCallback(async () => {
    const [settings, profiles] = await Promise.all([
      window.aiOffice.getAiSettings(),
      window.nawaRemoteEmbeddings.list(),
    ])
    if (alive.current) {
      setAi(settings)
      setEmbeddings(profiles)
    }
  }, [])
  useEffect(() => {
    alive.current = true
    if (!window.nawaRemoteEmbeddings) return
    const read = () => {
      void reload().catch((cause) => {
        if (alive.current) setError(message(cause))
      })
    }
    read()
    const offChat = window.aiOffice.onAiSettingsChanged?.(read)
    const offEmbedding = window.nawaRemoteEmbeddings.onChanged(read)
    return () => {
      alive.current = false
      offChat?.()
      offEmbedding()
    }
  }, [reload])
  const perform = async (action: () => Promise<void>) => {
    if (locked) return
    setWorking(true)
    setError('')
    setNotice('')
    try {
      await action()
    } catch (cause) {
      if (alive.current) setError(message(cause))
    } finally {
      if (alive.current) setWorking(false)
    }
  }
  const isDefault = (row: Row) =>
    row.role === 'chat'
      ? ai?.defaultChatModelId === row.id
      : !!embedding?.enabled &&
        embedding.backend === 'local' &&
        sameUrl(embedding.baseUrl, row.baseUrl) &&
        embedding.model === row.model
  const open = (row?: Row) => {
    let next = { ...blank(), name: copy.newProfile }
    if (row?.role === 'chat') {
      const model = chats.find((profile) => profile.id === row.id)!
      next = {
        ...next,
        id: model.id,
        name: model.name,
        model: model.config.model,
        baseUrl: model.config.baseUrl ?? '',
        isNew: false,
        key: undefined,
        hasKey: !!model.config.apiKey,
        policy: model.config.policy ?? {
          mode: isLoopbackApiUrl(model.config.baseUrl) ? 'local' : 'cloud',
          contextTokens: 32768,
          outputTokens: 4096,
        },
      }
    } else if (row) {
      const profile = embeddings!.profiles.find((item) => item.id === row.id)!
      next = { ...next, ...profile, role: 'embedding', isNew: false, key: undefined }
    }
    revision.current = next.role === 'chat' ? ai?.settingsRevision : embeddings?.revision
    original.current = next.isNew ? '' : JSON.stringify(next)
    setDraft(next)
    setError('')
    setNotice('')
    setConfirm(null)
    requestAnimationFrame(() => {
      heading.current?.scrollIntoView({ block: 'nearest' })
      heading.current?.focus({ preventScroll: true })
    })
  }
  const update = (patch: Partial<Draft>) => {
    setDraft((current) => current && { ...current, ...patch })
    setError('')
    setNotice('')
  }
  const candidate = (current: AiSettings, value: Draft): AiSettings => {
    if (value.key === REDACTED_AI_KEY) throw new Error(copy.invalidKey)
    const model = chatProfile(value)
    const next = {
      ...current,
      chatModels: (current.chatModels ?? []).some((profile) => profile.id === model.id)
        ? current.chatModels!.map((profile) => (profile.id === model.id ? model : profile))
        : [...(current.chatModels ?? []), model],
    }
    const url = new URL(model.config.baseUrl!)
    if (
      !['http:', 'https:'].includes(url.protocol) ||
      url.username ||
      url.password ||
      url.search ||
      url.hash
    )
      throw new Error(copy.invalidUrl)
    const invalid = validateChatModels(next)
    if (invalid) throw new Error(invalid)
    return next
  }
  const save = () =>
    perform(async () => {
      if (!draft) return
      if (draft.role === 'chat') {
        const current = await window.aiOffice.getAiSettings()
        if (current.settingsRevision !== revision.current) throw new Error(copy.conflict)
        await window.aiOffice.setAiSettings(candidate(current, draft))
      } else await window.nawaRemoteEmbeddings.save(draft, revision.current!, draft.key)
      await reload()
      if (alive.current) {
        setNotice(draft.role === 'embedding' ? copy.embeddingSaved : copy.saved)
        setDraft(null)
      }
      window.dispatchEvent(new Event('nawa:models-changed'))
    })
  const test = () =>
    perform(async () => {
      if (!draft) return
      if (draft.role === 'chat') {
        const next = candidate(await window.aiOffice.getAiSettings(), draft)
        const result = await window.aiOffice.testAiSettings({
          ...next,
          defaultChatModelId: draft.id,
          selectedChatModelId: draft.id,
        })
        if (alive.current && result.capabilities)
          setDraft(
            (current) =>
              current && { ...current, policy: { ...current.policy, tested: result.capabilities } },
          )
        if (!result.ok) throw new Error(result.error || copy.testFailed)
        setNotice(copy.tested)
      } else {
        const result = await window.nawaRemoteEmbeddings.test(draft, draft.key)
        if (alive.current && !draft.dimensions)
          setDraft((current) => current && { ...current, dimensions: result.dimensions })
        setNotice(`${copy.tested} ${result.dimensions}`)
      }
    })
  const apply = (row: Row) =>
    perform(async () => {
      if (row.role === 'chat') {
        const current = await window.aiOffice.getAiSettings()
        if (!current.chatModels?.some((profile) => profile.id === row.id))
          throw new Error(copy.conflict)
        await window.aiOffice.setAiSettings({ ...current, defaultChatModelId: row.id })
        window.dispatchEvent(new Event('nawa:models-changed'))
      } else {
        const result = await window.nawaRemoteEmbeddings.apply(row.id, embeddings!.revision)
        onEmbeddingApplied(result.settings)
      }
      await reload()
      setNotice(copy.applied)
    })
  const remove = (row: Row) =>
    perform(async () => {
      if (row.role === 'chat') {
        const current = await window.aiOffice.getAiSettings()
        if (current.defaultChatModelId === row.id) throw new Error(copy.activeDelete)
        await window.aiOffice.setAiSettings({
          ...current,
          chatModels: current.chatModels?.filter((profile) => profile.id !== row.id),
        })
      } else await window.nawaRemoteEmbeddings.remove(row.id, embeddings!.revision)
      await reload()
      setConfirm(null)
      setNotice(copy.removed)
    })
  const field = (
    key: 'name' | 'baseUrl' | 'model' | 'modelRevision' | 'documentPrefix' | 'queryPrefix',
    label: string,
  ) => (
    <label className="rm-field" key={key} htmlFor={`${id}-${key}`}>
      <span>{label}</span>
      <input
        id={`${id}-${key}`}
        className="set-input"
        value={draft![key]}
        placeholder={key === 'baseUrl' ? 'https://server.example/v1' : undefined}
        maxLength={key === 'name' ? 160 : key === 'model' ? 256 : 2048}
        dir={key === 'name' ? undefined : 'ltr'}
        spellCheck={false}
        required={['name', 'baseUrl', 'model'].includes(key)}
        onChange={(event) =>
          update({
            [key]: event.target.value,
            ...(['baseUrl', 'model'].includes(key)
              ? { policy: { ...draft!.policy, tested: undefined } }
              : {}),
            ...(key === 'baseUrl' && draft!.hasKey ? { key: '', hasKey: false } : {}),
          })
        }
      />
    </label>
  )
  if (!window.nawaRemoteEmbeddings)
    return (
      <p className="lm-error" role="alert">
        {copy.unavailable}
      </p>
    )
  return (
    <section className="rm-settings" aria-label={copy.title}>
      <div className="lm-section-heading">
        <div>
          <h4>{copy.title}</h4>
          <p className="lm-hint">{copy.intro}</p>
        </div>
        <button
          type="button"
          className="set-btn"
          disabled={locked || !!draft || !ai || !embeddings}
          onClick={() => open()}
        >
          {copy.add}
        </button>
      </div>
      {!ai || !embeddings ? (
        <p role="status">{copy.loading}</p>
      ) : !rows.length ? (
        <p className="lm-hint">{copy.empty}</p>
      ) : (
        <div className="rm-list">
          {rows.map((row) => (
            <article className="rm-row" key={`${row.role}:${row.id}`}>
              <div className="rm-description">
                <strong>{row.name}</strong>
                <span>
                  {copy[row.role]} · <bdi>{row.model}</bdi>
                </span>
                <bdi>{row.baseUrl}</bdi>
              </div>
              <div className="rm-actions">
                {isDefault(row) && <span className="rm-badge">{copy.current}</span>}
                <button
                  type="button"
                  className="set-btn"
                  disabled={locked || !!draft || (row.role === 'chat' && isDefault(row))}
                  onClick={() => void apply(row)}
                >
                  {copy.use}
                </button>
                <button
                  type="button"
                  className="set-btn"
                  disabled={locked || !!draft}
                  onClick={() => open(row)}
                >
                  {copy.edit}
                </button>
                <button
                  type="button"
                  className="set-btn danger"
                  title={isDefault(row) ? copy.activeDelete : undefined}
                  disabled={locked || !!draft || isDefault(row)}
                  onClick={() => setConfirm(row)}
                >
                  {copy.remove}
                </button>
              </div>
            </article>
          ))}
        </div>
      )}
      {draft && (
        <form
          className="rm-editor"
          aria-label={copy.editProfile}
          onSubmit={(event) => {
            event.preventDefault()
            void save()
          }}
        >
          <h4 tabIndex={-1} ref={heading}>
            {draft.isNew ? copy.newProfile : copy.editProfile}
          </h4>
          <fieldset disabled={locked}>
            <div className="rm-fields">
              {field('name', copy.name)}
              <label className="rm-field" htmlFor={`${id}-role`}>
                <span>{copy.role}</span>
                <select
                  id={`${id}-role`}
                  aria-label={copy.role}
                  className="set-input"
                  disabled={!draft.isNew}
                  value={draft.role}
                  onChange={(event) => {
                    const role = event.target.value as Role
                    revision.current = role === 'chat' ? ai?.settingsRevision : embeddings?.revision
                    update({ role, model: '' })
                  }}
                >
                  <option value="chat">{copy.chat}</option>
                  <option value="embedding">{copy.embedding}</option>
                </select>
              </label>
              {field('baseUrl', copy.url)}
              <label className="rm-field" htmlFor={`${id}-key`}>
                <span>{copy.key}</span>
                <input
                  id={`${id}-key`}
                  className="set-input"
                  type="password"
                  autoComplete="off"
                  spellCheck={false}
                  dir="ltr"
                  maxLength={8192}
                  value={draft.key ?? ''}
                  placeholder={draft.hasKey && draft.key === undefined ? copy.savedKey : undefined}
                  onChange={(event) => update({ key: event.target.value })}
                />
              </label>
            </div>
            <RemoteModelPicker
              key={`${draft.id}:${draft.role}`}
              profile={draft}
              onChange={(model) =>
                update({ model, policy: { ...draft.policy, tested: undefined } })
              }
            />
            {draft.hasKey && draft.key === undefined && (
              <button
                type="button"
                className="set-btn"
                onClick={() => update({ key: '', hasKey: false })}
              >
                {copy.removeKey}
              </button>
            )}
            <p className="lm-hint">{copy.keyScope}</p>
            {draft.role === 'chat' ? (
              <ModelPolicyEditor
                provider="custom"
                config={chatProfile(draft).config}
                onChange={(config) => update({ policy: config.policy ?? {} })}
              />
            ) : (
              <>
                <label className="rm-consent">
                  <input
                    type="checkbox"
                    checked={draft.allowRemote}
                    onChange={(event) => update({ allowRemote: event.target.checked })}
                  />
                  {copy.allowRemote}
                </label>
                <p className="lm-hint">{copy.remoteHint}</p>
                <details>
                  <summary>{copy.advanced}</summary>
                  <div className="rm-fields">
                    {(['dimensions', 'maxInputTokens'] as const).map((key) => (
                      <label className="rm-field" key={key} htmlFor={`${id}-${key}`}>
                        <span>{key === 'dimensions' ? copy.dimensions : copy.tokens}</span>
                        <input
                          id={`${id}-${key}`}
                          className="set-input"
                          type="number"
                          min={key === 'dimensions' ? 0 : 128}
                          max={key === 'dimensions' ? 16384 : 32768}
                          value={draft[key]}
                          onChange={(event) => update({ [key]: Number(event.target.value) })}
                        />
                      </label>
                    ))}
                    {field('modelRevision', copy.revision)}
                    {field('documentPrefix', copy.documentPrefix)}
                    {field('queryPrefix', copy.queryPrefix)}
                  </div>
                </details>
                <p className="lm-hint">{copy.reindex}</p>
              </>
            )}
            <div className="rm-actions">
              <button type="submit" className="set-btn primary">
                {copy.save}
              </button>
              <button type="button" className="set-btn" onClick={() => void test()}>
                {copy.test}
              </button>
              <button
                type="button"
                className="set-btn"
                onClick={() => (dirty ? setConfirm('discard') : setDraft(null))}
              >
                {copy.cancel}
              </button>
            </div>
          </fieldset>
        </form>
      )}
      {confirm && (
        <div
          className="lm-confirm"
          role="alertdialog"
          aria-label={confirm === 'discard' ? copy.discard : copy.removeConfirm}
        >
          <p>{confirm === 'discard' ? copy.discard : copy.removeConfirm}</p>
          <div className="rm-actions">
            <button
              type="button"
              className="set-btn danger"
              disabled={locked}
              onClick={() =>
                confirm === 'discard' ? (setDraft(null), setConfirm(null)) : void remove(confirm)
              }
            >
              {confirm === 'discard' ? copy.discardAction : copy.remove}
            </button>
            <button
              type="button"
              className="set-btn"
              disabled={locked}
              onClick={() => setConfirm(null)}
            >
              {confirm === 'discard' ? copy.keepEditing : copy.cancel}
            </button>
          </div>
        </div>
      )}
      {working && <p role="status">{copy.working}</p>}
      {notice && (
        <p role="status" className="lm-notice">
          {notice}
        </p>
      )}
      {error && (
        <p role="alert" className="lm-error">
          {error}
        </p>
      )}
    </section>
  )
}
