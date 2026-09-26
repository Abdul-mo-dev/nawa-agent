import { Worker } from 'node:worker_threads';
import { randomUUID } from 'node:crypto';
import { mkdir, readFile, writeFile, rename, unlink } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { safeStorage } from 'electron';
import workerPath from './worker?modulePath';
import { authorizePath, regularFile, hashFile } from '../directory-actions/file-safety';
import { evaluate, type JevEndpoint } from './jev';
import type { FileSearchProgress, FileSearchResult } from '../../shared/file-search-api';
const idle = (): FileSearchProgress => ({ running: false, indexed: 0, pending: 0, scanned: 0, message: '' });
const text = (e: unknown) => e instanceof Error ? e.message : String(e);
interface Job {
    action: 'index' | 'selected' | 'search' | 'clear';
    folder?: string;
    paths?: string[];
    query?: string;
}
interface Config {
    endpoint: JevEndpoint;
    encryptedKey: string;
}
/** One bounded extraction/SQLite worker, serialized jobs and explicit cancellation. */
export class DirectorySearchService {
    private worker: Worker | null = null;
    private queue: Promise<unknown> = Promise.resolve();
    private active: {
        owner: number;
        abort: AbortController;
    } | null = null;
    private cancelled = new Map<number, number>();
    private states = new Map<number, FileSearchProgress>();
    private config: Config | null = null;
    private stopped = false;
    private network = new Map<number, Set<AbortController>>();
    constructor(private options: {
        stateDirectory: string;
        roots(): Promise<string[]>;
        workerPath?: string;
    }) { }
    progress(owner: number): FileSearchProgress { return this.states.get(owner) ?? idle(); }
    cancel(owner: number): void {
        this.cancelled.set(owner, (this.cancelled.get(owner) ?? 0) + 1);
        for (const controller of this.network.get(owner) ?? [])
            controller.abort();
        this.network.delete(owner);
        if (this.active?.owner === owner)
            this.active.abort.abort();
        this.states.set(owner, { ...this.progress(owner), running: false, message: 'Search/index job cancelled.' });
    }
    stop(): void { this.stopped = true; this.active?.abort.abort(); for (const controllers of this.network.values())
        for (const controller of controllers)
            controller.abort(); this.network.clear(); void this.worker?.terminate(); this.worker = null; }
    private async request(owner: number, job: Job, signal?: AbortSignal): Promise<unknown> {
        const generation = this.cancelled.get(owner) ?? 0;
        const run = async () => {
            if (this.stopped || signal?.aborted || (this.cancelled.get(owner) ?? 0) !== generation)
                throw new Error('Search cancelled.');
            const roots = await this.options.roots();
            if (job.folder)
                await authorizePath(roots, job.folder);
            if (job.paths)
                for (const path of job.paths)
                    await regularFile(roots, path);
            const abort = new AbortController(), forward = () => abort.abort();
            signal?.addEventListener('abort', forward, { once: true });
            const id = randomUUID();
            this.active = { owner, abort };
            this.states.set(owner, { ...idle(), running: true, message: 'Preparing local index/search…' });
            try {
                if (signal?.aborted)
                    abort.abort();
                if (abort.signal.aborted)
                    throw new Error('Search cancelled.');
                let w = this.worker;
                if (!w) {
                    w = new Worker(this.options.workerPath ?? workerPath, { workerData: { databasePath: join(this.options.stateDirectory, 'search', 'file-content-v1.sqlite3') }, resourceLimits: { maxOldGenerationSizeMb: 384 } });
                    this.worker = w;
                    const current = w;
                    current.on('error', () => { if (this.worker === current)
                        this.worker = null; });
                    current.on('exit', () => { if (this.worker === current)
                        this.worker = null; });
                }
                const activeWorker = w;
                const result = await new Promise<unknown>((resolve, reject) => {
                    let finished = false;
                    const finish = (error?: Error, value?: unknown) => { if (finished)
                        return; finished = true; clearTimeout(timer); clearInterval(watch); activeWorker.off('message', onMessage); activeWorker.off('error', onError); activeWorker.off('exit', onExit); abort.signal.removeEventListener('abort', onAbort); error ? reject(error) : resolve(value); };
                    const drop = () => { if (this.worker === activeWorker)
                        this.worker = null; void activeWorker.terminate(); };
                    const onError = (error: Error) => { drop(); finish(error); };
                    const onExit = (code: number) => { if (this.worker === activeWorker)
                        this.worker = null; finish(new Error(`Search worker exited (${code}). Narrow the request and retry.`)); };
                    const onAbort = () => { drop(); finish(new Error('Search cancelled.')); };
                    const onMessage = (message: {
                        id: string;
                        progress?: FileSearchProgress;
                        error?: string;
                        result?: unknown;
                    }) => {
                        if (message.id !== id)
                            return;
                        if (message.progress) {
                            this.states.set(owner, message.progress);
                            return;
                        }
                        finish(message.error ? new Error(message.error) : undefined, message.result);
                    };
                    const timer = setTimeout(() => { drop(); finish(new Error('Local indexing/search exceeded its time budget. Narrow the folder or selection.')); }, job.action === 'index' ? 300000 : 120000);
                    let checking = false;
                    const watch = setInterval(() => {
                        if (checking)
                            return;
                        checking = true;
                        void this.options.roots().then(current => { if (roots.some(root => !current.includes(root)))
                            abort.abort(); }, () => abort.abort()).finally(() => { checking = false; });
                    }, 500);
                    activeWorker.on('message', onMessage);
                    activeWorker.once('error', onError);
                    activeWorker.once('exit', onExit);
                    abort.signal.addEventListener('abort', onAbort, { once: true });
                    if (abort.signal.aborted)
                        onAbort();
                    else
                        activeWorker.postMessage({ ...job, id, roots });
                });
                if (abort.signal.aborted || (this.cancelled.get(owner) ?? 0) !== generation)
                    throw new Error('Search cancelled.');
                if (job.folder)
                    await authorizePath(await this.options.roots(), job.folder);
                return result;
            }
            finally {
                signal?.removeEventListener('abort', forward);
                if (this.active?.abort === abort)
                    this.active = null;
                this.states.set(owner, { ...this.progress(owner), running: false });
            }
        };
        const result = this.queue.then(run, run);
        this.queue = result.catch(() => undefined);
        return result;
    }
    async indexFolder(owner: number, folder: string): Promise<FileSearchProgress> {
        const result = await this.request(owner, { action: 'index', folder }) as FileSearchProgress;
        this.states.set(owner, result);
        return result;
    }
    async selected(owner: number, paths: string[], query: string, signal: AbortSignal): Promise<FileSearchResult> {
        return await this.request(owner, { action: 'selected', paths, query }, signal) as FileSearchResult;
    }
    async search(owner: number, folder: string, query: string, rerank: boolean): Promise<FileSearchResult> {
        if (typeof query !== 'string' || !query.trim() || query.length > 256)
            throw new Error('Enter a search query of 1–256 characters.');
        const generation = this.cancelled.get(owner) ?? 0;
        const assertCurrent = () => { if (this.stopped || (this.cancelled.get(owner) ?? 0) !== generation)
            throw new Error('Search cancelled.'); };
        const result = await this.request(owner, { action: 'search', folder, query }) as FileSearchResult;
        assertCurrent();
        // No caller-controlled URL, and reranking is never invoked by the agent's local search tool.
        if (rerank && result.hits.length) {
            const abort = new AbortController();
            const controllers = this.network.get(owner) ?? new Set<AbortController>();
            controllers.add(abort);
            this.network.set(owner, controllers);
            let checking = false;
            const watch = setInterval(() => { if (checking)
                return; checking = true; void this.options.roots().then(roots => authorizePath(roots, folder)).catch(() => abort.abort()).finally(() => { checking = false; }); }, 500);
            try {
                const config = await this.loadConfig();
                assertCurrent();
                if (!config.encryptedKey || !safeStorage.isEncryptionAvailable())
                    throw new Error('Configure a securely stored reranking key first.');
                const candidates = result.hits.slice(0, 20);
                const judged = await evaluate(query, candidates.map(h => ({ title: h.name, heading: '', text: h.excerpt ?? h.snippet?.map(s => s.text).join('') ?? '' })), config.endpoint, safeStorage.decryptString(Buffer.from(config.encryptedKey, 'base64')), abort.signal);
                const ranked = candidates.slice(0, judged.scores.length).map((hit, i) => ({ hit, score: judged.scores[i]!, i })).sort((a, b) => b.score - a.score || a.i - b.i).map(v => v.hit);
                result.hits = [...ranked, ...result.hits.slice(judged.scores.length)];
                result.reranked = true;
            }
            catch (error) {
                assertCurrent();
                result.warnings.push(`Reranking unavailable; local order retained. ${text(error)}`);
            }
            finally {
                clearInterval(watch);
                controllers.delete(abort);
                if (!controllers.size)
                    this.network.delete(owner);
            }
        }
        // A detached or modified file must not be returned after a slow optional network response.
        const roots = await this.options.roots();
        await authorizePath(roots, folder);
        const kept = [];
        for (const hit of result.hits) {
            try {
                await regularFile(roots, hit.path);
                if (await hashFile(hit.path) !== hit.sourceHash)
                    throw new Error('Changed');
                kept.push(hit);
            }
            catch {
                result.warnings.push(`Unavailable/changed result omitted: ${hit.name}`);
            }
        }
        assertCurrent();
        result.total -= result.hits.length - kept.length;
        result.hits = kept;
        return result;
    }
    async clear(owner: number): Promise<void> { this.cancel(owner); await this.request(owner, { action: 'clear' }); }
    private async loadConfig(): Promise<Config> {
        if (this.config)
            return this.config;
        try {
            const raw = JSON.parse(await readFile(join(this.options.stateDirectory, 'search', 'rerank-key.json'), 'utf8'));
            if (!['direct', 'openrouter'].includes(raw.endpoint) || typeof raw.encryptedKey !== 'string')
                throw new Error('Invalid rerank settings');
            return this.config = raw;
        }
        catch (error) {
            if ((error as NodeJS.ErrnoException).code !== 'ENOENT')
                throw error;
            return this.config = { endpoint: 'direct', encryptedKey: '' };
        }
    }
    async settings(): Promise<{
        endpoint: JevEndpoint;
        hasKey: boolean;
    }> { const c = await this.loadConfig(); return { endpoint: c.endpoint, hasKey: !!c.encryptedKey }; }
    async saveSettings(endpoint: JevEndpoint, key: string): Promise<void> {
        if (!['direct', 'openrouter'].includes(endpoint) || typeof key !== 'string' || key.length > 8192)
            throw new Error('Invalid reranking settings.');
        if (key && (!safeStorage.isEncryptionAvailable() || (safeStorage as typeof safeStorage & {
            getSelectedStorageBackend?(): string;
        }).getSelectedStorageBackend?.() === 'basic_text'))
            throw new Error('OS-protected credential storage is unavailable. The key was not saved.');
        const value = { endpoint, encryptedKey: key ? safeStorage.encryptString(key.trim()).toString('base64') : '' };
        const path = join(this.options.stateDirectory, 'search', 'rerank-key.json'), temporary = `${path}.${randomUUID()}.tmp`;
        await mkdir(dirname(path), { recursive: true });
        try {
            await writeFile(temporary, JSON.stringify(value), { flag: 'wx', mode: 0o600 });
            await rename(temporary, path);
            this.config = value;
        }
        finally {
            await unlink(temporary).catch(() => undefined);
        }
    }
}
