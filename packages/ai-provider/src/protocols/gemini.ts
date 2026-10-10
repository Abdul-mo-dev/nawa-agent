import type { AgentMessage, AgentToolCall, AgentToolDef } from '@genoffice/agent-core'
import { aiFetch } from '../fetch'
import { httpBodyDetail } from '../http-error'
import { gensparkAttributionHeaders, opencodeSessionHeaders } from '../providers'
import type { AiChatResponse, AiProviderConfig } from '../types'
import { createStreamWatchdog, type StreamWatchdog } from '../watchdog'
import { toGeminiSchema } from './gemini-schema'
import {
  jsonBodyInsteadOfSse,
  sseErrorText,
  sseLines,
  throwIfCreditsNotice,
  type StreamCallbacks,
} from './shared'

export const GEMINI_BASE_URL = 'https://generativelanguage.googleapis.com/v1beta'

function geminiContents(
  messages: AgentMessage[],
  config: AiProviderConfig,
  baseUrl: string,
): unknown[] {
  const originalCallIds = new Set(
    messages.flatMap((message) =>
      message.role === 'assistant'
        ? (message.providerState?.parts.flatMap((part) => {
            const call = part.functionCall as { id?: string } | undefined
            return typeof call?.id === 'string' ? [call.id] : []
          }) ?? [])
        : [],
    ),
  )
  return messages.map((m) => {
    if (m.role === 'user') {
      if (!m.images?.length) return { role: 'user', parts: [{ text: m.text }] }
      return {
        role: 'user',
        parts: [
          ...(m.text ? [{ text: m.text }] : []),
          ...m.images.map((img) => ({ inline_data: { mime_type: img.mime, data: img.base64 } })),
        ],
      }
    }
    if (m.role === 'assistant') {
      if (m.providerState) {
        const state = m.providerState
        if (
          state.protocol !== 'gemini' ||
          state.model !== config.model ||
          state.endpoint !== baseUrl.replace(/\/$/, '')
        )
          throw new Error(
            'The model changed during an active tool turn. Start a new request with the selected model.',
          )
        return { role: 'model', parts: state.parts }
      }
      const parts: unknown[] = []
      if (m.text) parts.push({ text: m.text })
      for (const call of m.toolCalls ?? []) {
        parts.push({ functionCall: { name: call.name, args: call.input } })
      }
      // Gemini rejects model turns with empty parts lists.
      if (parts.length === 0) parts.push({ text: '(no content)' })
      return { role: 'model', parts }
    }
    return {
      role: 'user',
      parts: m.results.map((r) => ({
        functionResponse: {
          ...(originalCallIds.has(r.id) ? { id: r.id } : {}),
          name: r.name,
          response: r.isError ? { error: r.output } : { result: r.output },
        },
      })),
    }
  })
}

/**
 * Emits a complete (non-streamed) Gemini response delivered as a plain JSON body.
 * `streamGenerateContent` without SSE framing yields an array of chunks; a gateway
 * may also send a single `generateContent`-shaped object — handle both.
 */
function emitGeminiJsonMessage(
  bodyText: string,
  cb: StreamCallbacks,
  config: AiProviderConfig,
  baseUrl: string,
): void {
  let parsed: unknown
  try {
    parsed = JSON.parse(bodyText)
  } catch {
    throw new Error(`Gemini returned an unparseable JSON body: ${httpBodyDetail(bodyText)}`)
  }
  const events = (Array.isArray(parsed) ? parsed : [parsed]) as Array<{
    candidates?: Array<{
      content?: {
        parts?: Array<{
          text?: string
          thought?: boolean
          functionCall?: { id?: string; name?: string; args?: Record<string, unknown> }
          [key: string]: unknown
        }>
      }
      finishReason?: string
    }>
    promptFeedback?: { blockReason?: string }
    error?: { message?: string } | string
  }>
  let emitted = false
  const parts: Record<string, unknown>[] = []
  const calls: AgentToolCall[] = []
  let stopReason: string | undefined
  let abnormalFinish: string | undefined
  for (const event of events) {
    if (event.error) throw new Error(sseErrorText(event.error, 'Gemini error'))
    if (event.promptFeedback?.blockReason) {
      throw new Error(`Gemini blocked the prompt (${event.promptFeedback.blockReason})`)
    }
    const finishReason = event.candidates?.[0]?.finishReason
    if (finishReason === 'MAX_TOKENS') stopReason = 'max_tokens'
    else if (finishReason && finishReason !== 'STOP') abnormalFinish = finishReason
    for (const part of event.candidates?.[0]?.content?.parts ?? []) {
      parts.push(part)
      if (part.text) {
        emitted = true
        if (part.thought) cb.onReasoningDelta?.(part.text)
        else cb.onDelta(part.text)
      }
      if (part.functionCall?.name) {
        emitted = true
        calls.push({
          id: typeof part.functionCall.id === 'string' ? part.functionCall.id : crypto.randomUUID(),
          name: part.functionCall.name,
          input: part.functionCall.args ?? {},
        })
      }
    }
  }
  if (parts.length)
    cb.onProviderState?.({
      protocol: 'gemini',
      endpoint: baseUrl.replace(/\/$/, ''),
      model: config.model,
      parts,
    })
  if (!emitted) {
    throw new Error(
      abnormalFinish
        ? `Gemini returned no content (finishReason=${abnormalFinish})`
        : `Gemini returned no content: ${httpBodyDetail(bodyText)}`,
    )
  }
  for (const call of calls)
    cb.onToolCall({ ...call, ...(stopReason === 'max_tokens' ? { truncated: true } : {}) })
  if (stopReason) cb.onStopReason?.(stopReason)
}

