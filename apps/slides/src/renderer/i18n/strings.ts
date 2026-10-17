import { aiStrings } from './strings-ai'
import { appStrings } from './strings-app'
import { paneStrings } from './strings-panes'
import { ribbonStrings } from './strings-ribbon'

export const strings = {
  en: { ...appStrings.en, ...ribbonStrings.en, ...paneStrings.en, ...aiStrings.en },
  ja: { ...appStrings.ja, ...ribbonStrings.ja, ...paneStrings.ja, ...aiStrings.ja },
  ar: { ...appStrings.ar, ...ribbonStrings.ar, ...paneStrings.ar, ...aiStrings.ar },
}
