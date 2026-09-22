const $ = (id) => document.getElementById(id)
const el = (tag, text, className) => {
  const n = document.createElement(tag)
  if (text !== undefined) n.textContent = text
  if (className) n.className = className
  return n
}
let eventStream
const editorSubscribers = new Map(),
  editorEvents = new Map()
let dialogQueue = Promise.resolve()
function connectEvents() {
  eventStream?.close()
  eventStream = new EventSource('/api/events')
  eventStream.onmessage = (event) => {
    const packet = JSON.parse(event.data)
    if (!packet.tabId) {
      notify(
        'The editor connection missed events. Preserve unsaved work, then reload the affected files.',
        true,
      )
      return
    }
    const subscriber = editorSubscribers.get(packet.tabId)
    if (subscriber) subscriber(packet)
    else {
      const waiting = editorEvents.get(packet.tabId) ?? []
      waiting.push(packet)
      if (waiting.length > 32) waiting.shift()
      editorEvents.set(packet.tabId, waiting)
    }
  }
  eventStream.onerror = () =>
    notify(
      'The local service connection was interrupted. Keep your editor tabs open while it reconnects.',
      true,
    )
}
let csrf = '',
  status = {},
  mounts = [],
  currentMount = null,
  currentFolder = '',
  entries = [],
  tabs = [],
  active = null,
  modalResolve = null
