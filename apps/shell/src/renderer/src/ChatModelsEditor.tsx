import { useState } from 'react'
import { useSidebarText } from './explorer/sidebar-i18n'
import type { AiSettings, AiProviderId } from '@genoffice/ai-provider'
import { applyChatModel, validateChatModels, type AiChatModel } from '@genoffice/ai-provider/browser'
import type { AiCatalogEntry } from '../../shared/home-api'
import './chat-models-settings.css'

export function ChatModelsEditor({ settings, catalog, onChange }: {
  settings: AiSettings
  catalog: AiCatalogEntry[]
  onChange: (settings: AiSettings) => void
}) {
  const { s } = useSidebarText()
  const [expanded, setExpanded] = useState<string | null>(null)
  const [testing, setTesting] = useState<string | null>(null)
  const [testMessage, setTestMessage] = useState<{ id: string; text: string } | null>(null)
  const models = settings.chatModels ?? []
  const update = (id: string, patch: Partial<AiChatModel>) => { setTestMessage(null); onChange({ ...settings,
    chatModels: models.map(model => model.id === id ? { ...model, ...patch } : model) }) }
  const add = () => {
    const provider = settings.provider
    const source = settings.providers[provider]
    const profile: AiChatModel = { id: crypto.randomUUID(), name: `${catalog.find(c => c.id === provider)?.label || provider} ${models.length + 1}`, provider, config: { ...source } }
    onChange({ ...settings, chatModels: [...models, profile] })
    setExpanded(profile.id)
  }
  return <section className="nawa-models-settings" aria-label={s("Saved chat models")}>
    <div className="nawa-models-title"><h4>{s("Saved chat models")}</h4><button type="button" className="set-btn" onClick={add} disabled={models.length >= 64}>{s("+ Add current model")}</button></div>
    <p>{s('Save reusable connections here. Choose a model for the current conversation in Chat.')}</p>
    <label className="nawa-model-default">{s('Default chat model')}<select aria-label={s('Default chat model')} value={settings.defaultChatModelId || ''} onChange={event => onChange({ ...settings, defaultChatModelId: event.target.value || undefined })}><option value="">{s('Use provider connection')}</option>{models.map(model => <option value={model.id} key={model.id}>{model.name}</option>)}</select></label>
    <p>{s('Chats using “Default” follow this setting. A specific model selected in Chat stays with that conversation.')}</p>
    {!models.length && <p>{s('Configure the provider above, then add it as a saved model.')}</p>}
    {models.map((model, index) => {
      const meta = catalog.find(c => c.id === model.provider)
      const config = (patch: Partial<AiChatModel['config']>) => update(model.id, { config: { ...model.config, ...patch } })
      return <details className="nawa-model-card" key={model.id} open={expanded === model.id}>
        <summary onClick={event => { event.preventDefault(); setExpanded(value => value === model.id ? null : model.id) }}>{model.name || s('Model {number}', { number: index + 1 })} <small>{model.provider} · {model.config.model || s('Model ID required')}</small></summary>
        <fieldset disabled={!!testing}>
        <div className="nawa-model-fields">
          <label>{s("Display name")}<input aria-label={`Model ${index + 1} name`} value={model.name} maxLength={160} onChange={event => update(model.id, { name: event.target.value })} /></label>
          <label>{s("Provider")}<select aria-label={`Model ${index + 1} provider`} value={model.provider} onChange={event => {
            const provider = event.target.value as AiProviderId
            // Intentional provider change starts with that provider's saved config, not another provider's key.
            update(model.id, { provider, config: { ...settings.providers[provider] } })
          }}>{catalog.map(entry => <option key={entry.id} value={entry.id}>{entry.label}</option>)}</select></label>
          <label>{s("Model ID")}<input aria-label={`Model ${index + 1} ID`} list={`nawa-model-options-${model.id}`} value={model.config.model} maxLength={256} spellCheck={false} onChange={event => config({ model: event.target.value })} /><datalist id={`nawa-model-options-${model.id}`}>{meta?.models.map(id => <option value={id} key={id} />)}</datalist></label>
          {model.provider === 'codex' ? <label>{s("CLI path (optional)")}<input value={model.config.cliPath || ''} autoComplete="off" onChange={event => config({ cliPath: event.target.value })} /></label> : model.provider !== 'genspark' ? <><label>{s("Base URL")}{model.provider !== 'custom' && ' (optional)'}<input aria-label={`Model ${index + 1} base URL`} value={model.config.baseUrl || ''} placeholder={meta?.defaultBaseUrl || 'http://127.0.0.1:8000/v1'} spellCheck={false} onChange={event => config({ baseUrl: event.target.value })} /></label><label>{s("API key")}<input aria-label={`Model ${index + 1} API key`} type="password" value={model.config.apiKey} autoComplete="off" spellCheck={false} onChange={event => config({ apiKey: event.target.value })} /></label><small>{s("For a local server without authentication, enter a placeholder key such as “local”.")}</small></> : <small>{s("Uses the external provider’s existing sign-in.")}</small>}
        </div>
        <div className="nawa-model-actions"><button type="button" className="set-btn" disabled={!!testing} onClick={async () => {
          const error = validateChatModels({ ...settings, chatModels: [model], defaultChatModelId: model.id })
          if (error) { setTestMessage({ id: model.id, text: error }); return }
          setTesting(model.id); setTestMessage(null)
          try {
            const result = await window.aiOffice.testAiSettings(applyChatModel(settings, model.id))
            setTestMessage({ id: model.id, text: result.ok ? 'Connection successful.' : result.error || 'Connection failed.' })
          } catch (cause) { setTestMessage({ id: model.id, text: cause instanceof Error ? cause.message : String(cause) }) }
          finally { setTesting(null) }
        }}>{s(testing === model.id ? 'Testing…' : 'Test model')}</button><button type="button" className="set-btn" onClick={() => onChange({ ...settings, chatModels: models.filter(m => m.id !== model.id), defaultChatModelId: settings.defaultChatModelId === model.id ? undefined : settings.defaultChatModelId })}>{s("Remove profile")}</button></div>
        </fieldset>
        {testMessage?.id === model.id && <p role="status">{s(testMessage.text)}</p>}
      </details>
    })}
    <p className="nawa-model-security">{s("Profiles are saved through Nawa’s existing AI-settings file. API keys are not written into chat history or browser preferences.")}</p>
  </section>
}
