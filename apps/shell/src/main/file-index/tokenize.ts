/** Adapted from GenOffice f4ea9de914c5e9276a9c2935406885a7f742e31a, Apache-2.0.
 * CJK bigram/unigram pre-tokenizer for SQLite FTS5; Latin/digit words retain prefixes. */
export interface Tokenized {
    bi: string[];
    uni: string[];
}
const CJK_RANGES: ReadonlyArray<readonly [
    number,
    number
]> = [
    [0x2e80, 0x2fdf], [0x3005, 0x3007], [0x3040, 0x30ff], [0x3100, 0x312f],
    [0x3130, 0x318f], [0x31a0, 0x31ff], [0x3400, 0x4dbf], [0x4e00, 0x9fff],
    [0xa960, 0xa97f], [0xac00, 0xd7ff], [0xf900, 0xfaff], [0xff66, 0xff9f],
    [0x1100, 0x11ff], [0x20000, 0x323af],
];
export function isCjk(cp: number): boolean { return CJK_RANGES.some(([lo, hi]) => cp >= lo && cp <= hi); }
const WORD_CHAR = /^[\p{L}\p{N}\p{M}]$/u;
interface Run {
    kind: 'cjk' | 'word';
    chars: string[];
}
function fold(text: string): string { return text.normalize('NFKC').toLowerCase(); }
function splitRuns(text: string): Run[] {
    const runs: Run[] = [];
    let current: Run | null = null;
    for (const ch of fold(text)) {
        const kind = isCjk(ch.codePointAt(0)!) ? 'cjk' : WORD_CHAR.test(ch) ? 'word' : null;
        if (!kind) {
            current = null;
            continue;
        }
        if (current && current.kind === kind)
            current.chars.push(ch);
        else {
            current = { kind, chars: [ch] };
            runs.push(current);
        }
    }
    return runs;
}
export function tokenize(text: string): Tokenized {
    const bi: string[] = [], uni: string[] = [];
    for (const run of splitRuns(text)) {
        if (run.kind === 'word') {
            const word = run.chars.join('');
            bi.push(word);
            uni.push(word);
            continue;
        }
        // Iteration instead of argument-spread also supports very long CJK text.
        for (const ch of run.chars)
            uni.push(ch);
        if (run.chars.length === 1)
            bi.push(run.chars[0]!);
        else
            for (let i = 0; i + 1 < run.chars.length; i++)
                bi.push(run.chars[i]! + run.chars[i + 1]!);
    }
    return { bi, uni };
}
export function toIndexText(tokens: string[]): string { return tokens.join(' '); }
export interface QueryTerm {
    text: string;
    bigramSafe: boolean;
    tokens: Tokenized;
    prefix: boolean;
}
export function parseQuery(input: string): {
    include: QueryTerm[];
    exclude: QueryTerm[];
} {
    const include: QueryTerm[] = [], exclude: QueryTerm[] = [];
    const re = /(-)?(?:"([^"]*)"|(\S+))/g;
    let m: RegExpExecArray | null;
    while ((m = re.exec(input))) {
        const raw = (m[2] ?? m[3] ?? '').trim();
        if (!raw)
            continue;
        const runs = splitRuns(raw);
        if (!runs.length)
            continue;
        const last = runs[runs.length - 1]!;
        const term = { text: fold(raw), bigramSafe: runs.every(r => r.kind === 'word' || r.chars.length >= 2), tokens: tokenize(raw), prefix: m[2] === undefined && last.kind === 'word' && last.chars.length >= 2 };
        (m[1] ? exclude : include).push(term);
    }
    return { include, exclude };
}
const BI_COLUMNS = '{name path body}', UNI_COLUMNS = '{name_u path_u body_u}';
function phrase(tokens: string[], prefix: boolean): string {
    const quoted = `"${tokens.map(t => t.replace(/"/g, '""')).join(' ')}"`;
    return prefix ? `${quoted} *` : quoted;
}
export function termExpr(term: QueryTerm): string {
    return term.bigramSafe ? `${BI_COLUMNS}: ${phrase(term.tokens.bi, term.prefix)}` : `${UNI_COLUMNS}: ${phrase(term.tokens.uni, term.prefix)}`;
}
export function toMatchExpression(parsed: ReturnType<typeof parseQuery>, join: 'AND' | 'OR' = 'AND'): string | null {
    if (!parsed.include.length)
        return null;
    let expr = parsed.include.map(t => `(${termExpr(t)})`).join(` ${join} `);
    for (const t of parsed.exclude)
        expr = `(${expr}) NOT (${termExpr(t)})`;
    return expr;
}
export interface TokenExpr {
    text: string;
    expr: string;
    at: number[];
}
export function tokenExprs(term: QueryTerm): TokenExpr[] {
    const cols = term.bigramSafe ? BI_COLUMNS : UNI_COLUMNS;
    const out = new Map<string, TokenExpr>();
    const add = (tok: string, at: number[]) => { const cur = out.get(tok); if (cur)
        cur.at.push(...at);
    else
        out.set(tok, { text: tok, expr: '', at }); };
    let pos = 0, last = '';
    for (const run of splitRuns(term.text)) {
        const n = run.chars.length;
        if (run.kind === 'word')
            add((last = run.chars.join('')), Array.from({ length: n }, (_, i) => pos + i));
        else if (!term.bigramSafe || n === 1)
            run.chars.forEach((c, i) => add(c, [pos + i]));
        else
            for (let i = 0; i + 1 < n; i++)
                add(run.chars[i]! + run.chars[i + 1]!, [pos + i, pos + i + 1]);
        pos += n;
    }
    for (const t of out.values())
        t.expr = `${cols}: ${phrase([t.text], term.prefix && t.text === last)}`;
    return [...out.values()];
}
export function termChars(term: QueryTerm): number { return splitRuns(term.text).reduce((n, r) => n + r.chars.length, 0); }
export { fold as foldText };