const kinds = {
  docx: 'docs',
  xlsx: 'sheets',
  xlsm: 'sheets',
  csv: 'sheets',
  pptx: 'slides',
  pdf: 'pdf',
  md: 'markdown',
  markdown: 'markdown',
  html: 'html',
  htm: 'html',
}
const extension = (name) => (name.includes('.') ? name.split('.').pop().toLowerCase() : '')
const base = (name) => name.split('/').pop()
const parentPath = (name) => (name.includes('/') ? name.slice(0, name.lastIndexOf('/')) : '')
const query = (mount, path) => `?${new URLSearchParams({ mount, path })}`
function notify(message = '', error = false) {
  $('notice').hidden = !message
  $('notice').textContent = message
  $('notice').classList.toggle('error', error)
}
async function api(route, { method = 'GET', data, raw, headers = {} } = {}) {
  const response = await fetch(route, {
    method,
    credentials: 'same-origin',
    headers: {
      ...(method !== 'GET' ? { 'X-GenOffice-CSRF': csrf } : {}),
      ...(data !== undefined ? { 'Content-Type': 'application/json' } : {}),
      ...headers,
    },
    body: data !== undefined ? JSON.stringify(data) : raw,
  })
  const result = await response.json()
  if (!response.ok) {
    const error = new Error(result.error ?? 'The request failed.')
    error.code = result.code
    throw error
  }
  return result
}
function action(fn) {
  return (...args) => Promise.resolve(fn(...args)).catch((error) => notify(error.message, true))
}
function button(text, fn, primary = false) {
  const b = el('button', text, primary ? 'primary' : '')
  b.type = 'button'
  b.addEventListener('click', action(fn))
  return b
}
function modal(title, build) {
  if (modalResolve) {
    modalResolve(null)
    modalResolve = null
    $('modal').close()
  }
  $('modal-title').textContent = title
  $('modal-body').replaceChildren()
  $('modal-actions').replaceChildren()
  $('modal-error').textContent = ''
  return new Promise((resolve) => {
    modalResolve = resolve
    const done = (value) => {
      $('modal').close()
      modalResolve = null
      resolve(value)
    }
    const submit = (label, fn, primary = true) => {
      const b = button(
        label,
        async () => {
          b.disabled = true
          $('modal-error').textContent = ''
          try {
            await fn(done)
          } catch (error) {
            $('modal-error').textContent = error.message
          } finally {
            b.disabled = false
          }
        },
        primary,
      )
      $('modal-actions').append(b)
      return b
    }
    build({ body: $('modal-body'), done, submit })
    $('modal').showModal()
    setTimeout(() => $('modal-body').querySelector('input,select,button')?.focus(), 0)
  })
}
$('modal-close').onclick = () => {
  $('modal').close()
  modalResolve?.(null)
  modalResolve = null
}
$('modal').addEventListener('cancel', () => {
  modalResolve?.(null)
  modalResolve = null
})
$('modal-form').addEventListener('submit', (e) => {
  e.preventDefault()
  $('modal-actions').querySelector('.primary')?.click()
})
function field(body, title, input) {
  input.setAttribute('aria-label', title)
  const label = el('label', undefined, 'form-field')
  label.append(el('span', title), input)
  body.append(label)
  return input
}
async function connect() {
  const token = new URLSearchParams(location.hash.slice(1)).get('token')
  if (token) {
    ;({ csrf } = await api('/api/session', { method: 'POST', data: { token } }))
    history.replaceState(null, '', location.pathname)
  } else {
    try {
      ;({ csrf } = await api('/api/session'))
    } catch {
      await modal('Connect to Nawa', ({ body, submit }) => {
        body.append(
          el(
            'p',
            'Paste the connection token from the URL printed in the Nawa console, or open that complete URL in this browser.',
          ),
        )
        const input = field(body, 'Connection token', el('input'))
        input.type = 'password'
        input.autocomplete = 'off'
        submit('Connect', async (done) => {
          ;({ csrf } = await api('/api/session', {
            method: 'POST',
            data: { token: input.value.trim() },
          }))
          done(true)
        })
      })
      if (!csrf) return
    }
  }
  status = await api('/api/status')
  if (status.mode !== 'source-only') connectEvents()
  $('connection-status').textContent = 'Connected to this computer'
  $('connection-dot').classList.add('ready')
  $('mode-note').textContent =
    status.mode === 'source-only'
      ? 'Source-editor mode. Run setup-windows.cmd and Start Nawa.cmd to use the original office editors.'
      : 'Original Nawa editors · Local Windows service'
  await refreshMounts()
}
async function refreshMounts() {
  mounts = await api('/api/mounts')
  if (!mounts.some((m) => m.id === currentMount)) {
    currentMount = mounts[0]?.id ?? null
    currentFolder = ''
  }
  renderMounts()
  await loadFolder()
  updateToolbar()
}
function renderMounts() {
  $('mounts').replaceChildren()
  for (const mount of mounts) {
    const row = el('div', undefined, `mount-row ${mount.id === currentMount ? 'selected' : ''}`)
    const open = button(`▰  ${mount.name}${mount.readOnly ? '  ◇' : ''}`, async () => {
      currentMount = mount.id
      currentFolder = ''
      activate(null)
      renderMounts()
      await loadFolder()
    })
    open.className = 'mount-button'
    open.title = mount.root
    const remove = button('×', async () => {
      if (tabs.some((t) => t.mount === mount.id))
        throw new Error('Close all tabs using this folder before unmounting it.')
      if (!confirm(`Unmount “${mount.name}”? The files will not be deleted.`)) return
      await api(`/api/mounts/${mount.id}`, { method: 'DELETE' })
      await refreshMounts()
    })
    remove.className = 'icon-button'
    remove.title = 'Unmount folder'
    row.append(open, remove)
    $('mounts').append(row)
  }
}
async function mountFolder() {
  const result = await modal('Mount a local folder', ({ body, submit }) => {
    body.append(
      el(
        'p',
        'Choose a folder on the computer running Nawa. You can open, edit, and create files anywhere inside it.',
      ),
    )
    const input = field(body, 'Windows folder path', el('input'))
    input.placeholder = 'C:\\Users\\You\\Documents'
    body.append(
      el(
        'p',
        'A mount grants access to this folder and its ordinary subfolders. Links and junctions are blocked.',
        'form-help',
      ),
    )
    submit('Cancel', (done) => done(null), false)
    if (status.nativeFolderPicker)
      submit(
        'Browse computer…',
        async (done) => {
          const mounted = await api('/api/mounts/pick', { method: 'POST', data: {} })
          if (mounted) done(mounted)
        },
        false,
      )
    submit('Mount folder', async (done) =>
      done(await api('/api/mounts', { method: 'POST', data: { path: input.value.trim() } })),
    )
  })
  if (result) {
    currentMount = result.id
    currentFolder = ''
    activate(null)
    await refreshMounts()
    notify(`Mounted ${result.root}`)
  }
}
async function loadFolder() {
  if (!currentMount) {
    entries = []
    renderFiles()
    return
  }
  entries = await api('/api/tree' + query(currentMount, currentFolder))
  renderFiles()
}
function renderFiles() {
  const mount = mounts.find((m) => m.id === currentMount)
  $('folder-title').textContent = mount
    ? base(currentFolder) || mount.name
    : 'A home for your work.'
  $('breadcrumbs').replaceChildren()
  if (mount) {
    const crumbs = [{ name: mount.name, path: '' }]
    let at = ''
    for (const part of currentFolder.split('/').filter(Boolean)) {
      at = at ? `${at}/${part}` : part
      crumbs.push({ name: part, path: at })
    }
    crumbs.forEach((crumb, i) => {
      if (i) $('breadcrumbs').append(el('span', '/'))
      $('breadcrumbs').append(
        button(crumb.name, async () => {
          currentFolder = crumb.path
          await loadFolder()
        }),
      )
    })
  }
  $('file-list').replaceChildren()
  if (!mount) {
    const empty = el('div', undefined, 'empty-state')
    empty.append(
      el('div', '▱', 'empty-icon'),
      el('h2', 'Your folders. Your files.'),
      el(
        'p',
        'Mount a directory to bring your documents into Nawa. Browse and edit in your browser, with every save written back to your computer.',
      ),
      button('Mount your first folder', mountFolder, true),
    )
    $('file-list').append(empty)
    return
  }
  const filter = $('filter').value.toLowerCase()
  const visible = entries.filter((e) => e.name.toLowerCase().includes(filter))
  const table = el('table', undefined, 'file-table')
  const head = el('thead')
  const hr = el('tr')
  ;['Name', 'Modified', 'Size', ''].forEach((t) => hr.append(el('th', t)))
  head.append(hr)
  table.append(head)
  const body = el('tbody')
  for (const entry of visible) {
    const row = el('tr', undefined, 'file-entry')
    row.tabIndex = 0
    const nameCell = el('td')
    const name = el('div', undefined, 'file-name')
    const ext = extension(entry.name)
    const kind = entry.kind === 'directory' ? 'directory' : (kinds[ext] ?? '')
    name.append(
      el(
        'span',
        entry.kind === 'directory' ? '▰' : ext.slice(0, 4).toUpperCase() || 'FILE',
        `file-icon ${kind}`,
      ),
      el('span', entry.name),
    )
    nameCell.append(name)
    row.append(
      nameCell,
      el(
        'td',
        entry.modified
          ? new Date(entry.modified).toLocaleString([], { dateStyle: 'medium', timeStyle: 'short' })
          : 'Unavailable',
        'file-meta',
      ),
      el('td', entry.kind === 'directory' ? '—' : sizeLabel(entry.size), 'file-meta'),
    )
    const tools = el('td')
    if (entry.kind === 'file') {
      const b = button('Source', (e) => {
        e.stopPropagation()
        return openFile(entry.path, true)
      })
      b.style.fontSize = '10px'
      tools.append(b)
    }
    row.append(tools)
    const run = action(async () => {
      if (entry.kind === 'blocked')
        throw new Error(
          'This is a link, junction, special file, or reserved filename and cannot be opened through this mount.',
        )
      if (entry.kind === 'directory') {
        currentFolder = entry.path
        await loadFolder()
      } else await openFile(entry.path)
    })
    row.onclick = run
    row.onkeydown = (event) => {
      if (event.key === 'Enter') run()
    }
    body.append(row)
  }
  table.append(body)
  $('file-list').append(table)
  if (!visible.length)
    $('file-list').append(
      el(
        'p',
        filter
          ? 'No matching files in this folder.'
          : 'This folder is empty. Use New to create a file or a subfolder.',
        'muted',
      ),
    )
  $('status-left').textContent =
    `${entries.length} items · ${mount.root}${currentFolder ? ' / ' + currentFolder : ''}`
}
function sizeLabel(bytes) {
  return bytes < 1024
    ? `${bytes} B`
    : bytes < 1048576
      ? `${(bytes / 1024).toFixed(1)} KB`
      : `${(bytes / 1048576).toFixed(1)} MB`
}
function activate(id) {
  active = id
  $('files-view').hidden = !!id
  for (const tab of tabs) tab.view.hidden = tab.id !== id
  renderTabs()
  updateToolbar()
}
function renderTabs() {
  $('tabs').replaceChildren()
  for (const tab of tabs) {
    const item = el('div', undefined, `tab ${tab.id === active ? 'active' : ''}`)
    item.title = tab.path
    item.append(
      el(
        'span',
        `${tab.dirty ? '● ' : ''}${base(tab.path)}${tab.source ? ' · source' : ''}`,
        'tab-label',
      ),
    )
    const close = button('×', (event) => {
      event.stopPropagation()
      return closeTab(tab)
    })
    close.className = 'icon-button'
    close.title = 'Close file'
    item.append(close)
    item.onclick = () => activate(tab.id)
    $('tabs').append(item)
  }
}
function updateToolbar() {
  const tab = tabs.find((t) => t.id === active)
  for (const id of ['save', 'save-as', 'reload', 'download']) $(id).disabled = !tab
  $('new-file').disabled = !currentMount
  if (tab) $('status-left').textContent = `${tab.dirty ? 'Unsaved changes' : 'Saved'} · ${tab.path}`
}
function updateDirty(tab, dirty) {
  tab.dirty = dirty
  renderTabs()
  updateToolbar()
}
async function openFile(relative, forceSource = false) {
  notify()
  const existing = tabs.find(
    (t) =>
      t.mount === currentMount &&
      t.path === relative &&
      t.source === (forceSource || !status.editors?.includes(kinds[extension(relative)])),
  )
  if (existing) {
    activate(existing.id)
    return
  }
  const kind = kinds[extension(relative)]
  const native = !forceSource && status.editors?.includes(kind)
  let info, text
  if (native)
    info = await api('/api/tabs', { method: 'POST', data: { mount: currentMount, path: relative } })
  else text = await api('/api/text' + query(currentMount, relative))
  const tab = {
    id: info?.id ?? crypto.randomUUID(),
    mount: currentMount,
    path: relative,
    source: !native,
    dirty: false,
    view: el('div', undefined, 'editor-view'),
    text,
  }
  if (native) {
    const frame = document.createElement('iframe')
    frame.title = `Nawa ${kind}: ${base(relative)}`
    frame.src = info.url
    // The original HTML editor has its own opaque sandbox for authored HTML.
    frame.allow = 'clipboard-read; clipboard-write'
    tab.frame = frame
    tab.view.append(frame)
    frame.addEventListener('load', () => {
      if (tab.frame.contentDocument?.title?.includes('Error'))
        notify('The editor did not load. Rebuild the browser assets.', true)
    })
  } else {
    const meta = el('div', undefined, 'source-meta')
    meta.append(
      el('span', 'SOURCE EDITOR'),
      el('span', text.bom ? 'UTF-8 with BOM' : 'UTF-8'),
      el(
        'span',
        text.eol === 'crlf'
          ? 'Windows CRLF'
          : text.eol === 'mixed'
            ? 'Mixed line endings → LF when saved'
            : 'LF',
      ),
    )
    const textarea = el('textarea', undefined, 'source-editor')
    textarea.spellcheck = false
    textarea.wrap = 'off'
    textarea.value = text.text
    textarea.setAttribute('aria-label', `Edit ${base(relative)}`)
    tab.initialValue = textarea.value
    tab.textarea = textarea
    textarea.oninput = () => updateDirty(tab, textarea.value !== tab.initialValue)
    textarea.onkeydown = (event) => {
      if (event.key === 'Tab') {
        event.preventDefault()
        textarea.setRangeText('  ', textarea.selectionStart, textarea.selectionEnd, 'end')
        textarea.dispatchEvent(new Event('input'))
      }
    }
    tab.view.append(meta, textarea)
  }
  tabs.push(tab)
  $('views').append(tab.view)
  activate(tab.id)
}
async function closeTab(tab, discard = false) {
  if (
    !discard &&
    isDirty(tab) &&
    !confirm(`Close “${base(tab.path)}” and discard unsaved changes?`)
  )
    return false
  if (!tab.source) await api(`/api/tabs/${tab.id}`, { method: 'DELETE' })
  tab.view.remove()
  editorSubscribers.delete(tab.id)
  editorEvents.delete(tab.id)
  tabs = tabs.filter((t) => t !== tab)
  activate(active === tab.id ? (tabs.at(-1)?.id ?? null) : active)
  return true
}
function isDirty(tab) {
  return tab.source
    ? tab.dirty
    : (tab.frame?.contentWindow?.genofficeBridge?.isDirty?.() ?? tab.dirty)
}
async function saveTab(as = false) {
  const tab = tabs.find((t) => t.id === active)
  if (!tab) return
  if (!tab.source) {
    await api(`/api/tabs/${tab.id}/command`, {
      method: 'POST',
      data: { command: as ? 'saveAs' : 'save' },
    })
    return
  }
  let target = tab.path
  if (as) {
    const picked = await pickFile(tab, {
      kind: 'save',
      title: 'Save As',
      defaultName: base(tab.path),
    })
    if (!picked) return
    target = picked.path
  }
  const savedValue = tab.textarea.value
  let value = savedValue
  if (tab.text.eol === 'crlf') value = value.replace(/\r?\n/g, '\r\n')
  if (tab.text.bom) value = '\ufeff' + value
  const result = await api('/api/file' + query(tab.mount, target), {
    method: 'PUT',
    raw: new TextEncoder().encode(value),
    headers: as ? { 'If-None-Match': '*' } : { 'If-Match': `"${tab.text.revision}"` },
  })
  tab.path = target
  tab.text.revision = result.revision
  tab.initialValue = savedValue
  updateDirty(tab, tab.textarea.value !== savedValue)
  notify(`Saved ${target}`)
  await loadFolder()
}
async function reloadTab() {
  const tab = tabs.find((t) => t.id === active)
  if (!tab) return
  if (isDirty(tab) && !confirm('Reload from disk and discard your unsaved changes?')) return
  const { mount, path, source } = tab
  await closeTab(tab, true)
  currentMount = mount
  await openFile(path, source)
}
async function downloadTab() {
  const tab = tabs.find((t) => t.id === active)
  if (!tab) return
  const a = document.createElement('a')
  a.href = '/api/file' + query(tab.mount, tab.path)
  a.download = base(tab.path)
  a.click()
  notify('Downloaded the last saved version. Unsaved changes are not included.')
}
async function newFile() {
  if (!currentMount) return mountFolder()
  const result = await modal('Create in this folder', ({ body, submit }) => {
    const select = el('select')
    const types = [
      ['directory', 'Folder'],
      ['txt', 'Text file'],
      ['md', 'Markdown document'],
      ['html', 'HTML document'],
      ['csv', 'CSV file'],
      ['json', 'JSON file'],
    ]
    types.splice(
      1,
      0,
      ...[
        ['docx', 'Word document'],
        ['xlsx', 'Excel workbook'],
        ['pptx', 'PowerPoint presentation'],
        ['pdf', 'PDF document'],
      ].filter(([ext]) => status.editors?.includes(kinds[ext])),
    )
    for (const [value, title] of types) {
      const option = el('option', title)
      option.value = value
      select.append(option)
    }
    select.value = status.mode === 'source-only' ? 'txt' : 'docx'
    field(body, 'File type', select)
    const name = field(body, 'Name', el('input'))
    name.value = `Untitled.${select.value}`
    select.onchange = () => {
      name.value = select.value === 'directory' ? 'New folder' : `Untitled.${select.value}`
    }
    body.append(
      el(
        'p',
        `Location: ${mounts.find((m) => m.id === currentMount)?.name} / ${currentFolder || '(root)'}`,
        'form-help',
      ),
    )
    submit('Cancel', (done) => done(null), false)
    submit('Create', async (done) => {
      if (!name.value || /[/\\]/.test(name.value))
        throw new Error('Enter a filename, without directory separators.')
      if (select.value !== 'directory' && !name.value.toLowerCase().endsWith(`.${select.value}`))
        throw new Error(`The filename must end with .${select.value}.`)
      const relative = currentFolder ? `${currentFolder}/${name.value}` : name.value
      await api('/api/files', {
        method: 'POST',
        data: {
          mount: currentMount,
          path: relative,
          kind: select.value === 'directory' ? 'directory' : 'file',
        },
      })
      done({ path: relative, directory: select.value === 'directory' })
    })
  })
  if (result) {
    await loadFolder()
    if (!result.directory) await openFile(result.path)
  }
}
async function pickFile(tab, request) {
  return modal(
    request.title || (request.kind === 'save' ? 'Save As' : 'Choose a file'),
    ({ body, done, submit }) => {
      let folder = parentPath(tab.path),
        selected = null
      const bar = el('div', undefined, 'picker-path')
      const where = el('span')
      const up = button('↑ Up', async () => {
        folder = parentPath(folder)
        await show()
      })
      bar.append(up, where)
      const list = el('div', undefined, 'picker-list')
      body.append(bar, list)
      const input =
        request.kind === 'save'
          ? field(body, 'Filename (a new file; existing files are not overwritten)', el('input'))
          : null
      if (input) input.value = request.defaultName || base(tab.path)
      const folderOnly =
        request.directoryOnly === true || request.properties?.includes('openDirectory')
      async function show() {
        selected = null
        where.textContent = `${mounts.find((m) => m.id === tab.mount)?.name ?? 'Folder'} / ${folder || '(root)'}`
        up.disabled = !folder
        const files = await api('/api/tree' + query(tab.mount, folder))
        list.replaceChildren()
        for (const file of files.filter(
          (f) => f.kind !== 'blocked' && (!folderOnly || f.kind === 'directory'),
        )) {
          const row = el(
            'div',
            `${file.kind === 'directory' ? '▰' : '▤'}  ${file.name}`,
            'picker-entry',
          )
          row.tabIndex = 0
          row.onclick = action(async () => {
            if (file.kind === 'directory') {
              folder = file.path
              await show()
            } else {
              selected = file.path
              for (const child of list.children) child.classList.remove('selected')
              row.classList.add('selected')
              if (input) input.value = file.name
            }
          })
          row.ondblclick = () => {
            if (file.kind === 'file' && !input) done({ path: file.path })
          }
          list.append(row)
        }
      }
      submit('Cancel', (finish) => finish(null), false)
      submit(request.kind === 'save' ? 'Save' : folderOnly ? 'Choose folder' : 'Open', (finish) => {
        if (input) {
          if (!input.value || /[/\\]/.test(input.value))
            throw new Error('Enter a filename, without directory separators.')
          finish({ path: folder ? `${folder}/${input.value}` : input.value })
        } else if (folderOnly) finish({ path: folder })
        else {
          if (!selected) throw new Error('Select a file.')
          finish({ path: selected })
        }
      })
      show().catch((error) => {
        $('modal-error').textContent = error.message
      })
    },
  )
}
window.genofficeWorkspace = {
  subscribe(tabId, callback) {
    editorSubscribers.set(tabId, callback)
    for (const packet of editorEvents.get(tabId) ?? []) callback(packet)
    editorEvents.delete(tabId)
    return () => editorSubscribers.delete(tabId)
  },
  dialog(tabId, request) {
    const run = () => this.showDialog(tabId, request)
    const result = dialogQueue.then(run, run)
    dialogQueue = result.catch(() => {})
    return result
  },
  async showDialog(tabId, request) {
    const tab = tabs.find((t) => t.id === tabId)
    if (!tab) return null
    if (request.kind !== 'message') return pickFile(tab, request)
    return modal(request.title || 'Nawa', ({ body, submit }) => {
      body.append(el('p', request.message), el('p', request.detail || ''))
      ;(request.buttons || ['OK']).forEach((label, index) =>
        submit(
          label.replace(/&/g, ''),
          (done) => done({ response: index }),
          index === (request.defaultId ?? 0),
        ),
      )
    })
  },
  notify,
}
window.addEventListener('message', (event) => {
  if (event.origin !== location.origin || event.data?.source !== 'genoffice-browser') return
  const tab = tabs.find((t) => t.frame?.contentWindow === event.source && t.id === event.data.tabId)
  if (!tab) return
  if (event.data.type === 'dirty') updateDirty(tab, event.data.dirty === true)
  if (event.data.type === 'opened' && event.data.path) {
    tab.path = event.data.path
    renderTabs()
    updateToolbar()
  }
  if (event.data.type === 'copied') {
    notify(`Saved copy ${event.data.path}. The original remains open with its pending edits.`)
    void loadFolder().catch((error) => notify(error.message, true))
  }
  if (event.data.type === 'saved') {
    if (event.data.path) tab.path = event.data.path
    updateDirty(tab, false)
    notify(`Saved ${tab.path}`)
    void loadFolder().catch((error) => notify(error.message, true))
  }
  if (event.data.type === 'error') notify(event.data.message, true)
})
window.addEventListener('beforeunload', (event) => {
  if (tabs.some(isDirty)) {
    event.preventDefault()
    event.returnValue = ''
  }
})
window.addEventListener('keydown', (event) => {
  if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 's') {
    event.preventDefault()
    action(() => saveTab(event.shiftKey))()
  }
})
$('mount-top').onclick = action(mountFolder)
$('refresh').onclick = action(refreshMounts)
$('home').onclick = () => {
  activate(null)
  action(loadFolder)()
}
$('new-file').onclick = action(newFile)
$('save').onclick = action(() => saveTab())
$('save-as').onclick = action(() => saveTab(true))
$('reload').onclick = action(reloadTab)
$('download').onclick = action(downloadTab)
$('filter').oninput = renderFiles
updateToolbar()
action(connect)()
