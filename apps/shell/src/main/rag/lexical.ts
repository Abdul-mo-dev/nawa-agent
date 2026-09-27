/** Local keyword fallback for unspaced Japanese/CJK and ordinary Unicode words. */
export function terms(text: string): string[] {
  const out: string[] = []
  for (const run of text.normalize('NFKC').toLowerCase().match(/[\p{L}\p{N}\p{M}]+/gu) ?? []) {
    const parts = run.match(/[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]+|[^\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]+/gu) ?? []
    for (const part of parts) {
      if (/^[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]/u.test(part)) {
        const chars = Array.from(part); for (const ch of chars) out.push(ch)
        for (let i = 0; i + 1 < chars.length; i++) out.push(chars[i]! + chars[i + 1]!)
      } else out.push(part)
    }
  }
  return out
}
export const indexTerms = (text: string): string => terms(text).join(' ')
export const matchQuery = (query: string): string => [...new Set(terms(query))].slice(0, 48).map(t => `"${t.replace(/"/g, '""')}"`).join(' OR ')
