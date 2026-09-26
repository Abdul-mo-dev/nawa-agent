export interface FileSearchHit {
    path: string;
    name: string;
    sourceHash: string;
    snippet: {
        text: string;
        hit: boolean;
    }[] | null;
    excerpt?: string;
}
export interface FileSearchResult {
    hits: FileSearchHit[];
    total: number;
    warnings: string[];
    reranked?: boolean;
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
