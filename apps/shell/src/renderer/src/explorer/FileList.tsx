import { useEffect, useRef, useState } from 'react'
import type { KeyboardEvent, MouseEvent } from 'react'
import type { Item, Preferences, SortKey } from './model'
import { sizeLabel } from './model'
import { DocumentIcon, FolderGlyph, Icon } from './Icons'
import type { ExplorerString } from './strings'
interface Props {
  items: Item[]
  selected: Set<string>
  cutPaths: Set<string>
  preferences: Preferences
  locale: string
  text: (key: ExplorerString) => string
  onSelect: (path: string, options: { toggle?: boolean; range?: boolean; additive?: boolean }) => void
  onSelectAll: () => void
  onOpen: (item: Item) => void
  onContext: (event: MouseEvent, item: Item) => void
  onRename: () => void
  onDelete: () => void
  onSort: (key: SortKey) => void
}
/** Window both details and icon views so a 10,000-entry folder does not create 10,000 DOM rows. */
export function FileList({ items, selected, cutPaths, preferences: p, locale, text: t, onSelect, onSelectAll, onOpen, onContext, onRename, onDelete, onSort }: Props) {
  const host = useRef<HTMLDivElement>(null)
  const scroll = useRef<HTMLDivElement>(null)
  const [viewport, setViewport] = useState({ height: 600, width: 800, top: 0 })
  const [focused, setFocused] = useState<string | null>(null)
  const typeahead = useRef({ text: '', time: 0 })
  const tile = p.view === 'tiles', rowHeight = tile ? 146 : p.compact ? 32 : 42
  const columns = tile ? Math.max(1, Math.floor((viewport.width - 24) / 156)) : 1
  const rows = Math.ceil(items.length / columns)
  const firstRow = Math.max(0, Math.floor(viewport.top / rowHeight) - 4)
  const lastRow = Math.min(rows, Math.ceil((viewport.top + viewport.height) / rowHeight) + 4)
  const first = firstRow * columns, last = Math.min(items.length, lastRow * columns)
  useEffect(() => {
    const el = scroll.current
    if (!el) return
    const measure = () => setViewport(v => ({ ...v, width: el.clientWidth, height: el.clientHeight, top: el.scrollTop }))
    const observer = new ResizeObserver(measure)
    observer.observe(el); measure()
    return () => observer.disconnect()
  }, [])
  useEffect(() => {
    if (focused && items.some(item => item.path === focused)) return
    setFocused(items.find(item => selected.has(item.path))?.path ?? items[0]?.path ?? null)
  }, [items, focused, selected])
  useEffect(() => {
    const el = scroll.current
    if (!el) return
    el.scrollTop = 0
    setViewport(v => ({ ...v, top: 0 }))
  }, [p.view, p.compact, items.length, p.sort, p.descending])
  const bringIntoView = (index: number) => {
    const el = scroll.current
    if (!el) return
    const y = Math.floor(index / columns) * rowHeight
    if (y < el.scrollTop) el.scrollTop = y
    else if (y + rowHeight > el.scrollTop + el.clientHeight) el.scrollTop = y + rowHeight - el.clientHeight
  }
  const keyboard = (e: KeyboardEvent<HTMLDivElement>) => {
    if (e.target instanceof HTMLInputElement) return
    const ctrl = e.ctrlKey || e.metaKey
    const index = Math.max(0, items.findIndex(item => item.path === focused))
    let next: number | undefined
    if (e.key === 'ArrowDown') next = Math.min(items.length - 1, index + columns)
    else if (e.key === 'ArrowUp') next = Math.max(0, index - columns)
    else if (tile && e.key === 'ArrowRight') next = Math.min(items.length - 1, index + 1)
    else if (tile && e.key === 'ArrowLeft') next = Math.max(0, index - 1)
    else if (e.key === 'Home') next = 0
    else if (e.key === 'End') next = items.length - 1
    else if (e.key === 'PageDown') next = Math.min(items.length - 1, index + Math.max(columns, Math.floor(viewport.height / rowHeight) * columns))
    else if (e.key === 'PageUp') next = Math.max(0, index - Math.max(columns, Math.floor(viewport.height / rowHeight) * columns))
    else if (e.key === 'Enter' && items[index]) onOpen(items[index])
    else if (e.key === ' ' && items[index]) onSelect(items[index].path, { toggle: true })
    else if (ctrl && e.key.toLowerCase() === 'a') onSelectAll()
    else if (e.key === 'F2') onRename()
    else if (e.key === 'Delete') onDelete()
    else if (!ctrl && !e.altKey && e.key.length === 1 && e.key !== ' ') {
      const now = Date.now(), prior = typeahead.current
      const needle = (now - prior.time < 800 ? prior.text : '') + e.key.toLocaleLowerCase(locale)
      typeahead.current = { text: needle, time: now }
      const match = items.findIndex(item => item.name.toLocaleLowerCase(locale).startsWith(needle))
      if (match >= 0) next = match
    } else return
    e.preventDefault()
    if (next !== undefined && items[next]) {
      setFocused(items[next].path); bringIntoView(next)
      if (!ctrl || e.shiftKey) onSelect(items[next].path, { range: e.shiftKey, additive: ctrl })
    }
  }
  const date = (ms: number) => ms > 0 ? new Intl.DateTimeFormat(locale, { year: 'numeric', month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' }).format(ms) : '—'
  const type = (item: Item) => item.kind === 'folder' ? t('folder') : `${item.ext.toUpperCase()} ${t('file')}`
  const visibleFocused = focused ? items.slice(first, last).findIndex(item => item.path === focused) : -1
  return <div ref={host} className={`ex-file-list${tile ? ' is-tiles' : ''}`} role="grid" aria-label={t('files')} aria-rowcount={items.length + (tile ? 0 : 1)} aria-colcount={tile ? 2 : 5} aria-multiselectable="true" tabIndex={0}
      aria-activedescendant={visibleFocused >= 0 ? `ex-item-${first + visibleFocused}` : undefined} onKeyDown={keyboard}>
    {!tile && <div className="ex-list-heading ex-row-layout" role="row">
      <span className="ex-check-cell" role="columnheader"><input type="checkbox" aria-label="Select all visible results" checked={items.length > 0 && items.every(item => selected.has(item.path))} ref={el => { if (el) el.indeterminate = selected.size > 0 && !items.every(item => selected.has(item.path)) }} onChange={onSelectAll} /></span>
      {(['name', 'modified', 'type', 'size'] as const).map(key => <div role="columnheader" aria-sort={p.sort === key ? p.descending ? 'descending' : 'ascending' : 'none'} key={key} className={`ex-column-${key}`}>
        <button type="button" onClick={() => onSort(key)}>{t(key)}{p.sort === key && <Icon name={p.descending ? 'down' : 'up'} size={12} />}</button>
      </div>)}
    </div>}
    <div ref={scroll} className="ex-file-scroll" role="rowgroup" onScroll={e => { const el = e.currentTarget; setViewport(v => ({ ...v, top: el.scrollTop })) }}>
      <div style={{ height: firstRow * rowHeight }} aria-hidden="true" />
      <div className={tile ? 'ex-tile-grid' : ''} style={tile ? { gridTemplateColumns: `repeat(${columns}, minmax(0, 1fr))` } : undefined}>
        {items.slice(first, last).map((item, offset) => <div role="row" id={`ex-item-${first + offset}`} aria-rowindex={first + offset + (tile ? 1 : 2)} aria-selected={selected.has(item.path)}
          key={item.path} data-path={item.path} className={`${tile ? 'ex-tile' : 'ex-file-row ex-row-layout'}${selected.has(item.path) ? ' is-selected' : ''}${focused === item.path ? ' is-focused' : ''}${cutPaths.has(item.path) ? ' is-cut' : ''}`}
          style={{ height: tile ? 134 : rowHeight }} title={`${item.name}\n${item.path}`}
          onClick={e => { setFocused(item.path); host.current?.focus({ preventScroll: true }); onSelect(item.path, { toggle: e.ctrlKey || e.metaKey, range: e.shiftKey, additive: e.ctrlKey || e.metaKey }) }}
          onDoubleClick={() => onOpen(item)} onContextMenu={e => { setFocused(item.path); onContext(e, item) }}>
          <div role="gridcell" className="ex-check-cell"><input type="checkbox" tabIndex={-1} aria-label={`${t('checked')}: ${item.name}`} checked={selected.has(item.path)} onClick={e => e.stopPropagation()} onChange={() => { setFocused(item.path); onSelect(item.path, { toggle: true }) }} /></div>
          <div role="gridcell" className="ex-file-name"><span className="ex-file-symbol">{item.kind === 'folder' ? <FolderGlyph size={tile ? 70 : 24} /> : <DocumentIcon ext={item.ext} size={tile ? 66 : 26} />}</span><span className="ex-file-label" dir="auto">{item.name}</span>{item.starred && <Icon name="star" size={12} className="ex-starred-mark" />}{item.missing && <span className="ex-error">{t('unavailable')}</span>}</div>
          {!tile && <><div role="gridcell" className="ex-column-modified">{date(item.mtimeMs)}</div><div role="gridcell" className="ex-column-type">{type(item)}</div><div role="gridcell" className="ex-column-size">{item.kind === 'file' ? sizeLabel(item.sizeBytes, locale) : '—'}</div></>}
          {tile && <span className="ex-tile-meta">{item.kind === 'folder' ? t('folder') : sizeLabel(item.sizeBytes, locale)}</span>}
        </div>)}
      </div>
      <div style={{ height: Math.max(0, rows - lastRow) * rowHeight }} aria-hidden="true" />
    </div>
  </div>
}
