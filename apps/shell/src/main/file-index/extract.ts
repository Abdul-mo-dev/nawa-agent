/** GenOffice extraction route, adapted at f4ea9de914c5e9276a9c2935406885a7f742e31a (Apache-2.0). */
import { readFile, stat } from 'node:fs/promises';
import { extname } from 'node:path';
import { parseFileToText } from '@genoffice/file-parse';
export const MAX_EXTRACT_BYTES = 64 * 1024 * 1024;
export const MAX_BODY_CHARS = 1000000;
export type Extracted = {
    kind: 'text';
    text: string;
    truncated?: boolean;
} | {
    kind: 'name-only';
} | {
    kind: 'error';
    error: string;
};
function stripMarkup(html: string): string {
    return html.replace(/<(script|style)[\s\S]*?<\/\1>/gi, ' ').replace(/<[^>]+>/g, ' ').replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'");
}
export async function extractText(path: string): Promise<Extracted> {
    try {
        if ((await stat(path)).size > MAX_EXTRACT_BYTES)
            return { kind: 'name-only' };
        const ext = extname(path).slice(1).toLowerCase();
        if (ext === 'html' || ext === 'htm') {
            const text = stripMarkup(await readFile(path, 'utf8'));
            return { kind: 'text', text: text.slice(0, MAX_BODY_CHARS), truncated: text.length > MAX_BODY_CHARS };
        }
        const parsed = await parseFileToText(path);
        if (parsed.kind === 'unsupported' || parsed.kind === 'image')
            return { kind: 'name-only' };
        if (!parsed.ok)
            return { kind: 'error', error: parsed.error ?? 'Parse failed' };
        const text = parsed.text ?? '';
        return { kind: 'text', text: text.slice(0, MAX_BODY_CHARS), truncated: text.length > MAX_BODY_CHARS };
    }
    catch (e) {
        return { kind: 'error', error: e instanceof Error ? e.message : String(e) };
    }
}
