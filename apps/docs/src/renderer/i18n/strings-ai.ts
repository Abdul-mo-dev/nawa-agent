import { defineStrings } from '@genoffice/i18n'
import { en } from './ai/en'
import { ja } from './ai/ja'
import { ar } from './ai/ar'

/** User-visible strings for the ai/ panel and tool feedback (LLM prompts are not here) */
export const aiStrings = defineStrings({
  en,
  ja,
  ar,
})
