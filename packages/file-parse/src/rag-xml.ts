/** Bounded non-resolving XML reader for OOXML. No DTDs, entities, network or schema execution. */
export interface XmlNode { name: string; attrs: Record<string, string>; children: Array<XmlNode | string> }
export function decodeXml(value: string): string {
  return value.replace(/&(#x[0-9a-f]+|#\d+|amp|lt|gt|quot|apos);/gi, (all, entity: string) => {
    const names: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" }
    if (entity[0] !== '#') return names[entity] ?? all
    const cp = entity[1]?.toLowerCase() === 'x' ? Number.parseInt(entity.slice(2), 16) : Number(entity.slice(1))
    return Number.isInteger(cp) && cp > 0 && cp <= 0x10ffff && !(cp >= 0xd800 && cp <= 0xdfff) ? String.fromCodePoint(cp) : '\uFFFD'
  })
}
export function readXml(xml: string): XmlNode {
  if (xml.length > 32 * 1024 * 1024 || /<!\s*(DOCTYPE|ENTITY)/i.test(xml)) throw new Error('XML is oversized or contains a forbidden DTD/entity declaration.')
  const root: XmlNode = { name: '#document', attrs: {}, children: [] }, stack = [root]
  const tokens = /<!--[\s\S]*?-->|<!\[CDATA\[[\s\S]*?\]\]>|<\?[\s\S]*?\?>|<(?:[^>"']|"[^"]*"|'[^']*')+>|[^<]+/g
  let count = 0, match: RegExpExecArray | null, end = 0
  while ((match = tokens.exec(xml))) {
    if (match.index !== end) throw new Error('Malformed XML.')
    end = tokens.lastIndex
    if (++count > 1000000 || stack.length > 256) throw new Error('XML complexity limit exceeded.')
    const value = match[0], current = stack[stack.length - 1]!
    if (value.startsWith('<!--') || value.startsWith('<?')) continue
    if (value.startsWith('<![CDATA[')) { current.children.push(value.slice(9, -3)); continue }
    if (value.startsWith('</')) {
      if (stack.length < 2 || current.name !== value.slice(2, -1).trim()) throw new Error('Mismatched XML element.')
      stack.pop(); continue
    }
    if (value.startsWith('<')) {
      const name = /^<([^\s/>]+)/.exec(value)?.[1]
      if (!name || name.startsWith('!')) throw new Error('Unsupported XML declaration.')
      const attrs: Record<string, string> = Object.create(null)
      const re = /([^\s=<>]+)\s*=\s*("[^"]*"|'[^']*')/g
      let attr: RegExpExecArray | null
      while ((attr = re.exec(value))) attrs[attr[1]!] = decodeXml(attr[2]!.slice(1, -1))
      const node: XmlNode = { name, attrs, children: [] }
      current.children.push(node)
      if (!/\/\s*>$/.test(value)) stack.push(node)
    } else current.children.push(decodeXml(value))
  }
  if (end !== xml.length || stack.length !== 1) throw new Error('Unclosed XML element.')
  return root
}
export const local = (name: string): string => name.split(':').pop()!
export const children = (node: XmlNode, name?: string): XmlNode[] => node.children.filter((n): n is XmlNode => typeof n !== 'string' && (!name || local(n.name) === name))
export function descendants(node: XmlNode, name: string): XmlNode[] {
  const out: XmlNode[] = []
  const visit = (n: XmlNode) => { for (const child of children(n)) { if (local(child.name) === name) out.push(child); visit(child) } }
  visit(node); return out
}
export function attr(node: XmlNode | undefined, name: string): string {
  if (!node) return ''
  return node.attrs[name] ?? Object.entries(node.attrs).find(([key]) => local(key) === name)?.[1] ?? ''
}
export const innerText = (node: XmlNode): string => node.children.map(c => typeof c === 'string' ? c : innerText(c)).join('')
export function officeText(node: XmlNode): string {
  let text = ''
  const visit = (n: XmlNode) => {
    const name = local(n.name)
    if (name === 't' || name === 'delText') { if (name !== 'delText') text += innerText(n); return }
    if (name === 'tab') { text += '\t'; return }
    if (name === 'br' || name === 'cr') { text += '\n'; return }
    if (name === 'del') return
    for (const child of children(n)) visit(child)
  }
  visit(node); return text.trim()
}
