export interface FileSearchHit {
    path: string;
    name: string;
    sourceHash: string;
    snippet: {
        text: string;
        hit: boolean;
    }[] | null;
    excerpt?: string;
    chunks?: { citation: string; locator: string; text: string; truncated?: boolean; [key: string]: unknown }[];
}
export interface FileSearchResult {
    backend?: 'myagent' | 'local-rag' | 'local-text';
    hits: FileSearchHit[];
    total: number;
    warnings: string[];
    reranked?: boolean;
    coverage?: { selected: number; requested: string[]; covered: string[]; completeSelection: boolean };
    diagnostics?: { httpRequests: number; durationMs: number };
    localSourcesVerified?: boolean;
}
export interface FileSearchProgress {
    running: boolean;
    indexed: number;
    pending: number;
    scanned: number;
    message: string;
}
export interface FileSearchApi {
    indexFolder(folder: string): Promise<FileSearchProgress>;
    search(folder: string, query: string, rerank?: boolean): Promise<FileSearchResult>;
    progress(): Promise<FileSearchProgress>;
    cancel(): Promise<void>;
    clear(): Promise<void>;
    settings(): Promise<{
        endpoint: 'direct' | 'openrouter';
        hasKey: boolean;
    }>;
    saveSettings(endpoint: 'direct' | 'openrouter', key: string): Promise<void>;
}
export const FILE_SEARCH_CHANNEL = 'nawa:file-search';
declare global {
    interface Window {
        nawaFileSearch: FileSearchApi;
    }
}
