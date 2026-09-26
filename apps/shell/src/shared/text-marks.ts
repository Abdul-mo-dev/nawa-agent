/** GenOffice text-marks, adapted at f4ea9de914c5e9276a9c2935406885a7f742e31a (Apache-2.0). */
export interface TextMark {
    text: string;
    hit: boolean;
}
const WORD_CHAR = /^[\p{L}\p{N}\p{M}]$/u;
const CJK_START = /^[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}\p{Script=Bopomofo}]/u;
const GRAPHEME_SEGMENTER = new Intl.Segmenter(undefined, { granularity: 'grapheme' });
export function foldText(text: string): string { return text.normalize('NFKC').toLowerCase(); }
export function findRanges(hay: string, needles: readonly string[], allowMidWord?: (index: number) => boolean): Array<[
    number,
    number
]> {
    const ranges: Array<[
        number,
        number
    ]> = [];
    for (const n of needles) {
        if (!n)
            continue;
        const wordStart = !CJK_START.test(n) && WORD_CHAR.test(String.fromCodePoint(n.codePointAt(0)!));
        let at = hay.indexOf(n);
        while (at !== -1) {
            if (!wordStart || at === 0 || !WORD_CHAR.test(hay[at - 1]!) || allowMidWord?.(at))
                ranges.push([at, at + n.length]);
            at = hay.indexOf(n, at + 1);
        }
    }
    return mergeRanges(ranges);
}
function mergeRanges(ranges: Array<[
    number,
    number
]>): Array<[
    number,
    number
]> {
    ranges.sort((a, b) => a[0] - b[0]);
    const merged: Array<[
        number,
        number
    ]> = [];
    for (const r of ranges) {
        const last = merged.at(-1);
        if (last && r[0] <= last[1])
            last[1] = Math.max(last[1], r[1]);
        else
            merged.push([r[0], r[1]]);
    }
    return merged;
}
export function findTextRanges(text: string, needles: readonly string[]): Array<[
    number,
    number
]> {
    const folded = foldText(text), foldedNeedles = needles.map(foldText);
    if (/^[ -~]*$/.test(text))
        return findRanges(folded, foldedNeedles);
    const starts: number[] = [], ends: number[] = [], changedLength = new Set<number>();
    for (const { segment, index } of GRAPHEME_SEGMENTER.segment(text)) {
        const length = foldText(segment).length;
        for (let i = 0; i < length; i++) {
            if (length !== segment.length)
                changedLength.add(starts.length);
            starts.push(index);
            ends.push(index + segment.length);
        }
    }
    if (starts.length !== folded.length)
        return [];
    return mergeRanges(findRanges(folded, foldedNeedles, at => changedLength.has(at)).map(([s, e]) => [starts[s]!, ends[e - 1]!] as [
        number,
        number
    ]));
}
export function markText(text: string, needles: readonly string[]): TextMark[] {
    const ranges = findTextRanges(text, needles);
    if (!ranges.length)
        return [{ text, hit: false }];
    const out: TextMark[] = [];
    let cursor = 0;
    for (const [s, e] of ranges) {
        if (s > cursor)
            out.push({ text: text.slice(cursor, s), hit: false });
        out.push({ text: text.slice(s, e), hit: true });
        cursor = e;
    }
    if (cursor < text.length)
        out.push({ text: text.slice(cursor), hit: false });
    return out;
}
