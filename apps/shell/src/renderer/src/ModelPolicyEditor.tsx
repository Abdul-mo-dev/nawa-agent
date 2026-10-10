import {
  modelPolicyOf,
  type AiModelPolicy,
  type AiProviderConfig,
  type AiProviderId,
} from '@genoffice/ai-provider/browser'
import { useSidebarText } from './explorer/sidebar-i18n'

/** Advanced connection controls stay in main settings, never in directory chat. */
export function ModelPolicyEditor({
  provider,
  config,
  onChange,
  embedded = false,
  hideOutput = false,
}: {
  provider: AiProviderId
  config: AiProviderConfig
  onChange: (config: AiProviderConfig) => void
  embedded?: boolean
  hideOutput?: boolean
}) {
  const { s } = useSidebarText()
  const effective = modelPolicyOf(provider, config)
  const update = (patch: Partial<AiModelPolicy>) =>
    onChange({ ...config, policy: { ...config.policy, ...patch } })
  const fields = (
    <div className="nawa-model-fields">
      <label>
        {s('Run location')}
        <select
          aria-label={s('Run location')}
          value={effective.local ? 'local' : 'cloud'}
          onChange={(event) => update({ mode: event.target.value as 'local' | 'cloud' })}
        >
          <option value="local">{s('Local server')}</option>
          <option value="cloud">{s('Cloud API')}</option>
        </select>
      </label>
      <label>
        {s('Context limit (tokens)')}
        <input
          aria-label={s('Context limit (tokens)')}
          type="number"
          min={4096}
          max={2_000_000}
          step={1024}
          value={config.policy?.contextTokens ?? effective.contextTokens}
          onChange={(event) =>
            update({ contextTokens: event.target.value ? Number(event.target.value) : undefined })
          }
        />
      </label>
      {!hideOutput && (
        <label>
          {s('Output limit (tokens)')}
          <input
            aria-label={s('Output limit (tokens)')}
            type="number"
            min={1024}
            max={131072}
            step={1024}
            value={config.policy?.outputTokens ?? effective.outputTokens}
            onChange={(event) =>
              update({ outputTokens: event.target.value ? Number(event.target.value) : undefined })
            }
          />
        </label>
      )}
      {provider === 'custom' && (
        <label>
          {s('API output parameter')}
          <select
            aria-label={s('API output parameter')}
            value={config.policy?.outputField ?? ''}
            onChange={(event) =>
              update({
                outputField: event.target.value
                  ? (event.target.value as 'max_tokens' | 'max_completion_tokens')
                  : undefined,
              })
            }
          >
            <option value="">{s('Automatic')}</option>
            <option value="max_tokens">max_tokens</option>
            <option value="max_completion_tokens">max_completion_tokens</option>
          </select>
        </label>
      )}
      <label>
        {s('Test image understanding')}
        <select
          aria-label={s('Test image understanding')}
          value={config.policy?.vision === true ? 'yes' : 'no'}
          onChange={(event) => update({ vision: event.target.value === 'yes', tested: undefined })}
        >
          <option value="no">{s('No')}</option>
          <option value="yes">{s('Yes')}</option>
        </select>
      </label>
      {provider === 'codex' && (
        <small>
          {s(
            'Codex output limits are advisory; large tool responses are rejected before execution.',
          )}
        </small>
      )}
    </div>
  )
  return embedded ? (
    fields
  ) : (
    <details className="nawa-model-policy">
      <summary>{s('Advanced model settings')}</summary>
      {fields}
    </details>
  )
}
