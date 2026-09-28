import { useEffect, useId, useRef, useState } from 'react'
import { RagSettings } from '../rag/RagSettings'
import { useSidebarText } from '../explorer/sidebar-i18n'
import { usePanelActivity } from '../explorer/panel-state'
import { MyAgentDiagnostics } from './MyAgentDiagnostics'
import type { WorkspaceTab } from '../explorer/workspace-tabs-model'
import type { MyAgentConfigPatch, MyAgentDiagnostics as DiagnosticReport, MyAgentLaunchSettings, MyAgentLocalView, MyAgentSnapshot } from '../../../shared/myagent-settings-api'
import './myagent.css'

export function draftConfiguration(snapshot: MyAgentSnapshot): MyAgentConfigPatch | null {
  const c = snapshot.configuration
  if (!c) return null
  const { apiKeyConfigured: _key, ...provider } = c.provider
  return { provider, rag: {
    roots: c.rag.roots.map(root => ({ ...root })), embeddingBaseUrl: c.rag.embeddingBaseUrl,
    embeddingModel: c.rag.embeddingModel, managedLlamaProfileId: c.rag.managedLlamaProfileId,
    allowRemoteEmbeddings: c.rag.allowRemoteEmbeddings, embeddingBatchSize: c.rag.embeddingBatchSize,
    embeddingRequestTimeoutSeconds: c.rag.embeddingRequestTimeoutSeconds, allowedExtensions: c.rag.allowedExtensions,
    maxFilesPerJob: c.rag.maxFilesPerJob, maxFileSizeMb: c.rag.maxFileSizeMb,
    visualMode: c.rag.visualMode, visualModel: c.rag.visualModel,
    allowRemoteVisualExtraction: c.rag.allowRemoteVisualExtraction,
    maxPages: c.rag.maxPages, extractEmbeddedImages: c.rag.extractEmbeddedImages, renderVisualPages: c.rag.renderVisualPages,
    maxImagesPerFile: c.rag.maxImagesPerFile, visualExtractionTimeoutSeconds: c.rag.visualExtractionTimeoutSeconds,
    visualExtractionRetryCount: c.rag.visualExtractionRetryCount, tesseractPath: c.rag.tesseractPath ?? '', libreOfficePath: c.rag.libreOfficePath ?? '',
  } }
}

export type MyAgentSettingsSection = 'status' | 'models' | 'folders' | 'extraction' | 'launch'

