import { boundedToolEvidence } from '@genoffice/agent-core'
export { boundedToolEvidence } from '@genoffice/agent-core'
import type { AgentMessage, AgentToolDef } from '@genoffice/agent-core'
import type { AiProviderConfig, AiProviderId } from './types'
import { modelPolicyOf } from './model-policy'
import { openAiMessages } from './protocols/openai-compatible'
import { aiFetch } from './fetch'
import { getProviderAdapter } from './registry'
import { toGeminiSchema } from './protocols/gemini-schema'
import { isOpenAiCloudModel } from './local-endpoint'
import type { Tiktoken } from 'js-tiktoken/lite'

const encoders = new Map<string, Promise<Tiktoken>>()
async function openAiEncoder(model: string): Promise<Tiktoken> {
  const encoding = /^(?:ft:)?gpt-(?:3|35|4(?:-|$))/i.test(model.split('/').pop() ?? '')
    ? 'cl100k_base'
    : 'o200k_base'
  if (!encoders.has(encoding))
    encoders.set(
      encoding,
      (async () => {
        const [{ Tiktoken }, ranks] = await Promise.all([
          import('js-tiktoken/lite'),
          encoding === 'cl100k_base'
            ? import('js-tiktoken/ranks/cl100k_base')
            : import('js-tiktoken/ranks/o200k_base'),
        ])
        return new Tiktoken(ranks.default)
      })(),
    )
  return encoders.get(encoding)!
}

function promptBudgetContent(system: string, messages: AgentMessage[], tools: AgentToolDef[]) {
  const textMessages = messages.map((message) =>
    message.role === 'user' && message.images?.length
      ? {
          ...message,
          images: message.images.map((image) => ({ mime: image.mime, imageTokenReserve: 8192 })),
        }
      : message,
  )
  const imageReserve = messages.reduce(
    (n, m) => n + (m.role === 'user' ? (m.images?.length ?? 0) * 8192 : 0),
    0,
  )
  return {
    text: JSON.stringify({ system, messages: textMessages, tools }),
    reserve: 512 + messages.length * 32 + tools.length * 32 + imageReserve,
  }
}

/** Unknown/local tokenizers retain a conservative estimate or use server token counts. */
export function estimatedPromptTokens(
  system: string,
  messages: AgentMessage[],
  tools: AgentToolDef[],
): number {
  const content = promptBudgetContent(system, messages, tools)
  return new TextEncoder().encode(content.text).length + content.reserve
}

/** Tokenize the complete cloud request locally; framing and future aliases remain estimates. */
export async function estimatedOpenAiPromptTokens(
  model: string,
  system: string,
  messages: AgentMessage[],
  tools: AgentToolDef[],
): Promise<number> {
  const content = promptBudgetContent(system, messages, tools)
  const encoder = await openAiEncoder(model)
  return Math.ceil(encoder.encode(content.text, [], []).length * 1.15) + content.reserve
}

async function llamaPromptTokens(
  config: AiProviderConfig,
  baseUrl: string,
  system: string,
  messages: AgentMessage[],
  tools: AgentToolDef[],
  signal: AbortSignal,
): Promise<number | undefined> {
  const root = baseUrl.replace(/\/$/, '').replace(/\/v1$/, '')
  const timeout = AbortSignal.any([signal, AbortSignal.timeout(4000)])
  const headers = {
    'Content-Type': 'application/json',
    ...(config.apiKey ? { Authorization: `Bearer ${config.apiKey}` } : {}),
  }
  try {
    const request = {
      model: config.model,
      messages: openAiMessages(system, messages, true),
      tools: tools.map((t) => ({
        type: 'function',
        function: { name: t.name, description: t.description, parameters: t.inputSchema },
      })),
      add_generation_prompt: true,
    }
    const counted = await aiFetch(`${root}/v1/chat/completions/input_tokens`, {
      method: 'POST',
      signal: timeout,
      headers,
      body: JSON.stringify(request),
    })
    if (counted.ok) {
      const body = (await counted.json()) as { input_tokens?: number }
      if (Number.isSafeInteger(body.input_tokens) && body.input_tokens! > 0)
        return body.input_tokens
    }
    if (messages.some((m) => m.role === 'user' && m.images?.length)) return undefined
    const template = await aiFetch(`${root}/apply-template`, {
      method: 'POST',
      signal: timeout,
      headers,
      body: JSON.stringify(request),
    })
    if (!template.ok) return undefined
    const result = (await template.json()) as { prompt?: string }
    if (typeof result.prompt !== 'string') return undefined
    if (tools.some((tool) => !result.prompt!.includes(tool.name))) return undefined
    const tokenized = await aiFetch(`${root}/tokenize`, {
      method: 'POST',
      signal: timeout,
      headers,
      body: JSON.stringify({ model: config.model, content: result.prompt, add_special: true }),
    })
    if (!tokenized.ok) return undefined
    const body = (await tokenized.json()) as { tokens?: unknown[] }
    return Array.isArray(body.tokens) ? body.tokens.length : undefined
  } catch {
    if (signal.aborted) throw signal.reason
    return undefined
  }
}

