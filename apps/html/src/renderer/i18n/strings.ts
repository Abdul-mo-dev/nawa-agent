import { aiStrings } from './strings-ai'
import { appStrings } from './strings-app'

export const strings = {
  en: { ...appStrings.en, ...aiStrings.en },
  ja: { ...appStrings.ja, ...aiStrings.ja },
  ar: { ...appStrings.ar, ...aiStrings.ar },
}
