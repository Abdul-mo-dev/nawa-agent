/**
 * Per-language titles for the manual's sidebar and article headings.
 *
 * The registry holds the structure — which topics exist, their group and order
 * — and this holds the words, one entry per UI language. They are separate
 * because they change for different reasons and on different schedules: a new
 * topic lands in the registry, a new language lands here, and a language with
 * no body yet still needs a title so the sidebar never shows an empty row.
 */

import type { HelpGroupId } from './help-registry'

/** The languages the manual has titles for; `@genoffice/i18n`'s list, minus none. */
export const HELP_TITLE_LANGS = ['en', 'ja', 'ar'] as const

export type HelpTitleLang = (typeof HELP_TITLE_LANGS)[number]

/** Sidebar group headings, per language. */
const GROUP_TITLES: Record<HelpGroupId, Record<HelpTitleLang, string>> = {
  start: {
    en: 'Getting started',
    ja: 'はじめに',
    ar: 'البداية',
  },
  apps: {
    en: 'Applications',
    ja: 'アプリ',
    ar: 'التطبيقات',
  },
  ai: {
    en: 'AI features',
    ja: 'AI 機能',
    ar: 'ميزات الذكاء الاصطناعي',
  },
  manage: {
    en: 'Files & settings',
    ja: 'ファイルと設定',
    ar: 'الملفات والإعدادات',
  },
}

/** Article titles, per language, keyed by topic id. A language lands here when
 *  its bodies land in ./topics; until then the title falls back to English. */
const TOPIC_TITLES: Record<string, Record<HelpTitleLang, string>> = {
  'getting-started': {
    en: 'Quick start: the interface and the basics',
    ja: 'クイックスタート：画面と基本操作',
    ar: 'بدء سريع: الواجهة والأساسيات',
  },
  'home-screen': {
    en: 'The Home screen: where your files live',
    ja: 'ホーム画面：ファイルの置き場所',
    ar: 'الشاشة الرئيسية: مكان ملفاتك',
  },
  'tabs-and-windows': {
    en: 'Tabs and window management',
    ja: 'タブとウィンドウの管理',
    ar: 'علامات التبويب وإدارة النوافذ',
  },
  shortcuts: {
    en: 'Keyboard shortcuts',
    ja: 'キーボードショートカット',
    ar: 'اختصارات لوحة المفاتيح',
  },
  docs: {
    en: 'Docs: word processing',
    ja: 'Docs：文書処理',
    ar: 'Docs: معالجة النصوص',
  },
  sheets: {
    en: 'Sheets: spreadsheets',
    ja: 'Sheets：表計算',
    ar: 'Sheets: جداول البيانات',
  },
  slides: {
    en: 'Slides: presentations',
    ja: 'Slides：プレゼンテーション',
    ar: 'Slides: العروض التقديمية',
  },
  pdf: {
    en: 'PDF: reading, annotating and redacting',
    ja: 'PDF：読む、注釈する、塗りつぶす',
    ar: 'PDF: القراءة والتعليقات التوضيحية والإخفاء',
  },
  markdown: {
    en: 'The Markdown editor',
    ja: 'Markdown エディター',
    ar: 'محرّر Markdown',
  },
  html: {
    en: 'The HTML editor',
    ja: 'HTML エディター',
    ar: 'محرّر HTML',
  },
  'ai-panel': {
    en: 'The AI assistant panel',
    ja: 'AI アシスタントパネル',
    ar: 'لوحة مساعد الذكاء الاصطناعي',
  },
  'ai-models': {
    en: 'AI models and settings',
    ja: 'AI モデルと設定',
    ar: 'نماذج الذكاء الاصطناعي والإعدادات',
  },
  fonts: {
    en: 'Fonts: system faces and downloadable families',
    ja: 'フォント：システムフォントとダウンロードできる書体',
    ar: 'الخطوط: خطوط النظام والعائلات القابلة للتنزيل',
  },
  'file-ops': {
    en: 'File operations: rename, delete, export',
    ja: 'ファイル操作：名前の変更、削除、書き出し',
    ar: 'عمليات الملف: إعادة التسمية والحذف والتصدير',
  },
  'settings-integrations': {
    en: 'Settings, language, theme and MCP integrations',
    ja: '設定、言語、テーマと MCP 連携',
    ar: 'الإعدادات واللغة والمظهر وتكاملات MCP',
  },
  install: {
    en: 'Installing GenOffice',
    ja: 'GenOffice のインストール',
    ar: 'تثبيت GenOffice',
  },
  cli: {
    en: 'Command line and agents',
    ja: 'コマンドラインとエージェント',
    ar: 'سطر الأوامر والوكلاء',
  },
  mcp: {
    en: 'Connecting a coding agent',
    ja: 'コーディングエージェントの接続',
    ar: 'ربط وكيل برمجي',
  },
}

/** Sidebar group heading in the reader's language; English when unknown. */
export function groupTitle(id: HelpGroupId, lang: string): string {
  const row = GROUP_TITLES[id]
  return (row?.[lang as HelpTitleLang] ?? row?.en) as string
}

/** Article title in the reader's language; falls back to the topic id, which
 *  is never pretty, so a language added without its titles shows up as a gap
 *  rather than as a blank row. */
export function topicTitle(id: string, lang: string): string {
  const row = TOPIC_TITLES[id]
  return (row?.[lang as HelpTitleLang] ?? row?.en ?? id) as string
}
