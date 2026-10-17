import { describe, expect, it } from 'vitest'
import {
  createI18n,
  format,
  htmlDir,
  htmlLang,
  isLang,
  isRtlLang,
  LANGS,
  macShortcutsToWin,
  normalizeLang,
  type Params,
} from '../src/index'

describe('supported UI languages', () => {
  it('ships only English, Japanese and Arabic', () => {
    expect(LANGS).toEqual(['en', 'ja', 'ar'])
    for (const lang of LANGS) expect(isLang(lang)).toBe(true)
    for (const removed of [
      'zh',
      'zh-TW',
      'ko',
      'fr',
      'de',
      'es',
      'th',
      'id',
      'ru',
      'pt',
      'it',
      'pl',
      'cs',
      'nl',
      'ms',
      'he',
      'hi',
      'vi',
    ])
      expect(isLang(removed)).toBe(false)
    expect(isLang(42)).toBe(false)
  })
  it.each([
    ['en-US', 'en'],
    ['en_US', 'en'],
    ['ja', 'ja'],
    ['JA-JP', 'ja'],
    ['ja_JP', 'ja'],
    ['ar-SA', 'ar'],
    ['ar_EG', 'ar'],
  ])('normalizes %s to %s', (raw, lang) => {
    expect(normalizeLang(raw)).toBe(lang)
  })
  it.each([
    'zh',
    'zh-CN',
    'zh-TW',
    'zh-Hant',
    'fr-CA',
    'ko-KR',
    'de-DE',
    'he-IL',
    'iw-IL',
    'in-ID',
    'vi-VN',
    'arabic',
    'japanese',
    '',
    undefined,
    null,
  ])('falls back to English for %s', (raw) => {
    expect(normalizeLang(raw)).toBe('en')
  })
  it('sets the correct document tags', () => {
    expect(htmlLang('en')).toBe('en-US')
    expect(htmlLang('ja')).toBe('ja-JP')
    expect(htmlLang('ar')).toBe('ar-SA')
  })
})

describe('format', () => {
  it('fills placeholders and keeps unknown ones', () => {
    expect(format('已选 {n} 项', { n: 3 })).toBe('已选 3 项')
    expect(format('{a} and {b}', { a: 'x' })).toBe('x and {b}')
    expect(format('no params')).toBe('no params')
  })

  it('leaves the placeholder in place for a nullish param value', () => {
    // hasOwn is true for a key explicitly set to undefined/null, and
    // String(undefined) is the literal text "undefined"
    expect(format('Deleted {n} files', { n: undefined } as unknown as Params)).toBe(
      'Deleted {n} files',
    )
    expect(format('Deleted {n} files', { n: null } as unknown as Params)).toBe('Deleted {n} files')
  })

  it('does not leak prototype properties into placeholders', () => {
    expect(format('{toString}', {})).toBe('{toString}')
    expect(format('{constructor} and {valueOf}', {})).toBe('{constructor} and {valueOf}')
    expect(format('{n}', { n: 1 })).toBe('1')
  })
})

