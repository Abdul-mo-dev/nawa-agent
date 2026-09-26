/** Nawa permission-aware worker around GenOffice's FTS5 store and file parser.
 * Extraction, hashing and SQLite stay off Electron's main/UI thread. No network calls. */
import { parentPort, workerData } from 'node:worker_threads';
import { mkdir, readdir, lstat } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { FileIndexStore } from './store';
import { extractText } from './extract';
import { authorizePath, regularFile, hashFile, within } from '../directory-actions/file-safety';
interface Job {
    id: string;
    action: 'index' | 'selected' | 'search' | 'clear';
    roots: string[];
    folder?: string;
    paths?: string[];
    query?: string;
}
const LIMITS = { files: 5000, entries: 20000, depth: 32, bytes: 1024 * 1024 * 1024 };
let store: FileIndexStore | null = null;
let busy = false;
const message = (cause: unknown) => cause instanceof Error ? cause.message : String(cause);
const hidden = (name: string) => name.startsWith('.') || name.startsWith('~$') || ['node_modules', '__macosx'].includes(name.toLowerCase());
async function database(): Promise<FileIndexStore> {
    if (!store) {
        await mkdir(dirname(workerData.databasePath), { recursive: true });
        store = new FileIndexStore(workerData.databasePath);
    }
    return store;
}
async function work(job: Job): Promise<unknown> {
    const db = await database();
    let indexed = 0, scanned = 0, totalBytes = 0;
    const warnings: string[] = [];
    const warn = (text: string) => { if (warnings.length < 50)
        warnings.push(text); };
    const progress = (pending: number, text: string) => parentPort!.postMessage({ id: job.id, progress: { running: true, indexed, pending, scanned, message: text } });
    if (job.action === 'clear') {
        db.remove([...db.listAll().keys()]);
        return { running: false, indexed: 0, pending: 0, scanned: 0, message: 'Local content index cleared. Conversation history was not touched.' };
    }
    // Detaching a workspace prevents access immediately; cached rows outside current roots are pruned at the next job.
    const known = db.listAll();
    db.remove([...known.keys()].filter(path => !job.roots.some(root => within(root, path))));
    const paths: string[] = [];
    if (job.action === 'index') {
        if (!job.folder)
            throw new Error('Choose a folder to index.');
        await authorizePath(job.roots, job.folder);
        const walk = async (folder: string, depth: number): Promise<void> => {
            if (depth > LIMITS.depth) {
                warn('Some subfolders exceeded the depth limit.');
                return;
            }
            await authorizePath(job.roots, folder);
            for (const entry of await readdir(folder, { withFileTypes: true })) {
                if (++scanned > LIMITS.entries || paths.length >= LIMITS.files) {
                    warn('Index scan was capped; narrow the folder for complete coverage.');
                    return;
                }
                if (hidden(entry.name))
                    continue;
                const path = join(folder, entry.name);
                if (entry.isSymbolicLink()) {
                    warn(`Skipped linked entry: ${path}`);
                    continue;
                }
                if (entry.isDirectory())
                    await walk(path, depth + 1);
                else if (entry.isFile())
                    paths.push(path);
            }
        };
        await walk(job.folder, 0);
        const seen = new Set(paths);
        // Only purge missing entries after a complete enumeration.
        if (!warnings.some(w => w.includes('capped') || w.includes('depth')))
            db.remove([...known.keys()].filter(p => within(job.folder!, p) && !seen.has(p)));
    }
    else if (job.action === 'selected') {
        if (!Array.isArray(job.paths) || job.paths.length > 256)
            throw new Error('Invalid selected-file scope.');
        paths.push(...job.paths);
    }
    for (const [i, path] of paths.entries()) {
        progress(paths.length - i, path);
        try {
            await regularFile(job.roots, path);
            const stat = await lstat(path);
            totalBytes += stat.size;
            if (totalBytes > LIMITS.bytes) {
                warn('Indexing exceeded the 1 GiB per-job read budget.');
                break;
            }
            const old = known.get(path);
            // Agent-selected reads always hash; local folder scans can reuse unchanged metadata.
            if (job.action === 'index' && old?.status !== 'error' && old?.mtimeMs === stat.mtimeMs && old.sizeBytes === stat.size) {
                indexed++;
                continue;
            }
            const sourceHash = await hashFile(path);
            if (old?.sourceHash === sourceHash && old.status !== 'error') {
                indexed++;
                continue;
            }
            const parsed = await extractText(path);
            await regularFile(job.roots, path);
            if (await hashFile(path) !== sourceHash)
                throw new Error('File changed during extraction; not indexed.');
            db.upsert({ path, mtimeMs: stat.mtimeMs, sizeBytes: stat.size, sourceHash }, parsed.kind === 'text' ? parsed.text : null, parsed.kind === 'text' ? 'ok' : parsed.kind === 'name-only' ? 'name-only' : 'error');
            if (parsed.kind === 'text' && parsed.truncated)
                warn(`${path}: only the first 1,000,000 extracted characters were indexed.`);
            if (parsed.kind !== 'text')
                warn(`${path}: ${parsed.kind === 'error' ? parsed.error : 'only name/path indexed; no text extractor for this file'}`);
            indexed++;
        }
        catch (cause) {
            db.remove([path]);
            warn(`${path}: ${message(cause)}`);
        }
    }
    if (job.action === 'index')
        return { running: false, indexed, pending: 0, scanned, message: `Indexed ${indexed} files. ${warnings.join(' ')}` };
    if (!job.query || job.query.length > 256 || job.query.split(/\s+/).length > 32)
        throw new Error('Search queries must be 1–256 characters and at most 32 terms.');
    let allowed: string[];
    if (job.action === 'selected')
        allowed = paths;
    else {
        if (!job.folder)
            throw new Error('Choose a search folder.');
        await authorizePath(job.roots, job.folder);
        allowed = [...db.listAll().keys()].filter(p => within(job.folder!, p));
    }
    const result = db.search(job.query, { paths: allowed, limit: 100, excerptChars: 1200 });
    const hits = [];
    for (const hit of result.hits) {
        try {
            await regularFile(job.roots, hit.path);
            if (await hashFile(hit.path) !== hit.sourceHash) {
                db.remove([hit.path]);
                warn(`Changed file omitted; re-index: ${hit.path}`);
                continue;
            }
            hits.push(hit);
        }
        catch {
            db.remove([hit.path]);
            warn(`Unavailable file omitted: ${hit.path}`);
        }
    }
    if (result.total > result.hits.length)
        warn('Only the first 100 matches are returned. Narrow the query for other results.');
    warn('Search indexes at most 1,000,000 extracted characters per file; use native inspection for complete supported-document analysis.');
    return { hits, total: result.total - (result.hits.length - hits.length), warnings };
}
parentPort!.on('message', (job: Job) => {
    if (busy) {
        parentPort!.postMessage({ id: job.id, error: 'Search worker is busy.' });
        return;
    }
    busy = true;
    void work(job).then(result => parentPort!.postMessage({ id: job.id, result }), cause => parentPort!.postMessage({ id: job.id, error: message(cause) })).finally(() => { busy = false; });
});
