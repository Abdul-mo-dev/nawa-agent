import type { AgentMessage, AgentToolCall, AgentToolDef } from '@genoffice/agent-core'
import type { AiChatResponse, AiProviderConfig, AiProviderId } from './types'
import { streamForProvider } from './stream'
import { modelCapabilityIdentity } from './model-policy'

/** Explicit Settings test. Uses synthetic data only; never opens user files. */
export async function testModelCapabilities(
  provider: AiProviderId,
  config: AiProviderConfig,
  signal = AbortSignal.timeout(120000),
): Promise<AiChatResponse> {
  const identity = modelCapabilityIdentity(provider, config)
  const at = Date.now()
  const failed = (error: string): AiChatResponse => ({
    ok: false,
    error,
    capabilities: { identity, at, tools: false, vision: false },
  })
  if (!config || (!config.apiKey?.trim() && !['custom', 'codex'].includes(provider)))
    return failed('Configure this model connection before testing.')
  const testConfig = { ...config, policy: { ...config.policy, tested: undefined } }
  const nonce = `nawa_${crypto.randomUUID().replaceAll('-', '').slice(0, 16)}`
  const tool: AgentToolDef = {
    name: 'nawa_capability_check',
    description: 'Return a verification receipt for the supplied nonce.',
    inputSchema: {
      type: 'object',
      properties: { nonce: { type: 'string', enum: [nonce] } },
      required: ['nonce'],
      additionalProperties: false,
    },
  }
  const messages: AgentMessage[] = [
    {
      role: 'user',
      text: `Call nawa_capability_check with nonce "${nonce}". After receiving its result, reply with the verification receipt exactly.`,
    },
  ]
  try {
    const calls: AgentToolCall[] = []
    let state: Extract<AgentMessage, { role: 'assistant' }>['providerState']
    let stopped = ''
    await streamForProvider(
      provider,
      testConfig,
      'Test the advertised function. Use it before answering. The result contains the final verification receipt.',
      messages,
      [tool],
      1024,
      {
        signal,
        onDelta() {},
        onToolCall: (call) => calls.push(call),
        onProviderState: (value) => {
          state = value
        },
        onStopReason: (reason) => {
          stopped = reason
        },
      },
    )
    if (
      stopped === 'max_tokens' ||
      calls.length !== 1 ||
      calls[0]!.name !== tool.name ||
      calls[0]!.input.nonce !== nonce ||
      calls[0]!.inputError ||
      calls[0]!.truncated
    )
      return failed(
        'The model did not return a valid function call. Check the model and its tool template, then test again.',
      )
    const proof = `VERIFIED_${crypto.randomUUID().replaceAll('-', '').slice(0, 16)}`
    messages.push(
      { role: 'assistant', text: '', toolCalls: calls, ...(state ? { providerState: state } : {}) },
      {
        role: 'tool',
        results: [
          {
            id: calls[0]!.id,
            name: tool.name,
            output: JSON.stringify({ verificationReceipt: proof }),
          },
        ],
      },
    )
    let final = '',
      extraCalls = 0
    stopped = ''
    await streamForProvider(
      provider,
      testConfig,
      'Read the tool result and reply with its verification receipt exactly.',
      messages,
      [tool],
      1024,
      {
        signal,
        onDelta: (text) => {
          final += text
        },
        onToolCall: () => {
          extraCalls++
        },
        onStopReason: (reason) => {
          stopped = reason
        },
      },
    )
    if (extraCalls || stopped === 'max_tokens' || !final.includes(proof))
      return failed(
        'The function call worked, but the model did not complete the tool-result round trip.',
      )
    let vision = false
    if (config.policy?.vision === true) {
      let answer = '',
        visionCalls = 0
      // A tiny opaque red PNG: text-only endpoints must not pass this check.
      const image = {
        mime: 'image/png',
        base64:
          'iVBORw0KGgoAAAANSUhEUgAAABAAAAAQCAIAAACQkWg2AAAAF0lEQVR4nGP4z8BAEiJN9aiGUQ1DSgMAkPn/Afnh+ngAAAAASUVORK5CYII=',
      }
      await streamForProvider(
        provider,
        { ...testConfig, policy: { ...testConfig.policy, vision: true } },
        'Inspect the attached image. Reply only with its dominant color in English.',
        [{ role: 'user', text: 'What is the dominant color?', images: [image] }],
        [],
        256,
        {
          signal,
          onDelta: (text) => {
            answer += text
          },
          onToolCall: () => {
            visionCalls++
          },
        },
      )
      vision = !visionCalls && /\bred\b/i.test(answer)
      if (!vision)
        return {
          ok: false,
          error: 'Tool calling passed, but image understanding did not pass.',
          capabilities: { identity, at, tools: true, vision: false },
        }
    }
    return {
      ok: true,
      content: 'Tool calling and tool-result handling passed.',
      capabilities: {
        identity,
        at,
        tools: true,
        ...(config.policy?.vision === true ? { vision } : {}),
      },
    }
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) }
  }
}
