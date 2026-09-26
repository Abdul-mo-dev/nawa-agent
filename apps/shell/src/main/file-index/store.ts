/** GenOffice FTS5 ranking/store, adapted from f4ea9de914c5e9276a9c2935406885a7f742e31a (Apache-2.0).
 * Nawa adds source fingerprints and mandatory authorized-path filtering before result selection.
 * This database is separate from conversation history. */
import { createRequire } from 'node:module';
import { basename, dirname, extname } from 'node:path';
import { buildSnippet, containsAny, excerpt, type SnippetPart } from './snippet';
import { parseQuery, termChars, termExpr, toIndexText, toMatchExpression, tokenExprs, tokenize, type QueryTerm } from './tokenize';
// Keep SQLite a runtime builtin even when a bundler's builtin list predates Node 22.
const { DatabaseSync } = createRequire(import.meta.url)('node:' + 'sqlite') as typeof import('node:sqlite');
const MAX_BODY_CHARS = 1000000;
export type IndexStatus = 'ok' | 'name-only' | 'error';
export interface IndexedFile {
    path: string;
    mtimeMs: number;
    sizeBytes: number;
    status: IndexStatus;
    sourceHash: string;
}
export interface SearchHit {
    path: string;
    name: string;
    ext: string;
    mtimeMs: number;
    sizeBytes: number;
    sourceHash: string;
    snippet: SnippetPart[] | null;
    needles: string[];
    excerpt?: string;
}
export interface SearchOptions {
    paths: readonly string[];
    exts?: readonly string[];
    offset?: number;
    limit?: number;
    excerptChars?: number;
}
export interface SearchResult {
    hits: SearchHit[];
    total: number;
}
interface Row {
    id: number;
    path: string;
    name: string;
    ext: string;
    mtime_ms: number;
    size_bytes: number;
    source_hash: string;
}
interface Candidate {
    exact: number;
    relaxed: number;
    cover: number;
    score: number;
    needles: Set<string>;
}
export class FileIndexStore {
    private readonly db: import('node:sqlite').DatabaseSync;
    constructor(path: string) {
        this.db = new DatabaseSync(path);
        this.db.exec(`PRAGMA journal_mode=WAL; PRAGMA busy_timeout=5000;
      CREATE TABLE IF NOT EXISTS files(id INTEGER PRIMARY KEY,path TEXT NOT NULL UNIQUE,name TEXT NOT NULL,ext TEXT NOT NULL,mtime_ms REAL NOT NULL,size_bytes INTEGER NOT NULL,status TEXT NOT NULL,source_hash TEXT NOT NULL,body TEXT);
      CREATE VIRTUAL TABLE IF NOT EXISTS file_fts USING fts5(name,path,body,name_u,path_u,body_u,content='',contentless_delete=1,tokenize='unicode61 remove_diacritics 2');`);
    }
    listAll(): Map<string, IndexedFile> {
        const rows = this.db.prepare('SELECT path,mtime_ms,size_bytes,status,source_hash FROM files').all() as unknown as Array<{
            path: string;
            mtime_ms: number;
            size_bytes: number;
            status: IndexStatus;
            source_hash: string;
        }>;
        return new Map(rows.map(r => [r.path, { path: r.path, mtimeMs: r.mtime_ms, sizeBytes: r.size_bytes, status: r.status, sourceHash: r.source_hash }]));
    }
    count(): number { return (this.db.prepare('SELECT count(*) AS n FROM files').get() as {
        n: number;
    }).n; }
    upsert(meta: {
        path: string;
        mtimeMs: number;
        sizeBytes: number;
        sourceHash: string;
    }, text: string | null, status: IndexStatus): void {
        const name = basename(meta.path), ext = extname(meta.path).slice(1).toLowerCase(), body = text ? text.slice(0, MAX_BODY_CHARS) : null;
        const nameTok = tokenize(name), pathTok = tokenize(dirname(meta.path)), bodyTok = body ? tokenize(body) : { bi: [], uni: [] };
        this.db.exec('BEGIN');
        try {
            const existing = this.db.prepare('SELECT id FROM files WHERE path=?').get(meta.path) as {
                id: number;
            } | undefined;
            if (existing) {
                this.db.prepare('DELETE FROM file_fts WHERE rowid=?').run(existing.id);
                this.db.prepare('DELETE FROM files WHERE id=?').run(existing.id);
            }
            const r = this.db.prepare('INSERT INTO files(path,name,ext,mtime_ms,size_bytes,status,source_hash,body) VALUES(?,?,?,?,?,?,?,?)').run(meta.path, name, ext, meta.mtimeMs, meta.sizeBytes, status, meta.sourceHash, body);
            this.db.prepare('INSERT INTO file_fts(rowid,name,path,body,name_u,path_u,body_u) VALUES(?,?,?,?,?,?,?)').run(r.lastInsertRowid, toIndexText(nameTok.bi), toIndexText(pathTok.bi), toIndexText(bodyTok.bi), toIndexText(nameTok.uni), toIndexText(pathTok.uni), toIndexText(bodyTok.uni));
            this.db.exec('COMMIT');
        }
        catch (e) {
            this.db.exec('ROLLBACK');
            throw e;
        }
    }
    remove(paths: readonly string[]): void {
        const select = this.db.prepare('SELECT id FROM files WHERE path=?'), delFts = this.db.prepare('DELETE FROM file_fts WHERE rowid=?'), delFile = this.db.prepare('DELETE FROM files WHERE id=?');
        this.db.exec('BEGIN');
        try {
            for (const p of paths) {
                const r = select.get(p) as {
                    id: number;
                } | undefined;
                if (r) {
                    delFts.run(r.id);
                    delFile.run(r.id);
                }
            }
            ;
            this.db.exec('COMMIT');
        }
        catch (e) {
            this.db.exec('ROLLBACK');
            throw e;
        }
    }
    search(input: string, opts: SearchOptions): SearchResult {
        if (!opts.paths.length)
            return { hits: [], total: 0 };
        const parsed = parseQuery(input), authorized = new Set(opts.paths);
        if (!parsed.include.length)
            return { hits: [], total: 0 };
        const candidates = new Map<number, Candidate>();
        const get = (id: number): Candidate => { let c = candidates.get(id); if (!c) {
            c = { exact: 0, relaxed: 0, cover: 0, score: 0, needles: new Set() };
            candidates.set(id, c);
        } return c; };
        for (const term of parsed.include) {
            const exactIds = new Set<number>();
            for (const r of this.matchScored(termExpr(term))) {
                exactIds.add(r.rowid);
                const c = get(r.rowid);
                c.exact++;
                c.score += r.score;
                c.needles.add(term.text);
            }
            for (const [id, m] of this.relaxedMatches(term)) {
                if (exactIds.has(id))
                    continue;
                const c = get(id);
                c.relaxed++;
                c.cover += m.cover;
                for (const t of m.tokens)
                    c.needles.add(t);
            }
        }
        if (parsed.exclude.length) {
            const expr = toMatchExpression({ include: parsed.exclude, exclude: [] }, 'OR');
            if (expr)
                for (const id of this.matchIds(expr))
                    candidates.delete(id);
        }
        if (!candidates.size)
            return { hits: [], total: 0 };
        // Authorization precedes all-term fallback, total counts and excerpts. Empty scopes return nothing.
        const allRows = this.fetchRows([...candidates.keys()], opts.exts).filter(r => authorized.has(r.path));
        const fullRows = allRows.filter(r => { const c = candidates.get(r.id)!; return c.exact + c.relaxed === parsed.include.length; });
        const rows = fullRows.length ? fullRows : allRows, first = parsed.include[0]!.text;
        const rank = new Map<number, number[]>();
        for (const r of rows) {
            const c = candidates.get(r.id)!, needles = [...c.needles], meta = containsAny(r.name, needles) || containsAny(dirname(r.path), needles);
            rank.set(r.id, [r.name.toLowerCase().startsWith(first) ? 0 : 1, -(c.exact + c.relaxed), meta ? 0 : 1, -c.exact, -c.cover, c.score, -r.mtime_ms]);
        }
        rows.sort((a, b) => { const ra = rank.get(a.id)!, rb = rank.get(b.id)!; for (let i = 0; i < ra.length; i++)
            if (ra[i] !== rb[i])
                return ra[i]! - rb[i]!; return a.path.localeCompare(b.path); });
        const limit = Math.max(0, Math.min(200, opts.limit ?? 50)), offset = Math.max(0, opts.offset ?? 0), page = rows.slice(offset, offset + limit), bodies = this.fetchBodies(page.map(r => r.id));
        return { total: rows.length, hits: page.map(r => { const needles = [...candidates.get(r.id)!.needles], body = bodies.get(r.id); return { path: r.path, name: r.name, ext: r.ext, mtimeMs: r.mtime_ms, sizeBytes: r.size_bytes, sourceHash: r.source_hash, snippet: body ? buildSnippet(body, needles) : null, needles, ...(opts.excerptChars && body ? { excerpt: excerpt(body, needles, opts.excerptChars) } : {}) }; }) };
    }
    private matchScored(expr: string): Array<{
        rowid: number;
        score: number;
    }> { return this.db.prepare('SELECT rowid,bm25(file_fts,10.0,5.0,1.0,10.0,5.0,1.0) AS score FROM file_fts WHERE file_fts MATCH ?').all(expr) as unknown as Array<{
        rowid: number;
        score: number;
    }>; }
    private matchIds(expr: string): number[] { return (this.db.prepare('SELECT rowid FROM file_fts WHERE file_fts MATCH ?').all(expr) as unknown as Array<{
        rowid: number;
    }>).map(r => r.rowid); }
    private relaxedMatches(term: QueryTerm): Map<number, {
        tokens: string[];
        cover: number;
    }> {
        const tokens = tokenExprs(term), out = new Map<number, {
            tokens: string[];
            at: Set<number>;
        }>();
        if (tokens.length < 3)
            return new Map();
        for (const t of tokens)
            for (const id of this.matchIds(t.expr)) {
                let m = out.get(id);
                if (!m)
                    out.set(id, (m = { tokens: [], at: new Set() }));
                m.tokens.push(t.text);
                for (const i of t.at)
                    m.at.add(i);
            }
        const total = termChars(term), kept = new Map<number, {
            tokens: string[];
            cover: number;
        }>();
        for (const [id, m] of out) {
            const cover = m.at.size / total;
            if (cover > 0.5)
                kept.set(id, { tokens: m.tokens, cover });
        }
        return kept;
    }
    private fetchRows(ids: readonly number[], exts?: readonly string[]): Row[] {
        const lower = exts?.map(e => e.toLowerCase()) ?? [], clause = lower.length ? ` AND ext IN (${lower.map(() => '?').join(',')})` : '', rows: Row[] = [];
        for (let i = 0; i < ids.length; i += 500) {
            const chunk = ids.slice(i, i + 500);
            rows.push(...this.db.prepare(`SELECT id,path,name,ext,mtime_ms,size_bytes,source_hash FROM files WHERE id IN (${chunk.map(() => '?').join(',')})${clause}`).all(...chunk, ...lower) as unknown as Row[]);
        }
        return rows;
    }
    private fetchBodies(ids: readonly number[]): Map<number, string> {
        const out = new Map<number, string>();
        if (!ids.length)
            return out;
        const rows = this.db.prepare(`SELECT id,body FROM files WHERE id IN (${ids.map(() => '?').join(',')})`).all(...ids) as unknown as Array<{
            id: number;
            body: string | null;
        }>;
        for (const r of rows)
            if (r.body)
                out.set(r.id, r.body);
        return out;
    }
    close(): void { this.db.close(); }
}
