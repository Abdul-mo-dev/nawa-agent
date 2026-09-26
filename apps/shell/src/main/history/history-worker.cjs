'use strict'
/* Pure Node worker: SQLite and SHA-256 work never run on Electron's UI/main thread.
 * Also require-able by the regression tests; no Electron dependency or network I/O. */
const { isMainThread, parentPort, workerData } = require('node:worker_threads')
const { randomUUID, createHash } = require('node:crypto')
const { constants } = require('node:fs')
const fs = require('node:fs/promises')
const path = require('node:path')

const LIMITS = Object.freeze({
  entries: 20000, fileBytes: 256 * 1024 * 1024, totalBytes: 1024 * 1024 * 1024,
  durationMs: 30000, depth: 64, messages: 10000, transcriptChars: 8 * 1024 * 1024,
})
function string(value, name, max = 4096, empty = false) {
  if (typeof value !== 'string' || (!empty && !value.trim()) || value.length > max || value.includes('\0')) {
    throw new Error(`Invalid ${name}.`)
  }
  return value
}
function key(value) {
  const windows = /^[a-z]:[\\/]/i.test(value) || value.startsWith('\\\\') || value.startsWith('//')
  let result = (windows ? path.win32.normalize(value) : path.posix.normalize(value)).replace(/\\/g, '/')
  result = result.replace(/\/+$/, '') || '/'
  return windows ? result.toLowerCase() : result
}
function contains(root, target) {
  const a = key(root), b = key(target)
  return a === b || b.startsWith(a === '/' ? a : `${a}/`)
}
function absolute(value) {
  string(value, 'path')
  if (!path.isAbsolute(value) || value.replace(/\\/g, '/').split('/').some(x => x === '..' || x === '.')) {
    throw new Error('History fingerprints require absolute, non-traversing paths.')
  }
  return path.resolve(value)
}
function folderValue(value) { return value == null ? null : absolute(value) }
function workspaceKey(folder) { return folder ? key(folder) : 'nawa-main-selection' }
function sha(value) { return createHash('sha256').update(value).digest('hex') }
function errorText(error) { return error instanceof Error ? error.message : String(error) }
function normalizeScope(input) {
  if (!input || typeof input !== 'object') throw new Error('Invalid snapshot scope.')
  const unique = values => {
    if (!Array.isArray(values) || values.length > 512) throw new Error('Select no more than 512 items.')
    return [...new Map(values.map(value => { const p = absolute(value); return [key(p), p] })).values()]
  }
  return { opened: folderValue(input.opened), files: unique(input.files), directories: unique(input.directories) }
}
function normalizeMessages(input, legacy = false) {
  if (!Array.isArray(input) || input.length > LIMITS.messages) throw new Error('Conversation message limit exceeded.')
  let chars = 0
  const seen = new Set()
  const result = []
  for (const item of input) {
    if (!item || (item.role !== 'user' && item.role !== 'assistant') || typeof item.text !== 'string') {
      if (legacy) continue
      throw new Error('Invalid conversation message.')
    }
    chars += item.text.length
    if (chars > LIMITS.transcriptChars) throw new Error('Conversation exceeds the 8 Mi-character storage limit. Start a new chat.')
    const id = legacy ? randomUUID() : string(item.id, 'message ID', 100)
    if (seen.has(id)) throw new Error('Duplicate message ID.')
    seen.add(id)
    result.push({
      id, role: item.role, text: item.text,
      createdAt: Number.isFinite(item.createdAt) ? Math.max(0, Math.min(item.createdAt, Date.now() + 60000)) : Date.now(),
      streaming: Boolean(item.streaming), error: Boolean(item.error),
      contextKey: typeof item.contextKey === 'string' ? string(item.contextKey, 'context key', 1024 * 1024, true) : '',
      modelLabel: typeof item.modelLabel === 'string' ? string(item.modelLabel, 'model label', 1000, true) : '',
      snapshotHash: !legacy && /^[0-9a-f]{64}$/.test(item.snapshotHash || '') ? item.snapshotHash : '',
    })
  }
  return result
}