describe('macShortcutsToWin', () => {
  it('rewrites single-modifier chords', () => {
    expect(macShortcutsToWin('剪切 (⌘X)')).toBe('剪切 (Ctrl+X)')
    expect(macShortcutsToWin('Save (⌘S).')).toBe('Save (Ctrl+S).')
    expect(macShortcutsToWin('⌘1')).toBe('Ctrl+1')
  })

  it('rewrites multi-modifier chords in Ctrl, Alt, Shift order', () => {
    expect(macShortcutsToWin('⇧⌘G')).toBe('Ctrl+Shift+G')
    expect(macShortcutsToWin('⌘⇧V')).toBe('Ctrl+Shift+V')
    expect(macShortcutsToWin('⌥⌘I')).toBe('Ctrl+Alt+I')
    expect(macShortcutsToWin('⌥⇧⌘Z')).toBe('Ctrl+Alt+Shift+Z')
  })

  it('dedupes command and control into one Ctrl', () => {
    expect(macShortcutsToWin('⌃⌘F')).toBe('Ctrl+F')
  })

  it('handles function keys, arrows and named keys', () => {
    expect(macShortcutsToWin('⇧F5')).toBe('Shift+F5')
    expect(macShortcutsToWin('⌘⇧↑')).toBe('Ctrl+Shift+↑')
    expect(macShortcutsToWin('⌘⇧⌫')).toBe('Ctrl+Shift+Backspace')
    expect(macShortcutsToWin('⌫')).toBe('Backspace')
    expect(macShortcutsToWin('⌦')).toBe('Delete')
    expect(macShortcutsToWin('⏎')).toBe('Enter')
    expect(macShortcutsToWin('↩')).toBe('Enter')
    expect(macShortcutsToWin('␣')).toBe('Space')
  })

  it('keeps the Ctrl side of dual-platform listings', () => {
    expect(macShortcutsToWin('⌘/Ctrl+Enter 发送')).toBe('Ctrl+Enter 发送')
    expect(macShortcutsToWin('⌘/Strg+Eingabetaste')).toBe('Strg+Eingabetaste')
  })

  it('rewrites modifier+word combos and bare modifiers', () => {
    expect(macShortcutsToWin('⌘+Click to follow')).toBe('Ctrl+Click to follow')
    expect(macShortcutsToWin('按住 ⌘ 并单击')).toBe('按住 Ctrl 并单击')
  })

  it('keeps a chord embedded before non-Latin text intact', () => {
    expect(macShortcutsToWin('⌘S로 저장')).toBe('Ctrl+S로 저장')
  })

  it('leaves strings without Mac symbols untouched', () => {
    const plain = 'Ctrl+S saves the file'
    expect(macShortcutsToWin(plain)).toBe(plain)
    expect(macShortcutsToWin('文件')).toBe('文件')
  })
})

describe('shortcut rewrite order', () => {
  it('rewrites the template before interpolation so values keep their glyphs', () => {
    const template = 'Saved {name} (⌘S)'
    const params = { name: 'Plan ⇧Final.xlsx' }
    expect(format(macShortcutsToWin(template), params)).toBe('Saved Plan ⇧Final.xlsx (Ctrl+S)')
    expect(macShortcutsToWin(format(template, params))).toBe('Saved Plan Shift+Final.xlsx (Ctrl+S)')
  })
})

describe('createI18n', () => {
  const t = createI18n({
    en: { hello: 'Hello {name}', plain: 'Files' },
    ja: { hello: 'こんにちは {name}', plain: 'ファイル' },
    ar: { hello: 'مرحباً {name}', plain: 'الملفات' },
  })
  it('translates each supported language with interpolation', () => {
    expect(t('en', 'hello', { name: 'world' })).toBe('Hello world')
    expect(t('ja', 'hello', { name: '世界' })).toBe('こんにちは 世界')
    expect(t('ar', 'hello', { name: 'عالم' })).toBe('مرحباً عالم')
    expect(t('ar', 'plain')).toBe('الملفات')
  })
  it('falls back to English and then the key for a missing translation', () => {
    const partial = createI18n({
      en: { a: 'en-a', b: 'en-b' },
      ja: { a: 'ja-a' },
      ar: {},
    } as unknown as Parameters<typeof createI18n>[0])
    expect(partial('ja', 'a')).toBe('ja-a')
    expect(partial('ja', 'b')).toBe('en-b')
    expect(partial('ar', 'a')).toBe('en-a')
    expect(partial('ar', 'missing' as 'a')).toBe('missing')
  })
})

describe('UI direction', () => {
  it('uses right-to-left layout for Arabic', () => {
    expect(isRtlLang('ar')).toBe(true)
    expect(htmlDir('ar')).toBe('rtl')
  })
  it.each(['en', 'ja', 'zh', 'he', 'fa', '', undefined, null])(
    'uses left-to-right layout for %s',
    (lang) => {
      expect(isRtlLang(lang)).toBe(false)
      expect(htmlDir(lang)).toBe('ltr')
    },
  )
  it('agrees for every shipped language', () => {
    for (const lang of LANGS) expect(htmlDir(lang)).toBe(isRtlLang(lang) ? 'rtl' : 'ltr')
  })
})