export function MyAgentSettings({ activityTab = 'provider', section, connectionPending = false }: { activityTab?: WorkspaceTab; section?: MyAgentSettingsSection; connectionPending?: boolean }) {
  const { s, dir } = useSidebarText(), id = useId()
  const [snapshot, setSnapshot] = useState<MyAgentSnapshot | null>(null)
  const [draft, setDraft] = useState<MyAgentConfigPatch | null>(null)
  const [local, setLocal] = useState<MyAgentLocalView | null>(null)
  const [launch, setLaunch] = useState<MyAgentLaunchSettings | null>(null)
  const [busy, setBusy] = useState(false), [error, setError] = useState(''), [notice, setNotice] = useState('')
  const [restart, setRestart] = useState<string[]>([])
  const [confirm, setConfirm] = useState<'stop' | 'restart' | null>(null)
  const [connectionOpen, setConnectionOpen] = useState(true)
  const [connectionDirty, setConnectionDirty] = useState(false), [connected, setConnected] = useState(false)
  const connectionBlocked = connectionDirty || connectionPending
  const [diagnostics, setDiagnostics] = useState<DiagnosticReport | null>(null)
  const [providerKey, setProviderKey] = useState(''), [embeddingKey, setEmbeddingKey] = useState('')
  const [removeProviderKey, setRemoveProviderKey] = useState(false), [removeEmbeddingKey, setRemoveEmbeddingKey] = useState(false)
  const alive = useRef(true), working = useRef(false), dirtyRef = useRef(false)
  const baseline = snapshot ? draftConfiguration(snapshot) : null
  const dirty = !!draft && (JSON.stringify(draft) !== JSON.stringify(baseline) || !!providerKey || !!embeddingKey || removeProviderKey || removeEmbeddingKey)
  const launchDirty = !!launch && JSON.stringify(launch) !== JSON.stringify(local?.settings)
  dirtyRef.current = dirty
  usePanelActivity(activityTab, 'myagent-settings', busy ? { kind: 'busy', text: s('Managing MyAgent…') } : error ? { kind: 'error', text: error } : dirty || launchDirty ? { kind: 'unsaved', text: s('Unsaved MyAgent settings') } : null)

  const reload = async (replace = false) => {
    const results = await Promise.allSettled([window.nawaMyAgent.inspect(), window.nawaMyAgent.local()])
    if (!alive.current) return
    const [server, localResult] = results
    if (localResult.status === 'fulfilled') {
      setLocal(localResult.value)
      setLaunch(previous => previous ?? localResult.value.settings)
    }
    if (server.status === 'fulfilled') {
      setConnected(true)
      if (replace || !dirtyRef.current) { setSnapshot(server.value); setDraft(draftConfiguration(server.value)) }
      else setSnapshot(previous => previous ? { ...previous, health: server.value.health, profiles: server.value.profiles, runtimes: server.value.runtimes, warnings: server.value.warnings } : server.value)
    } else { setConnected(false); throw server.reason }
    if (localResult.status === 'rejected') throw localResult.reason
  }
  const perform = async (action: () => Promise<void>) => {
    if (working.current) return
    working.current = true; setBusy(true); setError(''); setNotice('')
    try { await action() } catch (e) { if (alive.current) setError(e instanceof Error ? e.message : String(e)) }
    finally { working.current = false; if (alive.current) setBusy(false) }
  }
  useEffect(() => {
    alive.current = true
    if (!window.nawaMyAgent) { setError(s('MyAgent settings bridge is unavailable. Rebuild and restart Nawa.')); return }
    void perform(() => reload())
    const connectionChanged = () => { setDiagnostics(null); if (!dirtyRef.current) void perform(() => reload(true)); else setNotice(s('Connection changed. Discard the server draft and refresh before saving.')) }
    window.addEventListener('nawa:rag-settings-changed', connectionChanged)
    return () => { alive.current = false; window.removeEventListener('nawa:rag-settings-changed', connectionChanged) }
  }, [])
  const update = <K extends 'provider' | 'rag'>(part: K, field: keyof MyAgentConfigPatch[K], value: unknown) => {
    setDraft(previous => previous && { ...previous, [part]: { ...previous[part], [field]: value } }); setNotice('')
  }
  const field = (label: string, value: string | number, change: (value: string) => void, type = 'text', min?: number, max?: number, help?: string) => <label className="nawa-rag-field" key={label}><span>{s(label)}</span><input aria-label={s(label)} className="set-input" type={type} value={value} disabled={busy} min={min} max={max} step={type === 'number' ? 1 : undefined} onChange={e => change(e.target.value)} spellCheck={false}/>{help && <small>{s(help)}</small>}</label>
  const check = (label: string, value: boolean, change: (value: boolean) => void) => <label className="nawa-rag-check"><input type="checkbox" checked={value} disabled={busy} onChange={e => change(e.target.checked)}/>{s(label)}</label>
  const credential = (label: string, stored: boolean, value: string, change: (value: string) => void, removed: boolean, remove: (value: boolean) => void) => <>
    <label className="nawa-rag-field"><span>{s(label)}</span><input aria-label={s(label)} className="set-input" type="password" autoComplete="off" disabled={busy || removed} value={value} placeholder={s(stored ? 'Stored on MyAgent — blank keeps the current key' : 'Optional provider key')} onChange={e => change(e.target.value)}/></label>
    {stored && check(s('Remove stored key') + ' — ' + s(label), removed, remove)}
  </>
  const save = () => perform(async () => {
    if (!snapshot || !draft) return
    const patch = { ...draft, provider: { ...draft.provider, ...(providerKey.trim() ? { apiKey: providerKey } : {}), ...(removeProviderKey ? { clearApiKey: true } : {}) }, rag: { ...draft.rag, ...(embeddingKey.trim() ? { embeddingApiKey: embeddingKey } : {}), ...(removeEmbeddingKey ? { clearEmbeddingApiKey: true } : {}) } }
    const result = await window.nawaMyAgent.saveConfiguration(snapshot.serverUrl, snapshot.revision, patch)
    if (!alive.current) return
    setSnapshot(result.snapshot); setDraft(draftConfiguration(result.snapshot)); setProviderKey(''); setEmbeddingKey(''); setRemoveProviderKey(false); setRemoveEmbeddingKey(false)
    setRestart(result.restartRequired ? result.restartRequiredSettings : [])
    setDiagnostics(null)
    setNotice(result.warning || s(result.restartRequired ? 'Server settings saved. Restart MyAgent to apply these changes.' : result.applied ? 'Server settings saved and applied.' : 'Server settings saved.'))
  })
  const control = (action: 'start' | 'stop' | 'restart') => perform(async () => {
    setConfirm(null)
    setDiagnostics(null)
    const result = await window.nawaMyAgent.control(action)
    if (!alive.current) return
    if (action === 'stop') { setSnapshot(null); setDraft(null); setNotice(s(result.message)); const next = await window.nawaMyAgent.local(); setLocal(next); return }
    await reload(true); setRestart([]); setNotice(s(result.message))
  })
  const choose = (kind: 'server' | 'directory') => perform(async () => {
    const path = await window.nawaMyAgent.choosePath(kind)
    if (path && alive.current) setLaunch(previous => previous && { ...previous, [kind === 'server' ? 'serverPath' : 'configurationDirectory']: path })
  })
  return <section className={`nawa-myagent-settings nawa-rag-settings${section ? ' is-compact' : ''}`} aria-label="MyAgent settings" dir={dir}>
    {!section && <><h3 className="set-pane-title">MyAgent</h3>
    <p>{s('Connect to MyAgent and manage its server, models, and shared document folders. Nawa’s chat model is configured separately.')}</p>
    <details open={connectionOpen} onToggle={e => setConnectionOpen(e.currentTarget.open)}><summary>{s('Connection')}</summary><RagSettings myAgentOnly suspended={busy} onDirtyChanged={setConnectionDirty}/></details></>}
    <section hidden={!!section && section !== 'status'} aria-labelledby={`${id}-status`}>
      <div className="nawa-myagent-heading"><h4 id={`${id}-status`}>{s('Server status')}</h4><button type="button" className="set-btn" disabled={busy} onClick={() => void perform(() => reload())}>{s('Refresh status')}</button></div>
      <p role="status">{snapshot && connected ? `${s('Connected')} · ${snapshot.health.status} · ${snapshot.health.version}` : s('Not connected. Save the connection, then start or refresh the server.')}</p>
      {snapshot?.health.userSetupRequired && <p>{s('MyAgent administrator user setup is incomplete. The service key can manage this server; create users in MyAgent.Server.UI if needed.')}</p>}
      {snapshot?.health.components?.length ? <ul className="nawa-myagent-components">{snapshot.health.components.map(c => <li key={c.name}><strong>{c.name}</strong> · {c.status}{c.detail && <span>{c.detail}</span>}</li>)}</ul> : null}
      {snapshot?.warnings.map((warning, index) => <p className="nawa-myagent-warning" key={index}>{warning}</p>)}
      <div className="nawa-rag-actions"><button type="button" className="set-btn" disabled={busy || connectionBlocked} onClick={() => void perform(async () => { const report = await window.nawaMyAgent.diagnostics(); if (alive.current) setDiagnostics(report) })}>{s('Check readiness')}</button></div>
      {diagnostics && <MyAgentDiagnostics report={diagnostics} disabled={busy} onCopy={() => void perform(async () => { await navigator.clipboard.writeText(JSON.stringify(diagnostics, null, 2)); setNotice(s('Readiness diagnostics copied.')) })}/>}
      <div className="nawa-rag-actions"><button type="button" className="set-btn" disabled={busy || launchDirty || dirty || connectionBlocked} onClick={() => void control('start')}>{s('Start server')}</button><button type="button" className="set-btn" disabled={busy || launchDirty || dirty || connectionBlocked} onClick={() => setConfirm('stop')}>{s('Stop server')}</button><button type="button" className="set-btn" disabled={busy || launchDirty || dirty || connectionBlocked} onClick={() => setConfirm('restart')}>{s('Restart server')}</button></div>
      {confirm && <div role="group" aria-label={s('Confirm server action')} className="nawa-myagent-warning"><p>{s('Stopping or restarting MyAgent interrupts its active chats, indexing, and model requests, including other clients.')}</p><button type="button" className="set-btn" disabled={busy} onClick={() => void control(confirm)}>{s(confirm === 'stop' ? 'Confirm stop' : 'Confirm restart')}</button><button type="button" className="set-btn" onClick={() => setConfirm(null)}>{s('Cancel')}</button></div>}
      {restart.length > 0 && <p className="nawa-myagent-warning" role="status">{s('Restart required')}: {restart.join(', ')}</p>}
    </section>
    {draft && snapshot?.configuration && <fieldset disabled={busy || connectionBlocked} className="nawa-myagent-fields">
      <legend hidden={!!section}>{s('Server configuration')}</legend>
      <details hidden={!!section && section !== 'models'} open><summary>{s('Chat and classification model')}</summary>
        <p hidden={!!section}>{s('This model runs MyAgent’s own agent and text classification. It does not change Nawa’s selected chat model.')}</p>
        {field('Chat API base URL', draft.provider.baseUrl, value => update('provider', 'baseUrl', value))}
        {field('MyAgent chat model', draft.provider.model, value => update('provider', 'model', value))}
        <label className="nawa-rag-field"><span>{s('Managed chat runtime')}</span><select className="set-input" aria-label={s('Managed chat runtime')} value={draft.provider.managedLlamaProfileId} onChange={e => update('provider', 'managedLlamaProfileId', e.target.value)}><option value="">{s('External API / manual endpoint')}</option>{snapshot.profiles.filter(p => p.kind.toLowerCase() === 'chat').map(p => <option key={p.id} value={p.id}>{p.displayName}</option>)}{draft.provider.managedLlamaProfileId && !snapshot.profiles.some(p => p.kind.toLowerCase() === 'chat' && p.id === draft.provider.managedLlamaProfileId) && <option value={draft.provider.managedLlamaProfileId}>{draft.provider.managedLlamaProfileId}</option>}</select><small>{s('Runtime selection controls startup. Enter that runtime’s API URL and served model alias in the fields above.')}</small></label>
        {credential('Chat provider API key', snapshot.configuration.provider.apiKeyConfigured, providerKey, setProviderKey, removeProviderKey, setRemoveProviderKey)}
        <div className="nawa-rag-grid">{field('Context window tokens (0 = automatic)', draft.provider.contextWindowTokens, value => update('provider', 'contextWindowTokens', Number(value)), 'number', 0, 10000000)}{field('Maximum output tokens (0 = automatic)', draft.provider.maximumOutputTokens, value => update('provider', 'maximumOutputTokens', Number(value)), 'number', 0, 1000000)}{field('Chat request timeout (seconds)', draft.provider.requestTimeoutSeconds, value => update('provider', 'requestTimeoutSeconds', Number(value)), 'number', 1, 3600)}{field('Concurrent chat requests', draft.provider.maximumConcurrentRequests, value => update('provider', 'maximumConcurrentRequests', Number(value)), 'number', 1, 64)}</div>
      </details>
      <details hidden={!!section && section !== 'models'} open={!section || undefined}><summary>{s('Embedding model')}</summary>
        <p hidden={!!section}>{s('After changing embedding or extraction settings, index / refresh the affected files in Knowledge.')}</p>
        {field('MyAgent embedding API URL', draft.rag.embeddingBaseUrl, value => update('rag', 'embeddingBaseUrl', value))}
        {field('MyAgent embedding model', draft.rag.embeddingModel, value => update('rag', 'embeddingModel', value))}
        <label className="nawa-rag-field"><span>{s('Managed embedding runtime')}</span><select className="set-input" aria-label={s('Managed embedding runtime')} value={draft.rag.managedLlamaProfileId} onChange={e => update('rag', 'managedLlamaProfileId', e.target.value)}><option value="">{s('External API / manual endpoint')}</option>{snapshot.profiles.filter(p => p.kind.toLowerCase().includes('embed')).map(p => <option key={p.id} value={p.id}>{p.displayName}</option>)}{draft.rag.managedLlamaProfileId && !snapshot.profiles.some(p => p.kind.toLowerCase().includes('embed') && p.id === draft.rag.managedLlamaProfileId) && <option value={draft.rag.managedLlamaProfileId}>{draft.rag.managedLlamaProfileId}</option>}</select><small>{s('Runtime selection controls startup. Enter that runtime’s API URL and served model alias in the fields above.')}</small></label>
        {credential('Embedding provider API key', snapshot.configuration.rag.embeddingApiKeyConfigured, embeddingKey, setEmbeddingKey, removeEmbeddingKey, setRemoveEmbeddingKey)}
        {check('Allow sending indexed text to a remote embedding provider', draft.rag.allowRemoteEmbeddings, value => update('rag', 'allowRemoteEmbeddings', value))}
        <div className="nawa-rag-grid">{field('Embedding batch size', draft.rag.embeddingBatchSize, value => update('rag', 'embeddingBatchSize', Number(value)), 'number', 1, 1000)}{field('Embedding timeout (seconds)', draft.rag.embeddingRequestTimeoutSeconds, value => update('rag', 'embeddingRequestTimeoutSeconds', Number(value)), 'number', 1, 3600)}</div>
      </details>
      <details hidden={!!section && section !== 'folders'} open><summary>{s('Shared RAG folders')}</summary><p hidden={!!section}>{s('MyAgent can index files inside these folders. The assistant can read only files selected in Nawa. Folder changes require a server restart.')}</p>
        {draft.rag.roots.map((root, index) => <div className="nawa-myagent-root" key={index}>
          {field('Folder ID', root.id, value => update('rag', 'roots', draft.rag.roots.map((r, n) => n === index ? { ...r, id: value } : r)))}
          {field('Folder display name', root.displayName, value => update('rag', 'roots', draft.rag.roots.map((r, n) => n === index ? { ...r, displayName: value } : r)))}
          {field('Shared folder path', root.path, value => update('rag', 'roots', draft.rag.roots.map((r, n) => n === index ? { ...r, path: value } : r)))}
          <div className="nawa-rag-actions"><button type="button" className="set-btn" onClick={() => void perform(async () => { const path = await window.nawaMyAgent.choosePath('directory'); if (path) update('rag', 'roots', draft.rag.roots.map((r, n) => n === index ? { ...r, path } : r)) })}>{s('Choose folder')}</button><button type="button" className="set-btn" onClick={() => update('rag', 'roots', draft.rag.roots.filter((_, n) => n !== index))}>{s('Remove folder')}</button></div>
        </div>)}
        <button type="button" className="set-btn" onClick={() => update('rag', 'roots', [...draft.rag.roots, { id: '', displayName: '', path: '' }])}>{s('Add shared folder')}</button>
      </details>
      <details hidden={!!section && section !== 'extraction'} open={section === 'extraction' || undefined}><summary hidden={!!section}>{s('Indexing and visual extraction')}</summary>
        <p hidden={!!section}>{s('Blank extractor paths use MyAgent’s installed defaults. These settings do not install software. After saving, restart if requested and refresh affected files.')}</p>
        <details open={!section || undefined}><summary>{s('File limits')}</summary>
        {field('Allowed file extensions', draft.rag.allowedExtensions.join(', '), value => update('rag', 'allowedExtensions', value.split(/[\s,]+/).filter(Boolean)))}
        <div className="nawa-rag-grid">{field('Files per indexing job', draft.rag.maxFilesPerJob, value => update('rag', 'maxFilesPerJob', Number(value)), 'number', 1, 10000)}{field('Maximum file size (MiB)', draft.rag.maxFileSizeMb, value => update('rag', 'maxFileSizeMb', Number(value)), 'number', 1, 10240)}</div>
        {field('Maximum pages per file (0 = unlimited)', draft.rag.maxPages, value => update('rag', 'maxPages', Number(value)), 'number', 0, 10000)}
        </details>
        <details open={!section || undefined}><summary>{s('OCR and Office')}</summary>
        {field('Tesseract OCR executable path', draft.rag.tesseractPath, value => update('rag', 'tesseractPath', value))}
        {field('LibreOffice executable path', draft.rag.libreOfficePath, value => update('rag', 'libreOfficePath', value))}
        </details>
        <details open={!section || undefined}><summary>{s('Visual extraction')}</summary>
        <label className="nawa-rag-field"><span>{s('Visual extraction mode')}</span><select className="set-input" aria-label={s('Visual extraction mode')} value={draft.rag.visualMode} onChange={e => update('rag', 'visualMode', e.target.value)}>{['None', 'AssetsOnly', 'OcrOnly', 'VlmCaption', 'VlmDetailed', 'OcrAndVlm'].map(value => <option key={value}>{value}</option>)}</select></label>
        {field('Visual model', draft.rag.visualModel, value => update('rag', 'visualModel', value))}
        {check('Allow remote visual extraction', draft.rag.allowRemoteVisualExtraction, value => update('rag', 'allowRemoteVisualExtraction', value))}
        {check('Extract embedded images', draft.rag.extractEmbeddedImages, value => update('rag', 'extractEmbeddedImages', value))}
        {check('Render pages for visual extraction', draft.rag.renderVisualPages, value => update('rag', 'renderVisualPages', value))}
        {field('Maximum images per file', draft.rag.maxImagesPerFile, value => update('rag', 'maxImagesPerFile', Number(value)), 'number', 0, 10000)}
        </details>
        <details open={!section || undefined}><summary>{s('Timeouts and retries')}</summary>
        <div className="nawa-rag-grid">{field('Visual extraction timeout (seconds)', draft.rag.visualExtractionTimeoutSeconds, value => update('rag', 'visualExtractionTimeoutSeconds', Number(value)), 'number', 1, 3600)}{field('Visual extraction retries', draft.rag.visualExtractionRetryCount, value => update('rag', 'visualExtractionRetryCount', Number(value)), 'number', 0, 20)}</div>
        </details>
      </details>
      <div className="nawa-settings-footer" hidden={!!section && !dirty}><p>{s(dirty ? 'Unsaved server changes' : 'Server settings loaded')}</p><div className="nawa-rag-actions"><button type="button" className="set-btn" disabled={!dirty} onClick={() => { setDraft(baseline); setProviderKey(''); setEmbeddingKey(''); setRemoveProviderKey(false); setRemoveEmbeddingKey(false); setError(''); setNotice('') }}>{s('Discard server changes')}</button><button type="button" className="set-btn primary" disabled={!dirty} onClick={() => void save()}>{s('Save server settings')}</button></div></div>
    </fieldset>}
    {snapshot?.profiles.length ? <details hidden={!!section && section !== 'models'}><summary>{s('Managed model runtimes')}</summary>{snapshot.profiles.map(profile => {
      const runtime = snapshot.runtimes.find(r => r.profileId === profile.id)
      return <div className="nawa-myagent-runtime" key={profile.id}><strong>{profile.displayName}</strong><p>{profile.kind} · {profile.model || s('Model not configured')} · {runtime?.state || s('Unknown')}</p>{runtime?.error && <p className="nawa-rag-error">{runtime.error}</p>}<div className="nawa-rag-actions">{(['start', 'stop'] as const).map(action => <button type="button" className="set-btn" key={action} disabled={busy || dirty || connectionBlocked || !profile.enabled || action === 'start' && !profile.modelConfigured} onClick={() => void perform(async () => { await window.nawaMyAgent.model(action, profile.id); await reload(); setNotice(s('Model runtime updated.')) })}>{s(action === 'start' ? 'Start model' : 'Stop model')}</button>)}</div></div>
    })}</details> : null}
    <details hidden={!!section && section !== 'launch'} open={section === 'launch' || undefined}><summary>{s('Local server launch')}</summary><p hidden={!!section}>{s('Use the installed MyAgentServer Windows service, or choose a MyAgent server executable. Nawa creates a configuration only if appsettings.json is missing; an existing configuration is preserved.')}</p>
      {local && <p>{s('Windows service')}: {local.serviceState}{local.processId ? ` · PID ${local.processId}` : ''}</p>}
      {launch && <><label className="nawa-rag-field"><span>{s('Launch mode')}</span><select className="set-input" aria-label={s('Launch mode')} disabled={busy} value={launch.mode} onChange={e => setLaunch({ ...launch, mode: e.target.value as MyAgentLaunchSettings['mode'] })}><option value="service">{s('Windows service')}</option><option value="process">{s('Server process')}</option></select></label>
        {launch.mode === 'process' && <>{field('MyAgent server executable', launch.serverPath, value => setLaunch({ ...launch, serverPath: value }))}<button type="button" className="set-btn" disabled={busy} onClick={() => void choose('server')}>{s('Choose server executable')}</button>{field('Server configuration directory', launch.configurationDirectory, value => setLaunch({ ...launch, configurationDirectory: value }))}<button type="button" className="set-btn" disabled={busy} onClick={() => void choose('directory')}>{s('Choose configuration directory')}</button></>}
        <div className="nawa-rag-actions"><button type="button" className="set-btn" disabled={busy || !launchDirty} onClick={() => setLaunch(local!.settings)}>{s('Discard launch changes')}</button><button type="button" className="set-btn" disabled={busy || !launchDirty} onClick={() => void perform(async () => { const result = await window.nawaMyAgent.saveLaunch(launch); setLocal(result); setLaunch(result.settings); setNotice(s('Local launch settings saved.')) })}>{s('Save launch settings')}</button></div>
      </>}
      <p hidden={!!section}>{s('Install server dependencies and add GGUF runtime profiles using MyAgent.Server.UI Setup and Runtime tabs. Saved profiles appear here after refreshing.')}</p>
    </details>
    {notice && <p role="status">{notice}</p>}{error && <p className="nawa-rag-error" role="alert">{error}</p>}
  </section>
}
