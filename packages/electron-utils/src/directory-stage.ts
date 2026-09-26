/** Main-process-only staging authority. Weak keys retain revocation during late async callbacks
 * without retaining closed WebContents objects. Renderers never register their own grants. */
import { dirname, isAbsolute, relative, resolve, sep } from 'node:path';
export interface DirectoryStageGrant {
    path: string;
    mode: 'read' | 'edit' | null;
    network: boolean;
    media: boolean;
    sources: string[];
    revoked: boolean;
}
const stages = new WeakMap<object, DirectoryStageGrant>();
export function registerDirectoryStage(contents: object, path: string): void {
    if (stages.has(contents))
        throw new Error('This editor already has a staging identity.');
    stages.set(contents, { path: resolve(path), mode: null, network: false, media: false, sources: [], revoked: false });
}
export function configureDirectoryStage(contents: object, mode: 'read' | 'edit', workflow?: {
    network: boolean;
    media: boolean;
    sources: {
        path: string;
    }[];
}): void {
    const stage = stages.get(contents);
    if (!stage || stage.revoked)
        throw new Error('Directory stage is unavailable.');
    const network = mode === 'edit' && workflow?.network === true;
    const media = network && workflow?.media === true;
    const sources = workflow?.sources.map(s => resolve(s.path)) ?? [];
    if (stage.mode) {
        if (stage.mode !== mode || stage.network !== network || stage.media !== media ||
            JSON.stringify(stage.sources) !== JSON.stringify(sources))
            throw new Error('Staging mode and workflow grants cannot change.');
        return;
    }
    stage.mode = mode;
    stage.network = network;
    stage.media = media;
    stage.sources = sources;
}
export function directoryStageFor(contents: object): DirectoryStageGrant | undefined { return stages.get(contents); }
export function revokeDirectoryStage(contents: object): void { const stage = stages.get(contents); if (stage) {
    stage.revoked = true;
    stage.sources = [];
} }
export function assertDirectoryStageCapability(contents: object, capability: 'edit' | 'network' | 'media'): void {
    const stage = stages.get(contents);
    if (!stage)
        return; // Ordinary editors retain their existing behavior.
    if (stage.revoked || stage.mode !== 'edit' || (capability !== 'edit' && !stage[capability]))
        throw new Error(`Directory ${capability} capability is not approved or was revoked.`);
}
export function assertDirectoryStageLocalRead(contents: object, path: string): void {
    const stage = stages.get(contents);
    if (!stage)
        return;
    if (stage.revoked || typeof path !== 'string' || !isAbsolute(path))
        throw new Error('Directory source read denied.');
    const full = resolve(path), root = dirname(stage.path), rel = relative(root, full);
    if (full !== stage.path && !stage.sources.includes(full) && (rel === '..' || rel.startsWith(`..${sep}`) || isAbsolute(rel)))
        throw new Error('This path is not a selected staging source.');
}
export function assertDirectoryStageMedia(contents: object, urls: readonly string[]): void {
    if (!stages.has(contents))
        return;
    assertDirectoryStageCapability(contents, 'media');
    for (const url of urls) {
        if (typeof url !== 'string')
            throw new Error('Invalid media reference.');
        if (/^https?:\/\//i.test(url) || /^data:image\//i.test(url))
            continue;
        assertDirectoryStageLocalRead(contents, url);
    }
}
/** Native tool arguments cannot turn an approved media service into an arbitrary local-file reader. */
export function assertDirectoryStageToolInput(contents: object, call: {
    name: string;
    input: Record<string, unknown>;
}): void {
    const stage = stages.get(contents);
    if (!stage)
        return;
    if (stage.revoked || !stage.mode)
        throw new Error('Directory session is not active.');
    if (call.name === 'analyze_media') {
        const urls = call.input?.mediaUrls;
        if (urls !== undefined && (!Array.isArray(urls) || !urls.every(value => typeof value === 'string')))
            throw new Error('Invalid media source list.');
        assertDirectoryStageMedia(contents, (urls ?? []) as string[]);
    }
}
/** Renderer network requests are separate from the main-process provider IPC services. */
export function directoryStageNetworkAllowed(contents: object, requestUrl: string, rendererUrl: string): boolean {
    const stage = stages.get(contents);
    if (!stage)
        return true;
    if (stage.revoked)
        return false;
    let requested: URL;
    try {
        requested = new URL(requestUrl);
    }
    catch {
        return false;
    }
    if (!['http:', 'https:', 'ws:', 'wss:'].includes(requested.protocol))
        return true;
    // Development-only assets/HMR must be reachable even in a read-only stage.
    try {
        const renderer = new URL(rendererUrl);
        if (['localhost', '127.0.0.1', '[::1]'].includes(renderer.hostname) &&
            ['http:', 'https:'].includes(renderer.protocol) && requested.hostname === renderer.hostname &&
            requested.port === renderer.port)
            return true;
    }
    catch { /* Packaged renderers use the app's local protocol. */ }
    return stage.mode === 'edit' && stage.network;
}
