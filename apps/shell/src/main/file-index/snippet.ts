/** Adapted from GenOffice f4ea9de914c5e9276a9c2935406885a7f742e31a, Apache-2.0. */
import { findRanges, findTextRanges, foldText, type TextMark } from '../../shared/text-marks';
export type SnippetPart = TextMark;
export function buildSnippet(text: string, needles: readonly string[]): SnippetPart[] | null {
    if (needles.every(n => !n) || !text)
        return null;
    const compact = text.replace(/\s+/g, ' '), ranges = findTextRanges(compact, needles);
    if (!ranges.length)
        return null;
    const start = Math.max(0, ranges[0]![0] - 40), end = Math.min(compact.length, start + 150);
    const parts: SnippetPart[] = [];
    let cursor = start;
    if (start > 0)
        parts.push({ text: '…', hit: false });
    for (const [s, e] of ranges) {
        if (s >= end)
            break;
        if (s > cursor)
            parts.push({ text: compact.slice(cursor, s), hit: false });
        const stop = Math.min(e, end);
        parts.push({ text: compact.slice(Math.max(s, cursor), stop), hit: true });
        cursor = stop;
    }
    if (cursor < end)
        parts.push({ text: compact.slice(cursor, end), hit: false });
    if (end < compact.length)
        parts.push({ text: '…', hit: false });
    return parts;
}
export function excerpt(text: string, needles: readonly string[], chars: number): string {
    const compact = text.replace(/\s+/g, ' ').trim(), ranges = findTextRanges(compact, needles);
    const start = ranges.length ? Math.max(0, ranges[0]![0] - Math.floor(chars / 4)) : 0;
    return compact.slice(start, start + chars);
}
export function containsAny(text: string, needles: readonly string[]): boolean { return findRanges(foldText(text), needles.map(foldText).filter(Boolean)).length > 0; }
