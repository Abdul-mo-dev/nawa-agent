import { randomUUID } from 'node:crypto'
import { createRequire } from 'node:module'
import { lstat, mkdir, mkdtemp, open, rename, rm } from 'node:fs/promises'
import { basename, join } from 'node:path'
import type { AnalyticsPreparationSummary, AnalyticsTableExport, SourceRef } from '../../shared/analytics-api'
import { authorizePath, hashFile, samePath, within } from '../directory-actions/file-safety'
import { quotedTable, type AnalyticsStore } from './store'

const { DatabaseSync } = createRequire(import.meta.url)('node:' + 'sqlite') as typeof import('node:sqlite')

/** Publish one standalone SQLite snapshot in private app storage for this selection's Ready tables. */
export async function exportReadyTables(options: {
  store: AnalyticsStore; roots: string[]; folder: string; outputDirectory: string; paths: string[]
  preparation: AnalyticsPreparationSummary; check: () => void
  verify: (sources: SourceRef[]) => Promise<void>
  progress: (record: import('./store').StoredDataset, rows: number) => void
}) {
  const { store, roots, folder, outputDirectory, paths, preparation, check, verify, progress } = options
  await authorizePath(roots, folder)
  if (!(await lstat(folder)).isDirectory()) throw new Error('Choose a workspace folder for the selected source files.')
  const selected = store.datasets().filter(record => paths.some(path => samePath(path, record.data.path)))
  const ready = selected.filter(record => record.data.status === 'ready' && record.typedTable && ['ready', 'needs-review'].includes(store.file(record.data.path)?.state ?? ''))
  const sources = ready.map(({ data: d }) => ({ path: d.path, hash: d.sourceHash, datasetId: d.id, generation: d.generation }))
  await verify(sources); check()
  await mkdir(outputDirectory, { recursive: true })
  await authorizePath([outputDirectory], outputDirectory)
  const stage = await mkdtemp(join(outputDirectory, '.nawa-table-export-'))
  const exports: AnalyticsTableExport[] = []
  const stamp = new Date().toISOString().replace(/[:.]/g, '-')
  const exportDirectory = join(outputDirectory, `Nawa table exports ${stamp}-${randomUUID().slice(0, 8)}`)
  let published = false
  let database: InstanceType<typeof DatabaseSync> | undefined
  try {
    await authorizePath([outputDirectory], stage)
    database = new DatabaseSync(join(stage, 'tables.sqlite3'), { allowExtension: false, enableDoubleQuotedStringLiterals: false })
    database.exec('PRAGMA journal_mode=DELETE; PRAGMA synchronous=FULL; PRAGMA cache_size=-16384;')
    database.exec('CREATE TABLE nawa_tables(dataset_id TEXT PRIMARY KEY,sql_table TEXT NOT NULL,source_path TEXT NOT NULL,source_hash TEXT NOT NULL,generation TEXT NOT NULL,name TEXT NOT NULL,sheet TEXT NOT NULL,rows INTEGER NOT NULL,policy_json TEXT NOT NULL,approval_json TEXT NOT NULL) STRICT; CREATE TABLE nawa_columns(dataset_id TEXT NOT NULL,column_id TEXT NOT NULL,name TEXT NOT NULL,type TEXT NOT NULL,scale INTEGER NOT NULL,unit TEXT NOT NULL,role TEXT NOT NULL,PRIMARY KEY(dataset_id,column_id)) STRICT; CREATE TABLE nawa_manifest(json TEXT NOT NULL) STRICT;')
    const tableInfo = database.prepare('INSERT INTO nawa_tables VALUES(?,?,?,?,?,?,?,?,?,?)')
    const columnInfo = database.prepare('INSERT INTO nawa_columns VALUES(?,?,?,?,?,?,?)')
    const types = { text: 'TEXT', date: 'TEXT', integer: 'INTEGER', decimal: 'INTEGER', boolean: 'INTEGER', real: 'REAL' }
    for (const record of ready) {
      check()
      const d = record.data, target = quotedTable(record.typedTable!)
      database.exec(`CREATE TABLE ${target}(__row INTEGER PRIMARY KEY,${d.policy.columns.map(c => `"${c.id}" ${types[c.type]}${c.nullable ? '' : ' NOT NULL'}`).join(',')}) STRICT`)
      const read = store.db.prepare(`SELECT __row,${d.policy.columns.map(c => `"${c.id}"`).join(',')} FROM ${target} ORDER BY __row`)
      read.setReadBigInts(true)
      const insert = database.prepare(`INSERT INTO ${target} VALUES(${Array.from({ length: d.policy.columns.length + 1 }, () => '?').join(',')})`)
      let rows = 0
      database.exec('BEGIN')
      for (const row of read.iterate()) {
        check()
        insert.run(row.__row, ...d.policy.columns.map(c => row[c.id]))
        rows++
        if (rows % 1000 === 0) {
          database.exec('COMMIT'); progress(record, rows)
          await new Promise<void>(resolve => setImmediate(resolve)); check()
          database.exec('BEGIN')
        }
      }
      database.exec('COMMIT')
      if (rows !== d.rows) throw new Error('Applied row count changed during export. Retry the batch.')
      if (d.policy.key.length) database.exec(`CREATE UNIQUE INDEX "${record.typedTable}_key" ON ${target}(${d.policy.key.map(key => `"${key}"`).join(',')})`)
      tableInfo.run(d.id, record.typedTable!, d.path, d.sourceHash, d.generation, d.name, d.sheet, rows, JSON.stringify(d.policy), JSON.stringify(d.approval ?? null))
      for (const c of d.policy.columns) columnInfo.run(d.id, c.id, c.name, c.type, c.scale, c.unit, c.role)
      progress(record, rows)
      exports.push({ datasetId: d.id, sourcePath: d.path, name: d.name, sheet: d.sheet, generation: d.generation, sourceHash: d.sourceHash, fileName: 'tables.sqlite3', sqlTable: record.typedTable!, rows })
    }
    const manifest = {
      version: 2, createdAt: new Date().toISOString(), format: 'SQLite', completePopulations: true,
      numericEncoding: 'Integers and decimals are exact signed 64-bit integers. Decimal values are scaled by 10^scale; consult nawa_columns. REAL is approximate.',
      sourceRowColumn: '__row', preparation,
      selectedFiles: paths.map(path => ({ path, state: store.file(path)?.state ?? 'not-imported', error: store.file(path)?.error ?? '' })),
      tables: selected.map(({ data: d }) => ({ datasetId: d.id, sourcePath: d.path, name: d.name, sheet: d.sheet, generation: d.generation, sourceHash: d.sourceHash, status: d.status, exported: exports.some(e => e.datasetId === d.id), rows: d.rows, policy: d.policy, approval: d.approval, warnings: d.warnings, preparedPolicy: d.preparedPolicy, preparationError: d.preparationError })),
      exports,
    }
    database.prepare('INSERT INTO nawa_manifest VALUES(?)').run(JSON.stringify(manifest))
    database.close(); database = undefined
    const file = await open(join(stage, 'manifest.json'), 'wx', 0o600)
    try { await file.writeFile(JSON.stringify(manifest, null, 2), 'utf8'); await file.sync() } finally { await file.close() }
    const hash = await hashFile(join(stage, 'tables.sqlite3'))
    await verify(sources); check()
    await authorizePath(roots, folder); await authorizePath([outputDirectory], stage)
    await rename(stage, exportDirectory); published = true
    const databasePath = join(exportDirectory, 'tables.sqlite3')
    for (const record of ready) store.putDataset({ ...record, data: { ...record.data, profile: { ...record.data.profile, sqliteExport: { path: databasePath, hash, generation: record.data.generation } } } })
    return { exportDirectory, databasePath, manifestPath: join(exportDirectory, 'manifest.json'), exports, preparation, sources }
  } finally {
    database?.close()
    if (!published && within(outputDirectory, stage) && basename(stage).startsWith('.nawa-table-export-')) {
      await authorizePath([outputDirectory], stage).then(() => rm(stage, { recursive: true, force: true })).catch(() => undefined)
    }
  }
}
