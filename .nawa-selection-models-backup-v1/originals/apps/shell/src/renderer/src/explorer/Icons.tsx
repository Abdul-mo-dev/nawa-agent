import type { CSSProperties } from 'react'

const paths = {
  home: 'M3 10 12 3l9 7M5 9v11h5v-6h4v6h5V9',
  recent: 'M3 11a9 9 0 1 1 2.4 7M3 4v7h7M12 7v5l3 2',
  star: 'm12 3 2.8 5.7 6.2.9-4.5 4.4 1.1 6.2L12 17.3l-5.6 2.9 1.1-6.2L3 9.6l6.2-.9Z',
  plus: 'M12 5v14M5 12h14', minus: 'M5 12h14',
  left: 'm13 5-7 7 7 7M6 12h14', right: 'm11 5 7 7-7 7M4 12h14',
  up: 'm5 11 7-7 7 7M12 4v16', refresh: 'M20 10a8 8 0 0 0-14-5L3 8M3 3v5h5M4 14a8 8 0 0 0 14 5l3-3M21 21v-5h-5',
  search: 'M16 16l5 5M18 10a8 8 0 1 1-16 0 8 8 0 0 1 16 0',
  chevron: 'm9 5 7 7-7 7', down: 'm5 9 7 7 7-7', close: 'm6 6 12 12M6 18 18 6',
  list: 'M8 5h13M8 12h13M8 19h13M3 5h.01M3 12h.01M3 19h.01',
  grid: 'M3 3h7v7H3zM14 3h7v7h-7zM3 14h7v7H3zM14 14h7v7h-7z',
  sort: 'M7 4v16m-4-4 4 4 4-4M14 5h7M14 10h5M14 15h3',
  info: 'M12 11v6M12 7h.01M22 12a10 10 0 1 1-20 0 10 10 0 0 1 20 0',
  sparkles: 'm12 3 2.2 6.8L21 12l-6.8 2.2L12 21l-2.2-6.8L3 12l6.8-2.2ZM20 2v4M18 4h4',
  settings: 'M9 3h6l1 3 3 1 2 5-2 5-3 1-1 3H9l-1-3-3-1-2-5 2-5 3-1ZM15 12a3 3 0 1 1-6 0 3 3 0 0 1 6 0',
  trash: 'M3 6h18M9 6V3h6v3M6 6l1 15h10l1-15M10 10v7M14 10v7',
  rename: 'm14 4 6 6M3 21l5-1L21 7l-4-4L4 16ZM12 21h9',
  copy: 'M8 8h12v13H8zM16 8V3H3v13h5',
  cut: 'M6 3a3 3 0 1 0 0 6 3 3 0 0 0 0-6ZM6 15a3 3 0 1 0 0 6 3 3 0 0 0 0-6ZM9 7l12 14M9 17l12-14',
  paste: 'M9 5H5v16h14V5h-4M9 3h6v4H9z',
  open: 'M14 3h7v7M10 14 21 3M21 14v7H3V3h7',
  menu: 'M4 6h16M4 12h16M4 18h16',
  pane: 'M3 4h18v16H3zM9 4v16', check: 'm4 12 5 5L20 6',
  more: 'M5 12h.01M12 12h.01M19 12h.01',
  folder: 'M3 6V4h6l3 3h9v13H3Z',
} as const
export type IconName = keyof typeof paths
export function Icon({ name, size = 18, className = '' }: { name: IconName; size?: number; className?: string }) {
  return <svg className={`ex-icon ${className}`} width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.55" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d={paths[name]} /></svg>
}
export function FolderGlyph({ size = 22, open = false }: { size?: number; open?: boolean }) {
  return <svg className="ex-folder-glyph" width={size} height={size} viewBox="0 0 32 28" fill="none" aria-hidden="true">
    <path d="M2 5a3 3 0 0 1 3-3h7l3 3h12a3 3 0 0 1 3 3v14a3 3 0 0 1-3 3H5a3 3 0 0 1-3-3Z" fill="var(--ex-folder-back)" />
    <path d="M4 8h24v12H4Z" fill="var(--ex-folder-paper)" />
    <path d={open ? 'M5 11h25l-4 12a3 3 0 0 1-3 2H3Z' : 'M2 11a3 3 0 0 1 3-3h7l3 3h15v11a3 3 0 0 1-3 3H5a3 3 0 0 1-3-3Z'} fill="var(--ex-folder-front)" />
    <path d="M5 24h21" stroke="var(--ex-folder-back)" strokeLinecap="round" />
  </svg>
}
export function DocumentIcon({ ext = '', size = 26 }: { ext?: string; size?: number }) {
  const e = ext.toLowerCase()
  const family = /^(docx?|odt|rtf)$/.test(e) ? 'word' : /^(xlsx?|xlsm|csv|ods)$/.test(e) ? 'sheet' : /^(pptx?|odp)$/.test(e) ? 'slide' : e === 'pdf' ? 'pdf' : /^(md|markdown)$/.test(e) ? 'markdown' : /^(html?|json|xml|js|ts|css)$/.test(e) ? 'code' : 'other'
  const mark = ({ word: 'W', sheet: 'X', slide: 'P', pdf: 'PDF', markdown: 'M↓', code: '</>', other: e.slice(0, 3).toUpperCase() || 'TXT' })[family]
  return <svg className={`ex-document-icon ex-file-${family}`} style={{ '--ex-file-color': `var(--ex-${family})` } as CSSProperties} width={size} height={size} viewBox="0 0 32 36" fill="none" aria-hidden="true">
    <path d="M8 1h14l8 8v24a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2V3a2 2 0 0 1 2-2Z" fill="var(--ex-paper)" stroke="var(--border-strong)" />
    <path d="M22 1v8h8" fill="var(--ex-paper-fold)" stroke="var(--border-strong)" strokeLinejoin="round" />
    <path d="M14 15h10M14 20h10M14 25h10" stroke="var(--ex-file-color)" strokeOpacity=".32" strokeWidth="1.5" />
    <rect x="1" y="13" width="21" height="18" rx="2.5" fill="var(--ex-file-color)" />
    <text x="11.5" y="25.5" textAnchor="middle" fill="var(--ex-mark)" fontFamily="Segoe UI, Arial, sans-serif" fontWeight="650" fontSize={mark.length > 2 ? '7.5' : '12'}>{mark}</text>
  </svg>
}