class HistoryStore {
  constructor(databasePath) {
    let DatabaseSync
    try { ({ DatabaseSync } = require('node:sqlite')) } catch {
      throw new Error('Nawa history needs an Electron runtime with node:sqlite. Use the repository\'s Electron version, then rebuild the shell.')
    }
    this.databasePath = databasePath
    this.db = new DatabaseSync(databasePath)
    const version = this.db.prepare('PRAGMA user_version').get().user_version
    if (version > 1) { this.db.close(); throw new Error('This history database was created by a newer Nawa version. It was not modified.') }
    this.db.exec('PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000; PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL;')
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS conversations (
        id TEXT PRIMARY KEY, workspace_key TEXT NOT NULL, folder TEXT, folder_name TEXT NOT NULL,
        title TEXT NOT NULL, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL,
        revision INTEGER NOT NULL DEFAULT 0, draft TEXT NOT NULL DEFAULT '', model_id TEXT NOT NULL DEFAULT '',
        baseline_id TEXT, last_chat_at INTEGER, deleted_at INTEGER
      ) STRICT;
      CREATE INDEX IF NOT EXISTS conversations_workspace_updated ON conversations(workspace_key, updated_at DESC);
      CREATE TABLE IF NOT EXISTS messages (
        conversation_id TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
        id TEXT NOT NULL, ordinal INTEGER NOT NULL, role TEXT NOT NULL CHECK(role IN ('user','assistant')),
        text TEXT NOT NULL, created_at INTEGER NOT NULL, streaming INTEGER NOT NULL, error INTEGER NOT NULL,
        context_key TEXT NOT NULL, model_label TEXT NOT NULL, snapshot_hash TEXT NOT NULL,
        PRIMARY KEY(conversation_id, id), UNIQUE(conversation_id, ordinal)
      ) STRICT;
      CREATE TABLE IF NOT EXISTS snapshots (
        id TEXT PRIMARY KEY, conversation_id TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
        started_at INTEGER NOT NULL, finished_at INTEGER NOT NULL, scope_json TEXT NOT NULL,
        tree_hash TEXT, complete INTEGER NOT NULL, file_count INTEGER NOT NULL, directory_count INTEGER NOT NULL,
        bytes_hashed INTEGER NOT NULL, issues_json TEXT NOT NULL
      ) STRICT;
      CREATE INDEX IF NOT EXISTS snapshots_conversation ON snapshots(conversation_id, started_at DESC);
      CREATE TABLE IF NOT EXISTS snapshot_entries (
        snapshot_id TEXT NOT NULL REFERENCES snapshots(id) ON DELETE CASCADE,
        path_key TEXT NOT NULL, path TEXT NOT NULL, kind TEXT NOT NULL, hash TEXT,
        status TEXT NOT NULL, size INTEGER, mtime_ms REAL,
        PRIMARY KEY(snapshot_id, path_key)
      ) STRICT;
      CREATE TABLE IF NOT EXISTS legacy_imports (
        source_key TEXT PRIMARY KEY, conversation_id TEXT NOT NULL, imported_at INTEGER NOT NULL
      ) STRICT;
      PRAGMA user_version=1;
    `)
  }
  transaction(callback) {
    const outer = !this.transactionDepth
    const name = `history_tx_${this.transactionDepth || 0}`
    this.transactionDepth = (this.transactionDepth || 0) + 1
    this.db.exec(outer ? 'BEGIN IMMEDIATE' : `SAVEPOINT ${name}`)
    try {
      const result = callback()
      this.db.exec(outer ? 'COMMIT' : `RELEASE SAVEPOINT ${name}`)
      return result
    } catch (error) {
      this.db.exec(outer ? 'ROLLBACK' : `ROLLBACK TO SAVEPOINT ${name}; RELEASE SAVEPOINT ${name}`)
      throw error
    } finally { this.transactionDepth-- }
  }
  row(id) {
    string(id, 'conversation ID', 100)
    const row = this.db.prepare('SELECT * FROM conversations WHERE id=? AND deleted_at IS NULL').get(id)
    if (!row) throw new Error('Conversation no longer exists. Choose another chat from History.')
    return row
  }
  summary(row) {
    return { id: row.id, folder: row.folder, folderName: row.folder_name, title: row.title,
      createdAt: row.created_at, updatedAt: row.updated_at, modelId: row.model_id,
      messageCount: Number(row.message_count ?? this.db.prepare('SELECT count(*) AS n FROM messages WHERE conversation_id=?').get(row.id).n) }
  }
  get(id) {
    const row = this.row(id)
    const messages = this.db.prepare('SELECT * FROM messages WHERE conversation_id=? ORDER BY ordinal').all(id).map(message => ({
      id: message.id, role: message.role, text: message.text || (message.streaming ? 'Interrupted before the response finished.' : ''),
      createdAt: message.created_at, streaming: false, error: Boolean(message.error || message.streaming),
      contextKey: message.context_key, modelLabel: message.model_label, snapshotHash: message.snapshot_hash || undefined,
    }))
    return { ...this.summary(row), revision: row.revision, draft: row.draft, messages,
      baselineId: row.baseline_id, lastChatAt: row.last_chat_at }
  }
  list(input = {}) {
    const filters = ['c.deleted_at IS NULL'], args = []
    if (Object.hasOwn(input, 'folder')) { filters.push('c.workspace_key=?'); args.push(workspaceKey(folderValue(input.folder))) }
    const query = string(input.query ?? '', 'search', 200, true).trim()
    if (query) { filters.push("c.title LIKE ? ESCAPE '\\'"); args.push(`%${query.replace(/[\\%_]/g, '\\$&')}%`) }
    const offset = Number.isInteger(input.offset) && input.offset >= 0 ? Math.min(input.offset, 1000000) : 0
    const where = filters.join(' AND ')
    const total = Number(this.db.prepare(`SELECT count(*) AS n FROM conversations c WHERE ${where}`).get(...args).n)
    const rows = this.db.prepare(`SELECT c.*, (SELECT count(*) FROM messages m WHERE m.conversation_id=c.id) AS message_count
      FROM conversations c WHERE ${where} ORDER BY c.updated_at DESC, c.id DESC LIMIT 50 OFFSET ?`).all(...args, offset)
    return { conversations: rows.map(row => this.summary(row)), total }
  }
  create(input) {
    const folder = folderValue(input.folder), id = randomUUID(), now = Date.now()
    const name = string(input.folderName || (folder ? path.basename(folder) : 'Workspace'), 'folder name', 500)
    const model = string(input.modelId ?? '', 'model', 200, true)
    this.db.prepare(`INSERT INTO conversations(id,workspace_key,folder,folder_name,title,created_at,updated_at,model_id)
      VALUES(?,?,?,?,?,?,?,?)`).run(id, workspaceKey(folder), folder, name, 'New conversation', now, now, model)
    return this.get(id)
  }
  save(input) {
    const messages = normalizeMessages(input.messages)
    const draft = string(input.draft, 'draft', 1024 * 1024, true), model = string(input.modelId, 'model', 200, true)
    if (!Number.isInteger(input.revision) || input.revision < 0) throw new Error('Invalid conversation revision.')
    return this.transaction(() => {
      const row = this.row(input.id)
      if (row.revision !== input.revision) throw new Error('This chat was changed in another window. Your unsaved text is still here; reopen History before editing further.')
      const baselineId = input.baselineId == null ? null : string(input.baselineId, 'snapshot ID', 100)
      if (baselineId && !this.db.prepare('SELECT 1 FROM snapshots WHERE id=? AND conversation_id=?').get(baselineId, row.id)) {
        throw new Error('The requested fingerprint does not belong to this conversation.')
      }
      const lastChatAt = Number.isFinite(input.lastChatAt) ? input.lastChatAt : row.last_chat_at
      const now = Date.now()
      const first = messages.find(message => message.role === 'user' && message.text.trim())
      const title = row.title === 'New conversation' && first ? first.text.trim().replace(/\s+/g, ' ').slice(0, 100) : row.title
      this.db.prepare(`UPDATE conversations SET draft=?,model_id=?,title=?,updated_at=?,revision=revision+1,
        baseline_id=?,last_chat_at=? WHERE id=?`).run(draft, model, title, now, baselineId, lastChatAt, row.id)
      this.db.prepare('DELETE FROM messages WHERE conversation_id=?').run(row.id)
      const insert = this.db.prepare(`INSERT INTO messages VALUES(?,?,?,?,?,?,?,?,?,?,?)`)
      messages.forEach((message, ordinal) => insert.run(row.id, message.id, ordinal, message.role, message.text,
        message.createdAt, Number(message.streaming), Number(message.error), message.contextKey, message.modelLabel, message.snapshotHash))
      // Keep the baseline plus recent pending captures; drafts never silently replace the baseline.
      this.db.prepare(`DELETE FROM snapshots WHERE conversation_id=? AND id<>coalesce(?, '') AND id NOT IN
        (SELECT id FROM snapshots WHERE conversation_id=? ORDER BY started_at DESC LIMIT 4)`).run(row.id, baselineId, row.id)
      return { revision: row.revision + 1, updatedAt: now, title }
    })
  }
  rename(id, title) {
    const row = this.row(id)
    title = string(title, 'conversation title', 200).trim()
    this.db.prepare('UPDATE conversations SET title=?,updated_at=?,revision=revision+1 WHERE id=?').run(title, Date.now(), row.id)
  }
  delete(id) {
    this.transaction(() => {
      this.row(id)
      this.db.prepare('DELETE FROM messages WHERE conversation_id=?').run(id)
      this.db.prepare('DELETE FROM snapshots WHERE conversation_id=?').run(id)
      // Tombstone prevents queued autosaves and legacy imports from recreating deleted chats.
      this.db.prepare(`UPDATE conversations SET deleted_at=?, title='Deleted conversation',draft='',model_id='',
        folder=NULL,folder_name='',workspace_key='',baseline_id=NULL,revision=revision+1 WHERE id=?`).run(Date.now(), id)
    })
  }
  importLegacy(entries) {
    if (entries == null) return 0
    if (!Array.isArray(entries) || entries.length > 500) throw new Error('Legacy import batch is too large.')
    let imported = 0
    for (const entry of entries) {
      string(entry.key, 'legacy key')
      if (this.db.prepare('SELECT 1 FROM legacy_imports WHERE source_key=?').get(entry.key)) continue
      const messages = normalizeMessages(entry.messages, true)
      const draft = string(entry.draft ?? '', 'legacy draft', 1024 * 1024, true)
      if (!messages.length && !draft) continue
      this.transaction(() => {
        if (this.db.prepare('SELECT 1 FROM legacy_imports WHERE source_key=?').get(entry.key)) return
        const record = this.create(entry)
        this.save({ id: record.id, revision: 0, messages, draft, modelId: record.modelId, baselineId: null, lastChatAt: null })
        this.db.prepare('INSERT INTO legacy_imports VALUES(?,?,?)').run(entry.key, record.id, Date.now())
        imported++
      })
    }
    return imported
  }
  saveSnapshot(id, scan) {
    this.row(id)
    const snapshotId = randomUUID()
    this.transaction(() => {
      this.db.prepare('INSERT INTO snapshots VALUES(?,?,?,?,?,?,?,?,?,?,?)').run(snapshotId, id, scan.startedAt,
        scan.finishedAt, JSON.stringify(scan.scope), scan.hash, Number(scan.complete), scan.fileCount,
        scan.directoryCount, scan.bytesHashed, JSON.stringify(scan.issues))
      const insert = this.db.prepare('INSERT INTO snapshot_entries VALUES(?,?,?,?,?,?,?,?)')
      for (const entry of scan.entries) insert.run(snapshotId, key(entry.path), entry.path, entry.kind,
        entry.hash, entry.status, entry.size ?? null, entry.mtimeMs ?? null)
    })
    return { id: snapshotId, hash: scan.hash, complete: scan.complete, startedAt: scan.startedAt,
      finishedAt: scan.finishedAt, fileCount: scan.fileCount, directoryCount: scan.directoryCount,
      bytesHashed: scan.bytesHashed, issues: scan.issues }
  }
  baseline(id) {
    const row = this.row(id)
    if (!row.baseline_id) return null
    const saved = this.db.prepare('SELECT * FROM snapshots WHERE id=? AND conversation_id=?').get(row.baseline_id, id)
    if (!saved) return null
    return { scope: JSON.parse(saved.scope_json), hash: saved.tree_hash, complete: Boolean(saved.complete),
      startedAt: saved.started_at, since: row.last_chat_at || saved.started_at,
      issues: JSON.parse(saved.issues_json), entries: this.db.prepare('SELECT path,kind,hash,status,size,mtime_ms AS mtimeMs FROM snapshot_entries WHERE snapshot_id=?').all(saved.id) }
  }
  close() { this.db.exec('PRAGMA wal_checkpoint(TRUNCATE)'); this.db.close() }
}

/** Full content hashing, never an mtime-only cache. Unverified is not unchanged. */
async function fingerprint(input, roots, options = {}) {
  const scope = normalizeScope(input), limits = { ...LIMITS, ...options.limits }
  const startedAt = Date.now(), issues = [], entries = [], visited = new Set()
  let bytesHashed = 0, fileCount = 0, directoryCount = 0, incomplete = false
  const signal = options.signal
  const problem = text => { incomplete = true; if (issues.length < 100) issues.push(text) }
  const guard = () => {
    if (signal?.aborted) throw new Error('Fingerprint check cancelled.')
    if (Date.now() - startedAt > limits.durationMs) throw new Error('Fingerprint time limit reached.')
  }
  const authorizedRoots = []
  for (const value of roots) {
    try {
      const root = absolute(value)
      if (key(await fs.realpath(root)) === key(root) && (await fs.lstat(root)).isDirectory()) authorizedRoots.push(root)
    } catch { /* Unavailable/detached roots do not authorize hashing. */ }
  }
  const authorize = async file => {
    const root = authorizedRoots.find(root => contains(root, file))
    if (!root) throw new Error('Folder is unavailable or no longer attached to the workspace.')
    if (key(await fs.realpath(root)) !== key(root)) throw new Error('Workspace root has changed or become a link.')
    if (key(await fs.realpath(file)) !== key(file)) throw new Error('Linked paths are not followed.')
    return root
  }
  const rootList = [...(scope.opened ? [scope.opened] : []), ...scope.directories, ...scope.files]
  const uniqueRoots = [...new Map(rootList.map(root => [key(root), root])).values()]
    .filter(root => !rootList.some(other => key(root) !== key(other) && contains(other, root) && !scope.files.includes(other)))
    .sort((a, b) => key(a) < key(b) ? -1 : 1)
  const statSignature = stat => [stat.dev, stat.ino, stat.size, stat.mtimeNs ?? stat.mtimeMs, stat.ctimeNs ?? stat.ctimeMs].map(String).join(':')
  const walk = async (file, depth) => {
    guard()
    const fileKey = key(file)
    if (visited.has(fileKey)) return null
    if (entries.length >= limits.entries) { problem('Entry limit reached; some paths were not checked.'); return null }
    visited.add(fileKey)
    const entry = { path: file, kind: 'unknown', hash: null, status: 'unverified', size: null, mtimeMs: null }
    entries.push(entry)
    if (options.excludeDirectory && contains(options.excludeDirectory, file)) {
      problem('The Nawa history database directory is excluded from its own fingerprints.'); return entry
    }
    const root = authorizedRoots.find(root => contains(root, file))
    if (!root) { problem(`${file}: unavailable or detached workspace root.`); return entry }
    let before
    try {
      before = await fs.lstat(file, { bigint: true })
      entry.kind = before.isDirectory() ? 'directory' : before.isFile() ? 'file' : 'link-or-special'
      if (before.isSymbolicLink() || (!before.isDirectory() && !before.isFile())) {
        problem(`${file}: links and special files are not followed.`); return entry
      }
      await authorize(file)
      entry.size = Number(before.size); entry.mtimeMs = Number(before.mtimeMs)
      if (before.isDirectory()) {
        directoryCount++
        if (depth >= limits.depth) { problem(`${file}: directory depth limit reached.`); return entry }
        const names = [], directory = await fs.opendir(file)
        for await (const child of directory) {
          guard()
          if (names.length + entries.length >= limits.entries) { problem(`${file}: entry limit reached.`); break }
          names.push(child.name)
        }
        names.sort()
        const children = []
        for (const name of names) {
          const child = await walk(path.join(file, name), depth + 1)
          if (child) children.push(child)
          if (entries.length >= limits.entries) { problem(`${file}: entry limit reached.`); break }
        }
        await authorize(file)
        const after = await fs.lstat(file, { bigint: true })
        if (statSignature(before) !== statSignature(after)) {
          problem(`${file}: directory changed while it was being scanned.`); return entry
        }
        if (children.every(child => child.status === 'ok')) {
          entry.hash = sha(JSON.stringify(children.map(child => [path.basename(child.path), child.kind, child.hash])))
          entry.status = 'ok'
        }
        return entry
      }
      fileCount++
      if (before.nlink > 1n) { problem(`${file}: hard-linked files are not hashed.`); return entry }
      if (Number(before.size) > limits.fileBytes || bytesHashed + Number(before.size) > limits.totalBytes) {
        problem(`${file}: fingerprint byte limit reached.`); return entry
      }
      const handle = await fs.open(file, constants.O_RDONLY | (constants.O_NOFOLLOW || 0))
      try {
        const opened = await handle.stat({ bigint: true })
        if (statSignature(before) !== statSignature(opened)) throw new Error('File changed before hashing.')
        const hash = createHash('sha256'), buffer = Buffer.allocUnsafe(256 * 1024)
        let count = 0
        while (true) {
          guard()
          const { bytesRead } = await handle.read(buffer, 0, buffer.length, null)
          if (!bytesRead) break
          bytesHashed += bytesRead; count += bytesRead
          if (bytesHashed > limits.totalBytes || count > limits.fileBytes) throw new Error('Fingerprint byte limit reached.')
          hash.update(buffer.subarray(0, bytesRead))
        }
        const after = await handle.stat({ bigint: true })
        const named = await fs.lstat(file, { bigint: true })
        await authorize(file)
        if (statSignature(before) !== statSignature(after) || statSignature(before) !== statSignature(named) || BigInt(count) !== before.size) {
          throw new Error('File changed while it was being hashed.')
        }
        entry.hash = hash.digest('hex'); entry.status = 'ok'
      } finally { await handle.close() }
    } catch (error) {
      if (signal?.aborted) throw error
      if (error?.code === 'ENOENT' && key(file) !== key(root)) {
        // Missing beneath an available registered root is a verifiable deletion.
        entry.status = 'missing'; entry.kind = before?.isDirectory() ? 'directory' : 'file'
      } else problem(`${file}: ${errorText(error)}`)
    }
    return entry
  }
  for (const root of uniqueRoots) {
    try { await walk(root, 0) }
    catch (error) {
      if (signal?.aborted) throw error
      problem(errorText(error)); break
    }
  }
  // Revalidate authority after the walk. This also prevents an offline root from appearing unchanged.
  for (const root of authorizedRoots) {
    if (!uniqueRoots.some(item => contains(root, item))) continue
    try { if (key(await fs.realpath(root)) !== key(root)) problem(`${root}: workspace root changed during scan.`) }
    catch { problem(`${root}: workspace root became unavailable during scan.`) }
  }
  const complete = !incomplete && entries.every(entry => entry.status === 'ok' || entry.status === 'missing')
  const hash = complete ? sha(JSON.stringify(entries.map(entry => [key(entry.path), entry.kind, entry.hash, entry.status])
    .sort((a, b) => a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0))) : null
  return { scope, entries, hash, complete, startedAt, finishedAt: Date.now(), fileCount, directoryCount, bytesHashed, issues }
}

function compareSnapshots(before, after) {
  const result = { status: 'unchanged', since: before.since ?? before.startedAt, checkedAt: after.finishedAt,
    added: 0, removed: 0, modified: 0, unverified: 0, changes: [], issues: [...(before.issues || []), ...after.issues].slice(0, 100),
    complete: before.complete && after.complete, truncated: false }
  const add = (kind, entry) => {
    result[kind]++
    if (result.changes.length < 100) result.changes.push({ kind, path: entry.path, entryType: entry.kind })
    else result.truncated = true
  }
  const old = new Map(before.entries.map(entry => [key(entry.path), entry]))
  const current = new Map(after.entries.map(entry => [key(entry.path), entry]))
  for (const [p, entry] of old) {
    const now = current.get(p)
    if (entry.status === 'missing') {
      if (now?.status === 'ok') add('added', now)
      else if (!now || now.status === 'unverified') add('unverified', now || entry)
    } else if (!now || now.status === 'missing') {
      add(after.complete ? 'removed' : 'unverified', entry)
    } else if (entry.status !== 'ok' || now.status !== 'ok') add('unverified', now)
    else if (entry.kind !== now.kind || (now.kind !== 'directory' && entry.hash !== now.hash) || entry.path !== now.path) add('modified', now)
  }
  for (const [p, entry] of current) if (!old.has(p) && entry.status !== 'missing') {
    add(entry.status === 'ok' && before.complete ? 'added' : 'unverified', entry)
  }
  if (result.added + result.removed + result.modified) result.status = 'changed'
  else if (!result.complete || result.unverified) result.status = 'incomplete'
  else if (before.hash !== after.hash) {
    // Conservative fallback for an empty-directory/layout change not represented by a leaf delta.
    result.status = 'changed'
  }
  return result
}

async function startWorker() {
  const directory = path.dirname(workerData.databasePath)
  await fs.mkdir(directory, { recursive: true, mode: 0o700 })
  const store = new HistoryStore(workerData.databasePath)
  try { await fs.chmod(workerData.databasePath, 0o600) } catch { /* Windows permissions are managed by the user profile. */ }
  const scans = new Map(), cancelledEarly = new Set()
  let activeScans = 0
  const handleScan = async (operation, payload, roots, owner) => {
    const scanId = string(payload.scanId, 'scan ID', 100), token = `${owner}:${scanId}`
    if (cancelledEarly.delete(token)) throw new Error('Fingerprint check cancelled.')
    if (scans.size >= 16) throw new Error('Too many fingerprint requests. Try again after the current check finishes.')
    const controller = new AbortController()
    if (scans.has(token)) throw new Error('Duplicate fingerprint request.')
    scans.set(token, controller)
    let acquired = false
    try {
      while (activeScans >= 2) {
        if (controller.signal.aborted) throw new Error('Fingerprint check cancelled.')
        await new Promise(resolve => setTimeout(resolve, 25))
      }
      acquired = true; activeScans++
      store.row(payload.id)
      const before = operation === 'compare' ? store.baseline(payload.id) : null
      if (operation === 'compare' && !before) return { status: 'no-baseline', since: null, checkedAt: Date.now(),
        added: 0, removed: 0, modified: 0, unverified: 0, changes: [], issues: ['This conversation has no historical fingerprint.'], complete: false, truncated: false }
      const scan = await fingerprint(before ? before.scope : payload.scope, roots, {
        signal: controller.signal, excludeDirectory: directory,
      })
      if (controller.signal.aborted) throw new Error('Fingerprint check cancelled.')
      return before ? compareSnapshots(before, scan) : store.saveSnapshot(payload.id, scan)
    } finally { scans.delete(token); if (acquired) activeScans-- }
  }
  parentPort.on('message', async message => {
    const { requestId, operation, payload = {}, roots = [], owner = 0 } = message
    try {
      let result
      switch (operation) {
        case 'initialize': result = { databasePath: workerData.databasePath, imported: store.importLegacy(payload.legacy) }; break
        case 'list': result = store.list(payload); break
        case 'create': result = store.create(payload); break
        case 'get': result = store.get(payload.id); break
        case 'save': result = store.save(payload); break
        case 'rename': result = store.rename(payload.id, payload.title); break
        case 'delete': result = store.delete(payload.id); break
        case 'capture': case 'compare': result = await handleScan(operation, payload, roots, owner); break
        case 'cancelScan': {
          const token = `${owner}:${string(payload.scanId, 'scan ID', 100)}`
          if (scans.has(token)) scans.get(token).abort()
          else { if (cancelledEarly.size > 1000) cancelledEarly.clear(); cancelledEarly.add(token) }
          break
        }
        case 'cancelOwner': for (const [token, controller] of scans) if (token.startsWith(`${owner}:`)) controller.abort(); break
        case 'close': for (const controller of scans.values()) controller.abort(); store.close(); parentPort.postMessage({ requestId, result: null }); parentPort.close(); return
        default: throw new Error('Unsupported conversation operation.')
      }
      parentPort.postMessage({ requestId, result: result ?? null })
    } catch (error) { parentPort.postMessage({ requestId, error: errorText(error) }) }
  })
  parentPort.postMessage({ ready: true })
}

module.exports = { HistoryStore, fingerprint, compareSnapshots, normalizeScope, normalizeMessages, key, contains, LIMITS }
if (!isMainThread) startWorker().catch(error => {
  parentPort.postMessage({ startupError: errorText(error) })
  parentPort.close()
})
