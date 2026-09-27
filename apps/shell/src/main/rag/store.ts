import { createRequire } from 'node:module'
import type { RagFileStatus, RagState } from '../../shared/rag-api'
import type { RagChunk } from './chunks'
import { indexTerms, matchQuery } from './lexical'
const { DatabaseSync } = createRequire(import.meta.url)('node:' + 'sqlite') as typeof import('node:sqlite')
export interface FileRecord {
  path: string; source_hash: string; profile: string; size: number; mtime: number; ctime: number
  status: RagState; chunks: number; indexed_at: number; error: string; warnings: string; partial: number
}
export interface StoredChunk extends RagChunk { id: number; path: string; sourceHash: string; vector: Float32Array }
export interface RankedChunk extends StoredChunk { score: number; cosine?: number; neighbor?: boolean }
export function vectorBytes(vector: Float32Array): Uint8Array {
  const buffer = Buffer.alloc(vector.length * 4)
  vector.forEach((n, i) => buffer.writeFloatLE(n, i * 4))
  return buffer
}
export function fromBytes(raw: Uint8Array): Float32Array {
  const bytes = Buffer.from(raw.buffer, raw.byteOffset, raw.byteLength)
  if (!bytes.length || bytes.length % 4) throw new Error('Corrupt embedding vector in index.')
  return Float32Array.from({ length: bytes.length / 4 }, (_, i) => bytes.readFloatLE(i * 4))
}
export class RagStore {
  readonly db: import('node:sqlite').DatabaseSync
  constructor(path: string) {
    this.db = new DatabaseSync(path)
    this.db.exec(`PRAGMA journal_mode=WAL; PRAGMA busy_timeout=5000; PRAGMA foreign_keys=ON;
      CREATE TABLE IF NOT EXISTS rag_meta(key TEXT PRIMARY KEY,value TEXT NOT NULL);
      INSERT OR IGNORE INTO rag_meta VALUES('schema','1');
      CREATE TABLE IF NOT EXISTS rag_profiles(id TEXT PRIMARY KEY,dimensions INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS rag_files(path TEXT PRIMARY KEY,source_hash TEXT NOT NULL DEFAULT '',profile TEXT NOT NULL DEFAULT '',size REAL NOT NULL DEFAULT 0,mtime REAL NOT NULL DEFAULT 0,ctime REAL NOT NULL DEFAULT 0,status TEXT NOT NULL DEFAULT 'not-indexed',chunks INTEGER NOT NULL DEFAULT 0,indexed_at REAL NOT NULL DEFAULT 0,error TEXT NOT NULL DEFAULT '',warnings TEXT NOT NULL DEFAULT '[]',partial INTEGER NOT NULL DEFAULT 0);
      CREATE TABLE IF NOT EXISTS rag_chunks(id INTEGER PRIMARY KEY,path TEXT NOT NULL REFERENCES rag_files(path) ON DELETE CASCADE,ordinal INTEGER NOT NULL,source_hash TEXT NOT NULL,profile TEXT NOT NULL,text TEXT NOT NULL,embedding_text TEXT NOT NULL,hash TEXT NOT NULL,locator TEXT NOT NULL,metadata TEXT NOT NULL,vector BLOB NOT NULL,UNIQUE(path,ordinal));
      CREATE INDEX IF NOT EXISTS rag_chunk_profile_path ON rag_chunks(profile,path);
      CREATE VIRTUAL TABLE IF NOT EXISTS rag_fts USING fts5(text,content='',contentless_delete=1,tokenize='unicode61 remove_diacritics 2');
      CREATE TABLE IF NOT EXISTS rag_embedding_cache(profile TEXT NOT NULL,hash TEXT NOT NULL,vector BLOB NOT NULL,PRIMARY KEY(profile,hash));`)
    const version = this.db.prepare("SELECT value FROM rag_meta WHERE key='schema'").get() as { value: string }
    if (version.value !== '1') throw new Error('Unsupported RAG database version. No migration was attempted.')
  }
  recover(): void { this.db.exec("UPDATE rag_files SET status='failed',error='Indexing was interrupted. Run Index / refresh to resume cached chunks.' WHERE status='embedding'") }
  get(path: string): FileRecord | undefined { return this.db.prepare('SELECT * FROM rag_files WHERE path=?').get(path) as unknown as FileRecord | undefined }
  allPaths(): string[] { return (this.db.prepare('SELECT path FROM rag_files').all() as unknown as { path: string }[]).map(r => r.path) }
  state(path: string, status: RagState, error = ''): void {
    this.db.prepare('INSERT INTO rag_files(path,status,error) VALUES(?,?,?) ON CONFLICT(path) DO UPDATE SET status=excluded.status,error=excluded.error').run(path, status, error.slice(0, 2000))
  }
  touch(path: string, mtime: number, ctime: number, size: number): void { this.db.prepare('UPDATE rag_files SET mtime=?,ctime=?,size=? WHERE path=?').run(mtime, ctime, size, path) }
  view(path: string, profile: string): RagFileStatus {
    const r = this.get(path)
    if (!r) return { path, status: 'not-indexed', chunks: 0 }
    return { path, status: r.status === 'embedded' && r.profile !== profile ? 'stale' : r.status, chunks: r.chunks,
      sourceHash: r.source_hash || undefined, indexedAt: r.indexed_at || undefined, partial: !!r.partial,
      error: r.status === 'embedded' && r.profile !== profile ? 'Embedding model/settings changed. Re-index this file.' : r.error || undefined,
      warnings: JSON.parse(r.warnings) as string[] }
  }
  dimensions(profile: string): number { return (this.db.prepare('SELECT dimensions FROM rag_profiles WHERE id=?').get(profile) as { dimensions: number } | undefined)?.dimensions ?? 0 }
  setDimensions(profile: string, dimensions: number): void {
    this.db.prepare('INSERT OR IGNORE INTO rag_profiles VALUES(?,?)').run(profile, dimensions)
    if (this.dimensions(profile) !== dimensions) throw new Error('Vector dimensions changed within one profile; set a new model revision and re-index.')
  }
  cached(profile: string, hash: string): Float32Array | undefined {
    const row = this.db.prepare('SELECT vector FROM rag_embedding_cache WHERE profile=? AND hash=?').get(profile, hash) as { vector: Uint8Array } | undefined
    return row ? fromBytes(row.vector) : undefined
  }
  cache(profile: string, hash: string, vector: Float32Array): void {
    this.setDimensions(profile, vector.length)
    this.db.prepare('INSERT OR IGNORE INTO rag_embedding_cache VALUES(?,?,?)').run(profile, hash, vectorBytes(vector))
  }
  /** Publish an entire file generation atomically, only after every vector and fingerprint passes. */
  commit(meta: { path: string; sourceHash: string; profile: string; size: number; mtime: number; ctime: number; warnings: string[]; partial: boolean }, chunks: RagChunk[], vectors: Float32Array[]): void {
    if (!chunks.length || chunks.length !== vectors.length) throw new Error('Incomplete file generation.')
    const dimensions = vectors[0]!.length
    if (!vectors.every(v => v.length === dimensions)) throw new Error('Mixed dimensions in one file generation.')
    this.db.exec('BEGIN IMMEDIATE')
    try {
      this.setDimensions(meta.profile, dimensions)
      this.state(meta.path, 'embedding')
      this.db.prepare('DELETE FROM rag_fts WHERE rowid IN (SELECT id FROM rag_chunks WHERE path=?)').run(meta.path)
      this.db.prepare('DELETE FROM rag_chunks WHERE path=?').run(meta.path)
      const put = this.db.prepare('INSERT INTO rag_chunks(path,ordinal,source_hash,profile,text,embedding_text,hash,locator,metadata,vector) VALUES(?,?,?,?,?,?,?,?,?,?)')
      const fts = this.db.prepare('INSERT INTO rag_fts(rowid,text) VALUES(?,?)')
      chunks.forEach((c, i) => {
        const row = put.run(meta.path, c.ordinal, meta.sourceHash, meta.profile, c.text, c.embeddingText, c.hash, c.locator, JSON.stringify(c.metadata), vectorBytes(vectors[i]!))
        fts.run(row.lastInsertRowid, indexTerms(c.embeddingText))
      })
      this.db.prepare("UPDATE rag_files SET source_hash=?,profile=?,size=?,mtime=?,ctime=?,status='embedded',chunks=?,indexed_at=?,error='',warnings=?,partial=? WHERE path=?").run(meta.sourceHash, meta.profile, meta.size, meta.mtime, meta.ctime, chunks.length, Date.now(), JSON.stringify(meta.warnings), meta.partial ? 1 : 0, meta.path)
      this.db.exec('COMMIT')
    } catch (error) { this.db.exec('ROLLBACK'); throw error }
  }
  remove(paths: string[]): void {
    this.db.exec('BEGIN IMMEDIATE')
    try {
      const fts = this.db.prepare('DELETE FROM rag_fts WHERE rowid IN (SELECT id FROM rag_chunks WHERE path=?)'), file = this.db.prepare('DELETE FROM rag_files WHERE path=?')
      for (const path of paths) { fts.run(path); file.run(path) }
      // Remove vectors no longer referenced by any published file. This also removes orphaned retry cache.
      this.db.exec('DELETE FROM rag_embedding_cache WHERE NOT EXISTS (SELECT 1 FROM rag_chunks c WHERE c.profile=rag_embedding_cache.profile AND c.hash=rag_embedding_cache.hash)')
      this.db.exec('COMMIT')
    } catch (error) { this.db.exec('ROLLBACK'); throw error }
  }
  private decode(row: Record<string, unknown>): StoredChunk {
    return { id: Number(row.id), path: String(row.path), ordinal: Number(row.ordinal), sourceHash: String(row.source_hash), text: String(row.text), embeddingText: String(row.embedding_text), hash: String(row.hash), locator: String(row.locator), metadata: JSON.parse(String(row.metadata)) as RagChunk['metadata'], vector: fromBytes(row.vector as Uint8Array) }
  }
  /** Exact cosine in a worker: bounded-memory scan, filtered by the selected-file allowlist BEFORE ranking. */
  retrieve(paths: string[], profile: string, query: string, vector: Float32Array | null, topK: number): RankedChunk[] {
    if (!paths.length) return []
    this.db.exec('CREATE TEMP TABLE IF NOT EXISTS rag_allowed(path TEXT PRIMARY KEY); DELETE FROM rag_allowed;')
    const allow = this.db.prepare('INSERT OR IGNORE INTO rag_allowed VALUES(?)')
    for (const path of paths) allow.run(path)
    const scope = "FROM rag_chunks c JOIN rag_files f ON f.path=c.path JOIN rag_allowed a ON a.path=c.path WHERE c.profile=? AND f.profile=? AND f.status='embedded' AND c.source_hash=f.source_hash"
    const cap = Math.min(192, topK * 8), semantic: Array<{ id: number; score: number }> = []
    if (vector) {
      const iter = this.db.prepare(`SELECT c.id,c.vector ${scope}`).iterate(profile, profile)
      for (const raw of iter) {
        const row = raw as unknown as { id: number; vector: Uint8Array }, candidate = fromBytes(row.vector)
        if (candidate.length !== vector.length) throw new Error('Stored vector dimension mismatch.')
        let score = 0; for (let i = 0; i < candidate.length; i++) score += candidate[i]! * vector[i]!
        if (semantic.length < cap || score > semantic[semantic.length - 1]!.score) { semantic.push({ id: row.id, score }); semantic.sort((a, b) => b.score - a.score); if (semantic.length > cap) semantic.pop() }
      }
    }
    const expression = matchQuery(query)
    const lexical = expression ? this.db.prepare(`SELECT c.id,bm25(rag_fts) AS rank FROM rag_fts JOIN rag_chunks c ON c.id=rag_fts.rowid JOIN rag_files f ON f.path=c.path JOIN rag_allowed a ON a.path=c.path WHERE rag_fts MATCH ? AND c.profile=? AND f.profile=? AND f.status='embedded' AND c.source_hash=f.source_hash ORDER BY rank LIMIT ?`).all(expression, profile, profile, cap) as unknown as { id: number; rank: number }[] : []
    const fused = new Map<number, { score: number; cosine?: number }>()
    semantic.forEach((r, i) => fused.set(r.id, { score: 1 / (60 + i + 1), cosine: r.score }))
    lexical.forEach((r, i) => { const old = fused.get(r.id) ?? { score: 0 }; fused.set(r.id, { ...old, score: old.score + 1 / (60 + i + 1) }) })
    const get = this.db.prepare(`SELECT c.* ${scope} AND c.id=?`)
    return [...fused].sort((a, b) => b[1].score - a[1].score).slice(0, topK).flatMap(([id, scores]) => {
      const raw = get.get(profile, profile, id)
      return raw ? [{ ...this.decode(raw), ...scores }] : []
    })
  }
  neighbor(chunk: StoredChunk, delta: number, profile: string): StoredChunk | undefined {
    const raw = this.db.prepare("SELECT c.* FROM rag_chunks c JOIN rag_files f ON f.path=c.path WHERE c.path=? AND c.ordinal=? AND c.profile=? AND c.source_hash=? AND f.status='embedded' AND f.source_hash=c.source_hash").get(chunk.path, chunk.ordinal + delta, profile, chunk.sourceHash)
    return raw ? this.decode(raw) : undefined
  }
  close(): void { this.db.close() }
}
