import { createI18n } from './core'
import type { Lang, Params } from './core'
import { en } from './legacy-office/en'
import { zh } from './legacy-office/zh'
import { zhTW } from './legacy-office/zh-TW'
import { ja } from './legacy-office/ja'
import { ko } from './legacy-office/ko'
import { fr } from './legacy-office/fr'
import { de } from './legacy-office/de'
import { es } from './legacy-office/es'
import { pt } from './legacy-office/pt'
import { it } from './legacy-office/it'
import { nl } from './legacy-office/nl'
import { pl } from './legacy-office/pl'
import { cs } from './legacy-office/cs'
import { ru } from './legacy-office/ru'
import { ar } from './legacy-office/ar'
import { he } from './legacy-office/he'
import { hi } from './legacy-office/hi'
import { th } from './legacy-office/th'
import { vi } from './legacy-office/vi'
import { id } from './legacy-office/id'
import { ms } from './legacy-office/ms'

const messages = {
  en,
  zh,
  'zh-TW': zhTW,
  ja,
  ko,
  fr,
  de,
  es,
  pt,
  it,
  nl,
  pl,
  cs,
  ru,
  ar,
  he,
  hi,
  th,
  vi,
  id,
  ms,
}
const translate = createI18n(messages)

export function legacyOfficeMessage(lang: Lang, key: keyof typeof zh, params?: Params): string {
  return translate(lang, key, params)
}