/** Per-endpoint request shaping resolved from the provider registry. */
export interface GeminiRequestOptions {
  omitTemperature?: boolean | undefined
  maxTokens?: number | undefined
}

export async function streamGemini(
  config: AiProviderConfig,
  system: string,
  messages: AgentMessage[],
  tools: AgentToolDef[],
  maxTokens: number,
  cb: StreamCallbacks,
  baseUrl = GEMINI_BASE_URL,
  options: GeminiRequestOptions = {},
): Promise<void> {
  const wd = createStreamWatchdog(cb.signal)
  return wd.guard(() =>
    geminiTurn(config, system, messages, tools, maxTokens, cb, baseUrl, wd, options),
  )
}

async function geminiTurn(
  config: AiProviderConfig,
  system: string,
  messages: AgentMessage[],
  tools: AgentToolDef[],
  maxTokens: number,
  cb: StreamCallbacks,
  baseUrl: string,
  wd: StreamWatchdog,
  options: GeminiRequestOptions,
): Promise<void> {
  const onBytes = () => {
    wd.touch()
    cb.onActivity?.()
  }
  const url = `${baseUrl.replace(/\/$/, '')}/models/${config.model}:streamGenerateContent?alt=sse`
  const response = await aiFetch(url, {
    method: 'POST',
    signal: wd.signal,
    headers: {
      'Content-Type': 'application/json',
      'x-goog-api-key': config.apiKey,
      ...gensparkAttributionHeaders(baseUrl),
      ...opencodeSessionHeaders(baseUrl, cb.sessionId),
    },
    body: JSON.stringify({
      systemInstruction: { parts: [{ text: system }] },
      contents: geminiContents(messages, config, baseUrl),
      ...(tools.length > 0
        ? {
            tools: [
              {
                functionDeclarations: tools.map((t) => ({
                  name: t.name,
                  description: t.description,
                  // JSON Schema constructs the Gemini proto lacks (type unions,
                  // $ref, ...) fail the whole request with HTTP 400
                  parameters: toGeminiSchema(t.inputSchema),
                })),
              },
            ],
          }
        : {}),
      // Google recommends the default temperature (1.0) for the Gemini 3
      // family — lower values may cause looping or degraded reasoning —
      // so omit our hard-coded 0.3 for those models via omitTemperature.
      generationConfig: {
        ...(options.omitTemperature ? {} : { temperature: 0.3 }),
        maxOutputTokens: maxTokens,
      },
    }),
  })
  // headers arrived: ping the renderer watchdog too, or a slow first chunk could trip it
  onBytes()
  if (!response.ok || !response.body) {
    throw new Error(`Gemini HTTP ${response.status}: ${httpBodyDetail(await response.text())}`)
  }
  const jsonBody = await jsonBodyInsteadOfSse(response)
  if (jsonBody !== null) {
    throwIfCreditsNotice(jsonBody)
    return emitGeminiJsonMessage(jsonBody, cb, config, baseUrl)
  }
  let stopReason: string | undefined
  let abnormalFinish: string | undefined
  let sawFinish = false
  let emitted = false
  const parts: Record<string, unknown>[] = []
  const calls: AgentToolCall[] = []
  for await (const line of sseLines(response.body, onBytes)) {
    if (!line.startsWith('data:')) continue
    const payload = line.slice(5).trim()
    if (!payload) continue
    // A truncated frame or a non-JSON keep-alive from a proxy should skip
    // that event, not kill the entire AI turn with a parser error.
    let event
    try {
      event = JSON.parse(payload) as {
        candidates?: Array<{
          content?: {
            parts?: Array<{
              text?: string
              thought?: boolean
              functionCall?: { id?: string; name?: string; args?: Record<string, unknown> }
              [key: string]: unknown
            }>
          }
          finishReason?: string
        }>
        promptFeedback?: { blockReason?: string }
        error?: { message?: string } | string
      }
    } catch {
      continue
    }
    if (event.error) throw new Error(sseErrorText(event.error, 'Gemini stream error'))
    if (event.promptFeedback?.blockReason) {
      throw new Error(`Gemini blocked the prompt (${event.promptFeedback.blockReason})`)
    }
    const finishReason = event.candidates?.[0]?.finishReason
    if (finishReason) sawFinish = true
    if (finishReason === 'MAX_TOKENS') stopReason = 'max_tokens'
    else if (finishReason && finishReason !== 'STOP') abnormalFinish = finishReason
    for (const part of event.candidates?.[0]?.content?.parts ?? []) {
      parts.push(part)
      if (part.text) {
        emitted = true
        if (part.thought) cb.onReasoningDelta?.(part.text)
        else cb.onDelta(part.text)
      }
      // Gemini emits function calls whole, never as partial JSON
      if (part.functionCall?.name) {
        emitted = true
        calls.push({
          id: typeof part.functionCall.id === 'string' ? part.functionCall.id : crypto.randomUUID(),
          name: part.functionCall.name,
          input: part.functionCall.args ?? {},
        })
      }
    }
  }
  if (parts.length)
    cb.onProviderState?.({
      protocol: 'gemini',
      endpoint: baseUrl.replace(/\/$/, ''),
      model: config.model,
      parts,
    })
  // A safety/recitation stop that produced nothing, or a stream with no message
  // framing at all (gateway soft-failure), would otherwise look like an empty
  // success; a genuine empty turn still carries finishReason=STOP and passes
  if (!emitted && abnormalFinish) {
    throw new Error(`Gemini returned no content (finishReason=${abnormalFinish})`)
  }
  if (!emitted && !sawFinish) {
    throw new Error('Gemini returned no content (empty stream)')
  }
  for (const call of calls)
    cb.onToolCall({ ...call, ...(stopReason === 'max_tokens' ? { truncated: true } : {}) })
  if (stopReason) cb.onStopReason?.(stopReason)
}