export async function prepareModelRequest(
  provider: AiProviderId,
  config: AiProviderConfig,
  baseUrl: string,
  system: string,
  messages: AgentMessage[],
  tools: AgentToolDef[],
  requestedOutput: number,
  signal: AbortSignal,
) {
  const policy = modelPolicyOf(provider, config, requestedOutput)
  const budgetTools =
    getProviderAdapter(provider).resolveEndpoint(config).protocol === 'gemini'
      ? tools.map((tool) => ({ ...tool, inputSchema: toGeminiSchema(tool.inputSchema) }))
      : tools
  if (!config.model?.trim() && provider !== 'codex')
    throw new Error('Choose a model ID in Settings before sending.')
  if (tools.length && policy.tools === false)
    throw new Error(
      'This model failed the tool-calling test. Test another model in Settings before asking it to handle files.',
    )
  const maxTokens = Math.min(
    policy.outputTokens,
    Number.isFinite(requestedOutput)
      ? Math.max(1, Math.floor(requestedOutput))
      : policy.outputTokens,
  )
  const inputLimit =
    policy.contextTokens - maxTokens - Math.max(512, Math.ceil(policy.contextTokens * 0.05))
  let bounded = structuredClone(messages)
  const count = async () => {
    const tokenizeCloud =
      !policy.local && (provider === 'openai' || isOpenAiCloudModel(config.model))
    const estimate = tokenizeCloud
      ? await estimatedOpenAiPromptTokens(config.model, system, bounded, budgetTools)
      : Math.max(
          estimatedPromptTokens(system, bounded, tools),
          estimatedPromptTokens(system, bounded, budgetTools),
        )
    if (estimate <= inputLimit) return estimate
    if (provider === 'custom' && policy.local)
      return (await llamaPromptTokens(config, baseUrl, system, bounded, tools, signal)) ?? estimate
    return estimate
  }
  let promptTokens = await count()
  while (promptTokens > inputLimit) {
    const nextUser = bounded.findIndex((m, index) => index > 0 && m.role === 'user')
    if (nextUser < 0) break
    // Drop whole completed exchanges; never separate an active signed tool chain.
    bounded = bounded.slice(nextUser)
    promptTokens = await count()
  }
  if (promptTokens > inputLimit) {
    const target = policy.local ? 2500 : 8000
    bounded = bounded.map((message) =>
      message.role === 'tool'
        ? {
            ...message,
            results: message.results.map((result) => ({
              ...result,
              output: boundedToolEvidence(result.output, target),
            })),
          }
        : message,
    )
    promptTokens = await count()
  }
  if (promptTokens > inputLimit)
    throw new Error(
      `The request exceeds this model's context budget: estimated input ${promptTokens}, available input ${inputLimit}, configured context ${policy.contextTokens}, output allowance ${maxTokens}. Check this profile's context limit in Settings → AI Model, or narrow the request. No model call was sent for this step.`,
    )
  return { messages: bounded, maxTokens, promptTokens }
}
