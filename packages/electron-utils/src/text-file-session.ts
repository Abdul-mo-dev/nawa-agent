import { createHash } from 'node:crypto'
import { readFile, writeFile } from 'node:fs/promises'
import { fileRevision, FileConflictError, replaceFileTransaction } from './file-transaction'

export interface TextCodec {
  text: string
  encode(text: string): Uint8Array
}
interface TextState {
  path: string
  revision: string
  codec: TextCodec
  newline: string | null
}

/** Per-view source identity, encoding and revision; shared by native text adapters. */
export class TextFileSessions {
  private readonly states = new Map<number, TextState>()
  private readonly owners = new Map<number, object>()
  constructor(private readonly decode: (bytes: Uint8Array) => TextCodec) {}

  async read(owner: number, path: string): Promise<string> {
    const token = {}
    this.owners.set(owner, token)
    const bytes = await readFile(path)
    const codec = this.decode(bytes)
    const endings = codec.text.match(/\r\n|\r|\n/g) ?? []
    const newline =
      endings.length && endings.every((value) => value === endings[0]) ? endings[0]! : null
    if (this.owners.get(owner) === token)
      this.states.set(owner, { path, revision: this.hash(bytes), codec, newline })
    return codec.text
  }

  async save(owner: number, path: string, text: string, allowReplace = false): Promise<void> {
    const token = this.owners.get(owner) ?? {}
    this.owners.set(owner, token)
    const source = this.states.get(owner)
    if (source?.path === path && (await fileRevision(path)) !== source.revision)
      throw new FileConflictError(path)
    const expectedRevision =
      source?.path === path ? source.revision : allowReplace ? await fileRevision(path) : null
    const normalized = source?.newline ? text.replace(/\r\n|\r|\n/g, source.newline) : text
    const codec = source?.codec ?? this.decode(new Uint8Array())
    const bytes = codec.encode(normalized)
    await replaceFileTransaction(path, (stage) => writeFile(stage, bytes, { flag: 'wx' }), {
      expectedRevision,
      beforeCommit: () => {
        if (this.owners.get(owner) !== token)
          throw new Error('The file view closed or changed before the save completed.')
      },
    })
    if (this.owners.get(owner) === token)
      this.states.set(owner, {
        path,
        codec,
        revision: this.hash(bytes),
        newline: source?.newline ?? null,
      })
  }

  rename(owner: number, oldPath: string, newPath: string): void {
    const state = this.states.get(owner)
    if (state?.path === oldPath) state.path = newPath
  }

  forget(owner: number): void {
    this.owners.delete(owner)
    this.states.delete(owner)
  }
  private hash(bytes: Uint8Array): string {
    return createHash('sha256').update(bytes).digest('hex')
  }
}
