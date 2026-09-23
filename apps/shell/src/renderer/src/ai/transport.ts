import { createIpcTransport, type AgentTransport } from '@genoffice/agent-core'
import type { AiSettings } from '@genoffice/ai-provider'

export function createShellTransport(getSettings: () => AiSettings): AgentTransport {
  return createIpcTransport<AiSettings>({
    onStream: (listener) => window.aiOffice.onAiStreamChunk(listener),
    start: (request) => window.aiOffice.aiStream(request),
    cancel: (requestId) => void window.aiOffice.aiStreamCancel(requestId),
    getSettings,
    unknownErrorText: () => 'The AI request failed.',
    timeoutErrorText: () => 'The AI request timed out.',
    creditsErrorText: () => 'The AI provider has no credits available.',
    networkErrorText: () => 'The AI provider could not be reached.',
    overloadedErrorText: () => 'The AI provider is temporarily overloaded.',
  })
}
