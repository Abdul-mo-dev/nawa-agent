import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { CSSProperties, MouseEvent, ReactNode } from 'react'
import type { FolderRoot, HomeApi, RecentPage } from '../../../shared/home-api'
import type { TabSummary } from '../../../shared/tabs-api'
import type { ExplorerLayout } from '../../../shared/explorer-layout'
import { useI18n } from '../locale'
import { WorkspaceChat } from '../WorkspaceChat'
import '../workspace.css'
import { DirectoryTree } from './Tree'
import { FileList } from './FileList'
import { DocumentIcon, FolderGlyph, Icon, NawaIcon } from './Icons'
import { Dialog, Menu, Splitter, ToolButton, useEditorSlot } from './Controls'
import type { MenuAction } from './Controls'
import { ExplorerSettings } from './Settings'
import { useDirectories } from './useDirectories'
import { explorerText } from './strings'
import { basename, breadcrumbs, DEFAULT_PREFERENCES, isWithin, LAST_LOCATION_KEY, parentPath, parsePreferences, PREFERENCES_KEY, rootFor, samePath, selectRange, sizeLabel, sortItems, validName, visit } from './model'
import type { Item, Location, Navigation, Preferences, SortKey } from './model'
import './explorer.css'

declare global {
  interface Window {
    aiOffice: HomeApi
    nawaExplorer?: { setLayout: (layout: ExplorerLayout) => void }
  }
}
interface Props { editorTab?: TabSummary; onOpenLegacy: () => void }
type DialogState =
  | { kind: 'newFolder'; parent: string }
  | { kind: 'rename'; item: Item }
  | { kind: 'delete'; items: Item[] }
  | { kind: 'remove'; root: FolderRoot }
  | { kind: 'conflicts'; paths: string[]; destination: string }
const PAGE_SIZE = 200
const errorText = (error: unknown) => error instanceof Error ? error.message : String(error)

