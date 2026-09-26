import { useEffect, useRef, useState } from 'react'
import type { KeyboardEvent, MouseEvent, ReactNode } from 'react'
import type { FolderRoot } from '../../../shared/home-api'
import type { DirectoryState } from './useDirectories'
import { basename, EXPANDED_KEY, isWithin, samePath } from './model'
import type { Item } from './model'
import { DocumentIcon, FolderGlyph, Icon } from './Icons'

interface Props {
  root: FolderRoot
  selectedPath?: string
  revision: number
  get: (path: string) => DirectoryState | undefined
  load: (path: string, force?: boolean) => Promise<unknown>
  navigate: (path: string) => void
  openFile: (path: string) => void
  onContext: (event: MouseEvent, item: Item, root: boolean) => void
}
export function DirectoryTree({ root, selectedPath, revision, get, load, navigate, openFile, onContext }: Props) {
  const [expanded, setExpanded] = useState<Set<string>>(() => {
    try {
      const saved: unknown = JSON.parse(localStorage.getItem(EXPANDED_KEY) || '[]')
      return new Set([root.path, ...(Array.isArray(saved) ? saved.filter((s): s is string => typeof s === 'string').slice(0, 128) : [])])
    } catch { return new Set([root.path]) }
  })
  const [limits, setLimits] = useState<Record<string, number>>({})
  const [focused, setFocused] = useState(root.path)
  const tree = useRef<HTMLDivElement>(null)
  const expandedRef = useRef(expanded)
  expandedRef.current = expanded
  useEffect(() => {
    setExpanded(old => new Set([...old, root.path]))
    setFocused(root.path)
  }, [root.path])
  useEffect(() => {
    for (const path of expanded) if (isWithin(path, root.path)) void load(path)
    try { localStorage.setItem(EXPANDED_KEY, JSON.stringify([...expanded].slice(-128))) } catch { /* Private windows can deny storage. */ }
  }, [expanded, root.path, load, revision])
  useEffect(() => {
    if (!selectedPath || !isWithin(selectedPath, root.path)) return
    const components = selectedPath.replace(/\\/g, '/').split('/')
    const paths: string[] = []
    for (let i = 1; i < components.length; i++) {
      const p = components.slice(0, i).join(selectedPath.includes('\\') ? '\\' : '/')
      if (isWithin(p, root.path)) paths.push(p)
    }
    setExpanded(old => new Set([...old, root.path, ...paths]))
  }, [selectedPath, root.path])
  const toggle = (path: string) => setExpanded(old => {
    const next = new Set(old)
    next.has(path) ? next.delete(path) : next.add(path)
    return next
  })
  const focusRow = (path: string) => {
    setFocused(path)
    requestAnimationFrame(() => {
      const row = [...(tree.current?.querySelectorAll<HTMLElement>('[role="treeitem"]') ?? [])].find(el => el.dataset.path === path)
      row?.focus(); row?.scrollIntoView({ block: 'nearest' })
    })
  }
  const keyDown = (e: KeyboardEvent<HTMLElement>, path: string, folder: boolean, parent?: string) => {
    const rows = [...(tree.current?.querySelectorAll<HTMLElement>('[role="treeitem"]') ?? [])]
    const index = rows.findIndex(row => row.dataset.path === path)
    let next: HTMLElement | undefined
    if (e.key === 'ArrowDown') next = rows[Math.min(rows.length - 1, index + 1)]
    else if (e.key === 'ArrowUp') next = rows[Math.max(0, index - 1)]
    else if (e.key === 'Home') next = rows[0]
    else if (e.key === 'End') next = rows[rows.length - 1]
    else if (e.key === 'ArrowRight' && folder) {
      if (!expandedRef.current.has(path)) toggle(path)
      else next = rows[index + 1]
    } else if (e.key === 'ArrowLeft') {
      if (folder && expandedRef.current.has(path)) toggle(path)
      else if (parent) focusRow(parent)
    } else if (e.key === 'Enter' || e.key === ' ') {
      folder ? navigate(path) : openFile(path)
    } else return
    e.preventDefault(); e.stopPropagation()
    if (next?.dataset.path) focusRow(next.dataset.path)
  }
  const render = (path: string, name: string, depth: number, parent?: string): ReactNode => {
    if (depth > 40) return null
    const state = get(path), open = expanded.has(path)
    const folders = [...(state?.listing?.folders ?? [])].sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true }))
    const files = [...(state?.listing?.files ?? [])].sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true }))
    const current = !!selectedPath && samePath(path, selectedPath)
    const item: Item = { path, name, kind: 'folder', ext: '', mtimeMs: 0, sizeBytes: 0 }
    return <div key={path} role="none">
      <div role="treeitem" aria-label={name} aria-expanded={open} aria-selected={current} aria-level={depth + 1}
        className={`ex-tree-row${current ? ' is-current' : ''}`} data-path={path}
        tabIndex={samePath(focused, path) ? 0 : -1} style={{ paddingInlineStart: 6 + Math.min(depth, 9) * 16 }}
        onFocus={() => setFocused(path)} onClick={() => { setFocused(path); navigate(path) }}
        onKeyDown={event => keyDown(event, path, true, parent)} onContextMenu={event => onContext(event, item, depth === 0)} title={path}>
        <button type="button" tabIndex={-1} className={`ex-tree-toggle${open ? ' is-open' : ''}`} aria-label={`${open ? 'Collapse' : 'Expand'} ${name}`}
          onClick={event => { event.stopPropagation(); toggle(path) }}><Icon name="chevron" size={12} /></button>
        <FolderGlyph size={20} open={open} /><span className="ex-tree-name" dir="auto">{name}</span>
        {depth === 0 && <span className="ex-root-dot" aria-hidden="true" />}
      </div>
      {open && <div role="group">
        {state?.loading && !state.listing && <div className="ex-tree-message" role="status">Loading…</div>}
        {state?.error && <div className="ex-tree-message ex-error"><span>{state.error}</span><button type="button" onClick={() => void load(path, true)}>Retry</button></div>}
        {folders.map(folder => render(folder.path, folder.name, depth + 1, path))}
        {files.slice(0, limits[path] ?? 100).map(file => <div key={file.path} role="treeitem" aria-label={file.name} aria-level={depth + 2} aria-selected={selectedPath ? samePath(selectedPath, file.path) : false}
          data-path={file.path} className={`ex-tree-row ex-tree-file${selectedPath && samePath(selectedPath, file.path) ? ' is-current' : ''}`}
          tabIndex={samePath(focused, file.path) ? 0 : -1} style={{ paddingInlineStart: 26 + Math.min(depth + 1, 9) * 16 }} title={file.path}
          onFocus={() => setFocused(file.path)} onClick={() => openFile(file.path)} onKeyDown={event => keyDown(event, file.path, false, path)}
          onContextMenu={event => onContext(event, { ...file, kind: 'file' }, false)}>
          <DocumentIcon ext={file.ext} size={20} /><span className="ex-tree-name" dir="auto">{file.name}</span>
        </div>)}
        {files.length > (limits[path] ?? 100) && <div className="ex-tree-message"><button type="button" onClick={() => setLimits(old => ({ ...old, [path]: (old[path] ?? 100) + 100 }))}>Show more files ({files.length - (limits[path] ?? 100)})</button></div>}
        {state?.listing && !state.loading && !state.error && !folders.length && !files.length && <div className="ex-tree-message">No supported documents</div>}
      </div>}
    </div>
  }
  return <div ref={tree} role="tree" className="ex-tree" aria-label={`${basename(root.path)} documents`}>{render(root.path, root.name, 0)}</div>
}
