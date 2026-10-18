import type { Lang } from '@genoffice/i18n'
import { en } from './i18n/agent-status/en'
import { ja } from './i18n/agent-status/ja'
import { ar } from './i18n/agent-status/ar'

export const agentStatusText = (lang: Lang) => ({ en, ja, ar })[lang]
