import { aiStrings } from './strings-ai'
import { appStrings } from './strings-app'
import { dialogStrings } from './strings-dialogs'

export const strings = {
  en: { ...appStrings.en, ...dialogStrings.en, ...aiStrings.en },
  ja: { ...appStrings.ja, ...dialogStrings.ja, ...aiStrings.ja },
  ar: { ...appStrings.ar, ...dialogStrings.ar, ...aiStrings.ar },
}
