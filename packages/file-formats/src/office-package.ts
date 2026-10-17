import { DOMParser, XMLSerializer } from '@xmldom/xmldom'

const TYPES_NS = 'http://schemas.openxmlformats.org/package/2006/content-types'
const RELS_NS = 'http://schemas.openxmlformats.org/package/2006/relationships'
const serializer = new XMLSerializer()

export function parseOfficeMetadataXml(xml: string): Document {
  if (/<!DOCTYPE/i.test(xml)) throw new Error('Office package metadata must not contain a DTD.')
  return new DOMParser({
    errorHandler: {
      warning: () => {},
      error: (message) => {
        throw new Error(`Invalid Office package XML: ${message}`)
      },
      fatalError: (message) => {
        throw new Error(`Invalid Office package XML: ${message}`)
      },
    },
  }).parseFromString(xml, 'application/xml')
}
const parse = parseOfficeMetadataXml

function elements(doc: Document, name: string): Element[] {
  const namespace = name === 'Relationship' ? RELS_NS : TYPES_NS
  return Array.from(doc.getElementsByTagName('*')).filter(
    (element) =>
      element.localName === name && (!element.namespaceURI || element.namespaceURI === namespace),
  )
}

/** Package part names and internal relationship targets are URI paths, on every OS. */
function partPath(value: string, source = ''): string {
  const decoded = decodeURIComponent(value.split('#')[0]!)
  const path = decoded.startsWith('/')
    ? decoded
    : `${source.slice(0, source.lastIndexOf('/') + 1)}${decoded}`
  const pieces: string[] = []
  for (const piece of path.split('/')) {
    if (!piece || piece === '.') continue
    if (piece === '..') pieces.pop()
    else pieces.push(piece)
  }
  return pieces.join('/')
}

export function macroPartRelsName(part: string): string {
  const slash = part.lastIndexOf('/')
  return `${part.slice(0, slash + 1)}_rels/${part.slice(slash + 1)}.rels`
}

