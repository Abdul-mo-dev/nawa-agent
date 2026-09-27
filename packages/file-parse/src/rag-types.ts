export interface RagBlock {
  text: string
  kind: 'paragraph' | 'table' | 'row' | 'code' | 'record' | 'outline' | 'notes'
  locator: string
  headings: string[]
  page?: number
  sheet?: string
  slide?: number
  rowStart?: number
  rowEnd?: number
  lineStart?: number
  lineEnd?: number
  /** Repeated in every fragment, e.g. table headers. Not an inferred fact. */
  context?: string
}
export interface RagDocument {
  title: string
  format: string
  blocks: RagBlock[]
  warnings: string[]
  partial: boolean
}
