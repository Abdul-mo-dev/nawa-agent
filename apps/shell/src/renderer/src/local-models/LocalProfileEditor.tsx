import { useId } from 'react'
import type { LocalModelProfile } from '../../../shared/local-models-api'
import { localModelCommand } from '../../../shared/local-model-command'
import type { en } from '../i18n/local-models/en'

export type ModelCopy = { [K in keyof typeof en]: string }
export function LocalProfileEditor({
  profile,
  executable,
  modelPaths,
  isNew,
  disabled,
  busy,
  dirty,
  logs,
  copy,
  update,
  changeKind,
  chooseModel,
  save,
  close,
  remove,
}: {
  profile: LocalModelProfile
  executable: string
  modelPaths: { path: string; name: string }[]
  isNew: boolean
  disabled: boolean
  busy: boolean
  dirty: boolean
  logs: string
  copy: ModelCopy
  update(patch: Partial<LocalModelProfile>): void
  changeKind(kind: LocalModelProfile['kind']): void
  chooseModel(): void
  save(): void
  close(): void
  remove(): void
}) {
  const id = useId()
  const number = (
    key: 'port' | 'contextSize' | 'threads',
    label: string,
    min: number,
    max: number,
  ) => (
    <label className="lm-field">
      <span>{label}</span>
      <input
        className="set-input"
        type="number"
        dir="ltr"
        value={profile[key]}
        min={min}
        max={max}
        step={1}
        onChange={(e) => update({ [key]: Number(e.target.value) })}
      />
    </label>
  )
  return (
    <section className="lm-editor" aria-label={copy.editModel}>
      <div className="lm-section-heading">
        <h4>{isNew ? copy.addModel : profile.name}</h4>
        <button type="button" className="set-btn" onClick={close}>
          {copy.closeEditor}
        </button>
      </div>
      <fieldset className="lm-fields" disabled={disabled || busy}>
        <div className="lm-grid">
          <label className="lm-field">
            <span>{copy.name}</span>
            <input
              className="set-input"
              value={profile.name}
              onChange={(e) => update({ name: e.target.value })}
            />
          </label>
          {isNew ? (
            <label className="lm-field">
              <span>{copy.modelRole}</span>
              <select
                className="set-input"
                aria-label={copy.modelRole}
                value={profile.kind}
                onChange={(e) => changeKind(e.target.value as LocalModelProfile['kind'])}
              >
                <option value="chat">{copy.chatModel}</option>
                <option value="embedding">{copy.embeddingModel}</option>
              </select>
            </label>
          ) : (
            number('port', copy.port, 1024, 65535)
          )}
        </div>
        <label className="lm-field">
          <span>{copy.model}</span>
          <div className="lm-input-action">
            <input
              className="set-input"
              aria-label={copy.model}
              dir="ltr"
              list={`${id}-models`}
              value={profile.modelPath}
              onChange={(e) => update({ modelPath: e.target.value })}
            />
            <button type="button" className="set-btn" onClick={chooseModel}>
              {copy.browse}
            </button>
          </div>
          <datalist id={`${id}-models`}>
            {modelPaths.map((m) => (
              <option key={m.path} value={m.path}>
                {m.name}
              </option>
            ))}
          </datalist>
        </label>
        <details className="lm-advanced">
          <summary>{copy.advancedOptions}</summary>
          <div className="lm-grid">
            {isNew && number('port', copy.port, 1024, 65535)}
            <label className="lm-field">
              <span>{copy.alias}</span>
              <input
                className="set-input"
                dir="ltr"
                value={profile.alias ?? ''}
                placeholder={profile.id}
                onChange={(e) => update({ alias: e.target.value })}
              />
            </label>
            {number('contextSize', copy.context, 128, 1048576)}
            <div className="lm-field">
              <label htmlFor={`${id}-gpu`}>{copy.gpu}</label>
              <div className="lm-input-action">
                <select
                  id={`${id}-gpu`}
                  className="set-input"
                  value={profile.gpuLayers === 'auto' ? 'auto' : 'manual'}
                  onChange={(e) => update({ gpuLayers: e.target.value === 'auto' ? 'auto' : -1 })}
                >
                  <option value="auto">{copy.automatic}</option>
                  <option value="manual">{copy.manual}</option>
                </select>
                {profile.gpuLayers !== 'auto' && (
                  <input
                    className="set-input"
                    aria-label={copy.gpuCount}
                    type="number"
                    dir="ltr"
                    value={profile.gpuLayers}
                    min={-1}
                    max={999}
                    step={1}
                    onChange={(e) => update({ gpuLayers: Number(e.target.value) })}
                  />
                )}
              </div>
            </div>
            {number('threads', copy.threads, 0, 1024)}
            {profile.kind === 'embedding' && (
              <label className="lm-field">
                <span>{copy.pooling}</span>
                <select
                  className="set-input"
                  value={profile.pooling}
                  aria-label={copy.pooling}
                  onChange={(e) =>
                    update({ pooling: e.target.value as LocalModelProfile['pooling'] })
                  }
                >
                  {['model', 'mean', 'cls', 'last'].map((p) => (
                    <option key={p} value={p}>
                      {p === 'model' ? copy.modelDefault : p}
                    </option>
                  ))}
                </select>
              </label>
            )}
          </div>
          <label className="lm-check">
            <input
              type="checkbox"
              checked={profile.autoStart}
              onChange={(e) => update({ autoStart: e.target.checked })}
            />
            {copy.autoStart}
          </label>
          <h5>{copy.arguments}</h5>
          {profile.arguments.map((arg, index) => (
            <div className="lm-argument" key={index}>
              <input
                type="checkbox"
                aria-label={`${copy.enabled} ${index + 1}`}
                checked={arg.enabled}
                onChange={(e) =>
                  update({
                    arguments: profile.arguments.map((v, i) =>
                      i === index ? { ...v, enabled: e.target.checked } : v,
                    ),
                  })
                }
              />
              <input
                className="set-input"
                dir="ltr"
                aria-label={`${copy.argumentName} ${index + 1}`}
                value={arg.name}
                onChange={(e) =>
                  update({
                    arguments: profile.arguments.map((v, i) =>
                      i === index ? { ...v, name: e.target.value } : v,
                    ),
                  })
                }
              />
              <input
                className="set-input"
                dir="ltr"
                aria-label={`${copy.argumentValue} ${index + 1}`}
                value={arg.value}
                onChange={(e) =>
                  update({
                    arguments: profile.arguments.map((v, i) =>
                      i === index ? { ...v, value: e.target.value } : v,
                    ),
                  })
                }
              />
              <button
                type="button"
                className="set-btn"
                aria-label={`${copy.removeArgument} ${index + 1}`}
                onClick={() =>
                  update({ arguments: profile.arguments.filter((_, i) => i !== index) })
                }
              >
                ×
              </button>
            </div>
          ))}
          <button
            type="button"
            className="set-btn"
            onClick={() =>
              update({
                arguments: [
                  ...profile.arguments,
                  { enabled: true, name: '--batch-size', value: '512' },
                ],
              })
            }
          >
            {copy.addArgument}
          </button>
          <details>
            <summary>{copy.command}</summary>
            <pre className="lm-code" dir="ltr">
              {localModelCommand(executable, profile)}
            </pre>
          </details>
        </details>
      </fieldset>
      {disabled && <p className="lm-hint">{copy.stopToEdit}</p>}
      <div className="lm-editor-footer">
        <button
          type="button"
          className="set-btn primary"
          disabled={busy || disabled || !dirty}
          onClick={save}
        >
          {copy.save}
        </button>
        <button
          type="button"
          className="set-btn danger"
          disabled={busy || disabled}
          onClick={remove}
        >
          {copy.remove}
        </button>
      </div>
      <details className="lm-runtime-logs">
        <summary>{copy.logs}</summary>
        <pre className="lm-code lm-logs" dir="ltr">
          {logs || copy.noLogs}
        </pre>
      </details>
    </section>
  )
}