function relationshipSource(name: string): string {
  if (name === '_rels/.rels') return ''
  return name.replace(/(^|\/)_rels\//, '$1').replace(/\.rels$/, '')
}

export function officeMainPart(rootRelationships: string): string | undefined {
  const relations = elements(parse(rootRelationships), 'Relationship').filter(
    (rel) =>
      /\/officeDocument$/.test(rel.getAttribute('Type') ?? '') &&
      rel.getAttribute('TargetMode') !== 'External',
  )
  if (relations.length !== 1)
    throw new Error('Office package must have one officeDocument relationship.')
  return partPath(relations[0]!.getAttribute('Target') ?? '')
}

export function rewriteMainContentType(
  xml: string,
  contentType: string,
  knownTypes: ReadonlySet<string>,
  mainPart?: string,
): string {
  const doc = parse(xml)
  const candidates = elements(doc, 'Override').filter((element) =>
    mainPart
      ? partPath(element.getAttribute('PartName') ?? '') === mainPart
      : knownTypes.has(element.getAttribute('ContentType') ?? ''),
  )
  if (candidates.length !== 1)
    throw new Error('Office package must declare exactly one main part content type.')
  const main = candidates[0]!
  if (!knownTypes.has(main.getAttribute('ContentType') ?? ''))
    throw new Error('Office package main part has an unsupported content type.')
  if (main.getAttribute('ContentType') === contentType) return xml
  main.setAttribute('ContentType', contentType)
  return serializer.serializeToString(doc)
}

export function isMacroPartName(name: string): boolean {
  return (
    /(?:^|\/)vbaProject(?:Signature(?:Agile|V3)?)?\.bin$/i.test(name) ||
    /(?:^|\/)vbaData[^/]*\.xml$/i.test(name)
  )
}

export function removeElementsByAttribute(
  xml: string,
  tag: 'Override' | 'Relationship',
  attribute: 'PartName' | 'Target',
  matches: (value: string) => boolean,
): string {
  const doc = parse(xml)
  let changed = false
  for (const element of elements(doc, tag)) {
    const value = element.getAttribute(attribute)
    if (value !== null && matches(value)) {
      element.parentNode!.removeChild(element)
      changed = true
    }
  }
  return changed ? serializer.serializeToString(doc) : xml
}

export function removeMacroOverrides(xml: string): string {
  return removeElementsByAttribute(xml, 'Override', 'PartName', isMacroPartName)
}

export function removeMacroRelationships(xml: string): string {
  return removeElementsByAttribute(xml, 'Relationship', 'Target', isMacroPartName)
}

/** Remove VBA payloads by content/relationship type as well as conventional names. */
export function macroFreePackageChanges(
  names: readonly string[],
  metadata: ReadonlyMap<string, string>,
): { replaced: Map<string, string>; removed: Set<string> } {
  const removed = new Set(names.filter(isMacroPartName))
  const typesXml = metadata.get('[Content_Types].xml')!
  const types = parse(typesXml)
  const isVba = (type: string) =>
    /(?:[/.])(?:vbaProject|vbaData|wordVbaData)(?:[.+/]|Signature|$)/i.test(type)
  const overrides = elements(types, 'Override')
  const overridden = new Set(
    overrides.map((element) => partPath(element.getAttribute('PartName') ?? '')),
  )
  for (const element of overrides) {
    if (isVba(element.getAttribute('ContentType') ?? ''))
      removed.add(partPath(element.getAttribute('PartName') ?? ''))
  }
  for (const element of elements(types, 'Default')) {
    if (isVba(element.getAttribute('ContentType') ?? '')) {
      const extension = (element.getAttribute('Extension') ?? '').toLowerCase()
      for (const name of names)
        if (!overridden.has(name) && name.split('.').pop()?.toLowerCase() === extension)
          removed.add(name)
    }
  }
  const relationships = new Map<string, Document>()
  for (const [name, xml] of metadata) {
    if (!name.endsWith('.rels')) continue
    const doc = parse(xml)
    relationships.set(name, doc)
    for (const rel of elements(doc, 'Relationship')) {
      if (rel.getAttribute('TargetMode') !== 'External' && isVba(rel.getAttribute('Type') ?? '')) {
        removed.add(partPath(rel.getAttribute('Target') ?? '', relationshipSource(name)))
      }
    }
  }
  const replaced = new Map<string, string>()
  if (removed.size === 0) return { replaced, removed }
  // Package signatures cannot remain valid after removing signed parts.
  const isPackageSignature = (type: string) => /digital-signature[-/.]/i.test(type)
  for (const name of names) if (name.startsWith('_xmlsignatures/')) removed.add(name)
  for (const element of overrides) {
    if (isPackageSignature(element.getAttribute('ContentType') ?? ''))
      removed.add(partPath(element.getAttribute('PartName') ?? ''))
  }
  for (const element of elements(types, 'Default'))
    if (isPackageSignature(element.getAttribute('ContentType') ?? '')) {
      const extension = (element.getAttribute('Extension') ?? '').toLowerCase()
      for (const name of names)
        if (!overridden.has(name) && name.split('.').pop()?.toLowerCase() === extension)
          removed.add(name)
    }
  for (const [name, doc] of relationships)
    for (const rel of elements(doc, 'Relationship')) {
      if (
        rel.getAttribute('TargetMode') !== 'External' &&
        isPackageSignature(rel.getAttribute('Type') ?? '')
      )
        removed.add(partPath(rel.getAttribute('Target') ?? '', relationshipSource(name)))
    }
  for (const name of [...removed]) {
    const companion = macroPartRelsName(name)
    if (names.includes(companion)) removed.add(companion)
  }
  let typesChanged = false
  for (const element of elements(types, 'Override')) {
    if (removed.has(partPath(element.getAttribute('PartName') ?? ''))) {
      element.parentNode!.removeChild(element)
      typesChanged = true
    }
  }
  for (const element of elements(types, 'Default')) {
    if (
      isVba(element.getAttribute('ContentType') ?? '') ||
      isPackageSignature(element.getAttribute('ContentType') ?? '')
    ) {
      element.parentNode!.removeChild(element)
      typesChanged = true
    }
  }
  if (typesChanged) replaced.set('[Content_Types].xml', serializer.serializeToString(types))
  for (const [name, doc] of relationships) {
    if (removed.has(name)) continue
    let changed = false
    for (const rel of elements(doc, 'Relationship')) {
      if (rel.getAttribute('TargetMode') === 'External') continue
      const target = partPath(rel.getAttribute('Target') ?? '', relationshipSource(name))
      if (removed.has(target)) {
        rel.parentNode!.removeChild(rel)
        changed = true
      }
    }
    if (changed) replaced.set(name, serializer.serializeToString(doc))
  }
  return { replaced, removed }
}
