import { defineStrings } from '@genoffice/i18n'
import { en } from './app/en'
import { ja } from './app/ja'
import { ar } from './app/ar'

/** Strings for App.tsx / SettingsModal / non-Ribbon components (keys use the app prefix to mark the area) */
export const appStrings = defineStrings({
  en,
  ja,
  ar,
})