export function ExplorerHome({ editorTab, onOpenLegacy }: Props) {
  const { lang, dateLocale } = useI18n()
  const t = explorerText(lang)
  const [prefs, setPrefs] = useState<Preferences>(() => { try { return parsePreferences(localStorage.getItem(PREFERENCES_KEY)) } catch { return { ...DEFAULT_PREFERENCES } } })
  const [roots, setRoots] = useState<FolderRoot[]>([])
  const [rootsLoading, setRootsLoading] = useState(true)
  const [activeRoot, setActiveRoot] = useState<string | null>(null)
  const [history, setHistory] = useState<Navigation>({ entries: [{ kind: 'home' }], index: 0 })
  const [revision, setRevision] = useState(0)
  const [selected, setSelected] = useState(new Set<string>())
  const anchor = useRef<string | null>(null)
  const [search, setSearch] = useState('')
  const searchInput = useRef<HTMLInputElement>(null)
  const addressInput = useRef<HTMLInputElement>(null)
  const [editingAddress, setEditingAddress] = useState(false)
  const [address, setAddress] = useState('')
  const [notice, setNotice] = useState<{ text: string; error: boolean } | null>(null)
  const [busy, setBusy] = useState(false)
  const [menu, setMenu] = useState<{ x: number; y: number; actions: MenuAction[] } | null>(null)
  const [dialog, setDialog] = useState<DialogState | null>(null)
  const [name, setName] = useState('')
  const [dialogError, setDialogError] = useState<string | null>(null)
  const [settingsOpen, setSettingsOpen] = useState(false)
  const [cutItems, setCutItems] = useState<Item[]>([])
  const [page, setPage] = useState<RecentPage>({ entries: [], total: 0, totalAll: 0 })
  const [pageLoading, setPageLoading] = useState(false)
  const [pageError, setPageError] = useState<string | null>(null)
  const pageSequence = useRef(0), rootSequence = useRef(0)
  const restored = useRef(false)
  const { get: directory, load: loadDirectory, invalidate } = useDirectories()
  const center = useRef<HTMLElement>(null)
  const explorer = useRef<HTMLDivElement>(null)
  const [windowWidth, setWindowWidth] = useState(() => window.innerWidth)
  const location = history.entries[history.index]
  const folder = location.kind === 'folder' ? location.path : null
  const editorActive = !!editorTab && editorTab.kind !== 'home'
  const currentRootPath = folder ? rootFor(folder, roots) : undefined
  const currentRoot = roots.find(root => samePath(root.path, currentRootPath || activeRoot || '')) ?? roots[0]
  const state = folder ? directory(folder) : undefined
  const inspectorVisible = !editorActive && prefs.pane !== 'none' && windowWidth >= 900
  const navigationVisible = prefs.navigationVisible && windowWidth >= 540
  const effectiveNavWidth = Math.min(prefs.navigationWidth, Math.max(180, windowWidth - 400))
  const effectiveInspectorWidth = Math.min(prefs.inspectorWidth, Math.max(300, windowWidth - (navigationVisible ? effectiveNavWidth : 0) - 385))
  const title = folder ? basename(folder) : t(location.kind as 'home' | 'recent' | 'starred')
  const suspended = !!menu || !!dialog || settingsOpen
  useEditorSlot(center, suspended)
  const notify = useCallback((text: string, error = false) => setNotice({ text, error }), [])
  const failure = useCallback((error: unknown) => notify(errorText(error), true), [notify])
  const act = useCallback(async (operation: () => Promise<unknown>) => { try { await operation() } catch (error) { failure(error) } }, [failure])
  const closeMenu = useCallback(() => setMenu(null), [])
  const changePrefs = (patch: Partial<Preferences>) => setPrefs(p => ({ ...p, ...patch }))

  const loadRoots = useCallback(async () => {
    const current = ++rootSequence.current
    setRootsLoading(true)
    try {
      const result = await window.aiOffice.workspaceRoots()
      if (current !== rootSequence.current) return result
      setRoots(result)
      setActiveRoot(old => result.find(root => old && samePath(root.path, old))?.path ?? result[0]?.path ?? null)
      if (!restored.current) {
        restored.current = true
        try {
          const saved: unknown = JSON.parse(localStorage.getItem(LAST_LOCATION_KEY) || 'null')
          if (saved && typeof saved === 'object' && 'kind' in saved && saved.kind === 'folder' && 'path' in saved && typeof saved.path === 'string' && rootFor(saved.path, result)) {
            setHistory({ entries: [{ kind: 'home' }, { kind: 'folder', path: saved.path }], index: 1 })
          }
        } catch { /* Ignore invalid or inaccessible preferences. */ }
      }
      return result
    } catch (error) { if (current === rootSequence.current) failure(error); return [] }
    finally { if (current === rootSequence.current) setRootsLoading(false) }
  }, [failure])
  useEffect(() => {
    void loadRoots()
    const off = window.aiOffice.onWorkspaceRootsChanged(() => { void loadRoots() })
    return () => { rootSequence.current++; off() }
  }, [loadRoots])
  useEffect(() => {
    let timer: ReturnType<typeof setTimeout> | undefined
    const off = window.aiOffice.onFolderChanged(() => {
      clearTimeout(timer)
      timer = setTimeout(() => { invalidate(); setRevision(n => n + 1) }, 150)
    })
    return () => { clearTimeout(timer); off() }
  }, [invalidate])
  useEffect(() => {
    const resize = () => setWindowWidth(window.innerWidth)
    window.addEventListener('resize', resize)
    return () => window.removeEventListener('resize', resize)
  }, [])
  useEffect(() => { try { localStorage.setItem(PREFERENCES_KEY, JSON.stringify(prefs)) } catch { /* Storage is optional. */ } }, [prefs])
  useEffect(() => {
    if (rootsLoading) return
    try { localStorage.setItem(LAST_LOCATION_KEY, JSON.stringify(location)) } catch { /* Storage is optional. */ }
  }, [location, rootsLoading])
  useEffect(() => {
    if (folder && rootFor(folder, roots)) { void loadDirectory(folder); setActiveRoot(rootFor(folder, roots) ?? null) }
  }, [folder, roots, loadDirectory, revision])
  useEffect(() => {
    if (location.kind === 'folder') { pageSequence.current++; setPageLoading(false); return }
    const sequence = ++pageSequence.current
    setPage({ entries: [], total: 0, totalAll: 0 }); setPageLoading(true); setPageError(null)
    const get = location.kind === 'starred' ? window.aiOffice.starred : window.aiOffice.recents
    void get({ offset: 0, limit: location.kind === 'home' ? 12 : PAGE_SIZE }).then(result => {
      if (sequence === pageSequence.current) setPage(result)
    }).catch(error => { if (sequence === pageSequence.current) setPageError(errorText(error)) })
      .finally(() => { if (sequence === pageSequence.current) setPageLoading(false) })
    return () => { pageSequence.current++ }
  }, [location.kind, revision])
  useEffect(() => {
    if (!editorActive || !editorTab?.filePath) return
    const root = rootFor(editorTab.filePath, roots)
    if (!root) return
    const parent = parentPath(editorTab.filePath)
    setActiveRoot(root)
    setHistory(old => visit(old, { kind: 'folder', path: parent }))
    setSelected(new Set([editorTab.filePath])); anchor.current = editorTab.filePath
    setSearch('')
  }, [editorTab?.id, editorTab?.filePath, editorActive, roots])

  const navigate = useCallback((next: Location) => {
    setHistory(old => visit(old, next)); setSelected(new Set()); anchor.current = null
    setSearch(''); setEditingAddress(false); setNotice(null)
    void window.aiOfficeTabs.activate('home').catch(failure)
  }, [failure])
  const moveHistory = (delta: number) => {
    const next = history.index + delta
    if (next < 0 || next >= history.entries.length) return
    setHistory(old => ({ ...old, index: next })); setSelected(new Set()); anchor.current = null
    setSearch(''); setEditingAddress(false); setNotice(null)
    void window.aiOfficeTabs.activate('home').catch(failure)
  }
  const refresh = () => { invalidate(); setRevision(n => n + 1); void loadRoots() }
  const openFile = useCallback((path: string) => { void window.aiOffice.openPath(path).catch(failure) }, [failure])
  const openItem = (item: Item) => { item.kind === 'folder' ? navigate({ kind: 'folder', path: item.path }) : openFile(item.path) }
  const addRoot = async () => {
    if (busy) return
    setBusy(true)
    try { const picked = await window.aiOffice.pickWorkspaceFolder(); if (picked) { const mounted = await loadRoots(); setActiveRoot(rootFor(picked.path, mounted) ?? null); navigate({ kind: 'folder', path: picked.path }) } }
    catch (error) { failure(error) }
    finally { setBusy(false) }
  }
  const allItems = useMemo<Item[]>(() => {
    if (folder) return [
      ...(state?.listing?.folders ?? []).map(item => ({ ...item, kind: 'folder' as const, ext: '', sizeBytes: 0 })),
      ...(state?.listing?.files ?? []).map(item => ({ ...item, kind: 'file' as const })),
    ]
    const recent = page.entries.map(item => ({ ...item, kind: 'file' as const }))
    return location.kind === 'home' ? [...roots.map(root => ({ ...root, kind: 'folder' as const, ext: '', mtimeMs: 0, sizeBytes: 0 })), ...recent] : recent
  }, [folder, state?.listing, page.entries, location.kind, roots])
  const items = useMemo(() => {
    const needle = search.trim().toLocaleLowerCase(dateLocale)
    return sortItems(needle ? allItems.filter(item => item.name.toLocaleLowerCase(dateLocale).includes(needle)) : allItems, prefs.sort, prefs.descending, dateLocale)
  }, [allItems, search, prefs.sort, prefs.descending, dateLocale])
  const selectedItems = allItems.filter(item => selected.has(item.path))
  const protectedItem = (item: Item) => item.kind === 'folder' && roots.some(root => isWithin(root.path, item.path))
  const canMutate = selectedItems.length > 0 && !selectedItems.some(protectedItem)
  const currentContext: Item | undefined = selectedItems.length === 1 ? selectedItems[0] : undefined
  const cutPaths = new Set(cutItems.map(item => item.path))
  const choose = (path: string, options: { toggle?: boolean; range?: boolean; additive?: boolean }) => {
    if (options.range) setSelected(previous => selectRange(items.map(item => item.path), anchor.current, path, previous, !!options.additive))
    else if (options.toggle) { setSelected(previous => { const next = new Set(previous); next.has(path) ? next.delete(path) : next.add(path); return next }); anchor.current = path }
    else { setSelected(new Set([path])); anchor.current = path }
  }
  const selectAll = () => setSelected(old => items.length > 0 && items.every(item => old.has(item.path)) ? new Set() : new Set(items.map(item => item.path)))
  const beginDialog = (next: DialogState) => { setDialog(next); setDialogError(null); setName(next.kind === 'rename' ? next.item.name : '') }
  const closeDialog = () => { if (!busy) setDialog(null) }
  const copyPaths = (paths: string[]) => { void navigator.clipboard.writeText(paths.join('\n')).then(() => notify(t('copied'))).catch(() => notify(t('clipboardError'), true)) }
  const requestRename = (list = selectedItems) => { if (list.length === 1 && !protectedItem(list[0])) beginDialog({ kind: 'rename', item: list[0] }) }
  const requestDelete = (list = selectedItems) => { if (list.length && !list.some(protectedItem)) beginDialog({ kind: 'delete', items: list }) }
  const beginCut = (list: Item[]) => { if (list.length && !list.some(protectedItem)) { setCutItems(list); notify(t('moveHelp')) } }
  const sort = (key: SortKey) => changePrefs({ sort: key, descending: prefs.sort === key ? !prefs.descending : false })
  const moveFiles = async (paths: string[], destination: string, keepBoth = false) => {
    const result = await window.aiOffice.movePaths(paths, destination, keepBoth ? 'keepBoth' : 'ask')
    const moved = new Set(result.moved.map(item => item.from))
    setCutItems(old => old.filter(item => !moved.has(item.path)))
    refresh()
    if (result.failed.length) notify(result.failed.map(item => `${basename(item.path)}: ${item.error}`).join('\n'), true)
    else if (result.moved.length) notify(t('moved'))
    if (result.conflicts.length) beginDialog({ kind: 'conflicts', paths: result.conflicts, destination })
    else if (keepBoth) setDialog(null)
  }
  const paste = async () => {
    if (!folder || !cutItems.length || busy) return
    setBusy(true)
    try { await moveFiles(cutItems.map(item => item.path), folder) } catch (error) { failure(error) } finally { setBusy(false) }
  }
  const ask = (list: Item[]) => {
    if (!list.length) { changePrefs({ pane: 'ai' }); return }
    if (list.length === 1 && !allItems.some(item => samePath(item.path, list[0].path))) {
      const parent = parentPath(list[0].path)
      if (rootFor(parent, roots)) navigate({ kind: 'folder', path: parent })
      else navigate({ kind: 'home' })
    }
    setSelected(new Set(list.map(item => item.path)))
    changePrefs({ pane: 'ai' })
  }
  const fileActions = (list: Item[], isRoot = false): MenuAction[] => {
    const one = list.length === 1 ? list[0] : undefined, protectedSelection = isRoot || list.some(protectedItem)
    return [
      { label: t('open'), icon: 'open', disabled: !one, shortcut: 'Enter', action: () => { if (one) openItem(one) } },
      { label: t('ask'), icon: 'sparkles', action: () => ask(list) },
      { label: t('cut'), icon: 'cut', disabled: protectedSelection, shortcut: 'Ctrl+X', divider: true, action: () => beginCut(list) },
      { label: t('copyPath'), icon: 'copy', action: () => copyPaths(list.map(item => item.path)) },
      { label: t('rename'), icon: 'rename', shortcut: 'F2', disabled: !one || protectedSelection, action: () => requestRename(list) },
      { label: t('duplicate'), icon: 'copy', disabled: !one || one.kind !== 'file', action: () => { if (one) void act(async () => { await window.aiOffice.duplicateFile(one.path); refresh() }) } },
      { label: t('starred'), icon: 'star', checked: !!one?.starred, disabled: !one || one.kind !== 'file', divider: true, action: () => { if (one) void act(async () => { await window.aiOffice.toggleStar(one.path); refresh() }) } },
      { label: t('reveal'), icon: 'open', disabled: !one, action: () => { if (one) void act(() => window.aiOffice.revealPath(one.path)) } },
      { label: t('trash'), icon: 'trash', shortcut: 'Delete', disabled: protectedSelection, danger: true, divider: true, action: () => requestDelete(list) },
    ]
  }
  const showItemMenu = (event: MouseEvent, item: Item, isRoot = false, fromTree = false) => {
    event.preventDefault(); event.stopPropagation()
    const list = !fromTree && selected.has(item.path) ? selectedItems : [item]
    if (!fromTree && !selected.has(item.path)) { setSelected(new Set([item.path])); anchor.current = item.path }
    setMenu({ x: event.clientX, y: event.clientY, actions: fileActions(list, isRoot) })
  }
  const toolbarMenu = (event: MouseEvent, actions: MenuAction[]) => {
    const rect = event.currentTarget.getBoundingClientRect()
    setMenu({ x: rect.left, y: rect.bottom + 6, actions })
  }
  const createFile = (kind: 'document' | 'spreadsheet' | 'presentation' | 'pdf' | 'markdown' | 'html') => {
    const operations = { document: window.aiOffice.newDoc, spreadsheet: window.aiOffice.newSheet, presentation: window.aiOffice.newSlide, pdf: window.aiOffice.newPdf, markdown: window.aiOffice.newMarkdown, html: window.aiOffice.newHtml }
    void act(() => operations[kind](folder ? { dir: folder } : undefined))
  }
  const newActions = (): MenuAction[] => [
    { label: t('newFolder'), icon: 'folder', disabled: !folder, action: () => { if (folder) beginDialog({ kind: 'newFolder', parent: folder }) } },
    ...(['document', 'spreadsheet', 'presentation', 'pdf', 'markdown', 'html'] as const).map(kind => ({ label: t(kind), action: () => createFile(kind) })),
    { label: t('add'), icon: 'plus', divider: true, action: () => { void addRoot() } },
  ]
  const viewActions = (): MenuAction[] => [
    { label: t('details'), icon: 'list', checked: prefs.view === 'details', action: () => changePrefs({ view: 'details' }) },
    { label: t('tiles'), icon: 'grid', checked: prefs.view === 'tiles', action: () => changePrefs({ view: 'tiles' }) },
    { label: t('compact'), checked: prefs.compact, divider: true, action: () => changePrefs({ compact: !prefs.compact }) },
    { label: t('navigation'), icon: 'pane', checked: prefs.navigationVisible, action: () => changePrefs({ navigationVisible: !prefs.navigationVisible }) },
    { label: t('assistant'), icon: 'sparkles', checked: prefs.pane === 'ai', disabled: editorActive, action: () => changePrefs({ pane: prefs.pane === 'ai' ? 'none' : 'ai' }) },
    { label: t('details'), icon: 'info', checked: prefs.pane === 'details', disabled: editorActive, action: () => changePrefs({ pane: prefs.pane === 'details' ? 'none' : 'details' }) },
    { label: t('resetLayout'), divider: true, action: () => setPrefs({ ...DEFAULT_PREFERENCES }) },
    { label: 'Original home', icon: 'home', divider: true, action: onOpenLegacy },
  ]
  const commitDialog = async () => {
    if (!dialog || busy) return
    if ((dialog.kind === 'newFolder' || dialog.kind === 'rename') && !validName(name)) { setDialogError(t('invalidName')); return }
    setBusy(true); setDialogError(null)
    try {
      if (dialog.kind === 'newFolder' || dialog.kind === 'rename') {
        const result = dialog.kind === 'newFolder' ? await window.aiOffice.createFolder(dialog.parent, name)
          : dialog.item.kind === 'folder' ? await window.aiOffice.renameFolder(dialog.item.path, name) : await window.aiOffice.renameFile(dialog.item.path, name)
        if (!result.ok) throw new Error(result.error || 'The operation failed.')
        setSelected(new Set(result.path ? [result.path] : [])); anchor.current = result.path ?? null
      } else if (dialog.kind === 'remove') {
        await window.aiOffice.removeWorkspaceFolder(dialog.root.path)
        if (folder && isWithin(folder, dialog.root.path)) navigate({ kind: 'home' })
        setCutItems(old => old.filter(item => !isWithin(item.path, dialog.root.path)))
        await loadRoots()
      } else if (dialog.kind === 'delete') {
        const files = dialog.items.filter(item => item.kind === 'file').map(item => item.path)
        if (files.length) await window.aiOffice.deleteFiles(files)
        for (const item of dialog.items.filter(item => item.kind === 'folder')) await window.aiOffice.deleteFolder(item.path)
        setSelected(new Set()); anchor.current = null
      } else if (dialog.kind === 'conflicts') { await moveFiles(dialog.paths, dialog.destination, true); return }
      setDialog(null); refresh()
    } catch (error) { setDialogError(errorText(error)); refresh() }
    finally { setBusy(false) }
  }
  const loadMore = async () => {
    if (pageLoading || location.kind === 'folder') return
    const sequence = pageSequence.current
    setPageLoading(true)
    try {
      const get = location.kind === 'starred' ? window.aiOffice.starred : window.aiOffice.recents
      const next = await get({ offset: page.entries.length, limit: PAGE_SIZE })
      if (sequence === pageSequence.current) setPage(old => ({ ...next, entries: [...new Map([...old.entries, ...next.entries].map(item => [item.path, item])).values()] }))
    } catch (error) { if (sequence === pageSequence.current) setPageError(errorText(error)) }
    finally { if (sequence === pageSequence.current) setPageLoading(false) }
  }
  const startAddress = () => {
    setAddress(folder || currentRoot?.path || ''); setEditingAddress(true)
    requestAnimationFrame(() => { addressInput.current?.focus(); addressInput.current?.select() })
  }
  const submitAddress = () => {
    const value = address.trim().replace(/^"|"$/g, '')
    const root = rootFor(value, roots)
    if (!root) { notify(t('notMounted'), true); return }
    void loadDirectory(value, true).then(result => {
      if (!result || result.missing) { notify(t('notMounted'), true); return }
      navigate({ kind: 'folder', path: result.dir })
    })
  }
  const keyboardRef = useRef({ startAddress, moveHistory, refresh, paste, selectedItems, beginCut })
  keyboardRef.current = { startAddress, moveHistory, refresh, paste, selectedItems, beginCut }
  useEffect(() => {
    const keyboard = (e: globalThis.KeyboardEvent) => {
      if (e.defaultPrevented || e.isComposing || document.querySelector('.ex-dialog-backdrop, .settings-overlay')) return
      const input = e.target instanceof HTMLElement && (e.target.matches('input,textarea,select') || e.target.isContentEditable)
      const ctrl = e.ctrlKey || e.metaKey, commands = keyboardRef.current
      if (ctrl && (e.key.toLowerCase() === 'l' || e.key.toLowerCase() === 'd')) { e.preventDefault(); commands.startAddress() }
      else if (ctrl && e.key.toLowerCase() === 'f' && !editorActive) { e.preventDefault(); searchInput.current?.focus(); searchInput.current?.select() }
      else if (e.key === 'F5' && !editorActive) { e.preventDefault(); commands.refresh() }
      else if (e.altKey && e.key === 'ArrowLeft') { e.preventDefault(); commands.moveHistory(-1) }
      else if (e.altKey && e.key === 'ArrowRight') { e.preventDefault(); commands.moveHistory(1) }
      else if (!input && !editorActive && ctrl && e.key.toLowerCase() === 'x') { e.preventDefault(); commands.beginCut(commands.selectedItems) }
      else if (!input && !editorActive && ctrl && e.key.toLowerCase() === 'v') { e.preventDefault(); void commands.paste() }
      else if (e.key === 'Escape' && !input) { closeMenu(); setSelected(new Set()); setCutItems([]) }
    }
    window.addEventListener('keydown', keyboard)
    return () => window.removeEventListener('keydown', keyboard)
  }, [editorActive, closeMenu])

  const crumbPath = editorActive && editorTab?.filePath ? parentPath(editorTab.filePath) : folder
  const crumbRoot = crumbPath ? rootFor(crumbPath, roots) : undefined
  const crumbs = crumbPath && crumbRoot ? breadcrumbs(crumbPath, crumbRoot) : []
  const upPath = editorActive ? crumbPath : folder && currentRootPath && !samePath(folder, currentRootPath) ? parentPath(folder) : null
  const itemCount = allItems.length
  const loading = folder ? !!state?.loading || (!state && !!currentRootPath) : pageLoading || rootsLoading
  const listError = folder ? (!currentRootPath && !rootsLoading ? t('notMounted') : state?.error) : pageError
  const headerIcon = folder ? <FolderGlyph size={34} open /> : location.kind === 'home' ? <NawaIcon size={34} /> : <Icon name={location.kind === 'starred' ? 'star' : location.kind === 'recent' ? 'recent' : 'home'} size={28} />

  function detailsPane(): ReactNode {
    const item = currentContext
    if (!item && selectedItems.length > 1) return <div className="ex-details-body"><Icon name="list" size={52} /><h2>{selectedItems.length} {t('selected')}</h2><dl><dt>{t('totalSize')}</dt><dd>{sizeLabel(selectedItems.filter(entry => entry.kind === 'file').reduce((sum, entry) => sum + entry.sizeBytes, 0), dateLocale)}</dd></dl><button className="ex-primary" onClick={() => ask(selectedItems)}><Icon name="sparkles" />{t('ask')}</button></div>
    if (!item) return <div className="ex-pane-empty"><Icon name="info" size={42} /><h2>{t('selectDetails')}</h2><p>{folder || t('local')}</p></div>
    return <div className="ex-details-body"><div className="ex-detail-art">{item.kind === 'folder' ? <FolderGlyph size={90} /> : <DocumentIcon ext={item.ext} size={90} />}</div><h2 dir="auto">{item.name}</h2><span className="ex-detail-kind">{item.kind === 'folder' ? t('folder') : `${item.ext.toUpperCase()} ${t('file')}`}</span><div className="ex-detail-buttons"><button className="ex-primary" onClick={() => openItem(item)}><Icon name="open" size={16} />{t('open')}</button><button className="ex-secondary" onClick={() => ask([item])}><Icon name="sparkles" size={16} />{t('ask')}</button></div><dl>
      <dt>{t('type')}</dt><dd>{item.kind === 'folder' ? t('folder') : item.ext.toUpperCase()}</dd>
      {item.kind === 'file' && <><dt>{t('size')}</dt><dd>{sizeLabel(item.sizeBytes, dateLocale)}</dd></>}
      <dt>{t('modified')}</dt><dd>{item.mtimeMs ? new Intl.DateTimeFormat(dateLocale, { dateStyle: 'medium', timeStyle: 'short' }).format(item.mtimeMs) : '—'}</dd>
      <dt>{t('path')}</dt><dd className="ex-detail-path" dir="auto">{item.path}</dd>
    </dl><button className="ex-link" onClick={() => copyPaths([item.path])}><Icon name="copy" size={14} />{t('copyPath')}</button><button className="ex-link" onClick={() => { void act(() => window.aiOffice.revealPath(item.path)) }}><Icon name="open" size={14} />{t('reveal')}</button></div>
  }

  return <div ref={explorer} className={`explorer${prefs.compact ? ' ex-compact' : ''}${editorActive ? ' ex-editor-active' : ''}`} data-testid="nawa-explorer" style={{ '--ex-nav-width': `${effectiveNavWidth}px`, '--ex-inspector-width': `${effectiveInspectorWidth}px` } as CSSProperties}>
    <header className="ex-address-row">
      <div className="ex-history"><ToolButton icon="left" label={`${t('back')} (Alt+←)`} disabled={history.index === 0} onClick={() => moveHistory(-1)} /><ToolButton icon="right" label={`${t('forward')} (Alt+→)`} disabled={history.index >= history.entries.length - 1} onClick={() => moveHistory(1)} /><ToolButton icon="up" label={t('up')} disabled={!upPath || !rootFor(upPath, roots)} onClick={() => { if (upPath) navigate({ kind: 'folder', path: upPath }) }} /><ToolButton icon="refresh" label={`${t('refresh')} (F5)`} onClick={refresh} /></div>
      <div className="ex-address" onDoubleClick={startAddress}>
        {editingAddress ? <input ref={addressInput} className="ex-address-input" aria-label={t('address')} value={address} onChange={e => setAddress(e.target.value)} onBlur={() => setEditingAddress(false)} onKeyDown={e => { if (e.key === 'Enter') { e.preventDefault(); submitAddress() } else if (e.key === 'Escape') { e.preventDefault(); setEditingAddress(false) } }} /> : <><button className="ex-address-home" aria-label={t('home')} onClick={() => navigate({ kind: 'home' })}><Icon name="home" size={17} /></button><nav aria-label="Breadcrumb" className="ex-breadcrumbs">
          {crumbs.length ? crumbs.map((crumb, index) => <span className="ex-crumb" key={crumb.path}><Icon name="chevron" size={11} /><button aria-current={!editorActive && index === crumbs.length - 1 ? 'page' : undefined} onClick={() => navigate({ kind: 'folder', path: crumb.path })} title={crumb.path}>{crumb.name}</button></span>) : <span className="ex-crumb"><Icon name="chevron" size={11} /><span>{title}</span></span>}
          {editorActive && <span className="ex-crumb ex-file-crumb"><Icon name="chevron" size={11} /><span aria-current="page" dir="auto">{editorTab?.title}</span></span>}
        </nav><button className="ex-address-edit" aria-label={`${t('address')} (Ctrl+L)`} title="Ctrl+L" onClick={startAddress}><Icon name="down" size={12} /></button></>}
      </div>
      <label className="ex-search"><Icon name="search" size={17} /><input ref={searchInput} type="search" aria-label={folder ? t('search') : t('searchFiles')} placeholder={folder ? `${t('search')}…` : `${t('searchFiles')}…`} value={search} disabled={editorActive} onChange={e => { setSearch(e.target.value); setSelected(new Set()) }} /><kbd>Ctrl F</kbd></label>
    </header>
    <div className="ex-command-bar" role="toolbar" aria-label="File commands">
      <button className="ex-tool with-label ex-new-button" disabled={busy} onClick={e => toolbarMenu(e, newActions())}><Icon name="plus" /><span>{t('new')}</span><Icon name="down" size={12} /></button><span className="ex-command-divider" />
      {editorActive ? <button className="ex-tool with-label" onClick={() => navigate(folder ? { kind: 'folder', path: folder } : { kind: 'recent' })}><Icon name="left" /><span>{t('backFiles')}</span></button> : <><ToolButton icon="cut" label={t('cut')} disabled={!canMutate || busy} onClick={() => beginCut(selectedItems)} /><ToolButton icon="copy" label={t('copyPath')} disabled={!selectedItems.length} onClick={() => copyPaths(selectedItems.map(item => item.path))} /><ToolButton icon="paste" label={t('paste')} disabled={!folder || !cutItems.length || busy} onClick={() => { void paste() }} /><ToolButton icon="rename" label={t('rename')} disabled={!canMutate || selectedItems.length !== 1 || busy} onClick={() => requestRename()} /><ToolButton icon="trash" label={t('trash')} disabled={!canMutate || busy} onClick={() => requestDelete()} /></>}
      <span className="ex-command-divider" /><button className="ex-tool with-label" disabled={editorActive} onClick={e => toolbarMenu(e, [...(['name', 'modified', 'type', 'size'] as const).map(key => ({ label: t(key), checked: prefs.sort === key, action: () => changePrefs({ sort: key }) })), { label: t('ascending'), divider: true, checked: !prefs.descending, action: () => changePrefs({ descending: false }) }, { label: t('descending'), checked: prefs.descending, action: () => changePrefs({ descending: true }) }])}><Icon name="sort" /><span>{t('sort')}</span><Icon name="down" size={11} /></button>
      <button className="ex-tool with-label" onClick={e => toolbarMenu(e, viewActions())}><Icon name="list" /><span>{t('view')}</span><Icon name="down" size={11} /></button>
      <button className="ex-tool" aria-label="More actions" title="More actions" onClick={e => toolbarMenu(e, [{ label: t('add'), icon: 'plus', action: () => { void addRoot() } }, { label: t('openFile'), icon: 'open', action: () => { void act(() => window.aiOffice.browse()) } }, { label: t('settings'), icon: 'settings', divider: true, action: () => setSettingsOpen(true) }, { label: 'Original home', icon: 'home', action: onOpenLegacy }])}><Icon name="more" /></button>
      <span className="ex-toolbar-spacer" /><ToolButton icon="pane" label={t('navigation')} pressed={navigationVisible} onClick={() => changePrefs({ navigationVisible: !prefs.navigationVisible })} /><ToolButton icon="info" label={t('details')} disabled={editorActive || windowWidth < 900} pressed={inspectorVisible && prefs.pane === 'details'} onClick={() => changePrefs({ pane: prefs.pane === 'details' ? 'none' : 'details' })} /><button className="ex-tool with-label ex-assistant-toggle" disabled={editorActive || windowWidth < 900} aria-pressed={inspectorVisible && prefs.pane === 'ai'} onClick={() => changePrefs({ pane: prefs.pane === 'ai' ? 'none' : 'ai' })}><Icon name="sparkles" /><span>{t('assistant')}</span></button>
    </div>
    <div className="ex-body">
      {navigationVisible && <><aside className="ex-navigation" aria-label={t('navigation')}>
        <div className="ex-brand"><span className="ex-brand-mark"><NawaIcon size={32} /></span><span>Nawa<span className="ex-brand-caption">Workspace</span></span></div>
        <nav className="ex-quick-nav" aria-label="Quick access">{(['home', 'recent', 'starred'] as const).map(kind => <button className={`ex-nav-item${location.kind === kind && !editorActive ? ' is-current' : ''}`} key={kind} aria-current={location.kind === kind && !editorActive ? 'page' : undefined} onClick={() => navigate({ kind })}><Icon name={kind === 'starred' ? 'star' : kind} size={18} /><span>{t(kind)}</span></button>)}</nav>
        <div className="ex-nav-section"><h2>{t('folders')}</h2><ToolButton icon="plus" label={t('add')} disabled={busy || rootsLoading} onClick={() => { void addRoot() }} /><ToolButton icon="minus" label={t('remove')} disabled={!currentRoot || busy} onClick={() => { if (currentRoot) beginDialog({ kind: 'remove', root: currentRoot }) }} /></div>
        {roots.length > 1 && <div className="ex-root-tabs" role="tablist" aria-label={t('rootTabs')}>{roots.map(root => <button role="tab" aria-selected={currentRoot?.path === root.path} key={root.path} title={root.path} onClick={() => { setActiveRoot(root.path); navigate({ kind: 'folder', path: root.path }) }}><FolderGlyph size={15} /><span>{root.name}</span></button>)}</div>}
        <div className="ex-tree-scroll">{rootsLoading && !roots.length ? <p className="ex-nav-help" role="status">{t('loading')}</p> : currentRoot ? <DirectoryTree root={currentRoot} revision={revision} selectedPath={editorActive && editorTab?.filePath ? editorTab.filePath : currentContext?.path ?? folder ?? undefined} get={directory} load={loadDirectory} navigate={path => navigate({ kind: 'folder', path })} openFile={openFile} onContext={(event, item, isRoot) => showItemMenu(event, item, isRoot, true)} /> : <button className="ex-add-empty" onClick={() => { void addRoot() }}><Icon name="plus" /><span>{t('rootsEmpty')}</span></button>}</div>
        <div className="ex-nav-footer"><button className="ex-nav-item" onClick={() => setSettingsOpen(true)}><Icon name="settings" /><span>{t('settings')}</span></button><div className="ex-local-badge"><span />{t('local')}</div></div>
      </aside><Splitter label={t('navigation')} value={effectiveNavWidth} min={180} max={380} onChange={navigationWidth => changePrefs({ navigationWidth })} /></>}
      <main ref={center} className="ex-center" aria-label={editorActive ? t('editor') : t('files')}>
        {editorActive ? <div className="ex-editor-placeholder" aria-hidden="true"><Icon name="open" size={28} /><span>{editorTab?.title}</span></div> : <>
          <div className="ex-content-heading"><span className="ex-heading-icon">{headerIcon}</span><div><h1 dir="auto">{title}</h1><p>{loading ? t('loading') : `${itemCount.toLocaleString(dateLocale)} ${t('items')}`}{selectedItems.length > 0 && ` · ${selectedItems.length} ${t('selected')}`}</p></div><span className="ex-toolbar-spacer" />{folder && <button className="ex-text-button" title={t('ask')} onClick={() => { changePrefs({ pane: 'ai' }) }}><Icon name="sparkles" size={15} /><span>{t('folderScope')}</span></button>}</div>
          {notice && <div className={`ex-notice${notice.error ? ' is-error' : ''}`} role={notice.error ? 'alert' : 'status'}><span>{notice.text}</span><button aria-label={t('close')} onClick={() => setNotice(null)}><Icon name="close" size={14} /></button></div>}
          {listError ? <div className="ex-empty"><Icon name="info" size={40} /><h2>{t('unavailable')}</h2><p>{listError}</p><button className="ex-primary" onClick={refresh}>{t('retry')}</button></div> : loading && !items.length ? <div className="ex-empty" role="status"><span className="ex-spinner" /><p>{t('loading')}</p></div> : !items.length ? <div className="ex-empty"><FolderGlyph size={86} /><h2>{search ? t('noResults') : !roots.length && location.kind === 'home' ? t('welcome') : t('empty')}</h2><p>{search ? t('noResultsHelp') : !roots.length && location.kind === 'home' ? t('welcomeHelp') : t('emptyHelp')}</p>{search ? <button className="ex-secondary" onClick={() => setSearch('')}>{t('clearSearch')}</button> : <div className="ex-empty-actions"><button className="ex-primary" onClick={() => { void addRoot() }}><Icon name="plus" size={16} />{t('add')}</button><button className="ex-secondary" onClick={() => { void act(() => window.aiOffice.browse()) }}>{t('openFile')}</button></div>}</div> : <FileList key={folder ?? location.kind} items={items} selected={selected} cutPaths={cutPaths} preferences={prefs} locale={dateLocale} text={t} onSelect={choose} onSelectAll={selectAll} onOpen={openItem} onContext={(event, item) => showItemMenu(event, item)} onRename={() => requestRename()} onDelete={() => requestDelete()} onSort={sort} />}
          {!folder && page.entries.length < page.total && <div className="ex-pagination"><span>{page.entries.length.toLocaleString(dateLocale)} / {page.total.toLocaleString(dateLocale)}</span><button disabled={pageLoading} onClick={() => { void loadMore() }}>{pageLoading ? t('loading') : t('loadMore')}</button></div>}
        </>}
      </main>
      {inspectorVisible && <><Splitter label={prefs.pane === 'ai' ? t('assistant') : t('details')} value={effectiveInspectorWidth} min={300} max={Math.min(560, Math.max(300, windowWidth - (navigationVisible ? prefs.navigationWidth : 0) - 380))} reverse onChange={inspectorWidth => changePrefs({ inspectorWidth })} /><aside className="ex-inspector" aria-label={prefs.pane === 'ai' ? t('assistant') : t('details')}><div className="ex-inspector-tabs" role="tablist" aria-label="Inspector"><button role="tab" aria-selected={prefs.pane === 'ai'} onClick={() => changePrefs({ pane: 'ai' })}><Icon name="sparkles" size={17} />{t('assistant')}</button><button role="tab" aria-selected={prefs.pane === 'details'} onClick={() => changePrefs({ pane: 'details' })}><Icon name="info" size={16} />{t('details')}</button><ToolButton icon="close" label={t('close')} onClick={() => changePrefs({ pane: 'none' })} /></div>
        {prefs.pane === 'details' ? detailsPane() : (folder && currentRootPath) || selectedItems.length > 0 ? <WorkspaceChat folder={folder} folderName={folder ? basename(folder) : 'Selected items'} scopePaths={selectedItems.filter(item => item.kind === 'file').map(item => item.path)} scopeDirs={selectedItems.filter(item => item.kind === 'folder').map(item => item.path)} onOpenFile={openFile} onClose={() => changePrefs({ pane: 'none' })} /> : <div className="ex-pane-empty"><span className="ex-ai-orb"><Icon name="sparkles" size={32} /></span><h2>{t('chooseFolder')}</h2><p>{t('chooseFolderHelp')}</p><button className="ex-secondary" onClick={() => { void addRoot() }}><Icon name="plus" size={15} />{t('add')}</button><div className="ex-readonly"><Icon name="check" size={13} />{t('readOnly')}</div></div>}
      </aside></>}
    </div>
    <footer className="ex-status"><span>{editorActive ? editorTab?.title : `${items.length.toLocaleString(dateLocale)} ${t('items')}`}</span>{!editorActive && selectedItems.length > 0 && <><span className="ex-status-divider" /><span>{selectedItems.length} {t('selected')}</span><span>{sizeLabel(selectedItems.filter(item => item.kind === 'file').reduce((sum, item) => sum + item.sizeBytes, 0), dateLocale)}</span></>}<span className="ex-toolbar-spacer" /><span className="ex-status-scope">{editorActive ? t('editor') : t('local')}</span><ToolButton icon="list" label={t('details')} disabled={editorActive} pressed={prefs.view === 'details'} onClick={() => changePrefs({ view: 'details' })} /><ToolButton icon="grid" label={t('tiles')} disabled={editorActive} pressed={prefs.view === 'tiles'} onClick={() => changePrefs({ view: 'tiles' })} /></footer>
    {menu && <Menu {...menu} onClose={closeMenu} />}
    {dialog && <Dialog title={dialog.kind === 'newFolder' ? t('newFolderTitle') : dialog.kind === 'rename' ? t('renameTitle') : dialog.kind === 'remove' ? t('removeTitle') : dialog.kind === 'delete' ? t('deleteTitle') : 'Names already exist'} onClose={closeDialog}>
      {dialog.kind === 'newFolder' || dialog.kind === 'rename' ? <form onSubmit={e => { e.preventDefault(); void commitDialog() }}><label className="ex-name-field">{t('nameLabel')}<input aria-label={t('nameLabel')} value={name} disabled={busy} maxLength={240} onChange={e => setName(e.target.value)} onFocus={e => { if (dialog.kind === 'rename') { const dot = name.lastIndexOf('.'); e.currentTarget.setSelectionRange(0, dialog.item.kind === 'file' && dot > 0 ? dot : name.length) } }} /></label>{dialogError && <p role="alert" className="ex-error">{dialogError}</p>}<div className="ex-dialog-actions"><button type="button" className="ex-secondary" disabled={busy} onClick={closeDialog}>{t('cancel')}</button><button type="submit" className="ex-primary" disabled={busy || !name.trim()}>{busy ? t('loading') : t('save')}</button></div></form> : <><p>{dialog.kind === 'remove' ? t('removeHelp') : dialog.kind === 'delete' ? t('deleteHelp') : 'Create unique names for conflicting items? Existing files will not be overwritten.'}</p><div className="ex-dialog-items" dir="auto">{dialog.kind === 'remove' ? dialog.root.path : dialog.kind === 'delete' ? dialog.items.map(item => item.name).join('\n') : dialog.paths.map(basename).join('\n')}</div>{dialogError && <p role="alert" className="ex-error">{dialogError}</p>}<div className="ex-dialog-actions"><button className="ex-secondary" disabled={busy} onClick={closeDialog}>{t('cancel')}</button><button className={dialog.kind === 'delete' ? 'ex-destructive' : 'ex-primary'} disabled={busy} onClick={() => { void commitDialog() }}>{busy ? t('loading') : dialog.kind === 'remove' ? t('remove') : dialog.kind === 'delete' ? t('trash') : 'Keep both'}</button></div></>}
    </Dialog>}
    {settingsOpen && <ExplorerSettings onClose={() => setSettingsOpen(false)} />}
  </div>
}
