import { aiStrings } from './strings-ai'
import { appStrings } from './strings-app'
import { editorStrings } from './strings-editor'
import { ribbonStrings } from './strings-ribbon'
import { tableStrings } from './strings-table'
import { zoteroStrings } from './strings-zotero'

export const strings = {
  en: {
    ...appStrings.en,
    ...ribbonStrings.en,
    ...tableStrings.en,
    ...editorStrings.en,
    ...aiStrings.en,
    ...zoteroStrings.en,
  },
  ja: {
    ...appStrings.ja,
    ...ribbonStrings.ja,
    ...tableStrings.ja,
    ...editorStrings.ja,
    ...aiStrings.ja,
    ...zoteroStrings.ja,
  },
  ar: {
    ...appStrings.ar,
    ...ribbonStrings.ar,
    ...tableStrings.ar,
    ...editorStrings.ar,
    ...aiStrings.ar,
    ...zoteroStrings.ar,
  },
}
