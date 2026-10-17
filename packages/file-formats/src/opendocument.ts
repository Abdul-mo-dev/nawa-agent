import { parseOfficeMetadataXml } from './office-package'

export function openDocumentMimeForPath(path: string): string | undefined {
  if (/\.odt$/i.test(path)) return 'application/vnd.oasis.opendocument.text'
  if (/\.odp$/i.test(path)) return 'application/vnd.oasis.opendocument.presentation'
  return undefined
}

/** Namespace-aware detection avoids matching comments or an unrelated element. */
export function openDocumentManifestEncrypted(xml: string): boolean {
  const doc = parseOfficeMetadataXml(xml)
  const ns = 'urn:oasis:names:tc:opendocument:xmlns:manifest:1.0'
  if (doc.documentElement.namespaceURI !== ns || doc.documentElement.localName !== 'manifest')
    throw new Error('Invalid OpenDocument manifest.')
  return doc.getElementsByTagNameNS(ns, 'encryption-data').length > 0
}
