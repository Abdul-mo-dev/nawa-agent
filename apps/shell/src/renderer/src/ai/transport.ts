import { createIpcTransport, type AgentTransport } from '@genoffice/agent-core'
import type { AiSettings } from '@genoffice/ai-provider'
import type { Lang } from '@genoffice/i18n'
import { agentStatusText } from '@genoffice/ui'

export function createShellTransport(
  getSettings: () => AiSettings,
  getLanguage: () => Lang = () => 'en',
): AgentTransport {
  return createIpcTransport<AiSettings>({
    onStream: (listener) => window.aiOffice.onAiStreamChunk(listener),
    start: (request) => window.aiOffice.aiStream(request),
    cancel: (requestId) => void window.aiOffice.aiStreamCancel(requestId),
    getSettings,
    unknownErrorText: () => agentStatusText(getLanguage()).requestFailed,
    timeoutErrorText: () => agentStatusText(getLanguage()).requestTimeout,
    creditsErrorText: () => agentStatusText(getLanguage()).noCredits,
    networkErrorText: () => agentStatusText(getLanguage()).networkError,
    overloadedErrorText: () => agentStatusText(getLanguage()).overloadedError,
  })
}
