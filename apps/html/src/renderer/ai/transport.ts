import { resolveRendererChatSettings, rememberChatModels, chatModelSessionKey } from '@genoffice/ai-provider/browser'
import { createIpcTransport, type AgentTransport } from '@genoffice/agent-core'
import type { AiSettings } from '@genoffice/ai-provider'
import { t } from '../i18n/locale'

/** The shared IPC transport wired to the html preload bridge (window.htmlApi). */
export async function loadChatModelSettings(): Promise<AiSettings> {
  return rememberChatModels(await window.htmlApi.getAiSettings())
}

export function createElectronTransport(getSettings: () => AiSettings): AgentTransport {
  return createIpcTransport<AiSettings>({
    onStream: (listener) => window.htmlApi.onAiStream(listener),
    start: (request) => window.htmlApi.aiStream(request),
    cancel: (requestId) => void window.htmlApi.aiStreamCancel(requestId),
    getSettings: () => resolveRendererChatSettings(getSettings()),
    sessionKey: chatModelSessionKey,
    unknownErrorText: () => t('aiUnknownError'),
    timeoutErrorText: () => t('aiTimeoutError'),
    creditsErrorText: () => t('aiCreditsExhausted'),
    networkErrorText: () => t('aiNetworkError'),
    overloadedErrorText: () => t('aiOverloadedError'),
  })
}
