/**
 * Univer starts with the synchronous English packs. Arabic and Japanese packs
 * load on demand when the app selects either language, then LocaleService
 * re-renders the spreadsheet menus, panels and dialogs.
 */
import { LocaleService, LocaleType, mergeLocales, type ILocales } from '@univerjs/core'

import type { UniverRuntime } from './univer-state'

type LocalePack = Record<string, unknown>

const UNIVER_LOCALES: Record<
  string,
  { type: LocaleType; load(): Promise<{ default: LocalePack }[]> }
> = {
  ja: {
    type: LocaleType.JA_JP,
    load: () =>
      Promise.all([
        import('@univerjs/preset-sheets-core/locales/ja-JP'),
        import('@univerjs/preset-sheets-conditional-formatting/locales/ja-JP'),
        import('@univerjs/preset-sheets-data-validation/locales/ja-JP'),
        import('@univerjs/preset-sheets-drawing/locales/ja-JP'),
        import('@univerjs/preset-sheets-filter/locales/ja-JP'),
        import('@univerjs/preset-sheets-find-replace/locales/ja-JP'),
        import('@univerjs/preset-sheets-note/locales/ja-JP'),
        import('@univerjs/preset-sheets-sort/locales/ja-JP'),
        import('@univerjs/preset-sheets-table/locales/ja-JP'),
      ]),
  },
  ar: {
    type: LocaleType.AR_SA,
    load: () =>
      Promise.all([
        import('@univerjs/preset-sheets-core/locales/ar-SA'),
        import('@univerjs/preset-sheets-conditional-formatting/locales/ar-SA'),
        import('@univerjs/preset-sheets-data-validation/locales/ar-SA'),
        import('@univerjs/preset-sheets-drawing/locales/ar-SA'),
        import('@univerjs/preset-sheets-filter/locales/ar-SA'),
        import('@univerjs/preset-sheets-find-replace/locales/ar-SA'),
        import('@univerjs/preset-sheets-note/locales/ar-SA'),
        import('@univerjs/preset-sheets-sort/locales/ar-SA'),
        import('@univerjs/preset-sheets-table/locales/ar-SA'),
      ]),
  },
}

const NUMBER_AS_TEXT_MESSAGE =
  'The value in this cell is stored as text — it will not be treated as a number in formulas.'

/**
 * Both "number stored as text" alerts title themselves "Error" (and sheets-ui
 * 0.25.1 references info keys no pack ships). Title with the numfmt pack's
 * localized "Number stored as text"; spread the namespaces because mergeLocales
 * merges shallowly.
 */
export function numberAsTextAlertLocale(pack: LocalePack): LocalePack {
  const ns = (name: string) => (pack[name] ?? {}) as Record<string, unknown>
  const info = (name: string) => (ns(name).info ?? {}) as Record<string, string>
  const title = info('sheets-numfmt-ui').forceStringInfo ?? 'Number stored as text'
  const patched = (name: string) => ({
    ...ns(name),
    info: { ...info(name), error: title, forceStringInfo: NUMBER_AS_TEXT_MESSAGE },
  })
  return { 'sheets-ui': patched('sheets-ui'), 'sheets-numfmt-ui': patched('sheets-numfmt-ui') }
}

/**
 * Excel wording for the insert-rows context entries: the upstream en pack
 * pairs "Insert N rows above" with "Insert N rows AFTER" (feedback #302 —
 * "it should be below, not after"; the insert itself lands directly under
 * the selection, only the label misleads). Non-English packs already say
 * below (the zh pack reads "insert below"), so the guard keys the patch to
 * the English text.
 */
export function insertRowsBelowLocale(pack: LocalePack): LocalePack {
  const sheetsUi = (pack['sheets-ui'] ?? {}) as Record<string, unknown>
  const rightClick = (sheetsUi.rightClick ?? {}) as Record<string, string>
  if (rightClick.insertRowsAfterSuffix !== 'rows after') return { 'sheets-ui': sheetsUi }
  return {
    'sheets-ui': {
      ...sheetsUi,
      rightClick: { ...rightClick, insertRowsAfterSuffix: 'rows below' },
    },
  }
}

export function univerLocaleFor(lang: string): LocaleType | null {
  return UNIVER_LOCALES[lang]?.type ?? null
}

export async function applyUniverLocale(runtime: UniverRuntime, lang: string): Promise<void> {
  const entry = UNIVER_LOCALES[lang]
  if (!entry) return
  const packs = (await entry.load()).map((mod) => mod.default)
  const merged = mergeLocales(...packs) as LocalePack
  Object.assign(merged, numberAsTextAlertLocale(merged))
  Object.assign(merged, insertRowsBelowLocale(merged))
  const localeService = runtime.univer.__getInjector().get(LocaleService)
  localeService.load({ [entry.type]: merged } as unknown as ILocales)
  localeService.setLocale(entry.type)
}
