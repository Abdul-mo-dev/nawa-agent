import { defineStrings } from '@genoffice/i18n'
import { en } from './ai/en'
import { ja } from './ai/ja'
import { ar } from './ai/ar'

/** User-visible copy for the ai/ panel and tool feedback (LLM prompts excluded) */
export const aiStrings = defineStrings({
  en,
  ja,
  ar,
})