export async function chatGemini(
  wd: StreamWatchdog,
  config: AiProviderConfig,
  system: string,
  user: string,
  baseUrl = GEMINI_BASE_URL,
  options: GeminiRequestOptions = {},
): Promise<AiChatResponse> {
  const url = `${baseUrl.replace(/\/$/, '')}/models/${config.model}:generateContent`
  const response = await aiFetch(url, {
    method: 'POST',
    signal: wd.signal,
    headers: {
      'Content-Type': 'application/json',
      'x-goog-api-key': config.apiKey,
      ...gensparkAttributionHeaders(baseUrl),
      ...opencodeSessionHeaders(baseUrl),
    },
    body: JSON.stringify({
      systemInstruction: { parts: [{ text: system }] },
      contents: [{ role: 'user', parts: [{ text: user }] }],
      generationConfig: {
        ...(options.omitTemperature ? {} : { temperature: 0.3 }),
        ...(options.maxTokens ? { maxOutputTokens: options.maxTokens } : {}),
      },
    }),
  })
  wd.touch()
  if (!response.ok) {
    return {
      ok: false,
      error: `Gemini HTTP ${response.status}: ${httpBodyDetail(await response.text())}`,
    }
  }
  // A 200 with an HTML shell / empty / truncated body (gateway soft-failure)
  // would make response.json() throw; return ok:false instead of leaking a
  // raw SyntaxError to the caller.
  const bodyText = await response.text()
  let json: {
    candidates?: Array<{ content?: { parts?: Array<{ text?: string }> } }>
  }
  try {
    json = JSON.parse(bodyText) as {
      candidates?: Array<{ content?: { parts?: Array<{ text?: string }> } }>
    }
  } catch {
    return {
      ok: false,
      error: `Gemini returned a non-JSON response: ${httpBodyDetail(bodyText)}`,
    }
  }
  const content = json.candidates?.[0]?.content?.parts?.map((p) => p.text ?? '').join('')
  if (!content) return { ok: false, error: 'Gemini returned an empty response' }
  return { ok: true, content }
}
